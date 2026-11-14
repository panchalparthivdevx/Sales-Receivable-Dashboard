/**
 * Financial Reporting — data from the rest of the dashboard, for the budget, forecasts and branch master.
 *
 * Nothing here calls Zoho directly: it reads the caches the dashboard already keeps (central sync: invoices, customer
 * payments, bills, vendor payments; Branch P&L: Zoho account transactions per account per financial year; the Rent
 * Recurring Module workbook; client agreements; Loan module). server/index.js hands the readers in through init().
 * Amounts from Zoho are in rupees; GST-exclusive invoice amounts come from the dashboard's sub-total cache.
 */

'use strict';

const XLSX = require('xlsx');

let ops = {};
function setOps(o) { ops = { ...ops, ...o }; }
const need = name => { if (!ops[name]) throw Object.assign(new Error(`The dashboard does not provide "${name}" to this module (restart the server).`), { status: 503 }); return ops[name]; };

const pad = n => String(n).padStart(2, '0');
const monthOf = d => (d ? String(d).slice(0, 7) : null);
function addMonths(m, k) { let [y, mo] = m.split('-').map(Number); mo += k; while (mo > 12) { mo -= 12; y++; } while (mo < 1) { mo += 12; y--; } return `${y}-${pad(mo)}`; }
function monthsBetween(a, b) { const out = []; if (!a || !b || a > b) return out; for (let m = a; m <= b && out.length < 240; m = addMonths(m, 1)) out.push(m); return out; }
const daysInMonth = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const fyOfMonth = m => { const [y, mo] = m.split('-').map(Number); const fy = mo >= 4 ? y + 1 : y; return `${fy - 1}-${String(fy).slice(2)}`; };
const todayIso = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // India
const lastCompleteMonth = () => addMonths(todayIso().slice(0, 7), -1);
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const normName = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(private|pvt|limited|ltd|llp|the|india|co)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// ── invoices (last 12+ months) ───────────────────────────────────────────────
async function invoices() {
  const read = need('readSynced');
  const [fy, paid, unpaid] = await Promise.all(['invoices_fy', 'invoices_paid_12mo', 'invoices_unpaid'].map(e => read(e).catch(() => null)));
  const subs = ops.invoiceSubtotals ? await ops.invoiceSubtotals().catch(() => ({})) : {};
  const byId = new Map();
  for (const src of [unpaid, paid, fy]) for (const i of src?.data || []) byId.set(i.invoice_id, i);
  const out = [];
  let gstFallback = 0, selfExcluded = 0, selfAmount = 0;
  for (const i of byId.values()) {
    if (['void', 'draft'].includes(i.status)) continue;
    // invoices addressed to the company itself (inter-branch billing) are not revenue or collections
    if (/^dev accelerator\b/i.test(String(i.customer_name || '').trim())) { selfExcluded++; selfAmount += Number(subs[i.invoice_id] ?? (Number(i.total) || 0) / 1.18) || 0; continue; }
    let sub = subs[i.invoice_id];
    if (sub == null) { sub = (Number(i.total) || 0) / 1.18; gstFallback++; }
    out.push({ id: i.invoice_id, no: i.invoice_number, customerId: i.customer_id, customer: i.customer_name, branch: i.branch_name || '', date: i.date, due: i.due_date, status: i.status,
      category: (i.cf_invoice_category || '').trim() || '(none)', sub: Number(sub) || 0, total: Number(i.total) || 0, balance: Number(i.balance) || 0, paidOn: i.last_payment_date || null, subKnown: subs[i.invoice_id] != null });
  }
  return { invoices: out, gstFallback, selfExcluded, selfAmount, syncedAt: fy?.synced_at || null };
}

// ── Zoho account transactions by P&L head (company level; ledgers carry no branch) ───────────────────────────────
async function plHeadMonthly(fromMonth, toMonth) {
  const mapping = await need('plMapping')();
  const heads = (mapping.heads || []).map(h => ({ id: h.id, label: h.label, section: h.section, income: !!h.is_income, accounts: (h.accounts || []).map(a => a.account_id).filter(Boolean) }));
  const fys = [...new Set(monthsBetween(fromMonth, toMonth).map(fyOfMonth))];
  const coverage = {};
  const byHead = {};
  for (const fy of fys) {
    let found = 0, missing = 0, oldest = null;
    for (const h of heads) {
      for (const acct of h.accounts) {
        const disk = await need('plAcctTxns')(fy, acct).catch(() => null);
        if (!disk) { missing++; continue; }
        found++;
        if (!oldest || disk.fetched_at < oldest) oldest = disk.fetched_at;
        for (const t of disk.transactions || []) {
          const m = monthOf(t.transaction_date);
          if (!m || m < fromMonth || m > toMonth) continue;
          const dr = parseFloat(t.debit_amount || 0) || 0, cr = parseFloat(t.credit_amount || 0) || 0;
          const v = h.income ? cr - dr : dr - cr;
          ((byHead[h.id] = byHead[h.id] || {})[m] = (byHead[h.id][m] || 0) + v);
        }
      }
    }
    coverage[fy] = { accountsFound: found, accountsMissing: missing, fetchedAt: oldest };
  }
  return { heads: heads.map(({ accounts, ...h }) => ({ ...h, accounts: accounts.length })), byHead, coverage };
}

// ── Rent Recurring Module workbook (every column, read by header name) ─────────────────────────────────────────
const RENT_HEAD = { profile: 'profilename', office: 'officeno', vendor: 'vendorname', branch: 'branch', terms: 'paymentterms', category: 'vendorcategory', agrStart: 'agreementstartfrom', agrEnd: 'agreementendson',
  modStart: 'modulestartson', modEnd: 'moduleendson', incOn: 'incrementon', incPct: 'increment', account: 'account', amount: 'amount', tdsPct: 'tds', carpet: 'carpet', sba: 'superbuildeuparea', sba2: 'superbuildup area', deposit: 'securitydeposit' };
function excelDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return new Date(v.getTime() + 12 * 3600e3).toISOString().slice(0, 10);
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : null; }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/); if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return `${y}-${pad(m[2])}-${pad(m[1])}`; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
const num = v => { if (typeof v === 'number') return v; const n = parseFloat(String(v || '').replace(/[,%\s]/g, '')); return Number.isFinite(n) ? n : null; };
async function rentWorkbook() {
  const got = ops.rentWorkbook ? await ops.rentWorkbook() : null;
  if (!got?.wb) return { file: null, lines: [] };
  const ws = got.wb.Sheets.Sheet1 || got.wb.Sheets[got.wb.SheetNames.find(n => got.wb.Sheets[n]['!ref'])];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const head = (rows[0] || []).map(norm);
  const col = k => { const h = RENT_HEAD[k]; const i = head.indexOf(h); if (i >= 0) return i; if (k === 'sba') return head.findIndex(x => /superbuil/.test(x)); if (k === 'tdsPct') return head.findIndex(x => /^tds/.test(x) && x !== 'tdssection'); if (k === 'incPct') return head.findIndex(x => /^increment(%|pct|percent)?$/.test(x) && x !== 'incrementon'); return -1; };
  const c = Object.fromEntries(Object.keys(RENT_HEAD).map(k => [k, col(k)]));
  c.incPct = head.findIndex((x, i) => /^increment/.test(x) && i !== c.incOn);
  c.tdsPct = head.findIndex(x => x === 'tds');
  const lines = [];
  for (let r = 1; r < rows.length; r++) {
    const x = rows[r];
    if (!x || !x[c.vendor] || !x[c.branch]) continue;
    const amount = num(x[c.amount]);
    if (!amount) continue;
    const pct = num(x[c.incPct]);
    lines.push({ row: r + 1, branch: String(x[c.branch]).trim(), vendor: String(x[c.vendor]).trim(), office: x[c.office] == null ? '' : String(x[c.office]).trim(), category: String(x[c.category] || '').trim(),
      terms: num(x[c.terms]), agrStart: excelDate(x[c.agrStart]), agrEnd: excelDate(x[c.agrEnd]), modStart: excelDate(x[c.modStart]), modEnd: excelDate(x[c.modEnd]), incOn: excelDate(x[c.incOn]),
      incPct: pct == null ? null : (pct > 1 ? pct / 100 : pct), amount, tdsPct: num(x[c.tdsPct]), carpet: num(x[c.carpet]), sba: c.sba >= 0 ? num(x[c.sba]) : null, deposit: num(x[c.deposit]) });
  }
  return { file: got.file, lines };
}

/** Rent bills in Zoho (sub-total before GST) by branch and month, with their landlord — to find branches the workbook misses */
async function rentBills() {
  const details = ops.rentBillDetails ? await ops.rentBillDetails().catch(() => ({})) : {};
  const bills = (await need('readSynced')('bills_fy').catch(() => null))?.data || [];
  const byId = new Map(bills.map(b => [b.bill_id, b]));
  const out = [];
  for (const [id, d] of Object.entries(details || {})) {
    if (!/office rent|rent expense/i.test(d.account_name || '')) continue;
    const b = byId.get(id);
    if (!b) continue;
    out.push({ id, branch: b.branch_name || '', vendor: b.vendor_name, vendorId: b.vendor_id, month: monthOf(b.date), date: b.date, sub: Number(d.sub_total) || 0, total: Number(b.total) || 0, tds: Number(b.tds_total) || 0 });
  }
  return out;
}

module.exports = { setOps, ops: () => ops, invoices, plHeadMonthly, rentWorkbook, rentBills, monthOf, addMonths, monthsBetween, daysInMonth, fyOfMonth, todayIso, lastCompleteMonth, days, median, normName, excelDate, num };
