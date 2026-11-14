/**
 * Financial Reporting — reporting periods (Indian financial year, April–March).
 *
 * A period is identified by what a column header SAYS (its "QUARTER ENDED / HALF YEAR ENDED / YEAR ENDED /
 * NINE MONTHS ENDED / PERIOD ENDED / AS AT" wording and its date), never by a file or sheet name.
 *
 * Period ids:  FY2027-Q2   quarter Jul–Sep 2026          FY2027-H1   half year Apr–Sep 2026
 *              FY2026-9M   nine months Apr–Dec 2025      FY2026-FY   year Apr 2025–Mar 2026
 *              FY2026-H2   half year Oct 2025–Mar 2026   BS-2026-09-30  balance sheet as at 30 Sep 2026
 * "FY2027" is the financial year 2026-27 (named by the year it ends in).
 */

'use strict';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Calendar date → 'YYYY-MM-DD' (Excel dates arrive as JS Dates at local midnight or as serial numbers) */
function dateToIso(d) {
  if (!(d instanceof Date) || isNaN(d) || d.getFullYear() < 1990) return null;
  // SheetJS builds dates at local midnight; a few seconds of float error can push them back a day
  const t = new Date(d.getTime() + 12 * 3600 * 1000);
  return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

/**
 * Find a calendar date in header text: "30/09/2026", "September 30,2026", "March 31, 2026", "31st March, 2025",
 * "30th September, 2024", "31-03-2026". Returns 'YYYY-MM-DD' or null.
 */
function parseDateText(s) {
  if (s == null) return null;
  const t = String(s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  let m = t.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if (m) {
    const d = +m[1], mo = +m[2], y = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= lastDay(y, mo)) return iso(y, mo, d);
  }
  m = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    const mo = MONTHS[m[1].toLowerCase()], d = +m[2], y = +m[3];
    if (d >= 1 && d <= lastDay(y, mo)) return iso(y, mo, d);
  }
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})\b/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const mo = MONTHS[m[2].toLowerCase()], d = +m[1], y = +m[3];
    if (d >= 1 && d <= lastDay(y, mo)) return iso(y, mo, d);
  }
  return null;
}

/**
 * Headings without a full date, used in consolidation workings:
 *   "2025-26" / "FY 2025-26"  → the financial year ending 31 March 2026      → { date, form: 'fylabel' }
 *   "June 2026"               → the month ending 30 June 2026               → { date, form: 'monthyear' }
 * The whole cell must be just that, so ordinary text is never misread.
 */
function parseLooseHeading(s) {
  const t = String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  let m = t.match(/^(?:f\.?y\.?\s*)?(20\d\d)\s*[-–/]\s*(\d\d)$/i);
  if (m && (+m[1] + 1) % 100 === +m[2]) return { date: iso(+m[1] + 1, 3, 31), form: 'fylabel' };
  m = t.match(/^([A-Za-z]{3,9})\.?\s*,?\s*(20\d\d)$/);
  if (m && MONTHS[m[1].toLowerCase()]) { const mo = MONTHS[m[1].toLowerCase()], y = +m[2]; return { date: iso(y, mo, lastDay(y, mo)), form: 'monthyear' }; }
  return null;
}

/** The wording of a header that tells what kind of period a column is */
function parseKind(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, ' ');
  if (/\bas at\b|\bas on\b/.test(t)) return 'asat';
  if (/quarter ended|quarter ending|three months ended/.test(t)) return 'quarter';
  if (/half[- ]?year ended|half[- ]?year ending|six months ended/.test(t)) return 'half';
  if (/nine months? ended|\b9 ?m\b|nine month/.test(t)) return 'nine';
  if (/year ended|year ending|\bfy\b/.test(t)) return 'year';
  if (/period ended|for the period/.test(t)) return 'period';
  return null;
}

const fyOf = endIso => { const [y, m] = endIso.split('-').map(Number); return m >= 4 ? y + 1 : y; };
const fyLabel = fy => `FY${fy - 1}-${String(fy).slice(2)}`;
const fyShort = fy => `FY${String(fy).slice(2)}`;
const quarterOf = endIso => ({ 6: 1, 9: 2, 12: 3, 3: 4 })[+endIso.slice(5, 7)] || null;

function addMonthsStart(endIso, months) {
  // first day of the period that ends on endIso (a month end) and spans `months` months
  let [y, m] = endIso.split('-').map(Number);
  m -= months - 1;
  while (m <= 0) { m += 12; y -= 1; }
  return iso(y, m, 1);
}
const fyStart = fy => iso(fy - 1, 4, 1);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

/**
 * Build the period from a header's kind and end date. Returns null when the two do not describe a known
 * financial reporting period (e.g. a quarter that does not end in Jun/Sep/Dec/Mar).
 */
function makePeriod(kind, endIso) {
  if (!endIso) return null;
  const mo = +endIso.slice(5, 7);
  const isMonthEnd = +endIso.slice(8, 10) === lastDay(+endIso.slice(0, 4), mo);
  const fy = fyOf(endIso);
  if (kind === 'asat') return withLabels({ id: `BS-${endIso}`, type: 'BS', fy, start: null, end: endIso, months: 0 });
  if (!isMonthEnd) return null;
  // "period ended" is cumulative from the start of the financial year
  let k = kind;
  if (k === 'period') k = mo === 3 ? 'year' : mo === 9 ? 'half' : mo === 12 ? 'nine' : mo === 6 ? 'quarter' : null;
  if (k === 'quarter') {
    if (![3, 6, 9, 12].includes(mo)) return null;
    const q = quarterOf(endIso);
    return withLabels({ id: `FY${fy}-Q${q}`, type: 'Q', q, fy, start: addMonthsStart(endIso, 3), end: endIso, months: 3 });
  }
  if (k === 'half') {
    if (mo === 9) return withLabels({ id: `FY${fy}-H1`, type: 'H', h: 1, fy, start: fyStart(fy), end: endIso, months: 6 });
    if (mo === 3) return withLabels({ id: `FY${fy}-H2`, type: 'H', h: 2, fy, start: addMonthsStart(endIso, 6), end: endIso, months: 6 });
    return null;
  }
  if (k === 'nine') return mo === 12 ? withLabels({ id: `FY${fy}-9M`, type: '9M', fy, start: fyStart(fy), end: endIso, months: 9 }) : null;
  if (k === 'year') return mo === 3 ? withLabels({ id: `FY${fy}-FY`, type: 'FY', fy, start: fyStart(fy), end: endIso, months: 12 }) : null;
  return null;
}

/** Period from its id (for derived periods and filters) */
function fromId(id) {
  let m = String(id).match(/^BS-(\d{4}-\d{2}-\d{2})$/);
  if (m) return makePeriod('asat', m[1]);
  m = String(id).match(/^FY(\d{4})-(Q[1-4]|H[12]|9M|FY)$/);
  if (!m) return null;
  const fy = +m[1], k = m[2];
  if (k[0] === 'Q') { const q = +k[1]; const end = { 1: iso(fy - 1, 6, 30), 2: iso(fy - 1, 9, 30), 3: iso(fy - 1, 12, 31), 4: iso(fy, 3, 31) }[q]; return makePeriod('quarter', end); }
  if (k === 'H1') return makePeriod('half', iso(fy - 1, 9, 30));
  if (k === 'H2') return makePeriod('half', iso(fy, 3, 31));
  if (k === '9M') return makePeriod('nine', iso(fy - 1, 12, 31));
  return makePeriod('year', iso(fy, 3, 31));
}

function withLabels(p) {
  const d = p.end;
  const [y, m, dd] = d.split('-');
  const human = `${dd}/${m}/${y}`;
  p.days = p.type === 'BS' ? 0 : daysBetween(p.start, p.end);
  if (p.type === 'BS') { p.label = `As at ${human}`; p.short = `${dd}-${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m]}-${y.slice(2)}`; }
  else if (p.type === 'Q') { p.label = `Q${p.q} ${fyLabel(p.fy)} (quarter ended ${human})`; p.short = `Q${p.q} ${fyShort(p.fy)}`; }
  else if (p.type === 'H') { p.label = `H${p.h} ${fyLabel(p.fy)} (half year ended ${human})`; p.short = `H${p.h} ${fyShort(p.fy)}`; }
  else if (p.type === '9M') { p.label = `9M ${fyLabel(p.fy)} (nine months ended ${human})`; p.short = `9M ${fyShort(p.fy)}`; }
  else { p.label = `${fyLabel(p.fy)} (year ended ${human})`; p.short = fyShort(p.fy); }
  p.colType = { BS: 'As at', Q: 'Quarter ended', H: 'Half year ended', '9M': 'Nine months ended', FY: 'Year ended' }[p.type];
  p.headerDate = human;
  return p;
}

/** Sort order: by end date, then shorter period first (Q before H before 9M before FY at the same end) */
const ORDER = { Q: 1, H: 2, '9M': 3, FY: 4, BS: 0 };
function cmp(a, b) {
  const pa = typeof a === 'string' ? fromId(a) : a, pb = typeof b === 'string' ? fromId(b) : b;
  if (!pa || !pb) return 0;
  if (pa.end !== pb.end) return pa.end < pb.end ? -1 : 1;
  return (ORDER[pa.type] || 9) - (ORDER[pb.type] || 9);
}

/** The balance sheet date at the end of a flow period, and the one at its start (the day before) */
const bsAtEnd = p => `BS-${p.end}`;
function bsAtStart(p) {
  if (!p.start) return null;
  const d = new Date(Date.parse(p.start) - 86400000);
  return `BS-${d.toISOString().slice(0, 10)}`;
}

module.exports = { parseDateText, parseLooseHeading, parseKind, dateToIso, makePeriod, fromId, cmp, fyOf, fyLabel, fyShort, quarterOf, bsAtEnd, bsAtStart, daysBetween, iso };
