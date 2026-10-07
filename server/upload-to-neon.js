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

// FP&A: every server/fpa/*.json under the key the app uses for it (fpa-store.js keyOf)
const { keyOf: fpaKeyOf } = require('./fpa-store');
for (const f of fs.existsSync(S('fpa')) ? fs.readdirSync(S('fpa')).filter(f => f.endsWith('.json')) : []) {
  STORES[fpaKeyOf(S('fpa', f))] = S('fpa', f);
}

// Synced Zoho entities: sync_data_<entity> ← sync_data/<entity>.json (sync-engine _syncDataKey)
for (const [k, def] of Object.entries(require('./sync-engine').ENTITY_DEFS)) {
  if (def.path) STORES[`sync_data_${k}`] = S('sync_data', `${k}.json`);
}

// MSME Interest quarter results: msme_qr_<fy>_<q> (index.js _msmeQRKey) — key from the file's own fy/quarter
for (const f of fs.readdirSync(S('sync_data')).filter(f => /^msme_qr_.*\.json$/.test(f))) {
  try {
    const r = JSON.parse(fs.readFileSync(S('sync_data', f), 'utf8')).result;
    if (r && r.fy && r.quarter) STORES[`msme_qr_${r.fy}_${r.quarter}`] = S('sync_data', f);
  } catch (_) {}
}

// Branch P&L settings, invoice sub-totals (index.js)
STORES.pl_mapping         = S('pl_mapping.json');
STORES.pl_branch_capacity = S('pl_branch_capacity.json');
STORES.invoice_subtotals  = S('sync_data', 'invoice_subtotals.json');

// Branch P&L caches: pl_fy_<fy>_<entity> ← pl_fy_cache/<fy>/<entity>.json (listed as one line)
const PL_FY_DIR = S('pl_fy_cache');
const PL_FY = {};
for (const fy of fs.existsSync(PL_FY_DIR) ? fs.readdirSync(PL_FY_DIR) : []) {
  const dir = path.join(PL_FY_DIR, fy);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) PL_FY[`pl_fy_${fy}_${f.replace(/\.json$/, '')}`] = path.join(dir, f);
}

// POCM store: pocm_cache_<key> = { saved_at, data } (pocm-sync.js); quarter-lock snapshots by id
const POCM = {};
const POCM_DIR = S('pocm_disk_cache');
for (const f of fs.existsSync(POCM_DIR) ? fs.readdirSync(POCM_DIR).filter(f => f.endsWith('.json')) : []) {
  POCM[`pocm_cache_${f.replace(/\.json$/, '')}`] = { file: path.join(POCM_DIR, f), wrap: true };
}
const SNAP_DIR = S('pocm_snapshots');
for (const f of fs.existsSync(SNAP_DIR) ? fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')) : []) {
  POCM[`pocm_snapshot_${f.replace(/\.json$/, '')}`] = { file: path.join(SNAP_DIR, f), wrap: false };
}

// Excel workbooks read at runtime (server/workbooks.js) — same paths as index.js / rent-agreed.js
const { pickLocalWorkbook, ROOT } = require('./rent-agreed');
const rentPick = pickLocalWorkbook();
const WORKBOOK_FILES = {
  branch_seats: path.join(ROOT, 'Branch wise Total Seat.xlsx'),
  payroll:      path.join(ROOT, 'Compliance & Payroll', 'Group Salary Sheet_24-09-26.xlsx'),
  loans:        path.join(ROOT, 'Loan Module', 'Loan Data Final (1).xlsx'),
  rent_module:  rentPick ? path.join(ROOT, rentPick.f) : null,
};

// Parsed exactly the way the office PC reads each store, so Vercel sees the same data:
// db.readJSON and the FP&A / POCM / P&L readers use plain JSON.parse — a file that starts with
// a byte-order mark (BOM, e.g. saved by PowerShell) fails there and counts as empty, so it is
// skipped here too and listed at the end. Only db.readBranchCache strips a leading BOM.
const readAsApp    = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const readStripBOM = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const hasBOM = f => fs.readFileSync(f).subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]));
const mb = n => (n / 1048576).toFixed(1) + ' MB';

async function main() {
  if (!DRY) await db.initDB();
  let sent = 0, skipped = 0, bytes = 0;
  const unreadable = [];   // files the office PC cannot read either

  // value to store, or undefined when the office PC can't read the file (then skipped)
  const load = (key, file) => {
    try { return readAsApp(file); }
    catch (e) {
      unreadable.push(`${path.relative(S('..'), file)} — ${hasBOM(file) ? 'starts with a BOM' : e.message}`);
      skipped++;
      return undefined;
    }
  };

  for (const [key, file] of Object.entries(STORES)) {
    if (!fs.existsSync(file)) { console.log(`  skip   ${key}  (no file ${path.relative(S('..'), file)})`); skipped++; continue; }
    const size = fs.statSync(file).size;
    const value = load(key, file);
    if (value === undefined) { console.log(`  skip   ${key}  (the office PC cannot read this file either — see below)`); continue; }
    if (!DRY) await db.writeJSON(key, null, value); // null → don't touch the local file
    console.log(`  ${DRY ? 'would' : 'sent '}  ${key}  ${mb(size)}`);
    sent++; bytes += size;
  }

  let plBytes = 0, plSent = 0;
  for (const [key, file] of Object.entries(PL_FY)) {
    const value = load(key, file);
    if (value === undefined) continue;
    if (!DRY) await db.writeJSON(key, null, value);
    plBytes += fs.statSync(file).size; plSent++;
  }
  console.log(`  ${DRY ? 'would' : 'sent '}  pl_fy_cache  (${plSent} files) ${mb(plBytes)}`);
  sent += plSent; bytes += plBytes;

  let pocmBytes = 0, pocmSent = 0;
  for (const [key, { file, wrap }] of Object.entries(POCM)) {
    const value = load(key, file);
    if (value === undefined) continue;
    const st = fs.statSync(file);
    if (!DRY) await db.writeJSON(key, null, wrap ? { saved_at: st.mtimeMs, data: value } : value);
    pocmBytes += st.size; pocmSent++;
  }
  console.log(`  ${DRY ? 'would' : 'sent '}  pocm store  (${pocmSent} files) ${mb(pocmBytes)}`);
  sent += pocmSent; bytes += pocmBytes;

  // Agreement Master listing (folder/file names only — the PDFs stay in OneDrive/SharePoint)
  const structure = require('./agreements-folder').scanAgreementsFolder();
  const clients = Object.values(structure).reduce((n, b) => n + Object.keys(b.clients).length, 0);
  if (!DRY) await db.writeJSON('agreements_structure', null, structure);
  console.log(`  ${DRY ? 'would' : 'sent '}  agreements_structure  (${Object.keys(structure).length} branches, ${clients} clients)`);
  sent++;

  const workbooks = require('./workbooks');
  for (const [key, file] of Object.entries(WORKBOOK_FILES)) {
    if (!file || !fs.existsSync(file)) { console.log(`  skip   xlsx_${key}  (no file ${file ? path.relative(ROOT, file) : 'Rent Recurring Module*.xlsx'})`); skipped++; continue; }
    const st = fs.statSync(file);
    if (!DRY) await workbooks.save(key, path.basename(file), fs.readFileSync(file), st.mtimeMs);
    console.log(`  ${DRY ? 'would' : 'sent '}  xlsx_${key}  ${path.basename(file)}  ${mb(st.size)}`);
    sent++; bytes += st.size;
  }

  // Branch bills cache has its own table (db.readBranchCache)
  const BRANCH_DIR = S('branch_bills_cache');
  for (const f of fs.existsSync(BRANCH_DIR) ? fs.readdirSync(BRANCH_DIR).filter(f => f.endsWith('.json')) : []) {
    const file = path.join(BRANCH_DIR, f);
    if (!DRY) await db.writeBranchCache(f.replace(/\.json$/, ''), readStripBOM(file), null);   // the PC strips a BOM here
    sent++; bytes += fs.statSync(file).size;
  }
  console.log(`  ${DRY ? 'would' : 'sent '}  branch_bills_cache  (${fs.existsSync(BRANCH_DIR) ? fs.readdirSync(BRANCH_DIR).length : 0} branches)`);

  if (unreadable.length) {
    console.log('\nNot uploaded — the office PC cannot read these files either, so Vercel matches it:');
    for (const u of unreadable) console.log(`  ${u}`);
  }
  console.log(`\n${DRY ? 'Dry run — nothing sent.' : 'Done.'} ${sent} item(s), ${mb(bytes)}; ${skipped} skipped.`);
  return { sent, skipped, bytes };
}

module.exports = { main };
if (require.main === module) {
  main().then(() => process.exit(0), e => { console.error('Upload failed:', e.message); process.exit(1); });
}
