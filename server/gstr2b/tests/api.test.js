/**
 * The HTTP API: rights, company / GSTIN scoping, onboarding, import, review actions, export, audit, demo data.
 * Runs the real router on a local port with a fake Zoho and fake users. SYNTHETIC data.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const XLSX = require('xlsx');
const { tempDir, rm, gstin, FAST_SYNC } = require('./helpers');
const F = require('./fakeZoho');
const { stmt, inv, sup, item } = require('./fixtures');
const store = require('../lib/store');
const files = require('../lib/files');
const books = require('../lib/booksStore');

const USERS = [
  { id: '1', username: 'admin', name: 'Admin', role: 'admin', active: true, permissions: {} },
  { id: '2', username: 'prep', name: 'Preparer', role: 'user', active: true, permissions: { gstr2b: { enabled: true, sections: { g2b_prepare: true } } } },
  { id: '3', username: 'rev', name: 'Reviewer', role: 'user', active: true, permissions: { gstr2b: { enabled: true, sections: { g2b_prepare: true, g2b_review: true } } } },
  { id: '4', username: 'reader', name: 'Reader', role: 'user', active: true, permissions: { gstr2b: { enabled: true, sections: {} } } },
  { id: '5', username: 'nobody', name: 'No access', role: 'user', active: true, permissions: { gstr2b: { enabled: false } } },
  { id: '6', username: 'cfo', name: 'CFO', role: 'user', active: true, permissions: { gstr2b: { enabled: true, sections: { g2b_prepare: true, g2b_review: true, g2b_config: true, g2b_approve: true } } } },
];

async function boot(tc) {
  const dir = tempDir();
  store.configure({ dir: dir + '/data', useDb: false });
  files.configure({ dir: dir + '/files', blob: null });
  await store.write('config', { sync: FAST_SYNC });
  const router = require('../index');
  const zr = F.makeFake();
  Object.assign(zr, { listOrganizations: async () => [{ id: F.ORG, name: 'Test Org', gst_registered: true, currency: 'INR', default: true }], listBranches: async () => F.BRANCHES,
    checkAccess: async () => ({ ok: true, credentials: 'fake', read_only: true, results: [{ label: 'Bills', ok: true }] }) });
  router.init({ zr, loadUsers: async () => USERS, log: { error() {} } });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || '1' }; next(); });
  app.use('/api/gstr2b', router);
  const server = await new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/gstr2b`;
  const call = async (method, path, { user = '1', body, form, raw } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'x-user': user, ...(body ? { 'content-type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    if (raw) return res;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: res.status, body: json };
  };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; router.stopScheduler(); server.closeAllConnections && server.closeAllConnections(); await new Promise(r => server.close(r)); rm(dir); };
  if (tc && tc.after) tc.after(close);                                    // always closed, even when an assertion fails
  return { dir, server, call, zr, router, close };
}
const COMPANY = { id: 'devx', name: 'Test Co', short: 'T', org_id: F.ORG, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number', registrations: [{ gstin: F.REC_A, label: 'GJ', branch_ids: ['br_a'] }, { gstin: F.REC_B, label: 'MH', branch_ids: ['br_b'] }] };
const form = (buf, name, extra = {}) => { const f = new FormData(); f.append('file', new Blob([buf]), name); for (const [k, v] of Object.entries(extra)) f.append(k, v); return f; };

test('rights: no access, read-only, preparer, reviewer, configurer — each action needs its own right', async tc => {
  const t = await boot(tc);
  assert.equal((await t.call('GET', '/meta', { user: '5' })).status, 403);
  assert.equal((await t.call('GET', '/meta', { user: '4' })).status, 200);
  assert.deepEqual((await t.call('GET', '/meta', { user: '4' })).body.rights, { prepare: false, review: false, approve: false, config: false, admin: false });
  assert.equal((await t.call('PUT', '/config/companies', { user: '3', body: { companies: [COMPANY] } })).status, 403);                // reviewer cannot configure
  assert.equal((await t.call('POST', '/sync/run', { user: '4', body: { company: 'devx', mode: 'incremental' } })).status, 403);       // reader cannot sync
  assert.equal((await t.call('POST', '/recon/approve', { user: '2', body: { keys: ['x'], reason: 'r' } })).status, 403);              // preparer cannot approve
  assert.equal((await t.call('GET', '/audit', { user: '2' })).status, 403);
  assert.equal((await t.call('POST', '/demo/load', { user: '6' })).status, 403);                                                      // demo data is admin only
  assert.match((await t.call('GET', '/meta', { user: '99' })).body.error, /access/);                                                   // unknown user
  await t.close();
});

test('onboarding: organisations and branches come from Zoho (read-only); GSTINs are verified before they are saved', async tc => {
  const t = await boot(tc);
  const orgs = await t.call('POST', '/onboard/zoho-orgs', { user: '6' });
  assert.equal(orgs.body.organizations[0].id, F.ORG); assert.equal(orgs.body.organizations[0].configured, false);
  const br = (await t.call('POST', '/onboard/branches', { user: '6', body: { org_id: F.ORG } })).body;
  assert.equal(br.registrations.length, 2); assert.equal(br.unmapped.length, 1); assert.equal(br.unmapped[0].name, 'Unmapped Branch');
  const gj = br.registrations.find(r => r.gstin === F.REC_A);
  assert.deepEqual(gj.branch_ids, ['br_a']); assert.ok(gj.checks.every(c => c.ok)); assert.equal(gj.state, 'GJ');
  assert.equal((await t.call('POST', '/onboard/branches', { user: '6', body: { org_id: 'abc' } })).status, 400);
  // saving: bad GSTIN, duplicate GSTIN, GSTIN not on any Zoho branch
  const bad = await t.call('PUT', '/config/companies', { user: '6', body: { companies: [{ ...COMPANY, registrations: [{ gstin: '24AAAAA0000A1Z0' }] }] } });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /check digit/);
  const dup = await t.call('PUT', '/config/companies', { user: '6', body: { companies: [COMPANY, { ...COMPANY, id: 'other', name: 'Other', org_id: '11111111111' }] } });
  assert.equal(dup.status, 400); assert.match(dup.body.error, /one company|already|both/);
  const unknown = await t.call('PUT', '/config/companies', { user: '6', body: { companies: [{ ...COMPANY, registrations: [{ gstin: gstin('06', 'AAACX9999X') }] }] } });
  assert.equal(unknown.status, 200); assert.match(unknown.body.warnings.join(' '), /not on any branch in Zoho/);
  const ok = await t.call('PUT', '/config/companies', { user: '6', body: { companies: [COMPANY] } });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.warnings, []);
  assert.equal(ok.body.companies[0].registrations[0].verified.source, 'Zoho branches');
  assert.equal(ok.body.companies[0].registrations[0].verified.branches, 1);
  // no company can be silently re-pointed at another Zoho organisation
  const swap = await t.call('PUT', '/config/companies', { user: '6', body: { companies: [{ ...COMPANY, org_id: '99999999999' }] } });
  assert.match(swap.body.error, /cannot be changed/);
  const meta = (await t.call('GET', '/meta', { user: '6' })).body;
  assert.equal(meta.companies[0].registrations.length, 2); assert.equal(meta.integrations.read_only, true);
  assert.equal((await t.call('POST', '/onboard/check', { user: '6', body: { company: 'devx' } })).body.read_only, true);
  await t.close();
});

test('settings, schedule and sync limits are validated and audited; the audit chain verifies', async tc => {
  const t = await boot(tc);
  await t.call('PUT', '/config/companies', { user: '6', body: { companies: [COMPANY] } });
  assert.equal((await t.call('PUT', '/config/settings', { user: '6', body: { tol_p: { cgst: 300 } } })).body.settings.tol_p.cgst, 300);
  assert.equal((await t.call('PUT', '/config/settings', { user: '6', body: { tol_p: { cgst: 99999 } } })).status, 400);
  assert.deepEqual((await t.call('PUT', '/config/schedule', { user: '6', body: { times: ['21:20', '13:20', '13:20'] } })).body.schedule.times, ['13:20', '21:20']);
  assert.equal((await t.call('PUT', '/config/schedule', { user: '6', body: { times: ['25:00'] } })).status, 400);
  assert.equal((await t.call('PUT', '/config/sync', { user: '6', body: { daily_budget: 100000 } })).status, 400);
  assert.equal((await t.call('PUT', '/config/sync', { user: '6', body: { rate_per_min: 500 } })).status, 400, 'more calls a minute than Zoho allows one user is refused');
  const saved = (await t.call('PUT', '/config/sync', { user: '6', body: { rate_per_min: 100, concurrency: 5, daily_budget: 40000, zoho_reserve: 20000, pace_ms: 6000 } })).body.sync;
  assert.deepEqual(saved, { rate_per_min: 100, concurrency: 5, daily_budget: 40000, zoho_reserve: 20000, slice_seconds: 60 }, 'the old "pause between calls" is not a setting any more');
  const meta = (await t.call('GET', '/meta', { user: '6' })).body;
  assert.deepEqual(meta.schedule.times, ['13:20', '21:20']);
  const audit = (await t.call('GET', '/audit', { user: '6' })).body.entries;
  assert.ok(audit.some(e => e.action === 'config.companies') && audit.some(e => e.action === 'config.settings') && audit.some(e => e.action === 'config.schedule'));
  assert.equal((await t.call('GET', '/audit/verify', { user: '6' })).body.ok, true);
  // tampering with a stored entry is detected
  const ym = new Date().toISOString().slice(0, 7).replace('-', '_');
  const entries = await store.read(`audit_${ym}`, []);
  entries[0].detail = 'changed afterwards'; await store.write(`audit_${ym}`, entries);
  const v = (await t.call('GET', '/audit/verify', { user: '6' })).body;
  assert.equal(v.ok, false); assert.match(v.reason, /changed after it was written/);
  await t.close();
});

test('access limits: a user restricted to one GSTIN sees only that registration everywhere', async tc => {
  const t = await boot(tc);
  await t.call('PUT', '/config/companies', { user: '6', body: { companies: [COMPANY] } });
  await t.call('PUT', '/config/access', { user: '1', body: { access: { 4: { companies: ['devx'], gstins: [F.REC_B] } } } });
  const meta = (await t.call('GET', '/meta', { user: '4' })).body;
  assert.deepEqual(meta.companies[0].registrations.map(r => r.gstin), [F.REC_B]);
  assert.equal((await t.call('GET', `/recon/summary?company=devx&gstin=${F.REC_A}`, { user: '4' })).body.registrations.length, 0);
  assert.equal((await t.call('GET', `/recon/summary?company=devx`, { user: '4' })).body.registrations.length, 1);
  assert.equal((await t.call('POST', '/recon/run', { user: '3', body: { company: 'devx', gstin: F.REC_A } })).status, 200);          // user 3 is unrestricted
  assert.equal((await t.call('PUT', '/config/access', { user: '6', body: { access: {} } })).status, 403);                           // only an administrator sets access
  // a restricted user cannot import for a GSTIN outside their scope
  await t.call('PUT', '/config/access', { user: '1', body: { access: { 2: { companies: ['devx'], gstins: [F.REC_B] } } } });
  const pv = await t.call('POST', '/import/preview', { user: '2', form: form(stmt({ gstin: F.REC_A, b2b: [sup(F.SUP_GJ, [inv('A-1', '05-10-2026', 1000, 90)])] }), 'a.json') });
  assert.match(pv.body.blockers.join(' '), /not set up/);
  await t.close();
});

test('end to end over HTTP: sync → import → reconcile → review → export, with the audit trail', async tc => {
  const t = await boot(tc);
  await t.call('PUT', '/config/companies', { user: '6', body: { companies: [COMPANY] } });
  // Zoho data and a first sync (the fake clock for budget is irrelevant here)
  t.zr.put('bills', F.bill({ id: 'b1', no: 'INV/001', date: '2026-10-05', taxable: 1000 }));
  t.zr.put('bills', F.bill({ id: 'b2', no: 'INV/002', date: '2026-10-06', taxable: 2000 }));
  t.zr.put('bills', F.bill({ id: 'b3', no: 'XYZ-77', date: '2026-10-07', taxable: 500 }));
  const started = (await t.call('POST', '/sync/run', { user: '2', body: { company: 'devx', mode: 'period', from: '2026-10', to: '2026-10' } })).body;
  assert.equal(started.started, true);
  for (let i = 0; i < 100 && (await t.call('GET', '/sync/status?company=devx')).body.running; i++) await new Promise(r => setTimeout(r, 20));
  const st = (await t.call('GET', '/sync/status?company=devx')).body;
  assert.equal(st.stats.detailed, 3); assert.equal(st.runs[0].status, 'completed'); assert.equal(st.credentials, 'fake credentials');
  // import a statement
  const buf = stmt({ b2b: [sup(F.SUP_GJ, [inv('INV/001', '05-10-2026', 1000, 90), inv('INV/002', '06-10-2026', 2000, 190), inv('QQ-1', '08-10-2026', 700, 63)])] });
  const pv = (await t.call('POST', '/import/preview', { user: '2', form: form(buf, 'GSTR2B_oct.json') })).body;
  assert.equal(pv.can_commit, true); assert.equal(pv.docs, 3); assert.equal(pv.company, 'devx'); assert.equal(pv.version, 1);
  const dup = (await t.call('POST', '/import/commit', { user: '2', body: { preview_id: pv.preview_id } }));
  assert.equal(dup.status, 200); assert.equal(dup.body.statement.version, 1);
  assert.equal(dup.body.reconciliation.summary.exact, 1); assert.equal(dup.body.reconciliation.summary.mismatched, 1);
  assert.equal((await t.call('POST', '/import/preview', { user: '2', form: form(buf, 'again.json') })).body.can_commit, false);              // repeated upload
  // dashboard
  const sum = (await t.call('GET', '/recon/summary?company=devx', { user: '4' })).body;
  assert.equal(sum.summary.by_status.exact.rows, 1); assert.equal(sum.summary.by_status.mismatched.rows, 1); assert.equal(sum.summary.by_status.books_only.rows, 1); assert.equal(sum.summary.by_status.portal_only.rows, 1);
  assert.equal(sum.bridge_ties, true);
  const list = (await t.call('GET', '/recon/rows?company=devx&status=books_only,portal_only', { user: '4' })).body;
  assert.equal(list.total, 2);
  const bo = list.rows.find(r => r.status === 'books_only'), po = list.rows.find(r => r.status === 'portal_only');
  // reviewer links the two unmatched documents (the vendor confirmed a different invoice number and amount)
  const noReason = await t.call('POST', '/recon/link', { user: '3', body: { company: 'devx', gstin: F.REC_A, books_ids: bo.b.map(x => x.id), portal_ids: po.p.map(x => x.id), reason: '' } });
  assert.equal(noReason.status, 400);
  assert.equal((await t.call('POST', '/recon/link', { user: '2', body: { company: 'devx', gstin: F.REC_A, books_ids: bo.b.map(x => x.id), portal_ids: po.p.map(x => x.id), reason: 'x' } })).status, 403);
  const linked = await t.call('POST', '/recon/link', { user: '3', body: { company: 'devx', gstin: F.REC_A, books_ids: bo.b.map(x => x.id), portal_ids: po.p.map(x => x.id), reason: 'Vendor confirmed invoice XYZ-77 was re-issued as QQ-1' } });
  assert.equal(linked.status, 200);
  const rows2 = (await t.call('GET', '/recon/rows?company=devx&status=mismatched', { user: '4' })).body.rows;
  assert.equal(rows2.length, 2);                                                                                                           // INV/002 and the manual link (₹200 / ₹63 apart)
  const manual = rows2.find(r => r.rule === 'MANUAL');
  assert.equal(manual.decision.by, 'Reviewer');
  const detail = (await t.call('GET', `/recon/row?key=${encodeURIComponent(manual.key)}`, { user: '4' })).body;
  assert.match(detail.row.explain.join(' '), /Linked by Reviewer/); assert.equal(detail.review.history[0].action, 'link');
  // assign + note (preparer)
  assert.equal((await t.call('POST', '/recon/assign', { user: '2', body: { keys: [manual.key], owner: 'Asha', workflow: 'vendor_followup', next_action: 'Ask for credit note', due: '2026-11-25' } })).status, 200);
  assert.equal((await t.call('POST', '/recon/assign', { user: '2', body: { keys: [manual.key], workflow: 'resolved' } })).status, 403);   // closing a row needs the review right
  assert.equal((await t.call('POST', '/recon/note', { user: '2', body: { key: manual.key, text: 'Emailed the vendor' } })).status, 200);
  const after = (await t.call('GET', '/recon/rows?company=devx&owner=Asha', { user: '4' })).body;
  assert.equal(after.total, 1); assert.equal(after.rows[0].notes, 1); assert.equal(after.rows[0].workflow, 'vendor_followup');
  // export
  const res = await t.call('GET', '/export/xlsx?company=devx', { user: '4', raw: true });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Executive summary', 'Detailed reconciliation', 'Books only', 'GSTR-2B only', 'Mismatches', 'Suggested (review)', 'Duplicates', 'Vendor summary', 'GSTIN summary', 'Cross-period & amendments', 'Excluded', 'Bridge & control totals', 'Imports', 'ITC register (Phase 2)', 'Post-lock changes (Phase 2)']);
  const detailed = XLSX.utils.sheet_to_json(wb.Sheets['Detailed reconciliation']);
  assert.equal(detailed.length, 3);
  assert.ok(detailed.some(r => r['Primary status'] === 'Exact matched' && r['Books CGST'] === 90));
  assert.match(XLSX.utils.sheet_to_json(wb.Sheets['ITC register (Phase 2)'], { header: 1 })[0][0], /Not implemented in Phase 1/);
  const bridge = XLSX.utils.sheet_to_json(wb.Sheets['Bridge & control totals'], { header: 1 });
  assert.ok(bridge.some(r => r[0] === 'Ties out' && r.slice(1, 7).every(c => c === 'Yes')));
  // original file download and audit trail
  const imp = (await t.call('GET', '/imports?company=devx')).body.statements[0];
  const file = await t.call('GET', `/imports/${imp.id}/file`, { raw: true });
  assert.ok(Buffer.compare(Buffer.from(await file.arrayBuffer()), buf) === 0);
  const actions = (await t.call('GET', '/audit', { user: '6' })).body.entries.map(e => e.action);
  for (const a of ['sync.period', 'import.statement', 'recon.run', 'recon.link', 'recon.assign', 'export.xlsx']) assert.ok(actions.includes(a), a);
  assert.equal((await t.call('GET', '/audit/verify', { user: '6' })).body.ok, true);
  await t.close();
});

test('approving suggestions: single approval, bulk safeguards for risky ones, variance approval', async tc => {
  const t = await boot(tc);
  await t.call('PUT', '/config/companies', { user: '6', body: { companies: [COMPANY] } });
  const { setup } = require('./fixtures');                                                                                                  // reuse the document builders through the same store
  const C = require('../lib/canonBooks');
  const cfg = (await t.call('GET', '/meta', { user: '6' })).body;
  const ctx = { company: cfg.companies[0], branches: new Map(F.BRANCHES.map(b => [b.id, { name: b.name, gstin: b.gstin, state: b.state_code }])), vendors: new Map() };
  const mk = s => { const x = F.bill(s); return C.fromDetail(x.detail, x.row, ctx, 'bill'); };
  await books.upsertMany('devx', [mk({ id: 'a', no: 'LZ/0012', date: '2026-10-05', taxable: 1000 }), mk({ id: 'b', no: 'DG-5', date: '2026-10-06', taxable: 1000 }), mk({ id: 'c', no: 'AA-9', date: '2026-10-07', taxable: 1000 })]);
  const other = gstin('24', 'AAACS1111A', '2');
  const buf = stmt({ b2b: [sup(F.SUP_GJ, [inv('LZ/12', '05-10-2026', 1000, 90), inv('DG-5', '06-10-2026', 1000, 96)]), sup(other, [inv('AA-9', '07-10-2026', 1000, 90)])] });
  const pv = (await t.call('POST', '/import/preview', { user: '2', form: form(buf, 's.json') })).body;
  await t.call('POST', '/import/commit', { user: '2', body: { preview_id: pv.preview_id } });
  const rows = (await t.call('GET', '/recon/rows?company=devx', { user: '4' })).body.rows;
  const by = no => rows.find(r => [...r.b, ...r.p].some(v => v.no === no));
  assert.equal(by('LZ/0012').status, 'suggested'); assert.equal(by('DG-5').status, 'mismatched'); assert.equal(by('AA-9').status, 'suggested'); assert.ok(by('AA-9').flags.includes('wrong_supplier_gstin'));
  // a bulk approval skips the risky one (wrong GSTIN) but approves the plain one
  const bulk = (await t.call('POST', '/recon/approve', { user: '3', body: { keys: [by('LZ/0012').key, by('AA-9').key], reason: 'Checked the invoices' } })).body;
  assert.equal(bulk.approved, 1); assert.equal(bulk.skipped.length, 1); assert.match(bulk.skipped[0].why, /individual approval/);
  assert.equal((await t.call('POST', '/recon/approve', { user: '3', body: { keys: [by('AA-9').key], reason: 'Vendor confirmed it is their Mumbai registration' } })).body.approved, 1);
  assert.equal((await t.call('POST', '/recon/approve', { user: '3', body: { keys: [by('DG-5').key], reason: 'x' } })).body.skipped[0].why, 'not a suggested match');
  const now = (await t.call('GET', '/recon/rows?company=devx', { user: '4' })).body.rows;
  const lz = now.find(r => r.b.some(v => v.no === 'LZ/0012'));
  assert.equal(lz.status, 'exact'); assert.equal(lz.rule, 'MANUAL');
  assert.equal(lz.decision.mode, 'manual'); assert.equal(lz.decision.approved_from, 'R4'); assert.equal(lz.decision.by, 'Reviewer');     // who approved it, and which suggestion rule it came from
  assert.equal((await t.call('POST', '/recon/approve', { user: '3', body: { keys: [by('LZ/0012').key], reason: '' } })).status, 400);
  // reject a suggestion → the pair is blocked
  await t.call('POST', '/recon/unlink', { user: '3', body: { key: now.find(r => r.b.some(v => v.no === 'AA-9')).key, reason: 'different supplier after all' } });
  const final = (await t.call('GET', '/recon/rows?company=devx', { user: '4' })).body.rows;
  assert.equal(final.find(r => r.b.some(v => v.no === 'AA-9')).status, 'books_only');
  await t.close();
});

test('demo data loads as a clearly separate company, reconciles every scenario, and is removed completely', async tc => {
  const t = await boot(tc);
  const r = (await t.call('POST', '/demo/load', { user: '1' })).body;
  assert.equal(r.company, 'demo'); assert.ok(r.counts.books_documents > 100); assert.ok(r.counts.statements >= 4);
  const meta = (await t.call('GET', '/meta', { user: '1' })).body;
  const demo = meta.companies.find(c => c.id === 'demo');
  assert.equal(demo.demo, true); assert.equal(demo.registrations.length, 2);
  const sum = (await t.call('GET', '/recon/summary?company=demo', { user: '1' })).body;
  const s = sum.summary.by_status;
  for (const k of ['exact', 'tolerance', 'suggested', 'mismatched', 'books_only', 'portal_only', 'excluded']) assert.ok(s[k].rows > 0, `demo has ${k}`);
  assert.equal(sum.bridge_ties, true);
  assert.ok(sum.summary.exposure.closing_soon_gst > 0 && sum.summary.exposure.time_barred_gst > 0, 'the deadline demonstration is present');
  const flags = sum.summary.flags;
  for (const f of ['credit_note', 'reverse_charge', 'amendment', 'duplicate_suspected', 'wrong_supplier_gstin', 'cross_period', 'cross_fy', 'grouped', 'invalid_gstin']) assert.ok(flags[f] > 0, `demo has ${f}`);
  assert.ok((await t.call('GET', '/imports?company=demo')).body.statements.every(x => x.demo === true));
  assert.equal((await t.call('POST', '/sync/run', { user: '6', body: { company: 'demo', mode: 'incremental' } })).status, 400);       // never synced from Zoho
  // load again → same result (no duplicates)
  const again = (await t.call('POST', '/demo/load', { user: '1' })).body;
  assert.equal(again.counts.books_documents, r.counts.books_documents);
  // remove → gone
  assert.equal((await t.call('POST', '/demo/remove', { user: '1' })).body.removed, true);
  assert.equal((await t.call('GET', '/meta', { user: '1' })).body.companies.find(c => c.id === 'demo'), undefined);
  assert.equal((await t.call('GET', '/imports')).body.statements.length, 0);
  await t.close();
});

test('the ITC register is reported as planned, not silently missing', async tc => {
  const t = await boot(tc);
  const r = (await t.call('GET', '/itc', { user: '4' })).body;
  assert.equal(r.implemented, false); assert.equal(r.phase, 2); assert.ok(r.rules_source.some(x => /16\(4\)/.test(x.title)));
  const meta = (await t.call('GET', '/meta', { user: '4' })).body;
  assert.ok(meta.phases.planned.some(p => /Phase 2/.test(p))); assert.ok(meta.rules.pending.every(p => /not (notified|applied)|not applied/.test(p.status)));
  await t.close();
});
