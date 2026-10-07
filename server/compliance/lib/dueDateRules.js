/**
 * Due Date Rule mini-language.
 *
 * A rule is one or more parts separated by ";". Each part is either a default expression
 * or an override for one period:   [PERIOD=]expression
 *
 *   PERIOD      APR … MAR (monthly), Q1 … Q4 (quarterly), H1 / H2 (half-yearly), FY (annual)
 *
 * Expressions
 *   11th of following month        day 11 of the month after the period ends
 *   20 of next month               same as "following month"
 *   last day of following month    last calendar day of the month after the period
 *   7th of same month              day 7 of the period's last month
 *   15th of 2 months after         day 15, two months after the period's last month
 *   31-Jul   (or 31 July)          the first 31-Jul that comes AFTER the period ends
 *
 * Examples
 *   11th of following month
 *   7th of following month; MAR=30-Apr
 *   Q1=31-Jul; Q2=31-Oct; Q3=31-Jan; Q4=31-May
 *   31-Dec                         (annual: 31-Dec after the FY ends)
 *
 * Days are clamped to the month length ("31st of following month" for January → 28/29 Feb).
 * Pure functions — no I/O.
 */

'use strict';

const P = require('./period');

const MONTH_NAME_TO_NUM = {};
for (const m of P.MONTHS) {
  MONTH_NAME_TO_NUM[m.label.toUpperCase()] = m.cal;
  MONTH_NAME_TO_NUM[m.short.toUpperCase()] = m.cal;
}
MONTH_NAME_TO_NUM.SEPT = 9;

const VALID_OVERRIDE_KEYS = new Set([...P.MONTH_KEYS, ...P.QUARTER_KEYS, ...P.HALF_KEYS, 'FY']);

/** Parse one expression (no "KEY=" prefix). Returns { expr } or { error }. */
function parseExpr(raw) {
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return { error: 'Empty rule part.' };

  // Fixed date: 31-Jul, 31 Jul, 31-July, 31/jul
  let m = s.match(/^(\d{1,2})\s*[-\s/]\s*([a-z]{3,9})$/);
  if (m) {
    const day = Number(m[1]);
    const mon = MONTH_NAME_TO_NUM[m[2].toUpperCase()];
    if (!mon) return { error: `"${m[2]}" is not a month name.` };
    if (day < 1 || day > 31) return { error: `Day ${day} is not valid.` };
    return { expr: { type: 'fixed', day, month: mon } };
  }

  // Relative: <day|last day> of <following|next|same|current|N months after> month
  m = s.match(/^(last day|\d{1,2})(?:st|nd|rd|th)? of (following month|next month|the following month|same month|current month|the same month|(\d{1,2}) months? after)$/);
  if (m) {
    const day = m[1] === 'last day' ? 'last' : Number(m[1]);
    if (day !== 'last' && (day < 1 || day > 31)) return { error: `Day ${day} is not valid.` };
    let offset;
    if (m[3] !== undefined) offset = Number(m[3]);
    else offset = /same|current/.test(m[2]) ? 0 : 1;
    if (offset > 24) return { error: 'Month offset must be 24 or less.' };
    return { expr: { type: 'relative', day, offset } };
  }

  return {
    error: `Could not understand "${raw.trim()}". Use e.g. "11th of following month", "last day of following month", "7th of same month" or "31-Jul".`,
  };
}

/**
 * Parse a full rule. Returns
 *   { ok: true, rule: { default: expr|null, overrides: { KEY: expr } } }  or
 *   { ok: false, error }
 */
function parseRule(text) {
  const src = String(text ?? '').trim();
  if (!src) return { ok: false, error: 'Due date rule is empty.' };
  const rule = { default: null, overrides: {} };
  for (const partRaw of src.split(';')) {
    const part = partRaw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq >= 0) {
      const key = part.slice(0, eq).trim().toUpperCase();
      if (!VALID_OVERRIDE_KEYS.has(key)) {
        return { ok: false, error: `"${key}" is not a valid period. Use APR–MAR, Q1–Q4, H1, H2 or FY.` };
      }
      if (rule.overrides[key]) return { ok: false, error: `Period ${key} is defined twice.` };
      const r = parseExpr(part.slice(eq + 1));
      if (r.error) return { ok: false, error: `${key}: ${r.error}` };
      rule.overrides[key] = r.expr;
    } else {
      if (rule.default) return { ok: false, error: 'Only one default expression is allowed (others need a PERIOD= prefix).' };
      const r = parseExpr(part);
      if (r.error) return { ok: false, error: r.error };
      rule.default = r.expr;
    }
  }
  if (!rule.default && !Object.keys(rule.overrides).length) return { ok: false, error: 'Due date rule is empty.' };
  return { ok: true, rule };
}

/**
 * Check that a rule covers every period of a frequency (no default + missing override → error).
 */
function checkCoverage(rule, frequency) {
  if (rule.default) return { ok: true };
  const missing = P.periodKeysOf(frequency).filter(k => !rule.overrides[k]);
  return missing.length
    ? { ok: false, error: `Rule has no default and no date for: ${missing.join(', ')}.` }
    : { ok: true };
}

/** Evaluate an expression against a period. Returns 'YYYY-MM-DD'. */
function evalExpr(expr, fy, periodKey) {
  const anchor = P.anchorMonth(periodKey);
  const cal = P.calendarOf(fy, anchor);                    // period's last month
  if (!cal) return null;
  if (expr.type === 'relative') {
    const idx = cal.year * 12 + (cal.month - 1) + expr.offset;
    const y = Math.floor(idx / 12);
    const mo = (idx % 12) + 1;
    const dim = P.daysInMonth(y, mo);
    const d = expr.day === 'last' ? dim : Math.min(expr.day, dim);
    return P.ymd(y, mo, d);
  }
  // fixed: first occurrence strictly after the period end
  const periodEnd = P.ymd(cal.year, cal.month, P.daysInMonth(cal.year, cal.month));
  for (const y of [cal.year, cal.year + 1]) {
    const d = Math.min(expr.day, P.daysInMonth(y, expr.month));
    const candidate = P.ymd(y, expr.month, d);
    if (candidate > periodEnd) return candidate;
  }
  return null;
}

/**
 * Due date for a compliance period.
 *   ruleText   the rule string from the Compliance Master
 *   fy         '2026-27'
 *   periodKey  'AUG' | 'Q1' | 'H2' | 'FY'
 * Returns { ok: true, date } or { ok: false, error }.
 */
function dueDateFor(ruleText, fy, periodKey) {
  const parsed = parseRule(ruleText);
  if (!parsed.ok) return parsed;
  const key = String(periodKey).toUpperCase();
  const expr = parsed.rule.overrides[key] || parsed.rule.default;
  if (!expr) return { ok: false, error: `Rule has no date for period ${key}.` };
  const date = evalExpr(expr, fy, key);
  return date ? { ok: true, date } : { ok: false, error: 'Could not compute a due date.' };
}

/** Validate a rule for a frequency (parse + coverage). */
function validateRule(ruleText, frequency) {
  const parsed = parseRule(ruleText);
  if (!parsed.ok) return parsed;
  const freq = P.normFrequency(frequency);
  if (freq) {
    const allowed = new Set(P.periodKeysOf(freq));
    const bad = Object.keys(parsed.rule.overrides).filter(k => !allowed.has(k));
    if (bad.length) return { ok: false, error: `${bad.join(', ')} cannot be used with a ${freq} compliance (use ${[...allowed].join(', ')}).` };
    const cov = checkCoverage(parsed.rule, freq);
    if (!cov.ok) return cov;
  }
  return { ok: true };
}

module.exports = { parseRule, parseExpr, dueDateFor, validateRule, evalExpr };
