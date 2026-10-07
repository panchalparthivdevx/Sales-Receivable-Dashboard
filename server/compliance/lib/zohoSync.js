/**
 * Zoho Books period cache for the Compliance Dashboard.
 *
 *   Cache key = Company + FY + Month.
 *   Selected period → stored data? → yes: use it (ZERO Zoho calls)
 *                                  → no:  show "Not Synced"; the user clicks "Sync Selected Period".
 *
 * Nothing here runs on a timer or when a filter changes. Zoho is called ONLY from
 * syncPeriods(), which the API calls only on an explicit user click.
 * The existing app-wide Full Sync (Sync Monitor) is untouched.
 *
 * `zohoGet` is injected so tests can count calls.
 */

'use strict';

const P = require('./period');

const cacheKey = (companyId, fy, month) => `${companyId}|${fy}|${month}`;

/** Company × month pairs covered by a selection (companies the user may see) */
function periodsFor(state, sel, { company_id, access } = {}) {
  const allowed = access?.companies?.length ? new Set(access.companies) : null;
  const companies = state.companies.filter(c =>
    c.status !== 'Inactive' && (!company_id || P.isAll(company_id) || c.id === company_id) && (!allowed || allowed.has(c.id)));
  const out = [];
  for (const c of companies) for (const m of sel.months) out.push({ company: c, fy: sel.selection.fy, month: m });
  return out;
}

/** Sync status for each period — reads the cache only, never calls Zoho */
function statusOf(cache, periods) {
  const rows = periods.map(({ company, fy, month }) => {
    const rec = cache.periods?.[cacheKey(company.id, fy, month)];
    return {
      company_id: company.id, company_name: company.name, company_short: company.short_code,
      fy, month, month_label: P.periodLabel(fy, month),
      linked: !!company.zoho_org_id,
      synced: !!(rec && rec.ok),
      partial: !!(rec && rec.partial),
      last_synced_at: rec?.synced_at || null,
      synced_by: rec?.synced_by || null,
      error: rec && !rec.ok ? (rec.errors || []).join('; ') : null,
    };
  });
  const linked = rows.filter(r => r.linked);
  return {
    periods: rows,
    total: linked.length,
    synced: linked.filter(r => r.synced).length,
    unlinked: rows.filter(r => !r.linked).length,
    last_synced_at: linked.map(r => r.last_synced_at).filter(Boolean).sort().pop() || null,
  };
}

/** Aggregate stored entity summaries for a selection (cache only) */
function dataOf(cache, periods, settings, module) {
  const ents = (settings.zoho?.entities || []).filter(e => !module || P.isAll(module) || (e.modules || []).some(m => m.toLowerCase() === String(module).toLowerCase()));
  const totals = Object.fromEntries(ents.map(e => [e.key, { key: e.key, label: e.label, modules: e.modules || [], count: 0, amount: 0 }]));
  const rows = [];
  for (const { company, fy, month } of periods) {
    const rec = cache.periods?.[cacheKey(company.id, fy, month)];
    if (!rec || !rec.ok) continue;
    const row = { company_id: company.id, company_name: company.name, fy, month, month_label: P.periodLabel(fy, month), synced_at: rec.synced_at, partial: !!rec.partial, entities: {} };
    for (const e of ents) {
      const s = rec.entities?.[e.key];
      if (!s) continue;
      row.entities[e.key] = { count: s.count, amount: s.amount, truncated: !!s.truncated, error: s.error || null };
      totals[e.key].count += s.count || 0;
      totals[e.key].amount = Math.round((totals[e.key].amount + (s.amount || 0)) * 100) / 100;
    }
    rows.push(row);
  }
  return { entities: Object.values(totals), rows };
}

function createZohoSync({ zohoGet }) {
  /** One list entity for one month. Sorted newest-first, stops once past the month start. */
  async function fetchEntity(entity, orgId, from, to, maxPages, counter) {
    const df = entity.date_field || 'date';
    const items = [];
    let page = 1, truncated = false;
    for (;;) {
      if (page > maxPages) { truncated = true; break; }
      counter.calls++;
      const data = await zohoGet(entity.path, {
        organization_id: orgId, sort_column: df, sort_order: 'D',
        date_start: from, date_end: to, page, per_page: 200,
      });
      const list = (data && data[entity.list_key]) || [];
      if (!list.length) break;
      let reachedFrom = false;
      for (const it of list) {
        const d = it[df];
        if (d && d >= from) reachedFrom = true;
        if (d && d >= from && d <= to) items.push(it);
      }
      if (!reachedFrom || !data.page_context?.has_more_page) break;
      page++;
    }
    return { items, truncated };
  }

  function summarise(entity, items) {
    const excluded = new Set((entity.exclude_statuses || []).map(s => String(s).toLowerCase()));
    const s = { count: 0, amount: 0, by_status: {}, excluded: 0 };
    for (const it of items) {
      const st = String(it.status || 'unknown').toLowerCase();
      if (excluded.has(st)) { s.excluded++; continue; }
      const amt = Number(it[entity.amount_field || 'total']) || 0;
      s.count++;
      s.amount += amt;
      s.by_status[st] = s.by_status[st] || { count: 0, amount: 0 };
      s.by_status[st].count++;
      s.by_status[st].amount = Math.round((s.by_status[st].amount + amt) * 100) / 100;
    }
    s.amount = Math.round(s.amount * 100) / 100;
    return s;
  }

  /** Fetch one Company + FY + Month from Zoho. Returns the cache record. */
  async function syncOne({ company, fy, month }, settings, user) {
    const range = P.monthRange(fy, month);
    const counter = { calls: 0 };
    const rec = {
      company_id: company.id, fy, month, org_id: company.zoho_org_id,
      from: range.from, to: range.to,
      synced_at: new Date().toISOString(), synced_by: user?.name || user?.username || '',
      entities: {}, errors: [], ok: false, partial: false, api_calls: 0,
    };
    const maxPages = settings.zoho?.max_pages_per_entity || 60;
    for (const e of settings.zoho?.entities || []) {
      try {
        const { items, truncated } = await fetchEntity(e, company.zoho_org_id, range.from, range.to, maxPages, counter);
        rec.entities[e.key] = { ...summarise(e, items), truncated };
        if (truncated) { rec.partial = true; rec.errors.push(`${e.label}: stopped after ${maxPages} pages`); }
      } catch (err) {
        const msg = err.response?.data?.message || err.message;
        rec.entities[e.key] = { count: 0, amount: 0, error: msg };
        rec.errors.push(`${e.label}: ${msg}`);
        rec.partial = true;
        if (/ZOHO_DAILY_LIMIT/.test(msg)) break;
      }
    }
    rec.api_calls = counter.calls;
    rec.ok = Object.values(rec.entities).some(s => !s.error);
    return rec;
  }

  /**
   * Sync a list of periods (explicit user action only).
   * onlyMissing = true skips periods that are already synced — those reuse stored data.
   * `save(rec)` persists each period as soon as it is fetched.
   */
  async function syncPeriods(periods, cache, { settings, user, onlyMissing = false, save }) {
    const results = [];
    for (const p of periods) {
      const key = cacheKey(p.company.id, p.fy, p.month);
      if (!p.company.zoho_org_id) { results.push({ key, skipped: 'Company not linked to Zoho Books' }); continue; }
      if (onlyMissing && cache.periods?.[key]?.ok) { results.push({ key, skipped: 'Already synced — stored data reused' }); continue; }
      const rec = await syncOne(p, settings, user);
      if (save) await save(key, rec);
      results.push({ key, ok: rec.ok, partial: rec.partial, api_calls: rec.api_calls, errors: rec.errors });
      if (rec.errors.some(e => /ZOHO_DAILY_LIMIT/.test(e))) break;
    }
    return results;
  }

  return { syncOne, syncPeriods };
}

module.exports = { createZohoSync, cacheKey, periodsFor, statusOf, dataOf };
