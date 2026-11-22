/**
 * Indian financial years and quarters. FY key "2026-27" = 1 Apr 2026 – 31 Mar 2027.
 * Q1 Apr–Jun · Q2 Jul–Sep · Q3 Oct–Dec · Q4 Jan–Mar. Quarter key "2026-27-Q1".
 *
 * Deductors file the quarterly TDS statement (Form 26Q/24Q/27Q) by 31 Jul, 31 Oct, 31 Jan and 31 May (Rule 31A); a credit for a quarter
 * normally reaches Form 26AS only after that. A statement whose "data updated till" date is before that day can therefore not show the
 * quarter completely — the reconciliation treats it as a coverage gap instead of calling the Books entries "Not in 26AS".
 */

'use strict';

const pad = n => String(n).padStart(2, '0');
const fyStartYear = iso => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); return m >= 4 ? y : y - 1; };
const fyKey = startYear => `${startYear}-${pad((startYear + 1) % 100)}`;
const fyOf = iso => fyKey(fyStartYear(iso));
const fyStart = fy => +String(fy).slice(0, 4);
const isFy = fy => /^\d{4}-\d{2}$/.test(String(fy)) && (fyStart(fy) + 1) % 100 === +String(fy).slice(5, 7);
const fyRange = fy => ({ from: `${fyStart(fy)}-04-01`, to: `${fyStart(fy) + 1}-03-31` });
const qOfMonth = m => (m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4);
const quarterOf = iso => `${fyOf(iso)}-Q${qOfMonth(+iso.slice(5, 7))}`;
const parseQ = key => { const m = String(key).match(/^(\d{4}-\d{2})-Q([1-4])$/); return m ? { fy: m[1], q: +m[2] } : null; };
function quarterRange(fy, q) {
  const s = fyStart(fy);
  return [null, { from: `${s}-04-01`, to: `${s}-06-30` }, { from: `${s}-07-01`, to: `${s}-09-30` }, { from: `${s}-10-01`, to: `${s}-12-31` }, { from: `${s + 1}-01-01`, to: `${s + 1}-03-31` }][q];
}
function filingDue(fy, q) { const s = fyStart(fy); return [null, `${s}-07-31`, `${s}-10-31`, `${s + 1}-01-31`, `${s + 1}-05-31`][q]; }
const qLabel = key => { const p = parseQ(key); return p ? `Q${p.q} FY ${p.fy}` : key; };
const nextQuarter = key => { const p = parseQ(key); return p.q < 4 ? `${p.fy}-Q${p.q + 1}` : `${fyKey(fyStart(p.fy) + 1)}-Q1`; };
const cmpQ = (a, b) => (a === b ? 0 : a < b ? -1 : 1);             // "2025-26-Q4" < "2026-27-Q1" as strings

/** Every quarter key touching [from, to] */
function quartersBetween(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let k = quarterOf(from); ; k = nextQuarter(k)) { out.push(k); const p = parseQ(k); if (quarterRange(p.fy, p.q).to >= to) break; if (out.length > 200) break; }
  return out;
}
/** Every "YYYY-MM" touching [from, to] */
function monthsBetween(from, to) {
  const out = [];
  let y = +from.slice(0, 4), m = +from.slice(5, 7);
  const ey = +to.slice(0, 4), em = +to.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } if (out.length > 400) break; }
  return out;
}
const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };

/**
 * The period asked for → { from, to, label, kind }. Accepts { fy, q } (q = 1–4 or 'all'), or a custom { from, to }.
 * A custom range must lie inside one financial year's statements or span several — both are allowed; the label says which.
 */
function resolve({ fy, q, from, to } = {}) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (from && to && iso.test(from) && iso.test(to)) {
    if (from > to) throw Object.assign(new Error('The "from" date is after the "to" date'), { status: 400 });
    return { from, to, kind: 'custom', label: `${from} to ${to}` };
  }
  if (!isFy(fy)) throw Object.assign(new Error('Choose a financial year (for example 2026-27) or a custom date range'), { status: 400 });
  const qq = q === undefined || q === '' || q === 'all' || q === null ? null : Number(q);
  if (qq !== null && ![1, 2, 3, 4].includes(qq)) throw Object.assign(new Error('Quarter must be 1, 2, 3 or 4'), { status: 400 });
  if (qq) { const r = quarterRange(fy, qq); return { ...r, kind: 'quarter', fy, q: qq, label: `Q${qq} FY ${fy}` }; }
  return { ...fyRange(fy), kind: 'fy', fy, label: `FY ${fy}` };
}

module.exports = { fyOf, fyKey, fyStart, isFy, fyRange, quarterOf, parseQ, quarterRange, filingDue, qLabel, nextQuarter, cmpQ, quartersBetween, monthsBetween, monthEnd, resolve };
