/**
 * The module as it runs ONLINE (Vercel): Neon instead of files, Blob instead of a folder, a read-only disk and no
 * timers. Neon is simulated only at the CONNECTION: the project's real server/db.js (read, write, compression, cache — and
 * its quirks, such as answering null for a record that does not exist and swallowing read errors) runs on an in-memory
 * stand-in for `pg`. Blob is an in-memory stand-in for server/file-store.js (the same exists / save / read calls). Any
 * write to the module's data folders fails like Vercel's read-only disk would. (Node runs each test file in its own
 * process, so setting VERCEL here affects only this file.) SYNTHETIC data.
 *
 * An earlier version of this file replaced db.js itself with a simpler stand-in, which hid a real bug: db.js answers null
 * for a record that does not exist, where the module needed an empty list or object.
 */

'use strict';

process.env.VERCEL = '1';
process.env.DATABASE_URL = 'postgres://stand-in/db';                                   // makes db.js use "Neon" (USE_DB), as on Vercel
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-gstr2b';
const os = require('os');
const path = require('path');
const fs = require('fs');
const SENTINEL = path.join(os.tmpdir(), `g2b-readonly-${process.pid}-${Date.now()}`);   // stands for Vercel's read-only /var/task
process.env.G2B_DATA_DIR = path.join(SENTINEL, 'data');
process.env.G2B_FILES_DIR = path.join(SENTINEL, 'files');

// The disk is read-only: any attempt to create or write under the module's folders throws (as EROFS does on Vercel)
const touched = [];
for (const fn of ['mkdirSync', 'writeFileSync', 'renameSync', 'appendFileSync', 'copyFileSync']) {
  const real = fs[fn];
  fs[fn] = function (p, ...rest) { if (String(p).includes(SENTINEL)) { touched.push(`${fn} ${p}`); const e = new Error(`EROFS: read-only file system, ${fn} '${p}'`); e.code = 'EROFS'; throw e; } return real.call(this, p, ...rest); };
}

// Neon at the connection level: an in-memory stand-in for `pg` that answers exactly the SQL server/db.js sends for kv_store
const rows = new Map();                                                              // key → { value: the stored text, at: updated_at as text }
const pgFail = { skip: 0, reads: 0 };                                                // let `skip` record reads through, then fail the next `reads` of them (a dropped connection)
let tick = 0;
class FakePool {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT updated_at::text AS at, CASE WHEN/.test(s)) {                       // db.js reading one record (and checking its own cached copy)
      if (pgFail.skip > 0) pgFail.skip--; else if (pgFail.reads > 0) { pgFail.reads--; throw new Error('Connection terminated unexpectedly'); }
      const [key, cachedAt] = params; const r = rows.get(key);
      return { rows: r ? [{ at: r.at, text: r.at === cachedAt ? null : r.value }] : [] };
    }
    if (/^INSERT INTO kv_store/.test(s)) { const [key, value] = params; const at = new Date(Date.now() + (++tick)).toISOString(); rows.set(key, { value, at }); return { rows: [{ at }] }; }
    if (/^DELETE FROM kv_store/.test(s)) { rows.delete(params[0]); return { rowCount: 1 }; }
    if (/^SELECT key, updated_at FROM kv_store WHERE key LIKE/.test(s)) {
      const prefix = params[0].slice(0, -1).replace(/\\(.)/g, '$1');                 // db.js escapes \ % _ and appends %
      return { rows: [...rows.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, updated_at: rows.get(key).at })) };
    }
    if (/^UPDATE kv_store SET value/.test(s)) { const [key, packed, at] = params; const r = rows.get(key); if (r && r.at === at) { r.value = packed; return { rowCount: 1 }; } return { rowCount: 0 }; }
    throw new Error(`The stand-in for pg does not know this SQL: ${s.slice(0, 80)}`);
  }
}
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool } };
const mem = { clear: () => rows.clear(), keys: () => rows.keys(), values: () => [...rows.values()].map(r => r.value) };

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const XLSX = require('xlsx');
const F = require('./fakeZoho');
const { stmt, sup, inv } = require('./fixtures');
const store = require('../lib/store');
const files = require('../lib/files');

const blobs = new Map();
files.configure({ blob: { async exists(p) { return blobs.has(p); }, async save(p, buf) { blobs.set(p, Buffer.from(buf)); }, async read(p) { return blobs.get(p) || null; } } });

const USERS = [{ id: '1', username: 'cfo', name: 'CFO', role: 'admin', active: true, permissions: {} }];
const COMPANY = { id: 'devx', name: 'Test Co', short: 'T', org_id: F.ORG, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number', registrations: [{ gstin: F.REC_A, label: 'GJ', branch_ids: ['br_a'] }, { gstin: F.REC_B, label: 'MH', branch_ids: ['br_b'] }] };

async function boot(tc) {
  mem.clear(); blobs.clear();                                                          // every test starts from an empty Neon and an empty Blob
  const router = require('../index');
  const zr = F.makeFake();
  Object.assign(zr, { listOrganizations: async () => [], listBranches: async () => F.BRANCHES, checkAccess: async () => ({ ok: true, results: [] }) });
  router.init({ zr, loadUsers: async () => USERS, log: { error() {} } });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: '1' }; next(); });
  app.use('/api/gstr2b', router);
  const server = await new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/gstr2b`;
  const call = async (method, p, { body, form, raw } = {}) => {
    const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: form || (body ? JSON.stringify(body) : undefined) });
    if (raw) return res;
    const t = await res.text(); let j; try { j = JSON.parse(t); } catch (_) { j = t; }
    return { status: res.status, body: j };
  };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; router.stopScheduler(); server.closeAllConnections && server.closeAllConnections(); await new Promise(r => server.close(r)); };
  if (tc && tc.after) tc.after(close);
  return { call, zr, router };
}
const form = (buf, name) => { const f = new FormData(); f.append('file', new Blob([buf]), name); return f; };

test('online: the whole flow runs on Neon + Blob with a read-only disk', async tc => {
  const t = await boot(tc);
  const meta0 = (await t.call('GET', '/meta')).body;
  assert.equal(meta0.integrations.vercel, true); assert.equal(meta0.integrations.scheduler, false); assert.equal(meta0.integrations.max_upload_mb, 4);
  assert.equal(t.router.startScheduler(), undefined);                                  // no timers online
  assert.equal((await t.call('PUT', '/config/companies', { body: { companies: [COMPANY] } })).status, 200);

  // Zoho sync: online one slice runs inside the request
  t.zr.put('bills', F.bill({ id: 'b1', no: 'INV/001', date: '2026-10-05', taxable: 1000 }));
  t.zr.put('bills', F.bill({ id: 'b2', no: 'INV/002', date: '2026-10-06', taxable: 2000 }));
  t.zr.put('bills', F.bill({ id: 'b3', no: 'XYZ-77', date: '2026-10-07', taxable: 500 }));
  const run = await t.call('POST', '/sync/run', { body: { company: 'devx', mode: 'period', from: '2026-10', to: '2026-10' } });
  assert.equal(run.body.started, true); assert.equal(run.body.summary.status, 'completed', JSON.stringify(run.body.summary));
  const st = (await t.call('GET', '/sync/status?company=devx')).body;
  assert.equal(st.stats.detailed, 3); assert.equal(st.running, false);

  // statement upload: the original goes to Blob, not to the disk
  const buf = stmt({ b2b: [sup(F.SUP_GJ, [inv('INV/001', '05-10-2026', 1000, 90), inv('INV/002', '06-10-2026', 2000, 190), inv('QQ-1', '08-10-2026', 700, 63)])] });
  const pv = (await t.call('POST', '/import/preview', { form: form(buf, 'GSTR2B.json') })).body;
  assert.equal(pv.can_commit, true, JSON.stringify(pv.blockers));
  assert.equal(blobs.size, 1); assert.ok([...blobs.keys()][0].startsWith('gstr2b/'));
  const commit = (await t.call('POST', '/import/commit', { body: { preview_id: pv.preview_id } })).body;
  assert.equal(commit.statement.version, 1); assert.equal(commit.reconciliation.summary.exact, 1);
  assert.equal((await t.call('POST', '/import/preview', { form: form(buf, 'again.json') })).body.can_commit, false);   // duplicate refused
  const imp = (await t.call('GET', '/imports?company=devx')).body.statements[0];
  const file = await t.call('GET', `/imports/${imp.id}/file`, { raw: true });
  assert.ok(Buffer.compare(Buffer.from(await file.arrayBuffer()), buf) === 0);              // the original comes back byte for byte from Blob

  // review decisions persist across Neon reads
  const rows = (await t.call('GET', '/recon/rows?company=devx')).body.rows;
  const bo = rows.find(r => r.status === 'books_only'), po = rows.find(r => r.status === 'portal_only');
  assert.equal((await t.call('POST', '/recon/link', { body: { company: 'devx', gstin: F.REC_A, books_ids: bo.b.map(x => x.id), portal_ids: po.p.map(x => x.id), reason: 'Vendor re-issued the invoice' } })).status, 200);
  const after = (await t.call('GET', '/recon/rows?company=devx&status=mismatched')).body.rows;
  assert.ok(after.some(r => r.rule === 'MANUAL'));
  assert.equal((await t.call('POST', '/recon/run', { body: { company: 'devx', mode: 'all' } })).status, 200);       // a full re-run keeps the link
  assert.ok((await t.call('GET', '/recon/rows?company=devx&status=mismatched')).body.rows.some(r => r.rule === 'MANUAL'));
  const ex = await t.call('GET', '/export/xlsx?company=devx', { raw: true });
  assert.equal(ex.status, 200); assert.equal(XLSX.read(Buffer.from(await ex.arrayBuffer()), { type: 'buffer' }).SheetNames.length, 15);
  assert.equal((await t.call('GET', '/audit/verify')).body.ok, true);

  // the demo loads and is removed in Neon mode too
  assert.ok((await t.call('POST', '/demo/load')).body.counts.books_documents > 100);
  assert.equal((await t.call('POST', '/demo/remove')).body.removed, true);
  assert.ok(![...mem.keys()].some(k => k.startsWith('g2b_books_demo')));

  // everything lives under the module's own Neon keys, and nothing was written to the disk
  const keys = [...mem.keys()];
  assert.ok(keys.length > 8 && keys.every(k => k.startsWith('g2b_')), `unexpected keys: ${keys.filter(k => !k.startsWith('g2b_')).join(', ')}`);
  assert.deepEqual(touched, [], `the module wrote to the disk: ${touched.slice(0, 3).join(' | ')}`);
  assert.equal(fs.existsSync(SENTINEL), false);
  const biggest = Math.max(...[...mem.values()].map(v => v.length));
  console.log(`      Neon keys: ${keys.length}; largest document ${(biggest / 1024).toFixed(0)} KB (db.js stores documents over 64 KB compressed)`);
});

test('online: a Zoho sync slice that runs out of time stops cleanly and the next click continues where it stopped', async tc => {
  const t = await boot(tc);
  await t.call('PUT', '/config/companies', { body: { companies: [COMPANY] } });
  for (let i = 1; i <= 6; i++) t.zr.put('bills', F.bill({ id: `s${i}`, no: `S/${i}`, date: '2026-09-1' + i, taxable: 100 * i }));
  const sync = (await t.call('GET', '/meta')).body.sync;
  assert.ok(sync.slice_seconds >= 30 && sync.slice_seconds <= 250, 'a slice must leave room inside the 300-second function limit');
  assert.equal((await t.call('PUT', '/config/sync', { body: { slice_seconds: 290 } })).status, 400);                 // a value that could overrun the limit is refused
  const limits = await t.call('PUT', '/config/sync', { body: { slice_seconds: 30, pace_ms: 600 } });
  assert.equal(limits.status, 200);
  const first = (await t.call('POST', '/sync/run', { body: { company: 'devx', mode: 'period', from: '2026-09', to: '2026-09' } })).body.summary;
  assert.ok(['completed', 'partial'].includes(first.status));
  const second = (await t.call('POST', '/sync/run', { body: { company: 'devx', mode: 'period', from: '2026-09', to: '2026-09' } })).body.summary;
  assert.equal(second.status, 'completed');
  assert.equal((await t.call('GET', '/sync/status?company=devx')).body.stats.detailed, 6);

  // a sync running on ANOTHER serverless instance leaves its lease in the stored state: this instance refuses to start a second one
  await store.update('sync_devx', {}, s => { s.lease = { run_id: 'run_elsewhere', by: 'Another user', at: new Date().toISOString(), until: new Date(Date.now() + 120000).toISOString() }; });
  const busy = (await t.call('POST', '/sync/run', { body: { company: 'devx', mode: 'incremental' } })).body;
  assert.equal(busy.busy, true); assert.match(busy.message, /Another user/); assert.equal(busy.summary, undefined);
  assert.equal((await t.call('GET', '/sync/status?company=devx')).body.running, true);
  await store.update('sync_devx', {}, s => { s.lease = null; });
  assert.equal((await t.call('GET', '/sync/status?company=devx')).body.running, false);
  assert.deepEqual(touched, []);
});

test('online: first use — before anything is synced or uploaded every screen loads (a record that is not there yet reads as empty)', async tc => {
  const t = await boot(tc);
  assert.equal((await t.call('PUT', '/config/companies', { body: { companies: [COMPANY] } })).status, 200);   // the audit log writes its first entry into a database that has no log yet
  for (const p of ['/meta', '/sync/status?company=devx', '/imports?company=devx', '/recon/summary?company=devx', '/recon/rows?company=devx', '/recon/vendors?company=devx',
    '/recon/bridge?company=devx', '/recon/options?company=devx', '/coverage?company=devx', '/itc', '/audit', '/audit/verify']) {
    const r = await t.call('GET', p);
    assert.equal(r.status, 200, `${p} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  const st = (await t.call('GET', '/sync/status?company=devx')).body;
  assert.equal(st.running, false); assert.equal(st.stats.total, 0); assert.equal(st.last_ok_at, null);
  assert.deepEqual((await t.call('GET', '/imports?company=devx')).body.statements, []);
  assert.deepEqual(st.hwm, {}, 'no first sync yet');
  // "Sync changes now" before the first sync reads nothing, says so, and does not count as a successful sync
  const early = (await t.call('POST', '/sync/run', { body: { company: 'devx', mode: 'incremental' } })).body;
  assert.equal(early.summary.status, 'needs_first_sync');
  const after = (await t.call('GET', '/sync/status?company=devx')).body;
  assert.equal(after.last_ok_at, null); assert.deepEqual(after.hwm, {}); assert.equal(after.running, false);
  const audit = (await t.call('GET', '/audit')).body.entries;
  assert.ok(audit.some(e => /^config\./.test(e.action)) && audit.some(e => e.action === 'sync.incremental'), 'saving the settings and the early sync click were both recorded in the audit log');
  assert.equal((await t.call('GET', '/audit/verify')).body.ok, true);
  assert.equal((await t.call('GET', '/export/xlsx?company=devx', { raw: true })).status, 200);
  assert.deepEqual(touched, []);
});

test('online: a failed database read stops the request — it is never taken for an empty record and written back over the real one', async tc => {
  const t = await boot(tc);
  assert.equal((await t.call('PUT', '/config/companies', { body: { companies: [COMPANY] } })).status, 200);
  const logged = console.error; console.error = () => {};                              // db.js logs the failure it swallows; keep the report readable
  try {
    pgFail.skip = 1; pgFail.reads = 3;                                                 // a dropped connection exactly while a setting is saved (after the access check has read the settings)
    const r = await t.call('PUT', '/config/sync', { body: { pace_ms: 700 } });
    assert.equal(r.status, 500); assert.match(JSON.stringify(r.body), /could not be read just now — nothing was changed/);
  } finally { console.error = logged; pgFail.skip = 0; pgFail.reads = 0; }
  const meta = (await t.call('GET', '/meta')).body;
  assert.equal(meta.companies.length, 1, 'the company set-up is still there');
  assert.notEqual(meta.sync.pace_ms, 700, 'the failed save changed nothing');
  assert.equal((await t.call('PUT', '/config/sync', { body: { pace_ms: 700 } })).status, 200);   // the same save works once the database answers again
  assert.equal((await t.call('GET', '/meta')).body.sync.pace_ms, 700);
  assert.equal((await t.call('GET', '/meta')).body.companies.length, 1);

  // the same at the storage level, for a record the module changes and writes back
  await store.write('probe', { keep: 'me' });
  console.error = () => {};
  try {
    pgFail.reads = 1;
    await assert.rejects(store.update('probe', {}, d => { d.extra = 1; }), /could not be read just now/);
  } finally { console.error = logged; pgFail.reads = 0; }
  assert.deepEqual(await store.read('probe', null), { keep: 'me' });
  assert.deepEqual(await store.read('never_written', []), [], 'a record that really is not there is still the empty default');
  assert.deepEqual(await store.read('never_written_obj', {}), {});
  assert.equal(await store.read('never_written_null', null), null);
});
