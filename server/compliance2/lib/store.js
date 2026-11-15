/**
 * Compliance Vr.2.0 — document store.
 *
 * Same two modes as the rest of the app (see server/db.js):
 *   office PC (no DATABASE_URL)  JSON files in server/compliance2/data (or C2_DATA_DIR), each written atomically
 *   Vercel + Neon                rows in kv_store, keys prefixed "c2_"
 *
 * Demo and live data never share a document: every key of a space starts with the space ("live_…", "demo_…").
 *   <sp>_org            entities, registrations, establishments, people, groups
 *   <sp>_rules          obligation rules with their versions, deadline extensions / fee waivers, state rules
 *   <sp>_applic         applicability decisions (effective-dated)
 *   <sp>_events         AGMs, notices, cancellations, material events … that trigger obligations
 *   <sp>_tasks_<FY>     tasks of one financial year
 *   <sp>_docs           document records and their versions (the files themselves: lib/blobs.js)
 *   <sp>_team           owner / backup / checker mapping
 *   <sp>_audit_<YYYY_MM>, <sp>_audit_tail   hash-chained audit trail
 *   settings            module settings (access scopes, reminder settings …) — shared by both spaces
 *
 * Every change goes through transaction(): one at a time inside this process, and on Neon all the documents a change
 * touched are written in one database transaction that only succeeds if none of them was changed by another server
 * instance meanwhile (otherwise the change is re-run on fresh data, up to 3 times). A throw writes nothing.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { clone, httpError } = require('./util');

let opts = { dir: process.env.C2_DATA_DIR || path.join(__dirname, '..', 'data'), useDb: null };
let _db = null;
const db = () => opts.db || _db || (_db = require('../../db'));          // tests may pass { db } (a stand-in for Neon)
const useDb = () => (opts.useDb === null ? db().USE_DB : opts.useDb);
const textCache = new Map();          // office PC only: one process owns the files. Text, so every read is a fresh copy

/** Tests point the store at a temporary folder: configure({ dir, useDb: false }) */
function configure(o) { opts = { ...opts, ...o }; textCache.clear(); }
const dataDir = () => opts.dir;
const safeKey = k => { if (!/^[A-Za-z0-9_.-]+$/.test(k)) throw new Error(`Invalid store key "${k}"`); return k; };
const fileOf = k => path.join(opts.dir, `${safeKey(k)}.json`);
const isAudit = k => /_audit_/.test(k) ? 1 : 0;

function readLocalText(key) {
  if (textCache.has(key)) return textCache.get(key);
  let text;
  try { text = fs.readFileSync(fileOf(key), 'utf8').replace(/^﻿/, ''); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Compliance store file ${key}.json could not be read: ${e.message}`); }
  textCache.set(key, text);
  return text;
}

/** A document (a fresh copy), or `def` when it does not exist. A failed read throws — it is never taken for "empty". */
async function read(key, def = null) {
  safeKey(key);
  if (useDb()) { const { value } = await db().readJSONStamped(`c2_${key}`); return value === undefined || value === null ? clone(def) : value; }
  const text = readLocalText(key);
  return text === null ? clone(def) : JSON.parse(text);
}

async function readStamped(key) {
  if (useDb()) return db().readJSONStamped(`c2_${key}`);
  const text = readLocalText(key);
  return { value: text === null ? undefined : JSON.parse(text), at: text === null ? null : 'local' };
}

function writeLocal(key, value) {
  fs.mkdirSync(opts.dir, { recursive: true });
  const file = fileOf(key);
  const text = JSON.stringify(value);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  textCache.set(key, text);
}

// ── Lock + transaction ────────────────────────────────────────────────────────
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

/**
 * Run `fn(tx)` exclusively. tx.get(key, default) loads a document once per transaction (a private copy),
 * tx.set(key, value) marks it to be written. Writes happen after fn resolves; when fn throws nothing is written.
 */
function transaction(fn, { retries = 3 } = {}) {
  return withLock(async () => {
    for (let attempt = 0; ; attempt++) {
      const loaded = new Map();
      const stamps = new Map();
      const dirty = new Set();
      const tx = {
        async get(key, def) {
          safeKey(key);
          if (!loaded.has(key)) {
            const { value, at } = await readStamped(key);
            loaded.set(key, value === undefined || value === null ? clone(def) : value);
            stamps.set(key, at);
          }
          return loaded.get(key);
        },
        set(key, value) { safeKey(key); if (!stamps.has(key)) stamps.set(key, undefined); loaded.set(key, value); dirty.add(key); },
        attempt,
      };
      const result = await fn(tx);
      if (!dirty.size) return result;
      // an audit entry is written with (never before) the change it describes
      const keys = [...dirty].sort((a, b) => isAudit(a) - isAudit(b));
      if (!useDb()) { for (const k of keys) writeLocal(k, loaded.get(k)); return result; }
      // a document set without being read first: take its current stamp, so the write is still conditional
      for (const k of keys) if (stamps.get(k) === undefined) stamps.set(k, (await db().readJSONStamped(`c2_${k}`)).at);
      const ok = await db().writeJSONManyIfUnchanged(keys.map(k => ({ key: `c2_${k}`, value: loaded.get(k), at: stamps.get(k) })));
      if (ok) return result;
      if (attempt >= retries) throw httpError(409, 'Someone else saved a change at the same moment, so nothing was saved. Please try again.');
    }
  });
}

/** Keys beginning with a prefix (without the c2_ database prefix) */
async function list(prefix = '') {
  if (useDb()) return (await db().listKeys(`c2_${prefix}`)).map(r => r.key.slice(3));
  try { return fs.readdirSync(opts.dir).filter(f => f.endsWith('.json') && f.startsWith(prefix)).map(f => f.slice(0, -5)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

const options = () => ({ ...opts });

module.exports = { configure, options, dataDir, read, transaction, list, useDb, safeKey };
