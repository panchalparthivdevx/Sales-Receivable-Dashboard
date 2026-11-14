/**
 * Financial Reporting — the canonical statement lines and the matcher that maps a workbook row to one of them.
 *
 * A row is mapped by the MEANING of its label in its context (the section it sits in), never by its row number or its
 * note number: "Borrowings" under "Current Liabilities" is bs.cl_borrow, under "Non-current Liabilities" bs.ncl_borrow;
 * the three "Owners of the Company" rows in a consolidated result are told apart by the attribution heading above them.
 *
 * Presentation signs: every line keeps the sign the source shows (expenses and taxes as positive charges, credits and
 * cash outflows negative). sign: 1 on every line is the explicit mapping rule — nothing is turned into an absolute value.
 *
 * unit: 'lakh' (₹ lakh), 'inr' (₹ per share — EPS, never scaled), 'times', 'fraction' (shown as %), 'nos'.
 */

'use strict';

// ── Profit and loss ──────────────────────────────────────────────────────────
const PL = [
  { id: 'pl.rev', label: 'Revenue from operations', re: /^revenue from operations?$|^revenue from contracts? with customers$/ },
  { id: 'pl.oth_inc', label: 'Other income', re: /^other income$/ },
  { id: 'pl.tot_inc', label: 'Total income', re: /^total income\b|^total revenue\b/, bold: true, sum: ['pl.rev', 'pl.oth_inc'] },
  { id: 'pl.exp_ops', label: 'Operating expenses / cost of goods and services', re: /^(operating expenses?|cost of goods and services|cost of services|cost of operations?)$/, indent: 1 },
  { id: 'pl.exp_emp', label: 'Employee benefits expense', re: /^employee benefits? expenses?$/, indent: 1 },
  { id: 'pl.exp_fin', label: 'Finance costs', re: /^finance costs?$/, indent: 1 },
  { id: 'pl.exp_dep', label: 'Depreciation and amortisation expense', re: /^depreciation (and|&) amorti[sz]ation( expenses?)?$/, indent: 1 },
  { id: 'pl.exp_oth', label: 'Other expenses', re: /^other expenses$/, indent: 1 },
  { id: 'pl.exp_tot', label: 'Total expenses', re: /^total expenses\b/, bold: true, sum: ['pl.exp_ops', 'pl.exp_emp', 'pl.exp_fin', 'pl.exp_dep', 'pl.exp_oth'] },
  { id: 'pl.pbe', label: 'Profit before exceptional items and tax', re: /^profit.*before exceptional items? and tax/, bold: true, calc: v => d(v['pl.tot_inc'], v['pl.exp_tot']) },
  { id: 'pl.exceptional', label: 'Exceptional items', re: /^exceptional items?$/ },
  { id: 'pl.pb_assoc', label: 'Profit before share of associates and tax', re: /^profit.*before share of (net )?(profit|loss)/, bold: true, cons: true },
  { id: 'pl.share_assoc', label: 'Share of profit/(loss) of associates', re: /^share of (net )?(profit|loss).*(associate|joint venture)/, cons: true },
  { id: 'pl.pbt', label: 'Profit before tax', re: /^profit.*before tax\b/, bold: true },
  { id: 'pl.tax_cur', label: 'Current tax', re: /current tax$/, indent: 1, sec: 'tax' },
  { id: 'pl.tax_def', label: 'Deferred tax', re: /^deferred tax/, indent: 1, sec: 'tax' },
  { id: 'pl.tax_prior', label: 'Tax adjustment for earlier years', re: /earlier years?|prior years?/, indent: 1, sec: 'tax' },
  { id: 'pl.tax_tot', label: 'Total tax expense', re: /^total tax expenses?/, bold: true, sum: ['pl.tax_cur', 'pl.tax_def', 'pl.tax_prior'] },
  { id: 'pl.pat', label: 'Profit for the period', re: /^profit.*for the (period|year)|^(net )?profit after tax/, not: /attributable/, bold: true, calc: v => d(v['pl.pbt'], v['pl.tax_tot']) },
  { id: 'pl.oci_nr', label: 'OCI — items that will not be reclassified to profit or loss', re: /^items that will not be reclassified to profit or loss$|remeasurement (gains?|losses?|of)?.*defined benew*/, indent: 1, sec: 'oci' },
  { id: 'pl.oci_nr_tax', label: 'Income tax on items that will not be reclassified', re: /^(income tax|tax).*(will not be reclassified)/, indent: 1, sec: 'oci' },
  { id: 'pl.oci_r', label: 'OCI — items that will be reclassified to profit or loss', re: /^items that will be reclassified to profit or loss$/, indent: 1, sec: 'oci' },
  { id: 'pl.oci_r_tax', label: 'Income tax on items that will be reclassified', re: /^(income tax|tax).*(will be reclassified)/, indent: 1, sec: 'oci' },
  { id: 'pl.oci_tot', label: 'Total other comprehensive income', re: /^total other comprehensive (income|loss)/, not: /attributable/, bold: true, sum: ['pl.oci_nr', 'pl.oci_nr_tax', 'pl.oci_r', 'pl.oci_r_tax'] },
  { id: 'pl.tci', label: 'Total comprehensive income', re: /^total comprehensive (income|loss)/, not: /attributable/, bold: true, sum: ['pl.pat', 'pl.oci_tot'] },
  { id: 'pl.pat_owners', label: 'Profit attributable to owners of the company', sec: 'attr_pat', who: 'owners', cons: true, indent: 1 },
  { id: 'pl.pat_nci', label: 'Profit attributable to non-controlling interests', sec: 'attr_pat', who: 'nci', cons: true, indent: 1 },
  { id: 'pl.oci_owners', label: 'OCI attributable to owners of the company', sec: 'attr_oci', who: 'owners', cons: true, indent: 1 },
  { id: 'pl.oci_nci', label: 'OCI attributable to non-controlling interests', sec: 'attr_oci', who: 'nci', cons: true, indent: 1 },
  { id: 'pl.tci_owners', label: 'Total comprehensive income attributable to owners', sec: 'attr_tci', who: 'owners', cons: true, indent: 1 },
  { id: 'pl.tci_nci', label: 'Total comprehensive income attributable to non-controlling interests', sec: 'attr_tci', who: 'nci', cons: true, indent: 1 },
  { id: 'pl.paidup', label: 'Paid-up equity share capital (face value ₹2 per share)', re: /^paid[- ]?up equity share capital/ },
  { id: 'pl.oth_eq', label: 'Other equity excluding revaluation reserve', re: /^other equity excluding revaluation/ },
  { id: 'pl.eps_basic', label: 'Earnings per share — basic (₹)', sec: 'eps', re: /^basic\b/, unit: 'inr', indent: 1 },
  { id: 'pl.eps_diluted', label: 'Earnings per share — diluted (₹)', sec: 'eps', re: /^diluted\b/, unit: 'inr', indent: 1 },
];

// Ratios disclosed in the SEBI results (kept as SOURCE-DISCLOSED ratios with their source definition — never mixed with
// the module's recalculated ratios)
const RT = [
  { id: 'rt.dscr', label: 'Debt service coverage ratio', re: /^debt service coverage/, unit: 'times' },
  { id: 'rt.iscr', label: 'Interest service coverage ratio', re: /^interest service coverage/, unit: 'times' },
  { id: 'rt.de', label: 'Debt equity ratio', re: /^debt[- ]?equity ratio/, unit: 'times' },
  { id: 'rt.cr', label: 'Current ratio', re: /^current ratio/, unit: 'times' },
  { id: 'rt.ltd_wc', label: 'Long term debt to working capital', re: /^long term debt to working capital/, unit: 'times' },
  { id: 'rt.cl_ratio', label: 'Current liability ratio', re: /^current liability ratio/, unit: 'times' },
  { id: 'rt.td_ta', label: 'Total debts to total assets', re: /^total debts? to total assets/, unit: 'times' },
  { id: 'rt.dtr', label: 'Debtors turnover ratio', re: /^debtors turnover/, unit: 'times' },
  { id: 'rt.opm', label: 'Operating margin', re: /^operating (profit )?margin/, unit: 'fraction' },
  { id: 'rt.npm', label: 'Net profit margin', re: /^net profit margin/, unit: 'fraction' },
  { id: 'rt.isr', label: 'Inventory turnover', re: /^inventory turnover/, unit: 'times' },
  { id: 'rt.bdr', label: 'Bad debts to accounts receivable', re: /^bad debts to/, unit: 'fraction' },
];

// ── Balance sheet ────────────────────────────────────────────────────────────
const BS = [
  { id: 'bs.ppe', label: 'Property, plant and equipment', re: /^property,? plant (and|&) equipments?$/, sec: 'nca', indent: 1 },
  { id: 'bs.cwip', label: 'Capital work-in-progress', re: /^capital work[- ]?in[- ]?progress$/, sec: 'nca', indent: 1 },
  { id: 'bs.rou', label: 'Right-of-use assets', re: /^right[- ]of[- ]use assets?$/, sec: 'nca', indent: 1 },
  { id: 'bs.goodwill', label: 'Goodwill', re: /^goodwill$/, sec: 'nca', indent: 1 },
  { id: 'bs.intang', label: 'Other intangible assets', re: /^(other )?intangible assets?$/, sec: 'nca', indent: 1 },
  { id: 'bs.intang_dev', label: 'Intangible assets under development', re: /^intangible assets? under dev/, sec: 'nca', indent: 1 },
  { id: 'bs.nc_inv', label: 'Investments (non-current)', re: /^investments?$/, sec: 'nca', indent: 2, fin: true },
  { id: 'bs.nc_loans', label: 'Loans (non-current)', re: /^loans$/, sec: 'nca', indent: 2, fin: true },
  { id: 'bs.nc_ofa', label: 'Other financial assets (non-current)', re: /^other financial assets$/, sec: 'nca', indent: 2, fin: true },
  { id: 'bs.dta', label: 'Deferred tax assets (net)', re: /^deferred tax assets?/, sec: 'nca', indent: 1 },
  { id: 'bs.nc_ita', label: 'Income tax assets (non-current)', re: /^(income|non[- ]current) tax assets?/, sec: 'nca', indent: 1 },
  { id: 'bs.nc_other', label: 'Other non-current assets', re: /^other non[- ]current assets$/, sec: 'nca', indent: 1 },
  { id: 'bs.nca_tot', label: 'Total non-current assets', re: /^total non[- ]current assets$/, sec: 'nca', bold: true,
    sum: ['bs.ppe', 'bs.cwip', 'bs.rou', 'bs.goodwill', 'bs.intang', 'bs.intang_dev', 'bs.nc_inv', 'bs.nc_loans', 'bs.nc_ofa', 'bs.dta', 'bs.nc_ita', 'bs.nc_other'] },
  { id: 'bs.inventories', label: 'Inventories', re: /^inventor(y|ies)$/, sec: 'ca', indent: 1 },
  { id: 'bs.c_inv', label: 'Investments (current)', re: /^investments?$/, sec: 'ca', indent: 2, fin: true },
  { id: 'bs.tr', label: 'Trade receivables', re: /^trade receivables?$/, sec: 'ca', indent: 2, fin: true },
  { id: 'bs.cash', label: 'Cash and cash equivalents', re: /^cash (and|&) cash equivalents?$/, sec: 'ca', indent: 2, fin: true },
  { id: 'bs.obank', label: 'Other bank balances', re: /^(other bank balances?|bank balances? other than)/, sec: 'ca', indent: 2, fin: true },
  { id: 'bs.c_loans', label: 'Loans (current)', re: /^loans$/, sec: 'ca', indent: 2, fin: true },
  { id: 'bs.c_ofa', label: 'Other financial assets (current)', re: /^other financial assets$/, sec: 'ca', indent: 2, fin: true },
  { id: 'bs.cta', label: 'Current tax assets (net)', re: /^current tax assets?/, sec: 'ca', indent: 1 },
  { id: 'bs.c_other', label: 'Other current assets', re: /^other current assets$/, sec: 'ca', indent: 1 },
  { id: 'bs.ca_tot', label: 'Total current assets', re: /^total current assets$/, sec: 'ca', bold: true,
    sum: ['bs.inventories', 'bs.c_inv', 'bs.tr', 'bs.cash', 'bs.obank', 'bs.c_loans', 'bs.c_ofa', 'bs.cta', 'bs.c_other'] },
  { id: 'bs.ta', label: 'TOTAL ASSETS', re: /^total assets$/, bold: true, grand: true, sum: ['bs.nca_tot', 'bs.ca_tot'] },
  { id: 'bs.share_cap', label: 'Equity share capital', re: /^(equity )?share capital$/, sec: 'eq', indent: 1 },
  { id: 'bs.oth_eq', label: 'Other equity', re: /^other equity$/, sec: 'eq', indent: 1 },
  { id: 'bs.eq_owners', label: 'Equity attributable to owners of the company', re: /^equity attributable to/, sec: 'eq', bold: true, cons: true, sum: ['bs.share_cap', 'bs.oth_eq'] },
  { id: 'bs.nci', label: 'Non-controlling interests', re: /^non[- ]?controlling interests?$/, sec: 'eq', indent: 1, cons: true },
  { id: 'bs.eq_tot', label: 'Total equity', re: /^total equity$/, sec: 'eq', bold: true, sum: ['bs.share_cap', 'bs.oth_eq', 'bs.nci'] },
  { id: 'bs.ncl_borrow', label: 'Borrowings (non-current)', re: /^borrowings?$/, sec: 'ncl', indent: 2, fin: true },
  { id: 'bs.ncl_lease', label: 'Lease liabilities (non-current)', re: /^lease liabilit(y|ies)$/, sec: 'ncl', indent: 2, fin: true },
  { id: 'bs.ncl_ofl', label: 'Other financial liabilities (non-current)', re: /^other financial liabilit(y|ies)$/, sec: 'ncl', indent: 2, fin: true },
  { id: 'bs.ncl_prov', label: 'Provisions (non-current)', re: /^provisions?$/, sec: 'ncl', indent: 1 },
  { id: 'bs.ncl_dtl', label: 'Deferred tax liabilities (net)', re: /^deferred tax liabilit/, sec: 'ncl', indent: 1 },
  { id: 'bs.ncl_other', label: 'Other non-current liabilities', re: /^other non[- ]current liabilit/, sec: 'ncl', indent: 1 },
  { id: 'bs.ncl_tot', label: 'Total non-current liabilities', re: /^total non[- ]current liabilit/, sec: 'ncl', bold: true,
    sum: ['bs.ncl_borrow', 'bs.ncl_lease', 'bs.ncl_ofl', 'bs.ncl_prov', 'bs.ncl_dtl', 'bs.ncl_other'] },
  { id: 'bs.cl_borrow', label: 'Borrowings (current)', re: /^borrowings?$/, sec: 'cl', indent: 2, fin: true },
  { id: 'bs.cl_tp_msme', label: 'Trade payables — micro and small enterprises', re: /micro (and|&) small enterprises/, not: /other than/, sec: 'cl', indent: 3, fin: true },
  { id: 'bs.cl_tp_other', label: 'Trade payables — other than micro and small enterprises', re: /other than micro/, sec: 'cl', indent: 3, fin: true },
  { id: 'bs.cl_lease', label: 'Lease liabilities (current)', re: /^lease liabilit(y|ies)$/, sec: 'cl', indent: 2, fin: true },
  { id: 'bs.cl_ofl', label: 'Other financial liabilities (current)', re: /^other financial liabilit(y|ies)$/, sec: 'cl', indent: 2, fin: true },
  { id: 'bs.cl_other', label: 'Other current liabilities', re: /^other current liabilit(y|ies)$/, sec: 'cl', indent: 1 },
  { id: 'bs.cl_prov', label: 'Provisions (current)', re: /^provisions?$/, sec: 'cl', indent: 1 },
  { id: 'bs.cl_ctl', label: 'Current tax liabilities (net)', re: /^current tax liabilit/, sec: 'cl', indent: 1 },
  { id: 'bs.cl_tot', label: 'Total current liabilities', re: /^total current liabilit/, sec: 'cl', bold: true,
    sum: ['bs.cl_borrow', 'bs.cl_tp_msme', 'bs.cl_tp_other', 'bs.cl_lease', 'bs.cl_ofl', 'bs.cl_other', 'bs.cl_prov', 'bs.cl_ctl'] },
  { id: 'bs.tel', label: 'TOTAL EQUITY AND LIABILITIES', re: /^total equity and liabilit/, bold: true, grand: true, sum: ['bs.eq_tot', 'bs.ncl_tot', 'bs.cl_tot'] },
];
const BS_SECTIONS = [
  { sec: 'nca', re: /^non[- ]current assets$/ }, { sec: 'ca', re: /^current assets$/ }, { sec: 'eq', re: /^equity$/ },
  { sec: 'ncl', re: /^non[- ]current liabilit(y|ies)$/ }, { sec: 'cl', re: /^current liabilit(y|ies)$/ },
];

// ── Cash flow ────────────────────────────────────────────────────────────────
// Only lines that are the same across companies and years are canonical; every other row is kept under its own label
// in its section (cf.A.x.<slug>) so nothing in the source is dropped.
const CF = [
  { id: 'cf.pbt', label: 'Profit before tax', re: /^profit.*before tax/, sec: 'A' },
  { id: 'cf.dep', label: 'Depreciation and amortisation', re: /^depreciation/, sec: 'A', indent: 1 },
  { id: 'cf.int_inc', label: 'Interest income', re: /^interest income$/, sec: 'A', indent: 1 },
  { id: 'cf.fin_cost', label: 'Finance costs', re: /^finance costs?$/, sec: 'A', indent: 1 },
  { id: 'cf.op_bwc', label: 'Operating profit before working capital changes', re: /^operating profit before working capital/, sec: 'A', bold: true },
  { id: 'cf.wc', label: 'Net changes in working capital', re: /^net (changes?|movement) in working capital|^(total )?working capital (changes|adjustments)/, sec: 'A', bold: true },
  { id: 'cf.cash_gen', label: 'Cash generated from operations', re: /^cash generated from operations?/, sec: 'A', bold: true },
  { id: 'cf.tax_paid', label: 'Direct taxes paid (net of refunds)', re: /^(direct taxes|income taxes?) paid|^taxes paid/, sec: 'A', indent: 1 },
  { id: 'cf.cfo', label: 'Net cash from/(used in) operating activities', re: /^net cash.*operating activit/, sec: 'A', bold: true, total: true },
  { id: 'cf.capex', label: 'Purchase of PPE / intangibles / CWIP (incl. capital advances)', re: /^purchase of property/, sec: 'B', indent: 1 },
  { id: 'cf.ppe_sale', label: 'Sale of property, plant and equipment', re: /^(proceeds from )?sale of property/, sec: 'B', indent: 1 },
  { id: 'cf.inv_buy', label: 'Purchase of investments', re: /^purchase of investments?$/, sec: 'B', indent: 1 },
  { id: 'cf.inv_sale', label: 'Proceeds from sale of investments', re: /^(proceeds from )?sale of investments?$/, sec: 'B', indent: 1 },
  { id: 'cf.loans_given', label: 'Loans given (net)', re: /^loans? given/, sec: 'B', indent: 1 },
  { id: 'cf.int_recd', label: 'Interest received', re: /^interest received/, sec: 'B', indent: 1 },
  { id: 'cf.cfi', label: 'Net cash from/(used in) investing activities', re: /^net cash.*investing activit/, sec: 'B', bold: true, total: true },
  { id: 'cf.int_paid', label: 'Interest paid on borrowings', re: /^interest paid( on borrowings?)?$|^finance costs? paid/, sec: 'C', indent: 1 },
  { id: 'cf.int_lease', label: 'Interest paid on lease liabilities', re: /^interest paid on lease/, sec: 'C', indent: 1 },
  { id: 'cf.borrow_in', label: 'Proceeds from borrowings', re: /^proceeds from .*borrowings?/, sec: 'C', indent: 1 },
  { id: 'cf.borrow_out', label: 'Repayment of borrowings', re: /^repayments? of .*borrowings?/, sec: 'C', indent: 1 },
  { id: 'cf.shares', label: 'Proceeds from issue of shares (net of issue expenses)', re: /^proceeds from (issue of )?(equity )?shares/, sec: 'C', indent: 1 },
  { id: 'cf.warrants', label: 'Proceeds from issue of share warrants', re: /share warrants/, sec: 'C', indent: 1 },
  { id: 'cf.lease_principal', label: 'Payment of principal portion of lease liabilities', re: /principal portion of lease|repayment of lease liabilit/, sec: 'C', indent: 1 },
  { id: 'cf.dividend', label: 'Dividends paid', re: /^dividends? paid/, sec: 'C', indent: 1 },
  { id: 'cf.cff', label: 'Net cash from/(used in) financing activities', re: /^net cash.*financing activit/, sec: 'C', bold: true, total: true },
  { id: 'cf.net', label: 'Net increase/(decrease) in cash and cash equivalents', re: /^net (increase|decrease|change).*cash/, sec: 'Z', bold: true, sum: ['cf.cfo', 'cf.cfi', 'cf.cff'] },
  { id: 'cf.open', label: 'Cash and cash equivalents at the beginning of the period', re: /^cash.*(beginning|opening|start)|^opening cash/, not: /acquisition|subsidiar/, sec: 'Z' },
  { id: 'cf.close', label: 'Cash and cash equivalents at the end of the period', re: /^cash.*(end of|closing)/, sec: 'Z', bold: true, sum: ['cf.net', 'cf.open'] },
];
const CF_SECTIONS = [
  { sec: 'A', re: /^cash flows? (from|used in|from \/ \(used in\)) operating/ }, { sec: 'B', re: /^cash flows? (from|used in|from \/ \(used in\)) investing/ },
  { sec: 'C', re: /^cash flows? (from|used in|from \/ \(used in\)) financing/ },
];

const ALL = [...PL, ...RT, ...BS, ...CF];
const BY_ID = Object.fromEntries(ALL.map(l => [l.id, l]));
const STATEMENT_OF = id => (id.startsWith('pl.') ? 'PL' : id.startsWith('bs.') ? 'BS' : id.startsWith('cf.') ? 'CF' : id.startsWith('rt.') ? 'RT' : 'NT');

function d(a, b) { return (a == null || b == null) ? null : a - b; }

/** Label normalisation: case, spaces, enumerations "(a)", "(iii)", "a)", "- ", roman references "(III-IV)", "/(loss)" */
function norm(label) {
  let t = String(label || '').replace(/ /g, ' ').replace(/[\r\n\t]+/g, ' ').toLowerCase();
  t = t.replace(/\/\s*\((loss|expense)\)/g, '').replace(/\((loss|expense)\)/g, '');
  t = t.replace(/\(\s*(?:[ivxl]+\s*[-+]\s*)+[ivxl]+\s*\)/g, '');           // (III-IV), (VII + VIII), (IX-X)
  t = t.replace(/\(refer note[^)]*\)/g, '');
  t = t.replace(/^\s*(?:\(?[ivxl]{1,5}\)|\(?[a-z]\)|\d+[.)]|[-–—•*]+)\s*/g, '');  // one leading enumeration
  t = t.replace(/^\s*(?:\(?[ivxl]{1,5}\)|\(?[a-z]\)|[-–—•]+)\s*/g, '');          // a second one ("(a) (i)")
  t = t.replace(/[*:]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*\.$/, '');
  return t;
}
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'row';

/**
 * Stateful matcher for one statement sheet. feed(label, hasValues) → { id, sec } | { header: sec } | null
 * Section headers change context; the same label can then mean a different line.
 */
function matcher(statement) {
  let sec = statement === 'BS' ? null : statement === 'CF' ? null : 'main';
  let lastOci = null;
  const seen = new Set();
  return {
    get sec() { return sec; },
    feed(raw) {
      const t = norm(raw);
      if (!t) return null;
      if (statement === 'BS') {
        for (const s of BS_SECTIONS) if (s.re.test(t)) { sec = s.sec; return { header: s.sec }; }
        const hit = BS.find(l => l.sec ? l.sec === sec && l.re.test(t) && !(l.not && l.not.test(t)) : (l.re.test(t) && !(l.not && l.not.test(t))));
        return hit ? { id: hit.id, sec } : null;
      }
      if (statement === 'CF') {
        for (const s of CF_SECTIONS) if (s.re.test(t)) { sec = s.sec; return { header: s.sec }; }
        const hit = CF.find(l => (l.sec === sec || l.sec === 'Z' || (l.id === 'cf.pbt' && !sec)) && l.re.test(t) && !(l.not && l.not.test(t)));
        if (hit) { if (hit.sec === 'Z') sec = 'Z'; return { id: hit.id, sec: hit.sec }; }
        if (/^(opening )?cash.*(beginning|opening)|^opening cash/.test(t)) { sec = 'Z'; return { extra: `cf.Z.x.${slug(raw)}`, sec: 'Z' }; }
        return sec ? { extra: `cf.${sec}.x.${slug(raw)}`, sec } : null;
      }
      // P&L (SEBI results or detailed statement)
      if (/^(profit|net profit).*attributable to/.test(t)) { sec = 'attr_pat'; return { header: sec }; }
      if (/^other comprehensive (income|loss).*attributable to/.test(t)) { sec = 'attr_oci'; return { header: sec }; }
      if (/^total comprehensive (income|loss).*attributable to/.test(t)) { sec = 'attr_tci'; return { header: sec }; }
      if (/^earnings? per (equity )?share/.test(t)) { sec = 'eps'; return { header: sec }; }
      if (/^ratios?$/.test(t)) { sec = 'ratios'; return { header: sec }; }
      if (/^other comprehensive (income|loss)/.test(t) && !/total/.test(t)) { sec = 'oci'; return { header: sec }; }
      if (sec === 'attr_pat' || sec === 'attr_oci' || sec === 'attr_tci') {
        const who = /^(owners|equity holders|shareholders) of (the )?(company|parent|holding)|^owners of|^equity holders/.test(t) ? 'owners' : /^non[- ]?controlling interests?/.test(t) ? 'nci' : null;
        if (who) { const hit = PL.find(l => l.sec === sec && l.who === who); return { id: hit.id, sec }; }
      }
      if (sec === 'eps') {
        const hit = PL.find(l => l.sec === 'eps' && l.re.test(t));
        if (hit) return { id: hit.id, sec };
      }
      if (sec === 'ratios') {
        const hit = RT.find(l => l.re.test(t));
        if (hit) return { id: hit.id, sec };
        return { ratioText: raw };
      }
      // OCI tax rows say only "Income tax effects on above" / "Tax effect on above items": they belong to the item above
      if (/^(income tax|tax) effects? (on|relating to) (the )?above( items)?$|^income tax effects? on above$/.test(t)) {
        return lastOci ? { id: `${lastOci}_tax`, sec: 'oci' } : null;
      }
      for (const l of PL) {
        if (!l.re || l.sec === 'eps' || l.who) continue;
        if (l.re.test(t) && !(l.not && l.not.test(t))) {
          if (l.id === 'pl.oci_nr' || l.id === 'pl.oci_r') lastOci = l.id;
          if (l.sec === 'tax' || l.sec === 'oci') { /* keep context */ } else if (sec !== 'main' && !['attr_pat', 'attr_oci', 'attr_tci'].includes(sec)) sec = 'main';
          if (['attr_pat', 'attr_oci', 'attr_tci', 'eps'].includes(sec) && !l.bold && l.id !== 'pl.paidup' && l.id !== 'pl.oth_eq') continue;
          seen.add(l.id);
          return { id: l.id, sec };
        }
      }
      return null;
    },
  };
}

/** Note titles → the statement line they support (used when a note cannot be linked by its reference number) */
const NOTE_TITLES = [
  [/^revenue from operations/, 'pl.rev'], [/^other income/, 'pl.oth_inc'],
  [/^(operating expenses|cost of goods and services|cost of services)/, 'pl.exp_ops'], [/^employee benefits? expenses?/, 'pl.exp_emp'],
  [/^finance costs?/, 'pl.exp_fin'], [/^depreciation/, 'pl.exp_dep'], [/^other expenses/, 'pl.exp_oth'],
  [/^exceptional/, 'pl.exceptional'], [/^earnings? per share/, 'pl.eps_basic'],
  [/^non[- ]current investments?/, 'bs.nc_inv'], [/^current investments?|^investments? \(current\)/, 'bs.c_inv'],
  [/^trade receivables?/, 'bs.tr'], [/^cash (and|&) cash equivalents?/, 'bs.cash'], [/^(other bank balances?|bank balances? other)/, 'bs.obank'],
  [/^deferred tax assets?/, 'bs.dta'], [/^other non[- ]current assets/, 'bs.nc_other'], [/^current tax assets?/, 'bs.cta'],
  [/^other current assets/, 'bs.c_other'], [/^(equity )?share capital/, 'bs.share_cap'], [/^other equity/, 'bs.oth_eq'],
  [/^trade payables?/, 'bs.cl_tp_other'], [/^other current liabilit/, 'bs.cl_other'],
  [/^property,? plant/, 'bs.ppe'], [/^capital work/, 'bs.cwip'], [/^right[- ]of[- ]use/, 'bs.rou'], [/^(other )?intangible assets?$/, 'bs.intang'],
];
function lineForNoteTitle(title) {
  const t = norm(title);
  for (const [re, id] of NOTE_TITLES) if (re.test(t)) return id;
  return null;
}

module.exports = { PL, RT, BS, CF, ALL, BY_ID, STATEMENT_OF, norm, slug, matcher, lineForNoteTitle };
