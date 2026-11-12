/**
 * DEMO DATA — entirely synthetic. Creates the company "Demo Company (synthetic)" with Books documents and GSTR-2B
 * statements covering every situation the reconciliation handles, so the screens can be tried before real files and
 * Zoho data are loaded. It never touches Zoho, never uses a real GSTIN / supplier / amount, lives under its own
 * company id ("demo"), is labelled DEMO everywhere, and is removed completely with remove().
 */

'use strict';

const store = require('./store');
const books = require('./booksStore');
const C = require('./canonBooks');
const N = require('./normalize');
const ST = require('./statements');

const DEMO_ID = 'demo';
const mk = (state, pan, entity = '1') => { const f = `${state}${pan}${entity}Z`; return f + N.gstinCheckChar(f); };
const rng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const r2 = v => Math.round(v * 100) / 100;
const dmy = iso => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

const REC_A = mk('24', 'DEMOA1234A'), REC_B = mk('27', 'DEMOA1234A');
const BRANCHES = new Map([['demo_a1', { name: 'Demo Ahmedabad Office', gstin: REC_A, state: 'GJ' }], ['demo_a2', { name: 'Demo Vadodara Office', gstin: REC_A, state: 'GJ' }], ['demo_b1', { name: 'Demo Mumbai Office', gstin: REC_B, state: 'MH' }]]);
const STATES = ['24', '27', '29', '07', '36', '08'];
const SUPPLIERS = Array.from({ length: 14 }, (_, i) => {
  const pan = `ZS${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(66 + (i % 25))}A${String(1000 + i * 7).slice(-4)}${String.fromCharCode(65 + ((i * 3) % 26))}`;
  const st = STATES[i % STATES.length];
  return { name: `Demo Supplier ${String(i + 1).padStart(2, '0')}`, pan, state: st, gstin: mk(st, pan), second: mk(STATES[(i + 1) % STATES.length], pan), vendor: `dv${i + 1}` };
});

const tax = (inter, rate, taxable) => {
  const t = r2(taxable * rate / 100);
  return inter ? [{ tax_name: `IGST${rate} (${rate}%)`, tax_amount: t }] : [{ tax_name: `SGST${rate / 2} (${rate / 2}%)`, tax_amount: r2(t / 2) }, { tax_name: `CGST${rate / 2} (${rate / 2}%)`, tax_amount: r2(t - r2(t / 2)) }];
};

let seq = 0;
/** A Zoho-shaped bill detail → canonical Books document */
function booksDoc(ctx, o) {
  const id = `demo_b${++seq}`;
  const inter = o.sup.state !== (o.rec === REC_B ? '27' : '24');
  const taxes = o.rcm ? [] : tax(inter, o.rate || 18, o.taxable);
  const taxTotal = taxes.reduce((s, t) => s + t.tax_amount, 0);
  const branch = o.rec === REC_B ? 'demo_b1' : (seq % 3 ? 'demo_a1' : 'demo_a2');
  const detail = {
    bill_id: id, bill_number: o.no, vendor_id: o.sup.vendor, vendor_name: o.sup.name, gst_no: o.supGstin || o.sup.gstin, gst_treatment: 'business_gst', status: 'open', date: o.posting || o.date,
    branch_id: branch, branch_name: BRANCHES.get(branch).name, source_of_supply: inter ? 'MH' : (o.rec === REC_B ? 'MH' : 'GJ'), destination_of_supply: o.rec === REC_B ? 'MH' : 'GJ',
    is_reverse_charge_applied: !!o.rcm, sub_total: o.taxable, tax_total: taxTotal, total: r2(o.taxable + (o.rcm ? 0 : taxTotal)), adjustment: 0, discount_total: 0, tds_amount: 0, taxes,
    line_items: [{ account_name: 'Demo expense', item_total: o.taxable, tax_percentage: o.rate || 18, tax_name: 'GST', line_item_taxes: taxes, itc_eligibility: 'eligible', reverse_charge_tax_amount: o.rcm ? r2(o.taxable * 0.18) : undefined, reverse_charge_tax_name: o.rcm ? 'GST18' : undefined,
      project_name: o.project || '', project_id: o.project ? `dp_${o.project}` : '' }],
    payments: [], balance: 0, currency_code: 'INR', last_modified_time: `${o.posting || o.date}T10:00:00+0530`, created_time: `${o.posting || o.date}T10:00:00+0530`,
    custom_field_hash: { cf_vendor_bill_date_unformatted: o.date }, custom_fields: [{ api_name: 'cf_vendor_bill_date', value: o.date }], gst_return_details: { return_period: '', status: '' },
  };
  const doc = C.fromDetail(detail, null, ctx, 'bill');
  doc.id = `zb:demo:bill:${id}`; doc.zoho_id = id; doc.zoho_url = '#demo'; doc.demo = true;
  return doc;
}
function creditDoc(ctx, o) {
  const id = `demo_c${++seq}`;
  const taxes = tax(false, 18, o.taxable);
  const detail = { vendor_credit_id: id, vendor_credit_number: o.no, status: 'open', date: o.date, vendor_id: o.sup.vendor, vendor_name: o.sup.name, gst_no: o.sup.gstin, gst_treatment: 'business_gst', branch_id: 'demo_a1', branch_name: 'Demo Ahmedabad Office',
    source_of_supply: 'GJ', destination_of_supply: 'GJ', sub_total: o.taxable, total: r2(o.taxable * 1.18), taxes, line_items: [{ item_total: o.taxable, line_item_taxes: taxes }], bill_id: 'demo_b1', bill_number: 'ref', last_modified_time: `${o.date}T10:00:00+0530`, custom_field_hash: { cf_bill_date_unformatted: o.date }, custom_fields: [] };
  const doc = C.fromDetail(detail, null, ctx, 'vendor_credit');
  doc.id = `zb:demo:vendor_credit:${id}`; doc.zoho_id = id; doc.zoho_url = '#demo'; doc.demo = true;
  return doc;
}

const item = (rt, txval, igst, cgst, sgst) => ({ num: 1, rt, txval, igst, cgst, sgst, cess: 0 });
function portalInv(o) {
  const inter = o.sup.state !== (o.rec === REC_B ? '27' : '24');
  const rate = o.rate || 18, t = r2(o.taxable * rate / 100);
  const it = inter ? item(rate, o.taxable, o.igst ?? t, 0, 0) : item(rate, o.taxable, 0, o.cgst ?? r2(t / 2), o.sgst ?? r2(t - r2(t / 2)));
  return { inum: o.no, typ: 'R', dt: dmy(o.date), val: r2(o.taxable + it.igst + it.cgst + it.sgst), pos: o.rec === REC_B ? '27' : '24', rev: o.rcm ? 'Y' : 'N', itcavl: 'Y', items: [it] };
}

async function load({ cfgNow, saveConfig, recon, by }) {
  await remove({ cfgNow, saveConfig });
  seq = 0;
  const company = { id: DEMO_ID, name: 'Demo Company (synthetic)', short: 'DEMO', org_id: '', active: true, demo: true, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number',
    registrations: [{ gstin: REC_A, label: 'Demo — Gujarat', branch_ids: ['demo_a1', 'demo_a2'], active: true, gstr9_filed: {}, verified: { at: new Date().toISOString(), by: 'demo', source: 'synthetic' } }, { gstin: REC_B, label: 'Demo — Maharashtra', branch_ids: ['demo_b1'], active: true, gstr9_filed: {}, verified: { at: new Date().toISOString(), by: 'demo', source: 'synthetic' } }] };
  const cfg0 = await cfgNow();
  await saveConfig({ companies: [...cfg0.companies.filter(c => c.id !== DEMO_ID), company] }, 'synthetic demo company added');
  const ctx = { company, branches: BRANCHES, vendors: new Map() };
  const R = rng(20261111);
  const docs = [], reported = {};                                                       // reported[period] = { gstinOfRec: { b2b: {ctin: [...]}, ...} }
  const rep = (rec, period) => { const k = `${rec}|${period}`; return (reported[k] = reported[k] || { rec, period, b2b: new Map(), b2ba: new Map(), cdnr: new Map(), isd: [], impg: [] }); };
  const LATEST = N.todayIST().slice(0, 7);                                              // a statement for a future month cannot exist
  const addInv = (rec, period, sup, inv) => { if (period > LATEST) return; const g = rep(rec, period).b2b; const gs = inv.ctin || sup.gstin; (g.get(gs) || g.set(gs, []).get(gs)).push(inv.inv); };
  const nextPeriod = date => { const [y, m] = [+date.slice(0, 4), +date.slice(5, 7)]; return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
  const months = ['2026-08', '2026-09', '2026-10'];
  let n = 0;
  for (const month of months) for (const sup of SUPPLIERS) {
    const count = 1 + Math.floor(R() * 3);
    for (let k = 0; k < count; k++) {
      const day = String(1 + Math.floor(R() * 27)).padStart(2, '0'), date = `${month}-${day}`;
      const taxable = Math.round((800 + R() * 60000) * 100) / 100, rec = sup.state === '27' && n % 4 === 0 ? REC_B : REC_A;
      const prefix = ['INV', 'DS', 'TX', 'GJ/26-27'][n % 4];
      const no = `${prefix}/${String(100 + n).padStart(4, '0')}`;
      const o = { sup, no, date, taxable, rec, project: n % 5 === 0 ? 'Project Alpha' : '' };
      const d = booksDoc(ctx, o); docs.push(d);
      const period = nextPeriod(date), scen = n % 20; n++;
      const base = { sup, no, date, taxable, rec };
      if (scen <= 11) addInv(rec, period, sup, { inv: portalInv(base) });
      else if (scen === 12) addInv(rec, period, sup, { inv: portalInv({ ...base, cgst: r2(taxable * 0.09 + 0.5), igst: r2(taxable * 0.18 + 0.5) }) });                  // rounding difference
      else if (scen === 13) addInv(rec, period, sup, { inv: portalInv({ ...base, taxable: r2(taxable + 100) }) });                                                       // value mismatch
      else if (scen === 15) addInv(rec, period, sup, { inv: portalInv({ ...base, no: no.toLowerCase().replace('/', '-') }) });                                           // formatting only
      else if (scen === 16) addInv(rec, period, sup, { inv: portalInv({ ...base, no: no.replace(/\/0+(\d)/, '/$1') }) });                                                // leading zeros → suggestion
      else if (scen === 17) addInv(rec, period, sup, { inv: portalInv(base), ctin: sup.second });                                                                         // other GSTIN of the same PAN
      else if (scen === 18) addInv(rec, nextPeriod(nextPeriod(date)), sup, { inv: portalInv(base) });                                                                     // reported two months late
      /* 14 and 19: never reported → Books only */
    }
  }
  // special situations
  const s1 = SUPPLIERS[0], s2 = SUPPLIERS[1], s3 = SUPPLIERS[2];
  docs.push(booksDoc(ctx, { sup: s1, no: 'SPLIT/1', date: '2026-10-12', taxable: 15000, rec: REC_A }));                                                                  // split: one Books invoice, two on GSTR-2B
  addInv(REC_A, '2026-11', s1, { inv: portalInv({ sup: s1, no: 'SPLIT/1A', date: '2026-10-12', taxable: 10000, rec: REC_A }) }); addInv(REC_A, '2026-11', s1, { inv: portalInv({ sup: s1, no: 'SPLIT/1B', date: '2026-10-12', taxable: 5000, rec: REC_A }) });
  docs.push(booksDoc(ctx, { sup: s2, no: 'CONS/1', date: '2026-10-14', taxable: 8000, rec: REC_A }), booksDoc(ctx, { sup: s2, no: 'CONS/2', date: '2026-10-15', taxable: 2000, rec: REC_A }));         // consolidated
  addInv(REC_A, '2026-11', s2, { inv: portalInv({ sup: s2, no: 'CONS/ALL', date: '2026-10-15', taxable: 10000, rec: REC_A }) });
  const dup = { sup: s3, no: 'DUP/77', date: '2026-10-20', taxable: 4400, rec: REC_A };                                                                                      // booked twice
  docs.push(booksDoc(ctx, dup), booksDoc(ctx, dup)); addInv(REC_A, '2026-11', s3, { inv: portalInv(dup) });
  docs.push(booksDoc(ctx, { sup: s1, no: 'RCM/1', date: '2026-10-22', taxable: 5000, rec: REC_A, rcm: true })); addInv(REC_A, '2026-11', s1, { inv: portalInv({ sup: s1, no: 'RCM/1', date: '2026-10-22', taxable: 5000, rec: REC_A, rcm: true }) });
  docs.push(booksDoc(ctx, { sup: s2, no: 'AMD/NEW-9', date: '2026-08-18', taxable: 6000, rec: REC_A }));                                                                    // amendment: original reported in Sep, revised in Nov
  addInv(REC_A, '2026-09', s2, { inv: portalInv({ sup: s2, no: 'AMD/OLD-9', date: '2026-08-18', taxable: 5000, rec: REC_A }) });
  rep(REC_A, '2026-11').b2ba.set(s2.gstin, [{ oinum: 'AMD/OLD-9', oidt: dmy('2026-08-18'), ...portalInv({ sup: s2, no: 'AMD/NEW-9', date: '2026-08-18', taxable: 6000, rec: REC_A }) }]);
  for (const [i, o] of [[0, { no: 'CN/D-1', date: '2026-10-05', taxable: 1500 }], [1, { no: 'CN/D-2', date: '2026-10-09', taxable: 900 }], [2, { no: 'CN/D-3', date: '2026-10-16', taxable: 700 }]]) {
    docs.push(creditDoc(ctx, { sup: SUPPLIERS[i], ...o }));
    if (i < 2) { const g = rep(REC_A, '2026-11').cdnr; (g.get(SUPPLIERS[i].gstin) || g.set(SUPPLIERS[i].gstin, []).get(SUPPLIERS[i].gstin)).push({ ntnum: o.no, typ: 'C', suptyp: 'R', dt: dmy(o.date), val: r2(o.taxable * 1.18 + (i === 1 ? 40 : 0)), pos: '24', rev: 'N', itcavl: 'Y', items: [item(18, i === 1 ? r2(o.taxable + 40 / 1.18) : o.taxable, 0, r2((i === 1 ? o.taxable + 40 / 1.18 : o.taxable) * 0.09), r2((i === 1 ? o.taxable + 40 / 1.18 : o.taxable) * 0.09))] }); }
  }
  for (let i = 0; i < 6; i++) addInv(REC_A, '2026-11', SUPPLIERS[(i * 2) % 14], { inv: portalInv({ sup: SUPPLIERS[(i * 2) % 14], no: `ONLY/${i + 1}`, date: `2026-10-${String(8 + i * 3).padStart(2, '0')}`, taxable: 2500 + i * 900, rec: REC_A }) });   // reported by suppliers, not in Books
  // earlier years — the deadline demonstration: FY 2025-26 (30 Nov 2026 is close) and FY 2024-25 (past)
  for (let i = 0; i < 8; i++) {
    const sup = SUPPLIERS[i % 14], date = `2026-0${1 + (i % 3)}-1${i}`;
    const o = { sup, no: `FY2526/${i + 1}`, date, taxable: 7000 + i * 1300, rec: REC_A };
    docs.push(booksDoc(ctx, o));
    if (i < 3) addInv(REC_A, '2026-06', sup, { inv: portalInv(o) });                                                                                                       // reported late (across the year end) → matched with flags
  }                                                                                                                                                                          // the other five stay Books-only: still claimable until 30 Nov 2026
  for (let i = 0; i < 2; i++) docs.push(booksDoc(ctx, { sup: SUPPLIERS[i], no: `FY2425/${i + 1}`, date: `2025-02-0${3 + i}`, taxable: 12000, rec: REC_A }));                     // past 30 Nov 2025 → time-barred
  rep(REC_A, '2026-11').isd.push({ ctin: mk('27', 'DEMOH1234H'), trdnm: 'Demo Head Office (ISD)', supprd: '102026', supfildt: '11-11-2026', doclist: [{ doctyp: 'ISDI', docnum: 'ISD/D-1', docdt: '30-10-2026', igst: 0, cgst: 1200, sgst: 1200, cess: 0, itcelg: 'Y' }] });
  rep(REC_A, '2026-11').impg.push({ refdt: '05-10-2026', recdt: '06-10-2026', portcode: 'INDEMO1', boenum: '9990001', boedt: '04-10-2026', isamd: 'N', txval: 50000, igst: 9000, cess: 0 });
  // a Books document whose supplier GSTIN was typed wrongly
  const typo = SUPPLIERS[5].gstin.slice(0, 6) + (SUPPLIERS[5].gstin[6] === 'A' ? 'B' : 'A') + SUPPLIERS[5].gstin.slice(7);
  docs.push(booksDoc(ctx, { sup: SUPPLIERS[5], supGstin: typo, no: 'TYPO/5', date: '2026-10-11', taxable: 3300, rec: REC_A })); addInv(REC_A, '2026-11', SUPPLIERS[5], { inv: portalInv({ sup: SUPPLIERS[5], no: 'TYPO/5', date: '2026-10-11', taxable: 3300, rec: REC_A }) });

  await books.upsertMany(DEMO_ID, docs);
  // statements
  const cfg = await cfgNow();
  const out = [];
  for (const [, v] of Object.entries(reported).sort()) {
    const [py, pm] = v.period.split('-');
    const docdata = {};
    const block = (map, key, list = 'inv') => { if (map.size) docdata[key] = [...map.entries()].map(([ctin, arr]) => ({ ctin, trdnm: (SUPPLIERS.find(s => s.gstin === ctin || s.second === ctin) || { name: 'Demo Supplier' }).name, supprd: `${String(+pm - 1 || 12).padStart(2, '0')}${+pm - 1 ? py : +py - 1}`, supfildt: `11-${pm}-${py}`, [list]: arr })); };
    block(v.b2b, 'b2b'); block(v.b2ba, 'b2ba'); block(v.cdnr, 'cdnr', 'nt');
    if (v.isd.length) docdata.isd = v.isd; if (v.impg.length) docdata.impg = v.impg;
    const buf = Buffer.from(JSON.stringify({ chksum: 'demo', data: { data: { gstin: v.rec, rtnprd: `${pm}${py}`, version: 'DEMO', gendt: `14-${pm}-${py}`, docdata } } }));
    const pv = await ST.preview({ buffer: buf, fileName: `DEMO_GSTR2B_${v.rec}_${v.period}.json`, cfg, by });
    if (pv.can_commit) out.push(await ST.commit({ previewId: pv.preview_id, cfg, by, ack: true, demo: true }));
  }
  const r = await recon.run({ company: DEMO_ID, by, mode: 'all' });
  return { company: DEMO_ID, counts: { books_documents: docs.length, statements: out.length, reconciliation_rows: r.results.reduce((s, x) => s + x.summary.rows, 0) }, note: 'Synthetic data. Nothing here came from Zoho or the GST portal.' };
}

async function remove({ cfgNow, saveConfig }) {
  const keys = await store.list(`books_${DEMO_ID}_`);
  for (const k of keys) await store.remove(k);
  await store.remove(`books_idx_${DEMO_ID}`);
  for (const g of [REC_A, REC_B]) await store.remove(`recon_${DEMO_ID}_${g}`);
  await store.remove(`review_${DEMO_ID}`); await store.remove(`sync_${DEMO_ID}`);
  await store.withLock('stmt_idx', async () => {
    const idx = await store.read('stmt_idx', []);
    for (const s of idx.filter(x => x.demo)) await store.remove(`stmt_${s.id}`);
    await store.write('stmt_idx', idx.filter(x => !x.demo));
  });
  const cfg = await cfgNow();
  if (cfg.companies.some(c => c.id === DEMO_ID)) await saveConfig({ companies: cfg.companies.filter(c => c.id !== DEMO_ID) }, 'synthetic demo company removed');
  return { removed: true };
}

module.exports = { load, remove, DEMO_ID, REC_A, REC_B };
