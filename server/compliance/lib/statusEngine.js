/**
 * Status engine.
 *
 *   Stored (set by a user):   Not Started | In Progress | Completed
 *   From applicability:       N/A  (task.applicable === false)
 *   Computed at read time:    Due Soon | Overdue   — NEVER stored
 *
 * Display status precedence: N/A → Completed → Overdue → Due Soon → stored status.
 *
 * KPI maths:
 *   Pending      = everything that is not Completed and not N/A
 *   Compliance % = Completed / (Total − N/A)      (N/A never counts against compliance)
 *
 * Pure functions — no I/O.
 */

'use strict';

const USER_STATUSES = ['Not Started', 'In Progress', 'Completed'];
const DISPLAY_STATUSES = ['Completed', 'In Progress', 'Not Started', 'Due Soon', 'Overdue', 'N/A'];

function normUserStatus(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (s === 'not started' || s === 'pending' || s === 'open') return 'Not Started';
  if (s === 'in progress' || s === 'wip') return 'In Progress';
  if (s === 'completed' || s === 'complete' || s === 'done' || s === 'filed') return 'Completed';
  return null;
}

/** Whole days from `fromISO` to `toISO` (both 'YYYY-MM-DD'); negative when `toISO` is earlier */
function daysBetween(fromISO, toISO) {
  const [y1, m1, d1] = fromISO.split('-').map(Number);
  const [y2, m2, d2] = toISO.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * Display status of a task as of `todayISO`.
 * @param {object} task         { applicable, status, due_date }
 * @param {string} todayISO     'YYYY-MM-DD'
 * @param {number} dueSoonDays  window for "Due Soon" (inclusive), from settings
 */
function displayStatus(task, todayISO, dueSoonDays) {
  if (task.applicable === false) return 'N/A';
  const stored = normUserStatus(task.status) || 'Not Started';
  if (stored === 'Completed') return 'Completed';
  if (!task.due_date) return stored;
  const left = daysBetween(todayISO, task.due_date);
  if (left < 0) return 'Overdue';
  if (left <= dueSoonDays) return 'Due Soon';
  return stored;
}

/** Days left until due (negative = days overdue). null when no due date. */
function daysLeft(task, todayISO) {
  return task.due_date ? daysBetween(todayISO, task.due_date) : null;
}

/** True when a Completed task was completed after its due date */
function completedLate(task) {
  return task.applicable !== false && normUserStatus(task.status) === 'Completed'
    && !!task.completion_date && !!task.due_date && task.completion_date > task.due_date;
}

/** KPI counts for a list of tasks that already carry `display_status` */
function stats(tasks) {
  const s = { total: tasks.length, completed: 0, pending: 0, overdue: 0, due_soon: 0, in_progress: 0, not_started: 0, na: 0 };
  for (const t of tasks) {
    switch (t.display_status) {
      case 'Completed':   s.completed++; break;
      case 'N/A':         s.na++; break;
      case 'Overdue':     s.overdue++; break;
      case 'Due Soon':    s.due_soon++; break;
      case 'In Progress': s.in_progress++; break;
      default:            s.not_started++; break;
    }
  }
  s.pending = s.total - s.completed - s.na;
  s.applicable = s.total - s.na;
  s.compliance_pct = s.applicable > 0 ? Math.round((s.completed / s.applicable) * 1000) / 10 : null;
  return s;
}

/** KPI bucket → does a display status belong to it (used by KPI-card drilldown) */
function inBucket(displayStatusValue, bucket) {
  switch (bucket) {
    case 'total':
    case 'all':          return true;
    case 'completed':    return displayStatusValue === 'Completed';
    case 'pending':      return displayStatusValue !== 'Completed' && displayStatusValue !== 'N/A';
    case 'overdue':      return displayStatusValue === 'Overdue';
    case 'due_soon':     return displayStatusValue === 'Due Soon';
    case 'in_progress':  return displayStatusValue === 'In Progress';
    case 'not_started':  return displayStatusValue === 'Not Started';
    case 'na':           return displayStatusValue === 'N/A';
    case 'applicable':   return displayStatusValue !== 'N/A';
    default:             return true;
  }
}

module.exports = {
  USER_STATUSES, DISPLAY_STATUSES, normUserStatus, daysBetween, displayStatus, daysLeft,
  completedLate, stats, inBucket,
};
