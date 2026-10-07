// Step 11 Pre-Compute Preparation
// 1. Normalise opening_balance_sheet.json to match compute engine field names
// 2. Set active:true on debt facilities
// 3. Add aggregate Ind AS 116 lease entry for compute
const fs = require('fs');
const path = require('path');
const FPA = path.join(__dirname, 'fpa');
const now = new Date().toISOString();

// ─── 1. OPENING BS NORMALISATION ─────────────────────────────────────────────
// Compute engine expects specific field names. Our OBS uses audited note names.
// Add compute_normalized section with engine-expected names; keep original for audit trail.
const obs = JSON.parse(fs.readFileSync(path.join(FPA, 'opening_balance_sheet.json'), 'utf8'));
const b = obs.balances;

// NC Assets: security_deposits = bs_nc_ofa (rent/security deposits component)
// The other_financial_assets_nc = ₹3,969.02L; this includes security deposits + other
// Per Note 6 of Standalone FS, bs_nc_ofa is mainly security deposits. Use whole amount.
obs.balances.assets.non_current.security_deposits = b.assets.non_current.other_financial_assets_nc; // ₹3,969.02L
obs.balances.assets.non_current.other_non_current =
  (b.assets.non_current.intangible_assets || 0) +
  (b.assets.non_current.investments_nc || 0) +
  (b.assets.non_current.loans_nc || 0) +
  (b.assets.non_current.deferred_tax_asset || 0) +
  (b.assets.non_current.other_nc_assets || 0); // ₹363.27 + ₹4863.04 + ₹26.21 + ₹849.60 + ₹2847.41

// C Assets: expected names
obs.balances.assets.current.cash = b.assets.current.cash_and_bank;  // ₹5,499.46L
obs.balances.assets.current.advances = b.assets.current.loans_advances_current; // ₹4,775.68L
obs.balances.assets.current.tax_assets = b.assets.current.current_tax_assets; // ₹1,372.51L

// C Liabilities: trade_payables (MSME + Others combined)
obs.balances.liabilities.current.trade_payables =
  (b.liabilities.current.trade_payables_msme || 0) +
  (b.liabilities.current.trade_payables_other || 0); // ₹968.12 + ₹1564.55 = ₹2,532.67L
obs.balances.liabilities.current.other_current =
  (b.liabilities.current.other_financial_liabilities_c || 0) +
  (b.liabilities.current.other_current_liabilities || 0) +
  (b.liabilities.current.short_term_provisions || 0); // ₹79.08 + ₹258.75 + ₹17.19 = ₹355.02L

// NC Liabilities: other_non_current
obs.balances.liabilities.non_current.other_non_current =
  (b.liabilities.non_current.other_financial_liabilities || 0) +
  (b.liabilities.non_current.provisions || 0); // ₹4,209.66 + ₹36.78 = ₹4,246.44L

obs.normalization_applied_at = now;
obs.normalization_note = 'Field name aliases added for compute engine compatibility. Original audited field names preserved.';
fs.writeFileSync(path.join(FPA, 'opening_balance_sheet.json'), JSON.stringify(obs, null, 2));
console.log('Opening BS normalized. cash:', obs.balances.assets.current.cash, '| advances:', obs.balances.assets.current.advances);
console.log('  other_non_current (NC assets):', obs.balances.assets.non_current.other_non_current.toFixed(2));

// ─── 2. DEBT FACILITIES — set active:true ────────────────────────────────────
// Compute engine: `if (!f.active) continue;` — all facilities are currently skipped
const ds = JSON.parse(fs.readFileSync(path.join(FPA, 'debt_schedule.json'), 'utf8'));
let activatedFacilities = 0;
ds.facilities.forEach(f => {
  if (f.active === undefined || f.active === null) {
    f.active = true;
    activatedFacilities++;
  }
});

// For compute projections, the opening_principal should be the CLOSING balance (Apr 2026 starting point)
// The facilities[] have April 2025 opening balances — for FY26-27 forecast, update to closing balances
// Map from closing_facilities_mar31_2026 where available
const closingMap = {};
(ds.closing_facilities_mar31_2026 || []).forEach(f => {
  // Match by lender name
  closingMap[f.lender.toLowerCase()] = f.total;
});

// For each opening facility, try to update opening_principal to closing balance
let updatedPrincipals = 0;
ds.facilities.forEach(f => {
  const closingBal = closingMap[f.lender.toLowerCase()];
  if (closingBal !== undefined && closingBal > 0) {
    f.opening_principal_apr2025 = f.opening_principal; // preserve original
    f.opening_principal = closingBal; // use closing as start for FY26-27 projections
    f.opening_balance_note = 'Updated to Mar-2026 closing balance for FY26-27 projections';
    updatedPrincipals++;
  }
  // Ensure drawdown and repayment schedules exist (empty if no data)
  if (!f.drawdown_schedule) f.drawdown_schedule = [];
  if (!f.repayment_schedule) f.repayment_schedule = [];
});

// Remove fully repaid facilities (those in opening register but absent from closing BC sheet)
// Don't delete — just mark inactive where closing balance is 0 (fully repaid by Mar 2026)
const repaidFacilities = ['Jio Credit Pvt Ltd', 'Mizuho CapsAve', 'Banquity', 'Oxyzo Financial Services',
  'Satya Micro Capital', 'GE Capital', 'Incred-1', 'Ugro Capital'];
ds.facilities.forEach(f => {
  const lenderLower = (f.lender || '').toLowerCase();
  const isRepaid = repaidFacilities.some(r => lenderLower.includes(r.toLowerCase()));
  if (isRepaid) {
    f.active = false;
    f.repaid_fy26 = true;
    f.opening_principal = 0; // fully repaid
  }
});

ds.last_updated = now;
ds.compute_prep_note = 'Step 11: set active:true, updated opening_principal to Mar-2026 closing balances for projection.';
fs.writeFileSync(path.join(FPA, 'debt_schedule.json'), JSON.stringify(ds, null, 2));
console.log('Debt facilities: activated', activatedFacilities, '| updated principals', updatedPrincipals);

// ─── 3. AGGREGATE IND AS 116 LEASE ENTRY ────────────────────────────────────
// Add a single aggregate entry for Ind AS 116 computation.
// Per-lease discount rates not available. Use aggregate from Note 45.
// Opening = Mar 31, 2026 closing values (start of FY26-27 projection)
const ls = JSON.parse(fs.readFileSync(path.join(FPA, 'lease_schedule.json'), 'utf8'));

// Derived from Note 45 aggregate:
// - Opening liability (Apr 1, 2026) = Mar 31, 2026 closing = ₹22,569.19L
// - Opening ROU (Apr 1, 2026) = Mar 31, 2026 closing = ₹19,225.26L
// - Implied monthly payment = ₹6,707.67L / 12 = ₹559.14L (FY26 actual; approximate FY27)
// - Effective discount rate: finance_cost_fy26 / avg_liability_fy26
//   Opening ₹25,490.68L, Closing ₹22,569.19L, Avg ≈ ₹24,029.94L
//   Rate = ₹2,719.68L / ₹24,029.94L = 11.32% per annum
// - Remaining term: from maturity analysis, undiscounted > 5yr = ₹3,284.93L suggests many leases > 5yr
//   Use blended remaining term = (present of remaining cash flows). Approximate = 60 months.
const aggregateLease = {
  lease_id: 'AGG-IND-AS-116',
  label: 'Aggregate Ind AS 116 — All Leases',
  note: 'AGGREGATE MODEL — Per Note 45, DevX Standalone FS FY 2025-26. Not per-lease. Discount rate is FY26 implied blended rate. Per-lease rates require CA/auditor workings.',
  active: true,
  classification: 'ind_as_116',
  opening_liability: 22569.19,   // Mar 31, 2026 closing = Apr 1, 2026 opening for projections
  opening_rou: 19225.26,         // Mar 31, 2026 closing ROU
  monthly_payment: 559.14,       // ₹6,707.67L / 12 months (FY26 actual; used as proxy)
  discount_rate: 11.32,          // FY26 implied: ₹2,719.68L finance cost / avg liability ₹24,030L
  lease_term_months: 60,         // Approximate blended remaining; maturity >5yr ₹3,285L exists
  commencement_date: '2026-04-01', // Start of projection period
  short_term_rent_monthly: 25.82,  // ₹309.79L/12 short-term lease expense from Note 45
  source: 'DevX Standalone FS Note 45 aggregate. Not per-lease.',
  data_quality: 'AGGREGATE_APPROXIMATION',
  fy26_actuals: {
    rou_dep: 5023.95,
    liability_opening: 25490.68,
    liability_closing: 22569.19,
    finance_cost: 2719.68,
    payments: 6707.67,
    additions: 1040.50,
  },
};

// Remove any existing aggregate entry to avoid duplicates
ls.leases = (ls.leases || []).filter(l => l.lease_id !== 'AGG-IND-AS-116');
ls.leases.push(aggregateLease);
ls.aggregate_lease_entry_added = now;
ls.aggregate_entry_note = 'Added aggregate Ind AS 116 entry for compute. Per-lease rates still required for per-lease model.';
ls.last_updated = now;
fs.writeFileSync(path.join(FPA, 'lease_schedule.json'), JSON.stringify(ls, null, 2));
console.log('Lease schedule: added aggregate Ind AS 116 entry. Total leases:', ls.leases.length);
console.log('  Opening liability:', 22569.19, '| Opening ROU:', 19225.26, '| Discount rate:', 11.32, '%');

console.log('\nPre-compute preparation complete. Ready to run integrated compute.');
