/**
 * Email reminders to the owners of open reconciliation rows.
 *
 *   daily email   one per owner per day, on the days and at the time set in Settings → Email reminders (India time): the owner's rows that
 *                 are overdue, due today, due within the next few days and newly assigned since their last email — and, weekly or daily
 *                 as set, their open rows without a due date. Nobody is emailed about nothing.
 *   on assignment an email at once to the person rows are given to (not when they assign rows to themselves).
 *   summary       optionally, one email to the managers' addresses: every owner's numbers and the overdue / due-today rows.
 *
 * What counts as open, overdue and "whose row" is defined once, in lib/tasks.js. A row is only ever described to a person who is allowed
 * to see its GSTIN; rows of the demo company are never emailed. Sending goes through lib/mailer.js; nothing here knows a credential.
 *
 * The scheduler calls tick() often (every 15 minutes online); it does something only when the time has come and today's emails have
 * not gone out yet. State (`reminders`): per day who was sent what, with failures and attempts — a failed email is tried again on the
 * next call, three times a day at most — and a log of the last emails. A short lease keeps two callers from sending the same emails.
 */

'use strict';

const store = require('./store');
const CFG = require('./config');
const N = require('./normalize');
const RV = require('./review');
const T = require('./tasks');
const MAIL = require('./reminderMail');
const { STATUS } = require('./match');
const { gst, sumSide } = require('./dash');
const { uid, sleep, nowIso } = require('./util');

const KEY = 'reminders';
const KEEP_DAYS = 40, KEEP_LOG = 300, MAX_ATTEMPTS = 3, LEASE_MS = 3 * 60000;
const CONNECTION = new Set(['mail_auth', 'mail_forbidden', 'mail_no_mailbox', 'mail_not_set_up']);   // the mailbox itself refuses: the same for every email
// told: "<user id>|<document id>" → when the assignment email told that person about that row, so the next daily email does not list it as new
const EMPTY = () => ({ days: {}, log: [], lease: null, told: {} });
const shape = doc => { const d = doc && typeof doc === 'object' ? doc : {}; return { days: d.days || {}, log: d.log || [], lease: d.lease || null, told: d.told || {} }; };

// India time (UTC + 5:30) from a clock value in milliseconds
const weekday = now => new Date(now + 330 * 60000).getUTCDay();
const hhmm = now => new Date(now + 330 * 60000).toISOString().slice(11, 16);
const dueNow = (r, now) => r.days.includes(weekday(now)) && hhmm(now) >= r.time;
/** The next moment a daily email is due, strictly after `now` */
function nextAt(r, now) {
  for (let i = 0; i < 8; i++) {
    const t = now + i * 86400000;
    if (!r.days.includes(weekday(t))) continue;
    const at = Date.parse(`${N.todayIST(t)}T${r.time}:00+05:30`);
    if (at > now) return new Date(at).toISOString();
  }
  return null;
}
// rows without a due date are listed every day, or once a week on the first sending day counted from Monday
const weeklyDay = r => [1, 2, 3, 4, 5, 6, 0].find(d => r.days.includes(d));
const listsUndated = (r, now) => r.undated === 'daily' || (r.undated === 'weekly' && weekday(now) === weeklyDay(r));
const byDue = (a, b) => String(a.due).localeCompare(String(b.due)) || String(a.supplier).localeCompare(String(b.supplier));

function create({ cfgNow, usersOf, recon, mailer, audit, log = console, env = process.env, sleepFn = sleep }) {
  const load = async () => shape(await store.read(KEY, null));
  const save = fn => store.update(KEY, EMPTY(), doc => {
    const d = shape(doc);
    fn(d);
    d.days = Object.fromEntries(Object.keys(d.days).sort().slice(-KEEP_DAYS).map(k => [k, d.days[k]]));
    d.log = d.log.slice(0, KEEP_LOG);
    const since = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
    d.told = Object.fromEntries(Object.entries(d.told).filter(([, at]) => at >= since));
    return d;
  });
  const entry = (d, e) => { d.log.unshift({ at: nowIso(), ...e }); };
  const appUrl = cfg => cfg.reminders.app_url || String(env.G2B_APP_URL || '').trim().replace(/\/+$/, '') || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '');

  /** One reconciliation row as an email describes it */
  function itemOf(co, reg, row, m, today, soonDays) {
    const sign = row.doc_type === 'CRN' ? -1 : 1, v = row.b[0] || row.p[0] || {};
    const bg = row.b.length ? gst(sumSide(row.b, sign)) : null, pg = row.p.length ? gst(sumSide(row.p, sign)) : null;
    const d = T.dueOf(row, m, today, soonDays);
    return {
      key: `${co.id}|${reg.gstin}|${row.id}`, anchor: RV.anchorOf(row), company_name: co.short || co.name, gstin: reg.gstin, gstin_label: reg.label || '',
      supplier: row.supplier_name || '', supplier_gstin: row.supplier_gstin || '', doc_no: v.no || '', doc_date: v.date || '', doc_type: row.doc_type,
      status: row.status, status_label: STATUS[row.status] || row.status, books_gst: bg, portal_gst: pg, diff_gst: bg !== null && pg !== null ? pg - bg : null,
      workflow_label: RV.WORKFLOW[m.workflow] || '', next_action: m.next_action || '', due: m.due || '', days: d.days, state: d.state,
      assigned_at: m.assigned_at || '', assigned_by: m.assigned_by || '',
    };
  }

  /**
   * Who would be emailed what, as things stand at `now`: per owner the sections of their email, and — separately, so that nothing is
   * dropped silently — the owners that cannot be emailed, with the reason and the number of rows.
   */
  async function plan({ now = Date.now(), cfg = null, users = null, state = null } = {}) {
    cfg = cfg || await cfgNow(); users = users || await usersOf(); state = state || await load();
    const r = cfg.reminders, today = N.todayIST(now);
    const per = new Map(), trouble = new Map();
    const cannot = (who, why) => { const k = `${who}|${why}`; (trouble.get(k) || trouble.set(k, { who, why, rows: 0 }).get(k)).rows++; };
    for (const co of cfg.companies.filter(c => c.active !== false && !c.demo)) {
      let review = null;
      for (const reg of co.registrations.filter(x => x.active !== false)) {
        const doc = await recon.load(co.id, reg.gstin);
        if (!doc) continue;
        review = review || await RV.load(co.id);
        for (const row of doc.rows) {
          const m = review.meta[RV.anchorOf(row)] || {};
          if (!m.owner || !T.isOpen(row, m)) continue;
          const u = T.ownerUser(m, users);
          if (!u) { cannot(m.owner, 'is not a dashboard user'); continue; }
          const name = u.name || u.username;
          if (!T.canOpen(u)) { cannot(name, 'cannot open GSTR-2B Reco'); continue; }
          if (!CFG.canSeeGstin(CFG.accessOf(cfg, u), co, reg.gstin)) { cannot(name, `is not allowed to see GSTIN ${reg.gstin}`); continue; }
          const id = String(u.id);
          (per.get(id) || per.set(id, { user: { id, name }, items: [] }).get(id)).items.push(itemOf(co, reg, row, m, today, r.soon_days));
        }
      }
    }
    const lastSent = id => Object.keys(state.days).sort().reverse().map(k => (state.days[k].owners || {})[id]).filter(o => o && o.status === 'sent').map(o => o.at)[0] || '';
    const undatedToday = listsUndated(r, now);
    const recipients = [...per.values()].map(p => {
      const of = s => p.items.filter(i => i.state === s);
      const sections = { overdue: of('overdue').sort(byDue), today: of('today').sort(byDue), soon: of('soon').sort(byDue) };
      const listed = new Set([...sections.overdue, ...sections.today, ...sections.soon].map(i => i.key));
      // newly assigned = given to this person since their last daily email, by somebody else, and not already told by the email sent at assignment
      const since = lastSent(p.user.id), told = i => (state.told[`${p.user.id}|${i.anchor}`] || '') >= i.assigned_at;
      sections.fresh = p.items.filter(i => !listed.has(i.key) && i.assigned_at && i.assigned_at > since && T.lc(i.assigned_by) !== T.lc(p.user.name) && !told(i));
      sections.fresh.forEach(i => listed.add(i.key));
      const undated = p.items.filter(i => !i.due && !listed.has(i.key));
      sections.undated = undatedToday ? undated : [];
      const counts = { open: p.items.length, overdue: sections.overdue.length, today: sections.today.length, soon: sections.soon.length, fresh: sections.fresh.length, undated: p.items.filter(i => !i.due).length };
      const email = (r.emails || {})[p.user.id] || '';
      const has_content = Object.values(sections).some(s => s.length > 0);
      if (!email) trouble.set(`${p.user.name}|email`, { who: p.user.name, why: 'has no email address in Settings → Email reminders', rows: p.items.length });
      return { user: p.user, email, sections, counts, has_content, items: p.items };
    }).sort((a, b) => a.user.name.localeCompare(b.user.name));
    return { today, due_now: dueNow(r, now), lists_undated: undatedToday, recipients, problems: [...trouble.values()].sort((a, b) => b.rows - a.rows) };
  }

  let running = false;
  /** Sends what is due. Safe to call often: returns { ran: false, why } when it is not the time, already done, switched off or not set up. */
  async function tick(o = {}) {
    if (running) return { ran: false, why: 'busy' };
    running = true;
    try { return await run(o); } finally { running = false; }
  }

  async function run({ now = Date.now(), maxMs = 40000, force = false, only = null, again = false, by = 'schedule' } = {}) {
    const cfg = await cfgNow(), r = cfg.reminders;
    if (!r.enabled && !force) return { ran: false, why: 'off' };
    if (!mailer.status().configured) return { ran: false, why: 'mail_not_set_up' };
    if (!force && !dueNow(r, now)) return { ran: false, why: 'not_due' };
    const today = N.todayIST(now);
    const before = await load();
    if (!force && before.days[today] && before.days[today].finished_at) return { ran: false, why: 'done' };
    if (before.lease && Date.now() - Date.parse(before.lease.at) < LEASE_MS) return { ran: false, why: 'busy' };
    // one sender at a time — online two instances may be called in the same minute: the one whose mark is still there after a moment goes on
    const lease = uid('rm_');
    await save(d => { d.lease = { id: lease, at: nowIso() }; });
    if (store.useDb()) { await sleepFn(300); if (((await load()).lease || {}).id !== lease) return { ran: false, why: 'busy' }; }

    const deadline = Date.now() + maxMs;
    const out = { ran: true, sent: 0, failed: 0, no_email: 0, left: 0 };
    let broken = '';
    try {
      const p = await plan({ now, cfg, users: await usersOf() });
      const url = appUrl(cfg);
      const dayNow = async () => (await load()).days[today] || {};
      const record = fn => save(d => { const x = (d.days[today] = d.days[today] || { owners: {}, started_at: nowIso() }); x.owners = x.owners || {}; fn(x, d); });
      const skip = (cur) => (cur && cur.status === 'sent' && !again) || (cur && cur.status === 'failed' && cur.attempts >= MAX_ATTEMPTS && !force);
      /** One email; resolves to { error, connection } — a connection-level refusal is not counted against the recipient */
      const post = async (to, mail) => {
        try { await mailer.send({ to, subject: mail.subject, html: mail.html }); return { error: '' }; }
        catch (e) { if (CONNECTION.has(e.code)) { broken = e.message; return { error: e.message, connection: true }; } return { error: e.message || 'the email could not be sent' }; }
      };

      for (const rc of p.recipients) {
        if (only && rc.user.id !== String(only)) continue;
        if (!rc.has_content) continue;
        if (!rc.email) { out.no_email++; continue; }
        const cur = ((await dayNow()).owners || {})[rc.user.id];                // read again each time: another caller may have sent it meanwhile
        if (skip(cur)) continue;
        if (broken || Date.now() > deadline) { out.left++; continue; }
        const mail = MAIL.digest({ name: rc.user.name, sections: rc.sections, counts: rc.counts, appUrl: url, soonDays: r.soon_days });
        const res = await post(rc.email, mail);
        if (res.connection) { out.left++; continue; }
        await record((x, d) => {
          x.owners[rc.user.id] = { status: res.error ? 'failed' : 'sent', at: nowIso(), attempts: ((cur && cur.attempts) || 0) + 1, error: res.error, to: rc.email, counts: rc.counts };
          entry(d, { kind: 'digest', to: rc.email, name: rc.user.name, subject: mail.subject, ok: !res.error, error: res.error, by });
        });
        if (res.error) out.failed++; else out.sent++;
      }

      // the managers' summary: when something is overdue or due today, and on the weekly day whenever rows are open
      let summaryDue = false;
      if (!only && r.summary_to.length) {
        const all = p.recipients.flatMap(rc => rc.items.map(i => ({ ...i, owner: rc.user.name })));
        const overdue = all.filter(i => i.state === 'overdue').sort(byDue), dueToday = all.filter(i => i.state === 'today').sort(byDue);
        const cur = (await dayNow()).summary;
        summaryDue = overdue.length + dueToday.length > 0 || (p.lists_undated && all.length > 0);
        if (summaryDue && !skip(cur)) {
          if (broken || Date.now() > deadline) out.left++;
          else {
            const mail = MAIL.summary({ owners: p.recipients.map(rc => ({ name: rc.user.name, ...rc.counts })), overdue, today: dueToday, unreachable: p.problems, appUrl: url });
            const res = await post(r.summary_to, mail);
            if (res.connection) out.left++;
            else {
              await record((x, d) => {
                x.summary = { status: res.error ? 'failed' : 'sent', at: nowIso(), attempts: ((cur && cur.attempts) || 0) + 1, error: res.error, to: r.summary_to };
                entry(d, { kind: 'summary', to: r.summary_to.join(', '), name: 'Managers\' summary', subject: mail.subject, ok: !res.error, error: res.error, by });
              });
              if (res.error) out.failed++; else out.sent++;
            }
          }
        }
      }

      if (broken) {
        // nothing could be sent: tried again at the next call, and given up for today after three such calls
        await record((x, d) => {
          const n = ((x.connection_error || {}).attempts || 0) + 1;
          x.connection_error = { at: nowIso(), message: broken, attempts: n };
          if (n >= MAX_ATTEMPTS) x.finished_at = nowIso();
          entry(d, { kind: 'connection', to: '', name: '', subject: '', ok: false, error: broken, by });
        });
        out.error = broken;
      } else if (!only && !out.left) {
        // everything that could go out has gone out — or has failed three times: today is done (a failed email, the summary too, is tried again first)
        const day = await dayNow();
        const owed = cur => !skip(cur) && (cur || {}).status !== 'sent';
        const pending = p.recipients.some(rc => rc.has_content && rc.email && owed((day.owners || {})[rc.user.id])) || (summaryDue && owed(day.summary));
        if (!pending) await record(x => { x.finished_at = nowIso(); delete x.connection_error; });
      }
      if (out.sent || out.failed || broken) {
        await audit.log({ by, action: 'reminders.sent', detail: `${out.sent} reminder email(s) sent${out.failed ? `, ${out.failed} failed` : ''}${out.no_email ? `, ${out.no_email} owner(s) without an address` : ''}${broken ? ` — stopped: ${broken}` : ''}`.slice(0, 300) });
      }
      return out;
    } finally {
      await save(d => { if (d.lease && d.lease.id === lease) d.lease = null; }).catch(e => log.error(`[gstr2b] reminders: ${e.message}`));
    }
  }

  /** The email that goes out at once when rows are given to somebody else. Never throws: a reminder must not fail the assignment. */
  async function notifyAssigned({ company, gstin, anchors, owner_id, by }) {
    try {
      const cfg = await cfgNow(), r = cfg.reminders;
      if (!r.enabled || !r.on_assign || !anchors || !anchors.length) return { sent: false, why: 'off' };
      if (!mailer.status().configured) return { sent: false, why: 'mail_not_set_up' };
      const u = T.userById(await usersOf(), owner_id);
      if (!u || !T.canOpen(u)) return { sent: false, why: 'not_a_user' };
      if (by && String(by.id) === String(u.id)) return { sent: false, why: 'self' };
      const to = (r.emails || {})[String(u.id)];
      if (!to) return { sent: false, why: 'no_email' };
      const co = cfg.companies.find(c => c.id === company), reg = co && co.registrations.find(x => x.gstin === gstin);
      if (!co || co.demo || !reg || !CFG.canSeeGstin(CFG.accessOf(cfg, u), co, reg.gstin)) return { sent: false, why: 'not_allowed' };
      const doc = await recon.load(co.id, reg.gstin), review = await RV.load(co.id);
      const want = new Set(anchors), today = N.todayIST();
      const items = ((doc && doc.rows) || []).filter(row => want.has(RV.anchorOf(row))).map(row => itemOf(co, reg, row, review.meta[RV.anchorOf(row)] || {}, today, r.soon_days));
      if (!items.length) return { sent: false, why: 'no_rows' };
      const byName = (by && (by.name || by.username)) || 'a colleague';
      const mail = MAIL.assigned({ name: u.name || u.username, by: byName, items, appUrl: appUrl(cfg) });
      let error = '';
      try { await mailer.send({ to, subject: mail.subject, html: mail.html }); } catch (e) { error = e.message || 'the email could not be sent'; }
      await save(d => {
        entry(d, { kind: 'assigned', to, name: u.name || u.username, subject: mail.subject, ok: !error, error, by: byName });
        if (!error) { const at = nowIso(); for (const i of items) d.told[`${u.id}|${i.anchor}`] = at; }
      });
      return { sent: !error, error };
    } catch (e) { log.error(`[gstr2b] assignment email: ${e.message}`); return { sent: false, why: 'error', error: e.message }; }
  }

  /** "Send a test email": proves the mail connection; carries no data */
  async function test({ to, by }) {
    if (!CFG.isEmail(String(to || '').trim().toLowerCase())) throw Object.assign(new Error('Enter the email address the test should go to'), { status: 400 });
    const st = mailer.status();
    if (!st.configured) throw Object.assign(new Error(`Email sending is not set up yet (missing: ${st.missing.join(', ')})`), { status: 400 });
    const mail = MAIL.test({ by, from: st.from });
    let error = '';
    try { await mailer.send({ to: String(to).trim(), subject: mail.subject, html: mail.html }); } catch (e) { error = e.message || 'the email could not be sent'; }
    await save(d => entry(d, { kind: 'test', to: String(to).trim(), name: '', subject: mail.subject, ok: !error, error, by }));
    await audit.log({ by, action: 'reminders.test', detail: `test email to ${String(to).trim()}: ${error || 'sent'}`.slice(0, 300) });
    if (error) throw Object.assign(new Error(error), { status: 502 });
    return { ok: true, to: String(to).trim(), from: st.from };
  }

  /** Everything the settings page shows */
  async function view({ now = Date.now() } = {}) {
    const cfg = await cfgNow(), users = await usersOf(), state = await load();
    const p = await plan({ now, cfg, users, state });
    const r = cfg.reminders, day = state.days[p.today] || null;
    const byId = new Map(p.recipients.map(rc => [rc.user.id, rc]));
    const last = id => { for (const k of Object.keys(state.days).sort().reverse()) { const o = (state.days[k].owners || {})[id]; if (o) return { status: o.status, at: o.at, error: o.error || '' }; } return null; };
    return {
      settings: r, mail: mailer.status(), app_url: appUrl(cfg), next_at: r.enabled ? nextAt(r, now) : null,
      people: T.people(users).map(u => { const rc = byId.get(u.id); return { id: u.id, name: u.name, email: (r.emails || {})[u.id] || '', open: rc ? rc.counts.open : 0, overdue: rc ? rc.counts.overdue : 0, today: rc ? rc.counts.today : 0, would_email: !!(rc && rc.has_content), last: last(u.id) }; }),
      problems: p.problems,
      today: { date: p.today, due_now: p.due_now, started_at: (day && day.started_at) || null, finished_at: (day && day.finished_at) || null, connection_error: (day && day.connection_error) || null, summary: (day && day.summary) || null },
      log: state.log.slice(0, 40),
    };
  }

  /** The email one person would get now — whatever the time of day and whether or not it has already gone out today */
  async function preview({ user, now = Date.now() }) {
    const cfg = await cfgNow();
    const p = await plan({ now, cfg });
    const rc = p.recipients.find(x => x.user.id === String(user));
    if (!rc || !rc.has_content) return { empty: true };
    return { empty: false, to: rc.email, ...MAIL.digest({ name: rc.user.name, sections: rc.sections, counts: rc.counts, appUrl: appUrl(cfg), soonDays: cfg.reminders.soon_days }) };
  }

  return { tick, plan, notifyAssigned, test, view, preview, load };
}

module.exports = { create, dueNow, nextAt, listsUndated, KEY };
