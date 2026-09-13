const fs = require('fs');

let appJs = fs.readFileSync('app.js', 'utf8');

// 1. Fix openModal so that when isEdit is true, it does not wipe the populated form fields
const oldOpenModal = `function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('hidden');

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
    } else if (modalId === 'qrModal') {
        loadPublicUrlInfo();
    }

    if (window.lucide) lucide.createIcons();
}`;

const newOpenModal = `function openModal(modalId, isEdit = false) {
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
}`;

if (appJs.includes(oldOpenModal)) {
    appJs = appJs.replace(oldOpenModal, newOpenModal);
    console.log('1. openModal updated successfully');
} else {
    console.log('1. openModal already updated or signature mismatch');
}

// 2. Fix editRevenue to pass isEdit = true to openModal and ensure safe number formatting
const oldEditRev = `function editRevenue(id) {
    const rev = STATE.revenues.find(r => r.id === id);
    if (!rev) return;

    document.getElementById('revEditId').value = rev.id;
    document.getElementById('revenueModalTitle').textContent = 'Tagesumsatz bearbeiten';
    document.getElementById('revDate').value = rev.date;
    document.getElementById('revStoreId').value = rev.storeId;
    document.getElementById('revCash').value = rev.cash.toFixed(2);
    document.getElementById('revCard').value = rev.card.toFixed(2);
    document.getElementById('revNote').value = rev.note || '';
    calculateRevTotal();

    openModal('quickRevenueModal');
}`;

const newEditRev = `function editRevenue(id) {
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
}`;

if (appJs.includes(oldEditRev)) {
    appJs = appJs.replace(oldEditRev, newEditRev);
    console.log('2. editRevenue updated successfully');
} else {
    console.log('2. editRevenue already updated or signature mismatch');
}

// 3. Fix handleRevenueSubmit to merge with existing record when editing
const oldHandleRevSubmit = `async function handleRevenueSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const editId = document.getElementById('revEditId').value;
    const date = document.getElementById('revDate').value;
    const storeId = document.getElementById('revStoreId').value;
    const cash = parseFloat(document.getElementById('revCash').value) || 0;
    const card = parseFloat(document.getElementById('revCard').value) || 0;
    const total = Math.round((cash + card) * 100) / 100;
    const note = document.getElementById('revNote').value.trim();

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
        showToast('Gesamtumsatz muss größer als 0 sein.', 'error');
        return;
    }

    const payload = {
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
}`;

const newHandleRevSubmit = `async function handleRevenueSubmit(e) {
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
        showToast('Gesamtumsatz muss größer als 0 sein.', 'error');
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
}`;

if (appJs.includes(oldHandleRevSubmit)) {
    appJs = appJs.replace(oldHandleRevSubmit, newHandleRevSubmit);
    console.log('3. handleRevenueSubmit updated successfully');
} else {
    console.log('3. handleRevenueSubmit already updated or signature mismatch');
}

// 4. Fix editExpense & handleExpenseSubmit
const oldEditExp = `function editExpense(id) {
    const exp = STATE.expenses.find(e => e.id === id);
    if (!exp) return;

    document.getElementById('expEditId').value = exp.id;
    document.getElementById('expenseModalTitle').textContent = 'Kostenposition bearbeiten';
    document.getElementById('expStoreId').value = exp.storeId;
    document.getElementById('expCategory').value = exp.category;
    document.getElementById('expDate').value = exp.date;
    document.getElementById('expAmount').value = exp.amount.toFixed(2);
    document.getElementById('expTitle').value = exp.title;

    const radio = document.querySelector(\`input[name="expRecurrence"][value="\${exp.recurrence}"]\`);
    if (radio) radio.checked = true;

    openModal('quickExpenseModal');
}`;

const newEditExp = `function editExpense(id) {
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

    const radio = document.querySelector(\`input[name="expRecurrence"][value="\${exp.recurrence}"]\`);
    if (radio) radio.checked = true;

    openModal('quickExpenseModal', true);
}`;

if (appJs.includes(oldEditExp)) {
    appJs = appJs.replace(oldEditExp, newEditExp);
    console.log('4. editExpense updated successfully');
}

const oldHandleExpSubmit = `async function handleExpenseSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const editId = document.getElementById('expEditId').value;
    const storeId = document.getElementById('expStoreId').value;
    const category = document.getElementById('expCategory').value;
    const date = document.getElementById('expDate').value;
    const amount = parseFloat(document.getElementById('expAmount').value) || 0;
    const title = document.getElementById('expTitle').value.trim();
    const recurrence = document.querySelector('input[name="expRecurrence"]:checked')?.value || 'single';

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
}`;

const newHandleExpSubmit = `async function handleExpenseSubmit(e) {
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
}`;

if (appJs.includes(oldHandleExpSubmit)) {
    appJs = appJs.replace(oldHandleExpSubmit, newHandleExpSubmit);
    console.log('5. handleExpenseSubmit updated successfully');
}

// 5. Fix editProduct & handleProductSubmit
const oldEditProd = `function editProduct(id) {
    const prod = STATE.products.find(p => p.id === id);
    if (!prod) return;

    document.getElementById('prodEditId').value = prod.id;
    document.getElementById('productModalTitle').textContent = 'Artikel bearbeiten';
    document.getElementById('prodName').value = prod.name;
    document.getElementById('prodStoreId').value = prod.storeId || '';
    document.getElementById('prodBarcode').value = prod.barcode || '';
    document.getElementById('prodSku').value = prod.sku || '';
    document.getElementById('prodCategory').value = prod.category || 'Allgemein';
    document.getElementById('prodCostPrice').value = prod.costPrice.toFixed(2);
    document.getElementById('prodSellPrice').value = prod.sellPrice.toFixed(2);
    document.getElementById('prodStock').value = prod.stockQuantity;
    document.getElementById('prodMinStock').value = prod.minStock;

    openModal('productModal');
}`;

const newEditProd = `function editProduct(id) {
    const prod = STATE.products.find(p => p.id === id);
    if (!prod) {
        showToast('Artikel nicht gefunden.', 'error');
        return;
    }

    document.getElementById('productModalTitle').textContent = 'Artikel bearbeiten';
    document.getElementById('prodEditId').value = prod.id;
    document.getElementById('prodName').value = prod.name;
    document.getElementById('prodStoreId').value = prod.storeId || '';
    document.getElementById('prodBarcode').value = prod.barcode || '';
    document.getElementById('prodSku').value = prod.sku || '';
    document.getElementById('prodCategory').value = prod.category || 'Allgemein';
    document.getElementById('prodCostPrice').value = Number(prod.costPrice).toFixed(2);
    document.getElementById('prodSellPrice').value = Number(prod.sellPrice).toFixed(2);
    document.getElementById('prodStock').value = prod.stockQuantity;
    document.getElementById('prodMinStock').value = prod.minStock;

    openModal('productModal', true);
}`;

if (appJs.includes(oldEditProd)) {
    appJs = appJs.replace(oldEditProd, newEditProd);
    console.log('6. editProduct updated successfully');
}

const oldHandleProdSubmit = `async function handleProductSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const editId = document.getElementById('prodEditId').value;
    const name = document.getElementById('prodName').value.trim();
    const storeId = document.getElementById('prodStoreId').value || null;
    const barcode = document.getElementById('prodBarcode').value.trim();
    const sku = document.getElementById('prodSku').value.trim();
    const category = document.getElementById('prodCategory').value.trim() || 'Allgemein';
    const costPrice = parseFloat(document.getElementById('prodCostPrice').value) || 0;
    const sellPrice = parseFloat(document.getElementById('prodSellPrice').value) || 0;
    const stockQuantity = parseInt(document.getElementById('prodStock').value) || 0;
    const minStock = parseInt(document.getElementById('prodMinStock').value) || 0;

    if (!name) {
        showToast('Bitte einen Artikelnamen eingeben.', 'error');
        return;
    }
    if (costPrice < 0 || sellPrice < 0) {
        showToast('Preise dürfen nicht negativ sein.', 'error');
        return;
    }

    const payload = {
        id: editId || undefined,
        name,
        storeId,
        barcode,
        sku,
        category,
        costPrice,
        sellPrice,
        stockQuantity,
        minStock
    };

    try {
        await dataService.saveProduct(payload, submitBtn);
        closeModal('productModal');
        form.reset();
        document.getElementById('prodEditId').value = '';
    } catch (err) {
        // Formular bleibt bei Fehlern erhalten
    }
}`;

const newHandleProdSubmit = `async function handleProductSubmit(e) {
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
        stockQuantity,
        minStock
    };

    try {
        await dataService.saveProduct(payload, submitBtn);
        closeModal('productModal');
        form.reset();
        document.getElementById('prodEditId').value = '';
    } catch (err) {
        // Formular bleibt bei Fehlern erhalten
    }
}`;

if (appJs.includes(oldHandleProdSubmit)) {
    appJs = appJs.replace(oldHandleProdSubmit, newHandleProdSubmit);
    console.log('7. handleProductSubmit updated successfully');
}

// 6. Fix editStore & handleStoreSubmit
const oldEditStore = `function editStore(id) {
    const store = STATE.stores.find(s => s.id === id);
    if (!store) return;

    document.getElementById('storeEditId').value = store.id;
    document.getElementById('storeModalTitle').textContent = 'Filiale bearbeiten';
    document.getElementById('storeName').value = store.name;
    document.getElementById('storeAddress').value = store.address || '';
    document.getElementById('storeManager').value = store.manager || '';
    document.getElementById('storePhone').value = store.phone || '';
    document.getElementById('storeColor').value = store.color || 'emerald';
    document.getElementById('storeEmployeeCount').value = store.employeeCount || 2;
    document.getElementById('storeTargetRevenue').value = store.targetRevenue || '';

    openModal('addStoreModal');
}`;

const newEditStore = `function editStore(id) {
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
}`;

if (appJs.includes(oldEditStore)) {
    appJs = appJs.replace(oldEditStore, newEditStore);
    console.log('8. editStore updated successfully');
}

const oldHandleStoreSubmit = `async function handleStoreSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const editId = document.getElementById('storeEditId').value;
    const name = document.getElementById('storeName').value.trim();
    const address = document.getElementById('storeAddress').value.trim();
    const manager = document.getElementById('storeManager').value.trim();
    const phone = document.getElementById('storePhone').value.trim();
    const color = document.getElementById('storeColor').value;
    const employeeCount = parseInt(document.getElementById('storeEmployeeCount').value) || 2;
    const targetRevenue = parseFloat(document.getElementById('storeTargetRevenue').value) || 0;

    if (!name) {
        showToast('Bitte einen Filialnamen eingeben.', 'error');
        return;
    }

    const payload = {
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
}`;

const newHandleStoreSubmit = `async function handleStoreSubmit(e) {
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
}`;

if (appJs.includes(oldHandleStoreSubmit)) {
    appJs = appJs.replace(oldHandleStoreSubmit, newHandleStoreSubmit);
    console.log('9. handleStoreSubmit updated successfully');
}

fs.writeFileSync('app.js', appJs, 'utf8');
console.log('ALL app.js updates written cleanly!');
