/**
 * Assignments: who owns a reconciliation row, whether the row is still open, and how its due date stands.
 *
 * One definition, used by the filters, the cards, the row list and the email reminders, so that their numbers agree:
 *   open      the row's status still needs somebody (mismatched, suggested, Books only, GSTR-2B only) AND nobody has marked it
 *             "Accepted as is" or "Resolved". A row that became matched by itself is no longer open.
 *   overdue   an open row whose due date has passed (India time).
 *   owner     the dashboard user a row was given to. The user's id is stored with the name, so a renamed user keeps their rows;
 *             a name typed before ids were stored is compared without regard to capital letters.
 */

'use strict';

const N = require('./normalize');

const OPEN_STATUSES = new Set(['mismatched', 'suggested', 'books_only', 'portal_only']);
const CLOSED_WORKFLOWS = new Set(['accepted', 'resolved']);
const lc = s => String(s === null || s === undefined ? '' : s).trim().toLowerCase();

const isOpen = (row, m) => OPEN_STATUSES.has(row.status) && !CLOSED_WORKFLOWS.has((m || {}).workflow || '');

/** { state: overdue | today | soon | later | null, days: due − today } — null for a row without a due date or one that is no longer open */
function dueOf(row, m, today, soonDays = 7) {
  const due = (m || {}).due || '';
  if (!due || !isOpen(row, m)) return { state: null, days: null };
  const days = N.daysBetween(today, due);
  return { state: days < 0 ? 'overdue' : days === 0 ? 'today' : days <= soonDays ? 'soon' : 'later', days };
}

/** May this user open the module at all? (the same test as the router's `rights`) */
const canOpen = u => !!u && u.active !== false && (u.role === 'admin' || !!(u.permissions && u.permissions.gstr2b && u.permissions.gstr2b.enabled === true));
/** The people a row can be given to */
const people = users => (users || []).filter(canOpen).map(u => ({ id: String(u.id), name: u.name || u.username })).sort((a, b) => a.name.localeCompare(b.name));
const userById = (users, id) => (users || []).find(u => String(u.id) === String(id)) || null;
const userByName = (users, name) => { const k = lc(name); return k ? (users || []).find(u => canOpen(u) && (lc(u.name) === k || lc(u.username) === k)) || null : null; };

/** Is this row's owner that user? */
function ownedBy(m, user) {
  if (!m || !m.owner || !user) return false;
  if (m.owner_id) return String(m.owner_id) === String(user.id);
  const k = lc(m.owner);
  return k === lc(user.name) || k === lc(user.username);
}
/** The user behind a row's owner, or null when the owner is only a typed name (or the user was removed) */
const ownerUser = (m, users) => (!m || !m.owner ? null : m.owner_id ? userById(users, m.owner_id) : userByName(users, m.owner));

/** What is stored for an owner chosen on the screen (a user id) or typed (a name): the user's name and id, or the text as it is */
function resolveOwner(users, { owner_id, owner } = {}) {
  if (owner_id !== undefined && owner_id !== null && String(owner_id) !== '') {
    const u = userById(users, owner_id);
    if (!canOpen(u)) throw new Error('That person cannot open GSTR-2B Reco (or is no longer a user) — choose the owner again');
    return { owner: u.name || u.username, owner_id: String(u.id) };
  }
  const text = String(owner || '').trim().slice(0, 80);
  if (!text) return { owner: '', owner_id: '' };
  const u = userByName(users, text);
  return u ? { owner: u.name || u.username, owner_id: String(u.id) } : { owner: text, owner_id: '' };
}

/** The Owner filter: "__me__", "__none__", "id:<user id>" or a name */
function ownerMatches(m, want, { me = null, users = [] } = {}) {
  const owner = (m || {}).owner || '';
  if (want === '__none__') return !owner;
  if (want === '__me__') return ownedBy(m, me);
  if (String(want).startsWith('id:')) { const u = userById(users, String(want).slice(3)); return !!u && ownedBy(m, u); }
  if (owner && lc(owner) === lc(want)) return true;
  const u = userByName(users, want);                    // a user's name also finds the rows given to that user under an earlier name
  return !!u && ownedBy(m, u);
}

/** The Due filter: overdue | today | week (today and the next 7 days) | set | none */
function dueMatches(row, m, want, today) {
  if (want === 'set') return !!(m || {}).due;
  if (want === 'none') return !(m || {}).due;
  const d = dueOf(row, m, today);
  if (want === 'overdue') return d.state === 'overdue';
  if (want === 'today') return d.state === 'today';
  if (want === 'week') return d.days !== null && d.days >= 0 && d.days <= 7;
  return true;
}

module.exports = { OPEN_STATUSES, CLOSED_WORKFLOWS, lc, isOpen, dueOf, canOpen, people, userById, userByName, ownedBy, ownerUser, resolveOwner, ownerMatches, dueMatches };
