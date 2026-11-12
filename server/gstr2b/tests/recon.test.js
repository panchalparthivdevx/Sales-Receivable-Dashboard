/**
 * Reconciliation end to end: Zoho documents + GSTR-2B statements → rows. SYNTHETIC data.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDir, rm, gstin } = require('./helpers');
const F = require('./fakeZoho');
const store = require('../lib/store');
const files = require('../lib/files');
const books = require('../lib/booksStore');
const C = require('../lib/canonBooks');
const ST = require('../lib/statements');
const RV = require('../lib/review');
const R = require('../lib/recon');
const CFG = require('../lib/config');
const M = require('../lib/match');

const SUP2 = gstin('24', 'AAACS1111A', '2');            // a second registration of supplier SUP_GJ's PAN
const SUP_TYPO = F.SUP_GJ.slice(0, 5) + (F.SUP_GJ[5] === 'S' ? 'T' : 'S') + F.SUP_GJ.slice(6, 14) + F.SUP_GJ[14];   // one character off, invalid checksum

function setup() {
  const dir = tempDir();
  store.configure({ dir: dir + '/data', useDb: false });
  files.configure({ dir: dir + '/files', blob: null });
  const cfg = CFG.merge({ companies: [{ id: 'devx', name: 'Test Co', short: 'T', org_id: F.ORG, active: true, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number',
    registrations: [{ gstin: F.REC_A, active: true }, { gstin: F.REC_B, active: true }] }] });
  const ctx = { company: cfg.companies[0], branches: new Map(F.BRANCHES.map(b => [b.id, { name: b.name, gstin: b.gstin, state: b.state_code }])), vendors: new Map() };
  const recon = R.create({ cfgNow: async () => cfg, audit: { log: async () => {} } });
  const addBooks = async (...specs) => {
    const docs = specs.map(s => { const x = s.credit ? F.credit(s) : s.expense ? F.expense(s) : F.bill(s); return C.fromDetail(x.detail, x.row, ctx, s.credit ? 'vendor_credit' : s.expense ? 'expense' : 'bill'); });
    await books.upsertMany('devx', docs);
    return docs;
  };
  return { dir, cfg, ctx, recon, addBooks };
}

const item = (txval, cgst, sgst = cgst, igst = 0) => ({ num: 1, rt: 18, txval, igst, cgst, sgst, cess: 0 });
const inv = (no, dt, txval, cgst, extra = {}) => ({ inum: no, typ: 'R', dt, val: txval + cgst * 2, pos: '24', rev: 'N', itcavl: 'Y', items: [item(txval, cgst)], ...extra });
const stmt = ({ gstin: g = F.REC_A, period = '112026', gendt = '14-11-2026', b2b = [], b2ba = [], cdnr = [], isd = [], impg = [] }) => Buffer.from(JSON.stringify({ chksum: 'c', data: { data: { gstin: g, rtnprd: period, gendt, docdata: {
  ...(b2b.length ? { b2b } : {}), ...(b2ba.length ? { b2ba } : {}), ...(cdnr.length ? { cdnr } : {}), ...(isd.length ? { isd } : {}), ...(impg.length ? { impg } : {}) } } } }));
const sup = (ctin, inv_) => ({ ctin, trdnm: 'Synthetic Supplier', supprd: '102026', supfildt: '11-11-2026', inv: inv_ });
const importFile = async (cfg, buffer, extra = {}) => {
  const pv = await ST.preview({ buffer, fileName: 'gstr2b.json', cfg, by: 'tester', ...extra });
  if (!pv.can_commit) return { pv };
  return { pv, st: await ST.commit({ previewId: pv.preview_id, cfg, by: 'tester', ack: true, ...extra }) };
};
const rowOf = (doc, pred) => doc.rows.filter(pred);
const byNo = (doc, no) => doc.rows.find(r => [...r.b, ...r.p].some(v => v.no === no));

test('end to end: every outcome the spec lists, each document in exactly one row', async () => {
  const { dir, cfg, recon, addBooks } = setup();
  await addBooks(
    { id: 'b1', no: 'INV/001', date: '2026-10-05', taxable: 1000 },
    { id: 'b2', no: 'INV/002', date: '2026-10-06', taxable: 2000 },
    { id: 'b3', no: 'INV/003', date: '2026-10-07', taxable: 3000 },
    { id: 'b4', no: 'INV/004', date: '2026-10-08', taxable: 500 },
    { id: 'b5', no: 'inv-005', date: '2026-10-09', taxable: 800 },
    { id: 'b6', no: 'INV/006', date: '2026-10-10', taxable: 600 },
    { id: 'c1', credit: true, no: 'CN/1', date: '2026-10-18', cfDate: '2026-10-18', taxable: 500 },
    { id: 'x1', no: 'NG/1', date: '2026-10-11', gst: '' },
  );
  const { pv, st } = await importFile(cfg, stmt({
    b2b: [
      sup(F.SUP_GJ, [inv('INV/001', '05-10-2026', 1000, 90), inv('INV/002', '06-10-2026', 2000, 180.5, { val: 2361 }), inv('INV/003', '07-10-2026', 3000, 275), inv('INV/005', '09-10-2026', 800, 72)]),
      sup(SUP2, [inv('INV/006', '10-10-2026', 600, 54)]),                                   // same PAN, another registration
      sup(F.SUP_MH, [inv('INV/900', '12-10-2026', 700, 63)]),                               // not in Books
    ],
    cdnr: [{ ctin: F.SUP_GJ, trdnm: 'Synthetic Supplier', supprd: '102026', supfildt: '11-11-2026', nt: [{ ntnum: 'CN/1', typ: 'C', suptyp: 'R', dt: '18-10-2026', val: 590, pos: '24', rev: 'N', itcavl: 'Y', items: [item(500, 45)] }] }],
    isd: [{ ctin: gstin('27', 'AAACT2803M'), trdnm: 'HO', supprd: '102026', supfildt: '11-11-2026', doclist: [{ doctyp: 'ISDI', docnum: 'ISD/1', docdt: '30-10-2026', igst: 0, cgst: 50, sgst: 50, cess: 0, itcelg: 'Y' }] }],
  }));
  assert.ok(st, JSON.stringify(pv.blockers));
  const out = await recon.run({ company: 'devx', gstin: F.REC_A, by: 'tester' });
  const doc = await recon.load('devx', F.REC_A);
  assert.equal(out.results[0].version, 1);

  const status = no => byNo(doc, no).status;
  assert.equal(status('INV/001'), 'exact');
  assert.equal(byNo(doc, 'INV/001').rule, 'R1');
  assert.equal(status('INV/002'), 'tolerance');                                              // ₹0.50 on CGST, inside ₹1
  assert.equal(byNo(doc, 'INV/002').diffs.cgst, 50);
  assert.equal(status('INV/003'), 'mismatched');                                             // ₹5 off
  assert.equal(byNo(doc, 'INV/003').diffs.cgst, 500);                                        // GSTR-2B ₹275 − Books ₹270
  assert.equal(status('INV/004'), 'books_only');
  assert.equal(status('inv-005'), 'exact'); assert.equal(byNo(doc, 'inv-005').rule, 'R2');   // normalised number
  const x = byNo(doc, 'INV/006');
  assert.equal(x.status, 'suggested'); assert.equal(x.rule, 'X1'); assert.ok(x.flags.includes('wrong_supplier_gstin'));
  assert.equal(status('CN/1'), 'exact'); assert.ok(byNo(doc, 'CN/1').flags.includes('credit_note'));
  assert.equal(status('INV/900'), 'portal_only');
  const isd = byNo(doc, 'ISD/1');
  assert.equal(isd.status, 'excluded'); assert.equal(isd.exclusion.code, 'unsupported_section'); assert.match(isd.exclusion.text, /ISD/);
  assert.equal(byNo(doc, 'NG/1').exclusion.code, 'no_supplier_gstin');
  // accounting: 8 Books + 8 GSTR-2B documents, none lost, none counted twice
  const bIds = doc.rows.flatMap(r => r.books_ids), pIds = doc.rows.flatMap(r => r.portal_ids);
  assert.equal(bIds.length, 8); assert.equal(new Set(bIds).size, 8);
  assert.equal(pIds.length, 8); assert.equal(new Set(pIds).size, 8);
  // INV/001, inv-005 and CN/1 are exact; the rest follow from the statuses asserted above
  assert.equal(doc.summary.counts.exact, 3); assert.equal(doc.summary.counts.tolerance, 1); assert.equal(doc.summary.counts.mismatched, 1);
  assert.equal(doc.summary.counts.suggested, 1); assert.equal(doc.summary.counts.books_only, 1); assert.equal(doc.summary.counts.portal_only, 1); assert.equal(doc.summary.counts.excluded, 2);
  assert.equal(Object.values(doc.summary.counts).reduce((a, b) => a + b, 0), doc.rows.length);
  rm(dir);
});

test('GSTR-2B of one GSTIN is never reconciled with Books of another GSTIN, and wrong-recipient cases are flagged for investigation', async () => {
  const { dir, cfg, recon, addBooks } = setup();
  await addBooks({ id: 'b1', no: 'RC-1', date: '2026-10-05', taxable: 1000 });                                            // booked under Ahmedabad (REC_A)
  await importFile(cfg, stmt({ gstin: F.REC_B, b2b: [sup(F.SUP_GJ, [inv('RC-1', '05-10-2026', 1000, 90)])] }));            // supplier billed the Mumbai GSTIN
  await recon.run({ company: 'devx', by: 't' });
  const a = await recon.load('devx', F.REC_A), b = await recon.load('devx', F.REC_B);
  const ra = byNo(a, 'RC-1'), rb = byNo(b, 'RC-1');
  assert.equal(ra.status, 'books_only'); assert.equal(rb.status, 'portal_only');                                         // NOT matched across GSTINs
  assert.ok(ra.flags.includes('wrong_recipient_gstin') && rb.flags.includes('wrong_recipient_gstin'));
  assert.equal(ra.related.gstin, F.REC_B); assert.equal(rb.related.gstin, F.REC_A);
  assert.match(ra.explain.join(' '), /Nothing is matched across GSTINs/);
  rm(dir);
});

test('GSTIN typo in Books (different PAN part) is found across partitions as a suggestion, never auto-matched', async () => {
  const { dir, cfg, recon, addBooks } = setup();
  await addBooks({ id: 'b1', no: 'TY-1', date: '2026-10-05', taxable: 1000, gst: SUP_TYPO });
  await importFile(cfg, stmt({ b2b: [sup(F.SUP_GJ, [inv('TY-1', '05-10-2026', 1000, 90)])] }));
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  const r = byNo(await recon.load('devx', F.REC_A), 'TY-1');
  assert.equal(r.status, 'suggested'); assert.equal(r.rule, 'X1');
  assert.ok(r.flags.includes('wrong_supplier_gstin') && r.flags.includes('invalid_gstin'));
  assert.match(r.explain.join(' '), /possible typing error/);
  // and the result is stable across runs (the typo partitions are recomputed, not frozen)
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  const again = byNo(await recon.load('devx', F.REC_A), 'TY-1');
  assert.equal(again.status, 'suggested');
  assert.equal((await recon.load('devx', F.REC_A)).rows.length, 2 - 1);
  rm(dir);
});

test('repeated upload of the same file is refused; nothing is counted twice', async () => {
  const { dir, cfg, recon, addBooks } = setup();
  await addBooks({ id: 'b1', no: 'A-1', date: '2026-10-05', taxable: 1000 });
  const file = stmt({ b2b: [sup(F.SUP_GJ, [inv('A-1', '05-10-2026', 1000, 90)])] });
  const first = await importFile(cfg, file);
  assert.ok(first.st);
  const again = await importFile(cfg, file);
  assert.equal(again.pv.can_commit, false); assert.match(again.pv.blockers.join(' '), /already imported/);
  assert.equal((await ST.list()).length, 1);
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  assert.equal((await recon.load('devx', F.REC_A)).summary.counts.exact, 1);
  rm(dir);
});

test('recomputed statement: a new version replaces the old one for reconciliation, history is kept, the diff shows the impact', async () => {
  const { dir, cfg, recon, addBooks } = setup();
  await addBooks({ id: 'b1', no: 'V-1', date: '2026-10-05', taxable: 1000 }, { id: 'b2', no: 'V-2', date: '2026-10-06', taxable: 2000 });
  const v1 = (await importFile(cfg, stmt({ gendt: '14-11-2026', b2b: [sup(F.SUP_GJ, [inv('V-1', '05-10-2026', 1000, 90), inv('V-2', '06-10-2026', 2000, 180)])] }))).st;
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  assert.equal((await recon.load('devx', F.REC_A)).summary.counts.exact, 2);
  // IMS: V-2 was rejected and the statement recomputed on 20 Nov — it is no longer in the statement
  const v2 = (await importFile(cfg, stmt({ gendt: '20-11-2026', b2b: [sup(F.SUP_GJ, [inv('V-1', '05-10-2026', 1000, 90)])] }))).st;
  assert.equal(v2.version, 2); assert.equal(v2.is_current, true);
  const idx = await ST.list();
  assert.equal(idx.find(s => s.id === v1.id).is_current, false); assert.equal(idx.find(s => s.id === v1.id).superseded_by, v2.id);
  const d = await ST.diff(v1.id, v2.id);
  assert.equal(d.counts.removed, 1); assert.equal(d.removed[0].doc_no, 'V-2'); assert.equal(d.itc_available_impact.cgst, -18000);
  const out = await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  const doc = await recon.load('devx', F.REC_A);
  assert.equal(byNo(doc, 'V-2').status, 'books_only');
  assert.equal(doc.version, 2); assert.equal(out.results[0].changes.transitions['exact → books_only'], 1);
  // an OLDER statement uploaded later is kept as history and does not replace the current one
  const old = (await importFile(cfg, stmt({ gendt: '12-11-2026', b2b: [sup(F.SUP_GJ, [inv('V-1', '05-10-2026', 1000, 90), inv('V-2', '06-10-2026', 2000, 180), inv('V-3', '07-10-2026', 1, 0)])] }))).st;
  assert.equal(old.is_current, false); assert.equal(old.version, 3);
  assert.equal((await ST.list()).find(s => s.id === v2.id).is_current, true);
  rm(dir);
});

test('amendment supersedes the original: counted once, matched to the revised document', async () => {
  const { dir, cfg, recon, addBooks } = setup();
  await addBooks({ id: 'b1', no: 'NEW-5', date: '2026-08-10', taxable: 500 });                                // Books has the corrected invoice
  await importFile(cfg, stmt({ period: '092026', gendt: '14-09-2026', b2b: [sup(F.SUP_GJ, [inv('OLD-5', '10-08-2026', 400, 36)])] }));
  await importFile(cfg, stmt({ period: '112026', gendt: '14-11-2026', b2ba: [sup(F.SUP_GJ, [{ oinum: 'OLD-5', oidt: '10-08-2026', inum: 'NEW-5', dt: '10-08-2026', val: 590, pos: '24', rev: 'N', itcavl: 'Y', items: [item(500, 45)] }])] }));
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  const doc = await recon.load('devx', F.REC_A);
  const r = byNo(doc, 'NEW-5');
  assert.equal(r.status, 'exact'); assert.ok(r.flags.includes('amendment'));
  assert.equal(r.p[0].amended_from.length, 1); assert.equal(r.p[0].amended_from[0].doc_no, 'OLD-5');
  assert.equal(doc.rows.filter(x => x.portal_ids.length).length, 1, 'the original and its amendment are ONE document');
  assert.equal(doc.inputs.portal.superseded_versions, 1);
  rm(dir);
});

test('late reporting across financial years: matched, with the cross-period flags', async () => {
  const { dir, cfg, recon, addBooks } = setup();
  await addBooks({ id: 'b1', no: 'LATE-1', date: '2026-03-28', taxable: 1000 });
  await importFile(cfg, stmt({ period: '062026', gendt: '14-06-2026', b2b: [sup(F.SUP_GJ, [inv('LATE-1', '28-03-2026', 1000, 90)])] }));       // the supplier reported it in June 2026
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  const r = byNo(await recon.load('devx', F.REC_A), 'LATE-1');
  assert.equal(r.status, 'exact');
  for (const f of ['cross_period', 'late_reporting', 'cross_fy']) assert.ok(r.flags.includes(f), f);
  assert.equal(r.periods.portal, '2026-06'); assert.equal(r.periods.invoice, '2026-03'); assert.equal(r.periods.record, '2026-06');
  rm(dir);
});

test('only the affected partitions are reprocessed when a Zoho document changes', async () => {
  const { dir, cfg, recon, addBooks } = setup();
  const sups = [F.SUP_GJ, F.SUP_MH, gstin('29', 'AAACI4798L'), gstin('33', 'AAACT2803M')];
  await addBooks(...sups.map((g, i) => ({ id: `b${i}`, no: `P-${i}`, date: '2026-10-05', taxable: 1000, gst: g })));
  await importFile(cfg, stmt({ b2b: sups.map((g, i) => sup(g, [inv(`P-${i}`, '05-10-2026', 1000, 90)])) }));
  const r1 = (await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' })).results[0];
  assert.equal(r1.recomputed, 4); assert.equal(r1.reused, 0);
  const r2 = (await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' })).results[0];
  assert.equal(r2.recomputed, 0); assert.equal(r2.reused, 4);
  // one bill is edited in Zoho
  await addBooks({ id: 'b1', no: 'P-1', date: '2026-10-05', taxable: 1100, lmt: '2026-11-12T10:00:00+0530', gst: F.SUP_MH });
  const r3 = (await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' })).results[0];
  assert.equal(r3.recomputed, 1); assert.equal(r3.reused, 3);
  assert.equal(byNo(await recon.load('devx', F.REC_A), 'P-1').status, 'mismatched');
  assert.equal(r3.changes.transitions['exact → mismatched'], 1);
  rm(dir);
});

test('reviewer decisions survive re-runs: manual link across suppliers, unlink, "not a match", exclusion', async () => {
  const { dir, cfg, recon, addBooks } = setup();
  await addBooks({ id: 'b1', no: 'MX-1', date: '2026-10-05', taxable: 1000, gst: F.SUP_GJ }, { id: 'b2', no: 'MY-1', date: '2026-10-06', taxable: 400 });
  await importFile(cfg, stmt({ b2b: [sup(F.SUP_MH, [inv('QQ-9', '07-10-2026', 1000, 90)]), sup(F.SUP_MH, [inv('QR-7', '08-10-2026', 321, 28.89)])] }));
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  let doc = await recon.load('devx', F.REC_A);
  const b1 = byNo(doc, 'MX-1'), p1 = byNo(doc, 'QQ-9');
  assert.equal(b1.status, 'books_only'); assert.equal(p1.status, 'portal_only');
  // reviewer links two documents of DIFFERENT suppliers (the vendor's GSTIN was wrong in Zoho)
  await RV.link('devx', { books_ids: b1.books_ids, portal_ids: p1.portal_ids, by: 'Asha', reason: 'Vendor confirmed new invoice number and GSTIN' });
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  doc = await recon.load('devx', F.REC_A);
  const linked = byNo(doc, 'MX-1');
  assert.equal(linked.rule, 'MANUAL'); assert.equal(linked.status, 'exact'); assert.equal(linked.decision.by, 'Asha');
  assert.equal(doc.rows.filter(r => r.books_ids.includes(linked.books_ids[0])).length, 1);
  // survives a full recompute
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't', mode: 'all' });
  assert.equal(byNo(await recon.load('devx', F.REC_A), 'MX-1').rule, 'MANUAL');
  // unlink → the pair is blocked and stays apart
  await RV.unlink('devx', linked, 'Asha', 'wrong pairing');
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  doc = await recon.load('devx', F.REC_A);
  assert.equal(byNo(doc, 'MX-1').status, 'books_only'); assert.equal(byNo(doc, 'QQ-9').status, 'portal_only');
  // exclusion with a mandatory reason
  await assert.rejects(RV.exclude('devx', { doc_id: byNo(doc, 'MY-1').books_ids[0], side: 'books', reason: ' ', by: 'Asha' }), /reason is required/);
  await RV.exclude('devx', { doc_id: byNo(doc, 'MY-1').books_ids[0], side: 'books', reason: 'Personal expense, not for GST', by: 'Asha' });
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  const ex = byNo(await recon.load('devx', F.REC_A), 'MY-1');
  assert.equal(ex.status, 'excluded'); assert.match(ex.exclusion.text, /Personal expense/);
  // notes, owner and workflow are kept apart from the result and follow the document
  await RV.assign('devx', [ex.books_ids[0]], { owner: 'Asha', workflow: 'vendor_followup', next_action: 'Ask vendor', due: '2026-11-20' }, 'Asha');
  await RV.note('devx', ex.books_ids[0], 'Called the vendor', 'Asha');
  const det = await RV.detailFor('devx', ex);
  assert.equal(det.meta.owner, 'Asha'); assert.equal(det.notes.length, 1); assert.ok(det.history.length >= 3);
  rm(dir);
});

test('deleted, voided and not-yet-detailed Books documents are excluded with a reason, not dropped', async () => {
  const { dir, cfg, recon, addBooks } = setup();
  const [d1] = await addBooks({ id: 'b1', no: 'DEL-1', date: '2026-10-05', taxable: 1000 }, { id: 'b2', no: 'VD-1', date: '2026-10-05', status: 'void' });
  await books.upsertMany('devx', [{ ...d1, deleted: true, excluded: 'deleted', excluded_text: 'Deleted in Zoho', hash: 'x' }]);
  const light = C.fromList(F.bill({ id: 'b3', no: 'PEND-1', date: '2026-10-07' }).row, { company: cfg.companies[0], branches: new Map(F.BRANCHES.map(b => [b.id, { name: b.name, gstin: b.gstin, state: b.state_code }])), vendors: new Map() }, 'bill');
  await books.upsertMany('devx', [light]);
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  const doc = await recon.load('devx', F.REC_A);
  assert.equal(byNo(doc, 'DEL-1').exclusion.code, 'deleted'); assert.equal(byNo(doc, 'VD-1').exclusion.code, 'void'); assert.equal(byNo(doc, 'PEND-1').exclusion.code, 'pending_detail');
  assert.equal(doc.inputs.books.pending_detail, 1);
  rm(dir);
});

test('statement import safeguards: unknown GSTIN, wrong period, future period, mismatched choice, empty file, row problems need confirmation', async () => {
  const { dir, cfg } = setup();
  const b = (g, p, extra = {}) => stmt({ gstin: g, period: p, b2b: [sup(F.SUP_GJ, [inv('S-1', '05-10-2026', 1000, 90)])], ...extra });
  assert.match((await ST.preview({ buffer: b(gstin('06', 'AAACX9999X'), '112026'), fileName: 'f.json', cfg })).blockers.join(' '), /not set up in Settings/);
  assert.match((await ST.preview({ buffer: b(F.REC_A, '112099'), fileName: 'f.json', cfg })).blockers.join(' '), /future/);
  assert.match((await ST.preview({ buffer: b(F.REC_A, '112026'), fileName: 'f.json', cfg, gstin: F.REC_B })).blockers.join(' '), /belongs to GSTIN/);
  assert.match((await ST.preview({ buffer: b(F.REC_A, '112026'), fileName: 'f.json', cfg, period: '2026-09' })).blockers.join(' '), /file is for 2026-11/);
  assert.match((await ST.preview({ buffer: stmt({ b2b: [] }), fileName: 'f.json', cfg })).blockers.join(' '), /No documents/);
  const withErr = stmt({ b2b: [sup(F.SUP_GJ, [inv('', '05-10-2026', 1000, 90)])] });
  const pv = await ST.preview({ buffer: withErr, fileName: 'f.json', cfg });
  assert.equal(pv.can_commit, true); assert.equal(pv.needs_ack, true); assert.ok(pv.error_count >= 1);
  await assert.rejects(ST.commit({ previewId: pv.preview_id, cfg, by: 't' }), e => e.needs_ack === true);
  const st = await ST.commit({ previewId: pv.preview_id, cfg, by: 't', ack: true });
  assert.equal(st.acknowledged, true);
  rm(dir);
});

test('the original file is stored once, byte for byte, and cannot be replaced', async () => {
  const { dir, cfg } = setup();
  const buf = stmt({ b2b: [sup(F.SUP_GJ, [inv('F-1', '05-10-2026', 1000, 90)])] });
  const { st } = await importFile(cfg, buf);
  const stored = await files.read(st.sha256);
  assert.ok(Buffer.compare(stored, buf) === 0);
  await files.save(st.sha256, Buffer.from('tampered'));                                        // a second save is ignored
  assert.ok(Buffer.compare(await files.read(st.sha256), buf) === 0);
  rm(dir);
});
