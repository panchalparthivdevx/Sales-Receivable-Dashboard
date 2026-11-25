/**
 * The HTTP routes, on an isolated express app: a stand-in login (header x-user), synthetic users, temporary store and files, no Zoho.
 * VERCEL=1 so server/db.js never mirrors anything to the office PC's real data files.
 */

'use strict';

process.env.VERCEL = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const XLSX = require('xlsx');
const H = require('./helpers');
const DEMO = require('../lib/demo');

const USERS = [
  { id: '1', username: 'admin', name: 'Admin', role: 'admin', active: true, permissions: {} },
  { id: '2', username: 'viewer', name: 'Viewer', role: 'user', active: true, permissions: { tds26as: { enabled: true, sections: {} } } },
  { id: '3', username: 'rev', name: 'Reviewer', role: 'user', active: true, permissions: { tds26as: { enabled: true, sections: { t26_review: true, t26_prepare: true } } } },
  { id: '4', username: 'none', name: 'No access', role: 'user', active: true, permissions: { tds26as: { enabled: false } } },
];
let base, server;

test.before(async () => {
  H.tempStore();
  const router = require('../index');
  router.init({ loadUsers: async () => USERS, zr: { get: async () => { throw new Error('no Zoho'); }, identity: () => 'test', errText: e => e.message, isGone: () => false, listOrganizations: async () => [] } });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || '1' }; next(); });
  app.use('/api/tds26as', router);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/tds26as`;
});
test.after(() => server && server.close());

const call = async (path, { user = '1', method = 'GET', body, form } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'x-user': user, ...(body ? { 'content-type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
};
const Q4 = 'entity=demo-x&fy=2025-26&q=4';

test('rights: no tick = no access; viewer can read but not review; demo loads for an admin only', async () => {
  assert.equal((await call('/meta', { user: '4' })).status, 403);
  assert.equal((await call('/demo/load', { user: '3', method: 'POST' })).status, 403);
  const d = await call('/demo/load', { method: 'POST' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const m = await call('/meta', { user: '2' });
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.rights, { prepare: false, review: false, config: false, admin: false });
  assert.equal(m.body.entities.length, 2);
  const dash = await call(`/recon/dashboard?${Q4}`, { user: '2' });
  assert.equal(dash.status, 200);
  assert.equal(dash.body.bridge.difference, 0);
  assert.equal(dash.body.totals.zoho, dash.body.totals.ledger_control);
  const units = await call(`/recon/units?${Q4}&status=not_in_26as`, { user: '2' });
  const g = units.body.units.find(u => u.client === 'ETA ZOHO ONLY LIMITED');
  assert.ok(g, 'the quarter parameter (q=4) is not taken for a text search');
  const s = await call(`/recon/units?${Q4}&search=iota`, { user: '2' });
  assert.deepEqual(s.body.units.map(u => u.client), ['IOTA OVERBOOKED LIMITED'], 'text search');
  const r = await call('/review/decision', { user: '2', method: 'POST', body: { entity: 'demo-x', fy: '2025-26', q: 4, unit: g.id, final_status: 'need_check' } });
  assert.equal(r.status, 403);
});

test('entity access: a user limited to one entity cannot open the other', async () => {
  const a = await call('/config/access', { method: 'PUT', body: { access: { 2: { entities: ['demo-y'] } } } });
  assert.equal(a.status, 200);
  assert.equal((await call(`/recon/dashboard?${Q4}`, { user: '2' })).status, 404);
  assert.equal((await call('/recon/dashboard?entity=demo-y&fy=2025-26&q=4', { user: '2' })).status, 200);
  assert.equal((await call('/meta', { user: '2' })).body.entities.length, 1);
  await call('/config/access', { method: 'PUT', body: { access: {} } });
});

test('upload over HTTP: a locked PDF asks for the password; the wrong entity is refused at commit', async () => {
  const sc = DEMO.scenario();
  const pdf = H.statementPdf({ pan: 'ZZZPD1234K', name: 'DEMO', fy: '2025-26', ay: '2026-27', updated: '15-Jun-2026', password: '01012010',
    deductors: [{ sr: 1, cl: sc.C.A, rows: [{ section: '194J(b)', date: '12-Jan-2026', status: 'F', booked: '15-May-2026', paid: 100000, deducted: 10000, deposited: 10000 }] }] });
  const form = () => { const f = new FormData(); f.append('entity', 'demo-y'); f.append('file', new Blob([pdf]), 'locked.pdf'); return f; };
  const p1 = await call('/import/preview', { method: 'POST', form: form() });
  assert.equal(p1.status, 422);
  assert.equal(p1.body.needs_password, true);
  const f2 = form(); f2.append('password', '01012010');
  const p2 = await call('/import/preview', { method: 'POST', form: f2 });
  assert.equal(p2.status, 200, JSON.stringify(p2.body));
  assert.equal(p2.body.totals.rows, 1);
  assert.ok(p2.body.validation.blockers.length, 'PAN of entity X uploaded under entity Y');
  const c = await call('/import/commit', { method: 'POST', body: { entity: 'demo-y', preview_id: p2.body.preview_id, ack: true } });
  assert.equal(c.status, 400);
  assert.match(c.body.error, /ZZZPD1234K/);
});

test('review over HTTP: carry forward, client owner, follow-up report and Excel export agree', async () => {
  const units = await call(`/recon/units?${Q4}&status=need_check&reason=timing`, { user: '3' });
  const f = units.body.units.find(u => u.client === 'ZETA TIMING PRIVATE LIMITED');
  const detail = await call(`/recon/unit?${Q4}&id=${f.id}`, { user: '3' });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.evidence[0].credit_line.txn_date, '2026-04-03');
  assert.equal(detail.body.comparison.calc.period_26as, '', 'the April credit is evidence, not part of the unit');
  const cf = await call('/review/decision', { user: '3', method: 'POST', body: { entity: 'demo-x', fy: '2025-26', q: 4, unit: f.id, final_status: 'carry_forward', remarks: 'April credit', carry_forward: { target: '2026-27-Q1', reason: 'Deducted in April' } } });
  assert.equal(cf.status, 200, JSON.stringify(cf.body));
  const mov = await call('/reports/carryforward?entity=demo-x&fy=2026-27', { user: '3' });
  assert.equal(mov.body.items[0].status, 'settled', 'the settlement pass ran after the decision');
  const fu = await call(`/reports/followup?${Q4}`, { user: '3' });
  const iota = fu.body.rows.find(r => r.client === 'IOTA OVERBOOKED LIMITED');
  const own = await call('/review/client', { user: '3', method: 'POST', body: { entity: 'demo-x', group: iota.id, owner_id: '3', remarks: 'Chase challan' } });
  assert.equal(own.body.owner, 'Reviewer');
  const fu2 = await call(`/reports/followup?${Q4}`, { user: '2' });
  assert.equal(fu2.body.rows.find(r => r.id === iota.id).owner, 'Reviewer');
  const x = await call(`/export/xlsx?${Q4}&report=followup`, { user: '2' });
  assert.equal(x.status, 200);
  const wb = XLSX.read(x.body, { type: 'buffer' });
  assert.ok(wb.SheetNames.includes('Client follow-up') && wb.SheetNames.includes('Open transactions'));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Client follow-up']);
  const total = rows.find(r => r.Client === 'TOTAL');
  assert.equal(Math.round(total['Amount requiring follow-up'] * 100), fu2.body.totals.follow_up);
  assert.equal(Math.round(total['TDS booked in Zoho'] * 100), (await call(`/recon/dashboard?${Q4}`)).body.totals.zoho);
  const all = await call(`/export/xlsx?${Q4}&report=all`);
  const wb2 = XLSX.read(all.body, { type: 'buffer' });
  for (const s of ['About', 'Client follow-up', 'Transactions', 'Source lines', 'Bridge', 'Zoho corrections', 'Carry-forward by quarter', 'Carry-forward items', 'Definitions']) assert.ok(wb2.SheetNames.includes(s), s);
  const audit = await call('/audit');
  assert.ok(audit.body.entries.some(e => e.action === 'review.decision') && audit.body.entries.some(e => e.action === 'export.xlsx'));
  assert.equal((await call('/audit/verify')).body.ok, true);
});

test('client totals: each row equals the Transactions list of that client; one status for a whole client (rights, remarks, stale page, carry forward kept, clear, export, audit)', async () => {
  const P = { entity: 'demo-x', fy: '2025-26' };
  const FY = 'entity=demo-x&fy=2025-26';   // the whole year: clients with several items
  const ct = await call(`/reports/clients?${FY}`, { user: '2' });
  assert.equal(ct.status, 200, JSON.stringify(ct.body));
  const dash = (await call(`/recon/dashboard?${FY}`)).body;
  const add = k => ct.body.rows.reduce((a, x) => a + x[k], 0);
  assert.equal(add('zoho'), dash.totals.zoho, 'the client rows add up to the Zoho TDS of the period');
  assert.equal(add('deposited'), dash.totals.deposited, '… and to the 26AS tax deposited');
  for (const row of ct.body.rows.filter(x => x.kind === 'client')) {
    const u = (await call(`/recon/units?${FY}&group=${row.id}&limit=3000`)).body;
    assert.deepEqual([u.sums.zoho, u.sums.deducted, u.sums.deposited, u.sums.diff, u.total], [row.zoho, row.deducted, row.deposited, row.diff, row.items], row.client);
    assert.equal(row.diff, row.zoho - row.deposited, row.client);
  }

  // two clients with open items, decided together; one open item of the second is carried forward first — the whole-client status
  // leaves it (and its carry-forward item) alone
  const unitsOf = async id => (await call(`/recon/units?${FY}&group=${id}&limit=3000`)).body.units;
  const open = ct.body.rows.filter(x => x.kind === 'client' && x.cleared < x.items && !x.carry_forward);
  let cfRow = null, cfUnit = null, target = null;
  for (const row of open) {
    cfUnit = (await unitsOf(row.id)).find(u => (u.open_zoho > 0 || u.open_26as > 0) && u.method !== 'cf_settlement' && u.effective !== 'carry_forward');
    if (cfUnit) { cfRow = row; break; }
  }
  for (const row of open) if (!target && row !== cfRow && (await unitsOf(row.id)).some(u => u.zoho.length && u.credits.length)) target = row;   // an item with entries AND credits
  assert.ok(cfRow && target, JSON.stringify(open.map(x => [x.client, x.items, x.cleared])));
  const both = new Set([target.id, cfRow.id]);
  const others = (await call(`/recon/units?${FY}&limit=3000`)).body.units.filter(u => !both.has(u.group)).map(u => [u.id, u.effective]);
  const body = (extra = {}) => ({ ...P, clients: [target, cfRow].map(x => ({ id: x.id, units: x.units })), final_status: 'rounding', remarks: 'Total difference negligible — manual reconciliation', ...extra });

  assert.equal((await call('/review/client-decision', { user: '2', method: 'POST', body: body() })).status, 403, 'a viewer cannot set a status');
  const noRemark = await call('/review/client-decision', { user: '3', method: 'POST', body: body({ remarks: '  ' }) });
  assert.equal(noRemark.status, 400);
  assert.match(noRemark.body.error, /remarks/);
  const cfAsked = await call('/review/client-decision', { user: '3', method: 'POST', body: body({ final_status: 'carry_forward' }) });
  assert.equal(cfAsked.status, 400);
  const stale = await call('/review/client-decision', { user: '3', method: 'POST', body: body({ clients: [{ id: target.id, units: [...target.units, 'u0000000000000000'] }] }) });
  assert.equal(stale.status, 409, 'the page showed other items than the client has now');

  const cfr = await call('/review/decision', { user: '3', method: 'POST', body: { ...P, unit: cfUnit.id, final_status: 'carry_forward', remarks: 'expected next year', carry_forward: { target: '2026-27-Q1', reason: 'credit expected in Q1' } } });
  assert.equal(cfr.status, 200, JSON.stringify(cfr.body));
  const ok = await call('/review/client-decision', { user: '3', method: 'POST', body: body() });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.clients, ok.body.units, ok.body.skipped_carry_forward], [2, target.items + cfRow.items - 1, 1]);

  const after = [...await unitsOf(target.id), ...await unitsOf(cfRow.id)];
  assert.ok(after.filter(u => u.id !== cfUnit.id).every(u => u.effective === 'rounding' && u.final_status === 'rounding' && u.decision.remarks === 'Total difference negligible — manual reconciliation'), JSON.stringify(after.map(u => [u.effective, u.final_status])));
  const cfAfter = after.find(u => u.id === cfUnit.id);
  assert.equal(cfAfter.effective, 'carry_forward');
  assert.equal(cfAfter.cf_item.status, 'open', 'the carry-forward item stays open');
  const othersAfter = (await call(`/recon/units?${FY}&limit=3000`)).body.units.filter(u => !both.has(u.group)).map(u => [u.id, u.effective]);
  assert.deepEqual(othersAfter, others, 'no other client changes');
  const two = after.find(u => u.id !== cfUnit.id && u.zoho.length && u.credits.length);
  const drawer = (await call(`/recon/unit?${FY}&id=${two.id}`)).body;
  assert.equal(drawer.history.length, two.zoho.length + two.credits.length);
  assert.ok(drawer.history.every(h => h.history.some(x => x.whole_client && x.final_status === 'rounding')), 'every Zoho entry and 26AS credit of the item has the decision, marked as coming from the whole client');

  const rows2 = (await call(`/reports/clients?${FY}`)).body.rows;
  const row2 = rows2.find(x => x.id === target.id), cf2 = rows2.find(x => x.id === cfRow.id);
  assert.deepEqual([row2.client_status, row2.reviewed, row2.decision.final_status, row2.decision.this_period, row2.decision.by], ['rounding', target.items, 'rounding', true, 'Reviewer']);
  assert.equal(cf2.client_status, cfRow.items === 1 ? 'carry_forward' : '', 'a client with a carried-forward item does not show one status unless that is all it has');
  assert.equal(cf2.decision.remarks, 'Total difference negligible — manual reconciliation');
  // looked at for one quarter only, the decision is shown as made for the whole year
  const m = +two.date.slice(5, 7), q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;
  const inQ = (await call(`/reports/clients?entity=demo-x&fy=2025-26&q=${q}`)).body.rows.find(x => x.id === target.id);
  assert.deepEqual([inQ.decision.this_period, inQ.decision.period.from, inQ.decision.period.to], [false, '2025-04-01', '2026-03-31']);
  // a client with one item reviewed and one not has no single client status (whichever item is reviewed)
  const alpha = rows2.find(x => x.kind === 'client' && x.items >= 2 && !x.reviewed);
  assert.ok(alpha, 'a client with two unreviewed items');
  for (const id of alpha.units) {
    await call('/review/decision', { user: '3', method: 'POST', body: { ...P, unit: id, final_status: 'matched', remarks: 'checked' } });
    const a = (await call(`/reports/clients?${FY}`)).body.rows.find(x => x.id === alpha.id);
    assert.deepEqual([a.client_status, a.reviewed], ['', 1], 'reviewer status on one of two items only');
    await call('/review/decision', { user: '3', method: 'POST', body: { ...P, unit: id, final_status: '' } });
  }
  // the export shows the figures and the decision
  const x = await call(`/export/xlsx?${FY}&report=clients`, { user: '2' });
  assert.equal(x.status, 200);
  const wb = XLSX.read(x.body, { type: 'buffer' });
  assert.ok(wb.SheetNames.includes('Client totals'), wb.SheetNames.join());
  const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets['Client totals']);
  const xr = sheetRows.find(r => r.Client === target.client);
  assert.equal(Math.round(xr['Difference (Zoho − deposited)'] * 100), target.diff);
  assert.equal(xr.Remarks, 'Total difference negligible — manual reconciliation');
  assert.equal(Math.round(sheetRows.find(r => r.Client === 'TOTAL')['TDS booked in Zoho'] * 100), dash.totals.zoho);

  // back to the system status (no remarks needed); the carried-forward item is still left alone
  const clr = await call('/review/client-decision', { user: '3', method: 'POST', body: body({ final_status: '', remarks: '' }) });
  assert.equal(clr.status, 200, JSON.stringify(clr.body));
  const cleared = [...await unitsOf(target.id), ...await unitsOf(cfRow.id)];
  assert.ok(cleared.filter(u => u.id !== cfUnit.id).every(u => u.final_status === '' && u.effective === u.status));
  assert.equal(cleared.find(u => u.id === cfUnit.id).effective, 'carry_forward');
  const audit = await call('/audit');
  assert.equal(audit.body.entries.filter(e => e.action === 'review.client_decision').length, 2);
  assert.ok(audit.body.entries.find(e => e.action === 'review.client_decision' && /Matched Rounding Diff\./.test(e.detail)).detail.includes(target.client));
  assert.equal((await call('/audit/verify')).body.ok, true);
});

test('demo data can be removed again; a real entity needs PAN, organisation and a ledger', async () => {
  const bad = await call('/config/entities', { method: 'PUT', body: { entities: [{ id: 'devx', name: 'Dev Accelerator Limited', pan: 'AAHCD9502C', org_id: '60027116474', ledgers: [] }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /ledger/);
  const r = await call('/demo/remove', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal((await call('/meta')).body.entities.length, 0);
});
