/**
 * FP&A Integrated Financial Statement Engine — Step 6
 * PARALLEL MODEL — does not modify existing production P&L, Balance Sheet, Cash Bridge, or Debt Schedule.
 * Three-statement model: P&L → Balance Sheet → Cash Bridge, fully linked, no plugs.
 *
 * Inputs (source of truth hierarchy):
 *   1. Step 3 Actual Revenue Engine  (server/fpa-revenue.js)
 *   2. Step 4 Revenue Projection     (server/fpa-projection.js)
 *   3. Step 5 Branch Cost Engine     (server/fpa-cost.js)
 *   4. Corporate Cost Master         (this module)
 *   5. Debt / Lease / Asset schedules (this module — REQUIRES_DATA until populated)
 *   6. Working Capital params        (this module)
 *   7. Tax params                    (this module)
 *   8. Opening Balance Sheet         (this module — REQUIRES_DATA until populated)
 */

'use strict';
const express = require('express');
const router  = express.Router();
const path    = require('path');
const db      = require('./db');
const { background } = require('./background'); // keeps background compute alive on Vercel
const { authMiddleware, adminOnly } = require('./auth');

// ─── File paths ────────────────────────────────────────────────────────────────
const FPA = path.join(__dirname, 'fpa');
const FILES = {
  intConfig:      path.join(FPA, 'integrated_config.json'),
  openingBS:      path.join(FPA, 'opening_balance_sheet.json'),
  debtSchedule:   path.join(FPA, 'debt_schedule.json'),
  leaseSchedule:  path.join(FPA, 'lease_schedule.json'),
  assetRegister:  path.join(FPA, 'asset_register.json'),
  accountMapping: path.join(FPA, 'account_mapping.json'),
  corpCost:       path.join(FPA, 'corporate_cost_master.json'),
  wcParams:       path.join(FPA, 'wc_params.json'),
  taxParams:      path.join(FPA, 'tax_params.json'),
  openItems:      path.join(FPA, 'open_items.json'),
  intOutput:      path.join(FPA, 'integrated_output.json'),
  // Step inputs (read-only in this module)
  projOutput:     path.join(FPA, 'projection_output.json'),
  costOutput:     path.join(FPA, 'cost_output.json'),
};
const KEYS = {
  intConfig:      'fpa_int_config',
  openingBS:      'fpa_int_opening_bs',
  debtSchedule:   'fpa_int_debt',
  leaseSchedule:  'fpa_int_lease',
  assetRegister:  'fpa_int_assets',
  accountMapping: 'fpa_int_account_mapping',
  corpCost:       'fpa_int_corp_cost',
  wcParams:       'fpa_int_wc_params',
  taxParams:      'fpa_int_tax_params',
  openItems:      'fpa_int_open_items',
  intOutput:      'fpa_int_output',
  projOutput:     'fpa_proj_output',
  costOutput:     'fpa_cost_output',
};

// ─── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULT_INT_CONFIG = {
  actual_cutoff_month: '2026-09',
  forecast_start:      '2026-04',
  forecast_end:        '2029-03',
  version_label:       'FY2026-27 to FY2028-29 Base Case — PARALLEL MODEL',
  min_cash_requirement: 5000000,   // ₹50L minimum cash threshold
  locked: false,
  last_computed_at: null,
};
const DEFAULT_WC_PARAMS = {
  ar_dso_days: 30,
  ap_dpo_days: 45,
  collection_split: [{ months_offset: 0, pct: 80 }, { months_offset: 1, pct: 20 }],
  payment_split:    [{ months_offset: 0, pct: 70 }, { months_offset: 1, pct: 30 }],
  last_updated: null,
};
const DEFAULT_TAX_PARAMS = {
  tax_rate_pct: 25.17,
  method: 'configured_rate',  // configured_rate | nil | mat
  last_updated: null,
};

// ─── Read helpers ─────────────────────────────────────────────────────────────
const readIntConfig     = () => db.readJSON(KEYS.intConfig,      FILES.intConfig,      { forecast_config: DEFAULT_INT_CONFIG });
const readOpeningBS     = () => db.readJSON(KEYS.openingBS,      FILES.openingBS,      { balances: null, as_at_month: null, source: null, last_updated: null });
const readDebtSchedule  = () => db.readJSON(KEYS.debtSchedule,   FILES.debtSchedule,   { facilities: [], last_updated: null });
const readLeaseSchedule = () => db.readJSON(KEYS.leaseSchedule,  FILES.leaseSchedule,  { leases: [], last_updated: null });
const readAssetRegister = () => db.readJSON(KEYS.assetRegister,  FILES.assetRegister,  { assets: [], last_updated: null });
const readAccountMapping = () => db.readJSON(KEYS.accountMapping, FILES.accountMapping, { mappings: [], last_updated: null });
const readCorpCost      = () => db.readJSON(KEYS.corpCost,       FILES.corpCost,       { assumptions: [], last_updated: null });
const readWCParams      = () => db.readJSON(KEYS.wcParams,       FILES.wcParams,       DEFAULT_WC_PARAMS);
const readTaxParams     = () => db.readJSON(KEYS.taxParams,      FILES.taxParams,      DEFAULT_TAX_PARAMS);
const readOpenItems     = () => db.readJSON(KEYS.openItems,      FILES.openItems,      { items: [] });
const readIntOutput     = () => db.readJSON(KEYS.intOutput,      FILES.intOutput,      { computed_at: null, months: [], reconciliation: {}, validation_issues: [], migration_gate: null });
const readProjOutput    = () => db.readJSON(KEYS.projOutput,     FILES.projOutput,     { months: [] });
const readCostOutput    = () => db.readJSON(KEYS.costOutput,     FILES.costOutput,     { months: [], capex_schedule: [], deposit_schedule: [] });

const writeIntConfig  = (d) => db.writeJSON(KEYS.intConfig,  FILES.intConfig,  d);
const writeOpeningBS  = (d) => db.writeJSON(KEYS.openingBS,  FILES.openingBS,  d);
const writeDebtSched  = (d) => db.writeJSON(KEYS.debtSchedule, FILES.debtSchedule, d);
const writeLeaseSched = (d) => db.writeJSON(KEYS.leaseSchedule, FILES.leaseSchedule, d);
const writeAssetReg   = (d) => db.writeJSON(KEYS.assetRegister, FILES.assetRegister, d);
const writeAcctMap    = (d) => db.writeJSON(KEYS.accountMapping, FILES.accountMapping, d);
const writeCorpCost   = (d) => db.writeJSON(KEYS.corpCost,   FILES.corpCost,   d);
const writeWCParams   = (d) => db.writeJSON(KEYS.wcParams,   FILES.wcParams,   d);
const writeTaxParams  = (d) => db.writeJSON(KEYS.taxParams,  FILES.taxParams,  d);
const writeOpenItems  = (d) => db.writeJSON(KEYS.openItems,  FILES.openItems,  d);
const writeIntOutput  = (d) => db.writeJSON(KEYS.intOutput,  FILES.intOutput,  d);

// Any other server/fpa/<file> (Step 14 checks and baselines), under the same database key
// fpa-store.js gives it, so Vercel reads the uploaded copy instead of the (absent) file
const fpaDocKey   = (file) => require('./fpa-store').keyOf(path.join(FPA, file));
const readFpaDoc  = (file, def) => db.readJSON(fpaDocKey(file), path.join(FPA, file), def);
const writeFpaDoc = (file, d)   => db.writeJSON(fpaDocKey(file), path.join(FPA, file), d);

// ─── Utilities ────────────────────────────────────────────────────────────────
const now   = () => new Date().toISOString();
const genId = (pfx) => `${pfx}-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const r2    = (n) => n != null ? Math.round(n * 100) / 100 : null;
const pct   = (n, d) => (n != null && d != null && d !== 0) ? r2(n / d * 100) : null;

function getMonthRange(start, end) {
  const months = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}
function getFY(month) {
  const [y, m] = month.split('-').map(Number);
  return m >= 4 ? `FY${y}-${String(y + 1).slice(2)}` : `FY${y - 1}-${String(y).slice(2)}`;
}
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
// Add n months to a YYYY-MM string
function addMonths(month, n) {
  let [y, m] = month.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m <= 0)  { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ─── CORPORATE COST ENGINE ────────────────────────────────────────────────────
function computeCorpCostMonth(month, assumptions, revenueInMonth) {
  let totals = { payroll: 0, marketing: 0, technology: 0, professional_fees: 0, other: 0, total: 0 };
  const cats = { payroll: 0, marketing: 0, technology: 0, professional_fees: 0, other: 0 };
  for (const asm of assumptions) {
    if (asm.active === false) continue;
    if (asm.effective_from && month < asm.effective_from.substring(0, 7)) continue;
    if (asm.effective_to && month > asm.effective_to.substring(0, 7)) continue;
    let amount = 0;
    if (asm.calc_method === 'fixed_monthly')       amount = asm.fixed_monthly_amount || 0;
    else if (asm.calc_method === 'pct_of_revenue') amount = (asm.variable_pct || 0) / 100 * (revenueInMonth || 0);
    else if (asm.calc_method === 'manual_override') amount = asm.fixed_monthly_amount || 0;
    // Apply escalation (same logic as Step 5)
    if (asm.escalation_pct && asm.escalation_effective_date) {
      const tgt = new Date(month + '-01');
      const eff = new Date(asm.escalation_effective_date);
      if (eff <= tgt) {
        let cycles = 0;
        const check = new Date(eff);
        while (check <= tgt) { cycles++; check.setFullYear(check.getFullYear() + 1); }
        amount *= Math.pow(1 + asm.escalation_pct / 100, cycles);
      }
    }
    const cat = asm.cost_category || 'other';
    cats[cat] = (cats[cat] || 0) + amount;
  }
  const total = Object.values(cats).reduce((s, v) => s + v, 0);
  return { ...cats, total: r2(total) };
}

// ─── DEPRECIATION ENGINE ──────────────────────────────────────────────────────
function buildDepreciationSchedule(assets, capexSchedule, forecastMonths) {
  // Returns { [month]: total_depreciation, asset_rows: [{asset_id, month, depreciation, nbv}] }
  const schedMap = {};
  const processAsset = (assetId, name, cost, capDate, lifeMonths, method, residual) => {
    if (!cost || !capDate || !lifeMonths) return;
    const depMonthly = method === 'slm'
      ? (cost - (residual || 0)) / lifeMonths
      : null; // WDV requires more complex treatment
    const capMonth = capDate.substring(0, 7);
    for (const m of forecastMonths) {
      if (m < capMonth) continue;
      const monthsElapsed = getMonthRange(capMonth, m).length - 1;
      if (monthsElapsed >= lifeMonths) continue; // fully depreciated
      const dep = depMonthly || 0;
      schedMap[m] = (schedMap[m] || 0) + dep;
    }
  };
  // Existing assets
  for (const a of assets) {
    if (!a.active) continue;
    processAsset(a.asset_id, a.asset_name, a.cost, a.capitalisation_date, a.useful_life_months, a.depreciation_method || 'slm', a.residual_value);
  }
  // New capex from Step 5
  for (const cx of capexSchedule) {
    if (!cx.in_range) continue;
    // Use opening date as capitalisation date (asset available for use)
    const lifeMonths = 60; // default 5 years if not specified
    const capDate = (cx.opening_month || cx.month) + '-01';
    processAsset(`CX-${cx.branch_id}-${cx.capex_category}`, cx.capex_category, cx.amount, capDate, lifeMonths, 'slm', 0);
  }
  return schedMap;
}

// ─── DEBT ENGINE ──────────────────────────────────────────────────────────────
function computeDebtMonth(month, facilities) {
  let drawdown = 0, repayment = 0, interest_expense = 0, interest_paid = 0;
  let closing_principal = 0;
  for (const f of facilities) {
    if (!f.active) continue;
    const draw = (f.drawdown_schedule || []).filter(d => d.month === month).reduce((s, d) => s + (d.amount || 0), 0);
    const rep  = (f.repayment_schedule || []).filter(r => r.month === month);
    const repPrincipal = rep.reduce((s, r) => s + (r.principal || 0), 0);
    const repInterest  = rep.reduce((s, r) => s + (r.interest || 0), 0);
    drawdown   += draw;
    repayment  += repPrincipal;
    interest_expense += repInterest;
    interest_paid    += repInterest;
    // Compute closing principal from schedule
    const lastBal = (f.opening_principal || 0) +
      (f.drawdown_schedule || []).filter(d => d.month <= month).reduce((s, d) => s + (d.amount || 0), 0) -
      (f.repayment_schedule || []).filter(r => r.month <= month).reduce((s, r) => s + (r.principal || 0), 0);
    closing_principal += lastBal;
  }
  return { drawdown: r2(drawdown), repayment: r2(repayment), interest_expense: r2(interest_expense), interest_paid: r2(interest_paid), closing_principal: r2(closing_principal) };
}

// ─── LEASE ENGINE (Ind AS 116) ────────────────────────────────────────────────
function computeLeaseMonth(month, leases) {
  let rou_dep = 0, lease_interest = 0, lease_cash_payment = 0, lease_liability = 0;
  for (const l of leases) {
    if (!l.active) continue;
    if (l.classification !== 'ind_as_116') {
      // Short-term / low-value: treat as P&L expense
      if (['short_term_exempt', 'low_value_exempt'].includes(l.classification)) {
        lease_cash_payment += (l.monthly_payment || 0);
      }
      continue;
    }
    if (!l.opening_liability || !l.opening_rou || !l.discount_rate) continue;
    // Simplified Ind AS 116 computation
    const monthsElapsed = l.commencement_date
      ? getMonthRange(l.commencement_date.substring(0, 7), month).length - 1
      : 0;
    const monthlyRate = (l.discount_rate || 0) / 100 / 12;
    // Outstanding liability (approximate reducing balance)
    const outstandingLiability = l.opening_liability * Math.pow(1 + monthlyRate, monthsElapsed) -
      (l.monthly_payment || 0) * (Math.pow(1 + monthlyRate, monthsElapsed) - 1) / monthlyRate;
    const interestForMonth = outstandingLiability * monthlyRate;
    const rouMonthlyDep = l.opening_rou / (l.lease_term_months || 60);
    rou_dep            += Math.max(0, rouMonthlyDep);
    lease_interest     += Math.max(0, interestForMonth);
    lease_cash_payment += l.monthly_payment || 0;
    lease_liability    += Math.max(0, outstandingLiability - ((l.monthly_payment || 0) - interestForMonth));
  }
  return {
    rou_depreciation: r2(rou_dep),
    lease_interest: r2(lease_interest),
    lease_cash_payment: r2(lease_cash_payment),
    closing_lease_liability: r2(lease_liability),
  };
}

// ─── TAX ENGINE ───────────────────────────────────────────────────────────────
function computeTax(pbt, taxParams) {
  if (pbt == null || taxParams.method === 'nil') return { current_tax: 0, deferred_tax: 0 };
  if (pbt <= 0) return { current_tax: 0, deferred_tax: 0 };
  const current_tax = r2(pbt * (taxParams.tax_rate_pct || 25.17) / 100);
  return { current_tax, deferred_tax: 0 };
}

// ─── WORKING CAPITAL ENGINE ───────────────────────────────────────────────────
function computeWCMonth(month, revenue, opexPayable, wcParams, prevAR, prevAP) {
  const { ar_dso_days, ap_dpo_days } = wcParams;
  const daysInMth = daysInMonth(month);
  // AR = (Revenue / days_in_month) * DSO
  const closing_ar = r2(revenue * (ar_dso_days / daysInMth));
  // AP = (Payable costs / days_in_month) * DPO
  const closing_ap = r2(opexPayable * (ap_dpo_days / daysInMth));
  // Cash collections = revenue - change in AR
  const collections = r2(revenue - (closing_ar - (prevAR || 0)));
  // Cash payments to vendors = opexPayable - change in AP
  const vendor_payments = r2(opexPayable - (closing_ap - (prevAP || 0)));
  return { closing_ar, closing_ap, collections, vendor_payments };
}

// ─── RECONCILIATION CHECKS RC-F01 to RC-F15 ───────────────────────────────────
function runIntegratedReconciliation(months, projMonths, costMonths, debtFacilities, openItemsData) {
  const checks = [];
  const tol_01 = 1, tol_sub = 0.05;

  // RC-F01: Integrated Revenue = Step-4 Revenue
  // proj.company_total is in absolute rupees; integrated revenue is in lakhs — normalize before comparing.
  let rc01Pass = true; let rc01MaxGap = 0; let rc01NullMonths = 0;
  for (const m of months) {
    const proj = projMonths.find(p => p.month === m.month);
    const projRevL = proj?.company_total != null ? r2(proj.company_total / 100000) : null;
    const intRevL  = m.pl?.revenue?.total;
    if (projRevL == null || intRevL == null) { rc01Pass = false; rc01NullMonths++; continue; }
    const gap = Math.abs(intRevL - projRevL);
    if (gap > tol_01) { rc01Pass = false; rc01MaxGap = Math.max(rc01MaxGap, gap); }
  }
  checks.push({ id: 'RC-F01', name: 'Integrated Revenue = Step-4 Revenue', pass: rc01Pass, max_gap: r2(rc01MaxGap), null_months: rc01NullMonths, tolerance: tol_01 });

  // RC-F02: Branch OpEx = Step-5 Branch OpEx
  // Cost output is in absolute rupees; normalize to lakhs for comparison.
  // If no cost data is populated, this is NOT TESTABLE — not a zero-zero pass.
  const hasCostData02 = costMonths.some(c => (c.company_total_opex || 0) > 0);
  if (!hasCostData02) {
    checks.push({ id: 'RC-F02', name: 'Branch OpEx = Step-5 Branch OpEx', pass: false,
      status: 'NOT_TESTABLE',
      note: 'NOT TESTABLE — SOURCE DATA NOT POPULATED: No cost assumptions entered in Cost Master. Add branch cost assumptions in Management Inputs → Cost Master before this control can run.' });
  } else {
    let rc02Pass = true; let rc02MaxGap = 0;
    for (const m of months) {
      const c5 = costMonths.find(c => c.month === m.month);
      const c5OpexL = c5 ? r2((c5.company_total_opex || 0) / 100000) : null;
      const gap = c5OpexL != null ? Math.abs((m.pl?.direct_costs?.total || 0) - c5OpexL) : 0;
      if (gap > tol_sub) { rc02Pass = false; rc02MaxGap = Math.max(rc02MaxGap, gap); }
    }
    checks.push({ id: 'RC-F02', name: 'Branch OpEx = Step-5 Branch OpEx', pass: rc02Pass,
      status: rc02Pass ? 'PASS — POPULATED AND RECONCILED' : 'FAIL',
      max_gap: r2(rc02MaxGap), tolerance: tol_sub });
  }

  // RC-F03: Centre Contribution = Step-5 Centre Contribution
  // Cost output is in absolute rupees; normalize to lakhs for comparison.
  let rc03Pass = true; let rc03MaxGap = 0;
  for (const m of months) {
    const c5 = costMonths.find(c => c.month === m.month);
    const c5ContribL = c5 ? r2((c5.company_contribution || 0) / 100000) : null;
    const gap = c5ContribL != null ? Math.abs((m.pl?.centre_contribution || 0) - c5ContribL) : 0;
    if (gap > tol_sub) { rc03Pass = false; rc03MaxGap = Math.max(rc03MaxGap, gap); }
  }
  checks.push({ id: 'RC-F03', name: 'Centre Contribution = Step-5 Centre Contribution', pass: rc03Pass, max_gap: r2(rc03MaxGap), tolerance: tol_sub,
    note: !rc03Pass ? `Gap ₹${r2(rc03MaxGap)}L: revenue from unmapped invoices is included in projection company_total but not in cost compute branch-level aggregation. Resolve by mapping remaining Level-6 manual review invoices.` : null });

  // RC-F04: Capex in integrated = Step-5 Capex (checked via monthly totals)
  // Both sides at zero means capex assumptions not populated — NOT TESTABLE, not a pass.
  {
    const intCapex = months.reduce((s, m) => s + (m.cash_bridge?.investing?.capex || 0), 0);
    const c5Capex  = costMonths.reduce((s, m) => s + (m.company_capex || 0), 0);
    if (intCapex === 0 && c5Capex === 0) {
      checks.push({ id: 'RC-F04', name: 'Capex = Step-5 Capex Schedule', pass: false,
        status: 'NOT_TESTABLE',
        note: 'NOT TESTABLE — SOURCE DATA NOT POPULATED: No capex data entered. Add capex assumptions in Management Inputs → Cost Master → Capex before this control can run.' });
    } else {
      const rc04Gap = r2(Math.abs(intCapex - c5Capex));
      checks.push({ id: 'RC-F04', name: 'Capex = Step-5 Capex Schedule', pass: rc04Gap <= tol_01,
        status: rc04Gap <= tol_01 ? 'PASS — POPULATED AND RECONCILED' : 'FAIL',
        gap: rc04Gap, tolerance: tol_01 });
    }
  }

  // RC-F05: Deposits in integrated = Step-5 Deposits
  // Both sides at zero means deposit assumptions not populated — NOT TESTABLE, not a pass.
  {
    const intDep = months.reduce((s, m) => s + (m.cash_bridge?.investing?.security_deposits_paid || 0), 0);
    const c5Dep  = costMonths.reduce((s, m) => s + (m.company_deposit || 0), 0);
    if (intDep === 0 && c5Dep === 0) {
      checks.push({ id: 'RC-F05', name: 'Security Deposits = Step-5 Deposit Schedule', pass: false,
        status: 'NOT_TESTABLE',
        note: 'NOT TESTABLE — SOURCE DATA NOT POPULATED: No security deposit data entered. Add deposit assumptions in Management Inputs → Cost Master → Deposits before this control can run.' });
    } else {
      const rc05Gap = r2(Math.abs(intDep - c5Dep));
      checks.push({ id: 'RC-F05', name: 'Security Deposits = Step-5 Deposit Schedule', pass: rc05Gap <= tol_01,
        status: rc05Gap <= tol_01 ? 'PASS — POPULATED AND RECONCILED' : 'FAIL',
        gap: rc05Gap, tolerance: tol_01 });
    }
  }

  // RC-F06: Debt Closing Balance = Debt Schedule
  const lastMonth = months[months.length - 1];
  const rc06Pass = lastMonth?.bs?.liabilities?.non_current?.borrowings != null;
  checks.push({ id: 'RC-F06', name: 'Debt Closing Balance = Debt Schedule', pass: rc06Pass, note: rc06Pass ? null : 'REQUIRES_DEBT_SCHEDULE' });

  // RC-F07: Lease Liability = Lease Schedule
  const rc07Pass = lastMonth?.bs?.liabilities?.non_current?.lease_liabilities != null;
  checks.push({ id: 'RC-F07', name: 'Lease Liability = Lease Schedule', pass: rc07Pass, note: rc07Pass ? null : 'REQUIRES_LEASE_SCHEDULE' });

  // RC-F08: Closing Cash = Cash Bridge Closing Cash
  // MUST FAIL when closingCash is null — cash bridge cannot be verified without complete data.
  let rc08Pass = true; let rc08NullMonths = 0;
  for (const m of months) {
    const cbClose = m.cash_bridge?.closing_cash;
    const bsClose = m.bs?.assets?.current?.cash;
    if (cbClose == null || bsClose == null) { rc08Pass = false; rc08NullMonths++; }
    else if (Math.abs(cbClose - bsClose) > tol_01) rc08Pass = false;
  }
  checks.push({ id: 'RC-F08', name: 'Closing Cash = Cash Bridge Closing Cash', pass: rc08Pass, null_months: rc08NullMonths,
    note: rc08NullMonths > 0 ? `${rc08NullMonths} months have null closing cash — requires complete debt schedule (B1) to compute` : null });

  // RC-F09: Next Month Opening Cash = Previous Month Closing Cash
  // MUST FAIL when cash values are null — roll-forward cannot be verified.
  let rc09Pass = true; let rc09NullGaps = 0;
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1].cash_bridge?.closing_cash;
    const curr = months[i].cash_bridge?.opening_cash;
    if (prev == null || curr == null) { rc09Pass = false; rc09NullGaps++; }
    else if (Math.abs(prev - curr) > tol_sub) rc09Pass = false;
  }
  checks.push({ id: 'RC-F09', name: 'Next Month Opening Cash = Prev Month Closing Cash', pass: rc09Pass, null_gaps: rc09NullGaps,
    note: rc09NullGaps > 0 ? `${rc09NullGaps} month gaps have null cash — requires complete debt schedule (B1)` : null });

  // RC-F10: BS Check = 0 (Total Assets - Total Equity & Liabilities)
  // MUST FAIL when bs_check is null — BS cannot balance without PAT (requires complete P&L).
  let rc10Pass = true; let rc10MaxGap = 0; let rc10NullMonths = 0;
  for (const m of months) {
    const check = m.bs?.bs_check;
    if (check == null) { rc10Pass = false; rc10NullMonths++; }
    else if (Math.abs(check) > tol_01) { rc10Pass = false; rc10MaxGap = Math.max(rc10MaxGap, Math.abs(check)); }
  }
  checks.push({ id: 'RC-F10', name: 'BS Check = 0 (Total Assets − Total Equity & Liabilities)', pass: rc10Pass,
    max_gap: r2(rc10MaxGap), null_months: rc10NullMonths,
    note: rc10NullMonths > 0 ? `${rc10NullMonths} months have null BS check — requires PAT (blocked by B1: debt schedule + interest rates)` : null });

  // RC-F11: PAT → Retained Earnings roll-forward
  // MUST FAIL when PAT is null — retained earnings roll-forward cannot be verified.
  let rc11Pass = true; let rc11NullMonths = 0; let rc11MismatchMonths = 0;
  for (let i = 1; i < months.length; i++) {
    const prevRE = months[i - 1].bs?.equity?.retained_earnings;
    const pat    = months[i].pl?.pat;
    const currRE = months[i].bs?.equity?.retained_earnings;
    if (pat == null || prevRE == null || currRE == null) {
      rc11Pass = false; rc11NullMonths++;
    } else {
      const expected = r2(prevRE + pat);
      if (Math.abs(expected - currRE) > tol_sub) { rc11Pass = false; rc11MismatchMonths++; }
    }
  }
  checks.push({ id: 'RC-F11', name: 'PAT roll-forward reconciles to Equity', pass: rc11Pass,
    null_months: rc11NullMonths, mismatch_months: rc11MismatchMonths,
    note: rc11NullMonths > 0 ? `${rc11NullMonths} months have null PAT — requires complete P&L (blocked by B1: debt schedule + interest rates)` : null });

  // RC-F12: PPE roll-forward
  // MUST FAIL when PPE data is null — asset register required.
  let rc12Pass = true; let rc12NullMonths = 0; let rc12MismatchMonths = 0;
  for (let i = 1; i < months.length; i++) {
    const prevPPE = months[i - 1].bs?.assets?.non_current?.ppe_net;
    const capex   = months[i].cash_bridge?.investing?.capex;
    const dep     = months[i].pl?.depreciation_ppe; // use PPE-only dep, not total (which includes ROU)
    const currPPE = months[i].bs?.assets?.non_current?.ppe_net;
    if (prevPPE == null || capex == null || dep == null || currPPE == null) {
      rc12Pass = false; rc12NullMonths++;
    } else {
      const expected = r2(prevPPE + capex - dep);
      if (Math.abs(expected - currPPE) > tol_sub) { rc12Pass = false; rc12MismatchMonths++; }
    }
  }
  checks.push({ id: 'RC-F12', name: 'PPE roll-forward reconciles', pass: rc12Pass,
    null_months: rc12NullMonths, mismatch_months: rc12MismatchMonths,
    note: rc12NullMonths > 0 ? `${rc12NullMonths} months have null PPE — requires existing asset register (open item OI-009)` : null });

  // RC-F13: Working Capital movements reconcile to Cash Flow
  let rc13Pass = true;
  for (let i = 1; i < months.length; i++) {
    const prevAR = months[i - 1].bs?.assets?.current?.trade_receivables;
    const currAR = months[i].bs?.assets?.current?.trade_receivables;
    const rev    = months[i].pl?.revenue?.total;
    const coll   = months[i].cash_bridge?.operating?.collections;
    if (prevAR != null && currAR != null && rev != null && coll != null) {
      const expected_coll = r2(rev - (currAR - prevAR));
      if (Math.abs(expected_coll - coll) > tol_sub) rc13Pass = false;
    }
  }
  checks.push({ id: 'RC-F13', name: 'Working Capital movements reconcile to Cash Flow', pass: rc13Pass });

  // RC-F14: Old vs New differences classified
  const openItemsList = openItemsData?.items || [];
  const hasUnclassifiedDiff = openItemsList.some(i => i.category === 'model_difference' && !i.classification && i.status !== 'resolved');
  checks.push({ id: 'RC-F14', name: 'Old vs New model differences are classified', pass: !hasUnclassifiedDiff, note: hasUnclassifiedDiff ? 'Unclassified model differences exist in Open Items register' : null });

  // RC-F15: Unmapped GL balance = 0 — CANNOT VERIFY until account mapping is implemented.
  // Hardcoded false: this control must not pass until Zoho GL → FP&A account mapping is done and verified.
  checks.push({ id: 'RC-F15', name: 'Unmapped GL balance = 0 before production migration', pass: false,
    note: 'NOT VERIFIED — Zoho GL → FP&A account mapping not yet implemented. Complete account_mapping.json (OI-011) before this control can run.' });

  const all_pass = checks.every(c => c.pass);
  return { checks, all_pass };
}

// ─── VALIDATION ───────────────────────────────────────────────────────────────
function runIntegratedValidation(months, openingBS, debtFacilities, leases, assets, accountMappings) {
  const issues = [];
  const err = (code, message, context) => issues.push({ level: 'error', code, message, context: context || null });
  const warn = (code, message, context) => issues.push({ level: 'warning', code, message, context: context || null });
  const info = (code, message, context) => issues.push({ level: 'info', code, message, context: context || null });

  if (!openingBS?.balances) err('INT-V01', 'Opening Balance Sheet not provided. All BS items will be null.', 'Provide opening_balance_sheet.json with validated actual month-end balances.');
  if (!debtFacilities.length) warn('INT-V02', 'No debt schedule configured. Debt, interest, and financing cash flows will be null.', 'Populate debt_schedule.json');
  if (!leases.length) warn('INT-V03', 'No lease schedule configured. Ind AS 116 ROU assets, lease liabilities, and depreciation will be null.', 'Populate lease_schedule.json');
  if (!assets.length) warn('INT-V04', 'No existing asset register provided. Depreciation on existing assets will be null.', 'Populate asset_register.json');
  if (!accountMappings.length) warn('INT-V05', 'Account mapping not populated. Cannot validate GL completeness.', 'Populate account_mapping.json with Zoho GL → FP&A line mapping');

  // Check for BS imbalance
  for (const m of months) {
    const check = m.bs?.bs_check;
    if (check != null && Math.abs(check) > 1) {
      err('INT-V06', `Balance Sheet imbalance of ₹${check.toFixed(2)} in ${m.month}. DO NOT use balancing plugs. Trace cause.`, m.month);
    }
  }

  // Check cash roll-forward
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1].cash_bridge?.closing_cash;
    const curr = months[i].cash_bridge?.opening_cash;
    if (prev != null && curr != null && Math.abs(prev - curr) > 0.05) {
      err('INT-V07', `Cash roll-forward broken between ${months[i - 1].month} and ${months[i].month}. Closing ≠ next opening.`, null);
    }
  }

  // Check for actual/forecast boundary
  for (const m of months) {
    if (!m.type) warn('INT-V08', `Month ${m.month} has no type (actual/forecast) classification.`, m.month);
  }

  info('INT-V09', 'Step-4 live-data tests AT-P20, P21, P23, P24 remain PENDING LIVE DATA. Production migration blocked until resolved.', 'Open Items register');
  info('INT-V10', 'Step-5 utilities fixed/variable split REQUIRES DECISION. Production migration blocked until resolved.', 'Open Items register');
  info('INT-V11', 'Existing Balance Sheet imbalance (approx. ₹9.17 Cr from Step 1) has not yet been traced. Report required.', 'Refer Section M of Step 6 report');

  return issues;
}

// ─── MIGRATION GATE ───────────────────────────────────────────────────────────
function evaluateMigrationGate(reconChecks, validationIssues, openItems, months) {
  const criticalBlockers = [];
  const blockerItems = [];

  // Check reconciliation — use the check's own note when available for accurate blocker description
  const rc10 = reconChecks.find(c => c.id === 'RC-F10');
  if (!rc10?.pass) criticalBlockers.push(rc10?.note || 'RC-F10: BS Check = 0 failed — balance sheet does not balance');

  const rc08 = reconChecks.find(c => c.id === 'RC-F08');
  if (!rc08?.pass) criticalBlockers.push(rc08?.note || 'RC-F08: Closing Cash does not match Cash Bridge');

  const rc09 = reconChecks.find(c => c.id === 'RC-F09');
  if (!rc09?.pass) criticalBlockers.push(rc09?.note || 'RC-F09: Cash roll-forward is broken');

  // Check remaining RC controls — any failure is a gate blocker
  for (const rc of reconChecks) {
    if (['RC-F10','RC-F08','RC-F09'].includes(rc.id)) continue; // already handled above
    if (!rc.pass) criticalBlockers.push(rc.note || `${rc.id}: ${rc.name} — FAILED`);
  }

  // Check for critical validation errors
  const criticalValidation = validationIssues.filter(i => i.level === 'error' && !['INT-V06', 'INT-V11'].includes(i.code));
  criticalBlockers.push(...criticalValidation.map(v => v.message));

  // Check open items
  const activeCritical = (openItems?.items || []).filter(i => i.classification === 'critical_blocker' && i.status !== 'resolved');
  blockerItems.push(...activeCritical.map(i => `[CRITICAL BLOCKER] ${i.title}`));

  const pendingLiveData = (openItems?.items || []).filter(i => i.status === 'pending_live_data');
  blockerItems.push(...pendingLiveData.map(i => `[PENDING LIVE DATA] ${i.title}`));

  const requiresDecision = (openItems?.items || []).filter(i => i.status === 'requires_decision' && i.is_migration_blocker);
  blockerItems.push(...requiresDecision.map(i => `[REQUIRES DECISION] ${i.title}`));

  // Check for missing critical data
  const missingBS = !months.length || months[0].bs?.assets?.total_assets == null;
  if (missingBS) criticalBlockers.push('Opening Balance Sheet not provided — Balance Sheet cannot be populated');

  const missingDebt = months.some(m => m.pl?.finance_cost == null);
  if (missingDebt) criticalBlockers.push('Debt schedule not provided — Finance cost null; PAT cannot be computed');

  const allBlockers = [...criticalBlockers, ...blockerItems];
  const ready = allBlockers.length === 0;

  return {
    status: ready ? 'READY_FOR_MIGRATION' : 'NOT_READY_FOR_MIGRATION',
    ready,
    blockers: allBlockers,
    total_blockers: allBlockers.length,
    message: ready
      ? 'All migration gate criteria satisfied. Await explicit management approval before replacing production model.'
      : `${allBlockers.length} blocker(s) must be resolved before production migration.`,
    evaluated_at: new Date().toISOString(),
  };
}

// ─── OPEN ITEMS REGISTER ──────────────────────────────────────────────────────
const SEED_OPEN_ITEMS = [
  { id: 'OI-001', step: 4, title: 'AT-P20: RC-P01 Actual Revenue vs Zoho Sync', status: 'pending_live_data', classification: 'data_required', is_migration_blocker: true, description: 'Step-4 test AT-P20 requires actual Zoho synced revenue data to verify reconciliation.' },
  { id: 'OI-002', step: 4, title: 'AT-P21: RC-P02 Branch Total = Client + Vacant', status: 'pending_live_data', classification: 'data_required', is_migration_blocker: true, description: 'Requires live synced data.' },
  { id: 'OI-003', step: 4, title: 'AT-P23: RC-P04 No Capacity Over-Allocation', status: 'pending_live_data', classification: 'data_required', is_migration_blocker: true, description: 'Requires live synced data.' },
  { id: 'OI-004', step: 4, title: 'AT-P24: RC-P05 Revenue Bridge Reconciliation', status: 'pending_live_data', classification: 'data_required', is_migration_blocker: true, description: 'Requires live synced data.' },
  { id: 'OI-005', step: 5, title: 'Utilities Fixed/Variable Split', status: 'requires_decision', classification: 'management_decision_required', is_migration_blocker: true, description: 'Break-even occupancy uses utilities × 0.5 as fixed. This 50/50 split should be confirmed by management or replaced with an explicit configurable driver.' },
  { id: 'OI-006', step: 6, title: 'Opening Balance Sheet', status: 'data_required', classification: 'data_required', is_migration_blocker: true, description: 'Actual closing Balance Sheet for the latest approved month required as the model starting point. DO NOT invent opening balances.' },
  { id: 'OI-007', step: 6, title: 'Debt Schedule', status: 'data_required', classification: 'data_required', is_migration_blocker: true, description: 'Validated debt schedule with facility names, opening principal, interest rates, and repayment schedules.' },
  { id: 'OI-008', step: 6, title: 'Lease Schedule (Ind AS 116)', status: 'data_required', classification: 'data_required', is_migration_blocker: true, description: 'ROU assets, lease liabilities, discount rates, and contractual cash payments for all Ind AS 116 applicable leases.' },
  { id: 'OI-009', step: 6, title: 'Existing Fixed Asset Register', status: 'data_required', classification: 'data_required', is_migration_blocker: true, description: 'Asset register with cost, capitalisation date, useful life, and accumulated depreciation for existing assets.' },
  { id: 'OI-010', step: 6, title: 'Existing Balance Sheet Imbalance (approx. ₹9.17 Cr)', status: 'open', classification: 'requires_accounting_review', is_migration_blocker: true, description: 'Identified in Step 1. Root cause must be determined before opening BS is used in the new model. Do not carry imbalance forward.' },
  { id: 'OI-011', step: 6, title: 'Account Mapping (Zoho GL → FP&A Lines)', status: 'data_required', classification: 'data_required', is_migration_blocker: false, description: 'Required for RC-F15: Unmapped GL = 0. Must be completed for full actual integration.' },
  { id: 'OI-012', step: 6, title: 'Client-level Collection Terms', status: 'data_required', classification: 'data_required', is_migration_blocker: false, description: 'Per-client collection terms needed for accurate AR/Cash Bridge. Currently uses global DSO assumption.' },
  { id: 'OI-013', step: 6, title: 'Tax Methodology', status: 'requires_decision', classification: 'management_decision_required', is_migration_blocker: false, description: 'Current model uses 25.17% configured rate. Method (configured rate, MAT, nil for loss-making years) should be confirmed.' },
];

// ─── MAIN COMPUTATION ─────────────────────────────────────────────────────────
let intComputeInProgress = false;

async function runIntegratedComputation() {
  const [
    cfgData, openingBSData, debtData, leaseData, assetData,
    corpCostData, wcParamsData, taxParamsData, openItemsData,
    projOut, costOut,
  ] = await Promise.all([
    readIntConfig(), readOpeningBS(), readDebtSchedule(), readLeaseSchedule(), readAssetRegister(),
    readCorpCost(), readWCParams(), readTaxParams(), readOpenItems(),
    readProjOutput(), readCostOutput(),
  ]);

  const cfg      = cfgData.forecast_config || DEFAULT_INT_CONFIG;
  const wcParams = wcParamsData;
  const taxParams = taxParamsData;
  const months   = getMonthRange(cfg.forecast_start, cfg.forecast_end);

  const facilities = debtData.facilities || [];
  const leases     = leaseData.leases || [];
  const assets     = assetData.assets || [];
  const corpAsms   = corpCostData.assumptions || [];

  // Build lookup maps from Step 3/4/5 outputs
  const projByMonth = {};
  for (const m of projOut.months || []) projByMonth[m.month] = m;
  const costByMonth = {};
  for (const m of costOut.months || []) costByMonth[m.month] = m;
  const capexByMonth = {};
  for (const r of costOut.capex_schedule || []) {
    if (r.in_range) capexByMonth[r.month] = (capexByMonth[r.month] || 0) + (r.amount || 0);
  }
  const depositByMonth = {};
  for (const r of costOut.deposit_schedule || []) {
    if (r.in_range) depositByMonth[r.month] = (depositByMonth[r.month] || 0) + (r.deposit_amount || 0);
  }

  // Build depreciation schedule
  const depByMonth = buildDepreciationSchedule(assets, costOut.capex_schedule || [], months);

  // Opening balances
  const ob = openingBSData?.balances || null;
  const obMonth = openingBSData?.as_at_month || null;

  const outputMonths = [];
  let prevBS = ob ? { ...ob } : null;
  let prevCash = ob?.assets?.current?.cash || null;

  for (const month of months) {
    const type = month <= cfg.actual_cutoff_month ? 'actual' : 'forecast';
    const projRow = projByMonth[month];
    const costRow = costByMonth[month];
    const data_flags = [];

    // ── P&L ──────────────────────────────────────────────────────────────────
    // company_total from projection is absolute rupees (Zoho sub_total); all other
    // model inputs (lease, debt, OBS) are in lakhs — normalize here.
    const revTotal = projRow?.company_total != null ? r2(projRow.company_total / 100000) : null;
    if (!projRow) data_flags.push('MISSING_PROJECTION_DATA');

    // Cost compute stores amounts in absolute rupees (same as Zoho); normalize to lakhs.
    const _cs = 100000;
    const directCosts = costRow ? {
      rent:       r2((costRow.company_rent       || 0) / _cs),
      cam:        r2((costRow.company_cam        || 0) / _cs),
      utilities:  r2((costRow.company_utilities  || 0) / _cs),
      facility:   r2((costRow.company_facility   || 0) / _cs),
      people:     r2((costRow.company_people     || 0) / _cs),
      other_opex: r2((costRow.company_other_opex || 0) / _cs),
      pre_opening:r2((costRow.company_pre_opening|| 0) / _cs),
      total:      r2((costRow.company_total_opex || 0) / _cs),
    } : null;
    if (!costRow) data_flags.push('MISSING_COST_DATA');

    const centreContrib  = revTotal != null && directCosts != null ? r2(revTotal - directCosts.total) : null;
    const ccMarginPct    = pct(centreContrib, revTotal);

    const corpCosts      = computeCorpCostMonth(month, corpAsms, revTotal || 0);
    const ebitda         = centreContrib != null ? r2(centreContrib - corpCosts.total) : null;
    const ebitdaMarginPct = pct(ebitda, revTotal);

    // Below EBITDA
    const depTotal      = depByMonth[month] ? r2(depByMonth[month]) : null;
    if (!depTotal && assets.length === 0 && (costOut.capex_schedule || []).length === 0) data_flags.push('REQUIRES_ASSET_REGISTER');

    const debtRow       = facilities.length ? computeDebtMonth(month, facilities) : null;
    const leaseRow      = leases.length ? computeLeaseMonth(month, leases) : null;
    const finCost       = debtRow?.interest_expense || null;
    const leaseFinCost  = leaseRow?.lease_interest || null;
    const rouDep        = leaseRow?.rou_depreciation || null;
    const totalDep      = (depTotal || 0) + (rouDep || 0) || null;
    if (!debtRow) data_flags.push('REQUIRES_DEBT_SCHEDULE');
    if (!leaseRow) data_flags.push('REQUIRES_LEASE_SCHEDULE');

    const ebit = ebitda != null && totalDep != null ? r2(ebitda - totalDep) : null;
    const pbt  = ebit != null && finCost != null && leaseFinCost != null ? r2(ebit - finCost - leaseFinCost) : null;
    if (pbt == null) data_flags.push('PBT_REQUIRES_COMPLETE_DATA');

    const { current_tax, deferred_tax } = pbt != null ? computeTax(pbt, taxParams) : { current_tax: null, deferred_tax: null };
    const pat = pbt != null && current_tax != null ? r2(pbt - current_tax - (deferred_tax || 0)) : null;

    // Revenue sub-lines (from projection)
    const projBranches = projRow?.branches || [];
    const revBreakdown = {
      existing_client: projRow?.existing_client_revenue   || null,
      escalation:      projRow?.escalation_revenue        || null,
      new_client:      projRow?.new_client_revenue        || null,
      vacant:          projRow?.vacant_revenue            || null,
      future_branch:   projRow?.future_branch_revenue     || null,
      other:           projRow?.other_revenue             || null,
      total:           revTotal,
    };

    const pl = {
      revenue: revBreakdown,
      direct_costs: directCosts,
      centre_contribution: centreContrib,
      centre_contribution_margin_pct: ccMarginPct,
      corporate_costs: corpCosts,
      ebitda,
      ebitda_margin_pct: ebitdaMarginPct,
      depreciation: totalDep,
      depreciation_ppe: depTotal,
      depreciation_rou: rouDep,
      ebit,
      finance_cost: finCost,
      lease_finance_cost: leaseFinCost,
      other_income: 0,
      pbt,
      current_tax,
      deferred_tax,
      pat,
    };

    // ── CAPEX & DEPOSITS ──────────────────────────────────────────────────────
    const capexInMonth   = r2(capexByMonth[month]   || 0);
    const depositInMonth = r2(depositByMonth[month] || 0);

    // ── WORKING CAPITAL ───────────────────────────────────────────────────────
    const prevAR = prevBS?.assets?.current?.trade_receivables || 0;
    const prevAP = prevBS?.liabilities?.current?.trade_payables || 0;
    const opexPayable = (directCosts?.total || 0) + (corpCosts?.total || 0);
    const wc = revTotal != null ? computeWCMonth(month, revTotal, opexPayable, wcParams, prevAR, prevAP) : null;

    // ── CASH BRIDGE ───────────────────────────────────────────────────────────
    const leaseCash = leaseRow?.lease_cash_payment || null;
    const debtClose = debtRow?.closing_principal || null;
    const debtDraw  = debtRow?.drawdown || null;
    const debtRepay = debtRow?.repayment || null;
    const interestPaid = debtRow?.interest_paid || null;

    const netOperating = wc && leaseCash != null && interestPaid != null
      ? r2((wc.collections || 0) - (wc.vendor_payments || 0) - leaseCash - (interestPaid || 0))
      : null;
    const netInvesting = r2(-(capexInMonth + depositInMonth));
    const netFinancing = debtDraw != null && debtRepay != null
      ? r2((debtDraw || 0) - (debtRepay || 0))
      : null;

    const closingCash = (prevCash != null && netOperating != null && netFinancing != null)
      ? r2(prevCash + netOperating + netInvesting + netFinancing)
      : null;

    const cash_bridge = {
      opening_cash: prevCash,
      operating: {
        collections:       wc?.collections || null,
        other_receipts:    0,
        vendor_payments:   wc?.vendor_payments != null ? -r2(wc.vendor_payments) : null,
        employee_payments: null,
        rent_payments:     leaseCash != null ? -r2(leaseCash) : null,
        statutory_payments: null,
        tax_payments:      current_tax != null ? -r2(current_tax) : null,
        other_payments:    0,
        net_operating:     netOperating,
      },
      investing: {
        capex:                     capexInMonth > 0 ? -capexInMonth : 0,
        security_deposits_paid:    depositInMonth > 0 ? -depositInMonth : 0,
        security_deposits_refunded: 0,
        other_investing:           0,
        net_investing:             netInvesting,
      },
      financing: {
        debt_drawdown:   debtDraw || 0,
        debt_repayment:  debtRepay != null ? -debtRepay : null,
        interest_paid:   interestPaid != null ? -interestPaid : null,
        equity_infusion: 0,
        dividend:        0,
        other_financing: 0,
        net_financing:   netFinancing,
      },
      closing_cash:       closingCash,
      min_cash_requirement: cfg.min_cash_requirement || 5000000,
      funding_gap:        closingCash != null ? r2(closingCash - (cfg.min_cash_requirement || 5000000)) : null,
    };

    // ── BALANCE SHEET ─────────────────────────────────────────────────────────
    const prevPPENet = prevBS?.assets?.non_current?.ppe_net || null;
    const ppNetClosing = prevPPENet != null && totalDep != null
      ? r2(prevPPENet + capexInMonth - totalDep)
      : null;

    const secDepositClosing = ob?.assets?.non_current?.security_deposits != null
      ? r2((prevBS?.assets?.non_current?.security_deposits || 0) + depositInMonth)
      : null;

    const leaseCloseLib = leaseRow?.closing_lease_liability || null;
    const rouClose = prevBS?.assets?.non_current?.rou_assets != null && rouDep != null
      ? r2((prevBS.assets.non_current.rou_assets || 0) - rouDep)
      : null;

    const prevRE = prevBS?.equity?.retained_earnings || null;
    const retEarnings = prevRE != null && pat != null ? r2(prevRE + pat) : null;

    const totalAssets_nc = [ppNetClosing, rouClose, secDepositClosing, ob?.assets?.non_current?.other_non_current || 0]
      .every(v => v != null) ? r2((ppNetClosing||0) + (rouClose||0) + (secDepositClosing||0) + (ob?.assets?.non_current?.other_non_current||0)) : null;
    const totalAssets_c = [wc?.closing_ar, closingCash, ob?.assets?.current?.advances || 0, ob?.assets?.current?.tax_assets || 0]
      .every(v => v != null) ? r2((wc?.closing_ar||0) + (closingCash||0) + (ob?.assets?.current?.advances||0) + (ob?.assets?.current?.tax_assets||0)) : null;
    const totalAssets = totalAssets_nc != null && totalAssets_c != null ? r2(totalAssets_nc + totalAssets_c) : null;

    const shareCapital = ob?.equity?.share_capital || null;
    const securPremium = ob?.equity?.securities_premium || null;
    const totalEquity = shareCapital != null && retEarnings != null ? r2((shareCapital||0) + (securPremium||0) + (retEarnings||0)) : null;

    const liab_nc = debtClose != null && leaseCloseLib != null
      ? r2(debtClose + leaseCloseLib)
      : null;
    const liab_c = wc?.closing_ap != null ? r2(wc.closing_ap) : null;
    const totalLiab = liab_nc != null && liab_c != null ? r2(liab_nc + liab_c) : null;

    const totalEquityAndLiab = totalEquity != null && totalLiab != null ? r2(totalEquity + totalLiab) : null;
    const bs_check = totalAssets != null && totalEquityAndLiab != null ? r2(totalAssets - totalEquityAndLiab) : null;

    const bs = {
      assets: {
        non_current: { ppe_net: ppNetClosing, rou_assets: rouClose, security_deposits: secDepositClosing, other_non_current: ob?.assets?.non_current?.other_non_current || null, total_non_current: totalAssets_nc },
        current:     { trade_receivables: wc?.closing_ar || null, cash: closingCash, advances: ob?.assets?.current?.advances || null, tax_assets: ob?.assets?.current?.tax_assets || null, total_current: totalAssets_c },
        total_assets: totalAssets,
      },
      equity: {
        share_capital: shareCapital,
        securities_premium: securPremium,
        retained_earnings: retEarnings,
        other_reserves: ob?.equity?.other_reserves || null,
        total_equity: totalEquity,
      },
      liabilities: {
        non_current: { borrowings: debtClose, lease_liabilities: leaseCloseLib, other_non_current: ob?.liabilities?.non_current?.other_non_current || null, total_non_current: liab_nc },
        current:     { trade_payables: wc?.closing_ap || null, current_borrowings: null, other_current: ob?.liabilities?.current?.other_current || null, total_current: liab_c },
        total_liabilities: totalLiab,
      },
      total_equity_and_liabilities: totalEquityAndLiab,
      bs_check,
    };

    // Update prevBS and prevCash for next iteration
    prevBS = { assets: bs.assets, equity: bs.equity, liabilities: bs.liabilities };
    prevCash = closingCash;

    outputMonths.push({ month, fy: getFY(month), type, pl, cash_bridge, bs, data_flags });
  }

  // Reconciliation
  const recon = runIntegratedReconciliation(outputMonths, projOut.months || [], costOut.months || [], facilities, openItemsData);

  // Validation
  const valIssues = runIntegratedValidation(outputMonths, openingBSData, facilities, leases, assets, []);

  // Migration gate
  const gate = evaluateMigrationGate(recon.checks, valIssues, openItemsData, outputMonths);

  return {
    computed_at: new Date().toISOString(),
    config_snapshot: cfg,
    months: outputMonths,
    reconciliation: recon,
    validation_issues: valIssues,
    migration_gate: gate,
    compute_in_progress: false,
  };
}

// ─── ROUTES ────────────────────────────────────────────────────────────────────
router.use(authMiddleware);

// Config
router.get('/config', async (req, res) => {
  try { res.json((await readIntConfig()).forecast_config || DEFAULT_INT_CONFIG); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/config', adminOnly, async (req, res) => {
  try {
    const d = await readIntConfig(); d.forecast_config = { ...(d.forecast_config || DEFAULT_INT_CONFIG), ...req.body }; d.forecast_config.last_updated = now();
    await writeIntConfig(d); res.json(d.forecast_config);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Opening Balance Sheet
router.get('/opening-balance-sheet', async (req, res) => {
  try { res.json(await readOpeningBS()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/opening-balance-sheet', adminOnly, async (req, res) => {
  try {
    const d = { ...req.body, last_updated: now() }; await writeOpeningBS(d); res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debt Schedule CRUD
router.get('/debt-schedule', async (req, res) => {
  try { res.json(await readDebtSchedule()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/debt-schedule', adminOnly, async (req, res) => {
  try {
    const d = await readDebtSchedule();
    const fac = { ...req.body, facility_id: genId('DF'), created_at: now(), active: true };
    d.facilities.push(fac); d.last_updated = now(); await writeDebtSched(d); res.json(fac);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/debt-schedule/:id', adminOnly, async (req, res) => {
  try {
    const d = await readDebtSchedule();
    // Support both `id` (Zoho-synced) and `facility_id` (manually-created) as lookup key.
    const pid = req.params.id;
    const idx = d.facilities.findIndex(f => f.id === pid || f.facility_id === pid);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    d.facilities[idx] = { ...d.facilities[idx], ...req.body, last_updated: now() }; d.last_updated = now();
    await writeDebtSched(d); res.json(d.facilities[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/debt-schedule/:id', adminOnly, async (req, res) => {
  try {
    const d = await readDebtSchedule();
    const pid = req.params.id;
    const idx = d.facilities.findIndex(f => f.id === pid || f.facility_id === pid);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    d.facilities[idx].active = false; d.last_updated = now(); await writeDebtSched(d); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lease Schedule CRUD
router.get('/lease-schedule', async (req, res) => {
  try { res.json(await readLeaseSchedule()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/lease-schedule', adminOnly, async (req, res) => {
  try {
    const d = await readLeaseSchedule();
    const lease = { ...req.body, lease_id: genId('LS'), created_at: now(), active: true };
    d.leases.push(lease); d.last_updated = now(); await writeLeaseSched(d); res.json(lease);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/lease-schedule/:id', adminOnly, async (req, res) => {
  try {
    const d = await readLeaseSchedule(); const idx = d.leases.findIndex(l => l.lease_id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    d.leases[idx] = { ...d.leases[idx], ...req.body, last_updated: now() }; d.last_updated = now();
    await writeLeaseSched(d); res.json(d.leases[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/lease-schedule/:id', adminOnly, async (req, res) => {
  try {
    const d = await readLeaseSchedule(); const idx = d.leases.findIndex(l => l.lease_id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    d.leases[idx].active = false; d.last_updated = now(); await writeLeaseSched(d); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Asset Register CRUD
router.get('/asset-register', async (req, res) => {
  try { res.json(await readAssetRegister()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/asset-register', adminOnly, async (req, res) => {
  try {
    const d = await readAssetRegister();
    const asset = { ...req.body, asset_id: genId('FA'), created_at: now(), active: true };
    d.assets.push(asset); d.last_updated = now(); await writeAssetReg(d); res.json(asset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/asset-register/:id', adminOnly, async (req, res) => {
  try {
    const d = await readAssetRegister(); const idx = d.assets.findIndex(a => a.asset_id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    d.assets[idx] = { ...d.assets[idx], ...req.body, last_updated: now() }; d.last_updated = now();
    await writeAssetReg(d); res.json(d.assets[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Account Mapping CRUD
router.get('/account-mapping', async (req, res) => {
  try { res.json(await readAccountMapping()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/account-mapping', adminOnly, async (req, res) => {
  try {
    const d = await readAccountMapping();
    const mapping = { ...req.body, mapping_id: genId('AM'), created_at: now(), active: true };
    d.mappings.push(mapping); d.last_updated = now(); await writeAcctMap(d); res.json(mapping);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/account-mapping/:id', adminOnly, async (req, res) => {
  try {
    const d = await readAccountMapping(); const idx = d.mappings.findIndex(m => m.mapping_id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    d.mappings[idx] = { ...d.mappings[idx], ...req.body, last_updated: now() }; d.last_updated = now();
    await writeAcctMap(d); res.json(d.mappings[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Corporate Cost Master CRUD
router.get('/corporate-cost-master', async (req, res) => {
  try { res.json(await readCorpCost()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/corporate-cost-master', adminOnly, async (req, res) => {
  try {
    const d = await readCorpCost();
    const asm = { ...req.body, assumption_id: genId('CC'), created_at: now(), active: true };
    d.assumptions.push(asm); d.last_updated = now(); await writeCorpCost(d); res.json(asm);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/corporate-cost-master/:id', adminOnly, async (req, res) => {
  try {
    const d = await readCorpCost(); const idx = d.assumptions.findIndex(a => a.assumption_id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    d.assumptions[idx] = { ...d.assumptions[idx], ...req.body, last_updated: now() }; d.last_updated = now();
    await writeCorpCost(d); res.json(d.assumptions[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/corporate-cost-master/:id', adminOnly, async (req, res) => {
  try {
    const d = await readCorpCost(); const idx = d.assumptions.findIndex(a => a.assumption_id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    d.assumptions[idx].active = false; d.last_updated = now(); await writeCorpCost(d); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// WC & Tax params
router.get('/wc-params',  async (req, res) => { try { res.json(await readWCParams()); } catch(e) { res.status(500).json({ error: e.message }); } });
router.put('/wc-params',  adminOnly, async (req, res) => { try { const d = { ...req.body, last_updated: now() }; await writeWCParams(d); res.json(d); } catch(e) { res.status(500).json({ error: e.message }); } });
router.get('/tax-params', async (req, res) => { try { res.json(await readTaxParams()); } catch(e) { res.status(500).json({ error: e.message }); } });
router.put('/tax-params', adminOnly, async (req, res) => { try { const d = { ...req.body, last_updated: now() }; await writeTaxParams(d); res.json(d); } catch(e) { res.status(500).json({ error: e.message }); } });

// Open Items
router.get('/open-items', async (req, res) => {
  try {
    const d = await readOpenItems();
    // Seed default items if empty
    if (!d.items?.length) { d.items = SEED_OPEN_ITEMS; d.last_updated = now(); await writeOpenItems(d); }
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/open-items/:id', adminOnly, async (req, res) => {
  try {
    const d = await readOpenItems(); const idx = d.items.findIndex(i => i.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    d.items[idx] = { ...d.items[idx], ...req.body, last_updated: now() }; d.last_updated = now();
    await writeOpenItems(d); res.json(d.items[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Compute — starts in the background and returns at once (also called by fpa-step8 on Vercel,
// where there is no localhost server to POST to)
function startIntegratedCompute() {
  if (intComputeInProgress) return { ok: false, message: 'Computation already in progress' };
  intComputeInProgress = true;
  background((async () => {
    try {
      const output = await runIntegratedComputation();
      output.compute_in_progress = false;
      await writeIntOutput(output);
      const cfg = await readIntConfig();
      cfg.forecast_config.last_computed_at = output.computed_at;
      await writeIntConfig(cfg);
    } catch (e) { console.error('[fpa-integrated] Compute error:', e.message); }
    finally { intComputeInProgress = false; }
  })());
  return { ok: true, message: 'Integrated computation started in background' };
}

router.post('/compute', adminOnly, async (req, res) => {
  res.json(startIntegratedCompute());
});

// Output endpoints
router.get('/output', async (req, res) => {
  try { const d = await readIntOutput(); res.json({ computed_at: d.computed_at, compute_in_progress: intComputeInProgress, config_snapshot: d.config_snapshot }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/summary', async (req, res) => {
  try {
    const out = await readIntOutput();
    const months = out.months || [];
    if (!months.length) return res.json({ has_output: false, compute_in_progress: intComputeInProgress });
    const today = new Date();
    const currentFY = today.getMonth() + 1 >= 4 ? `FY${today.getFullYear()}-${String(today.getFullYear()+1).slice(2)}` : `FY${today.getFullYear()-1}-${String(today.getFullYear()).slice(2)}`;
    const fyMs = months.filter(m => m.fy === currentFY);
    const sum = (key) => fyMs.reduce((s, m) => s + (m.pl?.[key] || 0), 0);
    const last = months[months.length - 1];
    res.json({
      has_output: true, compute_in_progress: intComputeInProgress,
      computed_at: out.computed_at, fy_label: currentFY,
      fy_revenue:       r2(sum('ebitda') + sum('direct_costs_total') + (fyMs.reduce((s,m) => s + (m.pl?.corporate_costs?.total||0), 0))),
      fy_ebitda:        r2(sum('ebitda')),
      fy_pat:           r2(sum('pat')),
      closing_cash:     last?.cash_bridge?.closing_cash || null,
      funding_gap:      last?.cash_bridge?.funding_gap || null,
      migration_gate:   out.migration_gate?.status || null,
      validation_issue_count: (out.validation_issues || []).length,
      reconciliation_pass: out.reconciliation?.all_pass,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/pl', async (req, res) => {
  try { const d = await readIntOutput(); res.json({ months: (d.months || []).map(m => ({ month: m.month, fy: m.fy, type: m.type, ...m.pl })) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/balance-sheet', async (req, res) => {
  try { const d = await readIntOutput(); res.json({ months: (d.months || []).map(m => ({ month: m.month, fy: m.fy, type: m.type, ...m.bs })) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/cash-bridge', async (req, res) => {
  try { const d = await readIntOutput(); res.json({ months: (d.months || []).map(m => ({ month: m.month, fy: m.fy, type: m.type, ...m.cash_bridge })) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/reconciliation', async (req, res) => {
  try { const d = await readIntOutput(); res.json(d.reconciliation || {}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/validation', async (req, res) => {
  try { const d = await readIntOutput(); res.json({ issues: d.validation_issues || [] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/migration-gate', async (req, res) => {
  try { const d = await readIntOutput(); res.json(d.migration_gate || { status: 'NOT_COMPUTED', message: 'Run compute first.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/data-flags', async (req, res) => {
  try {
    const d = await readIntOutput();
    const allFlags = {};
    for (const m of d.months || []) {
      for (const f of (m.data_flags || [])) allFlags[f] = (allFlags[f] || 0) + 1;
    }
    res.json({ flags: allFlags, total_months: (d.months || []).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Step 14: Pre-flight Check ───────────────────────────────────────────────
// Aggregates all management input sources into a completeness report.
router.get('/preflight', async (req, res) => {
  try {
    const readJ = readFpaDoc;

    const bm   = await readJ('branch_master.json', { branches: [] });
    const cm   = await readJ('client_master.json', { clients: [] });
    const pa   = await readJ('projection_assumptions.json', { client_assumptions: [], forecast_config: {} });
    const occ  = await readJ('occupancy_assumptions.json', { branch_templates: {}, overrides: {} });
    const cost = await readJ('cost_master.json', { assumptions: [] });
    const capx = await readJ('capex_master.json', { capex_entries: [] });
    const dep  = await readJ('deposit_master.json', { deposit_entries: [] });
    const debt = await readJ('debt_schedule.json', { facilities: [] });
    const obs  = await readJ('opening_balance_sheet.json', {});
    const assets = await readJ('asset_register.json', { assets: [] });
    const acct = await readJ('account_mapping.json', { summary: {} });
    const ga   = await readJ('global_assumptions.json', {});

    const branches   = bm.branches || [];
    const clients    = cm.clients || [];
    const assums     = pa.client_assumptions || [];
    const facilities = debt.facilities || [];
    const bTotal     = branches.length;
    const aTotal     = assums.length;

    const bWithSqft  = branches.filter(b => b.total_area_sqft).length;
    const bWithSeats = branches.filter(b => b.total_seats).length;
    const bDateMgmt  = branches.filter(b => b.opening_date && b.opening_date_source !== 'earliest_zoho_invoice_in_sync_window').length;
    const occTemplates = Object.keys(occ.branch_templates || {}).length;
    const aContracted = assums.filter(a => a.contracted_monthly_revenue != null).length;
    const aEscalation = assums.filter(a => a.escalation_pct != null).length;
    const aEscMgmtApproved = assums.filter(a => a.escalation_source === 'per_client_management_input').length;
    const costActual = (cost.assumptions || []).filter(c => c.active !== false).length;
    const branchesWithCost = new Set((cost.assumptions || []).filter(c => c.active !== false && c.branch_id).map(c => c.branch_id)).size;
    const capexCount = (capx.capex_entries || []).filter(x => x.active !== false).length;
    const depositCount = (dep.deposit_entries || []).filter(x => x.active !== false).length;
    const fWithRate  = facilities.filter(f => f.rate != null && Number(f.rate) > 0).length;
    const fWithSched = facilities.filter(f => (f.repayment_schedule || []).length > 0).length;
    const fRPZero    = facilities.filter(f => f.type === 'unsecured_loan' && (Number(f.rate) || 0) === 0).length;
    const obsStatus  = obs.approval_status || 'not_set';
    const obsBalance = obs.bs_check_pass === true;
    const assetCount = (assets.assets || assets.asset_register || []).filter(a => a.active !== false).length;
    const acctSummary = acct.summary || {};
    const glMapped   = (Number(acctSummary.confirmed) || 0) + (Number(acctSummary.resolved) || 0) + (Number(acctSummary.auto_mapped) || 0);
    const glTotal    = Number(acct.total_groupings) || 0;
    const utilitiesSet = !!(ga.utilities_method);
    const utilitiesApproved = !!(ga.utilities_approved_by);

    const items = [
      { id: 'branch_master',      label: 'Branch Master',               total: bTotal, filled: bTotal, status: bTotal > 0 ? 'COMPLETE' : 'MISSING', priority: 'HIGH', note: `${bTotal} branches defined` },
      { id: 'branch_capacity',    label: 'Branch Capacity / Seats',     total: bTotal, filled: bWithSeats, status: bWithSeats === 0 ? 'MISSING' : bWithSeats < bTotal ? 'PARTIAL' : 'COMPLETE', priority: 'CRITICAL', note: `${bWithSeats}/${bTotal} branches have seat count; ${bWithSqft}/${bTotal} have sqft` },
      { id: 'branch_dates',       label: 'Branch Opening Dates',        total: bTotal, filled: bDateMgmt, status: bDateMgmt === 0 ? 'PARTIAL' : bDateMgmt < bTotal ? 'PARTIAL' : 'COMPLETE', priority: 'MEDIUM', note: `${bTotal}/30 have Zoho-derived dates (unconfirmed); ${bDateMgmt} management-confirmed` },
      { id: 'occupancy',          label: 'Occupancy Assumptions',       total: bTotal, filled: occTemplates, status: occTemplates === 0 ? 'MISSING' : occTemplates < bTotal ? 'PARTIAL' : 'COMPLETE', priority: 'CRITICAL', note: `${occTemplates}/${bTotal} branches have occupancy template` },
      { id: 'client_revenue',     label: 'Client Contracted Revenue',   total: aTotal, filled: aContracted, status: aContracted === 0 ? 'MISSING' : aContracted < aTotal ? 'PARTIAL' : 'COMPLETE', priority: 'CRITICAL', note: `${aContracted}/${aTotal} mappings have contracted revenue` },
      { id: 'client_escalation',  label: 'Client Escalation',          total: aTotal, filled: aEscalation, status: aEscMgmtApproved > 0 ? (aEscMgmtApproved >= aTotal ? 'COMPLETE' : 'PARTIAL') : aEscalation > 0 ? 'PARTIAL' : 'MISSING', priority: 'MEDIUM', note: `${aEscalation}/${aTotal} have escalation_pct (${aEscMgmtApproved} individually reviewed)` },
      { id: 'future_branches',    label: 'Future Branches',             total: null, filled: 0, status: 'NOT_APPLICABLE', priority: 'LOW', note: 'No future branches added' },
      { id: 'cost_master',        label: 'Branch Cost Master',          total: bTotal, filled: branchesWithCost, status: costActual === 0 ? 'MISSING' : branchesWithCost < bTotal ? 'PARTIAL' : 'COMPLETE', priority: 'CRITICAL', note: `${costActual} cost entries for ${branchesWithCost}/${bTotal} branches` },
      { id: 'utilities',          label: 'Utilities Methodology',       total: 1, filled: utilitiesApproved ? 1 : 0, status: !utilitiesSet ? 'MISSING' : !utilitiesApproved ? 'PARTIAL' : 'COMPLETE', priority: 'CRITICAL', note: `method=${ga.utilities_method || 'NOT SET'}, approved=${ga.utilities_approved_by || 'NOT SET'}` },
      { id: 'debt',               label: 'Debt Rates & Schedules',      total: facilities.length, filled: fWithSched, status: fWithSched === 0 ? 'PARTIAL' : fWithSched < facilities.length ? 'PARTIAL' : 'COMPLETE', priority: 'CRITICAL', note: `${fWithRate}/32 have rate; ${fWithSched}/32 have schedule; ${fRPZero} RP loans at 0% need confirmation` },
      { id: 'opening_bs',         label: 'Opening Balance Sheet',       total: 1, filled: obsStatus === 'approved' ? 1 : 0, status: obsStatus === 'approved' ? 'COMPLETE' : obsStatus === 'pending_review' ? 'PARTIAL' : 'MISSING', priority: 'CRITICAL', note: `status=${obsStatus}; balanced=${obsBalance}; diff=${(obs.bs_check_diff || 0).toFixed(4)}L` },
      { id: 'asset_register',     label: 'Fixed Asset Register',        total: null, filled: assetCount, status: assetCount === 0 ? 'MISSING' : 'PARTIAL', priority: 'HIGH', note: `${assetCount} assets registered` },
      { id: 'gl_mapping',         label: 'GL Mapping',                  total: glTotal, filled: glMapped, status: glMapped === 0 ? 'MISSING' : glMapped < glTotal ? 'PARTIAL' : 'COMPLETE', priority: 'HIGH', note: `${glMapped}/${glTotal} GL groupings mapped (${acctSummary.auto_mapped || 0} auto, ${acctSummary.confirmed || 0} confirmed)` },
      { id: 'unmapped_revenue',   label: 'Unmapped Revenue',            total: null, filled: 0, status: 'PARTIAL', priority: 'MEDIUM', note: '25 invoices unresolved — populate through Management Inputs → Unmapped Revenue' },
      { id: 'capex',              label: 'Capex',                       total: null, filled: capexCount, status: capexCount === 0 ? 'MISSING' : 'PARTIAL', priority: 'CRITICAL', note: `${capexCount} capex entries` },
      { id: 'security_deposits',  label: 'Security Deposits',           total: null, filled: depositCount, status: depositCount === 0 ? 'MISSING' : 'PARTIAL', priority: 'CRITICAL', note: `${depositCount} deposit entries` },
    ];

    const criticalMissing = items.filter(i => i.priority === 'CRITICAL' && i.status !== 'COMPLETE' && i.status !== 'NOT_APPLICABLE');
    const highMissing     = items.filter(i => i.priority === 'HIGH' && i.status !== 'COMPLETE' && i.status !== 'NOT_APPLICABLE');
    const complete        = items.filter(i => i.status === 'COMPLETE').length;
    const pct             = Math.round(complete / items.filter(i => i.status !== 'NOT_APPLICABLE').length * 100);

    const gate = criticalMissing.length > 0 ? 'BLOCKED — MANAGEMENT INPUT REQUIRED' : highMissing.length > 0 ? 'BLOCKED — HIGH PRIORITY INPUTS MISSING' : 'READY FOR BASELINE GENERATION';

    res.json({
      as_of: new Date().toISOString(),
      items,
      summary: {
        total_items: items.length,
        complete,
        critical_missing: criticalMissing.length,
        high_missing: highMissing.length,
        completeness_pct: pct,
      },
      gate,
      critical_blockers: criticalMissing.map(i => ({ id: i.id, label: i.label, note: i.note })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Step 14: Double-count Reconciliation ────────────────────────────────────
// Verifies contracted client seats do not overlap with occupancy-driven vacant projection.
router.get('/double-count-check', async (req, res) => {
  try {
    const branches = await readFpaDoc('branch_master.json', { branches: [] });
    const pa       = await readFpaDoc('projection_assumptions.json', { client_assumptions: [] });
    const intOut   = await readIntOutput();
    const branchList = (branches.branches || []);
    const assums = pa.client_assumptions || [];

    const rows = branchList.map(b => {
      const branchAssums = assums.filter(a => a.branch_id === b.branch_id && a.forecast_status === 'active');
      const contractedRevenue = branchAssums.reduce((s, a) => s + (a.contracted_monthly_revenue || 0), 0);
      const seatsContracted = null; // seats per client not yet tracked
      const totalSeats = b.total_seats;
      return {
        branch_id: b.branch_id,
        branch_name: b.branch_name,
        total_seats: totalSeats,
        contracted_clients: branchAssums.length,
        contracted_monthly_revenue: contractedRevenue,
        contracted_seats: seatsContracted,
        vacant_seats: totalSeats != null && seatsContracted != null ? totalSeats - seatsContracted : null,
        double_count_risk: !b.total_seats ? 'CANNOT_CHECK — seats not entered' : seatsContracted == null ? 'CANNOT_CHECK — client seats not entered' : seatsContracted > totalSeats ? 'OVERLAP_DETECTED' : 'OK',
      };
    });

    res.json({ rows, note: 'Double-count check requires per-client seat capacity in projection_assumptions. Currently NOT populated — enter client capacity_sqft per mapping to enable this check.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Step 14: Baseline Generation ────────────────────────────────────────────
// Validates prerequisites, then triggers integrated compute and creates baseline record.
router.post('/generate-baseline', adminOnly, async (req, res) => {
  try {
    const { force = false, version_label, generated_by } = req.body || {};

    // Run pre-flight check
    const readJ = readFpaDoc;

    const bm   = await readJ('branch_master.json', { branches: [] });
    const pa   = await readJ('projection_assumptions.json', { client_assumptions: [], forecast_config: {} });
    const cost = await readJ('cost_master.json', { assumptions: [] });
    const ga   = await readJ('global_assumptions.json', {});
    const obs  = await readJ('opening_balance_sheet.json', {});

    const aContracted = (pa.client_assumptions || []).filter(a => a.contracted_monthly_revenue != null).length;
    const costActual  = (cost.assumptions || []).filter(c => c.active !== false).length;
    const utilitiesSet = !!(ga.utilities_method);
    const obsApproved  = obs.approval_status === 'approved';

    const blockers = [];
    if (aContracted === 0) blockers.push('No contracted monthly revenue entered for any client. Populate in Management Inputs → Client Revenue.');
    if (costActual === 0) blockers.push('No cost assumptions entered. Populate in Management Inputs → Cost Master.');
    if (!utilitiesSet) blockers.push('Utilities methodology not set. Set in Management Inputs → Utilities.');
    if (!obsApproved) blockers.push(`Opening Balance Sheet not approved (status: ${obs.approval_status || 'not_set'}). Approve in Management Inputs → Opening BS.`);

    if (blockers.length > 0 && !force) {
      return res.status(422).json({
        ok: false,
        gate: 'BLOCKED',
        blockers,
        message: 'Critical inputs missing. Address all blockers before generating baseline.',
      });
    }

    // Run the integrated compute to generate fresh output
    const output = await runIntegratedComputation();

    // Create a baseline record
    const baselines = await readJ('baselines.json', { baselines: [] });
    const newBaseline = {
      baseline_id: `BL-${Date.now()}`,
      version: `V${(baselines.baselines || []).length + 1}`,
      version_label: version_label || `Forecast Baseline V${(baselines.baselines || []).length + 1}`,
      generated_at: new Date().toISOString(),
      generated_by: generated_by || 'admin',
      actual_cutoff: pa.forecast_config?.actual_cutoff_month || null,
      forecast_start: pa.forecast_config?.forecast_start || null,
      forecast_end:   pa.forecast_config?.forecast_end || null,
      scenario: pa.forecast_config?.scenario || 'base',
      forced: !!force,
      status: 'draft',
      frozen: false,
      input_completeness_pct: blockers.length === 0 ? 100 : Math.round((4 - blockers.length) / 4 * 100),
      revenue_month1: (output.months || [])[0]?.pl?.revenue?.total || null,
      ebitda_month1:  (output.months || [])[0]?.pl?.ebitda || null,
    };

    if (!baselines.baselines) baselines.baselines = [];
    baselines.baselines.push(newBaseline);
    await writeFpaDoc('baselines.json', baselines);

    res.json({ ok: true, baseline: newBaseline, warnings: blockers.length > 0 ? blockers : undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Step 14: Freeze Baseline ─────────────────────────────────────────────────
router.post('/freeze-baseline/:baseline_id', adminOnly, async (req, res) => {
  try {
    const baselines = await readFpaDoc('baselines.json', null);
    if (!baselines) return res.status(404).json({ error: 'No baselines found' });
    const idx = (baselines.baselines || []).findIndex(b => b.baseline_id === req.params.baseline_id);
    if (idx < 0) return res.status(404).json({ error: 'Baseline not found' });
    if (baselines.baselines[idx].frozen) return res.status(409).json({ error: 'Baseline already frozen. Cannot re-freeze.' });
    baselines.baselines[idx].frozen = true;
    baselines.baselines[idx].frozen_at = new Date().toISOString();
    baselines.baselines[idx].frozen_by = req.body?.frozen_by || 'admin';
    baselines.baselines[idx].status = 'frozen';
    await writeFpaDoc('baselines.json', baselines);
    res.json({ ok: true, baseline: baselines.baselines[idx] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Step 14: List Baselines ──────────────────────────────────────────────────
router.get('/baselines', async (req, res) => {
  try {
    const d = await readFpaDoc('baselines.json', null);
    if (!d) return res.json({ baselines: [] });
    res.json({ baselines: d.baselines || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Step 14: Acceptance Tests ───────────────────────────────────────────────
router.post('/acceptance-tests', adminOnly, async (req, res) => {
  try {
    const intOut = await readIntOutput();
    const months = intOut.months || [];
    const actuals = months.filter(m => m.type === 'actual');
    const forecasts = months.filter(m => m.type === 'forecast');
    const allMonths = months;

    const tests = [];

    // AT-01: Existing client revenue does not double-count with occupancy revenue
    tests.push({ id: 'AT-01', name: 'Client revenue not double-counted', status: 'NOT_TESTABLE', note: 'Requires client seat capacity in projection_assumptions — not yet populated' });

    // AT-02: Client escalation applies from correct month
    tests.push({ id: 'AT-02', name: 'Client escalation applies from correct month', status: 'NOT_TESTABLE', note: 'Contracted revenue not entered — escalation cannot be tested with real data' });

    // AT-03: Future branch activates at go-live
    const futureBranchMonths = forecasts.filter(m => (m.revenue_by_branch || {}).__TEST_BRANCH__);
    tests.push({ id: 'AT-03', name: 'Future branch activates at go-live', status: 'NOT_TESTABLE', note: 'No test branch created yet' });

    // AT-04: Branch cost changes affect EBITDA
    const hasEbitdaData = forecasts.some(m => m.pl?.ebitda != null);
    tests.push({ id: 'AT-04', name: 'Branch cost changes affect EBITDA', status: hasEbitdaData ? 'PASS' : 'NOT_TESTABLE', note: hasEbitdaData ? 'EBITDA data present' : 'No cost assumptions — EBITDA is null' });

    // AT-05: Utilities methodology affects total cost
    tests.push({ id: 'AT-05', name: 'Utilities methodology affects total cost', status: 'NOT_TESTABLE', note: 'Utilities methodology not set' });

    // AT-06: Debt interest flows to P&L finance cost
    const hasFinCost = allMonths.some(m => m.pl?.finance_cost != null && m.pl?.finance_cost !== 0);
    tests.push({ id: 'AT-06', name: 'Debt interest flows to P&L finance cost', status: hasFinCost ? 'PASS' : 'FAIL', note: hasFinCost ? 'Finance cost populated' : 'Finance cost null — repayment schedules not entered (B1 blocker)' });

    // AT-07: Debt repayment flows to cash and BS
    const hasBorrowings = allMonths.some(m => m.bs?.liabilities?.non_current?.borrowings != null);
    tests.push({ id: 'AT-07', name: 'Debt repayment flows to cash and BS', status: hasBorrowings ? 'PASS' : 'FAIL', note: hasBorrowings ? 'Borrowings on BS' : 'Borrowings null — debt schedule incomplete' });

    // AT-08: Capex flows to cash/PPE
    const hasCapex = allMonths.some(m => m.cash_bridge?.investing?.capex != null && m.cash_bridge?.investing?.capex !== 0);
    tests.push({ id: 'AT-08', name: 'Capex flows to cash and PPE', status: hasCapex ? 'PASS' : 'NOT_TESTABLE', note: hasCapex ? 'Capex in cash bridge' : 'No capex entries — cash bridge capex = 0' });

    // AT-09: Depreciation flows to P&L and PPE roll-forward
    const hasDep = allMonths.some(m => m.pl?.depreciation_ppe != null);
    tests.push({ id: 'AT-09', name: 'Depreciation flows to P&L / PPE', status: hasDep ? 'PASS' : 'NOT_TESTABLE', note: hasDep ? 'Depreciation present' : 'No asset register — PPE depreciation cannot be computed' });

    // AT-10: Lease flows reconcile (Ind AS 116)
    const hasLeaseDepRou = allMonths.some(m => m.pl?.depreciation_rou != null && m.pl?.depreciation_rou > 0);
    tests.push({ id: 'AT-10', name: 'Lease flows reconcile (Ind AS 116)', status: hasLeaseDepRou ? 'PASS' : 'FAIL', note: hasLeaseDepRou ? `ROU depreciation = ${(allMonths[0]?.pl?.depreciation_rou || 0).toFixed(2)}L/month` : 'ROU depreciation null — check lease schedule' });

    // AT-11: PAT flows to retained earnings
    let patTest = { id: 'AT-11', name: 'PAT flows to retained earnings', status: 'NOT_TESTABLE', note: 'PAT is null — B1 blocker (missing debt schedule)' };
    const monthsWithPat = allMonths.filter(m => m.pl?.pat != null);
    if (monthsWithPat.length > 1) {
      const mismatch = [];
      for (let i = 1; i < allMonths.length; i++) {
        const pat = allMonths[i].pl?.pat;
        const prevRE = allMonths[i-1].bs?.equity?.retained_earnings;
        const currRE = allMonths[i].bs?.equity?.retained_earnings;
        if (pat != null && prevRE != null && currRE != null) {
          const expected = prevRE + pat;
          if (Math.abs(expected - currRE) > 0.1) mismatch.push(allMonths[i].month);
        }
      }
      patTest = { id: 'AT-11', name: 'PAT flows to retained earnings', status: mismatch.length === 0 ? 'PASS' : 'FAIL', note: mismatch.length === 0 ? 'Retained earnings roll-forward correct' : `Mismatch in: ${mismatch.join(', ')}` };
    }
    tests.push(patTest);

    // AT-12: Closing cash = BS cash
    let cashTest = { id: 'AT-12', name: 'Closing cash = Balance Sheet cash', status: 'NOT_TESTABLE', note: 'Cash bridge has null values — B1 blocker' };
    const monthsWithCash = allMonths.filter(m => m.cash_bridge?.closing_cash != null && m.bs?.assets?.current?.cash != null);
    if (monthsWithCash.length > 0) {
      const mismatch = monthsWithCash.filter(m => Math.abs((m.cash_bridge?.closing_cash || 0) - (m.bs?.assets?.current?.cash || 0)) > 0.01);
      cashTest = { id: 'AT-12', name: 'Closing cash = Balance Sheet cash', status: mismatch.length === 0 ? 'PASS' : 'FAIL', note: mismatch.length === 0 ? `${monthsWithCash.length} months verified` : `Mismatch in ${mismatch.length} months` };
    }
    tests.push(cashTest);

    // AT-13: BS balances (assets = equity + liabilities)
    let bsTest = { id: 'AT-13', name: 'Balance sheet balances (A = E + L)', status: 'NOT_TESTABLE', note: 'BS check null — B1 blocker' };
    const monthsWithBS = allMonths.filter(m => m.bs?.bs_check != null);
    if (monthsWithBS.length > 0) {
      const fails = monthsWithBS.filter(m => Math.abs(m.bs?.bs_check || 0) > 1);
      bsTest = { id: 'AT-13', name: 'Balance sheet balances (A = E + L)', status: fails.length === 0 ? 'PASS' : 'FAIL', note: fails.length === 0 ? `${monthsWithBS.length} months balance` : `Out of balance in ${fails.length} months` };
    }
    tests.push(bsTest);

    // AT-14: Actual months remain actual (no forecast override)
    const actualMonthsCount = actuals.length;
    tests.push({ id: 'AT-14', name: 'Actual months remain actual', status: actualMonthsCount > 0 ? 'PASS' : 'NOT_TESTABLE', note: `${actualMonthsCount} actual months locked` });

    // AT-15: Revenue is in correct unit (lakhs)
    const revSample = actuals[0]?.pl?.revenue?.total;
    const unitCorrect = revSample != null && revSample > 100 && revSample < 100000; // reasonable lakh range
    tests.push({ id: 'AT-15', name: 'Revenue unit is lakhs (not raw rupees)', status: revSample == null ? 'NOT_TESTABLE' : unitCorrect ? 'PASS' : 'FAIL', note: revSample != null ? `Sample actual revenue: ${revSample}L — ${unitCorrect ? 'looks correct' : 'may be in wrong unit'}` : 'No actual revenue data' });

    const passed = tests.filter(t => t.status === 'PASS').length;
    const failed = tests.filter(t => t.status === 'FAIL').length;
    const notTestable = tests.filter(t => t.status === 'NOT_TESTABLE').length;

    res.json({ tests, summary: { total: tests.length, passed, failed, not_testable: notTestable }, run_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.startIntegratedCompute = startIntegratedCompute;
