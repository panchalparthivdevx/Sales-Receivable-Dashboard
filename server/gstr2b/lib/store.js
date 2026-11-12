/**
 * GSTR-2B Reco — document store.
 *
 * Same two modes as the rest of the app (see server/db.js):
 *   office PC (no DATABASE_URL)  JSON files in server/gstr2b/data (or G2B_DATA_DIR), written atomically
 *   Vercel + Neon                rows in kv_store, keys prefixed "g2b_"
 *
 * Keys: g2b_config, g2b_sync_<co>, g2b_books_<co>_<YYYY_MM>, g2b_books_idx_<co>, g2b_stmt_idx, g2b_stmt_<id>,
 *       g2b_recon_<co>_<gstin>, g2b_review_<co>, g2b_audit_<YYYY_MM>, g2b_audit_tail, …
 *
 * Read-modify-write goes through update(): it takes a per-key lock, hands the function a private copy, and
 * writes only if the function finishes — a throw leaves the stored document untouched.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

let opts = { dir: process.env.G2B_DATA_DIR || path.join(__dirname, '..', 'data'), useDb: null };
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
 * One record from Neon. db.readJSON answers its default (null — even when undefined is passed) both when the record does not
 * exist AND when the read failed (it logs the error and swallows it). The two must be told apart here: a record that is not
 * there yet is the caller's empty default, but a failed read taken for "empty" would be changed and written back over the real
 * record, silently replacing it. listKeys does not swallow errors, so an unreachable database stops the request instead.
 */
async function readDb(key, def) {
  const full = `g2b_${key}`;
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
  catch (e) { if (e.code === 'ENOENT') return clone(def); throw new Error(`GSTR-2B store file ${key}.json could not be read: ${e.message}`); }
  cache.set(key, v);
  return v;
}

async function write(key, value) {
  safeKey(key);
  if (useDb()) { await db().writeJSON(`g2b_${key}`, null, value); return; }
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

/**
 * Locked read-modify-write. `fn(copy)` may mutate the copy and return nothing (the copy is written), return a
 * new document, or return `update.SKIP` to leave the stored document alone. Resolves to fn's `out` property
 * when it returns { out, doc }.
 */
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
  if (useDb()) { await db().deleteKey(`g2b_${key}`); return; }
  cache.delete(key);
  try { fs.unlinkSync(fileOf(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

/** Keys beginning with a prefix (without the g2b_ database prefix) */
async function list(prefix = '') {
  if (useDb()) return (await db().listKeys(`g2b_${prefix}`)).map(r => r.key.slice(4));
  try { return fs.readdirSync(opts.dir).filter(f => f.endsWith('.json') && f.startsWith(prefix)).map(f => f.slice(0, -5)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

module.exports = { configure, dataDir, read, write, update, remove, list, withLock, useDb, clone };
