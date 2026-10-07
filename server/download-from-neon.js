/**
 * Backup: copy everything the dashboard keeps in Neon into a dated folder (e.g. company OneDrive).
 * The reverse of server/upload-to-neon.js; nothing in Neon is changed.
 *
 *   PowerShell:
 *   $env:DATABASE_URL="postgres://…neon.tech/…"; node server/download-from-neon.js "D:\OneDrive - Dev Accelerator Limited\Dashboard Backups"
 *
 * Writes <folder>\neon-backup-YYYY-MM-DD\ with
 *   kv\<key>.json                 every stored document (data, settings, caches)
 *   branch_bills_cache\<id>.json  the branch bills cache
 *   excel\<name>.xlsx             the stored Excel workbooks (seats, payroll, loans, rent module)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');

const target = process.argv[2];
if (!process.env.DATABASE_URL || !target) {
  console.error('Usage (PowerShell):\n  $env:DATABASE_URL="postgres://…"; node server/download-from-neon.js "<backup folder>"');
  process.exit(1);
}
const db = require('./db');

(async () => {
  const out = path.join(target, `neon-backup-${new Date().toISOString().slice(0, 10)}`);
  for (const d of ['kv', 'branch_bills_cache', 'excel']) fs.mkdirSync(path.join(out, d), { recursive: true });
  const safe = s => s.replace(/[<>:"/\\|?*]/g, '_');

  let docs = 0, bytes = 0;
  for (const { key } of await db.listKeys('')) {
    const value = await db.readJSON(key, null, null);
    if (value === null) continue;
    if (key.startsWith('xlsx_') && value.data) {   // stored workbook → the original .xlsx
      const buf = Buffer.from(value.data, 'base64');
      fs.writeFileSync(path.join(out, 'excel', safe(value.name || `${key}.xlsx`)), buf);
      bytes += buf.length;
    } else {
      const text = JSON.stringify(value);
      fs.writeFileSync(path.join(out, 'kv', `${safe(key)}.json`), text, 'utf8');
      bytes += text.length;
    }
    docs++;
  }

  const branches = (await db.listBranchCacheFiles(null)).map(f => f.replace(/\.json$/, ''));
  for (const id of branches) {
    const data = await db.readBranchCache(id, null);
    if (data) fs.writeFileSync(path.join(out, 'branch_bills_cache', `${safe(id)}.json`), JSON.stringify(data), 'utf8');
  }

  console.log(`Backup written to ${out}\n  ${docs} document(s) + ${branches.length} branch cache(s), ${(bytes / 1048576).toFixed(1)} MB`);
  process.exit(0);
})().catch(e => { console.error('Backup failed:', e.message); process.exit(1); });
