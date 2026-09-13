/**
 * StoreControl Pro - Realistic End-to-End Simulation
 * Validates the exact user scenario:
 * Smartphone entry 123,45 € -> DB -> PC retrieval -> PC modification to 150,00 € -> Smartphone sync
 */

const assert = require('assert');
const app = require('../server/index');
const { db } = require('../server/db');
const { authenticateUser, generateToken } = require('../server/auth');

const PORT = 3998;
let server;
const baseUrl = `http://localhost:${PORT}`;

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

async function runE2E() {
    console.log('================================================================');
    console.log('  📱💻 StoreControl Pro - Realistischer End-to-End Test');
    console.log('================================================================\n');

    await new Promise((resolve) => {
        server = app.listen(PORT, '127.0.0.1', resolve);
    });

    try {
        // Authenticate Smartphone & PC users
        const adminUser = authenticateUser('admin', 'admin123');
        const adminToken = generateToken(adminUser);

        const cashierUser = authenticateUser('kasse', 'kasse123');
        const cashierToken = generateToken(cashierUser);

        const store = db.prepare('SELECT id, name FROM stores WHERE is_deleted = 0 LIMIT 1').get();
        assert.ok(store, 'Filiale muss existieren');
        console.log(`  [SETUP] Test-Filiale: "${store.name}" (${store.id})`);

        // ---------------------------------------------------------------------
        // Schritt 1 - 5: Smartphone erfasst 123,45 €
        // ---------------------------------------------------------------------
        console.log('\n  [SCHRITT 1-5] Smartphone: Umsatz über 123,45 € eingeben und speichern...');
        const clientGeneratedId = `rev_mobile_${Date.now()}`;
        const mobilePost = await request('/api/revenues', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${cashierToken}` },
            body: JSON.stringify({
                id: clientGeneratedId,
                storeId: store.id,
                date: '2026-09-10',
                cash: 100.00,
                card: 23.45,
                note: 'E2E Test Smartphone Erfassung'
            })
        });

        assert.strictEqual(mobilePost.status, 201, 'Status muss 201 Created sein');
        assert.strictEqual(mobilePost.data.success, true);
        assert.strictEqual(mobilePost.data.record.id, clientGeneratedId);
        assert.strictEqual(mobilePost.data.record.total, 123.45, 'Gesamtsumme muss exakt 123.45 € sein');
        console.log('  ✅ Smartphone: Umsatz über 123,45 € erfolgreich gespeichert (✓ Gespeichert)');

        // DB Verification
        const dbCheck1 = db.prepare('SELECT * FROM revenues WHERE id = ?').get(clientGeneratedId);
        assert.ok(dbCheck1, 'Datensatz muss in zentraler DB existieren');
        assert.strictEqual(dbCheck1.total_cents, 12345, 'Zentrale DB muss exakt 12345 Cent speichern');
        assert.strictEqual(dbCheck1.version, 1);
        console.log('  ✅ Zentrale Datenbank: Dauerhaft gespeichert mit 12345 Cent (WAL Modus)');

        // ---------------------------------------------------------------------
        // Schritt 6 - 7: PC öffnet Datenbestand
        // ---------------------------------------------------------------------
        console.log('\n  [SCHRITT 6-7] PC: Manager öffnen und Daten vom Server abrufen...');
        const pcGet = await request(`/api/revenues?month=2026-09&storeId=${store.id}`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert.strictEqual(pcGet.status, 200);
        const pcFound = pcGet.data.find(r => r.id === clientGeneratedId);
        assert.ok(pcFound, 'Umsatz von 123,45 € muss am PC sofort vorhanden sein');
        assert.strictEqual(pcFound.total, 123.45);
        assert.strictEqual(pcFound.cash, 100.00);
        assert.strictEqual(pcFound.card, 23.45);
        console.log('  ✅ PC: Datensatz über 123,45 € ist auf dem PC sofort verfügbar');

        // ---------------------------------------------------------------------
        // Schritt 8 - 9: Am PC auf 150,00 € ändern
        // ---------------------------------------------------------------------
        console.log('\n  [SCHRITT 8-9] PC: Betrag auf 150,00 € ändern (100 € Bar, 50 € Karte)...');
        const pcUpdate = await request(`/api/revenues/${clientGeneratedId}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${adminToken}` },
            body: JSON.stringify({
                cash: 100.00,
                card: 50.00,
                clientVersion: 1
            })
        });
        assert.strictEqual(pcUpdate.status, 200);
        assert.strictEqual(pcUpdate.data.record.total, 150.00);
        assert.strictEqual(pcUpdate.data.record.version, 2, 'Version muss 2 sein');
        console.log('  ✅ PC: Änderung auf 150,00 € erfolgreich gespeichert (Version 2)');

        // ---------------------------------------------------------------------
        // Schritt 10: Smartphone öffnen / aktualisieren
        // ---------------------------------------------------------------------
        console.log('\n  [SCHRITT 10] Smartphone: Synchronisation/Aktualisierung...');
        const mobileGet = await request(`/api/revenues?month=2026-09&storeId=${store.id}`, {
            headers: { 'Authorization': `Bearer ${cashierToken}` }
        });
        assert.strictEqual(mobileGet.status, 200);
        const mobileUpdated = mobileGet.data.find(r => r.id === clientGeneratedId);
        assert.ok(mobileUpdated);
        assert.strictEqual(mobileUpdated.total, 150.00, 'Smartphone muss 150,00 € anzeigen');
        assert.strictEqual(mobileUpdated.card, 50.00);
        console.log('  ✅ Smartphone: Zeigt jetzt exakt 150,00 € an');

        // ---------------------------------------------------------------------
        // Schritt 11: Duplikatschutz-Test bei Smartphone-Retry
        // ---------------------------------------------------------------------
        console.log('\n  [SCHRITT 11] Idempotenz-Prüfung: Erneutes Senden der gleichen ID...');
        const retryPost = await request('/api/revenues', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${cashierToken}` },
            body: JSON.stringify({
                id: clientGeneratedId,
                storeId: store.id,
                date: '2026-09-10',
                cash: 100.00,
                card: 50.00
            })
        });
        assert.strictEqual(retryPost.status, 200, 'Muss mit 200 Idempotent quittiert werden');
        assert.strictEqual(retryPost.data.idempotent, true);

        const totalRecordsWithId = db.prepare('SELECT COUNT(*) as c FROM revenues WHERE id = ?').get(clientGeneratedId).c;
        assert.strictEqual(totalRecordsWithId, 1, 'Es darf kein doppelter Eintrag entstanden sein!');
        console.log('  ✅ Duplikatschutz: Kein doppelter Datensatz (exakt 1 Eintrag in DB)');

        // ---------------------------------------------------------------------
        // Schritt 12: Löschtest
        // ---------------------------------------------------------------------
        console.log('\n  [SCHRITT 12] Löschtest: PC löscht Umsatz -> Smartphone aktualisiert...');
        const delRes = await request(`/api/revenues/${clientGeneratedId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert.strictEqual(delRes.status, 200);

        const dbDeleted = db.prepare('SELECT is_deleted FROM revenues WHERE id = ?').get(clientGeneratedId);
        assert.strictEqual(dbDeleted.is_deleted, 1, 'In DB als is_deleted = 1 markiert');

        const activeList = await request(`/api/revenues?month=2026-09&storeId=${store.id}`, {
            headers: { 'Authorization': `Bearer ${cashierToken}` }
        });
        const stillPresent = activeList.data.some(r => r.id === clientGeneratedId);
        assert.strictEqual(stillPresent, false, 'Gelöschter Datensatz darf nicht mehr in aktiver Liste erscheinen');
        console.log('  ✅ Löschen: Datensatz wurde zuverlässig gelöscht und verschwindet auf allen Geräten');

        console.log('\n================================================================');
        console.log('  🎉 Alle 12 Schritte des End-to-End Tests ERFOLGREICH abgeschlossen!');
        console.log('================================================================\n');

        process.exit(0);
    } finally {
        server.close();
    }
}

runE2E().catch(err => {
    console.error('❌ E2E Fehler:', err);
    process.exit(1);
});
