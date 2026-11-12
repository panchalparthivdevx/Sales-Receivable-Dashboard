/**
 * Audit trail — append-only, one document per month, each entry carrying the hash of the one before it
 * (across months too), so an edited or removed entry is detectable with verify().
 *
 * Recorded: imports, syncs, mappings, configuration and rule changes, matches, overrides, approvals,
 * claim decisions, exports. Entries are never edited or deleted by the module.
 */

'use strict';

const store = require('./store');
const { sha256, stable } = require('./util');

const monthKey = iso => `audit_${String(iso).slice(0, 7).replace('-', '_')}`;

/** entry: { by, action, company?, gstin?, detail?, ref? } */
async function log(entry) {
  const at = new Date().toISOString();
  return store.withLock('audit', async () => {
    const tail = await store.read('audit_tail', { seq: 0, hash: '0'.repeat(64) });
    const body = { seq: tail.seq + 1, at, by: entry.by || 'system', action: entry.action, company: entry.company || '', gstin: entry.gstin || '', detail: entry.detail ?? '', ref: entry.ref ?? '' };
    const full = { ...body, prev: tail.hash, hash: sha256(`${tail.hash}|${stable(body)}`) };
    const key = monthKey(at);
    const list = await store.read(key, []);
    await store.write(key, [...list, full]);
    await store.write('audit_tail', { seq: full.seq, hash: full.hash });
    return full;
  });
}

async function month(ym) { return store.read(monthKey(`${ym}-01`.slice(0, 10)), []); }

/** Re-computes the chain for the given months (default: every audit document) */
async function verify(months) {
  const keys = months ? months.map(m => monthKey(`${m}-01`)) : (await store.list('audit_2')).sort();
  let prev = null, checked = 0;
  for (const k of keys) {
    for (const e of await store.read(k, [])) {
      const { prev: p, hash, ...body } = e;
      if (prev !== null && p !== prev) return { ok: false, at_seq: e.seq, reason: 'an entry before this one is missing or was changed', checked };
      if (sha256(`${p}|${stable(body)}`) !== hash) return { ok: false, at_seq: e.seq, reason: 'this entry was changed after it was written', checked };
      prev = hash; checked++;
    }
  }
  return { ok: true, checked };
}

module.exports = { log, month, verify };
