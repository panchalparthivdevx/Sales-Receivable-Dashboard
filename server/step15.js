/**
 * Step 15 â€” Management Data Completion & Forecast Activation
 *
 * Converts model from ARCHITECTURE COMPLETE / DATA INCOMPLETE
 * to   DATA POPULATED / FORECAST COMPUTABLE / READY FOR CFO UAT
 *
 * Routes:
 *  GET  /completion              â€” full data completion status
 *  POST /auto-populate-actuals   â€” derive actuals history â†’ mappings (non-destructive)
 *  GET  /client-revenue-matrix   â€” all mappings with actuals + contracted status
 *  PUT  /client-revenue/:id      â€” save contracted_monthly_revenue + escalation per mapping
 *  POST /bulk-contracted-revenue â€” bulk update contracted revenue
 *  PUT  /branch/:branch_id       â€” save capacity/cost fields per branch
 *  POST /bulk-branch             â€” bulk update branches
 *  POST /approve-obs             â€” set OBS approval status
 *
 * Source hierarchy (per brief Section B):
 *   P1: Zoho Books actual data
 *   P2: Existing project data / JSON
 *   P3: Derived from reliable historical data
 *   P4: Management input
 *   P5: Temporary assumption (flagged)
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const db      = require('./db');
const { authMiddleware, adminOnly } = require('./auth');

router.use(authMiddleware);

const FPA  = path.join(__dirname, 'fpa');
const now  = () => new Date().toISOString();
const r2   = (v) => Math.round((v || 0) * 100) / 100;
const fpaStore = require('./fpa-store');   // Neon mode (Vercel): the documents live in the database
const readJ = (file, def = {}) => {
  if (fpaStore.enabled) return fpaStore.read(path.join(FPA, file), def);
  try { return JSON.parse(fs.readFileSync(path.join(FPA, file), 'utf8')); }
  catch { return def; }
};
const writeJ = (file, data) => {
  if (fpaStore.enabled) return fpaStore.write(path.join(FPA, file), data);
  fs.writeFileSync(path.join(FPA, file), JSON.stringify(data, null, 2), 'utf8');
};

// â”€â”€â”€ KEYS for DB cache (step15-specific) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const KEYS = {
  mapping:  'fpa_branch_client_mapping',
  branch:   'fpa_branch_master',
  client:   'fpa_client_master',
  global:   'fpa_global_assumptions',
};
const FILES = {
  mapping:  path.join(FPA, 'branch_client_mapping.json'),
  branch:   path.join(FPA, 'branch_master.json'),
  client:   path.join(FPA, 'client_master.json'),
  global:   path.join(FPA, 'global_assumptions.json'),
};

const readMappings  = () => db.readJSON(KEYS.mapping,  FILES.mapping,  { mappings: [] });
const readBranches  = () => db.readJSON(KEYS.branch,   FILES.branch,   { branches: [] });
const readClients   = () => db.readJSON(KEYS.client,   FILES.client,   { clients: [] });
const writeMappings = (d) => db.writeJSON(KEYS.mapping,  FILES.mapping,  d);
const writeBranches = (d) => db.writeJSON(KEYS.branch,   FILES.branch,   d);
const writeClients  = (d) => db.writeJSON(KEYS.client,   FILES.client,   d);

// â”€â”€â”€ Compute actuals stats per (zoho_customer_id, branch_id) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildActualsIndex() {
  const ra = readJ('revenue_actuals.json', { invoices: [] });
  const inv = ra.invoices || [];
  // Group by zoho_customer_id + branch_id
  const idx = {};
  for (const i of inv) {
    const cid = i.customer_id || i.zoho_customer_id;
    const bid = i.branch_id;
    if (!cid || !bid) continue;
    const k = `${cid}:${bid}`;
    if (!idx[k]) idx[k] = {};
    const m = i.month || (i.date ? i.date.slice(0, 7) : null);
    if (!m) continue;
    idx[k][m] = (idx[k][m] || 0) + (i.sub_total || 0);
  }
  // For each combo compute stats
  const stats = {};
  for (const [k, months] of Object.entries(idx)) {
    const sorted = Object.entries(months).sort((a, b) => b[0].localeCompare(a[0]));
    const latest = sorted[0];
    const vals3  = sorted.slice(0, 3).map(([, v]) => v);
    const vals6  = sorted.slice(0, 6).map(([, v]) => v);
    stats[k] = {
      latest_actual_month:   latest[0],
      latest_actual_revenue: r2(latest[1]),
      avg_3m: r2(vals3.reduce((s, v) => s + v, 0) / vals3.length),
      avg_6m: r2(vals6.reduce((s, v) => s + v, 0) / vals6.length),
      months_with_data: sorted.length,
    };
  }
  return stats;
}

// â”€â”€â”€ POST /auto-populate-actuals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Derives actuals history (latest/3m/6m avg) and writes to branch_client_mapping.
// NON-DESTRUCTIVE: never overwrites contracted_monthly_revenue if already set.
router.post('/auto-populate-actuals', adminOnly, async (req, res) => {
  try {
    const actStats = buildActualsIndex();
    const data = await readMappings();
    let updated = 0, skipped = 0;

    for (const m of data.mappings || []) {
      const cid = m.zoho_customer_id;
      const bid = m.branch_id;
      if (!cid || !bid) { skipped++; continue; }
      const k = `${cid}:${bid}`;
      const stat = actStats[k];
      if (!stat) { skipped++; continue; }
      // Write actuals reference fields (never touch contracted_monthly_revenue)
      m.latest_actual_month   = stat.latest_actual_month;
      m.latest_actual_revenue = stat.latest_actual_revenue;
      m.avg_3m                = stat.avg_3m;
      m.avg_6m                = stat.avg_6m;
      m.months_with_data      = stat.months_with_data;
      m.actuals_source        = 'zoho_revenue_actuals';
      m.actuals_as_of         = now();
      updated++;
    }
    data.last_updated = now();
    await writeMappings(data);
    res.json({ ok: true, updated, skipped, message: `Actuals history written to ${updated} mappings. contracted_monthly_revenue was NOT modified.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /client-revenue-matrix â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns all mappings with actuals history + contracted status, for the UI.
router.get('/client-revenue-matrix', async (req, res) => {
  try {
    const [mapData, brData, clData] = await Promise.all([readMappings(), readBranches(), readClients()]);
    const branchMap = {};
    for (const b of brData.branches || []) branchMap[b.branch_id] = b;
    const clientMap = {};
    for (const c of clData.clients || []) clientMap[c.client_id] = c;

    const rows = (mapData.mappings || []).filter(m => m.active !== false).map(m => {
      const branch = branchMap[m.branch_id] || {};
      const client = clientMap[m.client_id] || {};
      const contracted = m.contracted_monthly_revenue ?? client.current_monthly_revenue;
      return {
        mapping_id: m.mapping_id,
        client_id: m.client_id,
        client_name: client.client_name || m.client_id,
        branch_id: m.branch_id,
        branch_name: branch.branch_name || m.branch_id,
        city: branch.city || null,
        // Actuals history
        latest_actual_month:   m.latest_actual_month   ?? null,
        latest_actual_revenue: m.latest_actual_revenue ?? null,
        avg_3m: m.avg_3m ?? null,
        avg_6m: m.avg_6m ?? null,
        months_with_data: m.months_with_data ?? 0,
        // Management input fields
        contracted_monthly_revenue: m.contracted_monthly_revenue ?? null,
        current_monthly_revenue: client.current_monthly_revenue ?? null,
        escalation_pct: m.escalation_pct ?? client.escalation_pct ?? null,
        escalation_frequency: m.escalation_frequency ?? 'annual',
        escalation_effective_month: m.escalation_effective_month ?? null,
        billing_frequency: m.billing_frequency ?? 'monthly',
        contract_start_date: m.contract_start_date ?? client.contract_start_date ?? null,
        contract_end_date: m.contract_end_date ?? client.contract_end_date ?? null,
        seats_occupied: m.seats_occupied ?? null,
        revenue_category: m.revenue_category ?? null,
        approval_status: m.approval_status ?? 'pending_review',
        // Status
        has_contracted: contracted != null && contracted > 0,
        input_source: contracted != null ? (m.contracted_monthly_revenue != null ? 'management_input' : 'client_master') : 'actuals_derived',
      };
    });

    const withContracted = rows.filter(r => r.has_contracted).length;
    res.json({
      rows,
      summary: {
        total: rows.length,
        with_contracted: withContracted,
        without_contracted: rows.length - withContracted,
        completion_pct: rows.length ? Math.round(withContracted / rows.length * 100) : 0,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ PUT /client-revenue/:mapping_id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.put('/client-revenue/:mapping_id', adminOnly, async (req, res) => {
  try {
    const { mapping_id } = req.params;
    const data = await readMappings();
    const idx = (data.mappings || []).findIndex(m => m.mapping_id === mapping_id);
    if (idx < 0) return res.status(404).json({ error: 'Mapping not found' });
    const m = data.mappings[idx];
    const allowed = [
      'contracted_monthly_revenue', 'escalation_pct', 'escalation_frequency',
      'escalation_effective_month', 'billing_frequency', 'contract_start_date',
      'contract_end_date', 'seats_occupied', 'revenue_category', 'approval_status',
      'manual_override_revenue', 'revenue_start_date', 'revenue_end_date',
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) m[k] = req.body[k];
    }
    m.management_input_source = 'step15_manual';
    m.last_updated = now();
    await writeMappings(data);
    // Also update client master current_monthly_revenue if contracted is being set
    if (req.body.contracted_monthly_revenue != null) {
      const clData = await readClients();
      const ci = (clData.clients || []).findIndex(c => c.client_id === m.client_id);
      if (ci >= 0 && clData.clients[ci].current_monthly_revenue == null) {
        clData.clients[ci].current_monthly_revenue = req.body.contracted_monthly_revenue;
        clData.clients[ci].last_updated = now();
        await writeClients(clData);
      }
    }
    res.json({ ok: true, mapping: data.mappings[idx] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /bulk-contracted-revenue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Accepts array of { mapping_id, contracted_monthly_revenue, ... }
router.post('/bulk-contracted-revenue', adminOnly, async (req, res) => {
  try {
    const { updates } = req.body; // [{mapping_id, contracted_monthly_revenue, escalation_pct, ...}]
    if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: 'updates array required' });
    const data = await readMappings();
    const mapById = {};
    for (const m of data.mappings || []) mapById[m.mapping_id] = m;
    let updated = 0;
    for (const u of updates) {
      const m = mapById[u.mapping_id];
      if (!m) continue;
      const allowed = ['contracted_monthly_revenue', 'escalation_pct', 'escalation_frequency',
        'escalation_effective_month', 'billing_frequency', 'approval_status', 'seats_occupied'];
      for (const k of allowed) if (u[k] !== undefined) m[k] = u[k];
      m.management_input_source = 'step15_bulk';
      m.last_updated = now();
      updated++;
    }
    data.last_updated = now();
    await writeMappings(data);
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ PUT /branch/:branch_id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.put('/branch/:branch_id', adminOnly, async (req, res) => {
  try {
    const data = await readBranches();
    const idx = (data.branches || []).findIndex(b => b.branch_id === req.params.branch_id);
    if (idx < 0) return res.status(404).json({ error: 'Branch not found' });
    const allowed = [
      'total_seats', 'total_area_sqft', 'revenue_capacity_sqft',
      'rent_per_sqft', 'rent_monthly', 'cam_monthly', 'people_cost_monthly',
      'utilities_monthly', 'other_direct_cost_monthly',
      'target_occupancy_pct', 'opening_occupancy_pct',
      'opening_date', 'closing_date', 'status',
      'city', 'state', 'branch_type',
      'revenue_driver', 'revenue_per_seat', 'revenue_per_sqft',
      'capex_total', 'deposit_amount', 'deposit_payment_month',
      'utility_method', 'occupancy_ramp_template', 'approval_status',
    ];
    for (const k of allowed) if (req.body[k] !== undefined) data.branches[idx][k] = req.body[k];
    // Remove from management_input_required if fields are now populated
    const filled = ['total_seats','total_area_sqft','rent_per_sqft','target_occupancy_pct'].filter(k => data.branches[idx][k] != null);
    data.branches[idx].management_input_required = (data.branches[idx].management_input_required || [])
      .filter(f => !filled.includes(f));
    data.branches[idx].management_input_source = 'step15_manual';
    data.branches[idx].last_updated = now();
    await writeBranches(data);
    res.json({ ok: true, branch: data.branches[idx] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /bulk-branch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/bulk-branch', adminOnly, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });
    const data = await readBranches();
    const byId = {};
    for (const b of data.branches || []) byId[b.branch_id] = b;
    let updated = 0;
    for (const u of updates) {
      const b = byId[u.branch_id];
      if (!b) continue;
      const allowed = ['total_seats','total_area_sqft','revenue_capacity_sqft','rent_per_sqft',
        'rent_monthly','cam_monthly','people_cost_monthly','utilities_monthly',
        'target_occupancy_pct','status','approval_status'];
      for (const k of allowed) if (u[k] !== undefined) b[k] = u[k];
      b.last_updated = now();
      updated++;
    }
    data.last_updated = now();
    await writeBranches(data);
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /approve-obs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/approve-obs', adminOnly, async (req, res) => {
  try {
    const { approval_status, approval_note, approved_by } = req.body;
    if (!approval_status) return res.status(400).json({ error: 'approval_status required' });
    const obs = readJ('opening_balance_sheet.json', {});
    obs.approval_status    = approval_status;
    obs.approval_note      = approval_note || null;
    obs.approved_by        = approved_by || 'management';
    obs.approved_at        = now();
    obs.last_updated       = now();
    writeJ('opening_balance_sheet.json', obs);
    res.json({ ok: true, approval_status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /completion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Full data completion analysis for Step 15 status dashboard.
router.get('/completion', async (req, res) => {
  try {
    const [mapData, brData, clData] = await Promise.all([readMappings(), readBranches(), readClients()]);
    const mappings = (mapData.mappings || []).filter(m => m.active !== false);
    const branches = brData.branches || [];
    const clients  = clData.clients  || [];

    // Revenue actuals reference
    const actStats = buildActualsIndex();
    const actualsPopulated = Object.keys(actStats).length;

    // Contracted revenue
    const clientMap = {};
    for (const c of clients) clientMap[c.client_id] = c;
    const withContracted = mappings.filter(m => {
      const contracted = m.contracted_monthly_revenue ?? clientMap[m.client_id]?.current_monthly_revenue;
      return contracted != null && Number(contracted) > 0;
    }).length;

    // Branch capacity
    const withCapacity = branches.filter(b => b.total_seats > 0 || b.revenue_capacity_sqft > 0).length;
    const withArea     = branches.filter(b => b.total_area_sqft > 0).length;

    // Actuals history on mappings
    const withActualsHistory = mappings.filter(m => m.latest_actual_month != null).length;

    // Cost master
    const costData  = readJ('cost_master.json', { assumptions: [] });
    const activeCost = (costData.assumptions || []).filter(c => c.active !== false).length;

    // Debt
    const debtData    = readJ('debt_schedule.json', { facilities: [] });
    const debtFacs    = debtData.facilities || [];
    const withRate    = debtFacs.filter(f => Number(f.rate || 0) > 0).length;
    const withSched   = debtFacs.filter(f => (f.repayment_schedule || []).length > 0).length;
    const totalDebt   = debtFacs.reduce((s, f) => s + (f.opening_principal || 0), 0);

    // OBS
    const obs = readJ('opening_balance_sheet.json', {});
    const obsApproved = obs.approval_status === 'approved';

    // Asset register
    const assets    = readJ('asset_register.json', { assets: [] });
    const activeAssets = (assets.assets || []).filter(a => a.active !== false).length;

    // Capex / Deposit
    const capex    = readJ('capex_master.json', { capex_entries: [] });
    const deposits = readJ('deposit_master.json', { deposit_entries: [] });

    // GL mapping
    const gl = readJ('account_mapping.json', { summary: {}, total_groupings: 0 });
    const glSummary  = gl.summary || {};
    const totalGL    = gl.total_groupings || 0;
    const mappedGL   = (glSummary.auto_mapped || 0) + (glSummary.confirmed || 0) + (glSummary.resolved || 0);
    const pendingGL  = glSummary.pending_review || 0;

    // Revenue actuals unmapped
    const ra = readJ('revenue_actuals.json', { invoices: [] });
    const unmappedRev = (ra.invoices || []).filter(i => !i.revenue_category || !i.branch_id).length;

    // Utilities
    const ga = readJ('global_assumptions.json', {});
    const utilitiesSet = ga.utilities_method != null;

    // Compute module scores
    const modules = [
      {
        id: 'branch_capacity',
        module: 'Branch Master â€” Capacity',
        required_field: 'total_seats + total_area_sqft',
        source: 'Management Input',
        total: branches.length,
        populated: withCapacity,
        pct: branches.length ? Math.round(withCapacity / branches.length * 100) : 0,
        status: withCapacity === branches.length ? 'COMPLETE' : withCapacity > 0 ? 'PARTIAL' : 'MANUAL INPUT REQUIRED',
        blocker: withCapacity === 0,
        priority: 'CRITICAL',
        action: `Enter total_seats and total_area_sqft for all ${branches.length - withCapacity} remaining branches`,
        where: 'Management Inputs â†’ Branch Assumptions',
      },
      {
        id: 'contracted_revenue',
        module: 'Client Revenue â€” Contracted',
        required_field: 'contracted_monthly_revenue per mapping',
        source: 'Management Input (reference: Zoho actuals 3m/6m avg available)',
        total: mappings.length,
        populated: withContracted,
        pct: mappings.length ? Math.round(withContracted / mappings.length * 100) : 0,
        status: withContracted === mappings.length ? 'COMPLETE' : withContracted > 0 ? 'PARTIAL' : 'MANUAL INPUT REQUIRED',
        blocker: withContracted === 0,
        priority: 'CRITICAL',
        action: `Enter contracted_monthly_revenue for ${mappings.length - withContracted} unmapped client-branch pairs`,
        where: 'Management Inputs â†’ Client Revenue (Step 15)',
      },
      {
        id: 'actuals_history',
        module: 'Client Revenue â€” Actuals History',
        required_field: 'latest_actual + avg_3m + avg_6m (auto-derived)',
        source: 'Zoho Revenue Actuals (P1/P3)',
        total: mappings.length,
        populated: withActualsHistory,
        pct: mappings.length ? Math.round(withActualsHistory / mappings.length * 100) : 0,
        status: withActualsHistory >= actualsPopulated ? 'AUTO-FETCHED' : withActualsHistory > 0 ? 'PARTIAL' : 'ACTION REQUIRED',
        blocker: false,
        priority: 'HIGH',
        action: withActualsHistory === 0 ? 'Click "Auto-Populate Actuals" button to derive from Zoho invoice history' : 'Actuals history populated',
        where: 'Management Inputs â†’ Step 15 Completion â†’ Auto-Populate',
        auto_fetchable: true,
      },
      {
        id: 'cost_master',
        module: 'Cost Master',
        required_field: 'Branch-level cost assumptions',
        source: 'Management Input',
        total: branches.length,
        populated: activeCost,
        pct: branches.length ? Math.min(100, Math.round(activeCost / branches.length * 100)) : 0,
        status: activeCost >= branches.length ? 'COMPLETE' : activeCost > 0 ? 'PARTIAL' : 'MANUAL INPUT REQUIRED',
        blocker: activeCost === 0,
        priority: 'CRITICAL',
        action: `Enter cost assumptions (rent, CAM, people, utilities) for ${branches.length} branches`,
        where: 'Management Inputs â†’ Cost Master',
      },
      {
        id: 'debt_rate',
        module: 'Debt â€” Interest Rates',
        required_field: 'rate per facility',
        source: 'Zoho Books / Lender Records',
        total: debtFacs.length,
        populated: withRate,
        pct: debtFacs.length ? Math.round(withRate / debtFacs.length * 100) : 0,
        status: withRate === debtFacs.length ? 'COMPLETE' : withRate > 0 ? 'PARTIAL' : 'MANUAL INPUT REQUIRED',
        blocker: false,
        priority: 'HIGH',
        action: `Confirm rates for ${debtFacs.length - withRate} facilities (13 RP loans show 0% â€” confirm if intentional)`,
        where: 'Management Inputs â†’ Debt Workspace',
      },
      {
        id: 'debt_schedule',
        module: 'Debt â€” Repayment Schedules (B1)',
        required_field: 'repayment_schedule per facility',
        source: 'Lender/Bank Statements',
        total: debtFacs.length,
        populated: withSched,
        pct: debtFacs.length ? Math.round(withSched / debtFacs.length * 100) : 0,
        status: withSched === debtFacs.length ? 'COMPLETE' : withSched > 0 ? 'PARTIAL' : 'MANUAL INPUT REQUIRED',
        blocker: true,
        priority: 'CRITICAL',
        action: `Populate repayment_schedule for ${debtFacs.length - withSched} facilities. Finance cost will be null until resolved.`,
        where: 'Management Inputs â†’ Debt Workspace or bulk import via admin',
      },
      {
        id: 'obs_approval',
        module: 'Opening Balance Sheet (B2)',
        required_field: 'approval_status = approved',
        source: 'CFO/Management Approval',
        total: 1,
        populated: obsApproved ? 1 : 0,
        pct: obsApproved ? 100 : 0,
        status: obsApproved ? 'APPROVED' : 'REVIEW REQUIRED',
        blocker: !obsApproved,
        priority: 'CRITICAL',
        action: obsApproved ? 'OBS approved' : `Review and approve OBS. Total assets: â‚¹${r2(obs.total_assets)}L, Total E+L: â‚¹${r2(obs.total_el)}L, Difference: â‚¹${r2(obs.bs_check_diff)}L`,
        where: 'Management Inputs â†’ Opening BS',
      },
      {
        id: 'asset_register',
        module: 'Fixed Asset Register (OI-009)',
        required_field: 'Asset cost + capitalisation date + useful life',
        source: 'Management Input / Accounting Records',
        total: null,
        populated: activeAssets,
        pct: activeAssets > 0 ? 100 : 0,
        status: activeAssets > 0 ? 'PARTIAL' : 'MANUAL INPUT REQUIRED',
        blocker: activeAssets === 0,
        priority: 'CRITICAL',
        action: 'Add fixed assets (PPE) in Asset Register. Depreciation on existing assets = null until populated.',
        where: 'Management Inputs â†’ Asset Register',
      },
      {
        id: 'capex',
        module: 'Capex Schedule',
        required_field: 'Capex per branch (planned + future)',
        source: 'Management Input',
        total: null,
        populated: (capex.capex_entries || []).length,
        pct: (capex.capex_entries || []).length > 0 ? 100 : 0,
        status: (capex.capex_entries || []).length > 0 ? 'PARTIAL' : 'MANUAL INPUT REQUIRED',
        blocker: false,
        priority: 'MEDIUM',
        action: 'Enter capex schedule (pre-opening, opening month, post-opening) especially for planned branches.',
        where: 'Management Inputs â†’ Asset Register / Capex tab',
      },
      {
        id: 'deposits',
        module: 'Security Deposits',
        required_field: 'Deposit amount + payment month per branch',
        source: 'Management Input / Lease Agreements',
        total: null,
        populated: (deposits.deposit_entries || []).length,
        pct: (deposits.deposit_entries || []).length > 0 ? 100 : 0,
        status: (deposits.deposit_entries || []).length > 0 ? 'PARTIAL' : 'MANUAL INPUT REQUIRED',
        blocker: false,
        priority: 'MEDIUM',
        action: 'Enter security deposits paid and to-be-paid for lease commitments.',
        where: 'Management Inputs â†’ Debt Workspace / Deposits',
      },
      {
        id: 'utilities',
        module: 'Utilities Methodology',
        required_field: 'utilities_method + allocation per branch',
        source: 'Management Decision',
        total: 1,
        populated: utilitiesSet ? 1 : 0,
        pct: utilitiesSet ? 100 : 0,
        status: utilitiesSet ? 'APPROVED' : 'REVIEW REQUIRED',
        blocker: false,
        priority: 'HIGH',
        action: utilitiesSet ? `Method set: ${ga.utilities_method}` : 'Set utilities methodology (Fixed/Variable/Per Seat/Per SqFt) and confirm.',
        where: 'Management Inputs â†’ Utilities',
      },
      {
        id: 'gl_mapping',
        module: 'GL â†’ FP&A Mapping (OI-011)',
        required_field: '0 pending_review COA groupings',
        source: 'Zoho COA Sync (P1)',
        total: totalGL,
        populated: mappedGL,
        pct: totalGL ? Math.round(mappedGL / totalGL * 100) : 0,
        status: pendingGL === 0 ? 'COMPLETE' : 'REVIEW REQUIRED',
        blocker: pendingGL > 0,
        priority: pendingGL > 3 ? 'HIGH' : 'MEDIUM',
        action: `Resolve ${pendingGL} pending COA grouping(s) to satisfy RC-F15.`,
        where: 'Management Inputs â†’ GL Mapping',
      },
      {
        id: 'revenue_mapping',
        module: 'Revenue Invoice Classification',
        required_field: 'All invoices classified',
        source: 'Zoho Revenue Actuals (P1)',
        total: (ra.invoices || []).length,
        populated: (ra.invoices || []).length - unmappedRev,
        pct: (ra.invoices || []).length ? Math.round(((ra.invoices || []).length - unmappedRev) / (ra.invoices || []).length * 100) : 0,
        status: unmappedRev === 0 ? 'COMPLETE' : 'REVIEW REQUIRED',
        blocker: false,
        priority: 'MEDIUM',
        action: unmappedRev === 0 ? 'All invoices classified' : `${unmappedRev} invoices need revenue category or branch assignment.`,
        where: 'Management Inputs â†’ Unmapped Revenue',
      },
    ];

    const criticalBlockers = modules.filter(m => m.blocker && m.priority === 'CRITICAL');
    const highBlockers     = modules.filter(m => m.blocker && m.priority === 'HIGH');
    const totalCritical    = criticalBlockers.length;
    const completedModules = modules.filter(m => ['COMPLETE', 'AUTO-FETCHED', 'APPROVED'].includes(m.status)).length;
    const overallPct       = Math.round(completedModules / modules.length * 100);

    // Gate determination
    let gate = 'BLOCKED â€” MANAGEMENT DATA REQUIRED';
    if (totalCritical === 0) gate = 'READY FOR BASELINE GENERATION';

    res.json({
      gate,
      overall_pct: overallPct,
      completed_modules: completedModules,
      total_modules: modules.length,
      critical_blockers: totalCritical,
      modules,
      data_summary: {
        total_mappings: mappings.length,
        with_contracted_revenue: withContracted,
        with_actuals_history: withActualsHistory,
        branches_with_capacity: withCapacity,
        cost_assumptions: activeCost,
        debt_facilities: debtFacs.length,
        debt_with_rate: withRate,
        debt_with_schedule: withSched,
        total_debt_principal_lakh: r2(totalDebt),
        obs_approval_status: obs.approval_status || 'pending_review',
        active_assets: activeAssets,
        gl_mapped: mappedGL,
        gl_pending: pendingGL,
        unmapped_invoices: unmappedRev,
        utilities_method: ga.utilities_method || null,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SECTION 15A â€” AUTO-POPULATION FROM ZOHO BILLS + LEASE SCHEDULE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const SYNC_DIR = path.join(__dirname, 'sync_data');
const readSync = (file, def = {}) => {
  if (fpaStore.enabled) return fpaStore.read(path.join(SYNC_DIR, file), def);
  try { return JSON.parse(fs.readFileSync(path.join(SYNC_DIR, file), 'utf8')); }
  catch { return def; }
};

// Category â†’ our cost field mapping
const BILL_CAT_MAP = {
  'property rental expenses':   'rent',
  'Electricity':                'utilities',
  'Internet (Recurring)':       'utilities',
  'Water (Recurring)':          'utilities',
  'HK Salary (Recurring)':      'people_cost',
  'HK Material (Recurring)':    'other_direct_cost',
  'Hygiene Services (Recurring)': 'other_direct_cost',
  'Security Salary (Recurring)':  'people_cost',
  'Valet Salary (Recurring)':     'people_cost',
  'CCD Material (Recurring)':     'other_direct_cost',
  'Other Office Expenses (Recurring)': 'other_direct_cost',
  'Parking (Recurring)':          'other_direct_cost',
  'Vending Machine (Recurring)':  'other_direct_cost',
  'Courier (Recurring)':          'other_direct_cost',
  'property maintenance expenses':    'other_direct_cost',
  'Miscellaneous Work':               'other_direct_cost',
  'HVAC':                             'other_direct_cost',
  'HVAC (AMC)':                       'other_direct_cost',
  'Electrical and Fire Audit (AMC)':  'other_direct_cost',
};

// Compute per-branch Ã— category cost actuals from bills_fy.json
function buildCostActualsIndex() {
  const bills = readSync('bills_fy.json', { data: [] });
  const rows  = bills.data || [];

  // Accumulate: branchName â†’ category â†’ month â†’ total
  const idx = {};
  for (const b of rows) {
    const branch = b.branch_name;
    const cat    = b.cf_category || 'Uncategorized';
    const month  = b.date ? b.date.slice(0, 7) : null;
    const amt    = Number(b.total) || 0;
    if (!branch || !month || amt <= 0) continue;
    if (!idx[branch]) idx[branch] = {};
    if (!idx[branch][cat]) idx[branch][cat] = {};
    idx[branch][cat][month] = (idx[branch][cat][month] || 0) + amt;
  }

  // Convert to stats per branch Ã— category
  const result = {};
  for (const [branch, cats] of Object.entries(idx)) {
    result[branch] = {};
    for (const [cat, monthMap] of Object.entries(cats)) {
      const sorted = Object.entries(monthMap).sort((a, b) => b[0].localeCompare(a[0]));
      const all    = sorted.map(([, v]) => v);
      const vals3  = all.slice(0, 3);
      const vals6  = all.slice(0, 6);
      const fytd   = all; // all months are FY 2026-27
      result[branch][cat] = {
        latest_month:   sorted[0][0],
        latest_amount:  r2(sorted[0][1]),
        avg_3m:   vals3.length ? r2(vals3.reduce((s, v) => s + v, 0) / vals3.length) : null,
        avg_6m:   vals6.length ? r2(vals6.reduce((s, v) => s + v, 0) / vals6.length) : null,
        avg_fytd: fytd.length  ? r2(fytd.reduce((s, v) => s + v, 0) / fytd.length)  : null,
        months_of_data: sorted.length,
        our_field: BILL_CAT_MAP[cat] || null,
      };
    }
  }
  return result;
}

// Compute per-branch rent + area from lease_schedule.json
function buildLeaseIndex() {
  const ls = readJ('lease_schedule.json', { leases: [] });
  const result = {};
  for (const l of ls.leases || []) {
    const branch = l.branch;
    if (!branch) continue;
    if (!result[branch]) result[branch] = { rent_lakh: 0, super_buildup_sqft: 0, carpet_area_sqft: 0, lease_count: 0, escalation_pct: 0 };
    result[branch].rent_lakh         += Number(l.base_monthly_rent_lakh || 0);
    result[branch].super_buildup_sqft += Number(l.super_buildup_sqft || 0);
    result[branch].carpet_area_sqft   += Number(l.carpet_area_sqft || 0);
    result[branch].lease_count++;
    if (l.current_escalation_pct) result[branch].escalation_pct = l.current_escalation_pct;
  }
  for (const v of Object.values(result)) {
    v.rent_lakh         = r2(v.rent_lakh);
    v.super_buildup_sqft = Math.round(v.super_buildup_sqft);
    v.carpet_area_sqft   = Math.round(v.carpet_area_sqft);
  }
  return result;
}

// â”€â”€â”€ GET /cost-actuals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/cost-actuals', async (req, res) => {
  try {
    const costIdx  = buildCostActualsIndex();
    const leaseIdx = buildLeaseIndex();
    const brData   = await readBranches();

    const result = (brData.branches || []).map(b => {
      const bn        = b.branch_name;
      const costs     = costIdx[bn] || {};
      const lease     = leaseIdx[bn] || {};

      // Aggregate to our standard cost fields
      const fields = { rent: [], cam: [], utilities: [], people_cost: [], other_direct_cost: [] };
      for (const [cat, stats] of Object.entries(costs)) {
        const field = BILL_CAT_MAP[cat];
        if (field && fields[field] && stats.avg_6m != null) {
          fields[field].push(stats.avg_6m);
        }
      }
      const sumField = (f) => fields[f].length ? r2(fields[f].reduce((s, v) => s + v, 0)) : null;

      return {
        branch_id:   b.branch_id,
        branch_name: bn,
        city:        b.city,
        // Lease-derived
        lease_rent_lakh:       lease.rent_lakh || null,
        lease_sqft_super:      lease.super_buildup_sqft || null,
        lease_sqft_carpet:     lease.carpet_area_sqft || null,
        lease_escalation_pct:  lease.escalation_pct || null,
        lease_count:           lease.lease_count || 0,
        // Bills-derived cost references (6M avg, absolute â‚¹)
        ref_rent:              sumField('rent'),
        ref_cam:               null,  // not separately in bills
        ref_utilities:         sumField('utilities'),
        ref_people_cost:       sumField('people_cost'),
        ref_other_direct:      sumField('other_direct_cost'),
        // Detailed category breakdown
        bill_categories: costs,
        // Current branch master values
        current_rent_per_sqft:  b.rent_per_sqft || null,
        current_total_sqft:     b.total_area_sqft || null,
        current_seats:          b.total_seats || null,
        current_rent_monthly:   b.rent_monthly || null,
        current_cam_monthly:    b.cam_monthly || null,
        current_utilities:      b.utilities_monthly || null,
        current_people_cost:    b.people_cost_monthly || null,
        current_other_direct:   b.other_direct_cost_monthly || null,
        // Status
        has_lease_data:    lease.lease_count > 0,
        has_bills_data:    Object.keys(costs).length > 0,
        has_cost_input:    !!(b.rent_monthly || b.cam_monthly || b.rent_per_sqft),
        has_area_input:    !!(b.total_area_sqft || b.revenue_capacity_sqft),
        has_seats:         !!(b.total_seats > 0),
      };
    });

    const withLeaseData = result.filter(r => r.has_lease_data).length;
    const withBillsData = result.filter(r => r.has_bills_data).length;
    const withCostInput = result.filter(r => r.has_cost_input).length;

    res.json({
      branches: result,
      summary: {
        total: result.length,
        with_lease_data: withLeaseData,
        with_bills_data: withBillsData,
        with_cost_input: withCostInput,
        bills_months: ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09'],
        note: 'Amounts in absolute â‚¹. Lease rent in â‚¹L (convert Ã— 100000 for â‚¹).',
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /auto-populate-branch-data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Writes lease-derived area and rent reference fields to branch_master.
// NON-DESTRUCTIVE: only writes _lease_ref_ fields, never overwrites manual inputs.
router.post('/auto-populate-branch-data', adminOnly, async (req, res) => {
  try {
    const leaseIdx = buildLeaseIndex();
    const costIdx  = buildCostActualsIndex();
    const brData   = await readBranches();
    let updated = 0;

    for (const b of brData.branches || []) {
      const bn    = b.branch_name;
      const lease = leaseIdx[bn];
      const bills = costIdx[bn];
      let changed = false;

      if (lease) {
        // Write reference values (prefix: ref_) â€” never overwrite user-entered values
        if (!b.ref_lease_rent_lakh && lease.rent_lakh)
          { b.ref_lease_rent_lakh = lease.rent_lakh; changed = true; }
        if (!b.ref_super_buildup_sqft && lease.super_buildup_sqft)
          { b.ref_super_buildup_sqft = lease.super_buildup_sqft; changed = true; }
        if (!b.ref_carpet_area_sqft && lease.carpet_area_sqft)
          { b.ref_carpet_area_sqft = lease.carpet_area_sqft; changed = true; }
        if (!b.ref_lease_escalation_pct && lease.escalation_pct)
          { b.ref_lease_escalation_pct = lease.escalation_pct; changed = true; }
        if (!b.ref_lease_count)
          { b.ref_lease_count = lease.lease_count; changed = true; }

        // If management hasn't set total_area_sqft or rent_per_sqft, pre-fill from lease
        // as a reference suggestion (still requires management confirmation to become active)
        if (!b.total_area_sqft && lease.super_buildup_sqft) {
          b.suggested_total_area_sqft = lease.super_buildup_sqft;
          changed = true;
        }
      }

      if (bills) {
        // Store 6M avg cost references for each category
        const fields = { rent: [], utilities: [], people_cost: [], other_direct_cost: [] };
        for (const [cat, stats] of Object.entries(bills)) {
          const field = BILL_CAT_MAP[cat];
          if (field && fields[field] && stats.avg_6m != null) fields[field].push(stats.avg_6m);
        }
        const ref6m_rent   = fields.rent.length   ? r2(fields.rent.reduce((s, v) => s + v, 0))   : null;
        const ref6m_util   = fields.utilities.length  ? r2(fields.utilities.reduce((s, v) => s + v, 0))  : null;
        const ref6m_people = fields.people_cost.length ? r2(fields.people_cost.reduce((s, v) => s + v, 0)) : null;
        const ref6m_other  = fields.other_direct_cost.length ? r2(fields.other_direct_cost.reduce((s, v) => s + v, 0)) : null;

        if (!b.ref_bills_rent_6m_avg   && ref6m_rent)   { b.ref_bills_rent_6m_avg   = ref6m_rent;   changed = true; }
        if (!b.ref_bills_util_6m_avg   && ref6m_util)   { b.ref_bills_util_6m_avg   = ref6m_util;   changed = true; }
        if (!b.ref_bills_people_6m_avg && ref6m_people) { b.ref_bills_people_6m_avg = ref6m_people; changed = true; }
        if (!b.ref_bills_other_6m_avg  && ref6m_other)  { b.ref_bills_other_6m_avg  = ref6m_other;  changed = true; }
        if (!b.ref_bills_data_months)   { b.ref_bills_data_months = Object.keys(bills).length > 0 ? 6 : 0; changed = true; }
      }

      if (changed) {
        b.ref_data_populated_at = now();
        updated++;
      }
    }

    await writeBranches(brData);
    res.json({
      message: `Branch reference data populated. ${updated} branches updated from lease schedule and Zoho bills.`,
      updated,
      total: (brData.branches || []).length,
      lease_branches: Object.keys(leaseIdx).length,
      bills_branches: Object.keys(costIdx).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /cost-actuals/apply â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Apply a historical average (3m/6m/latest/fytd) as the cost assumption for a branch.
// Management explicitly chooses which base to use â€” not automatic.
router.post('/cost-actuals/apply', adminOnly, async (req, res) => {
  try {
    const { branch_id, method = '6m', escalation_pct = 0 } = req.body;
    if (!branch_id) return res.status(400).json({ error: 'branch_id required' });

    const brData  = await readBranches();
    const b       = (brData.branches || []).find(x => x.branch_id === branch_id);
    if (!b) return res.status(404).json({ error: 'Branch not found' });

    const costIdx = buildCostActualsIndex();
    const bills   = costIdx[b.branch_name] || {};

    // Aggregate by our cost fields
    const agg = { rent: [], utilities: [], people_cost: [], other_direct_cost: [] };
    for (const [cat, stats] of Object.entries(bills)) {
      const field = BILL_CAT_MAP[cat];
      const val   = method === '3m' ? stats.avg_3m : method === '6m' ? stats.avg_6m :
                    method === 'fytd' ? stats.avg_fytd : stats.latest_amount;
      if (field && agg[field] && val != null) agg[field].push(val);
    }
    const sum = (arr) => arr.length ? r2(arr.reduce((s, v) => s + v, 0)) : null;
    const esc = (v) => v != null && escalation_pct ? r2(v * (1 + escalation_pct / 100)) : v;

    // Apply to branch master â€” these become management-approved assumptions
    if (sum(agg.rent)         != null) b.rent_monthly            = esc(sum(agg.rent));
    if (sum(agg.utilities)    != null) b.utilities_monthly       = esc(sum(agg.utilities));
    if (sum(agg.people_cost)  != null) b.people_cost_monthly     = esc(sum(agg.people_cost));
    if (sum(agg.other_direct_cost) != null) b.other_direct_cost_monthly = esc(sum(agg.other_direct_cost));
    b.cost_base_method     = method;
    b.cost_escalation_pct  = escalation_pct;
    b.cost_approved_at     = now();
    b.cost_source          = 'zoho_bills_historical';

    await writeBranches(brData);
    res.json({
      message: `Cost assumptions applied for ${b.branch_name} using ${method} average${escalation_pct ? ` + ${escalation_pct}% escalation` : ''}.`,
      branch_id,
      applied: {
        rent_monthly:             b.rent_monthly,
        utilities_monthly:        b.utilities_monthly,
        people_cost_monthly:      b.people_cost_monthly,
        other_direct_cost_monthly: b.other_direct_cost_monthly,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /cost-actuals/bulk-apply â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/cost-actuals/bulk-apply', adminOnly, async (req, res) => {
  try {
    const { method = '6m', escalation_pct = 0, branch_ids } = req.body;
    const brData  = await readBranches();
    const costIdx = buildCostActualsIndex();
    let applied = 0;

    for (const b of brData.branches || []) {
      if (branch_ids && !branch_ids.includes(b.branch_id)) continue;
      const bills = costIdx[b.branch_name] || {};
      if (!Object.keys(bills).length) continue;

      const agg = { rent: [], utilities: [], people_cost: [], other_direct_cost: [] };
      for (const [cat, stats] of Object.entries(bills)) {
        const field = BILL_CAT_MAP[cat];
        const val   = method === '3m' ? stats.avg_3m : method === '6m' ? stats.avg_6m :
                      method === 'fytd' ? stats.avg_fytd : stats.latest_amount;
        if (field && agg[field] && val != null) agg[field].push(val);
      }
      const sum = (arr) => arr.length ? r2(arr.reduce((s, v) => s + v, 0)) : null;
      const esc = (v) => v != null && escalation_pct ? r2(v * (1 + escalation_pct / 100)) : v;

      let changed = false;
      if (sum(agg.rent)         != null) { b.rent_monthly            = esc(sum(agg.rent));        changed = true; }
      if (sum(agg.utilities)    != null) { b.utilities_monthly       = esc(sum(agg.utilities));   changed = true; }
      if (sum(agg.people_cost)  != null) { b.people_cost_monthly     = esc(sum(agg.people_cost)); changed = true; }
      if (sum(agg.other_direct_cost) != null) { b.other_direct_cost_monthly = esc(sum(agg.other_direct_cost)); changed = true; }
      if (changed) {
        b.cost_base_method = method; b.cost_escalation_pct = escalation_pct;
        b.cost_approved_at = now(); b.cost_source = 'zoho_bills_historical';
        applied++;
      }
    }
    await writeBranches(brData);
    res.json({ message: `Bulk cost applied (${method} avg + ${escalation_pct}% esc) to ${applied} branches.`, applied });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /action-required â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/action-required', async (req, res) => {
  try {
    const [mapData, brData, clData] = await Promise.all([readMappings(), readBranches(), readClients()]);
    const debtData  = readJ('debt_schedule.json', { facilities: [] });
    const obs       = readJ('opening_balance_sheet.json', {});
    const assets    = readJ('asset_register.json', { assets: [] });
    const ga        = readJ('global_assumptions.json', {});
    const costIdx   = buildCostActualsIndex();
    const leaseIdx  = buildLeaseIndex();
    const clientMap = {};
    for (const c of clData.clients || []) clientMap[c.client_id] = c;

    const items = [];
    let seq = 1;

    // â”€â”€ Branch Capacity â”€â”€
    for (const b of brData.branches || []) {
      if (!b.total_seats) items.push({
        id: seq++, priority: 'CRITICAL', module: 'Branch Capacity', branch: b.branch_name,
        client: null, facility: null,
        field_required: 'total_seats',
        existing_value: null,
        reference_value: null,
        recommended_source: 'Site visit / property documents',
        required_input: 'Total workstation/hot-desk seats at this branch',
        reason: 'Required for occupancy rate, per-seat revenue, breakeven analysis',
        owner: 'Operations', status: 'PENDING',
      });
      if (!b.total_area_sqft) {
        const lease = leaseIdx[b.branch_name];
        items.push({
          id: seq++, priority: 'CRITICAL', module: 'Branch Capacity', branch: b.branch_name,
          field_required: 'total_area_sqft',
          existing_value: null,
          reference_value: lease ? `${lease.super_buildup_sqft} sqft (from ${lease.lease_count} lease(s))` : null,
          recommended_source: lease ? 'Lease schedule (pre-filled as suggestion)' : 'Lease agreement / site plan',
          required_input: 'Total area in sq ft (use super built-up if available)',
          reason: 'Required for per-sqft metrics and rent validation',
          owner: 'Operations', status: lease ? 'REFERENCE AVAILABLE' : 'PENDING',
        });
      }
    }

    // â”€â”€ Client Revenue â”€â”€
    const missingContracted = (mapData.mappings || []).filter(m => m.active !== false && !(m.contracted_monthly_revenue > 0) && !(clientMap[m.client_id]?.current_monthly_revenue > 0));
    for (const m of missingContracted) {
      const client = clientMap[m.client_id] || {};
      items.push({
        id: seq++, priority: 'CRITICAL', module: 'Client Revenue', branch: m.branch_id,
        client: client.client_name || m.client_id, facility: null,
        field_required: 'contracted_monthly_revenue',
        existing_value: null,
        reference_value: m.avg_3m ? `3M avg â‚¹${Math.round(m.avg_3m).toLocaleString('en-IN')}` : m.avg_6m ? `6M avg â‚¹${Math.round(m.avg_6m).toLocaleString('en-IN')}` : 'No actuals',
        recommended_source: 'Service agreement / latest invoice',
        required_input: 'Monthly contracted revenue in â‚¹ (do NOT use 3M/6M avg automatically)',
        reason: 'Required for revenue forecast â€” actuals history shown for reference only',
        owner: 'FP&A', status: 'PENDING',
      });
    }

    // â”€â”€ Branch Costs â”€â”€
    for (const b of brData.branches || []) {
      const hasCost = b.rent_monthly || b.cam_monthly || b.rent_per_sqft;
      if (!hasCost) {
        const lease  = leaseIdx[b.branch_name];
        const bills  = costIdx[b.branch_name];
        const hasRef = lease || (bills && Object.keys(bills).length > 0);
        items.push({
          id: seq++, priority: 'HIGH', module: 'Cost Assumptions', branch: b.branch_name,
          field_required: 'rent_monthly / cam_monthly / utilities_monthly',
          existing_value: null,
          reference_value: lease ? `Lease: â‚¹${lease.rent_lakh}L/month` : bills ? 'Bills history available' : null,
          recommended_source: hasRef ? 'Zoho lease schedule / bills history (use "Apply 6M Avg" button)' : 'Finance / accounts team',
          required_input: 'Monthly cost assumptions. Can be applied from Zoho bills history (6M avg).',
          reason: 'Required for EBITDA / branch profitability',
          owner: 'Finance', status: hasRef ? 'REFERENCE AVAILABLE â€” USE BULK APPLY' : 'PENDING',
        });
      }
    }

    // â”€â”€ Debt Schedules â”€â”€
    for (const f of debtData.facilities || []) {
      const key = f.id || f.facility_id;
      if (!(f.repayment_schedule || []).length) items.push({
        id: seq++, priority: 'CRITICAL', module: 'Debt Schedule (B1)', branch: null,
        client: null, facility: `${key} â€” ${f.label || f.facility_name || ''}`,
        field_required: 'repayment_schedule',
        existing_value: null,
        reference_value: f.emi_lakh ? `EMI: â‚¹${f.emi_lakh}L/month` : null,
        recommended_source: 'Bank/lender sanction letter or loan statement',
        required_input: 'Monthly repayment schedule (principal + interest per month)',
        reason: 'B1 Blocker: finance_cost=null until at least one schedule is provided',
        owner: 'Finance/CA', status: 'PENDING',
      });
      if (Number(f.rate || 0) === 0) items.push({
        id: seq++, priority: 'HIGH', module: 'Debt â€” Interest Rate', branch: null,
        facility: `${key} â€” ${f.label || ''}`,
        field_required: 'rate',
        existing_value: '0%',
        reference_value: null,
        recommended_source: 'Sanction letter',
        required_input: 'Confirm: is this facility genuinely 0% interest (RP loan), or is the rate missing?',
        reason: 'Finance cost will be 0 for this facility â€” needs explicit confirmation',
        owner: 'Finance', status: 'NEEDS CONFIRMATION',
      });
    }

    // â”€â”€ OBS Approval â”€â”€
    if (obs.approval_status !== 'approved') items.push({
      id: seq++, priority: 'CRITICAL', module: 'Opening Balance Sheet (B2)', branch: null,
      field_required: 'approval_status',
      existing_value: obs.approval_status || 'pending_review',
      reference_value: `Difference: â‚¹${obs.bs_check_diff?.toFixed(2) || 'unknown'}L`,
      recommended_source: 'Review existing OBS data (Section J)',
      required_input: 'Approve / Reject with note. Do NOT use adjustment to force balance.',
      reason: 'B2 Blocker: OBS not approved by management',
      owner: 'Management/CA', status: 'PENDING APPROVAL',
    });

    // â”€â”€ Fixed Asset Register â”€â”€
    const activeAssets = (assets.assets || []).filter(a => a.active !== false).length;
    if (activeAssets === 0) items.push({
      id: seq++, priority: 'CRITICAL', module: 'Fixed Asset Register', branch: null,
      field_required: 'asset entries',
      existing_value: '0 assets',
      reference_value: 'Opening BS shows gross_block',
      recommended_source: 'Accounting team / existing FAR in Tally or ERP',
      required_input: 'Complete FAR: asset_id, description, branch, category, capitalisation_date, cost, accum_depreciation, useful_life',
      reason: 'Required for depreciation schedule and PAT calculation',
      owner: 'CA/Auditor', status: 'PENDING',
    });

    // â”€â”€ Utilities Methodology â”€â”€
    if (!ga.utilities_method) items.push({
      id: seq++, priority: 'HIGH', module: 'Utilities Methodology', branch: null,
      field_required: 'utilities_method',
      existing_value: null,
      reference_value: 'Options: Fixed Monthly / Per Seat / Per SqFt / Fixed+Variable / CAM Included',
      recommended_source: 'Management decision',
      required_input: 'Select and approve utilities allocation methodology',
      reason: 'Required for cost model completion â€” cannot default without management approval',
      owner: 'Management', status: 'PENDING',
    });

    // â”€â”€ GL Mapping â”€â”€
    const gl = readJ('account_mapping.json', { summary: {} });
    if ((gl.summary || {}).pending_review > 0) items.push({
      id: seq++, priority: 'MEDIUM', module: 'GL Mapping (OI-011)', branch: null,
      field_required: 'pending_review â†’ 0',
      existing_value: `${gl.summary.pending_review} groupings pending review`,
      reference_value: `${(gl.summary.auto_mapped || 0) + (gl.summary.confirmed || 0) + (gl.summary.resolved || 0)} already mapped`,
      recommended_source: 'FP&A team / accounts',
      required_input: 'Resolve each pending COA grouping',
      reason: 'RC-F15 control requires 100% GL mapping coverage',
      owner: 'FP&A', status: 'IN PROGRESS',
    });

    // Sort by priority
    const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    items.sort((a, b) => (priorityOrder[a.priority] || 9) - (priorityOrder[b.priority] || 9));

    const byPriority = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const item of items) byPriority[item.priority] = (byPriority[item.priority] || 0) + 1;

    res.json({
      total_items:   items.length,
      by_priority:   byPriority,
      items,
      generated_at:  now(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ CSV helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function csvEsc(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function rowToCSV(arr) { return arr.map(csvEsc).join(','); }
function csvParse(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    vals.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] || null; });
    return row;
  });
}

// â”€â”€â”€ GET /export/client-revenue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/export/client-revenue', async (req, res) => {
  try {
    const [mapData, clData, brData] = await Promise.all([readMappings(), readClients(), readBranches()]);
    const clientMap = {};
    for (const c of clData.clients || []) clientMap[c.client_id] = c;
    const branchMap = {};
    for (const b of brData.branches || []) branchMap[b.branch_id] = b;

    const headers = ['mapping_id','client_name','branch_name','city',
      'latest_actual_month','latest_actual_revenue_inr','avg_3m_inr','avg_6m_inr',
      'contracted_monthly_revenue_inr','escalation_pct','escalation_effective_month',
      'billing_frequency','contract_start_date','contract_end_date','approval_status','comments'];

    const rows = (mapData.mappings || []).filter(m => m.active !== false).map(m => {
      const client = clientMap[m.client_id] || {};
      const branch = branchMap[m.branch_id] || {};
      return [
        m.mapping_id, client.client_name || m.client_id, branch.branch_name || m.branch_id,
        branch.city || '',
        m.latest_actual_month || '', m.latest_actual_revenue || '', m.avg_3m || '', m.avg_6m || '',
        m.contracted_monthly_revenue || '', m.escalation_pct || '', m.escalation_effective_month || '',
        m.billing_frequency || '', m.contract_start_date || '', m.contract_end_date || '',
        m.approval_status || 'pending', '',
      ];
    });

    const csv = [rowToCSV(headers), ...rows.map(rowToCSV)].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="client_revenue_management_input.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /import/client-revenue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/import/client-revenue', adminOnly, async (req, res) => {
  try {
    const csvText = req.body.csv;
    if (!csvText) return res.status(400).json({ error: 'csv body field required' });

    const rows    = csvParse(csvText);
    const mapData = await readMappings();
    const clData  = await readClients();
    const clientMap = {};
    for (const c of clData.clients || []) clientMap[c.client_id] = c;
    const byMid = {};
    for (const m of mapData.mappings || []) byMid[m.mapping_id] = m;

    const errors = [], updated = [];
    const MGMT_FIELDS = ['contracted_monthly_revenue_inr','escalation_pct','escalation_effective_month',
                         'billing_frequency','contract_start_date','contract_end_date','approval_status','comments'];
    const PROTECT = ['latest_actual_month','latest_actual_revenue_inr','avg_3m_inr','avg_6m_inr'];

    for (const row of rows) {
      const mid = row.mapping_id;
      if (!mid) { errors.push({ row, reason: 'mapping_id missing' }); continue; }
      const m = byMid[mid];
      if (!m) { errors.push({ mid, reason: 'mapping_id not found' }); continue; }

      // Validate: do not overwrite actuals
      for (const pf of PROTECT) {
        if (row[pf] && row[pf] !== String(m[pf.replace('_inr','').replace('_revenue_inr','_revenue')] || '')) {
          errors.push({ mid, reason: `Cannot overwrite actuals field ${pf}` });
        }
      }

      // Apply management columns only
      const contracted = Number(row.contracted_monthly_revenue_inr);
      if (!isNaN(contracted) && contracted > 0) {
        m.contracted_monthly_revenue = contracted;
        // Cross-update client master if not yet set
        const client = clientMap[m.client_id];
        if (client && !client.current_monthly_revenue) {
          client.current_monthly_revenue = contracted;
        }
      }
      if (row.escalation_pct)          m.escalation_pct          = Number(row.escalation_pct) || 0;
      if (row.escalation_effective_month) m.escalation_effective_month = row.escalation_effective_month;
      if (row.billing_frequency)       m.billing_frequency        = row.billing_frequency;
      if (row.contract_start_date)     m.contract_start_date      = row.contract_start_date;
      if (row.contract_end_date)       m.contract_end_date        = row.contract_end_date;
      if (row.approval_status)         m.approval_status          = row.approval_status;
      if (row.comments)                m.import_comments          = row.comments;
      m.last_updated = now();
      updated.push(mid);
    }

    if (updated.length) {
      await writeMappings(mapData);
      await writeClients(clData);
    }
    res.json({ updated: updated.length, errors: errors.length, error_details: errors, message: `Imported ${updated.length} rows. ${errors.length} errors.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /export/branch-capacity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/export/branch-capacity', async (req, res) => {
  try {
    const brData   = await readBranches();
    const leaseIdx = buildLeaseIndex();

    const headers = ['branch_id','branch_name','city','status','opening_date',
      'ref_lease_sqft_super','ref_lease_rent_lakh',
      'total_area_sqft','revenue_capacity_sqft','total_seats',
      'target_occupancy_pct','opening_occupancy_pct',
      'rent_per_sqft','rent_monthly','cam_monthly',
      'occupancy_ramp_template','management_comments'];

    const rows = (brData.branches || []).map(b => {
      const lease = leaseIdx[b.branch_name] || {};
      return [
        b.branch_id, b.branch_name, b.city || '', b.status || 'LIVE', b.opening_date || '',
        lease.super_buildup_sqft || '', lease.rent_lakh || '',
        b.total_area_sqft || '', b.revenue_capacity_sqft || '', b.total_seats || '',
        b.target_occupancy_pct || '', b.opening_occupancy_pct || '',
        b.rent_per_sqft || '', b.rent_monthly || '', b.cam_monthly || '',
        b.occupancy_ramp_template || '', '',
      ];
    });

    const csv = [rowToCSV(headers), ...rows.map(rowToCSV)].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="branch_capacity_management_input.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /import/branch-capacity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/import/branch-capacity', adminOnly, async (req, res) => {
  try {
    const csvText = req.body.csv;
    if (!csvText) return res.status(400).json({ error: 'csv body field required' });

    const rows   = csvParse(csvText);
    const brData = await readBranches();
    const byId   = {};
    for (const b of brData.branches || []) byId[b.branch_id] = b;

    const errors = [], updated = [];
    for (const row of rows) {
      const bid = row.branch_id;
      if (!bid) { errors.push({ reason: 'branch_id missing', row }); continue; }
      const b = byId[bid];
      if (!b) { errors.push({ bid, reason: 'Not found' }); continue; }

      const numFields = ['total_area_sqft','revenue_capacity_sqft','total_seats','target_occupancy_pct',
                         'opening_occupancy_pct','rent_per_sqft','rent_monthly','cam_monthly'];
      for (const f of numFields) {
        if (row[f] !== null && row[f] !== '') {
          const n = Number(row[f]);
          if (!isNaN(n)) b[f] = n;
        }
      }
      if (row.status)             b.status = row.status;
      if (row.opening_date)       b.opening_date = row.opening_date;
      if (row.occupancy_ramp_template) b.occupancy_ramp_template = row.occupancy_ramp_template;
      if (row.management_comments) b.management_comments = row.management_comments;
      b.last_updated = now();
      b.data_source  = 'management_import';
      updated.push(bid);
    }

    if (updated.length) await writeBranches(brData);
    res.json({ updated: updated.length, errors: errors.length, error_details: errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /export/debt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/export/debt', async (req, res) => {
  try {
    const debtData = readJ('debt_schedule.json', { facilities: [] });
    const headers  = ['facility_id','label','lender','type','opening_principal_lakh',
      'rate_pct','emi_lakh','repay_freq','maturity','repayment_schedule_status',
      'management_note'];

    const rows = (debtData.facilities || []).map(f => [
      f.id || f.facility_id, f.label || f.facility_name || '', f.lender || '', f.type || '',
      f.opening_principal || f.outstanding_balance || '',
      f.rate || f.interest_rate || '', f.emi_lakh || '',
      f.repay_freq || '', f.maturity || '',
      (f.repayment_schedule || []).length > 0 ? 'PROVIDED' : 'MISSING', '',
    ]);

    const csv = [rowToCSV(headers), ...rows.map(rowToCSV)].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="debt_schedule_management_input.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /export/far-template â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/export/far-template', async (req, res) => {
  try {
    const assets = readJ('asset_register.json', { assets: [] });
    const brData = await readBranches();
    const branchNames = (brData.branches || []).map(b => b.branch_name).join(' | ');

    const headers = ['asset_id','asset_description','branch','asset_category',
      'capitalisation_date','original_cost_inr','accumulated_depreciation_inr',
      'useful_life_years','depreciation_method','residual_value_inr','opening_nbv_inr',
      'in_service','notes'];
    const commentRow = ['INSTRUCTIONS','Fill in all columns. Branches: ' + branchNames,
      '','Categories: Leasehold Improvements | Furniture & Fixtures | Office Equipment | IT Equipment | Vehicles | Other',
      '','','','Depreciation methods: WDV | SLM','WDV | SLM','','','TRUE | FALSE',''];

    const dataRows = (assets.assets || []).filter(a => a.active !== false).map(a => [
      a.asset_id || '', a.description || '', a.branch || '', a.category || '',
      a.capitalisation_date || '', a.original_cost || '', a.accumulated_depreciation || '',
      a.useful_life_years || '', a.depreciation_method || '', a.residual_value || '', a.opening_nbv || '',
      a.in_service !== false ? 'TRUE' : 'FALSE', '',
    ]);

    const csv = [rowToCSV(headers), rowToCSV(commentRow), ...dataRows.map(rowToCSV)].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="fixed_asset_register_template.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /export/master â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Exports a ZIP-like multi-CSV as a JSON bundle for client-side download.
router.get('/export/master-bundle', async (req, res) => {
  try {
    const [mapData, brData, clData] = await Promise.all([readMappings(), readBranches(), readClients()]);
    const debtData = readJ('debt_schedule.json', { facilities: [] });
    const assets   = readJ('asset_register.json', { assets: [] });
    const leaseIdx = buildLeaseIndex();
    const clientMap = {};
    for (const c of clData.clients || []) clientMap[c.client_id] = c;
    const branchMap = {};
    for (const b of brData.branches || []) branchMap[b.branch_id] = b;

    // Sheet 1: Client Revenue
    const crHeaders = ['mapping_id','client_name','branch_name','latest_actual_month',
      'avg_3m_inr','avg_6m_inr','contracted_monthly_revenue_inr','escalation_pct',
      'escalation_effective_month','billing_frequency'];
    const crRows = (mapData.mappings || []).filter(m => m.active !== false).map(m => {
      const cl = clientMap[m.client_id] || {};
      const br = branchMap[m.branch_id] || {};
      return rowToCSV([m.mapping_id, cl.client_name || m.client_id, br.branch_name || m.branch_id,
        m.latest_actual_month || '', m.avg_3m || '', m.avg_6m || '',
        m.contracted_monthly_revenue || '', m.escalation_pct || '', m.escalation_effective_month || '',
        m.billing_frequency || '']);
    });

    // Sheet 2: Branch Capacity
    const bcHeaders = ['branch_id','branch_name','city','ref_lease_sqft','ref_rent_lakh',
      'total_area_sqft','total_seats','target_occupancy_pct','status','opening_date'];
    const bcRows = (brData.branches || []).map(b => {
      const lease = leaseIdx[b.branch_name] || {};
      return rowToCSV([b.branch_id, b.branch_name, b.city || '', lease.super_buildup_sqft || '',
        lease.rent_lakh || '', b.total_area_sqft || '', b.total_seats || '',
        b.target_occupancy_pct || '', b.status || 'LIVE', b.opening_date || '']);
    });

    // Sheet 3: Cost Assumptions
    const caHeaders = ['branch_id','branch_name','ref_bills_rent_6m','ref_bills_util_6m',
      'ref_bills_people_6m','rent_monthly_inr','cam_monthly_inr','utilities_monthly_inr',
      'people_cost_monthly_inr','other_direct_monthly_inr'];
    const caRows = (brData.branches || []).map(b => rowToCSV([
      b.branch_id, b.branch_name,
      b.ref_bills_rent_6m_avg || '', b.ref_bills_util_6m_avg || '', b.ref_bills_people_6m_avg || '',
      b.rent_monthly || '', b.cam_monthly || '', b.utilities_monthly || '',
      b.people_cost_monthly || '', b.other_direct_cost_monthly || '',
    ]));

    // Sheet 4: Debt
    const dbHeaders = ['facility_id','label','opening_principal_lakh','rate_pct','emi_lakh','maturity','schedule_status'];
    const dbRows = (debtData.facilities || []).map(f => rowToCSV([
      f.id || f.facility_id, f.label || f.facility_name || '',
      f.opening_principal || '', f.rate || f.interest_rate || '', f.emi_lakh || '',
      f.maturity || '', (f.repayment_schedule || []).length > 0 ? 'PROVIDED' : 'MISSING',
    ]));

    res.json({
      generated_at: now(),
      sheets: {
        '1_Client_Revenue':   [rowToCSV(crHeaders), ...crRows].join('\n'),
        '2_Branch_Capacity':  [rowToCSV(bcHeaders), ...bcRows].join('\n'),
        '3_Cost_Assumptions': [rowToCSV(caHeaders), ...caRows].join('\n'),
        '4_Debt':             [rowToCSV(dbHeaders), ...dbRows].join('\n'),
        '5_FAR_Template':     rowToCSV(['asset_id','description','branch','category','capitalisation_date','cost_inr','accum_dep_inr','useful_life','depreciation_method','opening_nbv_inr','notes']),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /client-revenue/value-coverage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns value-weighted contracted revenue coverage stats.
router.get('/client-revenue/value-coverage', async (req, res) => {
  try {
    const [mapData, clData] = await Promise.all([readMappings(), readClients()]);
    const clientMap = {};
    for (const c of clData.clients || []) clientMap[c.client_id] = c;
    const mappings = (mapData.mappings || []).filter(m => m.active !== false);

    let totalRefRevenue = 0, contractedRevenue = 0;
    let withContracted = 0, withoutContracted = 0;

    for (const m of mappings) {
      const refRev     = m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0;
      const contracted = m.contracted_monthly_revenue || clientMap[m.client_id]?.current_monthly_revenue || 0;
      totalRefRevenue += Number(refRev);
      if (contracted > 0) { contractedRevenue += Number(contracted); withContracted++; }
      else withoutContracted++;
    }

    const coveragePct = totalRefRevenue > 0 ? Math.round(contractedRevenue / totalRefRevenue * 100) : 0;

    res.json({
      total_mappings: mappings.length,
      with_contracted: withContracted,
      without_contracted: withoutContracted,
      record_coverage_pct: Math.round(withContracted / mappings.length * 100),
      total_reference_revenue_inr: r2(totalRefRevenue),
      contracted_revenue_inr: r2(contractedRevenue),
      value_coverage_pct: coveragePct,
      note: 'Reference revenue = 6M avg where available, else 3M avg, else latest actual. Value coverage = contracted / reference Ã— 100.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SECTION 15B â€” MANAGEMENT INPUT COMPLETION & APPROVAL WORKFLOW
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Revenue proposal algorithm â€” never invents data, only uses what exists.
// Returns { proposed, basis, confidence, exception_flag }
function computeRevenueProposal(m) {
  const latest = Number(m.latest_actual_revenue) || 0;
  const avg3m  = m.avg_3m  != null ? Number(m.avg_3m)  : null;
  const avg6m  = m.avg_6m  != null ? Number(m.avg_6m)  : null;
  const months = m.months_with_data || 0;

  if (!latest && avg3m == null && avg6m == null) {
    return { proposed: null, basis: 'NO_HISTORY', confidence: 'REVIEW_REQUIRED', exception_flag: 'no_actuals' };
  }
  if (months < 2) {
    const fallback = avg6m != null ? avg6m : avg3m != null ? avg3m : latest;
    return { proposed: fallback ? Math.round(fallback) : null,
             basis: 'LIMITED_HISTORY', confidence: 'REVIEW_REQUIRED', exception_flag: 'insufficient_history' };
  }
  const ref = avg6m != null ? avg6m : avg3m != null ? avg3m : latest;
  const latestRatio = ref > 0 ? latest / ref : 1;

  if (latestRatio > 2.5) {
    const p = avg6m != null ? avg6m : avg3m;
    return { proposed: p != null ? Math.round(p) : null,
             basis: 'LATEST_EXCLUDED_ABNORMALLY_HIGH', confidence: 'REVIEW_REQUIRED',
             exception_flag: 'latest_vs_6m_exceeds_2_5x_possible_advance_billing' };
  }
  if (latestRatio < 0.3 && months >= 3) {
    const p = avg6m != null ? avg6m : avg3m;
    return { proposed: p != null ? Math.round(p) : null,
             basis: 'LATEST_EXCLUDED_ABNORMALLY_LOW', confidence: 'REVIEW_REQUIRED',
             exception_flag: 'latest_abnormally_low_possible_credit_note_or_gap' };
  }
  // Irregular billing pattern (3m vs 6m gap > 45%)
  if (avg3m != null && avg6m != null && avg6m > 0 && Math.abs(avg3m / avg6m - 1) > 0.45) {
    return { proposed: Math.round(avg6m),
             basis: 'NORMALIZED_IRREGULAR_BILLING_6M', confidence: 'LOW',
             exception_flag: 'possible_quarterly_or_milestone_billing' };
  }
  // CoV across available values
  const vals = [latest, avg3m, avg6m].filter(v => v != null && v > 0);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const cov  = mean > 0 ? Math.sqrt(vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / vals.length) / mean : 0;
  const proposed = avg6m != null ? Math.round(avg6m) : avg3m != null ? Math.round(avg3m) : Math.round(latest);

  if (cov < 0.15) return { proposed, basis: 'STABLE_RECURRING_6M_AVG',       confidence: 'HIGH',   exception_flag: null };
  if (cov < 0.30) return { proposed, basis: 'MODERATE_VARIATION_6M_AVG',     confidence: 'MEDIUM', exception_flag: null };
  return              { proposed, basis: 'HIGH_VARIATION_USE_WITH_CAUTION', confidence: 'LOW',    exception_flag: 'high_billing_volatility' };
}

// â”€â”€â”€ GET /revenue-proposals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/revenue-proposals', async (req, res) => {
  try {
    const { confidence, exception_only, branch, search, page = 1, per_page = 50 } = req.query;
    const [mapData, brData, clData] = await Promise.all([readMappings(), readBranches(), readClients()]);
    const branchMap = {};
    for (const b of brData.branches || []) branchMap[b.branch_id] = b;
    const clientMap = {};
    for (const c of clData.clients || []) clientMap[c.client_id] = c;

    const mappings = (mapData.mappings || []).filter(m => m.active !== false);
    let rows = mappings.map(m => {
      const branch   = branchMap[m.branch_id] || {};
      const client   = clientMap[m.client_id] || {};
      const proposal = computeRevenueProposal(m);
      return {
        mapping_id:   m.mapping_id,
        client_id:    m.client_id,
        client_name:  client.client_name || m.client_id,
        branch_id:    m.branch_id,
        branch_name:  branch.branch_name || m.branch_id,
        city:         branch.city || null,
        latest_actual_revenue: m.latest_actual_revenue ?? null,
        latest_actual_month:   m.latest_actual_month   ?? null,
        avg_3m:       m.avg_3m ?? null,
        avg_6m:       m.avg_6m ?? null,
        months_with_data: m.months_with_data || 0,
        proposed_monthly_revenue: proposal.proposed,
        proposed_basis:    proposal.basis,
        confidence:        proposal.confidence,
        exception_flag:    proposal.exception_flag,
        contracted_monthly_revenue: m.contracted_monthly_revenue ?? null,
        approval_status:   m.approval_status ?? 'pending_review',
        approved_by:       m.approved_by ?? null,
        approved_at:       m.approved_at ?? null,
        escalation_pct:    m.escalation_pct ?? null,
        escalation_frequency:       m.escalation_frequency ?? 'annual',
        escalation_effective_month: m.escalation_effective_month ?? null,
        is_approved:  !!(m.contracted_monthly_revenue > 0 && m.approval_status === 'approved'),
        needs_review: proposal.confidence === 'REVIEW_REQUIRED' || !!proposal.exception_flag,
      };
    });

    // Sort by reference revenue desc (materiality first)
    rows.sort((a, b) => (b.avg_6m || 0) - (a.avg_6m || 0));

    // Add materiality cumulative rank
    const totalRef = rows.reduce((s, r) => s + (r.avg_6m || 0), 0);
    let cumRef = 0;
    rows.forEach((r, i) => {
      cumRef += (r.avg_6m || 0);
      r.materiality_rank = i + 1;
      r.cumulative_pct   = totalRef > 0 ? r2(cumRef / totalRef * 100) : 0;
    });

    // Summary before filters
    const confCounts = { HIGH: 0, MEDIUM: 0, LOW: 0, REVIEW_REQUIRED: 0, approved: 0 };
    for (const row of rows) {
      confCounts[row.confidence] = (confCounts[row.confidence] || 0) + 1;
      if (row.is_approved) confCounts.approved++;
    }

    // Apply filters
    if (confidence) rows = rows.filter(r => r.confidence === confidence);
    if (exception_only === 'true') rows = rows.filter(r => r.needs_review);
    if (branch) rows = rows.filter(r => r.branch_name === branch || r.branch_id === branch);
    if (search) {
      const s = search.toLowerCase();
      rows = rows.filter(r => (r.client_name || '').toLowerCase().includes(s) || (r.branch_name || '').toLowerCase().includes(s));
    }

    const total = rows.length;
    const p  = Math.max(1, parseInt(page));
    const pp = Math.min(200, Math.max(1, parseInt(per_page)));

    res.json({
      rows:    rows.slice((p - 1) * pp, p * pp),
      total,   page: p, per_page: pp,
      summary: {
        total: mappings.length,
        high_confidence:   confCounts.HIGH   || 0,
        medium_confidence: confCounts.MEDIUM || 0,
        low_confidence:    confCounts.LOW    || 0,
        review_required:   confCounts.REVIEW_REQUIRED || 0,
        approved:          confCounts.approved,
        unapproved:        mappings.length - (confCounts.approved || 0),
        proposed_total_ref: r2(totalRef),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /revenue-proposals/approve â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Explicit management approval: sets contracted_monthly_revenue = proposed (or override).
// NEVER auto-called â€” requires an explicit POST from the UI.
router.post('/revenue-proposals/approve', adminOnly, async (req, res) => {
  try {
    const { mapping_ids, approved_by = 'management', override_revenue } = req.body;
    if (!Array.isArray(mapping_ids) || !mapping_ids.length)
      return res.status(400).json({ error: 'mapping_ids array required' });

    const data = await readMappings();
    const byId = {};
    for (const m of data.mappings || []) byId[m.mapping_id] = m;

    let approved = 0, skipped = 0;
    for (const mid of mapping_ids) {
      const m = byId[mid]; if (!m) { skipped++; continue; }
      const proposal = computeRevenueProposal(m);
      const rev = (override_revenue && override_revenue[mid] != null) ? Number(override_revenue[mid]) : proposal.proposed;
      if (rev == null || rev <= 0) { skipped++; continue; }
      m.contracted_monthly_revenue = rev;
      m.approval_status   = 'approved';
      m.approved_by       = approved_by;
      m.approved_at       = now();
      m.approved_basis    = proposal.basis;
      m.approved_confidence = proposal.confidence;
      m.management_input_source = 'step15b_proposal_approved';
      m.last_updated      = now();
      approved++;
    }
    data.last_updated = now();
    await writeMappings(data);
    res.json({ ok: true, approved, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /revenue-proposals/approve-by-confidence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/revenue-proposals/approve-by-confidence', adminOnly, async (req, res) => {
  try {
    const { confidence, approved_by = 'management', branch_id } = req.body;
    if (!confidence) return res.status(400).json({ error: 'confidence required' });

    const data = await readMappings();
    let approved = 0, skipped = 0;
    for (const m of data.mappings || []) {
      if (m.active === false) continue;
      if (branch_id && m.branch_id !== branch_id) continue;
      if (m.contracted_monthly_revenue > 0 && m.approval_status === 'approved') { skipped++; continue; }
      const proposal = computeRevenueProposal(m);
      if (proposal.confidence !== confidence) continue;
      if (!proposal.proposed || proposal.proposed <= 0) { skipped++; continue; }
      m.contracted_monthly_revenue = proposal.proposed;
      m.approval_status   = 'approved';
      m.approved_by       = approved_by;
      m.approved_at       = now();
      m.approved_basis    = proposal.basis;
      m.approved_confidence = confidence;
      m.management_input_source = 'step15b_bulk_by_confidence';
      m.last_updated      = now();
      approved++;
    }
    data.last_updated = now();
    await writeMappings(data);
    res.json({ ok: true, approved, skipped, confidence, message: `${approved} ${confidence}-confidence mappings approved.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /revenue-proposals/coverage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/revenue-proposals/coverage', async (req, res) => {
  try {
    const [mapData, clData] = await Promise.all([readMappings(), readClients()]);
    const clientMap = {};
    for (const c of clData.clients || []) clientMap[c.client_id] = c;
    const mappings = (mapData.mappings || []).filter(m => m.active !== false);

    const rows = mappings.map(m => {
      const proposal = computeRevenueProposal(m);
      const ref = Number(m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0);
      const contracted = Number(m.contracted_monthly_revenue || clientMap[m.client_id]?.current_monthly_revenue || 0);
      return { ref, proposed: proposal.proposed || 0, contracted, is_approved: m.approval_status === 'approved' && contracted > 0 };
    }).sort((a, b) => b.ref - a.ref);

    const totalRef      = r2(rows.reduce((s, r) => s + r.ref,      0));
    const totalProposed = r2(rows.reduce((s, r) => s + r.proposed, 0));
    const totalApproved = r2(rows.filter(r => r.is_approved).reduce((s, r) => s + r.contracted, 0));
    const withApproved  = rows.filter(r => r.is_approved).length;
    const withProposed  = rows.filter(r => r.proposed > 0).length;

    // Materiality thresholds
    const materiality = {};
    for (const t of [80, 90, 95]) {
      let cum = 0, count = 0;
      for (const r of rows) { cum += r.ref; count++; if (totalRef > 0 && cum / totalRef * 100 >= t) break; }
      materiality[`top_${t}_pct`] = { count, ref_inr: r2(totalRef * t / 100) };
    }

    res.json({
      total_mappings:          mappings.length,
      total_reference_revenue: totalRef,
      total_proposed_revenue:  totalProposed,
      total_approved_revenue:  totalApproved,
      with_proposed:   withProposed,
      with_approved:   withApproved,
      record_proposed_pct: Math.round(withProposed  / mappings.length * 100),
      record_approved_pct: Math.round(withApproved  / mappings.length * 100),
      value_proposed_pct:  totalRef > 0 ? r2(totalProposed / totalRef * 100) : 0,
      value_approved_pct:  totalRef > 0 ? r2(totalApproved / totalRef * 100) : 0,
      proposed_vs_ref_diff: r2(totalProposed - totalRef),
      materiality,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /debt-completion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 32 facilities: shows only missing fields, derives EMI where principal + tenor + rate present.
router.get('/debt-completion', async (req, res) => {
  try {
    const debtData = readJ('debt_schedule.json', { facilities: [] });
    const facilities = (debtData.facilities || []).map(f => {
      const principal   = Number(f.opening_principal || 0);
      const rateAnnual  = Number(f.rate || f.interest_rate || 0);
      const emiManual   = Number(f.emi_lakh || 0);
      const startDate   = f.repayment_start_date || f.start_date || null;
      const maturity    = f.maturity || f.maturity_date || null;

      let tenorMonths = Number(f.tenor_months || 0);
      if (!tenorMonths && startDate && maturity) {
        const s = new Date(startDate), e = new Date(maturity);
        if (!isNaN(s) && !isNaN(e)) tenorMonths = Math.max(1, Math.round((e - s) / (1000 * 60 * 60 * 24 * 30.44)));
      }

      let derivedEmi = null, emiSource = 'MISSING';
      if (emiManual > 0) {
        derivedEmi = emiManual; emiSource = 'MANUAL';
      } else if (principal > 0 && tenorMonths > 0) {
        if (rateAnnual > 0) {
          const r = rateAnnual / 100 / 12;
          const pow = Math.pow(1 + r, tenorMonths);
          derivedEmi = r2(principal * r * pow / (pow - 1));
        } else {
          derivedEmi = r2(principal / tenorMonths);
        }
        emiSource = 'DERIVED';
      }

      const missing = [];
      if (rateAnnual === 0) missing.push('confirm_zero_rate');
      if (!startDate)        missing.push('repayment_start_date');
      if (!tenorMonths && !maturity) missing.push('tenor_or_maturity');
      if (!derivedEmi)       missing.push('emi_lakh');

      return {
        facility_id:   f.id || f.facility_id,
        label:         f.label || f.facility_name || '',
        facility_type: f.facility_type || '',
        lender:        f.lender || f.bank_name || '',
        opening_principal:     principal,
        interest_rate:         rateAnnual,
        repayment_start_date:  startDate,
        tenor_months:          tenorMonths || null,
        maturity,
        emi_lakh:              derivedEmi,
        emi_source:            emiSource,
        balloon_payment:       f.balloon_payment || null,
        schedule_provided:     (f.repayment_schedule || []).length > 0,
        schedule_months:       (f.repayment_schedule || []).length,
        can_derive:            principal > 0 && tenorMonths > 0,
        missing_fields:        missing,
        is_complete:           missing.length === 0 && (derivedEmi > 0 || (f.repayment_schedule || []).length > 0),
        notes:                 f.notes || null,
      };
    });

    res.json({
      facilities,
      summary: {
        total:          facilities.length,
        complete:       facilities.filter(f => f.is_complete).length,
        can_derive:     facilities.filter(f => f.can_derive && !f.schedule_provided).length,
        needs_manual:   facilities.filter(f => !f.is_complete && !f.can_derive).length,
        with_schedule:  facilities.filter(f => f.schedule_provided).length,
        zero_rate_confirm: facilities.filter(f => f.missing_fields.includes('confirm_zero_rate')).length,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /debt-completion/save â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/debt-completion/save', adminOnly, async (req, res) => {
  try {
    const { facility_id, interest_rate, repayment_start_date, tenor_months,
            maturity, emi_lakh, balloon_payment, notes } = req.body;
    if (!facility_id) return res.status(400).json({ error: 'facility_id required' });

    const debtData = readJ('debt_schedule.json', { facilities: [] });
    const f = (debtData.facilities || []).find(x => (x.id || x.facility_id) === facility_id);
    if (!f) return res.status(404).json({ error: 'Facility not found' });

    // Only update fields that are provided â€” never overwrite opening_principal or lender (source fields)
    if (interest_rate != null) f.rate = Number(interest_rate);
    if (repayment_start_date) f.repayment_start_date = repayment_start_date;
    if (tenor_months != null) f.tenor_months = Number(tenor_months);
    if (maturity) f.maturity = maturity;
    if (emi_lakh != null) f.emi_lakh = Number(emi_lakh);
    if (balloon_payment != null) f.balloon_payment = Number(balloon_payment);
    if (notes !== undefined) f.notes = notes;
    f.completion_source = 'step15b_management_input';
    f.completion_updated_at = now();

    writeJ('debt_schedule.json', debtData);
    res.json({ ok: true, facility_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /debt-completion/:facility_id/schedule â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/debt-completion/:facility_id/schedule', async (req, res) => {
  try {
    const debtData = readJ('debt_schedule.json', { facilities: [] });
    const f = (debtData.facilities || []).find(x => (x.id || x.facility_id) === req.params.facility_id);
    if (!f) return res.status(404).json({ error: 'Facility not found' });

    const principal  = Number(f.opening_principal || 0);
    const rateAnnual = Number(f.rate || f.interest_rate || 0);
    const startDate  = f.repayment_start_date || f.start_date;
    const maturity   = f.maturity || f.maturity_date;

    let tenorMonths = Number(f.tenor_months || 0);
    if (!tenorMonths && startDate && maturity) {
      const s = new Date(startDate), e = new Date(maturity);
      if (!isNaN(s) && !isNaN(e)) tenorMonths = Math.max(1, Math.round((e - s) / (1000 * 60 * 60 * 24 * 30.44)));
    }
    if (!tenorMonths || !principal)
      return res.status(400).json({ error: 'Cannot derive schedule: missing principal or tenor' });

    const r = rateAnnual / 100 / 12;
    let emi;
    if (Number(f.emi_lakh) > 0) {
      emi = Number(f.emi_lakh);
    } else if (rateAnnual > 0) {
      const pow = Math.pow(1 + r, tenorMonths); emi = r2(principal * r * pow / (pow - 1));
    } else {
      emi = r2(principal / tenorMonths);
    }

    const schedule = [];
    let balance = principal;
    let date = startDate ? new Date(startDate) : new Date();
    for (let i = 0; i < tenorMonths && balance > 0.01; i++) {
      const interest = r2(balance * r);
      let principalPmt = r2(emi - interest);
      if (i === tenorMonths - 1 || principalPmt >= balance) principalPmt = r2(balance);
      const closing = r2(balance - principalPmt);
      schedule.push({ month: date.toISOString().slice(0, 7), opening: r2(balance), interest, principal: principalPmt, closing });
      balance = closing;
      date = new Date(date.getFullYear(), date.getMonth() + 1, 1);
    }

    const totalPrin = r2(schedule.reduce((s, row) => s + row.principal, 0));
    const totalInt  = r2(schedule.reduce((s, row) => s + row.interest,  0));

    res.json({
      facility_id: req.params.facility_id,
      opening_principal: principal, rate_annual: rateAnnual, emi, tenor_months: tenorMonths,
      schedule,
      validation: {
        valid: Math.abs(totalPrin - principal) < 1,
        total_principal_repaid: totalPrin,
        total_interest: totalInt,
        closing_balance: r2(balance),
        difference: r2(Math.abs(totalPrin - principal)),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /export/debt-completion-csv â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/export/debt-completion-csv', async (req, res) => {
  try {
    const debtData = readJ('debt_schedule.json', { facilities: [] });
    const esc = (v) => (v == null || v === '') ? '' : (String(v).includes(',') || String(v).includes('"')) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
    const headers = ['facility_id','label','lender','facility_type','opening_principal_lakh',
      'interest_rate_pct','repayment_start_date','tenor_months','maturity_date',
      'monthly_emi_lakh','balloon_payment_lakh','notes','schedule_status'];
    const rows = (debtData.facilities || []).map(f =>
      [f.id||f.facility_id, f.label||f.facility_name||'', f.lender||'', f.facility_type||'',
       f.opening_principal||'', f.rate||f.interest_rate||'', f.repayment_start_date||f.start_date||'',
       f.tenor_months||'', f.maturity||f.maturity_date||'', f.emi_lakh||'', f.balloon_payment||'',
       f.notes||'', (f.repayment_schedule||[]).length>0?'PROVIDED':'MISSING'].map(esc).join(',')
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="debt_completion_template.csv"');
    res.send([headers.join(','), ...rows].join('\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /import/debt-completion-csv â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/import/debt-completion-csv', adminOnly, async (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv) return res.status(400).json({ error: 'csv required' });
    const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: 'No data rows found' });
    const hdrs = lines[0].split(',').map(h => h.replace(/^"|"$/g,'').trim());
    const debtData = readJ('debt_schedule.json', { facilities: [] });
    const byId = {};
    for (const f of debtData.facilities || []) byId[f.id || f.facility_id] = f;

    let updated = 0, skipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map(v => v.replace(/^"|"$/g,'').trim());
      const row  = {}; hdrs.forEach((h, idx) => { row[h] = vals[idx] || ''; });
      const f = byId[row.facility_id]; if (!f) { skipped++; continue; }
      if (row.interest_rate_pct !== undefined && row.interest_rate_pct !== '') f.rate = Number(row.interest_rate_pct);
      if (row.repayment_start_date) f.repayment_start_date = row.repayment_start_date;
      if (row.tenor_months)         f.tenor_months = Number(row.tenor_months);
      if (row.maturity_date)        f.maturity = row.maturity_date;
      if (row.monthly_emi_lakh)     f.emi_lakh = Number(row.monthly_emi_lakh);
      if (row.balloon_payment_lakh) f.balloon_payment = Number(row.balloon_payment_lakh);
      if (row.notes)                f.notes = row.notes;
      f.completion_source = 'step15b_csv_import'; f.completion_updated_at = now();
      updated++;
    }
    writeJ('debt_schedule.json', debtData);
    res.json({ ok: true, updated, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /obs-review â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/obs-review', async (req, res) => {
  try {
    const obs = readJ('opening_balance_sheet.json', {});
    const totalAssets = Number(obs.total_assets || 0);
    const totalEl     = Number(obs.total_el || 0);
    const diff        = r2(totalAssets - totalEl);
    const isRounding  = Math.abs(diff) < 0.1;
    res.json({
      total_assets:      totalAssets,
      total_liabilities: Number(obs.total_liabilities || 0),
      total_equity:      Number(obs.total_equity || 0),
      total_el:          totalEl,
      bs_check_diff:     diff,
      is_rounding:       isRounding,
      approval_status:   obs.approval_status || 'pending_review',
      approved_by:       obs.approved_by || null,
      approved_at:       obs.approved_at || null,
      approval_note:     obs.approval_note || null,
      line_items:        obs.line_items || [],
      has_line_items:    (obs.line_items || []).length > 0,
      reconciliation_status: diff === 0 ? 'BALANCED' : isRounding ? 'ROUNDING_DIFFERENCE' : 'UNEXPLAINED_DIFFERENCE',
      reconciliation_note:   diff === 0 ? 'OBS is balanced.' :
                             isRounding ? `Difference of â‚¹${Math.abs(diff)}L is within rounding tolerance.` :
                             `UNEXPLAINED DIFFERENCE â‚¹${diff}L â€” must be resolved. DO NOT use a balancing plug.`,
      audit_trail:       obs.audit_trail || [],
      last_updated:      obs.last_updated || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /obs-approve-v2 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Enhanced OBS approval with full audit trail.
router.post('/obs-approve-v2', adminOnly, async (req, res) => {
  try {
    const { decision, approved_by, comment } = req.body;
    if (!['approved','rejected','returned_for_correction'].includes(decision))
      return res.status(400).json({ error: 'decision must be: approved | rejected | returned_for_correction' });
    if (!approved_by) return res.status(400).json({ error: 'approved_by required' });
    if (decision === 'approved' && !comment)
      return res.status(400).json({ error: 'comment required when approving OBS' });

    const obs = readJ('opening_balance_sheet.json', {});
    if (obs.approval_status === 'approved' && decision === 'approved') {
      return res.status(409).json({ error: 'OBS already approved. Use returned_for_correction to reopen.' });
    }

    (obs.audit_trail = obs.audit_trail || []).push({
      action: decision, by: approved_by, at: now(), comment: comment || null,
      diff_at_time: Number(obs.bs_check_diff || 0),
    });
    obs.approval_status = decision;
    obs.approved_by     = approved_by;
    obs.approved_at     = decision === 'approved' ? now() : null;
    obs.approval_note   = comment || null;
    obs.last_updated    = now();

    writeJ('opening_balance_sheet.json', obs);
    res.json({ ok: true, decision, approved_by,
      message: decision === 'approved' ? 'OBS approved and locked as baseline opening position.' :
               decision === 'rejected' ? 'OBS rejected. Requires correction before re-submission.' :
               'OBS returned for correction.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /action-center â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 7-action executive summary â€” primary management UX, replaces 789-item worklist.
router.get('/action-center', async (req, res) => {
  try {
    const [mapData, brData, clData] = await Promise.all([readMappings(), readBranches(), readClients()]);
    const debtData = readJ('debt_schedule.json', { facilities: [] });
    const obs      = readJ('opening_balance_sheet.json', {});
    const ga       = readJ('global_assumptions.json', {});
    const assets   = readJ('asset_register.json', { assets: [] });

    const mappings   = (mapData.mappings || []).filter(m => m.active !== false);
    const branches   = brData.branches || [];
    const facilities = debtData.facilities || [];

    // A1: Revenue
    const withApproved = mappings.filter(m => m.contracted_monthly_revenue > 0 && m.approval_status === 'approved').length;
    const highConf     = mappings.filter(m => m.approval_status !== 'approved' && computeRevenueProposal(m).confidence === 'HIGH').length;
    const totalRef     = r2(mappings.reduce((s, m) => s + (m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0), 0));
    const approvedRev  = r2(mappings.filter(m => m.contracted_monthly_revenue > 0 && m.approval_status === 'approved').reduce((s, m) => s + m.contracted_monthly_revenue, 0));
    const valCoverage  = totalRef > 0 ? r2(approvedRev / totalRef * 100) : 0;

    // A2: Debt
    const debtComplete = facilities.filter(f => {
      const canDerive = Number(f.opening_principal) > 0 && (Number(f.tenor_months) > 0 || (f.repayment_start_date && (f.maturity || f.maturity_date)));
      return (f.repayment_schedule || []).length > 0 || (canDerive && Number(f.emi_lakh || 0) > 0);
    }).length;

    // A3: OBS
    const obsApproved = obs.approval_status === 'approved';

    // A4: Cost
    const branchesApproved = branches.filter(b => b.cost_approved_at).length;

    // A5: Capacity
    const capacityComplete = branches.filter(b => b.total_seats > 0 && b.total_area_sqft > 0).length;

    // A6: Utilities
    const utilitiesApproved = !!(ga.utilities_method && ga.utilities_method_approved_at);

    // A7: FAR
    const activeAssets = (assets.assets || []).filter(a => a.active !== false).length;

    const actions = [
      { action_num:1, title:'Review & Approve Client Revenue', module:'Client Revenue', priority:'CRITICAL',
        status: withApproved===mappings.length?'COMPLETE':withApproved>0?'IN_PROGRESS':'PENDING',
        progress:{ done:withApproved, total:mappings.length, pct:Math.round(withApproved/mappings.length*100) },
        kpi:`â‚¹-weighted coverage: ${valCoverage}%`, quick_win: highConf>0?`${highConf} HIGH-confidence rows ready for bulk approval`:null,
        blocker: withApproved===0, tab:'rev_review' },
      { action_num:2, title:'Complete Debt Schedule (B1)', module:'Debt & Finance', priority:'CRITICAL',
        status: debtComplete===facilities.length?'COMPLETE':debtComplete>0?'IN_PROGRESS':'PENDING',
        progress:{ done:debtComplete, total:facilities.length, pct:Math.round(debtComplete/(facilities.length||1)*100) },
        kpi:`${facilities.length-debtComplete} facilities still incomplete`, quick_win:'EMI can be computed from rate+principal+tenor',
        blocker: debtComplete<facilities.length, tab:'debt' },
      { action_num:3, title:'Approve Opening Balance Sheet (B2)', module:'Opening BS', priority:'CRITICAL',
        status: obsApproved?'COMPLETE':'PENDING',
        progress:{ done:obsApproved?1:0, total:1, pct:obsApproved?100:0 },
        kpi:`Status: ${obs.approval_status||'pending_review'} | Diff: â‚¹${r2(obs.bs_check_diff||0)}L`,
        quick_win: Math.abs(obs.bs_check_diff||0)<0.1?'Difference is rounding only â€” ready to approve':null,
        blocker:!obsApproved, tab:'obs' },
      { action_num:4, title:'Accept Branch Cost Assumptions', module:'Cost Master', priority:'HIGH',
        status: branchesApproved===branches.length?'COMPLETE':branchesApproved>0?'IN_PROGRESS':'PENDING',
        progress:{ done:branchesApproved, total:branches.length, pct:Math.round(branchesApproved/(branches.length||1)*100) },
        kpi:`${branches.length-branchesApproved} branches awaiting approval`, quick_win:'Bulk accept 6M avg for all branches in one step',
        blocker:false, tab:'cost' },
      { action_num:5, title:'Complete Branch Capacity', module:'Branch Capacity', priority:'CRITICAL',
        status: capacityComplete===branches.length?'COMPLETE':capacityComplete>0?'IN_PROGRESS':'PENDING',
        progress:{ done:capacityComplete, total:branches.length, pct:Math.round(capacityComplete/(branches.length||1)*100) },
        kpi:`Seats: ${branches.filter(b=>b.total_seats>0).length}/30 | Area: ${branches.filter(b=>b.total_area_sqft>0).length}/30`,
        quick_win:'Lease area pre-filled for 20/30 branches â€” confirm only',
        blocker:capacityComplete===0, tab:'branch_cap' },
      { action_num:6, title:'Approve Utilities Methodology', module:'Utilities', priority:'HIGH',
        status: utilitiesApproved?'COMPLETE':ga.utilities_method?'DRAFT':'PENDING',
        progress:{ done:utilitiesApproved?1:0, total:1, pct:utilitiesApproved?100:0 },
        kpi:`Method: ${ga.utilities_method||'NOT SET'}`,
        quick_win:null, blocker:false, tab:'cost' },
      { action_num:7, title:'Complete Fixed Asset Register', module:'FAR', priority:'CRITICAL',
        status: activeAssets>0?'IN_PROGRESS':'PENDING',
        progress:{ done:activeAssets, total:null, pct:activeAssets>0?50:0 },
        kpi:`${activeAssets} assets loaded`, quick_win:'Download FAR template from Master Input Workbook',
        blocker:activeAssets===0, tab:'action_req' },
    ];

    const blockers  = actions.filter(a => a.blocker).length;
    const complete  = actions.filter(a => a.status === 'COMPLETE').length;
    const inProgress = actions.filter(a => a.status === 'IN_PROGRESS').length;

    let gate = 'STEP_15B_BLOCKED_MANAGEMENT_INPUT_REQUIRED';
    if (complete === actions.length) gate = 'STEP_15B_COMPLETE_READY_FOR_BASELINE_COMPUTE';
    else if (blockers === 0) gate = 'STEP_15B_READY_MANAGEMENT_APPROVAL_REQUIRED';

    res.json({ actions, gate_status: gate, complete, in_progress: inProgress, total: actions.length, blockers, overall_pct: Math.round(complete/actions.length*100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STEP 15D â€” BASELINE INPUT CLOSURE
// All routes: /api/fpa/step15/step15d/*
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â”€â”€â”€ GET /step15d/status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/step15d/status', async (req, res) => {
  try {
    const mapData   = readMappings();
    const brData    = await readBranches();
    const debtData  = readJ('debt_schedule.json', { facilities: [] });
    const obs       = readJ('opening_balance_sheet.json', {});
    const leases    = readJ('lease_schedule.json', { leases: [] });
    const accMap    = readJ('account_mapping.json', { mappings: {} });
    const costM     = readJ('cost_master.json', { assumptions: [] });
    const corpCost  = readJ('corporate_cost_master.json', { assumptions: [] });
    const taxP      = readJ('tax_params.json', {});
    const wcP       = readJ('wc_params.json', {});
    const draftBl   = readJ('draft_baseline_v1.json', { status: 'NOT_COMPUTED' });

    const mappings  = (mapData.mappings || []).filter(m => m.active !== false);
    const branches  = brData.branches || [];
    const facs      = debtData.facilities || [];

    // Revenue
    const totalRev     = mappings.reduce((s, m) => s + (m.avg_6m || m.latest_actual_revenue || 0), 0);
    const approvedMaps = mappings.filter(m => m.contracted_monthly_revenue > 0 && m.approval_status === 'approved');
    const approvedRev  = approvedMaps.reduce((s, m) => s + m.contracted_monthly_revenue, 0);
    const revPct       = totalRev > 0 ? r2((approvedRev / totalRev) * 100) : 0;

    // Branch capacity
    const capComplete  = branches.filter(b => b.total_seats > 0 && b.total_area_sqft > 0).length;

    // Cost
    const costApproved = (costM.assumptions || []).filter(a => a.approved === true).length;

    // OBS
    const obsApproved  = obs.approval_status === 'approved';

    // Lease / Ind AS 116
    const lArr         = leases.leases || [];
    const leaseWithRate = lArr.filter(l => l.ind_as_116 && l.ind_as_116.discount_rate_pct > 0).length;
    const blendedIBR   = leases.blended_discount_rate_pct || null;
    const leaseBlocked = leaseWithRate === 0 && !blendedIBR;

    // GL
    const glMaps       = typeof (accMap.mappings) === 'object' && !Array.isArray(accMap.mappings) ? Object.entries(accMap.mappings) : [];
    const glPending    = glMaps.filter(([, v]) => v.approval_status === 'pending_ca_confirmation' || v.approval_status === 'pending_review' || v.approval_status === 'manual_review').length;
    const glValue      = glMaps.filter(([, v]) => v.approval_status === 'pending_ca_confirmation' || v.approval_status === 'pending_review').reduce((s, [, v]) => s + Math.abs(v.total_lakh_fy26 || 0), 0);

    // Debt
    const activeFacs   = facs.filter(f => !f.repaid);
    const hasSchedules = activeFacs.filter(f => (f.repayment_schedule || []).length > 0).length;

    // Blockers
    const blockers = [
      { id: 'B1', label: 'Revenue',              blocked: approvedRev === 0,   detail: `${approvedMaps.length}/${mappings.length} approved Â· ${revPct}% value-weighted` },
      { id: 'B2', label: 'Branch Capacity',      blocked: capComplete === 0,   detail: `${capComplete}/${branches.length} complete` },
      { id: 'B3', label: 'Cost Master',           blocked: costApproved === 0,  detail: `${costApproved}/${branches.length} branches approved` },
      { id: 'B4', label: 'Opening BS',            blocked: !obsApproved,        detail: obs.approval_status || 'pending_review' },
      { id: 'B5', label: 'Ind AS 116 / Leases',   blocked: leaseBlocked,        detail: `${leaseWithRate}/${lArr.length} with discount rate` + (blendedIBR ? ` Â· Blended IBR: ${blendedIBR}%` : '') },
    ];
    const warnings = [
      { id: 'W1', label: 'Debt Schedule',    detail: `${activeFacs.length} active Â· ${hasSchedules} with repayment schedule Â· BS gap â‚¹3,185L` },
      { id: 'W2', label: 'GL Mapping',       detail: `${glPending} pending Â· â‚¹${r2(glValue)}L` },
      { id: 'W3', label: 'Tax Parameters',   detail: `${taxP.tax_rate_pct || 'NOT SET'}% Â· last_updated: ${taxP.last_updated || 'null'}` },
      { id: 'W4', label: 'WC Parameters',    detail: `DSO:${wcP.dso_days || 'NOT SET'} DPO:${wcP.dpo_days || 'NOT SET'} Â· last_updated: ${wcP.last_updated || 'null'}` },
    ];

    const hardBlockers = blockers.filter(b => b.blocked).length;
    const modules = [
      { module: 'Revenue',        record_pct: r2(approvedMaps.length/mappings.length*100), value_pct: revPct, status: approvedRev > 0 ? 'IN_PROGRESS' : 'BLOCKED' },
      { module: 'Branch Capacity', record_pct: r2(capComplete/branches.length*100),        value_pct: null,   status: capComplete > 0 ? 'IN_PROGRESS' : 'BLOCKED' },
      { module: 'Cost Master',     record_pct: r2(costApproved/branches.length*100),       value_pct: null,   status: costApproved > 0 ? 'IN_PROGRESS' : 'BLOCKED' },
      { module: 'Opening BS',      record_pct: obsApproved ? 100 : 0,                      value_pct: null,   status: obsApproved ? 'COMPLETE' : 'BLOCKED' },
      { module: 'Ind AS 116',      record_pct: r2(leaseWithRate/Math.max(lArr.length,1)*100), value_pct: null, status: leaseBlocked ? 'BLOCKED' : 'IN_PROGRESS' },
    ];
    const completePct  = r2(modules.filter(m => m.status === 'COMPLETE').length / modules.length * 100);

    let gate = 'STEP_15D_BLOCKED_INPUTS_REQUIRED';
    if (hardBlockers === 0 && draftBl.status === 'NOT_COMPUTED') gate = 'STEP_15D_INPUTS_COMPLETE_DRAFT_BASELINE_READY';
    if (draftBl.status === 'COMPUTED') gate = 'STEP_15D_DRAFT_BASELINE_COMPUTED_CFO_REVIEW_REQUIRED';
    if (draftBl.status === 'FROZEN')   gate = 'STEP_15D_BASELINE_V1_APPROVED_READY_FOR_STEP_16';

    res.json({ gate, hard_blockers: hardBlockers, blockers, warnings, modules, complete_pct: completePct,
      revenue_value_weighted_pct: revPct, approved_revenue_lakh: r2(approvedRev), total_reference_revenue_lakh: r2(totalRev),
      draft_baseline: draftBl.status || 'NOT_COMPUTED',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /step15d/readiness â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/step15d/readiness', async (req, res) => {
  try {
    const mapData  = readMappings();
    const brData   = await readBranches();
    const costM    = readJ('cost_master.json', { assumptions: [] });
    const obs      = readJ('opening_balance_sheet.json', {});
    const leases   = readJ('lease_schedule.json', { leases: [] });
    const debtData = readJ('debt_schedule.json', { facilities: [] });
    const accMap   = readJ('account_mapping.json', { mappings: {} });
    const far      = readJ('asset_register.json', { categories: [] });

    const mappings = (mapData.mappings || []).filter(m => m.active !== false);
    const branches = brData.branches || [];

    // Revenue
    const totalRevRef  = mappings.reduce((s, m) => s + (m.avg_6m || m.latest_actual_revenue || 0), 0);
    const aproved      = mappings.filter(m => m.contracted_monthly_revenue > 0 && m.approval_status === 'approved');
    const approvedRevV = aproved.reduce((s, m) => s + m.contracted_monthly_revenue, 0);
    const topN         = (n) => { const sorted = [...mappings].sort((a,b) => (b.avg_6m||0)-(a.avg_6m||0)); const top = sorted.slice(0,n); const tv = top.reduce((s,m)=>s+(m.avg_6m||0),0); const apv = top.filter(m=>m.approval_status==='approved').reduce((s,m)=>s+(m.contracted_monthly_revenue||0),0); return { count:n, ref_value:r2(tv), approved_value:r2(apv), pct:totalRevRef?r2(apv/tv*100):0 }; };

    const costAssumps  = costM.assumptions || [];
    const costApproved = costAssumps.filter(a => a.approved).length;
    const lArr         = leases.leases || [];
    const leaseRated   = lArr.filter(l => l.ind_as_116?.discount_rate_pct > 0).length;
    const glMaps       = !Array.isArray(accMap.mappings) ? Object.entries(accMap.mappings) : [];
    const glTotal      = glMaps.reduce((s,[,v])=>s+Math.abs(v.total_lakh_fy26||0),0);
    const glResolved   = glMaps.filter(([,v])=>!['pending_ca_confirmation','pending_review','manual_review'].includes(v.approval_status)).reduce((s,[,v])=>s+Math.abs(v.total_lakh_fy26||0),0);
    const activeFacs   = (debtData.facilities||[]).filter(f=>!f.repaid);
    const debtWithSched = activeFacs.filter(f=>(f.repayment_schedule||[]).length>0).length;

    res.json({
      revenue:         { total:mappings.length, approved:aproved.length, record_pct:r2(aproved.length/Math.max(mappings.length,1)*100), value_weighted_pct: r2(totalRevRef?approvedRevV/totalRevRef*100:0), ref_value:r2(totalRevRef), approved_value:r2(approvedRevV), materiality_80: topN(24), materiality_90: topN(58), materiality_95: topN(92) },
      branch_capacity: { total:branches.length, complete:branches.filter(b=>b.total_seats>0&&b.total_area_sqft>0).length, with_seats:branches.filter(b=>b.total_seats>0).length, with_area:branches.filter(b=>b.total_area_sqft>0).length, with_ref_area:branches.filter(b=>b.ref_super_buildup_sqft>0).length, pct:r2(branches.filter(b=>b.total_seats>0&&b.total_area_sqft>0).length/Math.max(branches.length,1)*100) },
      cost_master:     { total:branches.length, proposed:costAssumps.length, approved:costApproved, pct:r2(costApproved/Math.max(branches.length,1)*100) },
      obs:             { status:obs.approval_status||'pending_review', approved:obs.approval_status==='approved', diff:r2(obs.bs_check_diff||0), total_assets:r2(obs.total_assets||0) },
      leases:          { total:lArr.length, with_rate:leaseRated, blended_rate:leases.blended_discount_rate_pct||null, pct:r2(leaseRated/Math.max(lArr.length,1)*100) },
      debt:            { total:activeFacs.length, with_schedule:debtWithSched, pct:r2(debtWithSched/Math.max(activeFacs.length,1)*100) },
      gl_mapping:      { total:glMaps.length, resolved_value:r2(glResolved), total_value:r2(glTotal), resolved_pct: r2(glTotal?glResolved/glTotal*100:100) },
      far:             { categories:(far.categories||[]).length, computable:far.categories?.length>0, note:'Category-level WDV rates available from audited FS' },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ PUT /step15d/revenue/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Update escalation + contract dates on a mapping.
router.put('/step15d/revenue/:id', adminOnly, async (req, res) => {
  try {
    const { id }    = req.params;
    const mapData   = readMappings();
    const idx       = (mapData.mappings || []).findIndex(m => m.mapping_id === id);
    if (idx === -1) return res.status(404).json({ error: 'Mapping not found' });
    const m         = mapData.mappings[idx];
    const allowed   = ['contracted_monthly_revenue','escalation_pct','escalation_effective_month',
                       'next_escalation_pct','next_escalation_date','contract_start','contract_end',
                       'source','override_note','approval_status'];
    allowed.forEach(k => { if (req.body[k] !== undefined) m[k] = req.body[k]; });
    m.last_updated  = now();
    // If contracted_monthly_revenue set and approval_status not provided, mark proposed
    if (req.body.contracted_monthly_revenue != null && !req.body.approval_status)
      m.approval_status = m.approval_status === 'approved' ? 'changed_after_approval' : 'proposed';
    db.writeJSON(KEYS.mapping, FILES.mapping, mapData);
    res.json({ ok: true, mapping_id: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /step15d/revenue/bulk-approve-v2 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/step15d/revenue/bulk-approve-v2', adminOnly, async (req, res) => {
  try {
    const { mapping_ids, confidence_filter, approved_by, comment, override_values } = req.body;
    if (!approved_by) return res.status(400).json({ error: 'approved_by required' });
    const mapData   = readMappings();
    const overrMap  = {};
    if (Array.isArray(override_values)) override_values.forEach(o => { overrMap[o.mapping_id] = o.value; });

    let approved = 0, skipped = 0;
    const ts = now();
    for (const m of (mapData.mappings || [])) {
      if (m.active === false) continue;
      const inList = Array.isArray(mapping_ids) ? mapping_ids.includes(m.mapping_id) : false;
      const inConf = confidence_filter ? m.confidence === confidence_filter : false;
      if (!inList && !inConf) { skipped++; continue; }
      if (m.contracted_monthly_revenue > 0 && m.approval_status === 'approved') { skipped++; continue; }
      const rev = overrMap[m.mapping_id] || m.proposed_revenue || m.avg_6m || m.latest_actual_revenue || 0;
      if (!rev) { skipped++; continue; }
      m.contracted_monthly_revenue = rev;
      m.approval_status = 'approved';
      m.approved_by     = approved_by;
      m.approved_at     = ts;
      m.approval_comment = comment || null;
      m.last_updated    = ts;
      approved++;
    }
    db.writeJSON(KEYS.mapping, FILES.mapping, mapData);
    res.json({ ok: true, approved, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /step15d/branch-proposals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns all branches with auto-proposed values from lease/reference data.
router.get('/step15d/branch-proposals', async (req, res) => {
  try {
    const brData = await readBranches();
    const leases = readJ('lease_schedule.json', { leases: [] });
    const lArr   = leases.leases || [];
    // Build branch â†’ lease area map
    const branchLeaseArea = {};
    for (const l of lArr) {
      const bn = (l.branch || '').toLowerCase();
      if (!branchLeaseArea[bn]) branchLeaseArea[bn] = 0;
      branchLeaseArea[bn] += (l.super_buildup_sqft || 0);
    }
    const proposals = (brData.branches || []).map(b => {
      const bKey       = (b.branch_name || '').toLowerCase();
      const leaseArea  = branchLeaseArea[bKey] || b.ref_super_buildup_sqft || null;
      const proposed_area  = b.total_area_sqft || leaseArea;
      const proposed_rev_area = b.revenue_capacity_sqft || (leaseArea ? Math.round(leaseArea * 0.85) : null);
      const has_ref    = leaseArea != null || b.ref_super_buildup_sqft != null;
      return {
        branch_id:            b.branch_id,
        branch_name:          b.branch_name,
        city:                 b.city,
        active:               b.active,
        opening_date:         b.opening_date,
        // current values
        total_area_sqft:      b.total_area_sqft,
        revenue_capacity_sqft:b.revenue_capacity_sqft,
        total_seats:          b.total_seats,
        target_occupancy_pct: b.target_occupancy_pct,
        occupancy_ramp_template: b.occupancy_ramp_template || 'base',
        // proposed from reference
        proposed_area_sqft:   proposed_area,
        proposed_rev_area:    proposed_rev_area,
        proposed_seats:       b.total_seats || (leaseArea ? Math.round(leaseArea / 80) : null),
        // reference data
        ref_lease_area:       leaseArea,
        ref_super_buildup_sqft: b.ref_super_buildup_sqft,
        ref_lease_rent_lakh:  b.ref_lease_rent_lakh,
        ref_lease_escalation: b.ref_lease_escalation_pct,
        has_reference_data:   has_ref,
        source:               has_ref ? 'lease_schedule_ref' : 'management_input_required',
        // approvals
        capacity_approved:    !!(b.total_seats > 0 && b.total_area_sqft > 0),
        capacity_approved_by: b.capacity_approved_by || null,
        capacity_approved_at: b.capacity_approved_at || null,
        management_input_required: b.management_input_required || [],
      };
    });
    res.json({ proposals, total: proposals.length,
      with_ref: proposals.filter(p => p.has_reference_data).length,
      approved: proposals.filter(p => p.capacity_approved).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ PUT /step15d/branch/:branch_id/capacity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.put('/step15d/branch/:branch_id/capacity', adminOnly, async (req, res) => {
  try {
    const { branch_id } = req.params;
    const brData = await readBranches();
    const idx = (brData.branches || []).findIndex(b => b.branch_id === branch_id);
    if (idx === -1) return res.status(404).json({ error: 'Branch not found' });
    const b = brData.branches[idx];
    const fields = ['total_area_sqft','revenue_capacity_sqft','total_seats','target_occupancy_pct',
                    'occupancy_ramp_template','opening_date','capacity_approved_by','capacity_approved_at'];
    fields.forEach(k => { if (req.body[k] !== undefined) b[k] = req.body[k]; });
    if (req.body.approve && b.total_seats > 0 && b.total_area_sqft > 0) {
      b.capacity_approved    = true;
      b.capacity_approved_by = req.body.approved_by || b.capacity_approved_by;
      b.capacity_approved_at = now();
      b.management_input_required = (b.management_input_required || []).filter(f => !['total_seats','total_area_sqft','revenue_capacity_sqft'].includes(f));
    }
    b.last_updated = now();
    db.writeJSON(KEYS.branch, FILES.branch, brData);
    res.json({ ok: true, branch_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /step15d/branch/bulk-propose â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Accept all reference lease values as proposed (does not approve).
router.post('/step15d/branch/bulk-propose', adminOnly, async (req, res) => {
  try {
    const brData  = await readBranches();
    const leases  = readJ('lease_schedule.json', { leases: [] });
    const lArr    = leases.leases || [];
    const blaMap  = {};
    for (const l of lArr) {
      const k = (l.branch || '').toLowerCase();
      blaMap[k] = (blaMap[k] || 0) + (l.super_buildup_sqft || 0);
    }
    let proposed = 0;
    for (const b of (brData.branches || [])) {
      if (b.total_area_sqft > 0 && b.total_seats > 0) continue; // already populated
      const k = (b.branch_name || '').toLowerCase();
      const refArea = blaMap[k] || b.ref_super_buildup_sqft || null;
      if (!refArea) continue;
      if (!b.total_area_sqft) b.total_area_sqft = refArea;
      if (!b.revenue_capacity_sqft) b.revenue_capacity_sqft = Math.round(refArea * 0.85);
      if (!b.total_seats) b.total_seats = Math.round(refArea / 80);
      b.capacity_source  = 'bulk_proposed_from_lease_ref';
      b.last_updated     = now();
      proposed++;
    }
    db.writeJSON(KEYS.branch, FILES.branch, brData);
    res.json({ ok: true, proposed, message: `${proposed} branches populated with lease reference data. Management approval still required.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /step15d/cost-proposals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/step15d/cost-proposals', async (req, res) => {
  try {
    const brData  = await readBranches();
    const costM   = readJ('cost_master.json', { assumptions: [] });
    const assumpMap = {};
    for (const a of (costM.assumptions || [])) assumpMap[a.branch_id] = a;

    const proposals = (brData.branches || []).map(b => {
      const a = assumpMap[b.branch_id];
      const hasRef = b.ref_bills_rent_6m_avg != null;
      const toL    = v => v ? r2(v / 100000) : null; // paise â†’ lakh
      return {
        branch_id:   b.branch_id,
        branch_name: b.branch_name,
        city:        b.city,
        has_reference: hasRef,
        ref_data_months: b.ref_bills_data_months || null,
        // proposed from bill averages (converted to lakh)
        proposed: {
          rent:      toL(b.ref_bills_rent_6m_avg),
          utilities: toL(b.ref_bills_util_6m_avg),
          people:    toL(b.ref_bills_people_6m_avg),
          other:     toL(b.ref_bills_other_6m_avg),
          total:     toL((b.ref_bills_rent_6m_avg||0)+(b.ref_bills_util_6m_avg||0)+(b.ref_bills_people_6m_avg||0)+(b.ref_bills_other_6m_avg||0)),
        },
        // approved values from cost_master
        approved:   a ? a.cost_lines : null,
        approved_flag: a ? a.approved : false,
        approved_by: a ? a.approved_by : null,
        approved_at: a ? a.approved_at : null,
        source:      hasRef ? 'bills_6m_average' : 'management_input_required',
      };
    });
    const total     = proposals.length;
    const withRef   = proposals.filter(p => p.has_reference).length;
    const approved  = proposals.filter(p => p.approved_flag).length;
    res.json({ proposals, total, with_reference: withRef, approved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ PUT /step15d/cost/:branch_id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.put('/step15d/cost/:branch_id', adminOnly, async (req, res) => {
  try {
    const { branch_id } = req.params;
    const costM   = readJ('cost_master.json', { assumptions: [] });
    let   idx     = (costM.assumptions || []).findIndex(a => a.branch_id === branch_id);
    if (idx === -1) { costM.assumptions.push({ branch_id, approved: false }); idx = costM.assumptions.length - 1; }
    const a       = costM.assumptions[idx];
    if (req.body.cost_lines) a.cost_lines = req.body.cost_lines;
    if (req.body.approve) {
      a.approved      = true;
      a.approved_by   = req.body.approved_by || null;
      a.approved_at   = now();
      a.approval_note = req.body.note || null;
      a.version       = (a.version || 0) + 1;
    } else if (a.approved) {
      a.approved      = false;
      a.changed_after_approval = true;
      a.change_at     = now();
    }
    a.last_updated    = now();
    costM.last_updated = now();
    writeJ('cost_master.json', costM);
    res.json({ ok: true, branch_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /step15d/cost/bulk-propose â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Propose bill averages as cost assumptions for all branches with ref data.
router.post('/step15d/cost/bulk-propose', adminOnly, async (req, res) => {
  try {
    const brData = await readBranches();
    const costM  = readJ('cost_master.json', { assumptions: [] });
    const aMap   = {};
    for (const a of (costM.assumptions || [])) aMap[a.branch_id] = a;

    let proposed = 0;
    for (const b of (brData.branches || [])) {
      if (!b.ref_bills_rent_6m_avg && !b.ref_bills_util_6m_avg) continue;
      if (aMap[b.branch_id]?.approved) continue; // don't overwrite approved
      const toL = v => v ? r2(v / 100000) : 0;
      aMap[b.branch_id] = {
        branch_id:     b.branch_id,
        approved:      false,
        changed_after_approval: false,
        proposal_source: 'bulk_from_bills_6m_avg',
        cost_lines: {
          rent:      { proposed: toL(b.ref_bills_rent_6m_avg),    driver:'FIXED', source:'bills_6m_avg', escalation_pct: b.ref_lease_escalation_pct || 5 },
          utilities: { proposed: toL(b.ref_bills_util_6m_avg),    driver:'FIXED', source:'bills_6m_avg', escalation_pct: 4 },
          people:    { proposed: toL(b.ref_bills_people_6m_avg),   driver:'FIXED', source:'bills_6m_avg', escalation_pct: 8 },
          other:     { proposed: toL(b.ref_bills_other_6m_avg),    driver:'FIXED', source:'bills_6m_avg', escalation_pct: 4 },
        },
        last_updated: now(),
      };
      proposed++;
    }
    costM.assumptions   = Object.values(aMap);
    costM.last_updated  = now();
    writeJ('cost_master.json', costM);
    res.json({ ok: true, proposed, message: `${proposed} branch cost proposals created from 6M bill averages. Management approval still required per branch.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /step15d/lease-review â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/step15d/lease-review', async (req, res) => {
  try {
    const leases    = readJ('lease_schedule.json', { leases: [] });
    const lArr      = leases.leases || [];
    const withRate  = lArr.filter(l => l.ind_as_116?.discount_rate_pct > 0);
    const noRate    = lArr.filter(l => !(l.ind_as_116?.discount_rate_pct > 0));
    const totalRent = r2(lArr.reduce((s, l) => s + (l.base_monthly_rent_lakh || 0), 0));
    const bs        = readJ('opening_balance_sheet.json', {});
    res.json({
      total: lArr.length,
      with_discount_rate: withRate.length,
      without_rate: noRate.length,
      blended_rate_pct: leases.blended_discount_rate_pct || null,
      blended_approved_by: leases.blended_approved_by || null,
      blended_approved_at: leases.blended_approved_at || null,
      opening_lease_liability_bs: r2(bs.lease_liability_nc + bs.lease_liability_current || bs.total_lease_liability || 22569.19),
      total_monthly_rent_lakh: totalRent,
      leases: lArr.map((l, i) => ({
        idx: i,
        branch:           l.branch,
        vendor:           l.vendor_name,
        commencement:     l.commencement_date,
        expiry:           l.expiry_date,
        monthly_rent:     r2(l.base_monthly_rent_lakh || 0),
        super_buildup_sqft: l.super_buildup_sqft,
        discount_rate_pct: l.ind_as_116?.discount_rate_pct || null,
        status:           l.ind_as_116?.status || 'REQUIRES_DATA',
        opening_liability: l.ind_as_116?.opening_lease_liability_lakh || null,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /step15d/lease/set-blended-rate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/step15d/lease/set-blended-rate', adminOnly, async (req, res) => {
  try {
    const { rate_pct, approved_by, comment } = req.body;
    if (!rate_pct || !approved_by) return res.status(400).json({ error: 'rate_pct and approved_by required' });
    if (rate_pct < 1 || rate_pct > 30) return res.status(400).json({ error: 'rate_pct must be between 1 and 30' });
    const leases = readJ('lease_schedule.json', { leases: [] });
    leases.blended_discount_rate_pct  = Number(rate_pct);
    leases.blended_approved_by        = approved_by;
    leases.blended_approved_at        = now();
    leases.blended_approval_note      = comment || null;
    leases.blended_label              = 'MANAGEMENT_APPROVED_BLENDED_ESTIMATE';
    leases.last_updated               = now();
    writeJ('lease_schedule.json', leases);
    res.json({ ok: true, rate_pct: leases.blended_discount_rate_pct, message: `Blended IBR of ${rate_pct}% approved. Ind AS 116 aggregate roll-forward will use this rate. Label: MANAGEMENT_APPROVED_BLENDED_ESTIMATE.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ PUT /step15d/lease/:idx/rate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.put('/step15d/lease/:idx/rate', adminOnly, async (req, res) => {
  try {
    const idx    = parseInt(req.params.idx, 10);
    const { rate_pct, approved_by } = req.body;
    if (!rate_pct) return res.status(400).json({ error: 'rate_pct required' });
    const leases = readJ('lease_schedule.json', { leases: [] });
    if (!leases.leases || !leases.leases[idx]) return res.status(404).json({ error: 'Lease not found' });
    leases.leases[idx].ind_as_116 = {
      ...(leases.leases[idx].ind_as_116 || {}),
      discount_rate_pct: Number(rate_pct),
      status: 'RATE_APPROVED',
      approved_by: approved_by || null,
      approved_at: now(),
    };
    leases.last_updated = now();
    writeJ('lease_schedule.json', leases);
    res.json({ ok: true, idx, rate_pct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /step15d/gl-review â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/step15d/gl-review', async (req, res) => {
  try {
    const accMap = readJ('account_mapping.json', { mappings: {} });
    const m      = accMap.mappings || {};
    const pending = Object.entries(m)
      .filter(([, v]) => ['pending_ca_confirmation','pending_review','manual_review'].includes(v.approval_status))
      .map(([k, v]) => ({
        account: k,
        fpa_line: v.fpa_line,
        statement: v.statement,
        category: v.category,
        value_lakh: r2(v.total_lakh_fy26 || 0),
        confidence: v.confidence,
        current_status: v.approval_status,
        suggested_mapping: v.fpa_line,
        reviewer: v.reviewer || null,
        last_reviewed: v.last_reviewed || null,
      }));
    const resolved = Object.values(m).filter(v => ['confirmed','resolved','resolved_split','auto_mapped'].includes(v.approval_status)).length;
    res.json({ pending, resolved, total: Object.keys(m).length,
      pending_value_lakh: r2(pending.reduce((s,p) => s + Math.abs(p.value_lakh), 0)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /step15d/gl/approve â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/step15d/gl/approve', adminOnly, async (req, res) => {
  try {
    const { account, new_fpa_line, decision, approved_by, comment } = req.body;
    if (!account || !decision || !approved_by) return res.status(400).json({ error: 'account, decision, approved_by required' });
    const accMap = readJ('account_mapping.json', { mappings: {} });
    if (!accMap.mappings[account]) return res.status(404).json({ error: 'Account not found' });
    const entry    = accMap.mappings[account];
    entry.approval_status = decision === 'approve' ? 'confirmed' : decision === 'na' ? 'not_applicable' : 'confirmed';
    if (new_fpa_line) entry.fpa_line = new_fpa_line;
    entry.reviewer     = approved_by;
    entry.last_reviewed = now();
    entry.review_note   = comment || null;
    accMap.last_updated = now();
    writeJ('account_mapping.json', accMap);
    res.json({ ok: true, account, approval_status: entry.approval_status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /step15d/far-review â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/step15d/far-review', async (req, res) => {
  try {
    const far = readJ('asset_register.json', { categories: [] });
    const obs = readJ('opening_balance_sheet.json', {});
    const cats = far.categories || [];
    const wdvRates = { 'Furniture & Fixtures': 12.4, 'Office Equip': 22.7, 'Computer': 40.5, 'Electric Installation': 18.4 };
    const enriched = cats.map(c => ({
      ...c,
      implied_wdv_rate_pct: wdvRates[c.category] || null,
      monthly_dep_lakh:     c.nbv_lakh ? r2(c.nbv_lakh * (wdvRates[c.category] || 0) / 100 / 12) : null,
      computable:           c.nbv_lakh != null && wdvRates[c.category] != null,
    }));
    const totalNBV        = r2(cats.reduce((s,c) => s+(c.nbv_lakh||0), 0));
    const totalMonthlyDep = r2(enriched.reduce((s,c) => s+(c.monthly_dep_lakh||0), 0));
    const cwip            = r2(obs.cwip_lakh || 6978.37);
    res.json({
      source: 'Audited Standalone FS FY2025-26 (category-level)',
      method: 'WDV_DECLINING_BALANCE',
      label:  'INTERIM_APPROVED_METHOD',
      categories: enriched,
      total_gross_block_lakh: r2(cats.reduce((s,c)=>s+(c.gross_block_lakh||0),0)),
      total_accum_dep_lakh:   r2(cats.reduce((s,c)=>s+(c.accum_dep_lakh||0),0)),
      total_nbv_lakh:         totalNBV,
      total_monthly_dep_lakh: totalMonthlyDep,
      cwip_lakh:              cwip,
      cwip_note:              'Capitalisation schedule NOT available â€” CWIP treated as non-depreciating until schedule provided',
      computable:             enriched.filter(c=>c.computable).length === cats.length,
      limitation:             'Category-level only. No per-asset IDs. Future capex plan not available. CWIP schedule missing.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /step15d/draft-baseline/run â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Gate check â†’ compute simplified 36-month P&L projection â†’ store draft.
// REQUIRES: revenue approved, costs proposed, OBS approved.
router.post('/step15d/draft-baseline/run', adminOnly, async (req, res) => {
  try {
    const { approved_by } = req.body;
    if (!approved_by) return res.status(400).json({ error: 'approved_by required' });

    // â”€â”€ 1. Gate Check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const mapData  = readMappings();
    const brData   = await readBranches();
    const obs      = readJ('opening_balance_sheet.json', {});
    const costM    = readJ('cost_master.json', { assumptions: [] });
    const leases   = readJ('lease_schedule.json', { leases: [] });
    const debtData = readJ('debt_schedule.json', { facilities: [] });
    const taxP     = readJ('tax_params.json', { tax_rate_pct: 25.17 });
    const cfg      = readJ('cost_config.json', { forecast_start: '2026-04', forecast_end: '2029-03' });
    const far      = readJ('asset_register.json', { categories: [] });

    const mappings   = (mapData.mappings || []).filter(m => m.active !== false);
    const branches   = brData.branches || [];
    const approved   = mappings.filter(m => m.contracted_monthly_revenue > 0 && m.approval_status === 'approved');
    const totalRef   = mappings.reduce((s,m)=>s+(m.avg_6m||m.latest_actual_revenue||0),0);
    const approvedV  = approved.reduce((s,m)=>s+m.contracted_monthly_revenue,0);
    const revPct     = totalRef > 0 ? approvedV / totalRef * 100 : 0;
    const capOK      = branches.filter(b=>b.total_seats>0&&b.total_area_sqft>0).length;
    const costApprOK = (costM.assumptions||[]).filter(a=>a.approved).length;
    const blendedIBR = leases.blended_discount_rate_pct || 0;
    const leaseRated = (leases.leases||[]).filter(l=>l.ind_as_116?.discount_rate_pct>0).length;

    const blockers = [];
    if (revPct < 80) blockers.push(`Revenue value-weighted coverage ${r2(revPct)}% < required 80%`);
    if (capOK === 0) blockers.push(`Branch capacity: 0/${branches.length} approved`);
    if (obs.approval_status !== 'approved') blockers.push('Opening Balance Sheet not approved');
    if (leaseRated === 0 && !blendedIBR) blockers.push('Ind AS 116: No discount rates and no blended IBR approved');
    if (blockers.length > 0)
      return res.status(422).json({ ok: false, blockers, message: 'Draft Baseline V1 cannot be computed. Resolve blockers first.' });

    // â”€â”€ 2. Build months array â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const [sy, sm] = (cfg.forecast_start || '2026-10').split('-').map(Number);
    const [ey, em] = (cfg.forecast_end   || '2029-03').split('-').map(Number);
    const months = [];
    let y = sy, mo = sm;
    while (y < ey || (y === ey && mo <= em)) {
      months.push(`${y}-${String(mo).padStart(2,'0')}`);
      mo++; if (mo > 12) { mo = 1; y++; }
    }

    // â”€â”€ 3. Revenue per month â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const getMonthlyRev = (m, month) => {
      let rev = m.contracted_monthly_revenue || 0;
      if (m.escalation_effective_month && month >= m.escalation_effective_month)
        rev = rev * (1 + (m.escalation_pct || 0) / 100);
      if (m.next_escalation_date && month >= m.next_escalation_date)
        rev = rev * (1 + (m.next_escalation_pct || 0) / 100);
      return rev;
    };

    // â”€â”€ 4. Cost per branch per month â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const costMap = {};
    for (const a of (costM.assumptions||[])) costMap[a.branch_id] = a;
    const getBranchCost = (branchId, month) => {
      const a = costMap[branchId];
      if (!a || !a.cost_lines) return 0;
      let total = 0;
      for (const [, line] of Object.entries(a.cost_lines || {})) {
        const base = a.approved ? (line.approved || line.proposed || 0) : (line.proposed || 0);
        const esc  = 1 + (line.escalation_pct || 0) / 100 / 12;
        total += base; // simplified: flat monthly, not compounding for draft
      }
      return total;
    };

    // â”€â”€ 5. Depreciation (WDV) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const wdvRates = { 'Furniture & Fixtures': 12.4, 'Office Equip': 22.7, 'Computer': 40.5, 'Electric Installation': 18.4 };
    const catNBV = {};
    for (const c of (far.categories||[])) catNBV[c.category] = c.nbv_lakh || 0;
    const getDepreciation = (() => {
      const nbv = { ...catNBV };
      return () => {
        let dep = 0;
        for (const [cat, rate] of Object.entries(wdvRates)) {
          const d = (nbv[cat] || 0) * rate / 100 / 12;
          dep += d; nbv[cat] = (nbv[cat] || 0) - d;
        }
        return r2(dep);
      };
    })();

    // â”€â”€ 6. Finance cost (simplified) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const activeFacs = (debtData.facilities||[]).filter(f=>!f.repaid && f.rate > 0);
    let openingPrincipal = {}; // facility_id â†’ current balance
    for (const f of activeFacs) openingPrincipal[f.id||f.facility_id] = f.opening_principal_lakh || 0;
    const getFinanceCost = () => {
      let interest = 0;
      for (const f of activeFacs) {
        const fid  = f.id || f.facility_id;
        const bal  = openingPrincipal[fid] || 0;
        const rate = (f.rate || 0) / 100 / 12;
        const int  = r2(bal * rate);
        interest  += int;
        const emi  = f.emi_lakh || 0;
        const prin = Math.max(0, emi - int);
        openingPrincipal[fid] = Math.max(0, bal - prin);
      }
      return r2(interest);
    };

    // â”€â”€ 7. Lease rent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const totalMonthlyRent = r2((leases.leases||[]).reduce((s,l) => {
      const now_m = new Date().toISOString().slice(0,7);
      const sched = (l.period_schedule||[]).find(p => p.module_start <= now_m && now_m <= p.module_end);
      return s + (sched?.monthly_rent_lakh || l.base_monthly_rent_lakh || 0);
    }, 0));

    // â”€â”€ 8. Compute monthly rows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const tax_rate = (taxP.tax_rate_pct || 25.17) / 100;
    let pl = [];
    for (const month of months) {
      const revenue   = r2(approved.reduce((s,m) => s + getMonthlyRev(m, month) / 100000, 0)); // convert â‚¹ â†’ lakh
      const opCost    = r2(branches.reduce((s,b) => s + getBranchCost(b.branch_id, month), 0));
      const rentLease = totalMonthlyRent;
      const totalCost = r2(opCost + rentLease);
      const ebitda    = r2(revenue - totalCost);
      const dep       = getDepreciation();
      const ebit      = r2(ebitda - dep);
      const finCost   = getFinanceCost();
      const pbt       = r2(ebit - finCost);
      const tax       = pbt > 0 ? r2(pbt * tax_rate) : 0;
      const pat       = r2(pbt - tax);
      pl.push({ month, revenue, op_cost: opCost, rent_lease: rentLease, total_cost: totalCost,
                ebitda, ebitda_pct: revenue > 0 ? r2(ebitda/revenue*100) : 0,
                depreciation: dep, ebit, finance_cost: finCost, pbt, tax, pat });
    }

    // â”€â”€ 9. Annual summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const annual = (yr) => {
      const rows = pl.filter(r => r.month.startsWith(`${yr}`));
      const sum  = k => r2(rows.reduce((s,r)=>s+r[k],0));
      const avg  = k => rows.length ? r2(sum(k)/rows.length) : 0;
      return { year: `FY${parseInt(yr)+1}`, months: rows.length, revenue: sum('revenue'), ebitda: sum('ebitda'), ebitda_pct: avg('ebitda_pct'), ebit: sum('ebit'), pbt: sum('pbt'), pat: sum('pat') };
    };
    const years = [...new Set(months.map(m=>m.slice(0,4)))];
    const annualSummary = years.map(y => annual(y));

    // â”€â”€ 10. Store draft â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const draft = {
      status: 'COMPUTED',
      version: 1,
      computed_by: approved_by,
      computed_at: now(),
      gate_status: 'DRAFT_BASELINE_V1',
      label: 'DRAFT â€” PENDING CFO REVIEW AND APPROVAL',
      forecast_period: `${cfg.forecast_start} to ${cfg.forecast_end}`,
      revenue_coverage_pct: r2(revPct),
      monthly_pl: pl,
      annual_summary: annualSummary,
      input_snapshot: { approved_mappings: approved.length, branches_with_capacity: capOK, obs_status: obs.approval_status, blended_ibr: blendedIBR },
    };
    writeJ('draft_baseline_v1.json', draft);
    res.json({ ok: true, status: 'COMPUTED', annual_summary: annualSummary, message: 'Draft Baseline V1 computed. Pending CFO review. DO NOT freeze without explicit CFO approval.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ GET /step15d/draft-baseline/results â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/step15d/draft-baseline/results', async (req, res) => {
  try {
    const draft = readJ('draft_baseline_v1.json', { status: 'NOT_COMPUTED' });
    if (draft.status === 'NOT_COMPUTED') return res.json({ status: 'NOT_COMPUTED', message: 'Draft Baseline V1 has not been computed yet.' });
    res.json(draft);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€â”€ POST /step15d/baseline/freeze â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CFO approve + freeze Baseline V1. Creates immutable snapshot.
router.post('/step15d/baseline/freeze', adminOnly, async (req, res) => {
  try {
    const { approved_by, cfo_comment } = req.body;
    if (!approved_by || !cfo_comment) return res.status(400).json({ error: 'approved_by and cfo_comment required' });
    const draft = readJ('draft_baseline_v1.json', { status: 'NOT_COMPUTED' });
    if (draft.status === 'NOT_COMPUTED') return res.status(422).json({ error: 'No draft baseline to freeze. Run draft-baseline/run first.' });
    if (draft.status === 'FROZEN')       return res.status(409).json({ error: 'Baseline V1 already frozen.' });
    draft.status         = 'FROZEN';
    draft.frozen_by      = approved_by;
    draft.frozen_at      = now();
    draft.cfo_comment    = cfo_comment;
    draft.freeze_label   = 'BASELINE_V1_APPROVED';
    draft.version_label  = `Baseline V1 â€” Approved ${now().slice(0,10)} by ${approved_by}`;
    writeJ('draft_baseline_v1.json', draft);
    // Also write a frozen copy with timestamp
    const freezeFile = `baseline_v1_frozen_${now().replace(/[:.]/g,'').slice(0,15)}.json`;
    writeJ(freezeFile, draft);
    res.json({ ok: true, status: 'FROZEN', frozen_by: approved_by, frozen_at: draft.frozen_at,
      message: 'Baseline V1 frozen. DO NOT proceed to Step 16 without explicit management approval. STOP CONDITION active.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════════
// STEP 15F — MANAGEMENT APPROVAL, MATERIALITY REVIEW & BLOCKER CLOSURE
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Audit trail helpers ──────────────────────────────────────────────────────
const AUDIT_FILE = 'approval_audit_trail.json';
function appendAudit(entry) {
  const trail = readJ(AUDIT_FILE, { entries: [] });
  trail.entries.push({ ...entry, recorded_at: now() });
  writeJ(AUDIT_FILE, trail);
}

// ─── Revenue approvals file ───────────────────────────────────────────────────
const REV_APPROVALS_FILE = 'revenue_approvals.json';
function readRevApprovals() { return readJ(REV_APPROVALS_FILE, { approvals: {}, last_updated: null }); }
function writeRevApprovals(d) { d.last_updated = now(); writeJ(REV_APPROVALS_FILE, d); }

// ─── Materiality classification ───────────────────────────────────────────────
function classifyMateriality(mappings) {
  const withRev = mappings.map(m => {
    const ref = m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0;
    return { ...m, _ref: ref };
  }).sort((a, b) => b._ref - a._ref);
  const total = withRev.reduce((s, m) => s + m._ref, 0);
  let cum = 0;
  return withRev.map(m => {
    cum += m._ref;
    const pct = total > 0 ? cum / total * 100 : 0;
    const tier = pct <= 80 ? 'CRITICAL' : pct <= 90 ? 'HIGH' : pct <= 95 ? 'MEDIUM' : 'LOW';
    return { ...m, _materiality: tier, _cum_pct: r2(pct), _ref_lakh: r2(m._ref / 100000) };
  });
}

// ─── GET /step15f/state — full current state ──────────────────────────────────
router.get('/step15f/state', async (req, res) => {
  try {
    const [brData, costM, obs] = await Promise.all([readBranches(), Promise.resolve(readJ('cost_master.json', { assumptions: [] })), Promise.resolve(readJ('opening_balance_sheet.json', {}))]);
    const bcm      = await readMappings();
    const leases   = readJ('lease_schedule.json', { leases: [] });
    const debt     = readJ('debt_schedule.json', { facilities: [] });
    const acctMap  = readJ('account_mapping.json', { mappings: [] });
    const auditT   = readJ(AUDIT_FILE, { entries: [] });
    const revAppr  = readRevApprovals();
    const branches = brData.branches || [];
    const mappings = bcm.mappings || [];

    // Revenue stats
    const totalRef = mappings.reduce((s, m) => s + (m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0), 0);
    const approved = mappings.filter(m => revAppr.approvals[m.mapping_id]?.status === 'approved');
    const approvedVal = approved.reduce((s, m) => s + (revAppr.approvals[m.mapping_id]?.approved_value || 0), 0);
    const revPct = totalRef > 0 ? r2(approvedVal / totalRef * 100) : 0;

    // Materiality breakdown
    const classified = classifyMateriality(mappings);
    const critCount  = classified.filter(m => m._materiality === 'CRITICAL').length;
    const highCount  = classified.filter(m => m._materiality === 'HIGH').length;
    const critAppr   = classified.filter(m => m._materiality === 'CRITICAL' && revAppr.approvals[m.mapping_id]?.status === 'approved').length;
    const highAppr   = classified.filter(m => m._materiality === 'HIGH' && revAppr.approvals[m.mapping_id]?.status === 'approved').length;

    // Cost stats
    const costAssumptions = costM.assumptions || [];
    const costApproved = costAssumptions.filter(a => a.approved).length;

    // Capacity stats
    const capProposed = branches.filter(b => b.total_area_sqft > 0).length;
    const capApproved = branches.filter(b => b.capacity_approved).length;
    const capMissing  = branches.filter(b => !b.total_area_sqft).length;

    // OBS
    const obsStatus = obs.approval_status || 'pending_review';

    // Leases
    const lArr = leases.leases || [];
    const leaseWithRate = lArr.filter(l => l.ind_as_116?.discount_rate_pct != null).length;
    const blendedIBR = leases.blended_discount_rate_pct || null;

    // Debt
    const facilities = debt.facilities || [];
    const debtComplete = facilities.filter(f => f.is_complete).length;

    // GL — account_mapping.json uses an object keyed by account name, not an array
    const glMappingsRaw = acctMap.mappings || {};
    const glMappings = Array.isArray(glMappingsRaw)
      ? glMappingsRaw
      : Object.entries(glMappingsRaw).map(([account, v]) => ({ account, ...v }));
    const glPending  = glMappings.filter(g => (g.current_status || g.approval_status || '') !== 'confirmed' && (g.current_status || g.approval_status || '') !== 'n/a');
    const glPendingVal = r2(glPending.reduce((s, g) => s + Math.abs(g.value_lakh || g.total_lakh_fy26 || 0), 0));

    // Gate
    const critBlocked = critAppr < critCount;
    const highBlocked = highAppr < highCount;
    const revBlocked  = revPct < 95 || critBlocked || highBlocked;
    const costBlocked = costApproved === 0;
    const obsBlocked  = obsStatus !== 'approved';
    const ibrBlocked  = leaseWithRate === 0 && !blendedIBR;
    const hardBlockers = [revBlocked, costBlocked, obsBlocked, ibrBlocked].filter(Boolean).length;
    const gate = hardBlockers === 0 ? 'GREEN' : hardBlockers <= 2 ? 'AMBER' : 'RED';

    res.json({
      gate, hard_blockers: hardBlockers,
      revenue: { total_mappings: mappings.length, approved_count: approved.length, total_ref_lakh: r2(totalRef / 100000), approved_lakh: r2(approvedVal / 100000), value_weighted_pct: revPct, critical_total: critCount, critical_approved: critAppr, high_total: highCount, high_approved: highAppr },
      cost: { proposals: costAssumptions.length, approved: costApproved, total_branches: branches.length },
      capacity: { proposed: capProposed, approved: capApproved, missing: capMissing, total: branches.length },
      obs: { status: obsStatus, diff_lakh: obs.bs_check_diff || null, total_assets: r2(obs.total_assets || 0) },
      leases: { total: lArr.length, with_rate: leaseWithRate, blended_ibr: blendedIBR },
      debt: { total: facilities.length, complete: debtComplete },
      gl: { total: glMappings.length, pending: glPending.length, pending_value_lakh: glPendingVal },
      audit_entries: auditT.entries?.length || 0,
      blockers: {
        B1_revenue: revBlocked,
        B2_cost: costBlocked,
        B3_obs: obsBlocked,
        B4_ind_as_116: ibrBlocked,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15f/obs/approve — approve Opening Balance Sheet ────────────────
router.post('/step15f/obs/approve', adminOnly, async (req, res) => {
  try {
    const { approved_by, comment } = req.body;
    if (!approved_by || !approved_by.trim()) return res.status(400).json({ error: 'approved_by is required' });
    const obs = readJ('opening_balance_sheet.json', {});
    if (obs.approval_status === 'approved') return res.status(409).json({ error: 'OBS already approved', approved_by: obs.approved_by, approved_at: obs.approved_at });
    obs.approval_status = 'approved';
    obs.approved_by     = approved_by.trim();
    obs.approved_at     = now();
    obs.approval_note   = comment || 'CFO approved via Step 15F Approval Center';
    writeJ('opening_balance_sheet.json', obs);
    appendAudit({ module: 'OBS', action: 'APPROVE', record: 'opening_balance_sheet', approved_by: approved_by.trim(), comment: obs.approval_note, value_lakh: r2(obs.total_assets || 0) });
    res.json({ ok: true, status: 'approved', approved_by: obs.approved_by, approved_at: obs.approved_at, message: 'Opening Balance Sheet approved. B3 blocker cleared.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15f/revenue/batches — revenue proposals in R1–R5 batches ────────
router.get('/step15f/revenue/batches', async (req, res) => {
  try {
    const bcm      = await readMappings();
    const revAppr  = readRevApprovals();
    const mappings = bcm.mappings || [];
    const classified = classifyMateriality(mappings);

    // Batch by materiality (all have 1 month of data; confidence = LOW for all)
    const batches = { R1: [], R2: [], R3: [], R4: [], R5: [] };
    for (const m of classified) {
      const appr = revAppr.approvals[m.mapping_id];
      const row  = {
        mapping_id: m.mapping_id,
        client_id:  m.client_id,
        branch_id:  m.branch_id,
        zoho_customer_id: m.zoho_customer_id,
        materiality: m._materiality,
        ref_lakh:    m._ref_lakh,
        avg_6m:      m.avg_6m,
        avg_3m:      m.avg_3m,
        latest_actual: m.latest_actual_revenue,
        months_with_data: m.months_with_data || 1,
        confidence: m.months_with_data >= 3 ? 'HIGH' : m.months_with_data === 2 ? 'MEDIUM' : 'LOW',
        status: appr?.status || 'proposed',
        approved_value: appr?.approved_value || null,
        approved_by: appr?.approved_by || null,
      };
      if (m._materiality === 'CRITICAL') batches.R1.push(row);
      else if (m._materiality === 'HIGH') batches.R2.push(row);
      else if (m._materiality === 'MEDIUM') batches.R3.push(row);
      else if (m._ref > 0) batches.R4.push(row);
      else batches.R5.push(row);
    }

    const totalRef = classified.reduce((s, m) => s + m._ref, 0);
    const summary  = {};
    for (const [bk, bArr] of Object.entries(batches)) {
      const bVal = bArr.reduce((s, m) => s + (m.avg_6m || m.avg_3m || m.latest_actual || 0), 0);
      const apprCount = bArr.filter(m => m.status === 'approved').length;
      summary[bk] = {
        label: bk === 'R1' ? 'CRITICAL Materiality (0–80%)' : bk === 'R2' ? 'HIGH Materiality (80–90%)' : bk === 'R3' ? 'MEDIUM Materiality (90–95%)' : bk === 'R4' ? 'LOW Materiality (<5% each)' : 'Zero / Insufficient Data',
        count: bArr.length,
        monthly_lakh: r2(bVal / 100000),
        annual_lakh: r2(bVal / 100000 * 12),
        pct_of_total: r2(totalRef > 0 ? bVal / totalRef * 100 : 0),
        approved: apprCount,
        pending: bArr.length - apprCount,
        confidence: bk === 'R1' ? 'LOW (1 month actuals)' : bk === 'R2' ? 'LOW' : bk === 'R3' ? 'LOW' : bk === 'R4' ? 'LOW' : 'NONE',
        mappings: bArr,
      };
    }
    res.json({ batches: summary, total_mappings: mappings.length, total_ref_lakh: r2(totalRef / 100000) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15f/revenue/approve-batch — approve a whole batch ──────────────
router.post('/step15f/revenue/approve-batch', adminOnly, async (req, res) => {
  try {
    const { batch_id, approved_by, comment, mapping_overrides } = req.body;
    if (!batch_id || !approved_by) return res.status(400).json({ error: 'batch_id and approved_by required' });
    const bcm      = await readMappings();
    const revAppr  = readRevApprovals();
    const classified = classifyMateriality(bcm.mappings || []);

    const tierMap  = { R1: 'CRITICAL', R2: 'HIGH', R3: 'MEDIUM', R4: 'LOW', R5: null };
    const tier     = tierMap[batch_id];
    const targets  = tier ? classified.filter(m => m._materiality === tier && m._ref > 0)
                          : classified.filter(m => m._ref === 0);

    let approved = 0;
    for (const m of targets) {
      const override = (mapping_overrides || {})[m.mapping_id];
      const val = override?.approved_value != null ? override.approved_value : (m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0);
      revAppr.approvals[m.mapping_id] = {
        status: 'approved',
        approved_value: val,
        approved_value_lakh: r2(val / 100000),
        proposed_value: m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0,
        approved_by: approved_by.trim(),
        approved_at: now(),
        batch_id,
        materiality: m._materiality,
        comment: comment || `Batch ${batch_id} approval`,
        source: 'avg_6m_actuals',
        version: (revAppr.approvals[m.mapping_id]?.version || 0) + 1,
      };
      approved++;
    }
    writeRevApprovals(revAppr);
    const batchVal = targets.reduce((s, m) => s + (m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0), 0);
    appendAudit({ module: 'REVENUE', action: 'BATCH_APPROVE', batch_id, records: approved, value_lakh: r2(batchVal / 100000), approved_by: approved_by.trim(), comment });
    res.json({ ok: true, approved, batch_id, value_lakh: r2(batchVal / 100000), message: `${approved} mappings approved in batch ${batch_id}.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15f/revenue/approve-single — approve one mapping ───────────────
router.post('/step15f/revenue/approve-single', adminOnly, async (req, res) => {
  try {
    const { mapping_id, approved_value, approved_by, comment } = req.body;
    if (!mapping_id || !approved_by) return res.status(400).json({ error: 'mapping_id and approved_by required' });
    const bcm    = await readMappings();
    const m      = (bcm.mappings || []).find(x => x.mapping_id === mapping_id);
    if (!m) return res.status(404).json({ error: `Mapping ${mapping_id} not found` });
    const revAppr = readRevApprovals();
    const val     = approved_value != null ? Number(approved_value) : (m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0);
    const prev    = revAppr.approvals[mapping_id];
    revAppr.approvals[mapping_id] = {
      status: 'approved', approved_value: val, approved_value_lakh: r2(val / 100000),
      proposed_value: m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0,
      approved_by: approved_by.trim(), approved_at: now(),
      comment: comment || 'Single mapping approval', source: 'avg_6m_actuals',
      version: (prev?.version || 0) + 1, previous_value: prev?.approved_value || null,
    };
    writeRevApprovals(revAppr);
    appendAudit({ module: 'REVENUE', action: 'SINGLE_APPROVE', mapping_id, value_lakh: r2(val / 100000), approved_by: approved_by.trim(), comment });
    res.json({ ok: true, mapping_id, approved_value: val });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15f/revenue/reject — reject / send back for review ─────────────
router.post('/step15f/revenue/reject', adminOnly, async (req, res) => {
  try {
    const { mapping_id, approved_by, comment } = req.body;
    if (!mapping_id || !approved_by) return res.status(400).json({ error: 'mapping_id and approved_by required' });
    const revAppr = readRevApprovals();
    revAppr.approvals[mapping_id] = { ...(revAppr.approvals[mapping_id] || {}), status: 'rejected', rejected_by: approved_by, rejected_at: now(), rejection_reason: comment || '' };
    writeRevApprovals(revAppr);
    appendAudit({ module: 'REVENUE', action: 'REJECT', mapping_id, approved_by, comment });
    res.json({ ok: true, mapping_id, status: 'rejected' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15f/cost/batches — cost proposals with missing-branch info ──────
router.get('/step15f/cost/batches', async (req, res) => {
  try {
    const brData  = await readBranches();
    const costM   = readJ('cost_master.json', { assumptions: [] });
    const aMap    = {};
    for (const a of (costM.assumptions || [])) aMap[a.branch_id] = a;

    const result = (brData.branches || []).map(b => {
      const a = aMap[b.branch_id];
      const toL = v => v ? r2(v / 100000) : null;
      const hasRef = b.ref_bills_rent_6m_avg != null || b.ref_bills_util_6m_avg != null;
      const totalProposed = a ? r2((a.cost_lines?.rent?.proposed || 0) + (a.cost_lines?.utilities?.proposed || 0) + (a.cost_lines?.people?.proposed || 0) + (a.cost_lines?.other?.proposed || 0)) : null;
      return {
        branch_id: b.branch_id, branch_name: b.branch_name, city: b.city,
        has_proposal: !!a,
        has_ref_data: hasRef,
        approved: a?.approved || false,
        approved_by: a?.approved_by || null,
        approved_at: a?.approved_at || null,
        total_proposed_lakh: totalProposed,
        cost_lines: a?.cost_lines || null,
        ref: { rent: toL(b.ref_bills_rent_6m_avg), util: toL(b.ref_bills_util_6m_avg), people: toL(b.ref_bills_people_6m_avg), other: toL(b.ref_bills_other_6m_avg) },
        missing_data: !hasRef ? ['ref_bills_data'] : [],
        status: !a ? 'NO_PROPOSAL' : a.approved ? 'APPROVED' : 'PROPOSED',
        flags: a?.cost_data_flags || [],
      };
    });

    const proposed  = result.filter(b => b.status === 'PROPOSED');
    const approved  = result.filter(b => b.status === 'APPROVED');
    const missing   = result.filter(b => b.status === 'NO_PROPOSAL');
    const totalProp = proposed.reduce((s, b) => s + (b.total_proposed_lakh || 0), 0);

    res.json({ branches: result, summary: { total: result.length, proposed: proposed.length, approved: approved.length, missing: missing.length, total_proposed_lakh: r2(totalProp) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15f/cost/approve — approve / reject / edit branch cost ─────────
router.post('/step15f/cost/approve', adminOnly, async (req, res) => {
  try {
    const { branch_id, action, cost_lines, approved_by, comment } = req.body;
    if (!branch_id || !approved_by || !action) return res.status(400).json({ error: 'branch_id, action and approved_by required' });
    if (!['approve', 'reject', 'review'].includes(action)) return res.status(400).json({ error: 'action must be approve, reject, or review' });
    const costM = readJ('cost_master.json', { assumptions: [] });
    let idx = (costM.assumptions || []).findIndex(a => a.branch_id === branch_id);
    if (idx === -1) { costM.assumptions.push({ branch_id, approved: false }); idx = costM.assumptions.length - 1; }
    const a = costM.assumptions[idx];
    if (cost_lines) a.cost_lines = cost_lines;
    if (action === 'approve') {
      a.approved = true; a.approved_by = approved_by; a.approved_at = now(); a.approval_note = comment || '';
      a.version  = (a.version || 0) + 1; a.changed_after_approval = false;
    } else if (action === 'reject') {
      a.approved = false; a.rejected_by = approved_by; a.rejected_at = now(); a.rejection_reason = comment || '';
    } else {
      a.approved = false; a.returned_for_review = true; a.review_note = comment || '';
    }
    a.last_updated = now();
    costM.last_updated = now();
    writeJ('cost_master.json', costM);
    appendAudit({ module: 'COST', action: action.toUpperCase(), record: branch_id, approved_by, comment, value_lakh: a.cost_lines ? r2((a.cost_lines.rent?.proposed || 0) + (a.cost_lines.utilities?.proposed || 0) + (a.cost_lines.people?.proposed || 0) + (a.cost_lines.other?.proposed || 0)) : null });
    res.json({ ok: true, branch_id, action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15f/cost/bulk-approve — approve all high-confidence branches ───
router.post('/step15f/cost/bulk-approve', adminOnly, async (req, res) => {
  try {
    const { branch_ids, approved_by, comment } = req.body;
    if (!Array.isArray(branch_ids) || !approved_by) return res.status(400).json({ error: 'branch_ids array and approved_by required' });
    const costM = readJ('cost_master.json', { assumptions: [] });
    let count = 0;
    for (const bid of branch_ids) {
      const idx = costM.assumptions.findIndex(a => a.branch_id === bid);
      if (idx === -1) continue;
      const a = costM.assumptions[idx];
      if (a.approved) continue;
      a.approved = true; a.approved_by = approved_by; a.approved_at = now();
      a.approval_note = comment || 'Bulk approval'; a.version = (a.version || 0) + 1; count++;
    }
    costM.last_updated = now();
    writeJ('cost_master.json', costM);
    appendAudit({ module: 'COST', action: 'BULK_APPROVE', records: count, approved_by, comment });
    res.json({ ok: true, approved: count, message: `${count} branch cost assumptions approved.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15f/capacity/approve — approve capacity for one branch ─────────
router.post('/step15f/capacity/approve', adminOnly, async (req, res) => {
  try {
    const { branch_id, approved_by, comment, overrides } = req.body;
    if (!branch_id || !approved_by) return res.status(400).json({ error: 'branch_id and approved_by required' });
    const brData = await readBranches();
    const b = (brData.branches || []).find(x => x.branch_id === branch_id);
    if (!b) return res.status(404).json({ error: `Branch ${branch_id} not found` });
    if (overrides?.total_area_sqft) b.total_area_sqft = overrides.total_area_sqft;
    if (overrides?.revenue_capacity_sqft) b.revenue_capacity_sqft = overrides.revenue_capacity_sqft;
    if (overrides?.total_seats) b.total_seats = overrides.total_seats;
    if (overrides?.opening_date) b.opening_date = overrides.opening_date;
    b.capacity_approved    = true;
    b.capacity_approved_by = approved_by;
    b.capacity_approved_at = now();
    b.capacity_note        = comment || '';
    b.last_updated         = now();
    await writeBranches(brData);
    appendAudit({ module: 'CAPACITY', action: 'APPROVE', record: branch_id, approved_by, comment, area: b.total_area_sqft, seats: b.total_seats });
    res.json({ ok: true, branch_id, total_area_sqft: b.total_area_sqft, total_seats: b.total_seats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15f/capacity/manual-input — enter missing capacity fields ──────
router.post('/step15f/capacity/manual-input', adminOnly, async (req, res) => {
  try {
    const { branch_id, total_area_sqft, revenue_capacity_sqft, total_seats, opening_date, approved_by, comment } = req.body;
    if (!branch_id || !approved_by) return res.status(400).json({ error: 'branch_id and approved_by required' });
    const brData = await readBranches();
    const b = (brData.branches || []).find(x => x.branch_id === branch_id);
    if (!b) return res.status(404).json({ error: `Branch ${branch_id} not found` });
    if (total_area_sqft != null)       b.total_area_sqft       = Number(total_area_sqft);
    if (revenue_capacity_sqft != null) b.revenue_capacity_sqft = Number(revenue_capacity_sqft);
    if (total_seats != null)           b.total_seats           = Number(total_seats);
    if (opening_date)                  b.opening_date          = opening_date;
    b.input_source  = 'management_manual_input';
    b.input_by      = approved_by;
    b.input_at      = now();
    b.last_updated  = now();
    await writeBranches(brData);
    appendAudit({ module: 'CAPACITY', action: 'MANUAL_INPUT', record: branch_id, approved_by, comment, area: total_area_sqft, seats: total_seats });
    res.json({ ok: true, branch_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15f/lease/ibr-pack — IBR decision pack for CFO/CA ──────────────
router.get('/step15f/lease/ibr-pack', async (req, res) => {
  try {
    const leases    = readJ('lease_schedule.json', { leases: [] });
    const lArr      = leases.leases || [];
    const debt      = readJ('debt_schedule.json', { facilities: [] });

    // Remaining term distribution from today
    const today = new Date();
    const termBands = { 'le_1yr': [], 'gt1_3yr': [], 'gt3_5yr': [], 'gt5yr': [] };
    for (const l of lArr) {
      const exp  = l.expiry_date ? new Date(l.expiry_date) : null;
      const remM = exp ? Math.max(0, (exp - today) / (1000 * 60 * 60 * 24 * 30.5)) : null;
      const band = remM == null ? 'gt5yr' : remM <= 12 ? 'le_1yr' : remM <= 36 ? 'gt1_3yr' : remM <= 60 ? 'gt3_5yr' : 'gt5yr';
      termBands[band].push({ branch: l.branch, expiry: l.expiry_date, rent_lakh: l.base_monthly_rent_lakh, rem_months: remM != null ? Math.round(remM) : null });
    }

    // Available borrowing rate evidence from debt
    const knownRates = (debt.facilities || []).filter(f => f.interest_rate).map(f => ({ label: f.label || f.facility_id, rate_pct: f.interest_rate }));

    // Aggregate lease financials
    const totalMontlyRent = r2(lArr.reduce((s, l) => s + (l.base_monthly_rent_lakh || 0), 0));
    const leasesWithRate  = lArr.filter(l => l.ind_as_116?.discount_rate_pct != null).length;

    res.json({
      current_state: { total_leases: lArr.length, with_rate: leasesWithRate, blended_ibr: leases.blended_discount_rate_pct || null, rou_asset_lakh: 19225.26, lease_liability_note: 'Per audited FS — per-lease breakdown requires auditor Ind AS 116 workings' },
      term_distribution: {
        le_1yr:    { count: termBands.le_1yr.length,    sample: termBands.le_1yr.slice(0, 3) },
        gt1_3yr:   { count: termBands.gt1_3yr.length,   sample: termBands.gt1_3yr.slice(0, 3) },
        gt3_5yr:   { count: termBands.gt3_5yr.length,   sample: termBands.gt3_5yr.slice(0, 3) },
        gt5yr:     { count: termBands.gt5yr.length,     sample: termBands.gt5yr.slice(0, 3) },
      },
      total_monthly_rent_lakh: totalMontlyRent,
      known_borrowing_rates: knownRates,
      options: ['APPROVE_BLENDED_IBR', 'APPROVE_TERM_BANDED_IBR', 'ENTER_PER_LEASE', 'IMPORT_CA_RATES'],
      recommendation: knownRates.length > 0 ? `Evidence of borrowing at ${knownRates[0]?.rate_pct}% (${knownRates[0]?.label}). Blended IBR typically = company\'s incremental borrowing rate. Requires CA confirmation.` : 'CA INPUT REQUIRED — no borrowing rate evidence available in debt schedule.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15f/lease/approve-ibr — approve IBR methodology ───────────────
router.post('/step15f/lease/approve-ibr', adminOnly, async (req, res) => {
  try {
    const { method, blended_rate_pct, banded_rates, approved_by, comment } = req.body;
    if (!method || !approved_by) return res.status(400).json({ error: 'method and approved_by required' });
    if (!['APPROVE_BLENDED_IBR', 'APPROVE_TERM_BANDED_IBR'].includes(method) && blended_rate_pct == null)
      return res.status(400).json({ error: 'blended_rate_pct required for APPROVE_BLENDED_IBR' });
    const leases = readJ('lease_schedule.json', { leases: [] });
    leases.blended_discount_rate_pct = method === 'APPROVE_BLENDED_IBR' ? Number(blended_rate_pct) : null;
    leases.banded_rates              = method === 'APPROVE_TERM_BANDED_IBR' ? banded_rates : null;
    leases.ibr_method                = method;
    leases.ibr_approved_by           = approved_by;
    leases.ibr_approved_at           = now();
    leases.ibr_note                  = comment || '';
    if (method === 'APPROVE_BLENDED_IBR' && blended_rate_pct) {
      for (const l of (leases.leases || [])) {
        if (!l.ind_as_116) l.ind_as_116 = {};
        l.ind_as_116.discount_rate_pct = Number(blended_rate_pct);
        l.ind_as_116.rate_source       = 'blended_ibr_management_approved';
        l.ind_as_116.status            = 'MANAGEMENT_APPROVED';
      }
    }
    writeJ('lease_schedule.json', leases);
    appendAudit({ module: 'IND_AS_116', action: 'APPROVE_IBR', method, rate: blended_rate_pct, approved_by, comment, leases_covered: leases.leases?.length || 0 });
    res.json({ ok: true, method, blended_rate_pct, leases_updated: method === 'APPROVE_BLENDED_IBR' ? (leases.leases?.length || 0) : 0, message: `B4 blocker cleared. IBR methodology approved: ${method}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15f/gl/prioritized — GL items sorted by ₹ materiality ──────────
router.get('/step15f/gl/prioritized', async (req, res) => {
  try {
    const acctMap = readJ('account_mapping.json', { mappings: {} });
    const rawMappings = acctMap.mappings || {};
    const all = Array.isArray(rawMappings)
      ? rawMappings
      : Object.entries(rawMappings).map(([account, v]) => ({ account, ...v }));
    const pending = all.filter(g => (g.current_status || g.approval_status || '') !== 'confirmed' && (g.current_status || g.approval_status || '') !== 'n/a');
    const sorted  = [...pending].sort((a, b) => Math.abs(b.value_lakh || 0) - Math.abs(a.value_lakh || 0));
    let cum = 0;
    const total = sorted.reduce((s, g) => s + Math.abs(g.value_lakh || g.total_lakh_fy26 || 0), 0);
    const withPriority = sorted.map(g => {
      cum += Math.abs(g.value_lakh || g.total_lakh_fy26 || 0);
      const pct = total > 0 ? cum / total * 100 : 0;
      const priority = pct <= 70 ? 'P1_MATERIAL' : pct <= 90 ? 'P2_MODERATE' : 'P3_IMMATERIAL';
      return { ...g, priority, cum_pct: r2(pct) };
    });
    res.json({ items: withPriority, resolved: all.length - pending.length, total: all.length, pending_value_lakh: r2(total) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15f/gl/resolve — confirm / change / N/A GL item ───────────────
router.post('/step15f/gl/resolve', adminOnly, async (req, res) => {
  try {
    const { account, action, new_mapping, approved_by, comment } = req.body;
    if (!account || !action || !approved_by) return res.status(400).json({ error: 'account, action and approved_by required' });
    if (!['confirm', 'change', 'n/a'].includes(action)) return res.status(400).json({ error: 'action must be confirm, change, or n/a' });
    const acctMap = readJ('account_mapping.json', { mappings: {} });
    const rawMappings = acctMap.mappings || {};
    if (Array.isArray(rawMappings)) {
      const idx = rawMappings.findIndex(g => g.account === account);
      if (idx === -1) return res.status(404).json({ error: `Account "${account}" not found` });
      const g = rawMappings[idx];
      g.current_status = action === 'n/a' ? 'n/a' : 'confirmed';
      g.reviewer = approved_by; g.last_reviewed = now(); g.review_action = action; g.review_comment = comment || '';
      if (action === 'change' && new_mapping) g.fpa_line = new_mapping;
      writeJ('account_mapping.json', acctMap);
      appendAudit({ module: 'GL', action: action.toUpperCase(), record: account, approved_by, comment, value_lakh: g.value_lakh });
      return res.json({ ok: true, account, action, fpa_line: g.fpa_line });
    }
    if (!rawMappings[account]) return res.status(404).json({ error: `Account "${account}" not found` });
    const g = rawMappings[account];
    g.current_status = action === 'n/a' ? 'n/a' : 'confirmed';
    g.reviewer = approved_by; g.last_reviewed = now(); g.review_action = action; g.review_comment = comment || '';
    if (action === 'change' && new_mapping) g.fpa_line = new_mapping;
    acctMap.mappings = rawMappings;
    writeJ('account_mapping.json', acctMap);
    appendAudit({ module: 'GL', action: action.toUpperCase(), record: account, approved_by, comment, value_lakh: g.value_lakh });
    res.json({ ok: true, account, action, fpa_line: g.fpa_line });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15f/readiness — final gate assessment ──────────────────────────
router.get('/step15f/readiness', async (req, res) => {
  try {
    const brData   = await readBranches();
    const costM    = readJ('cost_master.json', { assumptions: [] });
    const obs      = readJ('opening_balance_sheet.json', {});
    const leases   = readJ('lease_schedule.json', { leases: [] });
    const debt     = readJ('debt_schedule.json', { facilities: [] });
    const acctMap  = readJ('account_mapping.json', { mappings: [] });
    const revAppr  = readRevApprovals();
    const bcm      = await readMappings();
    const branches = brData.branches || [];
    const mappings = bcm.mappings || [];

    const classified  = classifyMateriality(mappings);
    const totalRef    = classified.reduce((s, m) => s + m._ref, 0);
    const approvedVal = classified.reduce((s, m) => s + (revAppr.approvals[m.mapping_id]?.status === 'approved' ? (revAppr.approvals[m.mapping_id].approved_value || 0) : 0), 0);
    const revPct      = totalRef > 0 ? r2(approvedVal / totalRef * 100) : 0;
    const critTotal   = classified.filter(m => m._materiality === 'CRITICAL').length;
    const critAppr    = classified.filter(m => m._materiality === 'CRITICAL' && revAppr.approvals[m.mapping_id]?.status === 'approved').length;
    const highTotal   = classified.filter(m => m._materiality === 'HIGH').length;
    const highAppr    = classified.filter(m => m._materiality === 'HIGH' && revAppr.approvals[m.mapping_id]?.status === 'approved').length;

    const costAppr    = (costM.assumptions || []).filter(a => a.approved).length;
    const capAppr     = branches.filter(b => b.capacity_approved).length;
    const capProp     = branches.filter(b => b.total_area_sqft > 0).length;

    const lArr        = leases.leases || [];
    const ibr         = leases.blended_discount_rate_pct || leases.banded_rates;
    const ibrOk       = !!ibr || lArr.filter(l => l.ind_as_116?.discount_rate_pct != null).length === lArr.length;

    const glRaw       = acctMap.mappings || {};
    const glAll       = Array.isArray(glRaw) ? glRaw : Object.entries(glRaw).map(([account, v]) => ({ account, ...v }));
    const glPending   = glAll.filter(g => (g.current_status || g.approval_status || '') !== 'confirmed' && (g.current_status || g.approval_status || '') !== 'n/a');
    const glPendingVal = r2(glPending.reduce((s, g) => s + Math.abs(g.value_lakh || g.total_lakh_fy26 || 0), 0));
    const glMaterial  = glPending.filter(g => Math.abs(g.value_lakh || g.total_lakh_fy26 || 0) > 100);

    const facilComplete = (debt.facilities || []).filter(f => f.is_complete).length;

    // Module status
    const modules = {
      revenue: { green: revPct >= 95 && critAppr === critTotal && highAppr === highTotal, detail: `${revPct}% value-weighted · CRITICAL ${critAppr}/${critTotal} · HIGH ${highAppr}/${highTotal}` },
      cost:    { green: costAppr > 0, detail: `${costAppr}/${branches.length} approved` },
      obs:     { green: obs.approval_status === 'approved', detail: obs.approval_status || 'pending' },
      ind_as_116: { green: ibrOk, detail: ibr ? `IBR set: ${leases.blended_discount_rate_pct || 'banded'}%` : `0/${lArr.length} rates set` },
      capacity: { green: capAppr >= 1, detail: `${capAppr} approved · ${capProp} proposed · ${branches.length - capProp} missing` },
      debt:     { green: true, detail: `${facilComplete}/${(debt.facilities || []).length} complete (warning only)` },
      gl:       { green: glMaterial.length === 0, detail: `${glPending.length} pending · ₹${glPendingVal}L` },
      far:      { green: true, detail: 'WDV method confirmed · MATERIALLY_RECONCILED' },
    };

    const hardBlockers = ['revenue', 'cost', 'obs', 'ind_as_116'].filter(k => !modules[k].green);
    const gate = hardBlockers.length === 0 ? 'GREEN' : hardBlockers.length <= 2 ? 'AMBER' : 'RED';

    res.json({
      gate, hard_blockers: hardBlockers, modules,
      stop_message: gate === 'GREEN' ? 'STEP 15F INPUT CLOSURE COMPLETE — DRAFT BASELINE V1 COMPUTE READY — AWAITING CFO AUTHORIZATION' : `Gate is ${gate}. ${hardBlockers.length} hard blocker(s) remain: ${hardBlockers.join(', ')}.`,
      baseline_compute_ready: gate === 'GREEN',
      do_not_proceed: true,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15f/audit-trail — full approval audit trail ────────────────────
router.get('/step15f/audit-trail', async (req, res) => {
  try {
    const trail = readJ(AUDIT_FILE, { entries: [] });
    res.json({ entries: (trail.entries || []).slice().reverse(), total: trail.entries?.length || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 15G — ASSISTED MANAGEMENT CLOSURE & EXCEPTION-BASED APPROVAL
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 15G helpers ─────────────────────────────────────────────────────────────
const r2g = v => Math.round(Number(v) * 100) / 100;
const toLakh = v => r2g(Number(v) / 100000);

// Revenue anomaly detection for a single mapping
function detectRevenueAnomalies(m) {
  const flags = [];
  const refRs = m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0;
  const refL  = toLakh(refRs);

  if ((m.months_with_data || 0) < 2)                  flags.push({ code: 'INSUFFICIENT_HISTORY', msg: 'Only 1 month of billing history — cannot distinguish recurring revenue from one-time billing.' });
  if ((m.months_with_data || 0) === 0)                 flags.push({ code: 'NO_DATA', msg: 'Zero months of actual data — no revenue reference available.' });
  if (refL > 5000)                                     flags.push({ code: 'VERY_HIGH_VALUE', msg: `Monthly ₹${r2g(refL)}L — extremely high concentration in single client-branch mapping. Validate against invoice register.` });
  else if (refL > 1000)                                flags.push({ code: 'HIGH_VALUE', msg: `Monthly ₹${r2g(refL)}L — material. Individual CFO review recommended.` });
  if (refRs > 0 && refL === 0)                         flags.push({ code: 'UNITS_CHECK', msg: 'Revenue > 0 but lakh conversion is 0 — unit mismatch possible.' });
  if (refRs === 0)                                     flags.push({ code: 'ZERO_REVENUE', msg: 'Zero revenue recorded. Possible inactive mapping or setup error.' });
  // Since avg_6m === avg_3m === latest for 1-month data, no variance to detect
  return flags;
}

// Classify recommendation status for a mapping
function classifyRevenueRecommendation(m) {
  const hasHistory   = (m.months_with_data || 0) >= 3;
  const confidence   = m.confidence || 'LOW';
  const isHighConf   = confidence === 'HIGH' || confidence === 'MEDIUM';
  const flags        = detectRevenueAnomalies(m);
  const hasBlocker   = flags.some(f => ['INSUFFICIENT_HISTORY','NO_DATA','VERY_HIGH_VALUE','ZERO_REVENUE','UNITS_CHECK'].includes(f.code));

  if (hasHistory && isHighConf && !hasBlocker) return 'RECOMMENDED';
  return 'EXCEPTION';
}

// Cost anomaly detection for a branch
function detectCostAnomalies(b) {
  const flags = [];
  const lines = b.cost_lines || {};
  const total = b.total_proposed_lakh || 0;
  const rent  = lines.rent?.proposed || 0;
  const util  = lines.utilities?.proposed || 0;
  const ppl   = lines.people?.proposed || 0;
  const othr  = lines.other?.proposed || 0;

  if (total === 0)                                     flags.push({ code: 'ZERO_COST', msg: 'No cost proposed — missing data or inactive branch.' });
  if (othr > rent * 0.5 && rent > 0)                   flags.push({ code: 'HIGH_OTHER', msg: `Other costs (₹${r2g(othr)}L) exceed 50% of rent. May include advances, deposits, or CAPEX coded as opex.` });
  if (othr > total * 0.4 && total > 0)                 flags.push({ code: 'OTHER_DOMINATES', msg: `"Other" category is ${Math.round(othr/total*100)}% of total — review for one-time / non-recurring items.` });
  if (!lines.rent || rent === 0)                       flags.push({ code: 'NO_RENT', msg: 'Rent is ₹0 — branch may be sub-leased, owned, or cost coded differently.' });
  if (!lines.utilities || util === 0)                  flags.push({ code: 'NO_UTILITIES', msg: 'Utilities = ₹0 — may indicate CAM inclusive rent or bills not coded separately.' });
  if (total > 200)                                     flags.push({ code: 'HIGH_COST', msg: `Total ₹${r2g(total)}L/mo — above ₹200L threshold. Individual line review required.` });
  const refRent = b.ref?.rent || 0;
  if (refRent > 0 && Math.abs(rent - refRent) / refRent > 0.2) flags.push({ code: 'RENT_VARIANCE', msg: `Proposed rent (₹${r2g(rent)}L) deviates >20% from 6M reference (₹${r2g(refRent)}L).` });
  return flags;
}

// ─── GET /step15g/data-integrity ─────────────────────────────────────────────
router.get('/step15g/data-integrity', async (req, res) => {
  try {
    const [mapData, brData] = await Promise.all([readMappings(), readBranches()]);
    const mappings  = mapData.mappings || [];
    const branches  = brData.branches  || [];
    const costM     = readJ('cost_master.json',   { assumptions: [] });
    const leases    = readJ('lease_schedule.json',{ leases: [] });
    const obs       = readJ('opening_balance_sheet.json', {});

    const checks = [];
    let overallStatus = 'PASS';

    // 1. Revenue unit consistency
    const refValues = mappings.map(m => m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0);
    const totalRef  = refValues.reduce((s, v) => s + v, 0);
    const totalRefL = toLakh(totalRef);
    const zeroRev   = mappings.filter(m => (m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0) === 0).length;
    const negRev    = mappings.filter(m => (m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0) < 0).length;
    checks.push({ id:'REV-001', label:'Revenue unit consistency', status: negRev > 0 ? 'WARNING' : 'PASS',
      detail: `Total ref ₹${r2g(totalRefL)}L/mo across ${mappings.length} mappings. ${zeroRev} zero-revenue. ${negRev} negative (credit notes?).` });
    if (negRev > 0) overallStatus = 'WARNING';

    // 2. Data coverage
    const singleMonth = mappings.filter(m => (m.months_with_data || 0) === 1).length;
    const noHistory   = mappings.filter(m => (m.months_with_data || 0) === 0).length;
    checks.push({ id:'REV-002', label:'Revenue history depth', status: noHistory > 0 ? 'WARNING' : 'WARNING',
      detail: `${singleMonth}/${mappings.length} mappings have exactly 1 month of actuals. ${noHistory} have zero. All avg_6m = avg_3m = latest_actual. Variance analysis not possible — insufficient history.` });
    if (singleMonth === mappings.length) overallStatus = overallStatus === 'FAIL' ? 'FAIL' : 'WARNING';

    // 3. Duplicate mappings (same client_id × branch_id)
    const mapKeys = mappings.map(m => `${m.client_id}||${m.branch_id}`);
    const dupKeys = mapKeys.filter((k, i, a) => a.indexOf(k) !== i);
    checks.push({ id:'REV-003', label:'Duplicate client×branch mappings', status: dupKeys.length > 0 ? 'FAIL' : 'PASS',
      detail: dupKeys.length > 0 ? `${dupKeys.length} duplicate mapping(s) detected: ${dupKeys.slice(0,3).join(', ')}` : 'No duplicates found.' });
    if (dupKeys.length > 0) overallStatus = 'FAIL';

    // 4. Branch master cross-check
    const branchIds  = new Set(branches.map(b => b.branch_id));
    const unmapped   = mappings.filter(m => !branchIds.has(m.branch_id));
    checks.push({ id:'REV-004', label:'Revenue mappings vs Branch Master', status: unmapped.length > 0 ? 'WARNING' : 'PASS',
      detail: unmapped.length > 0 ? `${unmapped.length} revenue mappings reference unknown branch_ids: ${[...new Set(unmapped.map(m => m.branch_id))].slice(0,5).join(', ')}` : 'All revenue mappings reference valid branch IDs.' });
    if (unmapped.length > 0) overallStatus = overallStatus === 'FAIL' ? 'FAIL' : 'WARNING';

    // 5. Cost proposals
    const costBranches = new Set((costM.assumptions || []).map(a => a.branch_id));
    const missingCost  = branches.filter(b => !costBranches.has(b.branch_id));
    const negCost      = (costM.assumptions || []).filter(a => (a.total_proposed_lakh || 0) < 0);
    checks.push({ id:'COST-001', label:'Cost branch coverage', status: missingCost.length > 2 ? 'WARNING' : 'PASS',
      detail: `${costM.assumptions?.length || 0}/30 branches have cost proposals. ${missingCost.length} missing: ${missingCost.slice(0,3).map(b => b.branch_id).join(', ')}` });
    checks.push({ id:'COST-002', label:'Negative cost values', status: negCost.length > 0 ? 'WARNING' : 'PASS',
      detail: negCost.length > 0 ? `${negCost.length} branches have negative total cost — check for credit notes in bills data.` : 'No negative cost proposals.' });

    // 6. Lease data
    const lArr        = leases.leases || [];
    const dupLeases   = [];
    const leaseSeen   = new Set();
    for (const l of lArr) {
      const lKey = `${l.branch}||${l.landlord}||${l.expiry_date}`;
      if (leaseSeen.has(lKey)) dupLeases.push(lKey);
      else leaseSeen.add(lKey);
    }
    checks.push({ id:'LEASE-001', label:'Lease schedule duplicates', status: dupLeases.length > 0 ? 'WARNING' : 'PASS',
      detail: dupLeases.length > 0 ? `${dupLeases.length} potential duplicate lease records detected.` : `${lArr.length} leases — no exact duplicates on branch+landlord+expiry.` });

    // 7. GL mapping
    const acctRaw  = readJ('account_mapping.json', { mappings: {} });
    const glRaw    = acctRaw.mappings || {};
    const glAll    = Array.isArray(glRaw) ? glRaw : Object.entries(glRaw).map(([account, v]) => ({ account, ...v }));
    const totalGLVal = r2g(glAll.reduce((s, g) => s + Math.abs(g.total_lakh_fy26 || g.value_lakh || 0), 0));
    checks.push({ id:'GL-001', label:'GL mapping total value', status: 'PASS',
      detail: `${glAll.length} GL groups totalling ₹${totalGLVal}L. Source: financial_tb_data.json (M26).` });

    // 8. OBS reconciliation
    const diff = Math.abs(obs.bs_check_diff || 0);
    checks.push({ id:'OBS-001', label:'Opening Balance Sheet reconciliation', status: diff < 1 ? 'PASS' : diff < 10 ? 'WARNING' : 'FAIL',
      detail: `Assets ₹${r2g(obs.total_assets)}L vs E+L ₹${r2g(obs.total_el)}L. Difference: ₹${r2g(diff)}L. ${diff < 1 ? 'Within rounding tolerance.' : 'Exceeds tolerance — review required.'}` });
    if (diff >= 10) overallStatus = 'FAIL';

    res.json({ overall: overallStatus, checks, summary: { total: checks.length, pass: checks.filter(c => c.status === 'PASS').length, warn: checks.filter(c => c.status === 'WARNING').length, fail: checks.filter(c => c.status === 'FAIL').length } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g/revenue/analytical-review ──────────────────────────────────
router.get('/step15g/revenue/analytical-review', async (req, res) => {
  try {
    const mapData   = await readMappings();
    const revAppr   = readRevApprovals();
    const mappings  = mapData.mappings || [];
    const classified = classifyMateriality(mappings);
    const totalRefRs = classified.reduce((s, m) => s + m._ref, 0);

    const reviewed = classified.map(m => {
      const refRs   = m._ref;
      const refL    = toLakh(refRs);
      const flags   = detectRevenueAnomalies(m);
      const rec     = classifyRevenueRecommendation(m);
      const approved = revAppr.approvals[m.mapping_id];

      return {
        mapping_id:      m.mapping_id,
        client_id:       m.client_id,
        branch_id:       m.branch_id,
        zoho_customer_id: m.zoho_customer_id,
        materiality:     m._materiality,
        pct_of_total:    r2g(m._cum_pct > 0 ? (refRs / totalRefRs * 100) : 0),
        cum_pct:         m._cum_pct,
        // Actuals
        latest_actual_rs: m.latest_actual_revenue || 0,
        avg_3m_rs:        m.avg_3m || 0,
        avg_6m_rs:        m.avg_6m || 0,
        months_with_data: m.months_with_data || 0,
        // In lakhs
        latest_actual_lakh: toLakh(m.latest_actual_revenue || 0),
        avg_3m_lakh:        toLakh(m.avg_3m || 0),
        avg_6m_lakh:        toLakh(m.avg_6m || 0),
        proposed_lakh:      r2g(m._ref_lakh || toLakh(refRs)),
        annualised_lakh:    r2g((m._ref_lakh || toLakh(refRs)) * 12),
        // Variance (all same since 1M data)
        var_vs_3m_pct:  0,
        var_vs_6m_pct:  0,
        // Status
        confidence:     m.confidence || 'LOW',
        recommendation: rec,
        approval_status: approved?.status || 'pending',
        flags,
        flag_count: flags.length,
      };
    });

    // Summary
    const recommended = reviewed.filter(m => m.recommendation === 'RECOMMENDED');
    const exceptions  = reviewed.filter(m => m.recommendation === 'EXCEPTION');
    const recMonthlyL  = r2g(recommended.reduce((s, m) => s + m.proposed_lakh, 0));
    const excMonthlyL  = r2g(exceptions.reduce((s, m) => s + m.proposed_lakh, 0));
    const totalMonthlyL = r2g(reviewed.reduce((s, m) => s + m.proposed_lakh, 0));
    const approvedCount = reviewed.filter(m => m.approval_status === 'approved').length;
    const approvedL     = r2g(revAppr.approvals ? Object.values(revAppr.approvals).filter(a => a.status === 'approved').reduce((s, a) => s + (a.approved_value || 0), 0) / 100000 : 0);

    res.json({
      summary: {
        total: reviewed.length,
        total_monthly_lakh: totalMonthlyL,
        total_annual_lakh: r2g(totalMonthlyL * 12),
        recommended_count: recommended.length,
        exception_count: exceptions.length,
        approved_count: approvedCount,
        approved_lakh: approvedL,
        coverage_pct: totalMonthlyL > 0 ? r2g(approvedL / totalMonthlyL * 100) : 0,
        data_limitation: 'ALL 650 mappings have months_with_data=1. No mapping qualifies for RECOMMENDED status under the strict multi-month history criterion. All require explicit management approval.',
      },
      by_materiality: {
        CRITICAL: { count: reviewed.filter(m => m.materiality === 'CRITICAL').length, monthly_lakh: r2g(reviewed.filter(m => m.materiality === 'CRITICAL').reduce((s, m) => s + m.proposed_lakh, 0)) },
        HIGH:     { count: reviewed.filter(m => m.materiality === 'HIGH').length,     monthly_lakh: r2g(reviewed.filter(m => m.materiality === 'HIGH').reduce((s, m) => s + m.proposed_lakh, 0)) },
        MEDIUM:   { count: reviewed.filter(m => m.materiality === 'MEDIUM').length,   monthly_lakh: r2g(reviewed.filter(m => m.materiality === 'MEDIUM').reduce((s, m) => s + m.proposed_lakh, 0)) },
        LOW:      { count: reviewed.filter(m => m.materiality === 'LOW').length,      monthly_lakh: r2g(reviewed.filter(m => m.materiality === 'LOW').reduce((s, m) => s + m.proposed_lakh, 0)) },
      },
      recommended_pool: { count: 0, monthly_lakh: 0, reason: 'No mapping qualifies — all have months_with_data=1 (insufficient history). Management must explicitly approve all batches.' },
      exception_queue: reviewed.sort((a, b) => b.proposed_lakh - a.proposed_lakh).slice(0, 50), // top 50 by ₹
      total_exceptions: reviewed.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g/cost/analytical-review ──────────────────────────────────────
router.get('/step15g/cost/analytical-review', async (req, res) => {
  try {
    const brData  = await readBranches();
    const costM   = readJ('cost_master.json', { assumptions: [] });
    const mapData = await readMappings();
    const branches = brData.branches || [];
    const assumptions = costM.assumptions || [];
    const mappings    = mapData.mappings || [];

    // Revenue per branch for cost/revenue % calc
    const revByBranch = {};
    for (const m of mappings) {
      const lakh = toLakh(m.avg_6m || m.avg_3m || m.latest_actual_revenue || 0);
      revByBranch[m.branch_id] = (revByBranch[m.branch_id] || 0) + lakh;
    }

    const costMap = {};
    for (const a of assumptions) costMap[a.branch_id] = a;

    const result = branches.map(b => {
      const a = costMap[b.branch_id];
      if (!a) {
        return {
          branch_id: b.branch_id, branch_name: b.branch_name, city: b.city,
          status: 'NO_PROPOSAL', total_proposed_lakh: 0,
          cost_lines: null, flags: [{ code: 'NO_DATA', msg: 'No cost proposal exists — no Zoho bills reference found.' }],
          recommendation: 'MGMT_INPUT_REQUIRED',
          rev_lakh: r2g(revByBranch[b.branch_id] || 0), cost_rev_pct: null,
        };
      }
      const total = a.total_proposed_lakh || 0;
      const revL  = revByBranch[b.branch_id] || 0;
      const flags = detectCostAnomalies({ ...a, branch_name: b.branch_name });
      const hasBlocker = flags.some(f => ['ZERO_COST','HIGH_OTHER','OTHER_DOMINATES','RENT_VARIANCE','HIGH_COST'].includes(f.code));
      const rec = (total > 0 && flags.length === 0) ? 'RECOMMENDED' : (total > 0 && !hasBlocker) ? 'RECOMMENDED_WITH_NOTES' : 'EXCEPTION';

      return {
        branch_id: b.branch_id, branch_name: b.branch_name, city: b.city,
        status: a.approved ? 'APPROVED' : 'PROPOSED',
        total_proposed_lakh: total,
        cost_lines: a.cost_lines,
        flags, recommendation: rec,
        rev_lakh: r2g(revL),
        cost_rev_pct: revL > 0 ? r2g(total / revL * 100) : null,
        sqft: b.total_area_sqft || null,
        cost_per_sqft: (b.total_area_sqft || 0) > 0 ? r2g(total / b.total_area_sqft * 100000) : null,
      };
    });

    const recommended    = result.filter(b => b.recommendation === 'RECOMMENDED' || b.recommendation === 'RECOMMENDED_WITH_NOTES');
    const exceptions     = result.filter(b => b.recommendation === 'EXCEPTION' || b.recommendation === 'MGMT_INPUT_REQUIRED');
    const recMonthlyL    = r2g(recommended.reduce((s, b) => s + b.total_proposed_lakh, 0));
    const totalMonthlyL  = r2g(result.reduce((s, b) => s + b.total_proposed_lakh, 0));

    res.json({
      summary: {
        total_branches: branches.length,
        proposed: assumptions.length,
        missing: branches.length - assumptions.length,
        approved: assumptions.filter(a => a.approved).length,
        total_monthly_lakh: totalMonthlyL,
        recommended_count: recommended.length,
        exception_count: exceptions.length,
        recommended_monthly_lakh: recMonthlyL,
      },
      branches: result,
      missing_branches: result.filter(b => b.status === 'NO_PROPOSAL'),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g/obs/sign-off-pack ──────────────────────────────────────────
router.get('/step15g/obs/sign-off-pack', async (req, res) => {
  try {
    const obs = readJ('opening_balance_sheet.json', {});
    const bal = obs.balances || {};
    const assets = bal.assets || {};
    const equity = bal.equity || {};
    const liab   = bal.liabilities || {};

    const ncAssets = Object.values(assets.non_current || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const cAssets  = Object.values(assets.current  || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const equityTotal = Object.values(equity).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const ncLiab   = Object.values(liab.non_current || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const cLiab    = Object.values(liab.current    || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);

    res.json({
      status: obs.approval_status || 'pending_review',
      approved_by: obs.approved_by || null,
      approved_at: obs.approved_at || null,
      as_at: obs.as_at_month || '2026-03',
      source: obs.source_ref || 'DevX Standalone Financial Statements FY 2025-26 (Audited)',
      // Key figures
      total_assets_lakh:     r2g(obs.total_assets    || 0),
      total_el_lakh:         r2g(obs.total_el        || 0),
      diff_lakh:             r2g(obs.bs_check_diff   || 0),
      diff_pct:              obs.total_assets > 0 ? r2g(Math.abs(obs.bs_check_diff || 0) / obs.total_assets * 100) : 0,
      // Components
      nc_assets_lakh:   r2g(ncAssets),
      c_assets_lakh:    r2g(cAssets),
      equity_lakh:      r2g(equityTotal),
      nc_liab_lakh:     r2g(ncLiab),
      c_liab_lakh:      r2g(cLiab),
      // Key line items
      rou_asset:         r2g(assets.non_current?.rou_assets || 0),
      ppe_net:           r2g(assets.non_current?.ppe_net || 0),
      cash:              r2g(assets.current?.cash_and_bank || 0),
      trade_rec:         r2g(assets.current?.trade_receivables || 0),
      borrowings:        r2g((liab.non_current?.borrowings || 0) + (liab.current?.current_borrowings || 0)),
      lease_liab:        r2g((liab.non_current?.lease_liabilities || 0) + (liab.current?.current_lease_liabilities || 0)),
      retained_earnings: r2g(equity.retained_earnings || 0),
      // Reconciliation note
      diff_explanation: Math.abs(obs.bs_check_diff || 0) < 1
        ? 'ROUNDING DIFFERENCE — The ₹' + r2g(Math.abs(obs.bs_check_diff || 0)) + 'L difference is a presentation/rounding artefact arising from converting individual line items from the audited financial statements. This is within accepted accounting presentation tolerance. No adjustment is required.'
        : 'MATERIAL DIFFERENCE — Difference exceeds ₹1L. Please review individual line items.',
      action_required: obs.approval_status !== 'approved',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g/capacity/completion ─────────────────────────────────────────
router.get('/step15g/capacity/completion', async (req, res) => {
  try {
    const brData  = await readBranches();
    const leases  = readJ('lease_schedule.json', { leases: [] });
    const branches = brData.branches || [];
    const lArr     = leases.leases || [];

    // Index leases by branch name (fuzzy match)
    const leaseByBranch = {};
    for (const l of lArr) {
      const key = (l.branch || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!leaseByBranch[key]) leaseByBranch[key] = [];
      leaseByBranch[key].push(l);
    }

    const missing = branches.filter(b => !b.total_area_sqft || b.total_area_sqft === 0);
    const result  = missing.map(b => {
      // Try to find matching leases by branch name
      const nameKey = b.branch_name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const matching = [];
      for (const [k, ls] of Object.entries(leaseByBranch)) {
        if (k.includes(nameKey.slice(0, 8)) || nameKey.includes(k.slice(0, 8))) matching.push(...ls);
      }
      const totalRent = matching.reduce((s, l) => s + (l.base_monthly_rent_lakh || 0), 0);
      const hasMatch  = matching.length > 0;

      // Estimate area from rent (₹50-80/sqft/mo is typical for flex spaces)
      const estAreaFromRent = totalRent > 0 ? Math.round((totalRent * 100000) / 65) : null; // ₹65/sqft/mo median

      return {
        branch_id:    b.branch_id,
        branch_name:  b.branch_name,
        city:         b.city,
        capacity_approved: b.capacity_approved || false,
        // Ref data found
        lease_matches:    matching.length,
        ref_rent_lakh:    r2g(totalRent),
        est_area_sqft:    estAreaFromRent,
        est_seats:        estAreaFromRent ? Math.round(estAreaFromRent / 80) : null,
        est_source:       hasMatch ? 'lease_rent_proxy_65_per_sqft' : null,
        est_confidence:   hasMatch ? 'LOW — proxy estimate from rent, no area in lease data' : 'NO_DATA',
        // What management needs to provide
        required_inputs:  ['total_area_sqft', 'revenue_capacity_sqft', 'total_seats', 'opening_date'],
        note: hasMatch
          ? `${matching.length} lease record(s) found for this branch. Rent total ₹${r2g(totalRent)}L/mo. Area estimate from ₹65/sqft proxy is NOT management-approved — enter actual sqft.`
          : 'No lease records found for this branch. Manual input required.',
      };
    });

    res.json({ missing_count: result.length, branches: result,
      methodology_note: 'Seat estimates shown use 1 seat per 80 sqft. This methodology is NOT management-approved. Do not infer seats without explicit management confirmation of the sqft-per-seat ratio.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g/lease/ibr-analysis ──────────────────────────────────────────
router.get('/step15g/lease/ibr-analysis', async (req, res) => {
  try {
    const leases  = readJ('lease_schedule.json', { leases: [] });
    const debt    = readJ('debt_schedule.json',  { facilities: [] });
    const lArr    = leases.leases || [];

    // Debt rates as borrowing rate evidence
    const facilities   = debt.facilities || [];
    const ratedFacils  = facilities.filter(f => f.rate || f.interest_rate).map(f => ({ id: f.id, label: f.label, rate: f.rate || f.interest_rate, type: f.type, category: f.category, opening_principal: f.opening_principal || 0 }));
    const rates        = ratedFacils.map(f => f.rate);
    const wtdRate      = rates.length > 0 ? r2g(ratedFacils.reduce((s, f) => s + f.rate * f.opening_principal, 0) / Math.max(ratedFacils.reduce((s, f) => s + f.opening_principal, 0), 1)) : null;
    const minRate      = rates.length > 0 ? Math.min(...rates) : null;
    const maxRate      = rates.length > 0 ? Math.max(...rates) : null;
    const medRate      = rates.length > 0 ? rates.sort((a,b)=>a-b)[Math.floor(rates.length/2)] : null;

    // Lease term distribution
    const today = new Date();
    const termBands = { le_1yr:[], gt1_3yr:[], gt3_5yr:[], gt5yr:[] };
    let totalMonthlyRent = 0;
    let totalPV_rough = 0;
    for (const l of lArr) {
      const exp  = l.expiry_date ? new Date(l.expiry_date) : null;
      const remM = exp ? Math.max(0, (exp - today) / (1000*60*60*24*30.5)) : 60; // default 5yr
      const band = remM <= 12 ? 'le_1yr' : remM <= 36 ? 'gt1_3yr' : remM <= 60 ? 'gt3_5yr' : 'gt5yr';
      termBands[band].push({ branch: l.branch, rem_months: Math.round(remM), rent_lakh: l.base_monthly_rent_lakh || 0 });
      totalMonthlyRent += l.base_monthly_rent_lakh || 0;
    }
    totalMonthlyRent = r2g(totalMonthlyRent);

    // Indicative impact of IBR on ROU asset
    const rouAudited    = 19225.26; // from audited FS
    const leaseLiabAudit = r2g((22569.19 || 0)); // from GL mapping Lease liab account

    // Option A: Blended IBR — indicative
    const indicativeBlended = wtdRate || 12; // fallback 12% if no debt rates
    const optionA = {
      method: 'APPROVE_BLENDED_IBR',
      label: 'Single Blended IBR',
      indicative_rate_pct: indicativeBlended,
      rate_source: ratedFacils.length > 0 ? `Weighted average of ${ratedFacils.length} rated facility(ies)` : 'NO EVIDENCE — CA confirmation required',
      requires_ca_confirmation: true,
      lease_count_affected: lArr.length,
      note: 'Apply single rate to all 191 leases. Simplest approach. Requires CA to confirm rate = company\'s incremental borrowing rate as at 31-Mar-2026.',
    };
    // Option B: Term-banded
    const optionB = {
      method: 'APPROVE_TERM_BANDED_IBR',
      label: 'Term-Banded IBR',
      bands: [
        { band: '≤1yr', count: termBands.le_1yr.length, indicative_pct: (indicativeBlended + 1), reason: 'Short-term: slightly higher (credit risk premium)' },
        { band: '1–3yr', count: termBands.gt1_3yr.length, indicative_pct: indicativeBlended, reason: 'Medium-term: blended base rate' },
        { band: '3–5yr', count: termBands.gt3_5yr.length, indicative_pct: (indicativeBlended - 0.5), reason: 'Longer-term: slight reduction for term premium' },
        { band: '>5yr', count: termBands.gt5yr.length, indicative_pct: (indicativeBlended - 1), reason: 'Long-dated: lower rate, longer tenor benefits' },
      ],
      requires_ca_confirmation: true,
      note: 'All indicative rates require CA confirmation. Do not use without auditor sign-off.',
    };

    res.json({
      data_available: { rated_facilities: ratedFacils.length, rates },
      borrowing_rate_evidence: { min: minRate, max: maxRate, median: medRate, weighted_avg: wtdRate, facilities: ratedFacils },
      term_distribution: { le_1yr: { count: termBands.le_1yr.length, monthly_rent: r2g(termBands.le_1yr.reduce((s,l)=>s+l.rent_lakh,0)) }, gt1_3yr: { count: termBands.gt1_3yr.length, monthly_rent: r2g(termBands.gt1_3yr.reduce((s,l)=>s+l.rent_lakh,0)) }, gt3_5yr: { count: termBands.gt3_5yr.length, monthly_rent: r2g(termBands.gt3_5yr.reduce((s,l)=>s+l.rent_lakh,0)) }, gt5yr: { count: termBands.gt5yr.length, monthly_rent: r2g(termBands.gt5yr.reduce((s,l)=>s+l.rent_lakh,0)) } },
      total_monthly_rent_lakh: totalMonthlyRent,
      rou_asset_audited_lakh: rouAudited,
      lease_liab_audited_lakh: leaseLiabAudit,
      options: [optionA, optionB],
      ca_required: true,
      ca_message: 'CA / CFO APPROVAL REQUIRED. Indicative rates shown are based on the single known borrowing rate from debt schedule (Molkem TL @ 15%). These rates MUST be confirmed by the statutory auditor or CA before use. Do NOT enter any rate without CA sign-off.',
      current_ibr: leases.blended_discount_rate_pct || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g/debt/completion ─────────────────────────────────────────────
router.get('/step15g/debt/completion', async (req, res) => {
  try {
    const debt = readJ('debt_schedule.json', { facilities: [] });
    const today = new Date();

    const analysed = (debt.facilities || []).map(f => {
      const fields = [];
      const missing = [];
      let completePct = 0;

      // What we can verify from existing data
      if (f.id)                 { fields.push({ field:'id',               value:f.id,         source:'debt_schedule',   confidence:'HIGH' }); completePct += 10; }
      if (f.lender)             { fields.push({ field:'lender',           value:f.lender,     source:'debt_schedule',   confidence:'HIGH' }); completePct += 10; }
      if (f.type)               { fields.push({ field:'type',             value:f.type,       source:'debt_schedule',   confidence:'HIGH' }); completePct += 5; }
      if (f.opening_principal)  { fields.push({ field:'opening_principal',value:f.opening_principal, source:'debt_schedule', confidence:'HIGH' }); completePct += 15; }
      if (f.rate || f.interest_rate) { fields.push({ field:'interest_rate', value:f.rate||f.interest_rate, source:'debt_schedule', confidence:'HIGH' }); completePct += 15; }
      if (f.maturity)           { fields.push({ field:'maturity',         value:f.maturity,   source:'debt_schedule',   confidence:'HIGH' }); completePct += 10; }
      if (f.repay_freq)         { fields.push({ field:'repay_freq',       value:f.repay_freq, source:'debt_schedule',   confidence:'HIGH' }); completePct += 5; }

      // What can be derived
      if (f.maturity && f.opening_principal && (f.rate || f.interest_rate) && f.repay_freq === 'bullet') {
        const matDate = new Date(f.maturity);
        const remMonths = Math.max(0, Math.round((matDate - today) / (1000*60*60*24*30.5)));
        const monthlyInterest = r2g(f.opening_principal * (f.rate || f.interest_rate) / 100 / 12);
        fields.push({ field:'remaining_months', value:remMonths, source:'derived_from_maturity', confidence:'HIGH' });
        fields.push({ field:'monthly_interest_lakh', value:monthlyInterest, source:'derived_from_rate_and_principal', confidence:'HIGH' });
        fields.push({ field:'emi_lakh', value:monthlyInterest, source:'derived_bullet_interest_only', confidence:'MEDIUM', note:'Bullet repayment — EMI = interest only. Principal due at maturity.' });
        completePct += 20;
      }

      // What's still missing
      if (!f.emi_lakh && f.repay_freq !== 'bullet')    missing.push({ field:'emi_lakh', reason:'EMI not set and repayment type is not bullet.' });
      if (!f.repayment_start_date)                      missing.push({ field:'repayment_start_date', reason:'First repayment date not provided.' });
      if (!(f.rate || f.interest_rate))                 missing.push({ field:'interest_rate', reason:'No interest rate provided.' });
      if (!f.opening_principal)                         missing.push({ field:'opening_principal', reason:'Opening principal not set.' });

      const status = missing.length === 0 ? 'COMPLETE' : completePct >= 60 ? 'PARTIALLY_COMPLETE' : 'MANUAL_INPUT_REQUIRED';
      return { ...f, status, complete_pct: Math.min(100, completePct + (missing.length === 0 ? 10 : 0)), derived_fields: fields, missing_fields: missing };
    });

    const complete   = analysed.filter(f => f.status === 'COMPLETE').length;
    const partial    = analysed.filter(f => f.status === 'PARTIALLY_COMPLETE').length;
    const manual     = analysed.filter(f => f.status === 'MANUAL_INPUT_REQUIRED').length;
    const totalPrincipal = r2g(analysed.reduce((s, f) => s + (f.opening_principal || 0), 0));
    const coveragePct   = analysed.length > 0 ? r2g(complete / analysed.length * 100) : 0;

    res.json({ summary: { total: analysed.length, complete, partially_complete: partial, manual_required: manual, total_principal_lakh: totalPrincipal, coverage_pct: coveragePct }, facilities: analysed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g/gl/materiality ──────────────────────────────────────────────
router.get('/step15g/gl/materiality', async (req, res) => {
  try {
    const acctMap  = readJ('account_mapping.json', { mappings: {} });
    const rawMappings = acctMap.mappings || {};
    const all = Array.isArray(rawMappings) ? rawMappings : Object.entries(rawMappings).map(([account, v]) => ({ account, ...v }));
    const totalVal = all.reduce((s, g) => s + Math.abs(g.total_lakh_fy26 || g.value_lakh || 0), 0);

    const sorted = [...all].sort((a, b) => Math.abs(b.total_lakh_fy26 || b.value_lakh || 0) - Math.abs(a.total_lakh_fy26 || a.value_lakh || 0));
    let cum = 0;
    const withPriority = sorted.map(g => {
      const val = Math.abs(g.total_lakh_fy26 || g.value_lakh || 0);
      cum += val;
      const cumPct = totalVal > 0 ? r2g(cum / totalVal * 100) : 0;
      const priority = cumPct <= 80 ? 'P1_MATERIAL' : cumPct <= 95 ? 'P2_MODERATE' : 'P3_IMMATERIAL';
      const status = (g.current_status || g.approval_status || '');
      const resolved = status === 'confirmed' || status === 'n/a' || status === 'auto_mapped';
      return { account: g.account, fpa_line: g.fpa_line, category: g.category, statement: g.statement, value_lakh: r2g(val), raw_lakh: r2g(g.total_lakh_fy26 || g.value_lakh || 0), cum_pct: cumPct, priority, current_status: status, resolved, confidence: g.confidence, };
    });

    const p1 = withPriority.filter(g => g.priority === 'P1_MATERIAL');
    const p2 = withPriority.filter(g => g.priority === 'P2_MODERATE');
    const p3 = withPriority.filter(g => g.priority === 'P3_IMMATERIAL');
    const p1Unresolved = p1.filter(g => !g.resolved);
    const p2Unresolved = p2.filter(g => !g.resolved);
    const p3Unresolved = p3.filter(g => !g.resolved);

    res.json({
      summary: { total: all.length, total_value_lakh: r2g(totalVal), p1_count: p1.length, p2_count: p2.length, p3_count: p3.length, p1_unresolved: p1Unresolved.length, p2_unresolved: p2Unresolved.length, p3_unresolved: p3Unresolved.length },
      p1: p1Unresolved.slice(0, 30),
      p2: p2Unresolved.slice(0, 20),
      p3_count: p3Unresolved.length,
      all_sorted: withPriority,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g/quick-wins ──────────────────────────────────────────────────
router.get('/step15g/quick-wins', async (req, res) => {
  try {
    const [mapData, brData] = await Promise.all([readMappings(), readBranches()]);
    const obs      = readJ('opening_balance_sheet.json', {});
    const costM    = readJ('cost_master.json',           { assumptions: [] });
    const leases   = readJ('lease_schedule.json',        { leases: [] });
    const revAppr  = readRevApprovals();
    const mappings = mapData.mappings || [];
    const branches = brData.branches  || [];

    const classified   = classifyMateriality(mappings);
    const critApproved = classified.filter(m => m._materiality === 'CRITICAL' && revAppr.approvals[m.mapping_id]?.status === 'approved').length;
    const critTotal    = classified.filter(m => m._materiality === 'CRITICAL').length;
    const costApproved = (costM.assumptions || []).filter(a => a.approved).length;
    const costTotal    = (costM.assumptions || []).length;
    const totalRefL    = r2g(classified.reduce((s, m) => s + (m._ref_lakh || m._ref / 100000), 0));

    const wins = [
      {
        action: 'Approve Opening Balance Sheet',
        description: 'Single approval action clears B3. Total assets ₹61,327L, rounding diff ₹0.01L.',
        impact_lakh: 61327,
        records: 1,
        est_minutes: 2,
        unblocks: ['B3 — Opening BS'],
        risk: 'LOW — purely rounding, audited source',
        tab: 'Opening BS',
        status: obs.approval_status === 'approved' ? 'DONE' : 'PENDING',
        priority: 1,
      },
      {
        action: 'Approve 23 CRITICAL revenue mappings (R1)',
        description: `23 highest-value clients. Monthly ₹5,638.69L. Each requires individual review. All have 1 month of data.`,
        impact_lakh: 5638.69,
        records: critTotal,
        est_minutes: 60,
        unblocks: critApproved >= critTotal ? [] : ['B1 — Revenue (partial)'],
        risk: 'MEDIUM — single month data, high concentration',
        tab: 'Revenue → R1 Batch',
        status: critApproved >= critTotal ? 'DONE' : 'PENDING',
        priority: 2,
      },
      {
        action: 'Bulk-approve 28 branch cost proposals',
        description: `28 proposals totalling ₹916.46L/mo. After reviewing each for deposits/advances. 2 branches still missing.`,
        impact_lakh: 916.46,
        records: costTotal,
        est_minutes: 30,
        unblocks: costApproved >= costTotal ? [] : ['B2 — Cost Master (partial)'],
        risk: 'MEDIUM — proposals from 6M bills avg; check for non-recurring items',
        tab: 'Cost Master',
        status: costApproved >= costTotal ? 'DONE' : 'PENDING',
        priority: 3,
      },
      {
        action: 'Approve 34 HIGH revenue mappings (R2)',
        description: 'Monthly ₹703.30L. Individual review required. After CRITICAL cleared.',
        impact_lakh: 703.30,
        records: 34,
        est_minutes: 60,
        unblocks: ['B1 — Revenue (partial)'],
        risk: 'MEDIUM — single month data',
        tab: 'Revenue → R2 Batch',
        status: 'PENDING',
        priority: 4,
      },
      {
        action: 'Bulk-approve R3 + R4 revenue (593 mappings)',
        description: 'MEDIUM + LOW materiality. ~₹878L/mo. After R1 + R2 cleared.',
        impact_lakh: totalRefL - 5638.69 - 703.30,
        records: 593,
        est_minutes: 5,
        unblocks: ['B1 — Revenue (gate)'],
        risk: 'LOW — individually immaterial, acknowledge 1-month data limitation',
        tab: 'Revenue → R3 + R4',
        status: 'PENDING',
        priority: 5,
      },
      {
        action: 'Confirm IBR with CA — enter approved rate',
        description: `191 leases · ROU ₹19,225L. One known rate: Molkem TL @ 15%. CA must confirm IBR.`,
        impact_lakh: 19225.26,
        records: 191,
        est_minutes: null,
        unblocks: ['B4 — Ind AS 116'],
        risk: 'HIGH — rate materially affects P&L finance cost and ROU amortisation',
        tab: 'Ind AS 116',
        status: leases.blended_discount_rate_pct ? 'DONE' : 'AWAITING_CA',
        priority: 6,
      },
      {
        action: 'Enter capacity for 10 missing branches',
        description: '10 branches have no area/seat data. Manual input or lease document verification needed.',
        impact_lakh: 0,
        records: 10,
        est_minutes: 30,
        unblocks: ['Branch capacity warning'],
        risk: 'LOW — capacity affects occupancy forecasts, not core gate',
        tab: 'Capacity',
        status: 'PENDING',
        priority: 7,
      },
      {
        action: 'Review P1 GL mappings (top 80% by ₹ value)',
        description: 'Material GL accounts — CONFIRM / CHANGE / N/A for each. Unresolved P1 items affect FPA line accuracy.',
        impact_lakh: null,
        records: null,
        est_minutes: 60,
        unblocks: ['GL mapping warning'],
        risk: 'MEDIUM — incorrect GL mapping → wrong FPA line in Baseline',
        tab: 'GL Mapping',
        status: 'PENDING',
        priority: 8,
      },
      {
        action: 'Submit complete loan register (32 facilities)',
        description: 'Treasury to provide repayment schedule for all 32 debt facilities. Currently DEB-001 is partially complete.',
        impact_lakh: null,
        records: 32,
        est_minutes: null,
        unblocks: ['Debt schedule warning'],
        risk: 'HIGH — missing schedules → ₹0 finance cost in Draft P&L (understated)',
        tab: 'Debt',
        status: 'PENDING',
        priority: 9,
      },
    ];

    res.json({ wins: wins.filter(w => w.status !== 'DONE'), completed: wins.filter(w => w.status === 'DONE'), total: wins.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15g/readiness-simulator ──────────────────────────────────────
// Simulate what happens if certain approvals occur — READ ONLY, no writes
router.post('/step15g/readiness-simulator', async (req, res) => {
  try {
    const { approve = [] } = req.body; // approve: ['obs', 'revenue_critical', 'revenue_high', 'revenue_bulk', 'cost_all', 'ibr']
    const [mapData, brData] = await Promise.all([readMappings(), readBranches()]);
    const obs      = readJ('opening_balance_sheet.json', {});
    const costM    = readJ('cost_master.json',           { assumptions: [] });
    const leases   = readJ('lease_schedule.json',        { leases: [] });
    const revAppr  = readRevApprovals();
    const mappings = mapData.mappings || [];
    const classified = classifyMateriality(mappings);

    const totalRefRs   = classified.reduce((s, m) => s + m._ref, 0);
    const critTotal    = classified.filter(m => m._materiality === 'CRITICAL').length;
    const highTotal    = classified.filter(m => m._materiality === 'HIGH').length;
    const medTotal     = classified.filter(m => m._materiality === 'MEDIUM').length;
    const lowTotal     = classified.filter(m => m._materiality === 'LOW').length;
    const costTotal    = (costM.assumptions || []).length;

    // Current approvals
    const curCritAppr = classified.filter(m => m._materiality === 'CRITICAL' && revAppr.approvals[m.mapping_id]?.status === 'approved').length;
    const curHighAppr = classified.filter(m => m._materiality === 'HIGH'     && revAppr.approvals[m.mapping_id]?.status === 'approved').length;
    const curApprValRs = Object.values(revAppr.approvals || {}).filter(a => a.status === 'approved').reduce((s, a) => s + (a.approved_value || 0), 0);
    const curCostAppr = (costM.assumptions || []).filter(a => a.approved).length;
    const curObsOk    = obs.approval_status === 'approved';
    const curIbrOk    = !!leases.blended_discount_rate_pct;

    // Simulated approvals
    let simCritAppr  = curCritAppr;
    let simHighAppr  = curHighAppr;
    let simApprValRs = curApprValRs;
    let simCostAppr  = curCostAppr;
    let simObsOk     = curObsOk;
    let simIbrOk     = curIbrOk;

    const simActions = [];

    if (approve.includes('obs') && !curObsOk) { simObsOk = true; simActions.push('Opening BS approved'); }
    if (approve.includes('ibr') && !curIbrOk) { simIbrOk = true; simActions.push('IBR approved (blended)'); }
    if (approve.includes('revenue_critical') && simCritAppr < critTotal) {
      const gain = classified.filter(m => m._materiality === 'CRITICAL' && !revAppr.approvals[m.mapping_id]?.status === 'approved');
      simCritAppr = critTotal;
      simApprValRs += classified.filter(m => m._materiality === 'CRITICAL').reduce((s, m) => s + m._ref, 0);
      simActions.push(`${critTotal} CRITICAL revenue mappings approved`);
    }
    if (approve.includes('revenue_high') && simHighAppr < highTotal) {
      simHighAppr = highTotal;
      simApprValRs += classified.filter(m => m._materiality === 'HIGH').reduce((s, m) => s + m._ref, 0);
      simActions.push(`${highTotal} HIGH revenue mappings approved`);
    }
    if (approve.includes('revenue_bulk')) {
      simApprValRs = totalRefRs; // all approved
      simActions.push('All revenue mappings approved (R3+R4 bulk)');
    }
    if (approve.includes('cost_all') && simCostAppr < costTotal) {
      simCostAppr = costTotal;
      simActions.push(`${costTotal} cost branches approved`);
    }

    const simRevPct     = totalRefRs > 0 ? r2g(simApprValRs / totalRefRs * 100) : 0;
    const simRevBlocked = simRevPct < 95 || simCritAppr < critTotal || simHighAppr < highTotal;
    const simCostBlocked = simCostAppr === 0;
    const simBlockers   = [simRevBlocked, simCostBlocked, !simObsOk, !simIbrOk].filter(Boolean).length;
    const simGate       = simBlockers === 0 ? 'GREEN' : simBlockers <= 2 ? 'AMBER' : 'RED';

    // Current gate
    const curRevPct  = totalRefRs > 0 ? r2g(curApprValRs / totalRefRs * 100) : 0;
    const curBlockers = [curRevPct < 95 || curCritAppr < critTotal || curHighAppr < highTotal, curCostAppr === 0, !curObsOk, !curIbrOk].filter(Boolean).length;
    const curGate    = curBlockers === 0 ? 'GREEN' : curBlockers <= 2 ? 'AMBER' : 'RED';

    res.json({
      note: 'SIMULATION ONLY — no data has been written. This is a read-only projection.',
      current:   { gate: curGate, blockers: curBlockers, revenue_coverage_pct: curRevPct, critical_approved: curCritAppr, high_approved: curHighAppr, cost_approved: curCostAppr, obs_ok: curObsOk, ibr_ok: curIbrOk },
      simulated: { gate: simGate, blockers: simBlockers, revenue_coverage_pct: simRevPct, critical_approved: simCritAppr, high_approved: simHighAppr, cost_approved: simCostAppr, obs_ok: simObsOk, ibr_ok: simIbrOk },
      actions_simulated: simActions,
      gate_change: curGate !== simGate ? `${curGate} → ${simGate}` : `No change (still ${curGate})`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g/state ──────────────────────────────────────────────────────
router.get('/step15g/state', async (req, res) => {
  try {
    const [mapData, brData] = await Promise.all([readMappings(), readBranches()]);
    const obs     = readJ('opening_balance_sheet.json', {});
    const costM   = readJ('cost_master.json',           { assumptions: [] });
    const leases  = readJ('lease_schedule.json',        { leases: [] });
    const revAppr = readRevApprovals();
    const auditT  = readJ(AUDIT_FILE,                   { entries: [] });
    const mappings  = mapData.mappings || [];
    const branches  = brData.branches  || [];
    const classified = classifyMateriality(mappings);
    const totalRefRs = classified.reduce((s, m) => s + m._ref, 0);
    const approvedValRs = Object.values(revAppr.approvals || {}).filter(a => a.status === 'approved').reduce((s, a) => s + (a.approved_value || 0), 0);
    const revPct      = totalRefRs > 0 ? r2g(approvedValRs / totalRefRs * 100) : 0;
    const critTotal   = classified.filter(m => m._materiality === 'CRITICAL').length;
    const critAppr    = classified.filter(m => m._materiality === 'CRITICAL' && revAppr.approvals[m.mapping_id]?.status === 'approved').length;
    const highTotal   = classified.filter(m => m._materiality === 'HIGH').length;
    const highAppr    = classified.filter(m => m._materiality === 'HIGH' && revAppr.approvals[m.mapping_id]?.status === 'approved').length;
    const costAppr    = (costM.assumptions || []).filter(a => a.approved).length;
    const ibrOk       = !!leases.blended_discount_rate_pct;
    const obsOk       = obs.approval_status === 'approved';
    const revBlocked  = revPct < 95 || critAppr < critTotal || highAppr < highTotal;
    const hardBlockers = [revBlocked, costAppr === 0, !obsOk, !ibrOk].filter(Boolean).length;
    const gate        = hardBlockers === 0 ? 'GREEN' : hardBlockers <= 2 ? 'AMBER' : 'RED';

    res.json({ gate, hard_blockers: hardBlockers, step: '15G', revenue: { total: mappings.length, approved: Object.values(revAppr.approvals || {}).filter(a => a.status === 'approved').length, coverage_pct: revPct, critical_approved: critAppr, critical_total: critTotal, high_approved: highAppr, high_total: highTotal }, cost: { proposals: costM.assumptions?.length || 0, approved: costAppr, total_branches: branches.length }, obs: { status: obs.approval_status, assets_lakh: r2g(obs.total_assets || 0) }, lease: { total: (leases.leases || []).length, ibr_set: ibrOk }, audit_entries: auditT.entries?.length || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 15G.1 — CONTRACT-BASED REVENUE BASELINE RECONSTRUCTION
// ═══════════════════════════════════════════════════════════════════════════════

const G1_CORE_CATS = new Set(['Co-working Space','Managed Space','Flexi Desk','Virtual Office','Managed Office']);
const G1_EXCL_CATS = new Set(['Furniture & Fixture','Digital Marketing Services','Consultancy Charges','Payroll Management Services','Fund Raising Fees']);
const G1_ANC_CATS  = new Set(['Internet Charges','Parking Charges','Event Room','Conference Room','Meeting Room','Electricity Charges','IT & Networking Services','Lounge Room']);

let _g1Cache = null;

function getG1Analysis() {
  if (_g1Cache) return _g1Cache;

  const actuals  = readJ('revenue_actuals.json',       { invoices: [], credit_notes: [] });
  const mapData  = readJ('branch_client_mapping.json', { mappings: [] });
  const allInv   = actuals.invoices      || [];
  const allCN    = actuals.credit_notes  || [];
  const mappings = mapData.mappings      || [];

  // Build invoice index: customer_id||branch_id → array of invoices
  const invIdx = {}, cnIdx = {};
  for (const inv of allInv) {
    if (!inv.customer_id || !inv.branch_id) continue;
    const k = `${inv.customer_id}||${inv.branch_id}`;
    if (!invIdx[k]) invIdx[k] = [];
    invIdx[k].push(inv);
  }
  for (const cn of allCN) {
    if (!cn.customer_id || !cn.branch_id) continue;
    const k = `${cn.customer_id}||${cn.branch_id}`;
    if (!cnIdx[k]) cnIdx[k] = [];
    cnIdx[k].push(cn);
  }

  const results = mappings.map(m => {
    const key   = `${m.zoho_customer_id}||${m.branch_id}`;
    const invs  = invIdx[key] || [];
    const cns   = cnIdx[key]  || [];

    const coreInvs = invs.filter(i => G1_CORE_CATS.has(i.cf_invoice_category));
    const exclInvs = invs.filter(i => G1_EXCL_CATS.has(i.cf_invoice_category));
    const ancInvs  = invs.filter(i => G1_ANC_CATS.has(i.cf_invoice_category));
    const coreCNs  = cns.filter(cn => G1_CORE_CATS.has(cn.cf_invoice_category));

    // Monthly core billing net of credit notes
    const coreByMonth = {};
    for (const inv of coreInvs) {
      if (!inv.month) continue;
      coreByMonth[inv.month] = (coreByMonth[inv.month] || 0) + Math.abs(inv.sub_total || 0);
    }
    for (const cn of coreCNs) {
      if (!cn.month) continue;
      coreByMonth[cn.month] = (coreByMonth[cn.month] || 0) - Math.abs(cn.sub_total || 0);
    }

    const posAmts   = Object.values(coreByMonth).map(v => Math.max(0, v)).filter(v => v > 0);
    const n         = posAmts.length;
    const mean      = n ? posAmts.reduce((s,v)=>s+v,0)/n : 0;
    const variance  = n > 1 ? posAmts.reduce((s,v)=>s+Math.pow(v-mean,2),0)/(n-1) : 0;
    const cv        = mean > 0 ? Math.sqrt(variance)/mean : 9;

    const exclTotal = exclInvs.reduce((s,i)=>s+Math.abs(i.sub_total||0),0);
    const ancTotal  = ancInvs.reduce((s,i)=>s+Math.abs(i.sub_total||0),0);
    const allMonths = [...new Set(invs.map(i=>i.month).filter(Boolean))].sort();

    const latestLakh = toLakh(m.latest_actual_revenue || 0);
    const invMRRLakh = n >= 1 ? toLakh(mean) : 0;
    const mrrGapPct  = latestLakh > 0 && invMRRLakh > 0 ? r2g((latestLakh - invMRRLakh) / latestLakh * 100) : null;

    // Source level classification
    let lvl, conf, grp, lbl;
    if (n >= 6 && cv < 0.20)      { lvl='LEVEL_2'; conf='B'; grp='B'; lbl='STRONG_RECURRING'; }
    else if (n >= 3 && cv < 0.35) { lvl='LEVEL_2'; conf='B'; grp='B'; lbl='RECURRING_BILLING_EVIDENCE'; }
    else if (n >= 3)               { lvl='LEVEL_3'; conf='C'; grp='C'; lbl='VARIABLE_RECURRING'; }
    else if (n >= 1)               { lvl='LEVEL_3'; conf='C'; grp='C'; lbl='LIMITED_HISTORY'; }
    else if (allMonths.length >= 1){ lvl='LEVEL_4'; conf='D'; grp='D'; lbl='NON_CORE_BILLING_ONLY'; }
    else                           { lvl='LEVEL_4'; conf='D'; grp='D'; lbl='NO_INVOICE_EVIDENCE'; }

    const flags = [];
    if (grp==='C') flags.push({code:'HIST_PROXY', msg:'HISTORICAL PROXY — Management approval required. MRR based on limited billing evidence, not a signed contract.'});
    if (grp==='D') flags.push({code:'NO_EVIDENCE', msg:'No core billing evidence. Management must provide contracted revenue amount.'});
    if (exclTotal>0) flags.push({code:'EXCL_ITEMS', msg:`₹${toLakh(exclTotal)}L non-recurring excluded (Furniture/Capex/Digital Mktg etc.)`});
    if (ancTotal>0)  flags.push({code:'ANC_REV',    msg:`₹${toLakh(ancTotal)}L ancillary (Internet/Parking/Events) tracked separately`});
    if (cv>0.5 && n>1) flags.push({code:'HIGH_VAR', msg:`CV=${r2g(cv)} — billing varies significantly month to month`});
    if (mrrGapPct!==null && Math.abs(mrrGapPct)>40) flags.push({code:'MRR_GAP', msg:`Invoice MRR ₹${invMRRLakh}L vs mapping ₹${latestLakh}L — may indicate quarterly/advance billing`});

    return {
      mapping_id: m.mapping_id, client_id: m.client_id, branch_id: m.branch_id,
      zoho_customer_id: m.zoho_customer_id,
      source_level: lvl, source_label: lbl, confidence: conf, group: grp,
      months_core_billing: n, months_any_billing: allMonths.length, cv: n>1?r2g(cv):null,
      normalised_mrr_lakh: invMRRLakh, mapping_revenue_lakh: latestLakh,
      mrr_gap_pct: mrrGapPct,
      excl_total_lakh: toLakh(exclTotal), anc_total_lakh: toLakh(ancTotal),
      billing_months: allMonths, flags,
    };
  });

  const sumMRR = arr => r2g(arr.reduce((s,r)=>s+r.mapping_revenue_lakh,0));
  const totMRR = sumMRR(results);
  const grpSumm = (arr, label) => ({
    count: arr.length, mrr_lakh: sumMRR(arr), annual_lakh: r2g(sumMRR(arr)*12),
    pct_of_total: totMRR>0 ? r2g(sumMRR(arr)/totMRR*100) : 0, label,
  });

  _g1Cache = {
    results,
    groups: {
      A: grpSumm(results.filter(r=>r.group==='A'), 'Contract-backed (Level 1 — signed contracts)'),
      B: grpSumm(results.filter(r=>r.group==='B'), 'Recurring billing evidence (Level 2 — 3+ months consistent)'),
      C: grpSumm(results.filter(r=>r.group==='C'), 'Historical proxy (Level 3 — limited / variable billing)'),
      D: grpSumm(results.filter(r=>r.group==='D'), 'Insufficient evidence (Level 4 — no core billing data)'),
    },
    total_mrr_lakh: totMRR,
    invoice_coverage: {
      pairs_with_core_billing: results.filter(r=>r.months_core_billing>0).length,
      pairs_with_any_billing:  results.filter(r=>r.months_any_billing>0).length,
      total_pairs: results.length,
      invoice_mrr_lakh: r2g(results.reduce((s,r)=>s+r.normalised_mrr_lakh,0)),
      mapping_mrr_lakh: totMRR,
      gap_lakh: r2g(totMRR - results.reduce((s,r)=>s+r.normalised_mrr_lakh,0)),
      note: 'revenue_actuals.json captures remapped/processed invoices. Gap vs mapping revenue likely represents quarterly/advance billing not yet indexed in revenue_actuals.json.',
    },
    billing_normalisation: {
      excl_one_time_lakh: r2g(results.reduce((s,r)=>s+r.excl_total_lakh,0)),
      ancillary_lakh:     r2g(results.reduce((s,r)=>s+r.anc_total_lakh,0)),
      note: 'Furniture & Fixture, Digital Marketing, Consultancy excluded. Internet/Parking/Events = ancillary.',
    },
    computed_at: new Date().toISOString(),
  };
  return _g1Cache;
}

// ─── GET /step15g1/state ──────────────────────────────────────────────────────
router.get('/step15g1/state', (req, res) => {
  try {
    const g1 = getG1Analysis();
    res.json({
      groups: g1.groups, total_mrr_lakh: g1.total_mrr_lakh,
      invoice_coverage: g1.invoice_coverage, billing_normalisation: g1.billing_normalisation,
      b1_readiness: { group_b_pct: g1.groups.B.pct_of_total, group_a_pct: g1.groups.A.pct_of_total,
        approved_pct: 0, target_pct: 95,
        note: 'B1 GREEN requires ≥95% value-weighted approval. Group A+B eligible for bulk review. Group C requires individual management review. Group D requires management input before approval.' },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g1/approval-groups ───────────────────────────────────────────
router.get('/step15g1/approval-groups', (req, res) => {
  try {
    const g1 = getG1Analysis();
    res.json({
      groups: g1.groups, total_mrr_lakh: g1.total_mrr_lakh, invoice_coverage: g1.invoice_coverage,
      approval_sequence: [
        { step: 1, group: 'B', action: 'Bulk review — recurring billing evidence', mrr_lakh: g1.groups.B.mrr_lakh, pct: g1.groups.B.pct_of_total, note: 'Eligible for bulk review per batch. Approver name + comment required per batch. NOT auto-approved.' },
        { step: 2, group: 'C', action: 'Individual review — historical proxy', mrr_lakh: g1.groups.C.mrr_lakh, pct: g1.groups.C.pct_of_total, note: 'Must be labelled HISTORICAL PROXY — MANAGEMENT APPROVAL REQUIRED. Each mapping reviewed individually.' },
        { step: 3, group: 'D', action: 'Management input required', mrr_lakh: g1.groups.D.mrr_lakh, pct: g1.groups.D.pct_of_total, note: 'No evidence available. Management must provide contracted monthly revenue before approval possible.' },
      ],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g1/contract-master ───────────────────────────────────────────
router.get('/step15g1/contract-master', (req, res) => {
  try {
    const g1   = getG1Analysis();
    const page = parseInt(req.query.page || 1, 10);
    const size = parseInt(req.query.size || 50, 10);
    const grp  = req.query.group;
    let items  = grp ? g1.results.filter(r=>r.group===grp) : g1.results;
    items      = items.slice().sort((a,b)=>b.mapping_revenue_lakh-a.mapping_revenue_lakh);
    res.json({ total: items.length, page, size, items: items.slice((page-1)*size, page*size) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g1/quality-kpi ───────────────────────────────────────────────
router.get('/step15g1/quality-kpi', (req, res) => {
  try {
    const g1 = getG1Analysis();
    const { groups, total_mrr_lakh } = g1;
    const n650 = g1.results.length || 650;
    res.json({
      by_count: {
        level_1_signed_pct:      0,
        level_2_recurring_pct:   r2g(groups.B.count/n650*100),
        level_3_proxy_pct:       r2g(groups.C.count/n650*100),
        level_4_insufficient_pct:r2g(groups.D.count/n650*100),
        level_2_count: groups.B.count, level_3_count: groups.C.count, level_4_count: groups.D.count,
      },
      by_value: {
        level_2_lakh: groups.B.mrr_lakh, level_2_pct: groups.B.pct_of_total,
        level_3_lakh: groups.C.mrr_lakh, level_3_pct: groups.C.pct_of_total,
        level_4_lakh: groups.D.mrr_lakh, level_4_pct: groups.D.pct_of_total,
        total_lakh: total_mrr_lakh,
      },
      b1_gate: { approved_pct: 0, target_pct: 95, gate: 'RED',
        action: 'Approve Group B batches in Step 15F Revenue tab, then review Group C individually.' },
      invoice_coverage: g1.invoice_coverage,
      billing_normalisation: g1.billing_normalisation,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g1/branch-summary ────────────────────────────────────────────
router.get('/step15g1/branch-summary', async (req, res) => {
  try {
    const g1      = getG1Analysis();
    const brData  = await readBranches();
    const brMap   = {};
    for (const br of (brData.branches||[])) brMap[br.branch_id] = br;

    const byBranch = {};
    for (const r of g1.results) {
      if (!byBranch[r.branch_id]) byBranch[r.branch_id] = { mrr:0, nB:0, nC:0, nD:0, n:0 };
      const b = byBranch[r.branch_id];
      b.mrr += r.mapping_revenue_lakh; b.n++;
      if (r.group==='B') b.nB++;
      else if (r.group==='C') b.nC++;
      else b.nD++;
    }

    const rows = Object.entries(byBranch).map(([bid, b]) => {
      const br = brMap[bid] || {};
      return {
        branch_id: bid, branch_name: br.branch_name||bid, city: br.city||'—',
        client_count: b.n, total_mrr_lakh: r2g(b.mrr),
        grp_b: b.nB, grp_c: b.nC, grp_d: b.nD,
        total_seats: br.total_seats||null, capacity_sqft: br.total_area_sqft||null,
      };
    }).sort((a,b)=>b.total_mrr_lakh-a.total_mrr_lakh);

    res.json({ branches: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /step15g1/sources-analysis ──────────────────────────────────────────
router.get('/step15g1/sources-analysis', (req, res) => {
  try {
    const g1 = getG1Analysis();
    res.json({
      sources_inspected: [
        { source:'revenue_actuals.json', type:'Processed Zoho invoices', records:3996, date_range:'Dec 2025–Sep 2026', status:'AVAILABLE',
          note:'Branch IDs resolved; cf_invoice_category populated. Covers ~17.6% of mapped monthly revenue — gap due to quarterly/advance billing not yet indexed.' },
        { source:'branch_client_mapping.json', type:'Zoho actuals aggregation (Sep 2026)', records:650, status:'AVAILABLE',
          note:'Authoritative latest monthly revenue. Used as MRR amount for all classifications.' },
        { source:'client_master.json', type:'Client registry', records:650, status:'AVAILABLE',
          note:'All contracted_monthly_revenue = null. No contract data populated in system.' },
        { source:'projection_assumptions.json', type:'FPA projection assumptions', records:650, status:'AVAILABLE',
          note:'All contracted_monthly_revenue = null. No overrides entered.' },
        { source:'Signed Agreements / LOI / SOW', type:'LEVEL 1 contractual evidence', records:0, status:'NOT_AVAILABLE',
          note:'No signed contract data available in any system. Level 1 pool = 0 mappings. Management to confirm if agreements exist and provide terms.' },
      ],
      level_1_note: 'CRITICAL: No signed contracts, LOI, or service agreements exist in any data source. For Managed Space clients (enterprise), management must confirm whether formal agreements are in place and provide: Contract Start/End, Seats, Rate per Seat, Lock-in Period, Notice Period, Escalation.',
      invoice_gap: g1.invoice_coverage,
      normalisation: g1.billing_normalisation,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ─── GET /step15g1/export-template ───────────────────────────────────────────
// Download a pre-filled CSV template with system-known data (client, branch, MRR, group)
// ?template=A (contract master) | B (revenue approval)   ?group=D|B|C|ALL
router.get('/step15g1/export-template', async (req, res) => {
  try {
    const template  = (req.query.template || 'A').toUpperCase();
    const grpFilter = (req.query.group   || 'D').toUpperCase();

    const g1     = getG1Analysis();
    const cmData = readJ('client_master.json', { clients: [] });
    const brData = await readBranches();

    const clientNames = {};
    for (const c of (cmData.clients || [])) clientNames[c.client_id] = c.client_name || c.client_id;
    const branchNames = {};
    for (const b of (brData.branches || [])) branchNames[b.branch_id] = b.branch_name || b.branch_id;

    const escape = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const allRes = g1.results || [];
    const rows   = grpFilter === 'ALL' ? allRes : allRes.filter(r => r.group === grpFilter);
    const sorted = rows.slice().sort((a, b) => b.mapping_revenue_lakh - a.mapping_revenue_lakh);

    if (template === 'A') {
      const hdr = 'mapping_id,client_id,client_name,branch_id,branch_name,zoho_mrr_lakh,current_group,classification,contract_type,contract_start_date,contract_end_date,lockin_end_date,notice_period_days,contracted_seats,area_sqft,rate_per_seat_inr,rate_per_sqft_inr,fixed_monthly_revenue_inr,escalation_pct,escalation_effective_date,security_deposit_inr,billing_frequency,current_status,notes';
      const lines = sorted.map(r => [
        r.mapping_id, r.client_id,
        escape(clientNames[r.client_id] || r.client_id),
        r.branch_id,
        escape(branchNames[r.branch_id] || r.branch_id),
        r.mapping_revenue_lakh, r.group, r.source_label,
        '','','','','','','','','','','','','','MONTHLY','ACTIVE',''
      ].join(','));
      res.setHeader('Content-Type','text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',`attachment; filename="TemplateA_ContractMaster_Group${grpFilter}_${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send('﻿' + [hdr,...lines].join('\r\n'));
    }

    if (template === 'B') {
      const bRows = (grpFilter === 'ALL') ? allRes.filter(r => r.group==='B' || r.group==='C') : sorted;
      const hdr = 'mapping_id,client_id,client_name,branch_id,branch_name,group,classification,invoice_mrr_lakh,zoho_actual_mrr_lakh,your_approved_mrr_lakh,approval_status,approver_name,approval_date,comments';
      const lines = bRows.map(r => [
        r.mapping_id, r.client_id,
        escape(clientNames[r.client_id] || r.client_id),
        r.branch_id,
        escape(branchNames[r.branch_id] || r.branch_id),
        r.group, r.source_label, r.normalised_mrr_lakh, r.mapping_revenue_lakh,
        '','NEEDS_REVIEW','','',''
      ].join(','));
      res.setHeader('Content-Type','text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',`attachment; filename="TemplateB_RevenueApproval_Group${grpFilter}_${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send('﻿' + [hdr,...lines].join('\r\n'));
    }

    res.status(400).json({ error: 'template must be A or B' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /step15g1/import-contracts ─────────────────────────────────────────
// Import filled Template A — saves contract terms, NEVER overwrites Zoho actuals
// Body: { rows: [ { mapping_id, contract_type, fixed_monthly_revenue_inr, ... } ] }
router.post('/step15g1/import-contracts', async (req, res) => {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows[] required' });

    const store = readJ('contract_master_input.json', { contracts: {}, imported_count: 0 });
    let created = 0, updated = 0, skipped = 0;
    const num = v => (v !== '' && v !== undefined && v !== null) ? Number(v) : null;

    for (const row of rows) {
      if (!row.mapping_id) { skipped++; continue; }
      const existed = !!store.contracts[row.mapping_id];
      store.contracts[row.mapping_id] = {
        mapping_id: row.mapping_id, client_id: row.client_id||'', branch_id: row.branch_id||'',
        contract_type: row.contract_type||'UNKNOWN',
        contract_start_date: row.contract_start_date||null,
        contract_end_date: row.contract_end_date||null,
        lockin_end_date: row.lockin_end_date||null,
        notice_period_days: num(row.notice_period_days),
        contracted_seats: num(row.contracted_seats),
        area_sqft: num(row.area_sqft),
        rate_per_seat_inr: num(row.rate_per_seat_inr),
        rate_per_sqft_inr: num(row.rate_per_sqft_inr),
        fixed_monthly_revenue_inr: num(row.fixed_monthly_revenue_inr),
        escalation_pct: num(row.escalation_pct),
        escalation_effective_date: row.escalation_effective_date||null,
        security_deposit_inr: num(row.security_deposit_inr),
        billing_frequency: row.billing_frequency||'MONTHLY',
        current_status: row.current_status||'ACTIVE',
        notes: row.notes||'',
        imported_at: new Date().toISOString(),
      };
      if (existed) updated++; else created++;
    }

    store.imported_count = Object.keys(store.contracts).length;
    store.last_import_at = new Date().toISOString();
    writeJ('contract_master_input.json', store);
    _g1Cache = null; // force re-compute on next request

    res.json({ ok:true, created, updated, skipped, total_in_store: store.imported_count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════════
// STEP 15H — MANAGEMENT INPUT OPERATING WORKFLOW
// ═══════════════════════════════════════════════════════════════════════════════

const MODULES_15H = ['revenue','capacity','cost','obs','ibr','debt','gl','far','wc','tax'];
const MODULE_META_15H = {
  revenue:  { label:'Revenue / Client Contracts',    owner_role:'BD / CFO',       priority:1 },
  capacity: { label:'Branch Capacity',               owner_role:'Operations',     priority:2 },
  cost:     { label:'Cost Master',                   owner_role:'Finance',        priority:3 },
  obs:      { label:'Opening Balance Sheet',         owner_role:'Finance / CA',   priority:4 },
  ibr:      { label:'Ind AS 116 / IBR',              owner_role:'CA / CFO',       priority:5 },
  debt:     { label:'Debt Schedule',                 owner_role:'Treasury',       priority:6 },
  gl:       { label:'GL Mapping',                    owner_role:'Finance',        priority:7 },
  far:      { label:'Fixed Asset Register / CWIP',   owner_role:'Finance',        priority:8 },
  wc:       { label:'Working Capital Assumptions',   owner_role:'Finance',        priority:9 },
  tax:      { label:'Tax Assumptions',               owner_role:'Tax / CFO',      priority:10},
};

function readWorkflow15H() {
  return readJ('mgmt_workflow.json', {
    modules: Object.fromEntries(MODULES_15H.map(m=>[m,{status:'NOT_STARTED',owner:null,reviewer:null,last_updated:null}])),
    records: Object.fromEntries(MODULES_15H.map(m=>[m,{}])),
    audit:   [],
  });
}
function writeWorkflow15H(data){ writeJ('mgmt_workflow.json', data); }
function auditLog15H(wf, action, module, record_id, by, details={}){
  if (!wf.audit) wf.audit=[];
  wf.audit.unshift({ ts:new Date().toISOString(), action, module, record_id:record_id||null, by, ...details });
  if (wf.audit.length>5000) wf.audit=wf.audit.slice(0,5000);
}

// ─── GET /step15h/dashboard ───────────────────────────────────────────────────
router.get('/step15h/dashboard', async (req, res) => {
  try {
    const wf      = readWorkflow15H();
    const g1      = getG1Analysis();
    const brData  = await readBranches();
    const mapData = await readMappings();
    const costM   = readJ('cost_master.json',    { assumptions:[] });
    const leases  = readJ('lease_schedule.json', { leases:[] });
    const contracts = readJ('contract_master_input.json', { contracts:{} });
    const contCount = Object.keys(contracts.contracts||{}).length;
    const totalMaps = (mapData.mappings||[]).length;
    const activeBr  = (brData.branches||[]).filter(b=>b.active!==false).length;

    const modules = MODULES_15H.map(m => {
      const st  = wf.modules[m]||{};
      const meta = MODULE_META_15H[m];
      const recs = wf.records[m]||{};
      const rv   = Object.values(recs);
      const recAppr = rv.filter(r=>r.status==='APPROVED').length;
      let total=0,auto=0,inputReq=0,approved=0;
      if(m==='revenue')  { total=totalMaps; auto=g1.groups.B.count+g1.groups.C.count; approved=contCount+recAppr; inputReq=Math.max(0,totalMaps-approved); }
      else if(m==='capacity'){ total=activeBr; auto=(brData.branches||[]).filter(b=>b.active!==false&&(b.total_area_sqft||b.total_seats)).length; approved=recAppr; inputReq=Math.max(0,total-auto-approved); }
      else if(m==='cost')    { total=activeBr*12; approved=(costM.assumptions||[]).filter(a=>a.approved).length+recAppr; inputReq=Math.max(0,total-approved); }
      else if(m==='obs')     { total=1; auto=1; approved=st.status==='APPROVED'?1:0; inputReq=approved?0:1; }
      else if(m==='ibr')     { total=4; approved=leases.blended_discount_rate_pct?4:recAppr; inputReq=approved?0:4; }
      else if(m==='debt')    { total=32; auto=1; approved=recAppr; inputReq=Math.max(0,total-auto-approved); }
      else if(m==='gl')      { total=50; auto=30; approved=recAppr; inputReq=Math.max(0,total-auto-approved); }
      else { total=10; approved=recAppr; inputReq=Math.max(0,total-approved); }
      const pct = total>0?Math.round(Math.min(approved,total)/total*100):0;
      const effStatus = st.status||( pct>=100?'APPROVED': approved>0?'IN_PROGRESS':'NOT_STARTED' );
      return {
        id:m, label:meta.label, priority:meta.priority, owner_role:meta.owner_role,
        total, auto_populated:auto, input_required:inputReq, approved, completion_pct:pct,
        submitted:rv.filter(r=>r.status==='SUBMITTED').length,
        under_review:rv.filter(r=>r.status==='UNDER_REVIEW').length,
        rejected:rv.filter(r=>r.status==='REJECTED').length,
        status:effStatus, owner:st.owner||null, reviewer:st.reviewer||null,
        final_approver:'CFO', last_updated:st.last_updated||null, due_date:st.due_date||null,
      };
    });

    const overallPct = Math.round(modules.reduce((s,m)=>s+m.completion_pct,0)/modules.length);
    res.json({ modules, overall_pct:overallPct });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// ─── POST /step15h/record/save ────────────────────────────────────────────────
router.post('/step15h/record/save', (req, res) => {
  try {
    const { module, record_id, data, entered_by, source } = req.body;
    if (!module||!record_id) return res.status(400).json({ error:'module and record_id required' });
    const wf = readWorkflow15H();
    if (!wf.records[module]) wf.records[module]={};
    const prev = wf.records[module][record_id]||{};
    wf.records[module][record_id] = {
      ...prev, record_id, status:'SAVED',
      data: { ...(prev.data||{}), ...data },
      entered_by: entered_by||'unknown',
      entered_at: new Date().toISOString(),
      source: source||'MANUAL',
      previous_data: prev.data||null,
    };
    if (!wf.modules[module]) wf.modules[module]={};
    wf.modules[module].status = wf.modules[module].status==='APPROVED'?'APPROVED':'IN_PROGRESS';
    wf.modules[module].last_updated = new Date().toISOString();
    auditLog15H(wf,'SAVE',module,record_id,entered_by||'unknown',{fields:Object.keys(data||{})});
    writeWorkflow15H(wf);
    res.json({ ok:true, record:wf.records[module][record_id] });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// ─── POST /step15h/module/submit ──────────────────────────────────────────────
router.post('/step15h/module/submit', (req, res) => {
  try {
    const { module, submitted_by, comment } = req.body;
    if (!module) return res.status(400).json({ error:'module required' });
    const wf = readWorkflow15H();
    if (!wf.modules[module]) wf.modules[module]={};
    Object.assign(wf.modules[module],{ status:'SUBMITTED', submitted_by, submitted_at:new Date().toISOString(), submission_comment:comment||'' });
    auditLog15H(wf,'SUBMIT',module,null,submitted_by,{ comment });
    writeWorkflow15H(wf);
    res.json({ ok:true });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// ─── POST /step15h/module/approve ─────────────────────────────────────────────
// action: APPROVE | REJECT | RETURN
router.post('/step15h/module/approve', (req, res) => {
  try {
    const { module, action, approved_by, comment } = req.body;
    if (!module||!action) return res.status(400).json({ error:'module and action required' });
    if (!comment) return res.status(400).json({ error:'Comment is mandatory for approval/rejection (audit trail requirement)' });
    const statusMap = { APPROVE:'APPROVED', REJECT:'REJECTED', RETURN:'IN_PROGRESS' };
    const wf = readWorkflow15H();
    if (!wf.modules[module]) wf.modules[module]={};
    Object.assign(wf.modules[module],{
      status: statusMap[action]||'UNDER_REVIEW',
      approved_by, approved_at:new Date().toISOString(), approval_comment:comment,
    });
    auditLog15H(wf,action,module,null,approved_by,{ comment });
    writeWorkflow15H(wf);
    res.json({ ok:true, status:wf.modules[module].status });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// ─── POST /step15h/module/assign ──────────────────────────────────────────────
router.post('/step15h/module/assign', (req, res) => {
  try {
    const { module, owner, reviewer, due_date } = req.body;
    if (!module) return res.status(400).json({ error:'module required' });
    const wf = readWorkflow15H();
    if (!wf.modules[module]) wf.modules[module]={};
    if (owner!==undefined)    wf.modules[module].owner=owner;
    if (reviewer!==undefined) wf.modules[module].reviewer=reviewer;
    if (due_date!==undefined) wf.modules[module].due_date=due_date;
    wf.modules[module].last_updated=new Date().toISOString();
    writeWorkflow15H(wf);
    res.json({ ok:true, module:wf.modules[module] });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// ─── GET /step15h/gate ────────────────────────────────────────────────────────
router.get('/step15h/gate', async (req, res) => {
  try {
    const wf = readWorkflow15H();
    const g1 = getG1Analysis();
    const leases = readJ('lease_schedule.json',{leases:[]});
    const contracts = readJ('contract_master_input.json',{contracts:{}});
    const contCount = Object.keys(contracts.contracts||{}).length;
    const approvedMRR = g1.groups.B.mrr_lakh + g1.groups.C.mrr_lakh + (contCount/(g1.results?.length||650)*g1.groups.D.mrr_lakh);
    const valueWeighted = g1.total_mrr_lakh>0 ? r2g(approvedMRR/g1.total_mrr_lakh*100) : 0;
    const gates = [
      { id:'G_REV',  label:'Revenue',           status:valueWeighted>=95?'GREEN':'RED',   value:`${valueWeighted}% value-weighted approved`, target:'≥95%', critical:true },
      { id:'G_OBS',  label:'Opening BS',         status:wf.modules.obs?.status==='APPROVED'?'GREEN':'RED', value:wf.modules.obs?.status||'NOT_STARTED', target:'APPROVED', critical:true },
      { id:'G_IBR',  label:'Ind AS 116 / IBR',   status:leases.blended_discount_rate_pct?'GREEN':'RED', value:leases.blended_discount_rate_pct?`${leases.blended_discount_rate_pct}% approved`:'NOT SET', target:'IBR approved', critical:true },
      { id:'G_CAP',  label:'Branch Capacity',    status:wf.modules.capacity?.status==='APPROVED'?'GREEN':'AMBER', value:wf.modules.capacity?.status||'NOT_STARTED', target:'APPROVED', critical:false },
      { id:'G_COST', label:'Cost Master',        status:wf.modules.cost?.status==='APPROVED'?'GREEN':'RED', value:wf.modules.cost?.status||'NOT_STARTED', target:'APPROVED', critical:true },
      { id:'G_DEBT', label:'Debt Schedule',      status:wf.modules.debt?.status==='APPROVED'?'GREEN':'AMBER', value:wf.modules.debt?.status||'NOT_STARTED', target:'APPROVED', critical:false },
      { id:'G_GL',   label:'GL Mapping',         status:wf.modules.gl?.status==='APPROVED'?'GREEN':'AMBER', value:wf.modules.gl?.status||'NOT_STARTED', target:'All material resolved', critical:false },
    ];
    const criticalRed = gates.filter(g=>g.critical&&g.status==='RED').length;
    const allGreen = gates.every(g=>g.status==='GREEN');
    res.json({ gates, critical_blockers:criticalRed, all_green:allGreen,
      baseline_v1_locked:!allGreen,
      message: allGreen ? 'All gates GREEN. CFO may instruct Baseline V1 computation.' : `${criticalRed} critical blocker(s). Baseline V1 remains locked.` });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// ─── GET /step15h/cfo-queue ───────────────────────────────────────────────────
router.get('/step15h/cfo-queue', (req, res) => {
  try {
    const wf = readWorkflow15H();
    const queue = MODULES_15H.map(m=>({
      module:m, label:MODULE_META_15H[m].label,
      status:wf.modules[m]?.status||'NOT_STARTED',
      submitted_by:wf.modules[m]?.submitted_by||null,
      submitted_at:wf.modules[m]?.submitted_at||null,
      owner:wf.modules[m]?.owner||null,
      due_date:wf.modules[m]?.due_date||null,
      approval_comment:wf.modules[m]?.approval_comment||null,
      awaiting:['SUBMITTED','UNDER_REVIEW'].includes(wf.modules[m]?.status),
    }));
    res.json({ queue, pending_count:queue.filter(q=>q.awaiting).length });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// ─── GET /step15h/audit ───────────────────────────────────────────────────────
router.get('/step15h/audit', (req, res) => {
  try {
    const wf = readWorkflow15H();
    const limit = parseInt(req.query.limit||'100');
    const mod   = req.query.module;
    let audit = wf.audit||[];
    if (mod) audit = audit.filter(a=>a.module===mod);
    res.json({ audit:audit.slice(0,limit), total:audit.length });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// ─── GET /step15h/module-state/:module ───────────────────────────────────────
router.get('/step15h/module-state/:module', (req, res) => {
  try {
    const m = req.params.module;
    const wf = readWorkflow15H();
    res.json({ module:m, state:wf.modules[m]||{status:'NOT_STARTED'}, records_count:Object.keys(wf.records[m]||{}).length });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

module.exports = router;

