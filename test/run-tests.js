/**
 * StoreControl Pro - Automated Verification & Acceptance Tests
 * Validates all 6 Acceptance Tests and Core Functionality:
 * 1. Mobile Revenue Booking (500 €) -> Central DB -> PC Retrieval
 * 2. PC Article Creation -> Central DB -> Mobile Retrieval
 * 3. Offline Queue Booking -> Auto-Sync Push -> Server State
 * 4. Record Modification on PC -> Reflected in Sync
 * 5. Concurrent Modification Conflict Detection (409 Versioning)
 * 6. Security & Role Permissions (401 Unauthorized / 403 Forbidden)
 * 7. Financial Precision & Calculations (Integer Cents)
 * 8. Audit Log Traceability
 */

const assert = require('assert');
const http = require('http');
const app = require('../server/index');
const { db } = require('../server/db');
const { authenticateUser, generateToken } = require('../server/auth');

const PORT = 3999;
let server;
let baseUrl = `http://localhost:${PORT}`;
let adminToken = '';
let cashierToken = '';

async function request(url, options = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const status = res.status;
    let data;
    try {
        data = await res.json();
    } catch(e) {
        data = null;
    }
    return { status, data };
}

async function runTests() {
    console.log('================================================================');
    console.log('  🧪 StoreControl Pro - Akzeptanz- und Funktionstests');
    console.log('================================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            process.stdout.write(`  [TEST] ${name} ... `);
            await fn();
            console.log('✅ BESTANDEN');
            passed++;
        } catch (err) {
            console.log('❌ FEHLGESCHLAGEN');
            console.error('         Fehler:', err.message);
            failed++;
        }
    }

    // Start isolated test server instance
    await new Promise((resolve) => {
        server = app.listen(PORT, '127.0.0.1', () => {
            resolve();
        });
    });

    try {
        // Setup Auth Tokens
        const adminUser = authenticateUser('admin', 'admin123');
        adminToken = generateToken(adminUser);

        const cashierUser = authenticateUser('kasse', 'kasse123');
        cashierToken = generateToken(cashierUser);

        // ---------------------------------------------------------------------
        // Test 6: Sicherheit & Rollenprüfungen (Unberechtigter Zugriff verweigert)
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 6: Unberechtigter Zugriff wird serverseitig mit 401 verweigert', async () => {
            // No token provided
            const res = await request('/api/stores');
            assert.strictEqual(res.status, 401, 'Erwartet 401 ohne Token');
        });

        await test('Akzeptanztest 6b: Rolle "employee" darf keine administrativen Filialen anlegen (403)', async () => {
            const res = await request('/api/stores', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${cashierToken}` },
                body: JSON.stringify({ name: 'Hacker Filiale' })
            });
            assert.strictEqual(res.status, 403, 'Erwartet 403 Forbidden für Kassierer-Rolle');
        });

        // ---------------------------------------------------------------------
        // Test 0: Reale Geschäftsdaten aus Backup geladen
        // ---------------------------------------------------------------------
        let activeStoreId = '';
        await test('Realdaten-Integrität: Echte Filialen (Lichtenberg, Grünau, Königs Wusterhausen) und Kosten geladen', async () => {
            const res = await request('/api/stores', {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });
            assert.strictEqual(res.status, 200);
            assert.ok(res.data.length >= 3, 'Mindestens 3 Filialen erwartet');
            const storeNames = res.data.map(s => s.name);
            assert.ok(storeNames.includes('Lichtenberg'), 'Filiale Lichtenberg muss vorhanden sein');
            assert.ok(storeNames.includes('Grünau'), 'Filiale Grünau muss vorhanden sein');
            assert.ok(storeNames.includes('Königs Wusterhausen'), 'Filiale Königs Wusterhausen muss vorhanden sein');

            activeStoreId = res.data[0].id;

            // Check real expenses from backup
            const expRes = await request('/api/expenses?month=2026-09', {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });
            assert.strictEqual(expRes.status, 200);
            const titles = expRes.data.map(e => e.title);
            assert.ok(titles.some(t => t.includes('Pappel')), 'Lohn Pappel muss vorhanden sein');
            assert.ok(titles.some(t => t.includes('Miete')), 'Miete muss vorhanden sein');
        });

        // ---------------------------------------------------------------------
        // Test 1: Smartphone -> 500 € erfassen -> Server -> PC abrufen
        // ---------------------------------------------------------------------
        let createdRevId = '';
        await test('Akzeptanztest 1: Smartphone bucht 500 € Umsatz -> Zentral gespeichert -> Am PC sichtbar', async () => {
            // Smartphone client books 500 € (300 € bar, 200 € karte)
            const mobilePost = await request('/api/revenues', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({
                    storeId: activeStoreId,
                    date: '2026-09-09',
                    cash: 300.00,
                    card: 200.00,
                    note: 'Erfassung via Smartphone im Laden'
                })
            });

            assert.strictEqual(mobilePost.status, 201, 'Umsatz muss mit 201 angelegt werden');
            assert.strictEqual(mobilePost.data.record.total, 500.00, 'Gesamtsumme muss 500 € sein');
            createdRevId = mobilePost.data.record.id;

            // PC client queries revenues
            const pcGet = await request(`/api/revenues?month=2026-09&storeId=${activeStoreId}`, {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });

            assert.strictEqual(pcGet.status, 200);
            const found = pcGet.data.find(r => r.id === createdRevId);
            assert.ok(found, 'Der vom Smartphone gebuchte Umsatz muss auf dem PC auffindbar sein');
            assert.strictEqual(found.total, 500.00, 'Betrag auf PC muss exakt 500,00 € betragen');
            assert.strictEqual(found.cash, 300.00);
            assert.strictEqual(found.card, 200.00);
        });

        // ---------------------------------------------------------------------
        // Test 2: PC erstellt Artikel -> Smartphone ruft Artikel ab
        // ---------------------------------------------------------------------
        let createdProdId = '';
        await test('Akzeptanztest 2: PC erstellt Artikel -> Smartphone kann Artikel & Barcode abrufen', async () => {
            const testBarcode = '4098' + Date.now().toString().slice(-8);
            const pcCreate = await request('/api/products', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({
                    storeId: activeStoreId,
                    name: 'Premium Lederschuh Derby',
                    barcode: testBarcode,
                    sku: 'SCHUH-999',
                    category: 'Herrenschuhe',
                    costPrice: 65.00,
                    sellPrice: 149.95,
                    stockQuantity: 12,
                    minStock: 2
                })
            });

            assert.strictEqual(pcCreate.status, 201);
            createdProdId = pcCreate.data.product.id;

            // Smartphone searches by barcode
            const mobileSearch = await request(`/api/products?barcode=${testBarcode}`, {
                headers: { 'Authorization': `Bearer ${cashierToken}` }
            });

            assert.strictEqual(mobileSearch.status, 200);
            assert.strictEqual(mobileSearch.data.length, 1);
            assert.strictEqual(mobileSearch.data[0].name, 'Premium Lederschuh Derby');
            assert.strictEqual(mobileSearch.data[0].sellPrice, 149.95);
            assert.strictEqual(mobileSearch.data[0].stockQuantity, 12);
        });

        // ---------------------------------------------------------------------
        // Test 3: Offline Queue -> Auto-Sync Push -> Zentraler Datenbestand
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 3: Offline erfasste Buchungen synchronisieren bei Wiederverbindung fehlerfrei', async () => {
            const offlineQueue = [
                {
                    tempId: 'temp_offline_rev_1',
                    type: 'CREATE_REVENUE',
                    data: {
                        storeId: activeStoreId,
                        date: '2026-09-09',
                        cash: 120.50,
                        card: 80.00,
                        total: 200.50,
                        note: 'Offline im Keller erfasst'
                    },
                    clientVersion: 1
                },
                {
                    tempId: 'temp_offline_exp_1',
                    type: 'CREATE_EXPENSE',
                    data: {
                        storeId: activeStoreId,
                        category: 'other',
                        date: '2026-09-09',
                        amount: 35.00,
                        title: 'Glühbirnen für Lager',
                        recurrence: 'single'
                    },
                    clientVersion: 1
                }
            ];

            const syncPush = await request('/api/sync/push', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({ items: offlineQueue })
            });

            assert.strictEqual(syncPush.status, 200);
            assert.strictEqual(syncPush.data.synced.length, 2, 'Beide Offline-Buchungen müssen synchronisiert sein');
            assert.strictEqual(syncPush.data.conflicts.length, 0, 'Keine Konflikte erwartet');

            // Verify in DB
            const checkRev = db.prepare('SELECT total_cents, note FROM revenues WHERE note = ?').get('Offline im Keller erfasst');
            assert.ok(checkRev);
            assert.strictEqual(checkRev.total_cents, 20050, 'Cent-Speicherung muss exakt 20050 Cent sein');
        });

        // ---------------------------------------------------------------------
        // Test 4: Datensatz auf PC ändern -> Smartphone erhält aktuellen Stand
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 4: PC ändert Umsatz von 500 € auf 550 € -> Smartphone erhält Änderung', async () => {
            const updateRes = await request(`/api/revenues/${createdRevId}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({
                    cash: 350.00,
                    card: 200.00,
                    clientVersion: 1
                })
            });

            assert.strictEqual(updateRes.status, 200);
            assert.strictEqual(updateRes.data.record.total, 550.00);
            assert.strictEqual(updateRes.data.record.version, 2, 'Version muss auf 2 inkrementiert werden');

            // Smartphone pulls delta
            const pullRes = await request('/api/sync/pull?since=1970-01-01T00:00:00.000Z', {
                headers: { 'Authorization': `Bearer ${cashierToken}` }
            });

            assert.strictEqual(pullRes.status, 200);
            const pulled = pullRes.data.revenues.find(r => r.id === createdRevId);
            assert.ok(pulled);
            assert.strictEqual(pulled.total, 550.00);
        });

        // ---------------------------------------------------------------------
        // Test 5: Parallelbearbeitung & Konflikt-Erkennung (Kein stiller Verlust)
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 5: Konflikt-Erkennung verhindert stilles Überschreiben (409 Conflict)', async () => {
            // Client attempts update with outdated version 1, but server is at version 2
            const conflictRes = await request(`/api/revenues/${createdRevId}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({
                    cash: 999.00,
                    card: 0.00,
                    clientVersion: 1 // Outdated version!
                })
            });

            assert.strictEqual(conflictRes.status, 409, 'Server muss 409 Conflict melden');
            assert.ok(conflictRes.data.error.includes('Konflikt'));
            assert.ok(conflictRes.data.serverRecord, 'Server-Record muss im Response enthalten sein');
            assert.strictEqual(conflictRes.data.serverRecord.total, 550.00, 'Bestehender Stand darf nicht still überschrieben worden sein');
        });

        // ---------------------------------------------------------------------
        // Test 7: Cent-Genauigkeit & Finanzen (Keine Rundungsfehler)
        // ---------------------------------------------------------------------
        await test('Datenintegrität: Cent-Präzision verhindert IEEE-754 Fließkommafehler', async () => {
            // Classic floating point problem: 0.1 + 0.2 = 0.30000000000000004
            const revRes = await request('/api/revenues', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({
                    storeId: activeStoreId,
                    date: '2026-09-09',
                    cash: 0.10,
                    card: 0.20,
                    note: 'Cent-Test'
                })
            });

            assert.strictEqual(revRes.status, 201);
            assert.strictEqual(revRes.data.record.total, 0.30);

            const row = db.prepare('SELECT cash_cents, card_cents, total_cents FROM revenues WHERE id = ?').get(revRes.data.record.id);
            assert.strictEqual(row.cash_cents, 10);
            assert.strictEqual(row.card_cents, 20);
            assert.strictEqual(row.total_cents, 30);
        });

        // ---------------------------------------------------------------------
        // Test 8: Revisionsprotokoll / Audit Log
        // ---------------------------------------------------------------------
        await test('Revisionssicherheit: Aktionen werden lückenlos im Audit Log protokolliert', async () => {
            const auditRes = await request('/api/audit-logs?limit=20', {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });

            assert.strictEqual(auditRes.status, 200);
            assert.ok(auditRes.data.length > 0);

            const revenueLogs = auditRes.data.filter(l => l.entityType === 'revenue');
            assert.ok(revenueLogs.length >= 2, 'Audit Log muss Umsatz-Erstellung und Änderung enthalten');
        });

        // ---------------------------------------------------------------------
        // Test 9: Duplikatschutz & Idempotenz (Keine doppelten Datensätze bei Retry)
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 9: Idempotenz-Schutz verhindert doppelte Buchungen bei Retry', async () => {
            const idempotentId = `rev_idem_${Date.now()}`;
            const payload = {
                id: idempotentId,
                storeId: activeStoreId,
                date: '2026-09-09',
                cash: 250.00,
                card: 0.00,
                note: 'Idempotency Test 250 €'
            };

            // First submission
            const firstPost = await request('/api/revenues', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify(payload)
            });
            assert.strictEqual(firstPost.status, 201);
            assert.strictEqual(firstPost.data.record.id, idempotentId);

            // Second identical submission (e.g. user double-clicked or network retry)
            const secondPost = await request('/api/revenues', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify(payload)
            });
            assert.strictEqual(secondPost.status, 200, 'Zweiter Request muss mit 200 (Idempotent) bestätigt werden');
            assert.strictEqual(secondPost.data.idempotent, true);

            // Verify in DB that only 1 record exists with this ID
            const count = db.prepare('SELECT COUNT(*) as cnt FROM revenues WHERE id = ?').get(idempotentId).cnt;
            assert.strictEqual(count, 1, 'Es darf exakt nur 1 Datensatz in der Datenbank existieren');
        });

        // ---------------------------------------------------------------------
        // Test 10: Sync Push für Deletionen (DELETE_REVENUE, DELETE_EXPENSE, DELETE_PRODUCT)
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 10: Offline-Löschungen werden über /api/sync/push korrekt verarbeitet', async () => {
            // Create item first
            const delTargetId = `rev_del_${Date.now()}`;
            db.prepare(`
                INSERT INTO revenues (id, store_id, date, cash_cents, card_cents, total_cents, note, created_by, updated_by, created_at, updated_at, version)
                VALUES (?, ?, '2026-09-09', 10000, 0, 10000, 'To Delete', 'admin', 'admin', datetime('now'), datetime('now'), 1)
            `).run(delTargetId, activeStoreId);

            const pushRes = await request('/api/sync/push', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({
                    items: [
                        {
                            tempId: 'temp_del_1',
                            type: 'DELETE_REVENUE',
                            data: { id: delTargetId }
                        }
                    ]
                })
            });

            assert.strictEqual(pushRes.status, 200);
            assert.strictEqual(pushRes.data.synced.length, 1);

            const check = db.prepare('SELECT is_deleted FROM revenues WHERE id = ?').get(delTargetId);
            assert.ok(check);
            assert.strictEqual(check.is_deleted, 1, 'Datensatz muss als gelöscht markiert sein');
        });

        // ---------------------------------------------------------------------
        // Test 11: Filialen Sync Push (CREATE_STORE, UPDATE_STORE, DELETE_STORE)
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 11: Vollständiger Sync-Push für Filialen & Produkte', async () => {
            const syncStoreId = `store_sync_${Date.now()}`;
            const syncProdId = `prod_sync_${Date.now()}`;

            const pushRes = await request('/api/sync/push', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({
                    items: [
                        {
                            tempId: 'temp_s_1',
                            type: 'CREATE_STORE',
                            data: {
                                id: syncStoreId,
                                name: 'Testfiliale Sync',
                                color: 'rose',
                                employeeCount: 4,
                                targetRevenue: 50000.00
                            }
                        },
                        {
                            tempId: 'temp_p_1',
                            type: 'CREATE_PRODUCT',
                            data: {
                                id: syncProdId,
                                storeId: activeStoreId,
                                name: 'Testartikel Sync',
                                costPrice: 20.00,
                                sellPrice: 49.99,
                                stockQuantity: 50,
                                minStock: 5
                            }
                        }
                    ]
                })
            });

            assert.strictEqual(pushRes.status, 200);
            assert.strictEqual(pushRes.data.synced.length, 2);

            const dbStore = db.prepare('SELECT name, target_revenue_cents FROM stores WHERE id = ?').get(syncStoreId);
            assert.ok(dbStore);
            assert.strictEqual(dbStore.name, 'Testfiliale Sync');
            assert.strictEqual(dbStore.target_revenue_cents, 5000000);

            const dbProd = db.prepare('SELECT name, sell_price_cents FROM products WHERE id = ?').get(syncProdId);
            assert.ok(dbProd);
            assert.strictEqual(dbProd.name, 'Testartikel Sync');
            assert.strictEqual(dbProd.sell_price_cents, 4999);
        });

        // ---------------------------------------------------------------------
        // Test 12: Genaue Finanzberechnung (19,99 € + 10,01 € = 30,00 €)
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 12: Finanzgenauigkeit ohne Fließkomma-Drift (19,99 + 10,01 = 30,00)', async () => {
            const sumPost = await request('/api/revenues', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({
                    storeId: activeStoreId,
                    date: '2026-09-09',
                    cash: 19.99,
                    card: 10.01,
                    note: 'Genauigkeitstest'
                })
            });

            assert.strictEqual(sumPost.status, 201);
            assert.strictEqual(sumPost.data.record.total, 30.00);
            assert.strictEqual(sumPost.data.record.cash, 19.99);
            assert.strictEqual(sumPost.data.record.card, 10.01);

            const dbSum = db.prepare('SELECT total_cents FROM revenues WHERE id = ?').get(sumPost.data.record.id);
            assert.strictEqual(dbSum.total_cents, 3000);
        });

        // ---------------------------------------------------------------------
        // Test 13: Smartphone QR-Code - Kein Localhost/LAN, Unconfigured Status
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 13: Smartphone QR-Code erzeugt niemals Localhost/LAN-Adressen', async () => {
            // Ensure no public url in db for this test
            db.prepare("DELETE FROM app_settings WHERE key = 'app_public_url'").run();

            const infoRes = await request('/api/network-info');
            assert.strictEqual(infoRes.status, 200);
            assert.strictEqual(infoRes.data.isConfigured, false);
            assert.strictEqual(infoRes.data.publicUrl, null);
            assert.strictEqual(infoRes.data.qrCode, null);
        });

        // ---------------------------------------------------------------------
        // Test 14: Smartphone QR-Code - URL Validierung & echte HTTPS-Generierung
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 14: QR-Code lehnt private Adressen ab & erzeugt echten HTTPS QR-Code', async () => {
            // 1. Rejection of localhost
            const badLocalhost = await request('/api/settings/public-url', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({ publicUrl: 'http://localhost:3000' })
            });
            assert.strictEqual(badLocalhost.status, 400);

            // 2. Rejection of private IP
            const badPrivateIp = await request('/api/settings/public-url', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({ publicUrl: 'http://192.168.178.135:3000' })
            });
            assert.strictEqual(badPrivateIp.status, 400);

            // 3. Acceptance of real public HTTPS URL
            const goodUrl = 'https://manager.la-strada-schuhe.de';
            const saveRes = await request('/api/settings/public-url', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({ publicUrl: goodUrl })
            });
            assert.strictEqual(saveRes.status, 200);
            assert.strictEqual(saveRes.data.success, true);
            assert.strictEqual(saveRes.data.publicUrl, goodUrl);
            assert.ok(saveRes.data.qrCode.startsWith('data:image/png;base64,'));

            // 4. Verification that GET /network-info now returns public HTTPS
            const infoRes = await request('/api/network-info');
            assert.strictEqual(infoRes.status, 200);
            assert.strictEqual(infoRes.data.isConfigured, true);
            assert.strictEqual(infoRes.data.publicUrl, goodUrl);
            assert.ok(infoRes.data.qrCode.startsWith('data:image/png;base64,'));
        });

        // ---------------------------------------------------------------------
        // Test 15: „9 ausstehend“-Drain & Duplikat-Schutz bei Push-Wiederholung
        // ---------------------------------------------------------------------
        await test('Akzeptanztest 15: 9 ausstehende Offline-Aktionen leeren die Queue ohne Duplikate', async () => {
            const batchItems = [
                // 3 revenues
                { tempId: 't_rev_1', type: 'CREATE_REVENUE', data: { storeId: activeStoreId, date: '2026-09-10', cash: 100, card: 50, note: 'Sync 1' } },
                { tempId: 't_rev_2', type: 'CREATE_REVENUE', data: { storeId: activeStoreId, date: '2026-09-10', cash: 200, card: 0, note: 'Sync 2' } },
                { tempId: 't_rev_3', type: 'CREATE_REVENUE', data: { storeId: activeStoreId, date: '2026-09-10', cash: 50, card: 75, note: 'Sync 3' } },
                // 2 expenses
                { tempId: 't_exp_1', type: 'CREATE_EXPENSE', data: { storeId: activeStoreId, category: 'Material', date: '2026-09-10', amount: 35.50, title: 'Kartonagen' } },
                { tempId: 't_exp_2', type: 'CREATE_EXPENSE', data: { storeId: activeStoreId, category: 'Reinigung', date: '2026-09-10', amount: 15.00, title: 'Putzmittel' } },
                // 2 products
                { tempId: 't_prod_1', type: 'CREATE_PRODUCT', data: { name: 'Pflegespray', storeId: activeStoreId, sellPrice: 9.95, costPrice: 4.00, stockQuantity: 20 } },
                { tempId: 't_prod_2', type: 'CREATE_PRODUCT', data: { name: 'Schuhanzieher', storeId: activeStoreId, sellPrice: 4.50, costPrice: 1.50, stockQuantity: 30 } },
                // 1 store
                { tempId: 't_store_1', type: 'CREATE_STORE', data: { name: 'Filiale Test 4', targetRevenue: 12000.00 } },
                // 1 duplicate retry (matches t_rev_1)
                { tempId: 't_rev_1_retry', type: 'CREATE_REVENUE', data: { storeId: activeStoreId, date: '2026-09-10', cash: 100, card: 50, note: 'Sync 1' } }
            ];

            const pushRes = await request('/api/sync/push', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}` },
                body: JSON.stringify({ items: batchItems })
            });

            assert.strictEqual(pushRes.status, 200);
            assert.strictEqual(pushRes.data.success, true);
            if (pushRes.data.synced.length !== 9) {
                console.error('Test 15 Conflicts:', JSON.stringify(pushRes.data.conflicts, null, 2));
            }
            assert.strictEqual(pushRes.data.synced.length, 9);

            // Verify duplicate check worked: exact match for 100/50 on 2026-09-10 must only exist ONCE in DB!
            const countRev = db.prepare("SELECT count(*) as cnt FROM revenues WHERE store_id = ? AND date = '2026-09-10' AND cash_cents = 10000 AND card_cents = 5000 AND is_deleted = 0").get(activeStoreId);
            assert.strictEqual(countRev.cnt, 1);
        });

    } finally {
        server.close();
    }

    console.log('\n================================================================');
    console.log(`  Ergebnis: ${passed} Tests bestanden, ${failed} Tests fehlgeschlagen.`);
    console.log('================================================================\n');

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Unerwarteter Fehler bei der Testausführung:', err);
    process.exit(1);
});
