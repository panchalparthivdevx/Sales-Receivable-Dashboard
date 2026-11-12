/**
 * GST identity, date and document-number helpers for GSTR-2B Reco.
 *
 * Original values are always kept next to the normalised ones; nothing here rewrites a source value.
 */

'use strict';

// ── States ────────────────────────────────────────────────────────────────────
// GST state code, the 2-letter code Zoho Books uses for place of supply, and the name.
const STATE_TABLE = [
  ['01', 'JK', 'Jammu & Kashmir'], ['02', 'HP', 'Himachal Pradesh'], ['03', 'PB', 'Punjab'], ['04', 'CH', 'Chandigarh'],
  ['05', 'UK', 'Uttarakhand'], ['06', 'HR', 'Haryana'], ['07', 'DL', 'Delhi'], ['08', 'RJ', 'Rajasthan'],
  ['09', 'UP', 'Uttar Pradesh'], ['10', 'BR', 'Bihar'], ['11', 'SK', 'Sikkim'], ['12', 'AR', 'Arunachal Pradesh'],
  ['13', 'NL', 'Nagaland'], ['14', 'MN', 'Manipur'], ['15', 'MZ', 'Mizoram'], ['16', 'TR', 'Tripura'],
  ['17', 'ML', 'Meghalaya'], ['18', 'AS', 'Assam'], ['19', 'WB', 'West Bengal'], ['20', 'JH', 'Jharkhand'],
  ['21', 'OD', 'Odisha'], ['22', 'CG', 'Chhattisgarh'], ['23', 'MP', 'Madhya Pradesh'], ['24', 'GJ', 'Gujarat'],
  ['25', 'DD', 'Daman & Diu'], ['26', 'DN', 'Dadra & Nagar Haveli and Daman & Diu'], ['27', 'MH', 'Maharashtra'],
  ['29', 'KA', 'Karnataka'], ['30', 'GA', 'Goa'], ['31', 'LD', 'Lakshadweep'], ['32', 'KL', 'Kerala'],
  ['33', 'TN', 'Tamil Nadu'], ['34', 'PY', 'Puducherry'], ['35', 'AN', 'Andaman & Nicobar Islands'],
  ['36', 'TS', 'Telangana'], ['37', 'AP', 'Andhra Pradesh'], ['38', 'LA', 'Ladakh'], ['97', 'OT', 'Other Territory'],
  ['99', 'CJ', 'Centre Jurisdiction'],
];
const ALIAS = { UT: '05', OR: '21', DH: '26', PO: '34', TG: '36' };            // other spellings seen in exports
const BY_NUM = new Map(STATE_TABLE.map(([n, c, name]) => [n, { num: n, code: c, name }]));
const BY_CODE = new Map(STATE_TABLE.map(([n, c]) => [c, n]));
const BY_NAME = new Map(STATE_TABLE.map(([n, , name]) => [name.toUpperCase(), n]));

/** "24", "GJ", "Gujarat", "24-Gujarat" → "24" (GST state code) or null */
function stateNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  const lead = s.match(/^(\d{2})\b/);
  if (lead && BY_NUM.has(lead[1])) return lead[1];
  if (BY_CODE.has(s)) return BY_CODE.get(s);
  if (ALIAS[s]) return ALIAS[s];
  if (BY_NAME.has(s)) return BY_NAME.get(s);
  const dash = s.match(/^\d{2}\s*[-–]/);
  return dash ? stateNum(s.slice(0, 2)) : null;
}
const stateInfo = v => { const n = stateNum(v); return n ? BY_NUM.get(n) : null; };

// ── GSTIN / PAN ───────────────────────────────────────────────────────────────
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_LIKE = /^\d{2}[A-Z0-9]{13}$/;
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const normGstin = s => String(s ?? '').toUpperCase().replace(/[\s\-]/g, '');

/** Official check character (position 15) for the first 14 characters */
function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = CHARSET.indexOf(first14[i]);
    if (code < 0) return null;
    const prod = code * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/**
 * Everything knowable from the GSTIN text alone. `valid` = right shape AND check character correct AND a
 * real state code. Format-valid but checksum-invalid GSTINs are typos, flagged "Invalid GSTIN".
 */
function gstinInfo(raw) {
  const gstin = normGstin(raw);
  const out = { gstin, present: !!gstin, format_ok: false, checksum_ok: false, state_ok: false, valid: false, state_num: null, state: null, pan: null };
  if (!gstin) return out;
  out.format_ok = GSTIN_RE.test(gstin);
  if (!out.format_ok) return out;
  out.checksum_ok = gstinCheckChar(gstin.slice(0, 14)) === gstin[14];
  const st = BY_NUM.get(gstin.slice(0, 2));
  out.state_ok = !!st;
  out.state_num = gstin.slice(0, 2);
  out.state = st ? st.code : null;
  out.pan = gstin.slice(2, 12);
  out.valid = out.format_ok && out.checksum_ok && out.state_ok;
  return out;
}
const isValidGstin = g => gstinInfo(g).valid;
const panOf = g => { const i = gstinInfo(g); return i.format_ok ? i.pan : null; };

// ── Document numbers ──────────────────────────────────────────────────────────
/** Conservative normalisation: case, spaces and punctuation only. Leading zeros are KEPT. */
const normDocNo = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Looser key used only to SUGGEST candidates: also ignores leading zeros inside every number run */
function docNoCore(s) {
  const tokens = String(s ?? '').toUpperCase().match(/[A-Z]+|\d+/g) || [];
  return tokens.map(t => (/^\d/.test(t) ? t.replace(/^0+(?=\d)/, '') : t)).join('');
}

/** Bounded Levenshtein distance; returns max+1 as soon as it is certain to exceed max */
function editDistance(a, b, max = 2) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// ── Dates and periods ─────────────────────────────────────────────────────────
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12 };
const pad2 = n => String(n).padStart(2, '0');

function validYmd(y, m, d) {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad2(m)}-${pad2(d)}` : null;
}

/** GST portal "25-08-2026", "25/08/2026", ISO, "25-Aug-2026", Excel serial, Date → "YYYY-MM-DD" or null */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;                                   // not a plausible Excel serial
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return validYmd(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (m) return validYmd(2000 + +m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-/\s.]([A-Za-z]{3,9})[-/\s.,]*(\d{2,4})$/);
  if (m && MONTHS[m[2].toUpperCase()]) return validYmd(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS[m[2].toUpperCase()], +m[1]);
  return null;
}

const periodOfDate = iso => (iso ? iso.slice(0, 7) : null);                      // "2026-10"
/** Financial-year start year of a date or "YYYY-MM" period (April–March) */
function fyStart(isoOrPeriod) {
  if (!isoOrPeriod) return null;
  const y = +isoOrPeriod.slice(0, 4), m = +isoOrPeriod.slice(5, 7);
  return m >= 4 ? y : y - 1;
}
const fyLabel = isoOrPeriod => { const s = fyStart(isoOrPeriod); return s === null ? null : `${s}-${String(s + 1).slice(2)}`; };
const fyRange = label => { const s = +label.slice(0, 4); return { from: `${s}-04-01`, to: `${s + 1}-03-31` }; };
const quarterOf = period => { const m = +period.slice(5, 7); return `Q${Math.floor(((m + 8) % 12) / 3) + 1}`; };   // Apr–Jun = Q1
const halfOf = period => { const m = +period.slice(5, 7); return m >= 4 && m <= 9 ? 'H1' : 'H2'; };
const monthIndex = period => (period ? +period.slice(0, 4) * 12 + (+period.slice(5, 7) - 1) : null);
/** "102026" (GST return period) → "2026-10" */
const rtnprdToPeriod = s => (/^\d{6}$/.test(String(s)) ? `${String(s).slice(2)}-${String(s).slice(0, 2)}` : null);
const periodToRtnprd = p => `${p.slice(5, 7)}${p.slice(0, 4)}`;
/** "Oct-2026", "October 2026", "10/2026", "2026-10" → "2026-10" */
function parsePeriod(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})$/); if (m && +m[2] >= 1 && +m[2] <= 12) return s;
  m = s.match(/^(\d{2})[-/ ]?(\d{4})$/); if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${m[1]}`;
  m = s.match(/^([A-Za-z]{3,9})[-/\s,.]*(\d{4})$/); if (m && MONTHS[m[1].toUpperCase()]) return `${m[2]}-${pad2(MONTHS[m[1].toUpperCase()])}`;
  return null;
}
const todayIST = (now = Date.now()) => new Date(now + 330 * 60000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);   // b − a

const DOC_TYPES = { INV: 'Invoice', CRN: 'Credit note', DBN: 'Debit note' };

module.exports = {
  STATE_TABLE, stateNum, stateInfo,
  GSTIN_RE, GSTIN_LIKE, normGstin, gstinCheckChar, gstinInfo, isValidGstin, panOf,
  normDocNo, docNoCore, editDistance,
  parseDate, periodOfDate, fyStart, fyLabel, fyRange, quarterOf, halfOf, monthIndex, rtnprdToPeriod, periodToRtnprd, parsePeriod,
  todayIST, daysBetween, DOC_TYPES,
};
