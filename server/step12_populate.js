// Step 12 Data Population Script
// Builds: branch_master, client_master, branch_client_mapping, projection_assumptions
// Re-applies branch mapping to all existing revenue_actuals.json invoices (no Zoho re-sync)
'use strict';
const fs   = require('fs');
const path = require('path');
const now  = new Date().toISOString();
const FPA  = path.join(__dirname, 'fpa');

// ─── 1. BRANCH DEFINITIONS ────────────────────────────────────────────────────
// branch_name must match Zoho branch_name_raw EXACTLY (case-insensitive at runtime)
const BRANCH_DEFS = [
  { branch_name: 'Amd_Binori B Square_3',              city: 'Ahmedabad', city_code: 'AMD',  opening_date: '2025-12-02' },
  { branch_name: 'Amd_Capital One',                     city: 'Ahmedabad', city_code: 'AMD',  opening_date: '2026-03-02' },
  { branch_name: 'Amd_Gift City_Gandhinagar',           city: 'Ahmedabad', city_code: 'AMD',  opening_date: '2025-12-02' },
  { branch_name: 'Amd_Gift City_Tower One_Gandhinagar', city: 'Ahmedabad', city_code: 'AMD',  opening_date: '2025-12-06' },
  { branch_name: 'Amd_Sci. City_3Rd Floor',             city: 'Ahmedabad', city_code: 'AMD',  opening_date: '2026-01-01' },
  { branch_name: 'Amd_The First_10Th Floor',            city: 'Ahmedabad', city_code: 'AMD',  opening_date: '2025-12-02' },
  { branch_name: 'Amd_The First_11Th Floor',            city: 'Ahmedabad', city_code: 'AMD',  opening_date: '2025-12-02' },
  { branch_name: 'Amd_The First_A_6th Floor',           city: 'Ahmedabad', city_code: 'AMD',  opening_date: '2025-12-02' },
  { branch_name: 'Amd_The First_A-03',                  city: 'Ahmedabad', city_code: 'AMD',  opening_date: '2025-12-03' },
  { branch_name: 'Amd_The First_C_2Nd Floor',           city: 'Ahmedabad', city_code: 'AMD',  opening_date: '2025-12-02' },
  { branch_name: 'Hyd_Laxmi Pinnacle_Zomoto',           city: 'Hyderabad', city_code: 'HYD',  opening_date: '2026-01-01' },
  { branch_name: 'Hyd_Purva Summit_B_4Th Floor',        city: 'Hyderabad', city_code: 'HYD',  opening_date: '2025-12-03' },
  { branch_name: 'Hyd_Purva Summit_B_7Th Floor',        city: 'Hyderabad', city_code: 'HYD',  opening_date: '2026-01-01' },
  { branch_name: 'Ind_Nrk Busi. Park_B-1_6th Floor',   city: 'Indore',    city_code: 'IND',  opening_date: '2026-01-01' },
  { branch_name: 'Jai_Fort Anand_5Th Floor',            city: 'Jaipur',    city_code: 'JAI',  opening_date: '2025-12-02' },
  { branch_name: 'Jai_Pinkcity Multiplex_8Th Floor',    city: 'Jaipur',    city_code: 'JAI',  opening_date: '2025-12-03' },
  { branch_name: 'Mum_215-Atrium_10Th Floor',           city: 'Mumbai',    city_code: 'MUM',  opening_date: '2025-12-02' },
  { branch_name: 'Mum_Dynasty_7Th Floor',               city: 'Mumbai',    city_code: 'MUM',  opening_date: '2025-12-02' },
  { branch_name: 'Noi_Embassy_5th Floor',               city: 'Noida',     city_code: 'NOI',  opening_date: '2025-12-26' },
  { branch_name: 'Noi_Jask_7th Floor',                  city: 'Noida',     city_code: 'NOI',  opening_date: '2026-01-01' },
  { branch_name: 'Pun_Amar Busi.Zone_13Th Floor',       city: 'Pune',      city_code: 'PUN',  opening_date: '2025-12-02' },
  { branch_name: 'Pun_Mccia_6Th Floor',                 city: 'Pune',      city_code: 'PUN',  opening_date: '2025-12-02' },
  { branch_name: 'Pun_Next Gen 4th & 5th Floor',        city: 'Pune',      city_code: 'PUN',  opening_date: '2026-01-06' },
  { branch_name: 'Pun_Solitarie Business Hub_2nd Floor',city: 'Pune',      city_code: 'PUN',  opening_date: '2026-08-11' },
  { branch_name: 'Raj_Om 9 Square',                     city: 'Rajkot',    city_code: 'RAJ',  opening_date: '2025-12-01' },
  { branch_name: 'Support Branch',                      city: 'Corporate', city_code: 'CORP', opening_date: '2025-12-24', branch_type: 'support' },
  { branch_name: 'Surat_Stalwart_3rd Floor',            city: 'Surat',     city_code: 'SURAT',opening_date: '2026-01-01' },
  { branch_name: 'Udai_Paras Prime_5Th Floor',          city: 'Udaipur',   city_code: 'UDAI', opening_date: '2025-12-06' },
  { branch_name: 'Vad_Ishan_Block-F',                   city: 'Vadodara',  city_code: 'VAD',  opening_date: '2025-12-02' },
  { branch_name: 'Vad_Notus_D_10Th & 11Th Floor',      city: 'Vadodara',  city_code: 'VAD',  opening_date: '2025-12-02' },
];

// Assign branch IDs: BR-{CITY_CODE}-{SEQ}
const _citySeq = {};
const branches = BRANCH_DEFS.map(def => {
  const c = def.city_code;
  _citySeq[c] = (_citySeq[c] || 0) + 1;
  return {
    branch_id:              `BR-${c}-${String(_citySeq[c]).padStart(3, '0')}`,
    branch_name:            def.branch_name,
    city:                   def.city,
    city_code:              def.city_code,
    branch_type:            def.branch_type || 'coworking',
    opening_date:           def.opening_date,
    opening_date_source:    'earliest_zoho_invoice_in_sync_window',
    opening_date_note:      'MANAGEMENT INPUT REQUIRED: Confirm actual branch opening date',
    revenue_capacity_sqft:  null,
    total_area_sqft:        null,
    total_seats:            null,
    rent_per_sqft:          null,
    target_occupancy_pct:   null,
    occupancy_ramp_template:'base',
    revenue_escalation_pct: null,
    active:                 true,
    management_input_required: ['revenue_capacity_sqft','total_area_sqft','total_seats','opening_date'],
    data_source:            'step12_populate',
    last_updated:           now,
  };
});

// ─── 2. WRITE branch_master.json ─────────────────────────────────────────────
fs.writeFileSync(path.join(FPA, 'branch_master.json'), JSON.stringify({
  branches,
  last_updated: now,
  data_source:  'step12_populate',
  note:         'branch_name values match Zoho branch_name_raw exactly for Level-2 resolution. Management input required for capacity and opening date confirmation.',
}, null, 2));
console.log(`[1] branch_master.json written — ${branches.length} branches`);

// ─── 3. RE-MAP revenue_actuals.json IN-PLACE ─────────────────────────────────
// Re-applies resolveBranch() Level 2 logic without Zoho re-sync
const byName = new Map(branches.map(b => [b.branch_name.toLowerCase().trim(), b]));

const actuals = JSON.parse(fs.readFileSync(path.join(FPA, 'revenue_actuals.json'), 'utf8'));
const invoices    = actuals.invoices    || [];
const creditNotes = actuals.credit_notes || [];

let mapped = 0, partialMapped = 0, unmapped = 0;

function remapDoc(doc) {
  const rawBranch = (doc.branch_name_raw || '').trim();
  if (!rawBranch) { unmapped++; return; }

  const exact = byName.get(rawBranch.toLowerCase());
  if (exact) {
    doc.branch_id             = exact.branch_id;
    doc.branch_name_resolved  = exact.branch_name;
    doc.branch_mapping_source = 'zoho_field';
    mapped++;
    return;
  }

  // Partial match
  for (const [name, b] of byName) {
    if (name && (name.includes(rawBranch.toLowerCase()) || rawBranch.toLowerCase().includes(name))) {
      doc.branch_id             = b.branch_id;
      doc.branch_name_resolved  = b.branch_name;
      doc.branch_mapping_source = 'zoho_field_partial';
      partialMapped++;
      return;
    }
  }

  doc.branch_id             = null;
  doc.branch_name_resolved  = null;
  doc.branch_mapping_source = 'UNMAPPED';
  unmapped++;
}

invoices.forEach(remapDoc);
creditNotes.forEach(remapDoc);

actuals.last_remap_at   = now;
actuals.last_remap_note = 'Branch IDs re-applied in-place by step12_populate. Next Zoho sync will re-process with live branch_master.';
fs.writeFileSync(path.join(FPA, 'revenue_actuals.json'), JSON.stringify(actuals, null, 2));
console.log(`[2] revenue_actuals.json remapped — exact:${mapped} partial:${partialMapped} unmapped:${unmapped} / total:${invoices.length + creditNotes.length}`);

// ─── 4. BUILD client_master.json ─────────────────────────────────────────────
const customerMap = {};
for (const inv of invoices) {
  if (!inv.customer_id || !inv.branch_id) continue;
  if (!customerMap[inv.customer_id]) {
    customerMap[inv.customer_id] = {
      customer_id:   inv.customer_id,
      customer_name: inv.customer_name,
    };
  }
}

const clients = Object.values(customerMap).map(c => ({
  client_id:               `CL-${c.customer_id}`,
  client_name:             c.customer_name,
  zoho_customer_id:        c.customer_id,
  current_monthly_revenue: null,
  escalation_pct:          null,
  contract_start_date:     null,
  contract_end_date:       null,
  active:                  true,
  management_input_required: ['current_monthly_revenue','escalation_pct','contract_start_date'],
  data_source:             'step12_populate',
  last_updated:            now,
}));

fs.writeFileSync(path.join(FPA, 'client_master.json'), JSON.stringify({
  clients,
  last_updated: now,
  data_source:  'step12_populate',
  note:         'Derived from Zoho invoice customer data. Management input required for contracted terms.',
}, null, 2));
console.log(`[3] client_master.json written — ${clients.length} clients`);

// ─── 5. BUILD branch_client_mapping.json ─────────────────────────────────────
const mappingPairs = new Map();
for (const inv of invoices) {
  if (!inv.customer_id || !inv.branch_id) continue;
  const key = `${inv.customer_id}:${inv.branch_id}`;
  if (!mappingPairs.has(key)) {
    mappingPairs.set(key, {
      mapping_id:        `MAP-${inv.customer_id}-${inv.branch_id}`,
      client_id:         `CL-${inv.customer_id}`,
      branch_id:         inv.branch_id,
      zoho_customer_id:  inv.customer_id,
      active:            true,
      data_source:       'step12_populate_from_zoho_actuals',
      last_updated:      now,
    });
  }
}

const mappings = Array.from(mappingPairs.values());
fs.writeFileSync(path.join(FPA, 'branch_client_mapping.json'), JSON.stringify({
  mappings,
  last_updated: now,
  data_source:  'step12_populate',
  note:         'Unique customer×branch pairs from Zoho actuals. Management input required: contracted terms per mapping.',
}, null, 2));
console.log(`[4] branch_client_mapping.json written — ${mappings.length} mappings`);

// ─── 6. BUILD projection_assumptions.json ────────────────────────────────────
// One client_assumption per mapping; no contracted revenue set — compute will
// derive from Zoho 3-month actuals via deriveBasesFromActuals()
const clientAssumptions = mappings.map(m => ({
  mapping_id:                 m.mapping_id,
  client_id:                  m.client_id,
  branch_id:                  m.branch_id,
  zoho_customer_id:           m.zoho_customer_id,
  contracted_monthly_revenue: null,   // MANAGEMENT INPUT REQUIRED
  manual_override_revenue:    null,
  escalation_pct:             null,   // uses global default 5% via getEscalation()
  escalation_effective_date:  null,
  revenue_start_date:         null,
  revenue_end_date:           null,
  capacity_sqft:              null,
  forecast_status:            'active',
  data_source:                'step12_populate',
}));

const projectionAssumptions = {
  forecast_config: {
    actual_cutoff_month: '2026-09', // months through Sep 2026 treated as actuals
    forecast_start:      '2026-04', // aligned with integrated_config.forecast_start
    forecast_end:        '2029-03',
    scenario:            'base',
    proration_method:    'daily',
    version_label:       'FY2026-27 to FY2028-29 Base Case — Step 12 Population',
    locked:              false,
    last_computed_at:    null,
  },
  client_assumptions:   clientAssumptions,
  branch_rate_overrides:{},
  overrides_log:        [],
  last_updated:         now,
  data_source:          'step12_populate',
  note:                 'forecast_start=2026-04 aligns projection output with integrated compute range. Forecast months use Zoho 3m avg base revenue via deriveBasesFromActuals(). Management input required for contracted_monthly_revenue and escalation per client.',
};

fs.writeFileSync(path.join(FPA, 'projection_assumptions.json'), JSON.stringify(projectionAssumptions, null, 2));
console.log(`[5] projection_assumptions.json written — ${clientAssumptions.length} client assumptions`);

// ─── SUMMARY ─────────────────────────────────────────────────────────────────
console.log('\n=== Step 12 Population Complete ===');
console.log(`  Branches:         ${branches.length}`);
console.log(`  Invoices mapped:  ${mapped} exact + ${partialMapped} partial + ${unmapped} unmapped = ${invoices.length + creditNotes.length} total docs`);
console.log(`  Clients:          ${clients.length}`);
console.log(`  Mappings:         ${mappings.length}`);
console.log(`  Assumptions:      ${clientAssumptions.length}`);
console.log('\nNEXT: Run these 3 API computes (as admin) in order:');
console.log('  POST /api/fpa/projection/compute');
console.log('  POST /api/fpa/cost/compute');
console.log('  POST /api/fpa/integrated/compute');
