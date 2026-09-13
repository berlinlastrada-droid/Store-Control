const { db, logAudit } = require('../server/db');
const Database = require('better-sqlite3');
const path = 'C:/Users/esadb/AppData/Roaming/Mozilla/Firefox/Profiles/6l01b6ak.default-release/storage/default/file++++C++Users+esadb+Desktop+La%20Strada+laden-umsatz-manager+index.html/ls/data.sqlite';

function decompressSnappy(buf) {
    let pos = 0; let len = 0; let shift = 0;
    while (pos < buf.length) {
        const b = buf[pos++]; len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break; shift += 7;
    }
    const out = Buffer.alloc(len); let outPos = 0;
    while (pos < buf.length && outPos < len) {
        const tag = buf[pos++]; const type = tag & 3;
        if (type === 0) {
            let litLen = tag >> 2;
            if (litLen < 60) litLen += 1;
            else if (litLen === 60) litLen = 1 + buf[pos++];
            else if (litLen === 61) { litLen = 1 + buf.readUInt16LE(pos); pos += 2; }
            else if (litLen === 62) { litLen = 1 + buf.readUInt24LE(pos); pos += 3; }
            else if (litLen === 63) { litLen = 1 + buf.readUInt32LE(pos); pos += 4; }
            buf.copy(out, outPos, pos, pos + litLen); pos += litLen; outPos += litLen;
        } else if (type === 1) {
            const copyLen = ((tag >> 2) & 7) + 4;
            const offset = ((tag >> 5) << 8) | buf[pos++];
            for (let i = 0; i < copyLen; i++) out[outPos + i] = out[outPos - offset + i];
            outPos += copyLen;
        } else if (type === 2) {
            const copyLen = (tag >> 2) + 1;
            const offset = buf.readUInt16LE(pos); pos += 2;
            for (let i = 0; i < copyLen; i++) out[outPos + i] = out[outPos - offset + i];
            outPos += copyLen;
        } else if (type === 3) {
            const copyLen = (tag >> 2) + 1;
            const offset = buf.readUInt32LE(pos); pos += 4;
            for (let i = 0; i < copyLen; i++) out[outPos + i] = out[outPos - offset + i];
            outPos += copyLen;
        }
    }
    return out.subarray(0, outPos);
}

// Simple snappy compressor for literal chunks
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

async function migratePending() {
    console.log('=== Migration der 9 ausstehenden Eintrge ===');
    let ffDb;
    let queue = [];
    try {
        ffDb = new Database(path);
        const row = ffDb.prepare("SELECT value FROM data WHERE key = 'storecontrol_sync_queue'").get();
        if (row && row.value) {
            queue = JSON.parse(decompressSnappy(row.value).toString('utf8'));
        }
    } catch(err) {
        console.warn('Konnte Firefox-DB nicht direkt lesen:', err.message);
    }

    if (!queue || queue.length === 0) {
        console.log('Keine Eintrge in Firefox-Warteschlange gefunden.');
        return;
    }

    console.log(`Gefunden: ${queue.length} Eintrge in Warteschlange.`);
    const now = new Date().toISOString();
    let insertedCount = 0;

    const insertRev = db.prepare(`
        INSERT INTO revenues (id, store_id, date, cash_cents, card_cents, total_cents, note, created_by, updated_by, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', 'admin', ?, ?, 1)
    `);

    const migratedServerIds = [];

    const runTx = db.transaction(() => {
        for (const item of queue) {
            const d = item.data;
            const cashCents = Math.round((parseFloat(d.cash) || 0) * 100);
            const cardCents = Math.round((parseFloat(d.card) || 0) * 100);
            const totalCents = Math.round((parseFloat(d.total) || 0) * 100);

            // Check if already in DB
            let existing = db.prepare('SELECT id FROM revenues WHERE id = ?').get(item.tempId || d.id);
            if (!existing) {
                existing = db.prepare('SELECT id FROM revenues WHERE store_id = ? AND date = ? AND cash_cents = ? AND card_cents = ? AND is_deleted = 0')
                    .get(d.storeId, d.date, cashCents, cardCents);
            }

            let serverId;
            if (existing) {
                serverId = existing.id;
                console.log(`- Bereits in DB: ${d.date} (${d.storeId}) -> ID: ${serverId}`);
            } else {
                serverId = (item.tempId && !item.tempId.startsWith('temp_')) ? item.tempId : `rev_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                insertRev.run(serverId, d.storeId, d.date, cashCents, cardCents, totalCents, d.note || '', item.timestamp || now, now);
                logAudit('revenue', serverId, 'MIGRATE_PENDING', 'system', null, d);
                insertedCount++;
                console.log(`+ Eingefgt in SQLite: ${d.date} (${d.storeId}), Bar: ${d.cash}?, Karte: ${d.card}? -> ID: ${serverId}`);
            }
            migratedServerIds.push({ tempId: item.tempId, serverId, data: d });
        }
    });

    runTx();
    console.log(`Ergebnis: ${insertedCount} Eintrge neu in SQLite-Datenbank persistiert.`);

    // Clear Firefox sync queue and update revenues with _pendingSync = false
    if (ffDb) {
        try {
            // Update queue to empty
            const emptyBuf = compressSnappy(Buffer.from('[]', 'utf8'));
            ffDb.prepare("UPDATE data SET value = ? WHERE key = 'storecontrol_sync_queue'").run(emptyBuf);
            console.log('Firefox storecontrol_sync_queue auf [] zurckgesetzt.');

            // Also update storecontrol_revenues_v1
            const revRow = ffDb.prepare("SELECT value FROM data WHERE key = 'storecontrol_revenues_v1'").get();
            if (revRow && revRow.value) {
                let localRevs = JSON.parse(decompressSnappy(revRow.value).toString('utf8'));
                localRevs = localRevs.map(r => ({ ...r, _pendingSync: false }));
                const updatedBuf = compressSnappy(Buffer.from(JSON.stringify(localRevs), 'utf8'));
                ffDb.prepare("UPDATE data SET value = ? WHERE key = 'storecontrol_revenues_v1'").run(updatedBuf);
                console.log('Firefox storecontrol_revenues_v1: _pendingSync auf false gesetzt.');
            }
            ffDb.close();
        } catch(e) {
            console.warn('Konnte Firefox-DB nicht zurckschreiben:', e.message);
        }
    }

    console.log('Migration erfolgreich abgeschlossen!');
}

migratePending().catch(console.error);
