/**
 * GSTR-2B Reco — matching engine (pure functions, no I/O).
 *
 * Deterministic and explainable: every row says which rule produced it and why. It never decides tax
 * entitlement, never matches on vendor name / PAN / similar amounts alone, and never offsets one tax
 * component's difference against another (IGST vs CGST/SGST, taxable vs tax).
 *
 * Input: Books documents and GSTR-2B documents of ONE recipient GSTIN (the caller partitions by
 * recipient GSTIN and by supplier PAN; documents of different recipient GSTINs are never mixed here).
 * Every document is consumed by exactly one output row.
 *
 * Rules, in order (the first to claim a document wins):
 *   MANUAL  reviewer's link (honoured first; a reviewer's "not a match" block is honoured everywhere)
 *   R1      same supplier GSTIN + type + document number (exact text) + document date, one-to-one
 *   R2      same, with the number normalised for case, spaces and punctuation only (no leading-zero change)
 *   R3      R1/R2 identity with each tax component's difference inside its tolerance (status "tolerance")
 *   R4      candidate suggestions — fuzzy number / date window / amounts — REVIEW REQUIRED, never automatic
 *   R5      cross-period: not a separate rule; late/early reporting is a flag on any matched row
 *   R6      grouped split / consolidated documents — REVIEW REQUIRED
 *   X1      same recipient, DIFFERENT supplier GSTIN of the same PAN (or a one-to-two-character GSTIN typo)
 *           with identical number, date and amounts — REVIEW REQUIRED, flagged "wrong supplier GSTIN"
 * Whatever is left is "books_only" or "portal_only".
 */

'use strict';

const { COMPONENTS, diffAmounts, addAmounts, zeroAmounts } = require('./money');
const { editDistance, daysBetween, monthIndex, fyLabel, periodOfDate } = require('./normalize');
const { hashOf, groupBy } = require('./util');

const DEFAULTS = {
  tol_p: { taxable: 100, igst: 100, cgst: 100, sgst: 100, cess: 100 },   // ₹1.00 per component (paise)
  invoice_value_tol_p: 200,       // invoice value is informational only
  date_window_days: 7,            // R4: how far apart the dates may be
  fuzzy_edit_distance: 2,         // R4: characters that may differ in a document number
  fuzzy_min_len: 4,               // shorter numbers are never fuzzy-matched
  group_enabled: true,            // R6
  group_max: 4,                   // documents on the many side
  group_date_window_days: 5,
  group_pool_max: 14,
  normal_gap_months: 1,           // supplier normally reports in the invoice month or the next
  gstin_typo_distance: 2,         // X1
};

const STATUS = {
  exact: 'Exact matched',
  tolerance: 'Matched within approved tolerance',
  suggested: 'Suggested match — review required',
  mismatched: 'Mismatched',
  books_only: 'Books only',
  portal_only: 'GSTR-2B only',
  excluded: 'Excluded',
};

const settingsOf = s => ({ ...DEFAULTS, ...(s || {}), tol_p: { ...DEFAULTS.tol_p, ...((s && s.tol_p) || {}) } });

// ── Small helpers ─────────────────────────────────────────────────────────────
const amt = d => ({ ...zeroAmounts(), ...(d.amounts || {}) });
const sumAmounts = docs => docs.reduce((a, d) => addAmounts(a, amt(d)), zeroAmounts());
const sumValue = docs => docs.reduce((a, d) => a + (d.invoice_value || 0), 0);
const rawKey = d => `${String(d.doc_no ?? '').trim()}|${d.doc_date || ''}`;
const normKey = d => `${d.doc_no_norm || ''}|${d.doc_date || ''}`;
const supplierOf = d => (d.supplier && d.supplier.gstin) || '';
const uniqueSorted = a => [...new Set(a)].sort();

/** Per-component tolerance; grouped rows get the tolerance once per document on the larger side */
function tolFor(S, n = 1, approved = null) {
  const t = {};
  for (const c of COMPONENTS) t[c] = Math.max(S.tol_p[c] || 0, (approved && approved[c]) || 0) * Math.max(1, n);
  return t;
}

/** Component-wise comparison of two sides (portal − books). No component is ever offset against another. */
function evaluate(books, portal, S, approved = null) {
  const diffs = diffAmounts(sumAmounts(portal), sumAmounts(books));
  const tol = tolFor(S, Math.max(books.length, portal.length), approved);
  const within = {};
  for (const c of COMPONENTS) within[c] = Math.abs(diffs[c]) <= tol[c];
  const allZero = COMPONENTS.every(c => diffs[c] === 0);
  const allWithin = COMPONENTS.every(c => within[c]);
  const value_diff = sumValue(portal) - sumValue(books);
  return { diffs: { ...diffs, invoice_value: value_diff }, within, tol, allZero, allWithin, status: allZero ? 'exact' : allWithin ? 'tolerance' : 'mismatched' };
}

/** Tax-type mix: IGST vs CGST+SGST. Equal totals with a different mix is a mismatch, never a tolerance match. */
function taxMix(a) { return `${a.igst ? 'I' : ''}${a.cgst || a.sgst ? 'C' : ''}${a.cess ? 'X' : ''}`; }

function docFlags(d, side) {
  const f = [];
  if (d.doc_type === 'CRN') f.push('credit_note');
  if (d.doc_type === 'DBN') f.push('debit_note');
  if (d.rcm) f.push('reverse_charge');
  if (d.supplier && d.supplier.gstin && d.supplier.gstin_valid === false) f.push('invalid_gstin');
  if (d.is_amendment) f.push('amendment');
  if (d.date_assumed) f.push('date_assumed');
  if (d.incomplete) f.push('incomplete_data');
  if (side === 'portal' && d.itc_available === 'N') f.push('itc_not_available_per_portal');
  const a = d.amounts || {};
  if (!(a.igst || a.cgst || a.sgst || a.cess)) f.push('zero_tax');                  // exempt / nil-rated / SEZ without payment of tax: no GST at stake
  return f;
}

/** Late / early reporting and financial-year crossing, from the invoice date and the 2B return period */
function periodFlags(books, portal, S) {
  const f = [];
  const b = books[0], p = portal[0];
  if (!b || !p || !p.period || !b.doc_date) return f;
  const gap = monthIndex(p.period) - monthIndex(periodOfDate(b.doc_date));
  if (gap > S.normal_gap_months) f.push('cross_period', 'late_reporting');
  else if (gap < 0) f.push('cross_period', 'early_reporting');
  if (fyLabel(b.doc_date) !== fyLabel(`${p.period}-01`)) f.push('cross_fy');
  return f;
}

// ── Row construction ──────────────────────────────────────────────────────────
function makeRow({ status, rule, books = [], portal = [], S, flags = [], explain = [], candidates = [], decision = null, approved = null, ambiguous = false }) {
  const row = {
    id: books.length && portal.length ? `M:${hashOf({ b: uniqueSorted(books.map(d => d.id)), p: uniqueSorted(portal.map(d => d.id)) })}`
      : books.length ? `B:${books.map(d => d.id).sort().join('+')}` : `P:${portal.map(d => d.id).sort().join('+')}`,
    status, rule: rule || null,
    books_ids: books.map(d => d.id), portal_ids: portal.map(d => d.id),
    recipient_gstin: (books[0] || portal[0] || {}).recipient_gstin || '',
    supplier_gstin: supplierOf(portal[0] || {}) || supplierOf(books[0] || {}),
    supplier_name: (books[0] && books[0].supplier && books[0].supplier.name) || (portal[0] && portal[0].supplier && portal[0].supplier.name) || '',
    doc_type: (books[0] || portal[0] || {}).doc_type || 'INV',
    flags: [], explain, candidates, decision: decision || { mode: 'auto', rule: rule || null },
    diffs: null, within: null, tolerance_p: null,
  };
  const fl = new Set(flags);
  for (const d of books) docFlags(d, 'books').forEach(x => fl.add(x));
  for (const d of portal) docFlags(d, 'portal').forEach(x => fl.add(x));
  if (books.length && portal.length) {
    const ev = evaluate(books, portal, S, approved);
    row.diffs = ev.diffs; row.within = ev.within; row.tolerance_p = ev.tol;
    row._ev = ev;
    if (taxMix(sumAmounts(books)) !== taxMix(sumAmounts(portal)) && (sumAmounts(books).igst || sumAmounts(portal).igst)) fl.add('tax_type_mismatch');
    if (Math.abs(ev.diffs.invoice_value) > S.invoice_value_tol_p && ev.allWithin) fl.add('invoice_value_differs');
    periodFlags(books, portal, S).forEach(x => fl.add(x));
  }
  if (ambiguous) fl.add('ambiguous');
  row.flags = [...fl];
  return row;
}

// ── The matcher ───────────────────────────────────────────────────────────────
/**
 * @param {object[]} booksIn   Books documents (eligible ones only)
 * @param {object[]} portalIn  GSTR-2B documents (effective versions, matchable sections only)
 * @param {object}   settings  tolerances etc. (see DEFAULTS)
 * @param {object}   decisions { links:[{books_ids,portal_ids,approved_tol_p,by,at,reason}], blocks:['bookId|portalId'] }
 * @returns {{rows:object[], stale_links:object[]}}
 */
function matchSet(booksIn, portalIn, settings, decisions = {}, opts = {}) {
  const S = settingsOf(settings);
  const run = name => !opts.passes || opts.passes.includes(name);               // opts.passes limits which passes run (e.g. ['X1'])
  const links = decisions.links || [];
  const blocks = new Set(decisions.blocks || []);
  const isBlocked = (b, p) => blocks.has(`${b.id}|${p.id}`);

  const booksById = new Map(booksIn.map(d => [d.id, d]));
  const portalById = new Map(portalIn.map(d => [d.id, d]));
  const usedB = new Set(), usedP = new Set();
  const rows = [], stale = [];
  const extraFlags = new Map();                       // doc id → flags to add on its final row (duplicates, collisions…)
  const addFlag = (id, f) => { (extraFlags.get(id) || extraFlags.set(id, new Set()).get(id)).add(f); };
  const candidatesOf = new Map();                     // doc id → [{other id, score, reasons}] for display on unmatched rows

  const emit = (spec) => {
    const flags = new Set(spec.flags || []);
    for (const d of [...(spec.books || []), ...(spec.portal || [])]) (extraFlags.get(d.id) || []).forEach(f => flags.add(f));
    const row = makeRow({ ...spec, S, flags: [...flags] });
    for (const d of spec.books || []) { if (usedB.has(d.id)) throw new Error(`Books document ${d.id} consumed twice`); usedB.add(d.id); }
    for (const d of spec.portal || []) { if (usedP.has(d.id)) throw new Error(`GSTR-2B document ${d.id} consumed twice`); usedP.add(d.id); }
    rows.push(row);
    return row;
  };
  const freeB = () => booksIn.filter(d => !usedB.has(d.id));
  const freeP = () => portalIn.filter(d => !usedP.has(d.id));

  // ── Duplicate detection inside Books (flags only; matching below stays one-to-one) ──
  const dupGroups = groupBy(booksIn.filter(d => d.doc_no_norm), d => `${supplierOf(d)}|${d.doc_type}|${d.doc_no_norm}`);
  for (const g of dupGroups.values()) if (g.length > 1) g.forEach(d => addFlag(d.id, 'duplicate_suspected'));
  const sameAmounts = groupBy(booksIn.filter(d => d.doc_date), d => `${supplierOf(d)}|${d.doc_type}|${d.doc_date}|${COMPONENTS.map(c => amt(d)[c]).join(',')}`);
  for (const g of sameAmounts.values()) if (g.length > 1 && new Set(g.map(d => d.doc_no_norm)).size > 1) g.forEach(d => addFlag(d.id, 'duplicate_possible'));

  // ── MANUAL links ──
  for (const lk of links) {
    const bs = (lk.books_ids || []).map(id => booksById.get(id));
    const ps = (lk.portal_ids || []).map(id => portalById.get(id));
    if (!bs.length || !ps.length || bs.some(x => !x || usedB.has(x.id)) || ps.some(x => !x || usedP.has(x.id))) { stale.push(lk); continue; }
    const ev = evaluate(bs, ps, S, lk.approved_tol_p);
    emit({ status: ev.status, rule: 'MANUAL', books: bs, portal: ps,
      decision: { mode: 'manual', by: lk.by || '', at: lk.at || '', reason: lk.reason || '', approved_from: lk.approved_from || null },
      approved: lk.approved_tol_p || null,
      explain: [`Linked by ${lk.by || 'a reviewer'}${lk.reason ? ` — ${lk.reason}` : ''}.`, ...describeDiffs(ev)] });
  }

  // ── R1 / R2 (+R3): identity pairing per supplier GSTIN and document type ──
  function identityPass(kind) {
    const keyOf = kind === 'R1' ? rawKey : normKey;
    const B = freeB().filter(d => d.doc_no && d.doc_date && !d.date_assumed);
    const P = freeP().filter(d => d.doc_no && d.doc_date);
    const pIdx = groupBy(P, d => `${supplierOf(d)}|${d.doc_type}|${keyOf(d)}`);
    const bIdx = groupBy(B, d => `${supplierOf(d)}|${d.doc_type}|${keyOf(d)}`);
    for (const [k, bs] of bIdx) {
      const ps = (pIdx.get(k) || []).filter(p => !bs.every(b => isBlocked(b, p)));
      if (!ps.length) continue;
      if (kind === 'R2') {
        // normalisation collision: two different raw numbers collapsing to the same key on one side
        const rawB = new Set(bs.map(d => String(d.doc_no).trim())), rawP = new Set(ps.map(d => String(d.doc_no).trim()));
        if (rawB.size > 1 || rawP.size > 1) { [...bs, ...ps].forEach(d => addFlag(d.id, 'normalization_collision')); continue; }
      }
      if (bs.length !== 1 || ps.length !== 1) { [...bs, ...ps].forEach(d => addFlag(d.id, 'ambiguous')); continue; }
      const [b] = bs, [p] = ps;
      if (isBlocked(b, p)) continue;
      const ev = evaluate([b], [p], S);
      const rule = kind === 'R1' ? 'R1' : 'R2';
      const row = emit({ status: ev.status, rule: ev.status === 'tolerance' ? 'R3' : rule, books: [b], portal: [p],
        explain: [identityText(kind, b, p), ...describeDiffs(ev)] });
      row.identity = rule;                                  // which identity rule paired the documents (R3 rows keep it)
    }
  }
  if (run('R1')) identityPass('R1');
  if (run('R2')) identityPass('R2');

  // ── R4: suggestions inside one supplier GSTIN / type (never automatic) ──
  if (run('R4')) suggestionPass((b, p) => supplierOf(b) === supplierOf(p) && b.doc_type === p.doc_type, 'R4', false);

  // ── X1: other GSTIN of the same PAN, or a GSTIN typo ──
  if (run('X1')) suggestionPass((b, p) => supplierOf(b) !== supplierOf(p) && b.doc_type === p.doc_type && gstinRelated(b, p, S), 'X1', true);

  // ── R6: grouped split / consolidated (never automatic) ──
  if (S.group_enabled && run('R6')) groupedPass();

  // ── Leftovers ──
  for (const b of freeB()) emit({ status: 'books_only', books: [b], candidates: topCandidates(b.id), explain: ['No GSTR-2B document matched this Books document.'] });
  for (const p of freeP()) emit({ status: 'portal_only', portal: [p], candidates: topCandidates(p.id), explain: ['No Books document matched this GSTR-2B document.'] });

  for (const r of rows) delete r._ev;
  return { rows, stale_links: stale };

  // ───────────────────────── inner passes ─────────────────────────
  function scorePair(b, p, allowOtherGstin) {
    const reasons = [];
    let num = 0;
    if (b.doc_no_norm && b.doc_no_norm === p.doc_no_norm) { num = 3; reasons.push('document number equal after ignoring case, spaces and punctuation'); }
    else if (b.doc_no_core && b.doc_no_core === p.doc_no_core) { num = 2; reasons.push('document numbers equal once leading zeros are ignored'); }
    else if (Math.min((b.doc_no_norm || '').length, (p.doc_no_norm || '').length) >= S.fuzzy_min_len
      && editDistance(b.doc_no_norm, p.doc_no_norm, S.fuzzy_edit_distance) <= S.fuzzy_edit_distance) { num = 1; reasons.push(`document numbers differ by ${editDistance(b.doc_no_norm, p.doc_no_norm, S.fuzzy_edit_distance)} character(s)`); }

    let date = 0, dd = null;
    if (b.doc_date && p.doc_date) {
      dd = Math.abs(daysBetween(b.doc_date, p.doc_date));
      date = dd === 0 ? 3 : dd <= 3 ? 2 : dd <= S.date_window_days ? 1 : -1;
      if (b.date_assumed) { date = Math.min(date, 1); reasons.push('Books date is the posting date (supplier invoice date missing)'); }
      else reasons.push(dd === 0 ? 'same document date' : `dates ${dd} day(s) apart`);
    }
    const ev = evaluate([b], [p], S);
    const a = ev.allZero ? 3 : ev.allWithin ? 2 : similarTaxable(b, p) ? 1 : 0;
    reasons.push(a === 3 ? 'all five amounts identical' : a === 2 ? 'all amounts within tolerance' : a === 1 ? 'taxable value within 2% but a component differs' : 'amounts differ');

    let eligible = false;
    if (num === 3 && (date >= 1 || b.date_assumed) && a >= 1) eligible = true;
    else if (num === 2 && date >= 1 && a >= 2) eligible = true;
    else if (num === 2 && date === 3 && a >= 1) eligible = true;
    else if (num === 1 && date >= 2 && a >= 2) eligible = true;
    else if (num === 0 && date === 3 && a === 3 && b.doc_no && p.doc_no && amt(b).taxable !== 0) { eligible = true; reasons.push('document numbers differ completely — same date and identical amounts only'); }
    if (allowOtherGstin && !(num >= 2 && date === 3 && a >= 2)) eligible = false;   // X1 needs number, date and amounts
    return { eligible, score: num * 4 + a * 3 + Math.max(date, 0) * 2, num, date, amt: a, dd, ev, reasons };
  }

  function similarTaxable(b, p) {
    const x = amt(b).taxable, y = amt(p).taxable;
    if (!x || !y) return false;
    return Math.abs(x - y) * 50 <= Math.max(Math.abs(x), Math.abs(y));      // ≤ 2%
  }

  function suggestionPass(pairOk, rule, crossGstin) {
    for (let loop = 0; loop < 6; loop++) {
      const B = freeB(), P = freeP();
      if (!B.length || !P.length) return;
      // bucket portal docs by supplier PAN for speed (X1 compares across GSTINs of one PAN, or typos)
      const cands = new Map();                                       // books id → [{p, sc}]
      const candsP = new Map();
      for (const b of B) {
        for (const p of P) {
          if (!pairOk(b, p) || isBlocked(b, p)) continue;
          const sc = scorePair(b, p, crossGstin);
          if (!sc.eligible) continue;
          (cands.get(b.id) || cands.set(b.id, []).get(b.id)).push({ b, p, sc });
          (candsP.get(p.id) || candsP.set(p.id, []).get(p.id)).push({ b, p, sc });
        }
      }
      if (!cands.size) return;
      const rank = list => list.sort((x, y) => y.sc.score - x.sc.score || (x.sc.dd ?? 99) - (y.sc.dd ?? 99) || (x.p.id < y.p.id ? -1 : 1));
      for (const l of cands.values()) rank(l);
      for (const l of candsP.values()) rank(l);
      let assigned = 0;
      for (const [bid, list] of cands) {
        const best = list[0];
        const bSecond = list[1] ? list[1].sc.score : -Infinity;
        const pList = candsP.get(best.p.id);
        const pSecond = pList[1] ? pList[1].sc.score : -Infinity;
        const mutual = pList[0].b.id === bid;
        const unique = best.sc.score > bSecond && best.sc.score > pSecond;
        // remember the candidates for display on whatever stays unmatched
        remember(bid, list); remember(best.p.id, pList);
        if (!(mutual && unique) || usedB.has(bid) || usedP.has(best.p.id)) continue;
        const sc = best.sc;
        const relation = crossGstin ? gstinRelationText(best.b, best.p) : null;
        emit({ status: 'suggested', rule, books: [best.b], portal: [best.p],
          flags: crossGstin ? ['wrong_supplier_gstin'] : (sc.num === 0 ? ['number_differs'] : []),
          candidates: list.slice(0, 3).map(c => candView(c)),
          explain: [`Suggested — review required: ${sc.reasons.join('; ')}.`, ...(relation ? [relation] : []), ...describeDiffs(sc.ev)] });
        assigned++;
      }
      if (!assigned) {
        // ambiguity: every doc that still has ≥ 2 candidates is flagged for the reviewer
        for (const [bid, list] of cands) if (list.length > 1) { addFlag(bid, 'ambiguous'); list.forEach(c => addFlag(c.p.id, 'ambiguous')); }
        return;
      }
    }
  }
  function remember(id, list) { candidatesOf.set(id, list.slice(0, 3).map(candView)); }
  function candView(c) { return { books_id: c.b.id, portal_id: c.p.id, score: c.sc.score, reasons: c.sc.reasons, diffs: c.sc.ev.diffs }; }
  function topCandidates(id) { return candidatesOf.get(id) || []; }

  function groupedPass() {
    // many Books ↔ one GSTR-2B document, then one Books ↔ many GSTR-2B documents (same supplier GSTIN and type)
    const trySide = (singles, pool, singleIsPortal) => {
      for (const s of singles) {
        if (singleIsPortal ? usedP.has(s.id) : usedB.has(s.id)) continue;
        const cand = pool.filter(x => (singleIsPortal ? !usedB.has(x.id) : !usedP.has(x.id))
          && supplierOf(x) === supplierOf(s) && x.doc_type === s.doc_type
          && (!x.doc_date || !s.doc_date || Math.abs(daysBetween(x.doc_date, s.doc_date)) <= S.group_date_window_days)
          && (singleIsPortal ? !isBlocked(x, s) : !isBlocked(s, x))
          && COMPONENTS.every(c => amt(x)[c] <= amt(s)[c] + S.tol_p[c]));
        if (cand.length < 2 || cand.length > S.group_pool_max) continue;
        const sols = [];
        const target = amt(s);
        const dfs = (start, chosen, acc) => {
          if (sols.length > 1) return;
          if (chosen.length >= 2) {
            const ok = COMPONENTS.every(c => Math.abs(acc[c] - target[c]) <= S.tol_p[c] * chosen.length);
            if (ok) { sols.push([...chosen]); return; }
          }
          if (chosen.length >= S.group_max) return;
          for (let i = start; i < cand.length; i++) {
            const next = addAmounts(acc, amt(cand[i]));
            if (COMPONENTS.some(c => next[c] > target[c] + S.tol_p[c] * (chosen.length + 1))) continue;
            chosen.push(cand[i]); dfs(i + 1, chosen, next); chosen.pop();
          }
        };
        dfs(0, [], zeroAmounts());
        if (sols.length !== 1) { if (sols.length > 1) { addFlag(s.id, 'ambiguous'); } continue; }   // exactly one explanation, or none
        const many = sols[0];
        const books = singleIsPortal ? many : [s], portal = singleIsPortal ? [s] : many;
        const ev = evaluate(books, portal, S);
        emit({ status: 'suggested', rule: 'R6', books, portal, flags: ['grouped'],
          explain: [`Suggested — review required: ${many.length} ${singleIsPortal ? 'Books' : 'GSTR-2B'} documents add up to one ${singleIsPortal ? 'GSTR-2B' : 'Books'} document (split / consolidated invoice), same supplier and dates within ${S.group_date_window_days} days.`, ...describeDiffs(ev)] });
      }
    };
    trySide(freeP(), freeB(), true);
    trySide(freeB(), freeP(), false);
  }
}

function gstinRelated(b, p, S) {
  const gb = supplierOf(b), gp = supplierOf(p);
  if (!gb || !gp || gb === gp) return false;
  const panB = gb.slice(2, 12), panP = gp.slice(2, 12);
  if (panB && panB === panP) return true;
  return editDistance(gb, gp, S.gstin_typo_distance) <= S.gstin_typo_distance;
}
function gstinRelationText(b, p) {
  const gb = supplierOf(b), gp = supplierOf(p);
  const samePan = gb.slice(2, 12) === gp.slice(2, 12);
  return samePan
    ? `Supplier GSTIN differs (${gb} in Books, ${gp} on GSTR-2B) but the PAN is the same — a different registration of the same supplier; confirm which one is right.`
    : `Supplier GSTIN differs by ${editDistance(gb, gp, 4)} character(s) (${gb} in Books, ${gp} on GSTR-2B) — possible typing error in the vendor's GSTIN.`;
}

function identityText(kind, b, p) {
  return kind === 'R1'
    ? `Same supplier GSTIN, ${b.doc_type === 'INV' ? 'invoice' : 'note'} number "${b.doc_no}" and date ${b.doc_date} in Books and GSTR-2B.`
    : `Same supplier GSTIN and date ${b.doc_date}; numbers "${b.doc_no}" (Books) and "${p.doc_no}" (GSTR-2B) are equal after ignoring case, spaces and punctuation.`;
}

function describeDiffs(ev) {
  const names = { taxable: 'Taxable value', igst: 'IGST', cgst: 'CGST', sgst: 'SGST/UTGST', cess: 'Cess' };
  const out = [];
  for (const c of COMPONENTS) {
    const d = ev.diffs[c];
    if (d === 0) continue;
    out.push(`${names[c]} differs by ${(d / 100).toFixed(2)} (GSTR-2B − Books); tolerance ₹${(ev.tol[c] / 100).toFixed(2)} → ${ev.within[c] ? 'within' : 'OUTSIDE'} tolerance.`);
  }
  if (!out.length) out.push('All five amounts are identical.');
  return out;
}

/** Every document of both sides must appear in exactly one row — used by tests and the run-time guard */
function accounting(rows, books, portal) {
  const cb = new Map(), cp = new Map();
  for (const r of rows) {
    for (const id of r.books_ids) cb.set(id, (cb.get(id) || 0) + 1);
    for (const id of r.portal_ids) cp.set(id, (cp.get(id) || 0) + 1);
  }
  const idsB = new Set(books.map(d => d.id)), idsP = new Set(portal.map(d => d.id));
  const missingB = books.filter(d => cb.get(d.id) !== 1).map(d => d.id);
  const missingP = portal.filter(d => cp.get(d.id) !== 1).map(d => d.id);
  const extraB = [...cb.keys()].filter(id => !idsB.has(id));
  const extraP = [...cp.keys()].filter(id => !idsP.has(id));
  return { ok: !missingB.length && !missingP.length && !extraB.length && !extraP.length, missingB, missingP, extraB, extraP };
}

module.exports = { DEFAULTS, STATUS, settingsOf, matchSet, evaluate, accounting, periodFlags, sumAmounts, describeDiffs };
