/**
 * Matching engine — the scenarios in the specification. SYNTHETIC data only.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { books, portal, REC, SUP, SUP2 } = require('./helpers');
const { matchSet, accounting } = require('../lib/match');

const run = (B, P, settings, decisions) => {
  const out = matchSet(B, P, settings, decisions);
  const acc = accounting(out.rows, B, P);
  assert.ok(acc.ok, `every document must be in exactly one row: ${JSON.stringify(acc)}`);   // consumed once
  return out;
};
const only = rows => { assert.equal(rows.length, 1, `expected one row, got ${rows.map(r => r.status).join(',')}`); return rows[0]; };

test('R1: identical supplier GSTIN, number, date and amounts → Exact matched, with an explanation', () => {
  const b = books({ no: 'INV/001' }), p = portal({ no: 'INV/001' });
  const r = only(run([b], [p]).rows);
  assert.equal(r.status, 'exact');
  assert.equal(r.rule, 'R1');
  assert.deepEqual(r.books_ids, [b.id]); assert.deepEqual(r.portal_ids, [p.id]);
  assert.ok(r.explain.join(' ').includes('Same supplier GSTIN'));
  assert.deepEqual(r.decision, { mode: 'auto', rule: 'R1' });
});

test('R2: case, spaces and punctuation are normalised; leading zeros are NOT', () => {
  const r2 = only(run([books({ no: 'inv / 001-A' })], [portal({ no: 'INV-001 A' })]).rows);
  assert.equal(r2.status, 'exact'); assert.equal(r2.rule, 'R2');
  // leading zero variant must NOT be matched automatically — only suggested for review
  const r = only(run([books({ no: 'INV/0012' })], [portal({ no: 'INV/12' })]).rows);
  assert.equal(r.status, 'suggested'); assert.equal(r.rule, 'R4');
  assert.match(r.explain[0], /leading zeros/);
});

test('R3: differences inside the per-component tolerance → Matched within approved tolerance', () => {
  const b = books({ no: 'A1', cgst: 90, sgst: 90 }), p = portal({ no: 'A1', cgst: 90.5, sgst: 89.5 });
  const rr = only(run([b], [p]).rows);
  assert.equal(rr.status, 'tolerance'); assert.equal(rr.rule, 'R3'); assert.equal(rr.identity, 'R1');
  assert.equal(rr.diffs.cgst, 50); assert.equal(rr.diffs.sgst, -50);      // ±₹0.50, each inside its own ₹1 tolerance
});

test('a difference beyond tolerance in ANY component → Mismatched (paired, never silently matched)', () => {
  const rr = only(run([books({ no: 'A2', cgst: 90 })], [portal({ no: 'A2', cgst: 92.5 })]).rows);
  assert.equal(rr.status, 'mismatched');
  assert.equal(rr.within.cgst, false);
  assert.ok(rr.explain.join(' ').includes('OUTSIDE'));
});

test('no offsetting: IGST +₹1.50 against CGST −₹1.50 is two failures, not zero', () => {
  const b = books({ no: 'A3', igst: 100, cgst: 0, sgst: 0 }), p = portal({ no: 'A3', igst: 101.5, cgst: -1.5, sgst: 0 });
  const rr = only(run([b], [p]).rows);
  assert.equal(rr.status, 'mismatched');
});

test('identical total tax but different tax components (IGST vs CGST+SGST) → Mismatched + flag', () => {
  const b = books({ no: 'A4', igst: 180, cgst: 0, sgst: 0 }), p = portal({ no: 'A4', igst: 0, cgst: 90, sgst: 90 });
  const rr = only(run([b], [p]).rows);
  assert.equal(rr.status, 'mismatched');
  assert.ok(rr.flags.includes('tax_type_mismatch'));
});

test('tolerance is configurable per component', () => {
  const b = books({ no: 'A5', cgst: 90 }), p = portal({ no: 'A5', cgst: 92 });
  assert.equal(only(run([b], [p]).rows).status, 'mismatched');
  assert.equal(only(run([b], [p], { tol_p: { cgst: 300 } }).rows).status, 'tolerance');
});

test('repeated invoice numbers across years are different documents (date is part of the identity)', () => {
  const b25 = books({ no: '1', date: '2025-04-10', taxable: 500, cgst: 45, sgst: 45 });
  const b26 = books({ no: '1', date: '2026-04-12', taxable: 700, cgst: 63, sgst: 63 });
  const p26 = portal({ no: '1', date: '2026-04-12', taxable: 700, cgst: 63, sgst: 63, period: '2026-05' });
  const { rows } = run([b25, b26], [p26]);
  const matched = rows.find(r => r.portal_ids.length);
  assert.deepEqual(matched.books_ids, [b26.id]);
  assert.equal(matched.status, 'exact');
  assert.equal(rows.find(r => r.books_ids[0] === b25.id).status, 'books_only');
});

test('normalisation collision (A-1 and A/1 on the same day) is not auto-matched through R2', () => {
  const b1 = books({ no: 'A-1' }), b2 = books({ no: 'A/1' });
  const p1 = portal({ no: 'A.1' });
  const { rows } = run([b1, b2], [p1]);
  assert.ok(!rows.some(r => r.rule === 'R2'), 'R2 must not pair through a collision');
  assert.ok(rows.some(r => r.flags.includes('normalization_collision')));
});

test('duplicate Books records: not auto-matched, flagged, left for review', () => {
  const b1 = books({ no: 'D-100' }), b2 = books({ no: 'D-100' });
  const p = portal({ no: 'D-100' });
  const { rows } = run([b1, b2], [p]);
  assert.ok(rows.every(r => r.status === 'books_only' || r.status === 'portal_only'), 'two identical candidates → nothing is consumed automatically');
  for (const r of rows.filter(r => r.books_ids.length)) assert.ok(r.flags.includes('duplicate_suspected'));
  assert.ok(rows.some(r => r.flags.includes('ambiguous')));
});

test('wrong supplier GSTIN under the same PAN → suggestion only, flagged', () => {
  const b = books({ no: 'W-7', sup: SUP }), p = portal({ no: 'W-7', sup: SUP2 });
  const rr = only(run([b], [p]).rows);
  assert.equal(rr.status, 'suggested'); assert.equal(rr.rule, 'X1');
  assert.ok(rr.flags.includes('wrong_supplier_gstin'));
  assert.match(rr.explain.join(' '), /PAN is the same/);
});

test('a different supplier with the same PAN is never matched without number, date AND amounts', () => {
  const b = books({ no: 'W-8', sup: SUP, taxable: 1000 }), p = portal({ no: 'W-9', sup: SUP2, taxable: 1000 });
  const { rows } = run([b], [p]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.status).sort(), ['books_only', 'portal_only']);
});

test('similar amounts alone never match (different supplier, different number)', () => {
  const b = books({ no: 'S-1', sup: SUP }), p = portal({ no: 'ZZ-99', sup: '29AAACI4798L1ZD', date: '2026-10-11' });
  const { rows } = run([b], [p]);
  assert.deepEqual(rows.map(r => r.status).sort(), ['books_only', 'portal_only']);
});

test('credit notes only match credit notes; an invoice with the same number is not touched', () => {
  const inv = books({ no: 'N-5', type: 'INV' }), crn = books({ no: 'N-5', type: 'CRN' });
  const pc = portal({ no: 'N-5', type: 'CRN' });
  const { rows } = run([inv, crn], [pc]);
  const m = rows.find(r => r.portal_ids.length);
  assert.deepEqual(m.books_ids, [crn.id]); assert.equal(m.status, 'exact');
  assert.ok(m.flags.includes('credit_note'));
  assert.equal(rows.find(r => r.books_ids[0] === inv.id).status, 'books_only');
});

test('late reporting across financial years is flagged on the matched row', () => {
  const b = books({ no: 'L-1', date: '2026-03-28' }), p = portal({ no: 'L-1', date: '2026-03-28', period: '2026-06' });
  const rr = only(run([b], [p]).rows);
  assert.equal(rr.status, 'exact');
  for (const f of ['cross_period', 'late_reporting', 'cross_fy']) assert.ok(rr.flags.includes(f), f);
  // the normal case (supplier reports in the month after the invoice) is NOT flagged
  const ok = only(run([books({ no: 'L-2', date: '2026-10-20' })], [portal({ no: 'L-2', date: '2026-10-20', period: '2026-11' })]).rows);
  assert.ok(!ok.flags.includes('cross_period'));
});

test('Books document with an assumed (posting) date is never auto-matched on number alone', () => {
  const b = books({ no: 'DA-1', dateAssumed: true, date: '2026-10-14' }), p = portal({ no: 'DA-1', date: '2026-10-10' });
  const rr = only(run([b], [p]).rows);
  assert.equal(rr.status, 'suggested');
  assert.ok(rr.flags.includes('date_assumed'));
});

test('split invoice: Books 1,500 vs two GSTR-2B documents 1,000 + 500 → grouped suggestion, review required', () => {
  const b = books({ no: 'SP-1', taxable: 1500, cgst: 135, sgst: 135 });
  const p1 = portal({ no: 'SP-1A', taxable: 1000, cgst: 90, sgst: 90 }), p2 = portal({ no: 'SP-1B', taxable: 500, cgst: 45, sgst: 45 });
  const rr = only(run([b], [p1, p2]).rows);
  assert.equal(rr.status, 'suggested'); assert.equal(rr.rule, 'R6');
  assert.equal(rr.portal_ids.length, 2); assert.ok(rr.flags.includes('grouped'));
  assert.ok(Object.values(rr.diffs).every(v => v === 0));
});

test('consolidated invoice: two Books documents vs one GSTR-2B document', () => {
  const b1 = books({ no: 'C-1', taxable: 800, cgst: 72, sgst: 72 }), b2 = books({ no: 'C-2', taxable: 200, cgst: 18, sgst: 18 });
  const p = portal({ no: 'CONS-9', taxable: 1000, cgst: 90, sgst: 90 });
  const rr = only(run([b1, b2], [p]).rows);
  assert.equal(rr.status, 'suggested'); assert.equal(rr.books_ids.length, 2);
});

test('grouping with several possible explanations is not suggested (ambiguous)', () => {
  const p = portal({ no: 'X-0', taxable: 1000, cgst: 90, sgst: 90 });
  const bs = [400, 600, 300, 700].map((t, i) => books({ no: `G-${i}`, taxable: t, cgst: t * 0.09, sgst: t * 0.09 }));   // 400+600 and 300+700 both work
  const { rows } = run(bs, [p]);
  assert.ok(!rows.some(r => r.rule === 'R6'));
});

test('manual link is honoured and recorded; a "not a match" block is honoured', () => {
  const b = books({ no: 'M-1', taxable: 1000 }), p = portal({ no: 'ZZ-5555', taxable: 1000, date: '2026-10-11' });
  const linked = only(run([b], [p], {}, { links: [{ books_ids: [b.id], portal_ids: [p.id], by: 'Asha', at: '2026-11-01', reason: 'Vendor confirmed number typo' }] }).rows);
  assert.equal(linked.rule, 'MANUAL'); assert.equal(linked.status, 'exact');
  assert.deepEqual(linked.decision.mode, 'manual'); assert.equal(linked.decision.by, 'Asha');
  // a difference beyond tolerance stays a Mismatched pair unless the reviewer approves a variance
  const p2 = portal({ no: 'M-2', taxable: 1000, cgst: 100 }), b2 = books({ no: 'M-2', taxable: 1000, cgst: 90 });
  const lk = { books_ids: [b2.id], portal_ids: [p2.id], by: 'Asha' };
  assert.equal(only(run([b2], [p2], {}, { links: [lk] }).rows).status, 'mismatched');
  assert.equal(only(run([b2], [p2], {}, { links: [{ ...lk, approved_tol_p: { cgst: 1500 } }] }).rows).status, 'tolerance');
  // a reviewer's block keeps an otherwise perfect identity pair apart
  const b3 = books({ no: 'M-3' }), p3 = portal({ no: 'M-3' });
  const blocked = run([b3], [p3], {}, { blocks: [`${b3.id}|${p3.id}`] }).rows;
  assert.deepEqual(blocked.map(r => r.status).sort(), ['books_only', 'portal_only']);
});

test('a stale manual link (document gone) is reported, not applied', () => {
  const b = books({ no: 'ST-1' });
  const out = run([b], [], {}, { links: [{ books_ids: [b.id], portal_ids: ['ghost'] }] });
  assert.equal(out.stale_links.length, 1);
  assert.equal(only(out.rows).status, 'books_only');
});

test('amendment and reverse-charge flags are carried; ITC-not-available per portal is informational', () => {
  const rr = only(run([books({ no: 'F-1', rcm: true })], [portal({ no: 'F-1', amend: true, itc: 'N', rcm: true })]).rows);
  for (const f of ['amendment', 'reverse_charge', 'itc_not_available_per_portal']) assert.ok(rr.flags.includes(f), f);
});

test('invalid supplier GSTIN is flagged', () => {
  const rr = only(run([books({ no: 'IG-1', gstinValid: false })], [portal({ no: 'IG-1', gstinValid: false })]).rows);
  assert.ok(rr.flags.includes('invalid_gstin'));
});

test('large mixed set: each document consumed exactly once (accounting holds)', () => {
  const B = [], P = [];
  for (let i = 0; i < 300; i++) {
    const t = 100 + i * 7;
    B.push(books({ no: `BULK/${i}`, taxable: t, cgst: t * 0.09, sgst: t * 0.09, sup: i % 3 ? SUP : '29AAACI4798L1ZD' }));
    if (i % 5) P.push(portal({ no: i % 11 === 0 ? `bulk-${i}` : `BULK/${i}`, taxable: t, cgst: t * 0.09 + (i % 7 === 0 ? 0.4 : 0), sgst: t * 0.09, sup: i % 3 ? SUP : '29AAACI4798L1ZD' }));
  }
  for (let i = 0; i < 25; i++) P.push(portal({ no: `ONLY/${i}`, taxable: 50 + i }));
  const { rows } = run(B, P);
  const by = s => rows.filter(r => r.status === s).length;
  assert.ok(by('exact') > 100 && by('books_only') >= 60 && by('portal_only') >= 25);
  assert.equal(by('exact') + by('tolerance') + by('suggested') + by('mismatched') + by('books_only') + by('portal_only'), rows.length);
});
