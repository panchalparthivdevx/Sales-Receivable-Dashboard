/**
 * Months and financial years (April–March), in India time. A month is "YYYY-MM"; a financial year is "2026-27".
 */

'use strict';

const pad = n => String(n).padStart(2, '0');

/** Today in India (YYYY-MM-DD), whatever the server's own time zone */
function todayIST(now = new Date()) {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}

const monthOf = d => String(d || '').slice(0, 7);
const isMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

/** "2026-11" → "2026-11-01" / "2026-11-30" */
const monthStart = m => `${m}-01`;
function monthEnd(m) {
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m}-${pad(last)}`;
}
function addMonths(m, n) {
  const [y, mo] = m.split('-').map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
const monthDiff = (a, b) => { const [ya, ma] = a.split('-').map(Number); const [yb, mb] = b.split('-').map(Number); return (yb - ya) * 12 + (mb - ma); };

/** Financial year of a month or date: "2026-11" → "2026-27", "2027-02" → "2026-27" */
function fyOf(dOrM) {
  const [y, m] = String(dOrM).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${pad((start + 1) % 100)}`;
}
const isFy = fy => /^\d{4}-\d{2}$/.test(String(fy || '')) && (Number(fy.slice(0, 4)) + 1) % 100 === Number(fy.slice(5));
/** The twelve months of a financial year, April first */
function fyMonths(fy) {
  const y = Number(fy.slice(0, 4));
  return Array.from({ length: 12 }, (_, i) => addMonths(`${y}-04`, i));
}
const fyStart = fy => `${fy.slice(0, 4)}-04-01`;
const fyEnd = fy => `${Number(fy.slice(0, 4)) + 1}-03-31`;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11" → "Nov-26" (the user's sheet headings) */
const label = m => `${MONTH_NAMES[Number(m.slice(5)) - 1]}-${m.slice(2, 4)}`;
const longLabel = m => `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;

/** Days from date a to date b (b − a) */
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

module.exports = { todayIST, monthOf, isMonth, isDate, monthStart, monthEnd, addMonths, monthDiff, fyOf, isFy, fyMonths, fyStart, fyEnd, label, longLabel, daysBetween, MONTH_NAMES };
