/**
 * Backup and restore test: a backup is rebuilt in a temporary folder and verified (hashes, audit chains, every file decrypts
 * to its recorded hash); a changed backup is detected. SYNTHETIC data only (the demo space and one live entity).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers');
const B = require('../lib/backup');
const store = require('../lib/store');

test.before(() => H.start());
test.after(() => H.stop());

test('backup → restore test passes; a changed document or file in the backup is detected; the module keeps its folders', async () => {
  assert.equal((await H.call('1', 'GET', '/meta', undefined, { space: 'demo' })).status, 200);       // builds the demo space (tasks, sample files)
  assert.equal((await H.call('1', 'POST', '/org/entity', { legal_name: 'Synthetic Backup Co Pvt Ltd', short_code: 'SBCK', type: 'PRIVATE', pan: 'ZZZCB7009K' })).status, 200);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'c2bk-'));
  const r = await B.backup({ out, filesDir: H.filesDir });
  assert.ok(r.docs >= 8, `docs ${r.docs}`);
  assert.ok(r.files > 10, `files ${r.files}`);
  assert.deepEqual(r.missing_files, []);
  const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'));
  assert.ok(!JSON.stringify(manifest).includes(process.env.C2_FILE_KEY), 'the key is never in a backup');
  const ok = await B.restoreCheck(r.dir);
  assert.equal(ok.ok, true, ok.problems.join('; '));
  assert.ok(ok.report.demo.tasks > 100);
  assert.equal(ok.report.demo.file_versions_readable, r.files);
  assert.ok(ok.report.live.audit_entries >= 2);
  assert.equal(store.dataDir(), H.dataDir, 'the module is back on its own folder');
  assert.equal((await H.call('1', 'GET', '/org')).body.entities.length, 1, 'the module still reads its own data');
  // tamper with one backed-up audit document and one encrypted file
  const auditKey = manifest.docs.find(d => /^demo_audit_2/.test(d.key)).key;
  const f = path.join(r.dir, 'docs', `${auditKey}.json`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Demo space rebuilt', 'Demo space REBUILT'));
  const one = manifest.files[0];
  const fp = path.join(r.dir, 'files', one.space, `${one.sha256}.c2e`);
  const buf = fs.readFileSync(fp); buf[buf.length - 1] ^= 1; fs.writeFileSync(fp, buf);
  const bad = await B.restoreCheck(r.dir);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some(p => p.includes(auditKey) && /hash differs/.test(p)));
  assert.ok(bad.problems.some(p => /demo audit trail/.test(p)));
  assert.ok(bad.problems.some(p => p.includes(one.sha256)));
  // restore only into an empty folder
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'c2tgt-'));
  fs.mkdirSync(path.join(target, 'data')); fs.writeFileSync(path.join(target, 'data', 'x.json'), '{}');
  await assert.rejects(B.restoreCheck(r.dir, { target }), /only into an empty folder/);
});
