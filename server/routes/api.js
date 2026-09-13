const express = require('express');
const os = require('os');
const qrcode = require('qrcode');
const { db, logAudit, getAppSetting, setAppSetting } = require('../db');
const { 
    authenticateUser, 
    generateToken, 
    getPublicUser, 
    createPairingCode,
    redeemPairingCode,
    verifyDeviceToken,
    listUserDevices,
    revokeDevice,
    requireAuth, 
    requireRole 
} = require('../auth');

const router = express.Router();

// =============================================================================
// SERVER-SENT EVENTS (SSE) BROADCAST ENGINE
// =============================================================================
const sseClients = new Set();
const longPollClients = new Set();

function broadcastEvent(eventType, payload) {
    const timestamp = new Date().toISOString();
    const eventObj = { type: eventType, payload, timestamp };
    const sseData = `data: ${JSON.stringify(eventObj)}\n\n`;

    // 1. Send to all local & direct SSE clients
    for (const client of sseClients) {
        try {
            client.res.write(sseData);
        } catch (e) {
            sseClients.delete(client);
        }
    }

    // 2. Send to all Long-Polling clients (Instant push through Cloudflare Tunnel & Mobile)
    for (const client of longPollClients) {
        clearTimeout(client.timer);
        try {
            client.res.json(eventObj);
        } catch (e) {}
    }
    longPollClients.clear();
}

// Listen for dynamic tunnel URL changes and broadcast to clients
try {
    const tunnel = require('../tunnel');
    tunnel.onTunnelUrlChange((publicUrl) => {
        broadcastEvent('SETTINGS_CHANGED', { publicUrl });
    });
} catch(e) {}

// SSE Connection Endpoint (Hardened with no-transform, 2KB buffer flush & 15s keep-alive)
router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    if (req.socket) {
        req.socket.setTimeout(0);
        req.socket.setNoDelay(true);
        req.socket.setKeepAlive(true, 10000);
    }

    // 2KB padding to bypass any proxy / Cloudflare buffering immediately
    res.write(':' + ' '.repeat(2048) + '\n\n');

    const client = { id: Date.now() + Math.random(), res };
    sseClients.add(client);

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', clientId: client.id, timestamp: new Date().toISOString() })}\n\n`);

    // Keepalive heartbeat every 15s to keep idle mobile / Cloudflare connections alive
    const keepAliveTimer = setInterval(() => {
        try {
            res.write(':keepalive\n\n');
        } catch (e) {
            clearInterval(keepAliveTimer);
            sseClients.delete(client);
        }
    }, 15000);

    req.on('close', () => {
        clearInterval(keepAliveTimer);
        sseClients.delete(client);
    });
});

// REALTIME LONG-POLL ENDPOINT (Guaranteed 100% Realtime delivery over Cloudflare & Mobile)
router.get('/events/poll', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const client = {
        id: Date.now() + Math.random(),
        res,
        timer: null
    };

    // Hold request open for up to 25s waiting for server events
    client.timer = setTimeout(() => {
        longPollClients.delete(client);
        try {
            res.json({ type: 'TIMEOUT', timestamp: new Date().toISOString() });
        } catch (e) {}
    }, 25000);

    longPollClients.add(client);

    req.on('close', () => {
        clearTimeout(client.timer);
        longPollClients.delete(client);
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
    // 0. Active Cloudflare Tunnel
    try {
        const tunnel = require('../tunnel');
        const tunnelUrl = tunnel.getPublicTunnelUrl();
        if (tunnelUrl && isValidPublicHttpsUrl(tunnelUrl)) {
            return { url: tunnelUrl, source: 'cloudflare_tunnel' };
        }
    } catch(e) {}

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
// NETWORK INFO & SMARTPHONE QR-CODE (PUBLIC HTTPS WITH SECURE PAIRING)
// =============================================================================
router.get('/network-info', async (req, res) => {
    try {
        const { url: publicUrl, source } = resolvePublicHttpsUrl(req);
        const isConfigured = !!publicUrl;

        let qrCode = null;
        let pairingUrl = null;
        let pairingCode = null;

        if (isConfigured) {
            // Generate a secure pairing code for the admin account
            try {
                const pairing = createPairingCode('user_admin');
                pairingCode = pairing.code;
                pairingUrl = `${publicUrl}/?pair=${pairingCode}`;
            } catch (pErr) {
                pairingUrl = publicUrl;
            }

            qrCode = await qrcode.toDataURL(pairingUrl || publicUrl, {
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
            pairingUrl,
            pairingCode,
            qrCode,
            source,
            message: isConfigured 
                ? 'Öffentliche HTTPS-Adresse mit sicherer Gerätekopplung aktiv.' 
                : 'Die öffentliche App-Adresse ist noch nicht konfiguriert.'
        });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Abrufen der Smartphone-Verbindungsdaten', details: err.message });
    }
});

// Refresh pairing QR-Code on demand
router.get('/auth/pairing-qr', async (req, res) => {
    try {
        const { url: publicUrl } = resolvePublicHttpsUrl(req);
        if (!publicUrl) {
            return res.status(400).json({ error: 'Keine öffentliche HTTPS-Adresse verfügbar.' });
        }

        const pairing = createPairingCode('user_admin');
        const pairingUrl = `${publicUrl}/?pair=${pairing.code}`;
        const qrCode = await qrcode.toDataURL(pairingUrl, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 280,
            color: { dark: '#0f172a', light: '#ffffff' }
        });

        res.json({
            success: true,
            publicUrl,
            pairingUrl,
            pairingCode: pairing.code,
            expiresAt: pairing.expiresAt,
            qrCode
        });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Erzeugen des Kopplungs-Codes', details: err.message });
    }
});

// Redeem device pairing code (Smartphone scans QR -> saves permanent token)
router.post('/auth/pair-device', (req, res) => {
    try {
        const { code, deviceName } = req.body;
        if (!code) {
            return res.status(400).json({ error: 'Kopplungscode erforderlich.' });
        }
        const result = redeemPairingCode(code, deviceName, req.ip);
        if (result.error) {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Fehler bei der Gerätekopplung', details: err.message });
    }
});

// Verify returning device token
router.get('/auth/verify-device', (req, res) => {
    try {
        const token = req.headers['x-device-token'] || req.query.token;
        if (!token) {
            return res.status(400).json({ error: 'Device-Token erforderlich.' });
        }
        const user = verifyDeviceToken(token);
        if (!user) {
            return res.status(401).json({ error: 'Gerät nicht gekoppelt oder Token ungültig.' });
        }
        const sessionToken = generateToken(user);
        res.json({ valid: true, user, sessionToken });
    } catch (err) {
        res.status(500).json({ error: 'Fehler bei der Geräteüberprüfung', details: err.message });
    }
});

// List paired devices for user
router.get('/auth/devices', requireAuth, (req, res) => {
    try {
        const devices = listUserDevices(req.user.id);
        res.json({ devices });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Abrufen der Geräte', details: err.message });
    }
});

// Revoke a paired device
router.delete('/auth/devices/:id', requireAuth, (req, res) => {
    try {
        const success = revokeDevice(req.params.id, req.user.id);
        res.json({ success });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Deaktivieren des Geräts', details: err.message });
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

const updateStoreHandler = (req, res) => {
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

    db.prepare(`
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
    `).run(finalName, finalAddress, finalManager, finalPhone, finalColor, finalEmpCount, targetCents, now, newVersion, req.params.id);

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

const updateRevenueHandler = (req, res) => {
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

    db.prepare(`
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
    `).run(finalStoreId, finalDate, cashCents, cardCents, totalCents, finalNote, req.user.username, now, newVersion, req.params.id);

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

const updateExpenseHandler = (req, res) => {
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

    db.prepare(`
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
    `).run(finalStoreId, finalCategory, finalDate, amountCents, finalTitle, finalRecurrence, req.user.username, now, newVersion, req.params.id);

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
// PRODUCTS & WARENWIRTSCHAFT (Vollwertige Artikel- & Lagerverwaltung)
// =============================================================================

function sanitizeCsvValue(val) {
    if (val === null || val === undefined) return '';
    let str = String(val).trim();
    // Escape formula injection risks in Excel/LibreOffice
    if (str.startsWith('=') || str.startsWith('+') || str.startsWith('-') || str.startsWith('@')) {
        str = "'" + str;
    }
    // Escape quotes and wrap in quotes if contains delimiter or newline
    if (str.includes(';') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

// 1. Get Products with Filters (Search, Barcode, Category, Low Stock, Store)
router.get('/products', requireAuth, (req, res) => {
    try {
        const { storeId, q, barcode, category, lowStock } = req.query;
        let query = 'SELECT * FROM products WHERE is_deleted = 0';
        const params = [];

        if (storeId && storeId !== 'ALL') {
            query += ' AND (store_id = ? OR store_id IS NULL)';
            params.push(storeId);
        }
        if (barcode && String(barcode).trim()) {
            query += ' AND barcode = ?';
            params.push(String(barcode).trim());
        }
        if (category && category !== 'ALL') {
            query += ' AND category = ?';
            params.push(category);
        }
        if (lowStock === 'true' || lowStock === '1') {
            query += ' AND stock_quantity <= min_stock';
        }
        if (q && String(q).trim()) {
            const term = `%${String(q).trim()}%`;
            query += ' AND (name LIKE ? OR barcode LIKE ? OR sku LIKE ? OR manufacturer LIKE ? OR supplier LIKE ? OR storage_location LIKE ? OR category LIKE ?)';
            params.push(term, term, term, term, term, term, term);
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
            manufacturer: p.manufacturer || '',
            supplier: p.supplier || '',
            storageLocation: p.storage_location || '',
            taxRate: (p.tax_rate !== null && p.tax_rate !== undefined) ? p.tax_rate : 19.0,
            description: p.description || '',
            imageUrl: p.image_url || '',
            costPrice: (p.cost_price_cents || 0) / 100,
            sellPrice: (p.sell_price_cents || 0) / 100,
            stockQuantity: p.stock_quantity !== undefined ? p.stock_quantity : 0,
            minStock: p.min_stock !== undefined ? p.min_stock : 0,
            unit: p.unit || 'Stück',
            createdAt: p.created_at,
            updatedAt: p.updated_at,
            version: p.version
        }));

        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Abrufen der Artikel', details: err.message });
    }
});
// 2. Create Single Product
router.post('/products', requireAuth, requireRole(['admin', 'manager']), (req, res) => {
    try {
        const storeId = req.body.storeId !== undefined ? req.body.storeId : req.body.store_id;
        const name = req.body.name;
        const barcode = req.body.barcode;
        const sku = req.body.sku;
        const category = req.body.category;
        const manufacturer = req.body.manufacturer;
        const supplier = req.body.supplier;
        const storageLocation = req.body.storageLocation !== undefined ? req.body.storageLocation : req.body.storage_location;
        const taxRate = req.body.taxRate !== undefined ? req.body.taxRate : req.body.tax_rate;
        const description = req.body.description;
        const imageUrl = req.body.imageUrl !== undefined ? req.body.imageUrl : req.body.image_url;
        const costPrice = req.body.costPrice !== undefined ? req.body.costPrice : req.body.cost_price;
        const sellPrice = req.body.sellPrice !== undefined ? req.body.sellPrice : req.body.sell_price;
        const stockQuantity = req.body.stockQuantity !== undefined ? req.body.stockQuantity : req.body.stock_quantity;
        const minStock = req.body.minStock !== undefined ? req.body.minStock : req.body.min_stock;
        const unit = req.body.unit;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Artikelname ist erforderlich.' });
        }

        // Idempotency check if ID is provided
        if (req.body.id) {
            const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.body.id);
            if (existing) {
                const product = {
                    id: existing.id, storeId: existing.store_id, name: existing.name,
                    barcode: existing.barcode || '', sku: existing.sku || '', category: existing.category || 'Allgemein',
                    manufacturer: existing.manufacturer || '', supplier: existing.supplier || '',
                    storageLocation: existing.storage_location || '',
                    taxRate: existing.tax_rate !== null ? existing.tax_rate : 19.0,
                    description: existing.description || '', imageUrl: existing.image_url || '',
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
        const stockNum = parseInt(stockQuantity) || 0;
        const minStockNum = parseInt(minStock) || 0;
        const taxRateNum = (taxRate !== undefined && taxRate !== null && taxRate !== '') ? parseFloat(taxRate) : 19.0;
        const now = new Date().toISOString();

        db.prepare(`
            INSERT INTO products (
                id, store_id, name, barcode, sku, category,
                manufacturer, supplier, storage_location, tax_rate,
                description, image_url,
                cost_price_cents, sell_price_cents, stock_quantity, min_stock, unit,
                created_at, updated_at, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
            id,
            storeId || null,
            name.trim(),
            barcode ? String(barcode).trim() : null,
            sku ? String(sku).trim() : null,
            category ? String(category).trim() : 'Allgemein',
            manufacturer ? String(manufacturer).trim() : '',
            supplier ? String(supplier).trim() : '',
            storageLocation ? String(storageLocation).trim() : '',
            taxRateNum,
            description ? String(description).trim() : '',
            imageUrl ? String(imageUrl).trim() : '',
            costCents,
            sellCents,
            stockNum,
            minStockNum,
            unit || 'Stück',
            now,
            now
        );

        // Record initial stock movement if starting with inventory
        if (stockNum > 0) {
            const movementId = `sm_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            db.prepare(`
                INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, previous_stock, new_stock, reason, created_by, created_at)
                VALUES (?, ?, ?, 'inventory', ?, 0, ?, 'Anfangsbestand bei Neuanlage', ?, ?)
            `).run(movementId, id, storeId || null, stockNum, stockNum, req.user.username, now);
        }

        const product = {
            id, storeId: storeId || null, name: name.trim(),
            barcode: barcode ? String(barcode).trim() : '',
            sku: sku ? String(sku).trim() : '',
            category: category ? String(category).trim() : 'Allgemein',
            manufacturer: manufacturer ? String(manufacturer).trim() : '',
            supplier: supplier ? String(supplier).trim() : '',
            storageLocation: storageLocation ? String(storageLocation).trim() : '',
            taxRate: taxRateNum,
            description: description ? String(description).trim() : '',
            imageUrl: imageUrl ? String(imageUrl).trim() : '',
            costPrice: costCents / 100, sellPrice: sellCents / 100,
            stockQuantity: stockNum, minStock: minStockNum, unit: unit || 'Stück',
            createdAt: now, updatedAt: now, version: 1
        };

        logAudit('product', id, 'CREATE', req.user.username, null, product, req.ip);
        broadcastEvent('PRODUCT_CHANGED', { action: 'CREATE', product });

        res.status(201).json({ success: true, product });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Anlegen des Artikels', details: err.message });
    }
});

// 3. Update Single Product (Safe Partial Updates)
const updateProductHandler = (req, res) => {
    try {
        const existing = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Artikel nicht gefunden.' });

        const storeId = req.body.storeId !== undefined ? req.body.storeId : req.body.store_id;
        const name = req.body.name;
        const barcode = req.body.barcode;
        const sku = req.body.sku;
        const category = req.body.category;
        const manufacturer = req.body.manufacturer;
        const supplier = req.body.supplier;
        const storageLocation = req.body.storageLocation !== undefined ? req.body.storageLocation : req.body.storage_location;
        const taxRate = req.body.taxRate !== undefined ? req.body.taxRate : req.body.tax_rate;
        const description = req.body.description;
        const imageUrl = req.body.imageUrl !== undefined ? req.body.imageUrl : req.body.image_url;
        const costPrice = req.body.costPrice !== undefined ? req.body.costPrice : req.body.cost_price;
        const sellPrice = req.body.sellPrice !== undefined ? req.body.sellPrice : req.body.sell_price;
        const stockQuantity = req.body.stockQuantity !== undefined ? req.body.stockQuantity : req.body.stock_quantity;
        const minStock = req.body.minStock !== undefined ? req.body.minStock : req.body.min_stock;
        const unit = req.body.unit;
        const clientVersion = req.body.clientVersion !== undefined ? req.body.clientVersion : req.body.client_version;

        if (clientVersion && clientVersion < existing.version) {
            return res.status(409).json({ error: 'Konflikt: Artikeldaten wurden anderweitig geändert.', serverRecord: existing });
        }

        const finalStoreId = storeId !== undefined ? storeId : existing.store_id;
        const finalName = (name && String(name).trim()) ? String(name).trim() : existing.name;
        const finalBarcode = barcode !== undefined ? String(barcode).trim() : (existing.barcode || '');
        const finalSku = sku !== undefined ? String(sku).trim() : (existing.sku || '');
        const finalCategory = category !== undefined ? String(category).trim() : existing.category;
        const finalManufacturer = manufacturer !== undefined ? String(manufacturer).trim() : (existing.manufacturer || '');
        const finalSupplier = supplier !== undefined ? String(supplier).trim() : (existing.supplier || '');
        const finalStorageLocation = storageLocation !== undefined ? String(storageLocation).trim() : (existing.storage_location || '');
        const finalTaxRate = taxRate !== undefined ? parseFloat(taxRate) : ((existing.tax_rate !== null && existing.tax_rate !== undefined) ? existing.tax_rate : 19.0);
        const finalDescription = description !== undefined ? String(description).trim() : (existing.description || '');
        const finalImageUrl = imageUrl !== undefined ? String(imageUrl).trim() : (existing.image_url || '');

        const costCents = (costPrice !== undefined && costPrice !== null && costPrice !== '') ? Math.round(parseFloat(costPrice) * 100) : existing.cost_price_cents;
        const sellCents = (sellPrice !== undefined && sellPrice !== null && sellPrice !== '') ? Math.round(parseFloat(sellPrice) * 100) : existing.sell_price_cents;
        const finalStock = (stockQuantity !== undefined && stockQuantity !== null && stockQuantity !== '') ? parseInt(stockQuantity) : existing.stock_quantity;
        const finalMinStock = (minStock !== undefined && minStock !== null && minStock !== '') ? parseInt(minStock) : existing.min_stock;
        const finalUnit = unit !== undefined ? unit : existing.unit;

        const now = new Date().toISOString();
        const newVersion = existing.version + 1;

        db.prepare(`
            UPDATE products SET
                store_id = ?,
                name = ?,
                barcode = ?,
                sku = ?,
                category = ?,
                manufacturer = ?,
                supplier = ?,
                storage_location = ?,
                tax_rate = ?,
                description = ?,
                image_url = ?,
                cost_price_cents = ?,
                sell_price_cents = ?,
                stock_quantity = ?,
                min_stock = ?,
                unit = ?,
                updated_at = ?,
                version = ?
            WHERE id = ?
        `).run(
            finalStoreId, finalName, finalBarcode, finalSku, finalCategory,
            finalManufacturer, finalSupplier, finalStorageLocation, finalTaxRate,
            finalDescription, finalImageUrl,
            costCents, sellCents, finalStock, finalMinStock, finalUnit,
            now, newVersion, req.params.id
        );

        // Record stock movement if stock was changed manually in edit form
        if (finalStock !== existing.stock_quantity) {
            const delta = finalStock - existing.stock_quantity;
            const movementId = `sm_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            db.prepare(`
                INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, previous_stock, new_stock, reason, created_by, created_at)
                VALUES (?, ?, ?, 'correction', ?, ?, ?, 'Manuelle Bestandskorrektur im Artikel-Editor', ?, ?)
            `).run(movementId, req.params.id, finalStoreId || null, delta, existing.stock_quantity, finalStock, req.user.username, now);
        }

        const updated = {
            id: req.params.id,
            storeId: finalStoreId,
            name: finalName,
            barcode: finalBarcode,
            sku: finalSku,
            category: finalCategory,
            manufacturer: finalManufacturer,
            supplier: finalSupplier,
            storageLocation: finalStorageLocation,
            taxRate: finalTaxRate,
            description: finalDescription,
            imageUrl: finalImageUrl,
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
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Bearbeiten des Artikels', details: err.message });
    }
};

router.put('/products/:id', requireAuth, updateProductHandler);
router.patch('/products/:id', requireAuth, updateProductHandler);

// 4. Delete Product (Soft delete)
router.delete('/products/:id', requireAuth, requireRole(['admin', 'manager']), (req, res) => {
    try {
        const existing = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Artikel nicht gefunden.' });

        const now = new Date().toISOString();
        db.prepare('UPDATE products SET is_deleted = 1, updated_at = ?, version = version + 1 WHERE id = ?').run(now, req.params.id);

        logAudit('product', req.params.id, 'DELETE', req.user.username, existing, null, req.ip);
        broadcastEvent('PRODUCT_CHANGED', { action: 'DELETE', id: req.params.id });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Löschen des Artikels', details: err.message });
    }
});

// 5. Stock Movement Action (Fast Stock Adjustment: Inbound, Outbound, Correction, Inventory)
router.post('/products/:id/stock-movement', requireAuth, (req, res) => {
    try {
        const existing = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Artikel nicht gefunden.' });

        const { delta, movementType = 'correction', reason = '', storeId } = req.body;
        const deltaNum = parseInt(delta);
        if (isNaN(deltaNum) || deltaNum === 0) {
            return res.status(400).json({ error: 'Ungültige Bestandsveränderung (delta muss != 0 sein).' });
        }

        const validTypes = ['inbound', 'outbound', 'correction', 'inventory'];
        const finalType = validTypes.includes(movementType) ? movementType : 'correction';

        const previousStock = existing.stock_quantity;
        const newStock = Math.max(0, previousStock + deltaNum);
        const actualDelta = newStock - previousStock;
        const now = new Date().toISOString();
        const newVersion = existing.version + 1;
        const targetStoreId = storeId || existing.store_id;

        const movementId = `sm_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        const applyMovement = db.transaction(() => {
            db.prepare('UPDATE products SET stock_quantity = ?, updated_at = ?, version = ? WHERE id = ?')
              .run(newStock, now, newVersion, req.params.id);

            db.prepare(`
                INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, previous_stock, new_stock, reason, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(movementId, req.params.id, targetStoreId || null, finalType, actualDelta, previousStock, newStock, reason || '', req.user.username, now);
        });

        applyMovement();

        const updatedProduct = {
            id: existing.id,
            storeId: targetStoreId,
            name: existing.name,
            barcode: existing.barcode || '',
            sku: existing.sku || '',
            category: existing.category || 'Allgemein',
            manufacturer: existing.manufacturer || '',
            supplier: existing.supplier || '',
            storageLocation: existing.storage_location || '',
            taxRate: (existing.tax_rate !== null && existing.tax_rate !== undefined) ? existing.tax_rate : 19.0,
            description: existing.description || '',
            imageUrl: existing.image_url || '',
            costPrice: existing.cost_price_cents / 100,
            sellPrice: existing.sell_price_cents / 100,
            stockQuantity: newStock,
            minStock: existing.min_stock,
            unit: existing.unit || 'Stück',
            updatedBy: req.user.username,
            updatedAt: now,
            version: newVersion
        };

        const movement = {
            id: movementId,
            productId: req.params.id,
            productName: existing.name,
            storeId: targetStoreId,
            movementType: finalType,
            quantity: actualDelta,
            previousStock,
            newStock,
            reason: reason || '',
            createdBy: req.user.username,
            createdAt: now
        };

        logAudit('stock_movement', movementId, 'STOCK_ADJUSTMENT', req.user.username, { previousStock }, { newStock, actualDelta }, req.ip);
        broadcastEvent('PRODUCT_CHANGED', { action: 'UPDATE', product: updatedProduct });
        broadcastEvent('STOCK_MOVEMENT', { movement });

        res.json({ success: true, product: updatedProduct, movement });
    } catch (err) {
        res.status(500).json({ error: 'Fehler bei der Lagerbuchung', details: err.message });
    }
});

// 6. Get Movements for a specific product
router.get('/products/:id/movements', requireAuth, (req, res) => {
    try {
        const movements = db.prepare(`
            SELECT * FROM stock_movements
            WHERE product_id = ?
            ORDER BY created_at DESC
            LIMIT 100
        `).all(req.params.id);
        res.json(movements);
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Abrufen der Lagerbewegungen', details: err.message });
    }
});

// 7. Get Recent Global Stock Movements
router.get('/stock-movements', requireAuth, (req, res) => {
    try {
        const movements = db.prepare(`
            SELECT m.*, p.name as product_name, p.barcode as product_barcode, p.sku as product_sku
            FROM stock_movements m
            JOIN products p ON m.product_id = p.id
            ORDER BY m.created_at DESC
            LIMIT 150
        `).all();
        res.json(movements);
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Abrufen des Lagerprotokolls', details: err.message });
    }
});

// 8. Bulk CSV Import with Duplicate Strategy (update, skip, create)
router.post('/products/import-csv', requireAuth, requireRole(['admin', 'manager']), (req, res) => {
    try {
        const { items, duplicateStrategy = 'update' } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Keine gültigen Artikeldaten zum Importieren übergeben.' });
        }

        let importedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        const errors = [];

        const now = new Date().toISOString();

        const insertStmt = db.prepare(`
            INSERT INTO products (
                id, store_id, name, barcode, sku, category,
                manufacturer, supplier, storage_location, tax_rate,
                description, image_url,
                cost_price_cents, sell_price_cents, stock_quantity, min_stock, unit,
                created_at, updated_at, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);

        const updateStmt = db.prepare(`
            UPDATE products SET
                name = COALESCE(?, name),
                category = COALESCE(?, category),
                manufacturer = COALESCE(?, manufacturer),
                supplier = COALESCE(?, supplier),
                storage_location = COALESCE(?, storage_location),
                tax_rate = COALESCE(?, tax_rate),
                description = COALESCE(?, description),
                cost_price_cents = COALESCE(?, cost_price_cents),
                sell_price_cents = COALESCE(?, sell_price_cents),
                stock_quantity = COALESCE(?, stock_quantity),
                min_stock = COALESCE(?, min_stock),
                unit = COALESCE(?, unit),
                updated_at = ?,
                version = version + 1
            WHERE id = ?
        `);

        const findByBarcode = db.prepare("SELECT * FROM products WHERE barcode = ? AND barcode IS NOT NULL AND barcode != '' AND is_deleted = 0 LIMIT 1");
        const findBySku = db.prepare("SELECT * FROM products WHERE sku = ? AND sku IS NOT NULL AND sku != '' AND is_deleted = 0 LIMIT 1");

        const runImport = db.transaction(() => {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const rowNum = i + 1;

                if (!item.name || !String(item.name).trim()) {
                    errors.push({ row: rowNum, error: 'Artikelname fehlt' });
                    continue;
                }

                function sanitizeInputFormula(val) {
                    if (!val || typeof val !== 'string') return val;
                    const t = val.trim();
                    if (t.startsWith('=') || t.startsWith('+') || t.startsWith('-') || t.startsWith('@')) {
                        return "'" + t;
                    }
                    return t;
                }

                const name = sanitizeInputFormula(String(item.name).trim());
                const barcode = item.barcode ? String(item.barcode).trim() : null;
                const sku = item.sku ? String(item.sku).trim() : null;
                const category = item.category ? sanitizeInputFormula(String(item.category).trim()) : 'Allgemein';
                const manufacturer = item.manufacturer ? sanitizeInputFormula(String(item.manufacturer).trim()) : '';
                const supplier = item.supplier ? sanitizeInputFormula(String(item.supplier).trim()) : '';
                const storageLocation = (item.storageLocation !== undefined ? item.storageLocation : item.storage_location) ? sanitizeInputFormula(String(item.storageLocation || item.storage_location).trim()) : '';
                const taxRateRaw = item.taxRate !== undefined ? item.taxRate : item.tax_rate;
                const taxRate = (taxRateRaw !== undefined && taxRateRaw !== null && taxRateRaw !== '') ? parseFloat(taxRateRaw) : 19.0;
                const description = (item.description !== undefined ? item.description : item.description) ? sanitizeInputFormula(String(item.description).trim()) : '';
                const imageUrl = (item.imageUrl !== undefined ? item.imageUrl : item.image_url) ? String(item.imageUrl || item.image_url).trim() : '';

                const costPriceRaw = item.costPrice !== undefined ? item.costPrice : item.cost_price;
                const sellPriceRaw = item.sellPrice !== undefined ? item.sellPrice : item.sell_price;
                const stockRaw = item.stockQuantity !== undefined ? item.stockQuantity : item.stock_quantity;
                const minStockRaw = item.minStock !== undefined ? item.minStock : item.min_stock;

                const costCents = Math.round((parseFloat(costPriceRaw) || 0) * 100);
                const sellCents = Math.round((parseFloat(sellPriceRaw) || 0) * 100);
                const stock = (stockRaw !== undefined && stockRaw !== null && stockRaw !== '') ? parseInt(stockRaw) : 0;
                const minStock = (minStockRaw !== undefined && minStockRaw !== null && minStockRaw !== '') ? parseInt(minStockRaw) : 3;
                const unit = item.unit ? String(item.unit).trim() : 'Stück';

                // Check for existing duplicate
                let existing = null;
                if (barcode) existing = findByBarcode.get(barcode);
                if (!existing && sku) existing = findBySku.get(sku);

                if (existing) {
                    if (duplicateStrategy === 'skip') {
                        skippedCount++;
                        continue;
                    } else if (duplicateStrategy === 'update') {
                        updateStmt.run(
                            name, category, manufacturer, supplier, storageLocation, taxRate, description,
                            costCents, sellCents, stock, minStock, unit, now, existing.id
                        );
                        updatedCount++;
                        continue;
                    }
                    // If strategy is 'create', fall through to insert
                }

                // Insert new product
                const newId = `prod_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_${i}`;
                insertStmt.run(
                    newId, item.storeId || null, name, barcode, sku, category,
                    manufacturer, supplier, storageLocation, taxRate, description, imageUrl,
                    costCents, sellCents, stock, minStock, unit, now, now
                );
                importedCount++;
            }
        });

        runImport();

        logAudit('products', 'bulk_import', 'CSV_IMPORT', req.user.username, null, { importedCount, updatedCount, skippedCount, errorsCount: errors.length }, req.ip);
        broadcastEvent('PRODUCT_CHANGED', { action: 'BATCH_IMPORT', count: importedCount + updatedCount });

        res.json({
            success: true,
            imported: importedCount,
            updated: updatedCount,
            skipped: skippedCount,
            errors,
            message: `CSV-Import erfolgreich: ${importedCount} neu angelegt, ${updatedCount} aktualisiert, ${skippedCount} übersprungen.`
        });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim CSV-Import', details: err.message });
    }
});

// 9. Export Products as Standard CSV with UTF-8 BOM & Injection Protection
router.get('/products/export-csv', requireAuth, (req, res) => {
    try {
        const { storeId } = req.query;
        let query = 'SELECT * FROM products WHERE is_deleted = 0';
        const params = [];
        if (storeId && storeId !== 'ALL') {
            query += ' AND (store_id = ? OR store_id IS NULL)';
            params.push(storeId);
        }
        query += ' ORDER BY name ASC';
        const products = db.prepare(query).all(...params);

        // Header row
        const headers = [
            'Artikelnummer (SKU)',
            'EAN / Barcode',
            'Artikelname',
            'Kategorie',
            'Hersteller',
            'Lieferant',
            'Lagerort',
            'Einkaufspreis EUR',
            'Verkaufspreis EUR',
            'MwSt Prozent',
            'Lagerbestand',
            'Mindestbestand',
            'Einheit',
            'Beschreibung'
        ];

        let csv = '\uFEFF' + headers.join(';') + '\n';

        for (const p of products) {
            const row = [
                sanitizeCsvValue(p.sku || ''),
                sanitizeCsvValue(p.barcode || ''),
                sanitizeCsvValue(p.name || ''),
                sanitizeCsvValue(p.category || 'Allgemein'),
                sanitizeCsvValue(p.manufacturer || ''),
                sanitizeCsvValue(p.supplier || ''),
                sanitizeCsvValue(p.storage_location || ''),
                sanitizeCsvValue(((p.cost_price_cents || 0) / 100).toFixed(2).replace('.', ',')),
                sanitizeCsvValue(((p.sell_price_cents || 0) / 100).toFixed(2).replace('.', ',')),
                sanitizeCsvValue(p.tax_rate !== null ? p.tax_rate : 19.0),
                sanitizeCsvValue(p.stock_quantity || 0),
                sanitizeCsvValue(p.min_stock || 0),
                sanitizeCsvValue(p.unit || 'Stück'),
                sanitizeCsvValue(p.description || '')
            ];
            csv += row.join(';') + '\n';
        }

        const filename = `StoreControl_Warenwirtschaft_${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim CSV-Export', details: err.message });
    }
});

// 8. Get Single Product by ID (Placed after export-csv and import-csv to prevent route collisions)
router.get('/products/:id', requireAuth, (req, res) => {
    try {
        const p = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(req.params.id);
        if (!p) return res.status(404).json({ error: 'Artikel nicht gefunden.' });

        const formatted = {
            id: p.id,
            storeId: p.store_id,
            store_id: p.store_id,
            name: p.name,
            barcode: p.barcode || '',
            sku: p.sku || '',
            category: p.category || 'Allgemein',
            manufacturer: p.manufacturer || '',
            supplier: p.supplier || '',
            storageLocation: p.storage_location || '',
            storage_location: p.storage_location || '',
            taxRate: p.tax_rate !== null ? p.tax_rate : 19.0,
            tax_rate: p.tax_rate !== null ? p.tax_rate : 19.0,
            description: p.description || '',
            imageUrl: p.image_url || '',
            image_url: p.image_url || '',
            costPrice: (p.cost_price_cents || 0) / 100,
            cost_price: (p.cost_price_cents || 0) / 100,
            sellPrice: (p.sell_price_cents || 0) / 100,
            sell_price: (p.sell_price_cents || 0) / 100,
            stockQuantity: p.stock_quantity !== undefined ? p.stock_quantity : 0,
            stock_quantity: p.stock_quantity !== undefined ? p.stock_quantity : 0,
            minStock: p.min_stock !== undefined ? p.min_stock : 0,
            min_stock: p.min_stock !== undefined ? p.min_stock : 0,
            unit: p.unit || 'Stück',
            createdAt: p.created_at,
            updatedAt: p.updated_at,
            version: p.version
        };
        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Abrufen des Artikels', details: err.message });
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
// OFFLINE SYNC API (Reconcile, Push & Pull)
// =============================================================================

/**
 * Reconciles local pending or queued items against the central SQLite database.
 * If an item is already present (by id or content match), returns the canonical server record.
 * If an item is NOT present, safely persists it to the database.
 * Prevents duplicates, guarantees zero data loss, and enables the client to clear pending flags immediately.
 */
router.post("/sync/reconcile", requireAuth, (req, res) => {
    let items = req.body.items || [];
    if (!Array.isArray(items)) {
        items = [];
        if (Array.isArray(req.body.revenues)) items.push(...req.body.revenues.map(d => ({ type: "CREATE_REVENUE", data: d, tempId: d.id })));
        if (Array.isArray(req.body.expenses)) items.push(...req.body.expenses.map(d => ({ type: "CREATE_EXPENSE", data: d, tempId: d.id })));
        if (Array.isArray(req.body.products)) items.push(...req.body.products.map(d => ({ type: "CREATE_PRODUCT", data: d, tempId: d.id })));
        if (Array.isArray(req.body.stores)) items.push(...req.body.stores.map(d => ({ type: "CREATE_STORE", data: d, tempId: d.id })));
    }

    if (items.length === 0) {
        return res.json({ success: true, reconciled: [] });
    }

    const reconciled = [];
    const now = new Date().toISOString();

    const runReconcile = db.transaction(() => {
        for (const item of items) {
            const data = item.data || item;
            const originalId = item.tempId || data.id || null;
            let type = (item.type || "").toUpperCase().trim();
            if (!type) {
                if (data.cash !== undefined || data.card !== undefined || data.cash_cents !== undefined) type = "CREATE_REVENUE";
                else if (data.category && data.amount !== undefined) type = "CREATE_EXPENSE";
                else if (data.costPrice !== undefined || data.sellPrice !== undefined) type = "CREATE_PRODUCT";
                else if (data.targetRevenue !== undefined) type = "CREATE_STORE";
                else type = "CREATE_REVENUE";
            }

            if (type.includes("REVENUE")) {
                let existing = null;
                if (originalId) {
                    existing = db.prepare("SELECT * FROM revenues WHERE id = ? AND is_deleted = 0").get(originalId);
                }
                const cashCents = data.cashCents !== undefined ? data.cashCents : (data.cash_cents !== undefined ? data.cash_cents : Math.round((parseFloat(data.cash) || 0) * 100));
                const cardCents = data.cardCents !== undefined ? data.cardCents : (data.card_cents !== undefined ? data.card_cents : Math.round((parseFloat(data.card) || 0) * 100));
                const totalCents = cashCents + cardCents;
                let storeId = data.storeId || data.store_id;

                if (!storeId || !db.prepare("SELECT id FROM stores WHERE id = ?").get(storeId)) {
                    const fallback = db.prepare("SELECT id FROM stores WHERE is_deleted = 0 ORDER BY created_at ASC LIMIT 1").get();
                    storeId = fallback ? fallback.id : (storeId || null);
                }

                if (!existing && storeId && data.date) {
                    existing = db.prepare("SELECT * FROM revenues WHERE store_id = ? AND date = ? AND cash_cents = ? AND card_cents = ? AND is_deleted = 0").get(storeId, data.date, cashCents, cardCents);
                }

                if (existing) {
                    reconciled.push({
                        originalId,
                        serverId: existing.id,
                        action: "MATCHED",
                        record: {
                            id: existing.id,
                            storeId: existing.store_id,
                            date: existing.date,
                            cash: existing.cash_cents / 100,
                            card: existing.card_cents / 100,
                            total: existing.total_cents / 100,
                            note: existing.note || "",
                            createdBy: existing.created_by,
                            createdAt: existing.created_at,
                            updatedAt: existing.updated_at,
                            version: existing.version,
                            _pendingSync: false
                        }
                    });
                } else if (storeId && data.date) {
                    const newId = (originalId && !originalId.startsWith("temp_")) ? originalId : "rev_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
                    db.prepare("INSERT INTO revenues (id, store_id, date, cash_cents, card_cents, total_cents, note, created_by, updated_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").run(newId, storeId, data.date, cashCents, cardCents, totalCents, data.note || "", req.user.username, req.user.username, now, now);

                    logAudit("revenue", newId, "RECONCILE_INSERT", req.user.username, null, data, req.ip);

                    reconciled.push({
                        originalId,
                        serverId: newId,
                        action: "INSERTED",
                        record: {
                            id: newId,
                            storeId,
                            date: data.date,
                            cash: cashCents / 100,
                            card: cardCents / 100,
                            total: totalCents / 100,
                            note: data.note || "",
                            createdBy: req.user.username,
                            createdAt: now,
                            updatedAt: now,
                            version: 1,
                            _pendingSync: false
                        }
                    });
                }
            } else if (type.includes("EXPENSE")) {
                let existing = null;
                if (originalId) {
                    existing = db.prepare("SELECT * FROM expenses WHERE id = ? AND is_deleted = 0").get(originalId);
                }
                const amountCents = data.amountCents !== undefined ? data.amountCents : (data.amount_cents !== undefined ? data.amount_cents : Math.round((parseFloat(data.amount) || 0) * 100));
                let storeId = data.storeId || data.store_id;

                if (!storeId || !db.prepare("SELECT id FROM stores WHERE id = ?").get(storeId)) {
                    const fallback = db.prepare("SELECT id FROM stores WHERE is_deleted = 0 ORDER BY created_at ASC LIMIT 1").get();
                    storeId = fallback ? fallback.id : (storeId || null);
                }

                if (!existing && storeId && data.date && data.category) {
                    existing = db.prepare("SELECT * FROM expenses WHERE store_id = ? AND date = ? AND category = ? AND amount_cents = ? AND is_deleted = 0").get(storeId, data.date, data.category, amountCents);
                }

                if (existing) {
                    reconciled.push({
                        originalId,
                        serverId: existing.id,
                        action: "MATCHED",
                        record: {
                            id: existing.id,
                            storeId: existing.store_id,
                            category: existing.category,
                            date: existing.date,
                            amount: existing.amount_cents / 100,
                            title: existing.title || "",
                            note: existing.note || "",
                            createdBy: existing.created_by,
                            createdAt: existing.created_at,
                            updatedAt: existing.updated_at,
                            version: existing.version,
                            _pendingSync: false
                        }
                    });
                } else if (storeId && data.date && data.category) {
                    const newId = (originalId && !originalId.startsWith("temp_")) ? originalId : "exp_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
                    db.prepare("INSERT INTO expenses (id, store_id, category, date, amount_cents, title, note, created_by, updated_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").run(newId, storeId, data.category, data.date, amountCents, data.title || "", data.note || "", req.user.username, req.user.username, now, now);

                    logAudit("expense", newId, "RECONCILE_INSERT", req.user.username, null, data, req.ip);

                    reconciled.push({
                        originalId,
                        serverId: newId,
                        action: "INSERTED",
                        record: {
                            id: newId,
                            storeId,
                            category: data.category,
                            date: data.date,
                            amount: amountCents / 100,
                            title: data.title || "",
                            note: data.note || "",
                            createdBy: req.user.username,
                            createdAt: now,
                            updatedAt: now,
                            version: 1,
                            _pendingSync: false
                        }
                    });
                }
            } else if (type.includes("PRODUCT")) {
                let existing = null;
                if (originalId) {
                    existing = db.prepare("SELECT * FROM products WHERE id = ? AND is_deleted = 0").get(originalId);
                }
                if (!existing && data.barcode) {
                    existing = db.prepare("SELECT * FROM products WHERE barcode = ? AND is_deleted = 0").get(data.barcode);
                }
                if (!existing && data.name) {
                    existing = db.prepare("SELECT * FROM products WHERE name = ? AND is_deleted = 0").get(data.name);
                }

                if (existing) {
                    reconciled.push({
                        originalId,
                        serverId: existing.id,
                        action: "MATCHED",
                        record: {
                            id: existing.id,
                            name: existing.name,
                            sku: existing.sku || "",
                            barcode: existing.barcode || "",
                            category: existing.category || "General",
                            costPrice: existing.cost_price_cents / 100,
                            sellPrice: existing.sell_price_cents / 100,
                            stockQuantity: existing.stock_quantity,
                            minStock: existing.min_stock,
                            storeId: existing.store_id,
                            createdBy: existing.created_by,
                            createdAt: existing.created_at,
                            updatedAt: existing.updated_at,
                            version: existing.version,
                            _pendingSync: false
                        }
                    });
                } else if (data.name) {
                    const newId = (originalId && !originalId.startsWith("temp_")) ? originalId : "prod_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
                    const costPriceCents = Math.round((parseFloat(data.costPrice) || 0) * 100);
                    const sellPriceCents = Math.round((parseFloat(data.sellPrice) || 0) * 100);

                    db.prepare("INSERT INTO products (id, name, sku, barcode, category, cost_price_cents, sell_price_cents, stock_quantity, min_stock, store_id, created_by, updated_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").run(newId, data.name, data.sku || "", data.barcode || "", data.category || "General", costPriceCents, sellPriceCents, data.stockQuantity || 0, data.minStock || 0, data.storeId || null, req.user.username, req.user.username, now, now);

                    logAudit("product", newId, "RECONCILE_INSERT", req.user.username, null, data, req.ip);

                    reconciled.push({
                        originalId,
                        serverId: newId,
                        action: "INSERTED",
                        record: {
                            id: newId,
                            name: data.name,
                            sku: data.sku || "",
                            barcode: data.barcode || "",
                            category: data.category || "General",
                            costPrice: costPriceCents / 100,
                            sellPrice: sellPriceCents / 100,
                            stockQuantity: data.stockQuantity || 0,
                            minStock: data.minStock || 0,
                            storeId: data.storeId || null,
                            createdBy: req.user.username,
                            createdAt: now,
                            updatedAt: now,
                            version: 1,
                            _pendingSync: false
                        }
                    });
                }
            } else if (type.includes("STORE")) {
                let existing = null;
                if (originalId) {
                    existing = db.prepare("SELECT * FROM stores WHERE id = ? AND is_deleted = 0").get(originalId);
                }
                if (!existing && data.name) {
                    existing = db.prepare("SELECT * FROM stores WHERE name = ? AND is_deleted = 0").get(data.name);
                }

                if (existing) {
                    reconciled.push({
                        originalId,
                        serverId: existing.id,
                        action: "MATCHED",
                        record: {
                            id: existing.id,
                            name: existing.name,
                            address: existing.address || "",
                            manager: existing.manager || "",
                            phone: existing.phone || "",
                            color: existing.color || "emerald",
                            employeeCount: existing.employee_count,
                            targetRevenue: existing.target_revenue_cents / 100,
                            createdAt: existing.created_at,
                            updatedAt: existing.updated_at,
                            version: existing.version,
                            _pendingSync: false
                        }
                    });
                } else if (data.name) {
                    const newId = (originalId && !originalId.startsWith("temp_")) ? originalId : "store_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
                    const targetCents = Math.round((parseFloat(data.targetRevenue) || 0) * 100);

                    db.prepare("INSERT INTO stores (id, name, address, manager, phone, color, employee_count, target_revenue_cents, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").run(newId, data.name, data.address || "", data.manager || "", data.phone || "", data.color || "emerald", data.employeeCount || 2, targetCents, now, now);

                    logAudit("store", newId, "RECONCILE_INSERT", req.user.username, null, data, req.ip);

                    reconciled.push({
                        originalId,
                        serverId: newId,
                        action: "INSERTED",
                        record: {
                            id: newId,
                            name: data.name,
                            address: data.address || "",
                            manager: data.manager || "",
                            phone: data.phone || "",
                            color: data.color || "emerald",
                            employeeCount: data.employeeCount || 2,
                            targetRevenue: targetCents / 100,
                            createdAt: now,
                            updatedAt: now,
                            version: 1,
                            _pendingSync: false
                        }
                    });
                }
            }
        }
    });

    try {
        runReconcile();
        res.json({ success: true, reconciled });
    } catch (err) {
        console.error("Reconcile Transaction Error:", err);
        res.status(500).json({ error: "Fehler beim Datenbank-Abgleich: " + err.message });
    }
});

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
                    `).run((data.storeId || data.store_id) || existing.store_id, (data.date && String(data.date).trim()) ? String(data.date).trim() : existing.date, cashCents, cardCents, totalCents, data.note !== undefined ? (data.note === null ? '' : String(data.note).trim()) : (existing.note || ''), req.user.username, now, newVersion, data.id);

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
