/**
 * Compliance data store.
 *
 * Four logical documents (same pattern as the rest of the app — see server/db.js):
 *   data      compliance_data.json       masters, tasks, documents, folders, user roles
 *   audit     compliance_audit.json      audit trail
 *   zoho      compliance_zoho_sync.json  Zoho period cache (Company + FY + Month)
 *   settings  compliance_settings.json   settings changed in the app (overrides config defaults)
 *
 * Local mode (no DATABASE_URL): JSON files in server/compliance/data (or COMPLIANCE_DATA_DIR),
 * written atomically (temp file + rename). Neon mode: kv_store rows via server/db.js.
 *
 * All writes go through `transaction()`, which runs one at a time (a simple lock), so a
 * read-modify-write can never interleave with another. Each transaction writes its changed
 * documents once at the end — an import is applied as one write, or not at all.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const NAMES = {
  data:     'compliance_data',
  audit:    'compliance_audit',
  zoho:     'compliance_zoho_sync',
  settings: 'compliance_settings',
};

let opts = {
  dir: process.env.COMPLIANCE_DATA_DIR || path.join(__dirname, '..', 'data'),
  useDb: null,                      // null = follow server/db.js (DATABASE_URL)
};
let _db = null;
function db() { if (!_db) _db = require('../../db'); return _db; }
function useDb() { return opts.useDb === null ? db().USE_DB : opts.useDb; }

/** Tests point the store at a temporary folder: configure({ dir, useDb: false }) */
function configure(o) { opts = { ...opts, ...o }; }
function dataDir() { return opts.dir; }

function fileOf(name) {
  if (!NAMES[name]) throw new Error(`Unknown store document "${name}"`);
  return path.join(opts.dir, `${NAMES[name]}.json`);
}

async function read(name, defaultValue) {
  if (useDb()) return db().readJSON(NAMES[name], null, defaultValue);
  try {
    return JSON.parse(fs.readFileSync(fileOf(name), 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') return defaultValue;
    throw new Error(`Compliance store file ${path.basename(fileOf(name))} could not be read: ${e.message}`);
  }
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

async function write(name, value) {
  if (useDb()) return db().writeJSON(NAMES[name], null, value);
  writeFileAtomic(fileOf(name), JSON.stringify(value, null, 2));
}

// ── Lock + transaction ────────────────────────────────────────────────────────
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

/**
 * Run `fn(tx)` exclusively. tx.get(name, default) loads (once per transaction),
 * tx.set(name, value) marks it for writing. Writes happen after fn resolves; if fn
 * throws, nothing is written.
 */
function transaction(fn) {
  return withLock(async () => {
    const loaded = new Map();
    const dirty = new Set();
    const tx = {
      async get(name, def) {
        if (!loaded.has(name)) loaded.set(name, await read(name, def));
        return loaded.get(name);
      },
      set(name, value) { loaded.set(name, value); dirty.add(name); },
    };
    const result = await fn(tx);
    // data first: if it fails, audit is not written either
    const order = ['data', 'settings', 'zoho', 'audit'].filter(n => dirty.has(n));
    for (const n of order) await write(n, loaded.get(n));
    return result;
  });
}

// ── Backups ───────────────────────────────────────────────────────────────────
function resolveProjectPath(p) {
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

/**
 * Copy the current data document to the backup folder. Called before every import.
 * Keeps the newest `keep` backups. Returns the backup file path.
 */
async function backup(reason, { dir, keep = 30 } = {}) {
  const value = await read('data', null);
  const folder = resolveProjectPath(dir || path.join('server', 'compliance', 'backups'));
  fs.mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReason = String(reason || 'manual').replace(/[^a-z0-9-]+/gi, '-').slice(0, 30);
  const file = path.join(folder, `compliance_data_${stamp}_${safeReason}.json`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  const all = fs.readdirSync(folder).filter(f => /^compliance_data_.*\.json$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    try { fs.unlinkSync(path.join(folder, old)); } catch (_) { /* best effort */ }
  }
  return file;
}

module.exports = { configure, dataDir, read, write, transaction, backup, resolveProjectPath, PROJECT_ROOT, NAMES };
