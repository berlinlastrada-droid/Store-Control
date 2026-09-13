const path = require('path');
const { db } = require(path.join(__dirname, '../server/db'));
db.prepare("DELETE FROM stores WHERE id NOT IN ('store_1788358842956_bolf', 'store_1788358914508_zv8v', 'store_1788358943648_q74l')").run();
db.prepare("DELETE FROM products WHERE name IN ('Testartikel Sync', 'Premium Lederschuh Derby', 'Pflegespray', 'Schuhanzieher')").run();
db.prepare("DELETE FROM revenues WHERE note IN ('Erfassung via Smartphone im Laden', 'Offline im Keller erfasst', 'Cent-Test', 'Idempotency Test 250 €', 'To Delete', 'Genauigkeitstest', 'Sync 1', 'Sync 2', 'Sync 3', 'Umsatz geändert auf PC') OR id LIKE 'rev_del_%' OR id LIKE 'rev_idem_%'").run();
db.prepare("DELETE FROM expenses WHERE title IN ('Glühbirnen für Lager', 'Kartonagen', 'Putzmittel')").run();
db.prepare("UPDATE app_settings SET value = 'https://pay-cleanup-section-hats.trycloudflare.com', updated_at = datetime('now') WHERE key = 'app_public_url'").run();

console.log('Cleaned test suite artifacts. Current counts:');
console.log('User revenues:', db.prepare('SELECT count(*) as c FROM revenues WHERE is_deleted=0').get().c);
console.log('User expenses:', db.prepare('SELECT count(*) as c FROM expenses WHERE is_deleted=0').get().c);
console.log('Stores:', db.prepare('SELECT id, name FROM stores').all());
