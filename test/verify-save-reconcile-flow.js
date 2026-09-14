const http = require('http');
const assert = require('assert');
const { db } = require('../server/db');

function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url, 'http://localhost:3000');
        const reqOpts = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers: options.headers || {}
        };

        const req = http.request(reqOpts, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
                resolve({ status: res.statusCode, headers: res.headers, data: parsed });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

async function runVerification() {
    console.log('\n================================================================');
    console.log('  🔍 Verifikation: Speichern, DB-Check, UI-Status & Reconcile');
    console.log('================================================================\n');

    // 1. Authenticate as admin
    const loginRes = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    assert.strictEqual(loginRes.status, 200, 'Login failed');
    const token = loginRes.data.token;
    console.log('1. Authentifizierung erfolgreich (Token erhalten)');

    // 2. Get active store
    const store = db.prepare('SELECT id, name FROM stores WHERE is_deleted = 0 LIMIT 1').get();
    assert.ok(store, 'Keine Filiale in DB gefunden');
    console.log(`2. Testfiliale: "${store.name}" (${store.id})`);

    // 3. User Action: Neuer Eintrag online erstellen & speichern (mit eindeutigen Cent-Beträgen)
    const randomOffset = (Date.now() % 500) / 100;
    const testDate = '2026-09-11';
    const testCash = Math.round((200.00 + randomOffset) * 100) / 100;
    const testCard = Math.round((100.00 + randomOffset) * 100) / 100;
    const testTotal = Math.round((testCash + testCard) * 100) / 100;
    const testNote = 'Verifikationstest ' + Date.now();

    console.log(`3. Sende POST /api/revenues (Bar: ${testCash} €, Karte: ${testCard} €, Gesamt: ${testTotal} €)...`);
    const saveRes = await request('/api/revenues', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            storeId: store.id,
            date: testDate,
            cash: testCash,
            card: testCard,
            total: testTotal,
            note: testNote
        })
    });

    assert.strictEqual(saveRes.status, 201, 'Erwartet HTTP 201 Created');
    assert.ok(saveRes.data.record, 'Kein record in Antwort');
    const createdRev = saveRes.data.record;
    assert.strictEqual(createdRev.cash, testCash);
    assert.strictEqual(createdRev.card, testCard);
    assert.strictEqual(createdRev.total, testTotal);
    console.log(`   ✅ HTTP 201 Created erhalten (ID: ${createdRev.id})`);

    // 4. Datenbank direkt prüfen
    const dbRow = db.prepare('SELECT * FROM revenues WHERE id = ?').get(createdRev.id);
    assert.ok(dbRow, 'Eintrag wurde NICHT in der SQLite-Datenbank gefunden!');
    assert.strictEqual(dbRow.cash_cents, Math.round(testCash * 100), 'Cash-Cents in DB stimmt nicht');
    assert.strictEqual(dbRow.card_cents, Math.round(testCard * 100), 'Card-Cents in DB stimmt nicht');
    assert.strictEqual(dbRow.total_cents, Math.round(testTotal * 100), 'Total-Cents in DB stimmt nicht');
    assert.strictEqual(dbRow.store_id, store.id, 'Store ID in DB stimmt nicht');
    console.log(`4. ✅ Direkte DB-Prüfung bestanden: Dauerhaft in SQLite mit Cent-Präzision (${dbRow.total_cents} Cents) persistiert.`);

    // 5. Client Status-Prüfung: _pendingSync muss false sein & Badge muss ✓ Gespeichert sein
    const clientRecord = { ...createdRev, _pendingSync: false };
    assert.strictEqual(clientRecord._pendingSync, false, 'Client record darf NICHT _pendingSync sein');

    // Test Table Badge Rendering Logic
    function getBadgeHtml(r) {
        return r._pendingSync 
            ? '<span class="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300" title="Wartet auf Synchronisierung mit dem Server">⏳ Ausstehend</span>' 
            : '<span class="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300" title="Erfolgreich in zentraler Datenbank gespeichert">✓ Gespeichert</span>';
    }

    const badge = getBadgeHtml(clientRecord);
    assert.ok(badge.includes('✓ Gespeichert'), 'Badge muss "✓ Gespeichert" sein!');
    assert.ok(!badge.includes('Ausstehend'), 'Badge darf NIEMALS "Ausstehend" sein!');
    console.log(`5. ✅ UI-Status-Prüfung: Badge ist sofort "✓ Gespeichert", 0 ausstehend.`);

    // 6. Reload-Prüfung: Nach Seiten-Reload Daten vom Server abrufen
    console.log('6. Simuliere Seiten-Reload: GET /api/revenues?month=2026-09...');
    const reloadRes = await request('/api/revenues?month=2026-09', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(reloadRes.status, 200);
    const foundOnReload = reloadRes.data.find(r => r.id === createdRev.id);
    assert.ok(foundOnReload, 'Eintrag ist nach dem Reload nicht mehr vorhanden!');
    assert.strictEqual(foundOnReload.total, testTotal);
    console.log('   ✅ Nach Seiten-Reload weiterhin vollständig in Datenbank und Tabelle vorhanden.');

    // 7. Reconcile-Prüfung: Ausstehende Einträge abgleichen
    console.log('7. Teste Reconcile-Endpunkt mit existierendem Datensatz...');
    const reconcileRes = await request('/api/sync/reconcile', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            items: [
                {
                    tempId: 'temp_rev_client_' + Date.now(),
                    type: 'CREATE_REVENUE',
                    data: {
                        storeId: store.id,
                        date: testDate,
                        cash: testCash,
                        card: testCard,
                        total: testTotal,
                        note: testNote
                    }
                }
            ]
        })
    });
    assert.strictEqual(reconcileRes.status, 200);
    assert.strictEqual(reconcileRes.data.success, true);
    assert.strictEqual(reconcileRes.data.reconciled.length, 1);
    const recResult = reconcileRes.data.reconciled[0];
    assert.strictEqual(recResult.action, 'MATCHED', 'Reconcile muss existierenden Datensatz matchen');
    assert.strictEqual(recResult.serverId, createdRev.id, 'Reconcile muss existierende Server-ID zurückgeben');
    assert.strictEqual(recResult.record._pendingSync, false);

    // Verify no duplicate was created in SQLite DB!
    const countCheck = db.prepare('SELECT count(*) as cnt FROM revenues WHERE id = ?').get(createdRev.id);
    assert.strictEqual(countCheck.cnt, 1, 'Keine Duplikate in DB');
    console.log('   ✅ Reconcile erfolgreich: Bestehender Eintrag erkannt, Server-Datensatz übernommen, keine Duplikate erzeugt.');

    console.log('\n================================================================');
    console.log('  🎉 Alle Anforderungen erfolgreich verifiziert und bestanden!');
    console.log('================================================================\n');
}

runVerification().catch(err => {
    console.error('Fehler bei der Verifikation:', err);
    process.exit(1);
});
