/**
 * Period logic — the single place that knows how Indian Financial Year months map to
 * Quarters and Half Years.
 *
 *   H1 = Q1 (Apr, May, Jun) + Q2 (Jul, Aug, Sep)
 *   H2 = Q3 (Oct, Nov, Dec) + Q4 (Jan, Feb, Mar)
 *
 * Rules enforced here (and relied on everywhere else):
 *   • Period identity = Company + FY + Month. Quarter and Half are ALWAYS derived from Month.
 *   • A Quarter/Half typed by a user is only ever *checked* against the Month, never trusted.
 *   • An invalid combination (e.g. August + Q1) is rejected.
 *
 * Pure functions only — no I/O. Safe to unit-test.
 */

'use strict';

// Month table in FY order. `cal` = calendar month number (1–12).
const MONTHS = [
  { key: 'APR', label: 'April',     short: 'Apr', cal: 4,  quarter: 'Q1', half: 'H1' },
  { key: 'MAY', label: 'May',       short: 'May', cal: 5,  quarter: 'Q1', half: 'H1' },
  { key: 'JUN', label: 'June',      short: 'Jun', cal: 6,  quarter: 'Q1', half: 'H1' },
  { key: 'JUL', label: 'July',      short: 'Jul', cal: 7,  quarter: 'Q2', half: 'H1' },
  { key: 'AUG', label: 'August',    short: 'Aug', cal: 8,  quarter: 'Q2', half: 'H1' },
  { key: 'SEP', label: 'September', short: 'Sep', cal: 9,  quarter: 'Q2', half: 'H1' },
  { key: 'OCT', label: 'October',   short: 'Oct', cal: 10, quarter: 'Q3', half: 'H2' },
  { key: 'NOV', label: 'November',  short: 'Nov', cal: 11, quarter: 'Q3', half: 'H2' },
  { key: 'DEC', label: 'December',  short: 'Dec', cal: 12, quarter: 'Q3', half: 'H2' },
  { key: 'JAN', label: 'January',   short: 'Jan', cal: 1,  quarter: 'Q4', half: 'H2' },
  { key: 'FEB', label: 'February',  short: 'Feb', cal: 2,  quarter: 'Q4', half: 'H2' },
  { key: 'MAR', label: 'March',     short: 'Mar', cal: 3,  quarter: 'Q4', half: 'H2' },
].map((m, idx) => ({ ...m, idx }));

const MONTH_BY_KEY = Object.fromEntries(MONTHS.map(m => [m.key, m]));
const MONTH_KEYS   = MONTHS.map(m => m.key);

const QUARTERS = {
  Q1: { key: 'Q1', half: 'H1', months: ['APR', 'MAY', 'JUN'], label: 'Q1 (Apr–Jun)' },
  Q2: { key: 'Q2', half: 'H1', months: ['JUL', 'AUG', 'SEP'], label: 'Q2 (Jul–Sep)' },
  Q3: { key: 'Q3', half: 'H2', months: ['OCT', 'NOV', 'DEC'], label: 'Q3 (Oct–Dec)' },
  Q4: { key: 'Q4', half: 'H2', months: ['JAN', 'FEB', 'MAR'], label: 'Q4 (Jan–Mar)' },
};
const QUARTER_KEYS = Object.keys(QUARTERS);

const HALVES = {
  H1: { key: 'H1', quarters: ['Q1', 'Q2'], months: [...QUARTERS.Q1.months, ...QUARTERS.Q2.months], label: 'H1 (Apr–Sep)' },
  H2: { key: 'H2', quarters: ['Q3', 'Q4'], months: [...QUARTERS.Q3.months, ...QUARTERS.Q4.months], label: 'H2 (Oct–Mar)' },
};
const HALF_KEYS = Object.keys(HALVES);

// Compliance frequencies and the period keys they produce
const FREQUENCIES = ['Monthly', 'Quarterly', 'Half-Yearly', 'Annual'];

const isAll = v => v === undefined || v === null || v === '' || String(v).toLowerCase() === 'all';

// ── Normalisers ───────────────────────────────────────────────────────────────

/** 'Aug' | 'august' | 'AUG' | 8 | '08' → 'AUG'; anything else → null */
function normMonth(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || /^\d{1,2}$/.test(String(v).trim())) {
    const n = Number(v);
    const m = MONTHS.find(x => x.cal === n);
    return m ? m.key : null;
  }
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  const m = MONTHS.find(x => x.key === s || x.label.toUpperCase() === s || x.short.toUpperCase() === s);
  return m ? m.key : null;
}

/** 'q1' | 'Q1' → 'Q1'; anything else → null */
function normQuarter(v) {
  const s = String(v ?? '').trim().toUpperCase();
  return QUARTERS[s] ? s : null;
}

/** 'h2' | 'H2' → 'H2'; anything else → null */
function normHalf(v) {
  const s = String(v ?? '').trim().toUpperCase();
  return HALVES[s] ? s : null;
}

/**
 * Normalise a Financial Year: '2026-27' | 'FY 2026-27' | '2026-2027' | 'FY2026-27' → '2026-27'.
 * Returns null when the value is not a valid consecutive-year FY.
 */
function normFY(v) {
  const s = String(v ?? '').trim().toUpperCase().replace(/^FY\s*/, '');
  const m = s.match(/^(\d{4})\s*[-–/]\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const endRaw = Number(m[2]);
  const end = m[2].length === 4 ? endRaw : Math.floor(start / 100) * 100 + endRaw + (endRaw < start % 100 ? 100 : 0);
  if (end !== start + 1) return null;
  return `${start}-${String(end).slice(2)}`;
}

function fyStartYear(fy) {
  const n = normFY(fy);
  return n ? Number(n.slice(0, 4)) : null;
}

// ── Derivations ───────────────────────────────────────────────────────────────

const quarterOf = month => MONTH_BY_KEY[normMonth(month)]?.quarter || null;
const halfOf    = month => MONTH_BY_KEY[normMonth(month)]?.half || null;
const monthLabel = month => MONTH_BY_KEY[normMonth(month)]?.label || '';

/** Calendar year + month (1–12) of an FY month. FY 2026-27 + JAN → { year: 2027, month: 1 } */
function calendarOf(fy, month) {
  const start = fyStartYear(fy);
  const m = MONTH_BY_KEY[normMonth(month)];
  if (start === null || !m) return null;
  return { year: m.cal >= 4 ? start : start + 1, month: m.cal };
}

const pad2 = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();   // m = 1..12

/** First and last calendar date of an FY month as 'YYYY-MM-DD' */
function monthRange(fy, month) {
  const c = calendarOf(fy, month);
  if (!c) return null;
  return { from: ymd(c.year, c.month, 1), to: ymd(c.year, c.month, daysInMonth(c.year, c.month)) };
}

/** FY that contains a calendar date ('YYYY-MM-DD' or Date) */
function fyOfDate(d) {
  const dt = typeof d === 'string' ? new Date(`${d}T00:00:00`) : d;
  const y = dt.getFullYear();
  const m = dt.getMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

/** FY month key of a calendar date */
function monthOfDate(d) {
  const dt = typeof d === 'string' ? new Date(`${d}T00:00:00`) : d;
  return MONTHS.find(m => m.cal === dt.getMonth() + 1).key;
}

// ── Frequency ↔ period key ────────────────────────────────────────────────────

function normFrequency(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (s === 'monthly') return 'Monthly';
  if (s === 'quarterly') return 'Quarterly';
  if (['half-yearly', 'halfyearly', 'half-year', 'semi-annual'].includes(s)) return 'Half-Yearly';
  if (['annual', 'annually', 'yearly'].includes(s)) return 'Annual';
  return null;
}

/** The period a month belongs to for a given frequency: AUG → 'AUG' | 'Q2' | 'H1' | 'FY' */
function periodKeyFor(frequency, month) {
  const m = normMonth(month);
  if (!m) return null;
  switch (normFrequency(frequency)) {
    case 'Monthly':     return m;
    case 'Quarterly':   return quarterOf(m);
    case 'Half-Yearly': return halfOf(m);
    case 'Annual':      return 'FY';
    default:            return null;
  }
}

/** Months that make up a period key: 'Q2' → [JUL, AUG, SEP]; 'AUG' → [AUG]; 'FY' → all 12 */
function periodMonths(periodKey) {
  const k = String(periodKey ?? '').toUpperCase();
  if (MONTH_BY_KEY[k]) return [k];
  if (QUARTERS[k]) return [...QUARTERS[k].months];
  if (HALVES[k]) return [...HALVES[k].months];
  if (k === 'FY') return [...MONTH_KEYS];
  return [];
}

/**
 * The month a task is filed under (its period identity month): the LAST month of its period.
 * Monthly → itself; Q1 → JUN; H1 → SEP; FY → MAR.
 */
function anchorMonth(periodKey) {
  const ms = periodMonths(periodKey);
  return ms.length ? ms[ms.length - 1] : null;
}

/** All period keys of a frequency in an FY */
function periodKeysOf(frequency) {
  switch (normFrequency(frequency)) {
    case 'Monthly':     return [...MONTH_KEYS];
    case 'Quarterly':   return [...QUARTER_KEYS];
    case 'Half-Yearly': return [...HALF_KEYS];
    case 'Annual':      return ['FY'];
    default:            return [];
  }
}

/** Human label for a task period */
function periodLabel(fy, periodKey) {
  const k = String(periodKey ?? '').toUpperCase();
  if (MONTH_BY_KEY[k]) {
    const c = calendarOf(fy, k);
    return `${MONTH_BY_KEY[k].short} ${c ? c.year : ''}`.trim();
  }
  if (QUARTERS[k]) return `${QUARTERS[k].label} ${fy}`;
  if (HALVES[k]) return `${HALVES[k].label} ${fy}`;
  if (k === 'FY') return `FY ${fy}`;
  return k;
}

// ── Selection (filter) validation ─────────────────────────────────────────────

/**
 * Validate and normalise a period selection { fy, half, quarter, month }.
 * Each of half / quarter / month may be 'All'. Returns
 *   { ok: true, selection: { fy, half, quarter, month }, months: [...] }  or
 *   { ok: false, errors: ['...'] }
 * Quarter and Half are filled in from the Month (derived, never trusted).
 */
function validateSelection(sel = {}, { requireFY = true } = {}) {
  const errors = [];
  let fy = null;
  if (!isAll(sel.fy)) {
    fy = normFY(sel.fy);
    if (!fy) errors.push(`Financial Year "${sel.fy}" is not valid (use the form 2026-27).`);
  } else if (requireFY) {
    errors.push('Financial Year is required.');
  }

  let half = null, quarter = null, month = null;
  if (!isAll(sel.half)) {
    half = normHalf(sel.half);
    if (!half) errors.push(`Half Year "${sel.half}" is not valid (use H1 or H2).`);
  }
  if (!isAll(sel.quarter)) {
    quarter = normQuarter(sel.quarter);
    if (!quarter) errors.push(`Quarter "${sel.quarter}" is not valid (use Q1–Q4).`);
  }
  if (!isAll(sel.month)) {
    month = normMonth(sel.month);
    if (!month) errors.push(`Month "${sel.month}" is not valid.`);
  }
  if (errors.length) return { ok: false, errors };

  if (month) {
    const dq = quarterOf(month), dh = halfOf(month);
    if (quarter && quarter !== dq) errors.push(`${monthLabel(month)} belongs to ${dq}, not ${quarter}.`);
    if (half && half !== dh) errors.push(`${monthLabel(month)} belongs to ${dh}, not ${half}.`);
    quarter = dq; half = dh;
  }
  if (quarter) {
    const dh = QUARTERS[quarter].half;
    if (half && half !== dh) errors.push(`${quarter} belongs to ${dh}, not ${half}.`);
    half = dh;
  }
  if (errors.length) return { ok: false, errors };

  const months = month ? [month] : quarter ? [...QUARTERS[quarter].months] : half ? [...HALVES[half].months] : [...MONTH_KEYS];
  return { ok: true, selection: { fy, half: half || 'All', quarter: quarter || 'All', month: month || 'All' }, months };
}

/** True when a month falls inside a validated selection's month list */
function monthInSelection(month, months) {
  return months.includes(normMonth(month));
}

/** Current FY + month for 'today' */
function currentPeriod(today = new Date()) {
  return { fy: fyOfDate(today), month: monthOfDate(today) };
}

/** Local date as 'YYYY-MM-DD' (no UTC shift) */
function localISODate(d = new Date()) {
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Real calendar date check for 'YYYY-MM-DD' */
function isValidISODate(s) {
  const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** Static table the client uses to drive the dependent filters (single source of truth) */
function periodMeta() {
  return {
    months: MONTHS.map(({ key, label, short, cal, quarter, half, idx }) => ({ key, label, short, cal, quarter, half, idx })),
    quarters: QUARTER_KEYS.map(k => QUARTERS[k]),
    halves: HALF_KEYS.map(k => HALVES[k]),
    frequencies: FREQUENCIES,
  };
}

module.exports = {
  MONTHS, MONTH_KEYS, MONTH_BY_KEY, QUARTERS, QUARTER_KEYS, HALVES, HALF_KEYS, FREQUENCIES,
  isAll, normMonth, normQuarter, normHalf, normFY, normFrequency, fyStartYear,
  quarterOf, halfOf, monthLabel, calendarOf, monthRange, fyOfDate, monthOfDate,
  periodKeyFor, periodMonths, anchorMonth, periodKeysOf, periodLabel,
  validateSelection, monthInSelection, currentPeriod, localISODate, isValidISODate,
  daysInMonth, ymd, periodMeta,
};
