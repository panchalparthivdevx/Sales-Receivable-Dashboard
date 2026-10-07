/**
 * Neon PostgreSQL abstraction layer.
 * Replaces all local JSON file reads/writes for Vercel + Neon deployment.
 * Falls back to local file-system JSON when DATABASE_URL is not set (local dev).
 */

const path = require('path');
const fs   = require('fs');
const zlib = require('zlib');
const util = require('util');
const { background } = require('./background');

const USE_DB = !!process.env.DATABASE_URL;
// Neon writes also keep a local copy (backup) — except on Vercel, whose disk is read-only
const MIRROR = !process.env.VERCEL;

let _pool = null;

function getPool() {
  if (!_pool) {
    const { Pool } = require('pg');
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('neon.tech')
        ? { rejectUnauthorized: false }
        : false,
      max: 5,
    });
  }
  return _pool;
}

// ─── Schema bootstrap ──────────────────────────────────────────────────────────
// Documents are stored as `json` (kept exactly as written), not `jsonb`: jsonb re-sorts
// object keys, so branch lists and other keyed data would come back in a different
// order than the office PC's files.
async function initDB() {
  if (!USE_DB) return;
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key        TEXT PRIMARY KEY,
        value      JSON NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS branch_bills_cache (
        branch_id  TEXT PRIMARY KEY,
        data       JSON NOT NULL,
        synced_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS zoho_token (
        id     INT  PRIMARY KEY DEFAULT 1,
        token  TEXT,
        expiry BIGINT
      );

      CREATE TABLE IF NOT EXISTS sync_entity_cache (
        cache_key   TEXT PRIMARY KEY,
        data        JSON NOT NULL DEFAULT '[]',
        record_count INT  DEFAULT 0,
        synced_at   TIMESTAMPTZ DEFAULT NOW(),
        run_id      TEXT
      );
    `);
    // Tables created as jsonb by an earlier version: switch to json (re-upload restores key order)
    const old = await client.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND data_type = 'jsonb'
        AND ((table_name = 'kv_store' AND column_name = 'value')
          OR (table_name = 'branch_bills_cache' AND column_name = 'data'))`);
    for (const { table_name: t, column_name: c } of old.rows) {
      await client.query(`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE json USING ${c}::json`);
    }
  } finally {
    client.release();
  }
}

// ─── KV helpers ───────────────────────────────────────────────────────────────
// key = logical name (e.g. 'users', 'budget_data')
// localPath = fallback file path used when DATABASE_URL is not set

// Neon's free plan allows 5 GB of data transfer a month, and the synced lists run to tens of MB,
// so Neon mode saves on it twice:
//  - Documents of 64 KB or more are stored brotli-compressed as {"__brotli":"<base64>"} (about
//    40x smaller). Larger documents written before this are re-stored compressed the first time
//    they are read, with content and updated_at unchanged.
//  - The stored text of each document read is kept in memory; a read asks Neon for the text only
//    when the row changed since (one small query otherwise).
// Every read still parses its own fresh copy, exactly like reading a file on the office PC.
const PACK_MIN    = 64 * 1024;
const PACK_PREFIX = '{"__brotli":"';
const _brotli   = util.promisify(zlib.brotliCompress);
const _unbrotli = util.promisify(zlib.brotliDecompress);

async function _pack(text) {
  if (text.length < PACK_MIN) return text;
  const buf = await _brotli(Buffer.from(text, 'utf8'), { params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: text.length,
  } });
  return `${PACK_PREFIX}${buf.toString('base64')}"}`;
}
async function _unpack(stored) {
  if (!stored.startsWith(PACK_PREFIX)) return stored;
  const b64 = stored.slice(PACK_PREFIX.length, stored.lastIndexOf('"'));
  return (await _unbrotli(Buffer.from(b64, 'base64'))).toString('utf8');
}
// A large document still stored uncompressed: store it compressed, unless it changed meanwhile
function _repack(key, at, text) {
  background((async () => {
    const packed = await _pack(text);
    const r = await getPool().query(
      'UPDATE kv_store SET value = $2::json WHERE key = $1 AND updated_at::text = $3', [key, packed, at]);
    if (r.rowCount && _docCache.get(key)?.at === at) _cacheDoc(key, at, packed);
  })().catch(e => console.warn(`[db] compressing ${key} failed:`, e.message)));
}

const DOC_CACHE_MAX = 400 * 1024 * 1024;  // characters of stored text held, least recently used dropped first
const _docCache = new Map();              // key → { at: updated_at as text, text: as stored in Neon }
const _docReads = new Map();              // key → the read in flight, shared by concurrent callers
let _docCacheSize = 0;

function _cacheDoc(key, at, text) {
  _uncacheDoc(key);
  _docCache.set(key, { at, text });
  _docCacheSize += text.length;
  for (const [k, v] of _docCache) {
    if (_docCacheSize <= DOC_CACHE_MAX || k === key) break;
    _docCache.delete(k);
    _docCacheSize -= v.text.length;
  }
}
function _uncacheDoc(key) {
  const old = _docCache.get(key);
  if (old) { _docCache.delete(key); _docCacheSize -= old.text.length; }
}

// Text of a document as stored in Neon (possibly compressed), or null when there is no row
function _readStored(key) {
  if (_docReads.has(key)) return _docReads.get(key);
  const p = (async () => {
    const hit = _docCache.get(key);
    const r = await getPool().query(
      `SELECT updated_at::text AS at,
              CASE WHEN updated_at::text = $2 THEN NULL ELSE value::text END AS text
         FROM kv_store WHERE key = $1`,
      [key, hit ? hit.at : null]
    );
    if (!r.rows.length) { _uncacheDoc(key); return null; }
    const { at, text } = r.rows[0];
    if (text == null) {                                    // unchanged: mark as recently used
      if (_docCache.get(key) === hit) { _docCache.delete(key); _docCache.set(key, hit); }
      return hit.text;
    }
    _cacheDoc(key, at, text);
    if (text.length >= PACK_MIN && !text.startsWith(PACK_PREFIX)) _repack(key, at, text);
    return text;
  })().finally(() => _docReads.delete(key));
  _docReads.set(key, p);
  return p;
}

async function readJSON(key, localPath, defaultVal = null) {
  if (!USE_DB) {
    try { return JSON.parse(fs.readFileSync(localPath, 'utf8')); } catch (_) { return defaultVal; }
  }
  try {
    const stored = await _readStored(key);
    return stored == null ? defaultVal : JSON.parse(await _unpack(stored));
  } catch (e) {
    console.error(`[db] readJSON(${key}) error:`, e.message);
    return defaultVal;
  }
}

async function writeJSON(key, localPath, data) {
  if (!USE_DB) {
    fs.writeFileSync(localPath, JSON.stringify(data, null, 2), 'utf8');
    return;
  }
  try {
    const stored = await _pack(JSON.stringify(data));
    const r = await getPool().query(
      `INSERT INTO kv_store (key, value, updated_at)
       VALUES ($1, $2::json, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::json, updated_at = NOW()
       RETURNING updated_at::text AS at`,
      [key, stored]
    );
    _cacheDoc(key, r.rows[0].at, stored);
    // Mirror to local file if path provided (optional backup)
    if (localPath && MIRROR) {
      try { fs.writeFileSync(localPath, JSON.stringify(data, null, 2), 'utf8'); } catch (_) {}
    }
  } catch (e) {
    console.error(`[db] writeJSON(${key}) error:`, e.message);
    throw e;
  }
}

// Neon only: remove a document (no-op when using local files)
async function deleteKey(key) {
  if (!USE_DB) return;
  await getPool().query('DELETE FROM kv_store WHERE key = $1', [key]);
  _uncacheDoc(key);
}

// Neon only: keys under a prefix with their last write time ([] when using local files)
async function listKeys(prefix) {
  if (!USE_DB) return [];
  const r = await getPool().query(
    `SELECT key, updated_at FROM kv_store WHERE key LIKE $1`,
    [prefix.replace(/[\\%_]/g, '\\$&') + '%']
  );
  return r.rows;
}

// ─── Branch bills cache ───────────────────────────────────────────────────────

async function readBranchCache(branchId, localDir) {
  if (!USE_DB) {
    const file = path.join(localDir, `${branchId}.json`);
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
  }
  try {
    const r = await getPool().query('SELECT data FROM branch_bills_cache WHERE branch_id = $1', [branchId]);
    return r.rows[0]?.data ?? null;
  } catch (e) {
    console.error(`[db] readBranchCache(${branchId}) error:`, e.message);
    return null;
  }
}

async function writeBranchCache(branchId, data, localDir) {
  if (!USE_DB) {
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, `${branchId}.json`), JSON.stringify(data, null, 2), 'utf8');
    return;
  }
  try {
    await getPool().query(
      `INSERT INTO branch_bills_cache (branch_id, data, synced_at)
       VALUES ($1, $2::json, NOW())
       ON CONFLICT (branch_id) DO UPDATE SET data = $2::json, synced_at = NOW()`,
      [branchId, JSON.stringify(data)]
    );
    // Mirror locally too
    if (localDir && MIRROR) {
      try {
        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
        fs.writeFileSync(path.join(localDir, `${branchId}.json`), JSON.stringify(data, null, 2), 'utf8');
      } catch (_) {}
    }
  } catch (e) {
    console.error(`[db] writeBranchCache(${branchId}) error:`, e.message);
    throw e;
  }
}

async function listBranchCaches(localDir) {
  if (!USE_DB) {
    if (!fs.existsSync(localDir)) return [];
    return fs.readdirSync(localDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(localDir, f), 'utf8').replace(/^﻿/, '')); }
        catch (_) { return null; }
      })
      .filter(Boolean);
  }
  try {
    const r = await getPool().query('SELECT data FROM branch_bills_cache ORDER BY branch_id');
    return r.rows.map(row => row.data);
  } catch (e) {
    console.error('[db] listBranchCaches error:', e.message);
    return [];
  }
}

async function listBranchCacheFiles(localDir) {
  if (!USE_DB) {
    if (!fs.existsSync(localDir)) return [];
    return fs.readdirSync(localDir).filter(f => f.endsWith('.json'));
  }
  try {
    const r = await getPool().query('SELECT branch_id FROM branch_bills_cache ORDER BY branch_id');
    return r.rows.map(row => `${row.branch_id}.json`);
  } catch (e) {
    return [];
  }
}

// ─── Zoho token ───────────────────────────────────────────────────────────────

async function readZohoToken(localPath) {
  if (!USE_DB) {
    try {
      const data = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      return (data.token && data.expiry) ? data : null;
    } catch (_) { return null; }
  }
  try {
    const r = await getPool().query('SELECT token, expiry FROM zoho_token WHERE id = 1');
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function writeZohoToken(token, expiry, localPath) {
  if (!USE_DB) {
    try { fs.writeFileSync(localPath, JSON.stringify({ token, expiry }), 'utf8'); } catch (_) {}
    return;
  }
  try {
    await getPool().query(
      `INSERT INTO zoho_token (id, token, expiry) VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET token = $1, expiry = $2`,
      [token, expiry]
    );
    if (localPath && MIRROR) {
      try { fs.writeFileSync(localPath, JSON.stringify({ token, expiry }), 'utf8'); } catch (_) {}
    }
  } catch (e) {
    console.error('[db] writeZohoToken error:', e.message);
  }
}

module.exports = {
  USE_DB,
  initDB,
  readJSON,
  writeJSON,
  deleteKey,
  listKeys,
  readBranchCache,
  writeBranchCache,
  listBranchCaches,
  listBranchCacheFiles,
  readZohoToken,
  writeZohoToken,
};
