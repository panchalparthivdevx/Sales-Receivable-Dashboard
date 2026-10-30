'use strict';
// ─── Vendor Payment Report (Purchase & Payables) ─────────────────────────────────
// Every vendor payment of the previous and the current FY, classified by how it was made, with its
// PO, project and categories:
//   Against Bill          paid against bills dated on or before the payment date
//   Advance – Against PO  paid before any bill (nothing applied yet, or applied only to bills dated
//                         after the payment), with a PO: the payment's "Purchase Order No", else the
//                         PO a later bill was converted from
//   Advance – Without PO  the same without any PO
//   Bill + Advance        part against bills that already existed, part advance or excess (still
//                         unused, or applied to a later bill)
//
// Sync — the stage-4 entity 'vendor_payment_report' keeps its own copy of three Zoho lists, keyed on
// Zoho IDs: vendor payments (previous + current FY), purchase orders (all) and the previous FY's bills.
// Current-FY bills, vendors and vendor credits come from the central sync.
//  1. Baseline, once per list: pages sorted by date, each saved as soon as it is read together with the
//     oldest date it reached. An interrupted read continues from that date, never from page 1.
//  2. Every later run reads only what changed:
//     • change feeds: records whose last_modified_time is newer than the newest one already read
//       (usually one call per list);
//     • control totals: Zoho's record count (response_option=2) against the local count. A difference
//       is narrowed down to the month and only that month is re-listed. This is how records deleted in
//       Zoho are found — no change feed reports a deletion;
//     • vendor balances: each vendor's unused credits (Vendors — All) against the local unused payments
//       + credits. A vendor whose difference moved had a payment changed without a new
//       last_modified_time (Zoho does that for ~1.5% of later applications to bills), so that vendor's
//       payments alone are re-listed.
//  3. Details only the per-record API returns, fetched once per record (again only when it changes):
//     a PO's multi-select "Sub Category" (= the bill's "Project Sub Category"), a bill's PO when its
//     reference number is not that PO's number, refunds. Newest payments first; on the office PC a
//     first-build backlog fills in the background without holding up the central sync.
//  4. Rows: only the payments a change touches are re-calculated (all of them, locally without Zoho
//     calls, on the first build, after a Full Sync and once a day as a safety net).
//  5. Bill uploads and remarks (report page): the purchase team uploads an advance's bill, both teams
//     write remarks — kept per payment in vendor_payment_report_notes (user data, not synced). Once
//     Accounts books the uploaded bill in Zoho and adjusts the advance against it, the page shows the
//     payment as Against Bill. Zoho does not always mark such a payment as changed, so the vendors of
//     uploaded-bill payments still open are re-listed when one of their bills changes.
// The endpoint and the period filters only read the built rows; viewing the report never calls Zoho.

const path = require('path');

const VERSION = 2;
const KEYS = {
  rows:     'vendor_payment_report',            // built rows — what the endpoint reads
  meta:     'vendor_payment_report_meta',       // list reads, high-water marks, control totals, status
  payments: 'vendor_payment_report_payments',   // vendor payments of both FYs (list fields)
  pos:      'vendor_payment_report_pos',        // purchase orders, all of them (list fields)
  bills:    'vendor_payment_report_prev_bills', // bills of the previous FY (list fields)
  details:  'vendor_payment_report_details',    // fields only the per-record API returns
};
const EPS          = 0.5;           // ₹ — a balance below this counts as nil
const PER_PAGE     = 200;
const MAX_PAGES    = 250;           // per list read; a page cap fails the run instead of truncating
const OVERLAP_MS   = 15 * 60000;    // change feeds re-read 15 min before the newest change read
const RELIST_CAP   = 25;            // month / vendor re-lists per run; any rest the next run
const FULL_BUILD_H = 24;            // rows are re-calculated in full (locally) at least this often
const PO_FROM      = '2000-01-01';  // purchase orders: every date
const PO_TO        = '2099-12-31';
// Vendor Category values (bill-level and vendor master) whose bills carry Project Sub Category / a PO
const PROJECT_VENDOR_CATS = new Set([
  'project vendor', 'project vendors', 'maintanance vendor', 'maintenance vendor', 'repairs & maint. vendors',
]);
// Placeholder Project_Details values: a real project on the other document wins, and no mismatch is
// flagged against them (2026-10-27: 166 of 281 payment/PO differences were a PO tagged "Other")
const GENERIC_PROJECTS = new Set(['other', 'others']);

// List fields kept per record — rows are built from these
const PAY_FIELDS = [
  'payment_id', 'vendor_id', 'vendor_name', 'payment_number', 'date', 'payment_mode', 'amount', 'bcy_amount',
  'balance', 'bcy_balance', 'paid_through_account_name', 'reference_number', 'branch_name', 'currency_code',
  'bill_numbers', 'cf_purchase_order_no', 'cf_purchase_order_no_unformatted', 'cf_project_details',
  'cf_project_details_unformatted', 'status', 'created_time', 'last_modified_time',
];
const PO_FIELDS = [
  'purchaseorder_id', 'vendor_id', 'purchaseorder_number', 'date', 'status', 'cf_project_test',
  'cf_project_test_unformatted', 'cf_category', 'last_modified_time',
];
const BILL_FIELDS = [
  'bill_id', 'vendor_id', 'bill_number', 'reference_number', 'date', 'status', 'cf_category', 'cf_vendor_category',
  'last_modified_time',
];
// The lists this report keeps. All three default to every status. /bills applies date_start/date_end
// only without filter_by — with filter_by=Status.All Zoho ignores the dates (checked 2026-10-27).
const LISTS = {
  payments: { path: '/vendorpayments', key: 'vendorpayments', id: 'payment_id',       fields: PAY_FIELDS,  label: 'Vendor payments' },
  pos:      { path: '/purchaseorders', key: 'purchaseorders', id: 'purchaseorder_id', fields: PO_FIELDS,   label: 'Purchase orders' },
  bills:    { path: '/bills',          key: 'bills',          id: 'bill_id',          fields: BILL_FIELDS, label: 'Previous-FY bills' },
};
const ORDER = ['payments', 'pos', 'bills'];
// Row fields always present, even when blank
const KEEP_FIELDS = new Set(['id', 'date', 'number', 'vendor', 'amount', 'unused', 'adjusted', 'type', 'vendor_category']);

// Bill uploads and remarks entered on the report page
const NOTES_KEY   = 'vendor_payment_report_notes';
const NOTES_V     = 1;
const REMARK_MAX  = 2000;          // characters per remark
const HISTORY_MAX = 50;            // changes kept per payment (who uploaded, removed or wrote what)
const UPLOAD_RECHECK_H = 24;       // an open uploaded-bill payment's vendor is re-listed at least this often
// File types a bill can be uploaded as, and the type each is served with
const BILL_TYPES = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.heic': 'image/heic', '.heif': 'image/heif', '.csv': 'text/csv',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const num   = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2    = n => Math.round(n * 100) / 100;
const clean = s => String(s ?? '').trim();
const norm  = s => clean(s).toLowerCase();
const uniq  = a => [...new Set(a.filter(Boolean))];
const splitBills = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const pick  = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') r[k] = o[k]; return r; };
const inRange = (d, from, to) => !!d && d >= from && d <= to;
const isoNow = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const zohoMessage = e => e?.response?.data?.message || e?.message || String(e);
// Zoho timestamps look like 2026-09-29T17:10:12+0530
const tsMs  = s => { if (!s) return 0; const t = Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')); return Number.isNaN(t) ? 0 : t; };
function shiftDate(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const fyStartOf = d => { const y = Number(d.slice(0, 4)); return `${Number(d.slice(5, 7)) >= 4 ? y : y - 1}-04-01`; };
const fyEndOf   = d => `${Number(fyStartOf(d).slice(0, 4)) + 1}-03-31`;
function monthEnd(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
function nextMonth(ym) { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }
// [from, to] cut into calendar months
function monthsOf(from, to) {
  const out = [];
  for (let ym = from.slice(0, 7); `${ym}-01` <= to; ym = nextMonth(ym)) {
    const s = `${ym}-01`, e = monthEnd(ym);
    out.push({ from: s < from ? from : s, to: e > to ? to : e });
  }
  return out;
}
// How a date range whose count differs is narrowed: over several financial years → one piece per year
// within [lo, hi], plus the part before lo / after hi as one piece each (re-listed whole: they hold
// next to nothing); within one financial year → its months; a single month → null (re-list it)
function pieces(from, to, lo, hi) {
  if (fyStartOf(from) === fyStartOf(to)) {
    const ms = monthsOf(from, to);
    return ms.length > 1 ? ms : null;
  }
  const out = [];
  let s = from;
  if (s < lo) { out.push({ from: s, to: shiftDate(lo, -1), edge: true }); s = lo; }
  const end = to > hi ? hi : to;
  while (s <= end) {
    const e = fyEndOf(s) < end ? fyEndOf(s) : end;
    out.push({ from: s, to: e });
    s = shiftDate(e, 1);
  }
  if (to > hi) out.push({ from: shiftDate(hi, 1), to, edge: true });
  return out;
}

// Values of a multi-select custom field in a Zoho detail record (custom_fields[].value is an array)
function multiValues(rec, api) {
  const f = (rec.custom_fields || []).find(c => c.api_name === api);
  let v = f?.value;
  if (!Array.isArray(v) || !v.length) v = f?.value_formatted ?? rec.custom_field_hash?.[api] ?? '';
  const list = Array.isArray(v) ? v : String(v).split(',');
  return uniq(list.map(x => clean(x && typeof x === 'object' ? (x.name ?? x.value) : x)));
}
const fieldText = (rec, api) =>
  clean((rec.custom_fields || []).find(c => c.api_name === api)?.value_formatted ?? rec.custom_field_hash?.[api]);

// How a payment was made. billDates: the date of each bill it paid (null = not in the synced bills,
// i.e. older than them, so dated before the payment).
function classify({ date, amount, unused, refunded = 0, billDates, hasPo }) {
  const later   = billDates.filter(d => d && d > date).length;
  const earlier = billDates.length - later;
  let type;
  if (!billDates.length) type = 'advance';
  else if (!later) type = unused > EPS ? 'mixed' : 'bill';
  else type = earlier ? 'mixed' : 'advance';
  if (type === 'advance') type = hasPo ? 'adv_po' : 'adv';
  const adjusted = r2(Math.max(0, amount - unused - refunded));
  let status = '';
  if (type !== 'bill') {
    if (unused >= amount - EPS) status = 'unadjusted';
    else if (unused > EPS) status = 'partly';
    else status = refunded > EPS && adjusted <= EPS ? 'refunded' : 'adjusted';
  }
  return { type, status, adjusted };
}

const isProjectVendor = (billVcat, vendorVcat) =>
  PROJECT_VENDOR_CATS.has(norm(billVcat)) || PROJECT_VENDOR_CATS.has(norm(vendorVcat));
// The vendor's PO whose number is the bill's reference number — Zoho fills it in when a PO is
// converted to a bill (all 8 bills sampled on 2026-10-27 matched the PO in their bill detail)
const refPoOf = (b, vendorId, poByVendorNo) => (b?.ref && poByVendorNo?.get(`${vendorId}|${norm(b.ref)}`)) || '';
// The PO a paid bill was converted from — looked for on project / maintenance vendor bills only:
// Zoho's own link in the bill detail, else the reference-number match
function billPoOf(b, vendorId, { src, poByVendorNo, vendorById }) {
  if (!b || !isProjectVendor(b.vcat, vendorById.get(vendorId)?.cf_vendor_category)) return '';
  return src.bill_detail[b.id]?.po?.[0] || refPoOf(b, vendorId, poByVendorNo);
}
const rowOrder = (a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number);

// One row per payment (drafts and voids left out), newest first
function buildRows({ payments, billIndex, poById, vendorById, src, poByVendorNo = null }) {
  const look = { src, poByVendorNo, vendorById };
  const rows = [];
  for (const p of payments) {
    if (['draft', 'void'].includes(norm(p.status))) continue;
    const amount = r2(num(p.bcy_amount ?? p.amount));
    const unused = r2(num(p.bcy_balance ?? p.balance));
    const pd = src.pay_detail[p.payment_id];
    let nos = splitBills(p.bill_numbers);
    let dates;
    if (!nos.length && pd?.bills?.length) {          // bills only the payment detail lists
      nos = pd.bills.map(b => b.n);
      dates = pd.bills.map(b => b.d || null);
    }
    const bills = nos.map(n => billIndex.get(`${p.vendor_id}|${norm(n)}`) || null);
    dates = dates || bills.map(b => b?.date || null);
    const refunded = r2(num(pd?.refunded));
    const vcat = vendorById.get(p.vendor_id)?.cf_vendor_category;

    // PO: the payment's own "Purchase Order No", else the PO a paid bill was converted from
    const tagId = clean(p.cf_purchase_order_no_unformatted);
    const tagNo = clean(p.cf_purchase_order_no);
    let poId = tagId;
    let poSrc = tagId || tagNo ? 'payment' : '';
    if (!poSrc) {
      const viaBill = bills.map(b => billPoOf(b, p.vendor_id, look)).find(Boolean);
      if (viaBill) { poId = viaBill; poSrc = 'bill'; }
    }
    const po = poId ? poById.get(poId) : null;
    const { type, status, adjusted } = classify({ date: p.date, amount, unused, refunded, billDates: dates, hasPo: !!poSrc });

    // Project_Details: the payment's own, else (blank or only "Other") its PO's
    const payProj = clean(p.cf_project_details);
    const poProj  = po ? clean(po.cf_project_test) : '';
    const payProjId = clean(p.cf_project_details_unformatted);
    const poProjId  = po ? clean(po.cf_project_test_unformatted) : '';
    const generic = s => GENERIC_PROJECTS.has(norm(s));
    const usePo = !!poProj && (!payProj || (generic(payProj) && !generic(poProj)));
    const mismatch = !!(payProj && poProj && !generic(payProj) && !generic(poProj) &&
      (payProjId && poProjId ? payProjId !== poProjId : norm(payProj) !== norm(poProj)));

    // Sub-Category / Project Sub Category: the PO's, else the paid bills'
    const poDet   = po ? src.po_detail[poId] : null;
    const billCat = uniq(bills.map(b => b && (b.cat || src.bill_detail[b.id]?.cat)));
    const billSub = uniq(bills.flatMap(b => (b && src.bill_detail[b.id]?.sub) || []));
    const poSub   = poDet?.sub || [];

    const row = {
      id: p.payment_id, date: p.date || '', number: p.payment_number || '',
      vendor_id: p.vendor_id || '', vendor: p.vendor_name || '',
      mode: p.payment_mode || '', amount, unused, adjusted,
      paid_through: p.paid_through_account_name || '', reference: p.reference_number || '', branch: p.branch_name || '',
      type, status,
      po_number: tagNo || (po?.purchaseorder_number || ''), po_src: poSrc,
      po_status: po?.status || '', po_date: po?.date || '',
      bills: nos.join(', '), bill_dates: dates.map(d => d || '').join(', '),
      project: usePo ? poProj : payProj, project_src: usePo ? 'po' : payProj ? 'payment' : '',
      po_project: poProj, project_mismatch: mismatch,
      proj_sub_category: (poSub.length ? poSub : billSub).join(', '),
      sub_category: clean(po?.cf_category) || billCat.join(', '),
      vendor_category: clean(vcat) || 'Uncategorized',
    };
    if (refunded > EPS) row.refunded = refunded;
    if (p.currency_code && p.currency_code !== 'INR') row.currency = p.currency_code;
    if (poSrc === 'payment' && tagId && !po) row.po_missing = true;      // tagged PO no longer in Zoho
    // Project Sub Category still to come: the PO's detail, or (no PO yet) a project bill's detail
    if ((po && !poDet) || (!poSrc && bills.some(b => b && isProjectVendor(b.vcat, vcat) && !src.bill_detail[b.id]))) row.sub_pending = true;
    // Blank optional fields are left out (≈ a third of the rows' size)
    for (const k of Object.keys(row)) if (!KEEP_FIELDS.has(k) && (row[k] === '' || row[k] === false)) delete row[k];
    rows.push(row);
  }
  return rows.sort(rowOrder);
}

// runMs / detailMs / chunkMs / kickDelayMs: overrides for tests
function create({ db, syncEngine, pacedGet, isFatal, ensureDir, isVercel, runMs, detailMs, chunkMs, kickDelayMs = 3000 }) {
  const FILE = k => path.join(__dirname, 'sync_data', `${k}.json`);
  // One engine run: list reads and checks until RUN_MS (on Vercel well inside the 300-second function
  // the other entities share); detail calls get DETAIL_MS of it. Kept short because a scheduled sync
  // that finds a run still going is skipped. On the office PC what is left of a backlog continues in
  // the background in CHUNK_MS slices, each started only while no sync runs.
  const RUN_MS    = runMs ?? (isVercel ? 120000 : 90000);
  const DETAIL_MS = detailMs ?? (isVercel ? 60000 : 20000);
  const CHUNK_MS  = chunkMs ?? 45000;

  let rowsMem = null;              // { at, store } — the built rows, re-read at most once a minute
  let jobs = Promise.resolve();    // engine runs and background slices run one at a time
  let live = null;                 // what the running job is doing (status line)
  let worker = null;               // background backlog (office PC)
  let workerError = null;
  let centralMem = null;           // compact central data, reused by background slices for 5 min
  const serial = fn => { const p = jobs.then(fn); jobs = p.catch(() => {}); return p; };
  const setLive = o => { live = { ...(live || {}), ...o, at: isoNow() }; };

  // ── Storage ──
  const readKey = k => db.readJSON(k, FILE(k), null);
  async function writeKey(k, data) { ensureDir(); await db.writeJSON(k, FILE(k), data); }
  async function loadState() {
    const [meta, payments, pos, bills, det] = await Promise.all([KEYS.meta, KEYS.payments, KEYS.pos, KEYS.bills, KEYS.details].map(readKey));
    const ok = d => d && d.v === VERSION;
    return {
      meta:     ok(meta) ? meta : null,
      payments: ok(payments) ? payments.items : {},
      pos:      ok(pos) ? pos.items : {},
      bills:    ok(bills) ? bills.items : {},
      det:      ok(det) ? det : { v: VERSION, po_detail: {}, bill_detail: {}, pay_detail: {} },
    };
  }
  async function save(S, parts) {
    const at = isoNow();
    const w = [];
    for (const kind of ORDER) if (parts.includes(kind)) w.push(writeKey(KEYS[kind], { v: VERSION, updated_at: at, items: S[kind] }));
    if (parts.includes('details')) w.push(writeKey(KEYS.details, { ...S.det, v: VERSION, updated_at: at }));
    S.meta.counts = Object.fromEntries(ORDER.map(k => [k, Object.keys(S[k]).length]));
    S.meta.updated_at = at;
    w.push(writeKey(KEYS.meta, S.meta));
    await Promise.all(w);
  }
  async function readRows() {
    const s = await readKey(KEYS.rows);
    return s && s.v === VERSION ? s : null;
  }
  async function current() {
    if (rowsMem && Date.now() - rowsMem.at < 60000) return rowsMem.store;
    rowsMem = { at: Date.now(), store: await readRows() };
    return rowsMem.store;
  }
  async function writeRows(s) {
    await writeKey(KEYS.rows, s);
    rowsMem = { at: Date.now(), store: s };
  }

  // ── Window: previous FY start → current FY end ──
  function windowNow() {
    const d = syncEngine.getCurrentDates();
    const y = Number(d.fyStart.slice(0, 4));
    return { from: `${y - 1}-04-01`, prevTo: shiftDate(d.fyStart, -1), fyStart: d.fyStart, to: d.fyEnd, today: d.today };
  }
  const rangeOf = (kind, w) =>
    (kind === 'payments' ? { from: w.from, to: w.to } : kind === 'pos' ? { from: PO_FROM, to: PO_TO } : { from: w.from, to: w.prevTo });
  const newRead = (kind, w, reason) => ({
    ...rangeOf(kind, w), reason, started_ms: 0, started_at: null, cursor: null, pages: 0, pages_total: null,
    records: 0, total: null, done: false, completed_at: null,
  });
  function newMeta(w) {
    return {
      v: VERSION, created_at: isoNow(),
      window: { from: w.from, prevTo: w.prevTo, fyStart: w.fyStart, to: w.to },
      ready: { payments: false, pos: false, bills: false },     // the first complete read of each list
      read: Object.fromEntries(ORDER.map(k => [k, newRead(k, w, 'first build')])),
      hwm: { payments: 0, pos: 0, bills: 0 },                    // newest Zoho last_modified_time read (ms)
      seen_bills: 0,                                             // central bills already applied to rows (ms)
      vendor_cat: {}, vendor_off: null, vendor_check: null,
      control: null, pending: null, counts: null, last_check: null, last_full_build_at: null,
    };
  }
  // A new financial year: payments and bills before the new window are dropped; the payments of the
  // year that came in are read once (only those dated ahead of time exist yet) and last year's bills —
  // so far the central current-FY list — are read into the previous-FY list
  function rollWindow(S, w, res) {
    const old = S.meta.window;
    for (const kind of ['payments', 'bills']) {
      for (const [id, r] of Object.entries(S[kind])) if (!r.date || r.date < w.from) { delete S[kind][id]; res.dirty.add(kind); }
    }
    S.meta.read.payments = { ...newRead('payments', w, 'new financial year'), from: shiftDate(old.to, 1) > w.from ? shiftDate(old.to, 1) : w.from };
    S.meta.read.bills = newRead('bills', w, 'new financial year');
    S.meta.ready.bills = false;
    S.meta.window = { from: w.from, prevTo: w.prevTo, fyStart: w.fyStart, to: w.to };
    S.meta.vendor_off = null;
    S.meta.vendor_check = null;
    S.meta.control = null;
    res.full = true;
  }

  // ── Zoho calls (paced, counted) ──
  async function get(cat, p, params, res) {
    res.calls[cat]++;
    if (res.ctx) {
      res.ctx.pages = (res.ctx.pages || 0) + 1;
      if (res.ctx.prog) res.ctx.prog.pages = res.ctx.pages;
    }
    return pacedGet(p, params);
  }
  async function count(kind, from, to, res) {
    const d = await get('count', LISTS[kind].path, { date_start: from, date_end: to, response_option: 2 }, res);
    const n = Number(d.page_context?.total);
    if (!Number.isFinite(n)) throw new Error(`Zoho returned no ${LISTS[kind].label.toLowerCase()} count`);
    return n;
  }
  const localCount = (S, kind, from, to) => { let n = 0; for (const r of Object.values(S[kind])) if (inRange(r.date, from, to)) n++; return n; };

  // ── Local copy: upserts keyed on the Zoho ID ──
  // What a changed record means for the rows
  function touched(kind, rec, prev, res) {
    const ch = res.ch;
    if (kind === 'payments') { if (rec) ch.pay.add(rec.payment_id); else ch.payGone.add(prev.payment_id); }
    else if (kind === 'pos') ch.pos.add((rec || prev).purchaseorder_id);
    else for (const b of [rec, prev]) if (b) ch.billKeys.add(`${b.vendor_id}|${norm(b.bill_number)}`);
  }
  function upsert(S, kind, r, res) {
    const L = LISTS[kind];
    const id = r[L.id];
    if (!id) return;
    const rec = pick(r, L.fields);
    rec._s = Date.now();                       // last seen in a Zoho list
    const prev = S[kind][id];
    const st = res.stats[kind];
    if (!prev) { st.added++; touched(kind, rec, null, res); }
    else if (L.fields.some(f => String(prev[f] ?? '') !== String(rec[f] ?? ''))) { st.updated++; touched(kind, rec, prev, res); }
    else st.unchanged++;
    S[kind][id] = rec;
    res.dirty.add(kind);
  }
  function remove(S, kind, id, res) {
    const r = S[kind][id];
    delete S[kind][id];
    res.stats[kind].removed++;
    touched(kind, null, r, res);
    res.dirty.add(kind);
  }

  // ── 1. List reads (baseline, Full Sync, new FY) ──
  // Pages in date order (newest first). Every page is saved at once with the oldest date it reached; a
  // read that stops (time budget, restart, Zoho limit) continues from that date — that day's records
  // are read again, nothing before them.
  async function readList(S, kind, until, res, yieldFn) {
    const L = LISTS[kind];
    const R = S.meta.read[kind];
    if (!R.started_ms) {
      R.started_ms = Date.now();
      R.started_at = isoNow();
      R.total = await count(kind, R.from, R.to, res);
      R.pages_total = Math.max(1, Math.ceil(R.total / PER_PAGE));
      await save(S, []);
    }
    const end = R.cursor || R.to;
    for (let page = 1; ; page++) {
      if (Date.now() >= until || res.stopped || (yieldFn && yieldFn())) return false;
      if (page > MAX_PAGES) throw new Error(`Page cap (${MAX_PAGES} pages) reached on ${L.path} — report left unchanged`);
      setLive({ phase: 'baseline', list: kind, label: L.label, page: R.pages + 1, pages_total: R.pages_total,
        records: R.records, total: R.total, reached: R.cursor });
      const d = await get('list', L.path, { date_start: R.from, date_end: end, sort_column: 'date', sort_order: 'D', page, per_page: PER_PAGE }, res);
      const items = d[L.key] || [];
      for (const r of items) {
        if (!inRange(r.date, R.from, R.to)) continue;
        const was = S[kind][r[L.id]];
        if (!was || (was._s || 0) < R.started_ms) R.records++;
        upsert(S, kind, r, res);
      }
      R.pages++;
      res.pages++;
      if (items.length) R.cursor = items[items.length - 1].date || R.cursor;
      if (!items.length || !d.page_context?.has_more_page) {
        finishRead(S, kind, res);
        await save(S, [kind]);
        return true;
      }
      await save(S, [kind]);
    }
  }
  function finishRead(S, kind, res) {
    const R = S.meta.read[kind];
    // Records of the range not seen since the read began are no longer in Zoho
    for (const [id, r] of Object.entries(S[kind])) if (inRange(r.date, R.from, R.to) && (r._s || 0) < R.started_ms) remove(S, kind, id, res);
    R.done = true;
    R.completed_at = isoNow();
    S.meta.ready[kind] = true;
    // The change feed carries on from when this read began, so edits made meanwhile are read again
    S.meta.hwm[kind] = Math.max(S.meta.hwm[kind] || 0, R.started_ms);
    res.full = true;
  }

  // ── 2a. Change feeds ──
  // Records changed in Zoho since the newest change already read, newest first (usually one page)
  async function feed(S, kind, w, res) {
    const L = LISTS[kind];
    const { from, to } = rangeOf(kind, w);
    const since = (S.meta.hwm[kind] || 0) - OVERLAP_MS;
    let hwm = S.meta.hwm[kind] || 0, n = 0;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error(`Page cap (${MAX_PAGES} pages) reached on ${L.path} changes`);
      const d = await get('feed', L.path, { date_start: from, date_end: to, sort_column: 'last_modified_time', sort_order: 'D', page, per_page: PER_PAGE }, res);
      const items = d[L.key] || [];
      let older = false;
      for (const r of items) {
        const t = tsMs(r.last_modified_time);
        if (t && t < since) { older = true; break; }
        n++;
        if (t > hwm) hwm = t;
        if (inRange(r.date, from, to)) upsert(S, kind, r, res);
      }
      if (older || !items.length || !d.page_context?.has_more_page) break;
    }
    S.meta.hwm[kind] = hwm;
    return n;
  }

  // ── 2b. Control totals ──
  // Re-reads part of a list and makes the local copy match it exactly: upserts what Zoho returns and
  // removes the local records of that part Zoho no longer has (deleted)
  async function relist(S, kind, params, inPart, res) {
    const L = LISTS[kind];
    const t = Date.now();
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error(`Page cap (${MAX_PAGES} pages) reached on ${L.path} re-list`);
      const d = await get('relist', L.path, { ...params, sort_column: 'date', sort_order: 'D', page, per_page: PER_PAGE }, res);
      const items = d[L.key] || [];
      for (const r of items) if (inPart(r)) upsert(S, kind, r, res);
      if (!items.length || !d.page_context?.has_more_page) break;
    }
    for (const [id, r] of Object.entries(S[kind])) if (inPart(r) && (r._s || 0) < t) remove(S, kind, id, res);
  }
  // Zoho's record count of each list against the local copy; a difference is narrowed down to the
  // months that differ and only those are re-listed. deep (Recheck): lists that span several financial
  // years are also counted per year when the totals agree.
  async function controlTotals(S, w, until, res, deep) {
    const checks = [];
    const budget = { relists: 0 };
    for (const kind of ORDER) {
      const { from, to } = rangeOf(kind, w);
      const local = localCount(S, kind, from, to);
      const zoho = await count(kind, from, to, res);
      const c = { list: kind, label: LISTS[kind].label, zoho, local, repaired: [], incomplete: false };
      if (zoho !== local || (deep && fyStartOf(from) !== fyStartOf(to))) await narrow(S, kind, { from, to }, w, until, res, budget, c, deep);
      c.local_after = localCount(S, kind, from, to);
      checks.push(c);
    }
    S.meta.control = { at: isoNow(), deep: !!deep, checks };
    return checks;
  }
  async function narrow(S, kind, range, w, until, res, budget, c, all) {
    const oldest = kind === 'pos' ? Object.values(S.pos).reduce((m, r) => (r.date && r.date < m ? r.date : m), w.from) : w.from;
    const parts = pieces(range.from, range.to, fyStartOf(oldest), w.to);
    if (!parts || range.edge) {
      if (budget.relists >= RELIST_CAP || Date.now() >= until || res.stopped) { c.incomplete = true; return; }
      const before = localCount(S, kind, range.from, range.to);
      setLive({ phase: 'repair', list: kind, label: LISTS[kind].label, from: range.from, to: range.to });
      await relist(S, kind, { date_start: range.from, date_end: range.to }, r => inRange(r.date, range.from, range.to), res);
      budget.relists++;
      c.repaired.push({ from: range.from, to: range.to, local_before: before, local_after: localCount(S, kind, range.from, range.to) });
      return;
    }
    for (const p of parts) {
      if (Date.now() >= until || res.stopped) { c.incomplete = true; return; }
      const z = await count(kind, p.from, p.to, res);
      const l = localCount(S, kind, p.from, p.to);
      if (all) (c.pieces = c.pieces || []).push({ from: p.from, to: p.to, zoho: z, local: l });
      if (z !== l) await narrow(S, kind, p, w, until, res, budget, c, false);
    }
  }

  // ── 2c. Vendor balances ──
  // Each vendor's unused credits in Zoho (Vendors — All, synced at the start of the run) against the
  // local unused payments + vendor credits. The difference stays put (older payments and credits
  // outside the window) unless Zoho changed a payment without a new last_modified_time — then that
  // vendor's payments alone are re-listed.
  async function vendorCheck(S, C, w, until, res) {
    if (!C.vendors_synced_at || !C.credits) return;
    if (S.meta.vendor_check?.vendors_synced_at === C.vendors_synced_at) return;   // this snapshot is checked
    if (Date.parse(C.vendors_synced_at) < (S.meta.read.payments.started_ms || 0)) return;   // older than the payments
    const offsets = () => {
      const unused = {};
      for (const p of Object.values(S.payments)) {
        if (['draft', 'void'].includes(norm(p.status))) continue;
        unused[p.vendor_id] = (unused[p.vendor_id] || 0) + num(p.bcy_balance ?? p.balance);
      }
      const off = {};
      for (const [id, v] of C.vendors) off[id] = r2(v.unused - (unused[id] || 0) - (C.credits[id] || 0));
      return off;
    };
    let off = offsets();
    const prev = S.meta.vendor_off;
    const flagged = prev ? Object.keys(off).filter(id => prev[id] != null && Math.abs(off[id] - prev[id]) > 1) : [];
    let relisted = 0;
    for (const vid of flagged) {
      if (relisted >= RELIST_CAP || Date.now() >= until || res.stopped) break;
      setLive({ phase: 'repair', list: 'payments', label: 'Vendor payments', vendor: C.vendors.get(vid)?.contact_name || vid });
      await relist(S, 'payments', { vendor_id: vid, date_start: w.from, date_end: w.to },
        r => r.vendor_id === vid && inRange(r.date, w.from, w.to), res);
      relisted++;
    }
    if (relisted) off = offsets();
    for (const vid of flagged.slice(relisted)) off[vid] = prev[vid];   // not re-listed yet: flagged again next run
    S.meta.vendor_off = off;
    S.meta.vendor_check = {
      at: isoNow(), vendors_synced_at: C.vendors_synced_at, first: !prev, flagged: flagged.length, relisted,
      vendors: flagged.slice(0, 20).map(id => C.vendors.get(id)?.contact_name || id),
    };
  }

  // ── 2d. Payments whose bill was uploaded on the report ──
  // When Accounts books the uploaded bill and adjusts the advance against it, Zoho nearly always marks
  // the payment as changed (the feed picks it up) — not every time. So the vendor of an uploaded-bill
  // payment still open is re-listed when one of its current-FY bills changed after the vendor was last
  // re-listed (booking the bill and adjusting the advance both change the bill), and at least once a day.
  async function uploadCheck(S, C, w, until, res) {
    const items = (await notesNow()).items;
    const last = S.meta.upload_check || {};
    const open = new Map();   // vendor → its open payments with an uploaded bill
    for (const [id, n] of Object.entries(items)) {
      const p = S.payments[id];
      if (!p || !n.bills?.length || num(p.bcy_balance ?? p.balance) <= EPS) continue;
      open.set(p.vendor_id, (open.get(p.vendor_id) || 0) + 1);
    }
    const billAt = {};        // vendor → newest change to one of its bills (Zoho time)
    for (const b of C.bills) {
      if (!open.has(b.vendor_id)) continue;
      const t = tsMs(b.last_modified_time);
      if (t > (billAt[b.vendor_id] || 0)) billAt[b.vendor_id] = t;
    }
    const checked = {};
    for (const vid of open.keys()) if (last.vendor_at?.[vid]) checked[vid] = last.vendor_at[vid];
    const due = [...open.keys()].filter(vid => !syncEngine.isFresh(checked[vid], UPLOAD_RECHECK_H) ||
      (billAt[vid] || 0) > Date.parse(checked[vid]) - OVERLAP_MS);
    let relisted = 0;
    for (const vid of due) {
      if (relisted >= RELIST_CAP || Date.now() >= until || res.stopped) break;
      setLive({ phase: 'repair', list: 'payments', label: 'Vendor payments', vendor: C.vendors.get(vid)?.contact_name || vid });
      await relist(S, 'payments', { vendor_id: vid, date_start: w.from, date_end: w.to },
        r => r.vendor_id === vid && inRange(r.date, w.from, w.to), res);
      checked[vid] = isoNow();
      relisted++;
    }
    S.meta.upload_check = {
      at: isoNow(), open_payments: [...open.values()].reduce((s, n) => s + n, 0),
      vendors: open.size, due: due.length, relisted, vendor_at: checked,
    };
  }

  // ── Central data (bills of the current FY, vendors, vendor credits) ──
  async function central(reuse) {
    if (reuse && centralMem && Date.now() - centralMem.at < 5 * 60000) return centralMem.data;
    const rd = k => syncEngine.readSyncedData(k).catch(() => null);
    const [billFy, billOpen, billOver, vend, cred] = await Promise.all(
      ['bills_fy', 'bills_open', 'bills_overdue', 'vendors_all', 'vendor_credits_all'].map(rd));
    const missing = Object.entries({ bills_fy: billFy, vendors_all: vend }).filter(([, s]) => !s).map(([k]) => k);
    if (missing.length) throw new Error(`Synced data missing: ${missing.join(', ')}`);
    const all = s => (s ? [...(s.data || []), ...(s.future || [])] : []);
    const vendors = new Map();
    for (const v of all(vend)) {
      vendors.set(v.contact_id, { contact_name: v.contact_name || '', cf_vendor_category: clean(v.cf_vendor_category), unused: num(v.unused_credits_payable_amount) });
    }
    let credits = null;
    if (cred) {
      credits = {};
      for (const c of all(cred)) if (!['void', 'draft'].includes(norm(c.status))) credits[c.vendor_id] = (credits[c.vendor_id] || 0) + num(c.balance);
    }
    const data = {
      bills: [...all(billOpen), ...all(billOver), ...all(billFy)].map(b => pick(b, BILL_FIELDS)),
      vendors, credits, vendors_synced_at: vend.synced_at || null,
    };
    centralMem = { at: Date.now(), data };
    return data;
  }
  // Central records changed since the rows were last built: current-FY bills (last_modified_time) and
  // Vendor Category (compared with the previous build)
  function centralChanges(S, C, res) {
    const since = (S.meta.seen_bills || 0) - OVERLAP_MS;
    let max = S.meta.seen_bills || 0;
    for (const b of C.bills) {
      const t = tsMs(b.last_modified_time);
      if (t > since) res.ch.billKeys.add(`${b.vendor_id}|${norm(b.bill_number)}`);
      if (t > max) max = t;
    }
    S.meta.seen_bills = max;
    const cats = {};
    const prev = S.meta.vendor_cat || {};
    for (const [id, v] of C.vendors) {
      cats[id] = v.cf_vendor_category;
      if (prev[id] !== undefined && prev[id] !== v.cf_vendor_category) res.ch.vendors.add(id);
    }
    S.meta.vendor_cat = cats;
  }
  function lookups(S, C) {
    const billIndex = new Map();
    const add = b => {
      if (!b?.bill_id || norm(b.status) === 'void') return;
      billIndex.set(`${b.vendor_id}|${norm(b.bill_number)}`, {
        id: b.bill_id, date: b.date || '', cat: clean(b.cf_category), vcat: clean(b.cf_vendor_category),
        lmt: b.last_modified_time || '', ref: clean(b.reference_number),
      });
    };
    for (const b of Object.values(S.bills)) add(b);
    for (const b of C.bills) add(b);
    const poById = new Map(), poByVendorNo = new Map();
    for (const po of Object.values(S.pos)) {
      poById.set(po.purchaseorder_id, po);
      if (!po.purchaseorder_number) continue;
      const key = `${po.vendor_id}|${norm(po.purchaseorder_number)}`;
      const had = poById.get(poByVendorNo.get(key));
      if (!had || norm(had.status) === 'cancelled') poByVendorNo.set(key, po.purchaseorder_id);
    }
    return { billIndex, poById, poByVendorNo, vendorById: C.vendors, src: S.det };
  }
  const orderedPayments = S => Object.values(S.payments).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // ── 3. Details ──
  // Detail records the rows need — newest payments first — and the details still referred to
  function detailQueue(S, L, ordered) {
    const det = S.det;
    const queue = [], queued = new Set();
    const ref = { po: new Set(), bill: new Set(), pay: new Set() };
    const add = (type, id, l) => { const k = `${type}:${id}`; if (!queued.has(k)) { queued.add(k); queue.push({ type, id, l }); } };
    const needPo = id => {
      ref.po.add(id);
      const po = L.poById.get(id);
      if (po && det.po_detail[id]?.l !== (po.last_modified_time || '')) add('po', id, po.last_modified_time || '');
    };
    const needBill = b => { ref.bill.add(b.id); if (det.bill_detail[b.id]?.l !== b.lmt) add('bill', b.id, b.lmt); };
    for (const p of ordered) {
      if (['draft', 'void'].includes(norm(p.status))) continue;
      const tag = clean(p.cf_purchase_order_no_unformatted);
      const nos = splitBills(p.bill_numbers);
      if (tag) needPo(tag);
      else {
        const vcat = L.vendorById.get(p.vendor_id)?.cf_vendor_category;
        for (const n of nos) {
          const b = L.billIndex.get(`${p.vendor_id}|${norm(n)}`);
          if (!b || !isProjectVendor(b.vcat, vcat)) continue;
          const viaRef = refPoOf(b, p.vendor_id, L.poByVendorNo);
          if (viaRef) {
            needPo(viaRef);
            // The bill's own Project Sub Category is used only when its PO has none
            const pd = det.po_detail[viaRef];
            if (pd && !pd.missing && !(pd.sub || []).length) needBill(b);
          } else needBill(b);    // the bill's link to its PO (and its own Sub Category): bill detail only
          const viaDetail = det.bill_detail[b.id]?.po?.[0];
          if (viaDetail) needPo(viaDetail);
        }
      }
      // Used without any bill: refunded (or applied in a way the list does not show)
      if (!nos.length && num(p.bcy_amount ?? p.amount) - num(p.bcy_balance ?? p.balance) > EPS) {
        ref.pay.add(p.payment_id);
        if (det.pay_detail[p.payment_id]?.l !== (p.last_modified_time || '')) add('pay', p.payment_id, p.last_modified_time || '');
      }
    }
    return { queue, ref };
  }
  const pendingOf = queue => {
    const p = { po: 0, bill: 0, pay: 0 };
    for (const it of queue) p[it.type]++;
    return { po_details: p.po, bill_details: p.bill, payment_details: p.pay, total: queue.length };
  };
  function prune(S, ref, res) {
    for (const [map, keep] of [[S.det.po_detail, ref.po], [S.det.bill_detail, ref.bill], [S.det.pay_detail, ref.pay]]) {
      for (const id of Object.keys(map)) if (!keep.has(id)) { delete map[id]; res.dirty.add('details'); }
    }
  }
  async function fetchDetails(S, queue, until, res, yieldFn, skip) {
    const det = S.det;
    let sinceSave = 0;
    for (const it of queue) {
      if (Date.now() >= until || res.stopped || (yieldFn && yieldFn())) break;
      if (skip?.has(`${it.type}:${it.id}`)) continue;
      setLive({ phase: 'details', done: res.detail_calls, total: queue.length });
      try {
        if (it.type === 'po') {
          const po = (await get('detail', `/purchaseorders/${it.id}`, undefined, res)).purchaseorder || {};
          det.po_detail[it.id] = { l: it.l, sub: multiValues(po, 'cf_sub_category') };
          res.ch.pos.add(it.id);
        } else if (it.type === 'bill') {
          const b = (await get('detail', `/bills/${it.id}`, undefined, res)).bill || {};
          det.bill_detail[it.id] = {
            l: it.l, sub: multiValues(b, 'cf_sub_category'), cat: fieldText(b, 'cf_category'),
            po: (b.purchaseorder_ids || []).map(String).filter(Boolean),
          };
          res.ch.billIds.add(it.id);
        } else {
          const vp = (await get('detail', `/vendorpayments/${it.id}`, undefined, res)).vendorpayment || {};
          const rate = num(vp.exchange_rate) || 1;
          det.pay_detail[it.id] = {
            l: it.l,
            refunded: r2((vp.vendorpayment_refunds || []).reduce((s, r) => s + (r.amount_bcy != null ? num(r.amount_bcy) : num(r.amount) * rate), 0)),
            bills: (vp.bills || []).map(b => ({ n: clean(b.bill_number), d: b.date || '' })).filter(b => b.n),
          };
          res.ch.pay.add(it.id);
        }
      } catch (e) {
        if (e.response?.status === 404) {
          if (it.type === 'po') { det.po_detail[it.id] = { l: it.l, sub: [], missing: true }; res.ch.pos.add(it.id); }
          else if (it.type === 'bill') { det.bill_detail[it.id] = { l: it.l, sub: [], cat: '', po: [], missing: true }; res.ch.billIds.add(it.id); }
          else { det.pay_detail[it.id] = { l: it.l, refunded: 0, bills: [], missing: true }; res.ch.pay.add(it.id); }
        } else if (isFatal(e)) { res.stopped = zohoMessage(e); res.stoppedIn = 'details'; break; }
        else { res.failed++; skip?.add(`${it.type}:${it.id}`); continue; }
      }
      res.detail_calls++;
      res.dirty.add('details');
      if (++sinceSave >= 50) { sinceSave = 0; await save(S, ['details']); res.dirty.delete('details'); }
    }
  }

  // ── 4. Rows ──
  // The payments a set of changes touches
  function affected(S, L, ch) {
    const out = new Set();
    for (const id of ch.pay) if (S.payments[id]) out.add(id);
    if (!ch.billKeys.size && !ch.pos.size && !ch.vendors.size && !ch.billIds.size) return out;
    for (const p of Object.values(S.payments)) {
      const id = p.payment_id;
      if (out.has(id)) continue;
      if (ch.vendors.has(p.vendor_id)) { out.add(id); continue; }
      const tag = clean(p.cf_purchase_order_no_unformatted);
      if (tag && ch.pos.has(tag)) { out.add(id); continue; }
      const nos = splitBills(p.bill_numbers);
      const list = nos.length ? nos : (S.det.pay_detail[id]?.bills || []).map(b => b.n);
      for (const n of list) {
        const key = `${p.vendor_id}|${norm(n)}`;
        if (ch.billKeys.has(key)) { out.add(id); break; }
        const b = L.billIndex.get(key);
        if (!b) continue;
        if (ch.billIds.has(b.id)) { out.add(id); break; }
        if (!tag && ch.pos.size) { const po = billPoOf(b, p.vendor_id, L); if (po && ch.pos.has(po)) { out.add(id); break; } }
      }
    }
    return out;
  }
  // Re-calculates the rows a change touched (all rows when `full`) and saves them if anything moved
  async function publish(S, L, res, full) {
    const prev = full ? null : await readRows();
    const ordered = orderedPayments(S);
    const aff = prev ? affected(S, L, res.ch) : null;
    let rows, n;
    if (!prev || aff.size > ordered.length * 0.3) {
      rows = buildRows({ payments: ordered, ...L });
      n = ordered.length;
      S.meta.last_full_build_at = isoNow();
    } else if (!aff.size && !res.ch.payGone.size) {
      rows = prev.rows;
      n = 0;
    } else {
      const drop = new Set([...aff, ...res.ch.payGone]);
      const fresh = buildRows({ payments: ordered.filter(p => aff.has(p.payment_id)), ...L });
      rows = prev.rows.filter(r => !drop.has(r.id)).concat(fresh).sort(rowOrder);
      n = aff.size + res.ch.payGone.size;
    }
    res.recalculated += n;
    res.ch = newChanges();
    const m = S.meta;
    const doc = {
      v: VERSION, built_at: isoNow(), window_from: m.window.from, window_to: m.window.to,
      complete_from: m.ready.bills ? m.window.from : m.window.fyStart,   // earlier rows wait for last year's bills
      pending: m.pending || {}, rows,
    };
    if (n || !prev || JSON.stringify(prev.pending) !== JSON.stringify(doc.pending) || prev.complete_from !== doc.complete_from) await writeRows(doc);
    return rows.length;
  }

  const newChanges = () => ({ pay: new Set(), payGone: new Set(), pos: new Set(), billKeys: new Set(), billIds: new Set(), vendors: new Set() });
  const newResult = ctx => ({
    ctx, calls: { list: 0, feed: 0, count: 0, relist: 0, detail: 0 },
    stats: Object.fromEntries(ORDER.map(k => [k, { added: 0, updated: 0, removed: 0, unchanged: 0 }])),
    feed: {}, ch: newChanges(), dirty: new Set(), full: false, recalculated: 0, detail_calls: 0, failed: 0,
    pages: 0, stopped: '', stoppedIn: '',
  });

  // ── One job: an engine run, or (background) a slice of a first-build backlog ──
  async function step({ mode = 'normal', trigger = '', isInitial = false, ctx = null, runMs, detailMs, background = false, skip = null }) {
    const t0 = Date.now();
    const until = t0 + runMs;
    const res = newResult(ctx);
    const w = windowNow();
    const S = await loadState();
    const C = await central(background);
    let strategy = background ? 'background' : 'incremental';
    if (!S.meta) { S.meta = newMeta(w); strategy = 'first build'; }
    else if (S.meta.window.from !== w.from) { rollWindow(S, w, res); strategy = 'new financial year'; }
    // Full Sync Data (not the first build): every list is read again, page by page; the current copy
    // stays in use and is reconciled with each list as its read completes
    if (!background && !isInitial && (mode === 'full' || mode === 'full_refresh') && ORDER.every(k => S.meta.read[k].done)) {
      for (const k of ORDER) S.meta.read[k] = newRead(k, w, 'full sync');
      strategy = 'full sync';
    }
    const yieldFn = background ? () => syncEngine.getProgress().running : null;
    setLive({ phase: 'starting', mode, trigger, background, started_at: new Date(t0).toISOString() });
    let error = null;
    let rowCount = 0;
    try {
      try {
        // 1. List reads still to do — page by page, each saved
        for (const kind of ORDER) {
          if (S.meta.read[kind].done) continue;
          if (strategy === 'incremental' || strategy === 'background') strategy = `${S.meta.read[kind].reason} (continued)`;
          if (!(await readList(S, kind, until, res, yieldFn))) break;
        }
        // 2. What changed in Zoho since the last run (sync runs only, once every list is complete)
        if (!background && !res.stopped && ORDER.every(k => S.meta.read[k].done)) {
          setLive({ phase: 'checking' });
          for (const kind of ORDER) res.feed[kind] = await feed(S, kind, w, res);
          await controlTotals(S, w, until, res, mode === 'recheck' || mode === 'full_refresh');
          await vendorCheck(S, C, w, until, res);
          await uploadCheck(S, C, w, until, res);
        }
      } catch (e) {
        if (isFatal(e)) { res.stopped = zohoMessage(e); res.stoppedIn = 'lists'; }
        else error = e;
      }

      // 3. Rows (once payments and purchase orders are complete), then details
      centralChanges(S, C, res);
      if (S.meta.ready.payments && S.meta.ready.pos) {
        const L = lookups(S, C);
        const ordered = orderedPayments(S);
        const full = res.full || ['recheck', 'full', 'full_refresh'].includes(mode) ||
          !S.meta.last_full_build_at || !syncEngine.isFresh(S.meta.last_full_build_at, FULL_BUILD_H);
        let { queue, ref } = detailQueue(S, L, ordered);
        prune(S, ref, res);
        S.meta.pending = pendingOf(queue);
        rowCount = await publish(S, L, res, full);
        if (!error && !res.stopped && queue.length && detailMs > 0) {
          await fetchDetails(S, queue, Math.min(until, Date.now() + detailMs), res, yieldFn, skip);
          ({ queue } = detailQueue(S, L, ordered));   // what is left (and bills whose PO turned out to have no Sub Category)
          S.meta.pending = pendingOf(queue);
          rowCount = await publish(S, L, res, false);
        }
      }
    } finally {
      const total = Object.values(res.calls).reduce((s, n) => s + n, 0);
      const summary = {
        at: isoNow(), mode, trigger, strategy, ms: Date.now() - t0, zoho_calls: total, calls: res.calls,
        changes: res.stats, feed: res.feed, recalculated_rows: res.recalculated, detail_calls: res.detail_calls,
        failed: res.failed, stopped: res.stopped || null, error: error ? zohoMessage(error) : null,
      };
      if (background) S.meta.last_background = summary;
      else S.meta.last_check = summary;
      await save(S, [...res.dirty]).catch(e => { if (!error) error = e; });
      live = null;
    }
    if (error) throw error;
    if (res.stopped && res.stoppedIn === 'lists' && !background) {
      throw new Error(`Zoho limit reached — progress saved, the report continues on the next run: ${res.stopped}`);
    }

    const sum = f => ORDER.reduce((s, k) => s + res.stats[k][f], 0);
    const lists = ORDER.every(k => S.meta.read[k].done);
    return {
      more: !lists || (S.meta.pending?.total || 0) > 0,
      progress: res.pages + res.detail_calls,
      stopped: res.stopped,
      engine: {
        record_count: rowCount,
        strategy,
        stats: { checked: sum('added') + sum('updated') + sum('unchanged'), added: sum('added'), updated: sum('updated'),
          removed: sum('removed'), unchanged: sum('unchanged'), failed: res.failed },
        extra: {
          zoho_calls: S.meta.last_check?.zoho_calls, calls: res.calls, changes: res.stats,
          lists: Object.fromEntries(ORDER.map(k => [k, { done: S.meta.read[k].done, records: S.meta.counts?.[k] }])),
          control: (S.meta.control?.checks || []).map(c => ({ list: c.list, zoho: c.zoho, local: c.local, repaired: c.repaired.length })),
          vendor_check: S.meta.vendor_check && { flagged: S.meta.vendor_check.flagged, relisted: S.meta.vendor_check.relisted },
          upload_check: S.meta.upload_check && { open_payments: S.meta.upload_check.open_payments, relisted: S.meta.upload_check.relisted },
          recalculated_rows: res.recalculated, detail_calls: res.detail_calls, pending: S.meta.pending,
          stopped: res.stopped || null,
        },
      },
    };
  }

  // Office PC: what is left of a backlog (list pages, details) continues in the background, one slice
  // at a time, each starting only while no central sync runs and giving way as soon as one starts
  function kick() {
    if (isVercel || worker) return;
    const skip = new Set();   // details that failed (not a Zoho limit) are retried by a later sync run
    worker = (async () => {
      workerError = null;
      for (;;) {
        while (syncEngine.getProgress().running) await sleep(5000);
        const r = await serial(() => step({ background: true, runMs: CHUNK_MS, detailMs: CHUNK_MS, skip }));
        if (r.stopped) { workerError = { at: isoNow(), message: r.stopped }; break; }
        if (!r.more || !r.progress) break;
        await sleep(1000);
      }
    })().catch(e => {
      workerError = { at: isoNow(), message: zohoMessage(e) };
      console.error('[vendor-payment-report] background:', zohoMessage(e));
    }).finally(() => { worker = null; });
  }

  // The sync engine's entry point
  async function run({ mode = 'normal', trigger = '', isInitial = false, ctx = null } = {}) {
    const r = await serial(() => step({ mode, trigger, isInitial, ctx, runMs: RUN_MS, detailMs: DETAIL_MS }));
    if (r.more) setTimeout(kick, kickDelayMs);   // continues once this sync run has finished
    return r.engine;
  }

  // After a restart: continue a backlog the previous process left
  async function resume() {
    if (isVercel) return;
    const meta = await readKey(KEYS.meta).catch(() => null);
    if (!meta || meta.v !== VERSION) return;   // never built: the first sync run starts it
    if (!ORDER.every(k => meta.read?.[k]?.done) || (meta.pending?.total || 0) > 0) kick();
  }

  // The report's Refresh button: a sync run of this report (current-FY bills come along so that new
  // bills are classified too). Returns at once; the page polls status().
  async function refresh() {
    const meta = await readKey(KEYS.meta).catch(() => null);
    const built = meta && meta.v === VERSION && ORDER.every(k => meta.read?.[k]?.done);
    if (meta && meta.v === VERSION && !built && (worker || live)) return { status: 'building' };
    const r = syncEngine.startRun({ mode: 'normal', trigger: 'report', entities: built ? ['bills_fy', 'vendor_payment_report'] : ['vendor_payment_report'] });
    return { status: r.status === 'busy' ? 'busy' : 'started', run_id: r.run_id };
  }

  // What the report page shows about the sync
  async function status() {
    const meta = await readKey(KEYS.meta).catch(() => null);
    const ok = meta && meta.v === VERSION;
    const prog = syncEngine.getProgress();
    const eng = prog.running ? prog.progress?.entities?.vendor_payment_report : null;
    const list = k => {
      const R = meta.read[k];
      return {
        label: LISTS[k].label, ready: !!meta.ready[k], done: !!R.done, reason: R.reason,
        pages: R.pages, pages_total: R.pages_total, records: R.records, total: R.total, reached: R.cursor,
        started_at: R.started_at, completed_at: R.completed_at, count: meta.counts?.[k] ?? null,
      };
    };
    return {
      state: !ok ? 'not_started' : meta.ready.payments && meta.ready.pos ? 'ready' : 'building',
      running: !!live || !!worker || eng?.state === 'running',
      queued: eng?.state === 'pending',          // in a sync run that has not reached this report yet
      sync_running: !!prog.running,
      background: !!worker,
      activity: live,
      lists: ok ? Object.fromEntries(ORDER.map(k => [k, list(k)])) : null,
      pending: ok ? meta.pending : null,
      last_check: ok ? meta.last_check : null,
      last_background: ok ? meta.last_background || null : null,
      control: ok ? meta.control : null,
      vendor_check: ok ? meta.vendor_check : null,
      window: ok ? meta.window : null,
      error: workerError,
    };
  }

  // Resolves when the background backlog has stopped (tests)
  const whenIdle = () => worker || Promise.resolve();

  // ── 5. Bill uploads and remarks ──
  // One note per payment: { bills: [{ id, name, size, type, by: {id, name}, at }], purchase_remark,
  // accounts_remark: { text, by, at } | null, history: [{ at, by, by_id, action, detail }] }
  const NOTES_FILE = path.join(__dirname, `${NOTES_KEY}.json`);
  let notesMem = null;                  // office PC: this process is the only writer
  let noteJobs = Promise.resolve();     // edits are applied one at a time
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const noteView = n => ({ bills: n.bills, purchase_remark: n.purchase_remark, accounts_remark: n.accounts_remark });
  const who = u => ({ id: String(u.id), name: u.name });
  const stamp = (n, u, action, detail) => n.history.push({ at: isoNow(), by: u.name, by_id: String(u.id), action, detail });

  async function notesNow() {
    if (notesMem && !isVercel) return notesMem;   // Vercel: another instance may have written
    const d = await db.readJSON(NOTES_KEY, NOTES_FILE, null);
    notesMem = d && d.v === NOTES_V && d.items ? d : { v: NOTES_V, items: {} };
    return notesMem;
  }
  // Applies fn to one payment's note and saves it; resolves to the note as the page shows it
  function editNote(paymentId, fn) {
    const job = noteJobs.then(async () => {
      if (isVercel) notesMem = null;
      const d = JSON.parse(JSON.stringify(await notesNow()));
      const n = d.items[paymentId] || { bills: [], purchase_remark: null, accounts_remark: null, history: [] };
      fn(n);
      n.history = n.history.slice(-HISTORY_MAX);
      d.items[paymentId] = n;
      d.updated_at = isoNow();
      await db.writeJSON(NOTES_KEY, NOTES_FILE, d);
      notesMem = d;
      return noteView(n);
    });
    noteJobs = job.catch(() => {});
    return job;
  }

  async function hasPayment(id) {
    return !!(await current())?.rows.some(r => r.id === id);
  }
  // u: { id, name, admin, purchase, accounts } — rights checked by the caller (upload, remarks)
  function addBill(paymentId, file, u) {
    return editNote(paymentId, n => {
      n.bills.push({ id: file.id, name: file.name, size: file.size, type: file.type, by: who(u), at: isoNow() });
      stamp(n, u, 'bill uploaded', file.name);
    });
  }
  // The person who uploaded a bill (still in the purchase team) or an admin can remove it. The file
  // itself is kept on disk / in Blob storage; only the attachment is removed from the payment.
  function removeBill(paymentId, fileId, u) {
    return editNote(paymentId, n => {
      const f = n.bills.find(b => b.id === fileId);
      if (!f) throw httpError(404, 'This bill is no longer attached to the payment');
      if (!u.admin && !(u.purchase && f.by?.id === String(u.id))) throw httpError(403, 'Only the person who uploaded this bill, or an admin, can remove it');
      n.bills = n.bills.filter(b => b !== f);
      stamp(n, u, 'bill removed', f.name);
    });
  }
  // team: 'purchase' | 'accounts'; empty text clears the remark
  function setRemark(paymentId, team, text, u) {
    const t = String(text ?? '').replace(/\r\n/g, '\n').trim().slice(0, REMARK_MAX);
    return editNote(paymentId, n => {
      const key = `${team}_remark`;
      if ((n[key]?.text || '') === t) return;
      n[key] = t ? { text: t, by: who(u), at: isoNow() } : null;
      stamp(n, u, t ? `${team} remark` : `${team} remark cleared`, t.slice(0, 200));
    });
  }
  async function billFile(paymentId, fileId) {
    return (await notesNow()).items[paymentId]?.bills.find(b => b.id === fileId) || null;
  }
  // The notes of these rows, for the page
  async function notesOf(rows) {
    const items = (await notesNow()).items;
    const out = {};
    for (const r of rows) {
      const n = items[r.id];
      if (n && (n.bills.length || n.purchase_remark || n.accounts_remark)) out[r.id] = noteView(n);
    }
    return out;
  }

  return {
    run, current, refresh, status, resume, whenIdle,
    hasPayment, addBill, removeBill, setRemark, billFile, notesOf,
  };
}

module.exports = { create, classify, buildRows, multiValues, monthsOf, pieces, BILL_TYPES };
