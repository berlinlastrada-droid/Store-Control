/**
 * StoreControl Pro - Strict User Acceptance Flow Tests
 * Covers User Requirements 19, 20, 21, 22, 23, 8, 14
 */

const assert = require('assert');
const { db } = require('../server/db');

const BASE_URL = 'http://localhost:3000/api';

async function request(endpoint, options = {}) {
    const { headers = {}, ...restOptions } = options;
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        headers: {
            'Content-Type': 'application/json',
            ...headers
        },
        ...restOptions
    });
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    return { status: res.status, ok: res.ok, data };
}

async function runTests() {
    console.log('================================================================');
    console.log('  🎯 Spezifische Anforderungs-Tests (Online-Speichern & 0 Ausstehend)');
    console.log('================================================================\n');

    // 1. Authenticate
    const login = await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    assert.strictEqual(login.status, 200);
    const token = login.data.token;
    const authHeader = { 'Authorization': `Bearer ${token}` };

    const firstStore = db.prepare('SELECT id, name FROM stores WHERE is_deleted = 0 ORDER BY created_at ASC LIMIT 1').get();
    assert.ok(firstStore, 'Mindestens eine aktive Filiale muss existieren');
    const storeId = firstStore.id;

    // -------------------------------------------------------------------------
    // TEST 1 (User Req 19): Online 500 € -> Sofort DB -> Sofort 0 Ausstehend
    // -------------------------------------------------------------------------
    console.log('  [TEST 1 - Req 19] Online-Umsatz buchen (500 €): Sofort zentral gespeichert, nicht ausstehend...');
    const rev19Id = `rev_req19_${Date.now()}`;
    const res19 = await request('/revenues', {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
            id: rev19Id,
            storeId,
            date: '2026-09-10',
            cash: 200,
            card: 300,
            note: 'Test Anforderung 19'
        })
    });

    assert.strictEqual(res19.status, 201, 'Backend muss 201 Created bestätigen');
    assert.strictEqual(res19.data.record.total, 500, 'Gesamtbetrag muss exakt 500 € sein');
    
    // DB Check
    const dbRow19 = db.prepare('SELECT total_cents FROM revenues WHERE id = ?').get(rev19Id);
    assert.ok(dbRow19, 'Datensatz muss sofort in SQLite-Datenbank existieren');
    assert.strictEqual(dbRow19.total_cents, 50000, '50000 Cent in SQLite');
    console.log('  ✅ Datensatz unmittelbar mit 201 bestätigt und in SQLite persistiert.');

    // -------------------------------------------------------------------------
    // TEST 2 (User Req 20): Smartphone erstellt Datensatz -> Am PC ohne Export sichtbar
    // -------------------------------------------------------------------------
    console.log('  [TEST 2 - Req 20] Smartphone bucht Umsatz -> Am PC sofort sichtbar...');
    const rev20Id = `rev_mobile_${Date.now()}`;
    const mobileSave = await request('/revenues', {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
            id: rev20Id,
            storeId,
            date: '2026-09-10',
            cash: 150,
            card: 50,
            note: 'Gebucht via Smartphone'
        })
    });
    assert.strictEqual(mobileSave.status, 201);

    // PC Query
    const pcQuery = await request(`/revenues?month=2026-09`, {
        headers: authHeader
    });
    assert.strictEqual(pcQuery.status, 200);
    const foundOnPc = pcQuery.data.find(r => r.id === rev20Id);
    assert.ok(foundOnPc, 'PC muss den auf dem Smartphone erstellten Eintrag sofort sehen');
    assert.strictEqual(foundOnPc.total, 200);
    console.log('  ✅ Eintrag vom Smartphone ist am PC direkt ohne Export/Neustart vorhanden.');

    // -------------------------------------------------------------------------
    // TEST 3 (User Req 21): Mehrere Einträge nacheinander (100, 200, 300, 400, 500 €)
    // -------------------------------------------------------------------------
    console.log('  [TEST 3 - Req 21] 5 Einträge nacheinander erstellen (100, 200, 300, 400, 500 €)...');
    const amounts = [100, 200, 300, 400, 500];
    for (const amt of amounts) {
        const id = `rev_seq_${amt}_${Date.now()}`;
        const saveRes = await request('/revenues', {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({
                id,
                storeId,
                date: '2026-09-10',
                cash: amt,
                card: 0,
                note: `Sequenztest ${amt} €`
            })
        });
        assert.strictEqual(saveRes.status, 201, `Umsatz über ${amt} € muss mit 201 bestätigt werden`);
        const inDb = db.prepare('SELECT total_cents FROM revenues WHERE id = ?').get(id);
        assert.strictEqual(inDb.total_cents, amt * 100);
    }
    console.log('  ✅ Alle 5 Buchungen nacheinander erfolgreich gespeichert, 0 ausstehend.');

    // -------------------------------------------------------------------------
    // TEST 4 (User Req 22): Test mit Reload
    // -------------------------------------------------------------------------
    console.log('  [TEST 4 - Req 22] Speichern und Reload-Prüfung...');
    const reloadId = `rev_reload_${Date.now()}`;
    await request('/revenues', {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
            id: reloadId,
            storeId,
            date: '2026-09-10',
            cash: 88,
            card: 12,
            note: 'Reload Prüfung'
        })
    });
    // Simulate browser reload (fetch all from server again)
    const reloadFetch = await request(`/revenues?month=2026-09`, { headers: authHeader });
    const reloadRecord = reloadFetch.data.find(r => r.id === reloadId);
    assert.ok(reloadRecord, 'Datensatz muss nach Reload weiterhin persistent vorhanden sein');
    assert.strictEqual(reloadRecord.total, 100);
    console.log('  ✅ Datensatz nach vollständigem Reload unverändert vorhanden.');

    // -------------------------------------------------------------------------
    // TEST 5 (User Req 23): Gerät A bucht 777 € -> Gerät B öffnet und sieht 777 €
    // -------------------------------------------------------------------------
    console.log('  [TEST 5 - Req 23] Gerät A bucht 777 € -> Gerät B ruft Daten ab...');
    const id777 = `rev_777_${Date.now()}`;
    const devARes = await request('/revenues', {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
            id: id777,
            storeId,
            date: '2026-09-10',
            cash: 777,
            card: 0,
            note: 'Gerät A 777 € Buchung'
        })
    });
    assert.strictEqual(devARes.status, 201);

    // Device B query
    const devBRes = await request(`/revenues?month=2026-09`, { headers: authHeader });
    const devBRecord = devBRes.data.find(r => r.id === id777);
    assert.ok(devBRecord, 'Gerät B muss den 777 € Umsatz sofort sehen');
    assert.strictEqual(devBRecord.total, 777);
    console.log('  ✅ Gerät B sieht den 777 € Datensatz von Gerät A sofort.');

    // -------------------------------------------------------------------------
    // TEST 6 (User Req 8): Behandlung der 9 ausstehenden Einträge (Fall A, B, C)
    // -------------------------------------------------------------------------
    console.log('  [TEST 6 - Req 8] 9 ausstehende Einträge: Reconcile Fall A (bereits in DB), Fall B (noch nicht in DB), Duplikatschutz...');
    // Create 3 already existing items in DB (Fall A)
    const existingIds = [];
    for (let i = 1; i <= 3; i++) {
        const id = `rev_pre_existing_${i}_${Date.now()}`;
        existingIds.push(id);
        db.prepare(`
            INSERT INTO revenues (id, store_id, date, cash_cents, card_cents, total_cents, note, created_by, updated_by, created_at, updated_at, version)
            VALUES (?, ?, '2026-09-08', 5000, 0, 5000, 'Pre-existing', 'admin', 'admin', datetime('now'), datetime('now'), 1)
        `).run(id, storeId);
    }

    // Prepare 9 queue items: 3 Fall A (exist in DB), 6 Fall B (new items)
    const queueItems = [];
    for (let i = 1; i <= 3; i++) {
        queueItems.push({
            tempId: `temp_fallA_${i}`,
            type: 'CREATE_REVENUE',
            data: {
                id: existingIds[i - 1],
                storeId,
                date: '2026-09-08',
                cash: 50,
                card: 0
            }
        });
    }
    for (let i = 4; i <= 9; i++) {
        queueItems.push({
            tempId: `temp_fallB_${i}`,
            type: 'CREATE_REVENUE',
            data: {
                id: `rev_fallB_${i}_${Date.now()}`,
                storeId,
                date: '2026-09-09',
                cash: i * 10,
                card: 0,
                note: `Fall B Item ${i}`
            }
        });
    }
    assert.strictEqual(queueItems.length, 9, 'Exakt 9 ausstehende Aktionen');

    const push9Res = await request('/sync/push', {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({ items: queueItems })
    });

    assert.strictEqual(push9Res.status, 200);
    assert.strictEqual(push9Res.data.synced.length, 9, 'Alle 9 Einträge müssen verarbeitet sein');
    
    // Check that Fall A items are marked idempotent (no duplicate rows created)
    const fallASynced = push9Res.data.synced.filter(s => s.tempId.startsWith('temp_fallA'));
    assert.strictEqual(fallASynced.length, 3);
    fallASynced.forEach(s => assert.strictEqual(s.idempotent, true, 'Fall A muss als idempotent markiert sein'));

    // Check that Fall B items were inserted
    const fallBSynced = push9Res.data.synced.filter(s => s.tempId.startsWith('temp_fallB'));
    assert.strictEqual(fallBSynced.length, 6);
    for (const item of fallBSynced) {
        const inDb = db.prepare('SELECT id FROM revenues WHERE id = ?').get(item.serverId);
        assert.ok(inDb, `Fall B Datensatz ${item.serverId} muss jetzt in SQLite existieren`);
    }
    console.log('  ✅ Alle 9 ausstehenden Einträge ohne Datenverlust und ohne Duplikate abgearbeitet -> 0 ausstehend.');

    // -------------------------------------------------------------------------
    // TEST 7 (User Req 13 & 14): Fehlerbehandlung (Serverfehler wird nicht als offline/gespeichert verbucht)
    // -------------------------------------------------------------------------
    console.log('  [TEST 7 - Req 13/14] Ungültige Buchung (z.B. fehlende Filiale) -> Korrekter 400 Fehler...');
    const invalidRes = await request('/revenues', {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
            date: '2026-09-10',
            cash: 100
            // storeId is missing!
        })
    });
    assert.strictEqual(invalidRes.status, 400, 'Server muss 400 Bad Request bei fehlenden Pflichtfeldern melden');
    console.log('  ✅ Validierungsfehler wird als echter HTTP 400 gemeldet (nicht als Erfolg vorgetäuscht).');

    console.log('\n================================================================');
    console.log('  🎉 Alle 7 Anforderungs-Tests ERFOLGREICH BESTANDEN!');
    console.log('================================================================\n');
}

runTests().catch(err => {
    console.error('❌ Test fehlgeschlagen:', err);
    process.exit(1);
});
