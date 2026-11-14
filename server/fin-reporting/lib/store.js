/**
 * Financial Reporting — document store.
 *
 * Same two modes as the rest of the app (see server/db.js):
 *   office PC (no DATABASE_URL)  JSON files in server/fin-reporting/data (or FSR_DATA_DIR), written atomically
 *   Vercel + Neon                rows in kv_store, keys prefixed "fsr_"
 *
 * Keys:  index               import versions (active one, history, rollback)
 *        version_<id>        one imported dataset: facts, notes, narrative, issues, file list
 *        staging             workbooks extracted but not yet committed (one per file hash)
 *        adjustments         financial-statement-level adjustments (reason, evidence, user, date) — never mixed into source facts
 *        decisions           how a source conflict was resolved, by whom and when
 *        inputs              management inputs (budgets, seats, covenants, share data, thresholds …)
 *        audit               who did what (imports, rollbacks, adjustments, decisions, inputs)
 *
 * Read-modify-write goes through update(): a per-key lock, a private copy, written only if the function finishes.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let opts = { dir: process.env.FSR_DATA_DIR || path.join(__dirname, '..', 'data'), useDb: null };
let _db = null;
const db = () => (_db || (_db = require('../../db')));
const useDb = () => (opts.useDb === null ? db().USE_DB : opts.useDb);
const cache = new Map();

/** Tests point the store at a temporary folder: configure({ dir, useDb: false }) */
function configure(o) { opts = { ...opts, ...o }; cache.clear(); }
const safeKey = k => { if (!/^[A-Za-z0-9_.-]+$/.test(k)) throw new Error(`Invalid store key "${k}"`); return k; };
const fileOf = k => path.join(opts.dir, `${safeKey(k)}.json`);
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const NOT_READ = Object.freeze({ not_read: true });

// A failed Neon read must not be taken for "empty" (it would be written back over the real record) — see gstr2b/lib/store.js
async function readDb(key, def) {
  const full = `fsr_${key}`;
  const v = await db().readJSON(full, null, NOT_READ);
  if (v !== NOT_READ) return v;
  if ((await db().listKeys(full)).some(r => r.key === full)) throw new Error(`The stored record "${key}" could not be read just now — nothing was changed. Please try again.`);
  return clone(def);
}

async function read(key, def = null) {
  safeKey(key);
  if (useDb()) return readDb(key, def);
  if (cache.has(key)) return clone(cache.get(key));
  let v;
  try { v = JSON.parse(fs.readFileSync(fileOf(key), 'utf8').replace(/^﻿/, '')); }
  catch (e) { if (e.code === 'ENOENT') return clone(def); throw new Error(`Financial reporting store file ${key}.json could not be read: ${e.message}`); }
  cache.set(key, v);
  return clone(v);
}

async function write(key, value) {
  safeKey(key);
  if (useDb()) { await db().writeJSON(`fsr_${key}`, null, value); return; }
  fs.mkdirSync(opts.dir, { recursive: true });
  const file = fileOf(key);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
  cache.set(key, clone(value));
}

async function remove(key) {
  safeKey(key);
  if (useDb()) { await db().deleteKey(`fsr_${key}`); return; }
  cache.delete(key);
  try { fs.unlinkSync(fileOf(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
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

/** update(key, def, fn): fn gets a private copy and returns the new value (or mutates and returns undefined) */
function update(key, def, fn) {
  return withLock(key, async () => {
    const cur = await read(key, def);
    const out = await fn(cur);
    const next = out === undefined ? cur : out;
    await write(key, next);
    return next;
  });
}

async function audit(entry) {
  await update('audit', { entries: [] }, a => {
    a.entries.push({ at: new Date().toISOString(), ...entry });
    if (a.entries.length > 2000) a.entries = a.entries.slice(-2000);
  });
}

module.exports = { configure, read, write, update, remove, audit };
