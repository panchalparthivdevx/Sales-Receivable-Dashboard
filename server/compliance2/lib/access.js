/**
 * Who may do what — checked on the server for every request.
 *
 * Login: the app's own JWT login. Rights: User Settings → "Compliance Dashboard Vr.2.0" (module key compliance_v2).
 * App administrators have every right — but separation of duties still applies to them task by task.
 *   c2_initiator  Initiator = rights prepare + file: work on tasks, upload evidence, record the filing / payment, ask for an exception
 *   c2_approver   Approver  = rights review + verify + approve: approve the filing pack, verify the acknowledgement and close,
 *                 decide exceptions, re-open, legal holds, approve rule versions / extensions / master data
 *   c2_rules      rule maintenance: draft / verify rule versions, record applicability decisions
 *   c2_master     master data: entities, registrations, events, team mapping, task generation, document folders
 *   c2_admin      settings, access scopes, OneDrive connection, demo reset
 *   c2_auditor    READ-ONLY auditor: every write right is off, whatever else is ticked; sees only the entities (and, if
 *                 set, the period) given in Settings → Access — nothing until a scope is given
 * The separation rules (lib/workflow.js) work with two people: the Initiator prepares and files; an Approver other than the
 * Initiator checks the pack and closes. Nobody approves, verifies or decides something they prepared, filed or asked for.
 * The single-right ticks of the first version (c2_prepare, c2_review, c2_file, c2_verify, c2_approve) are still honoured.
 * Entity scope (Settings → Access): a user can be limited to some entities. Everything of other entities is refused
 * (404) — lists leave it out.
 *
 * Demo personas: in the DEMO space only, the screen may ask to act as "Initiator (demo)" or "Approver (demo)" so one person
 * can try the whole initiator / approver flow. A persona is not a login: it acts only on demo data, is recorded as
 * "<persona> (demo persona of <real user>)", and is ignored completely in the live space.
 */

'use strict';

const RIGHTS = ['prepare', 'review', 'file', 'verify', 'approve', 'rules', 'master', 'admin'];
// What User Settings shows. Initiator / Approver are the two working roles; the rest are for specialists.
const SECTIONS = {
  c2_initiator: 'Initiator: prepare tasks and workings, upload evidence, record filings and payments, ask for missing-evidence exceptions',
  c2_approver: 'Approver: check and approve filing packs, verify acknowledgements and close tasks, decide exceptions, re-open filings, approve rule versions, extensions and master data',
  c2_master: 'Master data: entities, registrations, events, team mapping, generate tasks, document folders',
  c2_rules: 'Rules & applicability: draft and verify rule versions, decide applicability',
  c2_admin: 'Administer: settings, access scopes, OneDrive connection, demo reset',
  c2_auditor: 'Auditor (READ-ONLY, limited to the scope set in the module\'s Settings → Access)',
};
// Which rights each tick gives. The single-right ticks of the first version (c2_prepare, c2_review …) still work.
const GRANTS = {
  c2_initiator: ['prepare', 'file'], c2_approver: ['review', 'verify', 'approve'], c2_master: ['master'], c2_rules: ['rules'], c2_admin: ['admin'],
  c2_prepare: ['prepare'], c2_review: ['review'], c2_file: ['file'], c2_verify: ['verify'], c2_approve: ['approve'],
};
const PERSONAS = {
  initiator: { label: 'Initiator', rights: GRANTS.c2_initiator },
  approver: { label: 'Approver', rights: [...GRANTS.c2_approver, 'rules'] },
  auditor: { label: 'Auditor', rights: [], auditor: true },
};
const none = () => Object.fromEntries(RIGHTS.map(r => [r, false]));

/** The compliance identity of a logged-in user. → { error } or actor */
function resolve(users, reqUser, { settings, space, persona }) {
  const u = users.find(x => x.id === reqUser?.id);
  if (!u || u.active === false) return { error: 401, message: 'User not found or disabled' };
  const admin = u.role === 'admin';
  const p = u.permissions?.compliance_v2;
  const view = admin || p?.enabled === true;
  if (!view) return { error: 403, message: 'You do not have access to Compliance Dashboard Vr.2.0 (User Settings → Compliance Dashboard Vr.2.0)' };
  const auditor = !admin && p?.sections?.c2_auditor === true;
  const rights = none();
  if (!auditor) {
    if (admin) for (const r of RIGHTS) rights[r] = true;
    else for (const [tick, given] of Object.entries(GRANTS)) if (p?.sections?.[tick] === true) for (const r of given) rights[r] = true;
  }
  const acc = settings?.access?.[u.id] || null;
  let entities = admin ? null : (acc?.entities?.length ? acc.entities : null);
  if (auditor && !acc?.entities?.length) entities = [];                       // an auditor sees nothing until given a scope
  const base = { id: u.id, user_id: u.id, name: u.name || u.username, username: u.username, email: u.email || '', admin, auditor, rights, entities,
    period_from: auditor ? acc?.period_from || null : null, period_to: auditor ? acc?.period_to || null : null, persona: null };
  if (space !== 'demo' || !persona) return base;
  const P = PERSONAS[persona];
  if (!P) return { error: 400, message: `Unknown demo persona "${persona}"` };
  const pr = none();
  for (const r of P.rights) pr[r] = true;
  pr.master = rights.master || admin;                                         // a persona may still generate demo tasks
  return { ...base, id: `demo-${persona}-${u.id}`, name: `${P.label} (demo persona of ${base.name})`, rights: P.auditor ? none() : pr, auditor: !!P.auditor, entities: null, persona };
}

const canSeeEntity = (actor, id) => actor.entities === null || actor.entities.includes(id);
function canSeeTask(actor, t) {
  if (!(t.entity_ids || [t.entity_id]).some(id => canSeeEntity(actor, id))) return false;
  if (actor.period_from && t.period_end < actor.period_from) return false;
  if (actor.period_to && t.period_start > actor.period_to) return false;
  return true;
}
const canWrite = actor => !actor.auditor;

/** The rights a user's ticks give (for lists of users) */
function rightsOf(u) {
  if (u.role === 'admin') return [...RIGHTS];
  const s = u.permissions?.compliance_v2?.sections || {};
  if (s.c2_auditor) return [];
  return RIGHTS.filter(r => Object.entries(GRANTS).some(([tick, given]) => s[tick] === true && given.includes(r)));
}
/** The two working roles a user holds (for screens) */
const rolesOf = u => { if (u.role === 'admin') return ['Admin']; const r = rightsOf(u); return [r.includes('prepare') && r.includes('file') && 'Initiator', r.includes('review') && r.includes('verify') && 'Approver'].filter(Boolean); };

module.exports = { RIGHTS, SECTIONS, GRANTS, PERSONAS, resolve, rightsOf, rolesOf, canSeeEntity, canSeeTask, canWrite };
