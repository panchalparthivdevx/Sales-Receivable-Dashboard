/**
 * Assignments: who owns a row, when a row is still open, how its due date stands — and the filters and figures built on that
 * (lib/tasks.js, lib/dash.js, lib/review.js). SYNTHETIC data.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rm } = require('./helpers');
const { scenario, byNo } = require('./fixtures');
const T = require('../lib/tasks');
const D = require('../lib/dash');
const RV = require('../lib/review');

const USERS = [
  { id: '1', username: 'admin', name: 'Admin', role: 'admin', active: true, permissions: {} },
  { id: '7', username: 'bhautik', name: 'Bhautik Zinzuvadiya', role: 'user', active: true, permissions: { gstr2b: { enabled: true, sections: { g2b_prepare: true } } } },
  { id: '8', username: 'asha', name: 'Asha Mehta', role: 'user', active: true, permissions: { gstr2b: { enabled: true, sections: {} } } },
  { id: '9', username: 'outsider', name: 'Outsider', role: 'user', active: true, permissions: { gstr2b: { enabled: false } } },
  { id: '10', username: 'gone', name: 'Gone', role: 'user', active: false, permissions: { gstr2b: { enabled: true } } },
];
const BHAUTIK = USERS[1], ASHA = USERS[2];
const TODAY = '2026-11-14';

test('who a row can be given to: the active users that can open the module, by name', () => {
  assert.deepEqual(T.people(USERS), [{ id: '1', name: 'Admin' }, { id: '8', name: 'Asha Mehta' }, { id: '7', name: 'Bhautik Zinzuvadiya' }]);
  assert.equal(T.canOpen(USERS[3]), false, 'a user the module is not ticked for');
  assert.equal(T.canOpen(USERS[4]), false, 'a user who was switched off');
});

test('an owner chosen from the list is stored with the user id; a typed name finds its user whatever the capitals; a name nobody has is kept as typed', () => {
  assert.deepEqual(T.resolveOwner(USERS, { owner_id: '7' }), { owner: 'Bhautik Zinzuvadiya', owner_id: '7' });
  assert.deepEqual(T.resolveOwner(USERS, { owner: 'bhautik Zinzuvadiya' }), { owner: 'Bhautik Zinzuvadiya', owner_id: '7' }, 'the name as it was typed in the screenshot: a small b');
  assert.deepEqual(T.resolveOwner(USERS, { owner: '  ASHA  ' }), { owner: 'Asha Mehta', owner_id: '8' }, 'a login name works too');
  assert.deepEqual(T.resolveOwner(USERS, { owner: 'Ramesh (auditor)' }), { owner: 'Ramesh (auditor)', owner_id: '' });
  assert.deepEqual(T.resolveOwner(USERS, { owner: 'Outsider' }), { owner: 'Outsider', owner_id: '' }, 'somebody who cannot open the module is only a name');
  assert.deepEqual(T.resolveOwner(USERS, { owner: '' }), { owner: '', owner_id: '' });
  assert.deepEqual(T.resolveOwner(USERS, { owner_id: '', owner: '' }), { owner: '', owner_id: '' });
  assert.throws(() => T.resolveOwner(USERS, { owner_id: '9' }), /cannot open GSTR-2B Reco/);
  assert.throws(() => T.resolveOwner(USERS, { owner_id: '10' }), /cannot open GSTR-2B Reco/);
  assert.throws(() => T.resolveOwner(USERS, { owner_id: '404' }), /no longer a user/);
});

test('whose row it is: the stored user id decides; a name stored without one is compared without regard to capitals', () => {
  assert.equal(T.ownedBy({ owner: 'Bhautik Zinzuvadiya', owner_id: '7' }, BHAUTIK), true);
  assert.equal(T.ownedBy({ owner: 'Old Name', owner_id: '7' }, BHAUTIK), true, 'a renamed user keeps their rows');
  assert.equal(T.ownedBy({ owner: 'Bhautik Zinzuvadiya', owner_id: '8' }, BHAUTIK), false, 'the id, not the name');
  assert.equal(T.ownedBy({ owner: 'bhautik zinzuvadiya' }, BHAUTIK), true);
  assert.equal(T.ownedBy({ owner: 'BHAUTIK' }, BHAUTIK), true, 'the login name');
  assert.equal(T.ownedBy({ owner: 'Bhautik' }, ASHA), false);
  assert.equal(T.ownedBy({ owner: '' }, BHAUTIK), false); assert.equal(T.ownedBy({ owner: 'x' }, null), false);
  assert.equal(T.ownerUser({ owner: 'asha mehta' }, USERS).id, '8'); assert.equal(T.ownerUser({ owner: 'Ramesh' }, USERS), null);
});

test('open and overdue: only a row that still needs somebody can be overdue', () => {
  const row = status => ({ status });
  assert.equal(T.isOpen(row('mismatched'), {}), true); assert.equal(T.isOpen(row('books_only'), { workflow: 'vendor_followup' }), true);
  assert.equal(T.isOpen(row('exact'), {}), false, 'a matched row needs nobody');
  assert.equal(T.isOpen(row('excluded'), {}), false);
  assert.equal(T.isOpen(row('mismatched'), { workflow: 'resolved' }), false); assert.equal(T.isOpen(row('suggested'), { workflow: 'accepted' }), false);
  assert.deepEqual(T.dueOf(row('mismatched'), { due: '2026-11-11' }, TODAY), { state: 'overdue', days: -3 });
  assert.deepEqual(T.dueOf(row('mismatched'), { due: TODAY }, TODAY), { state: 'today', days: 0 });
  assert.deepEqual(T.dueOf(row('mismatched'), { due: '2026-11-21' }, TODAY), { state: 'soon', days: 7 });
  assert.deepEqual(T.dueOf(row('mismatched'), { due: '2026-11-22' }, TODAY), { state: 'later', days: 8 });
  assert.deepEqual(T.dueOf(row('mismatched'), { due: '2026-11-16' }, TODAY, 1), { state: 'later', days: 2 }, 'the "soon" window is the caller\'s');
  assert.deepEqual(T.dueOf(row('mismatched'), {}, TODAY), { state: null, days: null });
  assert.deepEqual(T.dueOf(row('exact'), { due: '2026-11-01' }, TODAY), { state: null, days: null }, 'a matched row is not overdue');
  assert.deepEqual(T.dueOf(row('mismatched'), { due: '2026-11-01', workflow: 'resolved' }, TODAY), { state: null, days: null });
});

test('assigning: the rows somebody was just handed are told apart from a change of due date; clearing the owner clears who gave it', async () => {
  const { dir, doc } = await scenario();
  const a = byNo(doc, 'INV/003').books_ids[0], b = byNo(doc, 'INV/004').books_ids[0];
  assert.deepEqual(await RV.assign('devx', [a, b], { owner: 'Bhautik Zinzuvadiya', owner_id: '7', due: '2026-11-20' }, 'Admin'), { given: [a, b] });
  let m = (await RV.load('devx')).meta;
  assert.equal(m[a].owner_id, '7'); assert.equal(m[a].assigned_by, 'Admin'); assert.ok(Date.parse(m[a].assigned_at) <= Date.now());
  assert.deepEqual(await RV.assign('devx', [a], { due: '2026-11-25' }, 'Asha'), { given: [] }, 'a new due date is not a new assignment');
  assert.deepEqual(await RV.assign('devx', [a], { owner: 'Bhautik Zinzuvadiya', owner_id: '7' }, 'Asha'), { given: [] }, 'the same owner again');
  m = (await RV.load('devx')).meta;
  assert.equal(m[a].assigned_by, 'Admin', 'who gave it stays'); assert.equal(m[a].due, '2026-11-25'); assert.equal(m[a].updated_by, 'Asha');
  assert.deepEqual(await RV.assign('devx', [a], { owner: 'Asha Mehta', owner_id: '8' }, 'Admin'), { given: [a] });
  assert.deepEqual(await RV.assign('devx', [b], { owner: '' }, 'Admin'), { given: [] });
  m = (await RV.load('devx')).meta;
  assert.equal(m[b].owner, ''); assert.equal(m[b].owner_id, ''); assert.equal(m[b].assigned_at, undefined); assert.equal(m[b].due, '2026-11-20', 'the due date is kept');
  const hist = (await RV.detailFor('devx', byNo(doc, 'INV/003'))).history.map(h => h.detail);
  assert.ok(hist.includes('owner=Bhautik Zinzuvadiya, due=2026-11-20') && hist.includes('owner=Asha Mehta'), 'the history names the owner, not an id');
  rm(dir);
});

test('filters and figures: my rows, an owner in any capitals, open rows, overdue / due today / this week, and the Overview numbers', async () => {
  const { dir, doc } = await scenario();
  const total = doc.rows.length;
  const id = no => { const r = byNo(doc, no); return r.books_ids[0] || r.portal_ids[0]; };
  await RV.assign('devx', [id('INV/003')], { owner: 'Bhautik Zinzuvadiya', owner_id: '7', workflow: 'vendor_followup', due: '2026-11-10' }, 'Admin');   // mismatched, overdue
  await RV.assign('devx', [id('INV/004')], { owner: 'bhautik zinzuvadiya', due: TODAY }, 'Admin');                                                // Books only, typed in small letters, due today
  await RV.assign('devx', [id('INV/006')], { owner: 'Asha Mehta', owner_id: '8', due: '2026-11-20' }, 'Admin');                                 // suggested, due in 6 days
  await RV.assign('devx', [id('INV/001')], { owner: 'Bhautik Zinzuvadiya', owner_id: '7', due: '2026-11-01' }, 'Admin');                        // exact matched: not open
  await RV.assign('devx', [id('INV/900')], { due: '2026-11-12' }, 'Admin');                                                                      // GSTR-2B only, overdue, nobody's
  const rv = await RV.load('devx');
  const who = { me: BHAUTIK, users: USERS, today: TODAY };
  const n = (f, w = who) => D.filterRows(doc.rows, f, rv, undefined, w).length;
  assert.equal(n({ owner: '__me__' }), 3); assert.equal(n({ owner: '__me__', open: '1' }), 2, '"My rows": mine and still open');
  assert.equal(n({ owner: '__me__' }, { ...who, me: ASHA }), 1); assert.equal(n({ owner: '__me__' }, { users: USERS, today: TODAY }), 0, 'nobody asking');
  assert.equal(n({ owner: 'BHAUTIK ZINZUVADIYA' }), 3, 'a name finds the rows whatever the capitals, typed or chosen');
  assert.equal(n({ owner: 'id:7' }), 3); assert.equal(n({ owner: 'id:8' }), 1); assert.equal(n({ owner: 'id:404' }), 0);
  assert.equal(n({ owner: '__none__' }), total - 4);
  assert.equal(n({ open: '1' }), 4, 'mismatched, suggested, Books only, GSTR-2B only'); assert.equal(n({ open: '0' }), total);
  assert.equal(n({ due: 'overdue' }), 2, 'the matched row with a past date is not overdue'); assert.equal(n({ due: 'overdue', owner: '__none__' }), 1);
  assert.equal(n({ due: 'today' }), 1); assert.equal(n({ due: 'week' }), 2, 'today and the 20th');
  assert.equal(n({ due: 'set' }), 5); assert.equal(n({ due: 'none' }), total - 5); assert.equal(n({ due: 'whatever' }), total);
  assert.equal(n({ owner: '__me__', workflow: 'vendor_followup', due: 'overdue' }), 1);
  // the same definitions give the cards
  const s = D.summarize(doc.rows, { reviewDoc: rv, me: BHAUTIK, today: TODAY });
  assert.deepEqual(s.tasks, { mine: { open: 2, overdue: 1, today: 1 }, all: { open: 3, overdue: 2, today: 1 } });
  assert.deepEqual(D.summarize(doc.rows, { reviewDoc: rv, me: ASHA, today: TODAY }).tasks.mine, { open: 1, overdue: 0, today: 0 });
  assert.deepEqual(D.summarize(doc.rows, { reviewDoc: rv, today: TODAY }).tasks.mine, { open: 0, overdue: 0, today: 0 });
  assert.ok(s.definitions.assigned_to_me && s.definitions.overdue);
  // resolving a row takes it out of "open" and "overdue"
  await RV.assign('devx', [id('INV/003')], { workflow: 'resolved' }, 'Admin');
  const rv2 = await RV.load('devx');
  assert.equal(D.filterRows(doc.rows, { due: 'overdue' }, rv2, undefined, who).length, 1);
  assert.deepEqual(D.summarize(doc.rows, { reviewDoc: rv2, me: BHAUTIK, today: TODAY }).tasks.mine, { open: 1, overdue: 0, today: 1 });
  rm(dir);
});
