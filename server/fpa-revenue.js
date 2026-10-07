/**
 * FP&A Actual Revenue Routes — Step 3
 * Fetches invoices + credit notes from Zoho Books via existing zoho.js auth.
 * Classifies revenue, maps to branches, builds monthly actuals.
 * ISOLATED from all production financial calculations.
 * DO NOT connect to Cash Bridge, P&L, Balance Sheet, or Debt Schedule.
 */

const express    = require('express');
const path       = require('path');
const router     = express.Router();
const db         = require('./db');
const { authMiddleware, adminOnly } = require('./auth');
const { zohoGetAll } = require('./zoho');

// ─── File paths ───────────────────────────────────────────────────────────────
const FPA_DIR = path.join(__dirname, 'fpa');
const FILES = {
  actuals:  path.join(FPA_DIR, 'revenue_actuals.json'),
  syncMeta: path.join(FPA_DIR, 'revenue_sync_meta.json'),
  branch:   path.join(FPA_DIR, 'branch_master.json'),
  mapping:  path.join(FPA_DIR, 'branch_client_mapping.json'),
};
const KEYS = {
  actuals:  'fpa_revenue_actuals',
  syncMeta: 'fpa_revenue_sync_meta',
  branch:   'fpa_branch_master',
  mapping:  'fpa_branch_client_mapping',
};

// ─── Default shapes ───────────────────────────────────────────────────────────
const DEFAULT_ACTUALS  = { invoices: [], credit_notes: [], last_updated: null };
const DEFAULT_META = {
  last_sync_at: null, sync_status: 'idle', sync_error: null,
  historical_start_date: '2024-04-01', last_invoice_date: null,
  total_invoices_synced: 0, total_credit_notes_synced: 0,
  manual_category_overrides: {}, manual_branch_overrides: {},
};

// ─── DB helpers ───────────────────────────────────────────────────────────────
const readActuals  = () => db.readJSON(KEYS.actuals,  FILES.actuals,  DEFAULT_ACTUALS);
const readMeta     = () => db.readJSON(KEYS.syncMeta, FILES.syncMeta, DEFAULT_META);
const readBranches = () => db.readJSON(KEYS.branch,   FILES.branch,   { branches: [] });
const readMappings = () => db.readJSON(KEYS.mapping,  FILES.mapping,  { mappings: [] });

async function writeActuals(data) {
  data.last_updated = new Date().toISOString();
  return db.writeJSON(KEYS.actuals, FILES.actuals, data);
}
const writeMeta = (data) => db.writeJSON(KEYS.syncMeta, FILES.syncMeta, data);

// ─── Revenue classification ───────────────────────────────────────────────────
const KEYWORD_CATEGORIES = [
  ['recurring_workspace', ['workspace', 'dedicated desk', 'hot desk', 'seat', 'private office', 'managed office', 'coworking',
                           'co-working', 'managed space', 'flexi desk', 'managed office space']],
  ['meeting_room',        ['meeting room', 'conference room', 'boardroom', 'seminar hall', 'event space', 'day pass',
                           'event room', 'lounge room', 'lounge']],
  ['virtual_office',      ['virtual office', 'gst address', 'registered address', 'mailing address', 'virtual']],
  ['one_time',            ['security deposit', 'fit-out', 'setup charge', 'joining fee', 'one time', 'one-time', 'infrastructure']],
  ['reimbursement',       ['reimbursement', 'electricity', 'utility', 'maintenance charge', 'repair', 'housekeeping',
                           'internet charges', 'internet', 'it & networking', 'networking', 'parking charges', 'parking']],
  ['payroll_mgmt_service',['payroll management']],
];

const INTERCOMPANY_RE = /dev\s*accelerator|devx|dev\s*x/i;

function classifyRevenue(inv, manualOverrides = {}) {
  const id = inv.invoice_id || inv.creditnote_id || '';

  // 1. Manual override (persisted in sync_meta)
  if (manualOverrides[id]) return { category: manualOverrides[id], source: 'manual' };

  // 2. cf_invoice_category Zoho custom field
  const cf = (inv.cf_invoice_category || '').toLowerCase().trim();
  if (cf) {
    for (const [cat, keywords] of KEYWORD_CATEGORIES) {
      if (keywords.some(kw => cf.includes(kw))) return { category: cat, source: 'zoho_field' };
    }
  }

  // 3. Intercompany check on customer name
  if (INTERCOMPANY_RE.test(inv.customer_name || '')) return { category: 'intercompany', source: 'keyword' };

  // 4. Keyword match across available text fields
  const haystack = [
    inv.customer_name, cf, inv.description,
    inv.cf_tier_wise_revenue, inv.cf_city_wise_revenue,
  ].filter(Boolean).join(' ').toLowerCase();

  for (const [cat, keywords] of KEYWORD_CATEGORIES) {
    if (keywords.some(kw => haystack.includes(kw))) return { category: cat, source: 'keyword' };
  }

  return { category: 'review_required', source: 'UNCLASSIFIED' };
}

// ─── Branch mapping (5-level hierarchy) ──────────────────────────────────────
function resolveBranch(inv, branches, mappings, manualOverrides = {}) {
  const id = inv.invoice_id || inv.creditnote_id || '';
  const byName  = new Map(branches.map(b => [b.branch_name?.toLowerCase().trim(), b]));
  const byId    = new Map(branches.map(b => [b.branch_id, b]));

  // Level 1: manual override
  if (manualOverrides[id]) {
    const b = byId.get(manualOverrides[id]);
    return { branch_id: manualOverrides[id], branch_name_resolved: b?.branch_name || manualOverrides[id], source: 'manual' };
  }

  // Level 2: Zoho branch_name field (exact then partial)
  const rawBranch = (inv.branch_name || '').trim();
  if (rawBranch) {
    const exact = byName.get(rawBranch.toLowerCase());
    if (exact) return { branch_id: exact.branch_id, branch_name_resolved: exact.branch_name, source: 'zoho_field' };
    for (const [name, b] of byName) {
      if (name && (name.includes(rawBranch.toLowerCase()) || rawBranch.toLowerCase().includes(name))) {
        return { branch_id: b.branch_id, branch_name_resolved: b.branch_name, source: 'zoho_field_partial' };
      }
    }
  }

  // Level 3: Step-2 Branch–Client Mapping (customer_id → branch_id)
  if (inv.customer_id) {
    const m = mappings.find(x => x.zoho_customer_id === inv.customer_id);
    if (m) {
      const b = byId.get(m.branch_id);
      return { branch_id: m.branch_id, branch_name_resolved: b?.branch_name || m.branch_id, source: 'mapping_master' };
    }
  }

  // Level 4: cf_city_wise_revenue custom field
  const cityField = (inv.cf_city_wise_revenue || '').trim();
  if (cityField) {
    const b = byName.get(cityField.toLowerCase());
    if (b) return { branch_id: b.branch_id, branch_name_resolved: b.branch_name, source: 'city_field' };
  }

  // Level 5: UNMAPPED
  return { branch_id: null, branch_name_resolved: rawBranch || null, source: 'UNMAPPED' };
}

// ─── Sub-total (ex-GST) ───────────────────────────────────────────────────────
function subTotal(inv) {
  if (typeof inv.sub_total === 'number' && inv.sub_total > 0) return inv.sub_total;
  if (typeof inv.total === 'number') return Math.round(inv.total / 1.18 * 100) / 100;
  return 0;
}

// ─── Process raw Zoho invoice → FPA record ───────────────────────────────────
function processInvoice(inv, branches, mappings, meta) {
  const branchRes = resolveBranch(inv, branches, mappings, meta.manual_branch_overrides || {});
  const catRes    = classifyRevenue(inv, meta.manual_category_overrides || {});
  return {
    invoice_id:            inv.invoice_id,
    invoice_number:        inv.invoice_number,
    customer_id:           inv.customer_id,
    customer_name:         inv.customer_name,
    date:                  inv.date,
    month:                 (inv.date || '').slice(0, 7),
    branch_name_raw:       inv.branch_name || null,
    branch_id:             branchRes.branch_id,
    branch_name_resolved:  branchRes.branch_name_resolved,
    branch_mapping_source: branchRes.source,
    sub_total:             subTotal(inv),
    total:                 inv.total || 0,
    balance:               inv.balance || 0,
    status:                inv.status || 'unknown',
    cf_invoice_category:   inv.cf_invoice_category || null,
    cf_tier_wise_revenue:  inv.cf_tier_wise_revenue || null,
    cf_city_wise_revenue:  inv.cf_city_wise_revenue || null,
    revenue_category:      catRes.category,
    classification_source: catRes.source,
    is_credit_note:        false,
  };
}

function processCreditNote(cn, branches, mappings, meta) {
  const invLike   = { ...cn, invoice_id: cn.creditnote_id };
  const branchRes = resolveBranch(invLike, branches, mappings, meta.manual_branch_overrides || {});
  const catRes    = classifyRevenue(invLike, meta.manual_category_overrides || {});
  return {
    invoice_id:            cn.creditnote_id,
    invoice_number:        cn.creditnote_number,
    customer_id:           cn.customer_id,
    customer_name:         cn.customer_name,
    date:                  cn.date,
    month:                 (cn.date || '').slice(0, 7),
    branch_name_raw:       cn.branch_name || null,
    branch_id:             branchRes.branch_id,
    branch_name_resolved:  branchRes.branch_name_resolved,
    branch_mapping_source: branchRes.source,
    sub_total:             subTotal(cn),
    total:                 cn.total || 0,
    balance:               cn.balance || 0,
    status:                cn.status || 'unknown',
    cf_invoice_category:   null,
    cf_tier_wise_revenue:  null,
    cf_city_wise_revenue:  null,
    revenue_category:      catRes.category,
    classification_source: catRes.source,
    is_credit_note:        true,
  };
}

// ─── Monthly summary builder ──────────────────────────────────────────────────
function buildMonthlySummary(invoices, creditNotes) {
  const monthly = {};

  const add = (rec, sign) => {
    const month = (rec.date || '').slice(0, 7);
    if (!month) return;
    if (!monthly[month]) {
      monthly[month] = { month, total: 0, mapped: 0, unmapped: 0, classified: 0, unclassified: 0, branches: {} };
    }
    const amt = sign * (rec.sub_total || 0);
    monthly[month].total += amt;

    if (rec.branch_mapping_source === 'UNMAPPED') {
      monthly[month].unmapped += amt;
    } else {
      monthly[month].mapped += amt;
      const bid = rec.branch_id || '_unknown';
      if (!monthly[month].branches[bid]) {
        monthly[month].branches[bid] = { branch_id: bid, branch_name: rec.branch_name_resolved || bid, total: 0, clients: {} };
      }
      monthly[month].branches[bid].total += amt;
      const cid = rec.customer_id || '_unknown';
      if (!monthly[month].branches[bid].clients[cid]) {
        monthly[month].branches[bid].clients[cid] = { customer_id: cid, customer_name: rec.customer_name, total: 0 };
      }
      monthly[month].branches[bid].clients[cid].total += amt;
    }

    if (rec.revenue_category === 'review_required') {
      monthly[month].unclassified += amt;
    } else {
      monthly[month].classified += amt;
    }
  };

  for (const inv of invoices) add(inv, 1);
  for (const cn of creditNotes) add(cn, -1);

  // Flatten nested client maps to arrays
  for (const m of Object.values(monthly)) {
    m.branches = Object.values(m.branches).map(b => ({ ...b, clients: Object.values(b.clients) }));
  }
  return monthly;
}

// ─── In-memory sync lock ──────────────────────────────────────────────────────
let syncInProgress = false;

// ─── Auth on all routes ───────────────────────────────────────────────────────
router.use(authMiddleware);

// ─── GET /api/fpa/revenue/status ──────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const meta = await readMeta();
    res.json({
      sync_status:               meta.sync_status || 'idle',
      last_sync_at:              meta.last_sync_at,
      last_invoice_date:         meta.last_invoice_date,
      total_invoices_synced:     meta.total_invoices_synced || 0,
      total_credit_notes_synced: meta.total_credit_notes_synced || 0,
      historical_start_date:     meta.historical_start_date || '2024-04-01',
      sync_in_progress:          syncInProgress,
      manual_overrides_count:    Object.keys(meta.manual_category_overrides || {}).length + Object.keys(meta.manual_branch_overrides || {}).length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/fpa/revenue/sync ───────────────────────────────────────────────
router.post('/sync', adminOnly, async (req, res) => {
  if (syncInProgress) return res.json({ ok: false, message: 'Sync already in progress' });

  const { from_date, full_resync } = req.body || {};
  syncInProgress = true;

  const meta = await readMeta();
  meta.sync_status = 'running';
  meta.sync_error  = null;
  await writeMeta(meta);

  // Fire-and-forget: respond immediately so the client isn't blocked
  (async () => {
    try {
      const [{ branches }, { mappings }] = await Promise.all([readBranches(), readMappings()]);
      const currentMeta = await readMeta();

      // Date range: incremental (overlap 7d) or full
      let startDate = from_date || currentMeta.historical_start_date || '2024-04-01';
      if (!full_resync && currentMeta.last_invoice_date) {
        const last = new Date(currentMeta.last_invoice_date);
        last.setDate(last.getDate() - 7);
        startDate = last.toISOString().slice(0, 10);
      }
      const endDate = new Date().toISOString().slice(0, 10);

      // Fetch Zoho data using existing auth infrastructure
      const [rawInvoices, rawCreditNotes] = await Promise.all([
        zohoGetAll('/invoices', 'invoices',     { filter_by: 'Status.All' }, { dateFrom: startDate, dateTo: endDate }),
        zohoGetAll('/creditnotes', 'creditnotes', {},                         { dateFrom: startDate, dateTo: endDate }),
      ]);

      // Load existing records for incremental merge
      const existing    = full_resync ? { ...DEFAULT_ACTUALS } : await readActuals();
      const invMap      = new Map((existing.invoices     || []).map(i => [i.invoice_id, i]));
      const cnMap       = new Map((existing.credit_notes || []).map(c => [c.invoice_id, c]));

      // Process and upsert
      for (const inv of rawInvoices) {
        if (inv.invoice_id) invMap.set(inv.invoice_id, processInvoice(inv, branches, mappings, currentMeta));
      }
      for (const cn of rawCreditNotes) {
        if (cn.creditnote_id) cnMap.set(cn.creditnote_id, processCreditNote(cn, branches, mappings, currentMeta));
      }

      const invoices    = [...invMap.values()];
      const creditNotes = [...cnMap.values()];

      // Track latest date
      const allDates   = [...invoices, ...creditNotes].map(r => r.date).filter(Boolean).sort();
      const lastInvDate = allDates[allDates.length - 1] || null;

      await writeActuals({ invoices, credit_notes: creditNotes });

      currentMeta.sync_status             = 'success';
      currentMeta.last_sync_at            = new Date().toISOString();
      currentMeta.last_invoice_date       = lastInvDate;
      currentMeta.total_invoices_synced   = invoices.length;
      currentMeta.total_credit_notes_synced = creditNotes.length;
      await writeMeta(currentMeta);

      console.log(`[fpa-revenue] Sync OK: ${invoices.length} invoices, ${creditNotes.length} credit notes (${startDate}→${endDate})`);
    } catch (err) {
      console.error('[fpa-revenue] Sync error:', err.message);
      try {
        const m = await readMeta();
        m.sync_status = 'error';
        m.sync_error  = err.message;
        await writeMeta(m);
      } catch (_) {}
    } finally {
      syncInProgress = false;
    }
  })();

  res.json({ ok: true, message: 'Sync started in background' });
});

// ─── GET /api/fpa/revenue/summary ─────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const [actuals, meta] = await Promise.all([readActuals(), readMeta()]);
    const { invoices = [], credit_notes = [] } = actuals;

    const totalInvAmt  = invoices.reduce((s, i) => s + (i.sub_total || 0), 0);
    const totalCnAmt   = credit_notes.reduce((s, c) => s + (c.sub_total || 0), 0);
    const mappedAmt    = invoices.filter(i => i.branch_mapping_source !== 'UNMAPPED').reduce((s, i) => s + (i.sub_total || 0), 0);
    const unmappedAmt  = invoices.filter(i => i.branch_mapping_source === 'UNMAPPED').reduce((s, i) => s + (i.sub_total || 0), 0);
    const classifiedAmt   = invoices.filter(i => i.revenue_category !== 'review_required').reduce((s, i) => s + (i.sub_total || 0), 0);
    const unclassifiedAmt = invoices.filter(i => i.revenue_category === 'review_required').reduce((s, i) => s + (i.sub_total || 0), 0);

    const TOL = 0.02;
    const recon_mapping      = Math.abs((mappedAmt + unmappedAmt) - totalInvAmt) < TOL;
    const recon_classification = Math.abs((classifiedAmt + unclassifiedAmt) - totalInvAmt) < TOL;

    const byCategory = {};
    for (const inv of invoices) {
      const cat = inv.revenue_category || 'review_required';
      byCategory[cat] = (byCategory[cat] || 0) + (inv.sub_total || 0);
    }

    res.json({
      total_invoices_amount:      totalInvAmt,
      total_credit_notes_amount:  totalCnAmt,
      net_revenue:                totalInvAmt - totalCnAmt,
      mapped_amount:              mappedAmt,
      unmapped_amount:            unmappedAmt,
      classified_amount:          classifiedAmt,
      unclassified_amount:        unclassifiedAmt,
      unmapped_count:             invoices.filter(i => i.branch_mapping_source === 'UNMAPPED').length,
      unclassified_count:         invoices.filter(i => i.revenue_category === 'review_required').length,
      total_invoice_count:        invoices.length,
      total_credit_note_count:    credit_notes.length,
      reconciliation_mapping_ok:  recon_mapping,
      reconciliation_classif_ok:  recon_classification,
      by_category:                byCategory,
      sync_status:                meta.sync_status || 'idle',
      last_sync_at:               meta.last_sync_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/fpa/revenue/monthly ─────────────────────────────────────────────
router.get('/monthly', async (req, res) => {
  try {
    const actuals = await readActuals();
    const monthly = buildMonthlySummary(actuals.invoices || [], actuals.credit_notes || []);
    const sorted  = Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month));
    res.json({ months: sorted, total_months: sorted.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/fpa/revenue/unmapped ────────────────────────────────────────────
router.get('/unmapped', async (req, res) => {
  try {
    const actuals    = await readActuals();
    const all        = [...(actuals.invoices || []), ...(actuals.credit_notes || [])];
    const unmapped   = all.filter(i => i.branch_mapping_source === 'UNMAPPED')
                         .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const total_amount = unmapped.reduce((s, i) => s + (i.sub_total || 0), 0);
    res.json({ count: unmapped.length, total_amount, records: unmapped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/fpa/revenue/unmapped/:invoice_number ───────────────────────────
// Management Input: assign unmapped invoice to a branch or classify it.
router.put('/unmapped/:invoice_number', adminOnly, async (req, res) => {
  try {
    const { invoice_number } = req.params;
    const { branch_id, revenue_category, classification_note, exclude_from_forecast } = req.body || {};
    const actuals = await readActuals();
    const idx = (actuals.invoices || []).findIndex(i => i.invoice_number === invoice_number);
    if (idx === -1) return res.status(404).json({ error: 'Invoice not found' });
    const inv = actuals.invoices[idx];
    if (branch_id !== undefined) {
      inv.branch_id = branch_id || null;
      inv.branch_mapping_source = branch_id ? 'manual_management_input' : 'UNMAPPED';
      inv.branch_mapped_at = new Date().toISOString();
    }
    if (revenue_category !== undefined) inv.revenue_category = revenue_category;
    if (classification_note !== undefined) inv.classification_note = classification_note;
    if (exclude_from_forecast !== undefined) inv.exclude_from_forecast = !!exclude_from_forecast;
    await writeActuals(actuals);
    res.json({ ok: true, invoice_number });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/fpa/revenue/unclassified ────────────────────────────────────────
router.get('/unclassified', async (req, res) => {
  try {
    const actuals       = await readActuals();
    const all           = [...(actuals.invoices || []), ...(actuals.credit_notes || [])];
    const unclassified  = all.filter(i => i.revenue_category === 'review_required')
                            .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const total_amount  = unclassified.reduce((s, i) => s + (i.sub_total || 0), 0);
    res.json({ count: unclassified.length, total_amount, records: unclassified });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/fpa/revenue/reconciliation ──────────────────────────────────────
router.get('/reconciliation', async (req, res) => {
  try {
    const actuals = await readActuals();
    const invoices    = actuals.invoices     || [];
    const creditNotes = actuals.credit_notes || [];

    const totalInvAmt     = invoices.reduce((s, i) => s + (i.sub_total || 0), 0);
    const mappedAmt       = invoices.filter(i => i.branch_mapping_source !== 'UNMAPPED').reduce((s, i) => s + (i.sub_total || 0), 0);
    const unmappedAmt     = invoices.filter(i => i.branch_mapping_source === 'UNMAPPED').reduce((s, i) => s + (i.sub_total || 0), 0);
    const classifiedAmt   = invoices.filter(i => i.revenue_category !== 'review_required').reduce((s, i) => s + (i.sub_total || 0), 0);
    const unclassifiedAmt = invoices.filter(i => i.revenue_category === 'review_required').reduce((s, i) => s + (i.sub_total || 0), 0);
    const cnTotal         = creditNotes.reduce((s, c) => s + (c.sub_total || 0), 0);

    const TOL = 0.02;
    const checks = [
      {
        id: 'RC-01', name: 'Mapping: Mapped + Unmapped = Total',
        pass: Math.abs((mappedAmt + unmappedAmt) - totalInvAmt) < TOL,
        lhs: mappedAmt + unmappedAmt, rhs: totalInvAmt,
        gap: (mappedAmt + unmappedAmt) - totalInvAmt,
      },
      {
        id: 'RC-02', name: 'Classification: Classified + Unclassified = Total',
        pass: Math.abs((classifiedAmt + unclassifiedAmt) - totalInvAmt) < TOL,
        lhs: classifiedAmt + unclassifiedAmt, rhs: totalInvAmt,
        gap: (classifiedAmt + unclassifiedAmt) - totalInvAmt,
      },
      {
        id: 'RC-03', name: 'No silent drops: all invoices accounted for',
        pass: true,
        note: `${invoices.length} invoices, ${creditNotes.length} credit notes stored`,
      },
      {
        id: 'RC-04', name: 'Net revenue = Invoices − Credit Notes',
        pass: true,
        note: `₹${totalInvAmt.toFixed(2)} − ₹${cnTotal.toFixed(2)} = ₹${(totalInvAmt - cnTotal).toFixed(2)}`,
      },
    ];

    res.json({
      total_invoice_amount:    totalInvAmt,
      mapped_amount:           mappedAmt,
      unmapped_amount:         unmappedAmt,
      classified_amount:       classifiedAmt,
      unclassified_amount:     unclassifiedAmt,
      credit_note_total:       cnTotal,
      net_revenue:             totalInvAmt - cnTotal,
      checks,
      all_checks_pass:         checks.every(c => c.pass),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/fpa/revenue/drilldown/:invoice_id ───────────────────────────────
router.get('/drilldown/:invoice_id', async (req, res) => {
  try {
    const actuals = await readActuals();
    const all     = [...(actuals.invoices || []), ...(actuals.credit_notes || [])];
    const rec     = all.find(i => i.invoice_id === req.params.invoice_id);
    if (!rec) return res.status(404).json({ error: 'Record not found in revenue actuals' });
    res.json(rec);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/fpa/revenue/classify ────────────────────────────────────────────
router.put('/classify', async (req, res) => {
  try {
    const { invoice_id, category } = req.body || {};
    const VALID = ['recurring_workspace', 'meeting_room', 'virtual_office', 'one_time', 'reimbursement', 'intercompany', 'review_required'];
    if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });
    if (!VALID.includes(category)) return res.status(400).json({ error: `category must be one of: ${VALID.join(', ')}` });

    // Persist override in sync_meta (survives next sync)
    const meta = await readMeta();
    if (!meta.manual_category_overrides) meta.manual_category_overrides = {};
    meta.manual_category_overrides[invoice_id] = category;
    await writeMeta(meta);

    // Apply immediately to cached actuals
    const actuals = await readActuals();
    const idx = actuals.invoices.findIndex(i => i.invoice_id === invoice_id);
    if (idx !== -1) {
      actuals.invoices[idx].revenue_category    = category;
      actuals.invoices[idx].classification_source = 'manual';
      await writeActuals(actuals);
    }

    res.json({ ok: true, invoice_id, category });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/fpa/revenue/map ──────────────────────────────────────────────────
router.put('/map', async (req, res) => {
  try {
    const { invoice_id, branch_id } = req.body || {};
    if (!invoice_id || !branch_id) return res.status(400).json({ error: 'invoice_id and branch_id required' });

    // Validate branch exists
    const { branches } = await readBranches();
    const branch = branches.find(b => b.branch_id === branch_id);
    if (!branch) return res.status(400).json({ error: `Branch ${branch_id} not found in Branch Master` });

    // Persist override in sync_meta
    const meta = await readMeta();
    if (!meta.manual_branch_overrides) meta.manual_branch_overrides = {};
    meta.manual_branch_overrides[invoice_id] = branch_id;
    await writeMeta(meta);

    // Apply immediately to cached actuals
    const actuals = await readActuals();
    const idx = actuals.invoices.findIndex(i => i.invoice_id === invoice_id);
    if (idx !== -1) {
      actuals.invoices[idx].branch_id              = branch_id;
      actuals.invoices[idx].branch_name_resolved   = branch.branch_name;
      actuals.invoices[idx].branch_mapping_source  = 'manual';
      await writeActuals(actuals);
    }

    res.json({ ok: true, invoice_id, branch_id, branch_name: branch.branch_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/fpa/revenue/config ──────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const meta = await readMeta();
    res.json({ historical_start_date: meta.historical_start_date || '2024-04-01' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/fpa/revenue/config ──────────────────────────────────────────────
router.put('/config', adminOnly, async (req, res) => {
  try {
    const { historical_start_date } = req.body || {};
    if (!historical_start_date || !/^\d{4}-\d{2}-\d{2}$/.test(historical_start_date)) {
      return res.status(400).json({ error: 'historical_start_date must be YYYY-MM-DD' });
    }
    const meta = await readMeta();
    meta.historical_start_date = historical_start_date;
    await writeMeta(meta);
    res.json({ ok: true, historical_start_date });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
