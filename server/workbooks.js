/**
 * Excel workbooks the server reads at runtime: branch seats, the payroll salary sheet,
 * loan data and the Rent Recurring Module.
 *
 * Office PC (no DATABASE_URL): read straight from the folder — unchanged.
 * Neon (Vercel): a copy lives in kv_store as `xlsx_<key>` ({ name, mtime, size, data: base64 }),
 * sent by server/upload-to-neon.js or the Upload Excel button. Copies are held in memory
 * so callers stay synchronous, and re-checked every few minutes for newer uploads.
 */
const XLSX = require('xlsx');
const db   = require('./db');

const KEYS = ['branch_seats', 'payroll', 'loans', 'rent_module'];
const RECHECK_MS = 5 * 60 * 1000;

const _mem = {};          // key → { name, mtime, size, buf }
let _loadedAt = 0;
let _loading  = null;
const _onChange = [];     // called when a newer upload replaces a loaded workbook

async function _load() {
  const rows = await Promise.all(KEYS.map(k => db.readJSON(`xlsx_${k}`, null, null)));
  let changed = false;
  KEYS.forEach((k, i) => {
    const r = rows[i];
    if (!r || !r.data) return;
    if (_mem[k] && _mem[k].mtime !== r.mtime) changed = true;
    _mem[k] = { name: r.name, mtime: r.mtime, size: r.size, buf: Buffer.from(r.data, 'base64') };
  });
  _loadedAt = Date.now();
  if (changed) _onChange.forEach(fn => fn());
}

function onChange(fn) { _onChange.push(fn); }

// Start-up: load every stored workbook (Neon mode only)
async function preload() {
  if (!db.USE_DB) return;
  await _load();
}

// Per request: pick up newer uploads from other Vercel instances, without waiting
function refreshIfStale() {
  if (!db.USE_DB || _loading || Date.now() - _loadedAt < RECHECK_MS) return;
  _loading = _load().catch(e => console.warn('[workbooks] refresh failed:', e.message)).finally(() => { _loading = null; });
}

// Parsed workbook. localPath is the file the office PC reads (ignored in Neon mode).
function read(key, localPath) {
  if (!db.USE_DB) return XLSX.readFile(localPath);
  const m = _mem[key];
  if (!m) {
    const e = new Error(`Workbook "${key}" has not been uploaded to the database yet`);
    e.code = 'ENOENT';
    throw e;
  }
  return XLSX.read(m.buf, { type: 'buffer' });
}

// { name, mtime, size } of the stored copy (Neon mode), or null
function stored(key) {
  const m = _mem[key];
  return m ? { name: m.name, mtime: m.mtime, size: m.size } : null;
}

async function save(key, name, buf, mtime = Date.now()) {
  if (!KEYS.includes(key)) throw new Error(`Unknown workbook "${key}"`);
  await db.writeJSON(`xlsx_${key}`, null, { name, mtime, size: buf.length, data: buf.toString('base64') });
  _mem[key] = { name, mtime, size: buf.length, buf };
}

module.exports = { KEYS, preload, refreshIfStale, read, stored, save, onChange };
