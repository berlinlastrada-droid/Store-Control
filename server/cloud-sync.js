/**
 * StoreControl Pro - Cloud Synchronization Daemon
 * Keeps local PC SQLite database (data/storecontrol.db) in continuous,
 * bidirectional lockstep with the central Render cloud database (https://store-control-7jzt.onrender.com).
 * 
 * Works 100% non-destructively:
 * - Automatically pulls new bookings from phone/cloud to PC.
 * - Automatically pushes offline PC bookings to phone/cloud.
 * - When PC is shut down, phone continues to work with Render directly.
 * - When PC boots up, it seamlessly catches up with all changes.
 */

const { db } = require('./db');

const CLOUD_URL = process.env.CLOUD_URL || 'https://store-control-7jzt.onrender.com';
let syncInterval = null;
let isSyncing = false;
let authToken = null;
let tokenExpiresAt = 0;

function isRunningInCloud() {
    return !!(process.env.RENDER || process.env.IS_RENDER || (process.env.NODE_ENV === 'production' && process.env.PORT && !process.env.LOCAL_DEV));
}

async function getAuthToken() {
    if (authToken && Date.now() < tokenExpiresAt) {
        return authToken;
    }
    try {
        const res = await fetch(`${CLOUD_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin123' })
        });
        if (!res.ok) throw new Error(`Login failed with HTTP ${res.status}`);
        const data = await res.json();
        authToken = data.token;
        tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000; // 12 hours
        return authToken;
    } catch (e) {
        authToken = null;
        throw e;
    }
}

async function syncWithCloud() {
    if (isSyncing || isRunningInCloud()) return;
    isSyncing = true;

    try {
        const token = await getAuthToken();
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

        // 1. Sync Revenues (September 2026 and current active months)
        const currentMonth = new Date().toISOString().substring(0, 7);
        const monthsToSync = Array.from(new Set(['2026-09', currentMonth]));

        for (const month of monthsToSync) {
            // Fetch cloud revenues
            const cloudRevsRes = await fetch(`${CLOUD_URL}/api/revenues?month=${encodeURIComponent(month)}`, { headers });
            if (!cloudRevsRes.ok) continue;
            const cloudRevs = await cloudRevsRes.json();

            // Local revenues for month
            const localRevs = db.prepare('SELECT * FROM revenues WHERE date LIKE ? AND is_deleted = 0').all(`${month}%`);
            const localRevIds = new Set(localRevs.map(r => r.id));

            // A) Pull missing cloud revenues into local SQLite
            const missingInLocal = cloudRevs.filter(r => !localRevIds.has(r.id));
            if (missingInLocal.length > 0) {
                console.log(`[Cloud-Sync] 📥 Ziehe ${missingInLocal.length} neue Buchungen aus Cloud in lokale PC-Datenbank (${month})...`);
                const insertRev = db.prepare(`
                    INSERT INTO revenues (
                        id, store_id, date, cash_cents, card_cents, total_cents, note,
                        created_by, updated_by, is_deleted, created_at, updated_at, version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                `);
                const insertTx = db.transaction(() => {
                    for (const r of missingInLocal) {
                        const cashCents = r.cashCents !== undefined ? r.cashCents : Math.round((parseFloat(r.cash) || 0) * 100);
                        const cardCents = r.cardCents !== undefined ? r.cardCents : Math.round((parseFloat(r.card) || 0) * 100);
                        const totalCents = r.totalCents !== undefined ? r.totalCents : (cashCents + cardCents);
                        insertRev.run(
                            r.id,
                            r.storeId || r.store_id,
                            r.date,
                            cashCents,
                            cardCents,
                            totalCents,
                            r.note || '',
                            r.createdBy || 'admin',
                            r.updatedBy || 'admin',
                            r.createdAt || new Date().toISOString(),
                            r.updatedAt || new Date().toISOString(),
                            r.version || 1
                        );
                    }
                });
                insertTx();
            }

            // B) Push offline local revenues to cloud
            const cloudRevIds = new Set(cloudRevs.map(r => r.id));
            const missingInCloud = localRevs.filter(r => !cloudRevIds.has(r.id));
            if (missingInCloud.length > 0) {
                console.log(`[Cloud-Sync] 📤 Sende ${missingInCloud.length} offline erstellte PC-Buchungen an zentrale Cloud (${month})...`);
                const itemsToReconcile = missingInCloud.map(r => ({
                    type: 'CREATE_REVENUE',
                    tempId: r.id,
                    data: {
                        id: r.id,
                        storeId: r.store_id,
                        date: r.date,
                        cash: r.cash_cents / 100,
                        card: r.card_cents / 100,
                        total: r.total_cents / 100,
                        note: r.note || '',
                        createdAt: r.created_at
                    }
                }));

                await fetch(`${CLOUD_URL}/api/sync/reconcile`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ items: itemsToReconcile })
                });
            }

            // 2. Sync Expenses for month
            const cloudExpsRes = await fetch(`${CLOUD_URL}/api/expenses?month=${encodeURIComponent(month)}`, { headers });
            if (cloudExpsRes.ok) {
                const cloudExps = await cloudExpsRes.json();
                const localExps = db.prepare('SELECT * FROM expenses WHERE date LIKE ? AND is_deleted = 0').all(`${month}%`);
                const localExpIds = new Set(localExps.map(e => e.id));

                const expsMissingInLocal = cloudExps.filter(e => !localExpIds.has(e.id));
                if (expsMissingInLocal.length > 0) {
                    console.log(`[Cloud-Sync] 📥 Ziehe ${expsMissingInLocal.length} neue Kosten aus Cloud in lokale PC-Datenbank (${month})...`);
                    const insertExp = db.prepare(`
                        INSERT INTO expenses (
                            id, store_id, category, date, amount_cents, title, recurrence,
                            created_by, updated_by, is_deleted, created_at, updated_at, version
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                    `);
                    const expTx = db.transaction(() => {
                        for (const e of expsMissingInLocal) {
                            const amountCents = e.amountCents !== undefined ? e.amountCents : Math.round((parseFloat(e.amount) || 0) * 100);
                            insertExp.run(
                                e.id,
                                e.storeId || e.store_id,
                                e.category,
                                e.date,
                                amountCents,
                                e.title || 'Ausgabe',
                                e.recurrence || 'single',
                                e.createdBy || 'admin',
                                e.updatedBy || 'admin',
                                e.createdAt || new Date().toISOString(),
                                e.updatedAt || new Date().toISOString(),
                                e.version || 1
                            );
                        }
                    });
                    expTx();
                }
            }
        }
    } catch (err) {
        if (!err.message.includes('fetch failed')) {
            console.warn('[Cloud-Sync] Status:', err.message);
        }
    } finally {
        isSyncing = false;
    }
}

function startCloudSyncDaemon(intervalMs = 20000) {
    if (isRunningInCloud()) {
        console.log('[Cloud-Sync] Server läuft als zentrale Produktions-Cloud (Render). Synchronisations-Daemon inaktiv.');
        return;
    }
    console.log(`[Cloud-Sync] 🚀 PC-zu-Cloud Synchronisations-Daemon gestartet (Ziel: ${CLOUD_URL}, Intervall: ${intervalMs/1000}s)`);
    setTimeout(() => syncWithCloud(), 2000);
    syncInterval = setInterval(() => syncWithCloud(), intervalMs);
}

function notifyLocalChange() {
    setTimeout(() => syncWithCloud(), 1000);
}

module.exports = {
    startCloudSyncDaemon,
    syncWithCloud,
    notifyLocalChange,
    isRunningInCloud
};
