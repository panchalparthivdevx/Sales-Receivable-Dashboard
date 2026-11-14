/**
 * Budget, rent, expense projection, debt schedule, covenants, branch master and the collections & payments forecast,
 * on SYNTHETIC data (made-up clients, landlords and amounts — not company data). Months are relative to today.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');
const S = require('../lib/sources');
const BU = require('../lib/budget');
const DB = require('../lib/debt');
const BR = require('../lib/branches');
const FC = require('../lib/forecast');

const base = S.lastCompleteMonth();
const m = k => S.addMonths(base, k);              // m(1) = the current month = the first budget month
const dim = S.daysInMonth;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

function rentWb() {
  const head = ['Branch', 'Vendor Name', 'Office No', 'Payment Terms', 'Agreement Start From', 'Agreement Ends On', 'Module Starts On', 'Module Ends On', 'Increment On', 'Increment %', 'Amount', 'TDS %', 'Carpet', 'Super Buildeup Area'];
  const start = `${m(-11)}-01`;
  const rows = [['Amd_X', 'Landlord One', '101', 7, start, `${m(3)}-15`, start, `${base}-${dim(base)}`, start, 5, 50000, 10, 1000, 1400]];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows]), 'Sheet1');
  return wb;
}
const inv = (id, cust, name, date, sub, extra = {}) => ({ invoice_id: id, invoice_number: id.toUpperCase(), customer_id: cust, customer_name: name, branch_name: 'Amd_X', date, due_date: date, status: 'paid', total: sub * 1.18, balance: 0, ...extra });
const INVOICES = [
  inv('i1', 'cA', 'Alpha Pvt Ltd', `${base}-05`, 100000, { last_payment_date: `${base}-20` }),
  inv('i0', 'cA', 'Alpha Pvt Ltd', `${m(-1)}-05`, 100000, { last_payment_date: `${m(-1)}-20` }),
  inv('i2', 'cB', 'Beta LLP', `${base}-10`, 50000, { status: 'sent', balance: 59000 }),
  inv('i3', 'cS', 'DEV ACCELERATOR LIMITED', `${base}-01`, 1000000),
  inv('i4', 'cA', 'Alpha Pvt Ltd', `${base}-02`, 70000, { status: 'void' }),
];
const SUBS = { i0: 100000, i1: 100000, i2: 50000, i3: 1000000, i4: 70000 };
// electricity ₹10,000 every month; loan interest ₹5,000; both on accounts a1 / a2
const txns = (fy, amount) => ({ fetched_at: new Date().toISOString(), transactions: S.monthsBetween(m(-11), base).filter(x => S.fyOfMonth(x) === fy).map(x => ({ transaction_date: `${x}-28`, debit_amount: amount, credit_amount: 0 })) });
const OPS = {
  readSynced: async e => ({
    invoices_fy: { data: INVOICES, synced_at: new Date().toISOString() }, invoices_paid_12mo: { data: [] }, invoices_unpaid: { data: [] },
    customer_payments_fy: { data: [{ customer_id: 'cA', amount: 108000, tax_amount_withheld: 10000 }] },
    bills_fy: { data: [{ bill_id: 'b1', bill_number: 'B-1', vendor_id: 'v1', vendor_name: 'Vendor One', date: `${m(-1)}-01`, total: 20000, balance: 0, status: 'paid', branch_name: 'Amd_X' },
      { bill_id: 'b2', bill_number: 'B-2', vendor_id: 'v1', vendor_name: 'Vendor One', date: `${base}-25`, total: 30000, balance: 30000, status: 'open', branch_name: 'Amd_X' }] },
    bills_open: { data: [] }, bills_overdue: { data: [] },
    vendor_payments_fy: { data: [{ vendor_id: 'v1', vendor_name: 'Vendor One', date: `${m(-1)}-21`, bill_numbers: 'B-1' }] },
  })[e] || null,
  invoiceSubtotals: async () => SUBS,
  plMapping: async () => ({ heads: [{ id: 'revenue', label: 'Revenue', is_income: true, accounts: [{ account_id: 'r1' }] }, { id: 'electricity', label: 'Electricity', accounts: [{ account_id: 'a1' }] }, { id: 'interest_loan', label: 'Interest on loan', accounts: [{ account_id: 'a2' }] }] }),
  plAcctTxns: async (fy, id) => (id === 'a1' ? txns(fy, 10000) : id === 'a2' ? txns(fy, 5000) : null),
  rentWorkbook: async () => ({ file: 'Rent (synthetic).xlsx', wb: rentWb() }),
  rentBillDetails: async () => ({}),
  branches: async () => [{ name: 'Amd_X' }, { name: 'Pun_Y' }],
  plCapacity: async () => ({ Amd_X: { seats: 120, sqft: 6000 } }),
};
S.setOps(OPS);

const version = (settings = {}) => ({ id: 'v1', name: 'Test', settings: { ...BU.DEFAULT_SETTINGS(), ...settings } });
const row = (g, id) => g.rows.find(r => r.id === id);

test('budget revenue: run-rate until the end date, escalation, self-invoices and void invoices left out', async () => {
  const contracts = [{ id: 'k1', customerId: 'cA', client: 'Alpha Pvt Ltd', endDate: `${m(3)}-15`, escalationPct: 10, escalationDate: `${m(2)}-01`, source: 'test' }];
  const g = await BU.compute(version(), { contracts, rentOverrides: [], manual: [], overrides: {} });
  assert.strictEqual(g.months[0], m(1));
  const a = row(g, 'rev:cA');
  near(a.values[m(1)], 100000);
  near(a.values[m(2)], 110000);
  near(a.values[m(3)], 110000 * 15 / dim(m(3)));
  assert.strictEqual(a.values[m(4)], 0);
  const b = row(g, 'rev:cB');
  near(b.values[m(1)], 50000);
  near(b.values[g.months[g.months.length - 1]], 50000);
  assert.ok(b.meta.flags.some(f => /No end date/.test(f)));
  // billed only in the base month: flagged as a possible one-off; a client billed the same every month is not
  assert.ok(b.meta.flags.some(f => /only in the base month/.test(f)));
  assert.ok(!a.meta.flags.some(f => /one-off|only in the base month/.test(f)));
  assert.strictEqual(g.flags.oneOff, 1);
  assert.ok(!g.rows.some(r => /DEV ACCELERATOR/i.test(r.label)), 'self-invoice is not revenue');
  assert.strictEqual(g.sources.invoices.selfExcluded, 1);
  near(g.totals[m(1)].revenue, 150000);
  // clients without an end date can be left out
  const g2 = await BU.compute(version({ noEndDate: 'stop' }), { contracts, rentOverrides: [], manual: [], overrides: {} });
  assert.ok(!row(g2, 'rev:cB'));
});

test('budget rent: module amount, increment once after the module, agreement end date and override', async () => {
  const g = await BU.compute(version(), { contracts: [], rentOverrides: [], manual: [], overrides: {} });
  const r = row(g, 'rent:Amd_X|Landlord One|101');
  // the increment on the module's start is already in the module amount: one 5% step 12 months later
  near(r.values[m(1)], 52500);
  near(r.values[m(2)], 52500);
  near(r.values[m(3)], 52500 * 15 / dim(m(3)));
  assert.strictEqual(r.values[m(4)], 0);
  const g2 = await BU.compute(version(), { contracts: [], rentOverrides: [{ key: 'Amd_X|Landlord One|101', endDate: `${m(5)}-${dim(m(5))}`, source: 'renewal letter' }], manual: [], overrides: {} });
  const r2 = row(g2, 'rent:Amd_X|Landlord One|101');
  near(r2.values[m(4)], 52500);
  near(r2.values[m(5)], 52500);
  assert.strictEqual(r2.values[m(6)], 0);
  assert.strictEqual(BU.byStatementLine(g, `${m(1)}-01`, `${m(1)}-${dim(m(1))}`).values['m.lease'], r.values[m(1)]);
});

test('budget expenses: 12-month methods, debt-schedule interest, manual lines and cell overrides', async () => {
  const debtInterest = { [m(1)]: 7000, [m(2)]: 6500 };
  const manual = [{ id: 'x1', versionId: 'v1', section: 'expense', head: 'electricity', label: 'New hire', from: m(2), to: m(3), monthly: 20000, growthPct: 0 }];
  const overrides = { [`exp:electricity|${m(1)}`]: { v: 12345, by: 'test', at: 'now' } };
  const g = await BU.compute(version(), { contracts: [], rentOverrides: [], manual, overrides, debtInterest });
  const e = row(g, 'exp:electricity');
  assert.strictEqual(e.meta.method, 'trend');
  assert.strictEqual(e.values[m(1)], 12345);
  assert.ok(e.overridden[m(1)]);
  near(e.values[m(2)], 10000);
  const i = row(g, 'exp:interest_loan');
  assert.strictEqual(i.meta.method, 'debt');
  assert.strictEqual(i.values[m(2)], 6500);
  const man = row(g, 'man:x1');
  assert.strictEqual(man.values[m(1)], 0);
  assert.strictEqual(man.values[m(2)], 20000);
  assert.strictEqual(man.values[m(4)], 0);
  // EBITDA adds back finance costs; the result after finance costs does not
  const t = g.totals[m(2)];
  near(t.ebitda - t.result, 6500);
  // per-head method
  const g2 = await BU.compute(version({ headMethods: { electricity: 'zero' } }), { contracts: [], rentOverrides: [], manual: [], overrides: {} });
  assert.strictEqual(row(g2, 'exp:electricity').values[m(2)], 0);
  // the trend is held within ±50% of the average
  const steep = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((v, k) => ({ m: k, v: v * 1000 }));
  assert.strictEqual(BU.project(steep, 'trend', 24, 0.5), 6500 * 1.5);
});

test('debt: EMI, equal principal and bullet schedules; covenant status', () => {
  const f = { outstanding: 300000, outstandingAsAt: '2029-12-31', interestRate: 12, frequency: 'Monthly', firstDueDate: '2030-01-31', maturityDate: '2030-12-31' };
  const emi = DB.generate({ ...f, repaymentType: 'EMI' });
  assert.strictEqual(emi.rows.length, 12);
  near(emi.rows.reduce((s, r) => s + r.principal, 0), 300000, 1);
  const eq = DB.generate({ ...f, repaymentType: 'Equal principal' });
  near(eq.rows[0].principal, 25000, 1);
  near(eq.rows[0].interest, 300000 * 0.12 * 31 / 365, 1);
  const bl = DB.generate({ ...f, repaymentType: 'Bullet' });
  near(bl.rows[bl.rows.length - 1].principal, 300000, 1);
  assert.ok(bl.rows.slice(0, -1).every(r => !r.principal));
  assert.ok(DB.generate({ repaymentType: 'EMI' }).error);
  const doc = { facilities: [{ id: 'f1', basis: 'SA' }], schedule: emi.rows.map(r => ({ facilityId: 'f1', ...r })) };
  near(Object.values(DB.monthly(doc).principal).reduce((s, x) => s + x, 0), 300000, 1);
  const cov = { id: 'c1', operator: '>=', threshold: 1.2 };
  assert.strictEqual(DB.status(cov, []).status, 'Missing data');
  assert.strictEqual(DB.status(cov, [{ covenantId: 'c1', periodEnd: '2026-03-31', value: 1.1 }]).status, 'Breach');
  const ok = DB.status(cov, [{ covenantId: 'c1', periodEnd: '2026-03-31', value: 1.1 }, { covenantId: 'c1', periodEnd: '2026-09-30', value: 1.5 }]);
  assert.strictEqual(ok.status, 'Within threshold');
  near(ok.headroom, 0.3, 1e-9);
});

test('debt: the Excel format reads back, and a facility without schedule rows gets one generated', () => {
  const wb = XLSX.read(DB.template(), { type: 'buffer' });
  assert.deepStrictEqual(wb.SheetNames, ['Instructions', 'Facilities', 'Repayment schedule', 'Covenants', 'Covenant tests']);
  const head = XLSX.utils.sheet_to_json(wb.Sheets.Facilities, { header: 1 })[0];
  const val = { lender: 'Bank A', facilityName: 'TL-1', facilityType: 'Term loan', basis: 'Standalone', outstanding: 120000, outstandingAsAt: '2029-12-31', interestRate: 10, repaymentType: 'Equal principal', frequency: 'Quarterly', firstDueDate: '2030-03-31', maturityDate: '2030-12-31', source: 'sanction letter' };
  wb.Sheets.Facilities = XLSX.utils.aoa_to_sheet([head, DB.FAC_FIELDS.map(([k]) => val[k] ?? null)]);
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const { doc, errors } = DB.parseUpload(out, 'tester');
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(doc.facilities.length, 1);
  assert.strictEqual(doc.facilities[0].basis, 'SA');
  assert.strictEqual(doc.schedule.length, 4);
  near(doc.schedule[0].principal, 30000, 1);
});

test('branch master: required fields, model and zone wording, suggestions', async () => {
  const b = BR.normalise({ name: 'Amd_X', city: 'Ahmedabad', state: 'Gujarat', model: 'furnished by landlord', zone: 'non sez', seats: '120', revenueStart: '01/04/2024' }, 'tester');
  assert.strictEqual(b.model, 'Furnished by Landlord');
  assert.strictEqual(b.zone, 'Non-SEZ');
  assert.strictEqual(b.seats, 120);
  assert.strictEqual(b.revenueStart, '2024-04-01');
  assert.deepStrictEqual(BR.validate(b), []);
  assert.ok(BR.validate(BR.normalise({ name: 'Pun_Y' }, 't')).length >= 4);
  const sug = await BR.suggestions([b]);
  assert.deepStrictEqual(sug.map(x => x.name), ['Pun_Y'], 'saved branches are not suggested again');
  const sug2 = await BR.suggestions([]);
  const x = sug2.find(s => s.name === 'Amd_X');
  assert.strictEqual(x.seats, 120);
  assert.strictEqual(x.city, 'Ahmedabad');
  assert.ok(x.suggested);
});

test('forecast: client payment days, GST and TDS, current month not counted twice, debt service and opening cash', async () => {
  const g = await BU.compute(version(), { contracts: [], rentOverrides: [], manual: [], overrides: {} });
  const debtDoc = { facilities: [{ id: 'f1', facilityName: 'TL-1' }], schedule: [{ facilityId: 'f1', dueDate: `${m(2)}-05`, principal: 25000, interest: 3000 }] };
  const f = await FC.build({ grid: g, debtDoc, settings: { months: 6 }, manual: [{ id: 'q', dir: 'in', month: m(3), amount: 99999, label: 'Deposit refund' }], opening: { amount: 1000000, asAt: S.todayIso(), source: 'entered' } });
  const cp = await FC.clientPatterns(await S.invoices());
  assert.strictEqual(cp.patterns.get('cA').medianDays, 15);
  near(cp.patterns.get('cA').tdsShare, 10000 / 118000, 1e-9);
  // Alpha: ₹1,00,000 a month + 18% GST − TDS share = ₹1,08,000 collected 15 days after the usual invoice day (the 5th)
  const a2 = f.flows.find(x => x.kind === 'Budgeted revenue' && x.party === 'Alpha Pvt Ltd' && x.month === m(2));
  near(a2.amount, 108000, 0.5);
  assert.strictEqual(a2.date, `${m(2)}-20`);
  // Beta's open invoice is past its expected date (last month): by default still expected this month, unless it is
  // more than 60 days late — then listed as doubtful and left out
  const beta = f.flows.find(x => x.party === 'Beta LLP' && x.kind.startsWith('Overdue invoices'));
  assert.strictEqual(beta.month, m(1));
  near(beta.amount, 59000 * (1 - 10000 / 118000), 0.5);
  assert.ok(!f.overdue.in.length);
  const strict = await FC.build({ grid: g, debtDoc, settings: { months: 3, overdueDays: 0 }, manual: [], opening: null });
  assert.ok(strict.overdue.in.some(x => x.party === 'Beta LLP'));
  assert.ok(!strict.flows.some(x => x.party === 'Beta LLP' && x.kind.startsWith('Overdue invoices')));
  // debt service on its due date; the manual receipt in its month
  assert.strictEqual(f.table.find(r => r.month === m(2)).outs['Debt service'], 28000);
  assert.strictEqual(f.table.find(r => r.month === m(3)).ins.Manual, 99999);
  // running balance
  const t0 = f.table[0];
  assert.strictEqual(t0.opening, 1000000);
  near(f.table[1].opening, t0.closing);
  // vendor history: bill B-1 paid 20 days after its date; the open bill B-2 is expected 20 days after its date
  assert.strictEqual(f.company.vendors.medianDays, 20);
  // current month: a client invoiced this month has that billing taken off the budget
  const nowInv = { ...INVOICES[0], invoice_id: 'i9', invoice_number: 'I9', date: S.todayIso(), status: 'sent', balance: 118000, last_payment_date: null };
  INVOICES.push(nowInv); SUBS.i9 = 100000;
  try {
    const f2 = await FC.build({ grid: g, debtDoc, settings: { months: 3 }, manual: [], opening: null });
    assert.ok(!f2.flows.some(x => x.kind === 'Budgeted revenue' && x.party === 'Alpha Pvt Ltd' && x.label === `${m(1)} billing`), 'already invoiced in full this month');
    assert.ok(f2.flows.some(x => x.kind === 'Open invoices' && x.label === 'I9'));
    assert.strictEqual(f2.table[0].closing, null, 'no opening cash → no closing balance');
  } finally { INVOICES.pop(); delete SUBS.i9; }
});

test('planning API: rights, budget version, cell change, client end date, freeze, branch master, debt, forecast, export', async () => {
  const H = require('./helpers');
  H.tempStore();
  const srv = H.app(require('..')).listen(0);
  const B = '/api/fin-reporting';
  const go = (method, url, body, user) => H.call(srv, method, B + url, { body, user });
  try {
    assert.strictEqual((await go('POST', '/budget/versions', { name: 'x' }, '2')).status, 403, 'needs the Management inputs right');
    const v = (await go('POST', '/budget/versions', { name: 'FY test' })).body.version;
    let g = (await go('GET', `/budget/compute?version=${v.id}`)).body;
    assert.strictEqual(g.unit, 'lakh');
    near(g.totals[m(1)].revenue, 1.5);
    assert.deepStrictEqual(g.revenueCheck, []);
    assert.strictEqual((await go('POST', '/budget/override', { versionId: v.id, rowId: 'rev:cB', month: m(1), value: 0, note: 'lost' })).status, 200);
    assert.strictEqual((await go('POST', '/budget/clients', { items: [{ customerId: 'cB', client: 'Beta LLP', endDate: `${m(2)}-${dim(m(2))}` }] })).status, 400, 'source is required');
    assert.strictEqual((await go('POST', '/budget/clients', { items: [{ customerId: 'cB', client: 'Beta LLP', endDate: `${m(2)}-${dim(m(2))}`, source: 'client email' }] })).status, 200);
    g = (await go('GET', `/budget/compute?version=${v.id}`)).body;
    const b = g.rows.find(r => r.id === 'rev:cB');
    assert.strictEqual(b.values[m(1)], 0);
    assert.ok(b.overridden[m(1)]);
    near(b.values[m(2)], 0.5);
    assert.strictEqual(b.values[m(3)], 0);
    assert.strictEqual((await go('POST', `/budget/versions/${v.id}/freeze`, {})).status, 200);
    assert.strictEqual((await go('GET', `/budget/compute?version=${v.id}`)).body.version.frozen, true);
    assert.strictEqual((await go('POST', '/budget/override', { versionId: v.id, rowId: 'rev:cA', month: m(1), value: 1 })).status, 400, 'frozen');
    const x = await H.call(srv, 'GET', `${B}/budget/export?version=${v.id}`, { raw: true });
    assert.strictEqual(x.status, 200);
    assert.match(x.headers.get('content-type'), /spreadsheetml/);
    assert.strictEqual((await go('GET', `/budget/vs-actual?version=${v.id}&period=FY2027-Q2`)).body.code, 'NO_IMPORT');

    assert.strictEqual((await go('POST', '/branches', { name: 'Amd_X' })).status, 400);
    assert.strictEqual((await go('POST', '/branches', { items: [{ name: 'Amd_X', seats: 120, revenueStart: '2024-04-01' }], draft: true })).status, 200);
    const br = (await go('GET', '/branches')).body;
    assert.strictEqual(br.items.length, 1);
    assert.ok(br.items[0].missing.length > 0);
    assert.deepStrictEqual(br.suggestions.map(s => s.name), ['Pun_Y']);

    const fac = await go('POST', '/debt/facility', { lender: 'Bank A', facilityName: 'TL-1', facilityType: 'Term loan', outstanding: 300000, outstandingAsAt: S.todayIso(), interestRate: 12, repaymentType: 'EMI', frequency: 'Monthly', firstDueDate: `${m(2)}-05`, maturityDate: `${m(13)}-05`, source: 'sanction letter' });
    assert.strictEqual(fac.status, 200);
    assert.strictEqual(fac.body.generated, 12);
    const cov = (await go('POST', '/debt/covenant', { facilityId: fac.body.item.id, metric: 'DSCR', definition: 'as per clause 7', operator: '>=', threshold: 1.2, source: 'clause 7' })).body.item;
    assert.strictEqual((await go('POST', '/debt/test', { covenantId: cov.id, periodEnd: '2026-09-30', value: 1.1 })).status, 200);
    const debt = (await go('GET', '/debt')).body;
    assert.strictEqual(debt.facilities[0].scheduleRows, 12);
    assert.strictEqual(debt.covenants[0].status, 'Breach');
    const inp = (await go('GET', '/inputs')).body;
    const dc = inp.coverage.reports['Debt & Covenants'];
    assert.ok(dc.every(x => x.records > 0 && x.where === 'Debt & covenants'));
    assert.strictEqual(inp.types.budget.moved, 'Budget');

    const f = (await go('GET', '/forecast?months=6')).body;
    assert.strictEqual(f.table.length, 6);
    assert.ok(f.table.some(r => r.outs['Debt service'] > 0), 'debt service from the schedule');
    assert.strictEqual(f.budget.id, v.id);
    assert.strictEqual((await go('PUT', '/forecast/settings', { opening: { amount: 500000, asAt: S.todayIso() }, overdueCollections: 'exclude' })).status, 200);
    const f2 = (await go('GET', '/forecast?months=6')).body;
    assert.strictEqual(f2.opening.amount, 5);
    assert.strictEqual(f2.opening.source, 'entered');
    assert.ok(f2.overdue.in.some(o => o.party === 'Beta LLP'));
  } finally { srv.close(); }
});

test('ratios use the debt schedule, covenant tests and branch master (real workbooks)', { skip: !require('./helpers').hasReal() && 'real workbooks not present', timeout: 240000 }, async () => {
  const H = require('./helpers');
  H.tempStore();
  const srv = H.app(require('..')).listen(0);
  const go = (method, url, body) => H.call(srv, method, '/api/fin-reporting' + url, { body });
  try {
    assert.strictEqual((await go('POST', '/import/folder')).status, 200);
    assert.strictEqual((await go('POST', '/import/commit')).status, 200);
    let r = (await go('GET', '/ratios?basis=SA&periods=FY2027-H1')).body.results[0].values;
    assert.strictEqual(r['cov.dscr_ebitda'].status, 'Proxy', 'repayments from the cash flow until a schedule is entered');
    assert.strictEqual(r['cov.dscr_lender'].status, 'Missing Input');
    assert.strictEqual(r['unit.rev_seat'].status, 'Missing Input');
    const fac = (await go('POST', '/debt/facility', { lender: 'Bank A', facilityName: 'TL-1', facilityType: 'Term loan', outstanding: 12000000, outstandingAsAt: '2026-03-31', interestRate: 10, repaymentType: 'Equal principal', frequency: 'Monthly', firstDueDate: '2026-04-30', maturityDate: '2028-03-31', source: 'synthetic' })).body.item;
    const cov = (await go('POST', '/debt/covenant', { facilityId: fac.id, metric: 'DSCR', definition: 'synthetic', operator: '>=', threshold: 1.2, source: 'synthetic' })).body.item;
    await go('POST', '/debt/test', { covenantId: cov.id, periodEnd: '2026-09-30', value: 1.1 });
    await go('POST', '/branches', { items: [{ name: 'All centres (synthetic)', seats: 1000, superBuiltUp: 100000, revenueStart: '2020-01-01' }], draft: true });
    r = (await go('GET', '/ratios?basis=SA&periods=FY2027-H1')).body.results[0].values;
    assert.strictEqual(r['cov.dscr_ebitda'].status, 'OK');
    assert.match(r['cov.dscr_ebitda'].note, /debt schedule/);
    assert.strictEqual(r['cov.dscr_lender'].v, 1.1);
    assert.match(r['cov.dscr_lender'].note, /BREACH/);
    const rev = (await go('GET', '/statement?basis=SA&stmt=PL&periods=FY2027-H1')).body.rows.find(x => x.id === 'pl.rev').cells['FY2027-H1'].v;
    near(r['unit.rev_seat'].v, rev * 1e5 / (183 / (365 / 12)) / 1000, 1);
    near(r['unit.rev_sqft'].v, rev * 1e5 / (183 / (365 / 12)) / 100000, 0.01);
  } finally { srv.close(); }
});
