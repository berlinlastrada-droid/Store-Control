const express = require('express');
const os = require('os');
const qrcode = require('qrcode');
const { db, logAudit, getAppSetting, setAppSetting } = require('../db');
const { 
    authenticateUser, 
    generateToken, 
    getPublicUser, 
    requireAuth, 
    requireRole 
} = require('../auth');

const router = express.Router();

// =============================================================================
// SERVER-SENT EVENTS (SSE) BROADCAST ENGINE
// =============================================================================
const sseClients = new Set();

function broadcastEvent(eventType, payload) {
    const data = JSON.stringify({ type: eventType, payload, timestamp: new Date().toISOString() });
    for (const client of sseClients) {
        try {
            client.res.write(`data: ${data}\n\n`);
        } catch (e) {
            sseClients.delete(client);
        }
    }
}

// SSE Connection Endpoint
router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const client = { id: Date.now() + Math.random(), res };
    sseClients.add(client);

    // Send initial ping
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', clientId: client.id })}\n\n`);

    req.on('close', () => {
        sseClients.delete(client);
    });
});

// =============================================================================
// PUBLIC HTTPS URL VALIDATION & RESOLUTION
// =============================================================================
function isValidPublicHttpsUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
        const u = new URL(urlStr.trim());
        if (u.protocol !== 'https:') return false;
        const h = u.hostname.toLowerCase();
        // Disallow localhost, IPv4 loopback, IPv6 loopback, unspecified
        if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return false;
        // Disallow private ranges: 10.0.0.0/8, 192.168.0.0/16
        if (h.startsWith('10.') || h.startsWith('192.168.')) return false;
        // Disallow 172.16.0.0 - 172.31.255.255
        const match172 = h.match(/^172\.(\d+)\./);
        if (match172) {
            const octet = parseInt(match172[1], 10);
            if (octet >= 16 && octet <= 31) return false;
        }
        // Disallow local network suffixes
        if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return false;
        // Must contain at least one dot in domain name (e.g. example.com, myapp.onrender.com)
        if (!h.includes('.')) return false;
        return true;
    } catch {
        return false;
    }
}

function resolvePublicHttpsUrl(req) {
    // 1. Environment variables (Render, Railway, custom)
    const envUrl = process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || process.env.RAILWAY_STATIC_URL;
    if (envUrl) {
        const formatted = envUrl.startsWith('http') ? envUrl : `https://${envUrl}`;
        if (isValidPublicHttpsUrl(formatted)) {
            return { url: formatted.replace(/\/+$/, ''), source: 'env' };
        }
    }

    // 2. Saved setting in database
    const dbUrl = getAppSetting('app_public_url');
    if (dbUrl && isValidPublicHttpsUrl(dbUrl)) {
        return { url: dbUrl.trim().replace(/\/+$/, ''), source: 'db' };
    }

    // 3. Request headers if coming via HTTPS reverse proxy
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : null);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (proto === 'https' && host) {
        const headerUrl = `https://${host}`;
        if (isValidPublicHttpsUrl(headerUrl)) {
            return { url: headerUrl.replace(/\/+$/, ''), source: 'header' };
        }
    }

    return { url: null, source: null };
}

function mapExpenseCategory(cat) {
    if (!cat) return 'other';
    const c = String(cat).toLowerCase().trim();
    if (['staff', 'personal', 'gehalt', 'lohn'].includes(c)) return 'staff';
    if (['rent', 'miete', 'nebenkosten', 'pacht'].includes(c)) return 'rent';
    if (['goods', 'waren', 'wareneinkauf', 'material'].includes(c)) return 'goods';
    if (['other', 'sonstiges', 'reinigung', 'marketing', 'it'].includes(c)) return 'other';
    return ['staff', 'rent', 'goods', 'other'].includes(c) ? c : 'other';
}

// =============================================================================
// NETWORK INFO & SMARTPHONE QR-CODE (PUBLIC HTTPS ONLY)
// =============================================================================
router.get('/network-info', async (req, res) => {
    try {
        const { url: publicUrl, source } = resolvePublicHttpsUrl(req);
        const isConfigured = !!publicUrl;

        let qrCode = null;
        if (isConfigured) {
            qrCode = await qrcode.toDataURL(publicUrl, {
                errorCorrectionLevel: 'M',
                margin: 2,
                width: 280,
                color: {
                    dark: '#0f172a',
                    light: '#ffffff'
                }
            });
        }

        res.json({
            isConfigured,
            publicUrl,
            qrCode,
            source,
            message: isConfigured 
                ? 'Öffentliche HTTPS-Adresse aktiv.' 
                : 'Die öffentliche App-Adresse ist noch nicht konfiguriert.'
        });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Abrufen der Smartphone-Verbindungsdaten', details: err.message });
    }
});

// Configure or update Public HTTPS App URL
router.post('/settings/public-url', requireAuth, async (req, res) => {
    try {
        const { publicUrl } = req.body;
        if (!publicUrl || typeof publicUrl !== 'string') {
            return res.status(400).json({ error: 'Bitte geben Sie eine gültige öffentliche URL an.' });
        }

        const trimmed = publicUrl.trim().replace(/\/+$/, '');
        if (!isValidPublicHttpsUrl(trimmed)) {
            return res.status(400).json({ 
                error: 'Ungültige Adresse. Es muss eine öffentliche HTTPS-URL sein (z. B. https://manager.meine-domain.de oder https://storecontrol.onrender.com). Lokale Adressen wie localhost oder 192.168.x.x sind nicht zulässig.' 
            });
        }

        setAppSetting('app_public_url', trimmed);
        logAudit('setting', 'app_public_url', 'UPDATE_PUBLIC_URL', req.user ? req.user.username : 'system', null, { publicUrl: trimmed }, req.ip);

        const qrCode = await qrcode.toDataURL(trimmed, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 280,
            color: {
                dark: '#0f172a',
                light: '#ffffff'
            }
        });

        res.json({
            success: true,
            publicUrl: trimmed,
            qrCode,
            message: 'Öffentliche HTTPS-Adresse erfolgreich gespeichert.'
        });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Speichern der URL', details: err.message });
    }
});

// =============================================================================
// AUTHENTICATION & USERS
// =============================================================================
router.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
    }

    const user = authenticateUser(username, password);
    if (!user) {
        return res.status(401).json({ error: 'Ungültige Anmeldedaten.' });
    }

    const token = generateToken(user);
    const publicUser = getPublicUser(user);

    logAudit('user', user.id, 'LOGIN', user.username, null, { username: user.username }, req.ip);

    res.json({
        success: true,
        token,
        user: publicUser
    });
});

router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

router.post('/auth/change-password', requireAuth, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: 'Das neue Passwort muss mindestens 6 Zeichen lang sein.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const bcrypt = require('bcryptjs');
    if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
        return res.status(400).json({ error: 'Aktuelles Passwort ist falsch.' });
    }

    const newHash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(newHash, new Date().toISOString(), req.user.id);

    logAudit('user', req.user.id, 'PASSWORD_CHANGE', req.user.username, null, null, req.ip);
    res.json({ success: true, message: 'Passwort erfolgreich geändert.' });
});

router.get('/auth/users', requireAuth, requireRole(['admin']), (req, res) => {
    const users = db.prepare('SELECT id, username, display_name, role, store_id, is_active, created_at, updated_at FROM users').all();
    res.json(users);
});

// =============================================================================
// STORES
// =============================================================================
router.get('/stores', requireAuth, (req, res) => {
    const stores = db.prepare('SELECT * FROM stores WHERE is_deleted = 0 ORDER BY created_at ASC').all();
    const formatted = stores.map(s => ({
        ...s,
        targetRevenue: s.target_revenue_cents / 100,
        employeeCount: s.employee_count
    }));
    res.json(formatted);
});

router.post('/stores', requireAuth, requireRole(['admin', 'manager']), (req, res) => {
    const { name, address, manager, phone, color, employeeCount, targetRevenue } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Filialname ist erforderlich.' });
    }

    if (req.body.id) {
        const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.body.id);
        if (existing) {
            return res.status(200).json({ id: existing.id, name: existing.name, success: true, idempotent: true });
        }
    }

    const id = req.body.id || `store_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const targetCents = Math.round((parseFloat(targetRevenue) || 0) * 100);
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO stores (id, name, address, manager, phone, color, employee_count, target_revenue_cents, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, name.trim(), address || '', manager || '', phone || '', color || 'emerald', parseInt(employeeCount) || 2, targetCents, now, now);

    logAudit('store', id, 'CREATE', req.user.username, null, req.body, req.ip);
    broadcastEvent('STORE_CHANGED', { action: 'CREATE', id });

    res.status(201).json({ id, name, success: true });
});

router.put('/stores/:id', requireAuth, requireRole(['admin', 'manager']), (req, res) => {
    const store = db.prepare('SELECT * FROM stores WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!store) return res.status(404).json({ error: 'Filiale nicht gefunden.' });

    const { name, address, manager, phone, color, employeeCount, targetRevenue, clientVersion } = req.body;
    if (clientVersion && clientVersion < store.version) {
        return res.status(409).json({ error: 'Konflikt: Filiale wurde auf einem anderen Gerät geändert.', serverData: store });
    }

    const targetCents = targetRevenue !== undefined ? Math.round(parseFloat(targetRevenue) * 100) : store.target_revenue_cents;
    const now = new Date().toISOString();
    const newVersion = store.version + 1;

    db.prepare(`
        UPDATE stores SET
            name = COALESCE(?, name),
            address = COALESCE(?, address),
            manager = COALESCE(?, manager),
            phone = COALESCE(?, phone),
            color = COALESCE(?, color),
            employee_count = COALESCE(?, employee_count),
            target_revenue_cents = ?,
            updated_at = ?,
            version = ?
        WHERE id = ?
    `).run(name, address, manager, phone, color, employeeCount, targetCents, now, newVersion, req.params.id);

    logAudit('store', req.params.id, 'UPDATE', req.user.username, store, req.body, req.ip);
    broadcastEvent('STORE_CHANGED', { action: 'UPDATE', id: req.params.id });

    res.json({ success: true, version: newVersion });
});

router.delete('/stores/:id', requireAuth, requireRole(['admin']), (req, res) => {
    const store = db.prepare('SELECT * FROM stores WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!store) return res.status(404).json({ error: 'Filiale nicht gefunden.' });

    const now = new Date().toISOString();
    db.prepare('UPDATE stores SET is_deleted = 1, updated_at = ?, version = version + 1 WHERE id = ?').run(now, req.params.id);

    logAudit('store', req.params.id, 'DELETE', req.user.username, store, null, req.ip);
    broadcastEvent('STORE_CHANGED', { action: 'DELETE', id: req.params.id });

    res.json({ success: true });
});

// =============================================================================
// REVENUES (Tagesumsätze)
// =============================================================================
router.get('/revenues', requireAuth, (req, res) => {
    const { month, storeId, startDate, endDate } = req.query;
    let query = 'SELECT * FROM revenues WHERE is_deleted = 0';
    const params = [];

    if (storeId && storeId !== 'ALL') {
        query += ' AND store_id = ?';
        params.push(storeId);
    }
    if (month) {
        query += ' AND date LIKE ?';
        params.push(`${month}%`);
    } else if (startDate && endDate) {
        query += ' AND date BETWEEN ? AND ?';
        params.push(startDate, endDate);
    }

    query += ' ORDER BY date DESC, created_at DESC';
    const rows = db.prepare(query).all(...params);

    const formatted = rows.map(r => ({
        id: r.id,
        storeId: r.store_id,
        date: r.date,
        cash: r.cash_cents / 100,
        card: r.card_cents / 100,
        total: r.total_cents / 100,
        note: r.note || '',
        createdBy: r.created_by,
        updatedBy: r.updated_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        version: r.version
    }));

    res.json(formatted);
});

router.post('/revenues', requireAuth, (req, res) => {
    const { storeId, date, cash, card, note } = req.body;
    if (!storeId || !date) {
        return res.status(400).json({ error: 'Filiale und Datum erforderlich.' });
    }

    if (req.body.id) {
        const existing = db.prepare('SELECT * FROM revenues WHERE id = ?').get(req.body.id);
        if (existing) {
            const record = {
                id: existing.id, storeId: existing.store_id, date: existing.date,
                cash: existing.cash_cents / 100, card: existing.card_cents / 100, total: existing.total_cents / 100,
                note: existing.note || '', createdBy: existing.created_by, createdAt: existing.created_at,
                updatedAt: existing.updated_at, version: existing.version
            };
            return res.status(200).json({ success: true, record, idempotent: true });
        }
    }

    const cashCents = Math.round((parseFloat(cash) || 0) * 100);
    const cardCents = Math.round((parseFloat(card) || 0) * 100);
    const totalCents = cashCents + cardCents;

    const id = req.body.id || `rev_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO revenues (id, store_id, date, cash_cents, card_cents, total_cents, note, created_by, updated_by, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, storeId, date, cashCents, cardCents, totalCents, note || '', req.user.username, req.user.username, now, now);

    const record = {
        id, storeId, date, cash: cashCents / 100, card: cardCents / 100, total: totalCents / 100,
        note: note || '', createdBy: req.user.username, createdAt: now, updatedAt: now, version: 1
    };

    logAudit('revenue', id, 'CREATE', req.user.username, null, record, req.ip);
    broadcastEvent('REVENUE_CHANGED', { action: 'CREATE', record });

    res.status(201).json({ success: true, record });
});

router.put('/revenues/:id', requireAuth, (req, res) => {
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

    db.prepare(`
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
    `).run(storeId, date, cashCents, cardCents, totalCents, note, req.user.username, now, newVersion, req.params.id);

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
});

router.delete('/revenues/:id', requireAuth, (req, res) => {
    const existing = db.prepare('SELECT * FROM revenues WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Umsatz nicht gefunden.' });

    const now = new Date().toISOString();
    db.prepare('UPDATE revenues SET is_deleted = 1, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(req.user.username, now, req.params.id);

    logAudit('revenue', req.params.id, 'DELETE', req.user.username, existing, null, req.ip);
    broadcastEvent('REVENUE_CHANGED', { action: 'DELETE', id: req.params.id });

    res.json({ success: true });
});

// =============================================================================
// EXPENSES (Kosten & Ausgaben)
// =============================================================================
router.get('/expenses', requireAuth, (req, res) => {
    const { month, storeId, category } = req.query;
    let query = 'SELECT * FROM expenses WHERE is_deleted = 0';
    const params = [];

    if (storeId && storeId !== 'ALL') {
        query += ' AND store_id = ?';
        params.push(storeId);
    }
    if (month) {
        query += ' AND date LIKE ?';
        params.push(`${month}%`);
    }
    if (category) {
        query += ' AND category = ?';
        params.push(category);
    }

    query += ' ORDER BY date DESC, created_at DESC';
    const rows = db.prepare(query).all(...params);

    const formatted = rows.map(e => ({
        id: e.id,
        storeId: e.store_id,
        category: e.category,
        date: e.date,
        amount: e.amount_cents / 100,
        title: e.title,
        recurrence: e.recurrence,
        createdBy: e.created_by,
        updatedBy: e.updated_by,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
        version: e.version
    }));

    res.json(formatted);
});

router.post('/expenses', requireAuth, (req, res) => {
    const { storeId, category, date, amount, title, recurrence } = req.body;
    if (!storeId || !category || !date || !amount || !title) {
        return res.status(400).json({ error: 'Alle Pflichtfelder für Ausgaben müssen ausgefüllt sein.' });
    }

    if (req.body.id) {
        const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.body.id);
        if (existing) {
            const record = {
                id: existing.id, storeId: existing.store_id, category: existing.category, date: existing.date,
                amount: existing.amount_cents / 100, title: existing.title, recurrence: existing.recurrence,
                createdBy: existing.created_by, createdAt: existing.created_at, updatedAt: existing.updated_at, version: existing.version
            };
            return res.status(200).json({ success: true, record, idempotent: true });
        }
    }

    const amountCents = Math.round(parseFloat(amount) * 100);
    const id = req.body.id || `exp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const now = new Date().toISOString();
    const safeCategory = mapExpenseCategory(category);

    db.prepare(`
        INSERT INTO expenses (id, store_id, category, date, amount_cents, title, recurrence, created_by, updated_by, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, storeId, safeCategory, date, amountCents, title.trim(), recurrence || 'single', req.user.username, req.user.username, now, now);

    const record = {
        id, storeId, category: safeCategory, date, amount: amountCents / 100, title: title.trim(),
        recurrence: recurrence || 'single', createdBy: req.user.username, createdAt: now, updatedAt: now, version: 1
    };

    logAudit('expense', id, 'CREATE', req.user.username, null, record, req.ip);
    broadcastEvent('EXPENSE_CHANGED', { action: 'CREATE', record });

    res.status(201).json({ success: true, record });
});

router.put('/expenses/:id', requireAuth, (req, res) => {
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Kostenposition nicht gefunden.' });

    const { storeId, category, date, amount, title, recurrence, clientVersion } = req.body;
    if (clientVersion && clientVersion < existing.version) {
        return res.status(409).json({ error: 'Konflikt: Ausgabeneintrag wurde anderweitig geändert.', serverRecord: existing });
    }

    const amountCents = amount !== undefined ? Math.round(parseFloat(amount) * 100) : existing.amount_cents;
    const newVersion = existing.version + 1;
    const now = new Date().toISOString();

    db.prepare(`
        UPDATE expenses SET
            store_id = COALESCE(?, store_id),
            category = COALESCE(?, category),
            date = COALESCE(?, date),
            amount_cents = ?,
            title = COALESCE(?, title),
            recurrence = COALESCE(?, recurrence),
            updated_by = ?,
            updated_at = ?,
            version = ?
        WHERE id = ?
    `).run(storeId, category, date, amountCents, title, recurrence, req.user.username, now, newVersion, req.params.id);

    const updated = {
        id: req.params.id,
        storeId: storeId || existing.store_id,
        category: category || existing.category,
        date: date || existing.date,
        amount: amountCents / 100,
        title: title || existing.title,
        recurrence: recurrence || existing.recurrence,
        updatedBy: req.user.username,
        updatedAt: now,
        version: newVersion
    };

    logAudit('expense', req.params.id, 'UPDATE', req.user.username, existing, updated, req.ip);
    broadcastEvent('EXPENSE_CHANGED', { action: 'UPDATE', record: updated });

    res.json({ success: true, record: updated });
});

router.delete('/expenses/:id', requireAuth, (req, res) => {
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Ausgabe nicht gefunden.' });

    const now = new Date().toISOString();
    db.prepare('UPDATE expenses SET is_deleted = 1, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(req.user.username, now, req.params.id);

    logAudit('expense', req.params.id, 'DELETE', req.user.username, existing, null, req.ip);
    broadcastEvent('EXPENSE_CHANGED', { action: 'DELETE', id: req.params.id });

    res.json({ success: true });
});

// =============================================================================
// PRODUCTS (Artikel, Barcodes & Lagerverwaltung)
// =============================================================================
router.get('/products', requireAuth, (req, res) => {
    const { storeId, q, barcode } = req.query;
    let query = 'SELECT * FROM products WHERE is_deleted = 0';
    const params = [];

    if (storeId && storeId !== 'ALL') {
        query += ' AND (store_id = ? OR store_id IS NULL)';
        params.push(storeId);
    }
    if (barcode) {
        query += ' AND barcode = ?';
        params.push(barcode);
    }
    if (q) {
        query += ' AND (name LIKE ? OR barcode LIKE ? OR sku LIKE ?)';
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    query += ' ORDER BY name ASC';
    const products = db.prepare(query).all(...params);

    const formatted = products.map(p => ({
        id: p.id,
        storeId: p.store_id,
        name: p.name,
        barcode: p.barcode || '',
        sku: p.sku || '',
        category: p.category || 'Allgemein',
        costPrice: p.cost_price_cents / 100,
        sellPrice: p.sell_price_cents / 100,
        cost_price: p.cost_price_cents / 100,
        sell_price: p.sell_price_cents / 100,
        stockQuantity: p.stock_quantity,
        stock_quantity: p.stock_quantity,
        minStock: p.min_stock,
        unit: p.unit || 'Stück',
        size: p.size || '',
        color: p.color || '',
        season: p.season || '',
        manufacturer: p.manufacturer || '',
        supplier: p.supplier || '',
        description: p.description || '',
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        version: p.version
    }));

    res.json(formatted);
});

router.post('/products', requireAuth, requireRole(['admin', 'manager']), (req, res) => {
    const { storeId, name, barcode, sku, category, costPrice, sellPrice, stockQuantity, minStock, unit } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Artikelname ist erforderlich.' });
    }

    if (req.body.id) {
        const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.body.id);
        if (existing) {
            const product = {
                id: existing.id, storeId: existing.store_id, name: existing.name,
                barcode: existing.barcode || '', sku: existing.sku || '', category: existing.category || 'Allgemein',
                costPrice: existing.cost_price_cents / 100, sellPrice: existing.sell_price_cents / 100,
                stockQuantity: existing.stock_quantity, minStock: existing.min_stock, unit: existing.unit || 'Stück',
                createdAt: existing.created_at, updatedAt: existing.updated_at, version: existing.version
            };
            return res.status(200).json({ success: true, product, idempotent: true });
        }
    }

    const id = req.body.id || `prod_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const costCents = Math.round((parseFloat(costPrice) || 0) * 100);
    const sellCents = Math.round((parseFloat(sellPrice) || 0) * 100);
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO products (id, store_id, name, barcode, sku, category, cost_price_cents, sell_price_cents, stock_quantity, min_stock, unit, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
        id,
        storeId || null,
        name.trim(),
        barcode || null,
        sku || null,
        category || 'Allgemein',
        costCents,
        sellCents,
        parseInt(stockQuantity) || 0,
        parseInt(minStock) || 0,
        unit || 'Stück',
        now,
        now
    );

    const product = {
        id, storeId: storeId || null, name: name.trim(), barcode: barcode || '', sku: sku || '',
        category: category || 'Allgemein', costPrice: costCents / 100, sellPrice: sellCents / 100,
        stockQuantity: parseInt(stockQuantity) || 0, minStock: parseInt(minStock) || 0, unit: unit || 'Stück',
        createdAt: now, updatedAt: now, version: 1
    };

    logAudit('product', id, 'CREATE', req.user.username, null, product, req.ip);
    broadcastEvent('PRODUCT_CHANGED', { action: 'CREATE', product });

    res.status(201).json({ success: true, product });
});

router.put('/products/:id', requireAuth, (req, res) => {
    const existing = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Artikel nicht gefunden.' });

    const {
        storeId, name, barcode, sku, category,
        costPrice, sellPrice, cost_price, sell_price,
        stockQuantity, stock_quantity, minStock, min_stock, unit,
        size, color, season, manufacturer, supplier,
        storageLocation, storage_location, taxRate, tax_rate,
        description, imageUrl, image_url,
        clientVersion
    } = req.body;

    if (clientVersion && clientVersion < existing.version) {
        return res.status(409).json({ error: 'Konflikt: Artikeldaten wurden anderweitig geändert.', serverRecord: existing });
    }

    const effectiveCostPrice = costPrice !== undefined ? costPrice : (cost_price !== undefined ? cost_price : undefined);
    const effectiveSellPrice = sellPrice !== undefined ? sellPrice : (sell_price !== undefined ? sell_price : undefined);
    const effectiveStockQty = stockQuantity !== undefined ? stockQuantity : (stock_quantity !== undefined ? stock_quantity : undefined);
    const effectiveMinStock = minStock !== undefined ? minStock : (min_stock !== undefined ? min_stock : undefined);
    const effectiveStorage = storageLocation !== undefined ? storageLocation : (storage_location !== undefined ? storage_location : undefined);
    const effectiveTaxRate = taxRate !== undefined ? taxRate : (tax_rate !== undefined ? tax_rate : undefined);
    const effectiveImageUrl = imageUrl !== undefined ? imageUrl : (image_url !== undefined ? image_url : undefined);

    const costCents = effectiveCostPrice !== undefined ? Math.round(parseFloat(effectiveCostPrice) * 100) : existing.cost_price_cents;
    const sellCents = effectiveSellPrice !== undefined ? Math.round(parseFloat(effectiveSellPrice) * 100) : existing.sell_price_cents;
    const stockQtyVal = effectiveStockQty !== undefined ? parseInt(effectiveStockQty, 10) : existing.stock_quantity;
    const minStockVal = effectiveMinStock !== undefined ? parseInt(effectiveMinStock, 10) : existing.min_stock;
    const taxRateVal = effectiveTaxRate !== undefined ? parseFloat(effectiveTaxRate) : existing.tax_rate;
    const imgUrlVal = effectiveImageUrl !== undefined ? effectiveImageUrl : existing.image_url;

    const now = new Date().toISOString();
    const newVersion = existing.version + 1;

    db.prepare(`
        UPDATE products SET
            store_id = COALESCE(?, store_id),
            name = COALESCE(?, name),
            barcode = COALESCE(?, barcode),
            sku = COALESCE(?, sku),
            category = COALESCE(?, category),
            cost_price_cents = ?,
            sell_price_cents = ?,
            stock_quantity = ?,
            min_stock = ?,
            unit = COALESCE(?, unit),
            size = COALESCE(?, size),
            color = COALESCE(?, color),
            season = COALESCE(?, season),
            manufacturer = COALESCE(?, manufacturer),
            supplier = COALESCE(?, supplier),
            storage_location = COALESCE(?, storage_location),
            tax_rate = ?,
            description = COALESCE(?, description),
            image_url = ?,
            updated_at = ?,
            version = ?
        WHERE id = ?
    `).run(
        storeId !== undefined ? storeId : null,
        name !== undefined ? name.trim() : null,
        barcode !== undefined ? barcode.trim() : null,
        sku !== undefined ? sku.trim() : null,
        category !== undefined ? category.trim() : null,
        costCents,
        sellCents,
        stockQtyVal,
        minStockVal,
        unit !== undefined ? unit : null,
        size !== undefined ? size.trim() : null,
        color !== undefined ? color.trim() : null,
        season !== undefined ? season.trim() : null,
        manufacturer !== undefined ? manufacturer.trim() : null,
        supplier !== undefined ? supplier.trim() : null,
        effectiveStorage !== undefined ? effectiveStorage.trim() : null,
        taxRateVal,
        description !== undefined ? description.trim() : null,
        imgUrlVal,
        now,
        newVersion,
        req.params.id
    );

    const updated = {
        id: req.params.id,
        storeId: storeId !== undefined ? storeId : existing.store_id,
        name: name !== undefined ? name : existing.name,
        barcode: barcode !== undefined ? barcode : existing.barcode,
        sku: sku !== undefined ? sku : existing.sku,
        category: category !== undefined ? category : existing.category,
        costPrice: costCents / 100,
        sellPrice: sellCents / 100,
        cost_price: costCents / 100,
        sell_price: sellCents / 100,
        stockQuantity: stockQtyVal,
        stock_quantity: stockQtyVal,
        minStock: minStockVal,
        unit: unit !== undefined ? unit : existing.unit,
        size: size !== undefined ? size : existing.size,
        color: color !== undefined ? color : existing.color,
        season: season !== undefined ? season : existing.season,
        manufacturer: manufacturer !== undefined ? manufacturer : existing.manufacturer,
        supplier: supplier !== undefined ? supplier : existing.supplier,
        storageLocation: effectiveStorage !== undefined ? effectiveStorage : existing.storage_location,
        description: description !== undefined ? description : existing.description,
        imageUrl: imgUrlVal,
        image_url: imgUrlVal,
        updatedAt: now,
        version: newVersion
    };

    logAudit('product', req.params.id, 'UPDATE', req.user.username, existing, updated, req.ip);
    broadcastEvent('PRODUCT_CHANGED', { action: 'UPDATE', product: updated });

    res.json({ success: true, product: updated });
});

// BILD-UPLOAD FÜR ARTIKEL (BASE64 ODER DIREKTDATEI)
router.post('/products/:id/image-upload', requireAuth, (req, res) => {
    try {
        const { dataUrl, removeImage } = req.body;
        const productId = req.params.id;

        const existing = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(productId);
        if (!existing) return res.status(404).json({ error: 'Artikel nicht gefunden.' });

        const now = new Date().toISOString();
        let newImageUrl = existing.image_url;

        if (removeImage) {
            newImageUrl = '';
        } else if (dataUrl && dataUrl.startsWith('data:image/')) {
            const matches = dataUrl.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
            if (!matches) {
                return res.status(400).json({ error: 'Ungültiges Bildformat' });
            }
            const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
            const buffer = Buffer.from(matches[2], 'base64');
            const cleanSku = (existing.sku || productId).replace(/[^a-zA-Z0-9_-]/g, '_');
            const fileName = `img_${cleanSku}_${Date.now()}.${ext}`;
            const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'products');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            const targetPath = path.join(uploadDir, fileName);
            fs.writeFileSync(targetPath, buffer);
            newImageUrl = `/uploads/products/${fileName}`;
        }

        db.prepare('UPDATE products SET image_url = ?, updated_at = ?, version = version + 1 WHERE id = ?')
          .run(newImageUrl, now, productId);

        const updated = { ...existing, imageUrl: newImageUrl, image_url: newImageUrl, updatedAt: now, version: existing.version + 1 };
        broadcastEvent('PRODUCT_CHANGED', { action: 'UPDATE', product: updated });

        res.json({ success: true, imageUrl: newImageUrl });
    } catch (err) {
        console.error('Image upload error:', err);
        res.status(500).json({ error: 'Fehler beim Bild-Upload: ' + err.message });
    }
});

router.delete('/products/:id', requireAuth, requireRole(['admin', 'manager']), (req, res) => {
    const existing = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Artikel nicht gefunden.' });

    const now = new Date().toISOString();
    db.prepare('UPDATE products SET is_deleted = 1, updated_at = ?, version = version + 1 WHERE id = ?').run(now, req.params.id);

    logAudit('product', req.params.id, 'DELETE', req.user.username, existing, null, req.ip);
    broadcastEvent('PRODUCT_CHANGED', { action: 'DELETE', id: req.params.id });

    res.json({ success: true });
});


// =============================================================================
// BATCH MULTI-FILE IMPORT & ORDER HISTORY
// =============================================================================

router.post('/products/batch-import', requireAuth, requireRole(['admin', 'manager']), (req, res) => {
    try {
        const { items, duplicateStrategy = 'update', fileSummaries = [] } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Keine Datensätze übermittelt' });
        }

        // 1. Automatisches Sicherheits-Backup vor jedem Batch-Import
        const nowIso = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(__dirname, '..', '..', 'data', 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        const backupPath = path.join(backupDir, `storecontrol_safety_backup_${nowIso}.db`);
        const dbFile = path.join(__dirname, '..', '..', 'data', 'storecontrol.db');
        if (fs.existsSync(dbFile)) {
            try {
                fs.copyFileSync(dbFile, backupPath);
            } catch (bErr) {
                console.warn('[BatchImport] Warning creating backup:', bErr.message);
            }
        }

        const now = new Date().toISOString();
        let newCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        let ordersCount = 0;

        // Prepared statements
        const findByBarcode = db.prepare("SELECT * FROM products WHERE barcode = ? AND barcode IS NOT NULL AND barcode != '' AND is_deleted = 0 LIMIT 1");
        const findBySkuColorSize = db.prepare("SELECT * FROM products WHERE sku = ? AND (color = ? OR color IS NULL OR ? = '') AND (size = ? OR size IS NULL OR ? = '') AND is_deleted = 0 LIMIT 1");
        const findBySku = db.prepare("SELECT * FROM products WHERE sku = ? AND sku IS NOT NULL AND sku != '' AND is_deleted = 0 LIMIT 1");

        const insertProductStmt = db.prepare(`
            INSERT INTO products (
                id, store_id, name, barcode, sku, category,
                manufacturer, supplier, storage_location, tax_rate, description, image_url,
                cost_price_cents, sell_price_cents, stock_quantity, min_stock, unit,
                size, color, season, attributes_json,
                is_deleted, created_at, updated_at, version
            ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                0, ?, ?, 1
            )
        `);

        const updateProductStmt = db.prepare(`
            UPDATE products SET
                name = COALESCE(?, name),
                category = COALESCE(?, category),
                manufacturer = COALESCE(?, manufacturer),
                supplier = COALESCE(?, supplier),
                storage_location = COALESCE(?, storage_location),
                tax_rate = COALESCE(?, tax_rate),
                description = COALESCE(?, description),
                cost_price_cents = CASE WHEN ? > 0 THEN ? ELSE cost_price_cents END,
                sell_price_cents = CASE WHEN ? > 0 THEN ? ELSE sell_price_cents END,
                stock_quantity = stock_quantity + ?,
                size = COALESCE(?, size),
                color = COALESCE(?, color),
                season = COALESCE(?, season),
                updated_at = ?,
                version = version + 1
            WHERE id = ?
        `);

        const insertOrderStmt = db.prepare(`
            INSERT INTO product_orders (
                id, product_id, source_file, order_number, order_position, season,
                supplier, manufacturer, sku, barcode, size, color,
                ordered_quantity, delivered_quantity, cost_price_cents, sell_price_cents,
                order_date, delivery_date, invoice_date, raw_data_json, created_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?
            )
        `);

        const tx = db.transaction(() => {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const name = String(item.name || '').trim();
                const sku = item.sku ? String(item.sku).trim() : null;
                const barcode = item.barcode ? String(item.barcode).trim() : null;
                const size = item.size ? String(item.size).trim() : null;
                const color = item.color ? String(item.color).trim() : null;
                const season = item.season ? String(item.season).trim() : null;
                const category = item.category ? String(item.category).trim() : 'Schuhe';
                const manufacturer = item.manufacturer ? String(item.manufacturer).trim() : '';
                const supplier = item.supplier ? String(item.supplier).trim() : '';
                const storageLocation = item.storage_location ? String(item.storage_location).trim() : '';
                const taxRate = item.tax_rate !== undefined ? parseFloat(item.tax_rate) : 19.0;
                const description = item.description ? String(item.description).trim() : '';
                const unit = item.unit ? String(item.unit).trim() : 'Paar';
                const imageUrl = item.image_url || '';

                const costPriceRaw = item.cost_price !== undefined ? item.cost_price : (item.costPrice !== undefined ? item.costPrice : 0);
                const sellPriceRaw = item.sell_price !== undefined ? item.sell_price : (item.sellPrice !== undefined ? item.sellPrice : 0);
                const qtyRaw = item.stock_quantity !== undefined ? item.stock_quantity : (item.quantity !== undefined ? item.quantity : 1);
                const minStockRaw = item.min_stock !== undefined ? item.min_stock : 3;

                const costCents = Math.round((parseFloat(costPriceRaw) || 0) * 100);
                const sellCents = Math.round((parseFloat(sellPriceRaw) || 0) * 100);
                const qty = Math.max(1, parseInt(qtyRaw) || 1);
                const minStock = parseInt(minStockRaw) || 3;

                let existing = null;
                if (barcode) existing = findByBarcode.get(barcode);
                if (!existing && sku) existing = findBySkuColorSize.get(sku, color || '', color || '', size || '', size || '');
                if (!existing && sku && !size && !color) existing = findBySku.get(sku);

                let targetProductId = null;

                if (existing) {
                    if (duplicateStrategy === 'skip') {
                        skippedCount++;
                        targetProductId = existing.id;
                    } else if (duplicateStrategy === 'update') {
                        updateProductStmt.run(
                            name || existing.name,
                            category || existing.category,
                            manufacturer || existing.manufacturer,
                            supplier || existing.supplier,
                            storageLocation || existing.storage_location,
                            taxRate,
                            description || existing.description,
                            costCents, costCents,
                            sellCents, sellCents,
                            qty,
                            size || existing.size,
                            color || existing.color,
                            season || existing.season,
                            now,
                            existing.id
                        );
                        updatedCount++;
                        targetProductId = existing.id;
                    } else {
                        const newId = `prod_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_${i}`;
                        insertProductStmt.run(
                            newId, item.storeId || null, name, barcode, sku, category,
                            manufacturer, supplier, storageLocation, taxRate, description, imageUrl,
                            costCents, sellCents, qty, minStock, unit,
                            size, color, season, JSON.stringify(item.raw_attributes || {}),
                            now, now
                        );
                        newCount++;
                        targetProductId = newId;
                    }
                } else {
                    const newId = `prod_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_${i}`;
                    insertProductStmt.run(
                        newId, item.storeId || null, name, barcode, sku, category,
                        manufacturer, supplier, storageLocation, taxRate, description, imageUrl,
                        costCents, sellCents, qty, minStock, unit,
                        size, color, season, JSON.stringify(item.raw_attributes || {}),
                        now, now
                    );
                    newCount++;
                    targetProductId = newId;
                }

                // Insert into product_orders
                const orderId = `ord_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_${i}`;
                insertOrderStmt.run(
                    orderId,
                    targetProductId,
                    item.source_file || null,
                    item.order_number || null,
                    item.order_position || null,
                    season || null,
                    supplier || null,
                    manufacturer || null,
                    sku || null,
                    barcode || null,
                    size || null,
                    color || null,
                    qty,
                    item.delivered_quantity !== undefined ? parseInt(item.delivered_quantity) : qty,
                    costCents,
                    sellCents,
                    item.order_date || null,
                    item.delivery_date || null,
                    item.invoice_date || null,
                    JSON.stringify(item.raw_data || {}),
                    now
                );
                ordersCount++;
            }
        });

        tx();

        logAudit('product', 'batch', 'BATCH_IMPORT', req.user.username, null, {
            newCount,
            updatedCount,
            skippedCount,
            ordersCount,
            backupPath
        }, req.ip);

        broadcastEvent('PRODUCT_CHANGED', { action: 'BATCH_IMPORT', count: newCount + updatedCount });

        res.json({
            success: true,
            newCount,
            updatedCount,
            skippedCount,
            ordersCount,
            totalItems: items.length,
            filesCount: fileSummaries.length,
            backupPath,
            message: `Batch-Import erfolgreich: ${newCount} neue Artikel, ${updatedCount} aktualisiert, ${ordersCount} Historien-Einträge gesichert.`
        });
    } catch (err) {
        console.error('Batch-Import error:', err);
        res.status(500).json({ error: 'Fehler beim Batch-Import', details: err.message });
    }
});

// GET ORDER HISTORY FOR PRODUCT
router.get('/products/:id/orders', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        const orders = db.prepare(`
            SELECT * FROM product_orders
            WHERE product_id = ? OR (sku = (SELECT sku FROM products WHERE id = ?) AND sku IS NOT NULL)
            ORDER BY created_at DESC, order_date DESC
        `).all(id, id);
        res.json({ success: true, orders });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Laden der Bestellhistorie', details: err.message });
    }
});

// =============================================================================
// AUDIT LOGS (Revisionshistorie)
// =============================================================================
router.get('/audit-logs', requireAuth, requireRole(['admin', 'manager']), (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const logs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);

    const formatted = logs.map(l => ({
        id: l.id,
        entityType: l.entity_type,
        entityId: l.entity_id,
        action: l.action,
        changedBy: l.changed_by,
        oldData: l.old_data_json ? JSON.parse(l.old_data_json) : null,
        newData: l.new_data_json ? JSON.parse(l.new_data_json) : null,
        timestamp: l.timestamp,
        ipAddress: l.ip_address
    }));

    res.json(formatted);
});

// =============================================================================
// OFFLINE SYNC API (Push & Pull)
// =============================================================================
router.post('/sync/push', requireAuth, (req, res) => {
    const { items } = req.body; // Array of queued actions
    if (!Array.isArray(items) || items.length === 0) {
        return res.json({ synced: [], conflicts: [] });
    }

    const synced = [];
    const conflicts = [];

    const processSync = db.transaction(() => {
        for (const item of items) {
            let { type, data, clientVersion, tempId } = item;
            if (!data) continue;
            const now = new Date().toISOString();

            // Normalize action type
            let normalizedType = (type || '').toUpperCase().trim();
            if (normalizedType === 'REVENUE' || normalizedType === 'ADD_REVENUE' || normalizedType === 'SAVE_REVENUE') normalizedType = 'CREATE_REVENUE';
            if (normalizedType === 'EXPENSE' || normalizedType === 'ADD_EXPENSE' || normalizedType === 'SAVE_EXPENSE') normalizedType = 'CREATE_EXPENSE';
            if (normalizedType === 'PRODUCT' || normalizedType === 'ADD_PRODUCT' || normalizedType === 'SAVE_PRODUCT') normalizedType = 'CREATE_PRODUCT';
            if (normalizedType === 'STORE' || normalizedType === 'ADD_STORE' || normalizedType === 'SAVE_STORE') normalizedType = 'CREATE_STORE';

            let storeId = data.storeId || data.store_id;
            if (!storeId || !db.prepare('SELECT id FROM stores WHERE id = ?').get(storeId)) {
                const fallbackStore = db.prepare('SELECT id FROM stores WHERE is_deleted = 0 ORDER BY created_at ASC LIMIT 1').get();
                storeId = fallbackStore ? fallbackStore.id : (storeId || null);
            }

            try {
                if (normalizedType === 'CREATE_REVENUE') {
                    const id = data.id || `rev_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                    const existing = db.prepare('SELECT id, version FROM revenues WHERE id = ?').get(id);
                    if (existing) {
                        synced.push({ tempId, serverId: id, type: normalizedType, version: existing.version, idempotent: true });
                        continue;
                    }
                    const cashCents = data.cashCents !== undefined ? data.cashCents : (data.cash_cents !== undefined ? data.cash_cents : Math.round((parseFloat(data.cash) || 0) * 100));
                    const cardCents = data.cardCents !== undefined ? data.cardCents : (data.card_cents !== undefined ? data.card_cents : Math.round((parseFloat(data.card) || 0) * 100));
                    const totalCents = cashCents + cardCents;

                    // Reconcile if same revenue was already saved directly (duplicate prevention)
                    if (storeId && data.date) {
                        const duplicateCheck = db.prepare('SELECT id, version FROM revenues WHERE store_id = ? AND date = ? AND cash_cents = ? AND card_cents = ? AND is_deleted = 0').get(storeId, data.date, cashCents, cardCents);
                        if (duplicateCheck) {
                            synced.push({ tempId, serverId: duplicateCheck.id, type: normalizedType, version: duplicateCheck.version, idempotent: true });
                            continue;
                        }
                    }

                    db.prepare(`
                        INSERT INTO revenues (id, store_id, date, cash_cents, card_cents, total_cents, note, created_by, updated_by, created_at, updated_at, version)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                    `).run(id, storeId, data.date, cashCents, cardCents, totalCents, data.note || '', req.user.username, req.user.username, now, now);

                    logAudit('revenue', id, 'SYNC_CREATE', req.user.username, null, data, req.ip);
                    synced.push({ tempId, serverId: id, type: normalizedType, version: 1 });

                } else if (normalizedType === 'UPDATE_REVENUE') {
                    const existing = db.prepare('SELECT * FROM revenues WHERE id = ? AND is_deleted = 0').get(data.id);
                    if (!existing) {
                        conflicts.push({ tempId, id: data.id, reason: 'Datensatz existiert nicht oder wurde gelöscht' });
                        continue;
                    }
                    if (clientVersion && clientVersion < existing.version) {
                        conflicts.push({ tempId, id: data.id, reason: 'Versionskonflikt', serverRecord: existing });
                        continue;
                    }

                    const cashCents = data.cash !== undefined ? Math.round(parseFloat(data.cash) * 100) : (data.cashCents || existing.cash_cents);
                    const cardCents = data.card !== undefined ? Math.round(parseFloat(data.card) * 100) : (data.cardCents || existing.card_cents);
                    const totalCents = cashCents + cardCents;
                    const newVersion = existing.version + 1;

                    db.prepare(`
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
                    `).run(storeId, data.date, cashCents, cardCents, totalCents, data.note, req.user.username, now, newVersion, data.id);

                    logAudit('revenue', data.id, 'SYNC_UPDATE', req.user.username, existing, data, req.ip);
                    synced.push({ tempId, serverId: data.id, type: normalizedType, version: newVersion });

                } else if (normalizedType === 'DELETE_REVENUE') {
                    const existing = db.prepare('SELECT * FROM revenues WHERE id = ? AND is_deleted = 0').get(data.id);
                    if (existing) {
                        db.prepare('UPDATE revenues SET is_deleted = 1, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?')
                          .run(req.user.username, now, data.id);
                        logAudit('revenue', data.id, 'SYNC_DELETE', req.user.username, existing, null, req.ip);
                    }
                    synced.push({ tempId, serverId: data.id, type: normalizedType });

                } else if (normalizedType === 'CREATE_EXPENSE') {
                    const id = data.id || `exp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                    const existing = db.prepare('SELECT id, version FROM expenses WHERE id = ?').get(id);
                    if (existing) {
                        synced.push({ tempId, serverId: id, type: normalizedType, version: existing.version, idempotent: true });
                        continue;
                    }
                    const amountCents = data.amountCents !== undefined ? data.amountCents : (data.amount_cents !== undefined ? data.amount_cents : Math.round((parseFloat(data.amount) || 0) * 100));
                    const safeCategory = mapExpenseCategory(data.category);

                    // Reconcile if same expense was already saved directly
                    if (storeId && data.date) {
                        const duplicateExpense = db.prepare('SELECT id, version FROM expenses WHERE store_id = ? AND date = ? AND amount_cents = ? AND title = ? AND is_deleted = 0').get(storeId, data.date, amountCents, data.title || '');
                        if (duplicateExpense) {
                            synced.push({ tempId, serverId: duplicateExpense.id, type: normalizedType, version: duplicateExpense.version, idempotent: true });
                            continue;
                        }
                    }

                    db.prepare(`
                        INSERT INTO expenses (id, store_id, category, date, amount_cents, title, recurrence, created_by, updated_by, created_at, updated_at, version)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                    `).run(id, storeId, safeCategory, data.date, amountCents, data.title, data.recurrence || 'single', req.user.username, req.user.username, now, now);

                    logAudit('expense', id, 'SYNC_CREATE', req.user.username, null, data, req.ip);
                    synced.push({ tempId, serverId: id, type: normalizedType, version: 1 });

                } else if (normalizedType === 'UPDATE_EXPENSE') {
                    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND is_deleted = 0').get(data.id);
                    if (!existing) {
                        conflicts.push({ tempId, id: data.id, reason: 'Kostenposition existiert nicht oder wurde gelöscht' });
                        continue;
                    }
                    if (clientVersion && clientVersion < existing.version) {
                        conflicts.push({ tempId, id: data.id, reason: 'Versionskonflikt', serverRecord: existing });
                        continue;
                    }

                    const amountCents = data.amount !== undefined ? Math.round(parseFloat(data.amount) * 100) : (data.amountCents || existing.amount_cents);
                    const newVersion = existing.version + 1;
                    const safeCategory = data.category ? mapExpenseCategory(data.category) : existing.category;

                    db.prepare(`
                        UPDATE expenses SET
                            store_id = COALESCE(?, store_id),
                            category = ?,
                            date = COALESCE(?, date),
                            amount_cents = ?,
                            title = COALESCE(?, title),
                            recurrence = COALESCE(?, recurrence),
                            updated_by = ?,
                            updated_at = ?,
                            version = ?
                        WHERE id = ?
                    `).run(storeId, safeCategory, data.date, amountCents, data.title, data.recurrence, req.user.username, now, newVersion, data.id);

                    logAudit('expense', data.id, 'SYNC_UPDATE', req.user.username, existing, data, req.ip);
                    synced.push({ tempId, serverId: data.id, type: normalizedType, version: newVersion });

                } else if (normalizedType === 'DELETE_EXPENSE') {
                    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND is_deleted = 0').get(data.id);
                    if (existing) {
                        db.prepare('UPDATE expenses SET is_deleted = 1, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?')
                          .run(req.user.username, now, data.id);
                        logAudit('expense', data.id, 'SYNC_DELETE', req.user.username, existing, null, req.ip);
                    }
                    synced.push({ tempId, serverId: data.id, type: normalizedType });

                } else if (normalizedType === 'CREATE_PRODUCT') {
                    const id = data.id || `prod_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                    const existing = db.prepare('SELECT id, version FROM products WHERE id = ?').get(id);
                    if (existing) {
                        synced.push({ tempId, serverId: id, type: normalizedType, version: existing.version, idempotent: true });
                        continue;
                    }
                    if (data.barcode) {
                        const dupBarcode = db.prepare('SELECT id, version FROM products WHERE barcode = ? AND is_deleted = 0').get(data.barcode);
                        if (dupBarcode) {
                            synced.push({ tempId, serverId: dupBarcode.id, type: normalizedType, version: dupBarcode.version, idempotent: true });
                            continue;
                        }
                    }
                    const costCents = Math.round((parseFloat(data.costPrice) || 0) * 100);
                    const sellCents = Math.round((parseFloat(data.sellPrice) || 0) * 100);

                    db.prepare(`
                        INSERT INTO products (id, store_id, name, barcode, sku, category, cost_price_cents, sell_price_cents, stock_quantity, min_stock, unit, created_at, updated_at, version)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                    `).run(
                        id, storeId || null, data.name.trim(), data.barcode || null, data.sku || null,
                        data.category || 'Allgemein', costCents, sellCents, parseInt(data.stockQuantity) || 0,
                        parseInt(data.minStock) || 0, data.unit || 'Stück', now, now
                    );

                    logAudit('product', id, 'SYNC_CREATE', req.user.username, null, data, req.ip);
                    synced.push({ tempId, serverId: id, type: normalizedType, version: 1 });

                } else if (normalizedType === 'UPDATE_PRODUCT') {
                    const existing = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(data.id);
                    if (!existing) {
                        conflicts.push({ tempId, id: data.id, reason: 'Artikel nicht gefunden oder gelöscht' });
                        continue;
                    }
                    if (clientVersion && clientVersion < existing.version) {
                        conflicts.push({ tempId, id: data.id, reason: 'Versionskonflikt', serverRecord: existing });
                        continue;
                    }

                    const costCents = data.costPrice !== undefined ? Math.round(parseFloat(data.costPrice) * 100) : existing.cost_price_cents;
                    const sellCents = data.sellPrice !== undefined ? Math.round(parseFloat(data.sellPrice) * 100) : existing.sell_price_cents;
                    const newVersion = existing.version + 1;

                    db.prepare(`
                        UPDATE products SET
                            store_id = COALESCE(?, store_id),
                            name = COALESCE(?, name),
                            barcode = COALESCE(?, barcode),
                            sku = COALESCE(?, sku),
                            category = COALESCE(?, category),
                            cost_price_cents = ?,
                            sell_price_cents = ?,
                            stock_quantity = COALESCE(?, stock_quantity),
                            min_stock = COALESCE(?, min_stock),
                            unit = COALESCE(?, unit),
                            updated_at = ?,
                            version = ?
                        WHERE id = ?
                    `).run(
                        storeId, data.name, data.barcode, data.sku, data.category,
                        costCents, sellCents, data.stockQuantity, data.minStock, data.unit,
                        now, newVersion, data.id
                    );

                    logAudit('product', data.id, 'SYNC_UPDATE', req.user.username, existing, data, req.ip);
                    synced.push({ tempId, serverId: data.id, type: normalizedType, version: newVersion });

                } else if (normalizedType === 'DELETE_PRODUCT') {
                    const existing = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(data.id);
                    if (existing) {
                        db.prepare('UPDATE products SET is_deleted = 1, updated_at = ?, version = version + 1 WHERE id = ?')
                          .run(now, data.id);
                        logAudit('product', data.id, 'SYNC_DELETE', req.user.username, existing, null, req.ip);
                    }
                    synced.push({ tempId, serverId: data.id, type: normalizedType });

                } else if (normalizedType === 'CREATE_STORE') {
                    const id = data.id || `store_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                    const existing = db.prepare('SELECT id, version FROM stores WHERE id = ?').get(id);
                    if (existing) {
                        synced.push({ tempId, serverId: id, type: normalizedType, version: existing.version, idempotent: true });
                        continue;
                    }
                    const targetCents = Math.round((parseFloat(data.targetRevenue) || 0) * 100);

                    db.prepare(`
                        INSERT INTO stores (id, name, address, manager, phone, color, employee_count, target_revenue_cents, created_at, updated_at, version)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                    `).run(id, data.name.trim(), data.address || '', data.manager || '', data.phone || '', data.color || 'emerald', parseInt(data.employeeCount) || 2, targetCents, now, now);

                    logAudit('store', id, 'SYNC_CREATE', req.user.username, null, data, req.ip);
                    synced.push({ tempId, serverId: id, type: normalizedType, version: 1 });

                } else if (normalizedType === 'UPDATE_STORE') {
                    const existing = db.prepare('SELECT * FROM stores WHERE id = ? AND is_deleted = 0').get(data.id);
                    if (!existing) {
                        conflicts.push({ tempId, id: data.id, reason: 'Filiale nicht gefunden oder gelöscht' });
                        continue;
                    }
                    const targetCents = data.targetRevenue !== undefined ? Math.round(parseFloat(data.targetRevenue) * 100) : existing.target_revenue_cents;
                    const newVersion = existing.version + 1;

                    db.prepare(`
                        UPDATE stores SET
                            name = COALESCE(?, name),
                            address = COALESCE(?, address),
                            manager = COALESCE(?, manager),
                            phone = COALESCE(?, phone),
                            color = COALESCE(?, color),
                            employee_count = COALESCE(?, employee_count),
                            target_revenue_cents = ?,
                            updated_at = ?,
                            version = ?
                        WHERE id = ?
                    `).run(data.name, data.address, data.manager, data.phone, data.color, data.employeeCount, targetCents, now, newVersion, data.id);

                    logAudit('store', data.id, 'SYNC_UPDATE', req.user.username, existing, data, req.ip);
                    synced.push({ tempId, serverId: data.id, type: normalizedType, version: newVersion });

                } else if (normalizedType === 'DELETE_STORE') {
                    const existing = db.prepare('SELECT * FROM stores WHERE id = ? AND is_deleted = 0').get(data.id);
                    if (existing) {
                        db.prepare('UPDATE stores SET is_deleted = 1, updated_at = ?, version = version + 1 WHERE id = ?')
                          .run(now, data.id);
                        logAudit('store', data.id, 'SYNC_DELETE', req.user.username, existing, null, req.ip);
                    }
                    synced.push({ tempId, serverId: data.id, type: normalizedType });
                }
            } catch (err) {
                conflicts.push({ tempId, error: err.message });
            }
        }
    });

    processSync();
    if (synced.length > 0) {
        broadcastEvent('BATCH_SYNC', { count: synced.length });
    }

    res.json({ success: true, synced, conflicts });
});

router.get('/sync/pull', requireAuth, (req, res) => {
    const { since } = req.query; // ISO Timestamp
    const sinceTime = since || '1970-01-01T00:00:00.000Z';

    const stores = db.prepare('SELECT * FROM stores WHERE updated_at > ?').all(sinceTime);
    const revenues = db.prepare('SELECT * FROM revenues WHERE updated_at > ?').all(sinceTime);
    const expenses = db.prepare('SELECT * FROM expenses WHERE updated_at > ?').all(sinceTime);
    const products = db.prepare('SELECT * FROM products WHERE updated_at > ?').all(sinceTime);

    res.json({
        serverTime: new Date().toISOString(),
        stores: stores.map(s => ({ ...s, targetRevenue: s.target_revenue_cents / 100 })),
        revenues: revenues.map(r => ({ ...r, cash: r.cash_cents / 100, card: r.card_cents / 100, total: r.total_cents / 100 })),
        expenses: expenses.map(e => ({ ...e, amount: e.amount_cents / 100 })),
        products: products.map(p => ({ ...p, costPrice: p.cost_price_cents / 100, sellPrice: p.sell_price_cents / 100 }))
    });
});

// =============================================================================
// MIGRATION: 1-Click Import of Browser localStorage Data
// =============================================================================
router.post('/migration/import', requireAuth, requireRole(['admin']), (req, res) => {
    const { stores = [], revenues = [], expenses = [] } = req.body;
    let importedStores = 0, importedRevenues = 0, importedExpenses = 0;
    const now = new Date().toISOString();

    const runImport = db.transaction(() => {
        // Import Stores
        const insertStore = db.prepare(`
            INSERT OR IGNORE INTO stores (id, name, address, manager, phone, color, employee_count, target_revenue_cents, created_at, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);
        for (const s of stores) {
            if (!s.id || !s.name) continue;
            const targetCents = Math.round((parseFloat(s.targetRevenue) || 0) * 100);
            const res = insertStore.run(s.id, s.name, s.address || '', s.manager || '', s.phone || '', s.color || 'emerald', s.employeeCount || 2, targetCents, s.createdAt || now, now);
            if (res.changes > 0) importedStores++;
        }

        // Import Revenues
        const insertRev = db.prepare(`
            INSERT OR IGNORE INTO revenues (id, store_id, date, cash_cents, card_cents, total_cents, note, created_by, updated_by, created_at, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);
        for (const r of revenues) {
            if (!r.id || !r.storeId || !r.date) continue;
            const cashCents = Math.round((parseFloat(r.cash) || 0) * 100);
            const cardCents = Math.round((parseFloat(r.card) || 0) * 100);
            const totalCents = cashCents + cardCents;
            const res = insertRev.run(r.id, r.storeId, r.date, cashCents, cardCents, totalCents, r.note || '', 'migration', 'migration', r.createdAt || now, now);
            if (res.changes > 0) importedRevenues++;
        }

        // Import Expenses
        const insertExp = db.prepare(`
            INSERT OR IGNORE INTO expenses (id, store_id, category, date, amount_cents, title, recurrence, created_by, updated_by, created_at, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);
        for (const e of expenses) {
            if (!e.id || !e.storeId || !e.category || !e.date) continue;
            const amountCents = Math.round((parseFloat(e.amount) || 0) * 100);
            const res = insertExp.run(e.id, e.storeId, e.category, e.date, amountCents, e.title || 'Ausgabe', e.recurrence || 'single', 'migration', 'migration', e.createdAt || now, now);
            if (res.changes > 0) importedExpenses++;
        }
    });

    runImport();
    logAudit('system', 'migration', 'IMPORT_LOCAL_STORAGE', req.user.username, null, { importedStores, importedRevenues, importedExpenses }, req.ip);
    broadcastEvent('MIGRATION_COMPLETED', { importedStores, importedRevenues, importedExpenses });

    res.json({
        success: true,
        message: 'Altdaten erfolgreich in die zentrale Datenbank übernommen!',
        importedStores,
        importedRevenues,
        importedExpenses
    });
});

module.exports = router;
