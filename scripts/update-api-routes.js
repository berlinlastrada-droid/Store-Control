const fs = require('fs');
let code = fs.readFileSync('server/routes/api.js', 'utf8');

// 1. Revenues PUT/PATCH
const targetRevPut = `router.put('/revenues/:id', requireAuth, (req, res) => {
    const existing = db.prepare('SELECT * FROM revenues WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Umsatzdatensatz nicht gefunden.' });

    const { storeId, date, cash, card, note, clientVersion } = req.body;

    // Conflict Check
    if (clientVersion && clientVersion < existing.version) {
        return res.status(409).json({
            error: 'Konflikt: Dieser Umsatz wurde in der Zwischenzeit auf einem anderen Gerät geändert.',
            serverRecord: {
                id: existing.id,
                storeId: existing.store_id,
                date: existing.date,
                cash: existing.cash_cents / 100,
                card: existing.card_cents / 100,
                total: existing.total_cents / 100,
                note: existing.note,
                version: existing.version,
                updatedAt: existing.updated_at
            }
        });
    }

    const cashCents = cash !== undefined ? Math.round(parseFloat(cash) * 100) : existing.cash_cents;
    const cardCents = card !== undefined ? Math.round(parseFloat(card) * 100) : existing.card_cents;
    const totalCents = cashCents + cardCents;
    const newVersion = existing.version + 1;
    const now = new Date().toISOString();

    db.prepare(\`
        UPDATE revenues SET
            store_id = COALESCE(?, store_id),
            date = COALESCE(?, date),
            cash_cents = ?,
            card_cents = ?,
            total_cents = ?,
            note = COALESCE(?, note),
            updated_by = ?,
            updated_at = ?,
            version = ?
        WHERE id = ?
    \`).run(storeId, date, cashCents, cardCents, totalCents, note, req.user.username, now, newVersion, req.params.id);

    const updatedRecord = {
        id: req.params.id,
        storeId: storeId || existing.store_id,
        date: date || existing.date,
        cash: cashCents / 100,
        card: cardCents / 100,
        total: totalCents / 100,
        note: note !== undefined ? note : existing.note,
        updatedBy: req.user.username,
        updatedAt: now,
        version: newVersion
    };

    logAudit('revenue', req.params.id, 'UPDATE', req.user.username, existing, updatedRecord, req.ip);
    broadcastEvent('REVENUE_CHANGED', { action: 'UPDATE', record: updatedRecord });

    res.json({ success: true, record: updatedRecord });
});`;

// Because of umlauts in code, find start and end
const revStart = code.indexOf("router.put('/revenues/:id', requireAuth, (req, res) => {");
const revEnd = code.indexOf("router.delete('/revenues/:id', requireAuth, (req, res) => {");

if (revStart !== -1 && revEnd !== -1) {
    const newRevHandler = `const updateRevenueHandler = (req, res) => {
    const existing = db.prepare('SELECT * FROM revenues WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Umsatzdatensatz nicht gefunden.' });

    const { storeId, date, cash, card, note, clientVersion } = req.body;

    // Conflict Check
    if (clientVersion && clientVersion < existing.version) {
        return res.status(409).json({
            error: 'Konflikt: Dieser Umsatz wurde in der Zwischenzeit auf einem anderen Gerät geändert.',
            serverRecord: {
                id: existing.id,
                storeId: existing.store_id,
                date: existing.date,
                cash: existing.cash_cents / 100,
                card: existing.card_cents / 100,
                total: existing.total_cents / 100,
                note: existing.note,
                version: existing.version,
                updatedAt: existing.updated_at
            }
        });
    }

    const finalStoreId = (storeId && String(storeId).trim()) ? String(storeId).trim() : existing.store_id;
    const finalDate = (date && String(date).trim()) ? String(date).trim() : existing.date;
    const cashCents = (cash !== undefined && cash !== null && cash !== '') ? Math.round(parseFloat(cash) * 100) : existing.cash_cents;
    const cardCents = (card !== undefined && card !== null && card !== '') ? Math.round(parseFloat(card) * 100) : existing.card_cents;
    const totalCents = cashCents + cardCents;
    const finalNote = note !== undefined ? (note === null ? '' : String(note).trim()) : (existing.note || '');
    const newVersion = existing.version + 1;
    const now = new Date().toISOString();

    db.prepare(\`
        UPDATE revenues SET
            store_id = ?,
            date = ?,
            cash_cents = ?,
            card_cents = ?,
            total_cents = ?,
            note = ?,
            updated_by = ?,
            updated_at = ?,
            version = ?
        WHERE id = ?
    \`).run(finalStoreId, finalDate, cashCents, cardCents, totalCents, finalNote, req.user.username, now, newVersion, req.params.id);

    const updatedRecord = {
        id: req.params.id,
        storeId: finalStoreId,
        date: finalDate,
        cash: cashCents / 100,
        card: cardCents / 100,
        total: totalCents / 100,
        note: finalNote,
        updatedBy: req.user.username,
        updatedAt: now,
        version: newVersion
    };

    logAudit('revenue', req.params.id, 'UPDATE', req.user.username, existing, updatedRecord, req.ip);
    broadcastEvent('REVENUE_CHANGED', { action: 'UPDATE', record: updatedRecord });

    res.json({ success: true, record: updatedRecord });
};

router.put('/revenues/:id', requireAuth, updateRevenueHandler);
router.patch('/revenues/:id', requireAuth, updateRevenueHandler);

`;

    code = code.slice(0, revStart) + newRevHandler + code.slice(revEnd);
    console.log('1. Revenues PUT/PATCH updated');
} else {
    console.error('Revenues handler markers not found!');
}

// 2. Expenses PUT/PATCH
const expStart = code.indexOf("router.put('/expenses/:id', requireAuth, (req, res) => {");
const expEnd = code.indexOf("router.delete('/expenses/:id', requireAuth, (req, res) => {");

if (expStart !== -1 && expEnd !== -1) {
    const newExpHandler = `const updateExpenseHandler = (req, res) => {
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Kostenposition nicht gefunden.' });

    const { storeId, category, date, amount, title, recurrence, clientVersion } = req.body;
    if (clientVersion && clientVersion < existing.version) {
        return res.status(409).json({ error: 'Konflikt: Ausgabeneintrag wurde anderweitig geändert.', serverRecord: existing });
    }

    const finalStoreId = (storeId && String(storeId).trim()) ? String(storeId).trim() : existing.store_id;
    const finalCategory = (category && String(category).trim()) ? mapExpenseCategory(category) : existing.category;
    const finalDate = (date && String(date).trim()) ? String(date).trim() : existing.date;
    const amountCents = (amount !== undefined && amount !== null && amount !== '') ? Math.round(parseFloat(amount) * 100) : existing.amount_cents;
    const finalTitle = title !== undefined ? (title === null ? '' : String(title).trim()) : existing.title;
    const finalRecurrence = (recurrence && String(recurrence).trim()) ? String(recurrence).trim() : existing.recurrence;
    const newVersion = existing.version + 1;
    const now = new Date().toISOString();

    db.prepare(\`
        UPDATE expenses SET
            store_id = ?,
            category = ?,
            date = ?,
            amount_cents = ?,
            title = ?,
            recurrence = ?,
            updated_by = ?,
            updated_at = ?,
            version = ?
        WHERE id = ?
    \`).run(finalStoreId, finalCategory, finalDate, amountCents, finalTitle, finalRecurrence, req.user.username, now, newVersion, req.params.id);

    const updated = {
        id: req.params.id,
        storeId: finalStoreId,
        category: finalCategory,
        date: finalDate,
        amount: amountCents / 100,
        title: finalTitle,
        recurrence: finalRecurrence,
        updatedBy: req.user.username,
        updatedAt: now,
        version: newVersion
    };

    logAudit('expense', req.params.id, 'UPDATE', req.user.username, existing, updated, req.ip);
    broadcastEvent('EXPENSE_CHANGED', { action: 'UPDATE', record: updated });

    res.json({ success: true, record: updated });
};

router.put('/expenses/:id', requireAuth, updateExpenseHandler);
router.patch('/expenses/:id', requireAuth, updateExpenseHandler);

`;

    code = code.slice(0, expStart) + newExpHandler + code.slice(expEnd);
    console.log('2. Expenses PUT/PATCH updated');
} else {
    console.error('Expenses handler markers not found!');
}

// 3. Products PUT/PATCH
const prodStart = code.indexOf("router.put('/products/:id', requireAuth, (req, res) => {");
const prodEnd = code.indexOf("router.delete('/products/:id', requireAuth, (req, res) => {");

if (prodStart !== -1 && prodEnd !== -1) {
    const newProdHandler = `const updateProductHandler = (req, res) => {
    const existing = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Artikel nicht gefunden.' });

    const { storeId, name, barcode, sku, category, costPrice, sellPrice, stockQuantity, minStock, unit, clientVersion } = req.body;
    if (clientVersion && clientVersion < existing.version) {
        return res.status(409).json({ error: 'Konflikt: Artikeldaten wurden anderweitig geändert.', serverRecord: existing });
    }

    const finalStoreId = storeId !== undefined ? storeId : existing.store_id;
    const finalName = (name && String(name).trim()) ? String(name).trim() : existing.name;
    const finalBarcode = barcode !== undefined ? String(barcode).trim() : (existing.barcode || '');
    const finalSku = sku !== undefined ? String(sku).trim() : (existing.sku || '');
    const finalCategory = category !== undefined ? String(category).trim() : existing.category;
    const costCents = (costPrice !== undefined && costPrice !== null && costPrice !== '') ? Math.round(parseFloat(costPrice) * 100) : existing.cost_price_cents;
    const sellCents = (sellPrice !== undefined && sellPrice !== null && sellPrice !== '') ? Math.round(parseFloat(sellPrice) * 100) : existing.sell_price_cents;
    const finalStock = (stockQuantity !== undefined && stockQuantity !== null && stockQuantity !== '') ? parseInt(stockQuantity) : existing.stock_quantity;
    const finalMinStock = (minStock !== undefined && minStock !== null && minStock !== '') ? parseInt(minStock) : existing.min_stock;
    const finalUnit = unit !== undefined ? unit : existing.unit;
    const now = new Date().toISOString();
    const newVersion = existing.version + 1;

    db.prepare(\`
        UPDATE products SET
            store_id = ?,
            name = ?,
            barcode = ?,
            sku = ?,
            category = ?,
            cost_price_cents = ?,
            sell_price_cents = ?,
            stock_quantity = ?,
            min_stock = ?,
            unit = ?,
            updated_at = ?,
            version = ?
        WHERE id = ?
    \`).run(
        finalStoreId, finalName, finalBarcode, finalSku, finalCategory, costCents, sellCents,
        finalStock, finalMinStock, finalUnit, now, newVersion, req.params.id
    );

    const updated = {
        id: req.params.id,
        storeId: finalStoreId,
        name: finalName,
        barcode: finalBarcode,
        sku: finalSku,
        category: finalCategory,
        costPrice: costCents / 100,
        sellPrice: sellCents / 100,
        stockQuantity: finalStock,
        minStock: finalMinStock,
        unit: finalUnit,
        updatedAt: now,
        version: newVersion
    };

    logAudit('product', req.params.id, 'UPDATE', req.user.username, existing, updated, req.ip);
    broadcastEvent('PRODUCT_CHANGED', { action: 'UPDATE', product: updated });

    res.json({ success: true, product: updated });
};

router.put('/products/:id', requireAuth, updateProductHandler);
router.patch('/products/:id', requireAuth, updateProductHandler);

`;

    code = code.slice(0, prodStart) + newProdHandler + code.slice(prodEnd);
    console.log('3. Products PUT/PATCH updated');
} else {
    console.error('Products handler markers not found!');
}

// 4. Stores PUT/PATCH
const storeStart = code.indexOf("router.put('/stores/:id', requireAuth, requireRole(['admin', 'manager']), (req, res) => {");
const storeEnd = code.indexOf("router.delete('/stores/:id', requireAuth, requireRole(['admin']), (req, res) => {");

if (storeStart !== -1 && storeEnd !== -1) {
    const newStoreHandler = `const updateStoreHandler = (req, res) => {
    const store = db.prepare('SELECT * FROM stores WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!store) return res.status(404).json({ error: 'Filiale nicht gefunden.' });

    const { name, address, manager, phone, color, employeeCount, targetRevenue, clientVersion } = req.body;
    if (clientVersion && clientVersion < store.version) {
        return res.status(409).json({ error: 'Konflikt: Filiale wurde auf einem anderen Gerät geändert.', serverData: store });
    }

    const finalName = (name && String(name).trim()) ? String(name).trim() : store.name;
    const finalAddress = address !== undefined ? String(address).trim() : (store.address || '');
    const finalManager = manager !== undefined ? String(manager).trim() : (store.manager || '');
    const finalPhone = phone !== undefined ? String(phone).trim() : (store.phone || '');
    const finalColor = color !== undefined ? String(color).trim() : store.color;
    const finalEmpCount = (employeeCount !== undefined && employeeCount !== null && employeeCount !== '') ? parseInt(employeeCount) : store.employee_count;
    const targetCents = (targetRevenue !== undefined && targetRevenue !== null && targetRevenue !== '') ? Math.round(parseFloat(targetRevenue) * 100) : store.target_revenue_cents;
    const now = new Date().toISOString();
    const newVersion = store.version + 1;

    db.prepare(\`
        UPDATE stores SET
            name = ?,
            address = ?,
            manager = ?,
            phone = ?,
            color = ?,
            employee_count = ?,
            target_revenue_cents = ?,
            updated_at = ?,
            version = ?
        WHERE id = ?
    \`).run(finalName, finalAddress, finalManager, finalPhone, finalColor, finalEmpCount, targetCents, now, newVersion, req.params.id);

    const updatedStore = {
        id: req.params.id,
        name: finalName,
        address: finalAddress,
        manager: finalManager,
        phone: finalPhone,
        color: finalColor,
        employeeCount: finalEmpCount,
        targetRevenue: targetCents / 100,
        updatedAt: now,
        version: newVersion
    };

    logAudit('store', req.params.id, 'UPDATE', req.user.username, store, req.body, req.ip);
    broadcastEvent('STORE_CHANGED', { action: 'UPDATE', id: req.params.id, store: updatedStore });

    res.json({ success: true, store: updatedStore, version: newVersion });
};

router.put('/stores/:id', requireAuth, requireRole(['admin', 'manager']), updateStoreHandler);
router.patch('/stores/:id', requireAuth, requireRole(['admin', 'manager']), updateStoreHandler);

`;

    code = code.slice(0, storeStart) + newStoreHandler + code.slice(storeEnd);
    console.log('4. Stores PUT/PATCH updated');
} else {
    console.error('Stores handler markers not found!');
}

fs.writeFileSync('server/routes/api.js', code, 'utf8');
console.log('ALL server/routes/api.js routes updated cleanly!');
