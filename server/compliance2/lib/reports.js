/**
 * Reports & analytics (V7) and Tax trends (V9) — computed on the server from the stored records, so the chart, the table and
 * the CSV export are the same numbers.
 *
 * Payment dataset = payment register (lib/payments.js, every section except TDS) + TDS section allocations (lib/tds.js,
 * principal / surcharge / cess only — the TDS interest and fees stay on the challan and are reported as "not captured").
 * Each challan's cash is therefore counted once, and generic task "amount paid" fields are never added.
 *   • illustrative (demo seed) rows and recorded rows are separate datasets and never mixed;
 *   • a month with no rows is "no recorded payment" (null), never a confirmed nil;
 *   • basis: payment month (actual payment date) or liability month (the period the payment is for).
 */

'use strict';

const U = require('./util');
const P = require('./payments');
const R = require('./recon');

const SECTIONS = P.SECTIONS;
const r2 = n => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const monthsOf = fy => Array.from({ length: 12 }, (_, i) => { const [y, m] = U.addMonths(U.fyStartYear(fy), 4, i); return `${y}-${String(m).padStart(2, '0')}`; });
const addMonth = (ym, n) => { const [y, m] = U.addMonths(+ym.slice(0, 4), +ym.slice(5, 7), n); return `${y}-${String(m).padStart(2, '0')}`; };

/** Normalised payment rows */
function dataset({ payments, tds, org, illustrative }) {
  const regLabel = id => { const r = org.registrations.find(x => x.id === id); return r ? r.number : ''; };
  const rows = [];
  for (const p of payments.payments) {
    if (!!p.illustrative !== !!illustrative) continue;
    rows.push({ id: p.id, source: 'payment', entity_id: p.entity_id, registration_id: p.registration_id, registration: regLabel(p.registration_id), section: p.section, liability_month: p.liability_month, paid_date: p.paid_date,
      reference: p.reference, principal: p.principal, interest: p.interest, fee: p.fee, charges_known: true, code: '', alias: '', act: '', evidence: p.evidence, reversal_of: p.reversal_of, status: p.status, components: p.components, pt_type: p.pt_type });
  }
  for (const a of tds.allocations) {
    if (a.status !== 'active') continue;
    const ch = tds.challans.find(c => c.id === a.challan_id);
    if (!ch || ch.status === 'reversed' || !!ch.illustrative !== !!illustrative) continue;
    rows.push({ id: a.id, source: 'tds_allocation', challan_id: ch.id, entity_id: a.entity_id, registration_id: a.registration_id, registration: a.tan, section: 'TDS', liability_month: a.liability_month, paid_date: ch.paid_date,
      reference: `${ch.bsr_code}/${ch.challan_serial}/${ch.paid_date}`, principal: r2(a.principal + a.surcharge + a.cess), interest: null, fee: null, charges_known: false, code: a.section_code, alias: a.legacy_ref, act: a.act, evidence: ch.evidence, mapping: a.mapping, status: 'recorded' });
  }
  return rows;
}

const total = r => r2((r.principal || 0) + (r.interest || 0) + (r.fee || 0));
const monthOf = (r, basis) => (basis === 'liability' ? r.liability_month : r.paid_date.slice(0, 7));

function filterRows(rows, f, visible) {
  const months = f.fy ? monthsOf(f.fy) : null;
  return rows.filter(r => visible(r.entity_id) && (!f.entity_ids?.length || f.entity_ids.includes(r.entity_id)) && (!f.registration_ids?.length || f.registration_ids.includes(r.registration_id))
    && (!f.section || r.section === f.section) && (!months || months.includes(monthOf(r, f.basis))) && (!f.month || monthOf(r, f.basis) === f.month));
}

function groupSum(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = key(r); const g = m.get(k) || m.set(k, { key: k, principal: 0, charges: 0, charges_unknown: 0, total: 0, rows: 0 }).get(k); g.principal += r.principal || 0; if (r.charges_known) g.charges += (r.interest || 0) + (r.fee || 0); else g.charges_unknown += 1; g.total += total(r); g.rows += 1; }
  return [...m.values()].map(g => ({ ...g, principal: r2(g.principal), charges: r2(g.charges), total: r2(g.total) })).sort((a, b) => b.total - a.total);
}

/** The payment pages: Monthly payments, Company comparison, Section analysis, Payment register */
function payments(rows, f, { entities }) {
  const name = id => entities.find(e => e.id === id)?.short_code || id;
  const months = (f.fy ? monthsOf(f.fy) : U.uniq(rows.map(r => monthOf(r, f.basis))).sort()).filter(m => !f.month || m === f.month);
  const secs = SECTIONS.filter(s => !f.section || s === f.section);
  const matrix = months.map(m => {
    const rs = rows.filter(r => monthOf(r, f.basis) === m);
    const cells = Object.fromEntries(secs.map(s => { const t = rs.filter(r => r.section === s); return [s, t.length ? r2(t.reduce((a, r) => a + total(r), 0)) : null]; }));
    return { month: m, cells, total: rs.length ? r2(rs.reduce((a, r) => a + total(r), 0)) : null, principal: rs.length ? r2(rs.reduce((a, r) => a + (r.principal || 0), 0)) : null, rows: rs.length };
  });
  const principal = r2(rows.reduce((a, r) => a + (r.principal || 0), 0));
  const charges = r2(rows.filter(r => r.charges_known).reduce((a, r) => a + (r.interest || 0) + (r.fee || 0), 0));
  return {
    kpis: { recorded_total: r2(principal + charges), principal, charges, charges_unknown_rows: rows.filter(r => !r.charges_known).length, references: new Set(rows.map(r => `${r.entity_id}|${r.section}|${r.registration_id}|${r.source === 'tds_allocation' ? r.challan_id : r.reference}`)).size, rows: rows.length },
    sections: secs, matrix,
    by_company: groupSum(rows, r => name(r.entity_id)), by_section: groupSum(rows, r => r.section), by_registration: groupSum(rows, r => `${name(r.entity_id)} / ${r.registration || '—'}`),
    tds_by_code: groupSum(rows.filter(r => r.section === 'TDS'), r => `${r.act === '2025' ? '2025 Act' : '1961 Act'} · ${r.code}${r.alias && r.alias !== r.code ? ` · ${r.alias}` : ''}`),
    charges_by_section: groupSum(rows.filter(r => r.charges_known).map(r => ({ ...r, principal: 0 })), r => r.section).map(g => ({ ...g, total: g.charges })),
    register: rows.slice().sort((a, b) => a.paid_date.localeCompare(b.paid_date)).map(r => ({ ...r, company: name(r.entity_id), total: total(r) })),
  };
}

// ── Task-based pages ──────────────────────────────────────────────────────────
function tasks(list, { today, docsByTask, categories }) {
  const done = list.filter(t => t.status === 'completed');
  const late = list.filter(t => t.overdue);
  const unscheduled = list.filter(t => !t.effective_due);
  const end30 = U.addDays(today, 30);
  const filed = list.filter(t => ['completed', 'filed_awaiting_verification'].includes(t.status));
  const realDoc = t => (docsByTask.get(t.id) || []).some(d => d.status === 'active' && !d.sample);
  const noEvidence = filed.filter(t => !realDoc(t)), noAck = filed.filter(t => t.nature !== 'payment' && t.nature !== 'internal' && !t.filing?.ack_no), noDate = filed.filter(t => !t.filing?.filed_at);
  const statuses = U.uniq(list.map(t => t.status_label));
  const age = t => t.days_overdue;
  const owners = U.uniq(list.map(t => t.owner_name || 'Unassigned'));
  const ids = a => a.map(t => t.id);
  return {
    kpis: { total: list.length, completed: done.length, completion_pct: list.length ? Math.round((done.length / list.length) * 1000) / 10 : null, overdue: late.length, unscheduled: unscheduled.length },
    status: statuses.map(s => ({ key: s, count: list.filter(t => t.status_label === s).length })),
    timeliness: [{ key: 'On / before due date', count: done.filter(t => t.on_time).length }, { key: 'After due date', count: done.filter(t => t.filed_late).length }, { key: 'Date unavailable', count: done.filter(t => !t.on_time && !t.filed_late).length }],
    by_category: categories.map(c => { const rs = list.filter(t => t.category === c); const n = rs.filter(t => t.status === 'completed').length; return { key: c, tracked: rs.length, completed: n, open: rs.length - n, completion: rs.length ? Math.round((n / rs.length) * 1000) / 10 : null }; }),
    ageing: [['1–7 days', t => age(t) <= 7], ['8–30 days', t => age(t) > 7 && age(t) <= 30], ['31–60 days', t => age(t) > 30 && age(t) <= 60], ['61+ days', t => age(t) > 60]].map(([k, f]) => ({ key: k, count: late.filter(f).length })),
    overdue_ids: ids(late), upcoming_ids: ids(list.filter(t => t.status !== 'completed' && t.effective_due && t.effective_due >= today && t.effective_due <= end30)), unscheduled_ids: ids(unscheduled), window: { from: today, to: end30 },
    exceptions: [{ key: 'Filed / closed: missing real evidence', count: noEvidence.length }, { key: 'Filed / closed: missing acknowledgement', count: noAck.length }, { key: 'Filed / closed: missing filing date', count: noDate.length }, { key: 'No due date (unscheduled)', count: unscheduled.length }],
    exception_ids: ids(list.filter(t => noEvidence.includes(t) || noAck.includes(t) || noDate.includes(t))),
    owners: owners.map(o => { const rs = list.filter(t => (t.owner_name || 'Unassigned') === o); return { key: o, total: rs.length, open: rs.filter(t => t.status !== 'completed').length, overdue: rs.filter(t => t.overdue).length, review: rs.filter(t => ['ready_for_review', 'filed_awaiting_verification'].includes(t.status)).length, completed: rs.filter(t => t.status === 'completed').length }; }).sort((a, b) => b.open - a.open),
  };
}

// ── Reconciliation pages ──────────────────────────────────────────────────────
const RECON_PAGES = { gst13b: 'GST', vendor: 'VENDOR', gstcash: 'GST', pf: 'PF', esic: 'ESIC', tdsliab: 'TDS', pt: 'PT' };

function recon(page, records, f, { tdsDoc, visible }) {
  const type = RECON_PAGES[page];
  const months = f.fy ? monthsOf(f.fy) : null;
  const rs = records.filter(r => r.type === type && !!r.illustrative === !!f.illustrative && visible(r.entity_id) && (!f.entity_ids?.length || f.entity_ids.includes(r.entity_id)) && (!f.registration_ids?.length || f.registration_ids.includes(r.registration_id))
    && (!months || months.includes(r.month)) && (!f.month || r.month === f.month) && (!f.status || r.status === f.status));
  const withCalc = rs.map(r => ({ id: r.id, entity_id: r.entity_id, registration_id: r.registration_id, registration: r.registration_number, month: r.month, status: r.status, prepared_by: r.prepared_by, reviewed_by: r.reviewed_by, evidence: r.evidence.length, missing: R.missing(r), version: r.version, values: r.values, rows: r.rows, notes: r.notes, calc: R.calc(r, { tdsDoc }) }));
  const out = { type, kpis: { records: rs.length, reviewed: rs.filter(r => r.status === 'reviewed').length, missing: withCalc.filter(r => r.missing.length).length, with_evidence: rs.filter(r => r.evidence.length).length }, records: withCalc };
  if (page === 'gst13b') out.chart = withCalc.filter(r => r.calc).map(r => ({ key: `${r.registration} · ${r.month}`, value: r2(r.calc.absVariance) }));
  if (page === 'gstcash') {
    const valid = withCalc.filter(r => r.calc);
    out.months = (months || U.uniq(valid.map(r => r.month)).sort()).filter(m => !f.month || m === f.month).map(m => { const v = valid.filter(x => x.month === m); return { month: m, cash: v.length ? r2(v.reduce((s, z) => s + z.calc.cash, 0)) : null, credit: v.length ? r2(v.reduce((s, z) => s + z.calc.credit, 0)) : null, records: v.length }; });
    out.mix = valid.map(r => ({ id: r.id, key: `${r.registration} · ${r.month}`, liability: r.calc.liability, cash: r.calc.cash, credit: r.calc.credit, cash_pct: r.calc.total ? Math.round((1000 * r.calc.cash) / r.calc.total) / 10 : null, credit_pct: r.calc.total ? Math.round((1000 * r.calc.credit) / r.calc.total) / 10 : null, gap: r.calc.settlementGap }));
  }
  if (page === 'vendor') out.scorecard = R.vendor(rs);
  if (page === 'pf') out.chart = withCalc.filter(r => !r.missing.length).map(r => ({ key: `${r.registration} · ${r.month}`, value: r2(r.calc.absContribution) }));
  if (page === 'esic') out.chart = withCalc.filter(r => [r.calc.pEE, r.calc.pER, r.calc.challanEE, r.calc.challanER].every(x => x !== null)).map(r => ({ key: `${r.registration} · ${r.month}`, value: r2(Math.abs(r.calc.pEE - r.calc.challanEE) + Math.abs(r.calc.pER - r.calc.challanER)) }));
  if (page === 'pt') out.chart = withCalc.filter(r => r.calc.assessed !== null && r.calc.paid !== null).map(r => ({ key: `${r.registration} · ${r.month}`, value: r2(Math.abs(r.calc.assessed - r.calc.paid)) }));
  if (page === 'tdsliab') out.lines = withCalc.flatMap(r => r.calc.lines.map(l => ({ record_id: r.id, entity_id: r.entity_id, tan: r.registration, month: r.month, status: r.status, ...l })));
  return out;
}

// ── Trends (V9) ───────────────────────────────────────────────────────────────
/**
 * Month-on-month (vs the immediately preceding month — March for April) or quarter-on-quarter (FY Q1 vs the prior FY's Q4).
 * Quarter amounts are sums of the underlying rows; % = change / prior × 100 from those sums. A prior of zero → % not
 * applicable; a period with a missing month, a period in progress or a future period is not compared.
 */
function trends(allRows, f, { today, visible }) {
  const metric = ['principal', 'total', 'charges'].includes(f.metric) ? f.metric : 'principal';
  const quarterly = f.period === 'quarterly';
  const start = `${U.fyStartYear(f.fy)}-04`;
  const step = quarterly ? 3 : 1;
  const periods = Array.from({ length: quarterly ? 4 : 12 }, (_, i) => { const m0 = addMonth(start, i * step); return { key: m0, label: quarterly ? `Q${i + 1}` : m0, months: Array.from({ length: step }, (_, j) => addMonth(m0, j)) }; });
  const base = allRows.filter(r => visible(r.entity_id) && (!f.entity_ids?.length || f.entity_ids.includes(r.entity_id)) && (!f.registration_ids?.length || f.registration_ids.includes(r.registration_id)));
  const cur = today.slice(0, 7);
  const valueOf = r => (metric === 'charges' ? (r.interest || 0) + (r.fee || 0) : metric === 'total' ? total(r) : r.principal || 0);
  const bucket = (p, section) => {
    const rs = base.filter(r => (!section || r.section === section) && p.months.includes(monthOf(r, f.basis)));
    const observed = new Set(rs.map(r => monthOf(r, f.basis)));
    const future = p.months[0] > cur;
    // on the liability basis a month's payments fall due in the following month(s): the month just ended is still open
    const partial = !future && (f.basis === 'liability' ? addMonth(p.months[p.months.length - 1], 1) >= cur : p.months[p.months.length - 1] >= cur);
    const unavailable = metric !== 'principal' && rs.some(r => !r.charges_known);
    return { key: p.key, months: p.months, rows: rs.length, value: rs.length && !unavailable ? r2(rs.reduce((s, r) => s + valueOf(r), 0)) : null, observed: observed.size, future, partial, unavailable,
      complete: observed.size === p.months.length && !partial && !future && !unavailable,
      state: unavailable ? 'TDS charges not captured' : future ? 'Future period' : partial ? 'Period in progress' : !rs.length ? 'No recorded data' : observed.size < p.months.length ? `${observed.size}/${p.months.length} months recorded` : 'Recorded-data comparison' };
  };
  const prevOf = p => { const s = addMonth(p.months[0], -p.months.length); return { key: s, months: Array.from({ length: p.months.length }, (_, i) => addMonth(s, i)) }; };
  const change = (c, p) => {
    if (!c.complete || !p.complete || c.value === null || p.value === null) return { delta: null, pct: null, label: 'Not comparable' };
    const delta = r2(c.value - p.value);
    if (p.value === 0) return { delta, pct: null, label: c.value === 0 ? 'Both zero · % not applicable' : 'Zero baseline · % not applicable' };
    return { delta, pct: Math.round((1000 * delta) / p.value) / 10, label: 'Provisional' };
  };
  const series = section => periods.map(p => { const c = bucket(p, section), pr = bucket(prevOf(p), section); return { label: p.label, current: c, prior: pr, change: change(c, pr) }; });
  const overall = series(f.section || null);
  const last = [...overall].reverse().find(s => s.current.complete) || null;
  return { metric, period: quarterly ? 'quarterly' : 'monthly', basis: f.basis, series: overall, latest: last,
    sections: SECTIONS.map(s => ({ section: s, series: series(s) })).filter(x => x.series.some(s => s.current.rows)),
    note: 'Recorded payments attributed to a liability month are not assessed liability or tax expense. GST cash deposits are not full GST liability or ITC utilisation. TDS principal allocations exclude unrecorded charges. Growth figures are provisional: completeness and same-entity / GSTIN populations are not certified.' };
}

module.exports = { SECTIONS, RECON_PAGES, monthsOf, addMonth, dataset, filterRows, payments, tasks, recon, trends, total };
