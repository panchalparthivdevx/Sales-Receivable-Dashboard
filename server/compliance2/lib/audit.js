/**
 * Audit trail — append-only, one document per space and month, each entry carrying the hash of the one before it (across
 * months too), so an edited or removed entry is detected by verify(). The module has no route that edits or deletes it.
 *
 * Entry: { seq, at, actor, actor_id, persona, action, object_type, object_id, entity_id, summary, reason, before, after }
 * before / after hold only the fields that changed (history arrays are left out — they are on the record itself).
 */

'use strict';

const U = require('./util');

const monthKey = (sp, iso) => `${sp}_audit_${String(iso).slice(0, 7).replace('-', '_')}`;
const SKIP = new Set(['history', 'rev', 'updated_at', 'updated_by', 'updated_by_id']);

/** Changed fields between two versions of a record → { before, after } (null when nothing changed) */
function diff(before, after) {
  if (!before) return { before: null, after: trim(after) };
  if (!after) return { before: trim(before), after: null };
  const b = {}, a = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (SKIP.has(k)) continue;
    if (U.stable(before[k]) !== U.stable(after[k])) { b[k] = before[k]; a[k] = after[k]; }
  }
  return Object.keys(a).length || Object.keys(b).length ? { before: b, after: a } : null;
}
function trim(o) { if (!o || typeof o !== 'object') return o; const c = { ...o }; for (const k of SKIP) delete c[k]; return c; }

/** Append inside a store transaction (written together with the change it describes) */
async function append(tx, sp, e) {
  const at = U.nowIso();
  const tail = await tx.get(`${sp}_audit_tail`, { seq: 0, hash: '0'.repeat(64) });
  const d = e.before !== undefined || e.after !== undefined ? diff(e.before, e.after) : null;
  const body = {
    seq: tail.seq + 1, at, actor: e.actor?.name || 'system', actor_id: e.actor?.id || '', persona: e.actor?.persona || null,
    action: e.action, object_type: e.object_type || '', object_id: e.object_id || '', entity_id: e.entity_id || '',
    summary: String(e.summary || '').slice(0, 1000), reason: String(e.reason || '').slice(0, 2000), before: d?.before ?? null, after: d?.after ?? null,
  };
  const full = { ...body, prev: tail.hash, hash: U.sha256(`${tail.hash}|${U.stable(body)}`) };
  const key = monthKey(sp, at);
  const list = await tx.get(key, []);
  list.push(full);
  tx.set(key, list);
  tx.set(`${sp}_audit_tail`, { seq: full.seq, hash: full.hash });
  return full;
}

/** Entries, newest first, optionally filtered ({ object_id, entity_ids (scope), from, to, limit }) */
async function query(store, sp, { object_id, entity_ids, from, to, limit = 500 } = {}) {
  const keys = (await store.list(`${sp}_audit_2`)).sort().reverse();
  const out = [];
  for (const k of keys) {
    if (to && k.slice(-7).replace('_', '-') > to.slice(0, 7)) continue;
    if (from && k.slice(-7).replace('_', '-') < from.slice(0, 7)) break;
    const list = await store.read(k, []);
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (object_id && e.object_id !== object_id) continue;
      if (entity_ids && e.entity_id && !entity_ids.includes(e.entity_id)) continue;
      if (entity_ids && !e.entity_id) continue;                  // scoped users see entity-linked entries only
      out.push(e);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Re-computes the whole chain of a space */
async function verify(store, sp) {
  const keys = (await store.list(`${sp}_audit_2`)).sort();
  let prev = null, checked = 0;
  for (const k of keys) {
    for (const e of await store.read(k, [])) {
      const { prev: p, hash, ...body } = e;
      if (prev !== null && p !== prev) return { ok: false, at_seq: e.seq, reason: 'an entry before this one is missing or was changed', checked };
      if (U.sha256(`${p}|${U.stable(body)}`) !== hash) return { ok: false, at_seq: e.seq, reason: 'this entry was changed after it was written', checked };
      prev = hash; checked++;
    }
  }
  const tail = await store.read(`${sp}_audit_tail`, null);
  if (tail && prev !== null && tail.hash !== prev) return { ok: false, reason: 'the newest entries are missing', checked };
  return { ok: true, checked };
}

module.exports = { append, query, verify, diff };
