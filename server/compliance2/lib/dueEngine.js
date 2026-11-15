/**
 * Periods and statutory due dates.
 *
 * Period keys (a task's period identity):
 *   M:2026-04             a month
 *   Q:2026-27:Q1          a quarter of a financial year (Q1 = Apr–Jun)
 *   H:2026-27:H1          a half year (H1 = Apr–Sep)
 *   Y:2026-27             a financial year
 *   I:2026-27:2           instalment 2 of a financial year (advance tax)
 *   E:<event id>          one event (AGM, notice, cancellation, material event …)
 *   R:<scope id>:<date>   one renewal (licence / certificate expiring on <date>)
 *
 * A due-date expression is plain data (never code) — see EXPR_TYPES. Rules on purpose:
 *   • no weekend / holiday roll-forward: a date that falls on a Sunday stays on that Sunday;
 *   • a day that does not exist in a month (31 June, 29 Feb 2027) is an error, unless the rule says clamp: true —
 *     never silently moved;
 *   • an expression that cannot give a date (no event recorded yet, state not in a table, manual rule) returns no date
 *     and says why — such a task is "no due date", never overdue.
 */

'use strict';

const U = require('./util');

// per_registration: the registration's own filing frequency (Professional Tax, LWF — it differs by state and registration)
const FREQUENCIES = ['monthly', 'quarterly', 'half_yearly', 'annual', 'installments', 'event', 'renewal', 'transaction', 'per_registration'];
const QUARTER_OF_MONTH = m => (m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 && m <= 12 ? 'Q3' : 'Q4');
const HALF_OF_MONTH = m => (m >= 4 && m <= 9 ? 'H1' : 'H2');

/** Months of a financial year as [year, month] pairs, April first */
function fyMonths(fy) {
  const s = U.fyStartYear(fy);
  return Array.from({ length: 12 }, (_, i) => U.addMonths(s, 4, i));
}

function monthPeriod(y, m) {
  const fy = U.fyOf(U.ymd(y, m, 1));
  const q = QUARTER_OF_MONTH(m);
  const qStartMonth = { Q1: 4, Q2: 7, Q3: 10, Q4: 1 }[q];
  return {
    key: `M:${U.ymd(y, m, 1).slice(0, 7)}`, kind: 'month', fy, label: `${U.MONTHS[m - 1]} ${y}`,
    start: U.ymd(y, m, 1), end: U.ymd(y, m, U.daysInMonth(y, m)), quarter: q, half: HALF_OF_MONTH(m),
    month_in_quarter: m - qStartMonth + 1, end_month: m,
  };
}

function quarterPeriod(fy, q) {
  const s = U.fyStartYear(fy);
  const [y1, m1] = { Q1: [s, 4], Q2: [s, 7], Q3: [s, 10], Q4: [s + 1, 1] }[q];
  const [y3, m3] = U.addMonths(y1, m1, 2);
  const names = { Q1: 'Apr–Jun', Q2: 'Jul–Sep', Q3: 'Oct–Dec', Q4: 'Jan–Mar' };
  return { key: `Q:${fy}:${q}`, kind: 'quarter', fy, label: `${q} ${names[q]} FY ${fy}`, start: U.ymd(y1, m1, 1), end: U.ymd(y3, m3, U.daysInMonth(y3, m3)), quarter: q, half: q === 'Q1' || q === 'Q2' ? 'H1' : 'H2', end_month: m3 };
}

function halfPeriod(fy, h) {
  const s = U.fyStartYear(fy);
  return h === 'H1'
    ? { key: `H:${fy}:H1`, kind: 'half', fy, label: `H1 Apr–Sep FY ${fy}`, start: `${s}-04-01`, end: `${s}-09-30`, half: 'H1', end_month: 9 }
    : { key: `H:${fy}:H2`, kind: 'half', fy, label: `H2 Oct–Mar FY ${fy}`, start: `${s}-10-01`, end: `${s + 1}-03-31`, half: 'H2', end_month: 3 };
}

function yearPeriod(fy) { const b = U.fyBounds(fy); return { key: `Y:${fy}`, kind: 'year', fy, label: `FY ${fy}`, start: b.start, end: b.end, end_month: 3 }; }

/**
 * The periods of one financial year for a frequency. opts.months_in_quarter: [1, 2] keeps only the first two months of
 * each quarter (IFF, PMT-06). opts.installments: how many instalments (advance tax: 4).
 */
function periodsOf(frequency, fy, opts = {}) {
  if (!U.validFy(fy)) throw U.httpError(400, `"${fy}" is not a financial year (use e.g. 2026-27)`);
  switch (frequency) {
    case 'monthly': {
      const all = fyMonths(fy).map(([y, m]) => monthPeriod(y, m));
      return opts.months_in_quarter?.length ? all.filter(p => opts.months_in_quarter.includes(p.month_in_quarter)) : all;
    }
    case 'quarterly': return ['Q1', 'Q2', 'Q3', 'Q4'].map(q => quarterPeriod(fy, q));
    case 'half_yearly': return ['H1', 'H2'].map(h => halfPeriod(fy, h));
    case 'annual': return [yearPeriod(fy)];
    case 'installments': {
      const n = opts.installments || 4;
      const b = U.fyBounds(fy);
      return Array.from({ length: n }, (_, i) => ({ key: `I:${fy}:${i + 1}`, kind: 'installment', fy, label: `Instalment ${i + 1} FY ${fy}`, start: b.start, end: b.end, installment: i + 1, end_month: 3 }));
    }
    default: return [];                                   // event / renewal / transaction: no calendar periods
  }
}

/** Rebuild a calendar period from its key (event and renewal periods are built by the task generator) */
function periodFromKey(key) {
  let m;
  if ((m = /^M:(\d{4})-(\d{2})$/.exec(key))) return monthPeriod(+m[1], +m[2]);
  if ((m = /^Q:(\d{4}-\d{2}):(Q[1-4])$/.exec(key))) return quarterPeriod(m[1], m[2]);
  if ((m = /^H:(\d{4}-\d{2}):(H[12])$/.exec(key))) return halfPeriod(m[1], m[2]);
  if ((m = /^Y:(\d{4}-\d{2})$/.exec(key))) return yearPeriod(m[1]);
  if ((m = /^I:(\d{4}-\d{2}):(\d+)$/.exec(key))) return periodsOf('installments', m[1], { installments: Math.max(4, +m[2]) })[+m[2] - 1];
  return null;
}

// ── Expressions ───────────────────────────────────────────────────────────────
const EXPR_TYPES = {
  next_month_day: 'Day D of the month N months after the period ends (overrides for e.g. March)',
  days_after_period_end: 'N days after the period ends (overrides per quarter)',
  next_date_after_period_end: 'The first given day/month after the period ends (overrides per half / quarter)',
  fy_dates: 'Fixed day/month dates in the financial year, one per instalment',
  state_group: 'Day of the following month depending on the registration state (e.g. QRMP 22nd / 24th)',
  event_offset: 'Days, months or hours after an event (AGM, cancellation, material event …)',
  event_field: 'A date recorded on the event itself (e.g. the reply date printed on a notice)',
  expiry: 'The expiry date of the registration / certificate, optionally N days before',
  linked: 'Internal target: N days before / after another obligation of the same scope and period',
  by_state: 'A separate rule per state (Professional Tax, LWF …) — a state without one stays unscheduled',
  manual: 'No rule: the due date is entered on each task',
};

/** First match among overrides: { quarter?, half?, period_end_month?, installment?, ...values } */
function pickOverride(expr, period) {
  for (const o of expr.overrides || []) {
    if (o.quarter && o.quarter !== period.quarter) continue;
    if (o.half && o.half !== period.half) continue;
    if (o.period_end_month && o.period_end_month !== period.end_month) continue;
    if (o.installment && o.installment !== period.installment) continue;
    return { ...expr, ...o };
  }
  return expr;
}

/** A day of a month; 'last' = last day. A day that does not exist is an error unless clamp is set. */
function dayIn(y, m, day, clamp) {
  const last = U.daysInMonth(y, m);
  if (day === 'last') return { date: U.ymd(y, m, last) };
  const d = Number(day);
  if (!Number.isInteger(d) || d < 1) return { error: `Day "${day}" is not a day of the month` };
  if (d > last) {
    if (clamp) return { date: U.ymd(y, m, last), note: `day ${d} does not exist in ${U.MONTHS[m - 1]} ${y}; the rule says use the last day` };
    return { error: `Day ${d} does not exist in ${U.MONTHS[m - 1]} ${y} — the rule must say what happens (it is not moved silently)` };
  }
  return { date: U.ymd(y, m, d) };
}

const periodEndYM = period => [+period.end.slice(0, 4), +period.end.slice(5, 7)];

/**
 * Due date of one period. ctx: { period, registration, event, events (entity's events), expiry, linkedDue(ruleId) }.
 * Returns { date, at?, basis } or { date: null, pending | error, basis }.
 */
function computeDue(expr, ctx) {
  const { period } = ctx;
  if (!expr) return { date: null, pending: 'No due-date rule recorded for this obligation' };
  const e = pickOverride(expr, period || {});
  switch (e.type) {
    case 'next_month_day': {
      const [y, m] = periodEndYM(period);
      const [yy, mm] = U.addMonths(y, m, e.months_after ?? 1);
      const r = dayIn(yy, mm, e.day, e.clamp);
      return r.error ? { date: null, error: r.error } : { date: r.date, basis: describe(expr), note: r.note };
    }
    case 'days_after_period_end':
      if (!Number.isInteger(e.days)) return { date: null, error: 'days must be a whole number' };
      return { date: U.addDays(period.end, e.days), basis: describe(expr) };
    case 'next_date_after_period_end': {
      const [y] = periodEndYM(period);
      for (const yy of [y, y + 1]) {
        const r = dayIn(yy, e.month, e.day, e.clamp);
        if (r.error) return { date: null, error: r.error };
        if (r.date > period.end) return { date: r.date, basis: describe(expr), note: r.note };
      }
      return { date: null, error: 'No such date after the period end' };
    }
    case 'fy_dates': {
      const md = (e.dates || [])[(period.installment || 1) - 1];
      if (!md || !/^\d{2}-\d{2}$/.test(md)) return { date: null, error: `No date for instalment ${period.installment}` };
      const s = U.fyStartYear(period.fy); const mm = +md.slice(0, 2);
      const r = dayIn(mm >= 4 ? s : s + 1, mm, +md.slice(3), e.clamp);
      return r.error ? { date: null, error: r.error } : { date: r.date, basis: describe(expr) };
    }
    case 'state_group': {
      const st = ctx.registration?.state;
      if (!st) return { date: null, pending: 'The registration has no state, so the state group cannot be found' };
      const day = Object.entries(e.days_by_state || {}).find(([, states]) => states.includes(st))?.[0];
      if (!day) return { date: null, pending: `State ${st} is not in this rule's state-group table` };
      const [y, m] = periodEndYM(period);
      const [yy, mm] = U.addMonths(y, m, e.months_after ?? 1);
      const r = dayIn(yy, mm, Number(day), e.clamp);
      return r.error ? { date: null, error: r.error } : { date: r.date, basis: `${describe(expr)} — ${st}: day ${day}` };
    }
    case 'event_offset': {
      const ev = ctx.event || (ctx.events || []).find(x => x.type === e.event_type && x.fy === period?.fy && x.status !== 'cancelled');
      if (!ev) return { date: null, pending: `Waiting for the ${e.event_type || 'event'} date to be recorded` };
      if (e.hours) {
        if (!ev.event_at) return { date: null, pending: `The ${ev.type} time (date and hour) must be recorded for an hours-based deadline` };
        const atMs = Date.parse(ev.event_at) + e.hours * 3600000;
        if (Number.isNaN(atMs)) return { date: null, error: 'The event time is not a valid date-time' };
        return { date: new Date(atMs + U.IST_MS).toISOString().slice(0, 10), at: new Date(atMs).toISOString(), basis: `${e.hours} hours after ${ev.type} at ${U.istText(ev.event_at)} IST`, event_id: ev.id };
      }
      if (!U.isDate(ev.event_date)) return { date: null, pending: `The ${ev.type} date must be recorded` };
      let date = ev.event_date;
      if (e.months) {
        const [yy, mm] = U.addMonths(+date.slice(0, 4), +date.slice(5, 7), e.months);
        const r = dayIn(yy, mm, +date.slice(8), true);   // calendar months: 30 Nov + 3 months → 28/29 Feb (stated in basis)
        date = r.date;
      }
      if (e.days) date = U.addDays(date, e.days);
      return { date, basis: `${describe(expr)} (${ev.type} on ${ev.event_date})`, event_id: ev.id };
    }
    case 'event_field': {
      const v = ctx.event?.[e.field];
      if (!ctx.event) return { date: null, pending: 'Waiting for the event to be recorded' };
      if (!U.isDate(v)) return { date: null, pending: `The ${e.field.replace(/_/g, ' ')} on the ${ctx.event.type} must be recorded` };
      return { date: v, basis: `${e.field.replace(/_/g, ' ')} on ${ctx.event.type} ${ctx.event.reference || ''}`.trim(), event_id: ctx.event.id };
    }
    case 'expiry': {
      const v = ctx.expiry;
      if (!U.isDate(v)) return { date: null, pending: 'No expiry date recorded' };
      return { date: U.addDays(v, -(e.days_before || 0)), basis: describe(expr) };
    }
    case 'linked': {
      const d = ctx.linkedDue ? ctx.linkedDue(e.rule) : null;
      if (!d) return { date: null, pending: `The linked obligation ${e.rule} has no due date for this period` };
      return { date: U.addDays(d, e.days || 0), basis: describe(expr), internal: true };
    }
    case 'by_state': {
      const st = ctx.registration?.state;
      if (!st) return { date: null, pending: 'The registration has no state recorded', missing_rule: true };
      const sub = (e.states || {})[st];
      if (!sub) return { date: null, pending: `No rule recorded for state ${st} yet (missing-rule queue)`, missing_rule: true, state: st };
      const r = computeDue(sub, ctx);
      return { ...r, basis: r.basis ? `${st}: ${r.basis}` : r.basis };
    }
    case 'manual': return { date: null, pending: 'Manual: the due date is entered on the task', manual: true };
    default: return { date: null, error: `Unknown due-date rule type "${e.type}"` };
  }
}

/** Plain-language description of an expression */
function describe(e) {
  if (!e) return 'No due-date rule';
  const ov = (e.overrides || []).map(o => {
    const when = o.quarter || o.half || (o.period_end_month ? `period ending in ${U.MONTHS[o.period_end_month - 1]}` : '') || (o.installment ? `instalment ${o.installment}` : '');
    const what = o.days !== undefined ? `${o.days} days` : o.day !== undefined ? `day ${o.day}${o.months_after !== undefined ? ` of month +${o.months_after}` : ''}` : o.month ? `${o.day} ${U.MONTHS[o.month - 1]}` : '';
    return `${when}: ${what}`;
  });
  const tail = ov.length ? ` (${ov.join('; ')})` : '';
  switch (e.type) {
    case 'next_month_day': return `${e.day === 'last' ? 'Last day' : `Day ${e.day}`} of the ${e.months_after === 0 ? 'same' : e.months_after > 1 ? `${e.months_after}th following` : 'following'} month${tail}`;
    case 'days_after_period_end': return `${e.days} days after the period ends${tail}`;
    case 'next_date_after_period_end': return `${e.day} ${U.MONTHS[(e.month || 1) - 1]} after the period ends${tail}`;
    case 'fy_dates': return `Instalments on ${(e.dates || []).map(md => `${+md.slice(3)} ${U.MONTHS[+md.slice(0, 2) - 1]}`).join(', ')}`;
    case 'state_group': return `Day ${Object.keys(e.days_by_state || {}).join(' / ')} of the following month by state group`;
    case 'event_offset': return `${e.hours ? `${e.hours} hours` : e.months ? `${e.months} months${e.days ? ` + ${e.days} days` : ''}` : `${e.days || 0} days`} after ${e.event_type || 'the event'}`;
    case 'event_field': return `Date recorded on the event (${String(e.field || '').replace(/_/g, ' ')})`;
    case 'expiry': return e.days_before ? `${e.days_before} days before expiry` : 'On the expiry date';
    case 'linked': return `${Math.abs(e.days || 0)} days ${(e.days || 0) < 0 ? 'before' : 'after'} ${e.rule} (internal target)`;
    case 'by_state': { const k = Object.keys(e.states || {}); return k.length ? `By state — rules for ${k.join(', ')}; other states unscheduled` : 'By state — no state rule recorded yet'; }
    case 'manual': return 'Entered on each task';
    default: return `Unknown rule type ${e.type}`;
  }
}

/** Checks an expression's shape (when a rule is edited). Returns a list of problems (empty = fine). */
function checkExpr(e) {
  const p = [];
  if (e === null) return p;                               // explicitly "no rule yet"
  if (!e || typeof e !== 'object') return ['The due-date rule must be an object'];
  if (!EXPR_TYPES[e.type]) return [`Unknown due-date rule type "${e.type}"`];
  const okDay = d => d === 'last' || (Number.isInteger(d) && d >= 1 && d <= 31);
  if (e.type === 'next_month_day' && !okDay(e.day)) p.push('day must be 1–31 or "last"');
  if (e.type === 'days_after_period_end' && !Number.isInteger(e.days)) p.push('days must be a whole number');
  if (e.type === 'next_date_after_period_end' && (!(e.month >= 1 && e.month <= 12) || !okDay(e.day))) p.push('month (1–12) and day are required');
  if (e.type === 'fy_dates' && !(Array.isArray(e.dates) && e.dates.every(d => /^\d{2}-\d{2}$/.test(d)))) p.push('dates must be a list of "MM-DD"');
  if (e.type === 'state_group' && !(e.days_by_state && Object.keys(e.days_by_state).length)) p.push('days_by_state is required');
  if (e.type === 'event_offset' && !(e.days || e.months || e.hours)) p.push('days, months or hours is required');
  if (e.type === 'linked' && !e.rule) p.push('the linked rule id is required');
  if (e.type === 'event_field' && !e.field) p.push('the event field is required');
  if (e.type === 'by_state') {
    if (!e.states || typeof e.states !== 'object') p.push('states must map state codes to rules');
    else for (const [st, sub] of Object.entries(e.states)) { if (sub?.type === 'by_state') p.push(`${st}: a state rule cannot itself be by state`); else for (const q of checkExpr(sub)) p.push(`${st}: ${q}`); }
  }
  for (const o of e.overrides || []) {
    if (o.day !== undefined && !okDay(o.day)) p.push(`override day "${o.day}" is not valid`);
  }
  return p;
}

module.exports = { FREQUENCIES, EXPR_TYPES, periodsOf, periodFromKey, monthPeriod, quarterPeriod, halfPeriod, yearPeriod, computeDue, describe, checkExpr, QUARTER_OF_MONTH };
