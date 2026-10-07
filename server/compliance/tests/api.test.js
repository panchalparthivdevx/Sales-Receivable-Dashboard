'use strict';

// End-to-end through the real Express router (temp data folder, fake Zoho client).
// Uses the app's real login check: a signed JWT for user id '1' (the default admin).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const store = require('../lib/store');
const H = require('./helpers');

const tmp = H.tmpDir('cmp-api-');
store.configure({ dir: path.join(tmp, 'data'), useDb: false });
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'data', 'compliance_settings.json'), JSON.stringify({
  storage_root: path.join(tmp, 'storage'), backup_dir: path.join(tmp, 'backups'),
}));

const router = require('../index');
const zohoCalls = [];
router.setZohoGet(async (p, params) => {
  zohoCalls.push(p);
  return { [p.replace('/', '')]: [{ date: params.date_start, status: 'sent', total: 1000, amount: 1000 }], page_context: { has_more_page: false } };
});

const app = express();
app.use(express.json());
app.use('/api/compliance', router);
let server, base;
const token = jwt.sign({ id: '1', username: 'admin', role: 'admin' }, process.env.JWT_SECRET || 'da-finance-secret-2024', { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${token}` };

const api = async (method, url, body, headers = auth) => {
  const r = await fetch(base + url, { method, headers: { ...headers, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
};

test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/compliance`;
});
test.after(() => server.close());

test('API: everything needs a login (documents cannot be fetched without one)', async () => {
  for (const u of ['/meta', '/dashboard?fy=2026-27', '/documents/abc/download', '/zoho/status?fy=2026-27']) {
    const r = await api('GET', u, null, {});
    assert.equal(r.status, 401, u);
  }
  const forged = await api('GET', '/meta', null, { Authorization: 'Bearer ' + jwt.sign({ id: '1', role: 'admin' }, 'wrong-secret') });
  assert.equal(forged.status, 401);
});

test('API: seeded masters, August + Q1 rejected, generation, isolated dashboard', async () => {
  const meta = await api('GET', '/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.me.role, 'admin');
  assert.ok(meta.body.companies.some(c => c.short_code === 'DEVX'));

  const bad = await api('GET', '/dashboard?fy=2026-27&month=AUG&quarter=Q1');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /August belongs to Q2, not Q1/);

  const prev = await api('POST', '/tasks/generate', { fy: '2026-27' });
  assert.ok(prev.body.preview && prev.body.create > 100);
  const gen = await api('POST', '/tasks/generate', { fy: '2026-27', confirm: true });
  assert.equal(gen.body.created, prev.body.create);

  const aug = await api('GET', '/dashboard?fy=2026-27&month=AUG');
  assert.equal(aug.status, 200);
  assert.ok(aug.body.rows.length > 0);
  assert.ok(aug.body.rows.every(r => r.month === 'AUG' && r.quarter === 'Q2' && r.half === 'H1'));
  assert.equal(aug.body.kpis.total, aug.body.rows.length);
  const h2 = await api('GET', '/dashboard?fy=2026-27&half=H2');
  assert.ok(h2.body.rows.every(r => r.half === 'H2'));
});

test('API: task update — Completed needs a date in the past; Overdue cannot be set', async () => {
  const id = 'DEVX-GST002-2026-27-AUG';
  let r = await api('PUT', `/tasks/${id}`, { status: 'Overdue' });
  assert.equal(r.status, 400);
  r = await api('PUT', `/tasks/${id}`, { status: 'Completed', completion_date: '2099-01-01' });
  assert.equal(r.status, 400);
  r = await api('PUT', `/tasks/${id}`, { status: 'Completed', completion_date: '18-09-2026', remarks: 'Filed' });
  assert.equal(r.status, 200);
  const t = await api('GET', `/tasks/${id}`);
  assert.equal(t.body.task.display_status, 'Completed');
  assert.ok(t.body.audit.some(e => e.action === 'update' && e.changes.some(c => c.field === 'status')));
});

test('API: Zoho — revisiting a synced month makes zero Zoho calls', async () => {
  let s = await api('GET', '/zoho/status?fy=2026-27&month=AUG&company=CO-001');
  assert.equal(s.body.synced, 0);
  assert.equal(zohoCalls.length, 0, 'filter change / status read must not call Zoho');
  const sync = await api('POST', '/zoho/sync', { fy: '2026-27', month: 'AUG', company: 'CO-001' });
  assert.equal(sync.status, 200);
  const n = zohoCalls.length;
  assert.ok(n > 0);
  await api('GET', '/zoho/status?fy=2026-27&month=SEP&company=CO-001');
  await api('GET', '/dashboard?fy=2026-27&month=SEP');
  s = await api('GET', '/zoho/status?fy=2026-27&month=AUG&company=CO-001');
  const d = await api('GET', '/zoho/data?fy=2026-27&month=AUG&company=CO-001');
  await api('GET', '/dashboard?fy=2026-27&month=AUG');
  assert.equal(s.body.synced, 1);
  assert.equal(d.body.entities.find(e => e.key === 'invoices').count, 1);
  const again = await api('POST', '/zoho/sync', { fy: '2026-27', month: 'AUG', company: 'CO-001', only_missing: true });
  assert.equal(again.body.api_calls, 0);
  assert.equal(zohoCalls.length, n, 'no Zoho calls after the first sync');
  const q = await api('GET', '/zoho/status?fy=2026-27&quarter=Q2');
  assert.equal(q.body.synced, 1);
  assert.equal(q.body.total, 6);
});

test('API: upload routing, duplicate block, authenticated download, replace, delete', async () => {
  const id = 'DEVX-TDS001-2026-27-AUG';
  const pdf = (txt) => new Blob([Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(txt)])], { type: 'application/pdf' });
  const up = async (type, name, content) => { const f = new FormData(); f.append('doc_type', type); f.append('file', pdf(content), name); return api('POST', `/tasks/${id}/documents`, f); };

  const ch = await up('Challan', '../../../evil challan.pdf', 'challan-aug');
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.match(ch.body.document.folder, /^Dev Accelerator Limited\/FY 2026-27\/TDS\/Q2\/August\/Challan$/);
  assert.ok(fs.existsSync(path.join(tmp, 'storage', 'Dev Accelerator Limited', 'FY 2026-27', 'TDS', 'Q2', 'August', 'Challan', 'evil challan.pdf')));
  const rc = await up('Payment Receipt', 'receipt.pdf', 'receipt-aug');
  assert.match(rc.body.document.folder, /\/Receipt$/);
  const ot = await up('Notice', 'notice.pdf', 'notice-aug');
  assert.match(ot.body.document.folder, /\/Other Data$/);

  const dup = await up('Challan', 'again.pdf', 'challan-aug');
  assert.equal(dup.status, 409);

  const bad = new FormData(); bad.append('doc_type', 'Challan'); bad.append('file', new Blob(['MZ-not-a-pdf']), 'x.pdf');
  assert.equal((await api('POST', `/tasks/${id}/documents`, bad)).status, 400);

  const docId = ch.body.document.id;
  assert.equal((await api('GET', `/documents/${docId}/download`, null, {})).status, 401);
  const dl = await api('GET', `/documents/${docId}/download`);
  assert.equal(dl.status, 200);
  assert.ok(dl.body.toString().includes('challan-aug'));
  assert.equal(dl.headers.get('cache-control'), 'no-store');

  const rf = new FormData(); rf.append('file', pdf('challan-aug-v2'), 'challan v2.pdf');
  const rep = await api('PUT', `/documents/${docId}/replace`, rf);
  assert.equal(rep.status, 200);
  assert.equal(rep.body.document.version, 2);
  assert.ok(fs.readdirSync(path.join(tmp, 'storage', '_archive')).length === 1, 'old file archived, not served');

  const del = await api('DELETE', `/documents/${ot.body.document.id}`);
  assert.equal(del.status, 200);
  const t = await api('GET', `/tasks/${id}`);
  assert.equal(t.body.documents.length, 2);
  assert.ok(['upload', 'download', 'replace', 'delete'].every(a => t.body.audit.some(e => e.action === a)), 'all document actions are audited');
});

test('API: folder setup is idempotent', async () => {
  const a = await api('POST', '/folders/create', { company_id: 'CO-002', fy: '2026-27', modules: ['GST', 'Payroll'] });
  assert.deepEqual(a.body.results[0].modules.map(m => m.status), ['Created', 'Created']);
  const b = await api('POST', '/folders/create', { company_id: 'CO-002', fy: '2026-27', modules: ['GST', 'Payroll'] });
  assert.deepEqual(b.body.results[0].modules.map(m => m.status), ['Already Exists', 'Already Exists']);
});

test('API: import is Preview (no write) then Confirm (backup first, one write)', async () => {
  const head = ['Task ID', 'Company', 'FY', 'Month', 'Quarter', 'Half Year', 'Module', 'Compliance ID', 'Compliance Name', 'Applicable', 'Due Date', 'Responsible', 'Reviewer', 'Status', 'Completion Date', 'Remarks'];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head,
    ['DEVX-GST001-2026-27-AUG', '', '', '', '', '', '', '', '', '', '', 'Ravi', '', 'In Progress', '', ''],
    ['', 'DEVX', '2026-27', 'Aug', 'Q1', '', '', 'GST001', '', '', '', '', '', '', '', ''],
  ]), 'Tasks');
  const f = new FormData();
  f.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'tasks.xlsx');
  const dataFile = path.join(tmp, 'data', 'compliance_data.json');
  const before = fs.readFileSync(dataFile, 'utf8');
  const pv = await api('POST', '/import/preview', f);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.action_total, 1);
  assert.equal(pv.body.errors.length, 1);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), before, 'preview wrote nothing');
  const er = await api('GET', `/import/${pv.body.token}/errors`);
  const rows = XLSX.utils.sheet_to_json(XLSX.read(er.body).Sheets.Errors);
  assert.deepEqual(Object.keys(rows[0]), ['Sheet', 'Row', 'Field', 'Error', 'Suggested Fix']);
  const cf = await api('POST', '/import/confirm', { token: pv.body.token });
  assert.equal(cf.body.applied, 1);
  assert.ok(fs.readdirSync(path.join(tmp, 'backups')).some(n => n.includes('before-import')));
  const t = await api('GET', '/tasks/DEVX-GST001-2026-27-AUG');
  assert.equal(t.body.task.responsible, 'Ravi');
  assert.equal(t.body.task.status, 'In Progress');
});
