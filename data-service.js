/**
 * StoreControl Pro - Central Data Service
 * 
 * Implements Direct-API-First architecture:
 * 1. Immediate persistence to central database (Source of Truth)
 * 2. Instant UI integration of authoritative server records (no reload / tab switch needed)
 * 3. Client-generated Idempotency Keys to prevent duplicate bookings
 * 4. Graceful offline fallback into sync queue with visual pending badges
 * 5. Full audit traceability and error preservation
 */

class DataService {
    constructor() {
        this.pendingSyncIds = new Set();
    }

    generateId(prefix = 'item') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
    }

    setButtonLoading(button, isLoading, text = '⟳ Wird gespeichert...') {
        if (!button) return;
        if (isLoading) {
            button.dataset.originalHtml = button.innerHTML;
            button.disabled = true;
            button.classList.add('opacity-75', 'cursor-not-allowed');
            button.innerHTML = `<span class="inline-flex items-center gap-2"><svg class="animate-spin h-4 w-4 text-current inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>${text}</span>`;
        } else {
            if (button.dataset.originalHtml) {
                button.innerHTML = button.dataset.originalHtml;
            }
            button.disabled = false;
            button.classList.remove('opacity-75', 'cursor-not-allowed');
        }
    }

    isNetworkError(err) {
        if (!err) return false;
        // If an HTTP response code was received, the server was reached -> NOT a network error
        if (typeof err.status === 'number' && err.status >= 100) {
            return false;
        }
        // Browser is offline
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            return true;
        }
        // Only genuine network disconnect failures:
        const msg = (err.message || '').toLowerCase();
        return (
            (err.name === 'TypeError' && (msg.includes('fetch') || msg.includes('network'))) ||
            msg.includes('networkerror') ||
            msg.includes('failed to fetch') ||
            msg.includes('net::err_connection')
        );
    }

    // =========================================================================
    // REVENUES CRUD
    // =========================================================================

    async saveRevenue(payload, buttonEl = null) {
        const isEdit = !!payload.id && !payload._isNew;
        const recordId = payload.id || this.generateId('rev');
        const existing = isEdit ? STATE.revenues.find(r => r.id === recordId) : null;

        // Partial merge: existing record + incoming changes
        const merged = existing ? { ...existing, ...payload } : { ...payload };

        const cashNum = merged.cash !== undefined ? Math.round((parseFloat(merged.cash) || 0) * 100) / 100 : (existing ? existing.cash : 0);
        const cardNum = merged.card !== undefined ? Math.round((parseFloat(merged.card) || 0) * 100) / 100 : (existing ? existing.card : 0);
        const totalNum = Math.round((cashNum + cardNum) * 100) / 100;

        const completePayload = {
            ...merged,
            id: recordId,
            cash: cashNum,
            card: cardNum,
            total: totalNum,
            clientVersion: existing ? existing.version : (payload.clientVersion || 1)
        };

        this.setButtonLoading(buttonEl, true, '⟳ Wird gespeichert...');

        try {
            let serverRecord;
            if (isEdit) {
                const existing = STATE.revenues.find(r => r.id === recordId);
                completePayload.clientVersion = existing ? existing.version : 1;
                const res = await syncManager.apiRequest(`/api/revenues/${recordId}`, {
                    method: 'PUT',
                    body: JSON.stringify(completePayload)
                });
                serverRecord = res.record;
            } else {
                const res = await syncManager.apiRequest('/api/revenues', {
                    method: 'POST',
                    body: JSON.stringify(completePayload)
                });
                serverRecord = res.record;
            }

            serverRecord._pendingSync = false;

            // Remove any matching pending action from sync queue
            if (window.syncManager && Array.isArray(window.syncManager.syncQueue)) {
                window.syncManager.syncQueue = window.syncManager.syncQueue.filter(q => {
                    const qId = q.tempId || q.data?.id;
                    if (qId === recordId || qId === serverRecord.id) return false;
                    if (q.type === 'CREATE_REVENUE' && q.data) {
                        const sameStore = (q.data.storeId || q.data.store_id) === serverRecord.storeId;
                        const sameDate = q.data.date === serverRecord.date;
                        const sameCash = Math.round((parseFloat(q.data.cash) || 0) * 100) === Math.round(serverRecord.cash * 100);
                        const sameCard = Math.round((parseFloat(q.data.card) || 0) * 100) === Math.round(serverRecord.card * 100);
                        if (sameStore && sameDate && sameCash && sameCard) return false;
                    }
                    return true;
                });
                window.syncManager.saveQueue();
            }

            // Ensure date filter does not hide the freshly saved entry
            if (typeof STATE !== 'undefined' && serverRecord.date) {
                const recMonth = serverRecord.date.substring(0, 7);
                if (STATE.currentMonth && STATE.currentMonth !== recMonth) {
                    STATE.currentMonth = recMonth;
                    const monthSel = document.getElementById('globalMonthSelect');
                    if (monthSel) monthSel.value = recMonth;
                }
                if (STATE.currentStoreId !== 'ALL' && STATE.currentStoreId !== serverRecord.storeId) {
                    STATE.currentStoreId = 'ALL';
                    const storeSel = document.getElementById('globalStoreSelect');
                    if (storeSel) storeSel.value = 'ALL';
                }
            }

            this.applyRevenueToState(serverRecord, isEdit);
            saveStateToLocalStorageCache();
            updateUI();

            showToast(isEdit ? '✓ Umsatz aktualisiert!' : '✓ Umsatz erfolgreich gespeichert!', 'success');
            return { success: true, record: serverRecord };

        } catch (err) {
            if (err.status === 409) {
                if (typeof showConflictModal === 'function') {
                    showConflictModal([err.data || err.serverRecord]);
                }
                throw err;
            }

            if (this.isNetworkError(err)) {
                console.warn('Server nicht erreichbar, sichere Umsatz lokal in Warteschlange:', err.message);
                const localRecord = {
                    ...completePayload,
                    id: recordId,
                    version: completePayload.clientVersion || 1,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    _pendingSync: true
                };

                syncManager.enqueue(isEdit ? 'UPDATE_REVENUE' : 'CREATE_REVENUE', localRecord, completePayload.clientVersion || 1);
                this.applyRevenueToState(localRecord, isEdit);
                saveStateToLocalStorageCache();
                updateUI();

                showToast('⏳ Offline: Datensatz lokal gesichert. Wartet auf Synchronisierung...', 'info');
                return { success: true, offline: true, record: localRecord };
            }

            showToast('⚠ Speichern fehlgeschlagen: ' + err.message, 'error');
            throw err;
        } finally {
            this.setButtonLoading(buttonEl, false);
        }
    }

    applyRevenueToState(record, isEdit) {
        const idx = STATE.revenues.findIndex(r => r.id === record.id);
        if (idx !== -1) {
            STATE.revenues[idx] = { ...STATE.revenues[idx], ...record, _pendingSync: false };
        } else {
            STATE.revenues.unshift({ ...record, _pendingSync: false });
        }
        STATE.revenues.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }

    async deleteRevenue(id) {
        try {
            await syncManager.apiRequest(`/api/revenues/${id}`, { method: 'DELETE' });
            STATE.revenues = STATE.revenues.filter(r => r.id !== id);
            saveStateToLocalStorageCache();
            updateUI();
            showToast('✓ Umsatz gelöscht.', 'info');
            return { success: true };
        } catch (err) {
            if (this.isNetworkError(err)) {
                syncManager.enqueue('DELETE_REVENUE', { id });
                STATE.revenues = STATE.revenues.filter(r => r.id !== id);
                saveStateToLocalStorageCache();
                updateUI();
                showToast('⏳ Offline: Löschung vorgemerkt, wird synchronisiert...', 'info');
                return { success: true, offline: true };
            }
            showToast('⚠ Löschen fehlgeschlagen: ' + err.message, 'error');
            throw err;
        }
    }

    // =========================================================================
    // EXPENSES CRUD
    // =========================================================================

    async saveExpense(payload, buttonEl = null) {
        const isEdit = !!payload.id && !payload._isNew;
        const recordId = payload.id || this.generateId('exp');
        const existing = isEdit ? STATE.expenses.find(e => e.id === recordId) : null;

        const merged = existing ? { ...existing, ...payload } : { ...payload };
        const amountNum = merged.amount !== undefined ? Math.round((parseFloat(merged.amount) || 0) * 100) / 100 : (existing ? existing.amount : 0);

        const completePayload = {
            ...merged,
            id: recordId,
            amount: amountNum,
            clientVersion: existing ? existing.version : (payload.clientVersion || 1)
        };

        this.setButtonLoading(buttonEl, true, '⟳ Wird gespeichert...');

        try {
            let serverRecord;
            if (isEdit) {
                const existing = STATE.expenses.find(e => e.id === recordId);
                completePayload.clientVersion = existing ? existing.version : 1;
                const res = await syncManager.apiRequest(`/api/expenses/${recordId}`, {
                    method: 'PUT',
                    body: JSON.stringify(completePayload)
                });
                serverRecord = res.record;
            } else {
                const res = await syncManager.apiRequest('/api/expenses', {
                    method: 'POST',
                    body: JSON.stringify(completePayload)
                });
                serverRecord = res.record;
            }

            serverRecord._pendingSync = false;

            if (window.syncManager && Array.isArray(window.syncManager.syncQueue)) {
                window.syncManager.syncQueue = window.syncManager.syncQueue.filter(q => {
                    const qId = q.tempId || q.data?.id;
                    if (qId === recordId || qId === serverRecord.id) return false;
                    return true;
                });
                window.syncManager.saveQueue();
            }

            if (typeof STATE !== 'undefined' && serverRecord.date) {
                const recMonth = serverRecord.date.substring(0, 7);
                if (STATE.currentMonth && STATE.currentMonth !== recMonth) {
                    STATE.currentMonth = recMonth;
                    const monthSel = document.getElementById('globalMonthSelect');
                    if (monthSel) monthSel.value = recMonth;
                }
                if (STATE.currentStoreId !== 'ALL' && STATE.currentStoreId !== serverRecord.storeId) {
                    STATE.currentStoreId = 'ALL';
                    const storeSel = document.getElementById('globalStoreSelect');
                    if (storeSel) storeSel.value = 'ALL';
                }
            }

            this.applyExpenseToState(serverRecord, isEdit);
            saveStateToLocalStorageCache();
            updateUI();

            showToast(isEdit ? '✓ Kostenposition aktualisiert!' : '✓ Kosten erfolgreich gespeichert!', 'success');
            return { success: true, record: serverRecord };

        } catch (err) {
            if (err.status === 409) {
                if (typeof showConflictModal === 'function') {
                    showConflictModal([err.data || err.serverRecord]);
                }
                throw err;
            }

            if (this.isNetworkError(err)) {
                console.warn('Server nicht erreichbar, sichere Ausgabe lokal in Warteschlange:', err.message);
                const localRecord = {
                    ...completePayload,
                    id: recordId,
                    version: completePayload.clientVersion || 1,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    _pendingSync: true
                };

                syncManager.enqueue(isEdit ? 'UPDATE_EXPENSE' : 'CREATE_EXPENSE', localRecord, completePayload.clientVersion || 1);
                this.applyExpenseToState(localRecord, isEdit);
                saveStateToLocalStorageCache();
                updateUI();

                showToast('⏳ Offline: Kosten lokal gesichert. Wartet auf Synchronisierung...', 'info');
                return { success: true, offline: true, record: localRecord };
            }

            showToast('⚠ Speichern fehlgeschlagen: ' + err.message, 'error');
            throw err;
        } finally {
            this.setButtonLoading(buttonEl, false);
        }
    }

    applyExpenseToState(record, isEdit) {
        const idx = STATE.expenses.findIndex(e => e.id === record.id);
        if (idx !== -1) {
            STATE.expenses[idx] = { ...STATE.expenses[idx], ...record, _pendingSync: false };
        } else {
            STATE.expenses.unshift({ ...record, _pendingSync: false });
        }
        STATE.expenses.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }

    async deleteExpense(id) {
        try {
            await syncManager.apiRequest(`/api/expenses/${id}`, { method: 'DELETE' });
            STATE.expenses = STATE.expenses.filter(e => e.id !== id);
            saveStateToLocalStorageCache();
            updateUI();
            showToast('✓ Kosten gelöscht.', 'info');
            return { success: true };
        } catch (err) {
            if (this.isNetworkError(err)) {
                syncManager.enqueue('DELETE_EXPENSE', { id });
                STATE.expenses = STATE.expenses.filter(e => e.id !== id);
                saveStateToLocalStorageCache();
                updateUI();
                showToast('⏳ Offline: Löschung vorgemerkt, wird synchronisiert...', 'info');
                return { success: true, offline: true };
            }
            showToast('⚠ Löschen fehlgeschlagen: ' + err.message, 'error');
            throw err;
        }
    }

    // =========================================================================
    // PRODUCTS CRUD
    // =========================================================================

    async saveProduct(payload, buttonEl = null) {
        const isEdit = !!payload.id && !payload._isNew;
        const recordId = payload.id || this.generateId('prod');
        const existing = isEdit ? STATE.products.find(p => p.id === recordId) : null;

        const merged = existing ? { ...existing, ...payload } : { ...payload };
        const costNum = merged.costPrice !== undefined ? Math.round((parseFloat(merged.costPrice) || 0) * 100) / 100 : (existing ? existing.costPrice : 0);
        const sellNum = merged.sellPrice !== undefined ? Math.round((parseFloat(merged.sellPrice) || 0) * 100) / 100 : (existing ? existing.sellPrice : 0);

        const completePayload = {
            ...merged,
            id: recordId,
            costPrice: costNum,
            sellPrice: sellNum,
            stockQuantity: merged.stockQuantity !== undefined ? parseInt(merged.stockQuantity) : (existing ? existing.stockQuantity : 0),
            minStock: merged.minStock !== undefined ? parseInt(merged.minStock) : (existing ? existing.minStock : 0),
            clientVersion: existing ? existing.version : (payload.clientVersion || 1)
        };

        this.setButtonLoading(buttonEl, true, '⟳ Wird gespeichert...');

        try {
            let serverRecord;
            if (isEdit) {
                const existing = STATE.products.find(p => p.id === recordId);
                completePayload.clientVersion = existing ? existing.version : 1;
                const res = await syncManager.apiRequest(`/api/products/${recordId}`, {
                    method: 'PUT',
                    body: JSON.stringify(completePayload)
                });
                serverRecord = res.product || res.record;
            } else {
                const res = await syncManager.apiRequest('/api/products', {
                    method: 'POST',
                    body: JSON.stringify(completePayload)
                });
                serverRecord = res.product || res.record;
            }

            serverRecord._pendingSync = false;

            if (window.syncManager && Array.isArray(window.syncManager.syncQueue)) {
                window.syncManager.syncQueue = window.syncManager.syncQueue.filter(q => {
                    const qId = q.tempId || q.data?.id;
                    if (qId === recordId || qId === serverRecord.id) return false;
                    return true;
                });
                window.syncManager.saveQueue();
            }

            this.applyProductToState(serverRecord, isEdit);
            saveStateToLocalStorageCache();
            updateUI();

            showToast(isEdit ? '✓ Artikel aktualisiert!' : '✓ Neuer Artikel angelegt!', 'success');
            return { success: true, product: serverRecord };

        } catch (err) {
            if (err.status === 409) {
                if (typeof showConflictModal === 'function') {
                    showConflictModal([err.data || err.serverRecord]);
                }
                throw err;
            }

            if (this.isNetworkError(err)) {
                console.warn('Server nicht erreichbar, sichere Artikel lokal in Warteschlange:', err.message);
                const localRecord = {
                    ...completePayload,
                    id: recordId,
                    version: completePayload.clientVersion || 1,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    _pendingSync: true
                };

                syncManager.enqueue(isEdit ? 'UPDATE_PRODUCT' : 'CREATE_PRODUCT', localRecord, completePayload.clientVersion || 1);
                this.applyProductToState(localRecord, isEdit);
                saveStateToLocalStorageCache();
                updateUI();

                showToast('⏳ Offline: Artikel lokal gesichert. Wartet auf Synchronisierung...', 'info');
                return { success: true, offline: true, product: localRecord };
            }

            showToast('⚠ Speichern fehlgeschlagen: ' + err.message, 'error');
            throw err;
        } finally {
            this.setButtonLoading(buttonEl, false);
        }
    }

    applyProductToState(record, isEdit) {
        const idx = STATE.products.findIndex(p => p.id === record.id);
        if (idx !== -1) {
            STATE.products[idx] = { ...STATE.products[idx], ...record, _pendingSync: false };
        } else {
            STATE.products.push({ ...record, _pendingSync: false });
        }
        STATE.products.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }

    async deleteProduct(id) {
        try {
            await syncManager.apiRequest(`/api/products/${id}`, { method: 'DELETE' });
            STATE.products = STATE.products.filter(p => p.id !== id);
            saveStateToLocalStorageCache();
            updateUI();
            showToast('✓ Artikel gelöscht.', 'info');
            return { success: true };
        } catch (err) {
            if (this.isNetworkError(err)) {
                syncManager.enqueue('DELETE_PRODUCT', { id });
                STATE.products = STATE.products.filter(p => p.id !== id);
                saveStateToLocalStorageCache();
                updateUI();
                showToast('⏳ Offline: Löschung vorgemerkt, wird synchronisiert...', 'info');
                return { success: true, offline: true };
            }
            showToast('⚠ Löschen fehlgeschlagen: ' + err.message, 'error');
            throw err;
        }
    }

    async adjustProductStock(id, delta, movementType = 'correction', reason = '') {
        const prod = STATE.products.find(p => p.id === id);
        if (!prod) return;

        try {
            const res = await syncManager.apiRequest(`/api/products/${id}/stock-movement`, {
                method: 'POST',
                body: JSON.stringify({ delta, movementType, reason, storeId: prod.storeId })
            });
            if (res.product) {
                this.applyProductToState(res.product, true);
                saveStateToLocalStorageCache();
                updateUI();
                const sign = delta > 0 ? '+' : '';
                showToast(`Bestand geändert: ${prod.name} (${sign}${delta} -> ${res.product.stockQuantity} ${res.product.unit || 'Stück'})`, 'success');
                return res;
            }
        } catch (err) {
            console.warn('Fast stock adjustment offline fallback:', err.message);
            const newStock = Math.max(0, (prod.stockQuantity || 0) + delta);
            return this.saveProduct({ ...prod, stockQuantity: newStock });
        }
    }

    async importProductsCsv(items, duplicateStrategy = 'update') {
        const res = await syncManager.apiRequest('/api/products/import-csv', {
            method: 'POST',
            body: JSON.stringify({ items, duplicateStrategy })
        });
        if (res && res.success) {
            const freshProducts = await syncManager.apiRequest('/api/products');
            STATE.products = freshProducts.map(p => ({ ...p, _pendingSync: false }));
            saveStateToLocalStorageCache();
            updateUI();
        }
        return res;
    }

    // =========================================================================
    // STORES CRUD
    // =========================================================================

    async saveStore(payload, buttonEl = null) {
        const isEdit = !!payload.id && !payload._isNew;
        const recordId = payload.id || this.generateId('store');
        const existing = isEdit ? STATE.stores.find(s => s.id === recordId) : null;

        const merged = existing ? { ...existing, ...payload } : { ...payload };
        const targetRev = merged.targetRevenue !== undefined ? Math.round((parseFloat(merged.targetRevenue) || 0) * 100) / 100 : (existing ? existing.targetRevenue : 0);

        const completePayload = {
            ...merged,
            id: recordId,
            targetRevenue: targetRev,
            employeeCount: merged.employeeCount !== undefined ? parseInt(merged.employeeCount) : (existing ? existing.employeeCount : 2),
            clientVersion: existing ? existing.version : (payload.clientVersion || 1)
        };

        this.setButtonLoading(buttonEl, true, '⟳ Wird gespeichert...');

        try {
            let serverRecord;
            if (isEdit) {
                const existing = STATE.stores.find(s => s.id === recordId);
                completePayload.clientVersion = existing ? existing.version : 1;
                await syncManager.apiRequest(`/api/stores/${recordId}`, {
                    method: 'PUT',
                    body: JSON.stringify(completePayload)
                });
                serverRecord = { ...completePayload, version: (existing?.version || 1) + 1 };
            } else {
                await syncManager.apiRequest('/api/stores', {
                    method: 'POST',
                    body: JSON.stringify(completePayload)
                });
                serverRecord = { ...completePayload, version: 1 };
            }

            serverRecord._pendingSync = false;

            if (window.syncManager && Array.isArray(window.syncManager.syncQueue)) {
                window.syncManager.syncQueue = window.syncManager.syncQueue.filter(q => {
                    const qId = q.tempId || q.data?.id;
                    if (qId === recordId || qId === serverRecord.id) return false;
                    return true;
                });
                window.syncManager.saveQueue();
            }

            this.applyStoreToState(serverRecord, isEdit);
            saveStateToLocalStorageCache();
            updateUI();

            showToast(isEdit ? '✓ Filiale aktualisiert!' : '✓ Neue Filiale angelegt!', 'success');
            return { success: true, store: serverRecord };

        } catch (err) {
            if (err.status === 409) {
                if (typeof showConflictModal === 'function') {
                    showConflictModal([err.data || err.serverRecord]);
                }
                throw err;
            }

            if (this.isNetworkError(err)) {
                console.warn('Server nicht erreichbar, sichere Filiale lokal in Warteschlange:', err.message);
                const localRecord = {
                    ...completePayload,
                    id: recordId,
                    version: completePayload.clientVersion || 1,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    _pendingSync: true
                };

                syncManager.enqueue(isEdit ? 'UPDATE_STORE' : 'CREATE_STORE', localRecord, completePayload.clientVersion || 1);
                this.applyStoreToState(localRecord, isEdit);
                saveStateToLocalStorageCache();
                updateUI();

                showToast('⏳ Offline: Filiale lokal gesichert. Wartet auf Synchronisierung...', 'info');
                return { success: true, offline: true, store: localRecord };
            }

            showToast('⚠ Speichern fehlgeschlagen: ' + err.message, 'error');
            throw err;
        } finally {
            this.setButtonLoading(buttonEl, false);
        }
    }

    applyStoreToState(record, isEdit) {
        const idx = STATE.stores.findIndex(s => s.id === record.id);
        if (idx !== -1) {
            STATE.stores[idx] = { ...STATE.stores[idx], ...record, _pendingSync: false };
        } else {
            STATE.stores.push({ ...record, _pendingSync: false });
        }
    }

    async deleteStore(id) {
        try {
            await syncManager.apiRequest(`/api/stores/${id}`, { method: 'DELETE' });
            STATE.stores = STATE.stores.filter(s => s.id !== id);
            saveStateToLocalStorageCache();
            updateUI();
            showToast('✓ Filiale gelöscht.', 'info');
            return { success: true };
        } catch (err) {
            if (this.isNetworkError(err)) {
                syncManager.enqueue('DELETE_STORE', { id });
                STATE.stores = STATE.stores.filter(s => s.id !== id);
                saveStateToLocalStorageCache();
                updateUI();
                showToast('⏳ Offline: Löschung vorgemerkt, wird synchronisiert...', 'info');
                return { success: true, offline: true };
            }
            showToast('⚠ Löschen fehlgeschlagen: ' + err.message, 'error');
            throw err;
        }
    }
}

// Global Singleton Instance
window.dataService = new DataService();
