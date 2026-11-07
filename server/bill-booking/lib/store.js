/**
 * Bill Collection & Booking — data store.
 *
 * Documents (same pattern as the rest of the app — see server/db.js):
 *   bb_config            team, categories (+ their fields), companies, settings
 *   bb_secrets           mailbox tokens, encrypted (never sent to the browser or written to logs)
 *   bb_mappings          confirmed account / tax mappings
 *   bb_mail              mailbox cursors, poll log, skipped attachments
 *   bb_zoho_<org>        Zoho look-ups per organisation (accounts, taxes, branches, bill history)
 *   bb_shards            list of bill shards
 *   bb_bills_<YYYY_MM>   bills, one document per month received (keeps every write small)
 *   bb_audit_<YYYY_MM>   module-level events (configuration, mailbox polls, Zoho checks)
 *
 * Local mode (no DATABASE_URL): JSON files in server/bill-booking/data (or BB_DATA_DIR), written
 * atomically. Neon mode: kv_store rows. Everything is held in memory once loaded; all writes go
 * through `tx()`, which runs one at a time, so a read-modify-write never interleaves.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

let opts = { dir: process.env.BB_DATA_DIR || path.join(__dirname, '..', 'data'), useDb: null };
let _db = null;
function db() { if (!_db) _db = require('../../db'); return _db; }
function useDb() { return opts.useDb === null ? db().USE_DB : opts.useDb; }

/** Tests point the store at a temporary folder: configure({ dir, useDb: false }) */
function configure(o) { opts = { ...opts, ...o }; reset(); }
const dataDir = () => opts.dir;

async function read(key, def) {
  if (useDb()) return db().readJSON(key, null, def);
  try {
    return JSON.parse(fs.readFileSync(path.join(opts.dir, `${key}.json`), 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') return def;
    throw new Error(`Bill booking store file ${key}.json could not be read: ${e.message}`);
  }
}

async function write(key, value) {
  if (useDb()) return db().writeJSON(key, null, value);
  fs.mkdirSync(opts.dir, { recursive: true });
  const file = path.join(opts.dir, `${key}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

// ── In-memory state ───────────────────────────────────────────────────────────
let S = null;
function reset() { S = null; }

const SINGLE = ['bb_config', 'bb_secrets', 'bb_mappings', 'bb_mail'];
const DEFAULTS = { bb_config: null, bb_secrets: {}, bb_mappings: [], bb_mail: { cursors: {}, log: [], skipped: [] } };

async function load(force = false) {
  // Neon (Vercel): another instance may have written since — re-read (db.js answers from its
  // own cache unless the row changed). Office PC: one process owns the files.
  if (S && !force && !useDb()) return S;
  const next = { docs: {}, bills: new Map(), shardOf: new Map(), shards: [], zoho: S ? S.zoho : {}, dirty: new Set() };
  for (const k of SINGLE) next.docs[k] = await read(k, DEFAULTS[k]);
  next.shards = await read('bb_shards', []);
  for (const sh of next.shards) {
    const list = await read(sh, []);
    for (const b of list) { next.bills.set(b.id, b); next.shardOf.set(b.id, sh); }
  }
  S = next;   // Zoho look-ups are only a cache: kept across reloads
  return S;
}

const shardKey = iso => `bb_bills_${String(iso || new Date().toISOString()).slice(0, 7).replace('-', '_')}`;

async function flush() {
  if (!S || !S.dirty.size) return;
  const dirty = [...S.dirty];
  S.dirty.clear();
  for (const k of dirty) {
    if (k.startsWith('bb_bills_')) {
      await write(k, [...S.bills.values()].filter(b => S.shardOf.get(b.id) === k));
    } else if (k === 'bb_shards') {
      await write(k, S.shards);
    } else if (k.startsWith('bb_zoho_')) {
      await write(k, S.zoho[k]);
    } else {
      await write(k, S.docs[k]);
    }
  }
}

// ── Lock + transaction ────────────────────────────────────────────────────────
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

/** Transaction API handed to fn. Changes are written once fn resolves; a throw writes nothing
 *  (and the in-memory copy is reloaded from the last write). */
function tx(fn) {
  return withLock(async () => {
    await load();
    const api = {
      doc: k => S.docs[k],
      setDoc: (k, v) => { S.docs[k] = v; S.dirty.add(k); },
      touch: k => S.dirty.add(k),
      bill: id => S.bills.get(id) || null,
      bills: () => [...S.bills.values()],
      putBill: b => {
        let sh = S.shardOf.get(b.id);
        if (!sh) {
          sh = shardKey(b.created_at);
          S.shardOf.set(b.id, sh);
          if (!S.shards.includes(sh)) { S.shards.push(sh); S.dirty.add('bb_shards'); }
        }
        S.bills.set(b.id, b);
        S.dirty.add(sh);
      },
      zoho: async org => zohoDoc(org),
      touchZoho: org => S.dirty.add(`bb_zoho_${org}`),
    };
    try {
      const r = await fn(api);
      await flush();
      return r;
    } catch (e) {
      S.dirty.clear();
      S = null;
      throw e;
    }
  });
}

async function zohoDoc(org) {
  const k = `bb_zoho_${org}`;
  if (!S.zoho[k]) S.zoho[k] = await read(k, {});
  return S.zoho[k];
}

/** Zoho look-up cache of one organisation, read and filled outside the lock (network calls), then
 *  written with saveZohoCache. Losing a race only costs a repeat Zoho call. */
async function zohoCache(org) { await load(); return zohoDoc(org); }
function saveZohoCache(org) { return withLock(async () => { if (S && S.zoho[`bb_zoho_${org}`]) await write(`bb_zoho_${org}`, S.zoho[`bb_zoho_${org}`]); }); }

/** Read-only snapshot (no lock): current bills and documents */
async function snapshot() {
  await load();
  return { bills: [...S.bills.values()], doc: k => S.docs[k] };
}

async function bill(id) { await load(); return S.bills.get(id) || null; }

/** Module-level audit events, one document per month (kept to the newest 5,000 a month) */
async function audit(entry) {
  const k = `bb_audit_${new Date().toISOString().slice(0, 7).replace('-', '_')}`;
  return withLock(async () => {
    const list = await read(k, []);
    list.push({ at: new Date().toISOString(), ...entry });
    await write(k, list.slice(-5000));
  });
}
async function auditMonth(ym) { return read(`bb_audit_${ym.replace('-', '_')}`, []); }

module.exports = { configure, dataDir, load, tx, snapshot, bill, audit, auditMonth, withLock, reset, useDb, zohoCache, saveZohoCache };
