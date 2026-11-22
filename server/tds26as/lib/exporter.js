/**
 * Excel export — built from the same objects the screens show (lib/reports.js), so a figure cannot differ between the page and the
 * workbook. Amounts are numbers in rupees (#,##0.00), dates are Excel dates. Sheet sets: followup | transactions | corrections |
 * carryforward | all.
 */

'use strict';

const XLSX = require('xlsx');
const PER = require('./periods');
const { STATUS, METHOD } = require('./match');

const MONEY = '#,##0.00', DATE = 'dd-mmm-yyyy';
const rupees = p => (p === null || p === undefined ? null : Math.round(p) / 100);
const serial = iso => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000 : null);

function sheet(cols, rows) {
  const aoa = [cols.map(c => c[0])];
  for (const r of rows) aoa.push(cols.map(([, get, kind]) => {
    let v = get(r);
    if (kind === 'money') { v = rupees(v); return v === null ? '' : { t: 'n', v, z: MONEY }; }
    if (kind === 'date') { const s = serial(v); return s === null ? (v || '') : { t: 'n', v: s, z: DATE }; }
    return v === undefined || v === null ? '' : v;
  }));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = cols.map(c => ({ wch: Math.min(48, Math.max(10, String(c[0]).length + 2)) }));
  return ws;
}
const srcText = s => (s ? [s.file, s.sheet ? `sheet ${s.sheet}` : '', s.page ? `page ${s.page}` : '', s.line ? `line ${s.line}` : '', s.row ? `row ${s.row}` : ''].filter(Boolean).join(', ') : '');

function followupSheet(fu) {
  const cols = [
    ['Client', r => r.client], ['TAN(s)', r => r.tans.join(', ')], ['Period', r => r.period], ['TDS booked in Zoho', r => r.zoho, 'money'], ['Tax deducted per 26AS', r => r.deducted, 'money'],
    ['Tax deposited per 26AS', r => r.deposited, 'money'], ['Amount requiring follow-up', r => r.follow_up, 'money'], ['— credit missing from uploaded 26AS', r => r.missing, 'money'],
    ['— deducted exceeds deposited', r => r.ded_gt_dep, 'money'], ['— other short credit (difference)', r => r.short_credit, 'money'], ['— confirmed non-deposit', r => r.non_deposit, 'money'],
    ['Subsequent-period credit identified (check)', r => r.subsequent, 'money'], ['Needs review first', r => r.review_first, 'money'], ['Excess credit (not netted)', r => r.excess_credit, 'money'],
    ['Oldest open date', r => r.oldest_open, 'date'], ['Age (days)', r => r.age_days], ['Owner', r => r.owner], ['Remarks', r => r.remarks], ['Open items', r => r.open_units.length], ['Row type', r => ({ client: 'Client', unmapped_customer: 'Customer not mapped', unmapped_tan: 'Deductor not mapped', unallocated: 'Unallocated' })[r.kind] || r.kind],
  ];
  const ws = sheet(cols, [...fu.rows, { client: 'TOTAL', tans: [], period: '', ...fu.totals, oldest_open: '', age_days: '', owner: '', remarks: '', open_units: [], kind: '' }]);
  return ws;
}

function unitRows(units) {
  return units.map(u => ({ u,
    zno: u.zoho_lines.map(z => `${z.type_label} ${z.number || ''}`.trim()).join(' + '), inv: u.zoho_lines.flatMap(z => z.invoices.map(i => i.no)).join(', '),
    zdate: u.zoho_lines.map(z => z.date).sort()[0] || '', idate: u.zoho_lines.flatMap(z => z.invoices.map(i => i.date)).filter(Boolean).sort()[0] || '',
    pdate: u.zoho_lines.map(z => z.payment && z.payment.date).filter(Boolean).sort()[0] || '',
    basic: u.zoho_lines.length && u.zoho_lines.every(z => z.base && z.base.basic !== null && z.base.basic !== undefined) ? u.zoho_lines.reduce((a, z) => a + z.base.basic, 0) : null,
    comparable: u.zoho_lines.length && u.zoho_lines.every(z => z.base && z.base.comparable !== null && z.base.comparable !== undefined) ? u.zoho_lines.reduce((a, z) => a + z.base.comparable, 0) : null,
    ded: u.credit_lines.map(c => c.deductor).filter(Boolean)[0] || '', cdate: u.credit_lines.map(c => c.txn_date).filter(Boolean).sort()[0] || '', bdate: u.credit_lines.map(c => c.booking_date).filter(Boolean).sort()[0] || '',
    csec: [...new Set(u.credit_lines.map(c => c.section_raw))].join(', '), cstat: [...new Set(u.credit_lines.map(c => c.status))].join(', '), src: u.credit_lines.map(c => srcText(c.src)).join(' | ') }));
}

function transactionsSheet(units) {
  const cols = [
    ['Client', x => x.u.client], ['TAN(s)', x => x.u.tans.join(', ')], ['Section(s)', x => x.u.sections.join(', ')], ['Match method', x => METHOD[x.u.method]], ['System status', x => STATUS[x.u.status]],
    ['Final status', x => (x.u.final_status ? STATUS[x.u.final_status] : '')], ['Likely reason', x => (x.u.reason ? x.u.reason.text : '')], ['Responsibility (where established)', x => (x.u.reason && x.u.reason.responsibility) || ''],
    ['Zoho reference(s)', x => x.zno], ['Invoice(s)', x => x.inv], ['Zoho posting date', x => x.zdate, 'date'], ['Invoice date', x => x.idate, 'date'], ['Payment date', x => x.pdate, 'date'],
    ['Invoice basic value', x => x.basic, 'money'], ['Comparable base (Zoho)', x => x.comparable, 'money'], ['TDS receivable (Zoho)', x => (x.u.zoho.length ? x.u.z_amount : null), 'money'],
    ['Deductor (26AS)', x => x.ded], ['26AS transaction date', x => x.cdate, 'date'], ['26AS booking date', x => x.bdate, 'date'], ['26AS section', x => x.csec], ['Booking status', x => x.cstat],
    ['Amount paid / credited (26AS)', x => (x.u.credits.length ? x.u.paid : null), 'money'], ['Tax deducted (26AS)', x => (x.u.credits.length ? x.u.deducted : null), 'money'], ['Tax deposited (26AS)', x => (x.u.credits.length ? x.u.deposited : null), 'money'],
    ['TDS difference (Zoho − deposited)', x => x.u.diff, 'money'], ['Matched amount', x => x.u.matched_amount, 'money'], ['Open — Zoho side', x => x.u.open_zoho, 'money'], ['Open — 26AS side', x => x.u.open_26as, 'money'],
    ['Reviewer remarks', x => (x.u.decision ? x.u.decision.remarks : '')], ['Reviewed by', x => (x.u.decision ? x.u.decision.by : '')], ['Reviewed on', x => (x.u.decision ? String(x.u.decision.at).slice(0, 10) : ''), 'date'],
    ['26AS source (file, page / line / row)', x => x.src], ['Unit id', x => x.u.id],
  ];
  return sheet(cols, unitRows(units));
}

function linesSheet(units) {
  const rows = [];
  for (const u of units) {
    for (const z of u.zoho_lines) rows.push({ u, side: 'Zoho', ref: `${z.type_label} ${z.number || ''}`.trim(), party: z.customer, date: z.date, amount: z.amount, section: z.section, extra: z.invoices.map(i => `${i.no} (basic ${rupees(i.basic)})`).join('; '), url: z.url || '' });
    for (const c of u.credit_lines) rows.push({ u, side: '26AS', ref: `${c.tan} row ${c.src && (c.src.line || c.src.row || c.src.page) || ''}`, party: c.deductor, date: c.txn_date, amount: c.deposited, deducted: c.deducted, paid: c.amount_paid, section: c.section_raw, extra: `status ${c.status}${c.booking_date ? `, booked ${c.booking_date}` : ''}`, url: srcText(c.src) });
  }
  return sheet([['Unit id', r => r.u.id], ['Client', r => r.u.client], ['Side', r => r.side], ['Reference', r => r.ref], ['Customer / deductor', r => r.party], ['Date', r => r.date, 'date'], ['Section', r => r.section],
    ['Amount paid (26AS)', r => r.paid, 'money'], ['Tax deducted (26AS)', r => r.deducted, 'money'], ['TDS (Zoho) / deposited (26AS)', r => r.amount, 'money'], ['Detail', r => r.extra], ['Link / source', r => r.url],
    ['Match method', r => METHOD[r.u.method]], ['System status', r => STATUS[r.u.status]], ['Final status', r => (r.u.final_status ? STATUS[r.u.final_status] : '')]], rows);
}

function correctionsSheet(cr) {
  return sheet([['Area', r => cr.kinds[r.kind] || r.kind], ['Issue', r => r.label], ['Client', r => r.client], ['Zoho record', r => (r.zoho ? `${r.zoho.type_label} ${r.zoho.number || ''}` : '')], ['Zoho date', r => (r.zoho ? r.zoho.date : ''), 'date'],
    ['26AS deductor', r => (r.credit ? `${r.credit.deductor} (${r.credit.tan})` : '')], ['26AS date', r => (r.credit ? r.credit.txn_date : ''), 'date'], ['Amount', r => r.amount, 'money'], ['Detail', r => r.detail],
    ['Candidate invoice(s)', r => (r.candidate_invoices || []).map(i => i.no).join(', ')], ['Zoho link', r => (r.zoho && r.zoho.url) || ((r.candidate_invoices || [])[0] || {}).url || ''], ['Status', r => STATUS[r.status] || '']], cr.rows);
}

function cfSheets(cf) {
  const mov = sheet([['Period', r => r.label], ['Opening balance', r => r.opening, 'money'], ['Additions', r => r.additions, 'money'], ['Credits identified later', r => r.settled, 'money'], ['Reviewer-approved closures', r => r.closed, 'money'], ['Closing balance', r => r.closing, 'money']], cf.rows);
  const items = sheet([['Item', r => r.id], ['Client', r => r.client], ['Side', r => (r.side === 'zoho' ? 'Booked in Zoho, awaiting 26AS credit' : 'Credited in 26AS, awaiting Zoho booking')], ['Originating quarter', r => r.origin_label], ['Balance', r => r.balance, 'money'],
    ['Target period', r => r.target_label], ['Reason', r => r.reason], ['Approved by', r => r.by], ['Approved on', r => String(r.at).slice(0, 10), 'date'], ['Status', r => r.status], ['Settled in', r => r.settled_label], ['Settled by', r => (r.settlement ? r.settlement.detail : '')],
    ['Settlement difference', r => (r.settlement ? r.settlement.diff : null), 'money'], ['Closed in', r => r.closed_label], ['Closure reason', r => (r.closure ? r.closure.reason : '')]], cf.items);
  return { mov, items };
}

function build({ kind, scope, dash, fu, units, cr, cf, coverage, generatedBy, today }) {
  const wb = XLSX.utils.book_new();
  const about = [['26AS Reconciliation'], [], ['Entity', scope.entity], ['PAN', scope.pan], ['Period', scope.period], ['Filters', scope.filters || 'none'], ['Generated', `${today} by ${generatedBy}`],
    ['Zoho Books', 'read-only — nothing was changed in Zoho'], ['TDS difference', 'Zoho TDS receivable − 26AS tax deposited (positive = the books show more TDS than the statement credits)'], []];
  if (coverage) { about.push(['Coverage']); for (const c of coverage) about.push([c.label, c.value]); about.push([]); }
  if (dash) { about.push(['Totals (₹)']); for (const [k, v] of Object.entries({ 'Zoho TDS receivable': dash.totals.zoho, '26AS tax deducted': dash.totals.deducted, '26AS tax deposited': dash.totals.deposited, 'Matched credit': dash.totals.matched, 'Rounding difference': dash.totals.rounding, 'Open — Zoho side': dash.totals.open_zoho, 'Open — 26AS side': dash.totals.open_26as, 'Carry-forward balance': dash.totals.cf_open })) about.push([k, { t: 'n', v: rupees(v), z: MONEY }]); }
  const ws = XLSX.utils.aoa_to_sheet(about); ws['!cols'] = [{ wch: 30 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws, 'About');
  if (fu && (kind === 'followup' || kind === 'all')) { XLSX.utils.book_append_sheet(wb, followupSheet(fu), 'Client follow-up'); }
  if (units && (kind === 'transactions' || kind === 'all' || kind === 'followup')) { XLSX.utils.book_append_sheet(wb, transactionsSheet(units), kind === 'followup' ? 'Open transactions' : 'Transactions'); XLSX.utils.book_append_sheet(wb, linesSheet(units), 'Source lines'); }
  if (dash && (kind === 'all' || kind === 'transactions')) {
    const b = dash.bridge;
    const rows = [{ label: b.start.label, effect: b.start.amount }, ...b.lines.map(l => ({ label: `less: ${l.label}`, units: l.units, zoho: l.zoho, deposited: l.deposited, effect: -l.effect })), { label: b.end.label, effect: b.end.amount }, { label: 'Unexplained (must be 0.00)', effect: b.difference }];
    XLSX.utils.book_append_sheet(wb, sheet([['Bridge line', r => r.label], ['Units', r => r.units], ['Zoho', r => r.zoho, 'money'], ['26AS deposited', r => r.deposited, 'money'], ['Amount', r => r.effect, 'money']], rows), 'Bridge');
  }
  if (cr && (kind === 'corrections' || kind === 'all')) XLSX.utils.book_append_sheet(wb, correctionsSheet(cr), 'Zoho corrections');
  if (cf && (kind === 'carryforward' || kind === 'all')) { const s = cfSheets(cf); XLSX.utils.book_append_sheet(wb, s.mov, `Carry-forward by ${cf.by === 'fy' ? 'year' : 'quarter'}`); XLSX.utils.book_append_sheet(wb, s.items, 'Carry-forward items'); }
  const defs = XLSX.utils.aoa_to_sheet([['Term', 'Definition'], ...Object.entries((fu || {}).definitions || (dash || {}).definitions || {}), ...Object.entries(STATUS).map(([k, v]) => [v, `status code ${k}`]), ['Quarters', PER.qLabel('2026-27-Q1') + ' = Apr–Jun 2026']]);
  defs['!cols'] = [{ wch: 28 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(wb, defs, 'Definitions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { build };
