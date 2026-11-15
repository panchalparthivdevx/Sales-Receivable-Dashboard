/**
 * End-to-end through the HTTP routes: two entities with several GSTINs (two in one state), rule verification and approval,
 * applicability, generation without duplicates, QRMP, PT by state, PF, the maker / checker / filer / verifier workflow,
 * mandatory evidence and exceptions, revisions, extensions and fee waivers, stale updates, auditor and cross-entity access,
 * documents (versions, encryption, signed links), exports, import, demo / live separation and the audit chain.
 * ALL data is SYNTHETIC.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const H = require('./helpers');
const U = require('../lib/util');
const store = require('../lib/store');

const { call } = H;
const PAN_A = 'ZZZCA7001K', PAN_B = 'ZZZFB7002L';
const S = {};                                                   // shared state between the steps below
const ok = (r, msg) => { assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const tasks = async (user, q = '') => ok(await call(user, 'GET', `/tasks?fy=2026-27${q}`)).tasks;
const getTask = async (user, id) => ok(await call(user, 'GET', `/tasks/${id}`)).task;
const act = async (user, id, action, extra = {}) => { const t = await getTask('1', id); return call(user, 'POST', `/tasks/${id}/action`, { action, rev: t.rev, ...extra }); };
const upload = (user, id, docType, text, name = 'doc.txt', fields = {}) => call(user, 'POST', `/tasks/${id}/documents`, undefined, { form: H.fileForm(Buffer.from(text), name, { doc_type: docType, ...fields }) });
const find = (list, rule, reg, period) => list.find(t => t.rule_id === rule && (!reg || t.registration_id === reg) && (!period || t.period_key === period));

test.before(() => H.start());
test.after(() => H.stop());

test('no access without the module right; meta for a permitted user', async () => {
  assert.equal((await call('n', 'GET', '/meta')).status, 403);
  assert.equal((await call(null, 'GET', '/meta')).status, 401);
  const m = ok(await call('m', 'GET', '/meta'));
  assert.equal(m.space, 'live');
  assert.equal(m.actor.rights.prepare, true);
  assert.equal(m.actor.rights.review, false);
  assert.equal(m.storage.live_key, true);
});

test('masters: two entities, several GSTINs (two in Gujarat), TAN, PF, PT in two states; validation and secrets refused', async () => {
  S.A = ok(await call('1', 'POST', '/org/entity', { legal_name: 'Synthetic Alpha Pvt Ltd', short_code: 'SYNA', type: 'PRIVATE', pan: PAN_A, cin: 'U74999GJ2019PTC700001', listed: false, flags: { has_employees: true, has_exports: true } })).record;
  S.B = ok(await call('1', 'POST', '/org/entity', { legal_name: 'Synthetic Beta LLP', short_code: 'SYNB', type: 'LLP', pan: PAN_B, llpin: 'ABC-7002' })).record;
  const reg = async (x) => ok(await call('1', 'POST', '/org/registration', x), x.number).record;
  S.GJ1 = await reg({ entity_id: S.A.id, type: 'GST_REGULAR', number: H.gstin('24', PAN_A, '1'), state: 'GJ', filing_frequency: 'monthly', regime: 'regular' });
  S.GJ2 = await reg({ entity_id: S.A.id, type: 'GST_REGULAR', number: H.gstin('24', PAN_A, '2'), state: 'GJ', filing_frequency: 'quarterly', regime: 'qrmp', flags: { uses_iff: true } });
  S.MH = await reg({ entity_id: S.A.id, type: 'GST_REGULAR', number: H.gstin('27', PAN_A, '1'), state: 'MH', filing_frequency: 'monthly', regime: 'regular' });
  S.TAN_A = await reg({ entity_id: S.A.id, type: 'TAN', number: 'AHMZ70001A', flags: { deducts_salary: true } });
  S.PF = await reg({ entity_id: S.A.id, type: 'PF', number: 'GJAHD0070001000', state: 'GJ' });
  S.PTGJ = await reg({ entity_id: S.A.id, type: 'PT_PTRC', number: 'SYN-GJ-PT-1', state: 'GJ', filing_frequency: 'monthly' });
  S.PTMH = await reg({ entity_id: S.A.id, type: 'PT_PTRC', number: 'SYN-MH-PT-2', state: 'MH', filing_frequency: 'monthly' });
  S.DL = await reg({ entity_id: S.B.id, type: 'GST_REGULAR', number: H.gstin('07', PAN_B, '1'), state: 'DL', filing_frequency: 'quarterly', regime: 'qrmp', flags: { uses_iff: false } });
  S.TAN_B = await reg({ entity_id: S.B.id, type: 'TAN', number: 'DELZ70002B', flags: { deducts_salary: false } });
  // a GSTIN of another PAN, a wrong check character, a duplicate, a password field
  assert.match((await call('1', 'POST', '/org/registration', { entity_id: S.A.id, type: 'GST_REGULAR', number: H.gstin('24', 'ZZZCQ7009K'), state: 'GJ' })).body.error, /belongs to PAN/);
  const g = H.gstin('24', PAN_A, '3');
  assert.match((await call('1', 'POST', '/org/registration', { entity_id: S.A.id, type: 'GST_REGULAR', number: `${g.slice(0, 14)}${g[14] === 'A' ? 'B' : 'A'}`, state: 'GJ' })).body.error, /check character/);
  assert.match((await call('1', 'POST', '/org/registration', { entity_id: S.A.id, type: 'TAN', number: 'AHMZ70001A' })).body.error, /already recorded/);
  assert.match((await call('1', 'POST', '/org/registration', { entity_id: S.A.id, type: 'TAN', number: 'AHMZ70009Z', portal_password: 'x' })).body.error, /password/);
  assert.equal((await call('c', 'POST', '/org/entity', { legal_name: 'X', short_code: 'X', type: 'PRIVATE' })).status, 403);
});

test('stale update of a master record is refused', async () => {
  const a = ok(await call('1', 'PUT', `/org/entity/${S.A.id}`, { ...S.A, notes: 'first edit', rev: S.A.rev }));
  assert.equal(a.record.rev, S.A.rev + 1);
  const stale = await call('1', 'PUT', `/org/entity/${S.A.id}`, { ...S.A, notes: 'second edit from an old screen', rev: S.A.rev });
  assert.equal(stale.status, 409);
});

test('live generation is blocked until masters are approved, applicability decided and rules verified + approved', async () => {
  const g = ok(await call('m', 'POST', '/tasks/generate', { fy: '2026-27' }));
  assert.equal(g.created, 0);
  assert.ok(g.blocked_by_code.ENTITY_NOT_APPROVED > 0);
  for (const e of [S.A, S.B]) ok(await call('a', 'POST', `/org/entity/${e.id}/approve`), 'approve entity');
  for (const k of ['GJ1', 'GJ2', 'MH', 'TAN_A', 'PF', 'PTGJ', 'PTMH', 'DL', 'TAN_B']) ok(await call('a', 'POST', `/org/registration/${S[k].id}/approve`), `approve ${k}`);
  const g2 = ok(await call('m', 'POST', '/tasks/generate', { fy: '2026-27' }));
  assert.equal(g2.created, 0);
  assert.ok(g2.blocked_by_code.APPLIC_NOT_REVIEWED > 0, 'no decisions yet');
});

const RULES = { 'GST-R1-M': 1, 'GST-3B-M': 1, 'GST-R1-Q': 1, 'GST-3B-Q': 1, 'GST-IFF': 1, 'GST-PMT06': 1, 'TDS-DEP': 2, 'IT-ITR': 2, 'PF-ECR': 1, 'PF-PAY': 1, 'PT-PTRC-PAY': 1 };

test('applicability: accepting suggestions records decisions; unknown facts are skipped, never "not applicable"', async () => {
  const cov = ok(await call('r', 'GET', '/coverage?fy=2026-27'));
  const items = cov.rows.filter(r => RULES[r.rule_id]).map(r => ({ rule_id: r.rule_id, scope_id: r.scope_type === 'entity' ? r.entity_id : r.scope_id }));
  const res = ok(await call('r', 'POST', '/applicability/accept', { fy: '2026-27', items }));
  assert.ok(res.accepted >= 20, `accepted ${res.accepted}`);
  // B has no "exports" fact recorded → GST-LUT needs a person
  const lut = cov.rows.find(r => r.rule_id === 'GST-LUT' && r.entity_id === S.B.id);
  assert.equal(lut.suggestion.status, 'needs_review');
  assert.deepEqual(lut.suggestion.missing, ['entity.flags.has_exports']);
  const skip = ok(await call('r', 'POST', '/applicability/accept', { fy: '2026-27', items: [{ rule_id: 'GST-LUT', scope_id: lut.scope_id }] }));
  assert.equal(skip.accepted, 0);
  assert.match(skip.skipped[0].why, /needs a person's decision/);
  assert.equal((await call('c', 'POST', '/applicability', { rule_id: 'GST-LUT', scope_type: 'registration', scope_id: lut.scope_id, status: 'not_applicable', reason: 'test' })).status, 403);
  assert.match((await call('r', 'POST', '/applicability', { rule_id: 'GST-LUT', scope_type: 'registration', scope_id: lut.scope_id, status: 'not_applicable', reason: '' })).body.error, /reason is required/);
});

test('rule verification and approval: verifier ≠ approver, approval quotes the impact preview', async () => {
  const body = { source_url: 'https://www.cbic.gov.in/synthetic-test', notification_no: 'SYNTHETIC-TEST-1', notification_date: '2017-06-28', retrieved_at: '2026-11-14', verification_note: 'Synthetic test verification only' };
  // approver verifies and tries to approve the same version → refused
  ok(await call('a', 'POST', '/rules/GST-R1-M/versions/1/verify', body));
  const p0 = ok(await call('a', 'GET', '/rules/GST-R1-M/versions/1/preview'));
  assert.equal((await call('a', 'POST', '/rules/GST-R1-M/versions/1/approve', { preview_hash: p0.hash })).status, 403);
  assert.equal((await call('r', 'POST', '/rules/GST-R1-M/versions/1/approve', { preview_hash: p0.hash })).status, 403, 'rules editor has no approve right');
  // the second rule is verified by the rules editor and approved by the approver
  for (const [id, v] of Object.entries(RULES)) {
    if (id !== 'GST-R1-M') ok(await call('r', 'POST', `/rules/${id}/versions/${v}/verify`, body), `verify ${id}`);
  }
  assert.equal((await call('a', 'POST', '/rules/GST-3B-M/versions/1/approve', {})).status, 409, 'no preview quoted');
  for (const [id, v] of Object.entries(RULES)) {
    const approver = id === 'GST-R1-M' ? '1' : 'a';                  // GST-R1-M was verified by "a": the admin approves it
    const p = ok(await call(approver, 'GET', `/rules/${id}/versions/${v}/preview`));
    ok(await call(approver, 'POST', `/rules/${id}/versions/${v}/approve`, { preview_hash: p.hash, note: 'synthetic test approval' }), `approve ${id}`);
  }
  const rules = ok(await call('m', 'GET', '/rules')).rules;
  assert.equal(rules.find(r => r.id === 'TDS-DEP').versions[1].status, 'approved');
  assert.equal(rules.find(r => r.id === 'TDS-DEP').versions[0].status, 'draft', 'the 1961-Act version stays unverified');
  assert.equal(rules.find(r => r.id === 'GST-R9').versions[0].status, 'draft');
});

test('generation: one task per GSTIN / TAN / entity and period; nothing duplicated on a second run', async () => {
  const g = ok(await call('m', 'POST', '/tasks/generate', { fy: '2026-27', commit: true }));
  assert.equal(g.created, 162, JSON.stringify(g.blocked_by_code));
  const again = ok(await call('m', 'POST', '/tasks/generate', { fy: '2026-27', commit: true }));
  assert.equal(again.created, 0);
  assert.equal(again.existing, 162);
  const all = await tasks('1');
  S.all = all;
  const n = (rule, reg) => all.filter(t => t.rule_id === rule && (!reg || t.registration_id === reg)).length;
  assert.equal(n('GST-R1-M', S.GJ1.id), 12);
  assert.equal(n('GST-R1-M', S.MH.id), 12);
  assert.equal(n('GST-R1-M', S.GJ2.id), 0, 'the QRMP GSTIN in the same state has no monthly GSTR-1');
  assert.equal(n('GST-R1-Q', S.GJ2.id), 4);
  assert.equal(n('GST-IFF', S.GJ2.id), 8);
  assert.equal(n('GST-IFF', S.DL.id), 0, 'IFF not chosen');
  assert.equal(n('IT-ITR'), 2, 'ITR once per entity (PAN), not per GSTIN');
  assert.equal(n('TDS-DEP', S.TAN_A.id), 12);
  assert.equal(find(all, 'GST-3B-Q', S.GJ2.id, 'Q:2026-27:Q1').effective_due, '2026-07-22');
  assert.equal(find(all, 'GST-3B-Q', S.DL.id, 'Q:2026-27:Q1').effective_due, '2026-07-24');
  assert.equal(find(all, 'TDS-DEP', S.TAN_A.id, 'M:2027-03').effective_due, '2027-04-30');
  assert.equal(find(all, 'IT-ITR', null, 'Y:2026-27').no_due_date, true);
  assert.ok(all.every(t => t.id.startsWith('T202627-')));
});

test('Professional Tax: Gujarat dated, Maharashtra unscheduled in the missing-rule queue and never overdue; PF items in the calendar', async () => {
  const pt = await tasks('1', '&rule_ids=PT-PTRC-PAY');
  assert.ok(pt.filter(t => t.state === 'GJ').every(t => t.effective_due && t.effective_due.endsWith('-15')));
  const mh = pt.filter(t => t.state === 'MH');
  assert.equal(mh.length, 12);
  assert.ok(mh.every(t => t.no_due_date && t.flags.includes('missing_rule') && !t.overdue));
  const cov = ok(await call('1', 'GET', '/coverage?fy=2026-27'));
  assert.ok(cov.missing_rules.some(m => m.rule_id === 'PT-PTRC-PAY' && m.state === 'MH'));
  assert.ok(!cov.missing_rules.some(m => m.rule_id === 'PT-PTRC-PAY' && m.state === 'GJ'));
  const pf = await tasks('1', '&categories=Provident Fund');
  assert.equal(pf.filter(t => t.rule_id === 'PF-ECR').length, 12);
  assert.equal(pf.filter(t => t.rule_id === 'PF-PAY').length, 12);
  assert.ok(pf.every(t => t.effective_due), 'all PF items have a date (they appear in the calendar)');
  const ics = await call('1', 'GET', '/export/calendar.ics?fy=2026-27&categories=Provident Fund');
  assert.equal((ics.raw.toString().match(/BEGIN:VEVENT/g) || []).length, 24);
});

test('year rollover: FY 2027-28 tasks go to their own document and never duplicate 2026-27', async () => {
  const g = ok(await call('m', 'POST', '/tasks/generate', { fy: '2027-28', rule_ids: ['TDS-DEP'], commit: true }));
  assert.equal(g.created, 24);
  const next = ok(await call('1', 'GET', '/tasks?fy=2027-28')).tasks;
  assert.ok(next.every(t => t.id.startsWith('T202728-') && t.fy === '2027-28'));
  assert.equal(find(next, 'TDS-DEP', S.TAN_A.id, 'M:2027-04').effective_due, '2027-05-07');
  assert.ok(fs.existsSync(path.join(H.dataDir, 'live_tasks_2027-28.json')));
});

test('workflow: maker → checker → filer → verifier with evidence, exception, separation of duties and stale-update protection', async () => {
  const t = find(S.all, 'GST-3B-M', S.GJ1.id, 'M:2026-04');
  S.t3b = t.id;
  assert.equal((await getTask('1', t.id)).overdue, true, 'not filed and past 20 May');
  ok(await act('m', t.id, 'start'));
  assert.match((await act('m', t.id, 'submit')).body.error, /Upload the working/);
  ok(await upload('m', t.id, 'working', `Working for GSTIN ${S.GJ1.number}, April 2026`, 'working.txt'));
  ok(await act('m', t.id, 'submit'));
  assert.equal((await act('m', t.id, 'approve_filing')).status, 403, 'maker has no review right');
  const cur = await getTask('1', t.id);
  assert.equal((await call('c', 'POST', `/tasks/${t.id}/action`, { action: 'approve_filing', rev: cur.rev - 1 })).status, 409, 'stale view');
  ok(await act('c', t.id, 'approve_filing', { note: 'checked' }));
  assert.match((await act('f', t.id, 'record_filing', { filing: { filed_at: '2026-12-01T10:00:00+05:30', ack_no: 'X' } })).body.error, /future/);
  assert.match((await act('f', t.id, 'record_filing', { filing: { filed_at: '2026-05-19T15:00:00+05:30', ack_no: 'AA2405260000001', payment: { amounts: { tax: 5000 } } } })).body.error, /Payment date is required/);
  ok(await act('f', t.id, 'record_filing', { filing: { filed_at: '2026-05-19T15:00:00+05:30', ack_no: 'AA2405260000001', payment: { date: '2026-05-19', reference: 'CPIN-SYN-1', amounts: { tax: 5000, interest: 0 } } } }));
  ok(await upload('f', t.id, 'filed_return', `GSTR-3B filed copy ${S.GJ1.number} April 2026`, 'gstr3b.txt'));
  assert.equal((await getTask('1', t.id)).status, 'filed_awaiting_verification', 'an upload never changes the status');
  assert.match((await act('v', t.id, 'verify_close', {})).body.error, /Tick that you checked/);
  const miss = await act('v', t.id, 'verify_close', { ack_verified: true });
  assert.equal(miss.status, 400);
  assert.deepEqual(miss.body.missing.sort(), ['acknowledgement', 'payment_proof']);
  ok(await upload('f', t.id, 'acknowledgement', `ARN AA2405260000001 GSTIN ${S.GJ1.number} April 2026`, 'ack.txt'));
  ok(await act('f', t.id, 'request_exception', { note: 'Bank payment advice not yet received from the bank' }));
  assert.equal((await act('f', t.id, 'decide_exception', { decision: 'approve', note: 'x' })).status, 403);
  ok(await act('a', t.id, 'decide_exception', { decision: 'approve', note: 'Accepted for the test; to be filed later' }));
  const done = ok(await act('v', t.id, 'verify_close', { ack_verified: true, note: 'ARN matches the portal' }));
  assert.equal(done.task.status, 'completed');
  assert.equal(done.task.locked, true);
  assert.equal(done.task.on_time, true);
  assert.equal((await upload('f', t.id, 'other', 'late extra', 'extra.txt')).status, 400, 'locked');
});

test('separation of duties binds administrators too; a late filing is flagged', async () => {
  const t = find(S.all, 'GST-R1-M', S.GJ1.id, 'M:2026-05');
  ok(await upload('1', t.id, 'working', `GSTR-1 working ${S.GJ1.number} May 2026`, 'w.txt'));
  ok(await act('1', t.id, 'submit'));
  assert.match((await act('1', t.id, 'approve_filing')).body.error, /You prepared this task/);
  ok(await act('c', t.id, 'approve_filing'));
  ok(await act('f', t.id, 'record_filing', { filing: { filed_at: '2026-06-13T11:00:00+05:30', ack_no: 'AA2406260000002' } }));
  assert.match((await act('1', t.id, 'verify_close', { ack_verified: true })).body.error, /You prepared/);
  ok(await upload('f', t.id, 'filed_return', `GSTR-1 ${S.GJ1.number} May 2026`, 'r1.txt'));
  ok(await upload('f', t.id, 'acknowledgement', `ARN ${S.GJ1.number} May 2026`, 'a1.txt'));
  const d = ok(await act('v', t.id, 'verify_close', { ack_verified: true }));
  assert.equal(d.task.filed_late, true);
  assert.ok(d.task.flags.includes('filed_late'));
});

test('two roles: an Initiator prepares and files, a different Approver checks and closes; neither can do the other\'s part', async () => {
  const t = find(S.all, 'GST-3B-M', S.MH.id, 'M:2026-07');
  ok(await upload('ini', t.id, 'working', `Working ${S.MH.number} July 2026`, 'w.txt'));
  ok(await act('ini', t.id, 'submit'));
  assert.equal((await act('ini', t.id, 'approve_filing')).status, 403, 'an Initiator cannot approve');
  ok(await act('apr', t.id, 'approve_filing'));
  assert.equal((await act('apr', t.id, 'record_filing', { filing: { filed_at: '2026-08-19T10:00:00+05:30', ack_no: 'AA2708260000009' } })).status, 403, 'an Approver cannot record the filing');
  ok(await act('ini', t.id, 'record_filing', { filing: { filed_at: '2026-08-19T10:00:00+05:30', ack_no: 'AA2708260000009' } }));
  for (const k of ['filed_return', 'acknowledgement']) ok(await upload('ini', t.id, k, `${k} ${S.MH.number} July 2026`, `${k}.txt`));
  assert.equal((await act('ini', t.id, 'verify_close', { ack_verified: true })).status, 403, 'an Initiator cannot close');
  const d = ok(await act('apr', t.id, 'verify_close', { ack_verified: true }));
  assert.equal(d.task.status, 'completed');
  // an Initiator cannot approve a pack prepared by SOMEONE ELSE either (it is the role, not only the separation rule)
  const other = find(S.all, 'GST-3B-M', S.MH.id, 'M:2026-08');
  ok(await upload('m', other.id, 'working', `Working ${S.MH.number} August 2026`, 'w8.txt'));
  ok(await act('m', other.id, 'submit'));
  assert.match((await act('ini', other.id, 'approve_filing')).body.error, /needs the review right/);
  const users = ok(await call('1', 'GET', '/users')).users;
  assert.deepEqual(users.find(u => u.id === 'ini').roles, ['Initiator']);
  assert.deepEqual(users.find(u => u.id === 'ini').rights, ['prepare', 'file']);
  assert.deepEqual(users.find(u => u.id === 'apr').roles, ['Approver']);
  assert.deepEqual(users.find(u => u.id === 'apr').rights, ['review', 'verify', 'approve']);
});

test('re-opening creates a new filing version; the original stays as filed', async () => {
  assert.equal((await act('m', S.t3b, 'reopen', { note: 'Revised return needed for a correction' })).status, 403);
  const r = ok(await act('a', S.t3b, 'reopen', { note: 'Revision for a correction found after filing', kind: 'correction' }));
  assert.ok(r.revision_id && r.revision_id !== S.t3b);
  const orig = await getTask('1', S.t3b);
  assert.equal(orig.status, 'completed');
  assert.equal(orig.filing.ack_no, 'AA2405260000001');
  assert.equal(orig.revised_by_task, r.revision_id);
  const rev = await getTask('1', r.revision_id);
  assert.equal(rev.filing_version, 2);
  assert.equal(rev.status, 'in_progress');
  assert.ok(rev.identity.endsWith('|r2'));
  assert.equal((await act('a', S.t3b, 'reopen', { note: 'Again, should be refused now' })).status, 400);
});

test('deadline extension moves only the revised date in scope; fee waiver never moves it; archiving restores', async () => {
  const src = { notification_no: 'SYNTHETIC-EXT-1', source_url: 'https://www.cbic.gov.in/synthetic', retrieved_at: '2026-11-14', issuer: 'CBIC (synthetic)' };
  const x = ok(await call('r', 'POST', '/extensions', { rule_id: 'GST-3B-M', kind: 'deadline_extension', period_keys: ['M:2026-10'], new_due_date: '2026-11-27', scope: { entity_ids: [S.A.id], states: ['GJ'] }, ...src })).extension;
  assert.equal((await call('r', 'POST', `/extensions/${x.id}/approve`, {})).status, 403);
  const ap = ok(await call('a', 'POST', `/extensions/${x.id}/approve`, {}));
  assert.equal(ap.tasks_changed, 1, 'only the Gujarat GSTIN is in scope');
  const gj = find(await tasks('1', '&rule_ids=GST-3B-M'), 'GST-3B-M', S.GJ1.id, 'M:2026-10');
  const mh = find(await tasks('1', '&rule_ids=GST-3B-M'), 'GST-3B-M', S.MH.id, 'M:2026-10');
  assert.deepEqual([gj.original_due, gj.revised_due, gj.effective_due], ['2026-11-20', '2026-11-27', '2026-11-27']);
  assert.equal(mh.revised_due, null);
  assert.equal((await call('r', 'POST', '/extensions', { rule_id: 'GST-3B-M', kind: 'fee_waiver', period_keys: ['M:2026-10'], new_due_date: '2026-11-30', waiver_note: 'late fee', ...src })).status, 400);
  const w = ok(await call('r', 'POST', '/extensions', { rule_id: 'GST-3B-M', kind: 'fee_waiver', period_keys: ['M:2026-10'], waiver_note: 'Late fee waived for filings by 30 Nov (synthetic)', ...src })).extension;
  ok(await call('a', 'POST', `/extensions/${w.id}/approve`, {}));
  const mh2 = await getTask('1', mh.id);
  assert.equal(mh2.fee_waivers.length, 1);
  assert.equal(mh2.revised_due, null, 'fee waiver did not move the date');
  ok(await call('a', 'POST', `/extensions/${x.id}/archive`, { reason: 'Superseded for the test' }));
  const gj2 = await getTask('1', gj.id);
  assert.equal(gj2.revised_due, null);
  assert.equal(gj2.effective_due, '2026-11-20');
});

test('coverage report shows unreviewed and unverified obligations and registration gaps', async () => {
  const cov = ok(await call('1', 'GET', '/coverage?fy=2026-27'));
  const r9 = cov.rows.find(r => r.rule_id === 'GST-R9' && r.scope_id === S.GJ1.id);
  assert.ok(r9.gaps.includes('APPLIC_NOT_REVIEWED') && r9.gaps.includes('RULE_UNVERIFIED'));
  const ok3b = cov.rows.find(r => r.rule_id === 'GST-3B-M' && r.scope_id === S.GJ1.id);
  assert.deepEqual(ok3b.gaps, []);
  assert.ok(cov.registration_checks.some(c => c.entity_id === S.B.id && c.code === 'EMPLOYEES_UNKNOWN'));
  assert.ok(cov.registration_checks.some(c => c.entity_id === S.A.id && c.code === 'MULTI_GSTIN_STATE'));
});

test('overview figures come from the filtered records', async () => {
  const q = `&entity_ids=${S.A.id}&categories=GST`;
  const ov = ok(await call('1', 'GET', `/overview?fy=2026-27${q}`));
  const list = (await tasks('1', q)).filter(t => t.filing_version === 1 && !t.internal);
  assert.equal(ov.totals.obligations, list.length);
  assert.equal(ov.completion.numerator, list.filter(t => t.status === 'completed').length);
  assert.equal(ov.completion.denominator, list.length);
  assert.equal(ov.totals.overdue, list.filter(t => t.overdue).length);
  assert.equal(ov.categories.find(c => c.category === 'SEBI/Exchange').configured, false);
  assert.equal(ov.on_time.denominator, 3, 'April 3B (on time), May R1 (late), July 3B by the two-role test (on time)');
  assert.equal(ov.on_time.numerator, 2);
  const none = ok(await call('1', 'GET', '/overview?fy=2026-27&categories=FEMA/RBI'));
  assert.equal(none.totals.obligations, 0);
  assert.equal(none.completion.pct, null);
});

test('auditor: read-only, sees nothing until scoped, then only the scoped entity', async () => {
  assert.equal(ok(await call('aud', 'GET', '/tasks?fy=2026-27')).total, 0);
  ok(await call('1', 'PUT', '/settings/access', { user_id: 'aud', entities: [S.A.id] }));
  const seen = ok(await call('aud', 'GET', '/tasks?fy=2026-27')).tasks;
  assert.ok(seen.length > 0 && seen.every(t => t.entity_id === S.A.id));
  const one = seen[0];
  assert.equal((await call('aud', 'POST', `/tasks/${one.id}/action`, { action: 'start', rev: one.rev })).status, 403);
  assert.equal((await upload('aud', one.id, 'working', 'x')).status, 403);
  assert.equal((await call('aud', 'POST', '/tasks/generate', { fy: '2026-27' })).status, 403, 'auditor overrides the master right');
  const bTask = S.all.find(t => t.entity_id === S.B.id);
  assert.equal((await call('aud', 'GET', `/tasks/${bTask.id}`)).status, 404);
  const view = ok(await call('aud', 'GET', `/tasks/${one.id}`));
  assert.deepEqual(view.actions, []);
});

test('cross-entity access is rejected for a scoped user', async () => {
  ok(await call('1', 'PUT', '/settings/access', { user_id: 's', entities: [S.B.id] }));
  const aTask = S.all.find(t => t.entity_id === S.A.id && t.status === 'not_started');
  assert.equal((await call('s', 'GET', `/tasks/${aTask.id}`)).status, 404);
  assert.equal((await call('s', 'PATCH', `/tasks/${aTask.id}`, { remarks: 'x', rev: aTask.rev })).status, 404);
  assert.equal((await upload('s', aTask.id, 'working', 'x')).status, 404);
  assert.equal((await call('s', 'POST', '/org/entity', { legal_name: 'Y', short_code: 'YY', type: 'PRIVATE' })).status, 403);
  const mine = ok(await call('s', 'GET', '/tasks?fy=2026-27')).tasks;
  assert.ok(mine.length > 0 && mine.every(t => t.entity_id === S.B.id));
  const org = ok(await call('s', 'GET', '/org'));
  assert.deepEqual(org.entities.map(e => e.id), [S.B.id]);
});

test('documents: versions and recovery, one stored copy, encryption at rest, signed expiring links, refused files', async () => {
  const t = find(S.all, 'GST-3B-M', S.GJ1.id, 'M:2026-06');
  const v1 = ok(await upload('m', t.id, 'working', `June working v1 ${S.GJ1.number} June 2026`, 'june.txt')).document;
  assert.equal((await upload('m', t.id, 'working', `June working v1 ${S.GJ1.number} June 2026`, 'june-again.txt')).status, 409, 'same file twice');
  const v2 = ok(await upload('m', t.id, 'working', `June working v2 ${S.GJ1.number} June 2026`, 'june2.txt', { replace_doc_id: v1.id })).document;
  assert.equal(v2.versions.length, 2);
  const rest = ok(await call('m', 'POST', `/documents/${v1.id}/restore`, { version: 1 })).document;
  assert.equal(rest.versions.length, 3);
  assert.equal(rest.current.sha256, v1.current.sha256, 'version 1 is current again, as version 3');
  // stored encrypted: the plaintext is not on disk
  const stored = fs.readFileSync(path.join(H.filesDir, 'live', `${v1.current.sha256}.c2e`));
  assert.equal(stored.subarray(0, 4).toString(), 'C2E1');
  assert.ok(!stored.includes(Buffer.from('June working v1')));
  // the same challan for another task of the same entity is linked, not stored again
  const t2 = find(S.all, 'GST-3B-M', S.MH.id, 'M:2026-06');
  const before = fs.readdirSync(path.join(H.filesDir, 'live')).length;
  const lk = ok(await upload('m', t2.id, 'working', `June working v1 ${S.GJ1.number} June 2026`, 'june.txt'));
  assert.equal(lk.linked_existing, true);
  assert.equal(fs.readdirSync(path.join(H.filesDir, 'live')).length, before);
  // human-review flag: the MH task's document mentions the GJ GSTIN
  const t3 = find(S.all, 'GST-R1-M', S.MH.id, 'M:2026-06');
  const fl = ok(await upload('m', t3.id, 'working', `Working for GSTIN ${S.GJ1.number}, June 2026`, 'w.txt'));
  assert.ok(fl.flags.some(f => f.code === 'gstin_mismatch'));
  // signed link: works, is bound to a user's current access, and expires
  const link = ok(await call('m', 'POST', `/documents/${v1.id}/link-url`, {}));
  const dl = await call(null, 'GET', link.url.replace('/api/compliance2', ''));
  assert.equal(dl.status, 200);
  assert.equal(crypto.createHash('sha256').update(dl.raw).digest('hex'), v1.current.sha256);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call(null, 'GET', `${link.url.replace('/api/compliance2', '')}x`)).status, 403, 'tampered');
  const realNow = U.clock.now();
  U.clock.set(() => realNow + 10 * 60000);
  assert.equal((await call(null, 'GET', link.url.replace('/api/compliance2', ''))).status, 403, 'expired');
  U.clock.set(() => realNow);
  const sLink = await call('s', 'POST', `/documents/${v1.id}/link-url`, {});
  assert.equal(sLink.status, 404, 'a scoped user cannot get a link to another entity\'s document');
  // refused uploads
  assert.equal((await upload('m', t.id, 'working', '%PDF-1.4 fake', 'x.txt')).status, 415, 'content does not match the name');
  assert.equal((await upload('m', t.id, 'working', 'hello', 'x.exe')).status, 415);
  assert.equal((await upload('m', t.id, 'working', 'X5O!P%@AP-TEST-SIGNATURE', 'v.txt')).status, 422, 'malware scan');
  // legal hold blocks withdrawal
  ok(await call('a', 'POST', `/documents/${v1.id}/hold`, { on: true, reason: 'Synthetic dispute' }));
  assert.match((await call('m', 'POST', `/documents/${v1.id}/withdraw`, { reason: 'not needed' })).body.error, /legal hold/);
  ok(await call('a', 'POST', `/documents/${v1.id}/hold`, { on: false, reason: 'Released' }));
  ok(await call('m', 'POST', `/documents/${v1.id}/withdraw`, { reason: 'Uploaded to the wrong task' }));
  // live uploads need the encryption key
  const key = process.env.C2_FILE_KEY;
  delete process.env.C2_FILE_KEY;
  try { assert.equal((await upload('m', t.id, 'working', 'needs a key 123', 'k.txt')).status, 503); } finally { process.env.C2_FILE_KEY = key; }
});

test('exports: register (CSV / XLSX) with formula injection neutralised, exceptions, coverage, audit pack with matching hashes', async () => {
  const t = find(S.all, 'GST-R1-M', S.GJ1.id, 'M:2026-08');
  const cur = await getTask('1', t.id);
  ok(await call('m', 'PATCH', `/tasks/${t.id}`, { remarks: '=HYPERLINK("http://example.invalid","x")', rev: cur.rev }));
  const csv = await call('1', 'GET', '/export/register.csv?fy=2026-27&rule_ids=GST-R1-M');
  const text = csv.raw.toString('utf8');
  assert.ok(text.includes('\'=HYPERLINK'), 'formula prefixed with an apostrophe');
  assert.ok(!/,=HYPERLINK/.test(text));
  assert.ok(text.includes('Dataset,Live'));
  const x = await call('1', 'GET', '/export/register.xlsx?fy=2026-27&rule_ids=GST-R1-M');
  const wb = XLSX.read(x.raw, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Register);
  assert.equal(rows.length, (await tasks('1', '&rule_ids=GST-R1-M')).length);
  const ex = (await call('1', 'GET', '/export/exceptions.csv?fy=2026-27')).raw.toString();
  assert.ok(ex.includes('Filed late') && ex.includes('Overdue'));
  assert.ok((await call('1', 'GET', '/export/coverage.csv?fy=2026-27')).raw.toString().includes('Not decided'));
  const z = await call('1', 'GET', `/export/audit.zip?fy=2026-27&rule_ids=GST-3B-M&entity_ids=${S.A.id}`);
  const entries = H.unzip(z.raw);
  const names = entries.map(e => e.name);
  assert.ok(names.includes('README.txt') && names.includes('evidence_manifest.csv') && names.includes('audit.jsonl'));
  const manifest = XLSX.utils.sheet_to_json(XLSX.read(entries.find(e => e.name === 'evidence_manifest.csv').data.toString('utf8').replace(/^﻿/, ''), { type: 'string' }).Sheets.Sheet1, { range: 7 });
  const files = entries.filter(e => e.name.startsWith('evidence/'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const row = manifest.find(m => m['File in pack'] === f.name);
    assert.ok(row, f.name);
    assert.equal(crypto.createHash('sha256').update(f.data).digest('hex'), row['SHA-256']);
  }
  const auditor = await call('aud', 'GET', `/export/register.csv?fy=2026-27&entity_ids=${S.B.id}`);
  assert.ok(!auditor.raw.toString().includes(S.DL.number), 'the auditor\'s export leaves out entities outside the scope');
});

test('import: preview shows errors and nothing is saved; a clean file is saved as drafts; v1 companies carry over as drafts', async () => {
  const tpl = await call('m', 'GET', '/import/template.xlsx');
  assert.deepEqual(XLSX.read(tpl.raw, { type: 'buffer' }).SheetNames, ['Read_me', 'Entities', 'FY_Facts', 'Registrations', 'Establishments', 'People']);
  const book = rows => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Entities'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
  const bad = book([{ short_code: 'SYNC', legal_name: 'Synthetic Gamma Pvt Ltd', type: 'PRIVATE', pan: PAN_A }]);
  const pv = ok(await call('m', 'POST', '/import/preview', undefined, { form: H.fileForm(bad, 'm.xlsx') }));
  assert.equal(pv.errors, 1);
  assert.match(pv.results[0].error, /already has PAN/);
  assert.equal((await call('m', 'POST', '/import/commit', undefined, { form: H.fileForm(bad, 'm.xlsx') })).status, 400);
  const good = book([{ short_code: 'SYNC', legal_name: 'Synthetic Gamma Pvt Ltd', type: 'PRIVATE', pan: 'ZZZCG7003M', listed: 'No', has_employees: 'Yes' }]);
  ok(await call('m', 'POST', '/import/commit', undefined, { form: H.fileForm(good, 'm.xlsx') }));
  const org = ok(await call('1', 'GET', '/org'));
  const c = org.entities.find(e => e.short_code === 'SYNC');
  assert.equal(c.data_status, 'draft');
  assert.equal(c.flags.has_employees, true);
  // Compliance v1 (a synthetic copy of its data file)
  const v1store = require('../../compliance/lib/store');
  const v1dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'c2v1-'));
  fs.writeFileSync(path.join(v1dir, 'compliance_data.json'), JSON.stringify({ schema_version: 1, companies: [{ id: 'CO-9', name: 'Synthetic Old Co Pvt Ltd', short_code: 'OLDC', zoho_org_id: '' }] }));
  v1store.configure({ dir: v1dir, useDb: false });
  const v1 = ok(await call('m', 'POST', '/import-v1/preview'));
  assert.equal(v1.results[0].action, 'new');
  assert.ok(v1.results[0].warnings.some(w => /PAN not recorded/.test(w)));
  ok(await call('m', 'POST', '/import-v1/commit'));
  const old = ok(await call('1', 'GET', '/org')).entities.find(e => e.short_code === 'OLDC');
  assert.equal(old.type, 'PRIVATE');
  assert.match((await call('a', 'POST', `/org/entity/${old.id}/approve`)).body.error, /Record the PAN, CIN/);
});

test('demo and live are separate; demo personas run the flow on demo data only; an AGM change moves AOC-4', async () => {
  const demo = ok(await call('1', 'GET', '/tasks?fy=2026-27', undefined, { space: 'demo' }));
  assert.ok(demo.total > 100);
  assert.ok(demo.tasks.every(t => t.sample === true));
  assert.equal((await call('1', 'GET', `/tasks/${demo.tasks[0].id}`)).status, 404, 'a demo task does not exist in live');
  assert.ok(!(await tasks('1')).some(t => t.sample));
  const meta = ok(await call('1', 'GET', '/meta', undefined, { space: 'demo' }));
  assert.ok(meta.demo.snapshot_date);
  // persona: a checker approves the demo task waiting for review; personas are ignored in live
  const waiting = demo.tasks.find(t => t.status === 'ready_for_review');
  const ap = await call('1', 'POST', `/tasks/${waiting.id}/action`, { action: 'approve_filing', rev: waiting.rev }, { space: 'demo', persona: 'approver' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.match(ap.body.task.history.at(-1).by, /Approver \(demo persona of Admin\)/);
  assert.equal(ok(await call('m', 'GET', '/meta', undefined, { persona: 'approver' })).actor.persona, null);
  // AGM moved → AOC-4 (AGM + 30 days) recomputed with history
  const fy26 = ok(await call('1', 'GET', '/tasks?fy=2025-26', undefined, { space: 'demo' })).tasks;
  const aoc = fy26.find(t => t.rule_id === 'ROC-AOC4' && /Alpha/.test(t.scope_label));
  assert.equal(aoc.effective_due, '2026-10-26');
  const ev = ok(await call('1', 'GET', '/events', undefined, { space: 'demo' })).events.find(e => e.type === 'AGM' && e.entity_id === aoc.entity_id);
  const upd = ok(await call('1', 'PUT', `/events/${ev.id}`, { ...ev, event_date: '2026-09-29', reason: 'AGM adjourned (illustrative)' }, { space: 'demo' }));
  assert.ok(upd.recomputed >= 2, 'AOC-4 and MGT-7');
  const after = ok(await call('1', 'GET', `/tasks/${aoc.id}`, undefined, { space: 'demo' })).task;
  assert.equal(after.effective_due, '2026-10-29');
  assert.equal(after.history.at(-1).action, 'due_recomputed');
  // demo files use the demo store, never the live one
  assert.ok(fs.readdirSync(path.join(H.filesDir, 'demo')).length > 10);
});

test('audit trail: every change recorded, chain verifies, tampering is detected', async () => {
  const entries = ok(await call('1', 'GET', `/audit?object_id=${S.t3b}`)).entries;
  const actions = entries.map(e => e.action);
  for (const a of ['task_start', 'task_submit', 'task_approve_filing', 'task_record_filing', 'task_verify_close', 'task_reopen']) assert.ok(actions.includes(a), a);
  const closing = entries.find(e => e.action === 'task_verify_close');
  assert.equal(closing.actor, 'Verifier');
  assert.equal(closing.before.status, 'filed_awaiting_verification');
  assert.equal(closing.after.status, 'completed');
  assert.equal(ok(await call('1', 'GET', '/audit/verify')).ok, true);
  const file = fs.readdirSync(H.dataDir).find(f => /^live_audit_2026_11\.json$/.test(f));
  const list = JSON.parse(fs.readFileSync(path.join(H.dataDir, file), 'utf8'));
  list[3].summary = 'changed afterwards';
  fs.writeFileSync(path.join(H.dataDir, file), JSON.stringify(list));
  store.configure({ dir: H.dataDir });                                       // drop the in-memory copy
  const v = ok(await call('1', 'GET', '/audit/verify'));
  assert.equal(v.ok, false);
  assert.equal(v.at_seq, list[3].seq);
});
