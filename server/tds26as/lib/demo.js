/**
 * Synthetic demo data — two DEMO entities (PANs beginning ZZZ, deductor TANs AHM*0000**), clearly labelled on every screen. Nothing here
 * comes from Zoho Books or TRACES. The same scenario drives the automated tests (tests/acceptance.test.js), so the demo shows exactly the
 * cases the module was accepted on:
 *   A exact match · B ₹2.00 rounding · C ₹2.01 mismatch · D three invoices = one 26AS credit · E two equal TDS amounts, one credit (ambiguous)
 *   F March booking / April credit (timing) · G Zoho only · H 26AS only · I tax deducted > deposited · K a customer whose invoice records no TAN (not matched; name suggestion)
 *   L unallocated journal · T transfer between the entity's own TDS ledgers · M the same client in both entities · N partial payment
 *   O a credit that only the revised statement contains · statements: FY 2025-26 v1 and its revision v2, FY 2026-27, entity Y's own
 */

'use strict';

const store = require('./store');
const ST = require('./statements');
const { toPaise } = require('./util');

const X = { id: 'demo-x', name: 'DEMO Accelerator Limited (synthetic)', short: 'DEMO X', pan: 'ZZZPD1234K', org_id: '', active: true, demo: true, tan_field: 'cf_organization_tan_number',
  ledgers: [{ account_id: 'demo194C', name: '194C', section: '194C', parent: 'TDS Receivable' }, { account_id: 'demo194J', name: '194J', section: '194J', parent: 'TDS Receivable' },
    { account_id: 'demo194J2526', name: 'TDS Receivable U/s. 194J F.Y.2025-26', section: '194J', parent: 'TDS Receivable F.Y 2025-2026' }] };
const Y = { id: 'demo-y', name: 'DEMO Threads LLP (synthetic)', short: 'DEMO Y', pan: 'ZZZFN5678L', org_id: '', active: true, demo: true, tan_field: 'cf_organization_tan_number',
  ledgers: [{ account_id: 'demoY194C', name: '194C', section: '194C', parent: 'TDS Receivable' }] };

const C = {
  A: { cust: 'cA', name: 'ALPHA EXACT PRIVATE LIMITED', tan: 'AHMA00001A' }, B: { cust: 'cB', name: 'BETA ROUNDING LLP', tan: 'AHMB00002B' }, Cg: { cust: 'cC', name: 'GAMMA MISMATCH LIMITED', tan: 'AHMC00003C' },
  D: { cust: 'cD', name: 'DELTA MULTI INVOICE PVT LTD', tan: 'AHMD00004D' }, E: { cust: 'cE', name: 'EPSILON TWINS LIMITED', tan: 'AHME00005E' }, F: { cust: 'cF', name: 'ZETA TIMING PRIVATE LIMITED', tan: 'AHMF00006F' },
  G: { cust: 'cG', name: 'ETA ZOHO ONLY LIMITED', tan: 'AHMG00007G' }, H: { cust: 'cH', name: 'THETA STATEMENT ONLY LLP', tan: 'AHMH00008H' }, I: { cust: 'cI', name: 'IOTA OVERBOOKED LIMITED', tan: 'AHMI00009I' },
  K: { cust: 'cK', name: 'KAPPA NEW CLIENT PRIVATE LIMITED', tan: 'AHMK00010K' }, M: { cust: 'cM', name: 'COMMON CLIENT LIMITED', tan: 'AHMM00011M' }, N: { cust: 'cN', name: 'NU PARTIAL PRIVATE LIMITED', tan: 'AHMN00012N' },
  O: { cust: 'cO', name: 'OMICRON LATE FILER LIMITED', tan: 'AHMO00013O' }, MY: { cust: 'yM', name: 'COMMON CLIENT LIMITED', tan: 'AHMM00011M' }, Y1: { cust: 'yP', name: 'PSI PARTNERS LLP', tan: 'AHMP00014P' },
};
const r = v => toPaise(v);
let seq = 0;
const row = (acc, type, tid, date, cl, amount, extra = {}) => ({ id: `demo-row-${++seq}`, acc, type, type_label: { invoice: 'Invoice', customer_payment: 'Customer Payment', journal: 'Journal', creditnote: 'Credit Note' }[type],
  tid, date, cust: cl ? cl.cust : '', payee: cl ? cl.name : '', desc: extra.desc || '', no: extra.no || '', ref: '', dr: amount > 0 ? r(amount) : 0, cr: amount < 0 ? r(-amount) : 0, off: '' });
const inv = (id, no, date, cl, basic, gstRate, tds, names) => ({ id, no, date, cust: cl.cust, cust_name: cl.name, status: 'paid', sub_total: r(basic), tax_total: r(basic * gstRate), total: r(basic * (1 + gstRate) - tds), tds: r(tds),
  tds_percent: tds ? Math.round((tds / basic) * 10000) / 100 : null, tds_section: '', tds_names: names || [], tan: cl.tan, lmt: '2026-06-01T10:00:00+0530', branch: 'Demo branch', at: '2026-06-01T00:00:00Z' });

function scenario() {
  seq = 0;
  const rowsX = [
    row('demo194J', 'invoice', 'iA1', '2026-01-10', C.A, 10000, { no: 'DX/25-26/0101' }),
    row('demo194C', 'invoice', 'iB1', '2026-01-15', C.B, 5000, { no: 'DX/25-26/0102' }),
    row('demo194C', 'invoice', 'iC1', '2026-02-05', C.Cg, 3000, { no: 'DX/25-26/0103' }),
    row('demo194C', 'invoice', 'iD1', '2026-02-01', C.D, 1200, { no: 'DX/25-26/0104' }),
    row('demo194C', 'invoice', 'iD2', '2026-02-10', C.D, 1800, { no: 'DX/25-26/0105' }),
    row('demo194C', 'invoice', 'iD3', '2026-02-20', C.D, 2000, { no: 'DX/25-26/0106' }),
    row('demo194C', 'invoice', 'iE1', '2026-03-02', C.E, 2500, { no: 'DX/25-26/0107' }),
    row('demo194C', 'invoice', 'iE2', '2026-03-02', C.E, 2500, { no: 'DX/25-26/0108' }),
    row('demo194J', 'invoice', 'iF1', '2026-03-28', C.F, 4000, { no: 'DX/25-26/0109' }),
    row('demo194C', 'invoice', 'iG1', '2026-01-20', C.G, 1500, { no: 'DX/25-26/0110' }),
    row('demo194C', 'invoice', 'iI1', '2026-01-25', C.I, 6000, { no: 'DX/25-26/0111' }),
    row('demo194C', 'invoice', 'iK1', '2026-03-03', C.K, 700, { no: 'DX/25-26/0112' }),
    row('demo194C', 'invoice', 'iM1', '2026-02-02', C.M, 3333, { no: 'DX/25-26/0113' }),
    row('demo194C', 'customer_payment', '', '2026-02-15', C.N, 1000, { no: 'DX/25-26/0114' }),
    row('demo194C', 'invoice', 'iO1', '2026-03-08', C.O, 1100, { no: 'DX/25-26/0115' }),
    row('demo194J', 'journal', 'jL1', '2026-03-31', null, 1000, { no: 'JR/25-26/0901', desc: 'TDS receivable as per client confirmation' }),
    row('demo194J', 'journal', 'jT1', '2026-03-31', C.A, -2000, { no: 'JR/25-26/0902', desc: 'TDS transferred to FY 2025-26 ledger' }),
    row('demo194J2526', 'journal', 'jT1', '2026-03-31', C.A, 2000, { no: 'JR/25-26/0902', desc: 'TDS transferred to FY 2025-26 ledger' }),
    row('demo194J', 'invoice', 'iA0', '2026-01-05', C.A, 2000, { no: 'DX/25-26/0099' }),
  ];
  const docsX = { invoices: {}, payments: {}, paylist: {}, journals: {}, invno: {} };
  const invs = [
    inv('iA1', 'DX/25-26/0101', '2026-01-10', C.A, 100000, 0.18, 10000, ['194J']), inv('iA0', 'DX/25-26/0099', '2026-01-05', C.A, 20000, 0.18, 2000, ['194J']),
    inv('iB1', 'DX/25-26/0102', '2026-01-15', C.B, 250000, 0.18, 5000, ['194C']), inv('iC1', 'DX/25-26/0103', '2026-02-05', C.Cg, 150000, 0.18, 3000, ['194C']),
    inv('iD1', 'DX/25-26/0104', '2026-02-01', C.D, 60000, 0.18, 1200, ['194C']), inv('iD2', 'DX/25-26/0105', '2026-02-10', C.D, 90000, 0.18, 1800, ['194C']), inv('iD3', 'DX/25-26/0106', '2026-02-20', C.D, 100000, 0.18, 2000, ['194C']),
    inv('iE1', 'DX/25-26/0107', '2026-03-02', C.E, 125000, 0.18, 2500, ['194C']), inv('iE2', 'DX/25-26/0108', '2026-03-02', C.E, 125000, 0.18, 2500, ['194C']),
    inv('iF1', 'DX/25-26/0109', '2026-03-28', C.F, 40000, 0.18, 4000, ['194J']), inv('iG1', 'DX/25-26/0110', '2026-01-20', C.G, 75000, 0.18, 1500, ['194C']),
    inv('iI1', 'DX/25-26/0111', '2026-01-25', C.I, 300000, 0.18, 6000, ['194C']), inv('iK1', 'DX/25-26/0112', '2026-03-03', C.K, 35000, 0.18, 700, ['194C']),
    inv('iM1', 'DX/25-26/0113', '2026-02-02', C.M, 166650, 0.18, 3333, ['194C']), inv('iN1', 'DX/25-26/0114', '2026-02-01', C.N, 100000, 0.18, 0, []),
    inv('iO1', 'DX/25-26/0115', '2026-03-08', C.O, 55000, 0.18, 1100, ['194C']), inv('iH1', 'DX/25-26/0116', '2026-02-10', C.H, 45000, 0.18, 0, []),
  ];
  for (const i of invs) { docsX.invoices[i.id] = i; docsX.invno[i.no] = { id: i.id, cust: i.cust, date: i.date }; }
  docsX.invoices.iK1.tan = '';   // K: no TAN recorded on its invoice, so the TAN cannot tell the client — left to a name suggestion
  // the partial payment: half of invoice DX/25-26/0114 (₹1,18,000 gross): ₹58,000 received + ₹1,000 TDS = ₹59,000
  docsX.payments.pN1 = { id: 'pN1', no: 'CP/25-26/0501', date: '2026-02-15', cust: C.N.cust, cust_name: C.N.name, amount: r(58000), withheld: r(1000), tax_account_id: 'demo194C', ref: '',
    invoices: [{ id: 'iN1', no: 'DX/25-26/0114', date: '2026-02-01', applied: r(58000), withheld: r(1000), total: r(118000) }], lmt: '2026-02-15T10:00:00+0530', at: '2026-06-01T00:00:00Z' };
  docsX.journals.jL1 = { id: 'jL1', no: 'JR/25-26/0901', date: '2026-03-31', notes: 'TDS receivable as per client confirmation', ref: '', lines: [{ acc: 'demo194J', acc_name: '194J', cust: '', cust_name: '', dc: 'debit', amount: r(1000) }, { acc: 'demoSuspense', acc_name: 'Suspense', cust: '', cust_name: '', dc: 'credit', amount: r(1000) }], lmt: '', at: '' };
  docsX.journals.jT1 = { id: 'jT1', no: 'JR/25-26/0902', date: '2026-03-31', notes: 'TDS transferred to FY 2025-26 ledger', ref: '', lines: [{ acc: 'demo194J', acc_name: '194J', cust: C.A.cust, cust_name: C.A.name, dc: 'credit', amount: r(2000) }, { acc: 'demo194J2526', acc_name: 'TDS Receivable U/s. 194J F.Y.2025-26', cust: C.A.cust, cust_name: C.A.name, dc: 'debit', amount: r(2000) }], lmt: '', at: '' };

  const rowsY = [
    row('demoY194C', 'invoice', 'yiM1', '2026-02-03', C.MY, 7777, { no: 'DY/25-26/0001' }),
    row('demoY194C', 'invoice', 'yiP1', '2026-02-18', C.Y1, 2400, { no: 'DY/25-26/0002' }),
  ];
  const docsY = { invoices: {}, payments: {}, paylist: {}, journals: {}, invno: {} };
  for (const i of [inv('yiM1', 'DY/25-26/0001', '2026-02-03', C.MY, 388850, 0.18, 7777, ['194C']), inv('yiP1', 'DY/25-26/0002', '2026-02-18', C.Y1, 120000, 0.18, 2400, ['194C'])]) { docsY.invoices[i.id] = i; docsY.invno[i.no] = { id: i.id, cust: i.cust, date: i.date }; }

  const group = (id, cl) => ({ id, name: cl.name, customers: [{ id: cl.cust, name: cl.name }], tans: [{ tan: cl.tan, name: cl.name, by: 'demo', at: '2026-06-01T00:00:00Z', basis: 'demo' }], by: 'demo', at: '2026-06-01T00:00:00Z' });
  const clientsX = { groups: [['A', 'g0000000000000a01'], ['B', 'g0000000000000a02'], ['Cg', 'g0000000000000a03'], ['D', 'g0000000000000a04'], ['E', 'g0000000000000a05'], ['F', 'g0000000000000a06'], ['G', 'g0000000000000a07'], ['H', 'g0000000000000a08'], ['I', 'g0000000000000a09'], ['M', 'g0000000000000a11'], ['N', 'g0000000000000a12'], ['O', 'g0000000000000a13']]
    .map(([k, id]) => group(id, C[k])), no_customer: {}, rejected: {} };
  const clientsY = { groups: [group('g0000000000000b01', C.MY), group('g0000000000000b02', C.Y1)], no_customer: {}, rejected: {} };

  const ded = (sr, cl, rows) => ({ sr, cl, rows });
  const tx = (section, date, status, booked, paid, deducted, deposited) => ({ section, date, status, booked, paid, deducted, deposited });
  const fy2526 = [
    ded(1, C.A, [tx('194J(b)', '12-Jan-2026', 'F', '15-May-2026', 100000, 10000, 10000), tx('194J(b)', '05-Jan-2026', 'F', '15-May-2026', 20000, 2000, 2000)]),
    ded(2, C.B, [tx('194C', '16-Jan-2026', 'F', '15-May-2026', 249900, 4998, 4998)]),
    ded(3, C.Cg, [tx('194C', '06-Feb-2026', 'F', '15-May-2026', 149899.5, 2997.99, 2997.99)]),
    ded(4, C.D, [tx('194C', '15-Mar-2026', 'F', '15-May-2026', 250000, 5000, 5000)]),
    ded(5, C.E, [tx('194C', '02-Mar-2026', 'F', '15-May-2026', 125000, 2500, 2500)]),
    ded(6, C.H, [tx('194C', '14-Feb-2026', 'F', '15-May-2026', 45000, 900, 900)]),
    ded(7, C.I, [tx('194C', '26-Jan-2026', 'O', '15-May-2026', 300000, 6000, 0)]),
    ded(8, C.K, [tx('194C', '05-Mar-2026', 'F', '15-May-2026', 35000, 700, 700)]),
    ded(9, C.M, [tx('194C', '04-Feb-2026', 'F', '15-May-2026', 166650, 3333, 3333)]),
    ded(10, C.N, [tx('194C', '15-Feb-2026', 'F', '15-May-2026', 50000, 1000, 1000)]),
  ];
  const fy2526rev = fy2526.concat([ded(11, C.O, [tx('194C', '10-Mar-2026', 'F', '10-Jul-2026', 55000, 1100, 1100)])]);
  const fy2627 = [ded(1, C.F, [tx('194J(b)', '03-Apr-2026', 'F', '20-Jul-2026', 40000, 4000, 4000)])];
  const fyY = [ded(1, C.MY, [tx('194C', '05-Feb-2026', 'F', '15-May-2026', 388850, 7777, 7777)]), ded(2, C.Y1, [tx('194C', '20-Feb-2026', 'F', '15-May-2026', 120000, 2400, 2400)])];
  return {
    entities: [X, Y], rows: { [X.id]: rowsX, [Y.id]: rowsY }, docs: { [X.id]: docsX, [Y.id]: docsY }, clients: { [X.id]: clientsX, [Y.id]: clientsY }, C,
    statements: [
      { entity: X.id, file: 'DEMO_ZZZPD1234K_FY2025-26_v1.txt', text: tracesText({ pan: X.pan, name: X.name, fy: '2025-26', ay: '2026-27', created: '15-06-2026', deductors: fy2526 }) },
      { entity: X.id, file: 'DEMO_ZZZPD1234K_FY2025-26_v2_revised.txt', text: tracesText({ pan: X.pan, name: X.name, fy: '2025-26', ay: '2026-27', created: '20-07-2026', deductors: fy2526rev }) },
      { entity: X.id, file: 'DEMO_ZZZPD1234K_FY2026-27.txt', text: tracesText({ pan: X.pan, name: X.name, fy: '2026-27', ay: '2027-28', created: '10-08-2026', deductors: fy2627 }) },
      { entity: Y.id, file: 'DEMO_ZZZFN5678L_FY2025-26.txt', text: tracesText({ pan: Y.pan, name: Y.name, fy: '2025-26', ay: '2026-27', created: '20-06-2026', deductors: fyY }) },
    ],
    months: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'],
  };
}

/** A statement in the TRACES "Export as Text" layout ("^"-separated) */
function tracesText({ pan, name, fy, ay, created, deductors }) {
  const n = v => Number(v).toFixed(2);
  const L = [
    'File Creation Date^Permanent Account Number (PAN)^Current Status of PAN^Financial Year^Assessment Year^Name of Assessee^Address Line 1^Address Line 2^Address Line 3^Address Line 4^Address Line 5^Statecode^Pin Code',
    `${created}^${pan}^Active^${fy}^${ay}^${name}^Demo address^^^^^24^380001`, '',
    'PART-I - Details of Tax Deducted at Source',
    'Sr. No.^Name of Deductor^TAN of Deductor^^^^^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)^Total TDS Deposited(Rs.)',
  ];
  for (const d of deductors) {
    const s = f => d.rows.reduce((a, x) => a + Math.round(x[f] * 100), 0) / 100;
    L.push(`${d.sr}^${d.cl.name}^${d.cl.tan}^^^^^${n(s('paid'))}^${n(s('deducted'))}^${n(s('deposited'))}`);
    L.push('^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount Paid / Credited(Rs.)^Tax Deducted(Rs.)^TDS Deposited(Rs.)');
    d.rows.forEach((x, i) => L.push(`^${i + 1}^${x.section}^${x.date}^${x.status}^${x.booked}^-^${n(x.paid)}^${n(x.deducted)}^${n(x.deposited)}`));
  }
  L.push('', 'PART-II - Details of Tax Deducted at Source for 15G / 15H', 'No Transactions Present', 'PART-III - Details of Transactions under Proviso to section 194B/First Proviso to sub-section (1) of section 194R', 'No Transactions Present', '');
  return L.join('\r\n');
}

async function writeEntity(sc, e) {
  const byFy = {};
  for (const x of sc.rows[e.id]) { const fy = require('./periods').fyOf(x.date); (byFy[fy] = byFy[fy] || { rows: {}, months: {} }).rows[x.id] = x; }
  for (const [fy, doc] of Object.entries(byFy)) await store.write(`ledger_${e.id}_${fy.replace('-', '_')}`, doc);
  await store.write(`docs_${e.id}`, sc.docs[e.id]);
  await store.write(`clients_${e.id}`, sc.clients[e.id]);
  await store.write(`sync_${e.id}`, { last_ok_at: '2026-08-12T06:30:00.000Z', listed: Object.fromEntries(sc.months.map(m => [m, '2026-08-12T06:30:00.000Z'])), history: [{ id: 'demo', by: 'demo data', mode: 'demo', from: '2026-01-01', to: '2026-06-30', started_at: '2026-08-12T06:29:00.000Z', ended_at: '2026-08-12T06:30:00.000Z', calls: 0, months: 6, errors: 0 }] });
}

/** Write the scenario into the store and import its statements through the real importer. upTo limits which statements (tests use it). */
async function load({ cfgNow, saveConfig, by = 'demo', statements = null }) {
  const sc = scenario();
  const cfg = await cfgNow();
  const keep = cfg.entities.filter(e => !e.demo);
  await saveConfig({ entities: [...keep, ...sc.entities] }, `loaded ${sc.entities.length} demo entities`);
  for (const e of sc.entities) { await removeData(e.id); await writeEntity(sc, e); }
  const imported = [];
  for (const s of statements ? sc.statements.filter((x, i) => statements.includes(i)) : sc.statements) {
    const e = sc.entities.find(x => x.id === s.entity);
    const pv = await ST.preview({ buffer: Buffer.from(s.text, 'utf8'), fileName: s.file, entity: e, by });
    const cm = await ST.commit({ previewId: pv.preview_id, entity: e, by, ack: true });
    imported.push({ file: s.file, version: cm.statement && cm.statement.version, rows: pv.totals.rows });
  }
  return { entities: sc.entities.map(e => e.id), imported };
}

async function removeData(id) {
  for (const k of [...(await store.list(`ledger_${id}_`)), `docs_${id}`, `clients_${id}`, `sync_${id}`, `review_${id}`, `cf_${id}`]) await store.remove(k);
  await ST.removeEntity(id);
}
async function remove({ cfgNow, saveConfig }) {
  const cfg = await cfgNow();
  const demo = cfg.entities.filter(e => e.demo);
  for (const e of demo) await removeData(e.id);
  await saveConfig({ entities: cfg.entities.filter(e => !e.demo) }, `removed ${demo.length} demo entities`);
  return { removed: demo.map(e => e.id) };
}

module.exports = { scenario, tracesText, load, remove, writeEntity, X, Y };
