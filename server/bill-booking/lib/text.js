/**
 * Small text helpers shared by extraction, categorisation, account matching and duplicate checks.
 */

'use strict';

const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g;
const isGstin = s => /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(String(s || ''));
const panOf = gstin => (isGstin(gstin) ? gstin.slice(2, 12) : '');

/** Invoice numbers compared without spaces/punctuation: "INV/24-25/001" = "INV-24-25-001" */
const normInvoice = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** "05/11/2026", "5-Nov-2026", "05.11.26", "2026-11-05", "5th November 2026" → "2026-11-05" (Indian day-first) */
function parseDate(s) {
  if (!s) return '';
  const t = String(s).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2,4})\b/);
  if (m) return iso(year(m[3]), +m[2], +m[1]);
  m = t.match(/^(\d{1,2})[-/.\s,]*([a-z]{3,9})[-/.\s,']*(\d{2,4})\b/);
  if (m && monthOf(m[2])) return iso(year(m[3]), monthOf(m[2]), +m[1]);
  m = t.match(/^([a-z]{3,9})[-/.\s]*(\d{1,2}),?[-/.\s]*(\d{4})\b/);
  if (m && monthOf(m[1])) return iso(+m[3], monthOf(m[1]), +m[2]);
  return '';
}
const monthOf = w => MONTHS[w.slice(0, 4)] || MONTHS[w.slice(0, 3)];
const year = y => (String(y).length === 2 ? 2000 + Number(y) : Number(y));
function iso(y, mo, d) {
  if (!(y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "1,23,456.50" / "₹ 1,234" / "Rs.1234/-" → number (NaN when not a number) */
function parseAmount(s) {
  if (typeof s === 'number') return s;
  const t = String(s || '').replace(/[₹,\s]|rs\.?|inr|\/-/gi, '');
  const m = t.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Words that say nothing about what was bought
const STOP = new Set(('a an and the of for to in on at by with from as is are be this that being per no nos qty ' +
  'bill invoice tax gst cgst sgst igst total amount charges charge services service rs inr month monthly ' +
  'period dated date dt being towards against vide ref reference payment paid due sac hsn code rate ' +
  'jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august ' +
  'september october november december fy year').split(' '));

/** Meaningful words of a description (lower case, no numbers/dates/stop words; "repairs" → "repair") */
function tokens(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !/\d/.test(w) && !STOP.has(w))
    .map(w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

// "house keeping" on one side and "housekeeping" on the other count as the same word
function joinPairs(words, other) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (i + 1 < words.length && other.has(words[i] + words[i + 1])) { out.push(words[i] + words[i + 1]); i++; } else out.push(words[i]);
  }
  return out;
}

/** Overlap of two descriptions, 0–1 (Dice coefficient on distinct meaningful words) */
function similarity(a, b) {
  const wa = tokens(a), wb = tokens(b);
  const A = new Set(joinPairs(wa, new Set(wb)));
  const B = new Set(joinPairs(wb, A));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}

const normName = s => String(s || '').toLowerCase()
  .replace(/\b(m\/s|ms|messrs|pvt|private|ltd|limited|llp|inc|co|company|the|and|&|india)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function nameSimilarity(a, b) {
  const A = new Set(normName(a).split(' ').filter(Boolean)), B = new Set(normName(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}

module.exports = { GSTIN_RE, isGstin, panOf, normInvoice, parseDate, parseAmount, round2, tokens, similarity, normName, nameSimilarity };
