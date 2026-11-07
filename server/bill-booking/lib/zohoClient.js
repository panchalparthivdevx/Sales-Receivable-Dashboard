/**
 * Zoho Books calls for Bill Collection & Booking, for any of the configured organisations
 * (DevX, Neddle …). Reads use the app's shared zohoGet (same token, retries, daily-limit guard)
 * with the organisation's id; writes are limited to what this module needs:
 *   POST /bills (draft), POST /bills/{id}/attachment, DELETE /bills/{id} (only the draft test bill).
 * It never calls /bills/{id}/status/open, /submit or /approve — moving a draft on is the team's step in Zoho.
 */

'use strict';

const axios = require('axios');

function create(deps = {}) {
  const zoho = deps.zoho || require('../../zoho');
  const domain = () => process.env.ZOHO_API_DOMAIN;

  const get = (org, path, params = {}) => zoho.zohoGet(path, { ...params, organization_id: org });

  async function send(method, org, path, { data, form, params } = {}) {
    const token = await zoho.getAccessToken();
    const headers = { Authorization: `Zoho-oauthtoken ${token}` };
    let body = data === undefined ? undefined : JSON.stringify(data);
    if (form) { body = form; Object.assign(headers, form.getHeaders ? form.getHeaders() : {}); }
    else if (body !== undefined) headers['Content-Type'] = 'application/json';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await axios({
          method, url: `${domain()}/books/v3${path}`, headers, data: body,
          params: { organization_id: org, ...(params || {}) }, timeout: 60000, maxBodyLength: 30 * 1024 * 1024,
        });
        return res.data;
      } catch (e) {
        if (e.response?.status === 429 && attempt < 2 && e.response?.data?.code !== 45) {
          const wait = Math.min(parseInt(e.response.headers['retry-after'] || '30', 10), 60) * 1000;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
  }

  /** Zoho error → short message for the team (never the token or request headers) */
  function errText(e) {
    const d = e.response?.data;
    if (d?.message) return `Zoho: ${d.message}${d.code ? ` (code ${d.code})` : ''}`;
    return `Zoho request failed: ${e.message}`;
  }

  // ── Look-ups (cached in bb_zoho_<org>) ──────────────────────────────────────

  async function chartOfAccounts(org) {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const d = await get(org, '/chartofaccounts', { page, per_page: 200, filter_by: 'AccountType.Active' });
      for (const a of d.chartofaccounts || []) {
        all.push({ id: a.account_id, name: a.account_name, code: a.account_code || '', type: a.account_type, parent: a.parent_account_name || '' });
      }
      if (!d.page_context?.has_more_page) break;
    }
    return all;
  }

  async function taxes(org) {
    const d = await get(org, '/settings/taxes');
    return (d.taxes || []).map(t => ({
      id: t.tax_id, name: t.tax_name, percentage: Number(t.tax_percentage) || 0,
      type: t.tax_type, specific: t.tax_specific_type || '', inactive: t.status === 'inactive' || t.is_inactive === true,
    }));
  }

  async function branches(org) {
    try {
      const d = await get(org, '/branches');
      return (d.branches || []).map(b => ({ id: b.branch_id, name: b.branch_name, primary: !!b.is_primary_branch, gstin: b.gst_no || '' }));
    } catch (_) { return []; }
  }

  async function projects(org) {
    try {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const d = await get(org, '/projects', { page, per_page: 200, filter_by: 'Status.Active' });
        for (const p of d.projects || []) all.push({ id: p.project_id, name: p.project_name, customer: p.customer_name || '' });
        if (!d.page_context?.has_more_page) break;
      }
      return all;
    } catch (_) { return []; }
  }

  /** The organisation's own GSTINs, wherever Zoho returns them (organisation + branches) */
  async function ownGstins(org) {
    const found = new Set();
    const scan = obj => { const s = JSON.stringify(obj || {}).toUpperCase(); for (const g of s.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g) || []) found.add(g); };
    try { scan((await get(org, `/organizations/${org}`)).organization); } catch (_) {}
    try { scan((await get(org, '/branches')).branches); } catch (_) {}
    return [...found];
  }

  /** The vendor's bills from `fromDate` (list only) */
  async function vendorBills(org, vendorId, fromDate) {
    const d = await get(org, '/bills', { vendor_id: vendorId, date_start: fromDate, sort_column: 'date', sort_order: 'D', per_page: 50 });
    return (d.bills || []).filter(b => b.status !== 'void').map(b => ({
      bill_id: b.bill_id, bill_number: b.bill_number, date: b.date, status: b.status, total: b.total,
      tds_total: b.tds_total || 0, lmt: b.last_modified_time,
    }));
  }

  /** One bill's lines and bill-level settings, kept small for the history cache */
  async function billDetail(org, billId) {
    const b = (await get(org, `/bills/${billId}`)).bill;
    return compactBill(b);
  }

  function compactBill(b) {
    return {
      bill_id: b.bill_id, bill_number: b.bill_number, date: b.date, status: b.status, lmt: b.last_modified_time,
      vendor_id: b.vendor_id, total: b.total, sub_total: b.sub_total,
      branch_id: b.branch_id || '', branch_name: b.branch_name || '',
      gst_treatment: b.gst_treatment || '', gst_no: b.gst_no || '',
      source_of_supply: b.source_of_supply || '', destination_of_supply: b.destination_of_supply || '',
      is_reverse_charge_applied: !!b.is_reverse_charge_applied,
      tds_tax_id: b.tds_tax_id || '', tds_tax_name: b.tds_tax_name || b.tds_name || '', tds_percent: b.tds_percent || null,
      custom_fields: (b.custom_fields || []).map(c => ({ customfield_id: c.customfield_id, api_name: c.api_name || '', label: c.label, value: c.value })),
      lines: (b.line_items || []).map(l => ({
        description: l.description || l.name || '', account_id: l.account_id, account_name: l.account_name,
        tax_id: l.tax_id || '', tax_name: l.tax_name || '', tax_percentage: l.tax_percentage ?? null,
        hsn_or_sac: l.hsn_or_sac || '', amount: l.item_total ?? l.bcy_rate ?? 0,
        project_id: l.project_id || '', itc_eligibility: l.itc_eligibility || '',
        reverse_charge_tax_id: l.reverse_charge_tax_id || '',
      })),
    };
  }

  /** Bills already in Zoho with this vendor + bill number (exact, after Zoho's own search) */
  async function findBill(org, vendorId, billNumber) {
    const d = await get(org, '/bills', { vendor_id: vendorId, bill_number: billNumber, per_page: 25 });
    return (d.bills || []).map(b => ({ bill_id: b.bill_id, bill_number: b.bill_number, date: b.date, status: b.status, total: b.total }));
  }

  async function getBill(org, billId) {
    try {
      const b = (await get(org, `/bills/${billId}`)).bill;
      return { bill_id: b.bill_id, bill_number: b.bill_number, status: b.status, last_modified_by: b.last_modified_by_name || '', lmt: b.last_modified_time };
    } catch (e) {
      if (e.response?.status === 404 || e.response?.data?.code === 1002 || /does not exist/i.test(e.response?.data?.message || '')) return null;
      throw e;
    }
  }

  async function createBill(org, payload) {
    return (await send('post', org, '/bills', { data: payload })).bill;
  }

  async function attach(org, billId, buffer, fileName, mime) {
    // Node's own FormData/Blob — axios sends it as multipart with its boundary
    const form = new FormData();
    form.append('attachment', new Blob([buffer], { type: mime }), fileName);
    return send('post', org, `/bills/${billId}/attachment`, { form });
  }

  async function deleteBill(org, billId) { return send('delete', org, `/bills/${billId}`); }

  /** Access probe: read works, and POST /bills is accepted by the token (an empty bill is refused by
   *  validation, so nothing is created). Returns { read, create, detail }. */
  async function checkAccess(org) {
    const out = { read: false, create: false, detail: [] };
    try { await get(org, '/bills', { per_page: 1 }); out.read = true; } catch (e) { out.detail.push(`Read bills: ${errText(e)}`); }
    try {
      await send('post', org, '/bills', { data: {} });
      out.detail.push('Create: Zoho accepted an empty bill — unexpected; check Zoho');
    } catch (e) {
      const st = e.response?.status, code = e.response?.data?.code;
      if (st === 401 || code === 57 || code === 14) out.detail.push(`Create bills: not permitted for this login (${errText(e)}). The Zoho refresh token needs the ZohoBooks.bills.CREATE scope.`);
      else if (st >= 400 && st < 500) { out.create = true; out.detail.push(`Create bills: permitted (empty test refused as expected: ${errText(e)})`); }
      else out.detail.push(`Create bills: ${errText(e)}`);
    }
    return out;
  }

  const billUrl = (org, billId) => `https://books.zoho.in/app/${org}#/bills/${billId}`;

  return { get, send, errText, chartOfAccounts, taxes, branches, projects, ownGstins, vendorBills, billDetail, compactBill, findBill, getBill, createBill, attach, deleteBill, checkAccess, billUrl };
}

module.exports = { create };
