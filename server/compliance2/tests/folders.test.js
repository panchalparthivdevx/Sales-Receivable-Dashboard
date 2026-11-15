/**
 * OneDrive folder engine (V4) against a SIMULATED OneDrive — every case of the specification's folder test list.
 * ALL data is SYNTHETIC.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const ORG = require('../lib/org');
const FO = require('../lib/folders');
const PV = require('../lib/provision');
const GS = require('../lib/graphSim');
const U = require('../lib/util');

const actor = { id: 'u', name: 'Tester' };
const PAN = 'ZZZCF7101K';
function makeOrg() {
  const org = ORG.EMPTY();
  const e = ORG.upsert(org, 'entity', { legal_name: 'Synthetic Folder Co Private Limited', short_code: 'SFC', type: 'PRIVATE', pan: PAN, listed: false }, { actor }).record;
  const reg = x => ORG.upsert(org, 'registration', { entity_id: e.id, ...x }, { actor }).record;
  const g1 = reg({ type: 'GST_REGULAR', number: H.gstin('24', PAN, '1'), state: 'GJ', filing_frequency: 'monthly' });
  const g2 = reg({ type: 'GST_REGULAR', number: H.gstin('24', PAN, '2'), state: 'GJ', filing_frequency: 'quarterly' });
  const tan = reg({ type: 'TAN', number: 'AHMZ71001A' });
  const pt = reg({ type: 'PT_PTRC', number: 'SYN-PT-9', state: 'MH' });                       // periodicity not recorded
  for (const x of [e, g1, g2, tan, pt]) x.data_status = 'approved';
  return { org, e, g1, g2, tan, pt };
}
const newMapping = () => ({ ...PV.EMPTY(), base: { drive_id: 'sim-drive', item_id: 'sim-base', path: 'New folder' } });
const names = (sim, parentId) => Object.values(sim.state().items).filter(i => i.parent === parentId).map(i => i.name);

test('plan: company → FY → the nine approved categories; financial periods; one folder per GSTIN (two in Gujarat); PT without periodicity is pending', () => {
  const { org, e, g1, g2, pt } = makeOrg();
  const p = FO.plan(org, { fys: ['2026-27'] });
  const byKey = new Map(p.nodes.map(n => [n.key, n]));
  const F = `E:${e.id}|FY:2026-27`;
  assert.equal(byKey.get(`E:${e.id}`).name, 'Synthetic Folder Co Private Limited');
  assert.equal(byKey.get(F).name, 'FY 2026-27');
  assert.deepEqual(p.nodes.filter(n => n.parent === F).map(n => n.name), Object.values(FO.CATS));
  const kids = parent => p.nodes.filter(n => n.parent === parent);
  assert.deepEqual(kids(`${F}|C:financials`).map(n => n.name), ['01_Standalone'], 'consolidated only when the entity prepares them');
  const st = `${F}|C:financials|B:standalone`;
  assert.deepEqual(kids(st).map(n => n.name), ['01_Monthly', '02_Quarterly', '03_Half_Yearly', '04_Annual']);
  assert.equal(kids(`${st}|PR:monthly`).length, 12);
  assert.deepEqual(kids(`${st}|PR:monthly`).slice(0, 1).map(n => n.name), ['2026-04_April']);
  assert.deepEqual(kids(`${st}|PR:quarterly`).map(n => n.name), ['Q1_Apr-Jun', 'Q2_Jul-Sep', 'Q3_Oct-Dec', 'Q4_Jan-Mar']);
  assert.deepEqual(kids(`${st}|PR:half_yearly`).map(n => n.name), ['H1_Apr-Sep', 'H2_Oct-Mar']);
  assert.deepEqual(kids(`${st}|PR:annual`).map(n => n.name), ['FY_2026-27']);
  assert.deepEqual(kids(`${st}|PR:quarterly|P:Q:2026-27:Q1`).map(n => n.name), FO.FIN_DOCS);
  const gst = kids(`${F}|C:gst`).map(n => n.name);
  assert.deepEqual(gst, [`Gujarat_${g1.number}`, `Gujarat_${g2.number}`], 'two GSTINs in one state, two folders, full GSTIN');
  assert.equal(kids(`${F}|C:gst|R:${g1.id}`).length, 13, '12 months + Annual_Returns');
  assert.deepEqual(kids(`${F}|C:gst|R:${g1.id}|P:M:2026-04`).map(n => n.name), FO.GST_DOCS);
  assert.ok(p.pending.some(x => x.text.includes(pt.number) && /periodicity/.test(x.text)));
  assert.ok(byKey.has(`${F}|C:pt|S:MH|R:${pt.id}`), 'the PT registration folder itself is still created');
  assert.equal(kids(`${F}|C:pt|S:MH|R:${pt.id}`).length, 0, 'no period folders guessed');
  assert.deepEqual(kids(`${F}|C:other_pay|P:M:2026-04`).map(n => n.name), FO.OTHER_PAY);
});

test('preview sends nothing to OneDrive; apply creates everything once; running again (a duplicate event) creates nothing', async () => {
  const { org } = makeOrg();
  const sim = GS.create();
  const mapping = newMapping();
  const planned = FO.plan(org, { fys: ['2026-27'] });
  const pv = PV.preview(mapping, planned);
  assert.equal(pv.to_create, planned.nodes.length);
  assert.equal(sim.calls.read + sim.calls.write, 0, 'preview: no remote call at all');
  const r1 = await PV.apply({ graph: sim, mapping, planned });
  assert.equal(r1.created, planned.nodes.length);
  assert.equal(r1.failed, 0);
  for (const c of sim.calls.creates) assert.ok(sim.isInside(c.id, 'sim-base'), 'every folder is inside the chosen folder');
  const r2 = await PV.apply({ graph: sim, mapping, planned });
  assert.equal(r2.created, 0);
  assert.equal(r2.known, planned.nodes.length);
  assert.equal(sim.calls.creates.length, planned.nodes.length, 'no duplicate folders');
});

test('a new FY, and a registration added later, create only their own subtree', async () => {
  const { org, e } = makeOrg();
  const sim = GS.create();
  const mapping = newMapping();
  await PV.apply({ graph: sim, mapping, planned: FO.plan(org, { fys: ['2026-27'] }) });
  const before = sim.calls.creates.length;
  const r = await PV.apply({ graph: sim, mapping, planned: FO.plan(org, { fys: ['2026-27', '2027-28'] }) });
  assert.equal(r.created, FO.plan(org, { fys: ['2027-28'] }).nodes.length - 2, 'the new year minus the root and company folders that exist');
  assert.ok(names(sim, mapping.nodes[`E:${e.id}`].item_id).includes('FY 2027-28'));
  const pf = ORG.upsert(org, 'registration', { entity_id: e.id, type: 'PF', number: 'GJAHD0071001000', state: 'GJ' }, { actor }).record;
  pf.data_status = 'approved';
  const n0 = sim.calls.creates.length;
  await PV.apply({ graph: sim, mapping, planned: FO.plan(org, { fys: ['2026-27', '2027-28'] }) });
  assert.equal(sim.calls.creates.length - n0, 2 * 13, 'PF code folder + 12 months, in each of the two years');
  assert.ok(sim.calls.creates.length > before);
});

test('retry after a partial failure finishes the tree without duplicates; folders that already exist are reused', async () => {
  const { org, e } = makeOrg();
  const sim = GS.create();
  // a person made some folders by hand already
  const root = sim.addFolderByHand('sim-base', 'Finance & Compliance');
  const co = sim.addFolderByHand(root.id, 'Synthetic Folder Co Private Limited');
  sim.addFolderByHand(co.id, 'FY 2026-27');
  let n = 0;
  const flaky = { ...sim, async createFolder(d, p, name) { n++; if (n === 7 || n === 40) throw Object.assign(new Error('Simulated network failure'), { status: 503 }); return sim.createFolder(d, p, name); } };
  const mapping = newMapping();
  const planned = FO.plan(org, { fys: ['2026-27'] });
  const r1 = await PV.apply({ graph: flaky, mapping, planned });
  assert.equal(r1.failed, 2);
  assert.ok(r1.blocked > 0, 'children of a failed folder wait');
  assert.equal(r1.reused, 3, 'root, company and FY folders made by hand are reused');
  const failedKey = Object.entries(mapping.nodes).find(([, v]) => v.status === 'failed')[0];
  assert.ok(mapping.nodes[failedKey].next_retry_at, 'a retry time is set (back-off)');
  const r2 = await PV.apply({ graph: flaky, mapping, planned });
  assert.equal(r2.created, 0, 'before the retry time nothing is retried');
  const r3 = await PV.apply({ graph: flaky, mapping, planned, force: true });
  assert.equal(r3.failed, 0);
  assert.equal(Object.values(mapping.nodes).filter(v => v.item_id).length + 1, planned.nodes.length, 'every planned folder mapped (+ root)');
  // no parent has two children with the same name
  const items = Object.values(sim.state().items);
  const seen = new Set();
  for (const it of items) { const k = `${it.parent}|${it.name.toLowerCase()}`; assert.ok(!seen.has(k), `duplicate ${it.name}`); seen.add(k); }
  assert.equal(mapping.nodes[`E:${e.id}`].item_id, co.id);
});

test('a company rename keeps the folder (same id, mapping kept) and renames it in OneDrive; invalid characters are made safe', async () => {
  const { org, e } = makeOrg();
  const sim = GS.create();
  const mapping = newMapping();
  await PV.apply({ graph: sim, mapping, planned: FO.plan(org, { fys: ['2026-27'] }) });
  const id = mapping.nodes[`E:${e.id}`].item_id;
  ORG.upsert(org, 'entity', { ...e, legal_name: 'Synthetic Folder/Co: Renamed* <Ltd>?' }, { actor, id: e.id });
  e.data_status = 'approved';
  const r = await PV.apply({ graph: sim, mapping, planned: FO.plan(org, { fys: ['2026-27'] }) });
  assert.equal(r.renamed, 1);
  assert.equal(r.created, 0, 'nothing new is created for a rename');
  assert.equal(mapping.nodes[`E:${e.id}`].item_id, id, 'same folder');
  assert.equal(sim.state().items[id].name, 'Synthetic Folder_Co_ Renamed_ _Ltd__');
  assert.equal(mapping.nodes[`E:${e.id}`].names[0].name, 'Synthetic Folder Co Private Limited');
  assert.equal(FO.safeName('CON'), 'CON_');
  assert.equal(FO.safeName('  trailing dots... '), 'trailing dots');
  assert.equal(FO.safeName('a"b*c:d<e>f?g/h\\i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('company folders created directly in OneDrive: an exact legal name is linked and set up; others wait for a person; nothing deeper counts', async () => {
  const { org, e } = makeOrg();
  const other = ORG.upsert(org, 'entity', { legal_name: 'Synthetic Second Co Private Limited', short_code: 'SSC', type: 'PRIVATE', pan: 'ZZZCS7102K', listed: false }, { actor }).record;
  other.data_status = 'approved';
  const sim = GS.create();
  const mapping = newMapping();
  await PV.apply({ graph: sim, mapping, planned: FO.plan(org, { fys: ['2026-27'], entityIds: [e.id] }) });
  sim.addFolderByHand(mapping.root.item_id, 'Synthetic Second Co docs');                    // a near miss: never linked by itself
  sim.addFolderByHand(mapping.root.item_id, 'synthetic second co private limited');
  sim.addFolderByHand(mapping.root.item_id, 'Group tracker');
  sim.addFolderByHand(mapping.nodes[`E:${e.id}`].item_id, 'Some personal folder');            // deeper: never a company
  const s1 = await PV.scan({ graph: sim, mapping, org });
  assert.deepEqual(s1.linked, [other.id]);
  assert.deepEqual(s1.found.sort(), ['Group tracker', 'Synthetic Second Co docs']);
  assert.equal(mapping.nodes[`E:${other.id}`].name, 'synthetic second co private limited', 'only the exact legal name is linked');
  const s2 = await PV.scan({ graph: sim, mapping, org });
  assert.deepEqual([s2.linked.length, s2.found.length], [0, 0], 'a second scan finds nothing new');
  const r = await PV.apply({ graph: sim, mapping, planned: FO.plan(org, { fys: ['2026-27'] }) });
  assert.ok(r.created > 100, 'the linked company gets the standard structure');
  assert.equal(mapping.nodes[`E:${other.id}`].name, 'synthetic second co private limited', 'a linked folder keeps the name the person gave it');
  assert.throws(() => PV.link(mapping, { id: 'x', name: 'y' }, other), /already has its company folder/);
});

test('no write outside the Finance & Compliance folder; a revoked sign-in stops the run without marking folders failed', async () => {
  const { org, e } = makeOrg();
  const sim = GS.create();
  const outside = sim.addFolderByHand('root', 'Somebody else');                         // outside the chosen folder
  const planned = FO.plan(org, { fys: ['2026-27'] });
  // (a) a company folder whose mapping points outside (even with a forged parent record): OneDrive is asked, nothing is created
  const m1 = newMapping();
  await PV.apply({ graph: sim, mapping: m1, planned: FO.plan(org, { fys: ['2026-27'], entityIds: [] }) });   // root only
  m1.nodes[`E:${e.id}`] = { item_id: outside.id, parent_item_id: m1.root.item_id, name: 'x', label: 'Synthetic Folder Co Private Limited' };
  const r1 = await PV.apply({ graph: sim, mapping: m1, planned });
  assert.ok(r1.blocked > 0 && r1.created === 0, JSON.stringify(r1));
  assert.equal(m1.nodes[`E:${e.id}`].invalid, true);
  // (b) a deeper folder whose mapping was changed to point outside
  const m2 = newMapping();
  await PV.apply({ graph: sim, mapping: m2, planned });
  const fyKey = `E:${e.id}|FY:2026-27`;
  m2.nodes[fyKey].item_id = outside.id;
  delete m2.nodes[`${fyKey}|C:notices`];                                                // something to create under it
  const r2 = await PV.apply({ graph: sim, mapping: m2, planned });
  assert.equal(r2.created, 0);
  assert.equal(m2.nodes[fyKey].invalid, true);
  // (c) a mapping with no record of where a folder was made is refused locally
  const m3 = newMapping(); m3.root = m2.root; m3.nodes = { [`E:${e.id}`]: { item_id: outside.id, name: 'x' } };
  assert.equal((await PV.apply({ graph: sim, mapping: m3, planned })).created, 0);
  assert.ok(!sim.calls.creates.some(c => c.parent === outside.id), 'nothing was ever created outside');
  await assert.rejects(PV.uploadDocument({ graph: sim, mapping: m2, route: { fy_key: fyKey, category_key: `${fyKey}|C:notices`, keys: [{ key: `${fyKey}|C:notices|V:x`, parent: `${fyKey}|C:notices`, name: 'n' }], file_name: 'f.txt' }, entity: e, buffer: Buffer.from('x') }), /would not be inside/);
  const sim2 = GS.create();
  const m4 = newMapping();
  sim2.revoke();
  const rv = await PV.apply({ graph: sim2, mapping: m4, planned });
  assert.equal(rv.stopped, 'revoked');
  assert.equal(Object.values(m4.nodes).filter(v => v?.status === 'failed').length, 0);
});

test('document routing: compliance period decides the FY (March paid in April stays in March); challan folders; the approved file names; one upload per file', async () => {
  const { org, e, g1, g2, tan } = makeOrg();
  const sim = GS.create();
  const mapping = newMapping();
  await PV.apply({ graph: sim, mapping, planned: FO.plan(org, { fys: ['2026-27'] }) });
  const task = o => ({ id: 'T202627-aa', entity_id: e.id, fy: '2026-27', period_start: '2027-03-01', period_end: '2027-03-31', filing: null, form: '', ...o });
  const ver = { v: 1, original_name: 'challan.pdf' };
  const march = task({ rule_id: 'TDS-DEP', category: 'TDS/TCS', rule_name: 'TDS monthly deposit', period_key: 'M:2027-03', registration_id: tan.id, form: 'Challan ITNS 281', filing: { payment: { date: '2027-04-30', reference: 'CIN0001234' } } });
  const r = FO.route({ task: march, doc: { id: 'D-1', doc_type: 'payment_proof' }, version: ver, entity: e, registration: tan });
  assert.deepEqual(r.keys.map(k => k.name), ['AHMZ71001A', '01_Monthly_Payments', '2027-03_March', '2027-04-30_CIN0001234']);
  assert.equal(r.fy_key, `E:${e.id}|FY:2026-27`, 'FY of the liability month, not of the payment date');
  assert.equal(r.file_name, 'SFC_AHMZ71001A_TDSChallan_2027-03_CIN0001234_Paid.pdf');
  const gst3b = task({ rule_id: 'GST-3B-M', category: 'GST', rule_name: 'GSTR-3B', form: 'GSTR-3B', period_key: 'M:2026-04', period_start: '2026-04-01', period_end: '2026-04-30', registration_id: g1.id, filing: { ack_no: 'AA2405260000001', payment: { date: '2026-05-19', reference: 'CPIN9' } } });
  assert.deepEqual(FO.route({ task: gst3b, doc: { id: 'D-2', doc_type: 'filed_return' }, version: ver, entity: e, registration: g1 }).keys.map(k => k.name).slice(-1), ['04_GSTR-3B']);
  assert.equal(FO.route({ task: gst3b, doc: { id: 'D-2', doc_type: 'filed_return' }, version: ver, entity: e, registration: g1 }).file_name, `SFC_${g1.number}_GSTR3B_2026-04_AA2405260000001_Filed.pdf`);
  assert.deepEqual(FO.route({ task: gst3b, doc: { id: 'D-3', doc_type: 'payment_proof' }, version: ver, entity: e, registration: g1 }).keys.map(k => k.name).slice(-2), ['05_GST_Payments', '2026-05-19_CPIN9']);
  const qrmp = task({ rule_id: 'GST-R1-Q', category: 'GST', form: 'GSTR-1', period_key: 'Q:2026-27:Q1', period_start: '2026-04-01', period_end: '2026-06-30', registration_id: g2.id });
  assert.deepEqual(FO.route({ task: qrmp, doc: { id: 'D-4', doc_type: 'working' }, version: ver, entity: e, registration: g2 }).keys.map(k => k.name).slice(1), ['2026-06_June', '01_GSTR-1'], 'a QRMP quarter goes in its last month');
  const r9 = task({ rule_id: 'GST-R9', category: 'GST', form: 'GSTR-9', period_key: 'Y:2026-27', period_start: '2026-04-01', period_end: '2027-03-31', registration_id: g1.id });
  assert.deepEqual(FO.route({ task: r9, doc: { id: 'D-5', doc_type: 'filed_return' }, version: ver, entity: e, registration: g1 }).keys.map(k => k.name).slice(1), ['Annual_Returns']);
  assert.match(FO.route({ task: task({ category: 'ROC/LLP', rule_id: 'ROC-AOC4', period_key: 'Y:2026-27' }), doc: { id: 'D-6', doc_type: 'filed_return' }, version: ver, entity: e, registration: null }).unrouted, /no folder for ROC\/LLP/);
  // one challan used by two tasks: stored once in OneDrive
  const buf = Buffer.from('synthetic challan');
  const up1 = await PV.uploadDocument({ graph: sim, mapping, route: r, entity: e, buffer: buf });
  const up2 = await PV.uploadDocument({ graph: sim, mapping, route: r, entity: e, buffer: buf });
  assert.equal(up1.item_id, up2.item_id);
  assert.equal(up2.reused, true);
  assert.equal(Object.values(sim.state().items).filter(i => i.name === r.file_name).length, 1);
  assert.ok(sim.isInside(up1.item_id, mapping.root.item_id));
  assert.match(up1.path, /^Finance & Compliance \/ Synthetic Folder Co Private Limited \/ FY 2026-27 \/ 03_TDS \/ AHMZ71001A \/ 01_Monthly_Payments \/ 2027-03_March \/ 2027-04-30_CIN0001234 \//);
});

// ── Through the routes ────────────────────────────────────────────────────────
test.describe('routes', () => {
  const sim = GS.create();
  test.before(async () => { require('..').init({ graph: sim }); await H.start(); });
  test.after(() => H.stop());
  const { call } = H;
  const ok = (r, m) => { assert.ok(r.status < 300, `${m || ''} ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } throw new Error('timeout'); };

  test('demo: simulated provisioning, tree, add-company preview — nothing sent to Microsoft', async () => {
    const r = ok(await call('1', 'POST', '/folders/provision', {}, { space: 'demo' }));
    assert.equal(r.simulated, true);
    assert.ok(r.created > 300);
    const f = ok(await call('1', 'GET', '/folders', undefined, { space: 'demo' }));
    assert.equal(f.connection.status, 'simulated');
    assert.ok(f.tree.length > 50 && f.tree.every(n => ['created', 'reused', 'mapped'].includes(n.status)));
    const pc = ok(await call('1', 'GET', '/folders/preview-company?name=New%20Synthetic%20Co%20Pvt%20Ltd', undefined, { space: 'demo' }));
    assert.equal(pc.top[0].name, 'New Synthetic Co Pvt Ltd');
    assert.equal(sim.calls.write, 0, 'the live OneDrive stand-in was not touched by the demo');
  });

  test('live: choose the folder, a saved entity gets its folders automatically, an uploaded document is copied to its folder', async () => {
    const c = await call('1', 'POST', '/onedrive/connect-url', {});
    assert.equal(c.status, 400, JSON.stringify(c.body));
    assert.deepEqual(c.body.missing, ['C2_MS_TENANT_ID', 'C2_MS_CLIENT_ID', 'C2_MS_CLIENT_SECRET'], 'no app registration configured in tests');
    const bad = await call(null, 'GET', '/onedrive/callback?code=x&state=forged');
    assert.equal(bad.status, 400);
    assert.match(bad.raw.toString(), /expired/);
    ok(await call('1', 'POST', '/onedrive/base', { url: 'https://devxwork-my.sharepoint.com/my?id=%2Fpersonal%2Fsynthetic%5Fuser%2FDocuments%2FNew%20folder' }));
    ok(await call('1', 'POST', '/folders/provision', {}));                                     // root
    assert.ok(sim.state().items[Object.values(sim.state().items).find(i => i.name === 'Finance & Compliance').id]);
    const ent = ok(await call('1', 'POST', '/org/entity', { legal_name: 'Synthetic Auto Folder Co Pvt Ltd', short_code: 'SAF', type: 'PRIVATE', pan: 'ZZZCA7201K', cin: 'U74999GJ2020PTC720001', listed: false })).record;
    const f = await waitFor(async () => { const x = ok(await call('1', 'GET', `/folders?entity_id=${ent.id}`)); return x.tree.some(n => n.kind === 'category' && n.status === 'created') ? x : null; });
    assert.ok(f.tree.find(n => n.key === `E:${ent.id}`).web_url.startsWith('https://'));
    ok(await call('1', 'PUT', '/settings/access', { user_id: 's', entities: [ent.id] }));
    assert.equal((await call('s', 'POST', '/folders/scan', {})).status, 403, 'a user limited to some entities cannot scan the whole tree');
    // one task with a GSTIN, generated in live: register, approve, decide, verify + approve the rule, generate
    const g = ok(await call('1', 'POST', '/org/registration', { entity_id: ent.id, type: 'GST_REGULAR', number: H.gstin('24', 'ZZZCA7201K'), state: 'GJ', filing_frequency: 'monthly' })).record;
    ok(await call('a', 'POST', `/org/entity/${ent.id}/approve`));
    ok(await call('a', 'POST', `/org/registration/${g.id}/approve`));
    ok(await call('r', 'POST', '/applicability', { rule_id: 'GST-3B-M', scope_type: 'registration', scope_id: g.id, status: 'applicable', reason: 'Synthetic test', effective_from: '2026-04-01' }));
    ok(await call('r', 'POST', '/rules/GST-3B-M/versions/1/verify', { source_url: 'https://www.cbic.gov.in/t', notification_no: 'SYN', notification_date: '2017-06-28', retrieved_at: '2026-11-14', verification_note: 'synthetic' }));
    const pv = ok(await call('a', 'GET', '/rules/GST-3B-M/versions/1/preview'));
    ok(await call('a', 'POST', '/rules/GST-3B-M/versions/1/approve', { preview_hash: pv.hash }));
    ok(await call('m', 'POST', '/tasks/generate', { fy: '2026-27', commit: true, rule_ids: ['GST-3B-M'] }));
    const t = ok(await call('1', 'GET', `/tasks?fy=2026-27&rule_ids=GST-3B-M&entity_ids=${ent.id}`)).tasks.find(x => x.period_key === 'M:2026-04');
    const up = ok(await call('m', 'POST', `/tasks/${t.id}/documents`, undefined, { form: H.fileForm(Buffer.from(`Working ${g.number} April 2026`), 'w.txt', { doc_type: 'working' }) }));
    const remote = await waitFor(async () => { const v = ok(await call('1', 'GET', `/tasks/${t.id}`)); const d = v.documents.find(x => x.id === up.document.id); return d.current.remote?.status ? d.current.remote : null; });
    assert.equal(remote.status, 'uploaded', JSON.stringify(remote));
    assert.match(remote.path, /FY 2026-27 \/ 02_GST \/ Gujarat_24ZZZCA7201K1Z. \/ 2026-04_April \/ 04_GSTR-3B \/ SAF_24ZZZCA7201K1Z._GSTR3BWorking_2026-04_D-[0-9a-f]+_Working\.txt$/);
    const file = Object.values(sim.state().items).find(i => i.id === remote.item_id);
    assert.equal(file.sha256, require('crypto').createHash('sha256').update(`Working ${g.number} April 2026`).digest('hex'), 'OneDrive holds the original bytes');
    const audit = ok(await call('1', 'GET', '/audit?limit=50')).entries.map(e => e.action);
    assert.ok(audit.includes('onedrive_folder_chosen') && audit.includes('folders_provisioned'));
  });

  test('live: a revoked sign-in is reported and stops the engine', async () => {
    sim.revoke();
    const r = ok(await call('1', 'POST', '/folders/provision', { force: true }));
    assert.equal(r.stopped, null, 'everything was already mapped: no call needed');
    const s = await call('1', 'POST', '/folders/scan', {});
    assert.ok(s.status >= 400 || s.body?.stopped === 'revoked' || /revoked/i.test(JSON.stringify(s.body)));
  });
});

void U;
