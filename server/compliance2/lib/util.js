/**
 * Small shared helpers: hashing, ids, the clock, and date arithmetic on 'YYYY-MM-DD' strings.
 *
 * Dates are calendar dates (no time zone): every statutory date is a date in India. "Today" is the date in
 * Asia/Kolkata (UTC+05:30, no daylight saving), whatever time zone the server runs in.
 */

'use strict';

const crypto = require('crypto');

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

/** JSON with sorted keys, so equal content always hashes equal */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

const uid = (prefix = '') => `${prefix}${crypto.randomBytes(8).toString('hex')}`;
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const uniq = arr => [...new Set(arr)];
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); (m.get(k) || m.set(k, []).get(k)).push(x); } return m; };

// ── Clock (tests move it) ─────────────────────────────────────────────────────
let nowFn = () => Date.now();
const clock = { now: () => nowFn(), set(fn) { nowFn = fn || (() => Date.now()); } };
const IST_MS = 330 * 60000;
const nowIso = () => new Date(clock.now()).toISOString();
/** Today's date in Asia/Kolkata */
const todayIST = () => new Date(clock.now() + IST_MS).toISOString().slice(0, 10);
/** An instant (ms or ISO) as Indian wall-clock time 'YYYY-MM-DD HH:mm' */
const istText = t => new Date((typeof t === 'number' ? t : Date.parse(t)) + IST_MS).toISOString().slice(0, 16).replace('T', ' ');

// ── Dates ─────────────────────────────────────────────────────────────────────
const toMs = s => Date.parse(`${s}T00:00:00Z`);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toMs(s)) && new Date(toMs(s)).toISOString().slice(0, 10) === s;
const addDays = (s, n) => new Date(toMs(s) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / 86400000);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();          // m = 1..12
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function addMonths(y, m, n) { const t = y * 12 + (m - 1) + n; return [Math.floor(t / 12), (t % 12) + 1]; }
const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Indian financial year of a date: '2026-04-01' → '2026-27' */
function fyOf(date) {
  const y = +date.slice(0, 4), m = +date.slice(5, 7);
  const s = m >= 4 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}
const fyStartYear = fy => parseInt(String(fy).slice(0, 4), 10);
const validFy = fy => /^\d{4}-\d{2}$/.test(String(fy)) && (fyStartYear(fy) + 1) % 100 === +String(fy).slice(5);
const fyBounds = fy => ({ start: `${fyStartYear(fy)}-04-01`, end: `${fyStartYear(fy) + 1}-03-31` });
const nextFy = fy => { const s = fyStartYear(fy) + 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function httpError(status, message, extra) { return Object.assign(new Error(message), { status }, extra || {}); }

module.exports = {
  sha256, stable, uid, clone, uniq, groupBy, clock, nowIso, todayIST, istText, IST_MS,
  toMs, isDate, addDays, daysBetween, daysInMonth, ymd, addMonths, isLeap,
  fyOf, fyStartYear, validFy, fyBounds, nextFy, MONTHS, MONTHS_LONG, httpError,
};
