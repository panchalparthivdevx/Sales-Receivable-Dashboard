/** Shared fixtures for the reconciliation / dashboard / export / API tests. SYNTHETIC data. */

'use strict';

const { tempDir, gstin } = require('./helpers');
const F = require('./fakeZoho');
const store = require('../lib/store');
const files = require('../lib/files');
const books = require('../lib/booksStore');
const C = require('../lib/canonBooks');
const ST = require('../lib/statements');
const R = require('../lib/recon');
const CFG = require('../lib/config');

function setup(over = {}) {
  const dir = tempDir();
  store.configure({ dir: dir + '/data', useDb: false });
  files.configure({ dir: dir + '/files', blob: null });
  const cfg = CFG.merge({ companies: [{ id: 'devx', name: 'Test Co', short: 'T', org_id: F.ORG, active: true, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number',
    registrations: [{ gstin: F.REC_A, active: true, ...(over.regA || {}) }, { gstin: F.REC_B, active: true }] }], ...(over.cfg || {}) });
  const ctx = { company: cfg.companies[0], branches: new Map(F.BRANCHES.map(b => [b.id, { name: b.name, gstin: b.gstin, state: b.state_code }])), vendors: new Map() };
  const recon = R.create({ cfgNow: async () => cfg, audit: { log: async () => {} } });
  const addBooks = async (...specs) => {
    const docs = specs.map(s => { const x = s.credit ? F.credit(s) : s.expense ? F.expense(s) : F.bill(s); return C.fromDetail(x.detail, x.row, ctx, s.credit ? 'vendor_credit' : s.expense ? 'expense' : 'bill'); });
    await books.upsertMany('devx', docs);
    return docs;
  };
  return { dir, cfg, ctx, recon, addBooks };
}

const item = (txval, cgst, sgst = cgst, igst = 0) => ({ num: 1, rt: 18, txval, igst, cgst, sgst, cess: 0 });
const inv = (no, dt, txval, cgst, extra = {}) => ({ inum: no, typ: 'R', dt, val: txval + cgst * 2, pos: '24', rev: 'N', itcavl: 'Y', items: [item(txval, cgst)], ...extra });
const stmt = ({ gstin: g = F.REC_A, period = '112026', gendt = '14-11-2026', b2b = [], b2ba = [], cdnr = [], isd = [], impg = [] }) => Buffer.from(JSON.stringify({ chksum: 'c', data: { data: { gstin: g, rtnprd: period, gendt, docdata: {
  ...(b2b.length ? { b2b } : {}), ...(b2ba.length ? { b2ba } : {}), ...(cdnr.length ? { cdnr } : {}), ...(isd.length ? { isd } : {}), ...(impg.length ? { impg } : {}) } } } }));
const sup = (ctin, list, supprd = '102026', supfildt = '11-11-2026') => ({ ctin, trdnm: 'Synthetic Supplier', supprd, supfildt, inv: list });
const importFile = async (cfg, buffer, extra = {}) => {
  const pv = await ST.preview({ buffer, fileName: 'gstr2b.json', cfg, by: 'tester', ...extra });
  if (!pv.can_commit) return { pv };
  return { pv, st: await ST.commit({ previewId: pv.preview_id, cfg, by: 'tester', ack: true, ...extra }) };
};
const byNo = (doc, no) => doc.rows.find(r => [...r.b, ...r.p].some(v => v.no === no));

/** The standard scenario used by the dashboard / export tests */
async function scenario(over) {
  const s = setup(over);
  await s.addBooks(
    { id: 'b1', no: 'INV/001', date: '2026-10-05', taxable: 1000 },
    { id: 'b2', no: 'INV/002', date: '2026-10-06', taxable: 2000 },
    { id: 'b3', no: 'INV/003', date: '2026-10-07', taxable: 3000 },
    { id: 'b4', no: 'INV/004', date: '2026-10-08', taxable: 500 },
    { id: 'b5', no: 'inv-005', date: '2026-10-09', taxable: 800 },
    { id: 'b6', no: 'INV/006', date: '2026-10-10', taxable: 600 },
    { id: 'c1', credit: true, no: 'CN/1', date: '2026-10-18', cfDate: '2026-10-18', taxable: 500 },
    { id: 'x1', no: 'NG/1', date: '2026-10-11', gst: '' },
  );
  const SUP2 = gstin('24', 'AAACS1111A', '2');
  await importFile(s.cfg, stmt({
    b2b: [
      sup(F.SUP_GJ, [inv('INV/001', '05-10-2026', 1000, 90), inv('INV/002', '06-10-2026', 2000, 180.5, { val: 2361 }), inv('INV/003', '07-10-2026', 3000, 275), inv('INV/005', '09-10-2026', 800, 72)]),
      sup(SUP2, [inv('INV/006', '10-10-2026', 600, 54)]),
      sup(F.SUP_MH, [inv('INV/900', '12-10-2026', 700, 63)]),
    ],
    cdnr: [{ ctin: F.SUP_GJ, trdnm: 'Synthetic Supplier', supprd: '102026', supfildt: '11-11-2026', nt: [{ ntnum: 'CN/1', typ: 'C', suptyp: 'R', dt: '18-10-2026', val: 590, pos: '24', rev: 'N', itcavl: 'Y', items: [item(500, 45)] }] }],
    isd: [{ ctin: gstin('27', 'AAACT2803M'), trdnm: 'HO', supprd: '102026', supfildt: '11-11-2026', doclist: [{ doctyp: 'ISDI', docnum: 'ISD/1', docdt: '30-10-2026', igst: 0, cgst: 50, sgst: 50, cess: 0, itcelg: 'Y' }] }],
  }));
  await s.recon.run({ company: 'devx', gstin: F.REC_A, by: 'tester' });
  s.doc = await s.recon.load('devx', F.REC_A);
  return s;
}

module.exports = { setup, scenario, item, inv, stmt, sup, importFile, byNo, F };
