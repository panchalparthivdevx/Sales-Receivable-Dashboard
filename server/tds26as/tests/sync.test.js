/**
 * Zoho → module sync on a fake Zoho whose answers have the shapes seen on live Zoho Books (22 Nov 2026, read-only probe of the DevX
 * ledgers): customer-payment postings with an EMPTY transaction_id and the invoice number in entry_number, a journal whose TDS lines
 * have no customer (the receivable line has it), a journal moving TDS between two TDS ledgers, a month with more than one page.
 * All values are synthetic.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const BS = require('../lib/booksSync');
const BM = require('../lib/booksModel');
const store = require('../lib/store');

const ORG = '99999999';
const L194I = '9000000001', LFY = '9000000002', L194C = '9000000003';
const ENTITY = { id: 'syn', name: 'Synthetic Ltd', pan: 'ZZZPS0001Z', org_id: ORG, active: true, ledgers: [{ account_id: L194I, name: '194I', section: '194I' }, { account_id: LFY, name: 'TDS Receivable U/s. 194I F.Y.2025-26', section: '194I' }, { account_id: L194C, name: '194C', section: '194C' }], tan_field: 'cf_organization_tan_number' };

function fakeZoho() {
  const calls = [];
  const T = (o) => ({ categorized_transaction_id: o.ct, transaction_type: o.type, transaction_id: o.tid ?? '', transaction_date: o.date, transaction_type_formatted: o.type, account_id: o.acc, customer_id: o.cust || '', payee: o.payee || '',
    description: o.desc || '', entry_number: o.no || '', currency_code: 'INR', debit_or_credit: o.dr ? 'debit' : 'credit', offset_account_name: '', reference_number: '', debit_amount: o.dr || '', credit_amount: o.cr || '' });
  const ledger = {
    [L194I]: [
      T({ ct: 'ct1', type: 'invoice', tid: 'inv1', date: '2026-10-05', acc: L194I, cust: 'c1', payee: 'SYN ONE PVT LTD', no: 'IN/26-27/0001', dr: 2247 }),
      T({ ct: 'ct2', type: 'journal', tid: 'jr1', date: '2026-10-20', acc: L194I, cust: 'c1', payee: 'SYN ONE PVT LTD', no: 'JR/0001', desc: 'TDS Booked Against Invoice No. IN/26-27/0001 (Previous FY TDS Transferred)', cr: 500 }),
      T({ ct: 'ct3', type: 'journal', tid: 'jr2', date: '2026-10-30', acc: L194I, no: 'JR/0002', desc: 'IN/26-27/0002 - TDS Receivable of group company', dr: 1000 }),
      T({ ct: 'ct9', type: 'invoice', tid: 'inv9', date: '2026-10-31', acc: L194I, cust: 'c3', payee: 'SYN THREE', no: 'IN/26-27/0009', dr: 99 }),
    ],
    [LFY]: [T({ ct: 'ct4', type: 'journal', tid: 'jr1', date: '2026-10-20', acc: LFY, cust: 'c1', payee: 'SYN ONE PVT LTD', no: 'JR/0001', dr: 500 })],
    [L194C]: [
      T({ ct: 'ct5', type: 'customer_payment', tid: '', date: '2026-10-07', acc: L194C, cust: 'c2', payee: 'SYN TWO LLP', no: 'IN/26-27/0002', dr: 460 }),
      T({ ct: 'ct6', type: 'journal', tid: 'jr2', date: '2026-10-30', acc: L194C, no: 'JR/0002', desc: 'IN/26-27/0002 - TDS Receivable of group company', dr: 580.2 }),
      ...Array.from({ length: 230 }, (_, i) => T({ ct: `bulk${i}`, type: 'invoice', tid: `binv${i}`, date: `2026-11-${String(1 + (i % 20)).padStart(2, '0')}`, acc: L194C, cust: 'c2', payee: 'SYN TWO LLP', no: `IN/26-27/B${i}`, dr: 10 })),
    ],
  };
  const invoices = {
    inv1: { invoice_id: 'inv1', invoice_number: 'IN/26-27/0001', date: '2026-10-05', customer_id: 'c1', customer_name: 'SYN ONE PVT LTD', sub_total: 22470, tax_total: 4044.6, total: 24268, tds_amount: '2247.000', tds_percent: '10.00', tds_section: 'rent_land_furniture', tds_summary: [{ tds_name: '194I', tds_amount: 2247 }], cf_organization_tan_number: 'AHMS00001S', last_modified_time: '2026-10-05T10:00:00+0530' },
    inv2: { invoice_id: 'inv2', invoice_number: 'IN/26-27/0002', date: '2026-09-01', customer_id: 'c2', customer_name: 'SYN TWO LLP', sub_total: 46000, tax_total: 8280, total: 54280, tds_amount: '0', tds_summary: [], cf_organization_tan_number: 'AHMS00002S', last_modified_time: '2026-09-01T10:00:00+0530' },
    inv9: { invoice_id: 'inv9', invoice_number: 'IN/26-27/0009', date: '2026-10-31', customer_id: 'c3', customer_name: 'SYN THREE', sub_total: 990, tax_total: 178.2, total: 1069.2, tds_amount: '99', tds_summary: [{ tds_name: '194I' }], last_modified_time: '2026-10-31T10:00:00+0530' },
  };
  for (let i = 0; i < 230; i++) invoices[`binv${i}`] = { invoice_id: `binv${i}`, invoice_number: `IN/26-27/B${i}`, date: '2026-11-01', customer_id: 'c2', customer_name: 'SYN TWO LLP', sub_total: 500, tax_total: 90, total: 580, tds_amount: '10', tds_summary: [{ tds_name: '194C' }], last_modified_time: '2026-11-01T10:00:00+0530' };
  const payments = { p1: { payment_id: 'p1', payment_number: 'CP/0001', date: '2026-10-07', customer_id: 'c2', customer_name: 'SYN TWO LLP', amount: 26680, tax_amount_withheld: 460, tax_account_id: L194C, invoice_numbers: 'IN/26-27/0002',
    invoices: [{ invoice_id: 'inv2', invoice_number: 'IN/26-27/0002', amount_applied: 26680, tax_amount_withheld: 460, total: 54280, date: '2026-09-01' }], last_modified_time: '2026-10-07T10:00:00+0530' } };
  const journals = {
    jr1: { journal_id: 'jr1', entry_number: 'JR/0001', journal_date: '2026-10-20', notes: 'TDS Booked Against Invoice No. IN/26-27/0001', reference_number: '', line_items: [{ account_id: L194I, customer_id: 'c1', customer_name: 'SYN ONE PVT LTD', debit_or_credit: 'credit', amount: 500 }, { account_id: LFY, customer_id: 'c1', customer_name: 'SYN ONE PVT LTD', debit_or_credit: 'debit', amount: 500 }] },
    jr2: { journal_id: 'jr2', entry_number: 'JR/0002', journal_date: '2026-10-30', notes: 'IN/26-27/0002 - TDS Receivable of group company', reference_number: '', line_items: [{ account_id: 'ar', customer_id: 'c2', customer_name: 'SYN TWO LLP', debit_or_credit: 'credit', amount: 1580.2 }, { account_id: L194I, customer_id: '', debit_or_credit: 'debit', amount: 1000 }, { account_id: L194C, customer_id: '', debit_or_credit: 'debit', amount: 580.2 }] },
  };
  const zr = {
    calls, deleted: new Set(),
    async get(org, path, params, { before } = {}) {
      if (before) await before();
      calls.push({ org, path, params: { ...params } });
      assert.equal(org, ORG, 'every call names the organisation');
      if (path === '/chartofaccounts/transactions') {
        const rows = (ledger[params.account_id] || []).filter(r => !zr.deleted.has(r.categorized_transaction_id) && r.transaction_date >= params['date.start'] && r.transaction_date <= params['date.end']).sort((a, b) => b.transaction_date.localeCompare(a.transaction_date));
        const page = params.page || 1, per = params.per_page || 200;
        return { transactions: rows.slice((page - 1) * per, page * per), page_context: { page, has_more_page: rows.length > page * per } };
      }
      if (path === '/customerpayments') return { customerpayments: Object.values(payments).filter(p => p.date >= params.date_start && p.date <= params.date_end), page_context: { has_more_page: false } };
      const m = path.match(/^\/(invoices|customerpayments|journals)\/(.+)$/);
      if (m) { const src = { invoices, customerpayments: payments, journals }[m[1]][m[2]]; if (!src) throw Object.assign(new Error('not found'), { response: { status: 404, data: { code: 1002 } } }); return { [{ invoices: 'invoice', customerpayments: 'payment', journals: 'journal' }[m[1]]]: src }; }
      throw new Error(`unexpected GET ${path}`);
    },
    isGone: e => !!(e && e.response && e.response.status === 404), errText: e => e.message, identity: () => 'fake',
  };
  return zr;
}

async function runAll(sync, args) { let r = await sync.step(args); let n = 0; while (r.more && n++ < 50) r = await sync.step({ entity: args.entity, maxMs: args.maxMs }); return r; }

test('first sync: ledgers month by month (paged month split), details, and the items built from them', async () => {
  H.tempStore();
  await store.write('config', { sync: { rate_per_min: 600000, ledger_rate_per_min: 600000, concurrency: 3, daily_budget: 100000, step_seconds: 60 } });
  const zr = fakeZoho();
  const sync = BS.create({ zr, cfgNow: H.cfgNow });
  const r = await runAll(sync, { entity: ENTITY, from: '2026-10-01', to: '2026-11-30', mode: 'changes', by: 't', maxMs: 60000 });
  assert.equal(r.more, false); assert.ok(!r.error, r.error);
  const rows = await sync.ledgerRows('syn');
  assert.equal(rows.length, 4 + 1 + 2 + 230, 'every posting, none twice (the 230-row month was split into smaller windows)');
  assert.ok(zr.calls.filter(c => c.path === '/chartofaccounts/transactions' && c.params['date.start'] !== '2026-11-01' && c.params['date.start'] > '2026-11-01').length > 0, 'the November ledger was read in smaller windows');
  assert.ok(zr.calls.every(c => !/POST|PUT|DELETE/i.test(c.path)));
  const docs = await sync.docs('syn');
  assert.ok(docs.invoices.inv1, 'invoice on the ledger'); assert.ok(docs.payments.p1, 'payment behind the posting'); assert.ok(docs.invoices.inv2, 'invoice the payment settles'); assert.ok(docs.journals.jr2, 'journal');
  assert.equal(docs.invoices.inv1.tan, 'AHMS00001S', 'the client TAN custom field is kept');

  const b = BM.build({ entity: ENTITY, rows, docs });
  const it = k => b.items.find(i => i.key.startsWith(k));
  const inv = it('zi:inv1');
  assert.deepEqual([inv.amount, inv.base.basic, inv.base.gst, inv.base.comparable, inv.section], [224700, 2247000, 404460, 2247000, '194I']);
  const pay = b.items.find(i => i.type === 'customer_payment');
  assert.equal(pay.payment.id, 'p1', 'the payment behind a posting with an empty transaction id is found');
  assert.equal(pay.base.comparable, Math.round(4600000 * (2714000 / 5428000)), 'half the invoice is settled');
  assert.equal(b.transfers.length, 1, 'the journal moving TDS between the two 194I ledgers is a transfer');
  assert.ok(!b.items.some(i => i.key.startsWith('zj:jr1')), 'and is not counted');
  const jr = b.items.filter(i => i.key.startsWith('zj:jr2'));
  assert.equal(jr.length, 2, 'one entry per section of the journal');
  assert.ok(jr.every(i => i.customer_id === 'c2' && i.customer_basis === 'journal_line'), 'customer taken from the receivable line');
  assert.deepEqual(jr.map(i => i.amount).sort((a, c) => a - c), [58020, 100000]);
  assert.equal(b.items.reduce((a, i) => a + i.amount, 0), b.ledger_total, 'Σ entries = Σ ledger postings');
});

test('changes sync: listings again, details only for what is new; a posting deleted in Zoho disappears', async () => {
  H.tempStore();
  await store.write('config', { sync: { rate_per_min: 600000, ledger_rate_per_min: 600000, concurrency: 3, daily_budget: 100000, step_seconds: 60 } });
  const zr = fakeZoho();
  const sync = BS.create({ zr, cfgNow: H.cfgNow });
  await runAll(sync, { entity: ENTITY, from: '2026-10-01', to: '2026-11-30', mode: 'changes', by: 't', maxMs: 60000 });
  const first = zr.calls.length;
  const detailsFirst = zr.calls.filter(c => /^\/(invoices|journals|customerpayments)\//.test(c.path)).length;
  zr.deleted.add('ct9');
  zr.calls.length = 0;
  await runAll(sync, { entity: ENTITY, from: '2026-10-01', to: '2026-11-30', mode: 'changes', by: 't', maxMs: 60000 });
  const detailsAgain = zr.calls.filter(c => /^\/(invoices|journals|customerpayments)\//.test(c.path)).length;
  assert.ok(detailsFirst > 200);
  assert.equal(detailsAgain, 0, 'nothing is fetched again when nothing changed');
  assert.ok(zr.calls.length < first / 5);
  assert.ok(!(await sync.ledgerRows('syn')).some(r => r.id === 'ct9'), 'the deleted posting is gone after the month is listed again');
  const st = await sync.status('syn');
  assert.ok(st.last_ok_at && st.listed['2026-10'] && st.listed['2026-11']);
});

test('the daily budget stops a sync and keeps its place', async () => {
  H.tempStore();
  await store.write('config', { sync: { rate_per_min: 600000, ledger_rate_per_min: 600000, concurrency: 3, daily_budget: 5, step_seconds: 60 } });
  const zr = fakeZoho();
  const sync = BS.create({ zr, cfgNow: H.cfgNow });
  const r = await sync.step({ entity: ENTITY, from: '2026-10-01', to: '2026-11-30', mode: 'changes', by: 't', maxMs: 60000 });
  assert.ok(r.limit && /allowance/.test(r.error));
  assert.ok(zr.calls.length <= 5);
  const st = await sync.status('syn');
  assert.ok(st.run && st.run.months_todo.length >= 1, 'the run is kept and continues tomorrow');
});

test('the ledger report is paced on its own, slower clock; months of one quarter are read in one window', async () => {
  H.tempStore();
  await store.write('config', { sync: { rate_per_min: 600000, ledger_rate_per_min: 300, concurrency: 3, daily_budget: 100000, step_seconds: 60 } });   // 300 a minute = 200 ms apart
  const zr = fakeZoho();
  const stamps = [];
  const get0 = zr.get;
  zr.get = async (org, path, params, opts) => { const r = await get0(org, path, params, opts); if (path === '/chartofaccounts/transactions') stamps.push(Date.now()); return r; };
  const sync = BS.create({ zr, cfgNow: H.cfgNow });
  await runAll(sync, { entity: ENTITY, from: '2026-10-01', to: '2026-10-31', mode: 'changes', by: 't', maxMs: 60000 });
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  assert.ok(gaps.length >= 2 && gaps.every(g => g >= 190), `report calls at least 200 ms apart (got ${gaps.join(', ')})`);
  zr.calls.length = 0;
  await runAll(sync, { entity: ENTITY, from: '2026-10-01', to: '2026-12-31', mode: 'changes', by: 't', maxMs: 60000 });
  const report = zr.calls.filter(c => c.path === '/chartofaccounts/transactions');
  const windows = report.filter(c => c.params.page === 1 && c.params['date.start'] === '2026-10-01' && c.params['date.end'] === '2026-12-31');
  assert.equal(windows.length, 3, 'one Oct–Dec window per ledger');
  assert.ok(report.length < 3 * 3, `fewer calls than one per ledger per month (${report.length}, of which the extra ones split the busy November)`);
});

test('a Zoho block of the ledger report (code 43, "wait 60 minutes") stops the sync and nothing asks again before it ends', async () => {
  H.tempStore();
  await store.write('config', { sync: { rate_per_min: 600000, ledger_rate_per_min: 600000, concurrency: 3, daily_budget: 100000, step_seconds: 60 } });
  const zr = fakeZoho();
  let n = 0;
  const get0 = zr.get;
  zr.get = async (org, path, params, opts) => {
    if (path === '/chartofaccounts/transactions' && ++n > 1) { if (opts && opts.before) await opts.before(); const e = new Error('Zoho asked us to wait 60 minutes (rate limit) — the sync stopped and will resume on the next run.'); e.name = 'ZohoLimit'; throw e; }
    return get0(org, path, params, opts);
  };
  const sync = BS.create({ zr, cfgNow: H.cfgNow });
  const r = await sync.step({ entity: ENTITY, from: '2026-10-01', to: '2026-11-30', mode: 'changes', by: 't', maxMs: 60000 });
  assert.match(r.error, /wait 60 minutes/);
  const st = await sync.status('syn');
  assert.ok(Date.parse(st.blocked_until) > Date.now() + 59 * 60000, 'the end of the block is remembered');
  assert.ok(st.run && st.run.months_todo.length, 'the run is kept');
  const before = n;
  const again = await sync.step({ entity: ENTITY, maxMs: 60000 });
  assert.match(again.error, /paused its ledger report/);
  assert.equal(n, before, 'no further call to the report while it is blocked');
});
