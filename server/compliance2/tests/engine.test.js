/**
 * Engine tests (no server): due dates, periods, identifiers, applicability logic, rules lifecycle, extensions, store retry.
 * All entities, numbers and dates are SYNTHETIC test data.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-compliance2';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DE = require('../lib/dueEngine');
const V = require('../lib/validate');
const AP = require('../lib/applicability');
const RU = require('../lib/rules');
const CAT = require('../lib/catalogue');
const T = require('../lib/tasks');
const U = require('../lib/util');
const store = require('../lib/store');
const EXP = require('../lib/exporter');
const MET = require('../lib/metrics');

const month = ym => DE.periodFromKey(`M:${ym}`);
const due = (expr, period, extra = {}) => DE.computeDue(expr, { period, ...extra });

test('monthly periods run April to March, quarters and halves follow the Indian FY', () => {
  const ps = DE.periodsOf('monthly', '2026-27');
  assert.equal(ps.length, 12);
  assert.equal(ps[0].key, 'M:2026-04');
  assert.equal(ps[11].key, 'M:2027-03');
  assert.equal(ps[11].fy, '2026-27');
  const q = DE.periodsOf('quarterly', '2026-27');
  assert.deepEqual(q.map(p => [p.start, p.end]), [['2026-04-01', '2026-06-30'], ['2026-07-01', '2026-09-30'], ['2026-10-01', '2026-12-31'], ['2027-01-01', '2027-03-31']]);
  assert.deepEqual(DE.periodsOf('half_yearly', '2026-27').map(p => p.end), ['2026-09-30', '2027-03-31']);
  assert.throws(() => DE.periodsOf('monthly', '2026-28'), /not a financial year/);
});

test('year rollover: March period → next financial year date; FY of dates', () => {
  assert.equal(U.fyOf('2027-03-31'), '2026-27');
  assert.equal(U.fyOf('2027-04-01'), '2027-28');
  const tds = CAT.RULES.find(r => r.id === 'TDS-DEP').versions[1].due;
  assert.equal(due(tds, month('2027-03')).date, '2027-04-30', 'March TDS: special rule');
  assert.equal(due(tds, month('2026-04')).date, '2026-05-07');
  assert.equal(due(tds, month('2026-12')).date, '2027-01-07', 'December → January of the next calendar year');
  assert.equal(due({ type: 'next_date_after_period_end', month: 12, day: 31 }, DE.yearPeriod('2026-27')).date, '2027-12-31', 'GSTR-9: 31 December after the FY');
});

test('no weekend or holiday roll-forward', () => {
  // 11 Oct 2026 is a Sunday: stays a Sunday
  const d = due({ type: 'next_month_day', day: 11, months_after: 1 }, month('2026-09')).date;
  assert.equal(d, '2026-10-11');
  assert.equal(new Date(`${d}T00:00:00Z`).getUTCDay(), 0);
});

test('a day that does not exist is an error, not silently moved; "last" and clamp handle leap years', () => {
  const r = due({ type: 'next_month_day', day: 29, months_after: 1 }, month('2027-01'));
  assert.equal(r.date, null);
  assert.match(r.error, /Day 29 does not exist in Feb 2027/);
  assert.equal(due({ type: 'next_month_day', day: 29, months_after: 1 }, month('2028-01')).date, '2028-02-29', '2028 is a leap year');
  assert.equal(due({ type: 'next_month_day', day: 'last', months_after: 1 }, month('2027-01')).date, '2027-02-28');
  assert.equal(due({ type: 'next_month_day', day: 31, months_after: 1, clamp: true }, month('2026-05')).date, '2026-06-30');
});

test('QRMP: quarterly GSTR-1 on the 13th, GSTR-3B by state group (22nd / 24th), IFF and PMT-06 in M1–M2 only', () => {
  const q1 = DE.quarterPeriod('2026-27', 'Q1');
  const r1q = CAT.RULES.find(r => r.id === 'GST-R1-Q').versions[0].due;
  assert.equal(due(r1q, q1).date, '2026-07-13');
  const b3q = CAT.RULES.find(r => r.id === 'GST-3B-Q').versions[0].due;
  assert.equal(due(b3q, q1, { registration: { state: 'GJ' } }).date, '2026-07-22');
  assert.equal(due(b3q, q1, { registration: { state: 'DL' } }).date, '2026-07-24');
  assert.match(due(b3q, q1, { registration: { state: 'OT' } }).pending, /not in this rule's state-group table/);
  const iff = DE.periodsOf('monthly', '2026-27', { months_in_quarter: [1, 2] });
  assert.equal(iff.length, 8);
  assert.ok(!iff.some(p => ['M:2026-06', 'M:2026-09', 'M:2026-12', 'M:2027-03'].includes(p.key)), 'no third month of a quarter');
  assert.equal(due(CAT.RULES.find(r => r.id === 'GST-PMT06').versions[0].due, month('2026-04')).date, '2026-05-25');
});

test('SEBI results: 45 days after a quarter, 60 days after Q4; MSME-1 halves; advance-tax instalments', () => {
  const fr = CAT.RULES.find(r => r.id === 'SEBI-FR').versions[0].due;
  assert.equal(due(fr, DE.quarterPeriod('2026-27', 'Q1')).date, '2026-08-14');
  assert.equal(due(fr, DE.quarterPeriod('2026-27', 'Q4')).date, '2027-05-30');
  const msme = CAT.RULES.find(r => r.id === 'ROC-MSME1').versions[0].due;
  assert.equal(due(msme, DE.halfPeriod('2026-27', 'H1')).date, '2026-10-31');
  assert.equal(due(msme, DE.halfPeriod('2026-27', 'H2')).date, '2027-04-30');
  const adv = CAT.RULES.find(r => r.id === 'IT-ADV').versions[1].due;
  assert.deepEqual(DE.periodsOf('installments', '2026-27', { installments: 4 }).map(p => due(adv, p).date), ['2026-06-15', '2026-09-15', '2026-12-15', '2027-03-15']);
});

test('event-relative deadlines: AGM + days, hours after a timed event, reply date from a notice', () => {
  const y = DE.yearPeriod('2025-26');
  const agm = { id: 'V-1', type: 'AGM', fy: '2025-26', event_date: '2026-09-26' };
  assert.equal(due({ type: 'event_offset', event_type: 'AGM', days: 30 }, y, { events: [agm] }).date, '2026-10-26');
  assert.match(due({ type: 'event_offset', event_type: 'AGM', days: 30 }, y, { events: [] }).pending, /Waiting for the AGM/);
  const ev = { id: 'V-2', type: 'MATERIAL_EVENT', event_date: '2026-11-10', event_at: '2026-11-10T19:15:00+05:30' };
  const h = due({ type: 'event_offset', event_type: 'MATERIAL_EVENT', hours: 24 }, { key: 'E:V-2', fy: '2026-27' }, { event: ev });
  assert.equal(h.at, '2026-11-11T13:45:00.000Z');
  assert.equal(h.date, '2026-11-11');
  const late = due({ type: 'event_offset', event_type: 'MATERIAL_EVENT', hours: 6 }, { key: 'E:V-2', fy: '2026-27' }, { event: ev });
  assert.equal(late.date, '2026-11-11', 'an evening event + 6 hours falls on the next Indian date');
  assert.equal(due({ type: 'event_field', field: 'response_due' }, { key: 'E:V-3' }, { event: { type: 'NOTICE', response_due: '2026-11-19' } }).date, '2026-11-19');
});

test('Professional Tax is scoped by state: no rule for a state = no date (missing-rule queue), never a nationwide date', () => {
  const pt = CAT.RULES.find(r => r.id === 'PT-PTRC-PAY').versions[0].due;
  assert.equal(due(pt, month('2026-04'), { registration: { state: 'GJ' } }).date, '2026-05-15');
  const mh = due(pt, month('2026-04'), { registration: { state: 'MH' } });
  assert.equal(mh.date, null);
  assert.equal(mh.missing_rule, true);
  assert.match(mh.pending, /No rule recorded for state MH/);
  for (const id of ['PT-PTRC-RET', 'PT-PTEC', 'LWF']) assert.equal(CAT.RULES.find(r => r.id === id).versions[0].due.type, 'by_state');
});

test('a task without a due date is never overdue; a hours-based one is overdue by the clock', () => {
  const base = { id: 'T202627-aa', status: 'not_started', original_due: null, revised_due: null, filing: null, evidence_rule: { close: [] }, nature: 'return', history: [] };
  const d = T.derive(base, { today: '2030-01-01', nowMs: Date.parse('2030-01-01T00:00:00Z') });
  assert.equal(d.overdue, false);
  assert.equal(d.no_due_date, true);
  const timed = { ...base, original_due: '2026-11-11', original_due_at: '2026-11-11T13:45:00.000Z' };
  assert.equal(T.derive(timed, { today: '2026-11-11', nowMs: Date.parse('2026-11-11T13:00:00Z') }).overdue, false);
  assert.equal(T.derive(timed, { today: '2026-11-11', nowMs: Date.parse('2026-11-11T14:00:00Z') }).overdue, true);
});

test('GSTIN check character, PAN inside the GSTIN, state code; PAN holder type', () => {
  const g = `24ZZZCA9001K1Z${V.gstinCheckChar('24ZZZCA9001K1Z')}`;
  assert.equal(V.gstin(g, { entityPan: 'ZZZCA9001K', state: 'GJ' }).ok, true);
  assert.match(V.gstin(`${g.slice(0, 14)}${g[14] === 'A' ? 'B' : 'A'}`).errors[0], /check character/);
  assert.match(V.gstin(g, { entityPan: 'ZZZCB9001K' }).errors.join(), /belongs to PAN ZZZCA9001K/);
  assert.match(V.gstin(g, { state: 'MH' }).errors.join(), /does not match the registration state/);
  assert.equal(V.pan('ZZZPA9001K', 'company').warnings.length, 1, 'an individual PAN on a company is warned');
  assert.equal(V.tan('AHMZ90001A').ok, true);
  assert.equal(V.cin('U74999GJ2019PTC100001', { listed: true }).warnings.length, 1);
});

test('applicability: missing facts make "needs review", never "not applicable"', () => {
  const ctx = { entity: { type: 'PRIVATE', flags: {} }, fy: '2026-27' };
  const r = AP.evaluate({ fact: 'entity.flags.has_exports', eq: true }, ctx);
  assert.equal(r.value, null);
  assert.deepEqual(r.missing, ['entity.flags.has_exports']);
  assert.equal(AP.evaluate({ any: [{ fact: 'entity.flags.has_fdi', eq: true }, { fact: 'entity.flags.has_odi', eq: true }] }, { entity: { flags: { has_fdi: false } } }).value, null, 'false OR unknown = unknown');
  assert.equal(AP.evaluate({ any: [{ fact: 'entity.flags.has_fdi', eq: true }, { fact: 'entity.flags.has_odi', eq: true }] }, { entity: { flags: { has_fdi: true } } }).value, true, 'true OR unknown = true');
  assert.equal(AP.evaluate({ all: [{ fact: 'entity.listed', eq: true }, { fact: 'entity.flags.x', eq: true }] }, { entity: { listed: false, flags: {} } }).value, false, 'false AND unknown = false');
  assert.equal(AP.evaluate(null, ctx).value, null, 'no automatic test = a person decides');
  assert.equal(AP.evaluate({ fact: 'entity.prev_fy.turnover', gte: 100 }, { entity: { fy_facts: { '2025-26': { turnover: 150 } } }, fy: '2026-27' }).value, true, 'preceding FY facts');
});

test('catalogue: every version is an unverified draft; listed and LLP obligations are separate rules', () => {
  for (const r of CAT.RULES) {
    assert.ok(r.versions.length, r.id);
    for (const v of r.versions) { assert.equal(v.status, 'draft', r.id); assert.equal(v.verified_by, ''); assert.deepEqual(DE.checkExpr(v.due ?? null), [], r.id); }
  }
  assert.equal(new Set(CAT.RULES.map(r => r.id)).size, CAT.RULES.length);
  // equity-listing and debt-listing obligations are separate rules with separate tests
  const ent = (listed, listing_type) => ({ entity: { type: 'PUBLIC', listed, listing_type, flags: {} }, fy: '2026-27' });
  for (const id of ['SEBI-FR', 'SEBI-CGR', 'SEBI-SHP']) {
    const a = CAT.RULES.find(r => r.id === id).versions[0].applicability;
    assert.equal(AP.evaluate(a, ent(true, 'equity')).value, true, id);
    assert.equal(AP.evaluate(a, ent(true, 'debt')).value, false, `${id}: NCD-only listing`);
    assert.equal(AP.evaluate(a, ent(false, null)).value, false, `${id}: unlisted`);
    assert.equal(AP.evaluate(a, ent(true, null)).value, null, `${id}: listed, type unknown = needs review`);
  }
  for (const id of ['SEBI-D-FR', 'SEBI-D-UTIL', 'SEBI-D-AR']) {
    const a = CAT.RULES.find(r => r.id === id).versions[0].applicability;
    assert.equal(AP.evaluate(a, ent(true, 'debt')).value, true, id);
    assert.equal(AP.evaluate(a, ent(true, 'equity_and_debt')).value, true, id);
    assert.equal(AP.evaluate(a, ent(true, 'equity')).value, false, id);
  }
  assert.deepEqual(CAT.RULES.find(r => r.id === 'LLP-11').scope.entity_kinds, ['llp']);
  assert.deepEqual(CAT.RULES.find(r => r.id === 'ROC-MSME1').scope.entity_kinds, ['company'], 'MSME-1 not automatic for LLPs');
  const tds = CAT.RULES.find(r => r.id === 'TDS-STMT-SAL').versions;
  assert.equal(tds[0].form, '24Q');
  assert.equal(tds[0].effective_to, '2026-03-31');
  assert.equal(tds[1].form, '', 'Income-tax Act, 2025 period: legacy form number not assumed');
  for (const r of CAT.RULES.filter(x => x.category === 'Professional Tax')) assert.equal(r.versions[0].due.type, 'by_state');
});

test('rule versions: live uses approved only; verifier cannot approve; overlap trims the older version', () => {
  const doc = RU.EMPTY();
  RU.seed(doc);
  const rule = doc.rules.find(r => r.id === 'GST-R1-M');
  assert.match(RU.versionFor(rule, '2026-04-01', { live: true }).blocked, /unverified draft/);
  assert.equal(RU.versionFor(rule, '2026-04-01', { live: false }).unverified, true);
  const ver = { id: 'u1', name: 'Verifier' }, apr = { id: 'u2', name: 'Approver' };
  assert.throws(() => RU.verify(doc, 'GST-R1-M', 1, { source_url: 'https://www.cbic.gov.in/x' }, ver), /Notification|Date the source|Verification note/);
  RU.verify(doc, 'GST-R1-M', 1, { source_url: 'https://www.cbic.gov.in/x', notification_no: 'TEST 1/2017', notification_date: '2017-06-28', retrieved_at: '2026-11-14', verification_note: 'synthetic test', effective_from: '2017-07-01' }, ver);
  assert.throws(() => RU.approve(doc, 'GST-R1-M', 1, {}, ver), /cannot also approve/);
  RU.approve(doc, 'GST-R1-M', 1, {}, apr);
  assert.equal(RU.versionFor(rule, '2026-04-01', { live: true }).version.version, 1);
  const v2 = RU.newDraft(doc, 'GST-R1-M', { effective_from: '2027-04-01' }, ver);
  RU.editDraft(doc, 'GST-R1-M', v2.version, { due: { type: 'next_month_day', day: 10, months_after: 1 } }, ver);
  assert.throws(() => RU.editDraft(doc, 'GST-R1-M', 1, { notes: 'x' }, ver), /cannot be edited/);
  RU.verify(doc, 'GST-R1-M', v2.version, { source_url: 'https://www.cbic.gov.in/y', standing_provision: true, retrieved_at: '2026-11-14', verification_note: 'test' }, ver);
  RU.approve(doc, 'GST-R1-M', v2.version, {}, apr);
  assert.equal(rule.versions[0].effective_to, '2027-03-31');
  assert.equal(RU.versionFor(rule, '2027-04-01', { live: true }).version.version, 2);
  assert.equal(RU.versionFor(rule, '2027-03-01', { live: true }).version.version, 1);
});

test('catalogue upgrade: adds new rules, updates untouched ones, never overwrites an edited rule', () => {
  const doc = RU.EMPTY();
  RU.seed(doc);
  doc.catalogue_version = 1;
  doc.rules = doc.rules.filter(r => r.id !== 'SEBI-D-FR');                       // as a v1 space: the debt rule is missing
  const fr = doc.rules.find(r => r.id === 'SEBI-FR');
  fr.versions[0].applicability = { fact: 'entity.listed', eq: true };          // the v1 definition, untouched
  const shp = doc.rules.find(r => r.id === 'SEBI-SHP');
  shp.versions[0].applicability = { fact: 'entity.listed', eq: true };
  RU.editDraft(doc, 'SEBI-SHP', 1, { notes: 'edited by a person' }, { id: 'u', name: 'User' });
  const r = RU.upgrade(doc);
  assert.ok(r.added.includes('SEBI-D-FR'));
  assert.ok(r.updated.includes('SEBI-FR'));
  assert.ok(r.kept_edited.includes('SEBI-SHP'));
  assert.notDeepEqual(doc.rules.find(x => x.id === 'SEBI-FR').versions[0].applicability, { fact: 'entity.listed', eq: true });
  assert.equal(doc.rules.find(x => x.id === 'SEBI-SHP').versions[0].notes, 'edited by a person');
  assert.equal(doc.rules.find(x => x.id === 'SEBI-FR').history.at(-1).action, 'updated');
  assert.deepEqual(RU.upgrade(doc), { added: [], updated: [], kept_edited: [] }, 'second run does nothing');
});

test('extensions: a fee waiver cannot move the date; archived extensions no longer apply', () => {
  const doc = RU.EMPTY();
  RU.seed(doc);
  const a = { id: 'a', name: 'A' }, b = { id: 'b', name: 'B' };
  assert.throws(() => RU.createExtension(doc, { rule_id: 'GST-3B-M', kind: 'fee_waiver', period_keys: ['M:2026-10'], new_due_date: '2026-11-30', waiver_note: 'x' }, a), /does not change the due date/);
  const x = RU.createExtension(doc, { rule_id: 'GST-3B-M', kind: 'deadline_extension', period_keys: ['M:2026-10'], new_due_date: '2026-11-25', scope: { states: ['GJ'] }, notification_no: 'TEST', source_url: 'https://www.cbic.gov.in/t', retrieved_at: '2026-11-14', issuer: 'CBIC' }, a);
  assert.throws(() => RU.setExtensionStatus(doc, x.id, 'approve', {}, a), /cannot also approve/);
  RU.setExtensionStatus(doc, x.id, 'approve', {}, b);
  const task = { rule_id: 'GST-3B-M', period_key: 'M:2026-10', state: 'GJ', entity_id: 'E-1', registration_id: 'R-1', original_due: '2026-11-20', history: [] };
  T.applyExtensions(task, doc, b);
  assert.equal(task.revised_due, '2026-11-25');
  const other = { ...task, state: 'MH', history: [] };
  T.applyExtensions(other, doc, b);
  assert.equal(other.revised_due, null, 'out of scope');
  RU.setExtensionStatus(doc, x.id, 'archive', { reason: 'test' }, b);
  T.applyExtensions(task, doc, b);
  assert.equal(task.revised_due, null);
  assert.equal(task.history.at(-1).action, 'revised_due');
});

test('on-time is judged against the effective (extended) date; a fee waiver does not make a late filing on time', () => {
  const t = { id: 'T202627-bb', status: 'completed', original_due: '2026-11-20', revised_due: '2026-11-25', filing: { filed_at: '2026-11-23T10:00:00Z', filed_on: '2026-11-23' }, evidence_rule: { close: [] }, nature: 'return', history: [] };
  assert.equal(T.derive(t, { today: '2026-12-01', nowMs: 0 }).on_time, true);
  const w = { ...t, revised_due: null, fee_waivers: [{ id: 'X-1' }] };
  const d = T.derive(w, { today: '2026-12-01', nowMs: 0 });
  assert.equal(d.on_time, false);
  assert.equal(d.filed_late, true);
});

test('overview: zero denominators, empty categories "not configured", flags overlap while states are exclusive', () => {
  const empty = MET.overview([], {});
  assert.equal(empty.completion.denominator, 0);
  assert.equal(empty.completion.pct, null);
  assert.ok(empty.categories.every(c => c.configured === false && c.completion === null));
  const mk = (o) => T.derive({ id: `T202627-${Math.random().toString(16).slice(2, 8)}`, rule_id: 'X', category: 'GST', filing_version: 1, internal: false, status: 'not_started', original_due: '2026-10-20', evidence_rule: { close: ['acknowledgement'] }, nature: 'return', history: [], ...o }, { today: '2026-11-14', nowMs: 0 });
  const list = [mk({ status: 'ready_for_review' }), mk({ status: 'completed', filing: { filed_at: '2026-10-19T10:00:00Z', filed_on: '2026-10-19' } }), mk({ original_due: null })];
  const ov = MET.overview(list, {});
  assert.equal(ov.totals.obligations, 3);
  assert.equal(ov.totals.overdue, 1);
  assert.equal(ov.totals.review, 1, 'the overdue task is also in the review queue (flags overlap)');
  assert.equal(Object.values(ov.states).reduce((a, b) => a + b, 0), 3, 'exclusive states add up to the total');
  assert.equal(ov.completion.numerator, 1);
  assert.equal(ov.on_time.denominator, 1);
  assert.equal(ov.flags.evidence_missing, 1, 'completed without its acknowledgement');
  assert.equal(ov.categories.find(c => c.category === 'SEBI/Exchange').configured, false);
});

test('exports: formula injection neutralised; ZIP entries carry correct CRC-32', () => {
  assert.equal(EXP.safeCell('=HYPERLINK("http://x")'), '\'=HYPERLINK("http://x")');
  assert.equal(EXP.safeCell('+1+1'), "'+1+1");
  assert.equal(EXP.safeCell(-5), -5, 'numbers stay numbers');
  const csv = EXP.csv([{ label: 'v', get: r => r }], ['@SUM(A1)', 'ok'], {});
  assert.ok(csv.includes("'@SUM(A1)"));
  const z = EXP.zip([{ name: 'a.txt', data: 'hello hello hello hello' }, { name: 'b/c.bin', data: Buffer.from([1, 2, 3]) }]);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(z.readUInt32LE(14), EXP.crc32(Buffer.from('hello hello hello hello')));
  const ics = EXP.ics([{ id: 'T1', effective_due: '2026-11-20', rule_name: 'GSTR-3B', period_label: 'Oct 2026', scope_label: 'GJ, A', status_label: 'Not started', category: 'GST' }, { id: 'T2', effective_due: null }]);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1, 'tasks without a due date are not put in the calendar');
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261120'));
});

test('store: a write that loses a race on Neon is re-run on fresh data; a failure writes nothing', async () => {
  const rows = new Map();
  let stamp = 0, failNext = 1, calls = 0;
  const fake = {
    async readJSONStamped(key) { const r = rows.get(key); return r ? { value: JSON.parse(r.text), at: r.at } : { value: undefined, at: null }; },
    async writeJSONManyIfUnchanged(entries) {
      if (failNext-- > 0) { rows.set('c2_k', { text: JSON.stringify({ n: 100 }), at: `s${++stamp}` }); return false; }   // someone else wrote meanwhile
      for (const e of entries) { const cur = rows.get(e.key); if ((cur?.at ?? null) !== e.at) return false; }
      for (const e of entries) rows.set(e.key, { text: JSON.stringify(e.value), at: `s${++stamp}` });
      return true;
    },
    async listKeys() { return []; },
  };
  store.configure({ useDb: true, db: fake });
  try {
    await store.transaction(async tx => { calls++; const d = await tx.get('k', { n: 0 }); d.n += 1; tx.set('k', d); });
    assert.equal(calls, 2, 're-run after the conflict');
    assert.equal(JSON.parse(rows.get('c2_k').text).n, 101, 'applied on top of the other writer\'s value');
    await assert.rejects(store.transaction(async tx => { const d = await tx.get('k', {}); d.n = -1; tx.set('k', d); throw new Error('boom'); }), /boom/);
    assert.equal(JSON.parse(rows.get('c2_k').text).n, 101, 'nothing written');
  } finally {
    store.configure({ useDb: false, db: undefined, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'c2store-')) });
  }
});
