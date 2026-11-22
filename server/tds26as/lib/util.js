/**
 * Shared helpers. Amounts inside this module are INTEGER PAISE (₹1 = 100) — parsed from their decimal text and added as integers,
 * so ₹118.75 + ₹118.76 is exactly ₹237.51. The paise and hashing helpers are the GSTR-2B module's, unchanged.
 */

'use strict';

const money = require('../../gstr2b/lib/money');
const base = require('../../gstr2b/lib/util');

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/;
const normPan = v => String(v || '').toUpperCase().replace(/\s/g, '');
const normTan = v => String(v || '').toUpperCase().replace(/[\s-]/g, '');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
const validYmd = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

/** "15-Apr-2026", "15-04-2026", "15/04/2026", "2026-04-15", an Excel serial or a Date → "2026-04-15"; null when it is not a date */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === 'number' && v > 20000 && v < 80000) { const t = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000); return parseDate(t); }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return validYmd(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,4})[-/. ,]*(\d{4})$/);
  if (m) { const mo = MONTHS[m[2].toLowerCase()]; return mo && validYmd(+m[3], mo, +m[1]) ? `${m[3]}-${pad(mo)}-${pad(m[1])}` : null; }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return validYmd(+m[3], +m[2], +m[1]) ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null;
  return null;
}

const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);   // b − a
const fmtR = p => `₹${money.fmtINR(p)}`;
const pct = (num, den) => (den ? Math.round((num / den) * 10000) / 100 : null);          // 2-decimal percentage

module.exports = { ...base, ...money, PAN_RE, TAN_RE, normPan, normTan, parseDate, todayIST, daysBetween, fmtR, pct };
