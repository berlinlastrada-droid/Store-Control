const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, logAudit } = require('./db');

const SECRET_KEY = process.env.SESSION_SECRET || 'storecontrol_super_secret_key_change_in_prod_' + (process.env.COMPUTERNAME || 'pc');

// In-memory active tokens cache for instant lookups
const activeSessions = new Map();

function generateToken(user) {
    const payload = {
        userId: user.id,
        username: user.username,
        role: user.role,
        timestamp: Date.now()
    };
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(payloadStr).digest('base64url');
    const token = `${payloadStr}.${signature}`;

    // Token valid for 365 days for business app usage
    const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
    activeSessions.set(token, { user: getPublicUser(user), expiresAt });
    return token;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadStr, signature] = parts;
    const expectedSignature = crypto.createHmac('sha256', SECRET_KEY).update(payloadStr).digest('base64url');

    try {
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
            return null;
        }
        const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));
        const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(payload.userId);
        if (!user) return null;

        return getPublicUser(user);
    } catch (e) {
        return null;
    }
}

function getPublicUser(user) {
    if (!user) return null;
    const { password_hash, ...publicUser } = user;
    return publicUser;
}

function authenticateUser(username, password) {
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
    if (!user) return null;

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return null;

    return user;
}

// =============================================================================
// PERSISTENT DEVICE PAIRING & TOKEN MANAGEMENT
// =============================================================================

function createPairingCode(userId) {
    // Generate secure 16-character alphanumeric pairing token
    const code = 'sc_pair_' + crypto.randomBytes(8).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString(); // 15 minutes validity

    db.prepare(`
        INSERT INTO device_pairings (code, user_id, created_at, expires_at, is_used)
        VALUES (?, ?, ?, ?, 0)
    `).run(code, userId, now.toISOString(), expiresAt);

    return { code, expiresAt };
}

function redeemPairingCode(code, deviceName = 'Smartphone', ipAddress = null) {
    if (!code || typeof code !== 'string') {
        return { error: 'Ungültiger Kopplungscode.' };
    }

    const trimmedCode = code.trim();
    const pairing = db.prepare(`
        SELECT * FROM device_pairings 
        WHERE code = ? AND is_used = 0
    `).get(trimmedCode);

    if (!pairing) {
        return { error: 'Kopplungscode wurde nicht gefunden oder wurde bereits verwendet.' };
    }

    const now = new Date();
    if (new Date(pairing.expires_at) < now) {
        return { error: 'Dieser Kopplungscode ist abgelaufen. Bitte auf dem PC neu öffnen.' };
    }

    // Mark as used
    db.prepare('UPDATE device_pairings SET is_used = 1 WHERE code = ?').run(trimmedCode);

    // Retrieve paired user
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(pairing.user_id);
    if (!user) {
        return { error: 'Zugeordneter Benutzer existiert nicht oder ist deaktiviert.' };
    }

    // Generate permanent 256-bit device token
    const rawDeviceToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawDeviceToken).digest('hex');
    const deviceId = 'dev_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const isoNow = now.toISOString();

    db.prepare(`
        INSERT INTO device_sessions (id, user_id, device_token_hash, device_name, created_at, last_used_at, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(deviceId, user.id, tokenHash, String(deviceName || 'Smartphone').slice(0, 100), isoNow, isoNow);

    logAudit('device', deviceId, 'DEVICE_PAIRED', user.username, null, { deviceName, deviceId }, ipAddress);

    const sessionToken = generateToken(user);
    return {
        success: true,
        deviceId,
        deviceToken: rawDeviceToken,
        sessionToken,
        user: getPublicUser(user)
    };
}

function verifyDeviceToken(deviceToken) {
    if (!deviceToken || typeof deviceToken !== 'string') return null;

    try {
        const tokenHash = crypto.createHash('sha256').update(deviceToken.trim()).digest('hex');
        const session = db.prepare(`
            SELECT s.id AS session_id, s.device_name, s.user_id, u.*
            FROM device_sessions s
            JOIN users u ON s.user_id = u.id
            WHERE s.device_token_hash = ? AND s.is_active = 1 AND u.is_active = 1
        `).get(tokenHash);

        if (!session) return null;

        // Update last used timestamp
        const now = new Date().toISOString();
        db.prepare('UPDATE device_sessions SET last_used_at = ? WHERE id = ?').run(now, session.session_id);

        return {
            id: session.user_id,
            username: session.username,
            display_name: session.display_name,
            role: session.role,
            store_id: session.store_id,
            deviceId: session.session_id,
            deviceName: session.device_name
        };
    } catch (e) {
        console.error('verifyDeviceToken error:', e);
        return null;
    }
}

function listUserDevices(userId) {
    try {
        return db.prepare(`
            SELECT id, device_name, created_at, last_used_at, is_active
            FROM device_sessions
            WHERE user_id = ? AND is_active = 1
            ORDER BY last_used_at DESC
        `).all(userId);
    } catch (e) {
        return [];
    }
}

function revokeDevice(deviceId, userId = null) {
    try {
        if (userId) {
            db.prepare('UPDATE device_sessions SET is_active = 0 WHERE id = ? AND user_id = ?').run(deviceId, userId);
        } else {
            db.prepare('UPDATE device_sessions SET is_active = 0 WHERE id = ?').run(deviceId);
        }
        return true;
    } catch (e) {
        return false;
    }
}

function requireAuth(req, res, next) {
    let token = null;
    let isDeviceToken = false;

    // 1. Check X-Device-Token header (persistent smartphone token)
    const deviceHeader = req.headers['x-device-token'];
    if (deviceHeader) {
        token = deviceHeader;
        isDeviceToken = true;
    }

    // 2. Check Authorization header
    const authHeader = req.headers['authorization'];
    if (!token && authHeader) {
        if (authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7).trim();
        } else if (authHeader.startsWith('Device ')) {
            token = authHeader.substring(7).trim();
            isDeviceToken = true;
        }
    }

    // 3. Check query param or x-api-token
    if (!token) {
        if (req.query && req.query.token) {
            token = req.query.token;
        } else if (req.headers['x-api-token']) {
            token = req.headers['x-api-token'];
        }
    }

    if (!token) {
        return res.status(401).json({ error: 'Nicht autorisiert. Bitte melden Sie sich an.' });
    }

    // First try device token if flagged or formatted as hex token
    let user = null;
    if (isDeviceToken || (token.length === 64 && !token.includes('.'))) {
        user = verifyDeviceToken(token);
    }

    // Next try standard session token
    if (!user) {
        user = verifyToken(token);
    }

    // Fallback: check if standard token field was actually a device token
    if (!user && token.length === 64) {
        user = verifyDeviceToken(token);
    }

    if (!user) {
        return res.status(401).json({ error: 'Ungültige oder abgelaufene Sitzung. Bitte neu anmelden.' });
    }

    req.user = user;
    next();
}

function requireRole(allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Nicht autorisiert' });
        }
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ 
                error: `Zugriff verweigert. Erforderliche Rolle: ${allowedRoles.join(' oder ')}, Ihre Rolle: ${req.user.role}` 
            });
        }
        next();
    };
}

module.exports = {
    authenticateUser,
    generateToken,
    verifyToken,
    getPublicUser,
    createPairingCode,
    redeemPairingCode,
    verifyDeviceToken,
    listUserDevices,
    revokeDevice,
    requireAuth,
    requireRole
};
