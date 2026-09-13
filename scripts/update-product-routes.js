const fs = require('fs');
let code = fs.readFileSync('server/routes/api.js', 'utf8');

const prodStart = code.indexOf("router.put('/products/:id', requireAuth, (req, res) => {");
const prodEnd = code.indexOf("router.delete('/products/:id', requireAuth, requireRole(['admin', 'manager']), (req, res) => {");

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
        updatedBy: req.user.username,
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
    fs.writeFileSync('server/routes/api.js', code, 'utf8');
    console.log('Products PUT/PATCH updated cleanly!');
} else {
    console.error('Marker still not found', { prodStart, prodEnd });
}
