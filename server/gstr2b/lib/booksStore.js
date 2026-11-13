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

/**
 * Re-apply the scope rules (which GSTINs are switched on, which months have been synced) to the documents already stored — no Zoho call.
 * `scopeOf(recipientGstin, postingDate)` answers 'gstin_off' | 'outside_period' | null (see canonBooks.scopeExclusion).
 * A document still waiting for its amounts that has fallen out of scope is kept out; a document that was kept out for a scope reason and
 * is back in scope waits for its amounts again. Documents that already have amounts are never touched. Returns { parked, revived }.
 */
async function applyScope(company, texts, scopeOf) {
  return store.withLock(`booksw_${company}`, async () => {
    const out = { parked: 0, revived: 0 };
    for (const { key } of await shardsOf(company)) {
      const docs = await store.read(key, []);
      let dirty = false;
      for (const d of docs) {
        if (d.deleted || d.amounts) continue;
        const want = scopeOf(d.recipient_gstin, d.posting_date);
        if (d.excluded === 'gstin_off' || d.excluded === 'outside_period') {
          if (want === d.excluded) continue;
          if (want) { d.excluded = want; d.excluded_text = texts[want]; }
          else { d.excluded = null; delete d.excluded_text; d.detail_pending = true; out.revived++; }
          dirty = true;
        } else if (!d.excluded && d.detail_pending && want) {
          d.excluded = want; d.excluded_text = texts[want]; d.detail_pending = false; out.parked++; dirty = true;
        }
      }
      if (dirty) await store.write(key, docs);
    }
    return out;
  });
}

const FAIL_LIMIT = 3;                                            // a document whose amounts could not be read this many times is set aside until it is retried

/**
 * Coverage counts for the sync screen, in one pass over the store. `pending` are the documents still waiting for their amounts;
 * those among them that failed FAIL_LIMIT times are also counted in `failing` (with the first few listed, so the screen can show
 * which documents and why) — they are not tried again until resetFailures().
 */
async function stats(company) {
  const s = { total: 0, in_scope: 0, detailed: 0, pending: 0, stale: 0, failing: 0, failing_docs: [], excluded: {}, months: {}, by_kind: {} };
  for (const { ym, key } of await shardsOf(company)) {
    for (const d of await store.read(key, [])) {
      s.total++;
      s.by_kind[d.kind] = (s.by_kind[d.kind] || 0) + 1;
      const m = (s.months[ym] = s.months[ym] || { docs: 0, in_scope: 0, pending: 0 });
      m.docs++;
      if (d.excluded) { s.excluded[d.excluded] = (s.excluded[d.excluded] || 0) + 1; continue; }
      s.in_scope++; m.in_scope++;
      if (d.detail_pending) {
        s.pending++; m.pending++; if (d.stale) s.stale++;
        if ((d.detail_fail || 0) >= FAIL_LIMIT) {
          s.failing++;
          if (s.failing_docs.length < 25) s.failing_docs.push({ id: d.id, kind: d.kind, doc_no: d.doc_no || '', date: d.posting_date || '', supplier: (d.supplier && d.supplier.name) || '', attempts: d.detail_fail, error: d.detail_error || '', url: d.zoho_url || '' });
        }
      } else s.detailed++;
    }
  }
  return s;
}

/**
 * Give the documents that were set aside after repeated failures ONE more attempt (the nightly re-check and the "Try these again" button).
 * One, not a fresh three: a document that still cannot be read is back among the failed ones in the same run, so it never passes for
 * merely "pending" in between. Returns how many.
 */
async function resetFailures(company) {
  return store.withLock(`booksw_${company}`, async () => {
    let n = 0;
    for (const { key } of await shardsOf(company)) {
      const docs = await store.read(key, []);
      let dirty = false;
      for (const d of docs) if (d.detail_pending && !d.excluded && (d.detail_fail || 0) >= FAIL_LIMIT) { d.detail_fail = FAIL_LIMIT - 1; dirty = true; n++; }
      if (dirty) await store.write(key, docs);
    }
    return n;
  });
}

module.exports = { upsertMany, all, get, pendingDetails, applyScope, stats, resetFailures, shardsOf, monthOf, FAIL_LIMIT };
