'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const C = require('../lib/config');

const user = { id: '1', username: 'admin', name: 'Admin A' };

async function ingestAndWait(env, name, extra = {}) {
  const r = await env.pipeline.ingest({ buffer: H.pdf(name + (extra.salt || '')), name, mime: 'application/pdf', source: 'erp_upload', member_id: 'm1', source_ref: { erp_ref: 'E1' }, by: 'Admin A', ...extra });
  await env.pipeline.idle();
  return env.store.bill(r.id);
}

async function verifyDrafts(env) {
  await env.store.tx(async t => {
    const c = C.merge(t.doc('bb_config'));
    c.settings.draft_capability = { [H.ORG]: { verified: true, status: 'draft' } };
    t.setDoc('bb_config', c);
  });
}

test('a clean bill goes all the way to Ready, with every suggestion explained', async () => {
  const env = H.setup();
  await H.seedConfig();
  const b = await ingestAndWait(env, 'hk.pdf');
  assert.equal(b.status, 'ready', JSON.stringify(b.issues));
  assert.equal(b.company, 'devx'); assert.match(b.company_basis, /GSTIN/);
  assert.equal(b.vendor.id, 'v_hk'); assert.equal(b.vendor.match, 'gstin');
  assert.equal(b.category.id, 'hk_security_gardening');
  assert.equal(b.lines[0].account.id, 'acc_hk'); assert.equal(b.lines[0].account.source, 'history');
  assert.match(b.lines[0].account.basis, /CC\/101|CC\/087/);
  assert.equal(b.lines[0].tax.id, 'tx_gst18');
  assert.equal(b.bill_level.branch.id, 'br_1'); assert.equal(b.bill_level.tds.id, 'tds_194c');
  assert.deepEqual(b.audit.map(a => a.action), ['received', 'extracted', 'evaluated']);
});

test('the same bill by email to two mailboxes and by ERP upload: one original, the rest duplicates', async () => {
  const env = H.setup();
  await H.seedConfig();
  const a = await ingestAndWait(env, 'hk.pdf', { source: 'email', source_ref: { message_id: 'msg1', mailbox: 'asha@devx.work' } });
  const again = await env.pipeline.ingest({ buffer: H.pdf('hk.pdf'), name: 'hk.pdf', mime: 'application/pdf', source: 'email', source_ref: { message_id: 'msg1' } });
  assert.equal(again.existed, true, 'a re-poll of the same email adds nothing');
  const fwd = await ingestAndWait(env, 'hk.pdf', { source: 'email', source_ref: { message_id: 'msg2', mailbox: 'ravi@devx.work' } });
  assert.equal(fwd.status, 'duplicate'); assert.equal(fwd.duplicate.certainty, 'exact'); assert.equal(fwd.duplicate.of, a.id);
  const erp = await ingestAndWait(env, 'hk-erp.pdf', { salt: 'rescan' });
  assert.equal(erp.status, 'duplicate'); assert.equal(erp.duplicate.certainty, 'likely');
  assert.equal((await env.store.bill(a.id)).status, 'ready', 'the original stays ready');
});

test('a bill already booked in Zoho is a duplicate (sync data, and live check before drafting)', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const env = H.setup({ billsFy: { window_from: '2000-01-01', data: [{ bill_id: 'zz1', vendor_id: 'v_hk', bill_number: 'CC-120', date: today, status: 'open' }] } });
  await H.seedConfig();
  const b = await ingestAndWait(env, 'hk.pdf');
  assert.equal(b.status, 'duplicate'); assert.match(b.duplicate.reason, /Already in Zoho/);

  const env2 = H.setup({ zoho: { existing: [{ bill_id: 'zz9', bill_number: 'CC/120', date: today, status: 'draft' }] } });
  await H.seedConfig();
  await verifyDrafts(env2);
  const b2 = await ingestAndWait(env2, 'hk.pdf');
  const r = await env2.pipeline.createDraft(b2.id, user);
  assert.equal(r.status, 'duplicate');
  assert.ok(!env2.zc.calls.includes('create'), 'nothing created in Zoho');
});

test('drafts need the verified draft test; the draft is created as is_draft with the original attached', async () => {
  const env = H.setup();
  await H.seedConfig();
  const b = await ingestAndWait(env, 'hk.pdf');
  await assert.rejects(env.pipeline.createDraft(b.id, user), /draft test/);
  assert.ok(!env.zc.calls.includes('create'));

  const t = await env.pipeline.draftTest('devx', { vendor_id: 'v_hk', account_id: 'acc_hk' }, user);
  assert.equal(t.verified, true); assert.equal(t.deleted, true);
  assert.equal(env.zc.created[0].payload.is_draft, true);
  assert.ok(env.zc.calls.includes('delete:zb_1'));

  const d = await env.pipeline.createDraft(b.id, user);
  assert.equal(d.status, 'draft_created');
  const p = env.zc.created[1].payload;
  assert.equal(p.is_draft, true); assert.equal(p.vendor_id, 'v_hk'); assert.equal(p.bill_number, 'CC/120');
  assert.equal(p.line_items[0].account_id, 'acc_hk'); assert.equal(p.line_items[0].tax_id, 'tx_gst18'); assert.equal(p.branch_id, 'br_1');
  assert.ok(env.zc.calls.some(c => c.startsWith('attach:zb_2:hk.pdf')));
  assert.ok(env.zc.calls.includes('post:/bills/zb_2/comments'));
  assert.equal(d.zoho.url, `https://books.zoho.in/app/${H.ORG}#/bills/zb_2`);
  await assert.rejects(env.pipeline.createDraft(b.id, user), /Already a Zoho draft/);
  assert.equal(env.zc.created.length, 2, 'a retry never creates a second bill');
});

test('if Zoho does not keep the bill as a draft, drafting stops for that organisation', async () => {
  const env = H.setup({ zoho: { billStatus: 'open' } });
  await H.seedConfig();
  const t = await env.pipeline.draftTest('devx', { vendor_id: 'v_hk', account_id: 'acc_hk' }, user);
  assert.equal(t.verified, false); assert.ok(env.zc.calls.includes('delete:zb_1'));
  await verifyDrafts(env);
  const b = await ingestAndWait(env, 'hk.pdf');
  const d = await env.pipeline.createDraft(b.id, user);
  assert.equal(d.zoho.not_draft, true);
  const cfg = await env.pipeline.config();
  assert.equal(cfg.settings.draft_capability[H.ORG].verified, false);
  assert.equal(cfg.settings.auto_create_drafts, false);
});

test('Zoho rejection → Failed with the message; a fix and retry creates the draft', async () => {
  const env = H.setup({ zoho: { createError: 'Branch is mandatory' } });
  await H.seedConfig();
  await verifyDrafts(env);
  const b = await ingestAndWait(env, 'hk.pdf');
  await assert.rejects(env.pipeline.createDraft(b.id, user), /Branch is mandatory/);
  const f = await env.store.bill(b.id);
  assert.equal(f.status, 'failed'); assert.match(f.zoho.error, /Branch is mandatory/);
  env.zc.createBill = (o => async (org, p) => { env.zc.calls.push('create'); return { bill_id: 'zok', bill_number: p.bill_number, status: 'draft', sub_total: 10000 }; })();
  const d = await env.pipeline.createDraft(b.id, user);
  assert.equal(d.status, 'draft_created');
});

test('automatic drafts when switched on and verified', async () => {
  const env = H.setup();
  await H.seedConfig({ settings: { auto_create_drafts: true } });
  await verifyDrafts(env);
  const b = await ingestAndWait(env, 'hk.pdf');
  assert.equal(b.status, 'draft_created');
  assert.equal(b.audit.find(a => a.action === 'draft_created').by, 'system (auto)');
});

// A second, different bill of the same vendor (own number and amounts)
const SECOND = { fields: { invoice_number: 'CC/121', sub_total: 20000, cgst: 1800, sgst: 1800, tax_total: 3600, total: 23600 },
  lines: [{ description: 'Housekeeping manpower services for October', hsn_sac: '998533', amount: 20000, tax_rate: 18, tax_amount: 3600 }] };

test('review tracking: opened in Zoho → Reviewed; deleted in Zoho → back to the team', async () => {
  const env = H.setup({ reads: { '*': {}, 'b.pdf': SECOND } });
  await H.seedConfig();
  await verifyDrafts(env);
  const a = await ingestAndWait(env, 'a.pdf');
  const b = await ingestAndWait(env, 'b.pdf');
  await env.pipeline.createDraft(a.id, user);
  await env.pipeline.createDraft(b.id, user);
  env.zc.zohoStatusOf.zb_1 = 'open';
  env.zc.zohoStatusOf.zb_2 = null;
  await env.pipeline.refreshZoho();
  const ra = await env.store.bill(a.id), rb = await env.store.bill(b.id);
  assert.equal(ra.status, 'reviewed'); assert.equal(ra.reviewed.by, 'Reviewer R');
  assert.equal(rb.status, 'needs_input'); assert.ok(rb.issues.some(i => i.code === 'zoho_deleted'));
});

test('no history: the team picks the account and tax, saves a mapping, and the next bill uses it', async () => {
  const carpets = { fields: { description: 'Deep cleaning of carpets' }, lines: [{ description: 'Deep cleaning of carpets', amount: 10000, tax_rate: 18, tax_amount: 1800 }] };
  const env = H.setup({ reads: { 'c1.pdf': carpets, 'c2.pdf': { fields: { ...carpets.fields, ...SECOND.fields }, lines: [{ description: 'Deep cleaning of carpets in cabins', amount: 20000, tax_rate: 18, tax_amount: 3600 }] } } });
  env.zc.vendorBills = async () => [];
  await H.seedConfig();
  const b = await ingestAndWait(env, 'c1.pdf');
  assert.equal(b.status, 'needs_input');
  assert.ok(b.issues.some(i => i.code === 'account_missing'));
  const look = { accounts: await env.lookups.accounts(H.ORG), taxes: await env.lookups.taxes(H.ORG) };
  const r = await env.pipeline.edit(b.id, { lines: [{ id: b.lines[0].id, description: b.lines[0].description, amount: 10000, account_id: 'acc_hk', tax_id: 'tx_gst18' }], remember: { accounts: true } }, user, look);
  assert.equal(r.bill.status, 'ready');
  assert.equal(r.bill.lines[0].account.source, 'manual');
  const maps = (await env.store.snapshot()).doc('bb_mappings');
  assert.equal(maps.length, 1); assert.equal(maps[0].account_id, 'acc_hk'); assert.equal(maps[0].tax_id, 'tx_gst18');
  assert.match(r.bill.audit.at(-2).detail, /mapping saved/);

  const next = await ingestAndWait(env, 'c2.pdf');
  const n = await env.store.bill(next.id);
  assert.equal(n.lines[0].account.source, 'mapping'); assert.equal(n.lines[0].tax.source, 'mapping');
  assert.equal(n.status, 'ready');
});

test('documents that are not bills are set aside — visibly — and can be brought back', async () => {
  const env = H.setup({ reads: { 'q.pdf': { doc_type: 'quotation' }, 'u.pdf': { doc_type: 'other', ...SECOND } } });
  await H.seedConfig();
  const q = await ingestAndWait(env, 'q.pdf');
  assert.equal(q.status, 'not_bill'); assert.match(q.not_bill.reason, /Quotation/);
  const back = await env.pipeline.action(q.id, 'is_bill', {}, user);
  assert.equal(back.status, 'ready');
  const u = await ingestAndWait(env, 'u.pdf', { salt: 'u' });
  assert.equal(u.status, 'needs_input', 'unclear documents go to the team, never skipped');
  assert.ok(u.issues.some(i => i.code === 'doc_type_unclear'));
});

test('a reading failure is Failed with the reason; inconsistent amounts need input', async () => {
  const env = H.setup({ reads: { 'bad.pdf': new Error('Corrupt PDF'), 'sum.pdf': { fields: { total: 15000 } } } });
  await H.seedConfig();
  const bad = await ingestAndWait(env, 'bad.pdf');
  assert.equal(bad.status, 'failed'); assert.match(bad.processing_error, /Corrupt PDF/);
  const sum = await ingestAndWait(env, 'sum.pdf', { salt: 's' });
  assert.equal(sum.status, 'needs_input');
  assert.ok(sum.issues.some(i => i.code === 'amounts_inconsistent'));
});

test('category fields: a mandatory field stops the draft until filled; it then reaches Zoho', async () => {
  const env = H.setup();
  await H.seedConfig({ categories: cats => cats.map(c => c.id !== 'hk_security_gardening' ? c : { ...c, fields: [
    C.validateField({ label: 'Service month', type: 'text', mandatory: true, source: 'team', zoho: { target: 'bill_custom_field', key: 'cf_service_month' } }).field,
  ] }) });
  await verifyDrafts(env);
  const b = await ingestAndWait(env, 'hk.pdf');
  assert.equal(b.status, 'needs_input'); assert.ok(b.issues.some(i => /Service month is required/.test(i.message)));
  const r = await env.pipeline.edit(b.id, { cat_fields: { service_month: 'Oct-2026' } }, user);
  assert.equal(r.bill.status, 'ready');
  await env.pipeline.createDraft(b.id, user);
  assert.deepEqual(env.zc.created[0].payload.custom_fields, [{ customfield_id: 'cf_1', value: 'Oct-2026' }]);
});

test('possible duplicate needs the team: dismiss makes it ready, and the decision is in the audit trail', async () => {
  const env = H.setup();
  await H.seedConfig();
  const a = await ingestAndWait(env, 'a.pdf');
  const b = await ingestAndWait(env, 'b.pdf', { fields: {} });
  await env.pipeline.edit(b.id, { fields: { invoice_number: 'CC/999' } }, user);
  const nb = await env.store.bill(b.id);
  assert.equal(nb.status, 'needs_input'); assert.equal(nb.duplicate.certainty, 'possible'); assert.equal(nb.duplicate.of, a.id);
  const d = await env.pipeline.action(b.id, 'dismiss_duplicate', { reason: 'two monthly bills, same amount' }, user);
  assert.equal(d.status, 'ready');
  assert.ok(d.audit.some(x => x.action === 'not_duplicate' && /two monthly bills/.test(x.detail)));
});
