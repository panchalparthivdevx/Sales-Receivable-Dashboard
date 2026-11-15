#!/usr/bin/env node
/**
 * Compliance Vr.2.0 backup / restore test (run from the project folder):
 *
 *   node server/compliance2/scripts/backup.js backup  "D:\Backups\Compliance"     makes c2-backup-<time>\ in that folder
 *   node server/compliance2/scripts/backup.js check   "D:\Backups\Compliance\c2-backup-…"   rebuilds it in a temp folder and verifies it
 *   node server/compliance2/scripts/backup.js restore "<backup folder>" "<EMPTY target folder>"
 *
 * Reads .env like the server (DATABASE_URL → Neon, otherwise the PC files). The check needs C2_FILE_KEY (live files) and
 * JWT_SECRET (demo files) to prove every file still decrypts. The key itself is never written into a backup.
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env') });
const B = require('../lib/backup');

(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'backup' && a) { const r = await B.backup({ out: a }); console.log(`Backup written: ${r.dir}\n${r.docs} documents, ${r.files} evidence files${r.missing_files.length ? `\nWARNING: ${r.missing_files.length} file(s) were already missing` : ''}`); return; }
  if (cmd === 'check' && a) { const r = await B.restoreCheck(a); console.log(JSON.stringify(r.report, null, 2)); console.log(r.ok ? 'RESTORE TEST PASSED' : `RESTORE TEST FAILED:\n- ${r.problems.join('\n- ')}`); process.exit(r.ok ? 0 : 1); }
  if (cmd === 'restore' && a && b) { const r = await B.restoreCheck(a, { target: b }); console.log(r.ok ? `Restored into ${r.restored_to} — set C2_DATA_DIR / C2_FILES_DIR to its data and files folders to use it` : `Restored with problems:\n- ${r.problems.join('\n- ')}`); process.exit(r.ok ? 0 : 1); }
  console.log('Usage: backup <out folder> | check <backup folder> | restore <backup folder> <empty target folder>');
  process.exit(2);
})().catch(e => { console.error(e.message); process.exit(1); });
