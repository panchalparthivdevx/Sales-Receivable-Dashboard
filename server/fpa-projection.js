/**
 * FP&A Revenue Projection Engine — Step 4
 * Computes monthly projected revenue per branch and client.
 * Anti-double-count: client revenue + incremental vacant-capacity revenue only.
 * ISOLATED from P&L, Cash Bridge, Balance Sheet, Debt Schedule.
 * DO NOT connect this output to production financial statements until Step 5 approval.
 */

const express  = require('express');
const path     = require('path');
const router   = express.Router();
const db       = require('./db');
const { authMiddleware, adminOnly } = require('./auth');

// ─── File paths ───────────────────────────────────────────────────────────────
const FPA = path.join(__dirname, 'fpa');
const FILES = {
  projAssumptions: path.join(FPA, 'projection_assumptions.json'),
  projOutput:      path.join(FPA, 'projection_output.json'),
  branch:          path.join(FPA, 'branch_master.json'),
  client:          path.join(FPA, 'client_master.json'),
  mapping:         path.join(FPA, 'branch_client_mapping.json'),
  occupancy:       path.join(FPA, 'occupancy_assumptions.json'),
  global:          path.join(FPA, 'global_assumptions.json'),
  ramp:            path.join(FPA, 'ramp_templates.json'),
  actuals:         path.join(FPA, 'revenue_actuals.json'),
};
const KEYS = {
  projAssumptions: 'fpa_proj_assumptions',
  projOutput:      'fpa_proj_output',
  branch:          'fpa_branch_master',
  client:          'fpa_client_master',
  mapping:         'fpa_branch_client_mapping',
  occupancy:       'fpa_occupancy_assumptions',
  global:          'fpa_global_assumptions',
  ramp:            'fpa_ramp_templates',
  actuals:         'fpa_revenue_actuals',
};

const DEFAULT_CONFIG = {
  actual_cutoff_month:  '2026-09',
  forecast_start:       '2026-10',
  forecast_end:         '2029-03',
  scenario:             'base',
  proration_method:     'daily',
  version_label:        'FY2027-29 Base Case',
  locked:               false,
  last_computed_at:     null,
};

const DEFAULT_ASSUMPTIONS = {
  forecast_config: { ...DEFAULT_CONFIG },
  client_assumptions: [],
  branch_rate_overrides: {},
  overrides_log: [],
  last_updated: null,
};

const DEFAULT_OUTPUT = {
  computed_at: null, config_snapshot: null,
  months: [], bridge: [], validation_issues: [], reconciliation: {},
};

// ─── DB helpers ───────────────────────────────────────────────────────────────
const readPA  = () => db.readJSON(KEYS.projAssumptions, FILES.projAssumptions, DEFAULT_ASSUMPTIONS);
const readOut = () => db.readJSON(KEYS.projOutput,      FILES.projOutput,      DEFAULT_OUTPUT);
const readBranches  = () => db.readJSON(KEYS.branch,   FILES.branch,    { branches: [] });
const readClients   = () => db.readJSON(KEYS.client,   FILES.client,    { clients: [] });
const readMappings  = () => db.readJSON(KEYS.mapping,  FILES.mapping,   { mappings: [] });
const readOccupancy = () => db.readJSON(KEYS.occupancy,FILES.occupancy, { branch_templates: {}, overrides: {} });
const readGlobal    = () => db.readJSON(KEYS.global,   FILES.global,    {});
const readRamp      = () => db.readJSON(KEYS.ramp,     FILES.ramp,      { templates: {} });
const readActuals   = () => db.readJSON(KEYS.actuals,  FILES.actuals,   { invoices: [], credit_notes: [] });

async function writePA(data) {
  data.last_updated = new Date().toISOString();
  return db.writeJSON(KEYS.projAssumptions, FILES.projAssumptions, data);
}
const writeOut = (data) => db.writeJSON(KEYS.projOutput, FILES.projOutput, data);

// ─── Date / month utilities ───────────────────────────────────────────────────
function getMonthRange(startMonth, endMonth) {
  const months = [];
  let [y, m] = startMonth.split('-').map(Number);
  const [ey, em] = endMonth.split('-').map(Number);
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

function monthToDate(month) { return new Date(month + '-01'); }

// ─── Proration ────────────────────────────────────────────────────────────────
function prorateFactor(month, startDate, endDate, method = 'daily') {
  const [y, mo] = month.split('-').map(Number);
  const mStart = new Date(y, mo - 1, 1);
  const mEnd   = new Date(y, mo, 0); // last day
  const days   = daysInMonth(month);

  const cStart = startDate ? new Date(startDate) : null;
  const cEnd   = endDate   ? new Date(endDate)   : null;

  // Client entirely outside this month
  if (cStart && cStart > mEnd) return 0;
  if (cEnd   && cEnd   < mStart) return 0;

  if (method === 'full_month') return 1;

  if (method === 'next_full_month') {
    // Revenue only if client started on or before first of month
    return (cStart && cStart > mStart) ? 0 : 1;
  }

  // Daily proration
  const effStart = cStart && cStart > mStart ? cStart : mStart;
  const effEnd   = cEnd   && cEnd   < mEnd   ? cEnd   : mEnd;
  const activeDays = Math.floor((effEnd - effStart) / 86400000) + 1;
  return Math.max(0, Math.min(1, activeDays / days));
}

// ─── Escalation ───────────────────────────────────────────────────────────────
// Returns the base revenue adjusted for all escalation cycles up to targetMonth.
function applyEscalation(baseRevenue, targetMonth, escPct, effectiveDate, frequency = 'annual') {
  if (!escPct || !effectiveDate) return baseRevenue;
  const eff = new Date(effectiveDate + '-01');
  const tgt = new Date(targetMonth + '-01');
  if (tgt < eff) return baseRevenue; // escalation not yet in effect

  const factor = 1 + escPct / 100;

  if (frequency === 'one_time') return baseRevenue * factor;

  if (frequency === 'annual') {
    // Count annual cycles: each time we reach the anniversary of eff, revenue steps up
    let cycles = 0;
    let check = new Date(eff);
    while (check <= tgt) { cycles++; check.setFullYear(check.getFullYear() + 1); }
    return baseRevenue * Math.pow(factor, cycles);
  }

  return baseRevenue;
}

// ─── Escalation for a client (priority hierarchy) ────────────────────────────
function getEscalation(clientAssumption, clientRecord, branchRecord, global) {
  // Client-specific assumption overrides, then client_master field, then branch, then global
  const pct = clientAssumption?.escalation_pct
    ?? clientRecord?.escalation_pct
    ?? branchRecord?.revenue_escalation_pct
    ?? global?.revenue_escalation_pct ?? 5;

  const effectiveDate = clientAssumption?.escalation_effective_date
    ?? clientAssumption?.revenue_start_date
    ?? clientRecord?.contract_start_date
    ?? null;

  const frequency = clientAssumption?.escalation_frequency ?? 'annual';

  return { pct, effectiveDate, frequency };
}

// ─── Occupancy % for a branch/month ───────────────────────────────────────────
function getOccupancyPct(branchId, month, occupancy, rampTemplates, global, branchRecord) {
  // Level 1: monthly override
  const override = occupancy.overrides?.[branchId]?.[month];
  if (override !== undefined) return override;

  // Level 2: branch ramp template
  const templateName = occupancy.branch_templates?.[branchId]
    ?? branchRecord?.occupancy_ramp_template
    ?? global?.default_ramp_template ?? 'base';

  const template = rampTemplates.templates?.[templateName];
  if (!template) return branchRecord?.target_occupancy_pct ?? 80;

  // Index from branch opening date
  if (!branchRecord?.opening_date) return template.steady_state_pct ?? 100;

  const openMonth = branchRecord.opening_date.slice(0, 7);
  const idx = monthDiff(openMonth, month); // 0 = opening month

  if (idx < 0) return 0; // before opening
  if (idx < template.monthly_pct.length) return template.monthly_pct[idx];
  return template.steady_state_pct ?? template.monthly_pct[template.monthly_pct.length - 1];
}

// ─── Revenue rate for a branch ─────────────────────────────────────────────────
function getRevenueRate(branchId, branchRecord, global, branchRateOverrides) {
  return branchRateOverrides?.[branchId]
    ?? branchRecord?.revenue_per_sqft
    ?? global?.revenue_per_sqft
    ?? 130.74;
}

// ─── Derive base revenues from Step-3 actuals ─────────────────────────────────
function deriveBasesFromActuals(invoices, creditNotes, cutoffMonth) {
  // Group net revenue by customer_id + branch_id + month
  const byKey = {}; // `${customerId}:${branchId}` → { [month]: net }

  for (const inv of invoices) {
    if (!inv.customer_id || !inv.branch_id || !inv.month) continue;
    if (inv.month > cutoffMonth) continue;
    const k = `${inv.customer_id}:${inv.branch_id}`;
    if (!byKey[k]) byKey[k] = {};
    byKey[k][inv.month] = (byKey[k][inv.month] || 0) + (inv.sub_total || 0);
  }
  for (const cn of creditNotes) {
    if (!cn.customer_id || !cn.branch_id || !cn.month) continue;
    if (cn.month > cutoffMonth) continue;
    const k = `${cn.customer_id}:${cn.branch_id}`;
    if (!byKey[k]) byKey[k] = {};
    byKey[k][cn.month] = (byKey[k][cn.month] || 0) - (cn.sub_total || 0);
  }

  // For each key, compute: latest 3-month average (Priority 3), fallback all-time average (Priority 4)
  const bases = {};
  for (const [k, monthData] of Object.entries(byKey)) {
    const sorted = Object.entries(monthData).sort(([a], [b]) => b.localeCompare(a));
    const n = Math.min(3, sorted.length);
    const recent = sorted.slice(0, n);
    const avg = recent.reduce((s, [, v]) => s + v, 0) / n;
    const latestMonth = sorted[0][0];
    bases[k] = {
      derived_base:  Math.round(avg * 100) / 100,
      derived_source: n === 1 ? 'zoho_latest_1m' : `zoho_average_${n}m`,
      derived_month:  latestMonth,
    };
  }
  return bases;
}

// ─── Get effective base revenue for a client assumption ───────────────────────
function getClientBaseRevenue(asm, clientRecord, derivedBases) {
  // Priority 1: manual override
  if (asm?.manual_override_revenue != null) {
    return { revenue: asm.manual_override_revenue, source: 'manual_override' };
  }
  // Priority 2: contracted monthly revenue (in assumption OR client_master)
  const contracted = asm?.contracted_monthly_revenue ?? clientRecord?.current_monthly_revenue;
  if (contracted != null && contracted > 0) {
    return { revenue: contracted, source: 'contracted' };
  }
  // Priority 3 & 4: derived from Zoho actuals
  const zohoCustomerId = asm?.zoho_customer_id;
  const branchId       = asm?.branch_id;
  if (zohoCustomerId && branchId) {
    const d = derivedBases[`${zohoCustomerId}:${branchId}`];
    if (d) return { revenue: d.derived_base, source: d.derived_source };
  }
  return { revenue: null, source: 'missing' };
}

// ─── Compute one forecast month for a branch ──────────────────────────────────
function computeBranchForecast(month, branchRecord, activeMappings, clientAssumMap, clientMap,
                                occupancy, rampTemplates, global, branchRateOverrides, derivedBases,
                                prorationMethod) {
  const bid = branchRecord.branch_id;

  // Branch not yet open
  if (branchRecord.opening_date && month < branchRecord.opening_date.slice(0, 7)) {
    return buildBranchZero(bid, branchRecord.branch_name, month, 'not_open');
  }
  // Branch closed
  if (branchRecord.closing_date && month > branchRecord.closing_date.slice(0, 7)) {
    return buildBranchZero(bid, branchRecord.branch_name, month, 'closed');
  }

  const capacity   = branchRecord.revenue_capacity_sqft || branchRecord.total_area_sqft || 0;
  const occPct     = getOccupancyPct(bid, month, occupancy, rampTemplates, global, branchRecord);
  const rate       = getRevenueRate(bid, branchRecord, global, branchRateOverrides);
  const targetCap  = capacity * occPct / 100;

  const clients = [];
  let existingClientCapacity   = 0;
  let clientBaseRevenue        = 0;
  let clientEscalationRevenue  = 0;

  for (const mapping of activeMappings) {
    const asm         = clientAssumMap[mapping.mapping_id] || {};
    const clientRec   = clientMap[mapping.client_id] || {};
    const baseResult  = getClientBaseRevenue(asm, clientRec, derivedBases);
    const baseRev     = baseResult.revenue;

    if (baseRev == null) {
      clients.push({
        mapping_id: mapping.mapping_id, client_id: mapping.client_id,
        client_name: clientRec.client_name || mapping.client_id,
        base_revenue: 0, escalation_revenue: 0, total_revenue: 0,
        capacity_sqft: asm.capacity_sqft || 0,
        proration_factor: 0, override_flag: false,
        forecast_base_source: 'missing', validation_flag: 'MISSING_BASE_REVENUE',
      });
      continue;
    }

    const startDate = asm.revenue_start_date || clientRec.contract_start_date || null;
    const endDate   = asm.revenue_end_date   || clientRec.contract_end_date   || null;
    const proration = prorateFactor(month, startDate, endDate, prorationMethod);

    if (proration === 0) continue; // client not active this month

    const esc        = getEscalation(asm, clientRec, branchRecord, global);
    const escalated  = applyEscalation(baseRev, month, esc.pct, esc.effectiveDate, esc.frequency);
    const escalDelta = escalated - baseRev;

    const clientRevBase  = Math.round(baseRev  * proration * 100) / 100;
    const clientRevTotal = Math.round(escalated * proration * 100) / 100;
    const clientRevEscal = Math.round(escalDelta * proration * 100) / 100;

    const cap = asm.capacity_sqft || 0;

    clientBaseRevenue       += clientRevBase;
    clientEscalationRevenue += clientRevEscal;
    existingClientCapacity  += cap;

    clients.push({
      mapping_id: mapping.mapping_id, client_id: mapping.client_id,
      client_name: clientRec.client_name || mapping.client_id,
      base_revenue: clientRevBase, escalation_revenue: clientRevEscal, total_revenue: clientRevTotal,
      capacity_sqft: cap, proration_factor: proration,
      escalation_pct: esc.pct, escalation_effective_date: esc.effectiveDate,
      forecast_base_source: baseResult.source,
      override_flag: asm.manual_override_revenue != null,
      start_date: startDate, end_date: endDate,
    });
  }

  // Anti-double-count formula (Section 15 of brief)
  const incrementalCap    = Math.max(targetCap - existingClientCapacity, 0);
  const vacantCapRevenue  = Math.round(incrementalCap * rate * 100) / 100;
  const totalRevenue      = Math.round((clientBaseRevenue + clientEscalationRevenue + vacantCapRevenue) * 100) / 100;

  const validationFlags = [];
  if (capacity > 0 && existingClientCapacity > capacity) {
    validationFlags.push({ code: 'VP-C01', level: 'error', message: `Existing client capacity (${existingClientCapacity} sqft) exceeds branch capacity (${capacity} sqft)` });
  }
  if (occPct > 100) {
    validationFlags.push({ code: 'VP-C02', level: 'error', message: `Occupancy ${occPct}% exceeds 100%` });
  }
  if (existingClientCapacity > targetCap && targetCap > 0) {
    validationFlags.push({ code: 'VP-C03', level: 'info', message: `Existing client capacity (${existingClientCapacity} sqft) exceeds occupancy target (${Math.round(targetCap)} sqft) — incremental capacity = 0` });
  }

  return {
    branch_id: bid, branch_name: branchRecord.branch_name, month,
    type: 'forecast',
    client_base_revenue: Math.round(clientBaseRevenue * 100) / 100,
    client_escalation_revenue: Math.round(clientEscalationRevenue * 100) / 100,
    new_client_revenue: 0, exit_revenue_impact: 0,
    vacant_capacity_revenue: vacantCapRevenue,
    future_branch_revenue: 0,
    total_revenue: totalRevenue,
    total_capacity: capacity, existing_client_capacity: existingClientCapacity,
    target_capacity: Math.round(targetCap * 100) / 100,
    incremental_capacity: Math.round(incrementalCap * 100) / 100,
    occupancy_pct: occPct, revenue_rate: rate,
    clients, validation_flags: validationFlags,
  };
}

function buildBranchZero(branch_id, branch_name, month, reason) {
  return {
    branch_id, branch_name, month, type: reason,
    client_base_revenue: 0, client_escalation_revenue: 0,
    new_client_revenue: 0, exit_revenue_impact: 0,
    vacant_capacity_revenue: 0, future_branch_revenue: 0,
    total_revenue: 0, total_capacity: 0, existing_client_capacity: 0,
    target_capacity: 0, incremental_capacity: 0,
    occupancy_pct: 0, revenue_rate: 0, clients: [], validation_flags: [],
  };
}

// ─── Aggregate actuals from Step-3 for a month ────────────────────────────────
function aggregateActualMonth(month, invoices, creditNotes, branches) {
  const byBranch = {};
  for (const inv of [...invoices, ...creditNotes]) {
    if (inv.month !== month) continue;
    const bid = inv.branch_id || '_unmapped';
    if (!byBranch[bid]) byBranch[bid] = { total: 0, clients: {} };
    const sign = inv.is_credit_note ? -1 : 1;
    byBranch[bid].total += sign * (inv.sub_total || 0);
    const cid = inv.customer_id || '_unknown';
    if (!byBranch[bid].clients[cid]) byBranch[bid].clients[cid] = { customer_name: inv.customer_name, total: 0 };
    byBranch[bid].clients[cid].total += sign * (inv.sub_total || 0);
  }

  const branchRows = Object.entries(byBranch).map(([bid, d]) => {
    const br = branches.find(b => b.branch_id === bid);
    return {
      branch_id: bid, branch_name: br?.branch_name || bid, month, type: 'actual',
      actual_revenue: Math.round(d.total * 100) / 100,
      client_base_revenue: 0, client_escalation_revenue: 0,
      new_client_revenue: 0, exit_revenue_impact: 0,
      vacant_capacity_revenue: 0, future_branch_revenue: 0,
      total_revenue: Math.round(d.total * 100) / 100,
      total_capacity: br?.revenue_capacity_sqft || 0,
      existing_client_capacity: 0, target_capacity: 0, incremental_capacity: 0,
      occupancy_pct: null, revenue_rate: null,
      clients: Object.entries(d.clients).map(([cid, c]) => ({
        client_id: cid, client_name: c.customer_name, total_revenue: Math.round(c.total * 100) / 100,
        base_revenue: 0, escalation_revenue: 0, capacity_sqft: 0, proration_factor: 1,
        forecast_base_source: 'actual',
      })),
      validation_flags: [],
    };
  });

  const companyTotal = branchRows.reduce((s, b) => s + b.total_revenue, 0);
  return { month, fy: getFY(month), type: 'actual', company_total: Math.round(companyTotal * 100) / 100, branches: branchRows };
}

// ─── Build revenue bridge ──────────────────────────────────────────────────────
function buildRevenueBridge(monthRows) {
  const bridge = [];
  for (let i = 0; i < monthRows.length; i++) {
    const curr = monthRows[i];
    const prev = i > 0 ? monthRows[i - 1] : null;
    const opening = prev ? prev.company_total : 0;
    const closing = curr.company_total;

    // Decompose change into components
    const escalation = curr.branches.reduce((s, b) => s + (b.client_escalation_revenue || 0), 0);
    const vacCap     = curr.branches.reduce((s, b) => s + (b.vacant_capacity_revenue || 0), 0);
    const clientBase = curr.branches.reduce((s, b) => s + (b.client_base_revenue || 0), 0);
    const other      = closing - opening;

    bridge.push({
      month: curr.month, fy: curr.fy, type: curr.type,
      opening_revenue: Math.round(opening * 100) / 100,
      client_base: Math.round(clientBase * 100) / 100,
      escalation_additions: Math.round(escalation * 100) / 100,
      new_client_additions: Math.round(curr.branches.reduce((s, b) => s + (b.new_client_revenue || 0), 0) * 100) / 100,
      exit_deductions: Math.round(curr.branches.reduce((s, b) => s + (b.exit_revenue_impact || 0), 0) * 100) / 100,
      vacant_capacity: Math.round(vacCap * 100) / 100,
      future_branch: Math.round(curr.branches.reduce((s, b) => s + (b.future_branch_revenue || 0), 0) * 100) / 100,
      closing_revenue: Math.round(closing * 100) / 100,
      net_movement: Math.round((closing - opening) * 100) / 100,
    });
  }
  return bridge;
}

// ─── Projection validation ────────────────────────────────────────────────────
function runProjectionValidations(monthRows, config) {
  const issues = [];

  for (const mRow of monthRows) {
    for (const b of mRow.branches) {
      for (const flag of b.validation_flags || []) {
        issues.push({ month: mRow.month, branch_id: b.branch_id, branch_name: b.branch_name, ...flag });
      }
      for (const c of b.clients || []) {
        if (c.validation_flag) {
          issues.push({
            month: mRow.month, branch_id: b.branch_id, branch_name: b.branch_name,
            client_id: c.client_id, client_name: c.client_name,
            code: c.validation_flag, level: 'warning',
            message: `${c.client_name}: ${c.validation_flag}`,
          });
        }
      }
    }
  }
  return issues;
}

// ─── Reconciliation ───────────────────────────────────────────────────────────
function runReconciliation(monthRows, invoices, creditNotes, config) {
  const checks = [];

  // RC-P01: actual months: projection total ≈ Step-3 actual total
  const actualMonths = monthRows.filter(m => m.type === 'actual');
  if (actualMonths.length > 0) {
    const projActualTotal = actualMonths.reduce((s, m) => s + m.company_total, 0);
    const step3Total = [...invoices, ...creditNotes].filter(r => r.month <= config.actual_cutoff_month)
      .reduce((s, r) => s + (r.is_credit_note ? -(r.sub_total || 0) : (r.sub_total || 0)), 0);
    const gap = Math.abs(projActualTotal - step3Total);
    checks.push({
      id: 'RC-P01', name: 'Actual months: Projection matches Step-3 actuals',
      pass: gap < 1, gap: Math.round((projActualTotal - step3Total) * 100) / 100,
      projection_total: Math.round(projActualTotal * 100) / 100,
      step3_total: Math.round(step3Total * 100) / 100,
      note: actualMonths.length === 0 ? 'No actual months in range' : undefined,
    });
  } else {
    checks.push({ id: 'RC-P01', name: 'Actual months: Projection matches Step-3 actuals', pass: true, note: 'No actual months in projection range — all forecast' });
  }

  // RC-P02: forecast months: branch total = client revenue + vacant capacity
  const forecastMonths = monthRows.filter(m => m.type === 'forecast');
  let p02Pass = true; let p02MaxGap = 0;
  for (const mRow of forecastMonths) {
    for (const b of mRow.branches) {
      const computed = (b.client_base_revenue || 0) + (b.client_escalation_revenue || 0) + (b.vacant_capacity_revenue || 0);
      const gap = Math.abs(computed - b.total_revenue);
      if (gap > 0.05) { p02Pass = false; if (gap > p02MaxGap) p02MaxGap = gap; }
    }
  }
  checks.push({ id: 'RC-P02', name: 'Forecast branch total = Client Revenue + Vacant Capacity', pass: p02Pass, max_gap: Math.round(p02MaxGap * 100) / 100 });

  // RC-P03: company revenue = sum of branch revenues (per month)
  let p03Pass = true; let p03MaxGap = 0;
  for (const mRow of monthRows) {
    const branchSum = mRow.branches.reduce((s, b) => s + b.total_revenue, 0);
    const gap = Math.abs(branchSum - mRow.company_total);
    if (gap > 0.05) { p03Pass = false; if (gap > p03MaxGap) p03MaxGap = gap; }
  }
  checks.push({ id: 'RC-P03', name: 'Company revenue = sum of all branch revenues', pass: p03Pass, max_gap: Math.round(p03MaxGap * 100) / 100 });

  // RC-P04: client capacity + incremental capacity ≤ total capacity (per branch/month)
  let p04Pass = true; const p04Violations = [];
  for (const mRow of forecastMonths) {
    for (const b of mRow.branches) {
      if (b.total_capacity > 0) {
        const used = (b.existing_client_capacity || 0) + (b.incremental_capacity || 0);
        if (used > b.total_capacity + 0.01) {
          p04Pass = false;
          p04Violations.push(`${b.branch_id} ${mRow.month}: used=${used} > capacity=${b.total_capacity}`);
        }
      }
    }
  }
  checks.push({ id: 'RC-P04', name: 'Client capacity + incremental capacity ≤ total capacity', pass: p04Pass, violations: p04Violations.slice(0, 5) });

  // RC-P05: revenue bridge reconciles
  const bridge = buildRevenueBridge(monthRows);
  let p05Pass = true; let p05MaxGap = 0;
  for (const row of bridge) {
    const expected = row.opening_revenue + row.escalation_additions + row.new_client_additions - Math.abs(row.exit_deductions) + row.vacant_capacity + row.future_branch;
    // For actual months the bridge doesn't decompose — skip
    if (row.type === 'actual') continue;
    const gap = Math.abs(expected - row.closing_revenue);
    if (gap > 1) { p05Pass = false; if (gap > p05MaxGap) p05MaxGap = gap; }
  }
  checks.push({ id: 'RC-P05', name: 'Revenue bridge: Opening + Additions − Exits + Capacity = Closing', pass: p05Pass, max_gap: Math.round(p05MaxGap * 100) / 100, note: 'Actual months excluded from bridge check' });

  return { checks, all_pass: checks.every(c => c.pass) };
}

// ─── MAIN COMPUTATION ENGINE ──────────────────────────────────────────────────
let computeInProgress = false;

async function runComputation(pa) {
  const config = pa.forecast_config;
  const [{ branches }, { clients }, { mappings }, occupancy, global, rampData, actuals] = await Promise.all([
    readBranches(), readClients(), readMappings(),
    readOccupancy(), readGlobal(), readRamp(), readActuals(),
  ]);

  const activeBranches = branches.filter(b => b.active !== false);
  const clientMap      = Object.fromEntries(clients.map(c => [c.client_id, c]));
  const clientAssumMap = Object.fromEntries((pa.client_assumptions || []).map(a => [a.mapping_id, a]));

  const derivedBases = deriveBasesFromActuals(actuals.invoices || [], actuals.credit_notes || [], config.actual_cutoff_month);

  const allMonths   = getMonthRange(config.forecast_start, config.forecast_end);
  const cutoff      = config.actual_cutoff_month;
  const prorationM  = config.proration_method || 'daily';

  const monthRows = [];

  for (const month of allMonths) {
    const isActual = month <= cutoff;

    if (isActual) {
      const row = aggregateActualMonth(month, actuals.invoices || [], actuals.credit_notes || [], branches);
      monthRows.push(row);
    } else {
      // Forecast month
      const branchRows = [];
      for (const branch of activeBranches) {
        const activeMappings = mappings.filter(m => m.branch_id === branch.branch_id && m.active !== false);
        const row = computeBranchForecast(
          month, branch, activeMappings, clientAssumMap, clientMap,
          occupancy, rampData, global, pa.branch_rate_overrides || {},
          derivedBases, prorationM,
        );
        branchRows.push(row);
      }
      const companyTotal = branchRows.reduce((s, b) => s + b.total_revenue, 0);
      monthRows.push({
        month, fy: getFY(month), type: 'forecast', scenario: config.scenario,
        company_total: Math.round(companyTotal * 100) / 100,
        branches: branchRows,
      });
    }
  }

  const bridge      = buildRevenueBridge(monthRows);
  const valIssues   = runProjectionValidations(monthRows, config);
  const recon       = runReconciliation(monthRows, actuals.invoices || [], actuals.credit_notes || [], config);

  return {
    computed_at: new Date().toISOString(),
    config_snapshot: { ...config },
    months: monthRows,
    bridge,
    validation_issues: valIssues,
    reconciliation: recon,
  };
}

// ─── AUTH on all routes ───────────────────────────────────────────────────────
router.use(authMiddleware);

// ─── GET /api/fpa/projection/config ──────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const pa = await readPA();
    res.json(pa.forecast_config || DEFAULT_CONFIG);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/fpa/projection/config ──────────────────────────────────────────
router.put('/config', adminOnly, async (req, res) => {
  try {
    const pa = await readPA();
    pa.forecast_config = { ...(pa.forecast_config || DEFAULT_CONFIG), ...req.body };
    await writePA(pa);
    res.json({ ok: true, config: pa.forecast_config });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/fpa/projection/assumptions ─────────────────────────────────────
router.get('/assumptions', async (req, res) => {
  try {
    const pa = await readPA();
    res.json({ assumptions: pa.client_assumptions || [], branch_rate_overrides: pa.branch_rate_overrides || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/fpa/projection/assumptions/bulk-escalation ────────────────────
// MUST be defined BEFORE the :mapping_id route to avoid param capture.
// Apply a single escalation_pct to selected clients or all clients.
router.put('/assumptions/bulk-escalation', adminOnly, async (req, res) => {
  try {
    const { mapping_ids, escalation_pct, apply_to_all } = req.body || {};
    if (escalation_pct == null) return res.status(400).json({ error: 'escalation_pct required' });
    const pa = await readPA();
    if (!pa.client_assumptions) return res.json({ ok: true, updated: 0 });
    let updated = 0;
    pa.client_assumptions.forEach(a => {
      if (apply_to_all || (Array.isArray(mapping_ids) && mapping_ids.includes(a.mapping_id))) {
        a.escalation_pct = Number(escalation_pct);
        a.escalation_source = 'bulk_management_input';
        a.escalation_set_at = new Date().toISOString();
        updated++;
      }
    });
    await writePA(pa);
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/fpa/projection/assumptions/:mapping_id ─────────────────────────
router.put('/assumptions/:mapping_id', async (req, res) => {
  try {
    const { mapping_id } = req.params;
    const patch = req.body || {};
    const pa = await readPA();
    if (!pa.client_assumptions) pa.client_assumptions = [];
    const idx = pa.client_assumptions.findIndex(a => a.mapping_id === mapping_id);
    if (idx === -1) {
      pa.client_assumptions.push({ mapping_id, ...patch });
    } else {
      pa.client_assumptions[idx] = { ...pa.client_assumptions[idx], ...patch };
    }
    await writePA(pa);
    res.json({ ok: true, mapping_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/fpa/projection/branch-rate ─────────────────────────────────────
router.put('/branch-rate', adminOnly, async (req, res) => {
  try {
    const { branch_id, rate } = req.body || {};
    if (!branch_id) return res.status(400).json({ error: 'branch_id required' });
    const pa = await readPA();
    if (!pa.branch_rate_overrides) pa.branch_rate_overrides = {};
    if (rate == null) {
      delete pa.branch_rate_overrides[branch_id];
    } else {
      pa.branch_rate_overrides[branch_id] = Number(rate);
    }
    await writePA(pa);
    res.json({ ok: true, branch_id, rate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/fpa/projection/derive-bases ────────────────────────────────────
// Auto-populates base revenues from Step-3 actuals for all active mappings.
router.post('/derive-bases', adminOnly, async (req, res) => {
  try {
    const [pa, { mappings }, actuals] = await Promise.all([readPA(), readMappings(), readActuals()]);
    const config = pa.forecast_config || DEFAULT_CONFIG;
    const derived = deriveBasesFromActuals(actuals.invoices || [], actuals.credit_notes || [], config.actual_cutoff_month);

    if (!pa.client_assumptions) pa.client_assumptions = [];

    let updated = 0;
    for (const mapping of mappings.filter(m => m.active !== false)) {
      const zohoId  = mapping.zoho_customer_id;
      const branchId = mapping.branch_id;
      const key = `${zohoId}:${branchId}`;
      const d = derived[key];
      if (!d) continue;

      const idx = pa.client_assumptions.findIndex(a => a.mapping_id === mapping.mapping_id);
      const base = {
        mapping_id: mapping.mapping_id,
        client_id: mapping.client_id,
        branch_id: branchId,
        zoho_customer_id: zohoId,
      };
      if (idx === -1) {
        pa.client_assumptions.push({ ...base, derived_base_revenue: d.derived_base, derived_base_source: d.derived_source, derived_base_month: d.derived_month, forecast_status: 'active' });
      } else {
        pa.client_assumptions[idx] = {
          ...pa.client_assumptions[idx],
          derived_base_revenue: d.derived_base, derived_base_source: d.derived_source, derived_base_month: d.derived_month,
        };
      }
      updated++;
    }
    await writePA(pa);
    res.json({ ok: true, updated, total_derived: Object.keys(derived).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/fpa/projection/compute ────────────────────────────────────────
router.post('/compute', adminOnly, async (req, res) => {
  if (computeInProgress) return res.json({ ok: false, message: 'Compute already running' });
  computeInProgress = true;
  res.json({ ok: true, message: 'Computation started in background' });
  (async () => {
    try {
      const pa = await readPA();
      const output = await runComputation(pa);
      await writeOut(output);
      pa.forecast_config.last_computed_at = output.computed_at;
      await writePA(pa);
      console.log(`[fpa-projection] Compute OK: ${output.months.length} months`);
    } catch (err) {
      console.error('[fpa-projection] Compute error:', err.message);
    } finally { computeInProgress = false; }
  })();
});

// ─── GET /api/fpa/projection/output ──────────────────────────────────────────
router.get('/output', async (req, res) => {
  try {
    const [out, pa] = await Promise.all([readOut(), readPA()]);
    res.json({
      computed_at: out.computed_at,
      config_snapshot: out.config_snapshot,
      month_count: (out.months || []).length,
      compute_in_progress: computeInProgress,
      last_computed_at: pa.forecast_config?.last_computed_at,
      has_output: !!out.computed_at,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/fpa/projection/monthly ─────────────────────────────────────────
router.get('/monthly', async (req, res) => {
  try {
    const out = await readOut();
    const rows = (out.months || []).map(m => ({
      month: m.month, fy: m.fy, type: m.type, scenario: m.scenario,
      company_total: m.company_total,
      client_base: m.branches?.reduce((s, b) => s + (b.client_base_revenue || 0), 0) || 0,
      client_escalation: m.branches?.reduce((s, b) => s + (b.client_escalation_revenue || 0), 0) || 0,
      vacant_capacity: m.branches?.reduce((s, b) => s + (b.vacant_capacity_revenue || 0), 0) || 0,
      branch_count: m.branches?.length || 0,
      validation_issue_count: (out.validation_issues || []).filter(v => v.month === m.month).length,
    }));
    res.json({ months: rows, total_months: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/fpa/projection/branch/:branch_id ───────────────────────────────
router.get('/branch/:branch_id', async (req, res) => {
  try {
    const out = await readOut();
    const rows = (out.months || [])
      .map(m => {
        const b = (m.branches || []).find(b => b.branch_id === req.params.branch_id);
        return b ? { month: m.month, fy: m.fy, month_type: m.type, ...b } : null;
      })
      .filter(Boolean);
    res.json({ branch_id: req.params.branch_id, months: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/fpa/projection/bridge ──────────────────────────────────────────
router.get('/bridge', async (req, res) => {
  try {
    const out = await readOut();
    res.json({ bridge: out.bridge || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/fpa/projection/reconciliation ──────────────────────────────────
router.get('/reconciliation', async (req, res) => {
  try {
    const out = await readOut();
    res.json(out.reconciliation || { checks: [], all_pass: false, note: 'Not yet computed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/fpa/projection/validation ──────────────────────────────────────
router.get('/validation', async (req, res) => {
  try {
    const out = await readOut();
    const issues = out.validation_issues || [];
    res.json({ count: issues.length, issues });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/fpa/projection/summary ─────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const [out, pa] = await Promise.all([readOut(), readPA()]);
    const months = out.months || [];
    const config = pa.forecast_config || DEFAULT_CONFIG;

    const actualMonths   = months.filter(m => m.type === 'actual');
    const forecastMonths = months.filter(m => m.type === 'forecast');

    const lastActual  = actualMonths[actualMonths.length - 1];
    const firstFcast  = forecastMonths[0];

    // FY totals (current FY based on today)
    const today = new Date();
    const currentFY = today.getMonth() >= 3
      ? `FY${today.getFullYear()}-${String(today.getFullYear() + 1).slice(2)}`
      : `FY${today.getFullYear() - 1}-${String(today.getFullYear()).slice(2)}`;

    const fyMonths = months.filter(m => m.fy === currentFY);
    const fyTotal  = fyMonths.reduce((s, m) => s + m.company_total, 0);

    res.json({
      has_output: !!out.computed_at,
      computed_at: out.computed_at,
      compute_in_progress: computeInProgress,
      config,
      last_actual_month: lastActual?.month,
      last_actual_revenue: lastActual?.company_total || 0,
      first_forecast_month: firstFcast?.month,
      first_forecast_revenue: firstFcast?.company_total || 0,
      fy_label: currentFY,
      fy_forecast_total: Math.round(fyTotal * 100) / 100,
      total_actual_months: actualMonths.length,
      total_forecast_months: forecastMonths.length,
      validation_issue_count: (out.validation_issues || []).length,
      reconciliation_pass: out.reconciliation?.all_pass,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
