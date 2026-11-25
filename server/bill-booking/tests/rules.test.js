'use strict';

// Own sales invoices are never collected or booked; the category comes from the vendor's similar Zoho bill;
// bills checked under older rules are checked again; the default Zoho categories are seeded once.

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const C = require('../lib/config');
const OS = require('../lib/ownsale');
const ML = require('../lib/mail');

const user = { id: '1', username: 'admin', name: 'Admin A' };
const NT_GSTIN = '24AAKFN5555Q1Z2';       // Neddle (test value)
const CUST_GSTIN = '27AAACR1111P1ZR';     // an outside customer (test value)
const companies = [
  { id: 'devx', name: 'Dev Accelerator Ltd', gstins: [H.OWN_GSTIN], pans: [], name_hints: ['dev accelerator', 'devx'] },
  { id: 'neddle', name: 'Needle And Thread Designs LLP', gstins: [NT_GSTIN], pans: [], name_hints: ['needle and thread', 'neddle'] },
];

// What the PDF text of DevX's own invoice looks like (seller block first, then "Bill To")
const OWN_TEXT = `Dev Accelerator Limited (formerly known as Dev Accelerator Pvt. Ltd.)
11th Floor, A-1101 The First commercial complex, Ahmedabad
GSTIN: ${H.OWN_GSTIN}
TAX INVOICE
Invoice No# : IN/26-27/GJ/2641
Invoice Date : 23/11/2026
Bill To
RIGHTSOL PRIVATE LIMITED
GSTIN ${CUST_GSTIN}
Dedicated Hut October'26 998599 2.00 9,371.00
Sub Total 56,226.00
Total 66,347.00`;

// A vendor's bill to DevX: the vendor's GSTIN first, DevX after "Bill To"
const VENDOR_TEXT = `Clean Co Facility Services
GSTIN: ${H.V_GSTIN}
TAX INVOICE
Invoice No: CC/120
Bill To
Dev Accelerator Limited
GSTIN ${H.OWN_GSTIN}
Housekeeping manpower services 10,000.00`;

const sales = OS.salesIndex([{ company: 'devx', rows: [
  { invoice_number: 'IN/26-27/GJ/2641', date: '2026-11-23', total: 66347, customer_name: 'RIGHTSOL PRIVATE LIMITED' },
  { invoice_number: 'IN/26-27/GJ/2700', date: '2026-11-24', total: 1000, customer_name: 'Needle And Thread Designs LLP' },
] }]);

// ── Recognising our own sales invoices ────────────────────────────────────────

test('own sales invoice: recognised by its Zoho number, by the seller block, or by the supplier GSTIN', () => {
  const builtIn = { vendor_gstin: CUST_GSTIN, buyer_gstin: H.OWN_GSTIN, invoice_number: 'IN/26-27/GJ/2641', invoice_date: '2026-11-23', total: 66347 };
  const byNumber = OS.check({ fields: builtIn, text: OWN_TEXT, companies, sales });
  assert.equal(byNumber.basis, 'zoho_number'); assert.equal(byNumber.company, 'devx');
  assert.match(byNumber.reason, /IN\/26-27\/GJ\/2641 is Dev Accelerator Ltd's invoice to RIGHTSOL PRIVATE LIMITED/);

  const bySeller = OS.check({ fields: builtIn, text: OWN_TEXT, companies, sales: new Map() });
  assert.equal(bySeller.basis, 'seller_block');
  assert.match(bySeller.reason, new RegExp(`issued by Dev Accelerator Ltd \\(GSTIN ${H.OWN_GSTIN}\\) to GSTIN ${CUST_GSTIN}`));

  const byReader = OS.check({ fields: { vendor_gstin: H.OWN_GSTIN, buyer_gstin: CUST_GSTIN }, text: '', companies });
  assert.equal(byReader.basis, 'supplier_gstin');

  // by the attachment's name alone (Zoho names invoice PDFs after the number)
  assert.match(OS.byFileName({ fileName: 'IN26-27GJ2641.pdf', companies, sales }).reason, /Our own sales invoice IN\/26-27\/GJ\/2641/);
});

test('own sales invoice: vendor bills, intercompany bills and look-alike numbers are left alone', () => {
  // a vendor's bill to DevX
  assert.equal(OS.check({ fields: { vendor_gstin: H.V_GSTIN, buyer_gstin: H.OWN_GSTIN, invoice_number: 'CC/120' }, text: VENDOR_TEXT, companies, sales }), null);
  // Neddle's invoice to DevX is a purchase bill for DevX
  const ntText = `Needle And Thread Designs LLP\nGSTIN ${NT_GSTIN}\nTAX INVOICE\nBill To\nDev Accelerator Limited\nGSTIN ${H.OWN_GSTIN}`;
  assert.equal(OS.check({ fields: { vendor_gstin: NT_GSTIN, buyer_gstin: H.OWN_GSTIN }, text: ntText, companies, sales }), null);
  // DevX's invoice to Neddle (in DevX's sales invoices) is a purchase bill for Neddle
  assert.equal(OS.check({ fields: { vendor_gstin: H.OWN_GSTIN, buyer_gstin: NT_GSTIN, invoice_number: 'IN/26-27/GJ/2700' }, text: '', companies, sales }), null);
  assert.equal(OS.byFileName({ fileName: 'IN26-27GJ2700.pdf', companies, sales }), null);
  // same number, but neither the date nor the total agrees → another party's document
  assert.equal(OS.check({ fields: { vendor_gstin: H.V_GSTIN, buyer_gstin: H.OWN_GSTIN, invoice_number: 'IN/26-27/GJ/2641', invoice_date: '2026-01-05', total: 500 }, text: VENDOR_TEXT, companies, sales }), null);
  // short numbers never match
  assert.equal(OS.byFileName({ fileName: '2641.pdf', companies, sales: OS.salesIndex([{ company: 'devx', rows: [{ invoice_number: '2641' }] }]) }), null);
});

async function ingestAndWait(env, name, extra = {}) {
  const r = await env.pipeline.ingest({ buffer: H.pdf(name + (extra.salt || '')), name, mime: 'application/pdf', source: 'erp_upload', member_id: 'm1', source_ref: { erp_ref: 'E1' }, by: 'Admin A', ...extra });
  await env.pipeline.idle();
  return env.store.bill(r.id);
}

const OWN_READ = { text: OWN_TEXT, fields: { vendor_name: 'Dev Accelerator Limited', vendor_gstin: CUST_GSTIN, buyer_gstin: H.OWN_GSTIN, invoice_number: 'IN/26-27/GJ/2641' } };

test('workflow: our own sales invoice becomes Not a Bill with the reason, without Zoho look-ups; the team can overrule', async () => {
  const env = H.setup({ reads: { 'IN26-27GJ2641.pdf': OWN_READ, '*': {} } });
  env.synced.devx.invoices_fy = { data: [{ invoice_number: 'IN/26-27/GJ/2641', date: '2026-11-23', total: 66347, customer_name: 'RIGHTSOL PRIVATE LIMITED', status: 'sent' }] };
  await H.seedConfig();
  const b = await ingestAndWait(env, 'IN26-27GJ2641.pdf');
  assert.equal(b.status, 'not_bill');
  assert.equal(b.not_bill.own_sale, true); assert.match(b.not_bill.reason, /Our own sales invoice/);
  assert.equal(b.vendor, null, 'no vendor is matched for our own invoice');
  assert.ok(!env.zc.calls.some(c => c === 'vendorBills' || c.startsWith('detail:')), 'no Zoho calls spent on it');
  assert.ok(b.audit.some(a => a.action === 'evaluated' && /not a bill: Our own sales invoice/.test(a.detail)));

  const back = await env.pipeline.action(b.id, 'is_bill', {}, user);
  assert.notEqual(back.status, 'not_bill', '"It is a bill" brings it back');
  // a vendor bill next to it is untouched
  const v = await ingestAndWait(env, 'hk.pdf');
  assert.equal(v.status, 'ready'); assert.equal(v.own_sale, null);
});

// ── Category from the vendor's similar bill in Zoho ───────────────────────────

/** v_hk's Zoho bills, with Zoho's own "Category" / "Vendor Category" on them */
function zohoHistory(category, vendorCategory, description = 'Housekeeping manpower services for September') {
  const d = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const cf = [
    category && { customfield_id: 'cf_cat_id', api_name: 'cf_category', label: 'Category', value: category },
    vendorCategory && { customfield_id: 'cf_vcat_id', api_name: 'cf_vendor_category', label: 'Vendor Category', value: vendorCategory },
  ].filter(Boolean);
  const mk = (id, num, date) => ({ bill_id: id, bill_number: num, date, status: 'paid', lmt: `${date}T10:00:00+0530`, vendor_id: 'v_hk', branch_id: 'br_1', branch_name: 'Ahmedabad',
    tds_tax_id: 'tds_194c', tds_tax_name: 'TDS 194C 2%', custom_fields: cf,
    lines: [{ description, account_id: 'acc_rent', account_name: 'Office Rent', tax_id: 'tx_gst18', tax_name: 'GST18', tax_percentage: 18, hsn_or_sac: '998533' }] });
  const details = { z1: mk('z1', 'CC/101', d(30)), z2: mk('z2', 'CC/087', d(60)) };
  return { details, vendorBills: Object.values(details).map(b => ({ bill_id: b.bill_id, bill_number: b.bill_number, date: b.date, status: 'paid', total: 1000, lmt: b.lmt })) };
}

async function verifyDrafts(env) {
  await env.store.tx(async t => { const c = C.merge(t.doc('bb_config')); c.settings.draft_capability = { [H.ORG]: { verified: true, status: 'draft' } }; t.setDoc('bb_config', c); });
}

test('category and account come from the similar Zoho bill — even when the wording points elsewhere — and reach the draft', async () => {
  // the bill reads "Housekeeping …" (wording → Housekeeping), but this vendor's similar Zoho bills are booked as property maintenance / Landlord
  const env = H.setup({ zoho: zohoHistory('property maintenance expenses', 'Landlord ') });
  await H.seedConfig();
  await verifyDrafts(env);
  const b = await ingestAndWait(env, 'hk.pdf');
  assert.equal(b.category.id, 'rent_cam'); assert.equal(b.category.source, 'zoho_bill');
  assert.match(b.category.basis, /similar bill CC\/101 dated .* Category "property maintenance expenses", Vendor Category "Landlord"/);
  assert.equal(b.category.ref.bill_number, 'CC/101');
  assert.equal(b.lines[0].account.id, 'acc_rent'); assert.match(b.lines[0].account.basis, /CC\/101/);
  assert.deepEqual(b.zoho_category.values.map(v => v.value), ['property maintenance expenses', 'Landlord']);
  assert.equal(b.status, 'ready', JSON.stringify(b.issues));

  await env.pipeline.createDraft(b.id, user);
  assert.deepEqual(env.zc.created[0].payload.custom_fields, [
    { customfield_id: 'cf_cat_id', value: 'property maintenance expenses' }, { customfield_id: 'cf_vcat_id', value: 'Landlord' },
  ], "the draft gets Zoho's Category and Vendor Category as on the similar bill");
});

test('category: a Zoho category no bill category lists falls back to the wording, with the reason; nothing similar → no Zoho category', async () => {
  const env = H.setup({ zoho: zohoHistory('Internet (Recurring)', 'Recurring ') });
  await H.seedConfig();
  const b = await ingestAndWait(env, 'hk.pdf');
  assert.equal(b.category.id, 'hk_security_gardening', 'from the bill wording');
  assert.match(b.category.basis, /no bill category lists it under "Zoho categories"/);
  assert.equal(b.zoho_category.maps_to, '');

  const env2 = H.setup({ zoho: zohoHistory('property rental expenses', 'Landlord', 'Lease rent for office premises'), reads: { '*': {
    fields: { description: 'Deep cleaning of carpets' }, lines: [{ description: 'Deep cleaning of carpets', amount: 10000, tax_rate: 18, tax_amount: 1800 }] } } });
  await H.seedConfig();
  const c = await ingestAndWait(env2, 'carpets.pdf');
  assert.notEqual(c.category.source, 'zoho_bill', 'a bill unlike the earlier ones never takes their category');
  assert.equal(c.zoho_category, null);
});

test('category: a category chosen by hand is kept, and then the Zoho values of another category are not copied to the draft', async () => {
  const env = H.setup({ zoho: zohoHistory('property maintenance expenses', 'Landlord') });
  await H.seedConfig();
  await verifyDrafts(env);
  const b = await ingestAndWait(env, 'hk.pdf');
  const r = await env.pipeline.edit(b.id, { category_id: 'hk_security_gardening' }, user);
  assert.equal(r.bill.category.source, 'manual'); assert.equal(r.bill.category.id, 'hk_security_gardening');
  assert.equal(r.bill.zoho_category.maps_to, 'rent_cam');
  await env.pipeline.createDraft(b.id, user);
  assert.equal(env.zc.created[0].payload.custom_fields, undefined);
});

// ── Re-checking bills collected before the new rules ──────────────────────────

test('bills checked under older rules are checked again once, keeping what the team chose', async () => {
  const env = H.setup({ reads: { 'IN26-27GJ2641.pdf': OWN_READ, '*': {} } });
  await H.seedConfig();
  const own = await ingestAndWait(env, 'IN26-27GJ2641.pdf');   // no synced sales invoices: the seller block decides
  const hk = await ingestAndWait(env, 'hk.pdf');
  await env.pipeline.edit(hk.id, { category_id: 'amc' }, user);
  // as if both were checked before this version
  await env.store.tx(async t => {
    for (const id of [own.id, hk.id]) { const b = t.bill(id); delete b.rules_v; b.own_sale = null; b.not_bill = null; b.status = 'needs_input'; t.putBill(b); }
  });
  assert.equal(await env.pipeline.oldRulesCount(), 2);
  assert.equal(await env.pipeline.recheckOld(), 2);
  const o = await env.store.bill(own.id), h = await env.store.bill(hk.id);
  assert.equal(o.status, 'not_bill'); assert.match(o.not_bill.reason, /issued by Dev Accelerator Ltd/);
  assert.equal(h.category.id, 'amc', 'the team\'s choice is kept'); assert.equal(h.rules_v, env.pipeline.RULES_V);
  assert.equal(await env.pipeline.recheckOld(), 0, 'nothing is checked twice');
});

// ── Default Zoho categories ───────────────────────────────────────────────────

test('the default Zoho categories are added once to a stored configuration; later edits are kept', () => {
  const stored = { categories: [{ id: 'rent_cam', name: 'Rent', active: true, keywords: [], vendor_category_aliases: ['my own'], fields: [] }] };
  const m = C.merge(stored);
  assert.deepEqual(m.categories[0].vendor_category_aliases.slice(0, 2), ['my own', 'landlord']);
  assert.equal(m.zoho_categories_seeded, true);
  const edited = { ...m, categories: [{ ...m.categories[0], vendor_category_aliases: ['my own'] }] };   // the user removed the defaults and saved
  assert.deepEqual(C.merge(edited).categories[0].vendor_category_aliases, ['my own']);
});

// ── Mailbox: our own invoices are not collected ───────────────────────────────

test('mailbox: an attachment named like our own sales invoice is skipped with the reason; intercompany ones are collected', async () => {
  const day0 = new Date(Date.now() - 2 * 86400000).toISOString();
  const pdfs = { a1: 'IN26-27GJ2641.pdf', a2: 'IN26-27GJ2700.pdf' };
  const http = {
    async post(url, body) { return { data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }; },
    async get(url) {
      if (url.endsWith('/me')) return { data: { mail: 'asha@devx.work' } };
      if (/\/me\/messages\?/.test(url)) return { data: { value: [{ id: 'msgA', internetMessageId: '<a@x>', subject: 'Friendly Reminder | Invoice', from: { emailAddress: { name: 'Accounts Receivable', address: 'ar@devx.work' } }, receivedDateTime: day0, bodyPreview: 'Invoice attached' }] } };
      if (/\/attachments$/.test(url)) return { data: { value: Object.entries(pdfs).map(([id, name]) => ({ '@odata.type': '#microsoft.graph.fileAttachment', id, name, contentType: 'application/pdf', size: 40000, isInline: false })) } };
      const v = url.match(/\/attachments\/(\w+)\/\$value$/);
      if (v) return { data: H.pdf(v[1]) };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  process.env.BB_MS_CLIENT_ID = process.env.BB_MS_CLIENT_ID || 'client-id-test';
  process.env.BB_MS_CLIENT_SECRET = process.env.BB_MS_CLIENT_SECRET || 'client-secret-test';
  const env = H.setup();
  env.synced.devx.invoices_fy = { data: [
    { invoice_number: 'IN/26-27/GJ/2641', date: '2026-11-23', total: 66347, customer_name: 'RIGHTSOL PRIVATE LIMITED', status: 'sent' },
    { invoice_number: 'IN/26-27/GJ/2700', date: '2026-11-24', total: 1000, customer_name: 'Needle And Thread Designs LLP', status: 'sent' },
  ] };
  await H.seedConfig();
  const mail = ML.create({ store: env.store, pipeline: env.pipeline, files: env.files, lookups: env.lookups, http, log: { error() {} } });
  const cfg = C.merge((await env.store.snapshot()).doc('bb_config'));
  const url = mail.authUrl(cfg.team[0], 'http://localhost:3002/api/bill-booking/oauth/callback', user);
  await mail.completeAuth(new URL(url).searchParams.get('state'), 'code-1', 'http://localhost:3002/api/bill-booking/oauth/callback');

  const [res] = await mail.pollAll();
  await env.pipeline.idle();
  assert.equal(res.ingested, 1, 'DevX invoice to Neddle = Neddle purchase bill: collected');
  assert.equal(res.skipped, 1);
  const m = (await env.store.snapshot()).doc('bb_mail');
  assert.equal(m.skipped[0].name, 'IN26-27GJ2641.pdf'); assert.equal(m.skipped[0].own_sale, true);
  assert.match(m.skipped[0].reason, /Our own sales invoice IN\/26-27\/GJ\/2641 \(Dev Accelerator Ltd to RIGHTSOL PRIVATE LIMITED/);
  assert.equal((await env.store.snapshot()).bills.length, 1);
});
