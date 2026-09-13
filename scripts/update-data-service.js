const fs = require('fs');
let code = fs.readFileSync('data-service.js', 'utf8');

// 1. Revenue
const targetRev = `    async saveRevenue(payload, buttonEl = null) {
        const isEdit = !!payload.id && !payload._isNew;
        const recordId = payload.id || this.generateId('rev');

        const cashNum = Math.round((parseFloat(payload.cash) || 0) * 100) / 100;
        const cardNum = Math.round((parseFloat(payload.card) || 0) * 100) / 100;
        const totalNum = Math.round((cashNum + cardNum) * 100) / 100;

        const completePayload = {
            ...payload,
            id: recordId,
            cash: cashNum,
            card: cardNum,
            total: totalNum
        };`;

const replaceRev = `    async saveRevenue(payload, buttonEl = null) {
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
        };`;

if (code.includes(targetRev)) {
    code = code.replace(targetRev, replaceRev);
    console.log('1. saveRevenue in data-service.js updated');
} else {
    console.log('1. saveRevenue mismatch');
}

// 2. Expense
const targetExp = `    async saveExpense(payload, buttonEl = null) {
        const isEdit = !!payload.id && !payload._isNew;
        const recordId = payload.id || this.generateId('exp');
        const amountNum = Math.round((parseFloat(payload.amount) || 0) * 100) / 100;

        const completePayload = {
            ...payload,
            id: recordId,
            amount: amountNum
        };`;

const replaceExp = `    async saveExpense(payload, buttonEl = null) {
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
        };`;

if (code.includes(targetExp)) {
    code = code.replace(targetExp, replaceExp);
    console.log('2. saveExpense in data-service.js updated');
} else {
    console.log('2. saveExpense mismatch');
}

// 3. Product
const targetProd = `    async saveProduct(payload, buttonEl = null) {
        const isEdit = !!payload.id && !payload._isNew;
        const recordId = payload.id || this.generateId('prod');

        const costNum = Math.round((parseFloat(payload.costPrice) || 0) * 100) / 100;
        const sellNum = Math.round((parseFloat(payload.sellPrice) || 0) * 100) / 100;

        const completePayload = {
            ...payload,
            id: recordId,
            costPrice: costNum,
            sellPrice: sellNum,
            stockQuantity: parseInt(payload.stockQuantity) || 0,
            minStock: parseInt(payload.minStock) || 0
        };`;

const replaceProd = `    async saveProduct(payload, buttonEl = null) {
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
        };`;

if (code.includes(targetProd)) {
    code = code.replace(targetProd, replaceProd);
    console.log('3. saveProduct in data-service.js updated');
} else {
    console.log('3. saveProduct mismatch');
}

// 4. Store
const targetStore = `    async saveStore(payload, buttonEl = null) {
        const isEdit = !!payload.id && !payload._isNew;
        const recordId = payload.id || this.generateId('store');
        const targetRev = Math.round((parseFloat(payload.targetRevenue) || 0) * 100) / 100;

        const completePayload = {
            ...payload,
            id: recordId,
            targetRevenue: targetRev,
            employeeCount: parseInt(payload.employeeCount) || 2
        };`;

const replaceStore = `    async saveStore(payload, buttonEl = null) {
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
        };`;

if (code.includes(targetStore)) {
    code = code.replace(targetStore, replaceStore);
    console.log('4. saveStore in data-service.js updated');
} else {
    console.log('4. saveStore mismatch');
}

fs.writeFileSync('data-service.js', code, 'utf8');
console.log('data-service.js updated cleanly!');
