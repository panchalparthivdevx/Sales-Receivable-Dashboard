/**
 * The API through a real Express app with a temporary store: rights, import → commit → no duplicate → rollback,
 * persistence after a restart, decisions, adjustments, management inputs and exports.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const ROOT = '..';
const real = H.hasReal();

function fresh(dir) {
  for (const k of Object.keys(require.cache)) if (k.includes(`${require('path').sep}fin-reporting${require('path').sep}`) && !k.includes(`${require('path').sep}tests${require('path').sep}`)) delete require.cache[k];
  require('../lib/store').configure({ dir, useDb: false });
  return require(ROOT);
}

test('rights: no access, view only, import', async () => {
  const dir = H.tempStore();
  const srv = H.app(fresh(dir)).listen(0);
  try {
    assert.strictEqual((await H.call(srv, 'GET', '/api/fin-reporting/status', { user: '3' })).status, 403);
    const v = await H.call(srv, 'GET', '/api/fin-reporting/status', { user: '2' });
    assert.strictEqual(v.status, 200);
    assert.deepStrictEqual([v.body.rights.import, v.body.rights.adjust, v.body.rights.inputs], [false, false, false]);
    assert.strictEqual((await H.call(srv, 'POST', '/api/fin-reporting/import/commit', { user: '2' })).status, 403);
    assert.strictEqual((await H.call(srv, 'POST', '/api/fin-reporting/inputs/record', { user: '4', body: { type: 'budget' } })).status, 403);
    assert.strictEqual((await H.call(srv, 'GET', '/api/fin-reporting/statement?basis=SA&stmt=PL')).body.code, 'NO_IMPORT');
  } finally { srv.close(); }
});

test('import lifecycle on the real workbooks: commit, no duplicate, rollback, restart', { skip: !real && 'real workbooks not present' }, async () => {
  const dir = H.tempStore();
  let srv = H.app(fresh(dir)).listen(0);
  let firstId;
  try {
    const f = await H.call(srv, 'POST', '/api/fin-reporting/import/folder');
    assert.strictEqual(f.status, 200);
    assert.strictEqual(f.body.staged.length, 6);
    const c1 = await H.call(srv, 'POST', '/api/fin-reporting/import/commit');
    assert.strictEqual(c1.status, 200);
    firstId = c1.body.id;
    assert.ok(c1.body.counts.facts > 3000);
    const c2 = await H.call(srv, 'POST', '/api/fin-reporting/import/commit');
    assert.strictEqual(c2.body.unchanged, true);
    const st = await H.call(srv, 'GET', '/api/fin-reporting/status');
    assert.strictEqual(st.body.versions.length, 1);
    // a changed staging set (one workbook removed) makes a second version; rollback returns to the first
    const sha = st.body.staging[0].sha256;
    await H.call(srv, 'DELETE', `/api/fin-reporting/import/staging/${sha}`);
    const c3 = await H.call(srv, 'POST', '/api/fin-reporting/import/commit');
    assert.ok(c3.body.id && c3.body.id !== firstId);
    const rb = await H.call(srv, 'POST', '/api/fin-reporting/import/rollback', { body: { versionId: firstId, reason: 'test' } });
    assert.strictEqual(rb.status, 200);
    const st2 = await H.call(srv, 'GET', '/api/fin-reporting/status');
    assert.strictEqual(st2.body.active.id, firstId);
    assert.deepStrictEqual(st2.body.versions.map(x => x.status).sort(), ['active', 'rolled back']);
    // decisions and adjustments are stored apart from the facts
    const rec = await H.call(srv, 'GET', '/api/fin-reporting/recon');
    assert.ok(rec.body.rows.length > 1000);
    const d = rec.body.decisions[0];
    if (d) {
      const opt = d.options[1];
      assert.strictEqual((await H.call(srv, 'POST', '/api/fin-reporting/decisions', { body: { key: d.key, factKey: opt.factKey, reason: '' } })).status, 400);
      assert.strictEqual((await H.call(srv, 'POST', '/api/fin-reporting/decisions', { body: { key: d.key, factKey: opt.factKey, reason: 'test choice' } })).status, 200);
      const per = d.p.startsWith('BS-') ? 'BS' : 'PL';
      const view = await H.call(srv, 'GET', `/api/fin-reporting/statement?basis=${d.b}&stmt=${per}&periods=${d.p}`);
      const cell = view.body.rows.find(r => r.id === d.l).cells[d.p];
      assert.ok(cell.decided);
      assert.ok(Math.abs(cell.v - opt.v) < 1e-9);
    }
    assert.strictEqual((await H.call(srv, 'POST', '/api/fin-reporting/adjustments', { body: { basis: 'SA', line: 'pl.rev', period: 'FY2027-Q2', amount: 1 } })).status, 400);
    assert.strictEqual((await H.call(srv, 'POST', '/api/fin-reporting/adjustments', { body: { basis: 'SA', line: 'pl.rev', period: 'FY2027-Q2', amount: 1, reason: 'test', evidence: 'test' } })).status, 200);
    const plain = await H.call(srv, 'GET', '/api/fin-reporting/statement?basis=SA&stmt=PL&periods=FY2027-Q2');
    const adj = await H.call(srv, 'GET', '/api/fin-reporting/statement?basis=SA&stmt=PL&periods=FY2027-Q2&adj=1');
    const r0 = plain.body.rows.find(r => r.id === 'pl.rev').cells['FY2027-Q2'].v, r1 = adj.body.rows.find(r => r.id === 'pl.rev').cells['FY2027-Q2'].v;
    assert.ok(Math.abs(r1 - r0 - 1) < 1e-9, 'adjustment only in the adjusted view');
    const x = await H.call(srv, 'GET', '/api/fin-reporting/export?what=statement&basis=CO&stmt=BS', { raw: true });
    assert.strictEqual(x.status, 200);
    assert.match(x.headers.get('content-type'), /spreadsheetml/);
  } finally { srv.close(); }
  // restart: a new router instance reads the same store
  srv = H.app(fresh(dir)).listen(0);
  try {
    const st = await H.call(srv, 'GET', '/api/fin-reporting/status');
    assert.strictEqual(st.body.active.id, firstId);
    const pl = await H.call(srv, 'GET', '/api/fin-reporting/statement?basis=SA&stmt=PL');
    assert.ok(Math.abs(pl.body.rows.find(r => r.id === 'pl.rev').cells['FY2027-Q2'].v - 6299.162351) < 1e-5);
  } finally { srv.close(); }
});

test('management inputs: validation, upload template round trip, settings', async () => {
  const dir = H.tempStore();
  const srv = H.app(fresh(dir)).listen(0);
  try {
    const bad = await H.call(srv, 'POST', '/api/fin-reporting/inputs/record', { body: { type: 'budget', values: { line: 'EBITDA' } } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /required/);
    const ok = await H.call(srv, 'POST', '/api/fin-reporting/inputs/record', { body: { type: 'budget', source: 'test budget', values: { version: 'T1', line: 'Revenue from operations', periodEnd: '2026-09-30', amount: '1000' } } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.record.values.amount, 1000);
    const tpl = await H.call(srv, 'GET', '/api/fin-reporting/inputs/template/debt_schedule', { raw: true });
    assert.strictEqual(tpl.status, 200);
    // fill the template and upload it
    const XLSX = require('xlsx');
    const wb = XLSX.read(Buffer.from(await tpl.arrayBuffer()));
    const head = XLSX.utils.sheet_to_json(wb.Sheets.Data, { header: 1 })[0];
    const row = head.map(h => ({ Company: 'Dev Accelerator Ltd', 'Basis (Standalone / Consolidated)': 'Standalone', Source: 'loan agreement', 'Lender *': 'Bank A', 'Facility *': 'TL1', 'Due date / month end *': '2026-12-31', 'Scheduled principal (₹ lakh) *': 50 })[h] ?? null);
    wb.Sheets.Data = XLSX.utils.aoa_to_sheet([head, row]);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const form = new FormData(); form.append('file', new Blob([buf]), 'debt.xlsx');
    const up = await H.call(srv, 'POST', '/api/fin-reporting/inputs/upload/debt_schedule', { form });
    assert.strictEqual(up.status, 200, up.text);
    assert.strictEqual(up.body.saved, 1);
    const s = await H.call(srv, 'PUT', '/api/fin-reporting/inputs/settings', { body: { thresholds: { materiality: '2' }, alerts: { 'liq.cr': { min: '1.1', max: '' } }, gstOnReceivables: '0.18' } });
    assert.strictEqual(s.status, 200);
    const all = await H.call(srv, 'GET', '/api/fin-reporting/inputs');
    assert.strictEqual(all.body.settings.thresholds.materiality, 2);
    assert.deepStrictEqual(all.body.settings.alerts['liq.cr'], { min: 1.1, max: null });
    assert.strictEqual(all.body.coverage.counts.debt_schedule, 1);
  } finally { srv.close(); }
});
