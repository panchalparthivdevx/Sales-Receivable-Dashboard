/**
 * One-time upload of this PC's JSON data into Neon, under the same keys the app reads
 * through server/db.js. Local files are only read, never changed.
 *
 *   PowerShell:  $env:DATABASE_URL="postgres://…neon.tech/…"; node server/upload-to-neon.js
 *   Preview:     node server/upload-to-neon.js --dry-run      (lists what would be sent)
 *
 * Pass DATABASE_URL only for this command (not in .env), or this PC's server would
 * switch to Neon on its next restart.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
if (!DRY && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Example (PowerShell):\n  $env:DATABASE_URL="postgres://…"; node server/upload-to-neon.js');
  process.exit(1);
}
const db = require('./db');
const S  = (...p) => path.join(__dirname, ...p);

// key → file, exactly as the app's db.readJSON / db.writeJSON calls pair them
const STORES = {
  users:                    S('users.json'),
  agreements_data:          S('agreements_data.json'),
  bills_cache:              S('bills_cache.json'),
  branch_fy_actuals:        S('budget_branch_fy.json'),
  branch_fy_manual:         S('branch_fy_manual.json'),
  budget_actuals:           S('budget_actuals.json'),
  budget_data:              S('budget_data.json'),
  budget_mappings:          S('budget_mappings.json'),
  crm_actuals:              S('crm_actuals.json'),
  escrow_client_mapping:    S('escrow_client_mapping.json'),
  financial_bs_data:        S('financial_bs_data.json'),
  financial_mappings:       S('financial_mappings.json'),
  financial_pl_data:        S('financial_pl_data.json'),
  financial_tb_data:        S('financial_tb_data.json'),
  msme_form1_data:          S('msme_form1_data.json'),
  msme_interest_data:       S('msme_interest_data.json'),
  pocm_mapping:             S('pocm_mapping.json'),
  pocm_projects:            S('pocm_projects.json'),
  pocm_quarterly_estimates: S('pocm_quarterly_estimates.json'),
  pocm_quarter_locks:       S('pocm_quarter_locks.json'),
  pocm_sync_coverage:       S('pocm_sync_coverage.json'),
  portal_submissions:       S('portal_submissions.json'),
  rpt_ledger_mapping:       S('rpt_ledger_mapping.json'),
  rpt_loans:                S('rpt_loans.json'),
  rpt_doc_details:          S('rpt_doc_details.json'),
  rpt_ledger_txns:          S('rpt_ledger_txns.json'),
  rpt_zoho_options:         S('rpt_zoho_options.json'),
  rent_bill_details:        S('rent_bill_details.json'),
  pl_txn_branches:          S('pl_txn_branches.json'),
  vendor_registrations:     S('vendor_registrations.json'),
  sync_checkpoints:         S('sync_checkpoints.json'),
  sync_run_log:             S('sync_run_log.json'),
  gst_bill_detail_cache:    S('sync_data', 'gst_bill_detail_cache.json'),
  gst_vendor_pan_cache:     S('sync_data', 'gst_vendor_pan_cache.json'),
  msme_contact_map:         S('sync_data', 'msme_contact_map.json'),
  msme_form1_settlements:   S('sync_data', 'msme_form1_settlements.json'),
};

// Compliance store (server/compliance/lib/store.js NAMES)
const COMPLIANCE_DIR = process.env.COMPLIANCE_DATA_DIR || S('compliance', 'data');
for (const k of ['compliance_data', 'compliance_audit', 'compliance_zoho_sync', 'compliance_settings']) {
  STORES[k] = path.join(COMPLIANCE_DIR, `${k}.json`);
}

// FP&A (KEYS / FILES in fpa-*.js and step15.js)
const FPA = {
  fpa_branch_master: 'branch_master', fpa_client_master: 'client_master',
  fpa_branch_client_mapping: 'branch_client_mapping', fpa_occupancy_assumptions: 'occupancy_assumptions',
  fpa_global_assumptions: 'global_assumptions', fpa_ramp_templates: 'ramp_templates',
  fpa_capex_master: 'capex_master', fpa_cost_config: 'cost_config', fpa_cost_master: 'cost_master',
  fpa_cost_output: 'cost_output', fpa_cost_overrides: 'cost_overrides', fpa_deposit_master: 'deposit_master',
  fpa_int_account_mapping: 'account_mapping', fpa_int_assets: 'asset_register',
  fpa_int_config: 'integrated_config', fpa_int_corp_cost: 'corporate_cost_master',
  fpa_int_debt: 'debt_schedule', fpa_int_lease: 'lease_schedule', fpa_int_open_items: 'open_items',
  fpa_int_opening_bs: 'opening_balance_sheet', fpa_int_output: 'integrated_output',
  fpa_int_tax_params: 'tax_params', fpa_int_wc_params: 'wc_params',
  fpa_proj_assumptions: 'projection_assumptions', fpa_proj_output: 'projection_output',
  fpa_revenue_actuals: 'revenue_actuals', fpa_revenue_sync_meta: 'revenue_sync_meta',
};
for (const [k, f] of Object.entries(FPA)) STORES[k] = S('fpa', `${f}.json`);

// Synced Zoho entities: sync_data_<entity> ← sync_data/<entity>.json (sync-engine _syncDataKey)
for (const [k, def] of Object.entries(require('./sync-engine').ENTITY_DEFS)) {
  if (def.path) STORES[`sync_data_${k}`] = S('sync_data', `${k}.json`);
}

const readFile = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const mb = n => (n / 1048576).toFixed(1) + ' MB';

(async () => {
  if (!DRY) await db.initDB();
  let sent = 0, skipped = 0, bytes = 0;

  for (const [key, file] of Object.entries(STORES)) {
    if (!fs.existsSync(file)) { console.log(`  skip   ${key}  (no file ${path.relative(S('..'), file)})`); skipped++; continue; }
    const size = fs.statSync(file).size;
    if (!DRY) await db.writeJSON(key, null, readFile(file)); // null → don't touch the local file
    console.log(`  ${DRY ? 'would' : 'sent '}  ${key}  ${mb(size)}`);
    sent++; bytes += size;
  }

  // Branch bills cache has its own table (db.readBranchCache)
  const BRANCH_DIR = S('branch_bills_cache');
  for (const f of fs.existsSync(BRANCH_DIR) ? fs.readdirSync(BRANCH_DIR).filter(f => f.endsWith('.json')) : []) {
    const file = path.join(BRANCH_DIR, f);
    if (!DRY) await db.writeBranchCache(f.replace(/\.json$/, ''), readFile(file), null);
    sent++; bytes += fs.statSync(file).size;
  }
  console.log(`  ${DRY ? 'would' : 'sent '}  branch_bills_cache  (${fs.existsSync(BRANCH_DIR) ? fs.readdirSync(BRANCH_DIR).length : 0} branches)`);

  console.log(`\n${DRY ? 'Dry run — nothing sent.' : 'Done.'} ${sent} item(s), ${mb(bytes)}; ${skipped} skipped (no local file).`);
  process.exit(0);
})().catch(e => { console.error('Upload failed:', e.message); process.exit(1); });
