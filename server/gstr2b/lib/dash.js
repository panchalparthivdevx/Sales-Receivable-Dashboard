/**
 * Dashboard figures from reconciliation rows. Every figure is computed from rows only, and every row has exactly one
 * primary status, so the totals add up and nothing is counted twice; flags are overlays and are never summed into totals.
 *
 * "GST" below = IGST + CGST + SGST/UTGST + cess, signed (credit notes are negative). Amounts are paise.
 */

'use strict';

const N = require('./normalize');
const { COMPONENTS, zeroAmounts, addAmounts } = require('./money');
const { claimDeadline, exposureClass } = require('./rules');
const { STATUS } = require('./match');
const T = require('./tasks');

const DEFINITIONS = {
  books_gst: 'GST (IGST + CGST + SGST + cess) on Books documents that can be matched against GSTR-2B in the selected scope: bills with a supplier GSTIN, vendor credits (negative) and GST-bearing expenses. Excluded documents are shown separately. Not reduced for TDS.',
  portal_gst: 'GST on GSTR-2B documents in the selected scope that this phase can match (B2B, B2BA, B2B credit/debit notes and their amendments). Sections that are only imported (ISD, imports, ECO, Rule 37A) are listed under Excluded. Credit notes are negative. This is the portal\'s statement, not an eligibility decision.',
  matched: 'Rows whose status is "Exact matched" or "Matched within approved tolerance" — by a rule or by a reviewer\'s link. A suggested match is NOT counted until a reviewer approves it.',
  doc_rate_books: 'Matched Books documents ÷ all matchable Books documents in scope (matched + suggested + mismatched + Books-only).',
  tax_rate_books: 'GST on matched Books documents ÷ GST on all matchable Books documents in scope.',
  doc_rate_portal: 'Matched GSTR-2B documents ÷ all matchable GSTR-2B documents in scope (matched + suggested + mismatched + GSTR-2B-only).',
  exposure: 'Potential credit exposure = GST on Books documents (not credit notes, not reverse charge) that are NOT in GSTR-2B. It is unresolved, not lost: the supplier may still report it. It is split into confirmed time-barred (past the Section 16(4) deadline), closing soon, and still open. Mismatched documents add the shortfall where GSTR-2B shows less GST than Books.',
  pending_review: 'Suggested and mismatched rows, plus rows flagged ambiguous, duplicate, wrong supplier / recipient GSTIN or number collision, that are not yet marked Accepted or Resolved.',
  follow_up: 'Suppliers with at least one Books-only, mismatched or suggested document in scope.',
  assigned_to_me: 'Rows whose owner is you and that are still open: mismatched, suggested, Books-only or GSTR-2B-only, and not marked Accepted or Resolved. A row that has become matched is no longer open.',
  overdue: 'Open rows — anyone\'s, or without an owner — whose due date has passed (India time). A row stops counting when it becomes matched or is marked Accepted or Resolved.',
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = p => (/^\d{4}-\d{2}$/.test(p || '') ? `${MONTH_NAMES[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}` : '');
const dayLabel = iso => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? `${+iso.slice(8, 10)} ${MONTH_NAMES[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : iso);
const gst = a => (a ? (a.igst || 0) + (a.cgst || 0) + (a.cess || 0) + (a.sgst || 0) : 0);
const sgn = r => (r.doc_type === 'CRN' ? -1 : 1);
const sumSide = (views, sign) => views.reduce((a, v) => { for (const c of COMPONENTS) a[c] += sign * ((v.amounts && v.amounts[c]) || 0); return a; }, zeroAmounts());
const MATCHED = new Set(['exact', 'tolerance']);
const ATTENTION_FLAGS = ['ambiguous', 'duplicate_suspected', 'wrong_supplier_gstin', 'wrong_recipient_gstin', 'normalization_collision'];

/**
 * Filter rows by scope. `f` comes from the query string; `reviewDoc` supplies owner / workflow / due date. `who` = { me, users, today }:
 * the user asking (for "my rows"), the dashboard's users (an owner is a user) and today's date in India (for "overdue").
 */
function filterRows(rows, f = {}, reviewDoc = null, anchorOf = r => r.books_ids[0] || r.portal_ids[0], who = {}) {
  const list = v => (v === undefined || v === null || v === '' ? null : (Array.isArray(v) ? v : String(v).split(',')).filter(Boolean));
  const gstins = list(f.gstin), status = list(f.status), flags = list(f.flag), types = list(f.doc_type), months = list(f.month);
  const basis = ['record', 'books', 'portal', 'invoice'].includes(f.basis) ? f.basis : 'record';
  const q = f.q ? String(f.q).trim().toLowerCase() : '';
  const meta = (reviewDoc && reviewDoc.meta) || {};
  const today = who.today || N.todayIST();
  const openOnly = !!f.open && f.open !== '0' && f.open !== 'false';
  return rows.filter(r => {
    if (gstins && !gstins.includes(r.recipient_gstin)) return false;
    if (f.queue === 'books_only' && r.status !== 'books_only') return false;
    if (f.queue === 'portal_only' && r.status !== 'portal_only') return false;
    if (f.queue === 'excluded' && r.status !== 'excluded') return false;
    // "Mismatch and duplicate review": mismatched and suggested pairs, plus anything flagged as a duplicate or an identity problem
    if (f.queue === 'review' && !(r.status === 'mismatched' || r.status === 'suggested' || r.flags.includes('duplicate_possible') || ATTENTION_FLAGS.some(x => r.flags.includes(x)))) return false;
    if (status && !status.includes(r.status)) return false;
    if (types && !types.includes(r.doc_type)) return false;
    if (flags && !flags.some(x => r.flags.includes(x))) return false;
    if (f.branch) { const b = r.b[0]; if (f.branch === '__unallocated__' ? !!b : !b || b.branch_id !== f.branch) return false; }
    if (f.vendor) { const v = String(f.vendor).toLowerCase(); if (r.supplier_gstin.toLowerCase() !== v && !r.supplier_name.toLowerCase().includes(v)) return false; }
    if (f.project) { const p = String(f.project); if (!r.b.some(v => (v.projects || []).includes(p))) return false; }
    const per = r.periods && r.periods[basis];
    if (f.fy || f.quarter || f.half || f.from || f.to || months) {
      if (!per) return false;
      if (f.fy && N.fyLabel(`${per}-01`) !== f.fy) return false;
      if (f.quarter && N.quarterOf(per) !== f.quarter) return false;
      if (f.half && N.halfOf(per) !== f.half) return false;
      if (f.from && per < f.from) return false;
      if (f.to && per > f.to) return false;
      if (months && !months.includes(per)) return false;
    }
    if (f.owner || f.workflow || openOnly || f.due) {
      const m = meta[anchorOf(r)] || {};
      if (f.owner && !T.ownerMatches(m, f.owner, who)) return false;
      if (f.workflow && (f.workflow === '__none__' ? !!m.workflow : (m.workflow || '') !== f.workflow)) return false;
      if (openOnly && !T.isOpen(r, m)) return false;
      if (f.due && !T.dueMatches(r, m, f.due, today)) return false;
    }
    if (q) {
      const hay = [r.supplier_gstin, r.supplier_name, ...r.b.map(v => v.no), ...r.p.map(v => v.no), ...r.b.map(v => v.supplier), ...r.b.map(v => v.branch)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** The cards. `regOf(gstin)` returns the registration config (for GSTR-9 dates); `me` is the user asking (for "assigned to me"). */
function summarize(rows, { regOf = () => null, today = N.todayIST(), soonDays = 60, reviewDoc = null, me = null } = {}) {
  const by = {};
  for (const s of Object.keys(STATUS)) by[s] = { rows: 0, books_docs: 0, portal_docs: 0, books: zeroAmounts(), portal: zeroAmounts() };
  for (const r of rows) {
    const x = by[r.status];
    x.rows++; x.books_docs += r.b.length; x.portal_docs += r.p.length;
    x.books = addAmounts(x.books, sumSide(r.b, sgn(r))); x.portal = addAmounts(x.portal, sumSide(r.p, sgn(r)));
  }
  const live = ['exact', 'tolerance', 'suggested', 'mismatched', 'books_only', 'portal_only'];
  const bSide = s => live.reduce((a, k) => a + (s === 'docs' ? by[k].books_docs : gst(by[k].books)), 0);
  const pSide = s => live.reduce((a, k) => a + (s === 'docs' ? by[k].portal_docs : gst(by[k].portal)), 0);
  const matchedB = MATCHED_SUM(by, 'books_docs'), matchedP = MATCHED_SUM(by, 'portal_docs');
  const matchedBg = gst(addAmounts(by.exact.books, by.tolerance.books)), matchedPg = gst(addAmounts(by.exact.portal, by.tolerance.portal));
  const rate = (a, b) => (b ? a / b : null);

  // ── exposure: Books-only GST that is neither credit note nor reverse charge, by Section 16(4) deadline ──
  const ex = { books_only_gst: 0, time_barred_gst: 0, closing_soon_gst: 0, open_gst: 0, rcm_books_only_gst: 0, credit_note_books_only_gst: 0, zero_tax_docs: 0, docs: 0, by_deadline: {}, mismatch_shortfall_gst: 0, suggested_gst: 0, soon_days: soonDays };
  for (const r of rows) {
    if (r.status === 'books_only') {
      const v = r.b[0], g = gst(v.amounts);
      if (r.doc_type === 'CRN') { ex.credit_note_books_only_gst -= g; continue; }                 // credit notes are negative everywhere
      if (v.rcm) { ex.rcm_books_only_gst += g; continue; }
      if (!g) { ex.zero_tax_docs++; continue; }
      const dl = claimDeadline(v.date, regOf(r.recipient_gstin));
      const cls = exposureClass(dl && dl.deadline, today, soonDays);
      ex.books_only_gst += g; ex.docs++;
      ex[`${cls}_gst`] += g;
      const k = dl.deadline;
      const e = (ex.by_deadline[k] = ex.by_deadline[k] || { deadline: k, fy: dl.fy, basis: dl.basis, text: dl.text, class: cls, days_left: N.daysBetween(today, k), docs: 0, gst: 0 });
      e.docs++; e.gst += g;
    } else if (r.status === 'mismatched' && r.doc_type !== 'CRN') {
      const short = gst(sumSide(r.b, 1)) - gst(sumSide(r.p, 1));
      if (short > 0) ex.mismatch_shortfall_gst += short;
    } else if (r.status === 'suggested') ex.suggested_gst += gst(sumSide(r.b, sgn(r)));
  }
  ex.by_deadline = Object.values(ex.by_deadline).sort((a, b) => a.deadline.localeCompare(b.deadline));

  const meta = (reviewDoc && reviewDoc.meta) || {};
  const anchor = r => r.books_ids[0] || r.portal_ids[0];
  const pending = rows.filter(r => {
    if (!(r.status === 'suggested' || r.status === 'mismatched' || ATTENTION_FLAGS.some(f => r.flags.includes(f)))) return false;
    const w = (meta[anchor(r)] || {}).workflow;
    return w !== 'resolved' && w !== 'accepted';
  }).length;
  const flagCounts = {};
  for (const r of rows) for (const f of r.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
  const vendorsWithIssues = new Set(rows.filter(r => ['books_only', 'mismatched', 'suggested', 'portal_only'].includes(r.status)).map(r => r.supplier_gstin || r.supplier_name)).size;
  const followupOpen = rows.filter(r => { const w = (meta[anchor(r)] || {}).workflow; return w === 'vendor_followup' || w === 'waiting_vendor'; }).length;
  // assignments: open rows by owner and by due date (lib/tasks.js holds the definitions)
  const tasks = { mine: { open: 0, overdue: 0, today: 0 }, all: { open: 0, overdue: 0, today: 0 } };
  for (const r of rows) {
    const m = meta[anchor(r)] || {};
    if (!T.isOpen(r, m)) continue;
    const state = T.dueOf(r, m, today).state, mine = T.ownedBy(m, me);
    if (m.owner) tasks.all.open++;
    if (mine) tasks.mine.open++;
    if (state === 'overdue' || state === 'today') { tasks.all[state]++; if (mine) tasks.mine[state]++; }
  }
  const excluded = {};
  for (const r of rows.filter(r => r.status === 'excluded')) {
    const text = r.exclusion.text.replace(/^Excluded by .*?: /, '');
    const k = `${r.exclusion.code}|${text}`;                    // one line per distinct reason (ISD and imports are both "unsupported section")
    const e = (excluded[k] = excluded[k] || { code: r.exclusion.code, text, books_docs: 0, portal_docs: 0, books_gst: 0, portal_gst: 0 });
    e.books_docs += r.b.length; e.portal_docs += r.p.length; e.books_gst += gst(sumSide(r.b, sgn(r))); e.portal_gst += gst(sumSide(r.p, sgn(r)));
  }
  return {
    rows: rows.length, by_status: by,
    books: { docs: bSide('docs'), gst: bSide('gst'), amounts: live.reduce((a, k) => addAmounts(a, by[k].books), zeroAmounts()) },
    portal: { docs: pSide('docs'), gst: pSide('gst'), amounts: live.reduce((a, k) => addAmounts(a, by[k].portal), zeroAmounts()) },
    matched: { rows: by.exact.rows + by.tolerance.rows, books_docs: matchedB, portal_docs: matchedP, books_gst: matchedBg, portal_gst: matchedPg },
    rates: { doc_books: rate(matchedB, bSide('docs')), tax_books: rate(matchedBg, bSide('gst')), doc_portal: rate(matchedP, pSide('docs')) },
    exposure: ex, pending_review: pending, follow_up: { vendors_with_issues: vendorsWithIssues, open_followups: followupOpen }, tasks,
    excluded: Object.values(excluded), flags: flagCounts, definitions: DEFINITIONS,
    phase2: ['Proposed eligible ITC', 'Deferred ITC', 'Ineligible ITC', 'Claimed', 'Reversed', 'Reclaimed'],
  };
}
function MATCHED_SUM(by, key) { return by.exact[key] + by.tolerance[key]; }

/** Per supplier: what is open, how often, how late */
function vendors(rows) {
  const m = new Map();
  for (const r of rows) {
    if (r.status === 'excluded') continue;
    const key = r.supplier_gstin || `name:${r.supplier_name}`;
    const v = m.get(key) || { gstin: r.supplier_gstin, name: r.supplier_name, pan: r.supplier_gstin ? r.supplier_gstin.slice(2, 12) : '', rows: 0, matched: 0, suggested: 0, mismatched: 0, books_only: 0, portal_only: 0,
      books_only_gst: 0, mismatch_gst: 0, portal_only_gst: 0, months: new Set(), late: 0, delay_sum: 0, delay_n: 0, last_filing: null, invalid_gstin: false, wrong_gstin: false, duplicates: 0 };
    v.rows++;
    if (!v.name && r.supplier_name) v.name = r.supplier_name;
    if (MATCHED.has(r.status)) v.matched++; else v[r.status]++;
    const g = gst(sumSide(r.b, sgn(r))), pg = gst(sumSide(r.p, sgn(r)));
    if (r.status === 'books_only') v.books_only_gst += g;
    if (r.status === 'mismatched') v.mismatch_gst += Math.abs(g - pg);
    if (r.status === 'portal_only') v.portal_only_gst += pg;
    if (['books_only', 'mismatched', 'suggested', 'portal_only'].includes(r.status) && r.periods.record) v.months.add(r.periods.record);
    if (r.flags.includes('late_reporting')) v.late++;
    if (r.flags.includes('invalid_gstin')) v.invalid_gstin = true;
    if (r.flags.includes('wrong_supplier_gstin')) v.wrong_gstin = true;
    if (r.flags.includes('duplicate_suspected')) v.duplicates++;
    if (r.b[0] && r.p[0] && r.p[0].period && (r.b[0].date)) { const d = N.monthIndex(r.p[0].period) - N.monthIndex(r.b[0].date.slice(0, 7)); v.delay_sum += d; v.delay_n++; }
    for (const p of r.p) if (p.filing_period || p.filing_date) { const fd = p.filing_date || ''; if (!v.last_filing || fd > (v.last_filing.date || '')) v.last_filing = { period: p.filing_period, date: p.filing_date, as_of: p.period }; }
    m.set(key, v);
  }
  return [...m.values()].map(v => ({
    ...v, months: [...v.months].sort(), recurring_months: v.months.size, avg_delay_months: v.delay_n ? Math.round((v.delay_sum / v.delay_n) * 10) / 10 : null,
    discrepancy_rows: v.suggested + v.mismatched + v.books_only + v.portal_only, gst_at_stake: v.books_only_gst + v.mismatch_gst + v.portal_only_gst,
    // Supplier filing status is shown only where a verified source states it, with its period and date; otherwise "Unknown".
    filing_status: v.last_filing ? { known: true, text: `Reported in GSTR-1/IFF for ${monthLabel(N.rtnprdToPeriod(v.last_filing.period)) || v.last_filing.period || '—'}${v.last_filing.date ? `, filed ${dayLabel(v.last_filing.date)}` : ''}`, source: `GSTR-2B ${monthLabel(v.last_filing.as_of) || v.last_filing.as_of}` } : { known: false, text: 'Unknown', source: null },
  })).sort((a, b) => b.gst_at_stake - a.gst_at_stake || b.discrepancy_rows - a.discrepancy_rows);
}

/** Control totals: Books and GSTR-2B tie out per component, independently; exclusions listed apart */
function bridge(rows) {
  const out = { components: {}, excluded: {}, ties: true };
  const parts = ['exact', 'tolerance', 'suggested', 'mismatched'];
  for (const c of [...COMPONENTS, 'gst']) {
    const val = (r, side) => { const v = sumSide(side === 'b' ? r.b : r.p, sgn(r)); return c === 'gst' ? gst(v) : v[c]; };
    const t = { books_total: 0, matched_books: 0, suggested_books: 0, mismatched_books: 0, books_only: 0, portal_total: 0, matched_portal: 0, suggested_portal: 0, mismatched_portal: 0, portal_only: 0 };
    for (const r of rows) {
      if (r.status === 'excluded') continue;
      const b = val(r, 'b'), p = val(r, 'p');
      t.books_total += b; t.portal_total += p;
      if (r.status === 'exact' || r.status === 'tolerance') { t.matched_books += b; t.matched_portal += p; }
      else if (r.status === 'suggested') { t.suggested_books += b; t.suggested_portal += p; }
      else if (r.status === 'mismatched') { t.mismatched_books += b; t.mismatched_portal += p; }
      else if (r.status === 'books_only') t.books_only += b;
      else if (r.status === 'portal_only') t.portal_only += p;
    }
    t.difference = t.books_total - t.portal_total;
    t.explained = (t.matched_books - t.matched_portal) + (t.suggested_books - t.suggested_portal) + (t.mismatched_books - t.mismatched_portal) + t.books_only - t.portal_only;
    t.ties = t.difference === t.explained && t.books_total === t.matched_books + t.suggested_books + t.mismatched_books + t.books_only && t.portal_total === t.matched_portal + t.suggested_portal + t.mismatched_portal + t.portal_only;
    if (!t.ties) out.ties = false;
    out.components[c] = t;
  }
  for (const r of rows.filter(r => r.status === 'excluded')) {
    const text = r.exclusion.text.replace(/^Excluded by .*?: /, '');
    const k = `${r.exclusion.code}|${text}`;
    const e = (out.excluded[k] = out.excluded[k] || { code: r.exclusion.code, text, books_docs: 0, portal_docs: 0, books: zeroAmounts(), portal: zeroAmounts() });
    e.books_docs += r.b.length; e.portal_docs += r.p.length; e.books = addAmounts(e.books, sumSide(r.b, sgn(r))); e.portal = addAmounts(e.portal, sumSide(r.p, sgn(r)));
  }
  out.excluded = Object.values(out.excluded);
  return out;
}

/** Distinct values for the filter drop-downs */
function options(rows) {
  const vendors = new Map(), branches = new Map(), projects = new Set(), owners = new Set(), fys = new Set(), months = new Set();
  for (const r of rows) {
    if (r.supplier_gstin || r.supplier_name) vendors.set(r.supplier_gstin || r.supplier_name, r.supplier_name || r.supplier_gstin);
    if (r.b[0]) branches.set(r.b[0].branch_id, r.b[0].branch);
    for (const v of r.b) (v.projects || []).forEach(p => projects.add(p));
    const per = r.periods && r.periods.record;
    if (per) { months.add(per); fys.add(N.fyLabel(`${per}-01`)); }
  }
  return {
    vendors: [...vendors.entries()].map(([k, name]) => ({ key: k, name })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 1500),
    branches: [...branches.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)), projects: [...projects].sort(),
    fys: [...fys].sort().reverse(), months: [...months].sort().reverse(),
  };
}

module.exports = { DEFINITIONS, filterRows, summarize, vendors, bridge, options, gst, sumSide, ATTENTION_FLAGS };
