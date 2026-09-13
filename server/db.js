const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'storecontrol.db');
const initialDb = path.join(dataDir, 'initial_storecontrol.db');
if (!fs.existsSync(dbPath) && fs.existsSync(initialDb)) {
    console.log('[DB] Neues Volume: Initialisiere Datenbank mit echten Geschaeftsdaten...');
    fs.copyFileSync(initialDb, dbPath);
}
const db = new Database(dbPath);

// Performance & Integrity settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

function initSchema() {
    // 1. Settings Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);

    // 2. Users Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'employee')),
            store_id TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);

    // 3. Stores Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS stores (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            address TEXT,
            manager TEXT,
            phone TEXT,
            color TEXT DEFAULT 'emerald',
            employee_count INTEGER DEFAULT 2,
            target_revenue_cents INTEGER DEFAULT 0,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_stores_deleted ON stores(is_deleted);
    `);

    // 4. Revenues Table (Integer Cents for exact precision!)
    db.exec(`
        CREATE TABLE IF NOT EXISTS revenues (
            id TEXT PRIMARY KEY,
            store_id TEXT NOT NULL REFERENCES stores(id),
            date TEXT NOT NULL, -- YYYY-MM-DD
            cash_cents INTEGER NOT NULL DEFAULT 0,
            card_cents INTEGER NOT NULL DEFAULT 0,
            total_cents INTEGER NOT NULL DEFAULT 0,
            note TEXT,
            created_by TEXT,
            updated_by TEXT,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_revenues_store_date ON revenues(store_id, date);
        CREATE INDEX IF NOT EXISTS idx_revenues_date ON revenues(date);
        CREATE INDEX IF NOT EXISTS idx_revenues_deleted ON revenues(is_deleted);
    `);

    // 5. Expenses Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS expenses (
            id TEXT PRIMARY KEY,
            store_id TEXT NOT NULL REFERENCES stores(id),
            category TEXT NOT NULL CHECK(category IN ('staff', 'rent', 'goods', 'other')),
            date TEXT NOT NULL, -- YYYY-MM-DD
            amount_cents INTEGER NOT NULL DEFAULT 0,
            title TEXT NOT NULL,
            recurrence TEXT NOT NULL DEFAULT 'single' CHECK(recurrence IN ('single', 'monthly')),
            created_by TEXT,
            updated_by TEXT,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_expenses_store_date ON expenses(store_id, date);
        CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
        CREATE INDEX IF NOT EXISTS idx_expenses_deleted ON expenses(is_deleted);
    `);

    // 6. Products Table (Inventory & Articles)
    db.exec(`
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            store_id TEXT REFERENCES stores(id),
            name TEXT NOT NULL,
            barcode TEXT,
            sku TEXT,
            category TEXT DEFAULT 'Allgemein',
            cost_price_cents INTEGER NOT NULL DEFAULT 0,
            sell_price_cents INTEGER NOT NULL DEFAULT 0,
            stock_quantity INTEGER NOT NULL DEFAULT 0,
            min_stock INTEGER NOT NULL DEFAULT 0,
            unit TEXT DEFAULT 'Stück',
            is_deleted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
        CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
        CREATE INDEX IF NOT EXISTS idx_products_deleted ON products(is_deleted);
    `);

    // 7. Audit Log Table (Full Revision Safety & Traceability)
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL, -- 'revenue', 'expense', 'store', 'product', 'user'
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE', 'SYNC', 'LOGIN'
            changed_by TEXT,
            old_data_json TEXT,
            new_data_json TEXT,
            timestamp TEXT NOT NULL,
            ip_address TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
    `);

    // 8. Device Sessions & Pairing Table (Persistent Smartphone & PC Pairing)
    db.exec(`
        CREATE TABLE IF NOT EXISTS device_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            device_token_hash TEXT UNIQUE NOT NULL,
            device_name TEXT,
            created_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_device_token_hash ON device_sessions(device_token_hash);
        CREATE INDEX IF NOT EXISTS idx_device_user ON device_sessions(user_id);

        CREATE TABLE IF NOT EXISTS device_pairings (
            code TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            is_used INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_pairings_code ON device_pairings(code);
    `);

    seedInitialData();
}

function seedInitialData() {
    // 1. Seed Admin user if no users exist
    const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    if (userCount === 0) {
        const adminId = 'user_admin';
        const salt = bcrypt.genSaltSync(10);
        const hash = bcrypt.hashSync('admin123', salt);
        const now = new Date().toISOString();

        db.prepare(`
            INSERT INTO users (id, username, password_hash, display_name, role, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run(adminId, 'admin', hash, 'Administrator', 'admin', now, now);

        const mgrHash = bcrypt.hashSync('manager123', salt);
        db.prepare(`
            INSERT INTO users (id, username, password_hash, display_name, role, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run('user_manager', 'filialleiter', mgrHash, 'Filialleiter Lisa', 'manager', now, now);

        const cashHash = bcrypt.hashSync('kasse123', salt);
        db.prepare(`
            INSERT INTO users (id, username, password_hash, display_name, role, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run('user_cashier', 'kasse', cashHash, 'Kassierer Tim', 'employee', now, now);

        logAudit('user', adminId, 'CREATE', 'system', null, { username: 'admin', role: 'admin' }, '127.0.0.1');
    }

    // 2. Ensure the 3 real store containers exist if stores table is completely empty
    // NO DEMO REVENUES, NO DEMO EXPENSES, NO TEST PRODUCTS ARE EVER SEEDED!
    const storeCount = db.prepare('SELECT COUNT(*) AS count FROM stores WHERE is_deleted = 0').get().count;
    if (storeCount === 0) {
        const now = new Date().toISOString();
        const insertStore = db.prepare(`
            INSERT INTO stores (id, name, address, manager, phone, color, employee_count, target_revenue_cents, created_at, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)
        `);
        insertStore.run('store_1788358842956_bolf', 'Lichtenberg', '', '', '', 'teal', 3, now, now);
        insertStore.run('store_1788358914508_zv8v', 'Grünau', '', '', '', 'purple', 2, now, now);
        insertStore.run('store_1788358943648_q74l', 'Königs Wusterhausen', '', '', '', 'blue', 1, now, now);
        console.log('[DB] 3 Filial-Container (Lichtenberg, Grünau, Königs Wusterhausen) bereitgestellt (0 Einträge).');
    }
}

/**
 * Log an event to the audit log table
 */
function logAudit(entityType, entityId, action, changedBy, oldData, newData, ipAddress = null) {
    try {
        const stmt = db.prepare(`
            INSERT INTO audit_logs (entity_type, entity_id, action, changed_by, old_data_json, new_data_json, timestamp, ip_address)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            entityType,
            entityId,
            action,
            changedBy || 'system',
            oldData ? JSON.stringify(oldData) : null,
            newData ? JSON.stringify(newData) : null,
            new Date().toISOString(),
            ipAddress || null
        );
    } catch (err) {
        console.error('Failed to log audit event:', err);
    }
}

function getAppSetting(key) {
    try {
        const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
        return row ? row.value : null;
    } catch (err) {
        console.error('getAppSetting error:', err);
        return null;
    }
}

function setAppSetting(key, value) {
    try {
        const now = new Date().toISOString();
        db.prepare(`
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, String(value), now);
        return true;
    } catch (err) {
        console.error('setAppSetting error:', err);
        return false;
    }
}

// Initialize on require
initSchema();
migrateProductsAndStockSchema();

function migrateProductsAndStockSchema() {
    try {
        const columns = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
        if (!columns.includes('manufacturer')) {
            db.exec('ALTER TABLE products ADD COLUMN manufacturer TEXT;');
        }
        if (!columns.includes('supplier')) {
            db.exec('ALTER TABLE products ADD COLUMN supplier TEXT;');
        }
        if (!columns.includes('storage_location')) {
            db.exec('ALTER TABLE products ADD COLUMN storage_location TEXT;');
        }
        if (!columns.includes('tax_rate')) {
            db.exec('ALTER TABLE products ADD COLUMN tax_rate REAL DEFAULT 19.0;');
        }
        if (!columns.includes('description')) {
            db.exec('ALTER TABLE products ADD COLUMN description TEXT;');
        }
        if (!columns.includes('image_url')) {
            db.exec('ALTER TABLE products ADD COLUMN image_url TEXT;');
        }

        // Create stock_movements table
        db.exec(`
            CREATE TABLE IF NOT EXISTS stock_movements (
                id TEXT PRIMARY KEY,
                product_id TEXT NOT NULL REFERENCES products(id),
                store_id TEXT REFERENCES stores(id),
                movement_type TEXT NOT NULL CHECK(movement_type IN ('inbound', 'outbound', 'correction', 'inventory')),
                quantity INTEGER NOT NULL,
                previous_stock INTEGER NOT NULL,
                new_stock INTEGER NOT NULL,
                reason TEXT,
                created_by TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_stock_movements_prod ON stock_movements(product_id);
            CREATE INDEX IF NOT EXISTS idx_stock_movements_store ON stock_movements(store_id);
            CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at);
        `);
    } catch (e) {
        console.error('Migration error in migrateProductsAndStockSchema:', e);
    }
}

ensureInstallationId();

function ensureInstallationId() {
    let instId = getAppSetting('installation_id');
    if (!instId) {
        const crypto = require('crypto');
        instId = 'sc_' + crypto.randomBytes(8).toString('hex');
        setAppSetting('installation_id', instId);
    }
    return instId;
}
ensureInstallationId();


module.exports = {
    db,
    logAudit,
    getAppSetting,
    setAppSetting
};

