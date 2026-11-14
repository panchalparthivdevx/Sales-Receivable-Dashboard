/**
 * Financial Reporting — ratios and KPIs, with a formula dictionary.
 *
 * Rules applied (see the dictionary for each metric):
 *  - Returns and turnovers use AVERAGE balances (opening + closing ÷ 2). When the opening balance sheet is not available the
 *    closing balance is used and the result is labelled "Proxy (closing balance)".
 *  - Interim flow figures are annualised by actual days (× 365 ÷ days in the period) and labelled "annualised".
 *  - DSO / DPO use actual days in the period. Receivables include GST, revenue does not: DSO is labelled a proxy unless a
 *    GST rate for receivables is set (Management Inputs → Settings), then receivables are divided by (1 + rate).
 *  - Debt is borrowings only; lease liabilities are kept apart and shown "including leases" separately.
 *  - EBITDA follows the company's own definition (PBT + finance costs + D&A, see its SEBI ratio working). Lease-adjusted
 *    EBITDA deducts the lease payments in the cash flow (interest + principal on lease liabilities) — rent already in
 *    operating expenses (short-term leases) is not deducted again.
 *  - Leverage and valuation multiples use trailing-twelve-month (TTM) EBITDA / PAT.
 *  - Lender-defined DSCR needs the covenant definition and the scheduled principal (Management Inputs); the EBITDA-based
 *    coverage computed from the statements is shown separately and never called the lender's DSCR.
 *  - Group ratios are computed from the consolidated amounts, never averaged from entity ratios.
 *  - Ratios disclosed in the results keep their source value and definition, beside the recalculated management ratio.
 */

'use strict';

const P = require('./periods');
const M = require('./model');

const OK = 'OK', PROXY = 'Proxy', MISSING = 'Missing Input', NA = 'Not Applicable', NM = 'Not Meaningful', UNREC = 'Unreconciled';

function env(ctx, b, p, inputs = {}) {
  const per = P.fromId(p);
  const isFlow = per && per.type !== 'BS';
  const endId = per ? (per.type === 'BS' ? per.id : P.bsAtEnd(per)) : null;
  const startId = isFlow ? P.bsAtStart(per) : null;
  const cache = {};
  const cellOf = (id, pid) => { const k = `${id}|${pid}`; if (!(k in cache)) cache[k] = M.cell(ctx, b, id, pid); return cache[k]; };
  const flow = id => (isFlow ? M.num(cellOf(id, p)) : null);
  const flowErr = id => isFlow && cellOf(id, p).st === 'error';
  const end = id => M.num(cellOf(id, endId));
  const start = id => (startId ? M.num(cellOf(id, startId)) : null);
  const endS = ids => { const vs = ids.map(end); return vs.every(v => v == null) ? null : vs.reduce((s, v) => s + (v || 0), 0); };
  const startS = ids => { const vs = ids.map(start); return vs.every(v => v == null) ? null : vs.reduce((s, v) => s + (v || 0), 0); };
  const avg = ids => {
    const e = endS(ids), s = startS(ids);
    if (e == null) return { v: null, missing: `balance sheet as at ${per?.end}` };
    if (s == null) return { v: e, proxy: true, note: `closing balance used — no balance sheet as at ${startId ? startId.slice(3) : 'the start of the period'}` };
    return { v: (e + s) / 2 };
  };
  const ann = per && isFlow ? 365 / per.days : 1;
  const ttm = id => {
    if (!isFlow) return { v: null };
    const g = pid => M.num(cellOf(id, pid));
    if (per.type === 'FY') return { v: g(p), how: 'year' };
    const prevFY = `FY${per.fy - 1}-FY`;
    const sameLY = p.replace(/^FY(\d{4})/, (m, y) => `FY${+y - 1}`);
    const a = g(prevFY), c = g(sameLY), x = g(p);
    if (a != null && c != null && x != null) return { v: a - c + x, how: `${P.fromId(prevFY).short} − ${P.fromId(sameLY).short} + ${per.short}` };
    return { v: null, missing: `${P.fromId(prevFY).short} and ${P.fromId(sameLY).short} figures for a trailing-twelve-month total` };
  };
  const ebitdaOf = getter => { const a = getter('pl.pbt'), f = getter('pl.exp_fin'), d = getter('pl.exp_dep'); return a == null || f == null || d == null ? null : a + f + d; };
  const debt = ids => endS(ids);
  const shares = latestShareData(inputs, per?.end);
  return { ctx, b, p, per, isFlow, endId, startId, flow, flowErr, end, start, endS, startS, avg, ann, ttm, ebitdaOf, debt, inputs, shares,
    owners: b === 'CO' ? 'pl.pat_owners' : 'pl.pat', equityIds: b === 'CO' ? ['bs.share_cap', 'bs.oth_eq'] : ['bs.share_cap', 'bs.oth_eq'] };
}

function latestShareData(inputs, asOf) {
  const recs = (inputs.records || []).filter(r => r.type === 'share_data' && (!asOf || (r.effectiveDate || '') <= asOf));
  return recs.sort((a, c) => (c.effectiveDate || '').localeCompare(a.effectiveDate || ''))[0] || null;
}

const res = (v, status = OK, extra = {}) => ({ v, status: v == null && status === OK ? NM : status, ...extra });
const missing = what => ({ v: null, status: MISSING, note: `Missing input: ${what}` });
const div = (a, b2) => (a == null || b2 == null ? null : b2 === 0 ? undefined : a / b2);
function ratioRes(a, b2, extra = {}, zeroNote = 'denominator is zero') {
  if (a == null || b2 == null) return { v: null, status: MISSING, note: `Missing input: ${extra.missingWhat || 'a figure this ratio needs is not in the imported statements for this period'}`, parts: extra.parts };
  if (b2 === 0) return { v: null, status: NM, note: zeroNote, parts: extra.parts };
  return { v: a / b2, status: extra.proxy ? PROXY : OK, note: extra.note, parts: extra.parts, annualised: extra.annualised };
}

// ── the dictionary ───────────────────────────────────────────────────────────
// cat, id, name, definition, formula, inputs, source, basis (flow | stock | mixed), annual (annualisation), unit, calc(e)
const D = [];
const def = (o) => D.push(o);
const STMT = 'Imported statements';

// Profitability and returns
def({ cat: 'Profitability & returns', id: 'prof.ebitda', name: 'EBITDA', unit: 'lakh', definition: 'Earnings before interest, tax, depreciation and amortisation — the company\'s definition (SEBI ratio working).', formula: 'PBT + finance costs + depreciation & amortisation', inputs: ['PBT', 'Finance costs', 'D&A'], source: STMT, basis: 'flow', annual: 'none (period amount)',
  calc: e => { const v = e.ebitdaOf(e.flow); return res(v, OK, { parts: { PBT: e.flow('pl.pbt'), 'Finance costs': e.flow('pl.exp_fin'), 'D&A': e.flow('pl.exp_dep') } }); } });
def({ cat: 'Profitability & returns', id: 'prof.op_ebitda', name: 'Operating EBITDA', unit: 'lakh', definition: 'EBITDA excluding other income.', formula: 'EBITDA − other income', inputs: ['EBITDA', 'Other income'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => { const x = e.ebitdaOf(e.flow), o = e.flow('pl.oth_inc'); return res(x == null || o == null ? null : x - o, OK, { parts: { EBITDA: x, 'Other income': o } }); } });
def({ cat: 'Profitability & returns', id: 'prof.ebitda_lease', name: 'Lease-adjusted EBITDA (pre-Ind AS 116)', unit: 'lakh', definition: 'EBITDA after deducting lease payments on capitalised leases, as a management (pre-Ind AS 116) view. Rent already charged in operating expenses is not deducted again.', formula: 'EBITDA + interest paid on lease liabilities + principal paid on lease liabilities (both negative in the cash flow)', inputs: ['EBITDA', 'Lease interest paid (cash flow)', 'Lease principal paid (cash flow)'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => { const x = e.ebitdaOf(e.flow), li = e.flow('cf.int_lease'), lp = e.flow('cf.lease_principal'); if (x != null && (li == null || lp == null)) return missing(`cash flow statement for ${e.per?.short} (lease payments)`); return res(x == null ? null : x + li + lp, OK, { parts: { EBITDA: x, 'Lease interest paid': li, 'Lease principal paid': lp } }); } });
def({ cat: 'Profitability & returns', id: 'prof.gross_m', name: 'Gross margin', unit: 'fraction', definition: 'Revenue less operating expenses / cost of goods and services, as a share of revenue.', formula: '(Revenue − operating expenses) ÷ revenue', inputs: ['Revenue from operations', 'Operating expenses'], source: STMT, basis: 'flow', annual: 'none (ratio of same-period amounts)',
  calc: e => { const r = e.flow('pl.rev'), o = e.flow('pl.exp_ops'); return ratioRes(r == null || o == null ? null : r - o, r); } });
def({ cat: 'Profitability & returns', id: 'prof.ebitda_m', name: 'EBITDA margin', unit: 'fraction', definition: 'EBITDA as a share of revenue from operations.', formula: 'EBITDA ÷ revenue from operations', inputs: ['EBITDA', 'Revenue'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => ratioRes(e.ebitdaOf(e.flow), e.flow('pl.rev')) });
def({ cat: 'Profitability & returns', id: 'prof.op_ebitda_m', name: 'Operating EBITDA margin', unit: 'fraction', definition: 'Same as the SEBI "operating margin" in the results.', formula: '(EBITDA − other income) ÷ revenue from operations', inputs: ['EBITDA', 'Other income', 'Revenue'], source: STMT, basis: 'flow', annual: 'none', srcRatio: 'rt.opm',
  calc: e => { const x = e.ebitdaOf(e.flow), o = e.flow('pl.oth_inc'); return ratioRes(x == null || o == null ? null : x - o, e.flow('pl.rev')); } });
def({ cat: 'Profitability & returns', id: 'prof.ebitda_lease_m', name: 'Lease-adjusted EBITDA margin', unit: 'fraction', definition: 'Lease-adjusted EBITDA as a share of revenue.', formula: 'Lease-adjusted EBITDA ÷ revenue', inputs: ['Lease-adjusted EBITDA', 'Revenue'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => { const x = e.ebitdaOf(e.flow), li = e.flow('cf.int_lease'), lp = e.flow('cf.lease_principal'); if (li == null || lp == null) return missing(`cash flow statement for ${e.per?.short}`); return ratioRes(x == null ? null : x + li + lp, e.flow('pl.rev')); } });
def({ cat: 'Profitability & returns', id: 'prof.pbt_m', name: 'PBT margin', unit: 'fraction', definition: 'Profit before tax as a share of revenue.', formula: 'PBT ÷ revenue', inputs: ['PBT', 'Revenue'], source: STMT, basis: 'flow', annual: 'none', calc: e => ratioRes(e.flow('pl.pbt'), e.flow('pl.rev')) });
def({ cat: 'Profitability & returns', id: 'prof.pat_m', name: 'PAT margin', unit: 'fraction', definition: 'Same as the SEBI "net profit margin".', formula: 'Profit for the period ÷ revenue from operations', inputs: ['PAT', 'Revenue'], source: STMT, basis: 'flow', annual: 'none', srcRatio: 'rt.npm', calc: e => ratioRes(e.flow('pl.pat'), e.flow('pl.rev')) });
def({ cat: 'Profitability & returns', id: 'prof.roe', name: 'Return on equity', unit: 'fraction', definition: 'Profit attributable to owners (annualised) on average equity attributable to owners.', formula: 'PAT to owners × 365 ÷ days ÷ average (share capital + other equity)', inputs: ['PAT (owners)', 'Equity — opening and closing'], source: STMT, basis: 'mixed', annual: '× 365 ÷ days in the period',
  calc: e => { const pr = e.flow(e.owners), a = e.avg(e.equityIds); return ratioRes(pr == null ? null : pr * e.ann, a.v, { proxy: a.proxy, note: [a.note, e.ann !== 1 ? `annualised × ${e.ann.toFixed(3)}` : null].filter(Boolean).join('; '), missingWhat: a.missing, annualised: e.ann !== 1 }); } });
def({ cat: 'Profitability & returns', id: 'prof.roce', name: 'Return on capital employed (incl. leases)', unit: 'fraction', definition: 'EBIT (annualised) on average capital employed, where capital employed = total equity + borrowings + lease liabilities.', formula: '(PBT + finance costs) × 365 ÷ days ÷ average (total equity + borrowings + lease liabilities)', inputs: ['PBT', 'Finance costs', 'Total equity', 'Borrowings', 'Lease liabilities'], source: STMT, basis: 'mixed', annual: '× 365 ÷ days',
  calc: e => { const p1 = e.flow('pl.pbt'), f = e.flow('pl.exp_fin'); const a = e.avg(['bs.eq_tot', 'bs.ncl_borrow', 'bs.cl_borrow', 'bs.ncl_lease', 'bs.cl_lease']); return ratioRes(p1 == null || f == null ? null : (p1 + f) * e.ann, a.v, { proxy: a.proxy, note: a.note, missingWhat: a.missing, annualised: e.ann !== 1 }); } });
def({ cat: 'Profitability & returns', id: 'prof.roce_xl', name: 'Return on capital employed (excl. leases)', unit: 'fraction', definition: 'EBIT before lease interest on capital employed without lease liabilities. Lease interest comes from the finance-costs note.', formula: '(PBT + finance costs − interest on lease liabilities) × 365 ÷ days ÷ average (total equity + borrowings)', inputs: ['PBT', 'Finance costs', 'Interest on lease liability (note)', 'Equity', 'Borrowings'], source: 'Statements + finance-costs note', basis: 'mixed', annual: '× 365 ÷ days',
  calc: e => { const p1 = e.flow('pl.pbt'), f = e.flow('pl.exp_fin'), li = noteValue(e, 'pl.exp_fin', /interest on lease/); if (li == null) return missing(`interest on lease liabilities for ${e.per?.short} (finance-costs note)`); const a = e.avg(['bs.eq_tot', 'bs.ncl_borrow', 'bs.cl_borrow']); return ratioRes(p1 == null || f == null ? null : (p1 + f - li) * e.ann, a.v, { proxy: a.proxy, note: a.note, missingWhat: a.missing, annualised: e.ann !== 1 }); } });
def({ cat: 'Profitability & returns', id: 'prof.roa', name: 'Return on assets', unit: 'fraction', definition: 'Profit for the period (annualised) on average total assets.', formula: 'PAT × 365 ÷ days ÷ average total assets', inputs: ['PAT', 'Total assets'], source: STMT, basis: 'mixed', annual: '× 365 ÷ days',
  calc: e => { const a = e.avg(['bs.ta']); const pr = e.flow('pl.pat'); return ratioRes(pr == null ? null : pr * e.ann, a.v, { proxy: a.proxy, note: a.note, missingWhat: a.missing, annualised: e.ann !== 1 }); } });
def({ cat: 'Profitability & returns', id: 'prof.etr', name: 'Effective tax rate', unit: 'fraction', definition: 'Total tax expense as a share of profit before tax.', formula: 'Total tax ÷ PBT', inputs: ['Total tax', 'PBT'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => { const t = e.flow('pl.tax_tot'), pb = e.flow('pl.pbt'); if (pb != null && pb <= 0) return { v: null, status: NM, note: 'PBT is nil or negative' }; return ratioRes(t, pb); } });

// Liquidity
def({ cat: 'Liquidity', id: 'liq.cr', name: 'Current ratio', unit: 'times', definition: 'Current assets over current liabilities at the period end.', formula: 'Total current assets ÷ total current liabilities', inputs: ['Current assets', 'Current liabilities'], source: STMT, basis: 'stock', annual: 'n/a (balance)', srcRatio: 'rt.cr',
  calc: e => { const a = e.end('bs.ca_tot'), l = e.end('bs.cl_tot'); return ratioRes(a, l, { missingWhat: a == null ? `balance sheet as at ${e.endId?.slice(3)}` : null }); } });
def({ cat: 'Liquidity', id: 'liq.quick', name: 'Quick ratio', unit: 'times', definition: 'Current assets other than inventories and other (non-financial) current assets, over current liabilities.', formula: '(Current assets − inventories − other current assets) ÷ current liabilities', inputs: ['Current assets', 'Inventories', 'Other current assets', 'Current liabilities'], source: STMT, basis: 'stock', annual: 'n/a',
  calc: e => { const a = e.end('bs.ca_tot'); const x = (e.end('bs.inventories') || 0) + (e.end('bs.c_other') || 0); return ratioRes(a == null ? null : a - x, e.end('bs.cl_tot'), { missingWhat: a == null ? `balance sheet as at ${e.endId?.slice(3)}` : null }); } });
def({ cat: 'Liquidity', id: 'liq.cash_ratio', name: 'Cash ratio', unit: 'times', definition: 'Cash, other bank balances and current investments over current liabilities. Other bank balances may be under lien — see the notes.', formula: '(Cash + other bank balances + current investments) ÷ current liabilities', inputs: ['Cash', 'Other bank balances', 'Current investments', 'Current liabilities'], source: STMT, basis: 'stock', annual: 'n/a',
  calc: e => { const c = e.endS(['bs.cash', 'bs.obank', 'bs.c_inv']); return ratioRes(c, e.end('bs.cl_tot'), { missingWhat: c == null ? `balance sheet as at ${e.endId?.slice(3)}` : null }); } });
def({ cat: 'Liquidity', id: 'liq.nwc', name: 'Net working capital', unit: 'lakh', definition: 'Current assets less current liabilities.', formula: 'Current assets − current liabilities', inputs: ['Current assets', 'Current liabilities'], source: STMT, basis: 'stock', annual: 'n/a',
  calc: e => { const a = e.end('bs.ca_tot'), l = e.end('bs.cl_tot'); if (a == null || l == null) return missing(`balance sheet as at ${e.endId?.slice(3)}`); return res(a - l); } });

// Working capital
const gstNote = e => { const g = e.inputs.settings?.gstOnReceivables; return g ? { div: 1 + Number(g), note: `receivables divided by ${1 + Number(g)} to remove GST` } : { div: 1, note: 'receivables include GST while revenue does not — set the GST rate for receivables (Management Inputs → Settings) to make the bases consistent', proxy: true }; };
def({ cat: 'Working capital', id: 'wc.dso', name: 'Days sales outstanding (DSO)', unit: 'days', definition: 'Average trade receivables in days of revenue, using the actual days in the period.', formula: 'Average trade receivables ÷ revenue from operations × days in the period', inputs: ['Trade receivables — opening and closing', 'Revenue'], source: STMT, basis: 'mixed', annual: 'actual days',
  calc: e => { const a = e.avg(['bs.tr']); const r = e.flow('pl.rev'); const g = gstNote(e); if (a.v == null) return missing(a.missing); if (r == null) return missing(`revenue for ${e.per?.short}`); if (!r) return { v: null, status: NM, note: 'no revenue' }; return { v: (a.v / g.div) / r * e.per.days, status: a.proxy || g.proxy ? PROXY : OK, note: [a.note, g.note].filter(Boolean).join('; '), parts: { 'Average receivables': a.v, Revenue: r, Days: e.per.days } }; } });
def({ cat: 'Working capital', id: 'wc.dpo', name: 'Days payables outstanding (DPO) — proxy', unit: 'days', definition: 'Average trade payables in days of purchase-type costs. Purchases are not in the statements: operating expenses + other expenses are used as the proxy base.', formula: 'Average trade payables ÷ (operating expenses + other expenses) × days', inputs: ['Trade payables — opening and closing', 'Operating expenses', 'Other expenses'], source: STMT, basis: 'mixed', annual: 'actual days',
  calc: e => { const a = e.avg(['bs.cl_tp_msme', 'bs.cl_tp_other']); const base = e.flow('pl.exp_ops') != null && e.flow('pl.exp_oth') != null ? e.flow('pl.exp_ops') + e.flow('pl.exp_oth') : null; if (a.v == null) return missing(a.missing); if (!base) return { v: null, status: NM, note: 'no cost base' }; return { v: a.v / base * e.per.days, status: PROXY, note: ['purchases proxy = operating + other expenses; payables include GST', a.note].filter(Boolean).join('; ') }; } });
def({ cat: 'Working capital', id: 'wc.dio', name: 'Inventory days', unit: 'days', definition: 'Average inventories in days of operating expenses.', formula: 'Average inventories ÷ operating expenses × days', inputs: ['Inventories', 'Operating expenses'], source: STMT, basis: 'mixed', annual: 'actual days',
  calc: e => { const i = e.end('bs.inventories'); if (i == null) return missing(`balance sheet as at ${e.endId?.slice(3)}`); if (!i) return { v: null, status: NA, note: 'no inventories reported' }; const a = e.avg(['bs.inventories']); return ratioRes(a.v == null ? null : a.v * e.per.days, e.flow('pl.exp_ops'), { proxy: a.proxy, note: a.note }); } });
def({ cat: 'Working capital', id: 'wc.ccc', name: 'Cash conversion cycle — proxy', unit: 'days', definition: 'DSO + inventory days − DPO (DPO is a proxy, so this is too).', formula: 'DSO + inventory days − DPO', inputs: ['DSO', 'Inventory days', 'DPO'], source: STMT, basis: 'mixed', annual: 'actual days',
  calc: (e, get) => { const s = get('wc.dso'), p1 = get('wc.dpo'), i = get('wc.dio'); if (s.v == null || p1.v == null) return { v: null, status: s.status === MISSING || p1.status === MISSING ? MISSING : NM, note: s.note || p1.note }; return { v: s.v + (i.v || 0) - p1.v, status: PROXY, note: 'DPO proxy; inventory days nil' }; } });
def({ cat: 'Working capital', id: 'wc.rec_turn', name: 'Receivables turnover', unit: 'times', definition: 'Revenue (annualised) over average trade receivables. The results disclose a "debtors turnover" that uses the closing balance — shown beside it.', formula: 'Revenue × 365 ÷ days ÷ average trade receivables', inputs: ['Revenue', 'Trade receivables'], source: STMT, basis: 'mixed', annual: '× 365 ÷ days', srcRatio: 'rt.dtr',
  calc: e => { const a = e.avg(['bs.tr']); const r = e.flow('pl.rev'); return ratioRes(r == null ? null : r * e.ann, a.v, { proxy: a.proxy, note: a.note, missingWhat: a.missing, annualised: e.ann !== 1 }); } });

// Leverage
def({ cat: 'Leverage', id: 'lev.debt', name: 'Total borrowings (excl. leases)', unit: 'lakh', definition: 'Non-current + current borrowings.', formula: 'Borrowings (non-current) + borrowings (current)', inputs: ['Borrowings'], source: STMT, basis: 'stock', annual: 'n/a',
  calc: e => { const d = e.endS(['bs.ncl_borrow', 'bs.cl_borrow']); return d == null ? missing(`balance sheet as at ${e.endId?.slice(3)}`) : res(d); } });
def({ cat: 'Leverage', id: 'lev.debt_l', name: 'Total borrowings incl. lease liabilities', unit: 'lakh', definition: 'Borrowings plus lease liabilities (non-current + current).', formula: 'Borrowings + lease liabilities', inputs: ['Borrowings', 'Lease liabilities'], source: STMT, basis: 'stock', annual: 'n/a',
  calc: e => { const d = e.endS(['bs.ncl_borrow', 'bs.cl_borrow', 'bs.ncl_lease', 'bs.cl_lease']); return d == null ? missing(`balance sheet as at ${e.endId?.slice(3)}`) : res(d); } });
def({ cat: 'Leverage', id: 'lev.net_debt', name: 'Net debt (excl. leases)', unit: 'lakh', definition: 'Borrowings less cash, other bank balances and current investments. Bank balances under lien are still deducted — check the notes.', formula: 'Borrowings − cash − other bank balances − current investments', inputs: ['Borrowings', 'Cash', 'Other bank balances', 'Current investments'], source: STMT, basis: 'stock', annual: 'n/a',
  calc: e => { const d = e.endS(['bs.ncl_borrow', 'bs.cl_borrow']), c = e.endS(['bs.cash', 'bs.obank', 'bs.c_inv']); return d == null ? missing(`balance sheet as at ${e.endId?.slice(3)}`) : res(d - (c || 0)); } });
def({ cat: 'Leverage', id: 'lev.net_debt_l', name: 'Net debt incl. lease liabilities', unit: 'lakh', definition: 'Net debt plus lease liabilities.', formula: 'Net debt + lease liabilities', inputs: ['Net debt', 'Lease liabilities'], source: STMT, basis: 'stock', annual: 'n/a',
  calc: e => { const d = e.endS(['bs.ncl_borrow', 'bs.cl_borrow', 'bs.ncl_lease', 'bs.cl_lease']), c = e.endS(['bs.cash', 'bs.obank', 'bs.c_inv']); return d == null ? missing(`balance sheet as at ${e.endId?.slice(3)}`) : res(d - (c || 0)); } });
def({ cat: 'Leverage', id: 'lev.de', name: 'Debt / equity (excl. leases)', unit: 'times', definition: 'Same definition as the results: total debt ÷ total equity.', formula: 'Borrowings ÷ total equity', inputs: ['Borrowings', 'Total equity'], source: STMT, basis: 'stock', annual: 'n/a', srcRatio: 'rt.de',
  calc: e => ratioRes(e.endS(['bs.ncl_borrow', 'bs.cl_borrow']), e.end('bs.eq_tot'), { missingWhat: e.end('bs.eq_tot') == null ? `balance sheet as at ${e.endId?.slice(3)}` : null }) });
def({ cat: 'Leverage', id: 'lev.de_l', name: 'Debt / equity (incl. leases)', unit: 'times', definition: 'Borrowings plus lease liabilities over total equity.', formula: '(Borrowings + lease liabilities) ÷ total equity', inputs: ['Borrowings', 'Lease liabilities', 'Total equity'], source: STMT, basis: 'stock', annual: 'n/a',
  calc: e => ratioRes(e.endS(['bs.ncl_borrow', 'bs.cl_borrow', 'bs.ncl_lease', 'bs.cl_lease']), e.end('bs.eq_tot'), { missingWhat: e.end('bs.eq_tot') == null ? `balance sheet as at ${e.endId?.slice(3)}` : null }) });
def({ cat: 'Leverage', id: 'lev.nd_ebitda', name: 'Net debt / TTM EBITDA (excl. leases)', unit: 'times', definition: 'Net debt without leases over trailing-twelve-month lease-adjusted EBITDA would be like-for-like; reported EBITDA is used here and the mismatch is labelled.', formula: 'Net debt (excl. leases) ÷ TTM EBITDA', inputs: ['Net debt', 'TTM EBITDA'], source: STMT, basis: 'mixed', annual: 'TTM',
  calc: e => { const nd = e.endS(['bs.ncl_borrow', 'bs.cl_borrow']); const c = e.endS(['bs.cash', 'bs.obank', 'bs.c_inv']); const t = ttmEbitda(e); if (t.v == null) return missing(t.missing || 'TTM EBITDA'); if (nd == null) return missing(`balance sheet as at ${e.endId?.slice(3)}`); if (t.v <= 0) return { v: null, status: NM, note: 'TTM EBITDA is nil or negative' }; return { v: (nd - (c || 0)) / t.v, status: PROXY, note: `TTM = ${t.how}; reported EBITDA is after lease costs are excluded (Ind AS 116) while debt excludes leases — compare with the incl.-leases version`, parts: { 'Net debt': nd - (c || 0), 'TTM EBITDA': t.v } }; } });
def({ cat: 'Leverage', id: 'lev.nd_ebitda_l', name: 'Net debt incl. leases / TTM EBITDA', unit: 'times', definition: 'Like-for-like under Ind AS 116: lease liabilities in debt, reported EBITDA (before lease costs).', formula: '(Net debt + lease liabilities) ÷ TTM EBITDA', inputs: ['Net debt incl. leases', 'TTM EBITDA'], source: STMT, basis: 'mixed', annual: 'TTM',
  calc: e => { const d = e.endS(['bs.ncl_borrow', 'bs.cl_borrow', 'bs.ncl_lease', 'bs.cl_lease']); const c = e.endS(['bs.cash', 'bs.obank', 'bs.c_inv']); const t = ttmEbitda(e); if (t.v == null) return missing(t.missing || 'TTM EBITDA'); if (d == null) return missing(`balance sheet as at ${e.endId?.slice(3)}`); if (t.v <= 0) return { v: null, status: NM, note: 'TTM EBITDA is nil or negative' }; return { v: (d - (c || 0)) / t.v, status: OK, note: `TTM = ${t.how}`, parts: { 'Net debt incl. leases': d - (c || 0), 'TTM EBITDA': t.v } }; } });
def({ cat: 'Leverage', id: 'lev.td_ta', name: 'Total debt / total assets', unit: 'times', definition: 'Same definition as the results.', formula: 'Borrowings ÷ total assets', inputs: ['Borrowings', 'Total assets'], source: STMT, basis: 'stock', annual: 'n/a', srcRatio: 'rt.td_ta',
  calc: e => ratioRes(e.endS(['bs.ncl_borrow', 'bs.cl_borrow']), e.end('bs.ta'), { missingWhat: e.end('bs.ta') == null ? `balance sheet as at ${e.endId?.slice(3)}` : null }) });
def({ cat: 'Leverage', id: 'lev.ltd_wc', name: 'Long-term debt / working capital', unit: 'times', definition: 'Same definition as the results.', formula: 'Non-current borrowings ÷ (current assets − current liabilities)', inputs: ['Non-current borrowings', 'Current assets', 'Current liabilities'], source: STMT, basis: 'stock', annual: 'n/a', srcRatio: 'rt.ltd_wc',
  calc: e => { const w = e.end('bs.ca_tot') != null && e.end('bs.cl_tot') != null ? e.end('bs.ca_tot') - e.end('bs.cl_tot') : null; if (w != null && w <= 0) return { v: null, status: NM, note: 'working capital is nil or negative' }; return ratioRes(e.end('bs.ncl_borrow'), w, { missingWhat: w == null ? `balance sheet as at ${e.endId?.slice(3)}` : null }); } });
def({ cat: 'Leverage', id: 'lev.cl_ratio', name: 'Current liability ratio', unit: 'times', definition: 'Same definition as the results.', formula: 'Current liabilities ÷ (non-current + current liabilities)', inputs: ['Current liabilities', 'Non-current liabilities'], source: STMT, basis: 'stock', annual: 'n/a', srcRatio: 'rt.cl_ratio',
  calc: e => { const c = e.end('bs.cl_tot'), n = e.end('bs.ncl_tot'); return ratioRes(c, c == null || n == null ? null : c + n, { missingWhat: c == null ? `balance sheet as at ${e.endId?.slice(3)}` : null }); } });

// Coverage
def({ cat: 'Interest & debt-service coverage', id: 'cov.iscr', name: 'Interest coverage (EBITDA ÷ finance costs)', unit: 'times', definition: 'Same as the SEBI "interest service coverage ratio". Finance costs include interest on lease liabilities.', formula: 'EBITDA ÷ finance costs', inputs: ['EBITDA', 'Finance costs'], source: STMT, basis: 'flow', annual: 'none', srcRatio: 'rt.iscr',
  calc: e => ratioRes(e.ebitdaOf(e.flow), e.flow('pl.exp_fin')) });
def({ cat: 'Interest & debt-service coverage', id: 'cov.ebit_icr', name: 'Interest coverage (EBIT ÷ finance costs)', unit: 'times', definition: 'Earnings before interest and tax over finance costs.', formula: '(PBT + finance costs) ÷ finance costs', inputs: ['PBT', 'Finance costs'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => { const p1 = e.flow('pl.pbt'), f = e.flow('pl.exp_fin'); return ratioRes(p1 == null || f == null ? null : p1 + f, f); } });
def({ cat: 'Interest & debt-service coverage', id: 'cov.icr_borrow', name: 'Interest coverage on borrowings (lease-adjusted)', unit: 'times', definition: 'Lease-adjusted EBITDA over interest on borrowings only (finance-costs note), so leases are neither in the numerator nor the denominator.', formula: 'Lease-adjusted EBITDA ÷ (finance costs − interest on lease liabilities)', inputs: ['Lease-adjusted EBITDA', 'Finance costs', 'Interest on lease liability (note)'], source: 'Statements + finance-costs note + cash flow', basis: 'flow', annual: 'none',
  calc: e => { const x = e.ebitdaOf(e.flow), li = e.flow('cf.int_lease'), lp = e.flow('cf.lease_principal'), f = e.flow('pl.exp_fin'), ln = noteValue(e, 'pl.exp_fin', /interest on lease/); if (li == null || lp == null) return missing(`cash flow statement for ${e.per?.short}`); if (ln == null) return missing(`interest on lease liabilities for ${e.per?.short} (finance-costs note)`); return ratioRes(x == null ? null : x + li + lp, f == null ? null : f - ln); } });
def({ cat: 'Interest & debt-service coverage', id: 'cov.dscr_ebitda', name: 'Debt-service coverage — EBITDA-based (from statements)', unit: 'times', definition: 'EBITDA over finance costs plus scheduled principal repayments. NOT the lender-defined DSCR. Uses the scheduled principal entered under Management Inputs → Debt schedule for the period; without it, the cash-flow repayments (which include prepayments and refinancing) are used and the result is a proxy.', formula: 'EBITDA ÷ (finance costs + scheduled principal repayments)', inputs: ['EBITDA', 'Finance costs', 'Scheduled principal (debt schedule) or repayments (cash flow)'], source: 'Statements + debt schedule', basis: 'flow', annual: 'none', srcRatio: 'rt.dscr',
  calc: e => { const x = e.ebitdaOf(e.flow), f = e.flow('pl.exp_fin'); const sch = scheduledPrincipal(e); if (sch != null) return ratioRes(x, f == null ? null : f + sch, { note: 'scheduled principal from the debt schedule input' }); const rep = e.flow('cf.borrow_out'); if (rep == null) return missing(`debt schedule (scheduled principal) or a cash flow statement for ${e.per?.short}`); return { ...ratioRes(x, f == null ? null : f - rep), status: PROXY, note: 'principal = repayments in the cash flow (includes prepayments / refinancing); enter the debt schedule for the scheduled principal' }; } });
def({ cat: 'Interest & debt-service coverage', id: 'cov.dscr_lender', name: 'DSCR — lender definition', unit: 'times', definition: 'As defined in each loan agreement. Needs the covenant definition and threshold for each facility.', formula: 'Per covenant definition (Management Inputs → Covenants)', inputs: ['Covenant definition', 'Covenant threshold', 'Lender-defined numerator and denominator'], source: 'Management inputs', basis: 'flow', annual: 'per covenant',
  calc: e => { const cov = (e.inputs.records || []).filter(r => r.type === 'covenant' && /dscr/i.test(r.values?.metric || '')); if (!cov.length) return missing('covenant definitions for DSCR (lender, facility, definition, threshold)'); return { v: null, status: MISSING, note: `Covenant definitions recorded (${cov.length}); the lender-defined numerator / denominator for ${e.per?.short} must be entered as a covenant test value` }; } });

// Operating efficiency and expense ratios
def({ cat: 'Operating efficiency', id: 'eff.asset_turn', name: 'Asset turnover', unit: 'times', definition: 'Revenue (annualised) over average total assets.', formula: 'Revenue × 365 ÷ days ÷ average total assets', inputs: ['Revenue', 'Total assets'], source: STMT, basis: 'mixed', annual: '× 365 ÷ days',
  calc: e => { const a = e.avg(['bs.ta']); const r = e.flow('pl.rev'); return ratioRes(r == null ? null : r * e.ann, a.v, { proxy: a.proxy, note: a.note, missingWhat: a.missing, annualised: e.ann !== 1 }); } });
def({ cat: 'Operating efficiency', id: 'eff.fa_turn', name: 'Fixed-asset turnover (incl. right-of-use)', unit: 'times', definition: 'Revenue (annualised) over average PPE + right-of-use assets + intangibles.', formula: 'Revenue × 365 ÷ days ÷ average (PPE + ROU + intangibles)', inputs: ['Revenue', 'PPE', 'Right-of-use assets', 'Intangibles'], source: STMT, basis: 'mixed', annual: '× 365 ÷ days',
  calc: e => { const a = e.avg(['bs.ppe', 'bs.rou', 'bs.intang']); const r = e.flow('pl.rev'); return ratioRes(r == null ? null : r * e.ann, a.v, { proxy: a.proxy, note: a.note, missingWhat: a.missing, annualised: e.ann !== 1 }); } });
for (const [id, line, name] of [['exp.ops', 'pl.exp_ops', 'Operating expenses'], ['exp.emp', 'pl.exp_emp', 'Employee benefits'], ['exp.oth', 'pl.exp_oth', 'Other expenses'], ['exp.fin', 'pl.exp_fin', 'Finance costs'], ['exp.dep', 'pl.exp_dep', 'Depreciation & amortisation'], ['exp.tot', 'pl.exp_tot', 'Total expenses']])
  def({ cat: 'Expense-to-revenue', id, name: `${name} % of revenue`, unit: 'fraction', definition: `${name} as a share of revenue from operations.`, formula: `${name} ÷ revenue from operations`, inputs: [name, 'Revenue'], source: STMT, basis: 'flow', annual: 'none', calc: e => ratioRes(e.flow(line), e.flow('pl.rev')) });
for (const [id, re, name] of [['exp.rent', /^rent/, 'Rent (short-term / variable leases)'], ['exp.elec', /electricity/, 'Electricity'], ['exp.hk', /housekeeping|security/, 'Housekeeping, security & support'], ['exp.maint', /property maintenance/, 'Property maintenance'], ['exp.salary', /^salary/, 'Salaries']])
  def({ cat: 'Expense-to-revenue', id, name: `${name} % of revenue`, unit: 'fraction', definition: `${name} (note schedule line) as a share of revenue.`, formula: `${name} ÷ revenue`, inputs: [`${name} (note)`, 'Revenue'], source: 'Note schedules', basis: 'flow', annual: 'none',
    calc: e => { const lineId = id === 'exp.salary' ? 'pl.exp_emp' : 'pl.exp_ops'; const v = noteValue(e, lineId, re); if (v == null) return missing(`note schedule for ${e.per?.short} (${name})`); return ratioRes(v, e.flow('pl.rev')); } });

// Cash flow
def({ cat: 'Cash flow', id: 'cf.cfo', name: 'Net cash from operating activities', unit: 'lakh', definition: 'As reported in the cash flow statement.', formula: 'Cash flow statement', inputs: ['CFO'], source: STMT, basis: 'flow', annual: 'none', calc: e => { const v = e.flow('cf.cfo'); return v == null ? missing(`cash flow statement for ${e.per?.short}`) : res(v); } });
def({ cat: 'Cash flow', id: 'cf.fcf', name: 'Free cash flow', unit: 'lakh', definition: 'Operating cash flow less capital expenditure (capex is negative in the cash flow).', formula: 'CFO + purchase of PPE / intangibles / CWIP', inputs: ['CFO', 'Capex'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => { const o = e.flow('cf.cfo'), c = e.flow('cf.capex'); if (o == null) return missing(`cash flow statement for ${e.per?.short}`); return res(c == null ? null : o + c, OK, { parts: { CFO: o, Capex: c } }); } });
def({ cat: 'Cash flow', id: 'cf.fcf_lease', name: 'Free cash flow after lease payments', unit: 'lakh', definition: 'Free cash flow less lease payments (interest + principal on lease liabilities).', formula: 'CFO + capex + lease interest paid + lease principal paid', inputs: ['CFO', 'Capex', 'Lease payments'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => { const o = e.flow('cf.cfo'), c = e.flow('cf.capex'), li = e.flow('cf.int_lease'), lp = e.flow('cf.lease_principal'); if (o == null) return missing(`cash flow statement for ${e.per?.short}`); return res([c, li, lp].some(x => x == null) ? null : o + c + li + lp); } });
def({ cat: 'Cash flow', id: 'cf.conv', name: 'Cash conversion (CFO ÷ EBITDA)', unit: 'fraction', definition: 'Share of EBITDA turned into operating cash flow.', formula: 'CFO ÷ EBITDA', inputs: ['CFO', 'EBITDA'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => { const o = e.flow('cf.cfo'); if (o == null) return missing(`cash flow statement for ${e.per?.short}`); const x = e.ebitdaOf(e.flow); if (x != null && x <= 0) return { v: null, status: NM, note: 'EBITDA nil or negative' }; return ratioRes(o, x); } });
def({ cat: 'Cash flow', id: 'cf.cfo_pat', name: 'CFO ÷ PAT', unit: 'times', definition: 'Operating cash flow over profit for the period.', formula: 'CFO ÷ PAT', inputs: ['CFO', 'PAT'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => { const o = e.flow('cf.cfo'); if (o == null) return missing(`cash flow statement for ${e.per?.short}`); const p1 = e.flow('pl.pat'); if (p1 != null && p1 <= 0) return { v: null, status: NM, note: 'PAT nil or negative' }; return ratioRes(o, p1); } });
def({ cat: 'Cash flow', id: 'cf.capex_rev', name: 'Capex ÷ revenue', unit: 'fraction', definition: 'Capital expenditure as a share of revenue.', formula: '− capex ÷ revenue', inputs: ['Capex', 'Revenue'], source: STMT, basis: 'flow', annual: 'none',
  calc: e => { const c = e.flow('cf.capex'); if (c == null) return missing(`cash flow statement for ${e.per?.short}`); return ratioRes(-c, e.flow('pl.rev')); } });

// Shareholder and valuation
def({ cat: 'Shareholder & valuation', id: 'sh.eps_b', name: 'EPS — basic (reported)', unit: 'inr', definition: 'As reported. Interim EPS is not annualised. Never derived by subtracting cumulative EPS.', formula: 'As reported', inputs: ['EPS'], source: STMT, basis: 'flow', annual: 'not annualised', calc: e => res(e.flow('pl.eps_basic')) });
def({ cat: 'Shareholder & valuation', id: 'sh.eps_d', name: 'EPS — diluted (reported)', unit: 'inr', definition: 'As reported.', formula: 'As reported', inputs: ['EPS'], source: STMT, basis: 'flow', annual: 'not annualised', calc: e => res(e.flow('pl.eps_diluted')) });
def({ cat: 'Shareholder & valuation', id: 'sh.bvps', name: 'Book value per share', unit: 'inr', definition: 'Equity attributable to owners over equity shares outstanding at the period end. Shares: Management Inputs → Share data; otherwise paid-up equity capital ÷ ₹2 face value (labelled proxy).', formula: '(Share capital + other equity) ÷ shares outstanding', inputs: ['Equity attributable to owners', 'Shares outstanding'], source: 'Statements + share data', basis: 'stock', annual: 'n/a',
  calc: e => { const eq = e.endS(e.equityIds); if (eq == null) return missing(`balance sheet as at ${e.endId?.slice(3)}`); const sh = sharesAt(e); if (!sh.n) return missing('shares outstanding'); return { v: eq * 1e5 / sh.n, status: sh.proxy ? PROXY : OK, note: sh.note }; } });
def({ cat: 'Shareholder & valuation', id: 'sh.mcap', name: 'Market capitalisation', unit: 'lakh', definition: 'Dated market price × shares outstanding.', formula: 'Market price × shares outstanding', inputs: ['Market price (dated)', 'Shares outstanding'], source: 'Share data input', basis: 'stock', annual: 'n/a',
  calc: e => { const s = e.shares; if (!s?.values?.marketPrice) return missing('dated market price (Management Inputs → Share data)'); const sh = sharesAt(e); if (!sh.n) return missing('shares outstanding'); return { v: s.values.marketPrice * sh.n / 1e5, status: sh.proxy ? PROXY : OK, note: `price ₹${s.values.marketPrice} as at ${s.effectiveDate}${sh.note ? `; ${sh.note}` : ''}` }; } });
def({ cat: 'Shareholder & valuation', id: 'sh.pe', name: 'P/E (TTM)', unit: 'times', definition: 'Market price over trailing-twelve-month EPS computed from TTM profit to owners and the share count (EPS is never derived by subtracting cumulative EPS).', formula: 'Market price ÷ (TTM PAT to owners ÷ weighted shares)', inputs: ['Market price', 'TTM PAT (owners)', 'Weighted average shares'], source: 'Statements + share data', basis: 'mixed', annual: 'TTM',
  calc: e => { const s = e.shares; if (!s?.values?.marketPrice) return missing('dated market price (Management Inputs → Share data)'); if (!s.values.weightedShares) return missing('weighted average shares for the trailing twelve months (Share data)'); const t = e.ttm(e.owners); if (t.v == null) return missing(t.missing || 'TTM profit'); if (t.v <= 0) return { v: null, status: NM, note: 'TTM profit nil or negative' }; return { v: s.values.marketPrice / (t.v * 1e5 / s.values.weightedShares), status: OK, note: `TTM = ${t.how}` }; } });
def({ cat: 'Shareholder & valuation', id: 'sh.pb', name: 'Price / book', unit: 'times', definition: 'Market price over book value per share.', formula: 'Market price ÷ BVPS', inputs: ['Market price', 'BVPS'], source: 'Statements + share data', basis: 'stock', annual: 'n/a',
  calc: (e, get) => { const s = e.shares; if (!s?.values?.marketPrice) return missing('dated market price (Management Inputs → Share data)'); const bv = get('sh.bvps'); if (bv.v == null) return bv; return { v: s.values.marketPrice / bv.v, status: bv.status, note: bv.note }; } });
def({ cat: 'Shareholder & valuation', id: 'sh.ev_ebitda', name: 'EV / TTM EBITDA (incl. leases)', unit: 'times', definition: 'Enterprise value (market cap + net debt incl. leases + non-controlling interests) over TTM EBITDA.', formula: '(Market cap + net debt incl. leases + NCI) ÷ TTM EBITDA', inputs: ['Market cap', 'Net debt incl. leases', 'TTM EBITDA'], source: 'Statements + share data', basis: 'mixed', annual: 'TTM',
  calc: (e, get) => { const mc = get('sh.mcap'); if (mc.v == null) return mc; const nd = get('lev.net_debt_l'); const t = ttmEbitda(e); if (t.v == null) return missing(t.missing || 'TTM EBITDA'); if (nd.v == null) return nd; return ratioRes(mc.v + nd.v + (e.end('bs.nci') || 0), t.v, { note: `TTM = ${t.how}` }); } });
def({ cat: 'Shareholder & valuation', id: 'sh.payout', name: 'Dividend payout', unit: 'fraction', definition: 'Dividends declared for the period over profit to owners.', formula: 'Dividends ÷ PAT to owners', inputs: ['Dividends (Share data)', 'PAT (owners)'], source: 'Share data input', basis: 'flow', annual: 'none',
  calc: e => { const d = e.flow('cf.dividend'); const s = e.shares; const dps = s?.values?.dividendPerShare; if (d == null && dps == null) return missing('dividends declared (Share data → dividend per share), or a dividend line in the cash flow'); if (dps != null) { const sh = sharesAt(e); return ratioRes(dps * sh.n / 1e5, e.flow(e.owners), { proxy: sh.proxy }); } return ratioRes(-d, e.flow(e.owners)); } });

// Occupancy and unit economics (management inputs)
for (const [id, name, formula, unit] of [
  ['unit.occupancy', 'Occupancy (time-weighted)', 'Occupied seat-days ÷ capacity seat-days in the period', 'fraction'],
  ['unit.rev_seat', 'Revenue per capacity seat per month', 'Revenue ÷ time-weighted capacity seats ÷ months in the period', 'inr'],
  ['unit.rev_occ_seat', 'Revenue per occupied seat per month', 'Revenue ÷ time-weighted occupied seats ÷ months', 'inr'],
  ['unit.rev_sqft', 'Revenue per sq ft per month', 'Revenue ÷ time-weighted operational area ÷ months', 'inr'],
  ['unit.ebitda_seat', 'EBITDA per capacity seat per month', 'EBITDA ÷ time-weighted capacity seats ÷ months', 'inr'],
  ['unit.cost_seat', 'Operating cost per capacity seat per month', '(Total expenses − finance costs − D&A) ÷ time-weighted seats ÷ months', 'inr'],
]) def({ cat: 'Occupancy & unit economics', id, name, unit, definition: `${name}. Capacity seats, occupied seats and area must be entered by branch with effective dates (Management Inputs → Branch capacity); they are weighted by the days each figure applied in the period. Company-level figures only — a branch filter needs branch revenue.`, formula, inputs: ['Branch capacity seats / occupied seats / area with effective dates', 'Revenue / EBITDA'], source: 'Statements + branch capacity input', basis: 'flow', annual: 'per month (÷ months in the period)',
  calc: e => unitEconomics(e, id) });

// Client KPIs (from existing modules / inputs)
for (const [id, name] of [['cli.top10', 'Top-10 client share of revenue'], ['cli.retention', 'Client revenue retention (cohort)'], ['cli.churn', 'Client churn (logos)'], ['cli.mix', 'Revenue mix by service']])
  def({ cat: 'Client & revenue', id, name, unit: 'fraction', definition: `${name}. Computed on the Client & Revenue Analytics tab from invoice data (Sales module) or client revenue uploads — never inferred from statement totals.`, formula: id === 'cli.top10' ? 'Revenue of the 10 largest clients ÷ total invoiced revenue' : id === 'cli.mix' ? 'Revenue by service line (revenue note) ÷ total revenue' : 'Revenue from clients present in both periods ÷ revenue from those clients in the earlier period', inputs: ['Client-level revenue by period'], source: 'Sales module / client revenue input', basis: 'flow', annual: 'none',
    calc: e => (id === 'cli.mix' ? mixFromNote(e) : { v: null, status: MISSING, note: 'see Client & Revenue Analytics (invoice data or client revenue upload)' }) });

function ttmEbitda(e) {
  const parts = ['pl.pbt', 'pl.exp_fin', 'pl.exp_dep'].map(id => e.ttm(id));
  if (parts.some(x => x.v == null)) return { v: null, missing: parts.find(x => x.v == null).missing };
  return { v: parts.reduce((s, x) => s + x.v, 0), how: parts[0].how };
}
function noteValue(e, lineId, re) {
  if (!e.isFlow) return null;
  const C = require('./compare');
  const ni = C.noteItems(e.ctx, e.b, lineId, [e.p]);
  if (!ni) return null;
  const hits = ni.items.filter(it => re.test(it.label.toLowerCase()) && it.v[e.p] != null);
  return hits.length ? hits.reduce((s, it) => s + it.v[e.p], 0) : null;
}
function mixFromNote(e) {
  const C = require('./compare');
  const ni = e.isFlow ? C.noteItems(e.ctx, e.b, 'pl.rev', [e.p]) : null;
  if (!ni) return missing(`revenue note for ${e.per?.short}`);
  const rows = ni.items.filter(it => it.v[e.p]);
  const tot = rows.reduce((s, it) => s + it.v[e.p], 0);
  const top = rows.sort((a, c) => c.v[e.p] - a.v[e.p])[0];
  return { v: tot ? top.v[e.p] / tot : null, status: OK, note: `largest service line: ${top.label}`, parts: Object.fromEntries(rows.map(r => [r.label, r.v[e.p]])) };
}
function sharesAt(e) {
  const s = e.shares;
  if (s?.values?.sharesOutstanding) return { n: s.values.sharesOutstanding, note: `shares as at ${s.effectiveDate} (Share data)` };
  const pu = e.ctx.ix.version.facts.filter(fc => fc.b === e.b && fc.l === 'pl.paidup' && fc.st === 'ok' && P.fromId(fc.p)?.end === e.per?.end)[0];
  if (pu) return { n: pu.v * 1e5 / 2, proxy: true, note: 'shares = paid-up equity capital ÷ ₹2 face value (enter Share data to confirm)' };
  return { n: null };
}
function scheduledPrincipal(e) {
  const recs = (e.inputs.records || []).filter(r => r.type === 'debt_schedule' && r.periodEnd && r.periodEnd >= e.per.start && r.periodEnd <= e.per.end);
  if (!recs.length) return null;
  return recs.reduce((s, r) => s + (Number(r.values?.principal) || 0), 0);
}
/** Time-weighted seats / occupied seats / area over the period (company level), or null */
function denominators(e) {
  if (!e.isFlow) return null;
  const recs = (e.inputs.records || []).filter(r => r.type === 'branch_capacity' && (!r.basis || r.basis === e.b));
  if (!recs.length) return null;
  const days = e.per.days, start = Date.parse(e.per.start);
  const byBranch = {};
  for (const r of recs) (byBranch[r.branch || '—'] = byBranch[r.branch || '—'] || []).push(r);
  let cap = 0, occ = 0, area = 0;
  for (const list of Object.values(byBranch)) {
    list.sort((a, c) => (a.effectiveDate || '').localeCompare(c.effectiveDate || ''));
    for (let d = 0; d < days; d++) {
      const day = new Date(start + d * 86400000).toISOString().slice(0, 10);
      const r = [...list].reverse().find(x => (x.effectiveDate || '') <= day);
      if (!r) continue;
      cap += Number(r.values?.capacitySeats) || 0; occ += Number(r.values?.occupiedSeats) || 0; area += Number(r.values?.areaSqft) || 0;
    }
  }
  return { seats: cap / days || null, occupied: occ / days || null, area: area / days || null, months: days / (365 / 12), branches: Object.keys(byBranch).length };
}

function unitEconomics(e, id) {
  if (!e.isFlow) return { v: null, status: NA, note: 'flow period required' };
  const recs = (e.inputs.records || []).filter(r => r.type === 'branch_capacity' && (!r.basis || r.basis === e.b));
  if (!recs.length) return missing('branch capacity seats, occupied seats and area with effective dates (Management Inputs → Branch capacity)');
  // time-weight each branch's latest record effective on each day of the period
  const days = e.per.days;
  const start = Date.parse(e.per.start);
  const byBranch = {};
  for (const r of recs) (byBranch[r.branch || '—'] = byBranch[r.branch || '—'] || []).push(r);
  let cap = 0, occ = 0, area = 0, covered = 0;
  for (const list of Object.values(byBranch)) {
    list.sort((a, c) => (a.effectiveDate || '').localeCompare(c.effectiveDate || ''));
    for (let d = 0; d < days; d++) {
      const day = new Date(start + d * 86400000).toISOString().slice(0, 10);
      const r = [...list].reverse().find(x => (x.effectiveDate || '') <= day);
      if (!r) continue;
      covered++;
      cap += Number(r.values?.capacitySeats) || 0; occ += Number(r.values?.occupiedSeats) || 0; area += Number(r.values?.areaSqft) || 0;
    }
  }
  if (!cap) return missing(`branch capacity effective on or before ${e.per.end}`);
  const months = days / (365 / 12);
  const avgCap = cap / days, avgOcc = occ / days, avgArea = area / days;
  const rev = e.flow('pl.rev'), x = e.ebitdaOf(e.flow);
  const note = `time-weighted over ${days} days; ${Object.keys(byBranch).length} branch(es)`;
  if (id === 'unit.occupancy') return occ ? { v: occ / cap, status: OK, note } : missing('occupied seats');
  if (id === 'unit.rev_seat') return ratioRes(rev == null ? null : rev * 1e5 / months, avgCap, { note });
  if (id === 'unit.rev_occ_seat') return occ ? ratioRes(rev == null ? null : rev * 1e5 / months, avgOcc, { note }) : missing('occupied seats');
  if (id === 'unit.rev_sqft') return area ? ratioRes(rev == null ? null : rev * 1e5 / months, avgArea, { note }) : missing('operational area (sq ft)');
  if (id === 'unit.ebitda_seat') return ratioRes(x == null ? null : x * 1e5 / months, avgCap, { note });
  if (id === 'unit.cost_seat') { const t = e.flow('pl.exp_tot'), f = e.flow('pl.exp_fin'), dp = e.flow('pl.exp_dep'); return ratioRes(t == null ? null : (t - f - dp) * 1e5 / months, avgCap, { note }); }
  void covered;
  return { v: null, status: NA };
}

/** All metrics for one basis + period, plus the ratios disclosed in the source for that period */
function compute(ctx, b, p, inputs = {}) {
  const e = env(ctx, b, p, inputs);
  const out = {};
  const get = id => {
    if (out[id]) return out[id];
    const m = D.find(x => x.id === id);
    let r;
    try { r = m.calc(e, get); } catch (err) { r = { v: null, status: UNREC, note: `calculation error: ${err.message}` }; }
    if (r.v == null && r.status === OK) r.status = NM;
    if (r.v != null && r.annualised && r.status === OK) r.note = r.note || 'annualised';
    out[id] = r;
    return r;
  };
  D.forEach(m => get(m.id));
  // source-disclosed ratios (as reported, with their definition)
  const disclosed = {};
  for (const fc of ctx.ix.version.facts.filter(f => f.b === b && f.s === 'RT' && f.p === p && f.st === 'ok')) {
    const best = M.cell(ctx, b, fc.l, p);
    disclosed[fc.l] = { v: best.v, src: best.fact ? { f: best.fact.f, sh: best.fact.sh, c: best.fact.c } : null, definition: ctx.ix.version.ratioDefs?.[`${b}|${fc.l}`]?.definition || null };
  }
  // an interim figure that depends on a balance sheet nobody has: say so plainly
  for (const [id, r] of Object.entries(out)) if (r.status === OK && r.v == null) out[id] = { ...r, status: NM };
  return { basis: b, period: P.fromId(p), values: out, disclosed, denominators: denominators(e) };
}

function dictionary() {
  return D.map(({ calc, ...m }) => ({ ...m, status: m.source === STMT ? 'Implemented — statements' : m.source.includes('input') || m.source.includes('Management') ? 'Implemented — needs management input' : 'Implemented — statements + notes / modules' }));
}

module.exports = { compute, dictionary, env, STATUSES: { OK, PROXY, MISSING, NA, NM, UNREC } };
