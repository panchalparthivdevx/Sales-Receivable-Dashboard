/**
 * Zoho look-ups for one organisation, cached in bb_zoho_<org> so the shared daily Zoho API limit
 * is spent once: chart of accounts, taxes, branches, projects and own GSTINs (12 h), each vendor's
 * recent bill list (6 h, or the central sync's bills_fy when it covers the window) and bill details
 * (kept until Zoho's last-modified time changes).
 */

'use strict';

const H = 3600 * 1000;

function create({ store, zc, readSynced }) {
  async function cached(org, key, ttl, fn) {
    const doc = await store.zohoCache(org);
    const hit = doc[key];
    if (hit && Date.now() - Date.parse(hit.at) < ttl) return hit.data;
    try {
      const data = await fn();
      doc[key] = { at: new Date().toISOString(), data };
      await store.saveZohoCache(org);
      return data;
    } catch (e) {
      if (hit) return hit.data;   // stale is better than nothing when Zoho is busy
      throw e;
    }
  }

  const accounts = org => cached(org, 'accounts', 12 * H, () => zc.chartOfAccounts(org));
  const taxes    = org => cached(org, 'taxes', 12 * H, () => zc.taxes(org));
  const branches = org => cached(org, 'branches', 12 * H, () => zc.branches(org));
  const projects = org => cached(org, 'projects', 12 * H, () => zc.projects(org));
  const ownGstins = org => cached(org, 'own_gstins', 24 * H, () => zc.ownGstins(org));

  async function synced(companyId, entity) {
    try { return await readSynced(companyId, entity); } catch (_) { return null; }
  }

  async function vendors(companyId) {
    const s = await synced(companyId, 'vendors_all');
    return s?.data || [];
  }

  /** Bills already in Zoho (central sync) — for the duplicate check */
  async function zohoBills(companyId) {
    const s = await synced(companyId, 'bills_fy');
    return [...(s?.data || []), ...(s?.future || [])];
  }

  /**
   * The vendor's recent bills with their lines, newest first, without drafts this module created
   * and has not yet seen reviewed. → { bills: [compact], rows: [list rows] }
   */
  async function vendorHistory({ companyId, org, vendorId, days, maxBills, excludeBillIds = new Set() }) {
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    let rows = null;
    const s = await synced(companyId, 'bills_fy');
    if (s && Array.isArray(s.data) && s.window_from && s.window_from <= from) {
      rows = [...s.data, ...(s.future || [])].filter(b => b.vendor_id === vendorId && b.date >= from && b.status !== 'void')
        .map(b => ({ bill_id: b.bill_id, bill_number: b.bill_number, date: b.date, status: b.status, total: b.total, tds_total: b.tds_total || 0, lmt: b.last_modified_time }));
    }
    if (!rows) rows = await cached(org, `vb_${vendorId}_${from.slice(0, 7)}`, 6 * H, () => zc.vendorBills(org, vendorId, from));
    rows = rows.filter(r => r.status !== 'draft' && !excludeBillIds.has(r.bill_id))
      .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, maxBills);

    const doc = await store.zohoCache(org);
    doc.details = doc.details || {};
    let changed = false;
    const bills = [];
    for (const r of rows) {
      let d = doc.details[r.bill_id];
      if (!d || (r.lmt && d.lmt !== r.lmt)) {
        try {
          const fresh = await zc.billDetail(org, r.bill_id);
          if (fresh) { d = fresh; doc.details[r.bill_id] = d; changed = true; }
        } catch (_) { /* keep the cached copy, if any */ }
      }
      if (d) bills.push(d);
    }
    if (changed) await store.saveZohoCache(org);
    return { bills, rows, from };
  }

  return { accounts, taxes, branches, projects, ownGstins, vendors, zohoBills, vendorHistory, cached };
}

module.exports = { create };
