/**
 * FP&A Master Data Routes — Step 2
 * Isolated from all production financial calculations.
 * All data stored in server/fpa/*.json (local) or kv_store (Neon DB).
 * No Zoho API calls in this module.
 */

const express  = require('express');
const path     = require('path');
const router   = express.Router();
const db       = require('./db');
const { authMiddleware, adminOnly } = require('./auth');

// ─── File paths ───────────────────────────────────────────────────────────────
const FPA_DIR = path.join(__dirname, 'fpa');
const FILES = {
  branch:      path.join(FPA_DIR, 'branch_master.json'),
  client:      path.join(FPA_DIR, 'client_master.json'),
  mapping:     path.join(FPA_DIR, 'branch_client_mapping.json'),
  occupancy:   path.join(FPA_DIR, 'occupancy_assumptions.json'),
  global:      path.join(FPA_DIR, 'global_assumptions.json'),
  ramp:        path.join(FPA_DIR, 'ramp_templates.json'),
};
const KEYS = {
  branch:    'fpa_branch_master',
  client:    'fpa_client_master',
  mapping:   'fpa_branch_client_mapping',
  occupancy: 'fpa_occupancy_assumptions',
  global:    'fpa_global_assumptions',
  ramp:      'fpa_ramp_templates',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function readBranches()  { return await db.readJSON(KEYS.branch,    FILES.branch,    { branches: [] }); }
async function readClients()   { return await db.readJSON(KEYS.client,    FILES.client,    { clients: [] }); }
async function readMappings()  { return await db.readJSON(KEYS.mapping,   FILES.mapping,   { mappings: [] }); }
async function readOccupancy() { return await db.readJSON(KEYS.occupancy, FILES.occupancy, { branch_templates: {}, overrides: {} }); }
async function readGlobal()    { return await db.readJSON(KEYS.global,    FILES.global,    {}); }
async function readRamp()      { return await db.readJSON(KEYS.ramp,      FILES.ramp,      { templates: {} }); }

const now = () => new Date().toISOString();

// ─── ID generators ────────────────────────────────────────────────────────────
function nextBranchId(branches) {
  const nums = branches.map(b => {
    const m = b.branch_id?.match(/^BR-(\d+)$/);
    return m ? parseInt(m[1]) : 0;
  });
  return `BR-${String((Math.max(0, ...nums) + 1)).padStart(3, '0')}`;
}
function nextClientId(clients) {
  const nums = clients.map(c => {
    const m = c.client_id?.match(/^CLT-(\d+)$/);
    return m ? parseInt(m[1]) : 0;
  });
  return `CLT-${String((Math.max(0, ...nums) + 1)).padStart(3, '0')}`;
}
function nextMappingId(mappings) {
  const nums = mappings.map(m => {
    const x = m.mapping_id?.match(/^MAP-(\d+)$/);
    return x ? parseInt(x[1]) : 0;
  });
  return `MAP-${String((Math.max(0, ...nums) + 1)).padStart(3, '0')}`;
}

// ─── Validation engine ────────────────────────────────────────────────────────
async function runValidations() {
  const [{ branches }, { clients }, { mappings }, occ, global] = await Promise.all([
    readBranches(), readClients(), readMappings(), readOccupancy(), readGlobal(),
  ]);

  const errors = [];
  const warnings = [];
  const info = [];

  const branchIds   = new Set(branches.map(b => b.branch_id));
  const clientIds   = new Set(clients.map(c => c.client_id));
  const modelStart  = new Date(global.model_start_date || '2026-10-01');
  const modelEnd    = new Date(global.model_end_date   || '2029-03-31');

  // V1 — Duplicate branch IDs
  const bIdCounts = {};
  branches.forEach(b => { bIdCounts[b.branch_id] = (bIdCounts[b.branch_id] || 0) + 1; });
  Object.entries(bIdCounts).filter(([, c]) => c > 1).forEach(([id]) =>
    errors.push({ code: 'V01', level: 'error', entity: 'branch', id, message: `Duplicate Branch ID: ${id}` }));

  // V2 — Missing branch fields
  branches.forEach(b => {
    if (!b.branch_name)    errors.push({ code: 'V02a', level: 'error',   entity: 'branch', id: b.branch_id, message: `Branch ${b.branch_id}: missing branch_name` });
    if (!b.opening_date)   warnings.push({ code: 'V02b', level: 'warning', entity: 'branch', id: b.branch_id, message: `Branch ${b.branch_id}: missing opening_date` });
    if (!b.total_area_sqft || b.total_area_sqft <= 0)
      errors.push({ code: 'V02c', level: 'error', entity: 'branch', id: b.branch_id, message: `Branch ${b.branch_id}: total_area_sqft must be > 0` });
    if (b.revenue_capacity_sqft > b.total_area_sqft)
      errors.push({ code: 'V02d', level: 'error', entity: 'branch', id: b.branch_id, message: `Branch ${b.branch_id}: revenue_capacity_sqft exceeds total_area_sqft` });
    if (!b.revenue_per_sqft && !global.revenue_per_sqft)
      warnings.push({ code: 'V02e', level: 'warning', entity: 'branch', id: b.branch_id, message: `Branch ${b.branch_id}: no revenue_per_sqft (and no global default)` });
    if (!b.rent_per_sqft && !global.rent_per_sqft)
      warnings.push({ code: 'V02f', level: 'warning', entity: 'branch', id: b.branch_id, message: `Branch ${b.branch_id}: no rent_per_sqft (and no global default)` });
  });

  // V3 — Duplicate client IDs
  const cIdCounts = {};
  clients.forEach(c => { cIdCounts[c.client_id] = (cIdCounts[c.client_id] || 0) + 1; });
  Object.entries(cIdCounts).filter(([, c]) => c > 1).forEach(([id]) =>
    errors.push({ code: 'V03', level: 'error', entity: 'client', id, message: `Duplicate Client ID: ${id}` }));

  // V4 — Client missing required fields
  clients.forEach(c => {
    if (!c.client_name) errors.push({ code: 'V04a', level: 'error', entity: 'client', id: c.client_id, message: `Client ${c.client_id}: missing client_name` });
    if (!c.contract_start_date) warnings.push({ code: 'V04b', level: 'warning', entity: 'client', id: c.client_id, message: `Client ${c.client_id}: missing contract_start_date` });
    if (c.current_monthly_revenue !== undefined && c.current_monthly_revenue < 0)
      errors.push({ code: 'V04c', level: 'error', entity: 'client', id: c.client_id, message: `Client ${c.client_id}: negative current_monthly_revenue` });
    if (c.contract_end_date && c.contract_start_date && new Date(c.contract_end_date) <= new Date(c.contract_start_date))
      errors.push({ code: 'V04d', level: 'error', entity: 'client', id: c.client_id, message: `Client ${c.client_id}: contract_end_date is not after contract_start_date` });
  });

  // V5 — Mapping validations
  const dupMappingKeys = {};
  mappings.forEach(m => {
    // V5a — Branch exists
    if (m.branch_id && !branchIds.has(m.branch_id))
      errors.push({ code: 'V05a', level: 'error', entity: 'mapping', id: m.mapping_id, message: `Mapping ${m.mapping_id}: branch_id '${m.branch_id}' not found in Branch Master` });
    // V5b — Client exists
    if (m.client_id && !clientIds.has(m.client_id))
      errors.push({ code: 'V05b', level: 'error', entity: 'mapping', id: m.mapping_id, message: `Mapping ${m.mapping_id}: client_id '${m.client_id}' not found in Client Master` });
    // V5c — Branch active
    const branch = branches.find(b => b.branch_id === m.branch_id);
    if (branch && !branch.active && m.active)
      warnings.push({ code: 'V05c', level: 'warning', entity: 'mapping', id: m.mapping_id, message: `Mapping ${m.mapping_id}: client mapped to inactive branch '${m.branch_id}'` });
    // V5d — Duplicate active client-branch pair
    const key = `${m.client_id}::${m.branch_id}`;
    if (m.active) {
      if (dupMappingKeys[key]) {
        errors.push({ code: 'V05d', level: 'error', entity: 'mapping', id: m.mapping_id, message: `Duplicate active mapping: client '${m.client_id}' → branch '${m.branch_id}'` });
      }
      dupMappingKeys[key] = true;
    }
    // V5e — Allocation pct
    if (m.allocation_pct !== undefined && (m.allocation_pct < 0 || m.allocation_pct > 100))
      errors.push({ code: 'V05e', level: 'error', entity: 'mapping', id: m.mapping_id, message: `Mapping ${m.mapping_id}: allocation_pct ${m.allocation_pct}% is out of range 0–100` });
    // V5f — Unmapped (no branch_id)
    if (!m.branch_id || m.branch_id === '')
      errors.push({ code: 'V05f', level: 'error', entity: 'mapping', id: m.mapping_id, message: `Mapping ${m.mapping_id}: UNMAPPED — no branch_id assigned` });
  });

  // V6 — Clients with no mapping at all
  const mappedClientIds = new Set(mappings.filter(m => m.branch_id && m.active).map(m => m.client_id));
  clients.filter(c => c.active && !mappedClientIds.has(c.client_id)).forEach(c =>
    warnings.push({ code: 'V06', level: 'warning', entity: 'client', id: c.client_id, message: `Client ${c.client_id} (${c.client_name}): UNMAPPED — no active branch mapping` }));

  // V7 — Occupancy overrides > 100%
  Object.entries(occ.overrides || {}).forEach(([branchId, months]) => {
    Object.entries(months).forEach(([month, pct]) => {
      if (pct > 100)
        errors.push({ code: 'V07a', level: 'error', entity: 'occupancy', id: branchId, message: `Branch ${branchId} occupancy override for ${month} is ${pct}% — exceeds 100%` });
      if (pct < 0)
        errors.push({ code: 'V07b', level: 'error', entity: 'occupancy', id: branchId, message: `Branch ${branchId} occupancy override for ${month} is ${pct}% — negative value not allowed` });
      // V7c — occupancy before branch opening date
      const branch = branches.find(b => b.branch_id === branchId);
      if (branch && branch.opening_date && !branch.manual_occ_before_open) {
        const overrideDate = new Date(month + '-01');
        const openDate = new Date(branch.opening_date);
        if (overrideDate < openDate && pct > 0)
          warnings.push({ code: 'V07c', level: 'warning', entity: 'occupancy', id: branchId, message: `Branch ${branchId}: occupancy override ${month}=${pct}% set before opening date ${branch.opening_date}` });
      }
    });
  });

  // V8 — Revenue after client end date
  clients.forEach(c => {
    if (c.contract_end_date && c.active) {
      const endDate = new Date(c.contract_end_date);
      if (endDate > modelStart && endDate < modelEnd)
        info.push({ code: 'V08', level: 'info', entity: 'client', id: c.client_id, message: `Client ${c.client_id}: contract ends ${c.contract_end_date} within model period — revenue will stop at end date` });
    }
  });

  // V9 — Missing escalation assumption (info only — global default will apply)
  clients.filter(c => c.active && !c.escalation_pct).forEach(c =>
    info.push({ code: 'V09', level: 'info', entity: 'client', id: c.client_id, message: `Client ${c.client_id}: no client-level escalation — will use branch or global default (${global.revenue_escalation_pct || 5}%)` }));

  // V10 — Global assumption completeness
  if (!global.model_start_date) errors.push({ code: 'V10a', level: 'error', entity: 'global', id: 'global', message: 'Global: model_start_date is not set' });
  if (!global.revenue_per_sqft && branches.some(b => !b.revenue_per_sqft))
    warnings.push({ code: 'V10b', level: 'warning', entity: 'global', id: 'global', message: 'Global: revenue_per_sqft not set and some branches have no override' });

  return {
    summary: {
      errors:   errors.length,
      warnings: warnings.length,
      info:     info.length,
      total:    errors.length + warnings.length + info.length,
      status:   errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
    },
    issues: [...errors, ...warnings, ...info],
  };
}

// ─── ALL ROUTES REQUIRE AUTH ──────────────────────────────────────────────────
router.use(authMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// BRANCH MASTER
// ─────────────────────────────────────────────────────────────────────────────

router.get('/branch-master', async (req, res) => {
  try {
    const data = await readBranches();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/branch-master', async (req, res) => {
  try {
    const data = await readBranches();
    const body = req.body;

    // Validate required
    if (!body.branch_name) return res.status(400).json({ error: 'branch_name is required' });
    if (!body.total_area_sqft || body.total_area_sqft <= 0) return res.status(400).json({ error: 'total_area_sqft must be > 0' });

    // Auto-generate ID if not provided
    const branch_id = (body.branch_id && body.branch_id.trim())
      ? body.branch_id.trim()
      : nextBranchId(data.branches);

    // Check uniqueness
    if (data.branches.some(b => b.branch_id === branch_id))
      return res.status(400).json({ error: `Branch ID '${branch_id}' already exists` });

    const branch = {
      branch_id,
      branch_name:             body.branch_name || '',
      city:                    body.city || '',
      state:                   body.state || '',
      branch_status:           body.branch_status || 'existing',
      opening_date:            body.opening_date || null,
      closing_date:            body.closing_date || null,
      total_area_sqft:         Number(body.total_area_sqft) || 0,
      revenue_capacity_sqft:   Number(body.revenue_capacity_sqft) || Number(body.total_area_sqft) || 0,
      current_occupancy_pct:   body.current_occupancy_pct !== undefined ? Number(body.current_occupancy_pct) : null,
      target_occupancy_pct:    body.target_occupancy_pct  !== undefined ? Number(body.target_occupancy_pct)  : 100,
      occupancy_ramp_template: body.occupancy_ramp_template || 'base',
      revenue_per_sqft:        body.revenue_per_sqft  !== undefined ? Number(body.revenue_per_sqft)  : null,
      rent_per_sqft:           body.rent_per_sqft     !== undefined ? Number(body.rent_per_sqft)     : null,
      other_opex_per_sqft:     body.other_opex_per_sqft !== undefined ? Number(body.other_opex_per_sqft) : null,
      capex_per_sqft:          body.capex_per_sqft    !== undefined ? Number(body.capex_per_sqft)    : null,
      security_deposit_months: body.security_deposit_months !== undefined ? Number(body.security_deposit_months) : null,
      capex_lead_months:       body.capex_lead_months  !== undefined ? Number(body.capex_lead_months)  : null,
      deposit_lead_months:     body.deposit_lead_months !== undefined ? Number(body.deposit_lead_months) : null,
      revenue_escalation_pct:  body.revenue_escalation_pct !== undefined ? Number(body.revenue_escalation_pct) : null,
      rent_escalation_pct:     body.rent_escalation_pct   !== undefined ? Number(body.rent_escalation_pct)   : null,
      opex_escalation_pct:     body.opex_escalation_pct   !== undefined ? Number(body.opex_escalation_pct)   : null,
      depreciation_life_months: body.depreciation_life_months !== undefined ? Number(body.depreciation_life_months) : null,
      zoho_branch_tag:         body.zoho_branch_tag || null,
      manual_occ_before_open:  !!body.manual_occ_before_open,
      active:                  body.active !== false,
      data_source:             body.data_source || 'manual',
      notes:                   body.notes || '',
      last_updated:            now(),
    };

    data.branches.push(branch);
    data.last_updated = now();
    await db.writeJSON(KEYS.branch, FILES.branch, data);
    res.status(201).json(branch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/branch-master/:id', async (req, res) => {
  try {
    const data = await readBranches();
    const idx  = data.branches.findIndex(b => b.branch_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Branch not found' });

    const existing = data.branches[idx];
    const body = req.body;

    // Prevent changing the branch_id
    const merged = { ...existing, ...body, branch_id: existing.branch_id, last_updated: now() };

    // Coerce numbers
    ['total_area_sqft','revenue_capacity_sqft','current_occupancy_pct','target_occupancy_pct',
     'revenue_per_sqft','rent_per_sqft','other_opex_per_sqft','capex_per_sqft',
     'security_deposit_months','capex_lead_months','deposit_lead_months',
     'revenue_escalation_pct','rent_escalation_pct','opex_escalation_pct','depreciation_life_months']
      .forEach(k => { if (merged[k] !== null && merged[k] !== undefined) merged[k] = Number(merged[k]); });

    if (merged.total_area_sqft <= 0) return res.status(400).json({ error: 'total_area_sqft must be > 0' });

    data.branches[idx] = merged;
    data.last_updated  = now();
    await db.writeJSON(KEYS.branch, FILES.branch, data);
    res.json(merged);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/branch-master/:id', adminOnly, async (req, res) => {
  try {
    const data = await readBranches();
    const idx  = data.branches.findIndex(b => b.branch_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Branch not found' });

    // Check if any active mappings exist for this branch
    const { mappings } = await readMappings();
    const hasMapping = mappings.some(m => m.branch_id === req.params.id && m.active);
    if (hasMapping) return res.status(400).json({ error: 'Cannot delete branch with active client mappings. Deactivate mappings first.' });

    data.branches.splice(idx, 1);
    data.last_updated = now();
    await db.writeJSON(KEYS.branch, FILES.branch, data);
    res.json({ deleted: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT MASTER
// ─────────────────────────────────────────────────────────────────────────────

router.get('/client-master', async (req, res) => {
  try {
    const data = await readClients();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client-master', async (req, res) => {
  try {
    const data = await readClients();
    const body = req.body;

    if (!body.client_name) return res.status(400).json({ error: 'client_name is required' });

    const client_id = (body.client_id && body.client_id.trim())
      ? body.client_id.trim()
      : nextClientId(data.clients);

    if (data.clients.some(c => c.client_id === client_id))
      return res.status(400).json({ error: `Client ID '${client_id}' already exists` });

    const client = {
      client_id,
      zoho_customer_id:       body.zoho_customer_id       || null,
      client_name:            body.client_name            || '',
      contract_start_date:    body.contract_start_date    || null,
      contract_end_date:      body.contract_end_date      || null,
      exit_date:              body.exit_date              || null,
      current_monthly_revenue: body.current_monthly_revenue !== undefined ? Number(body.current_monthly_revenue) : null,
      occupied_sqft:          body.occupied_sqft          !== undefined ? Number(body.occupied_sqft) : null,
      revenue_per_sqft:       body.revenue_per_sqft       !== undefined ? Number(body.revenue_per_sqft) : null,
      escalation_pct:         body.escalation_pct         !== undefined ? Number(body.escalation_pct) : null,
      escalation_effective_date: body.escalation_effective_date || null,
      escalation_frequency:   body.escalation_frequency   || 'annual',
      client_status:          body.client_status          || 'active',
      revenue_type:           body.revenue_type           || 'actual',
      data_source:            body.data_source            || 'manual',
      last_zoho_sync:         null,
      active:                 body.active !== false,
      notes:                  body.notes  || '',
      last_updated:           now(),
    };

    data.clients.push(client);
    data.last_updated = now();
    await db.writeJSON(KEYS.client, FILES.client, data);
    res.status(201).json(client);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client-master/:id', async (req, res) => {
  try {
    const data = await readClients();
    const idx  = data.clients.findIndex(c => c.client_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Client not found' });

    const merged = { ...data.clients[idx], ...req.body, client_id: data.clients[idx].client_id, last_updated: now() };
    ['current_monthly_revenue','occupied_sqft','revenue_per_sqft','escalation_pct']
      .forEach(k => { if (merged[k] !== null && merged[k] !== undefined) merged[k] = Number(merged[k]); });

    data.clients[idx] = merged;
    data.last_updated = now();
    await db.writeJSON(KEYS.client, FILES.client, data);
    res.json(merged);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client-master/:id', adminOnly, async (req, res) => {
  try {
    const data = await readClients();
    const idx  = data.clients.findIndex(c => c.client_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Client not found' });

    const { mappings } = await readMappings();
    if (mappings.some(m => m.client_id === req.params.id && m.active))
      return res.status(400).json({ error: 'Cannot delete client with active mappings. Deactivate mappings first.' });

    data.clients.splice(idx, 1);
    data.last_updated = now();
    await db.writeJSON(KEYS.client, FILES.client, data);
    res.json({ deleted: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// BRANCH-CLIENT MAPPING
// ─────────────────────────────────────────────────────────────────────────────

router.get('/mapping', async (req, res) => {
  try {
    const data = await readMappings();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mapping', async (req, res) => {
  try {
    const [mapData, { branches }, { clients }] = await Promise.all([readMappings(), readBranches(), readClients()]);
    const body = req.body;

    if (!body.client_id) return res.status(400).json({ error: 'client_id is required' });
    if (!body.branch_id) return res.status(400).json({ error: 'branch_id is required' });

    const client = clients.find(c => c.client_id === body.client_id);
    const branch = branches.find(b => b.branch_id === body.branch_id);
    if (!client) return res.status(400).json({ error: `Client ID '${body.client_id}' not found in Client Master` });
    if (!branch) return res.status(400).json({ error: `Branch ID '${body.branch_id}' not found in Branch Master` });

    // Check for duplicate active mapping
    const existing = mapData.mappings.find(m => m.client_id === body.client_id && m.branch_id === body.branch_id && m.active);
    if (existing) return res.status(400).json({ error: `Active mapping already exists: ${body.client_id} → ${body.branch_id}` });

    const mapping_id = nextMappingId(mapData.mappings);
    const mapping = {
      mapping_id,
      zoho_customer_id:    body.zoho_customer_id    || client.zoho_customer_id || null,
      client_id:           body.client_id,
      client_name:         client.client_name,
      branch_id:           body.branch_id,
      branch_name:         branch.branch_name,
      mapping_status:      body.mapping_status      || 'confirmed',
      mapping_source:      body.mapping_source      || 'manual',
      mapping_confidence:  body.mapping_confidence  || 'high',
      effective_from:      body.effective_from      || null,
      effective_to:        body.effective_to        || null,
      manual_override:     !!body.manual_override,
      allocation_pct:      body.allocation_pct !== undefined ? Number(body.allocation_pct) : 100,
      notes:               body.notes              || '',
      last_reviewed_date:  now(),
      active:              body.active !== false,
      last_updated:        now(),
    };

    mapData.mappings.push(mapping);
    mapData.last_updated = now();
    await db.writeJSON(KEYS.mapping, FILES.mapping, mapData);
    res.status(201).json(mapping);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/mapping/:id', async (req, res) => {
  try {
    const data = await readMappings();
    const idx  = data.mappings.findIndex(m => m.mapping_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Mapping not found' });

    const merged = { ...data.mappings[idx], ...req.body, mapping_id: data.mappings[idx].mapping_id, last_updated: now() };
    if (merged.allocation_pct !== null && merged.allocation_pct !== undefined) merged.allocation_pct = Number(merged.allocation_pct);
    if (merged.allocation_pct < 0 || merged.allocation_pct > 100) return res.status(400).json({ error: 'allocation_pct must be 0–100' });

    data.mappings[idx] = merged;
    data.last_updated  = now();
    await db.writeJSON(KEYS.mapping, FILES.mapping, data);
    res.json(merged);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/mapping/:id', adminOnly, async (req, res) => {
  try {
    const data = await readMappings();
    const idx  = data.mappings.findIndex(m => m.mapping_id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Mapping not found' });
    data.mappings.splice(idx, 1);
    data.last_updated = now();
    await db.writeJSON(KEYS.mapping, FILES.mapping, data);
    res.json({ deleted: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// OCCUPANCY ASSUMPTIONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/occupancy', async (req, res) => {
  try {
    const [occ, { branches }, ramp] = await Promise.all([readOccupancy(), readBranches(), readRamp()]);
    res.json({ ...occ, branches: branches.map(b => ({ branch_id: b.branch_id, branch_name: b.branch_name, opening_date: b.opening_date, branch_status: b.branch_status })), templates: ramp.templates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set/update a monthly occupancy override for a branch
router.post('/occupancy/override', async (req, res) => {
  try {
    const { branch_id, month, pct } = req.body; // month = "YYYY-MM", pct = number 0-100
    if (!branch_id || !month) return res.status(400).json({ error: 'branch_id and month are required' });

    const pctNum = Number(pct);
    if (isNaN(pctNum) || pctNum < 0) return res.status(400).json({ error: 'pct must be >= 0' });
    if (pctNum > 100) return res.status(400).json({ error: 'pct cannot exceed 100 (occupancy cap). Set manual_occ_before_open on the branch to allow pre-open overrides.' });

    const { branches } = await readBranches();
    if (!branches.find(b => b.branch_id === branch_id)) return res.status(400).json({ error: `Branch '${branch_id}' not found` });

    const occ = await readOccupancy();
    if (!occ.overrides) occ.overrides = {};
    if (!occ.overrides[branch_id]) occ.overrides[branch_id] = {};
    occ.overrides[branch_id][month] = pctNum;
    occ.last_updated = now();
    await db.writeJSON(KEYS.occupancy, FILES.occupancy, occ);
    res.json({ branch_id, month, pct: pctNum });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a monthly override (reverts to template)
router.delete('/occupancy/override', async (req, res) => {
  try {
    const { branch_id, month } = req.body;
    if (!branch_id || !month) return res.status(400).json({ error: 'branch_id and month are required' });
    const occ = await readOccupancy();
    if (occ.overrides?.[branch_id]?.[month] !== undefined) {
      delete occ.overrides[branch_id][month];
      occ.last_updated = now();
      await db.writeJSON(KEYS.occupancy, FILES.occupancy, occ);
    }
    res.json({ deleted: true, branch_id, month });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set branch-level ramp template
router.put('/occupancy/template', async (req, res) => {
  try {
    const { branch_id, template } = req.body;
    if (!branch_id || !template) return res.status(400).json({ error: 'branch_id and template are required' });
    const valid = ['conservative', 'base', 'aggressive', 'custom'];
    if (!valid.includes(template)) return res.status(400).json({ error: `template must be one of: ${valid.join(', ')}` });

    const { branches } = await readBranches();
    if (!branches.find(b => b.branch_id === branch_id)) return res.status(400).json({ error: `Branch '${branch_id}' not found` });

    const occ = await readOccupancy();
    if (!occ.branch_templates) occ.branch_templates = {};
    occ.branch_templates[branch_id] = template;
    occ.last_updated = now();
    await db.writeJSON(KEYS.occupancy, FILES.occupancy, occ);
    res.json({ branch_id, template });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk set occupancy overrides for a branch (for paste/import)
router.post('/occupancy/bulk', async (req, res) => {
  try {
    const { branch_id, overrides } = req.body; // overrides = { "2026-10": 70, "2026-11": 75, ... }
    if (!branch_id) return res.status(400).json({ error: 'branch_id is required' });
    if (!overrides || typeof overrides !== 'object') return res.status(400).json({ error: 'overrides must be an object' });

    const { branches } = await readBranches();
    if (!branches.find(b => b.branch_id === branch_id)) return res.status(400).json({ error: `Branch '${branch_id}' not found` });

    for (const [month, pct] of Object.entries(overrides)) {
      if (Number(pct) > 100) return res.status(400).json({ error: `Month ${month}: pct ${pct} exceeds 100%` });
      if (Number(pct) < 0)   return res.status(400).json({ error: `Month ${month}: pct ${pct} is negative` });
    }

    const occ = await readOccupancy();
    if (!occ.overrides) occ.overrides = {};
    if (!occ.overrides[branch_id]) occ.overrides[branch_id] = {};
    Object.assign(occ.overrides[branch_id], overrides);
    occ.last_updated = now();
    await db.writeJSON(KEYS.occupancy, FILES.occupancy, occ);
    res.json({ branch_id, updated: Object.keys(overrides).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL ASSUMPTIONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/global-assumptions', async (req, res) => {
  try { res.json(await readGlobal()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/global-assumptions', async (req, res) => {
  try {
    const current = await readGlobal();
    const updated = { ...current, ...req.body, last_updated: now() };
    // Coerce numeric fields
    ['revenue_escalation_pct','rent_escalation_pct','opex_escalation_pct',
     'revenue_per_sqft','rent_per_sqft','other_opex_per_sqft','capex_per_sqft',
     'security_deposit_months','capex_lead_months','deposit_lead_months','depreciation_life_months']
      .forEach(k => { if (updated[k] !== null && updated[k] !== undefined) updated[k] = Number(updated[k]); });

    await db.writeJSON(KEYS.global, FILES.global, updated);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// RAMP TEMPLATES (read-only via API; editing requires direct file change)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/ramp-templates', async (req, res) => {
  try { res.json(await readRamp()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

router.get('/validation', async (req, res) => {
  try { res.json(await runValidations()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY DASHBOARD STATS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
  try {
    const [{ branches }, { clients }, { mappings }, validation] = await Promise.all([
      readBranches(), readClients(), readMappings(), runValidations(),
    ]);
    const activeBranches = branches.filter(b => b.active);
    const activeClients  = clients.filter(c => c.active);
    const activeMap      = mappings.filter(m => m.active);
    const unmapped       = activeClients.filter(c => !activeMap.some(m => m.client_id === c.client_id));

    res.json({
      branches: { total: branches.length, active: activeBranches.length, existing: branches.filter(b => b.branch_status === 'existing').length, signed: branches.filter(b => b.branch_status === 'signed').length, pipeline: branches.filter(b => b.branch_status === 'pipeline').length },
      clients:  { total: clients.length, active: activeClients.length, unmapped: unmapped.length },
      mappings: { total: mappings.length, active: activeMap.length },
      validation: validation.summary,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
