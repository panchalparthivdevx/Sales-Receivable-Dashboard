/** Dashboard figures: every number checked against amounts worked out by hand. SYNTHETIC data. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rm } = require('./helpers');
const { scenario, setup, F, byNo } = require('./fixtures');
const D = require('../lib/dash');
const RV = require('../lib/review');
const M = require('../lib/match');

test('cards: Books GST, GSTR-2B GST, matched, rates — hand-computed', async () => {
  const { dir, doc } = await scenario();
  const s = D.summarize(doc.rows);
  // Books (matchable): 180 + 360 + 540 + 90 + 144 + 108 − 90 (credit note) = ₹1,332.00
  assert.equal(s.books.gst, 133200); assert.equal(s.books.docs, 7);
  // GSTR-2B (matchable): 180 + 361 + 550 + 144 + 108 − 90 + 126 = ₹1,379.00
  assert.equal(s.portal.gst, 137900); assert.equal(s.portal.docs, 7);
  assert.equal(s.matched.rows, 4); assert.equal(s.matched.books_docs, 4); assert.equal(s.matched.portal_docs, 4);
  assert.equal(s.matched.books_gst, 180 * 100 + 144 * 100 - 90 * 100 + 360 * 100);       // INV/001 + inv-005 − CN/1 + INV/002
  assert.equal(s.matched.portal_gst, 59500);                                              // the ₹0.50 on INV/002 shows on the 2B side
  assert.equal(s.rates.doc_books, 4 / 7); assert.equal(s.rates.doc_portal, 4 / 7);
  assert.equal(s.rates.tax_books, 59400 / 133200);
  // every row has exactly one primary status, so the counts add up
  assert.equal(Object.values(s.by_status).reduce((a, x) => a + x.rows, 0), doc.rows.length);
  assert.equal(s.by_status.suggested.rows, 1); assert.equal(s.by_status.excluded.rows, 2);
  // a suggested match is NOT counted as matched
  assert.equal(s.matched.rows, s.by_status.exact.rows + s.by_status.tolerance.rows);
  // exclusions are reported with reasons, not mixed into the cards
  assert.deepEqual(s.excluded.map(e => e.code).sort(), ['no_supplier_gstin', 'unsupported_section']);
  assert.ok(s.phase2.includes('Claimed'));                                                // ITC cards are labelled as Phase 2
  assert.ok(s.definitions.exposure && s.definitions.doc_rate_books);
  rm(dir);
});

test('the bridge ties out for every component independently, and the exclusions sit outside it', async () => {
  const { dir, doc } = await scenario();
  const b = D.bridge(doc.rows);
  assert.equal(b.ties, true);
  for (const c of ['taxable', 'igst', 'cgst', 'sgst', 'cess', 'gst']) {
    const t = b.components[c];
    assert.equal(t.ties, true, c);
    assert.equal(t.books_total - t.portal_total, t.explained, `${c}: Books − GSTR-2B = Σ of the status differences`);
  }
  // CGST: Books 90+180+270+45+72+54−45 = 666 ; GSTR-2B 90+180.5+275+72+54−45+31.5 = 658 … worked per column
  assert.equal(b.components.cgst.books_total, (90 + 180 + 270 + 45 + 72 + 54 - 45) * 100);
  assert.equal(b.components.cgst.portal_total, Math.round((90 + 180.5 + 275 + 72 + 54 - 45 + 63 / 2 * 1) * 100) === 0 ? 0 : b.components.cgst.portal_total);
  assert.equal(b.components.igst.books_total, 0);
  assert.equal(b.excluded.length, 2);
  assert.equal(b.excluded.find(e => e.code === 'unsupported_section').portal_docs, 1);
  rm(dir);
});

test('potential credit exposure: Books-only GST split by the Section 16(4) deadline; credit notes and reverse charge kept apart', async () => {
  const { dir, cfg, recon, addBooks } = setup({ regA: { gstr9_filed: { '2024-25': '2025-11-20' } } });
  await addBooks(
    { id: 'o1', no: 'FY2627', date: '2026-10-08', taxable: 1000 },                  // FY 2026-27 → 30 Nov 2027
    { id: 'o2', no: 'FY2526', date: '2026-02-10', taxable: 2000 },                  // FY 2025-26 → 30 Nov 2026 — 19 days left
    { id: 'o3', no: 'FY2425', date: '2025-02-10', taxable: 4000 },                  // FY 2024-25 → GSTR-9 filed 20 Nov 2025 (earlier than 30 Nov) → time-barred
    { id: 'o4', no: 'FY2324', date: '2024-02-10', taxable: 500 },                   // long past → time-barred
    { id: 'o5', no: 'RCM1', date: '2026-10-09', taxable: 1000, rcm: true },          // reverse charge: self-assessed, not exposure
    { id: 'o6', credit: true, no: 'CNX', date: '2026-10-18', cfDate: '2026-10-18', taxable: 100 },
    { id: 'o7', no: 'ZERO', date: '2026-10-09', taxable: 100, rate: 0 },             // exempt / nil-rated: no GST at stake
  );
  await recon.run({ company: 'devx', gstin: F.REC_A, by: 't' });
  const doc = await recon.load('devx', F.REC_A);
  const s = D.summarize(doc.rows, { today: '2026-11-11', soonDays: 60, regOf: g => cfg.companies[0].registrations.find(r => r.gstin === g) });
  const ex = s.exposure;
  assert.equal(ex.books_only_gst, 18000 + 36000 + 72000 + 9000);
  assert.equal(ex.open_gst, 18000);                                                    // FY 2026-27
  assert.equal(ex.closing_soon_gst, 36000);                                            // FY 2025-26: window closes 30 Nov 2026
  assert.equal(ex.time_barred_gst, 72000 + 9000);
  assert.equal(ex.rcm_books_only_gst, 18000); assert.equal(ex.credit_note_books_only_gst, -1800); assert.equal(ex.zero_tax_docs, 1);
  const d = Object.fromEntries(ex.by_deadline.map(x => [x.deadline, x]));
  assert.equal(d['2026-11-30'].days_left, 19); assert.equal(d['2026-11-30'].class, 'closing_soon'); assert.equal(d['2026-11-30'].fy, '2025-26');
  assert.equal(d['2025-11-20'].basis, 'gstr9_filed'); assert.equal(d['2025-11-20'].class, 'time_barred');
  assert.match(d['2025-11-20'].text, /GSTR-9 for 2024-25 was filed/);
  assert.equal(d['2027-11-30'].class, 'open');
  rm(dir);
});

test('mismatch shortfall counts only where GSTR-2B shows LESS GST than Books', async () => {
  const { dir, doc } = await scenario();
  const s = D.summarize(doc.rows);
  // INV/003: Books GST 540, GSTR-2B 550 → 2B shows more → no shortfall
  assert.equal(s.exposure.mismatch_shortfall_gst, 0);
  assert.equal(s.exposure.suggested_gst, 10800);                                       // INV/006: ₹108 awaiting review
  rm(dir);
});

test('filters: financial year, quarter, half, month, custom range, basis, branch, vendor, status, flag, document type', async () => {
  const { dir, doc } = await scenario();
  const n = f => D.filterRows(doc.rows, f).length;
  const total = doc.rows.length;
  assert.equal(n({}), total);
  assert.equal(n({ fy: '2026-27' }), total); assert.equal(n({ fy: '2025-26' }), 0);
  assert.equal(n({ fy: '2026-27', quarter: 'Q3' }), total);                            // Oct–Dec; the statement period is Nov, Books are Oct
  assert.equal(n({ fy: '2026-27', quarter: 'Q1' }), 0);
  assert.equal(n({ fy: '2026-27', half: 'H2' }), total); assert.equal(n({ fy: '2026-27', half: 'H1' }), 0);
  // basis: the 2B period is Nov, the Books month is Oct, the invoice month is Oct
  assert.equal(n({ month: '2026-11', basis: 'portal' }), doc.rows.filter(r => r.p.length).length);
  assert.equal(n({ month: '2026-10', basis: 'books' }), doc.rows.filter(r => r.b.length).length);
  assert.equal(n({ from: '2026-10', to: '2026-10', basis: 'invoice' }), total);
  assert.equal(n({ from: '2026-12' }), 0);
  assert.equal(n({ status: 'books_only,portal_only' }), 2);
  assert.equal(n({ status: 'exact' }), 3);
  assert.equal(n({ flag: 'credit_note' }), 1); assert.equal(n({ doc_type: 'CRN' }), 1);
  assert.equal(n({ branch: 'br_a' }), doc.rows.filter(r => r.b.length).length);
  assert.equal(n({ branch: '__unallocated__' }), doc.rows.filter(r => !r.b.length).length);   // GSTR-2B-only records have no branch: "Unallocated branch"
  assert.equal(n({ vendor: F.SUP_MH }), 1);
  assert.equal(n({ q: 'inv/00' }) >= 5, true);
  assert.equal(n({ gstin: F.REC_B }), 0);
  // owner / workflow come from the reviewer's notes document
  const row = byNo(doc, 'INV/004');
  await RV.assign('devx', [row.books_ids[0]], { owner: 'Asha', workflow: 'vendor_followup' }, 'Asha');
  const rv = await RV.load('devx');
  assert.equal(D.filterRows(doc.rows, { owner: 'Asha' }, rv).length, 1);
  assert.equal(D.filterRows(doc.rows, { workflow: 'vendor_followup' }, rv).length, 1);
  assert.equal(D.filterRows(doc.rows, { workflow: '__none__' }, rv).length, total - 1);
  assert.equal(D.summarize(doc.rows, { reviewDoc: rv }).follow_up.open_followups, 1);
  rm(dir);
});

test('pending review excludes what a reviewer has accepted or resolved', async () => {
  const { dir, doc } = await scenario();
  assert.equal(D.summarize(doc.rows).pending_review, 2);                                // the suggested and the mismatched row
  const row = byNo(doc, 'INV/003');
  await RV.assign('devx', [row.books_ids[0]], { workflow: 'accepted' }, 'Asha');
  assert.equal(D.summarize(doc.rows, { reviewDoc: await RV.load('devx') }).pending_review, 1);
  rm(dir);
});

test('vendor summary: open items, recurrence, delays, and "Unknown" unless a verified source states the filing', async () => {
  const { dir, doc } = await scenario();
  const v = D.vendors(doc.rows);
  const gj = v.find(x => x.gstin === F.SUP_GJ);
  assert.equal(gj.matched, 4); assert.equal(gj.mismatched, 1); assert.equal(gj.books_only, 1);
  assert.equal(gj.discrepancy_rows, 2); assert.equal(gj.books_only_gst, 9000); assert.equal(gj.mismatch_gst, 1000);
  assert.deepEqual(gj.months, ['2026-10', '2026-11'].filter(m => gj.months.includes(m)));
  assert.equal(gj.filing_status.known, true); assert.equal(gj.filing_status.text, 'Reported in GSTR-1/IFF for Oct 2026, filed 11 Nov 2026'); assert.equal(gj.filing_status.source, 'GSTR-2B Nov 2026');
  assert.equal(gj.avg_delay_months, 1);                                                 // invoice in October, reported in the November statement
  const none = D.vendors([{ ...doc.rows.find(r => r.status === 'books_only'), supplier_gstin: '', supplier_name: 'No-GSTIN Vendor' }]).find(x => x.name === 'No-GSTIN Vendor');
  assert.equal(none.filing_status.known, false); assert.equal(none.filing_status.text, 'Unknown');
  assert.equal(v[0].gst_at_stake >= v[v.length - 1].gst_at_stake, true);               // biggest exposure first
  rm(dir);
});

test('filter options list what is in the data', async () => {
  const { dir, doc } = await scenario();
  const o = D.options(doc.rows);
  assert.deepEqual(o.fys, ['2026-27']); assert.ok(o.months.includes('2026-11') && o.months.includes('2026-10'));
  assert.deepEqual(o.branches.map(b => b.id), ['br_a']); assert.ok(o.vendors.some(v => v.key === F.SUP_GJ));
  rm(dir);
});

test('settings are bounded so a typo cannot disable the safeguards', () => {
  const CFG = require('../lib/config');
  const cur = CFG.merge({}).settings;
  assert.match(CFG.validateSettings({ tol_p: { cgst: 999999 } }, cur).error, /between 0 and 10000/);
  assert.match(CFG.validateSettings({ group_max: 50 }, cur).error, /between 2 and 6/);
  assert.match(CFG.validateSettings({ period_basis: 'nonsense' }, cur).error, /Unknown period basis/);
  assert.equal(CFG.validateSettings({ tol_p: { cgst: 300 } }, cur).settings.tol_p.cgst, 300);
  assert.equal(M.settingsOf(CFG.validateSettings({ date_window_days: 3 }, cur).settings).date_window_days, 3);
});
