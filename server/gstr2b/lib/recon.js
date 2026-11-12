/**
 * Reconciliation runs: Books documents × GSTR-2B documents of ONE recipient GSTIN → one row per document or pair.
 *
 *   - Companies and recipient GSTINs are never mixed: a registration is reconciled only with its own Books documents
 *     and its own statements. PAN-level grouping is used inside a registration to find other registrations of the same
 *     supplier, and across registrations only to INVESTIGATE (flag "wrong recipient GSTIN"), never to match.
 *   - The work is partitioned by supplier PAN. A run recomputes only the partitions whose inputs changed (documents
 *     edited in Zoho, a new statement version, a reviewer decision, new settings) and keeps the rest.
 *   - Reviewer decisions (links, "not a match", exclusions) are applied before any rule.
 *   - Before anything is saved, every Books and GSTR-2B document must be accounted for exactly once.
 */

'use strict';

const store = require('./store');
const books = require('./booksStore');
const statements = require('./statements');
const review = require('./review');
const M = require('./match');
const N = require('./normalize');
const { hashOf, groupBy, nowIso } = require('./util');
const { COMPONENTS, zeroAmounts, addAmounts, diffAmounts } = require('./money');

const reconKey = (co, g) => `recon_${co}_${g}`;

// What each kind of Zoho document does in this module — shown on the coverage screen and in the exports
const COVERAGE_MATRIX = [
  { source: 'Zoho Books — Bills', status: 'included', how: 'Matched as invoices (B2B) when the supplier has a GSTIN. Amounts come from the bill detail: taxable value, IGST / CGST / SGST / cess.' },
  { source: 'Zoho Books — Vendor credits', status: 'included', how: 'Matched as supplier credit notes (CDNR "C"). The original bill link is kept.' },
  { source: 'Zoho Books — Expenses with GST', status: 'included', how: 'Only expenses that carry GST and a supplier GSTIN. The expense date is never trusted as an invoice date, so these are only ever suggested, not auto-matched.' },
  { source: 'Zoho Books — Bills of unregistered / consumer / overseas suppliers', status: 'excluded', how: 'Listed and counted, never matched: such suppliers cannot appear in GSTR-2B.' },
  { source: 'Zoho Books — Reverse-charge purchases from unregistered suppliers', status: 'excluded', how: 'Self-assessed tax; not in GSTR-2B. Reviewed in the ITC register (Phase 2).' },
  { source: 'Zoho Books — Void, draft, deleted, opening-balance, non-INR documents', status: 'excluded', how: 'Listed with the reason; deleted documents stay as tombstones.' },
  { source: 'Zoho Books — Supplier debit notes', status: 'needs convention', how: 'Zoho has no separate document for a debit note RECEIVED from a supplier; they are expected to be booked as bills. Confirm with the finance team.' },
  { source: 'Zoho Books — Manual journals, opening ITC balances', status: 'supplemental import', how: 'Not read in Phase 1. ITC adjustments made by journal need a supplemental import (Phase 2).' },
  { source: 'Zoho Books — Imports of goods (bill of entry)', status: 'supplemental import', how: 'Customs data is not held as structured fields in Zoho; IMPG records from GSTR-2B are imported and shown as Excluded (Phase 2).' },
  { source: 'GSTR-2B — B2B, B2BA, CDNR, CDNRA', status: 'included', how: 'Matched against Books; amendments supersede the original so nothing is counted twice.' },
  { source: 'GSTR-2B — ISD, ISDA, IMPG, IMPGSEZ (+ amendments), ECO, ECOA, Rule 37A reversals', status: 'imported, not matched', how: 'Imported and counted; shown as Excluded with the reason until Phase 2.' },
];

const bView = d => ({
  id: d.id, kind: d.kind, no: d.doc_no, date: d.doc_date, posting: d.posting_date, period: d.accounting_period, date_assumed: !!d.date_assumed,
  supplier: d.supplier.name, gstin: d.supplier.gstin, pan: d.supplier.pan, vendor_id: d.supplier.vendor_id, master_gstin: d.supplier.master_gstin || '',
  amounts: d.amounts || zeroAmounts(), value: d.invoice_value ?? null, branch_id: d.recipient.branch_id, branch: d.recipient.branch_name,
  projects: (d.projects || []).map(p => p.name), url: d.zoho_url, status: d.status, rcm: !!d.rcm, rcm_tax: d.rcm_tax || 0, pos: d.pos || null, stale: !!d.stale, dq: d.data_quality || [],
  balance: d.balance ?? null, paid: (d.payments || []).reduce((s, p) => s + (p.amount || 0), 0), itc: d.itc_eligibility || [], linked_bill: d.linked_bill || null, lmt: d.source && d.source.lmt,
  gst_return: d.gst_return || null,
});
const pView = d => ({
  id: d.id, no: d.doc_no, date: d.doc_date, period: d.period, section: d.section, supplier: d.supplier.name, gstin: d.supplier.gstin, pan: d.supplier.pan,
  amounts: d.amounts, value: d.invoice_value, itc: d.itc_available, reason: d.reason, rcm: d.rcm, pos: d.pos, filing_period: d.supplier.filing_period, filing_date: d.supplier.filing_date,
  src_id: d.src_id, stmt_id: d.stmt_id, version: d.version, is_amendment: d.is_amendment, amended_from: d.amended_from || [], source_type: d.source_type, inv_type: d.inv_type, issues: d.issues || [], demo: !!d.demo,
  supplier_state: d.supplier.state,
});

const periodsOf = r => {
  const b = r.b[0], p = r.p[0];
  const inv = (b && b.date) || (p && p.date);
  return { record: (p && p.period) || (b && b.period) || null, books: (b && b.period) || null, portal: (p && p.period) || null, invoice: inv ? inv.slice(0, 7) : null };
};

function finishRow(row, bById, pById, runVersion) {
  row.b = row.books_ids.map(id => bView(bById.get(id)));
  row.p = row.portal_ids.map(id => pView(pById.get(id)));
  row.periods = periodsOf(row);
  row.run_version = runVersion;
  const stale = row.books_ids.some(id => bById.get(id).stale);
  if (stale && !row.flags.includes('zoho_changed_not_refreshed')) row.flags.push('zoho_changed_not_refreshed');
  if (row.books_ids.some(id => (bById.get(id).data_quality || []).length) && !row.flags.includes('data_quality_note')) row.flags.push('data_quality_note');
  if (row.portal_ids.some(id => pById.get(id).portal_duplicate) && !row.flags.includes('portal_duplicate')) row.flags.push('portal_duplicate');
  if (row.portal_ids.some(id => (pById.get(id).amended_from || []).length) && !row.flags.includes('amendment')) row.flags.push('amendment');
  return row;
}

function excludedRow(side, doc, code, text, S) {
  const isB = side === 'books';
  const base = {
    id: `X:${doc.id}`, status: 'excluded', rule: null, books_ids: isB ? [doc.id] : [], portal_ids: isB ? [] : [doc.id],
    recipient_gstin: doc.recipient_gstin || '', supplier_gstin: (doc.supplier && doc.supplier.gstin) || '', supplier_name: (doc.supplier && doc.supplier.name) || '',
    doc_type: doc.doc_type || 'INV', flags: [], explain: [`Excluded: ${text}`], candidates: [], decision: { mode: 'auto', rule: null },
    diffs: null, within: null, tolerance_p: null, exclusion: { code, text },
  };
  if (doc.doc_type === 'CRN') base.flags.push('credit_note');
  if (doc.doc_type === 'DBN') base.flags.push('debit_note');
  if (doc.rcm) base.flags.push('reverse_charge');
  if (doc.is_amendment) base.flags.push('amendment');
  if (doc.supplier && doc.supplier.gstin && doc.supplier.gstin_valid === false) base.flags.push('invalid_gstin');
  if (code === 'incomplete' || code === 'incomplete_data') base.flags.push('incomplete_data');
  if (code === 'unsupported_section') base.flags.push('unsupported_section');
  return base;
}

const matchSettingsHash = S => hashOf({ t: S.tol_p, d: S.date_window_days, f: S.fuzzy_edit_distance, g: [S.group_enabled, S.group_max, S.group_date_window_days], n: S.normal_gap_months, v: 3 });

function create({ cfgNow, audit = { log: async () => {} }, log = console } = {}) {

  /** Reconcile one registration. `booksAll` = every Books document of the company (loaded once by run()). */
  async function runOne(co, reg, booksAll, { by, mode, S, decisions }) {
    const gstin = reg.gstin;
    const prev = await store.read(reconKey(co.id, gstin), null);
    const mine = booksAll.filter(d => d.recipient_gstin === gstin);
    const { effective, superseded } = await statements.effective(gstin);
    const excl = decisions.exclusions || {};

    // ── inputs ──
    const bEng = [], pEng = [], excludedRows = [];
    const bById = new Map(mine.map(d => [d.id, d])), pById = new Map(effective.map(d => [d.id, d]));
    for (const d of mine) {
      if (excl[d.id]) excludedRows.push(excludedRow('books', d, 'manual', `Excluded by ${excl[d.id].by}: ${excl[d.id].reason}`, S));
      else if (d.deleted) excludedRows.push(excludedRow('books', d, 'deleted', 'Deleted in Zoho', S));
      else if (d.excluded) excludedRows.push(excludedRow('books', d, d.excluded, d.excluded_text || d.excluded, S));
      else if (!d.amounts) excludedRows.push(excludedRow('books', d, 'pending_detail', 'Waiting for the document\'s amounts from Zoho (the sync has not fetched them yet)', S));
      else bEng.push(d);
    }
    for (const d of effective) {
      if (excl[d.id]) excludedRows.push(excludedRow('portal', d, 'manual', `Excluded by ${excl[d.id].by}: ${excl[d.id].reason}`, S));
      else if (!d.matchable) excludedRows.push(excludedRow('portal', d, 'unsupported_section', d.unsupported_reason || 'Section not matched in this phase', S));
      else if (d.incomplete) excludedRows.push(excludedRow('portal', d, 'incomplete_data', `Incomplete data in the statement (${(d.issues || []).join(', ')}) — cannot be matched reliably`, S));
      else pEng.push(d);
    }

    // ── reviewer links first: a link may join documents of DIFFERENT suppliers (e.g. a GSTIN typo), so links are applied
    //    before partitioning; their documents then leave the partitions. Stale links (a document gone) are reported. ──
    const bEngById = new Map(bEng.map(d => [d.id, d])), pEngById = new Map(pEng.map(d => [d.id, d]));
    const takenB = new Set(), takenP = new Set(), goodLinks = [], stale = [];
    for (const l of decisions.links) {
      const bs = l.books_ids.map(id => bEngById.get(id)), ps = l.portal_ids.map(id => pEngById.get(id));
      if (bs.some(x => !x) || ps.some(x => !x) || l.books_ids.some(id => takenB.has(id)) || l.portal_ids.some(id => takenP.has(id))) {
        if (l.books_ids.some(id => bById.has(id)) || l.portal_ids.some(id => pById.has(id))) stale.push(l);       // only this GSTIN's links
        continue;
      }
      l.books_ids.forEach(id => takenB.add(id)); l.portal_ids.forEach(id => takenP.add(id)); goodLinks.push(l);
    }
    let rows = [];
    if (goodLinks.length) {
      const out = M.matchSet([...takenB].map(id => bEngById.get(id)), [...takenP].map(id => pEngById.get(id)), S, { links: goodLinks }, { passes: [] });
      for (const r of out.rows) { r.partition = 'manual'; rows.push(finishRow(r, bById, pById, 0)); }
    }

    // ── partitions by supplier PAN (inside one registration; documents of other registrations never enter) ──
    const pk = d => (d.supplier && (d.supplier.pan || d.supplier.gstin)) || 'UNKNOWN';
    const free = list => list.filter(d => !takenB.has(d.id) && !takenP.has(d.id));
    const bPart = groupBy(free(bEng), pk), pPart = groupBy(free(pEng), pk);
    const keys = [...new Set([...bPart.keys(), ...pPart.keys()])].sort();
    const prevParts = (prev && prev.partitions) || {};
    const prevTypo = new Set((prev && prev.typo_parts) || []);                      // partitions whose leftovers the typo pass consumed last time
    const prevRowsByPart = groupBy(((prev && prev.rows) || []).filter(r => r.partition && r.partition !== 'manual' && r.partition !== '*typo'), r => r.partition);
    const sHash = matchSettingsHash(S);
    const partitions = {};
    let recomputed = 0, reused = 0;
    for (const k of keys) {
      const B = bPart.get(k) || [], P = pPart.get(k) || [];
      const ids = new Set([...B.map(d => d.id), ...P.map(d => d.id)]);
      const blocks = decisions.blocks.filter(x => ids.has(x.split('|')[0]) || ids.has(x.split('|')[1]));
      const hash = hashOf([sHash, B.map(d => [d.id, d.hash, d.source && d.source.lmt, !!d.stale]).sort(), P.map(d => [d.id, d.amounts, d.doc_no, d.doc_date, d.itc_available, d.period, d.is_amendment, d.supplier.gstin, d.src_id]).sort(), blocks]);
      partitions[k] = { hash, books: B.length, portal: P.length };
      if (mode !== 'all' && prevParts[k] && prevParts[k].hash === hash && prevRowsByPart.get(k) && !prevTypo.has(k)) { rows.push(...prevRowsByPart.get(k)); reused++; continue; }
      const out = M.matchSet(B, P, S, { links: [], blocks: blocks.filter(x => ids.has(x.split('|')[0])) });
      for (const r of out.rows) { r.partition = k; rows.push(finishRow(r, bById, pById, 0)); }
      recomputed++;
    }

    // ── GSTIN typos across partitions: the leftovers of the whole registration, X1 pass only (cheap, every run) ──
    const typoParts = new Set();
    {
      const lb = rows.filter(r => r.status === 'books_only').map(r => bById.get(r.books_ids[0]));
      const lp = rows.filter(r => r.status === 'portal_only').map(r => pById.get(r.portal_ids[0]));
      if (lb.length && lp.length) {
        const out = M.matchSet(lb, lp, S, { blocks: decisions.blocks }, { passes: ['X1'] });
        const sugg = out.rows.filter(r => r.status === 'suggested');
        if (sugg.length) {
          const gone = new Set(sugg.flatMap(r => [...r.books_ids.map(i => `B:${i}`), ...r.portal_ids.map(i => `P:${i}`)]));
          for (const r of rows) if (gone.has(r.id)) typoParts.add(r.partition);
          rows = rows.filter(r => !gone.has(r.id));
          for (const r of sugg) { r.partition = '*typo'; rows.push(finishRow(r, bById, pById, 0)); }
        }
      }
    }
    for (const r of excludedRows) { r.partition = ''; rows.push(finishRow(r, bById, pById, 0)); }

    // ── accounting: every document exactly once ──
    const acc = M.accounting(rows, mine, effective);
    if (!acc.ok) throw new Error(`Reconciliation for ${gstin} does not account for every document exactly once (${acc.missingB.length + acc.missingP.length} missing, ${acc.extraB.length + acc.extraP.length} unexpected) — nothing was saved.`);

    const version = ((prev && prev.version) || 0) + 1;
    for (const r of rows) r.run_version = version;
    const changes = diffRuns(prev && prev.rows, rows);
    const summary = summarizeRows(rows);
    const doc = {
      company: co.id, gstin, version, ran_at: nowIso(), by, mode, settings_hash: sHash,
      inputs: {
        books: { documents: mine.length, matchable: bEng.length, excluded: countBy(excludedRows.filter(r => r.books_ids.length), r => r.exclusion.code), pending_detail: excludedRows.filter(r => r.exclusion && r.exclusion.code === 'pending_detail').length },
        portal: { documents: effective.length, matchable: pEng.length, superseded_versions: superseded.length, excluded: countBy(excludedRows.filter(r => r.portal_ids.length), r => r.exclusion.code) },
        statements: (await statements.list()).filter(s => s.gstin === gstin && s.is_current).map(s => ({ id: s.id, period: s.period, version: s.version, gendt: s.gendt })),
      },
      partitions, typo_parts: [...typoParts], recomputed, reused, stale_links: stale.map(l => ({ id: l.id, books_ids: l.books_ids, portal_ids: l.portal_ids, by: l.by })),
      changes, summary, rows,
    };
    await store.write(reconKey(co.id, gstin), doc);
    await audit.log({ by, action: 'recon.run', company: co.id, gstin, detail: `v${version} (${mode}): ${recomputed} partition(s) recomputed, ${reused} reused; ${summary.counts.exact + summary.counts.tolerance} matched, ${summary.counts.suggested} suggested, ${summary.counts.mismatched} mismatched, ${summary.counts.books_only} Books-only, ${summary.counts.portal_only} 2B-only` });
    return { gstin, version, recomputed, reused, summary, changes, stale_links: doc.stale_links };
  }

  async function run({ company, gstin = null, by = 'system', mode = 'dirty' }) {
    const cfg = await cfgNow();
    const co = cfg.companies.find(c => c.id === company);
    if (!co) throw new Error(`Unknown company "${company}"`);
    const regs = co.registrations.filter(r => r.active && (!gstin || r.gstin === gstin));
    if (!regs.length) throw new Error('No active GSTIN to reconcile for this company');
    const booksAll = await books.all(co.id);
    const decisions = await review.decisionsFor(co.id);
    const results = [];
    for (const reg of regs) results.push(await runOne(co, reg, booksAll, { by, mode, S: cfg.settings, decisions }));
    await markRecipientHints(cfg);
    return { company: co.id, results };
  }

  /** Same supplier, number, date and amounts sitting as Books-only under one GSTIN and GSTR-2B-only under ANOTHER: flag both, link nothing */
  async function markRecipientHints(cfg) {
    const docs = [];
    for (const co of cfg.companies) for (const reg of co.registrations) { const d = await store.read(reconKey(co.id, reg.gstin), null); if (d) docs.push({ co, reg, d }); }
    if (docs.length < 2) return 0;
    const S = M.settingsOf(cfg.settings);
    const key = r => `${r.supplier_gstin}|${(r.b[0] || r.p[0]).no ? N.normDocNo((r.b[0] || r.p[0]).no) : ''}|${(r.b[0] || r.p[0]).date}`;
    const bo = new Map(), po = new Map();
    for (const x of docs) for (const r of x.d.rows) { r.related = undefined; if (r.status === 'books_only') (bo.get(key(r)) || bo.set(key(r), []).get(key(r))).push({ x, r }); else if (r.status === 'portal_only') (po.get(key(r)) || po.set(key(r), []).get(key(r))).push({ x, r }); }
    let n = 0;
    const changed = new Set();
    for (const [k, bs] of bo) for (const b of bs) for (const p of po.get(k) || []) {
      if (b.x.reg.gstin === p.x.reg.gstin) continue;
      const ev = M.evaluate(b.r.b.map(v => ({ amounts: v.amounts, invoice_value: v.value })), p.r.p.map(v => ({ amounts: v.amounts, invoice_value: v.value })), S);
      if (!ev.allWithin) continue;
      for (const [me, other] of [[b, p], [p, b]]) {
        if (!me.r.flags.includes('wrong_recipient_gstin')) me.r.flags.push('wrong_recipient_gstin');
        me.r.related = { gstin: other.x.reg.gstin, company: other.x.co.id, company_name: other.x.co.name, row_id: other.r.id, side: other === p ? 'GSTR-2B' : 'Books' };
        me.r.explain = [...me.r.explain.filter(t => !/^Possible wrong recipient/.test(t)), `Possible wrong recipient GSTIN: the same supplier, number, date and amounts appear as ${other === p ? 'GSTR-2B-only' : 'Books-only'} under ${other.x.reg.gstin} (${other.x.co.name}). Nothing is matched across GSTINs — confirm which registration the invoice was issued to.`];
        changed.add(me.x);
      }
      n++;
    }
    // flags that no longer apply are cleared above (related reset); drop the flag where there is no related link now
    for (const x of docs) { for (const r of x.d.rows) if (!r.related && r.flags.includes('wrong_recipient_gstin')) { r.flags = r.flags.filter(f => f !== 'wrong_recipient_gstin'); changed.add(x); } }
    for (const x of changed) await store.write(reconKey(x.co.id, x.reg.gstin), x.d);
    return n;
  }

  const load = (company, gstin) => store.read(reconKey(company, gstin), null);

  return { run, load, markRecipientHints };
}

const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] || 0) + 1; } return m; };

/** What changed since the previous run, by row id: new / removed / moved between statuses */
function diffRuns(prevRows, rows) {
  if (!prevRows) return { first_run: true, total: rows.length, transitions: {}, new_rows: rows.length, removed_rows: 0 };
  const byDoc = new Map();
  for (const r of prevRows) for (const id of [...r.books_ids, ...r.portal_ids]) byDoc.set(id, r.status);
  const t = {};
  let moved = 0;
  for (const r of rows) {
    const ids = [...r.books_ids, ...r.portal_ids];
    const was = byDoc.get(ids[0]);
    if (was && was !== r.status) { const k = `${was} → ${r.status}`; t[k] = (t[k] || 0) + 1; moved++; }
  }
  const nowIds = new Set(rows.flatMap(r => [...r.books_ids, ...r.portal_ids]));
  const newRows = rows.filter(r => ![...r.books_ids, ...r.portal_ids].some(id => byDoc.has(id))).length;
  const removed = [...byDoc.keys()].filter(id => !nowIds.has(id)).length;
  return { first_run: false, total: rows.length, moved, transitions: t, new_rows: newRows, removed_rows: removed };
}

/** Counts and amounts per primary status (rows are mutually exclusive, so the totals add up) */
function summarizeRows(rows) {
  const counts = {}, books = {}, portal = {};
  for (const s of Object.keys(M.STATUS)) { counts[s] = 0; books[s] = zeroAmounts(); portal[s] = zeroAmounts(); }
  const sign = d => (d === 'CRN' ? -1 : 1);
  for (const r of rows) {
    counts[r.status]++;
    for (const v of r.b) for (const c of COMPONENTS) books[r.status][c] += sign(r.doc_type) * (v.amounts[c] || 0);
    for (const v of r.p) for (const c of COMPONENTS) portal[r.status][c] += sign(r.doc_type) * (v.amounts[c] || 0);
  }
  return { counts, books, portal, rows: rows.length };
}

module.exports = { create, COVERAGE_MATRIX, summarizeRows, diffRuns, reconKey, excludedRow, bView, pView, matchSettingsHash };
