/**
 * Zoho Books ledger, account mapping and provisional statements. The Zoho side is a stand-in (an in-memory ledger that answers
 * like Zoho's report and list APIs); amounts are SYNTHETIC. The real-workbook test runs only where the final workbooks exist.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const H = require('./helpers');
const F = require('../lib/xlformula');
const { makeTracer } = require('../lib/wbtrace');
const G = require('../lib/gl');
const LV = require('../lib/live');
const M = require('../lib/model');

const near = (a, b, tol = 0.005, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

// ── a stand-in for Zoho Books ─────────────────────────────────────────────────
function fakeZoho() {
  const accounts = [
    { id: 'A1', name: 'Bank', type: 'bank' }, { id: 'A2', name: 'Revenue', type: 'income' }, { id: 'A3', name: 'Rent Expense', type: 'expense' },
    { id: 'A4', name: 'Payables', type: 'other_current_liability' }, { id: 'A5', name: 'Share Capital', type: 'equity' }, { id: 'A6', name: 'New Deposit', type: 'other_asset', parent: null },
  ];
  const opening = { A1: 100000, A5: -100000 };                    // as at 31 March 2025, rupees, debit positive
  let lmtClock = Date.parse('2026-11-01T00:00:00Z');
  const tick = () => new Date((lmtClock += 60000)).toISOString().replace('Z', '+0000');
  const journals = [];
  const add = (id, date, lines, extra = {}) => { const t = tick(); journals.push({ journal_id: id, journal_date: date, entry_number: id, total: lines.reduce((s, l) => s + (l.dr || 0), 0), status: 'published', lines, created_time: t, last_modified_time: t, ...extra }); };
  // FY 2025-26 and FY 2026-27 activity
  add('J1', '2025-06-15', [{ a: 'A1', dr: 50000 }, { a: 'A2', cr: 50000 }]);
  add('J2', '2025-12-10', [{ a: 'A3', dr: 20000 }, { a: 'A4', cr: 20000 }]);
  add('J3', '2026-05-20', [{ a: 'A1', dr: 80000 }, { a: 'A2', cr: 80000 }]);
  add('J4', '2026-09-05', [{ a: 'A3', dr: 30000 }, { a: 'A1', cr: 30000 }]);
  add('J5', '2026-10-12', [{ a: 'A1', dr: 40000 }, { a: 'A2', cr: 40000 }]);
  add('J6', '2026-11-10', [{ a: 'A3', dr: 15000 }, { a: 'A4', cr: 15000 }]);
  const posted = () => journals.filter(j => j.status !== 'void');
  const isPL = id => ['income', 'expense'].includes(accounts.find(a => a.id === id)?.type);
  const fyStart = d => { const [y, m] = d.split('-').map(Number); return `${m >= 4 ? y : y - 1}-04-01`; };
  let failOn = null, calls = 0;
  async function zget(p, q = {}) {
    calls++;
    if (failOn && failOn(p, q)) { const e = new Error('simulated Zoho failure'); e.response = { status: 500, data: { message: 'simulated Zoho failure' } }; throw e; }
    if (p === '/chartofaccounts') return { chartofaccounts: accounts.map(a => ({ account_id: a.id, account_name: a.name, account_type: a.type, parent_account_id: a.parent || '', parent_account_name: '', is_active: true, created_time: '2025-01-01T00:00:00+0530' })), page_context: { has_more_page: false } };
    if (p === '/reports/generalledger') {
      const acc = {};
      for (const j of posted()) if (j.journal_date >= q.from_date && j.journal_date <= q.to_date) for (const l of j.lines) { const o = acc[l.a] || (acc[l.a] = [0, 0]); o[0] += l.dr || 0; o[1] += l.cr || 0; }
      return { generalledger: accounts.map(a => ({ account_id: a.id, name: a.name, debit_total: acc[a.id]?.[0] || 0, credit_total: acc[a.id]?.[1] || 0 })) };
    }
    if (p === '/reports/trialbalance') {
      assert.strictEqual(q.filter_by, 'TransactionDate.CustomDate', 'the trial balance must be asked for a custom date (else Zoho answers for today)');
      const d = q.to_date, fs0 = fyStart(d);
      const bal = {};
      let re = 0;
      for (const [id, v] of Object.entries(opening)) bal[id] = v;
      for (const j of posted()) {
        if (j.journal_date > d) continue;
        for (const l of j.lines) {
          const net = (l.dr || 0) - (l.cr || 0);
          if (isPL(l.a) && j.journal_date < fs0) re += net; else bal[l.a] = (bal[l.a] || 0) + net;
        }
      }
      const groups = ['asset', 'liability', 'equity', 'income', 'expense'].map(g => ({ account_type: g, account_transactions: accounts.filter(a => ({ bank: 'asset', other_asset: 'asset', other_current_liability: 'liability', equity: 'equity', income: 'income', expense: 'expense' })[a.type] === g && bal[a.id]).map(a => ({ account_id: a.id, name: a.name, net_debit_total: bal[a.id] > 0 ? bal[a.id] : '', net_credit_total: bal[a.id] < 0 ? -bal[a.id] : '' })) }));
      groups.find(g => g.account_type === 'equity').account_transactions.push({ name: 'Retained Earnings', net_debit_total: re > 0 ? re : '', net_credit_total: re < 0 ? -re : '' });
      return { trialbalance: [{ account_transactions: groups, net_debit_total: 1, net_credit_total: 1 }], page_context: { to_date: d } };
    }
    if (p === '/journals') {
      let list = [...journals];
      if (q.sort_column === 'last_modified_time') list.sort((a, b) => (a.last_modified_time < b.last_modified_time ? 1 : -1));
      if (q.date_start) list = list.filter(j => j.journal_date >= q.date_start && j.journal_date <= q.date_end);
      return { journals: list.map(({ lines, ...j }) => j), page_context: { has_more_page: false } };
    }
    const key = p.slice(1);
    return { [key]: [], page_context: { has_more_page: false } };
  }
  return { zget, journals, accounts, tick, get calls() { return calls; }, set failOn(f) { failOn = f; } };
}

// ── formulas ──────────────────────────────────────────────────────────────────
test('formula parser: sheet references, whole columns, functions, percent, unary minus', () => {
  const t = F.parse("=-SUMIF('TB S26'!$H:$H,B15,'TB S26'!G:G)+C3*25.168%-ROUND(Sheet2!A1:B2,0)");
  assert.strictEqual(t.t, 'bin');
  const sumif = t.a.a.a;
  assert.strictEqual(sumif.t, 'fn'); assert.strictEqual(sumif.name, 'SUMIF');
  assert.deepStrictEqual([sumif.args[0].sheet, sumif.args[0].c1, sumif.args[0].r2], ['TB S26', 8, Infinity]);
  assert.strictEqual(t.a.b.b.t, 'pct');
});

test('tracer: a statement figure is followed to the trial-balance ledgers, signs, splits and typed parts kept apart', () => {
  // TB sheet: Account | Opening | Debit | Credit | Closing | OBE | In Lacs | Grouping
  const tb = [['Account', 'Opening Balance', 'Debit', 'Credit', 'Closing Balance', 'OBE', 'In Lacs', 'Grouping'],
    ['Bank A', 0, 0, 0, 500000, 0, null, 'Cash'], ['Bank B', 0, 0, 0, 300000, 0, null, 'Cash'], ['Loan X', 0, 0, 0, -1000000, 0, null, 'Borrowings'], ['Old Loan', 0, 0, 0, 0, 0, null, 'Borrowings']];
  // built in memory with formulas and the values Excel would have cached (SheetJS does not calculate)
  const book = XLSX.utils.book_new();
  const sheet = (name, aoa, cells) => { const ws = XLSX.utils.aoa_to_sheet(aoa); for (const [addr, [f, v]] of Object.entries(cells)) ws[addr] = { t: 'n', f, v }; const R = XLSX.utils.decode_range(ws['!ref']); R.e.c = Math.max(R.e.c, 7); R.e.r = Math.max(R.e.r, 9); ws['!ref'] = XLSX.utils.encode_range(R); XLSX.utils.book_append_sheet(book, ws, name); };
  sheet('TB', tb, { G2: ['+(E2+F2)/100000', 5], G3: ['+(E3+F3)/100000', 3], G4: ['+(E4+F4)/100000', -10], G5: ['+(E5+F5)/100000', 0] });
  sheet('Notes', [['Particulars', 'As at September 30, 2026', 'As at March 31, 2026'], ['Cash', null, 7], ['Total', null, null], [], ['Particulars', 'As at September 30, 2026'], ['Current maturity typed', 4], ['Non-current', null], ['Rupee slip', null]],
    { B2: ['SUMIF(TB!H:H,A2,TB!G:G)', 8], B3: ['SUM(B2:B2)', 8], B7: ['-VLOOKUP("Loan X",TB!A:E,5,FALSE)/100000-B6', 6], B8: ['-VLOOKUP("Old Loan",TB!A:E,5,FALSE)', 0] });
  sheet('BS', [['Line', 'As at September 30, 2026'], ['Cash and cash equivalents'], ['Borrowings (current)'], ['Borrowings (non-current)'], ['Opening reserve']],
    { B2: ['Notes!B3', 8], B3: ['Notes!B6', 4], B4: ['Notes!B7+Notes!B8', 6], B5: ['+Notes!C2+IF(1>0,0,99)', 7] });
  const T = makeTracer(book, { tbSheet: 'TB', periodStart: '2026-04-01', periodEnd: '2026-09-30', firstRow: 2, lastRow: 5 });
  const cash = T.check('BS', 'B2');
  assert.ok(cash.ok);
  assert.deepStrictEqual([...cash.lin.t.keys()].sort(), ['2:close', '2:obe', '3:close', '3:obe']);
  near(cash.lin.t.get('2:close'), 1e-5, 1e-12);
  const nc = T.check('BS', 'B4');
  assert.ok(nc.ok, `non-current ${nc.got}`);
  near(nc.lin.t.get('4:close'), -1e-5, 1e-12, 'a credit balance shown as a positive liability');
  assert.ok(nc.lin.k.some(c => c.kind === 'period' && c.addr === 'B6' && Math.abs(c.v * c.coef + 4) < 1e-9), 'the typed current maturity is a typed part with its cell');
  assert.ok(T.anomalies.some(a => a.addr === 'B4'), 'the rupee amount summed into a lakh total is reported (and read as lakh)');
  near(Math.abs(nc.lin.t.get('5:close') || 0), 1e-5, 1e-12);
  const res = T.check('BS', 'B5');
  assert.ok(res.ok);
  assert.ok(res.lin.k.every(c => c.kind === 'opening'), 'a figure from the comparative column is an opening balance');
});

// ── the ledger sync ───────────────────────────────────────────────────────────
test('ledger sync: initial load agrees with the trial balance; an entry moved Nov → Oct updates both months and leaves Q3 unchanged; a failed run keeps the checkpoint and resumes; deletions and voids are picked up', async () => {
  H.tempStore();
  const store = require('../lib/store');
  const z = fakeZoho();
  let clock = Date.parse('2026-11-22T06:00:00Z');
  const gl = G.createGL({ store, zget: z.zget, now: () => clock, gapMs: 0 });
  const r0 = await gl.run({ mode: 'initial', today: '2026-11-22' });
  assert.strictEqual(r0.status, 'ok', r0.error);
  assert.strictEqual(r0.tbCheck.ok, true, JSON.stringify(r0.tbCheck));
  const st0 = await gl.readState();
  assert.strictEqual(st0.cutoff, '2026-11-22');
  assert.strictEqual(Object.keys(st0.months).length, 20);
  const ds0 = await gl.dataset();
  const q3 = d => { const r = d.range('2026-10', '2026-11'); return [...r.values()].reduce((s, [dr]) => s + dr, 0); };
  const oct0 = (await store.read('gl_month_2026-10')).acc, nov0 = (await store.read('gl_month_2026-11')).acc;
  assert.deepStrictEqual(nov0.A3, [15000, 0]);
  const q3before = q3(ds0);

  // an edit in Zoho: J6 moved from 10 Nov to 15 Oct, same amount
  clock += 3600e3;
  const j6 = z.journals.find(j => j.journal_id === 'J6');
  j6.journal_date = '2026-10-15'; j6.last_modified_time = new Date(clock - 60000).toISOString().replace('Z', '+0000');
  const r1 = await gl.run({ mode: 'hourly', today: '2026-11-22', openFrom: '2026-10' });
  assert.strictEqual(r1.status, 'ok', r1.error);
  assert.strictEqual(r1.records.changed, 1);
  assert.ok(r1.records.items.some(x => x.id === 'J6' && x.oldDate === '2026-11-10' && x.date === '2026-10-15'));
  assert.ok(r1.monthsRead.includes('2026-10') && r1.monthsRead.includes('2026-11'));
  assert.deepStrictEqual((await store.read('gl_month_2026-10')).acc.A3, [15000, 0], 'October now has the expense');
  assert.strictEqual((await store.read('gl_month_2026-11')).acc.A3, undefined, 'November no longer has it');
  assert.ok(r1.affectedPeriods.includes('FY2027-Q3'));
  near(q3(await gl.dataset()), q3before, 0.001, 'the quarter total is unchanged');
  assert.notDeepStrictEqual(oct0, (await store.read('gl_month_2026-10')).acc);
  void nov0;

  // a back-dated posting into a finalised month (September) is read through its record and September is re-read
  clock += 3600e3;
  z.journals.push({ journal_id: 'J7', journal_date: '2026-09-25', entry_number: 'J7', total: 5000, status: 'published', lines: [{ a: 'A3', dr: 5000 }, { a: 'A4', cr: 5000 }], created_time: new Date(clock - 30000).toISOString().replace('Z', '+0000'), last_modified_time: new Date(clock - 30000).toISOString().replace('Z', '+0000') });
  const hwmBefore = (await gl.readState()).feed.journals.hwm;
  // a failure halfway: the checkpoint stays, the run is kept for resuming, nothing half-written is committed
  z.failOn = (p, q) => p === '/reports/generalledger' && q.from_date === '2026-09-01';
  const r2 = await gl.run({ mode: 'hourly', today: '2026-11-22', openFrom: '2026-10' });
  assert.strictEqual(r2.status, 'failed');
  assert.strictEqual((await gl.readState()).feed.journals.hwm, hwmBefore, 'the checkpoint did not move');
  assert.ok((await store.read('gl_pending')).queue.length > 0, 'the run is kept for resuming');
  assert.strictEqual((await store.read('gl_month_2026-09')).acc.A3[0], 30000, 'September not changed yet');
  z.failOn = null;
  clock += 60000;
  const r3 = await gl.run({ mode: 'hourly', today: '2026-11-22' });
  assert.strictEqual(r3.status, 'ok', r3.error);
  assert.strictEqual(r3.resumed, 1);
  assert.strictEqual((await store.read('gl_month_2026-09')).acc.A3[0], 35000, 'the back-dated posting is in September once — no duplicate');
  assert.notStrictEqual((await gl.readState()).feed.journals.hwm, hwmBefore, 'the checkpoint moved after the batch was saved');
  const r3b = await gl.run({ mode: 'hourly', today: '2026-11-22' });
  assert.strictEqual(r3b.records.added + r3b.records.changed, 0, 'the overlap window does not count a record twice');
  assert.strictEqual((await store.read('gl_month_2026-09')).acc.A3[0], 35000);

  // an edit that moves a record between two finalised months (September → August): both months are re-read from the record index
  clock += 3600e3;
  const j4 = z.journals.find(j => j.journal_id === 'J4');
  j4.journal_date = '2026-08-20'; j4.last_modified_time = new Date(clock - 1000).toISOString().replace('Z', '+0000');
  const rMove = await gl.run({ mode: 'hourly', today: '2026-11-22', openFrom: '2026-10' });
  assert.ok(rMove.monthsRead.includes('2026-08') && rMove.monthsRead.includes('2026-09'), rMove.monthsRead.join(','));
  assert.strictEqual((await store.read('gl_month_2026-09')).acc.A3[0], 5000, 'September keeps only the back-dated posting');
  assert.strictEqual((await store.read('gl_month_2026-08')).acc.A3[0], 30000, 'August has the moved expense');

  // a deletion never appears in a "modified since" list: the open months are re-read every run
  clock += 3600e3;
  z.journals.splice(z.journals.findIndex(j => j.journal_id === 'J5'), 1);
  const r4 = await gl.run({ mode: 'hourly', today: '2026-11-22', openFrom: '2026-10' });
  assert.strictEqual(r4.status, 'ok');
  assert.strictEqual((await store.read('gl_month_2026-10')).acc.A2, undefined, 'the deleted revenue is gone from October');
  assert.ok(r4.monthsChanged.some(m => m.month === '2026-10'));
  // a void
  clock += 3600e3;
  const j3 = z.journals.find(j => j.journal_id === 'J3'); j3.status = 'void'; j3.last_modified_time = new Date(clock - 1000).toISOString().replace('Z', '+0000');
  const r5 = await gl.run({ mode: 'hourly', today: '2026-11-22', openFrom: '2026-10' });
  assert.strictEqual(r5.records.voided, 1);
  assert.strictEqual((await store.read('gl_month_2026-05')).acc.A2, undefined, 'the voided entry left May');
  assert.strictEqual(r5.tbCheck.ok, true, JSON.stringify(r5.tbCheck));
});

// ── provisional statements from the ledger ────────────────────────────────────
test('provisional statements: Zoho balance sheet balances, open periods roll the final figures forward, the cash flow agrees with the balance-sheet cash', async () => {
  H.tempStore();
  const store = require('../lib/store');
  const z = fakeZoho();
  const gl = G.createGL({ store, zget: z.zget, now: () => Date.parse('2026-11-22T06:00:00Z'), gapMs: 0 });
  assert.strictEqual((await gl.run({ mode: 'initial', today: '2026-11-22' })).status, 'ok');
  const ds = await gl.dataset();
  const L = (lines, extra = {}) => ({ leaf: true, carried: [], dropped: [], ...extra, stmt: Object.keys(extra).length ? extra.stmt : undefined });
  const map = {
    meta: { file: 'synthetic.xlsx', sha256: 'x', reportingDate: '2026-09-30', ytdPeriod: 'FY2027-H1', bsPeriod: 'BS-2026-09-30' },
    lines: { 'bs.cash': { ...L(), stmt: 'BS' }, 'bs.cl_other': { ...L(), stmt: 'BS' }, 'bs.share_cap': { ...L(), stmt: 'BS' }, 'bs.oth_eq': { ...L(), stmt: 'BS', carried: [{ rule: 'opening', amount: 0, sheet: 'N', addr: 'D1' }] }, 'pl.rev': { ...L(), stmt: 'PL' }, 'pl.exp_oth': { ...L(), stmt: 'PL' } },
    noteItems: {},
    ledgers: [
      { row: 1, name: 'Bank', zoho: { id: 'A1' }, section: 'asset', group: 'Cash', status: 'traced', lines: { 'bs.cash': { close: 1e-5 } }, notes: {} },
      { row: 2, name: 'Revenue', zoho: { id: 'A2' }, section: 'income', group: 'Rev', status: 'traced', lines: { 'pl.rev': { close: -1e-5 } }, notes: {} },
      { row: 3, name: 'Rent Expense', zoho: { id: 'A3' }, section: 'expense', group: 'Oth', status: 'traced', lines: { 'pl.exp_oth': { close: 1e-5 } }, notes: {} },
      { row: 4, name: 'Payables', zoho: { id: 'A4' }, section: 'liability', group: 'Pay', status: 'traced', lines: { 'bs.cl_other': { close: -1e-5 } }, notes: {} },
      { row: 5, name: 'Share Capital', zoho: { id: 'A5' }, section: 'equity', group: 'Eq', status: 'traced', lines: { 'bs.share_cap': { close: -1e-5 } }, notes: {} },
    ],
  };
  // final figures as at 30 Sep 2026 / H1 FY27, deliberately different from Zoho (as a final workbook is)
  const fact = (s, l, p, v) => ({ b: 'SA', s, l, p, v, st: 'ok', f: 0, sh: 'X', c: 'A1', role: 'primary', k: s === 'PL' ? 'SEBI' : 'BS' });
  const version = { files: [{ f: 0, name: 'final.xlsx', reportingDate: '2026-09-30' }], facts: [fact('BS', 'bs.cash', 'BS-2026-09-30', 2.0), fact('BS', 'bs.cl_other', 'BS-2026-09-30', 0.5), fact('BS', 'bs.share_cap', 'BS-2026-09-30', 1.0), fact('BS', 'bs.oth_eq', 'BS-2026-09-30', 0.5),
    fact('BS', 'bs.ta', 'BS-2026-09-30', 2.0), fact('BS', 'bs.tel', 'BS-2026-09-30', 2.0), fact('PL', 'pl.rev', 'FY2027-H1', 0.9), fact('PL', 'pl.exp_oth', 'FY2027-H1', 0.35)], notes: [] };
  const lv = LV.createLive({ map, edits: {}, ds, version, finalCtx: M.makeCtx(version), M });
  for (const pid of lv.bsIds) { const b = lv.zoho.BS[pid]; if (b) near(b.lines['bs.ta'], b.lines['bs.tel'], 1e-9, `Zoho balance sheet ${pid}`); }
  // Q3 FY27 is open and after the final period: Zoho's own (Oct revenue 40,000 + Nov rent 15,000)
  near(lv.live.PL['FY2027-Q3'].lines['pl.rev'], 0.4, 1e-9);
  near(lv.live.PL['FY2027-Q3'].lines['pl.exp_oth'], 0.15, 1e-9);
  assert.strictEqual(lv.live.PL['FY2027-Q3'].asAt, '2026-11-22');
  // 9M = final H1 + Zoho Q3 to date
  near(lv.live.PL['FY2027-9M'].lines['pl.rev'], 0.9 + 0.4, 1e-9);
  // the provisional 31 March 2027 column = final 30 Sep + Zoho movement since, and balances
  const b = lv.live.BS['BS-2027-03-31'];
  near(b.lines['bs.cash'], 2.0 + 0.4, 1e-9);
  near(b.lines['bs.ta'], b.lines['bs.tel'], 1e-9, 'provisional balance sheet');
  assert.strictEqual(b.asAt, '2026-11-22');
  // the Zoho figure of a finalised period differs from the final one but never replaces it in the final view
  const merged = { ...version, files: [...version.files, { f: 1, name: 'Zoho', zoho: true, reportingDate: '2026-11-22' }], facts: [...version.facts, ...lv.facts.map(f => ({ ...f, f: 1 }))], notes: [] };
  const ctxF = M.makeCtx(merged), ctxZ = M.makeCtx(merged, { mode: 'zoho' });
  assert.strictEqual(M.cell(ctxF, 'SA', 'pl.rev', 'FY2027-H1').v, 0.9, 'final view: the workbook');
  near(M.cell(ctxZ, 'SA', 'pl.rev', 'FY2027-H1').v, 0.8, 1e-9, 'Provisional – Zoho Books: Zoho');
  assert.strictEqual(M.cell(ctxF, 'SA', 'pl.rev', 'FY2027-Q3').fact.role, 'live');
  // cash flows agree with the balance-sheet cash
  for (const f of lv.facts.filter(x => x.s === 'CF' && x.l === 'cf.Z.x.difference')) near(f.v, 0, 1e-9, `cash flow ${f.p} ${f.role}`);
  // a new Zoho account with an amount and no mapping is shown on the awaiting line, never dropped
  z.journals.push({ journal_id: 'J9', journal_date: '2026-11-15', entry_number: 'J9', total: 7000, status: 'published', lines: [{ a: 'A6', dr: 7000 }, { a: 'A1', cr: 7000 }], created_time: '2026-11-22T05:00:00+0000', last_modified_time: '2026-11-22T05:00:00+0000' });
  const gl2 = G.createGL({ store, zget: z.zget, now: () => Date.parse('2026-11-22T07:00:00Z'), gapMs: 0 });
  assert.strictEqual((await gl2.run({ mode: 'hourly', today: '2026-11-22', openFrom: '2026-10' })).status, 'ok');
  const lv2 = LV.createLive({ map, edits: {}, ds: await gl2.dataset(), version, finalCtx: M.makeCtx(version), M });
  assert.ok(lv2.awaiting.some(a => a.id === 'A6' && Math.abs(a.amount - 0.07) < 1e-9));
  const z2 = lv2.zoho.BS['BS-2027-03-31'];
  near(z2.lines['bs.ta'], z2.lines['bs.tel'], 1e-9, 'still balances with the account awaiting mapping');
  // a reviewer's edit places it
  const lv3 = LV.createLive({ map, edits: { A6: { line: 'bs.c_other', by: 'tester' } }, ds: await gl2.dataset(), version, finalCtx: M.makeCtx(version), M });
  near(lv3.zoho.BS['BS-2027-03-31'].lines['bs.c_other'], 0.07, 1e-9);
  assert.ok(!lv3.awaiting.some(a => a.id === 'A6'));
});

// ── the mapping from the real Q2 workbook ─────────────────────────────────────
const Q2 = path.join(__dirname, '..', '..', '..', 'Financials & Presentations', 'Financials', 'DevX Standalone FS FY 2026-27_Q-2_Final Set.xlsx');
test('account mapping from TB S26 (the real Q2 workbook): every line traced, the workbook reproduced except where a schedule replaces the ledgers', { skip: !fs.existsSync(Q2) && 'Q2 workbook not on this machine' }, () => {
  const AC = require('../lib/acmap');
  const m = AC.buildMapping({ buf: fs.readFileSync(Q2), name: path.basename(Q2), accounts: {} });
  assert.strictEqual(m.meta.sheet, 'TB S26');
  assert.strictEqual(m.meta.ytdPeriod, 'FY2027-H1');
  const leaf = Object.values(m.lines).filter(l => l.leaf);
  assert.ok(leaf.length >= 40);
  assert.ok(Object.values(m.lines).every(l => l.ok), 'every statement figure is reproduced by its trace');
  for (const l of leaf) if (!l.schedule) near(l.residual, 0, 0.2, `${l.line} residual`);
  near(m.lines['bs.ppe'].residual + m.lines['bs.cwip'].residual + m.lines['bs.intang'].residual, 0, 0.1, 'the fixed-asset register and the ledgers agree in total');
  near(m.lines['bs.ncl_borrow'].mapped, m.lines['bs.ncl_borrow'].wb, 0.05, 'non-current borrowings after the sign repair');
  near(m.lines['bs.cl_borrow'].mapped, m.lines['bs.cl_borrow'].wb, 0.05, 'current borrowings');
  assert.ok(m.meta.tciRule.ok && m.meta.tciRule.checked > 100);
  assert.ok(m.meta.counts.traced > 1300);
  assert.ok(Object.values(m.noteItems).every(i => i.ok));
});
