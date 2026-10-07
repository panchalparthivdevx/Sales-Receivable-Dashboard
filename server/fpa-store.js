/**
 * The FP&A step modules (fpa-step7.js, fpa-step8.js, step15.js) read and write their JSON
 * documents synchronously.
 *
 * Office PC (no DATABASE_URL): the files under server/ — callers keep their own file code.
 * Neon (Vercel): the same documents in kv_store, under the keys the rest of the app already
 * uses for them (fpa-routes, fpa-integrated, index.js …), so there is one copy of each.
 * They are held in memory: ensureLoaded() runs before every step 7/8/15 request and re-reads
 * only documents changed since; writes are saved in the background, in order.
 */
const path = require('path');
const db   = require('./db');
const { background } = require('./background');

const FPA = path.join(__dirname, 'fpa');

// server/fpa/<file> → key used by the other FP&A modules (KEYS in fpa-*.js / step15.js)
const FPA_KEYS = {
  'branch_master.json':          'fpa_branch_master',
  'client_master.json':          'fpa_client_master',
  'branch_client_mapping.json':  'fpa_branch_client_mapping',
  'occupancy_assumptions.json':  'fpa_occupancy_assumptions',
  'global_assumptions.json':     'fpa_global_assumptions',
  'ramp_templates.json':         'fpa_ramp_templates',
  'capex_master.json':           'fpa_capex_master',
  'cost_config.json':            'fpa_cost_config',
  'cost_master.json':            'fpa_cost_master',
  'cost_output.json':            'fpa_cost_output',
  'cost_overrides.json':         'fpa_cost_overrides',
  'deposit_master.json':         'fpa_deposit_master',
  'account_mapping.json':        'fpa_int_account_mapping',
  'asset_register.json':         'fpa_int_assets',
  'integrated_config.json':      'fpa_int_config',
  'corporate_cost_master.json':  'fpa_int_corp_cost',
  'debt_schedule.json':          'fpa_int_debt',
  'lease_schedule.json':         'fpa_int_lease',
  'open_items.json':             'fpa_int_open_items',
  'opening_balance_sheet.json':  'fpa_int_opening_bs',
  'integrated_output.json':      'fpa_int_output',
  'tax_params.json':             'fpa_int_tax_params',
  'wc_params.json':              'fpa_int_wc_params',
  'projection_assumptions.json': 'fpa_proj_assumptions',
  'projection_output.json':      'fpa_proj_output',
  'revenue_actuals.json':        'fpa_revenue_actuals',
  'revenue_sync_meta.json':      'fpa_revenue_sync_meta',
};
// Other server files the step modules read (keys used by index.js / sync-engine.js)
const OTHER_KEYS = {
  [path.join(__dirname, 'financial_bs_data.json')]: 'financial_bs_data',
  [path.join(__dirname, 'financial_pl_data.json')]: 'financial_pl_data',
  [path.join(__dirname, 'financial_tb_data.json')]: 'financial_tb_data',
  [path.join(__dirname, 'sync_data', 'bills_fy.json')]: 'sync_data_bills_fy',
};
const WANTED = new Set([...Object.values(FPA_KEYS), ...Object.values(OTHER_KEYS)]);
const STEP_PREFIX = 'fpa_file_';   // step-only documents (step7_state, step8_state, audit_trail, …)

// Key for a file path, or null if the store doesn't hold it
function keyOf(file) {
  const abs = path.resolve(file);
  if (OTHER_KEYS[abs]) return OTHER_KEYS[abs];
  if (path.dirname(abs) !== FPA) return null;
  const base = path.basename(abs);
  return FPA_KEYS[base] || STEP_PREFIX + base.replace(/\.json$/, '');
}

const _mem    = {};   // key → { at: ms of the stored version, value }
const _writes = {};   // key → promise chain
let _loading  = null;

async function ensureLoaded() {
  if (!db.USE_DB) return;
  if (_loading) return _loading;
  _loading = (async () => {
    const rows = [
      ...await db.listKeys('fpa_'),
      ...await db.listKeys('financial_'),
      ...await db.listKeys('sync_data_bills_fy'),
    ];
    for (const { key, updated_at } of rows) {
      if (!WANTED.has(key) && !key.startsWith(STEP_PREFIX)) continue;
      const at = new Date(updated_at).getTime();
      if (_mem[key] && _mem[key].at >= at) continue;
      await (_writes[key] || Promise.resolve());   // a pending save of ours lands first
      _mem[key] = { at, value: await db.readJSON(key, null, null) };
    }
  })().finally(() => { _loading = null; });
  return _loading;
}

// A copy, like a fresh file read, so callers can change it without touching the store
function read(file, fallback = null) {
  const key = keyOf(file);
  const v = key && _mem[key] ? _mem[key].value : null;
  return v == null ? fallback : structuredClone(v);
}

function write(file, data) {
  const key = keyOf(file);
  if (!key) throw new Error(`No database key for ${path.basename(file)}`);
  const value = structuredClone(data);
  _mem[key] = { at: Date.now(), value };
  _writes[key] = (_writes[key] || Promise.resolve())
    .then(() => db.writeJSON(key, null, value))
    .catch(e => console.warn(`[fpa-store] save failed for ${key}: ${e.message}`));
  background(_writes[key]);
}

module.exports = { enabled: db.USE_DB, ensureLoaded, read, write, keyOf };
