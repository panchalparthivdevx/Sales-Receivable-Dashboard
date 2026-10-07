/**
 * create_vendor_custom_fields.js
 * Checks which vendor registration custom fields already exist in Zoho Books
 * and prints a step-by-step list of the ones still to create in the UI.
 *
 * NOTE: Zoho Books does NOT support creating custom field definitions via REST API.
 * Use this script to see what's missing, then create them via:
 *   Zoho Books → Settings → Custom Fields → Contacts → +New Custom Field
 *
 * Usage: node server/create_vendor_custom_fields.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');
const path  = require('path');
const fs    = require('fs');

const TOKEN_FILE = path.resolve(__dirname, '.token_cache.json');
const ORG_ID     = process.env.ZOHO_ORG_ID;
const API_BASE   = (process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in') + '/books/v3';

// ── Auth ──────────────────────────────────────────────────────────────────────
let cachedToken = null, tokenExpiry = 0;

async function getToken() {
  if (!cachedToken) {
    try {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (d.token && Date.now() < Number(d.expiry)) { cachedToken = d.token; tokenExpiry = Number(d.expiry); }
    } catch (_) {}
  }
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await axios.post(`${process.env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    },
  });
  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: cachedToken, expiry: tokenExpiry }));
  return cachedToken;
}

async function zohoGet(endpoint, params = {}) {
  const token = await getToken();
  const res = await axios.get(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params:  { organization_id: ORG_ID, ...params },
    timeout: 30000,
  });
  return res.data;
}

// ── Field definitions ─────────────────────────────────────────────────────────
const CUSTOM_FIELDS = [
  // Company Info
  { label: 'Trade Name',                    api_name: 'cf_trade_name',                    type: 'Text (Single Line)',  section: 'Company Info'    },
  { label: 'Date of Incorporation',         api_name: 'cf_date_of_incorporation',          type: 'Date',                section: 'Company Info'    },
  { label: 'Type of Vendor',                api_name: 'cf_vendor_type',                   type: 'Dropdown',            section: 'Company Info',
    options: 'Rent/Maint. Vendors | Recurring Vendors | Consultants Vendors | Project Vendors | Other Vendors | Client' },
  { label: 'Type of Organization',          api_name: 'cf_organization_type',             type: 'Dropdown',            section: 'Company Info',
    options: 'Individual / Sole Proprietorship | HUF (Hindu Undivided Family) | Partnership Firm | LLP (Limited Liability Partnership) | Private Limited Company | Public Limited Company | Section 8 Company | Trust / NGO | AOP / BOI | Foreign Company | Government Entity' },
  { label: 'Company Industry',              api_name: 'cf_company_industry',              type: 'Dropdown',            section: 'Company Info',
    options: 'Banking | Financial Services | Insurance | Fintech | Outsourcing | Medical Tourism | Real Estate | Technology | Manufacturing | Retail | Education | Healthcare | Hospitality | Construction | Logistics | Media & Entertainment | Agriculture | Other' },
  { label: 'Company Sector',                api_name: 'cf_company_sector',                type: 'Dropdown',            section: 'Company Info',
    options: 'BFSI | Healthcare | ITES | IT and BPM | FMCG | Real Estate | Manufacturing | Education | Retail | Logistics | Media | Agriculture | Construction | Other' },
  { label: 'Number of Employees',           api_name: 'cf_number_of_employees',           type: 'Number',              section: 'Company Info'    },
  { label: 'Vendor Criteria',               api_name: 'cf_vendor_criteria',               type: 'Dropdown',            section: 'Company Info',
    options: 'Goods | Services | Both' },
  { label: 'Has Brochure',                  api_name: 'cf_has_brochure',                  type: 'Checkbox',            section: 'Company Info'    },

  // GST Details
  { label: 'GST Registration Status',       api_name: 'cf_gst_registration_status',       type: 'Dropdown',            section: 'GST Details',
    options: 'Regular | Composition | SEZ Unit | SEZ Developer' },
  { label: 'Head Office GST Number',        api_name: 'cf_head_office_gst',               type: 'Text (Single Line)',  section: 'GST Details'     },
  { label: 'GST Number for Billing',        api_name: 'cf_gst_for_billing',               type: 'Text (Single Line)',  section: 'GST Details'     },
  { label: 'Additional GST Registrations',  api_name: 'cf_additional_gst_registrations',  type: 'Multi-line Text',     section: 'GST Details'     },

  // Turnover
  { label: 'Turnover Previous FY (INR)',    api_name: 'cf_turnover_previous_fy',           type: 'Decimal',             section: 'Turnover'        },
  { label: 'Turnover Current FY (INR)',     api_name: 'cf_turnover_current_fy',            type: 'Decimal',             section: 'Turnover'        },

  // Statutory
  { label: 'CIN / LLPIN / Reg. Number',     api_name: 'cf_cin_llpin',                     type: 'Text (Single Line)',  section: 'Statutory'       },
  { label: 'Has TAN Number',                api_name: 'cf_has_tan',                       type: 'Checkbox',            section: 'Statutory'       },
  { label: 'TAN Number',                    api_name: 'cf_tan_number',                    type: 'Text (Single Line)',  section: 'Statutory'       },
  { label: 'Has Multiple TANs',             api_name: 'cf_has_multiple_tan',              type: 'Checkbox',            section: 'Statutory'       },
  { label: 'Additional TAN Numbers',        api_name: 'cf_additional_tan_numbers',        type: 'Multi-line Text',     section: 'Statutory'       },
  { label: 'Is MSME / UDYAM Registered',    api_name: 'cf_is_msme',                       type: 'Checkbox',            section: 'Statutory'       },
  { label: 'MSME / UDYAM Number',           api_name: 'cf_msme_udyam_number',             type: 'Text (Single Line)',  section: 'Statutory'       },
  { label: 'MSME Category',                 api_name: 'cf_msme_category',                 type: 'Dropdown',            section: 'Statutory',
    options: 'Micro | Small | Medium' },
  { label: 'MSME Sector',                   api_name: 'cf_msme_sector',                   type: 'Dropdown',            section: 'Statutory',
    options: 'Manufacturing | Services' },
  { label: 'MSME Renewal FY',               api_name: 'cf_msme_renewal_fy',               type: 'Text (Single Line)',  section: 'Statutory'       },
  { label: 'Has Professional Tax',          api_name: 'cf_has_professional_tax',          type: 'Checkbox',            section: 'Statutory'       },
  { label: 'Professional Tax (PT) Number',  api_name: 'cf_pt_number',                     type: 'Text (Single Line)',  section: 'Statutory'       },
  { label: 'Has Provident Fund',            api_name: 'cf_has_pf',                        type: 'Checkbox',            section: 'Statutory'       },
  { label: 'PF Registration Number',        api_name: 'cf_pf_number',                     type: 'Text (Single Line)',  section: 'Statutory'       },
  { label: 'Has ESI',                       api_name: 'cf_has_esi',                       type: 'Checkbox',            section: 'Statutory'       },
  { label: 'ESI Number',                    api_name: 'cf_esi_number',                    type: 'Text (Single Line)',  section: 'Statutory'       },
  { label: 'Shops & Est. License Number',   api_name: 'cf_shops_est_license_number',      type: 'Text (Single Line)',  section: 'Statutory'       },
  { label: 'Shops & Est. State',            api_name: 'cf_shops_est_state',               type: 'Text (Single Line)',  section: 'Statutory'       },

  // Signatory
  { label: 'Signatory Name',                api_name: 'cf_signatory_name',                type: 'Text (Single Line)',  section: 'Signatory'       },
  { label: 'Signatory Designation',         api_name: 'cf_signatory_designation',         type: 'Text (Single Line)',  section: 'Signatory'       },
  { label: 'Signatory Mobile',              api_name: 'cf_signatory_mobile',              type: 'Text (Single Line)',  section: 'Signatory'       },
  { label: 'Signatory Alt. Mobile',         api_name: 'cf_signatory_alt_mobile',          type: 'Text (Single Line)',  section: 'Signatory'       },
  { label: 'Signatory Aadhar Number',       api_name: 'cf_signatory_aadhar',              type: 'Text (Single Line)',  section: 'Signatory'       },
  { label: 'Signatory PAN',                 api_name: 'cf_signatory_pan',                 type: 'Text (Single Line)',  section: 'Signatory'       },
  { label: 'Signatory DIN',                 api_name: 'cf_signatory_din',                 type: 'Text (Single Line)',  section: 'Signatory'       },

  // Finance Contact
  { label: 'Primary Finance Designation',   api_name: 'cf_primary_finance_designation',   type: 'Text (Single Line)',  section: 'Finance Contact' },
  { label: 'Secondary Finance Designation', api_name: 'cf_secondary_finance_designation', type: 'Text (Single Line)',  section: 'Finance Contact' },

  // Bank Account
  { label: 'Bank Name',                     api_name: 'cf_bank_name',                     type: 'Text (Single Line)',  section: 'Bank Account'    },
  { label: 'IFSC Code',                     api_name: 'cf_ifsc_code',                     type: 'Text (Single Line)',  section: 'Bank Account'    },
  { label: 'Bank Branch Name',              api_name: 'cf_bank_branch',                   type: 'Text (Single Line)',  section: 'Bank Account'    },
  { label: 'Swift Code',                    api_name: 'cf_swift_code',                    type: 'Text (Single Line)',  section: 'Bank Account'    },
  { label: 'Bank Account Type',             api_name: 'cf_bank_account_type',             type: 'Dropdown',            section: 'Bank Account',
    options: 'Savings Account | Current Account | NRI Account' },
  { label: 'MICR Code',                     api_name: 'cf_micr_code',                     type: 'Text (Single Line)',  section: 'Bank Account'    },
  { label: 'Bank Account Number',           api_name: 'cf_bank_account_number',           type: 'Text (Single Line)',  section: 'Bank Account'    },

  // E-Sign & Terms
  { label: 'E-Sign Signer Name',            api_name: 'cf_esign_signer_name',             type: 'Text (Single Line)',  section: 'E-Sign & Terms'  },
  { label: 'E-Sign Signer Email',           api_name: 'cf_esign_signer_email',            type: 'Email',               section: 'E-Sign & Terms'  },
  { label: 'Terms Accepted',                api_name: 'cf_terms_accepted',                type: 'Checkbox',            section: 'E-Sign & Terms'  },
  { label: 'Vendor Suggestions',            api_name: 'cf_vendor_suggestions',            type: 'Multi-line Text',     section: 'E-Sign & Terms'  },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Zoho Books — Vendor Custom Fields Status ===\n');

  if (!ORG_ID) { console.error('ZOHO_ORG_ID missing in .env'); process.exit(1); }

  // Fetch existing custom fields
  console.log('Fetching existing custom fields…\n');
  let resp;
  try {
    resp = await zohoGet('/settings/customfields', { module: 'contacts' });
  } catch (e) {
    console.error('Failed to fetch fields:', e.response?.data || e.message);
    process.exit(1);
  }

  // Parse: response.customfields is an object keyed by module name
  const cfByModule = resp.customfields || {};
  const contactsFields = cfByModule.contacts || cfByModule.vendor || cfByModule.Contacts || [];

  // Build lookup by placeholder AND label
  const existingByPlaceholder = new Set();
  const existingByLabel = new Set();
  for (const f of contactsFields) {
    if (f.placeholder) existingByPlaceholder.add(f.placeholder.toLowerCase());
    if (f.label)       existingByLabel.add(f.label.toLowerCase());
  }

  // Semantic equivalents: our planned api_name → existing placeholder already in Zoho
  const SEMANTIC_MAP = {
    'cf_organization_type':      'cf_type_of_organization',
    'cf_date_of_incorporation':  'cf_date_of_registration',
    'cf_gst_for_billing':        'cf_please_enter_gst_number_of_',
    'cf_cin_llpin':              'cf_organization_registration_n',
    'cf_tan_number':             'cf_organization_tan_number',
    'cf_pt_number':              'cf_organization_s_professional',
    'cf_pf_number':              'cf_organization_s_provident_fu',
    'cf_esi_number':             'cf_organization_s_esi_number',
    'cf_bank_branch':            'cf_branch_name',
    'cf_bank_account_type':      'cf_account_type',
    'cf_bank_account_number':    'cf_account_number_n',
    'cf_msme_renewal_fy':        'cf_fy_of_the_latest_msme_certificate',
  };

  console.log(`Existing custom fields in Contacts: ${contactsFields.length}\n`);
  if (contactsFields.length > 0) {
    console.log('  Existing fields:');
    for (const f of contactsFields) {
      console.log(`    • ${f.label || '(no label)'} — placeholder: ${f.placeholder || '—'}`);
    }
    console.log('');
  }

  // Categorise each required field
  const toCreate  = [];
  const alreadyOk = [];
  const reuseAs   = [];

  for (const field of CUSTOM_FIELDS) {
    const plannedKey = field.api_name.toLowerCase();
    const placeholderMatch = existingByPlaceholder.has(plannedKey);
    const labelMatch = existingByLabel.has(field.label.toLowerCase());
    const semanticExisting = SEMANTIC_MAP[plannedKey];
    const semanticMatch = semanticExisting && existingByPlaceholder.has(semanticExisting.toLowerCase());

    if (placeholderMatch || labelMatch) {
      alreadyOk.push({ ...field, note: 'exact match' });
    } else if (semanticMatch) {
      reuseAs.push({ ...field, existingPlaceholder: semanticExisting });
    } else {
      toCreate.push(field);
    }
  }

  // Results
  if (alreadyOk.length) {
    console.log(`✓ Exact matches — already in Zoho (${alreadyOk.length}):`);
    for (const f of alreadyOk) console.log(`    [OK]   ${f.api_name} — "${f.label}"`);
    console.log('');
  }

  if (reuseAs.length) {
    console.log(`♻  Reuse existing field under different placeholder (${reuseAs.length}):`);
    for (const f of reuseAs) console.log(`    [MAP]  ${f.api_name} → reuse ${f.existingPlaceholder} — "${f.label}"`);
    console.log('       (Server handler already uses the correct existing placeholder.)');
    console.log('');
  }

  if (toCreate.length === 0) {
    console.log('✓ All custom fields are already configured in Zoho Books!\n');
    return;
  }

  console.log(`\n⚠  ${toCreate.length} fields need to be created manually in Zoho Books UI.`);
  console.log('   Path: Zoho Books → Settings (⚙) → Custom Fields → Contacts → + New Custom Field\n');

  // Group by section
  const sections = [...new Set(toCreate.map(f => f.section))];
  for (const section of sections) {
    const fields = toCreate.filter(f => f.section === section);
    console.log(`── ${section} ─────────────────────────────────────────────`);
    for (const f of fields) {
      console.log(`  Field Name  : ${f.label}`);
      console.log(`  API Name    : ${f.api_name}`);
      console.log(`  Type        : ${f.type}`);
      if (f.options) console.log(`  Options     : ${f.options}`);
      console.log('');
    }
  }

  // Save to file for easy reference
  const outLines = [
    'Zoho Books — Vendor Custom Fields Creation List',
    `Generated: ${new Date().toISOString()}`,
    `Fields to create: ${toCreate.length}`,
    '',
    'Path: Zoho Books → Settings → Custom Fields → Contacts → + New Custom Field',
    '',
  ];
  for (const section of sections) {
    outLines.push(`=== ${section} ===`);
    const fields = toCreate.filter(f => f.section === section);
    for (const f of fields) {
      outLines.push(`  Field Name : ${f.label}`);
      outLines.push(`  API Name   : ${f.api_name}`);
      outLines.push(`  Type       : ${f.type}`);
      if (f.options) outLines.push(`  Options    : ${f.options}`);
      outLines.push('');
    }
  }
  const outPath = path.resolve(__dirname, '../vendor_custom_fields_todo.txt');
  fs.writeFileSync(outPath, outLines.join('\n'), 'utf8');
  console.log(`\n📄 Full list saved to: vendor_custom_fields_todo.txt\n`);
}

main().catch(e => {
  console.error('Unexpected error:', e.message);
  process.exit(1);
});
