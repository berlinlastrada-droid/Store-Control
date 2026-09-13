/**
 * StoreControl Pro - Client Sync Manager
 * Handles offline-first queuing, automatic 2-way sync, SSE real-time updates,
 * and conflict detection between Smartphone & PC.
 */

class SyncManager {
    constructor() {
        this.isOnline = navigator.onLine;
        this.syncQueue = this.loadQueue();
        this.lastSyncTime = localStorage.getItem('storecontrol_last_sync') || '1970-01-01T00:00:00.000Z';
        this.isSyncing = false;
        this.eventSource = null;
        this.changeListeners = [];
        this.statusListeners = [];
        this.conflictListeners = [];

        this.init();
    }

    
    getBaseUrl() {
        if (typeof window !== 'undefined') {
            if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
                return '';
            }
            return 'http://localhost:3000';
        }
        return 'http://localhost:3000';
    }

    async checkFileProtocolAndRedirect() {
        if (typeof window === 'undefined' || window.location.protocol !== 'file:') return;
        try {
            const res = await fetch('http://localhost:3000/api/network-info', { method: 'GET', cache: 'no-cache' });
            if (res.ok) {
                this.setOnlineStatus(true);
                if (this.syncQueue && this.syncQueue.length > 0) {
                    await this.reconcileExistingPendingWithServer();
                }
                console.log('Zentraler Server erreichbar. Leite weiter auf http://localhost:3000...');
                window.location.replace('http://localhost:3000');
            }
        } catch (e) {
            console.log('Lokaler Server noch nicht erreichbar auf http://localhost:3000');
        }
    }

    init() {
        // Window online/offline events
        window.addEventListener('online', () => {
            this.setOnlineStatus(true);
            this.reconcileExistingPendingWithServer().then(() => this.syncNow());
        });

        window.addEventListener('offline', () => {
            this.setOnlineStatus(false);
        });

        // Listen to visibility & focus for instant recovery on mobile wake-up
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    console.log('📱 App aufgewacht: Reconnecte SSE und prüfe Datenbestand...');
                    this.connectSSE();
                    this.checkConnectionAndSync();
                    if (typeof loadDataFromServer === 'function') loadDataFromServer(false);
                }
            });
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', () => {
                this.connectSSE();
                this.checkConnectionAndSync();
                if (typeof loadDataFromServer === 'function') loadDataFromServer(false);
            });
        }

        // Fast 5-second background heartbeat & sync safety-net
        setInterval(() => {
            this.checkConnectionAndSync();
        }, 5000);

        // Start Bidirectional Realtime Stream (SSE + Long-Poll)
        this.startRealtimeStream();
        if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
            this.checkFileProtocolAndRedirect();
        }
    }

    // =========================================================================
    // AUTHENTICATION STATE
    // =========================================================================
    // PERSISTENT DEVICE TOKEN MANAGEMENT
    // =========================================================================
    getDeviceToken() {
        return localStorage.getItem('storecontrol_device_token');
    }

    setDeviceToken(token) {
        if (token) {
            localStorage.setItem('storecontrol_device_token', token);
        } else {
            localStorage.removeItem('storecontrol_device_token');
        }
        this.notifyStatusChange();
    }

    getDeviceId() {
        return localStorage.getItem('storecontrol_device_id');
    }

    setDeviceId(id) {
        if (id) {
            localStorage.setItem('storecontrol_device_id', id);
        } else {
            localStorage.removeItem('storecontrol_device_id');
        }
    }

    async pairDevice(code, deviceName = null) {
        try {
            const name = deviceName || (navigator.userAgent.includes('iPhone') ? 'iPhone' : (navigator.userAgent.includes('Android') ? 'Android Smartphone' : 'Web Browser'));
            const res = await fetch(this.getBaseUrl() + '/api/auth/pair-device', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, deviceName: name })
            });
            const data = await res.json();
            if (res.ok && data.deviceToken) {
                this.setDeviceToken(data.deviceToken);
                if (data.deviceId) this.setDeviceId(data.deviceId);
                if (data.sessionToken) this.setAuth(data.sessionToken, data.user);
                this.connectSSE();
                return { success: true, user: data.user };
            } else {
                return { success: false, error: data.error || 'Kopplung fehlgeschlagen.' };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    getToken() {
        return localStorage.getItem('storecontrol_auth_token');
    }

    getUser() {
        try {
            return JSON.parse(localStorage.getItem('storecontrol_auth_user'));
        } catch (e) {
            return null;
        }
    }

    setAuth(token, user) {
        if (token) {
            localStorage.setItem('storecontrol_auth_token', token);
            localStorage.setItem('storecontrol_auth_user', JSON.stringify(user));
        } else {
            localStorage.removeItem('storecontrol_auth_token');
            localStorage.removeItem('storecontrol_auth_user');
        }
        this.notifyStatusChange();
        if (token) {
            this.connectSSE();
            this.syncNow().catch(e => console.log('Login auto-sync deferred:', e.message));
        }
    }

    isLoggedIn() {
        return !!this.getToken();
    }

    // =========================================================================
    // API REQUEST WRAPPER (WITH OFFLINE HANDLING)
    // =========================================================================
    async ensureToken() {
        if (this.getToken()) return this.getToken();

        // 1. Check persistent device token first
        const deviceToken = this.getDeviceToken();
        if (deviceToken) {
            try {
                const verifyRes = await fetch(this.getBaseUrl() + '/api/auth/verify-device', {
                    headers: { 'X-Device-Token': deviceToken }
                });
                if (verifyRes.ok) {
                    const verifyData = await verifyRes.json();
                    if (verifyData.sessionToken) {
                        this.setAuth(verifyData.sessionToken, verifyData.user);
                        return verifyData.sessionToken;
                    }
                }
            } catch (e) {
                console.warn('Device token verification deferred:', e.message);
            }
        }

        // 2. Default login for PC direct access
        try {
            const res = await fetch(this.getBaseUrl() + "/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: "admin", password: "admin123" })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.token) {
                    this.setAuth(data.token, data.user);
                    return data.token;
                }
            }
        } catch (e) {
            console.warn("Auto-login failed:", e.message);
        }
        return null;
    }
    async apiRequest(endpoint, options = {}) {
        if (!this.getToken()) {
            await this.ensureToken();
        }
        const token = this.getToken();
        const deviceToken = this.getDeviceToken();
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        if (deviceToken) {
            headers['X-Device-Token'] = deviceToken;
        }

        const config = {
            ...options,
            headers
        };
        const fullUrl = endpoint.startsWith('http') ? endpoint : (this.getBaseUrl() + endpoint);
        try {
            const res = await fetch(fullUrl, config);

            // Check if unauthorized
            if (res.status === 401) {
                console.warn('Session expired or unauthorized, attempting auto-relogin...');
                try {
                    const loginRes = await fetch(this.getBaseUrl() + "/api/auth/login", {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: 'admin', password: 'admin123' })
                    });
                    if (loginRes.ok) {
                        const loginData = await loginRes.json();
                        if (loginData.token) {
                            this.setAuth(loginData.token, loginData.user);
                            const retryHeaders = {
                                ...headers,
                                'Authorization': `Bearer ${loginData.token}`
                            };
                            const retryRes = await fetch(fullUrl, { ...options, headers: retryHeaders });
                            if (retryRes.ok) {
                                return await retryRes.json();
                            }
                        }
                    }
                } catch (retryErr) {
                    console.warn('Auto-relogin failed:', retryErr.message);
                }

                this.setAuth(null, null);
                if (typeof window.showLoginModal === 'function') {
                    window.showLoginModal('Ihre Sitzung ist abgelaufen. Bitte erneut anmelden.');
                }
                const authErr = new Error('Sitzung abgelaufen');
                authErr.status = 401;
                throw authErr;
            }

            // Successfully reached server
            if (!this.isOnline) {
                this.setOnlineStatus(true);
            }

            const data = await res.json();
            if (!res.ok) {
                const err = new Error(data.error || 'Serverfehler');
                err.status = res.status;
                err.data = data;
                throw err;
            }

            return data;
        } catch (err) {
            // Check if network error
            if (err.name === 'TypeError' || err.message === 'Failed to fetch' || !navigator.onLine) {
                this.setOnlineStatus(false);
            }
            throw err;
        }
    }

    // =========================================================================
    
    // =========================================================================
    // BIDIRECTIONAL REALTIME STREAM (SSE + LONG-POLL FOR 100% TUNNEL RELIABILITY)
    // =========================================================================
    startRealtimeStream() {
        this.connectSSE();
        this.startLongPoll();
    }

    async startLongPoll() {
        if (this.isLongPolling) return;
        this.isLongPolling = true;

        const pollLoop = async () => {
            if (!this.isLongPolling) return;
            try {
                const token = this.getToken();
                const deviceToken = this.getDeviceToken();
                const base = this.getBaseUrl();
                const headers = {};
                if (token) headers['Authorization'] = `Bearer ${token}`;
                if (deviceToken) headers['X-Device-Token'] = deviceToken;

                const res = await fetch(`${base}/api/events/poll`, {
                    headers,
                    cache: 'no-store'
                });

                if (res.ok) {
                    const data = await res.json();
                    if (data && data.type && data.type !== 'TIMEOUT') {
                        console.log('⚡ Realtime Live-Update erhalten (Instant Push):', data.type, data.payload);
                        this.notifyChange(data.type, data.payload);
                    }
                }
            } catch (err) {
                // Short pause on network disconnect before re-poll
                await new Promise(r => setTimeout(r, 2000));
            }

            if (this.isLongPolling) {
                setTimeout(pollLoop, 50);
            }
        };

        pollLoop();
    }

    // REALTIME SERVER-SENT EVENTS (SSE)
    // =========================================================================
    connectSSE() {
        if (!window.EventSource) return;

        if (this.eventSource) {
            this.eventSource.close();
        }

        const token = this.getToken();
        const base = this.getBaseUrl();
        const url = token ? `${base}/api/events?token=${encodeURIComponent(token)}` : `${base}/api/events`;

        try {
            this.eventSource = new EventSource(url);

            this.eventSource.onopen = () => {
                this.setOnlineStatus(true);
            };

            this.eventSource.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'CONNECTED') {
                        // Connection established
                        return;
                    }

                    // A change occurred on server (e.g., from smartphone or PC)
                    console.log('📡 SSE Live-Update erhalten:', msg.type, msg.payload);
                    this.notifyChange(msg.type, msg.payload);
                } catch (e) {
                    console.error('SSE Parse Error:', e);
                }
            };

            this.eventSource.onerror = () => {
                // SSE automatically reconnects, but mark status
                if (this.eventSource.readyState === EventSource.CLOSED) {
                    setTimeout(() => this.connectSSE(), 5000);
                }
            };
        } catch (err) {
            console.error('Failed to init SSE:', err);
        }
    }

    // =========================================================================
    // OFFLINE QUEUE MANAGEMENT
    // =========================================================================
    loadQueue() {
        try {
            return JSON.parse(localStorage.getItem('storecontrol_sync_queue')) || [];
        } catch (e) {
            return [];
        }
    }

    saveQueue() {
        localStorage.setItem('storecontrol_sync_queue', JSON.stringify(this.syncQueue));
        this.notifyStatusChange();
    }

    /**
     * Enqueue an action when offline or when saving optimistically
     */
    enqueue(type, data, clientVersion = 1) {
        const tempId = data.id || `temp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const item = {
            tempId,
            type,
            data: { ...data, id: data.id || tempId },
            clientVersion,
            timestamp: new Date().toISOString()
        };

        this.syncQueue.push(item);
        this.saveQueue();

        // Attempt immediate sync to push out queue as soon as possible
        if (!this.isSyncing && this.getToken()) {
            this.syncNow().catch(e => console.log('Auto-sync retry deferred:', e.message));
        }

        return tempId;
    }

    // =========================================================================
    // SYNCHRONIZATION ENGINE
    // =========================================================================
    // =========================================================================
    // RECONCILE PENDING ITEMS WITH CENTRAL DATABASE
    // =========================================================================
    async reconcileExistingPendingWithServer() {
        if (!this.isOnline) {
            try {
                const check = await fetch(this.getBaseUrl() + '/api/network-info', { method: 'GET', cache: 'no-cache' });
                if (check.ok) this.setOnlineStatus(true);
                else return;
            } catch(e) { return; }
        }
        if (!this.getToken()) {
            await this.ensureToken();
        }
        if (!this.getToken()) return;

        const pendingItems = [];
        const seenIds = new Set();

        // 1. Collect from syncQueue
        for (const q of this.syncQueue) {
            const id = q.tempId || q.data?.id;
            if (id && !seenIds.has(id)) {
                seenIds.add(id);
                pendingItems.push({
                    tempId: q.tempId || id,
                    type: q.type,
                    data: q.data
                });
            }
        }

        // 2. Collect from STATE collections if marked _pendingSync
        if (typeof STATE !== "undefined") {
            const collectPending = (list, type) => {
                if (!Array.isArray(list)) return;
                for (const item of list) {
                    if (item && item._pendingSync && item.id && !seenIds.has(item.id)) {
                        seenIds.add(item.id);
                        pendingItems.push({
                            tempId: item.id,
                            type,
                            data: item
                        });
                    }
                }
            };
            collectPending(STATE.revenues, "CREATE_REVENUE");
            collectPending(STATE.expenses, "CREATE_EXPENSE");
            collectPending(STATE.products, "CREATE_PRODUCT");
            collectPending(STATE.stores, "CREATE_STORE");
        }

        if (pendingItems.length === 0) {
            return;
        }

        try {
            console.log(`🔍 Prüfe ${pendingItems.length} ausstehende Einträge gegen zentrale Datenbank...`);
            const res = await this.apiRequest("/api/sync/reconcile", {
                method: "POST",
                body: JSON.stringify({ items: pendingItems })
            });

            if (res && res.reconciled && res.reconciled.length > 0) {
                const reconciledMap = new Map();
                for (const r of res.reconciled) {
                    if (r.originalId) reconciledMap.set(r.originalId, r);
                    if (r.serverId) reconciledMap.set(r.serverId, r);
                }

                // Update state records with canonical server data
                if (typeof STATE !== "undefined") {
                    const applyToCollection = (collKey) => {
                        if (!Array.isArray(STATE[collKey])) return;
                        STATE[collKey] = STATE[collKey].map(item => {
                            const match = reconciledMap.get(item.id);
                            if (match && match.record) {
                                return { ...item, ...match.record, _pendingSync: false };
                            }
                            if (item._pendingSync && reconciledMap.has(item.id)) {
                                return { ...item, _pendingSync: false };
                            }
                            return item;
                        });
                    };

                    applyToCollection("revenues");
                    applyToCollection("expenses");
                    applyToCollection("products");
                    applyToCollection("stores");

                    if (typeof saveStateToLocalStorageCache === "function") {
                        saveStateToLocalStorageCache();
                    }
                }

                // Remove matched items from syncQueue
                this.syncQueue = this.syncQueue.filter(q => {
                    const qId = q.tempId || q.data?.id;
                    return !reconciledMap.has(qId);
                });

                if (this.syncQueue.length === 0 && typeof STATE !== "undefined") {
                    ["revenues", "expenses", "products", "stores"].forEach(key => {
                        if (Array.isArray(STATE[key])) {
                            STATE[key].forEach(record => { record._pendingSync = false; });
                        }
                    });
                }

                this.saveQueue();
                this.notifyStatusChange();

                if (typeof updateUI === "function") {
                    updateUI();
                }

                console.log(`✓ ${res.reconciled.length} Einträge erfolgreich mit zentraler Datenbank synchronisiert.`);
            }
        } catch (err) {
            console.warn("Reconciliation deferred:", err.message);
        }
    }
    async syncNow() {
        await this.reconcileExistingPendingWithServer();
        if (this.isSyncing) return;

        // Auto-login if session token is missing
        if (!this.getToken()) {
            try {
                const loginRes = await fetch(this.getBaseUrl() + "/api/auth/login", {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: 'admin', password: 'admin123' })
                });
                if (loginRes.ok) {
                    const loginData = await loginRes.json();
                    if (loginData.token) {
                        this.setAuth(loginData.token, loginData.user);
                    }
                }
            } catch (e) {
                console.warn('Sync auto-login failed:', e.message);
            }
        }
        if (!this.getToken()) return;

        this.isSyncing = true;
        this.notifyStatusChange();

        try {
            // 1. PUSH local queue to server
            if (this.syncQueue.length > 0) {
                console.log(`🔄 Synchronisiere ${this.syncQueue.length} ausstehende Aktionen...`);
                const pushResult = await this.apiRequest('/api/sync/push', {
                    method: 'POST',
                    body: JSON.stringify({ items: this.syncQueue })
                });

                if (pushResult.success) {
                    const syncedItems = pushResult.synced || [];
                    const syncedTempIds = new Set(syncedItems.map(s => s.tempId).filter(Boolean));
                    const syncedServerIds = new Set(syncedItems.map(s => s.serverId).filter(Boolean));

                    // Remove successfully synced items from queue by tempId and serverId
                    this.syncQueue = this.syncQueue.filter(item => {
                        const isTempMatched = item.tempId && (syncedTempIds.has(item.tempId) || syncedServerIds.has(item.tempId));
                        const isServerMatched = item.data?.id && (syncedServerIds.has(item.data.id) || syncedTempIds.has(item.data.id));
                        return !isTempMatched && !isServerMatched;
                    });

                    // If all items were accepted without conflicts, ensure queue is completely empty
                    if ((!pushResult.conflicts || pushResult.conflicts.length === 0) && syncedItems.length >= this.syncQueue.length) {
                        this.syncQueue = [];
                    }

                    this.saveQueue();
                    this.notifyStatusChange();

                    // Clear _pendingSync flags on state objects in memory
                    if (typeof STATE !== 'undefined') {
                        ['revenues', 'expenses', 'products', 'stores'].forEach(key => {
                            if (Array.isArray(STATE[key])) {
                                STATE[key].forEach(record => {
                                    if (this.syncQueue.length === 0 || syncedTempIds.has(record.id) || syncedServerIds.has(record.id)) {
                                        record._pendingSync = false;
                                    }
                                });
                            }
                        });
                        if (typeof saveStateToLocalStorageCache === 'function') {
                            saveStateToLocalStorageCache();
                        }
                        if (typeof updateUI === 'function') {
                            updateUI();
                        }
                    }

                    if (syncedItems.length > 0 && typeof showToast === 'function') {
                        showToast(`✓ ${syncedItems.length} ausstehende Datensätze synchronisiert!`, 'success');
                    }

                    // Check if there were conflicts
                    if (pushResult.conflicts && pushResult.conflicts.length > 0) {
                        console.warn('⚠️ Synchronisations-Konflikte aufgetreten:', pushResult.conflicts);
                        this.notifyConflict(pushResult.conflicts);
                    }
                }
            }

            // 2. PULL latest updates from server since last sync
            const pullResult = await this.apiRequest(`/api/sync/pull?since=${encodeURIComponent(this.lastSyncTime)}`);
            if (pullResult && pullResult.serverTime) {
                this.lastSyncTime = pullResult.serverTime;
                localStorage.setItem('storecontrol_last_sync', this.lastSyncTime);
                this.notifyChange('SYNC_PULL_COMPLETED', pullResult);
            }

            this.setOnlineStatus(true);
        } catch (err) {
            console.warn('Sync failed (will retry automatically):', err.message);
        } finally {
            this.isSyncing = false;
            this.notifyStatusChange();
        }
    }

    async checkConnectionAndSync() {
        try {
            const res = await fetch(this.getBaseUrl() + '/api/network-info', { method: 'GET', cache: 'no-cache' });
            if (res.ok) {
                if (!this.isOnline) {
                    this.setOnlineStatus(true);
                }
                await this.reconcileExistingPendingWithServer();
                if (this.syncQueue.length > 0) {
                    await this.syncNow();
                }
            } else {
                this.setOnlineStatus(false);
            }
        } catch (e) {
            this.setOnlineStatus(false);
        }
    }

    setOnlineStatus(status) {
        if (this.isOnline !== status) {
            this.isOnline = status;
            this.notifyStatusChange();
        }
    }

    // =========================================================================
    // EVENT LISTENERS & OBSERVERS
    // =========================================================================
    onChange(callback) {
        this.changeListeners.push(callback);
    }

    notifyChange(type, payload) {
        for (const cb of this.changeListeners) {
            try {
                cb(type, payload);
            } catch (e) {
                console.error('Error in change listener:', e);
            }
        }
    }

    onStatusChange(callback) {
        this.statusListeners.push(callback);
    }

    notifyStatusChange() {
        const status = {
            isOnline: this.isOnline,
            isSyncing: this.isSyncing,
            pendingCount: this.syncQueue.length,
            isLoggedIn: this.isLoggedIn(),
            user: this.getUser()
        };

        for (const cb of this.statusListeners) {
            try {
                cb(status);
            } catch (e) {
                console.error('Error in status listener:', e);
            }
        }
    }

    onConflict(callback) {
        this.conflictListeners.push(callback);
    }

    notifyConflict(conflicts) {
        for (const cb of this.conflictListeners) {
            try {
                cb(conflicts);
            } catch (e) {
                console.error('Error in conflict listener:', e);
            }
        }
    }
}

// Global Singleton Instance
window.syncManager = new SyncManager();
