/**
 * FP&A Branch Cost, EBITDA, Capex & Security Deposit Engine — Step 5
 * Converts Step-4 Revenue Projection into Branch Economics.
 * ISOLATED from P&L, Cash Bridge, Balance Sheet, Debt Schedule.
 * DO NOT connect to production financial statements until Step 6 approval.
 *
 * Accounting separation:
 *   EBITDA / Centre Contribution → Rent, CAM, Utilities, Facility, People, Other OpEx
 *   CAPEX                        → Fit-out, Furniture, IT, Leasehold improvements (NOT in EBITDA)
 *   Balance Sheet                → Refundable security deposits (NOT in EBITDA)
 */

const express  = require('express');
const path     = require('path');
const router   = express.Router();
const db       = require('./db');
const { authMiddleware, adminOnly } = require('./auth');

// ─── File paths ───────────────────────────────────────────────────────────────
const FPA = path.join(__dirname, 'fpa');
const FILES = {
  costConfig:    path.join(FPA, 'cost_config.json'),
  costMaster:    path.join(FPA, 'cost_master.json'),
  capexMaster:   path.join(FPA, 'capex_master.json'),
  depositMaster: path.join(FPA, 'deposit_master.json'),
  costOutput:    path.join(FPA, 'cost_output.json'),
  costOverrides: path.join(FPA, 'cost_overrides.json'),
  projOutput:    path.join(FPA, 'projection_output.json'),
  branch:        path.join(FPA, 'branch_master.json'),
  occupancy:     path.join(FPA, 'occupancy_assumptions.json'),
  global:        path.join(FPA, 'global_assumptions.json'),
  ramp:          path.join(FPA, 'ramp_templates.json'),
};
const KEYS = {
  costConfig:    'fpa_cost_config',
  costMaster:    'fpa_cost_master',
  capexMaster:   'fpa_capex_master',
  depositMaster: 'fpa_deposit_master',
  costOutput:    'fpa_cost_output',
  costOverrides: 'fpa_cost_overrides',
  projOutput:    'fpa_proj_output',
  branch:        'fpa_branch_master',
  occupancy:     'fpa_occupancy_assumptions',
  global:        'fpa_global_assumptions',
  ramp:          'fpa_ramp_templates',
};

const DEFAULT_COST_CONFIG = {
  actual_cutoff_month: '2026-09',
  forecast_start:      '2026-04',
  forecast_end:        '2029-03',
  version_label:       'FY2026-27 to FY2028-29 Base Case',
  locked:              false,
  last_computed_at:    null,
};

const DEFAULT_COST_MASTER    = { assumptions: [],    last_updated: null };
const DEFAULT_CAPEX_MASTER   = { capex_entries: [],  last_updated: null };
const DEFAULT_DEPOSIT_MASTER = { deposits: [],        last_updated: null };
const DEFAULT_COST_OUTPUT    = {
  computed_at: null, config_snapshot: null,
  months: [], capex_schedule: [], deposit_schedule: [],
  validation_issues: [], reconciliation: {},
};
const DEFAULT_OVERRIDES = { overrides: [] };

// ─── DB helpers ───────────────────────────────────────────────────────────────
const readCostConfig    = () => db.readJSON(KEYS.costConfig,    FILES.costConfig,    { forecast_config: { ...DEFAULT_COST_CONFIG } });
const readCostMaster    = () => db.readJSON(KEYS.costMaster,    FILES.costMaster,    DEFAULT_COST_MASTER);
const readCapexMaster   = () => db.readJSON(KEYS.capexMaster,   FILES.capexMaster,   DEFAULT_CAPEX_MASTER);
const readDepositMaster = () => db.readJSON(KEYS.depositMaster, FILES.depositMaster, DEFAULT_DEPOSIT_MASTER);
const readCostOutput    = () => db.readJSON(KEYS.costOutput,    FILES.costOutput,    DEFAULT_COST_OUTPUT);
const readCostOverrides = () => db.readJSON(KEYS.costOverrides, FILES.costOverrides, DEFAULT_OVERRIDES);
const readProjOutput    = () => db.readJSON(KEYS.projOutput,    FILES.projOutput,    { months: [] });
const readBranches      = () => db.readJSON(KEYS.branch,        FILES.branch,        { branches: [] });
const readOccupancy     = () => db.readJSON(KEYS.occupancy,     FILES.occupancy,     { branch_templates: {}, overrides: {} });
const readGlobal        = () => db.readJSON(KEYS.global,        FILES.global,        {});
const readRamp          = () => db.readJSON(KEYS.ramp,          FILES.ramp,          { templates: {} });

async function writeCostConfig(data) {
  data.last_updated = new Date().toISOString();
  return db.writeJSON(KEYS.costConfig, FILES.costConfig, data);
}
async function writeCostMaster(data) {
  data.last_updated = new Date().toISOString();
  return db.writeJSON(KEYS.costMaster, FILES.costMaster, data);
}
async function writeCapexMaster(data) {
  data.last_updated = new Date().toISOString();
  return db.writeJSON(KEYS.capexMaster, FILES.capexMaster, data);
}
async function writeDepositMaster(data) {
  data.last_updated = new Date().toISOString();
  return db.writeJSON(KEYS.depositMaster, FILES.depositMaster, data);
}
const writeCostOutput    = d => db.writeJSON(KEYS.costOutput,    FILES.costOutput,    d);
const writeCostOverrides = d => db.writeJSON(KEYS.costOverrides, FILES.costOverrides, d);

// ─── ID generator ─────────────────────────────────────────────────────────────
const genId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

// ─── Month/date utilities ─────────────────────────────────────────────────────
function getMonthRange(start, end) {
  const months = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
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

function monthDiff(fromMonth, toMonth) {
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

// ─── Occupancy % (replicated from Step 4 — engines stay independent) ─────────
function getOccupancyPct(branchId, month, occupancy, rampData, global, branchRecord) {
  const override = (occupancy.overrides || {})[branchId]?.[month];
  if (override != null) return override;
  const templateName =
    (occupancy.branch_templates || {})[branchId] ||
    branchRecord?.occupancy_ramp_template ||
    global?.default_ramp_template || 'base';
  const template = rampData.templates?.[templateName] || rampData.templates?.base;
  if (!template) return 0;
  const openDate = branchRecord?.opening_date || global?.model_start_date;
  if (!openDate) return template.steady_state_pct ?? 100;
  const openMonth = openDate.substring(0, 7);
  const idx = monthDiff(openMonth, month);
  if (idx < 0) return 0;
  if (idx < (template.monthly_pct || []).length) return template.monthly_pct[idx];
  return template.steady_state_pct ?? 100;
}

// ─── Escalation (annual compounding, every_3_years, one_time) ─────────────────
function applyEscalation(base, targetMonth, escPct, effectiveDate, frequency) {
  if (!escPct || escPct <= 0 || !effectiveDate) return base;
  const factor = 1 + escPct / 100;
  const tgt = new Date(targetMonth + '-01');
  const eff = new Date(effectiveDate);
  if (isNaN(eff.getTime()) || isNaN(tgt.getTime())) return base;

  if (frequency === 'annual') {
    let cycles = 0;
    const check = new Date(eff);
    while (check <= tgt) { cycles++; check.setFullYear(check.getFullYear() + 1); }
    return base * Math.pow(factor, cycles);
  }
  if (frequency === 'every_3_years') {
    let cycles = 0;
    const check = new Date(eff);
    while (check <= tgt) { cycles++; check.setFullYear(check.getFullYear() + 3); }
    return base * Math.pow(factor, cycles);
  }
  if (frequency === 'one_time') {
    return eff <= tgt ? base * factor : base;
  }
  return base;
}

// ─── Proration factor for commencement month ──────────────────────────────────
function commencementProration(month, commencementDate) {
  if (!commencementDate) return 1;
  const commMonth = commencementDate.substring(0, 7);
  if (month > commMonth) return 1;
  if (month < commMonth) return 0;
  const startDay = parseInt(commencementDate.split('-')[2], 10) || 1;
  const totalDays = daysInMonth(month);
  return (totalDays - startDay + 1) / totalDays;
}

// ─── Compute a single cost line for a branch/month ────────────────────────────
function computeCostLine(asm, month, branchRecord, monthRevenue, occupancyPct, overridesMap) {
  if (!asm.active) return null;

  // Effective date range
  const fromYM = asm.effective_from ? asm.effective_from.substring(0, 7) : null;
  const toYM   = asm.effective_to   ? asm.effective_to.substring(0, 7)   : null;
  if (fromYM && month < fromYM) return null;
  if (toYM   && month > toYM)   return null;

  const isRentLine = asm.cost_subcategory === 'rent';

  // Rent: check commencement date (may differ from effective_from)
  const commDate = asm.rent_commencement_date || asm.effective_from;
  if (isRentLine && commDate) {
    if (month < commDate.substring(0, 7)) return null;
  }

  // Rent-free period
  let isRentFree = false;
  if (isRentLine && asm.rent_free_start && asm.rent_free_end) {
    const rfS = asm.rent_free_start.substring(0, 7);
    const rfE = asm.rent_free_end.substring(0, 7);
    if (month >= rfS && month <= rfE) isRentFree = true;
  }

  // Area and seats (falls back to branch record)
  const area  = asm.applicable_area_sqft || branchRecord?.revenue_capacity_sqft || branchRecord?.total_area_sqft || 0;
  const seats = asm.applicable_seats      || branchRecord?.total_seats || 0;
  const calcMethod = asm.calc_method || 'fixed_monthly';
  const flags = [];

  let baseAmount = 0;
  switch (calcMethod) {
    case 'fixed_monthly':
      baseAmount = asm.fixed_monthly_amount || asm.base_amount || 0;
      break;
    case 'per_sqft':
      if (!area) flags.push({ code: 'V-NO-AREA', level: 'warning', message: `No area for per-sqft cost: ${asm.assumption_id}` });
      baseAmount = area * (asm.rate_per_sqft || 0);
      break;
    case 'per_seat':
      if (!seats) flags.push({ code: 'V-NO-SEATS', level: 'warning', message: `No seats for per-seat cost: ${asm.assumption_id}` });
      baseAmount = seats * (asm.rate_per_seat || 0);
      break;
    case 'pct_of_revenue':
      baseAmount = (monthRevenue || 0) * (asm.variable_pct || 0) / 100;
      break;
    case 'occupancy_linked':
      baseAmount = area * (occupancyPct / 100) * (asm.rate_per_sqft || 0);
      break;
    default: // manual_override or unknown
      baseAmount = asm.fixed_monthly_amount || asm.base_amount || 0;
  }

  // Apply escalation
  const escPct  = asm.escalation_pct || 0;
  const escDate = asm.escalation_effective_date || asm.effective_from || null;
  const escFreq = asm.escalation_frequency || 'annual';
  let escalatedAmount = isRentFree ? 0 :
    (escPct > 0 && escDate ? applyEscalation(baseAmount, month, escPct, escDate, escFreq) : baseAmount);

  // Proration for commencement month (rent only)
  let prorationFactor = 1;
  if (isRentLine && commDate) {
    prorationFactor = commencementProration(month, commDate);
    escalatedAmount = escalatedAmount * prorationFactor;
  }

  // Monthly override check
  const overrideKey = `${asm.assumption_id}:${month}`;
  const override    = overridesMap[overrideKey];
  const finalAmount = override ? override.override_amount : escalatedAmount;

  return {
    assumption_id:    asm.assumption_id,
    cost_category:    asm.cost_category,
    cost_subcategory: asm.cost_subcategory,
    cost_nature:      asm.cost_nature || 'opex',  // opex | pre_opening
    variability:      asm.variability || 'fixed',  // fixed | semi_variable | variable
    calc_method:      calcMethod,
    area_used:        area,
    rate_per_sqft:    asm.rate_per_sqft || null,
    base_amount:      Math.round(baseAmount * 100) / 100,
    escalated_amount: Math.round(escalatedAmount * 100) / 100,
    override_amount:  override ? override.override_amount : null,
    final_amount:     Math.round(finalAmount * 100) / 100,
    is_rent_free:     isRentFree,
    proration_factor: Math.round(prorationFactor * 1000) / 1000,
    has_override:     !!override,
    validation_flags: flags,
  };
}

// ─── Aggregate cost lines into category totals ────────────────────────────────
function aggregateCostLines(lines) {
  const out = { rent: 0, cam: 0, utilities: 0, facility: 0, people: 0, other_opex: 0, pre_opening: 0 };
  for (const l of lines) {
    if (!l) continue;
    if (l.cost_nature === 'pre_opening') { out.pre_opening += l.final_amount; continue; }
    switch (l.cost_category) {
      case 'occupancy': l.cost_subcategory === 'rent' ? (out.rent += l.final_amount) : (out.cam += l.final_amount); break;
      case 'utilities': out.utilities += l.final_amount; break;
      case 'facility':  out.facility  += l.final_amount; break;
      case 'people':    out.people    += l.final_amount; break;
      default:          out.other_opex += l.final_amount;
    }
  }
  out.total_opex = out.rent + out.cam + out.utilities + out.facility + out.people + out.other_opex;
  return out;
}

// ─── Break-even occupancy ─────────────────────────────────────────────────────
// Fixed costs / (full-capacity revenue) × 100
// Only calculated where both numerator and denominator are meaningful.
function computeBreakEven(agg, revenue, area) {
  if (!area || !revenue) return null;
  const fixedCosts = agg.rent + agg.cam + (agg.utilities * 0.5);
  const pct = (fixedCosts / revenue) * 100;
  return Math.min(Math.round(pct * 10) / 10, 999);
}

// ─── Capex payment schedule ───────────────────────────────────────────────────
function buildCapexPayments(capexEntries, monthSet) {
  const schedule = [];
  for (const entry of capexEntries) {
    if (!entry.active) continue;
    const area       = entry.area_sqft || 0;
    const totalCapex = entry.override_amount ??
      (entry.fixed_capex != null ? entry.fixed_capex : area * (entry.capex_per_sqft || 0));
    if (!totalCapex) continue;

    const openingMonth = entry.opening_date ? entry.opening_date.substring(0, 7) : null;
    if (!openingMonth) continue;

    const paySchedule = entry.payment_schedule?.length
      ? entry.payment_schedule
      : [{ months_before_opening: 0, pct: 100 }];
    const [oy, om] = openingMonth.split('-').map(Number);

    const pctSum = paySchedule.reduce((s, t) => s + (t.pct || 0), 0);
    if (Math.abs(pctSum - 100) > 0.01) {
      // Flag but still include; validation will catch it
    }

    for (const tranche of paySchedule) {
      const mbf = tranche.months_before_opening ?? 0;
      const pct = tranche.pct || 0;
      if (!pct) continue;
      let pm = om - mbf, py = oy;
      while (pm <= 0) { pm += 12; py--; }
      const payMonth = `${py}-${String(pm).padStart(2, '0')}`;
      schedule.push({
        month:                payMonth,
        fy:                   getFY(payMonth),
        branch_id:            entry.branch_id,
        capex_id:             entry.capex_id,
        capex_category:       entry.capex_category || 'general',
        pct,
        amount:               Math.round(totalCapex * pct / 100 * 100) / 100,
        total_planned_capex:  Math.round(totalCapex * 100) / 100,
        opening_month:        openingMonth,
        months_before_opening: mbf,
        in_range:             monthSet.has(payMonth),
      });
    }
  }
  return schedule;
}

// ─── Security deposit schedule ────────────────────────────────────────────────
function buildDepositPayments(depositEntries, branchMap, costMaster, monthSet) {
  const schedule = [];
  for (const entry of depositEntries) {
    if (!entry.active) continue;
    const branch = branchMap[entry.branch_id];
    const openingMonth = branch?.opening_date ? branch.opening_date.substring(0, 7) : null;
    if (!openingMonth) continue;

    let depositAmount = entry.override_amount ?? entry.fixed_deposit_amount;
    if (!depositAmount) {
      const depMonths = entry.deposit_months || 0;
      if (!depMonths) continue;
      let rentBasis = entry.rent_basis_amount;
      if (!rentBasis) {
        // Try cost master rent assumption for this branch
        const rentAsm = (costMaster.assumptions || []).find(
          a => a.branch_id === entry.branch_id && a.cost_subcategory === 'rent' && a.active
        );
        if (rentAsm) {
          const area = rentAsm.applicable_area_sqft || branch?.revenue_capacity_sqft || branch?.total_area_sqft || 0;
          rentBasis = rentAsm.calc_method === 'per_sqft'
            ? area * (rentAsm.rate_per_sqft || 0)
            : rentAsm.fixed_monthly_amount || rentAsm.base_amount || 0;
        } else {
          // Fallback: branch.rent_per_sqft × area
          const area = branch?.revenue_capacity_sqft || branch?.total_area_sqft || 0;
          rentBasis = (branch?.rent_per_sqft || 0) * area;
        }
      }
      depositAmount = depMonths * (rentBasis || 0);
    }
    if (!depositAmount) continue;

    const mbf = entry.months_before_opening ?? 3;
    const [oy, om] = openingMonth.split('-').map(Number);
    let pm = om - mbf, py = oy;
    while (pm <= 0) { pm += 12; py--; }
    const payMonth = `${py}-${String(pm).padStart(2, '0')}`;

    schedule.push({
      month:               payMonth,
      fy:                  getFY(payMonth),
      branch_id:           entry.branch_id,
      deposit_id:          entry.deposit_id,
      deposit_type:        entry.deposit_type || 'security_deposit',
      deposit_amount:      Math.round(depositAmount * 100) / 100,
      deposit_months:      entry.deposit_months || null,
      refundable:          entry.refundable !== false,
      expected_refund_date: entry.expected_refund_date || null,
      opening_month:        openingMonth,
      months_before_opening: mbf,
      in_range:             monthSet.has(payMonth),
    });
  }
  return schedule;
}

// ─── Cost validation ──────────────────────────────────────────────────────────
function runCostValidations(costMaster, capexMaster, depositMaster, branches) {
  const issues = [];
  const branchMap = Object.fromEntries(branches.map(b => [b.branch_id, b]));

  for (const asm of costMaster.assumptions || []) {
    if (!asm.active) continue;
    if (!branchMap[asm.branch_id]) {
      issues.push({ level: 'error', code: 'V-MISSING-BRANCH', context: asm.assumption_id, branch_id: asm.branch_id, message: `Cost assumption ${asm.assumption_id} references unknown branch: ${asm.branch_id}` });
      continue;
    }
    const branch = branchMap[asm.branch_id];
    const area = asm.applicable_area_sqft || branch.revenue_capacity_sqft || branch.total_area_sqft || 0;
    if (asm.cost_subcategory === 'rent' && !asm.rate_per_sqft && !asm.fixed_monthly_amount && !asm.base_amount)
      issues.push({ level: 'error', code: 'V-MISSING-RENT-RATE', context: asm.assumption_id, branch_id: asm.branch_id, message: `Missing rent rate for ${asm.branch_id}` });
    if (asm.cost_subcategory === 'rent' && !asm.rent_commencement_date && !asm.effective_from)
      issues.push({ level: 'warning', code: 'V-MISSING-RENT-DATE', context: asm.assumption_id, branch_id: asm.branch_id, message: `Missing rent commencement date for ${asm.branch_id}` });
    if (asm.calc_method === 'per_sqft' && !area)
      issues.push({ level: 'warning', code: 'V-MISSING-AREA', context: asm.assumption_id, branch_id: asm.branch_id, message: `No area for per-sqft cost ${asm.assumption_id}` });
    if ((asm.rate_per_sqft || 0) < 0 || (asm.fixed_monthly_amount || 0) < 0 || (asm.base_amount || 0) < 0)
      issues.push({ level: 'error', code: 'V-NEGATIVE-AMOUNT', context: asm.assumption_id, branch_id: asm.branch_id, message: `Negative cost amount in ${asm.assumption_id}` });
    if (asm.escalation_pct && asm.escalation_pct < 0)
      issues.push({ level: 'error', code: 'V-INVALID-ESC', context: asm.assumption_id, branch_id: asm.branch_id, message: `Negative escalation in ${asm.assumption_id}` });
    if (!asm.cost_category)
      issues.push({ level: 'warning', code: 'V-MISSING-CATEGORY', context: asm.assumption_id, branch_id: asm.branch_id, message: `No cost category in ${asm.assumption_id}` });
  }

  for (const cx of capexMaster.capex_entries || []) {
    if (!cx.active) continue;
    const area = cx.area_sqft || 0;
    const hasAmt = cx.fixed_capex || cx.override_amount || (area && cx.capex_per_sqft);
    if (!hasAmt)
      issues.push({ level: 'error', code: 'V-MISSING-CAPEX', context: cx.capex_id, branch_id: cx.branch_id, message: `Missing capex amount for ${cx.capex_id}` });
    if (!cx.opening_date)
      issues.push({ level: 'error', code: 'V-MISSING-OPENING', context: cx.capex_id, branch_id: cx.branch_id, message: `Missing opening date for capex ${cx.capex_id}` });
    const pctSum = (cx.payment_schedule || []).reduce((s, t) => s + (t.pct || 0), 0);
    if ((cx.payment_schedule || []).length > 0 && Math.abs(pctSum - 100) > 0.01)
      issues.push({ level: 'error', code: 'V-CAPEX-PCT', context: cx.capex_id, branch_id: cx.branch_id, message: `Capex payment schedule totals ${pctSum.toFixed(1)}%, must be 100%` });
    if ((cx.capex_per_sqft || 0) < 0)
      issues.push({ level: 'error', code: 'V-NEGATIVE-CAPEX', context: cx.capex_id, branch_id: cx.branch_id, message: `Negative capex rate in ${cx.capex_id}` });
  }

  for (const dep of depositMaster.deposits || []) {
    if (!dep.active) continue;
    if (!dep.deposit_months && !dep.fixed_deposit_amount && !dep.override_amount)
      issues.push({ level: 'error', code: 'V-MISSING-DEPOSIT', context: dep.deposit_id, branch_id: dep.branch_id, message: `Missing deposit amount/months for ${dep.deposit_id}` });
    if (!branchMap[dep.branch_id])
      issues.push({ level: 'error', code: 'V-MISSING-BRANCH', context: dep.deposit_id, branch_id: dep.branch_id, message: `Deposit ${dep.deposit_id} references unknown branch: ${dep.branch_id}` });
  }

  for (const branch of branches.filter(b => b.active !== false)) {
    const hasCosts = (costMaster.assumptions || []).some(a => a.branch_id === branch.branch_id && a.active);
    if (!hasCosts)
      issues.push({ level: 'warning', code: 'V-NO-COSTS', context: branch.branch_id, branch_id: branch.branch_id, message: `Branch ${branch.branch_name || branch.branch_id} has no active cost assumptions — costs will be zero` });
  }

  return issues;
}

// ─── Reconciliation RC-C01 through RC-C08 ────────────────────────────────────
function runCostReconciliation(months, projMonths, capexSchedule, depositSchedule) {
  const checks = [];
  const projMap = Object.fromEntries((projMonths || []).map(m => [m.month, m]));

  // RC-C01: Branch revenue = Step-4 projected revenue
  let rc01Pass = true, rc01MaxGap = 0;
  const hasProj = projMonths && projMonths.length > 0;
  for (const mRow of months) {
    const pm = projMap[mRow.month];
    if (!pm) continue;
    const gap = Math.abs(mRow.company_revenue - pm.company_total);
    if (gap > 1) { rc01Pass = false; rc01MaxGap = Math.max(rc01MaxGap, gap); }
  }
  checks.push({ id: 'RC-C01', name: 'Branch revenue = Step-4 Projected Revenue', pass: hasProj ? rc01Pass : true, max_gap: Math.round(rc01MaxGap * 100) / 100, note: !hasProj ? 'Step-4 output not yet computed — run revenue projection first' : undefined });

  // RC-C02: Total branch opex = sum of cost line items
  let rc02Pass = true, rc02MaxGap = 0;
  for (const mRow of months) {
    for (const b of mRow.branches) {
      const lineSum = (b.cost_lines || []).reduce((s, l) => s + (l.final_amount || 0), 0);
      const gap = Math.abs(lineSum - b.total_opex);
      if (gap > 0.05) { rc02Pass = false; rc02MaxGap = Math.max(rc02MaxGap, gap); }
    }
  }
  checks.push({ id: 'RC-C02', name: 'Total branch opex = sum of cost line items', pass: rc02Pass, max_gap: Math.round(rc02MaxGap * 100) / 100 });

  // RC-C03: Centre contribution = revenue − direct opex
  let rc03Pass = true, rc03MaxGap = 0;
  for (const mRow of months) {
    for (const b of mRow.branches) {
      const expected = b.revenue - b.total_opex;
      const gap = Math.abs(expected - b.centre_contribution);
      if (gap > 0.05) { rc03Pass = false; rc03MaxGap = Math.max(rc03MaxGap, gap); }
    }
  }
  checks.push({ id: 'RC-C03', name: 'Centre contribution = Revenue − Direct Opex', pass: rc03Pass, max_gap: Math.round(rc03MaxGap * 100) / 100 });

  // RC-C04: Company revenue = sum of branch revenues
  let rc04Pass = true, rc04MaxGap = 0;
  for (const mRow of months) {
    const branchSum = mRow.branches.reduce((s, b) => s + b.revenue, 0);
    const gap = Math.abs(branchSum - mRow.company_revenue);
    if (gap > 0.05) { rc04Pass = false; rc04MaxGap = Math.max(rc04MaxGap, gap); }
  }
  checks.push({ id: 'RC-C04', name: 'Company revenue = sum of branch revenues', pass: rc04Pass, max_gap: Math.round(rc04MaxGap * 100) / 100 });

  // RC-C05: Company opex = sum of branch opex
  let rc05Pass = true, rc05MaxGap = 0;
  for (const mRow of months) {
    const branchSum = mRow.branches.reduce((s, b) => s + b.total_opex, 0);
    const gap = Math.abs(branchSum - mRow.company_total_opex);
    if (gap > 0.05) { rc05Pass = false; rc05MaxGap = Math.max(rc05MaxGap, gap); }
  }
  checks.push({ id: 'RC-C05', name: 'Company opex = sum of branch opex', pass: rc05Pass, max_gap: Math.round(rc05MaxGap * 100) / 100 });

  // RC-C06: Company contribution = sum of branch contributions
  let rc06Pass = true, rc06MaxGap = 0;
  for (const mRow of months) {
    const branchSum = mRow.branches.reduce((s, b) => s + b.centre_contribution, 0);
    const gap = Math.abs(branchSum - mRow.company_contribution);
    if (gap > 0.05) { rc06Pass = false; rc06MaxGap = Math.max(rc06MaxGap, gap); }
  }
  checks.push({ id: 'RC-C06', name: 'Company contribution = sum of branch contributions', pass: rc06Pass, max_gap: Math.round(rc06MaxGap * 100) / 100 });

  // RC-C07: Total capex = sum of branch capex schedules (in range)
  const capexFromSchedule = capexSchedule.filter(r => r.in_range).reduce((s, r) => s + r.amount, 0);
  const capexFromMonths   = months.reduce((s, m) => s + (m.company_capex || 0), 0);
  const rc07Gap = Math.abs(capexFromSchedule - capexFromMonths);
  checks.push({ id: 'RC-C07', name: 'Total capex = sum of branch capex schedules', pass: rc07Gap < 1, gap: Math.round((capexFromSchedule - capexFromMonths) * 100) / 100 });

  // RC-C08: Total deposits = sum of branch deposit schedules (in range)
  const depFromSchedule = depositSchedule.filter(r => r.in_range).reduce((s, r) => s + r.deposit_amount, 0);
  const depFromMonths   = months.reduce((s, m) => s + (m.company_deposit || 0), 0);
  const rc08Gap = Math.abs(depFromSchedule - depFromMonths);
  checks.push({ id: 'RC-C08', name: 'Total deposits = sum of branch deposit schedules', pass: rc08Gap < 1, gap: Math.round((depFromSchedule - depFromMonths) * 100) / 100 });

  return { checks, all_pass: checks.every(c => c.pass) };
}

// ─── MAIN COMPUTATION ENGINE ──────────────────────────────────────────────────
let costComputeInProgress = false;

async function runCostComputation() {
  const [cfgData, costMaster, capexMaster, depositMaster, overrides, projOutput, { branches }, occupancy, global, rampData] =
    await Promise.all([
      readCostConfig(), readCostMaster(), readCapexMaster(), readDepositMaster(),
      readCostOverrides(), readProjOutput(), readBranches(),
      readOccupancy(), readGlobal(), readRamp(),
    ]);

  const cfg        = cfgData.forecast_config || DEFAULT_COST_CONFIG;
  const allMonths  = getMonthRange(cfg.forecast_start, cfg.forecast_end);
  const monthSet   = new Set(allMonths);
  const branchMap  = Object.fromEntries(branches.map(b => [b.branch_id, b]));
  const overridesMap = Object.fromEntries(
    (overrides.overrides || []).map(o => [`${o.assumption_id}:${o.month}`, o])
  );
  const projMonthMap = Object.fromEntries((projOutput.months || []).map(m => [m.month, m]));

  const capexSchedule   = buildCapexPayments(capexMaster.capex_entries || [], monthSet);
  const depositSchedule = buildDepositPayments(depositMaster.deposits || [], branchMap, costMaster, monthSet);

  // Index capex/deposit by branch+month
  const capexIndex   = {};
  const depositIndex = {};
  for (const ce of capexSchedule) {
    if (!ce.in_range) continue;
    const k = `${ce.branch_id}:${ce.month}`;
    capexIndex[k] = (capexIndex[k] || 0) + ce.amount;
  }
  for (const de of depositSchedule) {
    if (!de.in_range) continue;
    const k = `${de.branch_id}:${de.month}`;
    depositIndex[k] = (depositIndex[k] || 0) + de.deposit_amount;
  }

  const monthRows = [];

  for (const month of allMonths) {
    const projMRow   = projMonthMap[month];
    const branchRows = [];

    for (const branch of branches.filter(b => b.active !== false)) {
      const bid          = branch.branch_id;
      const projBranch   = projMRow?.branches?.find(b => b.branch_id === bid);
      const revenue      = projBranch?.total_revenue || 0;
      const occupancyPct = getOccupancyPct(bid, month, occupancy, rampData, global, branch);
      const isPreOpening = branch.opening_date && month < branch.opening_date.substring(0, 7);

      const branchAsms = (costMaster.assumptions || []).filter(a => a.branch_id === bid);
      const costLines  = branchAsms
        .map(asm => computeCostLine(asm, month, branch, revenue, occupancyPct, overridesMap))
        .filter(Boolean);

      const agg  = aggregateCostLines(costLines);
      const bCap = capexIndex[`${bid}:${month}`]   || 0;
      const bDep = depositIndex[`${bid}:${month}`] || 0;

      const centreContrib = revenue - agg.total_opex;
      const marginPct     = revenue > 0 ? Math.round(centreContrib / revenue * 1000) / 10 : null;
      const area          = branch.revenue_capacity_sqft || branch.total_area_sqft || 0;

      branchRows.push({
        branch_id:              bid,
        branch_name:            branch.branch_name,
        type:                   month <= cfg.actual_cutoff_month ? 'actual' : 'forecast',
        is_pre_opening:         isPreOpening,
        revenue:                Math.round(revenue * 100) / 100,
        rent:                   Math.round(agg.rent * 100) / 100,
        cam:                    Math.round(agg.cam * 100) / 100,
        utilities:              Math.round(agg.utilities * 100) / 100,
        facility:               Math.round(agg.facility * 100) / 100,
        people:                 Math.round(agg.people * 100) / 100,
        other_opex:             Math.round(agg.other_opex * 100) / 100,
        pre_opening_costs:      Math.round(agg.pre_opening * 100) / 100,
        total_opex:             Math.round(agg.total_opex * 100) / 100,
        centre_contribution:    Math.round(centreContrib * 100) / 100,
        contribution_margin_pct: marginPct,
        capex:                  Math.round(bCap * 100) / 100,
        deposit:                Math.round(bDep * 100) / 100,
        occupancy_pct:          occupancyPct,
        cost_lines:             costLines.map(l => ({
          assumption_id:    l.assumption_id,
          cost_category:    l.cost_category,
          cost_subcategory: l.cost_subcategory,
          cost_nature:      l.cost_nature,
          variability:      l.variability,
          calc_method:      l.calc_method,
          final_amount:     l.final_amount,
          is_rent_free:     l.is_rent_free,
          has_override:     l.has_override,
          override_amount:  l.override_amount,
        })),
        unit_economics: {
          area_sqft:                area,
          revenue_per_sqft:         area > 0 ? Math.round(revenue / area * 100) / 100 : null,
          rent_per_sqft:            area > 0 ? Math.round(agg.rent / area * 100) / 100 : null,
          opex_per_sqft:            area > 0 ? Math.round(agg.total_opex / area * 100) / 100 : null,
          contribution_per_sqft:    area > 0 ? Math.round(centreContrib / area * 100) / 100 : null,
          breakeven_occupancy_pct:  computeBreakEven(agg, revenue, area),
        },
        validation_flags: costLines.flatMap(l => l.validation_flags || []),
      });
    }

    const sum = k => branchRows.reduce((s, b) => s + (b[k] || 0), 0);
    const compRev   = sum('revenue');
    const compOpex  = sum('total_opex');
    const compCon   = compRev - compOpex;
    const compMargin = compRev > 0 ? Math.round(compCon / compRev * 1000) / 10 : null;

    monthRows.push({
      month,
      fy:                           getFY(month),
      type:                         month <= cfg.actual_cutoff_month ? 'actual' : 'forecast',
      company_revenue:              Math.round(compRev * 100) / 100,
      company_rent:                 Math.round(sum('rent') * 100) / 100,
      company_cam:                  Math.round(sum('cam') * 100) / 100,
      company_utilities:            Math.round(sum('utilities') * 100) / 100,
      company_facility:             Math.round(sum('facility') * 100) / 100,
      company_people:               Math.round(sum('people') * 100) / 100,
      company_other_opex:           Math.round(sum('other_opex') * 100) / 100,
      company_pre_opening:          Math.round(sum('pre_opening_costs') * 100) / 100,
      company_total_opex:           Math.round(compOpex * 100) / 100,
      company_contribution:         Math.round(compCon * 100) / 100,
      company_contribution_margin_pct: compMargin,
      company_capex:                Math.round(sum('capex') * 100) / 100,
      company_deposit:              Math.round(sum('deposit') * 100) / 100,
      branches:                     branchRows,
    });
  }

  const validationIssues = runCostValidations(costMaster, capexMaster, depositMaster, branches);
  const reconciliation   = runCostReconciliation(monthRows, projOutput.months || [], capexSchedule, depositSchedule);

  return {
    computed_at:      new Date().toISOString(),
    config_snapshot:  { ...cfg },
    months:           monthRows,
    capex_schedule:   capexSchedule,
    deposit_schedule: depositSchedule,
    validation_issues: validationIssues,
    reconciliation,
  };
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────
router.use(authMiddleware);

// ─── Config ────────────────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const d = await readCostConfig();
    res.json(d.forecast_config || DEFAULT_COST_CONFIG);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/config', adminOnly, async (req, res) => {
  try {
    const d = await readCostConfig();
    d.forecast_config = { ...(d.forecast_config || DEFAULT_COST_CONFIG), ...req.body };
    await writeCostConfig(d);
    res.json({ ok: true, config: d.forecast_config });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Cost Master CRUD ──────────────────────────────────────────────────────────
router.get('/cost-master', async (req, res) => {
  try {
    const d = await readCostMaster();
    const { branch_id } = req.query;
    const asms = branch_id
      ? (d.assumptions || []).filter(a => a.branch_id === branch_id)
      : (d.assumptions || []);
    res.json({ assumptions: asms, total: asms.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cost-master', adminOnly, async (req, res) => {
  try {
    const d   = await readCostMaster();
    const asm = { assumption_id: genId('CA'), ...req.body, active: true, last_updated: new Date().toISOString() };
    d.assumptions.push(asm);
    await writeCostMaster(d);
    res.json({ ok: true, assumption_id: asm.assumption_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/cost-master/:id', adminOnly, async (req, res) => {
  try {
    const d   = await readCostMaster();
    const idx = d.assumptions.findIndex(a => a.assumption_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    d.assumptions[idx] = { ...d.assumptions[idx], ...req.body, assumption_id: req.params.id, last_updated: new Date().toISOString() };
    await writeCostMaster(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/cost-master/:id', adminOnly, async (req, res) => {
  try {
    const d   = await readCostMaster();
    const idx = d.assumptions.findIndex(a => a.assumption_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    d.assumptions[idx].active = false;
    d.assumptions[idx].last_updated = new Date().toISOString();
    await writeCostMaster(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Capex Master CRUD ─────────────────────────────────────────────────────────
router.get('/capex-master', async (req, res) => {
  try {
    const d = await readCapexMaster();
    res.json({ capex_entries: d.capex_entries || [], total: (d.capex_entries || []).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/capex-master', adminOnly, async (req, res) => {
  try {
    const d  = await readCapexMaster();
    const cx = {
      capex_id: genId('CX'), ...req.body, active: true,
      payment_schedule: req.body.payment_schedule || [{ months_before_opening: 0, pct: 100 }],
      last_updated: new Date().toISOString(),
    };
    d.capex_entries.push(cx);
    await writeCapexMaster(d);
    res.json({ ok: true, capex_id: cx.capex_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/capex-master/:id', adminOnly, async (req, res) => {
  try {
    const d   = await readCapexMaster();
    const idx = d.capex_entries.findIndex(c => c.capex_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    d.capex_entries[idx] = { ...d.capex_entries[idx], ...req.body, capex_id: req.params.id, last_updated: new Date().toISOString() };
    await writeCapexMaster(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/capex-master/:id', adminOnly, async (req, res) => {
  try {
    const d   = await readCapexMaster();
    const idx = d.capex_entries.findIndex(c => c.capex_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    d.capex_entries[idx].active = false;
    d.capex_entries[idx].last_updated = new Date().toISOString();
    await writeCapexMaster(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Deposit Master CRUD ───────────────────────────────────────────────────────
router.get('/deposit-master', async (req, res) => {
  try {
    const d = await readDepositMaster();
    res.json({ deposits: d.deposits || [], total: (d.deposits || []).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/deposit-master', adminOnly, async (req, res) => {
  try {
    const d   = await readDepositMaster();
    const dep = { deposit_id: genId('SD'), ...req.body, active: true, last_updated: new Date().toISOString() };
    d.deposits.push(dep);
    await writeDepositMaster(d);
    res.json({ ok: true, deposit_id: dep.deposit_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/deposit-master/:id', adminOnly, async (req, res) => {
  try {
    const d   = await readDepositMaster();
    const idx = d.deposits.findIndex(dep => dep.deposit_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    d.deposits[idx] = { ...d.deposits[idx], ...req.body, deposit_id: req.params.id, last_updated: new Date().toISOString() };
    await writeDepositMaster(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/deposit-master/:id', adminOnly, async (req, res) => {
  try {
    const d   = await readDepositMaster();
    const idx = d.deposits.findIndex(dep => dep.deposit_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    d.deposits[idx].active = false;
    d.deposits[idx].last_updated = new Date().toISOString();
    await writeDepositMaster(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Monthly cost overrides ────────────────────────────────────────────────────
router.get('/overrides', async (req, res) => {
  try {
    const d = await readCostOverrides();
    res.json({ overrides: d.overrides || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/override', adminOnly, async (req, res) => {
  try {
    const { assumption_id, month, override_amount, reason } = req.body || {};
    if (!assumption_id || !month || override_amount == null)
      return res.status(400).json({ error: 'assumption_id, month, override_amount required' });
    const d = await readCostOverrides();
    const key = `${assumption_id}:${month}`;
    const idx = (d.overrides || []).findIndex(o => `${o.assumption_id}:${o.month}` === key);
    const entry = {
      id: genId('OV'), assumption_id, month, override_amount: Number(override_amount),
      reason: reason || null, user: req.user?.username || 'admin', timestamp: new Date().toISOString(),
    };
    if (idx === -1) d.overrides.push(entry);
    else d.overrides[idx] = entry;
    await writeCostOverrides(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/override/:assumption_id/:month', adminOnly, async (req, res) => {
  try {
    const { assumption_id, month } = req.params;
    const d = await readCostOverrides();
    d.overrides = (d.overrides || []).filter(o => !(o.assumption_id === assumption_id && o.month === month));
    await writeCostOverrides(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Compute (fire-and-forget) ─────────────────────────────────────────────────
router.post('/compute', adminOnly, async (req, res) => {
  if (costComputeInProgress) return res.json({ ok: false, message: 'Compute already running' });
  costComputeInProgress = true;
  res.json({ ok: true, message: 'Cost computation started in background' });
  (async () => {
    try {
      const output = await runCostComputation();
      await writeCostOutput(output);
      const cfg = await readCostConfig();
      cfg.forecast_config.last_computed_at = output.computed_at;
      await writeCostConfig(cfg);
      console.log(`[fpa-cost] Compute OK: ${output.months.length} months, ${output.validation_issues.length} issues`);
    } catch (err) {
      console.error('[fpa-cost] Compute error:', err.message);
    } finally { costComputeInProgress = false; }
  })();
});

// ─── Output metadata ──────────────────────────────────────────────────────────
router.get('/output', async (req, res) => {
  try {
    const [out, cfg] = await Promise.all([readCostOutput(), readCostConfig()]);
    res.json({
      computed_at:          out.computed_at,
      has_output:           !!out.computed_at,
      month_count:          (out.months || []).length,
      compute_in_progress:  costComputeInProgress,
      last_computed_at:     cfg.forecast_config?.last_computed_at,
      config_snapshot:      out.config_snapshot,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Summary KPIs ─────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const [out, cfg] = await Promise.all([readCostOutput(), readCostConfig()]);
    const months    = out.months || [];
    const config    = cfg.forecast_config || DEFAULT_COST_CONFIG;
    const fMonths   = months.filter(m => m.type === 'forecast');
    const today     = new Date();
    const currentFY = today.getMonth() >= 3
      ? `FY${today.getFullYear()}-${String(today.getFullYear() + 1).slice(2)}`
      : `FY${today.getFullYear() - 1}-${String(today.getFullYear()).slice(2)}`;
    const fyMonths  = months.filter(m => m.fy === currentFY);
    const fyRevenue = fyMonths.reduce((s, m) => s + m.company_revenue, 0);
    const fyOpex    = fyMonths.reduce((s, m) => s + m.company_total_opex, 0);
    const fyContrib = fyRevenue - fyOpex;
    const fyMargin  = fyRevenue > 0 ? Math.round(fyContrib / fyRevenue * 1000) / 10 : null;
    const totalCapex   = (out.capex_schedule || []).filter(r => r.in_range).reduce((s, r) => s + r.amount, 0);
    const totalDeposit = (out.deposit_schedule || []).filter(r => r.in_range).reduce((s, r) => s + r.deposit_amount, 0);

    res.json({
      has_output:              !!out.computed_at,
      computed_at:             out.computed_at,
      compute_in_progress:     costComputeInProgress,
      config,
      fy_label:                currentFY,
      fy_revenue:              Math.round(fyRevenue * 100) / 100,
      fy_total_opex:           Math.round(fyOpex * 100) / 100,
      fy_contribution:         Math.round(fyContrib * 100) / 100,
      fy_contribution_margin:  fyMargin,
      total_forecast_months:   fMonths.length,
      total_capex_in_range:    Math.round(totalCapex * 100) / 100,
      total_deposits_in_range: Math.round(totalDeposit * 100) / 100,
      validation_issue_count:  (out.validation_issues || []).length,
      reconciliation_pass:     out.reconciliation?.all_pass,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Monthly company view ─────────────────────────────────────────────────────
router.get('/monthly', async (req, res) => {
  try {
    const out = await readCostOutput();
    const rows = (out.months || []).map(m => ({
      month: m.month, fy: m.fy, type: m.type,
      company_revenue:  m.company_revenue,
      company_rent:     m.company_rent,
      company_cam:      m.company_cam,
      company_utilities: m.company_utilities,
      company_facility: m.company_facility,
      company_people:   m.company_people,
      company_other_opex: m.company_other_opex,
      company_total_opex: m.company_total_opex,
      company_contribution: m.company_contribution,
      company_contribution_margin_pct: m.company_contribution_margin_pct,
      company_capex:    m.company_capex,
      company_deposit:  m.company_deposit,
      branch_count:     (m.branches || []).length,
    }));
    res.json({ months: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Branch drilldown ─────────────────────────────────────────────────────────
router.get('/branch/:branch_id', async (req, res) => {
  try {
    const out  = await readCostOutput();
    const rows = (out.months || [])
      .map(m => {
        const b = (m.branches || []).find(b => b.branch_id === req.params.branch_id);
        return b ? { month: m.month, fy: m.fy, ...b } : null;
      })
      .filter(Boolean);
    res.json({ branch_id: req.params.branch_id, months: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Capex schedule ───────────────────────────────────────────────────────────
router.get('/capex-schedule', async (req, res) => {
  try {
    const out = await readCostOutput();
    res.json({ schedule: out.capex_schedule || [], total: (out.capex_schedule || []).reduce((s, r) => s + r.amount, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Deposit schedule ─────────────────────────────────────────────────────────
router.get('/deposit-schedule', async (req, res) => {
  try {
    const out = await readCostOutput();
    res.json({ schedule: out.deposit_schedule || [], total: (out.deposit_schedule || []).reduce((s, r) => s + r.deposit_amount, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reconciliation ───────────────────────────────────────────────────────────
router.get('/reconciliation', async (req, res) => {
  try {
    const out = await readCostOutput();
    res.json(out.reconciliation || { checks: [], all_pass: false, note: 'Not yet computed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Validation ───────────────────────────────────────────────────────────────
router.get('/validation', async (req, res) => {
  try {
    const out = await readCostOutput();
    res.json({ issues: out.validation_issues || [], count: (out.validation_issues || []).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Unit economics aggregate ─────────────────────────────────────────────────
router.get('/unit-economics', async (req, res) => {
  try {
    const out = await readCostOutput();
    const months = (out.months || []).filter(m => m.type === 'forecast');
    if (!months.length) return res.json({ months: [] });
    const rows = months.map(m => ({
      month: m.month, fy: m.fy,
      branches: (m.branches || []).map(b => ({
        branch_id: b.branch_id, branch_name: b.branch_name,
        revenue: b.revenue, total_opex: b.total_opex,
        centre_contribution: b.centre_contribution,
        contribution_margin_pct: b.contribution_margin_pct,
        occupancy_pct: b.occupancy_pct,
        ...b.unit_economics,
      })),
    }));
    res.json({ months: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
