/**
 * Books documents (bills, vendor credits, GST-bearing expenses), one stored document per company and POSTING month
 * (books_<co>_<YYYY_MM>), plus an id → month index so a document whose posting date was edited in Zoho moves cleanly.
 * Writes are idempotent upserts keyed by the Zoho id: the same input written twice leaves the same store.
 */

'use strict';

const store = require('./store');

const monthOf = doc => String(doc.posting_date || doc.doc_date || '0000-00').slice(0, 7);
const shardKey = (co, ym) => `books_${co}_${ym.replace('-', '_')}`;
const idxKey = co => `books_idx_${co}`;

/**
 * Upsert documents. `merge(old, next)` decides what is stored (default: replace). Returns { added, changed, unchanged }.
 * Every stored document keeps a short revision trail (last 10 source versions) for the post-change reports.
 */
async function upsertMany(company, docs, merge = (o, n) => n) {
  if (!docs.length) return { added: 0, changed: 0, unchanged: 0 };
  return store.withLock(`booksw_${company}`, async () => {
    const idx = await store.read(idxKey(company), {});
    const touched = new Map();                                   // shard → Map(id → doc | null)
    const want = (shard) => { if (!touched.has(shard)) touched.set(shard, new Map()); return touched.get(shard); };
    const stats = { added: 0, changed: 0, unchanged: 0 };
    const cache = new Map();
    const load = async shard => { if (!cache.has(shard)) cache.set(shard, new Map((await store.read(shard, [])).map(d => [d.id, d]))); return cache.get(shard); };
    const nowIso = new Date().toISOString();
    for (const next of docs) {
      const ym = monthOf(next);
      const shard = shardKey(company, ym);
      const oldShard = idx[next.id] ? shardKey(company, idx[next.id]) : null;
      const prev = oldShard ? (await load(oldShard)).get(next.id) : null;
      const merged = merge(prev || null, next);
      if (prev && prev.hash === merged.hash && !!prev.detail_pending === !!merged.detail_pending && !!prev.stale === !!merged.stale
        && prev.source?.lmt === merged.source?.lmt && prev.excluded === merged.excluded && (prev.detail_fail || 0) === (merged.detail_fail || 0)) { stats.unchanged++; continue; }
      merged.first_seen = (prev && prev.first_seen) || nowIso;
      // a revision = a change between two FULL versions (the first detail fetch of a listed document is not a revision)
      merged.revisions = [...((prev && prev.revisions) || []), ...(prev && prev.amounts && prev.hash !== merged.hash ? [{ at: nowIso, lmt: prev.source?.lmt || '', hash: prev.hash, tax: prev.tax_total ?? null, status: prev.status || '', excluded: prev.excluded || null }] : [])].slice(-10);
      if (prev) stats.changed++; else stats.added++;
      if (oldShard && oldShard !== shard) want(oldShard).set(next.id, null);   // posting month edited in Zoho
      want(shard).set(next.id, merged);
      idx[next.id] = ym;
      (await load(shard)).set(next.id, merged);
    }
    for (const [shard, changes] of touched) {
      const m = await load(shard);
      for (const [id, doc] of changes) { if (doc === null) m.delete(id); else m.set(id, doc); }
      await store.write(shard, [...m.values()]);
    }
    if (stats.added || stats.changed) await store.write(idxKey(company), idx);
    return stats;
  });
}

async function shardsOf(company) {
  const idx = await store.read(idxKey(company), {});
  return [...new Set(Object.values(idx))].sort().map(ym => ({ ym, key: shardKey(company, ym) }));
}

/** All documents of a company (optionally only months within [fromYm, toYm]) */
async function all(company, { fromYm = null, toYm = null } = {}) {
  const out = [];
  for (const { ym, key } of await shardsOf(company)) {
    if ((fromYm && ym < fromYm) || (toYm && ym > toYm)) continue;
    out.push(...(await store.read(key, [])));
  }
  return out;
}

async function get(company, id) {
  const idx = await store.read(idxKey(company), {});
  if (!idx[id]) return null;
  return (await store.read(shardKey(company, idx[id]), [])).find(d => d.id === id) || null;
}

/** Documents needing a detail fetch, edited ones first, then newest first */
async function pendingDetails(company, limit = 1e9) {
  const out = [];
  for (const { key } of (await shardsOf(company)).reverse()) {
    for (const d of await store.read(key, [])) if (d.detail_pending && !d.excluded && !d.deleted) out.push(d);
  }
  out.sort((a, b) => (b.stale ? 1 : 0) - (a.stale ? 1 : 0) || String(b.posting_date).localeCompare(String(a.posting_date)));
  return out.slice(0, limit);
}

/** Coverage counts for the sync screen */
async function stats(company) {
  const s = { total: 0, in_scope: 0, detailed: 0, pending: 0, stale: 0, excluded: {}, months: {}, by_kind: {} };
  for (const { ym, key } of await shardsOf(company)) {
    for (const d of await store.read(key, [])) {
      s.total++;
      s.by_kind[d.kind] = (s.by_kind[d.kind] || 0) + 1;
      const m = (s.months[ym] = s.months[ym] || { docs: 0, in_scope: 0, pending: 0 });
      m.docs++;
      if (d.excluded) { s.excluded[d.excluded] = (s.excluded[d.excluded] || 0) + 1; continue; }
      s.in_scope++; m.in_scope++;
      if (d.detail_pending) { s.pending++; m.pending++; if (d.stale) s.stale++; } else s.detailed++;
    }
  }
  return s;
}

module.exports = { upsertMany, all, get, pendingDetails, stats, shardsOf, monthOf };
