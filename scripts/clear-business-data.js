const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { db } = require('../server/db');

function compressSnappy(buf) {
    const varintBuf = [];
    let len = buf.length;
    while (len >= 0x80) {
        varintBuf.push((len & 0x7f) | 0x80);
        len >>>= 7;
    }
    varintBuf.push(len & 0x7f);

    const chunks = [];
    let pos = 0;
    while (pos < buf.length) {
        const chunkLen = Math.min(buf.length - pos, 65536);
        const chunk = buf.subarray(pos, pos + chunkLen);
        pos += chunkLen;

        const tag = [];
        if (chunkLen <= 60) {
            tag.push(((chunkLen - 1) << 2) | 0);
        } else if (chunkLen <= 256) {
            tag.push((60 << 2) | 0, chunkLen - 1);
        } else if (chunkLen <= 65536) {
            const lenVal = chunkLen - 1;
            tag.push((61 << 2) | 0, lenVal & 0xff, (lenVal >> 8) & 0xff);
        }
        chunks.push(Buffer.concat([Buffer.from(tag), chunk]));
    }
    return Buffer.concat([Buffer.from(varintBuf), ...chunks]);
}

async function cleanAllBusinessData() {
    console.log('================================================================');
    console.log('  🧹 STORE CONTROL - GESCHÄFTSDATEN VOLLSTÄNDIG BEREINIGEN');
    console.log('================================================================\n');

    // 1. Safety Backup
    const backupPath = path.join(__dirname, '../data/storecontrol_backup_before_reset.db');
    fs.copyFileSync(path.join(__dirname, '../data/storecontrol.db'), backupPath);
    console.log('1. Sicherheits-Backup erstellt unter:', backupPath);

    // 2. Clear Database Tables
    const tx = db.transaction(() => {
        const delRev = db.prepare('DELETE FROM revenues').run();
        console.log(`2. Tagesumsätze gelöscht: ${delRev.changes} Einträge entfernt.`);

        const delExp = db.prepare('DELETE FROM expenses').run();
        console.log(`3. Kosten & Ausgaben gelöscht: ${delExp.changes} Einträge entfernt.`);

        const delProd = db.prepare('DELETE FROM products').run();
        console.log(`4. Artikel & Lager gelöscht: ${delProd.changes} Einträge entfernt.`);

        const delTestStores = db.prepare("DELETE FROM stores WHERE name LIKE '%Test%' OR id LIKE '%test%' OR id LIKE '%sync%'").run();
        console.log(`5. Testfilialen gelöscht: ${delTestStores.changes} Testeinträge entfernt.`);

        const delAudit = db.prepare('DELETE FROM audit_logs').run();
        console.log(`6. Audit-Logs zurückgesetzt: ${delAudit.changes} Protokolleinträge bereinigt.`);
    });
    tx();

    db.exec('VACUUM');
    console.log('7. Datenbank-Vakuumierung durchgeführt (Speicherplatz freigegeben).');

    // Verify Remaining Data in SQLite
    const revCount = db.prepare('SELECT count(*) as c FROM revenues').get().c;
    const expCount = db.prepare('SELECT count(*) as c FROM expenses').get().c;
    const prodCount = db.prepare('SELECT count(*) as c FROM products').get().c;
    const storeCount = db.prepare('SELECT count(*) as c FROM stores').get().c;
    const userCount = db.prepare('SELECT count(*) as c FROM users').get().c;
    const stores = db.prepare('SELECT id, name FROM stores').all();

    console.log('\n--- Aktueller Datenbank-Status ---');
    console.log(`- Tagesumsätze: ${revCount}`);
    console.log(`- Kosten & Ausgaben: ${expCount}`);
    console.log(`- Artikel: ${prodCount}`);
    console.log(`- Filialen (${storeCount}):`, stores.map(s => s.name).join(', '));
    console.log(`- Benutzer (${userCount}): erhalten (admin, filialleiter, kasse)`);

    // 3. Clear Firefox LocalStorage for both localhost:3000 and file:///
    const ffProfilesDir = 'C:/Users/esadb/AppData/Roaming/Mozilla/Firefox/Profiles';
    if (fs.existsSync(ffProfilesDir)) {
        const profiles = fs.readdirSync(ffProfilesDir);
        for (const p of profiles) {
            const defaultStorage = path.join(ffProfilesDir, p, 'storage/default');
            if (fs.existsSync(defaultStorage)) {
                const storageDirs = fs.readdirSync(defaultStorage);
                for (const d of storageDirs) {
                    if (d.includes('localhost+3000') || d.includes('laden-umsatz-manager')) {
                        const lsDbPath = path.join(defaultStorage, d, 'ls/data.sqlite');
                        if (fs.existsSync(lsDbPath)) {
                            try {
                                const ffDb = new Database(lsDbPath);
                                const emptyBuf = compressSnappy(Buffer.from('[]', 'utf8'));

                                // Reset collections to empty arrays
                                ffDb.prepare("UPDATE data SET value = ? WHERE key = 'storecontrol_revenues_v1'").run(emptyBuf);
                                ffDb.prepare("UPDATE data SET value = ? WHERE key = 'storecontrol_expenses_v1'").run(emptyBuf);
                                ffDb.prepare("UPDATE data SET value = ? WHERE key = 'storecontrol_products_v1'").run(emptyBuf);
                                ffDb.prepare("UPDATE data SET value = ? WHERE key = 'storecontrol_sync_queue'").run(emptyBuf);

                                // Update stores in cache to match cleaned DB
                                const cleanStoresBuf = compressSnappy(Buffer.from(JSON.stringify(stores), 'utf8'));
                                ffDb.prepare("UPDATE data SET value = ? WHERE key = 'storecontrol_stores_v1'").run(cleanStoresBuf);

                                ffDb.close();
                                console.log(`8. Browser-Cache bereinigt in: ${d}`);
                            } catch(err) {
                                console.warn(`Fehler beim Bereinigen von ${d}:`, err.message);
                            }
                        }
                    }
                }
            }
        }
    }

    // 4. Send SSE trigger via HTTP request so all open browser tabs update instantly
    try {
        const http = require('http');
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: '/api/sync/pull',
            method: 'GET'
        });
        req.end();
    } catch(e) {}

    console.log('\n================================================================');
    console.log('  ✅ ALLE GESCHÄFTSDATEN WURDEN ERFOLGREICH GELÖSCHT!');
    console.log('  Der Manager ist nun komplett leer und bereit zur Neuerfassung.');
    console.log('================================================================\n');
}

cleanAllBusinessData().catch(console.error);
