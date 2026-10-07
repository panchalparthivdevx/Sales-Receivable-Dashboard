/**
 * Field parsers shared by manual entry, the master screens and Excel import.
 *
 * Convention for incoming values (import + API):
 *   undefined  → leave unchanged (a blank Excel cell)
 *   ''         → empty the value (the Excel token #CLEAR is turned into '')
 */

'use strict';

const P = require('./period');

const CLEAR_TOKEN = '#CLEAR';

function text(v) {
  if (v === undefined || v === null) return undefined;
  return String(v).trim();
}

/** 'Yes' | 'No' | null (invalid) | undefined (not given) */
function yesNo(v) {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return '';
  if (['yes', 'y', 'true', '1', 'applicable'].includes(s)) return 'Yes';
  if (['no', 'n', 'false', '0', 'not applicable', 'na', 'n/a'].includes(s)) return 'No';
  return null;
}

const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };

/**
 * Parse a date from Excel/UI into 'YYYY-MM-DD'.
 * Accepts: Excel serial number, Date, 'DD-MM-YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD', 'DD-Mon-YYYY'.
 * Returns { ok: true, iso } | { ok: true, iso: '' } for blank | { ok: false }.
 */
function parseDate(v) {
  if (v === undefined || v === null) return { ok: true, iso: undefined };
  if (v instanceof Date && !isNaN(v)) return { ok: true, iso: P.localISODate(v) };
  if (typeof v === 'number' && isFinite(v)) {
    // Excel serial date (1900 system; 25569 = 1970-01-01)
    if (v < 20000 || v > 80000) return { ok: false };
    const ms = Math.round((v - 25569) * 86400000);
    const d = new Date(ms);
    return { ok: true, iso: P.ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) };
  }
  const s = String(v).trim();
  if (s === '') return { ok: true, iso: '' };
  let y, m, d, mm;
  if ((mm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else if ((mm = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { d = +mm[1]; m = +mm[2]; y = +mm[3]; }
  else if ((mm = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,4})[a-z]*[-\s/,]+(\d{4})$/))) { d = +mm[1]; m = MON[mm[2].toUpperCase()]; y = +mm[3]; }
  else return { ok: false };
  const iso = P.ymd(y, m || 0, d);
  return P.isValidISODate(iso) ? { ok: true, iso } : { ok: false };
}

/** 'YYYY-MM-DD' → 'DD-MM-YYYY' */
function fmtDMY(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${d}-${m}-${y}`;
}

/** 'JUN, dec' → 'JUN,DEC' (FY order). Returns null if any part is not a month. */
function parseMonthList(v) {
  if (v === undefined) return undefined;
  const s = String(v ?? '').trim();
  if (!s) return '';
  const parts = s.split(/[\s,;/]+/).filter(Boolean);
  const keys = [];
  for (const p of parts) {
    const k = P.normMonth(p);
    if (!k) return null;
    if (!keys.includes(k)) keys.push(k);
  }
  return keys.sort((a, b) => P.MONTH_BY_KEY[a].idx - P.MONTH_BY_KEY[b].idx).join(',');
}

/** Turn a raw import cell into the API convention (blank → undefined, #CLEAR → '') */
function fromCell(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return undefined;
    if (s.toUpperCase() === CLEAR_TOKEN) return '';
    return s;
  }
  return v;
}

module.exports = { CLEAR_TOKEN, text, yesNo, parseDate, fmtDMY, parseMonthList, fromCell };
