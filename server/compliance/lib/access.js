/**
 * Who may do what in the Compliance Dashboard.
 *
 * Login is the app's existing JWT login (server/auth.js). On top of it:
 *   • The app's Admin users are always Compliance "admin".
 *   • Other users get the compliance role assigned in Master > Users and Roles,
 *     or settings.default_role when none is assigned.
 *   • Role permission flags (edit in Lists / Settings > Roles):
 *       edit_tasks        update task status / remarks / dates, upload documents
 *       manage_documents  replace / delete documents
 *       edit_master       masters, applicability, task generation, folder setup
 *       import            Excel import
 *       admin             settings, users and roles, audit trail
 *   • Company access: a user can be limited to some companies. Tasks, documents and Zoho data
 *     of other companies are never returned to that user.
 *   • A user whose app permissions switch the 'compliance' module off gets 403.
 */

'use strict';

const store = require('./store');
const Settings = require('./settings');
const { migrate } = require('../schema/migrations');

let _auth = null;
function auth() { if (!_auth) _auth = require('../../auth'); return _auth; }

const ALL_FLAGS = Object.fromEntries(Settings.FLAG_KEYS.map(f => [f, true]));

/** Resolve the compliance identity of an authenticated request (req.user from authMiddleware) */
async function resolve(reqUser, { state, settings } = {}) {
  const users = await auth().loadUsers();
  const u = users.find(x => x.id === reqUser?.id);
  if (!u || u.active === false) return { error: 401, message: 'User not found or disabled.' };
  if (u.role !== 'admin' && u.permissions?.compliance && u.permissions.compliance.enabled === false) {
    return { error: 403, message: 'You do not have access to the Compliance Dashboard.' };
  }
  const st = state || migrate(await store.read('data', null)).state;
  const s = settings || Settings.merge(await store.read('settings', {}));
  const assign = (st.user_roles || []).find(r => r.user_id === u.id);
  const isAppAdmin = u.role === 'admin';
  let role = isAppAdmin ? 'admin' : (assign?.role || s.default_role || 'viewer');
  if (!s.roles[role]) role = s.default_role && s.roles[s.default_role] ? s.default_role : 'viewer';
  const def = s.roles[role] || {};
  const flags = role === 'admin' ? { ...ALL_FLAGS } : Object.fromEntries(Settings.FLAG_KEYS.map(f => [f, def[f] === true]));
  return {
    id: u.id, username: u.username, name: u.name || u.username,
    app_role: u.role, role, role_label: def.label || role, flags,
    companies: isAppAdmin ? [] : (assign?.companies || []),
  };
}

/** Express middleware: attaches req.cuser (needs authMiddleware first) */
function attach() {
  return async (req, res, next) => {
    try {
      const r = await resolve(req.user);
      if (r.error) return res.status(r.error).json({ error: r.message });
      req.cuser = r;
      next();
    } catch (e) { next(e); }
  };
}

/** Express middleware: require a permission flag */
function need(flag) {
  return (req, res, next) => {
    if (req.cuser?.flags?.[flag]) return next();
    res.status(403).json({ error: `Your compliance role (${req.cuser?.role_label || 'none'}) does not allow this. Permission needed: ${flag.replace('_', ' ')}.` });
  };
}

function canSeeCompany(cuser, companyId) {
  return !cuser.companies?.length || cuser.companies.includes(companyId);
}

module.exports = { resolve, attach, need, canSeeCompany, ALL_FLAGS };
