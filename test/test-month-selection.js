const path = require('path');
const { generateToken } = require('../server/auth.js');
const { db } = require('../server/db.js');

async function runTestSuite() {
    console.log('================================================================');
    console.log('  🧪 Vollständiger Test der Monatsauswahl (Mobile & PC)');
    console.log('================================================================\n');

    const admin = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
    const token = generateToken(admin);
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
    const baseUrl = 'http://127.0.0.1:3000';

    let passed = 0;
    let failed = 0;

    function assert(desc, condition) {
        if (condition) {
            console.log(`  ✅ [PASS] ${desc}`);
            passed++;
        } else {
            console.error(`  ❌ [FAIL] ${desc}`);
            failed++;
        }
    }

    // TEST 1: Verfügbare Monate abrufen
    console.log('--- TEST 1: Alle Monate mit vorhandenen Daten abrufen (/api/months) ---');
    const monthsRes = await fetch(`${baseUrl}/api/months`, { headers });
    assert('HTTP Status 200 für /api/months', monthsRes.status === 200);
    const monthsData = await monthsRes.json();
    assert('Mindestens 1 Monat vorhanden', monthsData.length >= 1);
    const sepMonth = monthsData.find(m => m.month === '2026-09');
    assert('September 2026 ist in den verfügbaren Monaten', !!sepMonth);
    assert('September 2026 hat exakt 39 Buchungen', sepMonth && sepMonth.revenueCount === 39);
    assert('September 2026 Monatsumsatz ist exakt 19.852,87 €', sepMonth && Math.round(sepMonth.totalRevenue * 100) === 1985287);
    assert('September 2026 hat 9 Ausgaben', sepMonth && sepMonth.expenseCount === 9);

    // TEST 2: September 2026 Daten abrufen
    console.log('\n--- TEST 2: September 2026 Daten abrufen & verifizieren ---');
    const sepRevsRes = await fetch(`${baseUrl}/api/revenues?month=2026-09`, { headers });
    const sepRevs = await sepRevsRes.json();
    assert('Exakt 39 Tagesumsätze für September 2026 geladen', sepRevs.length === 39);

    let totalCashCents = 0, totalCardCents = 0, totalRevCents = 0;
    sepRevs.forEach(r => {
        totalCashCents += Math.round(r.cash * 100);
        totalCardCents += Math.round(r.card * 100);
        totalRevCents += Math.round(r.total * 100);
    });
    assert('Summe Bar + Karte entspricht Gesamtsumme', (totalCashCents + totalCardCents) === totalRevCents);
    assert('Gesamter September-Umsatz ist exakt 19.852,87 €', totalRevCents === 1985287);

    const sepExpsRes = await fetch(`${baseUrl}/api/expenses?month=2026-09`, { headers });
    const sepExps = await sepExpsRes.json();
    assert('Exakt 9 Kosten-Einträge für September 2026 geladen', sepExps.length === 9);
    let totalExpCents = 0;
    sepExps.forEach(e => { totalExpCents += Math.round(e.amount * 100); });
    assert('Gesamte September-Kosten sind exakt 12.478,33 €', totalExpCents === 1247833);

    const netProfitCents = totalRevCents - totalExpCents;
    assert('Gesamtgewinn September ist exakt 7.374,54 €', netProfitCents === 737454);

    // TEST 3: Wechsel zu Oktober 2026
    console.log('\n--- TEST 3: Wechsel zu Oktober 2026 ---');
    const octRevsRes = await fetch(`${baseUrl}/api/revenues?month=2026-10`, { headers });
    const octRevs = await octRevsRes.json();
    assert('Oktober 2026 hat 0 Buchungen', octRevs.length === 0);

    const octExpsRes = await fetch(`${baseUrl}/api/expenses?month=2026-10`, { headers });
    const octExps = await octExpsRes.json();
    assert('Oktober 2026 hat 0 Ausgaben', octExps.length === 0);

    // TEST 4: Wechsel zurück zu September 2026
    console.log('\n--- TEST 4: Wechsel zurück zu September 2026 (Datenintegrität) ---');
    const sepRevsRes2 = await fetch(`${baseUrl}/api/revenues?month=2026-09`, { headers });
    const sepRevs2 = await sepRevsRes2.json();
    assert('Alle 39 September-Umsätze weiterhin vollständig vorhanden', sepRevs2.length === 39);

    const sepExpsRes2 = await fetch(`${baseUrl}/api/expenses?month=2026-09`, { headers });
    const sepExps2 = await sepExpsRes2.json();
    assert('Alle 9 September-Kosten weiterhin vollständig vorhanden', sepExps2.length === 9);

    // TEST 5: HTML- und Client-Funktionen Verifikation
    console.log('\n--- TEST 5: HTML- und Client-Funktionen Verifikation ---');
    const fs = require('fs');
    const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

    assert('index.html enthält #globalMonthBar (Mobile & Desktop Leiste)', indexHtml.includes('id="globalMonthBar"'));
    assert('index.html enthält #btnPrevMonth (< Vorheriger Monat)', indexHtml.includes('id="btnPrevMonth"'));
    assert('index.html enthält #btnNextMonth (> Nächster Monat)', indexHtml.includes('id="btnNextMonth"'));
    assert('index.html enthält #btnMonthPickerOpen (Monatsauswahl-Öffner)', indexHtml.includes('id="btnMonthPickerOpen"'));
    assert('index.html enthält #btnResetCurrentMonth (Zum aktuellen Monat)', indexHtml.includes('id="btnResetCurrentMonth"'));
    assert('index.html enthält #monthPickerModal (Monatsauswahl-Modal)', indexHtml.includes('id="monthPickerModal"'));
    assert('index.html enthält #monthsWithDataList (Liste Monate mit Daten)', indexHtml.includes('id="monthsWithDataList"'));
    assert('index.html enthält Desktop-Header Monats-Navigation', indexHtml.includes('id="desktopHeaderMonthContainer"'));

    assert('app.js enthält setGlobalMonth() Funktion', appJs.includes('function setGlobalMonth'));
    assert('app.js enthält changeMonthRelative() Funktion', appJs.includes('function changeMonthRelative'));
    assert('app.js enthält resetToCurrentMonth() Funktion', appJs.includes('function resetToCurrentMonth'));
    assert('app.js speichert gewählten Monat in localStorage', appJs.includes('storecontrol_selected_month'));
    assert('app.js stellt gespeicherten Monat bei Neustart wieder her', appJs.includes("localStorage.getItem('storecontrol_selected_month')"));

    console.log('\n================================================================');
    console.log(`  Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen.`);
    console.log('================================================================\n');

    if (failed > 0) process.exit(1);
}

runTestSuite().catch(e => {
    console.error('Test Suite Error:', e);
    process.exit(1);
});
