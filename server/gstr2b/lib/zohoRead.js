/**
 * Read-only Zoho Books client for GSTR-2B Reco.
 *
 * It exposes GET and nothing else — there is no POST / PUT / DELETE in this file, so this module cannot change
 * anything in Zoho Books. Credentials:
 *   - GSTR2B_ZOHO_REFRESH_TOKEN (+ GSTR2B_ZOHO_CLIENT_ID / GSTR2B_ZOHO_CLIENT_SECRET, falling back to the app's)
 *     → a dedicated token created with read-only scopes (recommended, least privilege), or
 *   - the app's shared Zoho token (server/zoho.js) when no dedicated token is set.
 * Data centre: ZOHO_ACCOUNTS_URL / ZOHO_API_DOMAIN from .env (the app runs on Zoho India: zoho.in).
 *
 * Calls are paced, retried with a growing wait on 429 / 5xx / network errors, stop on Zoho's daily limit (code 45) and are
 * counted so the sync can keep to its per-day budget. Every answer also carries Zoho's own account of the organisation's
 * allowance (headers seen live on 12 Nov 2026: x-rate-limit-limit / -remaining / -reset for the day, x-user-access-limit /
 * -remaining for the minute, x-user-concurrency-limit) — usage(org) hands the latest reading to the sync.
 *
 * Scopes a dedicated token needs: ZohoBooks.bills.READ, ZohoBooks.vendorcredits.READ, ZohoBooks.expenses.READ,
 * ZohoBooks.contacts.READ, ZohoBooks.settings.READ (branches, organisations), ZohoBooks.vendorpayments.READ.
 */

'use strict';

const axios = require('axios');
const { sleep } = require('./util');

const READ_SCOPES = ['ZohoBooks.bills.READ', 'ZohoBooks.vendorcredits.READ', 'ZohoBooks.expenses.READ', 'ZohoBooks.contacts.READ', 'ZohoBooks.settings.READ', 'ZohoBooks.vendorpayments.READ'];

class ZohoLimit extends Error { constructor(m, code) { super(m); this.name = 'ZohoLimit'; this.code = code; } }

function create(deps = {}) {
  const http = deps.http || axios;
  const env = deps.env || process.env;
  const zoho = deps.zoho || (() => require('../../zoho'));
  const wait = deps.sleep || sleep;
  const calls = { total: 0 };
  let last = 0;
  let own = null;                                                  // { token, expiry } for a dedicated refresh token
  let ownInFlight = null;

  const usageByOrg = new Map();                                    // organisation id → what Zoho last said about its allowance
  const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  function note(org, headers) {
    if (!org || !headers) return;
    const limit = int(headers['x-rate-limit-limit']);
    if (limit === null) return;                                    // an answer without the allowance headers (a proxy error page)
    const reset = int(headers['x-rate-limit-reset']);
    usageByOrg.set(String(org), {
      day_limit: limit, day_remaining: int(headers['x-rate-limit-remaining']), day_reset_at: reset === null ? null : new Date(Date.now() + reset * 1000).toISOString(),
      minute_limit: int(headers['x-user-access-limit']), minute_remaining: int(headers['x-user-access-remaining']), concurrency_limit: int(headers['x-user-concurrency-limit']),
      at: new Date().toISOString(),
    });
  }
  /** Zoho's latest account of an organisation's allowance, or null before the first answer */
  const usage = org => { const u = usageByOrg.get(String(org)); return u ? { ...u } : null; };

  const dedicated = () => !!env.GSTR2B_ZOHO_REFRESH_TOKEN;
  const identity = () => (dedicated() ? 'dedicated read-only token (GSTR2B_ZOHO_REFRESH_TOKEN)' : 'the dashboard\'s shared Zoho token');

  async function token(force = false) {
    if (!dedicated()) return (typeof zoho === 'function' ? zoho() : zoho).getAccessToken();
    if (!force && own && Date.now() < own.expiry) return own.token;
    if (ownInFlight) return ownInFlight;
    ownInFlight = http.post(`${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, { params: {
      refresh_token: env.GSTR2B_ZOHO_REFRESH_TOKEN,
      client_id: env.GSTR2B_ZOHO_CLIENT_ID || env.ZOHO_CLIENT_ID, client_secret: env.GSTR2B_ZOHO_CLIENT_SECRET || env.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' } })
      .then(r => { if (!r.data.access_token) throw new Error(`Zoho did not issue a token: ${r.data.error || 'unknown error'}`); own = { token: r.data.access_token, expiry: Date.now() + ((r.data.expires_in || 3600) - 120) * 1000 }; return own.token; })
      .finally(() => { ownInFlight = null; });
    return ownInFlight;
  }

  /**
   * GET /books/v3<path> for one organisation. `before` runs once per call (the sync uses it to take its turn in the calls-per-minute
   * queue, to count the call against its daily budget and to stop between calls — it may throw). `paceMs` is a plain minimum gap between
   * two calls for the few one-after-another callers. `onThrottle(seconds)` is told when Zoho answers "too many requests", so that
   * the caller can hold its other calls back too.
   */
  async function get(org, path, params = {}, { paceMs = 0, before, onThrottle } = {}) {
    if (org === undefined || org === '') throw new Error('A Zoho organisation id is required');      // null = a call that belongs to no organisation (the organisation list)
    if (before) await before();
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const gap = paceMs - (Date.now() - last);
      if (gap > 0) await wait(gap);
      last = Date.now();
      calls.total++;
      try {
        const res = await http.get(`${env.ZOHO_API_DOMAIN}/books/v3${path}`, {
          headers: { Authorization: `Zoho-oauthtoken ${await token(refreshed)}` }, params: org === null ? { ...params } : { ...params, organization_id: org }, timeout: 45000,
        });
        note(org, res.headers);
        return res.data;
      } catch (e) {
        const st = e.response && e.response.status, body = (e.response && e.response.data) || {};
        if (e.response) note(org, e.response.headers);
        if (st === 401 && !refreshed && dedicated()) { refreshed = true; own = null; continue; }
        if (st === 429) {
          if (body.code === 45) throw new ZohoLimit('Zoho Books says the organisation\'s daily API allowance is used up — the sync resumes after midnight (India time), when Zoho resets it.', 45);
          const ra = parseInt((e.response.headers || {})['retry-after'] || '30', 10);
          if (onThrottle) onThrottle(ra);
          if (ra > 90) throw new ZohoLimit(`Zoho asked us to wait ${Math.round(ra / 60)} minutes (rate limit) — the sync stopped and will resume on the next run.`, 429);
          if (attempt < 3) { await wait(ra * 1000); continue; }
        }
        if ((!st || st >= 500) && attempt < 2) { await wait(2000 * (attempt + 1)); continue; }
        throw e;
      }
    }
  }

  /** Every page of a list endpoint (calls onPage(rows, pageNo) for each; stops when onPage returns false) */
  async function list(org, path, key, params = {}, { maxPages = 120, onPage, paceMs = 0, before, onThrottle } = {}) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const d = await get(org, path, { ...params, page, per_page: 200 }, { paceMs, before, onThrottle });
      const rows = d[key] || [];
      if (onPage) { const go = await onPage(rows, page, d); if (go === false) return { rows: all, pages: page, complete: false }; } else all.push(...rows);
      if (!(d.page_context && d.page_context.has_more_page) || !rows.length) return { rows: all, pages: page, complete: true };
    }
    throw new Error(`${path} returned more than ${maxPages} pages — stopped instead of reading a partial list`);
  }

  const listOrganizations = async () => ((await get(null, '/organizations')).organizations || []).map(o => ({
    id: String(o.organization_id), name: o.name, gst_registered: !!o.is_registered_for_gst, currency: o.currency_code, default: !!o.is_default_org }));
  async function listBranches(org) {
    const d = await get(org, '/branches');
    return (d.branches || []).map(b => ({
      id: String(b.branch_id), name: b.branch_name, gstin: String(b.tax_reg_no || '').toUpperCase(), state_code: (b.address && b.address.state_code) || '',
      state: (b.address && b.address.state) || '', active: b.is_branch_active !== false, primary: !!b.is_primary_branch, registration_id: String(b.tax_registration_id || b.tax_settings_id || '') }));
  }

  const isGone = e => !!e && ((e.response && e.response.status === 404) || (e.response && e.response.data && (e.response.data.code === 1002 || /does not exist|not found/i.test(e.response.data.message || ''))));
  const errText = e => {
    if (e instanceof ZohoLimit) return e.message;
    const d = e.response && e.response.data;
    return d && d.message ? `Zoho: ${d.message}${d.code ? ` (code ${d.code})` : ''}` : `Zoho request failed: ${e.message}`;
  };

  /** One GET per area, so the onboarding screen can show exactly which access works */
  async function checkAccess(org) {
    const probes = [['Organisation', `/organizations/${org}`, null], ['Branches (recipient GSTINs)', '/branches', null], ['Bills', '/bills', { per_page: 1 }],
      ['Vendor credits', '/vendorcredits', { per_page: 1 }], ['Expenses', '/expenses', { per_page: 1 }], ['Contacts (vendors)', '/contacts', { per_page: 1, contact_type: 'vendor' }]];
    const out = [];
    for (const [label, path, params] of probes) {
      try { await get(org, path, params || {}, { paceMs: 400 }); out.push({ label, ok: true }); }
      catch (e) { out.push({ label, ok: false, message: errText(e) }); }
    }
    return { ok: out.every(x => x.ok), credentials: identity(), read_only: true, results: out, scopes_for_dedicated_token: READ_SCOPES };
  }

  // The object has no write methods by design; tests assert it.
  return Object.freeze({ get, list, listOrganizations, listBranches, isGone, errText, checkAccess, identity, dedicated, calls, usage });
}

module.exports = { create, ZohoLimit, READ_SCOPES };
