/**
 * StoreControl Pro 2.0 - Centralized Multi-Device Retail & Revenue Manager
 * Handles financial calculations, multi-store metrics, offline sync,
 * touch numpad rapid booking, inventory/products, camera barcode scanning,
 * and live synchronization across Smartphone & PC.
 */

// Global State
const STATE = {
    stores: [],
    revenues: [],
    expenses: [],
    products: [],
    auditLogs: [],
    currentStoreId: 'ALL',
    currentMonth: '', // YYYY-MM
    activeTab: 'dashboard',
    numpad: {
        cents: 0
    },
    charts: {
        trend: null,
        costBreakdown: null
    },
    scannerStream: null,
    scannerInterval: null,
    isLowStockFilterActive: false,
    barcodeScanTargetInput: null,
    quickScanHtml5Qr: null,
    csvImportState: {
        rawText: '',
        delimiter: ';',
        headers: [],
        rows: [],
        mapping: {},
        validRows: [],
        invalidRows: []
    }
};

// LocalStorage Keys for Offline Caching
const STORAGE_KEYS = {
    STORES: 'storecontrol_stores_v1',
    REVENUES: 'storecontrol_revenues_v1',
    EXPENSES: 'storecontrol_expenses_v1',
    PRODUCTS: 'storecontrol_products_v1',
    MIGRATION_DISMISSED: 'storecontrol_migration_dismissed'
};

// Color Palette for Stores & Categories
const STORE_COLORS = {
    emerald: { bg: 'bg-emerald-500', text: 'text-emerald-700', badge: 'bg-emerald-100 text-emerald-800' },
    blue: { bg: 'bg-blue-500', text: 'text-blue-700', badge: 'bg-blue-100 text-blue-800' },
    purple: { bg: 'bg-purple-500', text: 'text-purple-700', badge: 'bg-purple-100 text-purple-800' },
    amber: { bg: 'bg-amber-500', text: 'text-amber-700', badge: 'bg-amber-100 text-amber-800' },
    rose: { bg: 'bg-rose-500', text: 'text-rose-700', badge: 'bg-rose-100 text-rose-800' },
    teal: { bg: 'bg-teal-500', text: 'text-teal-700', badge: 'bg-teal-100 text-teal-800' }
};

const CATEGORY_NAMES = {
    staff: '👤 Mitarbeiterkosten',
    rent: '🏢 Miete & Nebenkosten',
    goods: '📦 Warenkosten (Wareneinsatz)',
    other: '🏷️ Sonstige Betriebskosten'
};

// =============================================================================
// INITIALIZATION
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    initDefaultDates();
    initEventListeners();
    initSyncObservers();

    // Check for Smartphone Pairing Code in URL (?pair=...)
    const urlParams = new URLSearchParams(window.location.search);
    const pairCode = urlParams.get('pair');
    if (pairCode && window.syncManager) {
        console.log('📱 Kopplungscode in URL erkannt:', pairCode);
        try {
            const pairResult = await syncManager.pairDevice(pairCode);
            if (pairResult.success) {
                console.log('✅ Smartphone dauerhaft mit Store Control gekoppelt als:', pairResult.user?.username);
                // Remove ?pair= from URL to keep clean URL for PWA / Home Screen
                if (window.history && window.history.replaceState) {
                    window.history.replaceState({}, document.title, window.location.pathname);
                }
                if (typeof showToast === 'function') {
                    showToast('✅ Smartphone dauerhaft verbunden!', 'success');
                }
            } else {
                console.warn('Pairing failed:', pairResult.error);
            }
        } catch (pErr) {
            console.warn('Pairing error:', pErr);
        }
    }

    // Check Auto-Login or Session
    await ensureAuthentication();

    // Load initial data from server or local offline cache
    await loadInitialData();

    // Reconcile and synchronize any pending items with central database immediately
    if (window.syncManager) {
        await syncManager.reconcileExistingPendingWithServer();
        syncManager.syncNow().catch(e => console.warn('Initial sync deferred:', e.message));
    }

    // Check for existing unmigrated browser data
    checkLocalStorageMigrationNeeded();

    // Render UI
    updateUI();

    // Fetch public HTTPS & QR code for smartphone
    loadPublicUrlInfo();

    // Initialize PWA installation listeners and buttons
    initPwaInstallManager();
});

function initDefaultDates() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    
    STATE.currentMonth = `${yyyy}-${mm}`;
    
    const dateInput = document.getElementById('revDate');
    if (dateInput) dateInput.value = `${yyyy}-${mm}-${dd}`;
    const expDateInput = document.getElementById('expDate');
    if (expDateInput) expDateInput.value = `${yyyy}-${mm}-${dd}`;
    const numpadDate = document.getElementById('numpadDate');
    if (numpadDate) numpadDate.value = `${yyyy}-${mm}-${dd}`;

    const monthSelect = document.getElementById('globalMonthSelect');
    if (monthSelect) monthSelect.value = STATE.currentMonth;
}

function initEventListeners() {
    // Global store filter
    const storeSelect = document.getElementById('globalStoreSelect');
    if (storeSelect) {
        storeSelect.addEventListener('change', (e) => {
            STATE.currentStoreId = e.target.value;
            updateUI();
        });
    }

    // Global month filter
    const monthSelect = document.getElementById('globalMonthSelect');
    if (monthSelect) {
        monthSelect.addEventListener('change', (e) => {
            STATE.currentMonth = e.target.value;
            loadDataFromServer();
        });
    }

    // Search filters
    const revSearch = document.getElementById('revenueSearchInput');
    if (revSearch) revSearch.addEventListener('input', renderRevenuesTable);

    const expSearch = document.getElementById('expenseSearchInput');
    if (expSearch) expSearch.addEventListener('input', renderExpensesTable);

    const expCatFilter = document.getElementById('expenseCategoryFilter');
    if (expCatFilter) expCatFilter.addEventListener('change', renderExpensesTable);
}

// =============================================================================
// AUTHENTICATION & SESSION MANAGEMENT
// =============================================================================

async function ensureAuthentication() {
    if (!window.syncManager) return;

    let validAuth = false;

    // 1. Check persistent device token (stays permanently on Smartphone)
    const deviceToken = syncManager.getDeviceToken();
    if (deviceToken) {
        try {
            const verifyRes = await fetch('/api/auth/verify-device', {
                headers: { 'X-Device-Token': deviceToken }
            });
            if (verifyRes.ok) {
                const verifyData = await verifyRes.json();
                if (verifyData.sessionToken) {
                    syncManager.setAuth(verifyData.sessionToken, verifyData.user);
                    updateUserDisplay(verifyData.user);
                    validAuth = true;
                    return;
                }
            }
        } catch (devErr) {
            console.warn('Device verify offline or starting:', devErr.message);
        }
    }

    // 2. Check existing session token
    if (syncManager.isLoggedIn()) {
        try {
            const meRes = await fetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${syncManager.getToken()}` }
            });
            if (meRes.ok) {
                const meData = await meRes.json();
                validAuth = true;
                updateUserDisplay(meData.user);
            }
        } catch (e) {
            console.warn('Check auth me failed, offline or server starting:', e.message);
        }
    }

    if (!validAuth) {
        try {
            // Attempt auto-login with default admin credentials for seamless first run
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'admin', password: 'admin123' })
            });
            if (res.ok) {
                const data = await res.json();
                syncManager.setAuth(data.token, data.user);
                updateUserDisplay(data.user);
            }
        } catch (err) {
            console.log('Server not reachable yet or offline, continuing in cached mode.');
        }
    }
}

function updateUserDisplay(user) {
    const navUsername = document.getElementById('navUsername');
    if (navUsername && user) {
        navUsername.textContent = user.display_name || user.username;
    }

    const loginModalSubtitle = document.getElementById('loginModalSubtitle');
    const loggedInView = document.getElementById('loggedInView');
    const loginForm = document.getElementById('loginForm');
    const loggedDisplayName = document.getElementById('loggedDisplayName');
    const loggedRole = document.getElementById('loggedRole');

    if (user && syncManager.isLoggedIn()) {
        if (loginModalSubtitle) loginModalSubtitle.textContent = `Angemeldet als ${user.display_name || user.username}`;
        if (loggedInView) loggedInView.classList.remove('hidden');
        if (loginForm) loginForm.classList.add('hidden');
        if (loggedDisplayName) loggedDisplayName.textContent = user.display_name || user.username;
        if (loggedRole) loggedRole.textContent = user.role;
    } else {
        if (loginModalSubtitle) loginModalSubtitle.textContent = 'Bitte melden Sie sich an';
        if (loggedInView) loggedInView.classList.add('hidden');
        if (loginForm) loginForm.classList.remove('hidden');
    }
}

async function handleLoginSubmit(e) {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Anmeldung fehlgeschlagen');

        syncManager.setAuth(data.token, data.user);
        updateUserDisplay(data.user);
        closeModal('loginModal');
        showToast(`Willkommen zurück, ${data.user.display_name}!`, 'success');

        await loadDataFromServer();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function handleLogout() {
    syncManager.setAuth(null, null);
    updateUserDisplay(null);
    closeModal('loginModal');
    showToast('Erfolgreich abgemeldet.', 'info');
}

// =============================================================================
// REAL-TIME SYNC & OBSERVERS
// =============================================================================

function initSyncObservers() {
    if (!window.syncManager) return;

    // Listen for remote real-time events from other devices (SSE)
    syncManager.onChange((type, payload) => {
        console.log('🔄 Remote Event empfangen, aktualisiere Ansicht:', type);
        loadDataFromServer(false); // Reload quietly in background
    });

    // Listen for connectivity and queue status updates
    syncManager.onStatusChange((status) => {
        updateSyncBadge(status);
    });

    // Listen for conflicts
    syncManager.onConflict((conflicts) => {
        showConflictModal(conflicts);
    });
}

function updateSyncBadge(status) {
    const btn = document.getElementById('syncStatusBtn');
    const dot = document.getElementById('syncIndicatorDot');
    const text = document.getElementById('syncStatusText');
    if (!btn || !dot || !text) return;

    if (status.isSyncing) {
        btn.className = 'flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-xs font-semibold bg-brand-900/60 text-brand-300 border border-brand-500/40 cursor-pointer';
        dot.className = 'w-2 h-2 rounded-full bg-brand-400 animate-spin';
        text.textContent = 'Synchronisiere...';
    } else if (status.pendingCount > 0) {
        btn.className = 'flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-900/60 text-amber-300 border border-amber-500/40 cursor-pointer';
        dot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
        text.textContent = `${status.pendingCount} ausstehend`;
    } else if (status.isOnline) {
        btn.className = 'flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-800 text-emerald-400 border border-emerald-500/30 hover:bg-slate-700/80 transition cursor-pointer';
        dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
        text.textContent = 'Live-Sync';
    } else {
        btn.className = 'flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-900/60 text-rose-300 border border-rose-500/40 cursor-pointer';
        dot.className = 'w-2 h-2 rounded-full bg-rose-400';
        text.textContent = 'Offline';
    }
}

function triggerManualSync() {
    if (window.syncManager) {
        showToast('Synchronisation wird ausgeführt...', 'info');
        syncManager.syncNow().then(() => {
            loadDataFromServer();
            showToast('Synchronisation abgeschlossen', 'success');
        }).catch(err => {
            showToast('Sync fehlgeschlagen: ' + err.message, 'error');
        });
    }
}

// =============================================================================
// DATA LOADING & CACHING PIPELINE
// =============================================================================

async function loadInitialData() {
    // 1. Try to load cached state first for instant UI response
    loadStateFromLocalStorageCache();

    // 2. Refresh with authoritative server data
    await loadDataFromServer(true);
}

function loadStateFromLocalStorageCache() {
    try {
        const savedStores = localStorage.getItem(STORAGE_KEYS.STORES);
        const savedRevenues = localStorage.getItem(STORAGE_KEYS.REVENUES);
        const savedExpenses = localStorage.getItem(STORAGE_KEYS.EXPENSES);
        const savedProducts = localStorage.getItem(STORAGE_KEYS.PRODUCTS);

        if (savedStores) STATE.stores = JSON.parse(savedStores);
        if (savedRevenues) STATE.revenues = JSON.parse(savedRevenues);
        if (savedExpenses) STATE.expenses = JSON.parse(savedExpenses);
        if (savedProducts) STATE.products = JSON.parse(savedProducts);
    } catch (e) {
        console.warn('Fehler beim Laden des Offline-Caches:', e);
    }
}

function saveStateToLocalStorageCache() {
    try {
        localStorage.setItem(STORAGE_KEYS.STORES, JSON.stringify(STATE.stores));
        localStorage.setItem(STORAGE_KEYS.REVENUES, JSON.stringify(STATE.revenues));
        localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(STATE.expenses));
        localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(STATE.products));
    } catch (e) {
        console.warn('Fehler beim Speichern in Cache:', e);
    }
}

async function loadDataFromServer(showErrors = false) {
    if (!window.syncManager || !syncManager.isLoggedIn()) return;

    try {
        const [storesData, revenuesData, expensesData, productsData] = await Promise.all([
            syncManager.apiRequest('/api/stores'),
            syncManager.apiRequest(`/api/revenues?month=${encodeURIComponent(STATE.currentMonth)}`),
            syncManager.apiRequest(`/api/expenses?month=${encodeURIComponent(STATE.currentMonth)}`),
            syncManager.apiRequest('/api/products')
        ]);

        const serverStores = (storesData || []).map(s => ({ ...s, _pendingSync: false }));
        const serverRevs = (revenuesData || []).map(r => ({ ...r, _pendingSync: false }));
        const serverExps = (expensesData || []).map(e => ({ ...e, _pendingSync: false }));
        const serverProds = (productsData || []).map(p => ({ ...p, _pendingSync: false }));

        // Canonical Server ID sets
        const serverRevIds = new Set(serverRevs.map(r => r.id));
        const serverExpIds = new Set(serverExps.map(e => e.id));
        const serverProdIds = new Set(serverProds.map(p => p.id));
        const serverStoreIds = new Set(serverStores.map(s => s.id));

        // NON-DESTRUCTIVE SELF-HEALING MERGE:
        // Local business records must NEVER be discarded when missing on the server.
        // Instead, they are preserved and automatically re-committed to the central database.
        const missingRevsToReconcile = [];
        const mergedRevenues = [...serverRevs];
        for (const localRev of (STATE.revenues || [])) {
            if (!localRev || !localRev.id || localRev._deletedLocally) continue;
            if (!serverRevIds.has(localRev.id)) {
                const isQueriedMonth = !STATE.currentMonth || (localRev.date && localRev.date.startsWith(STATE.currentMonth));
                if (isQueriedMonth) {
                    console.warn('⚠️ Lokaler Umsatz auf Server nicht vorhanden. Sichere Datensatz & starte Selbstheilung:', localRev.id, localRev.date, localRev.total);
                    localRev._pendingSync = true;
                    missingRevsToReconcile.push({
                        type: 'CREATE_REVENUE',
                        tempId: localRev.id,
                        data: localRev
                    });
                }
                mergedRevenues.push(localRev);
            }
        }

        const missingExpsToReconcile = [];
        const mergedExpenses = [...serverExps];
        for (const localExp of (STATE.expenses || [])) {
            if (!localExp || !localExp.id || localExp._deletedLocally) continue;
            if (!serverExpIds.has(localExp.id)) {
                const isQueriedMonth = !STATE.currentMonth || (localExp.date && localExp.date.startsWith(STATE.currentMonth));
                if (isQueriedMonth) {
                    localExp._pendingSync = true;
                    missingExpsToReconcile.push({
                        type: 'CREATE_EXPENSE',
                        tempId: localExp.id,
                        data: localExp
                    });
                }
                mergedExpenses.push(localExp);
            }
        }

        const mergedProducts = [...serverProds];
        for (const p of (STATE.products || [])) {
            if (p && p.id && !p._deletedLocally && !serverProdIds.has(p.id)) {
                mergedProducts.push(p);
            }
        }

        const mergedStores = [...serverStores];
        for (const s of (STATE.stores || [])) {
            if (s && s.id && !s._deletedLocally && !serverStoreIds.has(s.id)) {
                mergedStores.push(s);
            }
        }

        STATE.stores = mergedStores;
        STATE.revenues = mergedRevenues;
        STATE.revenues.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        STATE.expenses = mergedExpenses;
        STATE.expenses.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        STATE.products = mergedProducts;

        saveStateToLocalStorageCache();
        updateUI();

        // Automatic Background Reconciliation (Self-Healing)
        const itemsToHeal = [...missingRevsToReconcile, ...missingExpsToReconcile];
        if (itemsToHeal.length > 0 && window.syncManager && syncManager.isLoggedIn()) {
            console.log('🚑 Sende ' + itemsToHeal.length + ' lokale Datensätze an zentrale Datenbank zur Selbstheilung...');
            syncManager.apiRequest('/api/sync/reconcile', {
                method: 'POST',
                body: JSON.stringify({ items: itemsToHeal })
            }).then(res => {
                if (res && res.reconciled && res.reconciled.length > 0) {
                    console.log('✓ Selbstheilung erfolgreich abgeschlossen: ' + res.reconciled.length + ' Datensätze zentral persistiert.');
                    for (const r of res.reconciled) {
                        const rec = STATE.revenues.find(item => item.id === r.originalId || item.id === r.serverId);
                        if (rec) rec._pendingSync = false;
                    }
                    saveStateToLocalStorageCache();
                    updateUI();
                }
            }).catch(e => {
                console.warn('Selbstheilungs-Retry aufgeschoben:', e.message);
            });
        }
    } catch (err) {
        if (showErrors && err.message !== 'Sitzung abgelaufen') {
            console.warn('Server offline, arbeite mit lokalem Stand:', err.message);
        }
    }
}

// =============================================================================
// LOCALSTORAGE MIGRATION DETECTION
// =============================================================================

function checkLocalStorageMigrationNeeded() {
    const isDismissed = localStorage.getItem(STORAGE_KEYS.MIGRATION_DISMISSED);
    if (isDismissed) return;

    // Check if there are items in localStorage that are not in the SQLite database yet
    const localStores = JSON.parse(localStorage.getItem(STORAGE_KEYS.STORES) || '[]');
    const localRevenues = JSON.parse(localStorage.getItem(STORAGE_KEYS.REVENUES) || '[]');

    if (localRevenues.length > 0 && STATE.revenues.length === 0) {
        const banner = document.getElementById('migrationBanner');
        if (banner) banner.classList.remove('hidden');
    }
}

function dismissMigrationBanner() {
    localStorage.setItem(STORAGE_KEYS.MIGRATION_DISMISSED, 'true');
    const banner = document.getElementById('migrationBanner');
    if (banner) banner.classList.add('hidden');
}

async function runLocalStorageMigration() {
    try {
        const stores = JSON.parse(localStorage.getItem(STORAGE_KEYS.STORES) || '[]');
        const revenues = JSON.parse(localStorage.getItem(STORAGE_KEYS.REVENUES) || '[]');
        const expenses = JSON.parse(localStorage.getItem(STORAGE_KEYS.EXPENSES) || '[]');

        const res = await syncManager.apiRequest('/api/migration/import', {
            method: 'POST',
            body: JSON.stringify({ stores, revenues, expenses })
        });

        showToast(res.message || 'Altdaten erfolgreich übertragen!', 'success');
        dismissMigrationBanner();
        await loadDataFromServer(true);
    } catch (err) {
        showToast('Migration fehlgeschlagen: ' + err.message, 'error');
    }
}

// =============================================================================
// MAIN UI UPDATE & RENDER PIPELINE
// =============================================================================

function updateUI() {
    updateStoreDropdowns();
    renderBannerNotice();
    renderDashboardKPIs();
    renderCharts();
    renderStoreComparisonTable();
    renderRecentLists();
    renderRevenuesTable();
    renderExpensesTable();
    renderProductsTable();
    renderMonthlyReport();
    renderStoresGrid();

    // Re-initialize Lucide icons
    if (window.lucide) {
        lucide.createIcons();
    }
}

function switchTab(tabId) {
    STATE.activeTab = tabId;
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    
    const target = document.getElementById(`tab-${tabId}`);
    if (target) {
        target.classList.remove('hidden');
    }

    // Highlight active nav button
    document.querySelectorAll('.nav-tab').forEach(btn => {
        btn.classList.remove('active-tab');
        if (btn.getAttribute('onclick')?.includes(`'${tabId}'`)) {
            btn.classList.add('active-tab');
        }
    });

    // Mobile bottom nav active state
    document.querySelectorAll('.mobile-bottom-nav .nav-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('onclick')?.includes(`'${tabId}'`)) {
            btn.classList.add('active');
        }
    });

    // Ensure the active tab view is freshly rendered from latest STATE
    if (tabId === 'dashboard') {
        renderDashboardKPIs();
        renderCharts();
        renderStoreComparisonTable();
        renderRecentLists();
    } else if (tabId === 'revenues') {
        renderRevenuesTable();
    } else if (tabId === 'expenses') {
        renderExpensesTable();
    } else if (tabId === 'products') {
        renderProductsTable();
    } else if (tabId === 'monthlyReport') {
        renderMonthlyReport();
    } else if (tabId === 'stores') {
        renderStoresGrid();
    } else if (tabId === 'auditLogs') {
        loadAuditLogs();
    }

    if (window.lucide) {
        lucide.createIcons();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateStoreDropdowns() {
    const globalSelect = document.getElementById('globalStoreSelect');
    const revStoreSelect = document.getElementById('revStoreId');
    const expStoreSelect = document.getElementById('expStoreId');
    const numpadStoreSelect = document.getElementById('numpadStoreId');
    const prodStoreSelect = document.getElementById('prodStoreId');

    const prevGlobalVal = globalSelect ? globalSelect.value : 'ALL';
    const optStyle = 'style="background-color: #ffffff !important; color: #0f172a !important; font-weight: 600;"';
    
    if (globalSelect) {
        globalSelect.innerHTML = '<option value="ALL" class="store-opt" ' + optStyle + '>⭐ Alle Filialen (Gesamt)</option>';
    }
    if (revStoreSelect) revStoreSelect.innerHTML = '';
    if (expStoreSelect) expStoreSelect.innerHTML = '';
    if (numpadStoreSelect) numpadStoreSelect.innerHTML = '';
    if (prodStoreSelect) prodStoreSelect.innerHTML = '<option value="" class="store-opt" ' + optStyle + '>Alle Filialen (Zentrallager)</option>';

    STATE.stores.forEach(store => {
        const globalOpt = `<option value="${store.id}" class="store-opt" ${optStyle}>● ${escapeHtml(store.name)}</option>`;
        const modalOpt = `<option value="${store.id}" class="store-opt" ${optStyle}>${escapeHtml(store.name)}</option>`;
        
        if (globalSelect) globalSelect.insertAdjacentHTML('beforeend', globalOpt);
        if (revStoreSelect) revStoreSelect.insertAdjacentHTML('beforeend', modalOpt);
        if (expStoreSelect) expStoreSelect.insertAdjacentHTML('beforeend', modalOpt);
        if (numpadStoreSelect) numpadStoreSelect.insertAdjacentHTML('beforeend', modalOpt);
        if (prodStoreSelect) prodStoreSelect.insertAdjacentHTML('beforeend', modalOpt);
    });

    if (globalSelect) {
        globalSelect.value = prevGlobalVal;
        STATE.currentStoreId = globalSelect.value;
    }
}

function renderBannerNotice() {
    const bannerText = document.getElementById('bannerActiveFilterText');
    const reportHeader = document.getElementById('reportHeaderPeriod');

    let storeName = 'Alle Filialen';
    if (STATE.currentStoreId !== 'ALL') {
        const found = STATE.stores.find(s => s.id === STATE.currentStoreId);
        if (found) storeName = found.name;
    }

    const [year, month] = STATE.currentMonth.split('-');
    const dateObj = new Date(year, parseInt(month) - 1, 1);
    const monthName = dateObj.toLocaleString('de-DE', { month: 'long', year: 'numeric' });

    if (bannerText) {
        bannerText.textContent = `${storeName} | ${monthName}`;
    }
    if (reportHeader) {
        reportHeader.textContent = `Monat: ${monthName} | Filiale: ${storeName}`;
    }
    const reportGen = document.getElementById('reportGeneratedAt');
    if (reportGen) {
        reportGen.textContent = new Date().toLocaleString('de-DE');
    }
}

// =============================================================================
// FINANCIAL CALCULATIONS & KPIs
// =============================================================================

function getFilteredData() {
    let revs = STATE.revenues;
    let exps = STATE.expenses;

    if (STATE.currentStoreId !== 'ALL') {
        revs = revs.filter(r => r.storeId === STATE.currentStoreId);
        exps = exps.filter(e => e.storeId === STATE.currentStoreId);
    }

    // Filter by month
    if (STATE.currentMonth) {
        revs = revs.filter(r => r.date && r.date.startsWith(STATE.currentMonth));
        exps = exps.filter(e => e.date && e.date.startsWith(STATE.currentMonth));
    }

    return { revenues: revs, expenses: exps };
}

function calculateTotals(revenuesList, expensesList) {
    let totalCashCents = 0;
    let totalCardCents = 0;
    let totalRevenueCents = 0;

    revenuesList.forEach(r => {
        totalCashCents += Math.round((parseFloat(r.cash) || 0) * 100);
        totalCardCents += Math.round((parseFloat(r.card) || 0) * 100);
        totalRevenueCents += Math.round((parseFloat(r.total) || 0) * 100);
    });

    let totalStaffCents = 0;
    let totalRentCents = 0;
    let totalGoodsCents = 0;
    let totalOtherCents = 0;
    let totalExpensesCents = 0;

    expensesList.forEach(e => {
        const amountCents = Math.round((parseFloat(e.amount) || 0) * 100);
        totalExpensesCents += amountCents;
        if (e.category === 'staff') totalStaffCents += amountCents;
        else if (e.category === 'rent') totalRentCents += amountCents;
        else if (e.category === 'goods') totalGoodsCents += amountCents;
        else if (e.category === 'other') totalOtherCents += amountCents;
    });

    const totalCash = totalCashCents / 100;
    const totalCard = totalCardCents / 100;
    const totalRevenue = totalRevenueCents / 100;
    const totalStaff = totalStaffCents / 100;
    const totalRent = totalRentCents / 100;
    const totalGoods = totalGoodsCents / 100;
    const totalOther = totalOtherCents / 100;
    const totalExpenses = totalExpensesCents / 100;

    const grossProfitCents = totalRevenueCents - totalGoodsCents;
    const netProfitCents = totalRevenueCents - totalExpensesCents;
    const grossProfit = grossProfitCents / 100;
    const netProfit = netProfitCents / 100;

    const profitMargin = totalRevenueCents > 0 ? (netProfitCents / totalRevenueCents) * 100 : 0;
    const costRatio = totalRevenueCents > 0 ? (totalExpensesCents / totalRevenueCents) * 100 : 0;

    return {
        totalCash,
        totalCard,
        totalRevenue,
        totalStaff,
        totalRent,
        totalGoods,
        totalOther,
        totalExpenses,
        grossProfit,
        netProfit,
        profitMargin,
        costRatio,
        revenueCount: revenuesList.length,
        expenseCount: expensesList.length
    };
}

function renderDashboardKPIs() {
    const { revenues, expenses } = getFilteredData();
    const totals = calculateTotals(revenues, expenses);

    // Today's revenue calculation with cent precision
    const todayStr = getTodayString();
    let todayRevs = revenues.filter(r => r.date === todayStr);
    let todayCashCents = 0, todayCardCents = 0, todayTotalCents = 0;
    todayRevs.forEach(r => {
        todayCashCents += Math.round((parseFloat(r.cash) || 0) * 100);
        todayCardCents += Math.round((parseFloat(r.card) || 0) * 100);
        todayTotalCents += Math.round((parseFloat(r.total) || 0) * 100);
    });
    const todayCash = todayCashCents / 100;
    const todayCard = todayCardCents / 100;
    const todayTotal = todayTotalCents / 100;

    const kpiTodayRev = document.getElementById('kpiTodayRevenue');
    if (kpiTodayRev) kpiTodayRev.textContent = formatCurrency(todayTotal);

    const kpiTodayCash = document.getElementById('kpiTodayCash');
    if (kpiTodayCash) kpiTodayCash.textContent = formatCurrency(todayCash);

    const kpiTodayCard = document.getElementById('kpiTodayCard');
    if (kpiTodayCard) kpiTodayCard.textContent = formatCurrency(todayCard);

    // Month Revenue KPI
    const kpiMonthRev = document.getElementById('kpiMonthRevenue');
    if (kpiMonthRev) kpiMonthRev.textContent = formatCurrency(totals.totalRevenue);

    const kpiCount = document.getElementById('kpiMonthEntryCount');
    if (kpiCount) kpiCount.innerHTML = `<i data-lucide="check-circle" class="w-3.5 h-3.5"></i> <span>${totals.revenueCount} Buchungen</span>`;

    const avgDaily = totals.revenueCount > 0 ? totals.totalRevenue / totals.revenueCount : 0;
    const kpiAvg = document.getElementById('kpiAvgDailyRevenue');
    if (kpiAvg) kpiAvg.textContent = formatCurrency(avgDaily);

    // Month Costs KPI
    const kpiCosts = document.getElementById('kpiMonthCosts');
    if (kpiCosts) kpiCosts.textContent = formatCurrency(totals.totalExpenses);

    const kpiCostRatio = document.getElementById('kpiCostRatio');
    if (kpiCostRatio) kpiCostRatio.textContent = totals.costRatio.toFixed(1) + '%';

    const kpiStaffShort = document.getElementById('kpiStaffShort');
    if (kpiStaffShort) kpiStaffShort.textContent = formatCurrencyShort(totals.totalStaff);

    const kpiRentShort = document.getElementById('kpiRentShort');
    if (kpiRentShort) kpiRentShort.textContent = formatCurrencyShort(totals.totalRent);

    const kpiGoodsShort = document.getElementById('kpiGoodsShort');
    if (kpiGoodsShort) kpiGoodsShort.textContent = formatCurrencyShort(totals.totalGoods);

    // Month Profit KPI
    const kpiProfit = document.getElementById('kpiMonthProfit');
    const kpiMargin = document.getElementById('kpiProfitMargin');
    const kpiBadge = document.getElementById('kpiProfitBadge');
    const kpiProfitCard = document.getElementById('kpiProfitCard');

    if (kpiProfit) {
        kpiProfit.textContent = formatCurrency(totals.netProfit);
        if (totals.netProfit >= 0) {
            kpiProfit.className = 'text-xl sm:text-3xl font-black text-emerald-600';
            if (kpiBadge) {
                kpiBadge.textContent = 'Gewinnzone';
                kpiBadge.className = 'font-bold px-2 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-800';
            }
        } else {
            kpiProfit.className = 'text-xl sm:text-3xl font-black text-rose-600';
            if (kpiBadge) {
                kpiBadge.textContent = 'Verlustzone';
                kpiBadge.className = 'font-bold px-2 py-0.5 rounded-full text-[11px] bg-rose-100 text-rose-800';
            }
        }
    }
    if (kpiMargin) {
        kpiMargin.textContent = totals.profitMargin.toFixed(1) + '%';
    }

    // Expense Tab Category Badges
    const badgeStaff = document.getElementById('badgeStaffCost');
    if (badgeStaff) badgeStaff.textContent = formatCurrency(totals.totalStaff);
    const badgeRent = document.getElementById('badgeRentCost');
    if (badgeRent) badgeRent.textContent = formatCurrency(totals.totalRent);
    const badgeGoods = document.getElementById('badgeGoodsCost');
    if (badgeGoods) badgeGoods.textContent = formatCurrency(totals.totalGoods);
    const badgeOther = document.getElementById('badgeOtherCost');
    if (badgeOther) badgeOther.textContent = formatCurrency(totals.totalOther);
}

// =============================================================================
// CHARTS (TREND & DONUT)
// =============================================================================

function renderCharts() {
    renderTrendChart();
    renderCostDonutChart();
}

function renderTrendChart() {
    const canvas = document.getElementById('monthlyTrendChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const isDark = document.documentElement.classList.contains('dark');
    const [year, month] = STATE.currentMonth.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();

    const labels = [];
    const revenueData = [];
    const costData = [];

    const { revenues, expenses } = getFilteredData();

    for (let day = 1; day <= daysInMonth; day++) {
        const dayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        labels.push(`${day}.`);

        const dayRevs = revenues.filter(r => r.date === dayStr);
        const dayRevSum = dayRevs.reduce((acc, r) => acc + (parseFloat(r.total) || 0), 0);
        revenueData.push(dayRevSum);

        const dayExps = expenses.filter(e => e.date === dayStr);
        const dayExpSum = dayExps.reduce((acc, e) => acc + (parseFloat(e.amount) || 0), 0);
        costData.push(dayExpSum);
    }

    if (STATE.charts.trend) {
        STATE.charts.trend.destroy();
    }

    const ctx = canvas.getContext('2d');
    STATE.charts.trend = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Tagesumsatz (€)',
                    data: revenueData,
                    borderColor: '#10b981',
                    backgroundColor: isDark ? 'rgba(16, 185, 129, 0.15)' : 'rgba(16, 185, 129, 0.08)',
                    borderWidth: 2.5,
                    fill: true,
                    tension: 0.25,
                    pointRadius: 2,
                    pointHoverRadius: 5
                },
                {
                    label: 'Tageskosten (€)',
                    data: costData,
                    borderColor: '#ef4444',
                    backgroundColor: 'transparent',
                    borderWidth: 1.8,
                    borderDash: [4, 4],
                    pointRadius: 1,
                    pointHoverRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        boxWidth: 12,
                        color: isDark ? '#cbd5e1' : '#334155',
                        font: { size: 11, family: 'Plus Jakarta Sans' }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: isDark ? '#94a3b8' : '#64748b',
                        callback: val => val.toLocaleString('de-DE') + ' €',
                        font: { size: 10 }
                    },
                    grid: { color: isDark ? 'rgba(255, 255, 255, 0.08)' : '#f1f5f9' }
                },
                x: {
                    ticks: {
                        color: isDark ? '#94a3b8' : '#64748b',
                        font: { size: 9 },
                        maxTicksLimit: 16
                    },
                    grid: { display: false }
                }
            }
        }
    });
}

function renderCostDonutChart() {
    const canvas = document.getElementById('costBreakdownChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const isDark = document.documentElement.classList.contains('dark');
    const { expenses } = getFilteredData();
    const totals = calculateTotals([], expenses);

    const legStaff = document.getElementById('legendStaff');
    const legRent = document.getElementById('legendRent');
    const legGoods = document.getElementById('legendGoods');
    const legOther = document.getElementById('legendOther');

    if (legStaff) legStaff.textContent = formatCurrency(totals.totalStaff);
    if (legRent) legRent.textContent = formatCurrency(totals.totalRent);
    if (legGoods) legGoods.textContent = formatCurrency(totals.totalGoods);
    if (legOther) legOther.textContent = formatCurrency(totals.totalOther);

    if (STATE.charts.costBreakdown) {
        STATE.charts.costBreakdown.destroy();
    }

    const ctx = canvas.getContext('2d');
    const hasCosts = totals.totalExpenses > 0;

    STATE.charts.costBreakdown = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Mitarbeiter', 'Miete & Nebenkosten', 'Wareneinsatz', 'Sonstige'],
            datasets: [{
                data: hasCosts 
                    ? [totals.totalStaff, totals.totalRent, totals.totalGoods, totals.totalOther] 
                    : [1, 0, 0, 0],
                backgroundColor: hasCosts 
                    ? ['#3b82f6', '#f59e0b', '#ef4444', '#a855f7'] 
                    : [isDark ? '#1e293b' : '#e2e8f0'],
                borderWidth: 2,
                borderColor: isDark ? '#0f172a' : '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '72%',
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: hasCosts,
                    callbacks: {
                        label: ctx => ` ${ctx.label}: ${formatCurrency(ctx.raw)}`
                    }
                }
            }
        }
    });
}

function renderCostDonutChart() {
    const canvas = document.getElementById('costBreakdownChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const { expenses } = getFilteredData();
    const totals = calculateTotals([], expenses);

    const legStaff = document.getElementById('legendStaff');
    const legRent = document.getElementById('legendRent');
    const legGoods = document.getElementById('legendGoods');
    const legOther = document.getElementById('legendOther');

    if (legStaff) legStaff.textContent = formatCurrency(totals.totalStaff);
    if (legRent) legRent.textContent = formatCurrency(totals.totalRent);
    if (legGoods) legGoods.textContent = formatCurrency(totals.totalGoods);
    if (legOther) legOther.textContent = formatCurrency(totals.totalOther);

    if (STATE.charts.costBreakdown) {
        STATE.charts.costBreakdown.destroy();
    }

    const ctx = canvas.getContext('2d');
    const hasCosts = totals.totalExpenses > 0;

    STATE.charts.costBreakdown = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Mitarbeiter', 'Miete & Nebenkosten', 'Wareneinsatz', 'Sonstige'],
            datasets: [{
                data: hasCosts 
                    ? [totals.totalStaff, totals.totalRent, totals.totalGoods, totals.totalOther] 
                    : [1, 0, 0, 0],
                backgroundColor: hasCosts 
                    ? ['#3b82f6', '#f59e0b', '#ef4444', '#a855f7'] 
                    : ['#e2e8f0'],
                borderWidth: 2,
                borderColor: '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '72%',
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: hasCosts,
                    callbacks: {
                        label: ctx => ` ${ctx.label}: ${formatCurrency(ctx.raw)}`
                    }
                }
            }
        }
    });
}

// =============================================================================
// STORE COMPARISON & RECENT LISTS
// =============================================================================

function renderStoreComparisonTable() {
    const tbody = document.getElementById('storeComparisonTableBody');
    const tfoot = document.getElementById('storeComparisonTableFoot');
    if (!tbody || !tfoot) return;

    tbody.innerHTML = '';
    let sumTarget = 0, sumRevenue = 0, sumCosts = 0, sumProfit = 0;

    STATE.stores.forEach(store => {
        const storeRevs = STATE.revenues.filter(r => r.storeId === store.id && r.date.startsWith(STATE.currentMonth));
        const storeExps = STATE.expenses.filter(e => e.storeId === store.id && e.date.startsWith(STATE.currentMonth));
        const totals = calculateTotals(storeRevs, storeExps);

        const target = store.targetRevenue || 0;
        const progress = target > 0 ? (totals.totalRevenue / target) * 100 : 0;

        sumTarget += target;
        sumRevenue += totals.totalRevenue;
        sumCosts += totals.totalExpenses;
        sumProfit += totals.netProfit;

        const colorCfg = STORE_COLORS[store.color] || STORE_COLORS.emerald;

        const row = `
            <tr class="hover:bg-slate-50/80 transition">
                <td class="py-3 px-4 font-semibold text-slate-900 flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full ${colorCfg.bg}"></span>
                    <span>${escapeHtml(store.name)}</span>
                </td>
                <td class="py-3 px-4 text-slate-500">${formatCurrency(target)}</td>
                <td class="py-3 px-4 font-bold text-slate-900">${formatCurrency(totals.totalRevenue)}</td>
                <td class="py-3 px-4">
                    <div class="flex items-center gap-2">
                        <div class="w-16 bg-slate-200 rounded-full h-1.5 overflow-hidden">
                            <div class="h-1.5 rounded-full ${progress >= 100 ? 'bg-emerald-500' : 'bg-brand-500'}" style="width: ${Math.min(progress, 100)}%"></div>
                        </div>
                        <span class="text-[11px] font-semibold text-slate-600">${progress.toFixed(0)}%</span>
                    </div>
                </td>
                <td class="py-3 px-4 text-rose-600 font-semibold">${formatCurrency(totals.totalExpenses)}</td>
                <td class="py-3 px-4 font-bold ${totals.netProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}">
                    ${formatCurrency(totals.netProfit)}
                </td>
                <td class="py-3 px-4 text-right">
                    <button onclick="quickBookForStore('${store.id}')" class="text-xs font-bold text-emerald-600 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1 rounded-lg transition">
                        + Buchen
                    </button>
                </td>
            </tr>
        `;
        tbody.insertAdjacentHTML('beforeend', row);
    });

    // Summary Foot Row
    tfoot.innerHTML = `
        <tr>
            <td class="py-3 px-4">Gesamtsumme (Alle Filialen)</td>
            <td class="py-3 px-4">${formatCurrency(sumTarget)}</td>
            <td class="py-3 px-4 text-emerald-700">${formatCurrency(sumRevenue)}</td>
            <td class="py-3 px-4">${sumTarget > 0 ? ((sumRevenue / sumTarget) * 100).toFixed(0) + '%' : '-'}</td>
            <td class="py-3 px-4 text-rose-700">${formatCurrency(sumCosts)}</td>
            <td class="py-3 px-4 ${sumProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}">${formatCurrency(sumProfit)}</td>
            <td class="py-3 px-4 text-right">-</td>
        </tr>
    `;
}

function renderRecentLists() {
    const revContainer = document.getElementById('recentRevenuesList');
    const expContainer = document.getElementById('recentExpensesList');
    if (!revContainer || !expContainer) return;

    // Recent Revenues (Top 5)
    const sortedRevs = [...STATE.revenues].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5);
    revContainer.innerHTML = sortedRevs.length === 0 ? '<p class="text-slate-400 py-3 text-center">Keine Buchungen vorhanden.</p>' : '';
    sortedRevs.forEach(r => {
        const store = STATE.stores.find(s => s.id === r.storeId);
        const storeName = store ? store.name : 'Unbekannt';
        const item = `
            <div class="flex items-center justify-between py-2">
                <div class="space-y-0.5">
                    <div class="font-bold text-slate-800">${escapeHtml(storeName)}</div>
                    <div class="text-[10px] text-slate-400">${formatDateDE(r.date)} ${r.note ? '• ' + escapeHtml(r.note) : ''}</div>
                </div>
                <div class="text-right">
                    <div class="font-black text-emerald-600">${formatCurrency(r.total)}</div>
                    <div class="text-[10px] text-slate-400">Bar: ${formatCurrencyShort(r.cash)} | Karte: ${formatCurrencyShort(r.card)}</div>
                </div>
            </div>
        `;
        revContainer.insertAdjacentHTML('beforeend', item);
    });

    // Recent Expenses (Top 5)
    const sortedExps = [...STATE.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5);
    expContainer.innerHTML = sortedExps.length === 0 ? '<p class="text-slate-400 py-3 text-center">Keine Kosten vorhanden.</p>' : '';
    sortedExps.forEach(e => {
        const store = STATE.stores.find(s => s.id === e.storeId);
        const storeName = store ? store.name : 'Unbekannt';
        const item = `
            <div class="flex items-center justify-between py-2">
                <div class="space-y-0.5">
                    <div class="font-bold text-slate-800">${escapeHtml(e.title || 'Ausgabe')}</div>
                    <div class="text-[10px] text-slate-400">${formatDateDE(e.date)} • ${escapeHtml(storeName)}</div>
                </div>
                <div class="text-right">
                    <div class="font-black text-rose-600">-${formatCurrency(e.amount)}</div>
                    <div class="text-[10px] text-slate-400">${CATEGORY_NAMES[e.category] || e.category}</div>
                </div>
            </div>
        `;
        expContainer.insertAdjacentHTML('beforeend', item);
    });
}

// =============================================================================
// REVENUE CRUD
// =============================================================================

function renderRevenuesTable() {
    const tbody = document.getElementById('revenueTableBody');
    const countEl = document.getElementById('revenueRecordCount');
    if (!tbody) return;

    const searchTerm = (document.getElementById('revenueSearchInput')?.value || '').toLowerCase();
    let revs = [...STATE.revenues];

    if (STATE.currentStoreId !== 'ALL') {
        revs = revs.filter(r => r.storeId === STATE.currentStoreId);
    }
    if (STATE.currentMonth) {
        revs = revs.filter(r => r.date && r.date.startsWith(STATE.currentMonth));
    }

    if (searchTerm) {
        revs = revs.filter(r => {
            const store = STATE.stores.find(s => s.id === r.storeId);
            const storeName = (store?.name || '').toLowerCase();
            return (r.date || '').includes(searchTerm) ||
                   storeName.includes(searchTerm) ||
                   (r.note || '').toLowerCase().includes(searchTerm);
        });
    }

    revs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (countEl) countEl.textContent = `${revs.length} Einträge`;

    tbody.innerHTML = revs.length === 0 
        ? '<tr><td colspan="7" class="py-8 text-center text-slate-400">Keine Umsätze gefunden.</td></tr>' 
        : '';

    revs.forEach(r => {
        const store = STATE.stores.find(s => s.id === r.storeId);
        const storeName = store ? store.name : 'Gelöschte Filiale';
        const colorCfg = store ? (STORE_COLORS[store.color] || STORE_COLORS.emerald) : STORE_COLORS.emerald;

        const isPending = !!r._pendingSync && (window.syncManager?.syncQueue || []).some(q => (q.tempId === r.id || q.data?.id === r.id));
        const pendingBadge = isPending 
            ? '<span class="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300" title="Wartet auf Synchronisierung mit dem Server">⏳ Ausstehend</span>' 
            : '<span class="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300" title="Erfolgreich in zentraler Datenbank gespeichert">✓ Gespeichert</span>';

        const tr = `
            <tr class="hover:bg-slate-50/80 transition ${r._pendingSync ? 'bg-amber-50/40' : ''}">
                <td class="py-3 px-4 font-semibold text-slate-900">${formatDateDE(r.date)} ${pendingBadge}</td>
                <td class="py-3 px-4">
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${colorCfg.badge}">
                        <span class="w-1.5 h-1.5 rounded-full ${colorCfg.bg}"></span>
                        ${escapeHtml(storeName)}
                    </span>
                </td>
                <td class="py-3 px-4 font-semibold text-slate-800">${formatCurrency(r.cash)}</td>
                <td class="py-3 px-4 font-semibold text-slate-800">${formatCurrency(r.card)}</td>
                <td class="py-3 px-4 font-black text-emerald-600">${formatCurrency(r.total)}</td>
                <td class="py-3 px-4 text-slate-500 text-xs">${escapeHtml(r.note || '-')}</td>
                <td class="py-3 px-4 text-right">
                    <div class="flex items-center justify-end gap-1">
                        <button onclick="editRevenue('${r.id}')" title="Bearbeiten" class="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition">
                            <i data-lucide="edit-2" class="w-4 h-4"></i>
                        </button>
                        <button onclick="deleteRevenue('${r.id}')" title="Löschen" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
        tbody.insertAdjacentHTML('beforeend', tr);
    });

    if (window.lucide) lucide.createIcons();
}

function calculateRevTotal() {
    const cash = parseFloat(document.getElementById('revCash')?.value) || 0;
    const card = parseFloat(document.getElementById('revCard')?.value) || 0;
    const total = Math.round((cash + card) * 100) / 100;
    const calcEl = document.getElementById('revCalcTotal');
    if (calcEl) calcEl.textContent = formatCurrency(total);
}

async function handleRevenueSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const editId = document.getElementById('revEditId').value.trim();
    const existing = editId ? STATE.revenues.find(r => r.id === editId) : null;

    const dateInput = document.getElementById('revDate').value;
    const storeIdInput = document.getElementById('revStoreId').value;
    const cashInput = document.getElementById('revCash').value;
    const cardInput = document.getElementById('revCard').value;
    const noteInput = document.getElementById('revNote').value;

    const storeId = storeIdInput || (existing ? existing.storeId : '');
    const date = dateInput || (existing ? existing.date : '');
    const cash = (cashInput !== '' && !isNaN(parseFloat(cashInput))) ? parseFloat(cashInput) : (existing ? existing.cash : 0);
    const card = (cardInput !== '' && !isNaN(parseFloat(cardInput))) ? parseFloat(cardInput) : (existing ? existing.card : 0);
    const total = Math.round((cash + card) * 100) / 100;
    const note = noteInput !== undefined ? noteInput.trim() : (existing ? (existing.note || '') : '');

    if (!storeId) {
        showToast('Bitte eine Filiale auswählen.', 'error');
        return;
    }
    if (!date) {
        showToast('Bitte ein Datum angeben.', 'error');
        return;
    }
    if (cash < 0 || card < 0) {
        showToast('Negative Beträge sind nicht zulässig.', 'error');
        return;
    }
    if (total <= 0) {
        showToast('Der Gesamtumsatz muss größer als 0 € sein.', 'error');
        return;
    }

    const payload = {
        ...(existing || {}),
        id: editId || undefined,
        storeId,
        date,
        cash,
        card,
        total,
        note
    };

    try {
        await dataService.saveRevenue(payload, submitBtn);
        closeModal('quickRevenueModal');
        form.reset();
        document.getElementById('revEditId').value = '';
    } catch (err) {
        // Fehler wird von dataService angezeigt; Formular bleibt erhalten, kein Datenverlust!
    }
}

function editRevenue(id) {
    const rev = STATE.revenues.find(r => r.id === id);
    if (!rev) {
        showToast('Umsatzdatensatz nicht gefunden.', 'error');
        return;
    }

    document.getElementById('revenueModalTitle').textContent = 'Tagesumsatz bearbeiten';
    document.getElementById('revEditId').value = rev.id;
    document.getElementById('revDate').value = rev.date;
    document.getElementById('revStoreId').value = rev.storeId;
    document.getElementById('revCash').value = Number(rev.cash).toFixed(2);
    document.getElementById('revCard').value = Number(rev.card).toFixed(2);
    document.getElementById('revNote').value = rev.note || '';
    calculateRevTotal();

    openModal('quickRevenueModal', true);
}

async function deleteRevenue(id) {
    if (!confirm('Möchten Sie diesen Umsatz wirklich löschen?')) return;
    try {
        await dataService.deleteRevenue(id);
    } catch (err) {
        // Fehler wird von dataService angezeigt
    }
}

// =============================================================================
// EXPENSES CRUD
// =============================================================================

function renderExpensesTable() {
    const tbody = document.getElementById('expenseTableBody');
    if (!tbody) return;

    const searchTerm = (document.getElementById('expenseSearchInput')?.value || '').toLowerCase();
    const catFilter = document.getElementById('expenseCategoryFilter')?.value || 'ALL';

    let exps = [...STATE.expenses];

    if (STATE.currentStoreId !== 'ALL') {
        exps = exps.filter(e => e.storeId === STATE.currentStoreId);
    }
    if (STATE.currentMonth) {
        exps = exps.filter(e => e.date && e.date.startsWith(STATE.currentMonth));
    }
    if (catFilter !== 'ALL') {
        exps = exps.filter(e => e.category === catFilter);
    }

    if (searchTerm) {
        exps = exps.filter(e => {
            const store = STATE.stores.find(s => s.id === e.storeId);
            const storeName = (store?.name || '').toLowerCase();
            return (e.title || '').toLowerCase().includes(searchTerm) ||
                   storeName.includes(searchTerm) ||
                   (e.date || '').includes(searchTerm);
        });
    }

    exps.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    tbody.innerHTML = exps.length === 0 
        ? '<tr><td colspan="7" class="py-8 text-center text-slate-400">Keine Kosten gefunden.</td></tr>' 
        : '';

    exps.forEach(e => {
        const store = STATE.stores.find(s => s.id === e.storeId);
        const storeName = store ? store.name : 'Gelöschte Filiale';
        const colorCfg = store ? (STORE_COLORS[store.color] || STORE_COLORS.emerald) : STORE_COLORS.emerald;

        const isPending = !!e._pendingSync && (window.syncManager?.syncQueue || []).some(q => (q.tempId === e.id || q.data?.id === e.id));
        const pendingBadge = isPending 
            ? '<span class="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300" title="Wartet auf Synchronisierung mit dem Server">⏳ Ausstehend</span>' 
            : '<span class="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300" title="Erfolgreich in zentraler Datenbank gespeichert">✓ Gespeichert</span>';

        const tr = `
            <tr class="hover:bg-slate-50/80 transition ${e._pendingSync ? 'bg-amber-50/40' : ''}">
                <td class="py-3 px-4 font-semibold text-slate-900">${formatDateDE(e.date)} ${pendingBadge}</td>
                <td class="py-3 px-4">
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${colorCfg.badge}">
                        <span class="w-1.5 h-1.5 rounded-full ${colorCfg.bg}"></span>
                        ${escapeHtml(storeName)}
                    </span>
                </td>
                <td class="py-3 px-4 text-xs font-semibold text-slate-600">${CATEGORY_NAMES[e.category] || e.category}</td>
                <td class="py-3 px-4 font-semibold text-slate-900">${escapeHtml(e.title)}</td>
                <td class="py-3 px-4 text-xs text-slate-500">${e.recurrence === 'monthly' ? 'Monatlich wiederkehrend' : 'Einmalig'}</td>
                <td class="py-3 px-4 font-black text-rose-600">${formatCurrency(e.amount)}</td>
                <td class="py-3 px-4 text-right">
                    <div class="flex items-center justify-end gap-1">
                        <button onclick="editExpense('${e.id}')" title="Bearbeiten" class="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition">
                            <i data-lucide="edit-2" class="w-4 h-4"></i>
                        </button>
                        <button onclick="deleteExpense('${e.id}')" title="Löschen" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
        tbody.insertAdjacentHTML('beforeend', tr);
    });

    if (window.lucide) lucide.createIcons();
}

async function handleExpenseSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const editId = document.getElementById('expEditId').value.trim();
    const existing = editId ? STATE.expenses.find(e => e.id === editId) : null;

    const storeId = document.getElementById('expStoreId').value || (existing ? existing.storeId : '');
    const category = document.getElementById('expCategory').value || (existing ? existing.category : '');
    const date = document.getElementById('expDate').value || (existing ? existing.date : '');
    const amountVal = document.getElementById('expAmount').value;
    const amount = (amountVal !== '' && !isNaN(parseFloat(amountVal))) ? parseFloat(amountVal) : (existing ? existing.amount : 0);
    const title = document.getElementById('expTitle').value.trim() || (existing ? existing.title : '');
    const recurrence = document.querySelector('input[name="expRecurrence"]:checked')?.value || (existing ? existing.recurrence : 'single');

    if (!storeId) {
        showToast('Bitte eine Filiale auswählen.', 'error');
        return;
    }
    if (!category) {
        showToast('Bitte eine Kostenkategorie wählen.', 'error');
        return;
    }
    if (!date) {
        showToast('Bitte ein Datum angeben.', 'error');
        return;
    }
    if (!title) {
        showToast('Bitte eine Bezeichnung für die Ausgabe eingeben.', 'error');
        return;
    }
    if (amount <= 0) {
        showToast('Der Betrag muss größer als 0 € sein.', 'error');
        return;
    }

    const payload = {
        ...(existing || {}),
        id: editId || undefined,
        storeId,
        category,
        date,
        amount,
        title,
        recurrence
    };

    try {
        await dataService.saveExpense(payload, submitBtn);
        closeModal('quickExpenseModal');
        form.reset();
        document.getElementById('expEditId').value = '';
    } catch (err) {
        // Fehler wird von dataService angezeigt; Formular bleibt erhalten
    }
}

function editExpense(id) {
    const exp = STATE.expenses.find(e => e.id === id);
    if (!exp) {
        showToast('Kostenposition nicht gefunden.', 'error');
        return;
    }

    document.getElementById('expenseModalTitle').textContent = 'Kostenposition bearbeiten';
    document.getElementById('expEditId').value = exp.id;
    document.getElementById('expStoreId').value = exp.storeId;
    document.getElementById('expCategory').value = exp.category;
    document.getElementById('expDate').value = exp.date;
    document.getElementById('expAmount').value = Number(exp.amount).toFixed(2);
    document.getElementById('expTitle').value = exp.title;

    const radio = document.querySelector(`input[name="expRecurrence"][value="${exp.recurrence}"]`);
    if (radio) radio.checked = true;

    openModal('quickExpenseModal', true);
}

async function deleteExpense(id) {
    if (!confirm('Möchten Sie diesen Kosteneintrag wirklich löschen?')) return;
    try {
        await dataService.deleteExpense(id);
    } catch (err) {
        // Fehler wird von dataService angezeigt
    }
}

// =============================================================================
// PRODUCTS & INVENTORY CRUD
// =============================================================================

// =============================================================================
// WARENWIRTSCHAFT / INVENTORY MANAGEMENT LOGIC
// =============================================================================

function updateModalMarginCalculation() {
    const costInput = document.getElementById('prodCostPrice');
    const sellInput = document.getElementById('prodSellPrice');
    const marginDisplay = document.getElementById('prodMarginDisplay');
    if (!costInput || !sellInput || !marginDisplay) return;

    const cost = parseFloat(costInput.value) || 0;
    const sell = parseFloat(sellInput.value) || 0;

    if (sell > 0) {
        const margin = (((sell - cost) / sell) * 100).toFixed(1);
        marginDisplay.textContent = margin + '%';
        if (margin < 15) {
            marginDisplay.className = 'px-3 py-2 text-sm font-black text-rose-700 bg-rose-50 border border-rose-200 rounded-xl text-center';
        } else if (margin < 30) {
            marginDisplay.className = 'px-3 py-2 text-sm font-black text-amber-700 bg-amber-50 border border-amber-200 rounded-xl text-center';
        } else {
            marginDisplay.className = 'px-3 py-2 text-sm font-black text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl text-center';
        }
    } else {
        marginDisplay.textContent = '0.0%';
        marginDisplay.className = 'px-3 py-2 text-sm font-black text-slate-500 bg-slate-50 border border-slate-200 rounded-xl text-center';
    }
}

function openProductModal(clean = true) {
    openModal('productModal', !clean);
}

function toggleLowStockFilter() {
    STATE.isLowStockFilterActive = !STATE.isLowStockFilterActive;
    const btn = document.getElementById('filterLowStockBtn');
    const card = document.getElementById('kpiLowStockCard');
    if (btn) {
        if (STATE.isLowStockFilterActive) {
            btn.className = 'px-3 py-2 bg-rose-600 text-white border border-rose-700 rounded-xl text-xs font-bold flex items-center gap-1.5 transition whitespace-nowrap shadow-sm';
            btn.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5"></i> <span>Filter aktiv: Mindestbestand</span>';
        } else {
            btn.className = 'px-3 py-2 bg-slate-100 hover:bg-rose-50 text-slate-700 hover:text-rose-700 border border-slate-200 rounded-xl text-xs font-bold flex items-center gap-1.5 transition whitespace-nowrap';
            btn.innerHTML = '<i data-lucide="alert-circle" class="w-3.5 h-3.5"></i> <span>Nur kritischer Bestand</span>';
        }
    }
    if (card) {
        if (STATE.isLowStockFilterActive) {
            card.classList.add('ring-2', 'ring-rose-500', 'bg-rose-50/60');
        } else {
            card.classList.remove('ring-2', 'ring-rose-500', 'bg-rose-50/60');
        }
    }
    renderProductsTable();
    if (window.lucide) lucide.createIcons();
}

function renderProductsTable() {
    const tbody = document.getElementById('productTableBody');
    const countEl = document.getElementById('productRecordCount');
    if (!tbody) return;

    const searchTerm = (document.getElementById('productSearchInput')?.value || '').toLowerCase().trim();
    const categoryFilter = document.getElementById('productCategoryFilter')?.value || '';
    let prods = [...STATE.products];

    // Filter by store if not ALL
    if (STATE.currentStoreId !== 'ALL') {
        prods = prods.filter(p => !p.storeId || p.storeId === STATE.currentStoreId);
    }

    // 1. Calculate and update KPI Statistics over store products
    let totalQty = 0;
    let totalCostVal = 0;
    let totalSellVal = 0;
    let lowStockCount = 0;
    const categoriesSet = new Set();

    prods.forEach(p => {
        const qty = Number(p.stockQuantity) || 0;
        const cost = Number(p.costPrice) || 0;
        const sell = Number(p.sellPrice) || 0;
        const min = Number(p.minStock) || 0;

        totalQty += qty;
        totalCostVal += (qty * cost);
        totalSellVal += (qty * sell);
        if (qty <= min) lowStockCount++;
        if (p.category) categoriesSet.add(p.category);
    });

    const kpiTotalEl = document.getElementById('kpiTotalProducts');
    if (kpiTotalEl) kpiTotalEl.textContent = prods.length.toString();

    const kpiQtyEl = document.getElementById('kpiTotalQuantity');
    if (kpiQtyEl) kpiQtyEl.textContent = `${totalQty.toLocaleString('de-DE')} Stück im Lager`;

    const kpiCostEl = document.getElementById('kpiStockValueCost');
    if (kpiCostEl) kpiCostEl.textContent = formatCurrency(totalCostVal);

    const kpiSellEl = document.getElementById('kpiStockValueSell');
    if (kpiSellEl) kpiSellEl.textContent = formatCurrency(totalSellVal);

    const kpiProfitEl = document.getElementById('kpiPotentialProfit');
    if (kpiProfitEl) {
        const profit = totalSellVal - totalCostVal;
        kpiProfitEl.textContent = `Potenzial: ${formatCurrency(profit)} Marge`;
    }

    const kpiLowStockEl = document.getElementById('kpiLowStockCount');
    if (kpiLowStockEl) kpiLowStockEl.textContent = lowStockCount.toString();

    // 2. Populate Category Filter Dropdown if categories changed
    const catSelect = document.getElementById('productCategoryFilter');
    if (catSelect) {
        const currentSelected = catSelect.value;
        const sortedCats = Array.from(categoriesSet).sort((a, b) => a.localeCompare(b, 'de'));
        let optionsHtml = '<option value="">Alle Kategorien</option>';
        sortedCats.forEach(c => {
            optionsHtml += `<option value="${escapeHtml(c)}" ${c === currentSelected ? 'selected' : ''}>${escapeHtml(c)}</option>`;
        });
        catSelect.innerHTML = optionsHtml;
    }

    // 3. Apply Filters for Table Display
    if (categoryFilter) {
        prods = prods.filter(p => p.category === categoryFilter);
    }

    if (STATE.isLowStockFilterActive) {
        prods = prods.filter(p => (Number(p.stockQuantity) || 0) <= (Number(p.minStock) || 0));
    }

    if (searchTerm) {
        prods = prods.filter(p => 
            (p.name && p.name.toLowerCase().includes(searchTerm)) ||
            (p.barcode && p.barcode.toLowerCase().includes(searchTerm)) ||
            (p.sku && p.sku.toLowerCase().includes(searchTerm)) ||
            (p.category && p.category.toLowerCase().includes(searchTerm)) ||
            (p.manufacturer && p.manufacturer.toLowerCase().includes(searchTerm)) ||
            (p.supplier && p.supplier.toLowerCase().includes(searchTerm)) ||
            (p.storageLocation && p.storageLocation.toLowerCase().includes(searchTerm)) ||
            (p.storage_location && p.storage_location.toLowerCase().includes(searchTerm))
        );
    }

    if (countEl) countEl.textContent = `${prods.length} Artikel`;

    tbody.innerHTML = prods.length === 0 
        ? '<tr><td colspan="10" class="py-10 text-center text-slate-400">Keine Artikel gefunden. Nutzen Sie "+ Neuer Artikel", "CSV Import" oder den Barcode-Scanner.</td></tr>' 
        : '';

    prods.forEach(p => {
        const cost = Number(p.costPrice) || 0;
        const sell = Number(p.sellPrice) || 0;
        const qty = Number(p.stockQuantity) || 0;
        const minStock = Number(p.minStock) || 0;
        const margin = sell > 0 ? (((sell - cost) / sell) * 100).toFixed(0) : 0;
        const isLowStock = qty <= minStock;
        const location = p.storageLocation || p.storage_location || '-';
        const tax = p.taxRate !== undefined ? p.taxRate : (p.tax_rate !== undefined ? p.tax_rate : 19);

        const isPending = !!p._pendingSync && (window.syncManager?.syncQueue || []).some(q => (q.tempId === p.id || q.data?.id === p.id));
        const pendingBadge = isPending 
            ? '<span class="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300" title="Wartet auf Synchronisierung mit dem Server">⏳ Ausstehend</span>' 
            : '<span class="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300" title="Erfolgreich in zentraler Datenbank gespeichert">✓ Gespeichert</span>';

        const imageHtml = p.imageUrl || p.image_url 
            ? `<img src="${escapeHtml(p.imageUrl || p.image_url)}" alt="Artikelbild" class="w-8 h-8 rounded-lg object-cover border border-slate-200 flex-shrink-0">`
            : `<div class="w-8 h-8 rounded-lg bg-slate-100 text-slate-400 flex items-center justify-center flex-shrink-0"><i data-lucide="package" class="w-4 h-4"></i></div>`;

        const tr = `
            <tr class="hover:bg-slate-50/80 transition ${p._pendingSync ? 'bg-amber-50/40' : ''}">
                <td class="py-3 px-4">
                    <div class="flex items-center gap-2.5">
                        ${imageHtml}
                        <div>
                            <div class="font-bold text-slate-900 flex items-center flex-wrap gap-1">
                                ${escapeHtml(p.name)} ${pendingBadge}
                            </div>
                            <div class="text-[11px] text-slate-400 flex items-center gap-2">
                                ${p.sku ? '<span>SKU: ' + escapeHtml(p.sku) + '</span>' : ''}
                                ${p.manufacturer ? '<span>• ' + escapeHtml(p.manufacturer) + '</span>' : ''}
                            </div>
                        </div>
                    </div>
                </td>
                <td class="py-3 px-4">
                    ${p.barcode 
                        ? `<div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-100 font-mono text-xs text-slate-700 font-bold border border-slate-200/60">
                            <i data-lucide="barcode" class="w-3.5 h-3.5 text-slate-400"></i>
                            <span>${escapeHtml(p.barcode)}</span>
                           </div>` 
                        : '<span class="text-slate-300">-</span>'}
                </td>
                <td class="py-3 px-4 text-xs">
                    <span class="px-2 py-0.5 rounded-lg bg-teal-50 text-teal-700 font-medium border border-teal-100">${escapeHtml(p.category || 'Allgemein')}</span>
                </td>
                <td class="py-3 px-4 text-xs text-slate-600">
                    <span class="inline-flex items-center gap-1 text-slate-500">
                        ${location !== '-' ? '<i data-lucide="map-pin" class="w-3 h-3 text-slate-400"></i>' : ''}
                        ${escapeHtml(location)}
                    </span>
                </td>
                <td class="py-3 px-4 text-right text-slate-600 font-medium">${formatCurrency(cost)}</td>
                <td class="py-3 px-4 text-right font-bold text-emerald-700">${formatCurrency(sell)}</td>
                <td class="py-3 px-4 text-center text-xs text-slate-500">${tax}%</td>
                <td class="py-3 px-4 text-center">
                    <span class="px-2 py-0.5 rounded-full text-xs font-bold ${margin >= 30 ? 'bg-emerald-100 text-emerald-800' : (margin >= 15 ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800')}">
                        ${margin}%
                    </span>
                </td>
                <td class="py-3 px-4">
                    <div class="flex items-center justify-center gap-1.5">
                        <button onclick="adjustProductStock('${p.id}', -1)" title="-1 Abgang" class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold flex items-center justify-center text-xs transition active:scale-95">-</button>
                        <div class="text-center min-w-[42px]">
                            <div class="font-black text-sm ${isLowStock ? 'text-rose-600 animate-pulse' : 'text-slate-900'}">${qty} <span class="text-[10px] font-normal text-slate-400">${escapeHtml(p.unit || 'Stk.')}</span></div>
                            ${isLowStock ? '<span class="text-[9px] font-bold text-rose-600 bg-rose-50 px-1 py-0.2 rounded border border-rose-200">Meldebestand!</span>' : ''}
                        </div>
                        <button onclick="adjustProductStock('${p.id}', 1)" title="+1 Zugang" class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold flex items-center justify-center text-xs transition active:scale-95">+</button>
                    </div>
                </td>
                <td class="py-3 px-4 text-right">
                    <div class="flex items-center justify-end gap-1">
                        <button onclick="openStockHistoryModal('${p.id}')" title="Lagerbewegungen / Verlauf" class="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition">
                            <i data-lucide="history" class="w-4 h-4"></i>
                        </button>
                        <button onclick="editProduct('${p.id}')" title="Bearbeiten" class="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition">
                            <i data-lucide="edit-2" class="w-4 h-4"></i>
                        </button>
                        <button onclick="deleteProduct('${p.id}')" title="Löschen" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
        tbody.insertAdjacentHTML('beforeend', tr);
    });

    if (window.lucide) lucide.createIcons();
}

async function handleProductSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const editId = document.getElementById('prodEditId').value.trim();
    const existing = editId ? STATE.products.find(p => p.id === editId) : null;

    const name = document.getElementById('prodName').value.trim() || (existing ? existing.name : '');
    const storeId = document.getElementById('prodStoreId').value || (existing ? existing.storeId : null);
    const barcode = document.getElementById('prodBarcode').value.trim() || (existing ? (existing.barcode || '') : '');
    const sku = document.getElementById('prodSku').value.trim() || (existing ? (existing.sku || '') : '');
    const category = document.getElementById('prodCategory').value.trim() || (existing ? existing.category : 'Allgemein');
    const manufacturer = document.getElementById('prodManufacturer')?.value.trim() || (existing ? (existing.manufacturer || '') : '');
    const supplier = document.getElementById('prodSupplier')?.value.trim() || (existing ? (existing.supplier || '') : '');
    const storageLocation = document.getElementById('prodStorageLocation')?.value.trim() || (existing ? (existing.storageLocation || existing.storage_location || '') : '');
    const unit = document.getElementById('prodUnit')?.value || (existing ? (existing.unit || 'Stk.') : 'Stk.');
    const taxRate = parseInt(document.getElementById('prodTaxRate')?.value || (existing ? existing.taxRate : 19), 10);
    const imageUrl = document.getElementById('prodImageUrl')?.value.trim() || (existing ? (existing.imageUrl || existing.image_url || '') : '');
    const description = document.getElementById('prodDescription')?.value.trim() || (existing ? (existing.description || '') : '');

    const costVal = document.getElementById('prodCostPrice').value;
    const sellVal = document.getElementById('prodSellPrice').value;
    const stockVal = document.getElementById('prodStock').value;
    const minVal = document.getElementById('prodMinStock').value;

    const costPrice = (costVal !== '' && !isNaN(parseFloat(costVal))) ? parseFloat(costVal) : (existing ? existing.costPrice : 0);
    const sellPrice = (sellVal !== '' && !isNaN(parseFloat(sellVal))) ? parseFloat(sellVal) : (existing ? existing.sellPrice : 0);
    const stockQuantity = (stockVal !== '' && !isNaN(parseInt(stockVal))) ? parseInt(stockVal) : (existing ? existing.stockQuantity : 0);
    const minStock = (minVal !== '' && !isNaN(parseInt(minVal))) ? parseInt(minVal) : (existing ? existing.minStock : 0);

    if (!name) {
        showToast('Bitte einen Artikelnamen eingeben.', 'error');
        return;
    }
    if (costPrice < 0 || sellPrice < 0) {
        showToast('Preise dürfen nicht negativ sein.', 'error');
        return;
    }

    const payload = {
        ...(existing || {}),
        id: editId || undefined,
        name,
        storeId,
        barcode,
        sku,
        category,
        costPrice,
        sellPrice,
        taxRate,
        stockQuantity,
        minStock,
        manufacturer,
        supplier,
        storageLocation,
        unit,
        imageUrl,
        description
    };

    try {
        await dataService.saveProduct(payload, submitBtn);
        closeModal('productModal');
        form.reset();
        document.getElementById('prodEditId').value = '';
    } catch (err) {
        // Formular bleibt bei Fehlern erhalten
    }
}

function editProduct(id) {
    const prod = STATE.products.find(p => p.id === id);
    if (!prod) {
        showToast('Artikel nicht gefunden.', 'error');
        return;
    }

    document.getElementById('productModalTitle').textContent = 'Artikel bearbeiten';
    document.getElementById('prodEditId').value = prod.id;
    document.getElementById('prodName').value = prod.name || '';
    document.getElementById('prodStoreId').value = prod.storeId || '';
    document.getElementById('prodBarcode').value = prod.barcode || '';
    document.getElementById('prodSku').value = prod.sku || '';
    document.getElementById('prodCategory').value = prod.category || 'Allgemein';
    document.getElementById('prodCostPrice').value = Number(prod.costPrice || 0).toFixed(2);
    document.getElementById('prodSellPrice').value = Number(prod.sellPrice || 0).toFixed(2);
    document.getElementById('prodStock').value = prod.stockQuantity !== undefined ? prod.stockQuantity : 0;
    document.getElementById('prodMinStock').value = prod.minStock !== undefined ? prod.minStock : 3;

    if (document.getElementById('prodManufacturer')) document.getElementById('prodManufacturer').value = prod.manufacturer || '';
    if (document.getElementById('prodSupplier')) document.getElementById('prodSupplier').value = prod.supplier || '';
    if (document.getElementById('prodStorageLocation')) document.getElementById('prodStorageLocation').value = prod.storageLocation || prod.storage_location || '';
    if (document.getElementById('prodUnit')) document.getElementById('prodUnit').value = prod.unit || 'Stk.';
    if (document.getElementById('prodTaxRate')) document.getElementById('prodTaxRate').value = prod.taxRate !== undefined ? prod.taxRate : (prod.tax_rate !== undefined ? prod.tax_rate : 19);
    if (document.getElementById('prodImageUrl')) document.getElementById('prodImageUrl').value = prod.imageUrl || prod.image_url || '';
    if (document.getElementById('prodDescription')) document.getElementById('prodDescription').value = prod.description || '';

    updateModalMarginCalculation();
    openModal('productModal', true);
}

async function deleteProduct(id) {
    const prod = STATE.products.find(p => p.id === id);
    const title = prod ? prod.name : 'diesen Artikel';
    if (!confirm(`Möchten Sie "${title}" wirklich aus der Warenwirtschaft löschen?`)) return;
    try {
        await dataService.deleteProduct(id);
    } catch (err) {
        // Fehler von dataService angezeigt
    }
}

async function adjustProductStock(id, delta, movementType = null, reason = null) {
    try {
        await dataService.adjustProductStock(id, delta, movementType, reason);
    } catch (err) {
        showToast('Bestandsänderung fehlgeschlagen: ' + err.message, 'error');
    }
}

// =============================================================================
// BARCODE SCANNER LOGIC (Kamera, BarcodeDetector API & Html5Qrcode Fallback)
// =============================================================================

function scanBarcodeIntoInput(targetInputId) {
    STATE.barcodeScanTargetInput = targetInputId;
    openBarcodeScanner();
}

async function openBarcodeScanner() {
    openModal('barcodeScannerModal');
    const video = document.getElementById('scannerVideo');
    if (!video) return;

    try {
        STATE.scannerStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        video.srcObject = STATE.scannerStream;
        await video.play();

        // 1. Prioritize native BarcodeDetector if available
        if ('BarcodeDetector' in window) {
            try {
                const supportedFormats = await window.BarcodeDetector.getSupportedFormats();
                const formats = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code'].filter(f => supportedFormats.includes(f));
                const barcodeDetector = new window.BarcodeDetector({ formats: formats.length > 0 ? formats : undefined });
                
                STATE.scannerInterval = setInterval(async () => {
                    try {
                        const barcodes = await barcodeDetector.detect(video);
                        if (barcodes.length > 0) {
                            const code = barcodes[0].rawValue;
                            handleScannedBarcode(code);
                        }
                    } catch (e) {}
                }, 250);
                return;
            } catch (e) {
                console.warn('BarcodeDetector konnte nicht initialisiert werden, wechsle zu Fallback:', e);
            }
        }

        // 2. Fallback: Html5Qrcode library if loaded
        if (window.Html5Qrcode) {
            console.log('Verwende Html5Qrcode Library für Barcode-Erkennung...');
        }
    } catch (err) {
        console.warn('Kamera-Zugriff nicht möglich:', err);
        showToast('Kamera konnte nicht geöffnet werden. Bitte Barcode manuell eingeben.', 'warning');
    }
}

function closeBarcodeScanner() {
    if (STATE.scannerInterval) {
        clearInterval(STATE.scannerInterval);
        STATE.scannerInterval = null;
    }
    if (STATE.scannerStream) {
        STATE.scannerStream.getTracks().forEach(track => track.stop());
        STATE.scannerStream = null;
    }
    closeModal('barcodeScannerModal');
}

function handleManualBarcodeSubmit(e) {
    e.preventDefault();
    const code = document.getElementById('manualBarcodeInput').value.trim();
    if (code) {
        handleScannedBarcode(code);
    }
}

function handleScannedBarcode(code) {
    // Audio Beep
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.value = 0.15;
        osc.start();
        setTimeout(() => { osc.stop(); ctx.close(); }, 120);
    } catch (e) {}

    closeBarcodeScanner();

    // If targeted into a form input (e.g. prodBarcode)
    if (STATE.barcodeScanTargetInput) {
        const inputEl = document.getElementById(STATE.barcodeScanTargetInput);
        if (inputEl) {
            inputEl.value = code;
            showToast(`Barcode übernommen: ${code}`, 'success');
        }
        STATE.barcodeScanTargetInput = null;
        return;
    }

    // Default action: lookup in inventory
    const existing = STATE.products.find(p => p.barcode === code || p.sku === code);
    if (existing) {
        showToast(`Artikel erkannt: ${existing.name} (${formatCurrency(existing.sellPrice)})`, 'success');
        switchTab('products');
        const searchInput = document.getElementById('productSearchInput');
        if (searchInput) searchInput.value = code;
        renderProductsTable();
    } else {
        if (confirm(`Kein Artikel mit Barcode "${code}" gefunden. Jetzt neu anlegen?`)) {
            switchTab('products');
            openProductModal();
            const barcodeInput = document.getElementById('prodBarcode');
            if (barcodeInput) barcodeInput.value = code;
        }
    }
}

// =============================================================================
// SCHNELL-SCAN / LAGER & VERKAUF (RAPID STOCK ADJUSTMENTS)
// =============================================================================

let quickScanCurrentProduct = null;
let quickScanLastScannedCode = '';

async function openQuickScanModal(initialCode = '') {
    quickScanCurrentProduct = null;
    quickScanLastScannedCode = initialCode;

    const resultBox = document.getElementById('quickScanResultContainer');
    const notFoundBox = document.getElementById('quickScanNotFoundContainer');
    const input = document.getElementById('quickScanBarcodeInput');

    if (resultBox) resultBox.classList.add('hidden');
    if (notFoundBox) notFoundBox.classList.add('hidden');
    if (input) {
        input.value = initialCode || '';
        setTimeout(() => input.focus(), 200);
    }

    openModal('quickScanModal');

    // Start scanner in quickScanQrReader
    if (window.Html5Qrcode) {
        try {
            if (STATE.quickScanHtml5Qr) {
                await STATE.quickScanHtml5Qr.stop().catch(() => {});
            }
            STATE.quickScanHtml5Qr = new Html5Qrcode('quickScanQrReader');
            await STATE.quickScanHtml5Qr.start(
                { facingMode: 'environment' },
                {
                    fps: 10,
                    qrbox: { width: 250, height: 150 },
                    formatsToSupport: [
                        Html5QrcodeSupportedFormats.EAN_13,
                        Html5QrcodeSupportedFormats.EAN_8,
                        Html5QrcodeSupportedFormats.CODE_128,
                        Html5QrcodeSupportedFormats.CODE_39,
                        Html5QrcodeSupportedFormats.UPC_A,
                        Html5QrcodeSupportedFormats.UPC_E,
                        Html5QrcodeSupportedFormats.QR_CODE
                    ]
                },
                (decodedText) => {
                    handleQuickScanBarcode(decodedText);
                },
                (err) => {}
            );
        } catch (err) {
            console.warn('Html5Qrcode konnte nicht gestartet werden:', err);
        }
    }

    if (initialCode) {
        handleQuickScanBarcode(initialCode);
    }
}

function closeQuickScanModal() {
    if (STATE.quickScanHtml5Qr) {
        STATE.quickScanHtml5Qr.stop().catch(() => {});
        STATE.quickScanHtml5Qr = null;
    }
    closeModal('quickScanModal');
}

function handleQuickScanSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('quickScanBarcodeInput');
    const code = input ? input.value.trim() : '';
    if (code) {
        handleQuickScanBarcode(code);
    }
}

function handleQuickScanBarcode(code) {
    quickScanLastScannedCode = code;
    const input = document.getElementById('quickScanBarcodeInput');
    if (input) input.value = code;

    const prod = STATE.products.find(p => (p.barcode && p.barcode.toLowerCase() === code.toLowerCase()) || (p.sku && p.sku.toLowerCase() === code.toLowerCase()));
    const resultBox = document.getElementById('quickScanResultContainer');
    const notFoundBox = document.getElementById('quickScanNotFoundContainer');

    if (prod) {
        quickScanCurrentProduct = prod;
        notFoundBox.classList.add('hidden');
        renderQuickScanProductCard(prod);
        resultBox.classList.remove('hidden');

        // Play positive sound
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 750;
            gain.gain.value = 0.2;
            osc.start();
            setTimeout(() => { osc.stop(); ctx.close(); }, 100);
        } catch (e) {}
    } else {
        quickScanCurrentProduct = null;
        resultBox.classList.add('hidden');
        const codeEl = document.getElementById('quickScanNotFoundCode');
        if (codeEl) codeEl.textContent = code;
        notFoundBox.classList.remove('hidden');
    }
}

function renderQuickScanProductCard(prod) {
    const container = document.getElementById('quickScanResultContainer');
    if (!container) return;

    const qty = Number(prod.stockQuantity) || 0;
    const minStock = Number(prod.minStock) || 0;
    const isLow = qty <= minStock;
    const unit = prod.unit || 'Stk.';

    container.innerHTML = `
        <div class="bg-slate-50 border border-slate-200/80 rounded-2xl p-4 space-y-3">
            <div class="flex items-start justify-between gap-3">
                <div>
                    <span class="text-[10px] font-bold uppercase tracking-wider text-teal-700 bg-teal-50 px-2 py-0.5 rounded-md border border-teal-200">
                        ${escapeHtml(prod.category || 'Allgemein')}
                    </span>
                    <h4 class="font-bold text-slate-900 text-base mt-1">${escapeHtml(prod.name)}</h4>
                    <div class="text-xs text-slate-500 flex items-center gap-2 mt-0.5 font-mono">
                        ${prod.barcode ? '<span>EAN: ' + escapeHtml(prod.barcode) + '</span>' : ''}
                        ${prod.sku ? '<span>SKU: ' + escapeHtml(prod.sku) + '</span>' : ''}
                    </div>
                </div>
                <div class="text-right">
                    <div class="text-xs text-slate-400">Verkaufspreis</div>
                    <div class="text-base font-black text-emerald-700">${formatCurrency(prod.sellPrice)}</div>
                </div>
            </div>

            <!-- Großer Bestands-Zähler -->
            <div class="flex items-center justify-between p-3.5 bg-white rounded-xl border border-slate-200 shadow-sm">
                <div>
                    <span class="text-xs font-semibold text-slate-500 uppercase">Aktueller Bestand</span>
                    <div class="flex items-center gap-1.5 mt-0.5">
                        <span class="text-3xl font-black ${isLow ? 'text-rose-600' : 'text-slate-900'}">${qty}</span>
                        <span class="text-xs font-bold text-slate-400">${escapeHtml(unit)}</span>
                        ${isLow ? '<span class="text-[10px] font-bold text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200 ml-1">Mindestbestand!</span>' : ''}
                    </div>
                </div>
                <div class="text-right text-xs text-slate-500">
                    <div>Lagerort: <strong class="text-slate-700">${escapeHtml(prod.storageLocation || prod.storage_location || 'Zentrallager')}</strong></div>
                    <div>Meldebestand: <strong>${minStock} ${escapeHtml(unit)}</strong></div>
                </div>
            </div>

            <!-- Schnell-Buchungsaktionen -->
            <div class="space-y-2 pt-1">
                <!-- Wareneingang (+) -->
                <div>
                    <div class="text-[11px] font-bold text-emerald-700 uppercase flex items-center gap-1 mb-1">
                        <i data-lucide="arrow-down-left" class="w-3.5 h-3.5"></i>
                        Wareneingang buchen (+)
                    </div>
                    <div class="grid grid-cols-4 gap-2">
                        <button onclick="applyQuickStockChange('${prod.id}', 1, 'inbound')" class="py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs transition shadow-sm active:scale-95">+1</button>
                        <button onclick="applyQuickStockChange('${prod.id}', 5, 'inbound')" class="py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs transition shadow-sm active:scale-95">+5</button>
                        <button onclick="applyQuickStockChange('${prod.id}', 10, 'inbound')" class="py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs transition shadow-sm active:scale-95">+10</button>
                        <button onclick="promptCustomStockChange('${prod.id}', 1, 'inbound')" class="py-2 bg-emerald-100 hover:bg-emerald-200 text-emerald-800 font-bold rounded-xl text-xs transition active:scale-95">+ X...</button>
                    </div>
                </div>

                <!-- Verkauf / Abgang (-) -->
                <div>
                    <div class="text-[11px] font-bold text-brand-600 uppercase flex items-center gap-1 mb-1">
                        <i data-lucide="arrow-up-right" class="w-3.5 h-3.5"></i>
                        Verkauf / Abgang buchen (-)
                    </div>
                    <div class="grid grid-cols-4 gap-2">
                        <button onclick="applyQuickStockChange('${prod.id}', -1, 'outbound')" class="py-2 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl text-xs transition shadow-sm active:scale-95">-1</button>
                        <button onclick="applyQuickStockChange('${prod.id}', -2, 'outbound')" class="py-2 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl text-xs transition shadow-sm active:scale-95">-2</button>
                        <button onclick="applyQuickStockChange('${prod.id}', -5, 'outbound')" class="py-2 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl text-xs transition shadow-sm active:scale-95">-5</button>
                        <button onclick="promptCustomStockChange('${prod.id}', -1, 'outbound')" class="py-2 bg-blue-100 hover:bg-blue-200 text-blue-800 font-bold rounded-xl text-xs transition active:scale-95">- X...</button>
                    </div>
                </div>

                <!-- Korrektur / Neuer Bestand setzen -->
                <div class="flex items-center gap-2 pt-1 border-t border-slate-200">
                    <button onclick="promptSetExactStock('${prod.id}')" class="flex-1 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1">
                        <i data-lucide="sliders" class="w-3.5 h-3.5"></i>
                        Bestand korrigieren (Inventur)
                    </button>
                    <button onclick="openStockHistoryModal('${prod.id}')" class="px-3 py-2 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-xl text-xs font-bold transition flex items-center gap-1">
                        <i data-lucide="history" class="w-3.5 h-3.5 text-teal-600"></i>
                        Verlauf
                    </button>
                </div>
            </div>
        </div>
    `;
    if (window.lucide) lucide.createIcons();
}

async function applyQuickStockChange(productId, delta, type = 'inbound') {
    try {
        const prod = STATE.products.find(p => p.id === productId);
        const reason = type === 'inbound' ? 'Schnell-Scan Wareneingang' : 'Schnell-Scan Verkauf';
        await dataService.adjustProductStock(productId, delta, type, reason);

        // Update local card immediately
        if (prod) {
            prod.stockQuantity = (Number(prod.stockQuantity) || 0) + delta;
            renderQuickScanProductCard(prod);
        }
    } catch (err) {
        showToast('Fehler bei Schnellbuchung: ' + err.message, 'error');
    }
}

function promptCustomStockChange(productId, sign, type) {
    const qtyStr = prompt(sign > 0 ? 'Menge für Wareneingang eingeben:' : 'Menge für Abgang / Verkauf eingeben:');
    if (!qtyStr) return;
    const qty = parseInt(qtyStr, 10);
    if (isNaN(qty) || qty <= 0) {
        alert('Bitte eine positive ganze Zahl eingeben.');
        return;
    }
    applyQuickStockChange(productId, sign * qty, type);
}

function promptSetExactStock(productId) {
    const prod = STATE.products.find(p => p.id === productId);
    if (!prod) return;
    const current = Number(prod.stockQuantity) || 0;
    const newQtyStr = prompt(`Neuen tatsächlichen Lagerbestand für "${prod.name}" eingeben (Aktuell: ${current}):`, current);
    if (newQtyStr === null) return;
    const newQty = parseInt(newQtyStr, 10);
    if (isNaN(newQty) || newQty < 0) {
        alert('Bitte eine gültige Zahl >= 0 eingeben.');
        return;
    }
    const delta = newQty - current;
    if (delta === 0) return;
    adjustProductStock(productId, delta, 'inventory', 'Manuelle Inventurkorrektur via Schnell-Scan')
        .then(() => {
            prod.stockQuantity = newQty;
            renderQuickScanProductCard(prod);
        });
}

function createNewProductFromScannedCode() {
    const code = quickScanLastScannedCode;
    closeQuickScanModal();
    switchTab('products');
    openProductModal();
    const barcodeInput = document.getElementById('prodBarcode');
    if (barcodeInput) barcodeInput.value = code;
}

// =============================================================================
// CSV IMPORT ASSISTENT (VORSCHAU, SPALTENZUORDNUNG, DUPLIKATE & FORMELSCHUTZ)
// =============================================================================

async function handleCsvFileSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
        STATE.csvImportState = STATE.csvImportState || {};
        STATE.csvImportState.fileName = file.name;
        STATE.csvImportState.fileSize = file.size;

        // Check if SheetJS (XLSX) is available
        if (typeof window.XLSX === 'undefined') {
            throw new Error('SheetJS-Bibliothek (xlsx.full.min.js) ist nicht geladen.');
        }

        const arrayBuffer = await file.arrayBuffer();

        // Workbook mit SheetJS einlesen (unterstützt XLSX, XLS, CSV mit UTF-8)
        const wb = window.XLSX.read(arrayBuffer, { type: 'array', cellDates: true, codepage: 65001 });
        STATE.csvImportState.workbook = wb;
        STATE.csvImportState.sheetNames = wb.SheetNames || [];

        if (STATE.csvImportState.sheetNames.length === 0) {
            throw new Error('Die ausgewählte Datei enthält keine lesbaren Tabellenblätter.');
        }

        // Tabellenblatt-Auswahl einrichten
        const sheetContainer = document.getElementById('csvSheetSelectorContainer');
        const sheetSelect = document.getElementById('csvSheetSelect');
        if (sheetSelect && sheetContainer) {
            sheetSelect.innerHTML = STATE.csvImportState.sheetNames.map((name, idx) => 
                `<option value="${idx}">Tabellenblatt: ${escapeHtml(name)}</option>`
            ).join('');

            if (STATE.csvImportState.sheetNames.length > 1) {
                sheetContainer.classList.remove('hidden');
            } else {
                sheetContainer.classList.add('hidden');
            }
        }

        // Erstes Tabellenblatt laden
        loadSheetIntoImportState(0);
    } catch (err) {
        console.error('Fehler beim Öffnen der Excel-/CSV-Datei:', err);
        showToast('Fehler beim Öffnen der Datei: ' + err.message, 'error');
    }
}

function handleCsvSheetChanged(sheetIndex) {
    loadSheetIntoImportState(parseInt(sheetIndex, 10) || 0);
}

function loadSheetIntoImportState(sheetIndex) {
    const wb = STATE.csvImportState.workbook;
    if (!wb) return;
    const sheetName = STATE.csvImportState.sheetNames[sheetIndex] || STATE.csvImportState.sheetNames[0];
    STATE.csvImportState.selectedSheet = sheetName;
    const ws = wb.Sheets[sheetName];
    if (!ws) return;

    // Zu 2D-Array konvertieren mit Rohwerten als formatierte Strings
    const rawData = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (!rawData || rawData.length === 0) {
        showToast(`Das Tabellenblatt "${sheetName}" enthält keine Daten.`, 'warning');
        return;
    }

    // Kopfzeilen-Erkennung (Zeile mit meisten nicht-leeren Spalten in den ersten 6 Zeilen)
    let headerRowIdx = 0;
    let maxCols = 0;
    for (let i = 0; i < Math.min(6, rawData.length); i++) {
        const nonEmpties = (rawData[i] || []).filter(c => c !== '' && c !== null && c !== undefined).length;
        if (nonEmpties > maxCols) {
            maxCols = nonEmpties;
            headerRowIdx = i;
        }
    }

    const headers = (rawData[headerRowIdx] || []).map((h, i) => String(h).trim() || `Spalte_${i + 1}`);
    const rows = [];
    for (let r = headerRowIdx + 1; r < rawData.length; r++) {
        const row = rawData[r];
        if (!row) continue;
        const hasContent = row.some(c => c !== '' && c !== null && c !== undefined);
        if (hasContent) {
            const rowArr = headers.map((_, idx) => {
                let val = row[idx];
                if (val === undefined || val === null) return '';
                return String(val).trim();
            });
            rows.push(rowArr);
        }
    }

    STATE.csvImportState.headers = headers;
    STATE.csvImportState.rows = rows;

    const infoEl = document.getElementById('csvDetectedInfo');
    if (infoEl) {
        const sheetInfo = STATE.csvImportState.sheetNames.length > 1 ? ` (Blatt: "${sheetName}")` : '';
        infoEl.textContent = `${STATE.csvImportState.fileName}${sheetInfo}: ${rows.length} Datenzeilen & ${headers.length} Spalten erkannt`;
    }

    // Rendere Vorschau-Tabelle (erste 6 Datenzeilen)
    const table = document.getElementById('csvPreviewTable');
    if (table) {
        let html = '<thead class="bg-slate-100 text-slate-700 font-bold border-b"><tr>';
        headers.forEach(h => {
            html += `<th class="py-2.5 px-3 text-left whitespace-nowrap text-[11px]">${escapeHtml(h)}</th>`;
        });
        html += '</tr></thead><tbody class="divide-y divide-slate-100">';
        rows.slice(0, 6).forEach(row => {
            html += '<tr class="hover:bg-slate-50">';
            headers.forEach((_, cIdx) => {
                html += `<td class="py-2 px-3 truncate max-w-[160px] text-xs font-mono text-slate-700">${escapeHtml(row[cIdx] || '')}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody>';
        table.innerHTML = html;
    }

    document.getElementById('csvDropZone').classList.add('hidden');
    document.getElementById('csvPreviewSection').classList.remove('hidden');
}

function resetCsvImport() {
    STATE.csvImportState = {
        workbook: null,
        sheetNames: [],
        selectedSheet: '',
        headers: [],
        rows: [],
        validRows: [],
        invalidRows: [],
        mapping: {}
    };
    const fileInput = document.getElementById('csvFileInput');
    if (fileInput) fileInput.value = '';
    const dropZone = document.getElementById('csvDropZone');
    if (dropZone) dropZone.classList.remove('hidden');
    const previewSection = document.getElementById('csvPreviewSection');
    if (previewSection) previewSection.classList.add('hidden');
    const sheetContainer = document.getElementById('csvSheetSelectorContainer');
    if (sheetContainer) sheetContainer.classList.add('hidden');

    document.getElementById('csvStep1').classList.remove('hidden');
    document.getElementById('csvStep2').classList.add('hidden');
    document.getElementById('csvStep3').classList.add('hidden');

    document.getElementById('importStepBadge1').className = 'flex items-center gap-1.5 text-teal-600 font-bold';
    document.getElementById('importStepBadge2').className = 'flex items-center gap-1.5 text-slate-400';
    document.getElementById('importStepBadge3').className = 'flex items-center gap-1.5 text-slate-400';
}

function proceedToCsvStep2() {
    document.getElementById('csvStep1').classList.add('hidden');
    document.getElementById('csvStep2').classList.remove('hidden');

    // Update Step Indicators
    document.getElementById('importStepBadge1').className = 'flex items-center gap-1.5 text-slate-400';
    document.getElementById('importStepBadge2').className = 'flex items-center gap-1.5 text-teal-600 font-bold';

    renderCsvColumnMapping();
}

function backToCsvStep1() {
    document.getElementById('csvStep2').classList.add('hidden');
    document.getElementById('csvStep1').classList.remove('hidden');
    document.getElementById('importStepBadge1').className = 'flex items-center gap-1.5 text-teal-600 font-bold';
    document.getElementById('importStepBadge2').className = 'flex items-center gap-1.5 text-slate-400';
}

// Hilfsfunktion: Text normalisieren für Spaltenvergleich
function normalizeCsvHeader(text) {
    if (!text) return '';
    return String(text)
        .toLowerCase()
        .trim()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]/g, '');
}

// Universelle Spaltenheuristik
function detectCsvField(rawHeader) {
    const norm = normalizeCsvHeader(rawHeader);
    if (!norm) return null;

    // Bild-Spalten nicht als Name oder SKU matchen
    if (norm.includes('bild') || norm.includes('foto') || norm.includes('image') || norm.includes('pic')) {
        return null;
    }

    // 1. SKU (Modell / Artikelnummer)
    if (norm.includes('artikelnummer') || norm.includes('artikelnr') || norm === 'artnr' || norm === 'sku' || norm.includes('modellnummer') || norm === 'modell' || norm === 'model' || norm.includes('itemno') || norm === 'art') {
        return 'sku';
    }

    // 2. Barcode / EAN / GTIN
    if (norm.includes('ean') || norm.includes('gtin') || norm.includes('barcode') || norm.includes('strichcode')) {
        return 'barcode';
    }

    // 3. Größe (Einzelgröße)
    if (norm.includes('groesse') || norm.includes('grosse') || norm.includes('size') || norm.includes('einzelgr') || norm.includes('schuhgr') || norm.includes('groessenverlauf')) {
        return 'size';
    }

    // 4. Farbe (Farbbezeichnung)
    if (norm.includes('farbe') || norm.includes('colour') || norm.includes('color') || norm.includes('farbbezeichnung')) {
        return 'color';
    }

    // 5. Menge / Bestand
    if (norm.includes('menge') || norm.includes('ordermenge') || norm.includes('qty') || norm.includes('quantity') || norm.includes('paar') || norm === 'stk' || norm === 'stueck' || norm.includes('bestand')) {
        return 'stock_quantity';
    }

    // 6. Einkaufspreis (EK)
    if (norm.includes('einkauf') || norm.includes('purchase') || norm.includes('ekdeutschland') || norm.startsWith('ek') || norm === 'hap' || norm === 'price' || norm === 'preis') {
        return 'cost_price';
    }

    // 7. Verkaufspreis (VK / UVP)
    if (norm.includes('verkauf') || norm.includes('retail') || norm.includes('uvp') || norm.includes('rrp') || norm.startsWith('vk')) {
        return 'sell_price';
    }

    // 8. Auftragsnummer (nicht Positionsnummer)
    if ((norm.includes('auftragsnummer') || norm.includes('bestellnummer') || norm.includes('ordernumber') || norm === 'orderno') && !norm.includes('position')) {
        return 'order_number';
    }

    // 9. Liefertermin / Datum
    if (norm.includes('liefertermin') || norm.includes('lieferdatum') || norm.includes('deliverydate') || norm.includes('lieferwoche') || norm.includes('rechnungsdatum') || norm.includes('bestelldatum') || norm.includes('orderdate') || norm === 'datum' || norm === 'date') {
        return 'delivery_date';
    }

    // 10. Name / Modellname
    if (norm.includes('artikelname') || norm.includes('modellname') || norm.includes('produktname') || norm.includes('bezeichnung') || norm === 'name' || norm === 'titel' || norm === 'title') {
        return 'name';
    }

    // 11. Hersteller / Marke
    if (norm.includes('marke') || norm.includes('hersteller') || norm.includes('brand')) {
        return 'manufacturer';
    }

    // 12. Lieferant
    if (norm.includes('lieferant') || norm.includes('supplier') || norm.includes('vendor')) {
        return 'supplier';
    }

    // 13. Kategorie
    if (norm.includes('kategorie') || norm.includes('category') || norm.includes('warengruppe')) {
        return 'category';
    }

    return null;
}

// Definition der Zielfelder
const CSV_TARGET_FIELDS = [
    { key: 'sku', label: 'Artikelnr. / Modell (SKU)', required: false },
    { key: 'barcode', label: 'Barcode / EAN / GTIN', required: false },
    { key: 'size', label: 'Größe (Einzelgröße)', required: false },
    { key: 'color', label: 'Farbe (Farbbezeichnung)', required: false },
    { key: 'name', label: 'Artikelname / Bezeichnung', required: false },
    { key: 'stock_quantity', label: 'Menge / Ordermenge', required: false },
    { key: 'cost_price', label: 'Einkaufspreis netto (€)', required: false },
    { key: 'sell_price', label: 'Verkaufspreis brutto (€)', required: false },
    { key: 'manufacturer', label: 'Hersteller / Marke', required: false },
    { key: 'supplier', label: 'Lieferant', required: false },
    { key: 'category', label: 'Kategorie / Warengruppe', required: false },
    { key: 'order_number', label: 'Auftragsnummer / Beleg-Nr.', required: false },
    { key: 'delivery_date', label: 'Liefertermin / Datum', required: false },
    { key: 'storage_location', label: 'Lagerort / Regal', required: false },
    { key: 'tax_rate', label: 'MwSt-Satz (%)', required: false },
    { key: 'unit', label: 'Einheit', required: false },
    { key: 'description', label: 'Beschreibung / Notiz', required: false }
];

function renderCsvColumnMapping() {
    const container = document.getElementById('csvColumnMappingContainer');
    if (!container) return;

    const headers = STATE.csvImportState.headers;
    let html = '';

    // Automatische Zuordnung durchführen (Jede Spalte maximal 1 Zielfeld)
    const fieldToHeaderIndex = {};
    const usedIndices = new Set();

    headers.forEach((h, idx) => {
        const fieldKey = detectCsvField(h);
        if (fieldKey && fieldToHeaderIndex[fieldKey] === undefined && !usedIndices.has(idx)) {
            fieldToHeaderIndex[fieldKey] = idx;
            usedIndices.add(idx);
        }
    });

    CSV_TARGET_FIELDS.forEach(field => {
        const matchedIndex = fieldToHeaderIndex[field.key] !== undefined ? fieldToHeaderIndex[field.key] : -1;

        html += `
            <div class="bg-white p-3 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between">
                <label class="text-xs font-bold text-slate-800 mb-1 flex items-center justify-between">
                    <span>${escapeHtml(field.label)}</span>
                    ${field.required ? '<span class="text-rose-500 text-[10px]">Pflichtfeld</span>' : ''}
                </label>
                <select id="csvMap_${field.key}" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-teal-500">
                    <option value="-1">-- Nicht zuordnen --</option>
                    ${headers.map((h, idx) => `<option value="${idx}" ${idx === matchedIndex ? 'selected' : ''}>Spalte "${escapeHtml(h)}"` + (idx === matchedIndex ? ' (Automatisch erkannt)' : '') + `</option>`).join('')}
                </select>
            </div>
        `;
    });

    container.innerHTML = html;
}

function parseGermanNumber(str, defaultValue = 0) {
    if (str === null || str === undefined || str === '') return defaultValue;
    if (typeof str === 'number') return str;
    let clean = String(str).replace(/[^0-9.,-]/g, '').trim();
    if (!clean) return defaultValue;
    if (clean.includes(',') && clean.includes('.')) {
        if (clean.indexOf(',') < clean.indexOf('.')) {
            clean = clean.replace(/,/g, '');
        } else {
            clean = clean.replace(/\./g, '').replace(',', '.');
        }
    } else if (clean.includes(',')) {
        clean = clean.replace(',', '.');
    }
    const num = parseFloat(clean);
    return isNaN(num) ? defaultValue : num;
}

function proceedToCsvStep3() {
    // Read user mapping
    const mapping = {};
    CSV_TARGET_FIELDS.forEach(f => {
        const select = document.getElementById('csvMap_' + f.key);
        if (select) {
            mapping[f.key] = parseInt(select.value, 10);
        }
    });

    // Check minimum required fields: Either name OR sku OR barcode must be mapped!
    const hasNameOrSku = (mapping.name !== -1 && mapping.name !== undefined) || 
                         (mapping.sku !== -1 && mapping.sku !== undefined) ||
                         (mapping.barcode !== -1 && mapping.barcode !== undefined);

    if (!hasNameOrSku) {
        showToast('Bitte ordnen Sie mindestens die Spalte "Artikelname", "Artikelnr. (SKU)" oder "Barcode / EAN" zu.', 'error');
        return;
    }

    STATE.csvImportState.mapping = mapping;

    // Validate rows
    const rows = STATE.csvImportState.rows;
    const validItems = [];
    const errors = [];
    let duplicateCount = 0;

    const existingBarcodes = new Set(STATE.products.filter(p => p.barcode).map(p => String(p.barcode).toLowerCase().trim()));
    const existingSkus = new Set(STATE.products.filter(p => p.sku).map(p => String(p.sku).toLowerCase().trim()));

    rows.forEach((row, idx) => {
        const lineNum = idx + 2; // header is line 1

        const rawSku = mapping.sku !== -1 && mapping.sku !== undefined ? String(row[mapping.sku] || '').trim() : '';
        const rawBarcode = mapping.barcode !== -1 && mapping.barcode !== undefined ? String(row[mapping.barcode] || '').trim() : '';
        const rawSize = mapping.size !== -1 && mapping.size !== undefined ? String(row[mapping.size] || '').trim() : '';
        const rawColor = mapping.color !== -1 && mapping.color !== undefined ? String(row[mapping.color] || '').trim() : '';
        let rawName = mapping.name !== -1 && mapping.name !== undefined ? String(row[mapping.name] || '').trim() : '';

        // Intelligent Fallback for name: Construct clean name from SKU + Color + Size if no explicit column
        if (!rawName) {
            const parts = [];
            if (rawSku) parts.push(rawSku);
            if (rawColor) parts.push(rawColor);
            if (rawSize) parts.push(`Gr. ${rawSize}`);
            rawName = parts.join(' ').trim() || (rawBarcode ? `Artikel ${rawBarcode}` : `Artikel ${idx + 1}`);
        }

        if (!rawName && !rawSku && !rawBarcode) {
            errors.push({ line: lineNum, col: 'Identifikation', error: 'Kein Name, SKU oder Barcode vorhanden', fix: 'Zeile wird ignoriert.' });
            return;
        }

        const category = mapping.category !== -1 && mapping.category !== undefined ? (String(row[mapping.category] || '').trim() || 'Schuhe') : 'Schuhe';
        const costPrice = mapping.cost_price !== -1 && mapping.cost_price !== undefined ? parseGermanNumber(row[mapping.cost_price], 0) : 0;
        const sellPrice = mapping.sell_price !== -1 && mapping.sell_price !== undefined ? parseGermanNumber(row[mapping.sell_price], 0) : 0;
        const stockQuantity = mapping.stock_quantity !== -1 && mapping.stock_quantity !== undefined ? Math.max(1, Math.round(parseGermanNumber(row[mapping.stock_quantity], 1))) : 1;
        const minStock = mapping.min_stock !== -1 && mapping.min_stock !== undefined ? Math.round(parseGermanNumber(row[mapping.min_stock], 3)) : 3;
        const manufacturer = mapping.manufacturer !== -1 && mapping.manufacturer !== undefined ? String(row[mapping.manufacturer] || '').trim() : '';
        const supplier = mapping.supplier !== -1 && mapping.supplier !== undefined ? String(row[mapping.supplier] || '').trim() : '';
        const storageLocation = mapping.storage_location !== -1 && mapping.storage_location !== undefined ? String(row[mapping.storage_location] || '').trim() : '';
        const taxRate = mapping.tax_rate !== -1 && mapping.tax_rate !== undefined ? Math.round(parseGermanNumber(row[mapping.tax_rate], 19)) : 19;
        const unit = mapping.unit !== -1 && mapping.unit !== undefined ? (String(row[mapping.unit] || '').trim() || 'Paar') : 'Paar';
        
        // Build rich description preserving size, color, order number, delivery date
        const descParts = [];
        if (mapping.description !== -1 && mapping.description !== undefined && row[mapping.description]) {
            descParts.push(String(row[mapping.description]).trim());
        }
        if (rawSize) descParts.push(`Größe: ${rawSize}`);
        if (rawColor) descParts.push(`Farbe: ${rawColor}`);
        if (mapping.order_number !== -1 && mapping.order_number !== undefined && row[mapping.order_number]) {
            descParts.push(`Auftrags-Nr.: ${row[mapping.order_number]}`);
        }
        if (mapping.delivery_date !== -1 && mapping.delivery_date !== undefined && row[mapping.delivery_date]) {
            descParts.push(`Liefertermin: ${row[mapping.delivery_date]}`);
        }
        const description = descParts.join(' | ');

        // Duplicate check
        const isDuplicate = (rawBarcode && existingBarcodes.has(rawBarcode.toLowerCase())) || 
                            (rawSku && existingSkus.has(rawSku.toLowerCase()));
        if (isDuplicate) duplicateCount++;

        validItems.push({
            name: rawName,
            barcode: rawBarcode,
            sku: rawSku,
            category,
            cost_price: costPrice,
            sell_price: sellPrice,
            stock_quantity: stockQuantity,
            min_stock: minStock,
            manufacturer,
            supplier,
            storage_location: storageLocation,
            tax_rate: taxRate,
            unit,
            description,
            size: rawSize,
            color: rawColor,
            isDuplicate
        });
    });

    STATE.csvImportState.validRows = validItems;
    STATE.csvImportState.invalidRows = errors;

    // Render Step 3 summary
    const summaryEl = document.getElementById('csvValidationSummary');
    if (summaryEl) {
        let html = `
            <div class="grid grid-cols-3 gap-3 text-center my-2">
                <div class="bg-emerald-50 border border-emerald-200 rounded-2xl p-3 shadow-xs">
                    <div class="text-[11px] text-emerald-800 font-bold uppercase">Bereit zum Import</div>
                    <div class="text-2xl font-black text-emerald-700">${validItems.length}</div>
                </div>
                <div class="bg-amber-50 border border-amber-200 rounded-2xl p-3 shadow-xs">
                    <div class="text-[11px] text-amber-800 font-bold uppercase">Bereits im System</div>
                    <div class="text-2xl font-black text-amber-700">${duplicateCount}</div>
                </div>
                <div class="bg-slate-50 border border-slate-200 rounded-2xl p-3 shadow-xs">
                    <div class="text-[11px] text-slate-600 font-bold uppercase">Fehlerhaft / Ignoriert</div>
                    <div class="text-2xl font-black ${errors.length > 0 ? 'text-rose-600' : 'text-slate-700'}">${errors.length}</div>
                </div>
            </div>
        `;

        // Add a preview table of prepared items
        if (validItems.length > 0) {
            html += `
                <div class="mt-3 border border-slate-200 rounded-2xl overflow-hidden bg-white shadow-xs">
                    <div class="bg-slate-50 px-3 py-2 text-xs font-bold text-slate-800 border-b border-slate-200 flex items-center justify-between">
                        <span>Vorschau der aufbereiteten Artikel (erste 5 Zeilen):</span>
                        <span class="text-[11px] text-slate-500 font-normal">Werte werden exakt übernommen</span>
                    </div>
                    <div class="max-h-36 overflow-x-auto">
                        <table class="w-full text-left text-xs">
                            <thead class="bg-slate-100 text-slate-600 font-bold text-[11px]">
                                <tr>
                                    <th class="py-1.5 px-3">Artikelname</th>
                                    <th class="py-1.5 px-3">Artikelnr. (SKU)</th>
                                    <th class="py-1.5 px-3">EAN / Barcode</th>
                                    <th class="py-1.5 px-3">Größe</th>
                                    <th class="py-1.5 px-3">Farbe</th>
                                    <th class="py-1.5 px-3">Menge</th>
                                    <th class="py-1.5 px-3">EK (€)</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-100 text-slate-700">
                                ${validItems.slice(0, 5).map(item => `
                                    <tr class="hover:bg-slate-50">
                                        <td class="py-1.5 px-3 font-semibold truncate max-w-[150px]">${escapeHtml(item.name)}</td>
                                        <td class="py-1.5 px-3 font-mono font-bold text-teal-700">${escapeHtml(item.sku || '-')}</td>
                                        <td class="py-1.5 px-3 font-mono">${escapeHtml(item.barcode || '-')}</td>
                                        <td class="py-1.5 px-3 font-bold text-slate-900">${escapeHtml(item.size || '-')}</td>
                                        <td class="py-1.5 px-3">${escapeHtml(item.color || '-')}</td>
                                        <td class="py-1.5 px-3 font-bold text-emerald-700">${item.stock_quantity} ${escapeHtml(item.unit)}</td>
                                        <td class="py-1.5 px-3 font-semibold">${formatCurrency(item.cost_price)}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        if (errors.length > 0) {
            html += `
                <div class="mt-3 border border-rose-200 rounded-xl overflow-hidden">
                    <div class="bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800 flex items-center gap-1.5">
                        <i data-lucide="alert-triangle" class="w-4 h-4"></i>
                        Gefundene Formatfehler (diese Zeilen werden übersprungen):
                    </div>
                    <div class="max-h-32 overflow-y-auto">
                        <table class="w-full text-left text-xs">
                            <thead class="bg-slate-100 text-slate-500 font-bold">
                                <tr>
                                    <th class="py-1.5 px-3">Zeile</th>
                                    <th class="py-1.5 px-3">Spalte</th>
                                    <th class="py-1.5 px-3">Fehler</th>
                                    <th class="py-1.5 px-3">Lösung</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-100 text-slate-700">
                                ${errors.slice(0, 10).map(e => `
                                    <tr>
                                        <td class="py-1.5 px-3 font-mono font-bold">${e.line}</td>
                                        <td class="py-1.5 px-3 font-semibold">${escapeHtml(e.col)}</td>
                                        <td class="py-1.5 px-3 text-rose-600">${escapeHtml(e.error)}</td>
                                        <td class="py-1.5 px-3 text-slate-500">${escapeHtml(e.fix)}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        summaryEl.innerHTML = html;
        if (window.lucide) lucide.createIcons();
    }

    document.getElementById('csvStep2').classList.add('hidden');
    document.getElementById('csvStep3').classList.remove('hidden');

    document.getElementById('importStepBadge2').className = 'flex items-center gap-1.5 text-slate-400';
    document.getElementById('importStepBadge3').className = 'flex items-center gap-1.5 text-teal-600 font-bold';
}

function backToCsvStep2() {
    document.getElementById('csvStep3').classList.add('hidden');
    document.getElementById('csvStep2').classList.remove('hidden');
    document.getElementById('importStepBadge2').className = 'flex items-center gap-1.5 text-teal-600 font-bold';
    document.getElementById('importStepBadge3').className = 'flex items-center gap-1.5 text-slate-400';
}

async function executeCsvImport() {
    const items = STATE.csvImportState.validRows;
    if (!items || items.length === 0) {
        showToast('Keine gültigen Datensätze zum Importieren vorhanden.', 'error');
        return;
    }

    const stratRadio = document.querySelector('input[name="csvDuplicateStrategy"]:checked');
    const duplicateStrategy = stratRadio ? stratRadio.value : 'update';

    const btn = document.getElementById('csvExecuteImportBtn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="animate-spin inline-block mr-1">↻</span> Importiere...';

    try {
        const result = await dataService.importProductsCsv(items, duplicateStrategy);
        closeModal('csvImportModal');
        const countCreated = result.imported || result.created || 0;
        const countUpdated = result.updated || 0;
        const countSkipped = result.skipped || 0;
        showToast(`Import erfolgreich: ${countCreated} neu angelegt, ${countUpdated} aktualisiert, ${countSkipped} übersprungen.`, 'success');
        resetCsvImport();
        switchTab('products');
        renderProductsTable();
    } catch (err) {
        showToast('Fehler beim Import: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

// CSV EXPORT MIT UTF-8 BOM & FORMEL-INJEKTIONS-SCHUTZ
// =============================================================================

function exportProductsCsv() {
    // Direct browser download from backend endpoint
    const url = '/api/products/export-csv';
    const link = document.createElement('a');
    link.href = url;
    link.download = `warenwirtschaft_export_${getTodayString()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Warenwirtschafts-CSV Export heruntergeladen.', 'success');
}

// =============================================================================
// LAGERBEWEGUNGS-HISTORIE (STOCK MOVEMENTS MODAL)
// =============================================================================

async function openStockHistoryModal(productId = null) {
    const modalTitle = document.getElementById('stockHistoryModalTitle');
    const tbody = document.getElementById('stockHistoryTableBody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-400">Lade Lagerprotokoll...</td></tr>';
    openModal('stockHistoryModal');

    try {
        let url = '/api/stock-movements';
        if (productId) {
            url = `/api/products/${productId}/movements`;
            const prod = STATE.products.find(p => p.id === productId);
            if (modalTitle && prod) {
                modalTitle.textContent = `Lagerbewegungen: ${prod.name}`;
            }
        } else {
            if (modalTitle) modalTitle.textContent = 'Gesamtes Lagerprotokoll';
        }

        const movements = await syncManager.apiRequest(url);

        if (!movements || movements.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-400">Keine Lagerbewegungen protokolliert.</td></tr>';
            return;
        }

        const TYPE_LABELS = {
            inbound: { label: '+ Wareneingang', color: 'bg-emerald-100 text-emerald-800' },
            outbound: { label: '- Verkauf', color: 'bg-blue-100 text-blue-800' },
            correction: { label: '~ Korrektur', color: 'bg-amber-100 text-amber-800' },
            inventory: { label: '📋 Inventur', color: 'bg-purple-100 text-purple-800' },
            import: { label: '📥 CSV Import', color: 'bg-teal-100 text-teal-800' }
        };

        tbody.innerHTML = movements.map(m => {
            const typeInfo = TYPE_LABELS[m.movement_type] || { label: m.movement_type, color: 'bg-slate-100 text-slate-700' };
            const dateStr = new Date(m.created_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            const deltaSign = m.delta > 0 ? `+${m.delta}` : `${m.delta}`;
            const deltaColor = m.delta > 0 ? 'text-emerald-700 font-bold' : (m.delta < 0 ? 'text-brand-600 font-bold' : 'text-slate-600');

            return `
                <tr class="hover:bg-slate-50 transition">
                    <td class="py-2.5 px-3 whitespace-nowrap text-slate-500 font-mono text-[11px]">${escapeHtml(dateStr)}</td>
                    <td class="py-2.5 px-3 font-semibold text-slate-900">${escapeHtml(m.product_name || m.product_id)}</td>
                    <td class="py-2.5 px-3">
                        <span class="px-2 py-0.5 rounded-md text-[10px] font-bold ${typeInfo.color}">${typeInfo.label}</span>
                    </td>
                    <td class="py-2.5 px-3 text-right font-mono text-xs ${deltaColor}">${deltaSign}</td>
                    <td class="py-2.5 px-3 text-right font-mono font-bold text-xs text-slate-900">${m.new_stock}</td>
                    <td class="py-2.5 px-3 text-slate-600 text-xs truncate max-w-[200px]" title="${escapeHtml(m.reason || '')}">${escapeHtml(m.reason || '-')}</td>
                </tr>
            `;
        }).join('');

    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-rose-500 font-semibold">Fehler beim Laden: ${escapeHtml(err.message)}</td></tr>`;
    }
}


// =============================================================================
// TOUCH QUICK NUMPAD FOR MOBILE RAPID REVENUE ENTRY
// =============================================================================

function openQuickNumpad() {
    STATE.numpad.cents = 0;
    updateNumpadDisplay();
    
    const storeSelect = document.getElementById('numpadStoreId');
    if (storeSelect && STATE.stores.length > 0) {
        storeSelect.value = STATE.currentStoreId !== 'ALL' ? STATE.currentStoreId : STATE.stores[0].id;
    }
    const dateInput = document.getElementById('numpadDate');
    if (dateInput) dateInput.value = getTodayString();
    const noteInput = document.getElementById('numpadNote');
    if (noteInput) noteInput.value = '';

    openModal('quickNumpadModal');
}

function pressNumpad(key) {
    if (key === 'C') {
        STATE.numpad.cents = 0;
    } else if (key === 'BACK') {
        STATE.numpad.cents = Math.floor(STATE.numpad.cents / 10);
    } else if (/^\d$/.test(key)) {
        // Prevent huge overflows (max 99.999,99 €)
        if (STATE.numpad.cents < 10000000) {
            STATE.numpad.cents = (STATE.numpad.cents * 10) + parseInt(key);
        }
    }
    updateNumpadDisplay();
}

function updateNumpadDisplay() {
    const display = document.getElementById('numpadDisplay');
    if (!display) return;
    const amount = STATE.numpad.cents / 100;
    display.textContent = formatCurrency(amount);
}

async function commitNumpad(type) {
    const amount = STATE.numpad.cents / 100;
    if (amount <= 0) {
        showToast('Bitte einen Betrag größer als 0 € eingeben.', 'error');
        return;
    }

    const storeId = document.getElementById('numpadStoreId').value;
    if (!storeId) {
        showToast('Bitte eine Filiale auswählen.', 'error');
        return;
    }
    const date = document.getElementById('numpadDate').value || getTodayString();
    const note = document.getElementById('numpadNote').value.trim() || (type === 'cash' ? 'Barverkauf' : 'Kartenzahlung');

    const cash = type === 'cash' ? amount : 0;
    const card = type === 'card' ? amount : 0;

    const payload = {
        storeId,
        date,
        cash,
        card,
        total: amount,
        note
    };

    const commitBtn = type === 'cash' ? document.getElementById('numpadBtnCash') : document.getElementById('numpadBtnCard');

    try {
        await dataService.saveRevenue(payload, commitBtn);
        closeModal('quickNumpadModal');
        STATE.numpad.cents = 0;
        updateNumpadDisplay();
        const noteInput = document.getElementById('numpadNote');
        if (noteInput) noteInput.value = '';
    } catch (err) {
        // Fehler von dataService angezeigt
    }
}

// =============================================================================
// CAMERA BARCODE SCANNER
// =============================================================================

// (Barcode scanner and quick scan functions relocated to Products & Inventory section below)
// =============================================================================
// SMARTPHONE PAIRING & PUBLIC HTTPS QR-CODE
// =============================================================================

function isValidClientPublicHttps(urlStr) {
    if (!urlStr) return false;
    try {
        const u = new URL(urlStr);
        if (u.protocol !== 'https:') return false;
        const h = u.hostname.toLowerCase();
        if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return false;
        if (h.startsWith('10.') || h.startsWith('192.168.')) return false;
        const match172 = h.match(/^172\.(\d+)\./);
        if (match172) {
            const octet = parseInt(match172[1], 10);
            if (octet >= 16 && octet <= 31) return false;
        }
        if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return false;
        return h.includes('.');
    } catch {
        return false;
    }
}

async function loadPublicUrlInfo() {
    const successState = document.getElementById('qrSuccessState');
    const errorState = document.getElementById('qrErrorState');
    const qrContainer = document.getElementById('qrCodeContainer');
    const urlInput = document.getElementById('qrPublicUrlInput');

    try {
        const apiBase = window.syncManager ? syncManager.getBaseUrl() : '';
        const res = await fetch(apiBase + '/api/network-info');
        if (!res.ok) throw new Error('Netzwerk-Endpunkt nicht erreichbar');
        const data = await res.json();

        let finalPublicUrl = data.pairingUrl || data.publicUrl;
        let qrCode = data.qrCode;

        // Auto-detect if user is accessing frontend over public HTTPS
        if (!finalPublicUrl && window.location.protocol === 'https:' && isValidClientPublicHttps(window.location.origin)) {
            finalPublicUrl = window.location.origin;
            try {
                const autoSaveRes = await fetch('/api/settings/public-url', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(syncManager.getToken() ? { 'Authorization': `Bearer ${syncManager.getToken()}` } : {})
                    },
                    body: JSON.stringify({ publicUrl: finalPublicUrl })
                });
                if (autoSaveRes.ok) {
                    const autoData = await autoSaveRes.json();
                    qrCode = autoData.qrCode;
                }
            } catch (e) {
                console.log('Auto-detection save skipped:', e.message);
            }
        }

        if (finalPublicUrl && qrCode) {
            if (qrContainer) {
                qrContainer.innerHTML = `<img src="${qrCode}" alt="Smartphone QR-Code" class="w-full h-full object-contain">`;
            }
            if (urlInput) {
                urlInput.value = finalPublicUrl;
            }
            if (successState) successState.classList.remove('hidden');
            if (errorState) errorState.classList.add('hidden');
        } else {
            console.error('[StoreControl] Öffentliche HTTPS-URL nicht konfiguriert oder ungültig. QR-Code wird nicht für localhost/private IPs erzeugt.');
            if (successState) successState.classList.add('hidden');
            if (errorState) errorState.classList.remove('hidden');
        }
    } catch (err) {
        console.error('[StoreControl] Fehler beim Laden der Netzwerk-Info:', err);
        if (successState) successState.classList.add('hidden');
        if (errorState) errorState.classList.remove('hidden');
    }

    if (window.lucide) lucide.createIcons();
}

async function handleSavePublicUrl(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('publicUrlInput');
    const errorEl = document.getElementById('publicUrlErrorMsg');
    const btn = document.getElementById('savePublicUrlBtn');
    if (!input) return;

    const url = input.value.trim();
    if (errorEl) errorEl.classList.add('hidden');

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> <span>Wird gespeichert...</span>';
        if (window.lucide) lucide.createIcons();
    }

    try {
        const res = await syncManager.apiRequest('/api/settings/public-url', {
            method: 'POST',
            body: JSON.stringify({ publicUrl: url })
        });

        if (!res.success) {
            throw new Error(res.error || 'Speichern fehlgeschlagen');
        }

        showToast('✓ Öffentliche Adresse erfolgreich eingerichtet!', 'success');
        await loadPublicUrlInfo();
    } catch (err) {
        if (errorEl) {
            errorEl.textContent = err.message || 'Fehler beim Speichern der URL';
            errorEl.classList.remove('hidden');
        } else {
            showToast(err.message, 'error');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i> <span>Speichern &amp; QR-Code aktivieren</span>';
            if (window.lucide) lucide.createIcons();
        }
    }
}

function showQrConfigForm() {
    const successState = document.getElementById('qrSuccessState');
    const errorState = document.getElementById('qrErrorState');
    const input = document.getElementById('publicUrlInput');
    const currentUrlInput = document.getElementById('qrPublicUrlInput');

    if (input && currentUrlInput && currentUrlInput.value) {
        input.value = currentUrlInput.value;
    }
    if (successState) successState.classList.add('hidden');
    if (errorState) errorState.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

function copyQrUrl() {
    const input = document.getElementById('qrPublicUrlInput');
    if (!input || !input.value) return;
    navigator.clipboard.writeText(input.value).then(() => {
        showToast('✓ Adresse in die Zwischenablage kopiert!', 'success');
    }).catch(() => {
        input.select();
        document.execCommand('copy');
        showToast('✓ Adresse in die Zwischenablage kopiert!', 'success');
    });
}

// =============================================================================
// AUDIT LOGS
// =============================================================================

async function loadAuditLogs() {
    const tbody = document.getElementById('auditLogsTableBody');
    if (!tbody || !syncManager.isLoggedIn()) return;

    try {
        const logs = await syncManager.apiRequest('/api/audit-logs?limit=50');
        tbody.innerHTML = logs.length === 0 ? '<tr><td colspan="5" class="py-6 text-center text-slate-400">Keine Revisions-Einträge vorhanden.</td></tr>' : '';

        logs.forEach(l => {
            let actionBadge = 'bg-slate-100 text-slate-700';
            if (l.action.includes('CREATE')) actionBadge = 'bg-emerald-100 text-emerald-800';
            else if (l.action.includes('UPDATE')) actionBadge = 'bg-brand-100 text-brand-800';
            else if (l.action.includes('DELETE')) actionBadge = 'bg-rose-100 text-rose-800';
            else if (l.action.includes('LOGIN')) actionBadge = 'bg-purple-100 text-purple-800';

            const details = l.newData ? JSON.stringify(l.newData) : (l.oldData ? 'Gelöscht: ' + JSON.stringify(l.oldData) : '-');

            const tr = `
                <tr class="hover:bg-slate-50/80 transition text-xs">
                    <td class="py-3 px-4 font-mono text-slate-500">${new Date(l.timestamp).toLocaleString('de-DE')}</td>
                    <td class="py-3 px-4 font-bold text-slate-900">${escapeHtml(l.changedBy || 'System')}</td>
                    <td class="py-3 px-4"><span class="px-2 py-0.5 rounded-full font-bold uppercase text-[10px] ${actionBadge}">${escapeHtml(l.action)}</span></td>
                    <td class="py-3 px-4 font-semibold text-slate-700">${escapeHtml(l.entityType)} (#${escapeHtml(l.entityId)})</td>
                    <td class="py-3 px-4 text-slate-600 max-w-xs truncate font-mono text-[11px]" title="${escapeHtml(details)}">${escapeHtml(details)}</td>
                </tr>
            `;
            tbody.insertAdjacentHTML('beforeend', tr);
        });
    } catch (err) {
        console.warn('Audit logs load failed:', err);
    }
}

// =============================================================================
// CONFLICT RESOLUTION MODAL
// =============================================================================

function showConflictModal(conflicts) {
    const modal = document.getElementById('conflictModal');
    const container = document.getElementById('conflictDetailsContainer');
    if (!modal || !container) return;

    container.innerHTML = '';
    conflicts.forEach(c => {
        container.innerHTML += `
            <div class="border border-amber-200 bg-amber-50/50 p-2.5 rounded-lg space-y-1">
                <div><strong>Datensatz ID:</strong> ${c.id || c.tempId}</div>
                <div><strong>Grund:</strong> ${c.reason || 'Parallele Änderung auf anderem Gerät'}</div>
            </div>
        `;
    });

    openModal('conflictModal');
}

function resolveConflict(strategy) {
    closeModal('conflictModal');
    if (strategy === 'keepServer') {
        showToast('Server-Stand beibehalten.', 'info');
        loadDataFromServer();
    } else {
        showToast('Änderung wird forciert übertragen.', 'info');
        triggerManualSync();
    }
}

// =============================================================================
// MONTHLY REPORT & GUV
// =============================================================================

function renderMonthlyReport() {
    const { revenues, expenses } = getFilteredData();
    const totals = calculateTotals(revenues, expenses);

    const guvRev = document.getElementById('guvTotalRevenue');
    if (guvRev) guvRev.textContent = formatCurrency(totals.totalRevenue);
    const guvCash = document.getElementById('guvCashRevenue');
    if (guvCash) guvCash.textContent = formatCurrency(totals.totalCash);
    const guvCard = document.getElementById('guvCardRevenue');
    if (guvCard) guvCard.textContent = formatCurrency(totals.totalCard);

    const guvExp = document.getElementById('guvTotalExpenses');
    if (guvExp) guvExp.textContent = formatCurrency(totals.totalExpenses);
    const guvGoods = document.getElementById('guvGoods');
    if (guvGoods) guvGoods.textContent = formatCurrency(totals.totalGoods);
    const guvStaff = document.getElementById('guvStaff');
    if (guvStaff) guvStaff.textContent = formatCurrency(totals.totalStaff);
    const guvRent = document.getElementById('guvRent');
    if (guvRent) guvRent.textContent = formatCurrency(totals.totalRent);
    const guvOther = document.getElementById('guvOther');
    if (guvOther) guvOther.textContent = formatCurrency(totals.totalOther);

    const guvGross = document.getElementById('guvGrossProfit');
    if (guvGross) guvGross.textContent = formatCurrency(totals.grossProfit);
    const guvNet = document.getElementById('guvNetProfit');
    if (guvNet) guvNet.textContent = formatCurrency(totals.netProfit);
    const guvMargin = document.getElementById('guvMargin');
    if (guvMargin) guvMargin.textContent = totals.profitMargin.toFixed(1) + '%';
    const guvCostRatio = document.getElementById('guvCostRatio');
    if (guvCostRatio) guvCostRatio.textContent = totals.costRatio.toFixed(1) + '%';

    // Store breakdown grid
    const grid = document.getElementById('guvStoresGrid');
    if (!grid) return;
    grid.innerHTML = '';

    STATE.stores.forEach(store => {
        const storeRevs = STATE.revenues.filter(r => r.storeId === store.id && r.date.startsWith(STATE.currentMonth));
        const storeExps = STATE.expenses.filter(e => e.storeId === store.id && e.date.startsWith(STATE.currentMonth));
        const stTotals = calculateTotals(storeRevs, storeExps);

        const card = `
            <div class="bg-slate-50 p-4 rounded-xl border border-slate-200/80 space-y-2 text-xs">
                <div class="font-bold text-sm text-slate-900 border-b border-slate-200 pb-1.5 flex items-center justify-between">
                    <span>${escapeHtml(store.name)}</span>
                    <span class="${stTotals.netProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'} font-black">${formatCurrency(stTotals.netProfit)}</span>
                </div>
                <div class="flex justify-between text-slate-600">
                    <span>Umsatz:</span>
                    <strong class="text-slate-800">${formatCurrency(stTotals.totalRevenue)}</strong>
                </div>
                <div class="flex justify-between text-slate-600">
                    <span>Kosten:</span>
                    <strong class="text-rose-600">${formatCurrency(stTotals.totalExpenses)}</strong>
                </div>
                <div class="flex justify-between text-slate-600">
                    <span>Gewinnmarge:</span>
                    <strong>${stTotals.profitMargin.toFixed(1)}%</strong>
                </div>
            </div>
        `;
        grid.insertAdjacentHTML('beforeend', card);
    });
}

// =============================================================================
// STORES MANAGEMENT
// =============================================================================

function renderStoresGrid() {
    const grid = document.getElementById('storesCardGrid');
    if (!grid) return;
    grid.innerHTML = '';

    STATE.stores.forEach(store => {
        const colorCfg = STORE_COLORS[store.color] || STORE_COLORS.emerald;
        const storeRevs = STATE.revenues.filter(r => r.storeId === store.id && r.date.startsWith(STATE.currentMonth));
        const totals = calculateTotals(storeRevs, []);

        const card = `
            <div class="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-sm space-y-4 hover:shadow-md transition">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2.5">
                        <span class="w-3 h-3 rounded-full ${colorCfg.bg}"></span>
                        <h3 class="font-bold text-slate-900 text-base">${escapeHtml(store.name)}</h3>
                    </div>
                    <div class="flex items-center gap-1">
                        <button onclick="editStore('${store.id}')" title="Bearbeiten" class="p-1 text-slate-400 hover:text-purple-600 rounded-lg">
                            <i data-lucide="edit-2" class="w-4 h-4"></i>
                        </button>
                        <button onclick="deleteStore('${store.id}')" title="Löschen" class="p-1 text-slate-400 hover:text-rose-600 rounded-lg">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    </div>
                </div>
                <div class="text-xs text-slate-500 space-y-1">
                    <div>📍 ${escapeHtml(store.address || 'Keine Adresse')}</div>
                    <div>👤 Leitung: ${escapeHtml(store.manager || 'Nicht hinterlegt')}</div>
                    <div>📞 ${escapeHtml(store.phone || 'Keine Telefonnummer')}</div>
                    <div>👥 Mitarbeiter: ${store.employeeCount || 2}</div>
                </div>
                <div class="pt-2 border-t border-slate-100 flex items-center justify-between text-xs">
                    <span class="text-slate-500">Umsatzziel:</span>
                    <strong class="text-slate-800">${formatCurrency(store.targetRevenue || 0)}</strong>
                </div>
                <div class="flex items-center justify-between text-xs">
                    <span class="text-slate-500">Umsatz aktuell:</span>
                    <strong class="text-emerald-600">${formatCurrency(totals.totalRevenue)}</strong>
                </div>
            </div>
        `;
        grid.insertAdjacentHTML('beforeend', card);
    });

    if (window.lucide) lucide.createIcons();
}

function quickBookForStore(storeId) {
    const revStoreSelect = document.getElementById('revStoreId');
    if (revStoreSelect) revStoreSelect.value = storeId;
    openModal('quickRevenueModal');
}

async function handleStoreSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const editId = document.getElementById('storeEditId').value.trim();
    const existing = editId ? STATE.stores.find(s => s.id === editId) : null;

    const name = document.getElementById('storeName').value.trim() || (existing ? existing.name : '');
    const address = document.getElementById('storeAddress').value.trim() || (existing ? (existing.address || '') : '');
    const manager = document.getElementById('storeManager').value.trim() || (existing ? (existing.manager || '') : '');
    const phone = document.getElementById('storePhone').value.trim() || (existing ? (existing.phone || '') : '');
    const color = document.getElementById('storeColor').value || (existing ? existing.color : 'emerald');
    const employeeCount = parseInt(document.getElementById('storeEmployeeCount').value) || (existing ? existing.employeeCount : 2);
    const targetVal = document.getElementById('storeTargetRevenue').value;
    const targetRevenue = (targetVal !== '' && !isNaN(parseFloat(targetVal))) ? parseFloat(targetVal) : (existing ? existing.targetRevenue : 0);

    if (!name) {
        showToast('Bitte einen Filialnamen eingeben.', 'error');
        return;
    }

    const payload = {
        ...(existing || {}),
        id: editId || undefined,
        name,
        address,
        manager,
        phone,
        color,
        employeeCount,
        targetRevenue
    };

    try {
        await dataService.saveStore(payload, submitBtn);
        closeModal('addStoreModal');
        form.reset();
        document.getElementById('storeEditId').value = '';
    } catch (err) {
        // Fehler von dataService angezeigt; Formular bleibt erhalten
    }
}

async function handleBulkStoreSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const names = document.getElementById('bulkStoreNames').value.split('\n').map(n => n.trim()).filter(n => n.length > 0);
    const employeeCount = parseInt(document.getElementById('bulkEmployeeCount').value) || 2;
    const targetRevenue = parseFloat(document.getElementById('bulkTargetRevenue').value) || 0;

    if (names.length === 0) {
        showToast('Bitte mindestens einen Filialnamen eingeben.', 'error');
        return;
    }

    const colors = ['emerald', 'blue', 'purple', 'amber', 'rose', 'teal'];
    dataService.setButtonLoading(submitBtn, true, '⟳ Wird gespeichert...');

    try {
        let successCount = 0;
        for (let i = 0; i < names.length; i++) {
            await dataService.saveStore({
                name: names[i],
                color: colors[i % colors.length],
                employeeCount,
                targetRevenue
            });
            successCount++;
        }
        closeModal('bulkAddStoresModal');
        form.reset();
        showToast(`✓ ${successCount} Filialen erfolgreich angelegt!`, 'success');
    } catch (err) {
        showToast('Massen-Anlage teilweise fehlgeschlagen: ' + err.message, 'error');
    } finally {
        dataService.setButtonLoading(submitBtn, false);
    }
}

function editStore(id) {
    const store = STATE.stores.find(s => s.id === id);
    if (!store) {
        showToast('Filiale nicht gefunden.', 'error');
        return;
    }

    document.getElementById('storeModalTitle').textContent = 'Filiale bearbeiten';
    document.getElementById('storeEditId').value = store.id;
    document.getElementById('storeName').value = store.name;
    document.getElementById('storeAddress').value = store.address || '';
    document.getElementById('storeManager').value = store.manager || '';
    document.getElementById('storePhone').value = store.phone || '';
    document.getElementById('storeColor').value = store.color || 'emerald';
    document.getElementById('storeEmployeeCount').value = store.employeeCount || 2;
    document.getElementById('storeTargetRevenue').value = store.targetRevenue ? Number(store.targetRevenue).toFixed(2) : '';

    openModal('addStoreModal', true);
}

async function deleteStore(id) {
    if (!confirm('Möchten Sie diese Filiale wirklich löschen?')) return;
    try {
        await dataService.deleteStore(id);
    } catch (err) {
        // Fehler von dataService angezeigt
    }
}

// =============================================================================
// DEMO DATA & RESET
// =============================================================================

async function loadDemoData() {
    if (!confirm('Möchten Sie Beispieldaten laden?')) return;

    const [curY, curM] = STATE.currentMonth.split('-').map(Number);
    const daysInMonth = new Date(curY, curM, 0).getDate();
    const today = new Date();
    const currentDayLimit = (today.getFullYear() === curY && (today.getMonth() + 1) === curM) 
        ? today.getDate() 
        : daysInMonth;

    try {
        // Create 3 demo stores
        const store1 = await syncManager.apiRequest('/api/stores', {
            method: 'POST',
            body: JSON.stringify({ name: 'Filiale Mitte (Hauptstraße)', address: 'Hauptstraße 45, Berlin', color: 'emerald', employeeCount: 4, targetRevenue: 30000 })
        });
        const store2 = await syncManager.apiRequest('/api/stores', {
            method: 'POST',
            body: JSON.stringify({ name: 'Filiale Bahnhof (Center)', address: 'Willy-Brandt-Platz 1, Berlin', color: 'blue', employeeCount: 3, targetRevenue: 22000 })
        });
        const store3 = await syncManager.apiRequest('/api/stores', {
            method: 'POST',
            body: JSON.stringify({ name: 'Filiale West (Einkaufspark)', address: 'Westring 88, Berlin', color: 'purple', employeeCount: 2, targetRevenue: 18000 })
        });

        // Insert some revenues for the month
        for (let d = 1; d <= currentDayLimit; d++) {
            const dateStr = `${curY}-${String(curM).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const cash = Math.round(300 + Math.random() * 200);
            const card = Math.round(500 + Math.random() * 400);

            await syncManager.apiRequest('/api/revenues', {
                method: 'POST',
                body: JSON.stringify({ storeId: store1.id, date: dateStr, cash, card, total: cash + card, note: 'Tagesgeschäft' })
            });
        }

        // Insert expenses
        await syncManager.apiRequest('/api/expenses', {
            method: 'POST',
            body: JSON.stringify({ storeId: store1.id, category: 'rent', date: `${STATE.currentMonth}-01`, amount: 2400, title: 'Kaltmiete & Nebenkosten', recurrence: 'monthly' })
        });
        await syncManager.apiRequest('/api/expenses', {
            method: 'POST',
            body: JSON.stringify({ storeId: store1.id, category: 'staff', date: `${STATE.currentMonth}-01`, amount: 4800, title: 'Mitarbeitergehälter', recurrence: 'monthly' })
        });
        await syncManager.apiRequest('/api/expenses', {
            method: 'POST',
            body: JSON.stringify({ storeId: store1.id, category: 'goods', date: `${STATE.currentMonth}-05`, amount: 1950, title: 'Wareneinkauf Großhandel', recurrence: 'single' })
        });

        // Insert demo products
        await syncManager.apiRequest('/api/products', {
            method: 'POST',
            body: JSON.stringify({ storeId: store1.id, name: 'Turnschuh Classic Retro', barcode: '401234567890', sku: 'SCHUH-101', category: 'Schuhe', costPrice: 42.50, sellPrice: 89.90, stockQuantity: 24, minStock: 5 })
        });
        await syncManager.apiRequest('/api/products', {
            method: 'POST',
            body: JSON.stringify({ storeId: store1.id, name: 'Leder-Sneaker Urban White', barcode: '401234567891', sku: 'SCHUH-102', category: 'Schuhe', costPrice: 55.00, sellPrice: 119.00, stockQuantity: 18, minStock: 4 })
        });

        showToast('Beispieldaten erfolgreich geladen!', 'success');
        await loadDataFromServer();
    } catch (err) {
        showToast('Fehler beim Laden der Demodaten: ' + err.message, 'error');
    }
}

async function clearAllData() {
    if (!confirm('ACHTUNG: Möchten Sie wirklich alle Daten zurücksetzen?')) return;
    try {
        localStorage.clear();
        showToast('Lokaler Speicher zurückgesetzt.', 'info');
        window.location.reload();
    } catch (err) {
        showToast('Fehler: ' + err.message, 'error');
    }
}

// =============================================================================
// EXPORT FUNCTIONS (CSV & JSON)
// =============================================================================

function exportRevenuesCSV() {
    let csv = '\uFEFFDatum;Filiale;Bar (€);Karte (€);Gesamt (€);Notiz\n';
    STATE.revenues.forEach(r => {
        const store = STATE.stores.find(s => s.id === r.storeId);
        const storeName = store ? store.name : 'Gelöscht';
        csv += `"${r.date}";"${storeName}";"${r.cash.toFixed(2).replace('.', ',')}";"${r.card.toFixed(2).replace('.', ',')}";"${r.total.toFixed(2).replace('.', ',')}";"${(r.note || '').replace(/"/g, '""')}"\n`;
    });
    downloadBlob(csv, `StoreControl_Umsaetze_${STATE.currentMonth}.csv`, 'text/csv;charset=utf-8;');
}

function exportExpensesCSV() {
    let csv = '\uFEFFDatum;Filiale;Kategorie;Bezeichnung;Art;Betrag (€)\n';
    STATE.expenses.forEach(e => {
        const store = STATE.stores.find(s => s.id === e.storeId);
        const storeName = store ? store.name : 'Gelöscht';
        csv += `"${e.date}";"${storeName}";"${CATEGORY_NAMES[e.category] || e.category}";"${(e.title || '').replace(/"/g, '""')}";"${e.recurrence}";"${e.amount.toFixed(2).replace('.', ',')}"\n`;
    });
    downloadBlob(csv, `StoreControl_Kosten_${STATE.currentMonth}.csv`, 'text/csv;charset=utf-8;');
}

function exportMonthlyCSV() {
    const { revenues, expenses } = getFilteredData();
    const totals = calculateTotals(revenues, expenses);
    let csv = `\uFEFFGuV-Monatsbericht: ${STATE.currentMonth}\n\n`;
    csv += `Gesamterlöse (Umsatz);${totals.totalRevenue.toFixed(2).replace('.', ',')} €\n`;
    csv += `- Barumsatz;${totals.totalCash.toFixed(2).replace('.', ',')} €\n`;
    csv += `- Kartenzahlung;${totals.totalCard.toFixed(2).replace('.', ',')} €\n\n`;
    csv += `Gesamtkosten;${totals.totalExpenses.toFixed(2).replace('.', ',')} €\n`;
    csv += `- Warenkosten (Wareneinsatz);${totals.totalGoods.toFixed(2).replace('.', ',')} €\n`;
    csv += `- Mitarbeiter;${totals.totalStaff.toFixed(2).replace('.', ',')} €\n`;
    csv += `- Miete & Nebenkosten;${totals.totalRent.toFixed(2).replace('.', ',')} €\n`;
    csv += `- Sonstige Betriebskosten;${totals.totalOther.toFixed(2).replace('.', ',')} €\n\n`;
    csv += `Rohertrag;${totals.grossProfit.toFixed(2).replace('.', ',')} €\n`;
    csv += `Reingewinn (Nettoergebnis);${totals.netProfit.toFixed(2).replace('.', ',')} €\n`;
    csv += `Gewinnmarge;${totals.profitMargin.toFixed(1)}%\n`;

    downloadBlob(csv, `StoreControl_GuV_${STATE.currentMonth}.csv`, 'text/csv;charset=utf-8;');
}

function downloadBackupJSON() {
    const backupData = {
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        stores: STATE.stores,
        revenues: STATE.revenues,
        expenses: STATE.expenses,
        products: STATE.products
    };
    downloadBlob(JSON.stringify(backupData, null, 2), `StoreControl_Backup_${getTodayString()}.json`, 'application/json');
}

function restoreBackupJSON(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.stores || !data.revenues || !data.expenses) {
                throw new Error('Ungültiges Sicherungsformat');
            }
            await syncManager.apiRequest('/api/migration/import', {
                method: 'POST',
                body: JSON.stringify(data)
            });
            showToast('Sicherungsdatei erfolgreich wiederhergestellt!', 'success');
            await loadDataFromServer();
        } catch (err) {
            showToast('Wiederherstellung fehlgeschlagen: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);
}

function downloadBlob(content, filename, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// =============================================================================
// MODAL & UI HELPERS
// =============================================================================

function openModal(modalId, isEdit = false) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('hidden');

    if (!isEdit) {
        if (modalId === 'quickRevenueModal') {
            document.getElementById('revenueModalTitle').textContent = 'Tagesumsatz erfassen';
            document.getElementById('revEditId').value = '';
            document.getElementById('revCash').value = '0.00';
            document.getElementById('revCard').value = '0.00';
            document.getElementById('revNote').value = '';
            calculateRevTotal();
        } else if (modalId === 'quickExpenseModal') {
            document.getElementById('expenseModalTitle').textContent = 'Kosten & Ausgaben erfassen';
            document.getElementById('expEditId').value = '';
            document.getElementById('expAmount').value = '';
            document.getElementById('expTitle').value = '';
        } else if (modalId === 'addStoreModal') {
            document.getElementById('storeModalTitle').textContent = 'Neue Filiale anlegen';
            document.getElementById('storeEditId').value = '';
            document.getElementById('storeForm').reset();
        } else if (modalId === 'productModal') {
            document.getElementById('productModalTitle').textContent = 'Neuen Artikel anlegen';
            document.getElementById('prodEditId').value = '';
            document.getElementById('productForm').reset();
        }
    }

    if (modalId === 'qrModal') {
        loadPublicUrlInfo();
    }

    if (window.lucide) lucide.createIcons();
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('hidden');
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMessage');
    const toastIcon = document.getElementById('toastIcon');
    if (!toast || !toastMsg) return;

    toastMsg.textContent = message;

    if (type === 'error') {
        toastIcon.className = 'w-6 h-6 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center flex-shrink-0';
        toastIcon.innerHTML = '<i data-lucide="alert-circle" class="w-4 h-4"></i>';
    } else if (type === 'info') {
        toastIcon.className = 'w-6 h-6 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center flex-shrink-0';
        toastIcon.innerHTML = '<i data-lucide="info" class="w-4 h-4"></i>';
    } else {
        toastIcon.className = 'w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center flex-shrink-0';
        toastIcon.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i>';
    }

    if (window.lucide) lucide.createIcons();

    toast.classList.remove('translate-y-24', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');

    setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-24', 'opacity-0');
    }, 3500);
}

// =============================================================================
// FORMATTING UTILITIES
// =============================================================================

function formatCurrency(amount) {
    return (parseFloat(amount) || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function formatCurrencyShort(amount) {
    const val = parseFloat(amount) || 0;
    if (val >= 1000) {
        return (val / 1000).toFixed(1).replace('.', ',') + 'k €';
    }
    return Math.round(val) + ' €';
}

function formatDateDE(isoDate) {
    if (!isoDate) return '-';
    const parts = isoDate.split('-');
    if (parts.length === 3) {
        return `${parts[2]}.${parts[1]}.${parts[0]}`;
    }
    return isoDate;
}

function getTodayString() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}


// =============================================================================
// PWA INSTALLATION & STANDALONE MANAGEMENT
// =============================================================================
let deferredInstallPrompt = null;

function isPwaStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || 
           window.navigator.standalone === true ||
           document.referrer.includes('android-app://');
}

function initPwaInstallManager() {
    const installBtn = document.getElementById('pwaInstallHeaderBtn');
    const isStandalone = isPwaStandalone();

    if (isStandalone) {
        console.log('[PWA] Store Control laeuft im Standalone-App-Modus');
        if (installBtn) installBtn.classList.add('hidden');
        return;
    }

    // If on mobile browser (iPhone, Android, tablet) and not standalone, show install button in header
    const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 768;
    if (installBtn && isMobileDevice) {
        installBtn.classList.remove('hidden');
    }
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    console.log('[PWA] beforeinstallprompt registriert (Android 1-Klick Installation bereit)');

    const installBtn = document.getElementById('pwaInstallHeaderBtn');
    if (installBtn && !isPwaStandalone()) {
        installBtn.classList.remove('hidden');
    }
    const androidBox = document.getElementById('androidPromptActionBox');
    if (androidBox) {
        androidBox.classList.remove('hidden');
    }
});

window.addEventListener('appinstalled', () => {
    console.log('[PWA] Store Control wurde erfolgreich als App installiert!');
    deferredInstallPrompt = null;
    const installBtn = document.getElementById('pwaInstallHeaderBtn');
    if (installBtn) installBtn.classList.add('hidden');
    const androidBox = document.getElementById('androidPromptActionBox');
    if (androidBox) androidBox.classList.add('hidden');
    showToast('Store Control wurde erfolgreich auf Ihrem Startbildschirm installiert!', 'success');
});

function handlePwaInstallClick() {
    if (deferredInstallPrompt) {
        executeAndroidPwaPrompt();
    } else {
        openModal('pwaInstallModal');
    }
}

async function executeAndroidPwaPrompt() {
    if (!deferredInstallPrompt) {
        openModal('pwaInstallModal');
        return;
    }
    try {
        deferredInstallPrompt.prompt();
        const choiceResult = await deferredInstallPrompt.userChoice;
        console.log('[PWA] User Choice:', choiceResult.outcome);
        if (choiceResult.outcome === 'accepted') {
            showToast('Store Control wird installiert...', 'info');
        }
        deferredInstallPrompt = null;
        closeModal('pwaInstallModal');
    } catch (err) {
        console.error('[PWA] Prompt error:', err);
        openModal('pwaInstallModal');
    }
}


// =============================================================================
// DARK MODE & THEME MANAGEMENT
// =============================================================================

function initTheme() {
    const savedTheme = localStorage.getItem('storecontrol_theme') || 'dark';
    applyTheme(savedTheme, false);
}

function applyTheme(theme, reRenderCharts = true) {
    const html = document.documentElement;
    const isDark = theme === 'dark';

    if (isDark) {
        html.classList.add('dark');
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) metaTheme.setAttribute('content', '#090d16');
    } else {
        html.classList.remove('dark');
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) metaTheme.setAttribute('content', '#0f172a');
    }

    try {
        localStorage.setItem('storecontrol_theme', theme);
    } catch (e) {}

    const iconSun = document.getElementById('themeIconSun');
    const iconMoon = document.getElementById('themeIconMoon');
    const textSpan = document.getElementById('themeToggleText');

    if (iconSun && iconMoon) {
        if (isDark) {
            iconSun.classList.add('hidden');
            iconMoon.classList.remove('hidden');
            if (textSpan) textSpan.textContent = 'Dark';
        } else {
            iconSun.classList.remove('hidden');
            iconMoon.classList.add('hidden');
            if (textSpan) textSpan.textContent = 'Light';
        }
    }

    if (typeof Chart !== 'undefined') {
        Chart.defaults.color = isDark ? '#94a3b8' : '#64748b';
        Chart.defaults.borderColor = isDark ? 'rgba(255, 255, 255, 0.08)' : '#f1f5f9';
    }

    if (reRenderCharts) {
        if (typeof renderTrendChart === 'function') renderTrendChart();
        if (typeof renderCostDonutChart === 'function') renderCostDonutChart();
    }
    
    if (window.lucide) {
        try { lucide.createIcons(); } catch(e) {}
    }
}

function toggleDarkMode() {
    const currentTheme = localStorage.getItem('storecontrol_theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme, true);
    if (typeof showToast === 'function') {
        showToast(newTheme === 'dark' ? '🌙 Dunkelmodus aktiviert' : '☀️ Hellmodus aktiviert', 'info');
    }
}
window.toggleDarkMode = toggleDarkMode;
