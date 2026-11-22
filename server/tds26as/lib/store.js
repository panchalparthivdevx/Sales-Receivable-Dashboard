/**
 * 26AS Reconciliation — document store (same two modes as the rest of the app, see server/db.js):
 *   office PC (no DATABASE_URL)  JSON files in server/tds26as/data (or T26_DATA_DIR), written atomically
 *   Vercel + Neon                rows in kv_store, keys prefixed "t26_"
 *
 * Every key that holds entity data carries the entity id (ledger_<entity>_<fy>, docs_<entity>, clients_<entity>, review_<entity>,
 * cf_<entity>, sync_<entity>), so imports, mappings, results and review decisions of one legal entity never mix with another's.
 * Read-modify-write goes through update(): a per-key lock, a private copy, and a write only when the function finishes.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PREFIX = 't26_';
let opts = { dir: process.env.T26_DATA_DIR || path.join(__dirname, '..', 'data'), useDb: null };
let _db = null;
const db = () => (_db || (_db = require('../../db')));
const useDb = () => (opts.useDb === null ? db().USE_DB : opts.useDb);
const cache = new Map();                       // office PC only: one process owns the files

/** Tests point the store at a temporary folder: configure({ dir, useDb: false }) */
function configure(o) { opts = { ...opts, ...o }; cache.clear(); }
const dataDir = () => opts.dir;
const safeKey = k => { if (!/^[A-Za-z0-9_.-]+$/.test(k)) throw new Error(`Invalid store key "${k}"`); return k; };
const fileOf = k => path.join(opts.dir, `${safeKey(k)}.json`);
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const NOT_READ = Object.freeze({ not_read: true });

/**
 * db.readJSON answers its default both when a record does not exist and when the read failed (it swallows the error). A failed read
 * taken for "empty" would be written back over the real record, so listKeys (which does not swallow errors) tells the two apart.
 */
async function readDb(key, def) {
  const full = `${PREFIX}${key}`;
  const v = await db().readJSON(full, null, NOT_READ);
  if (v !== NOT_READ) return v;
  if ((await db().listKeys(full)).some(r => r.key === full)) throw new Error(`The stored record "${key}" could not be read just now — nothing was changed. Please try again.`);
  return clone(def);
}

async function read(key, def = null) {
  safeKey(key);
  if (useDb()) return readDb(key, def);
  if (cache.has(key)) return cache.get(key);
  let v;
  try { v = JSON.parse(fs.readFileSync(fileOf(key), 'utf8').replace(/^﻿/, '')); }
  catch (e) { if (e.code === 'ENOENT') return clone(def); throw new Error(`26AS store file ${key}.json could not be read: ${e.message}`); }
  cache.set(key, v);
  return v;
}

async function write(key, value) {
  safeKey(key);
  if (useDb()) { await db().writeJSON(`${PREFIX}${key}`, null, value); return; }
  fs.mkdirSync(opts.dir, { recursive: true });
  const file = fileOf(key);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
  cache.set(key, value);
}

const tails = new Map();
function withLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

/** Locked read-modify-write: fn(copy) mutates the copy (returns nothing), returns a new document, { out, doc }, or update.SKIP */
async function update(key, def, fn) {
  return withLock(key, async () => {
    const cur = await read(key, def);
    const copy = clone(cur === null || cur === undefined ? def : cur);
    const r = await fn(copy);
    if (r === update.SKIP) return undefined;
    if (r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'doc')) { await write(key, r.doc); return r.out; }
    await write(key, r === undefined ? copy : r);
    return undefined;
  });
}
update.SKIP = Symbol('skip');

async function remove(key) {
  safeKey(key);
  if (useDb()) { await db().deleteKey(`${PREFIX}${key}`); return; }
  cache.delete(key);
  try { fs.unlinkSync(fileOf(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

/** Keys beginning with a prefix (without the t26_ database prefix) */
async function list(prefix = '') {
  if (useDb()) return (await db().listKeys(`${PREFIX}${prefix}`)).map(r => r.key.slice(PREFIX.length));
  try { return fs.readdirSync(opts.dir).filter(f => f.endsWith('.json') && f.startsWith(prefix)).map(f => f.slice(0, -5)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

module.exports = { configure, dataDir, read, write, update, remove, list, withLock, useDb, clone };
