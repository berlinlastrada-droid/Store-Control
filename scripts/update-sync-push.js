const fs = require('fs');
let code = fs.readFileSync('server/routes/api.js', 'utf8');

// Update UPDATE_REVENUE inside sync/push
const oldSyncRev = `                } else if (normalizedType === 'UPDATE_REVENUE') {
                    const existing = db.prepare('SELECT * FROM revenues WHERE id = ? AND is_deleted = 0').get(data.id);
                    if (!existing) {
                        conflicts.push({ tempId, id: data.id, reason: 'Datensatz existiert nicht oder wurde gelöscht' });
                        continue;
                    }
                    if (clientVersion && clientVersion < existing.version) {
                        conflicts.push({ tempId, id: data.id, reason: 'Versionskonflikt', serverRecord: existing });
                        continue;
                    }

                    const cashCents = data.cash !== undefined ? Math.round(parseFloat(data.cash) * 100) : (data.cashCents || existing.cash_cents);
                    const cardCents = data.card !== undefined ? Math.round(parseFloat(data.card) * 100) : (data.cardCents || existing.card_cents);
                    const totalCents = cashCents + cardCents;
                    const newVersion = existing.version + 1;

                    db.prepare(\`
                        UPDATE revenues SET
                            store_id = COALESCE(?, store_id),
                            date = COALESCE(?, date),
                            cash_cents = ?,
                            card_cents = ?,
                            total_cents = ?,
                            note = COALESCE(?, note),
                            updated_by = ?,
                            updated_at = ?,
                            version = ?
                        WHERE id = ?
                    \`).run(storeId, data.date, cashCents, cardCents, totalCents, data.note, req.user.username, now, newVersion, data.id);`;

const newSyncRev = `                } else if (normalizedType === 'UPDATE_REVENUE') {
                    const existing = db.prepare('SELECT * FROM revenues WHERE id = ? AND is_deleted = 0').get(data.id);
                    if (!existing) {
                        conflicts.push({ tempId, id: data.id, reason: 'Datensatz existiert nicht oder wurde gelöscht' });
                        continue;
                    }
                    if (clientVersion && clientVersion < existing.version) {
                        conflicts.push({ tempId, id: data.id, reason: 'Versionskonflikt', serverRecord: existing });
                        continue;
                    }

                    const finalStoreId = (data.storeId || data.store_id) || existing.store_id;
                    const finalDate = (data.date && String(data.date).trim()) ? String(data.date).trim() : existing.date;
                    const cashCents = data.cash !== undefined ? Math.round(parseFloat(data.cash) * 100) : (data.cashCents || existing.cash_cents);
                    const cardCents = data.card !== undefined ? Math.round(parseFloat(data.card) * 100) : (data.cardCents || existing.card_cents);
                    const totalCents = cashCents + cardCents;
                    const finalNote = data.note !== undefined ? (data.note === null ? '' : String(data.note).trim()) : (existing.note || '');
                    const newVersion = existing.version + 1;

                    db.prepare(\`
                        UPDATE revenues SET
                            store_id = ?,
                            date = ?,
                            cash_cents = ?,
                            card_cents = ?,
                            total_cents = ?,
                            note = ?,
                            updated_by = ?,
                            updated_at = ?,
                            version = ?
                        WHERE id = ?
                    \`).run(finalStoreId, finalDate, cashCents, cardCents, totalCents, finalNote, req.user.username, now, newVersion, data.id);`;

// Find markers safely
const markerStart = code.indexOf("} else if (normalizedType === 'UPDATE_REVENUE') {");
const markerNext = code.indexOf("} else if (normalizedType === 'DELETE_REVENUE') {");

if (markerStart !== -1 && markerNext !== -1) {
    const chunk = code.slice(markerStart, markerNext);
    const replacedChunk = chunk.replace(
        /UPDATE revenues SET[\s\S]*?WHERE id = \?[\s\S]*?\)\.run\([\s\S]*?\);/,
        `UPDATE revenues SET
                            store_id = ?,
                            date = ?,
                            cash_cents = ?,
                            card_cents = ?,
                            total_cents = ?,
                            note = ?,
                            updated_by = ?,
                            updated_at = ?,
                            version = ?
                        WHERE id = ?
                    \`).run((data.storeId || data.store_id) || existing.store_id, (data.date && String(data.date).trim()) ? String(data.date).trim() : existing.date, cashCents, cardCents, totalCents, data.note !== undefined ? (data.note === null ? '' : String(data.note).trim()) : (existing.note || ''), req.user.username, now, newVersion, data.id);`
    );
    code = code.slice(0, markerStart) + replacedChunk + code.slice(markerNext);
    console.log('UPDATE_REVENUE in sync/push safely updated');
}

fs.writeFileSync('server/routes/api.js', code, 'utf8');
console.log('server/routes/api.js sync push updated cleanly!');
