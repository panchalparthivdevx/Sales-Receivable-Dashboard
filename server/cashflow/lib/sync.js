/**
 * Management Cash Flow — reading Zoho Books (read-only).
 *
 * The bill, payment and vendor LISTS come from the dashboard's central sync (no Zoho call here): bills_fy (+ its future
 * bills), bills_open and bills_overdue (older unpaid bills), vendor_payments_fy, vendors_all, invoices_fy (customer names).
 * Only bills that may belong to a category are read in detail (one GET /bills/{id} each, paced), and a detail is read again
 * only when the bill changed in Zoho (last modified time, balance, status or total). Details are kept per month of the bill
 * (bd_<company>_<YYYY-MM>) with an index (bdi_<company>); the chart of accounts is kept for a day (coa_<company>).
 *
 * A refresh runs in steps of a few minutes (online, Vercel ends a request after 300 s) and resumes where it stopped.
 */

'use strict';

const store = require('./store');
const CL = require('./classify');
const M = require('./months');

const COA_TTL_MS = 24 * 3600e3;
const LEASE_MS = 6 * 60e3;

function create({ zr, readSynced, cfgNow, log = console }) {
  const readList = async (company, entity) => { try { return await readSynced(company, entity); } catch (e) { log.error?.(`[cashflow] ${company} ${entity}: ${e.message}`); return null; } };

  /** Chart of accounts (all, active and inactive — old bills use accounts closed since), kept for a day */
  async function coa(co, { force = false, paceMs } = {}) {
    const key = `coa_${co.id}`;
    const hit = await store.read(key, null);
    if (hit && !force && Date.now() - Date.parse(hit.at) < COA_TTL_MS) return hit;
    try {
      const r = await zr.list(co.org_id, '/chartofaccounts', 'chartofaccounts', { filter_by: 'AccountType.All', sort_column: 'account_name', per_page: 200 }, { paceMs, maxPages: 60 });
      const seen = new Set();
      const rows = [];
      for (const a of r.rows) {
        if (seen.has(a.account_id)) continue;
        seen.add(a.account_id);
        rows.push({ id: String(a.account_id), name: a.account_name || '', parent: a.parent_account_name || '', type: a.account_type || '', active: a.is_active !== false });
      }
      const doc = { at: new Date().toISOString(), rows, complete: r.complete };
      await store.write(key, doc);
      return doc;
    } catch (e) {
      if (hit) return hit;
      throw e;
    }
  }

  /** The synced lists of a company: bills (current FY + future + older unpaid), payments, vendors, customers.
   *  Kept in memory for a minute: the lists are large (vendors ≈ 15 MB) and a page asks for them several times. */
  const listMemo = new Map();
  async function lists(company, { fresh = false } = {}) {
    const hit = listMemo.get(company);
    if (!fresh && hit && Date.now() - hit.at < 60000) return hit.data;
    const data = await readLists(company);
    listMemo.set(company, { at: Date.now(), data });
    return data;
  }
  async function readLists(company) {
    const fy = await readList(company, 'bills_fy');
    const byId = new Map();
    for (const r of [...(fy?.data || []), ...(fy?.future || [])]) byId.set(String(r.bill_id), r);
    for (const ent of ['bills_open', 'bills_overdue']) {
      const s = await readList(company, ent);
      for (const r of s?.data || []) if (!byId.has(String(r.bill_id))) byId.set(String(r.bill_id), r);
    }
    const pays = await readList(company, 'vendor_payments_fy');
    const vend = await readList(company, 'vendors_all');
    const inv = company === 'devx' ? await readList(company, 'invoices_fy') : null;
    return {
      bills: [...byId.values()], window_from: fy?.window_from || '', bills_synced_at: fy?.synced_at || '',
      payments: pays?.data || [], payments_synced_at: pays?.synced_at || '',
      vendors: vend?.data || [], customers: [...new Set((inv?.data || []).map(r => r.customer_name).filter(Boolean))],
    };
  }

  const vendorMasterMap = vendors => new Map((vendors || []).map(v => [String(v.contact_id), String(v.cf_vendor_category_formatted || v.cf_vendor_category || '')]));

  const indexDef = () => ({ sig: {}, month: {}, cats: {}, vendors: {}, months: [] });

  /** Every bill detail kept for a company → [compact bill] */
  async function loadBills(company) {
    const idx = await store.read(`bdi_${company}`, null);
    if (!idx) return [];
    const out = [];
    for (const m of idx.months || []) {
      const d = await store.read(`bd_${company}_${m}`, null);
      for (const b of Object.values(d?.bills || {})) out.push(b);
    }
    return out;
  }

  /** Take the refresh lease of a company (two refreshes never run together: office PC scheduler, button, Vercel cron) */
  async function lease(company, by) {
    return store.update(`status_${company}`, {}, st => {
      if (st.running_until && Date.parse(st.running_until) > Date.now()) return { out: false, doc: st };
      st.running_until = new Date(Date.now() + LEASE_MS).toISOString();
      st.running_by = by;
      st.started_at = new Date().toISOString();
      return { out: true, doc: st };
    });
  }

  /**
   * One refresh step for a company: chart of accounts (daily), the candidate bills from the synced lists, then bill details
   * until `until` (epoch ms). → status
   */
  async function step(company, { until = Date.now() + 200000, by = 'scheduler', forceCoa = false } = {}) {
    const cfg = await cfgNow();
    const co = cfg.companies.find(c => c.id === company);
    if (!co) throw Object.assign(new Error('Unknown company'), { status: 400 });
    if (!(await lease(company, by))) return { ...(await store.read(`status_${company}`, {})), busy: true };
    const paceMs = Number(cfg.settings.pace_ms) || 1200;
    const errors = [];
    let fetched = 0, candidates = 0, need = [], listed = 0, coaDoc = null, L = null;
    try {
      coaDoc = await coa(co, { force: forceCoa, paceMs });
      const accCat = CL.accountCategories(coaDoc.rows, cfg.categories);
      L = await lists(company, { fresh: true });
      listed = L.bills.length;
      const vendorMaster = new Map([...vendorMasterMap(L.vendors)].map(([k, v]) => [k, v.toLowerCase()]));
      const idx = await store.read(`bdi_${company}`, indexDef());
      const learned = new Set(Object.keys(idx.vendors || {}));
      const cand = L.bills.filter(r => CL.isCandidate(r, { categories: cfg.categories, vendorMaster, learned }));
      candidates = cand.length;
      need = cand.filter(r => idx.sig[String(r.bill_id)] !== CL.rowSig(r))
        .sort((a, b) => (a.status === 'paid') - (b.status === 'paid') || String(b.date).localeCompare(String(a.date)));
      const buckets = new Map();
      const flush = async () => {
        for (const [m, bills] of buckets) {
          await store.update(`bd_${company}_${m}`, { bills: {} }, d => { d.bills = d.bills || {}; Object.assign(d.bills, bills); });
          if (!idx.months.includes(m)) idx.months.push(m);
        }
        buckets.clear();
        idx.months.sort();
        await store.write(`bdi_${company}`, idx);
      };
      for (const row of need) {
        if (Date.now() > until - paceMs - 1500) break;
        const id = String(row.bill_id);
        try {
          const d = await zr.get(co.org_id, `/bills/${id}`, {}, { paceMs });
          if (!d?.bill) throw new Error('Zoho returned no bill');
          const b = CL.compactBill(d.bill);
          const m = M.monthOf(b.date) || 'undated';
          const old = idx.month[id];
          if (old && old !== m) await store.update(`bd_${company}_${old}`, { bills: {} }, x => { if (x.bills) delete x.bills[id]; });
          if (!buckets.has(m)) buckets.set(m, {});
          buckets.get(m)[id] = b;
          idx.sig[id] = CL.rowSig(row);
          idx.month[id] = m;
          const cats = [...new Set(CL.partsOf(b, accCat).map(p => p.category))];
          if (cats.length) { idx.cats[id] = cats; idx.vendors[b.vid] = [...new Set([...(idx.vendors[b.vid] || []), ...cats])]; } else delete idx.cats[id];
          fetched++;
          if (fetched % 25 === 0) await flush();
        } catch (e) {
          if (e.name === 'ZohoLimit') { errors.push(`Zoho daily limit reached: ${e.message}`); break; }
          errors.push(`Bill ${row.bill_number || id}: ${zr.errText ? zr.errText(e) : e.message}`);
          if (errors.length >= 8) break;
        }
      }
      // bills deleted in Zoho: inside the synced window (so they would be listed) but not listed any more
      const listedIds = new Set(L.bills.map(r => String(r.bill_id)));
      const winMonth = M.monthOf(L.window_from);
      if (winMonth && L.bills.length) {
        for (const [id, m] of Object.entries(idx.month)) {
          if (listedIds.has(id) || m < winMonth) continue;
          await store.update(`bd_${company}_${m}`, { bills: {} }, x => { if (x.bills) delete x.bills[id]; });
          delete idx.month[id]; delete idx.sig[id]; delete idx.cats[id];
        }
      }
      await flush();
    } catch (e) {
      errors.push(zr.errText ? zr.errText(e) : e.message);
    } finally {
      const done = need.length - fetched;
      await store.update(`status_${company}`, {}, st => {
        st.running_until = null;
        st.last_step_at = new Date().toISOString();
        st.last_step_by = by;
        st.listed = listed; st.candidates = candidates; st.fetched_last = fetched; st.remaining = Math.max(0, done);
        st.coa_at = coaDoc?.at || st.coa_at || null; st.coa_accounts = coaDoc?.rows?.length || st.coa_accounts || 0;
        st.lists_synced_at = L?.bills_synced_at || st.lists_synced_at || null;
        st.payments_synced_at = L?.payments_synced_at || st.payments_synced_at || null;
        if (done <= 0 && !errors.length) st.last_complete_at = st.last_step_at;
        st.errors = errors.slice(0, 8);
      });
    }
    return store.read(`status_${company}`, {});
  }

  return { coa, lists, loadBills, step, vendorMasterMap };
}

module.exports = { create };
