/** Small shared helpers: stable hashing, ids, async guards. */

'use strict';

const crypto = require('crypto');

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const sha1 = data => crypto.createHash('sha1').update(data).digest('hex');

/** JSON with sorted keys, so equal content always hashes equal */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}
const hashOf = v => sha1(stable(v)).slice(0, 16);

const uid = (prefix = '') => `${prefix}${crypto.randomBytes(6).toString('hex')}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/** Run `fn` over `items` with at most `n` at a time, in order of completion-independent results */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const uniq = arr => [...new Set(arr)];
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); (m.get(k) || m.set(k, []).get(k)).push(x); } return m; };

module.exports = { sha256, sha1, stable, hashOf, uid, sleep, nowIso, pool, uniq, groupBy };
