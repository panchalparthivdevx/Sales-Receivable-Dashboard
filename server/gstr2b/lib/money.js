/**
 * Decimal arithmetic for GSTR-2B Reco.
 *
 * Every amount inside this module is an INTEGER NUMBER OF PAISE (₹1 = 100). Amounts are parsed from
 * their decimal text, added and compared as integers, and turned back into rupees only for display —
 * so a sum of 118.75 + 118.76 is exactly 237.51, never 237.50999999999996.
 */

'use strict';

/** Zoho / portal value (number, "1,234.50", "(12.00)", null) → integer paise; null when there is no value */
function toPaise(v) {
  if (v === null || v === undefined || v === '') return null;
  let s;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    s = Math.abs(v) < 1e-6 || Math.abs(v) >= 1e15 ? v.toFixed(6) : String(v);
    if (/e/i.test(s)) s = v.toFixed(6);
  } else {
    s = String(v).trim();
  }
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }           // accounting negative: (12.00)
  s = s.replace(/[₹,\s]|INR|Rs\.?/gi, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [int, frac = ''] = s.split('.');
  const f3 = (frac + '000').slice(0, 3);
  let paise = Number(int || '0') * 100 + Number(f3.slice(0, 2));
  if (Number(f3[2]) >= 5) paise += 1;                                   // half-up on the third decimal
  return neg ? -paise : paise;
}

/** Missing amounts count as zero (for components that are simply absent, e.g. no CESS) */
const p0 = v => (toPaise(v) ?? 0);

const sum = (...xs) => xs.reduce((a, b) => a + (b || 0), 0);
const sumBy = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

/** paise → rupees as a number with 2 decimals (for JSON consumers that want rupees) */
const toRupees = p => (p === null || p === undefined ? null : Math.round(p) / 100);

/** paise → "1,23,456.78" (Indian grouping), "-" for null */
function fmtINR(p, { sign = false } = {}) {
  if (p === null || p === undefined) return '—';
  const neg = p < 0;
  const abs = Math.abs(Math.round(p));
  const rupees = String(Math.floor(abs / 100));
  const frac = String(abs % 100).padStart(2, '0');
  let g = rupees;
  if (rupees.length > 3) {
    const last3 = rupees.slice(-3);
    const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    g = `${rest},${last3}`;
  }
  return `${neg ? '-' : (sign && abs ? '+' : '')}${g}.${frac}`;
}

/** |a − b| ≤ tolerance, all in paise */
const within = (diffP, tolP) => Math.abs(diffP) <= tolP;

/** The five tax components every document carries, in one fixed order */
const COMPONENTS = ['taxable', 'igst', 'cgst', 'sgst', 'cess'];
const TAX_COMPONENTS = ['igst', 'cgst', 'sgst', 'cess'];

const zeroAmounts = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
const taxOf = a => (a.igst || 0) + (a.cgst || 0) + (a.sgst || 0) + (a.cess || 0);
const addAmounts = (a, b) => { const o = {}; for (const c of COMPONENTS) o[c] = (a[c] || 0) + (b[c] || 0); return o; };
const diffAmounts = (a, b) => { const o = {}; for (const c of COMPONENTS) o[c] = (a[c] || 0) - (b[c] || 0); return o; };   // a − b

module.exports = { toPaise, p0, sum, sumBy, toRupees, fmtINR, within, COMPONENTS, TAX_COMPONENTS, zeroAmounts, taxOf, addAmounts, diffAmounts };
