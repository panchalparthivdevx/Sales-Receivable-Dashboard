'use strict';

// Zoho-style PDF text (totals first), our numbering series for invoices raised after the last sync, and
// "Read all again with Claude" (which bills, what is kept, and the route's guard).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const H = require('./helpers');
const OS = require('../lib/ownsale');

const user = { id: '1', username: 'admin', name: 'Admin A' };
const CUST = '27AAACR1111P1ZR';
const companies = [
  { id: 'devx', name: 'Dev Accelerator Ltd', gstins: [H.OWN_GSTIN], pans: [], name_hints: ['dev accelerator', 'devx'] },
  { id: 'neddle', name: 'Needle And Thread Designs LLP', gstins: ['24AAKFN5555Q1Z2'], pans: [], name_hints: ['needle and thread', 'neddle'] },
];

// How a Zoho invoice PDF's text really comes out: the totals and terms first, the letterhead later
const ZOHO_TEXT = `1
Sub Total56,226.00
CGST9 (9%)5,060.34
SGST9 (9%)5,060.34
Amount Withheld
(-) 5,622.60
Total66,347.00
Balance Due₹60,724.40
Total In Words
Indian Rupee Sixty Thousand Seven Hundred Twenty-Four and Forty Paise
Thank you for your Business.
Company's Bank Details: Bank Name: ICICI Bank LTD, Current Account No: 000000000000, IFSC Code: ICIC0000000
Terms & Conditions
Kindly Include Invoice Number as Reference while Initiating Payment
Dev Accelerator Limited (formerly
known as Dev Accelerator Pvt. Ltd.)
11th Floor, A-1101 The First commercial complex,
Vastrapur, Ahmedabad 380015
GSTIN: ${H.OWN_GSTIN}
TAX INVOICE
Invoice No# : IN/26-27/GJ/2655
Place Of Supply : Gujarat (24)
Bill To
RIGHTSOL PRIVATE LIMITED
GSTIN ${CUST}
Dedicated Hut October'26 998599 2.00 9,371.00`;

const rows = n => Array.from({ length: n }, (_, i) => ({ invoice_number: `IN/26-27/GJ/${String(2600 + i).padStart(4, '0')}`, date: '2026-11-01', total: 1000, customer_name: 'Customer' }));

test('own sales invoice: Zoho PDF text with the letterhead after the totals is recognised by the seller block', () => {
  assert.ok(ZOHO_TEXT.search(/dev accelerator/i) > 400, 'the letterhead is not at the start of the text');
  const r = OS.check({ fields: { vendor_gstin: CUST, buyer_gstin: H.OWN_GSTIN, invoice_number: '' }, text: ZOHO_TEXT, companies, sales: new Map() });
  assert.equal(r?.basis, 'seller_block');
  // a vendor's bill laid out the same way (its own GSTIN in the seller block) is not ours
  const vendorText = ZOHO_TEXT.replace('Dev Accelerator Limited (formerly\nknown as Dev Accelerator Pvt. Ltd.)', 'Clean Co Facility Services').replace(`GSTIN: ${H.OWN_GSTIN}`, `GSTIN: ${H.V_GSTIN}`)
    .replace(`GSTIN ${CUST}`, `Dev Accelerator Limited GSTIN ${H.OWN_GSTIN}`);
  assert.equal(OS.check({ fields: { vendor_gstin: H.V_GSTIN, buyer_gstin: H.OWN_GSTIN }, text: vendorText, companies, sales: new Map() }), null);
});

test('own sales invoice: raised after the last sync, recognised by our numbering series; generic numbering never is', () => {
  const sales = OS.salesIndex([{ company: 'devx', rows: rows(30) }]);
  assert.match(OS.byFileName({ fileName: 'IN26-27GJ2655.pdf', companies, sales }).reason, /follows Dev Accelerator Ltd's invoice numbering \(IN\/26-27\/GJ\/…\)/);
  assert.equal(OS.check({ fields: { vendor_gstin: CUST, buyer_gstin: H.OWN_GSTIN, invoice_number: 'IN/26-27/GJ/2655' }, text: '', companies, sales }).basis, 'zoho_series');
  // DevX invoice to Neddle (buyer GSTIN is Neddle's): a purchase bill for Neddle
  assert.equal(OS.check({ fields: { vendor_gstin: H.OWN_GSTIN, buyer_gstin: '24AAKFN5555Q1Z2', invoice_number: 'IN/26-27/GJ/2655' }, text: '', companies, sales }), null);
  // too few invoices for a series / a generic prefix like INV- / another prefix
  assert.equal(OS.byFileName({ fileName: 'IN26-27GJ2655.pdf', companies, sales: OS.salesIndex([{ company: 'devx', rows: rows(5) }]) }), null);
  const generic = OS.salesIndex([{ company: 'devx', rows: Array.from({ length: 40 }, (_, i) => ({ invoice_number: `INV-${String(i + 1).padStart(6, '0')}` })) }]);
  assert.equal(generic.series.size, 0);
  assert.equal(OS.byFileName({ fileName: 'INV-000555.pdf', companies, sales: generic }), null, 'vendors use INV- too');
  assert.equal(OS.byFileName({ fileName: 'IN26-27MH0001.pdf', companies, sales }), null, 'a series we do not use');
});

// ── Read all again ────────────────────────────────────────────────────────────

const BUILT_IN = { engine: 'text', fields: { description: 'Housekeeping manpower services for October' } };

async function ingest(env, name, extra = {}) {
  const r = await env.pipeline.ingest({ buffer: H.pdf(name), name, mime: 'application/pdf', source: 'erp_upload', member_id: 'm1', source_ref: { erp_ref: name }, by: 'Admin A', ...extra });
  await env.pipeline.idle();
  return env.store.bill(r.id);
}

test('read all again: only bills the built-in reader read and nobody changed; the rest are kept and counted', async () => {
  const own = { engine: 'text', text: ZOHO_TEXT, fields: { vendor_gstin: CUST, buyer_gstin: H.OWN_GSTIN, invoice_number: '', vendor_name: 'Sub Total56,226.00' } };
  const env = H.setup({ reads: { 'a.pdf': BUILT_IN, 'b.pdf': { ...BUILT_IN, fields: { ...BUILT_IN.fields, invoice_number: 'CC/121', total: 23600, sub_total: 20000, cgst: 1800, sgst: 1800, tax_total: 3600 } },
    'own.pdf': own, 'q.pdf': { engine: 'text', doc_type: 'quotation' },
    'c.pdf': { fields: { invoice_number: 'CC/130', sub_total: 5000, cgst: 450, sgst: 450, tax_total: 900, total: 5900 }, lines: [{ description: 'Housekeeping manpower services for October', amount: 5000, tax_rate: 18, tax_amount: 900 }] },
    '*': BUILT_IN } });
  await H.seedConfig();
  const a = await ingest(env, 'a.pdf');                 // built-in, untouched → read again
  const b = await ingest(env, 'b.pdf');                 // built-in, the team chose the category → kept
  await env.pipeline.edit(b.id, { category_id: 'amc' }, user);
  const o = await ingest(env, 'own.pdf');               // our own invoice the older rules missed → kept (the re-check sets it aside)
  await env.store.tx(async t => { const x = t.bill(o.id); x.own_sale = null; x.not_bill = null; x.status = 'needs_input'; t.putBill(x); });
  const q = await ingest(env, 'q.pdf');                 // set aside as a quotation → kept
  const c = await ingest(env, 'c.pdf');                 // already read by Claude → kept
  assert.equal(q.status, 'not_bill'); assert.equal(c.extraction.engine, 'claude');

  const dry = await env.pipeline.rereadAll({ by: 'Admin A', dryRun: true });
  assert.deepEqual({ queued: dry.queued, skipped: dry.skipped }, { queued: 1, skipped: { by_hand: 1, claude: 1, set_aside: 1, own_sale: 1 } });
  assert.equal((await env.store.bill(a.id)).status, a.status, 'a dry run changes nothing');

  const before = env.readCalls.length;
  const r = await env.pipeline.rereadAll({ by: 'Admin A' });
  assert.deepEqual(r.ids, [a.id]);
  const reset = await env.store.bill(a.id);
  assert.equal(reset.status, 'received'); assert.equal(reset.extraction, null);
  assert.equal(Date.parse(reset.read_lease), 0, 'the next reader may take it at once');
  assert.ok(reset.audit.some(x => x.action === 'reprocess' && /all bills read by the built-in reader, by Admin A/.test(x.detail)));
  // the online reader takes it straight away
  assert.equal(await env.pipeline.readStale({ staleMs: 315000, until: Date.now() + 120000, workers: 1, minLeftMs: 0 }), 1);
  assert.deepEqual(env.readCalls.slice(before), ['a.pdf']);
  assert.equal((await env.store.bill(b.id)).category.id, 'amc', 'the team\'s choice is untouched');
});

test('read all again (route): refused until the Claude reader is on; then counts, reads and is recorded', async () => {
  const env = H.setup({ reads: { '*': BUILT_IN } });
  await H.seedConfig();
  const router = require('..');
  const USERS = [{ id: '1', username: 'admin', name: 'Admin A', role: 'admin', active: true },
    { id: '3', username: 'rev', name: 'Rev', role: 'user', active: true, permissions: { bill_booking: { enabled: true, sections: { bb_review: true } } } }];
  const ctx = router.init({ zc: env.zc, lookups: env.lookups, files: env.files, extractFn: H.fakeExtract({ '*': BUILT_IN }, env.readCalls), loadUsers: async () => USERS, log: { error() {} } });
  const app = express(); app.use(express.json());
  app.use('/api/bill-booking', (req, res, next) => { if (req.headers['x-user']) req.user = { id: req.headers['x-user'] }; next(); }, router);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const call = (who, body) => fetch(`http://127.0.0.1:${server.address().port}/api/bill-booking/bills/reread`, { method: 'POST', headers: { 'x-user': who, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const had = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    await ingest(env, 'x.pdf');
    const off = await call('1', { dry: true });
    assert.equal(off.status, 409); assert.match((await off.json()).error, /ANTHROPIC_API_KEY is not set/);
    process.env.ANTHROPIC_API_KEY = 'test-key-not-used';   // the reader itself is the test stand-in: nothing is sent anywhere
    assert.equal((await call('3', { dry: true })).status, 403, 'needs the Configure right');
    const dry = await (await call('1', { dry: true })).json();
    assert.equal(dry.queued, 1); assert.equal(dry.dry, true);
    const real = await (await call('1', {})).json();
    assert.equal(real.queued, 1);
    await ctx.pipeline.idle();   // the office PC reads it in its own process
    assert.deepEqual(env.readCalls, ['x.pdf', 'x.pdf'], 'read once when collected, once more on request');
    assert.notEqual((await env.store.snapshot()).bills[0].status, 'received');
    const log = await env.store.auditMonth(new Date().toISOString().slice(0, 7));
    assert.ok(log.some(e => e.action === 'reread_all' && e.by === 'Admin A' && /1 bill\(s\) read again/.test(e.detail)));
  } finally {
    if (had === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = had;
    router.init({ zc: env.zc, lookups: env.lookups, files: env.files });
    server.close();
  }
});
