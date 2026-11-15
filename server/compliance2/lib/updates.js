/**
 * Compliance Updates (V2): update records, a source monitor (daily job, 09:00 Asia/Kolkata by default, admin-configurable),
 * a reviewer queue, per-user read / saved state, notes, assignable actions and the update → rule-change link.
 *
 * Store document "<sp>_updates": { updates: [], sources: [], runs: [], actions: [], user_state: { <user id>: { read: [], saved: [] } },
 *   settings: { enabled, time 'HH:MM', extra_domains [] } }
 *
 * Update: { id, topic, kind, issuer, source_url, reference, published, effective, retrieved_at, state, title, summary,
 *   previous_requirement, new_requirement, entity_ids, registration_ids, impact, status 'candidate' | 'in_review' | 'verified' |
 *   'rejected' | 'superseded', supersedes, superseded_by, content_hash, curated, source_id, notes [], rule_links [], history [] }
 *
 * Safety:
 *   • Everything taken from a source is UNTRUSTED TEXT: tags are stripped, control characters removed and lengths capped
 *     here; the screen shows it as text (never as HTML). Links are kept only when they are https on an official domain.
 *     Nothing in a source is ever followed as an instruction.
 *   • The monitor only detects new items on official pages / feeds and puts them in the reviewer queue as unverified
 *     candidates. It never changes a rule or a due date: a reviewer proposes a rule draft from a verified update, and that
 *     draft goes through the normal verify → impact preview → approval by another person (lib/rules.js).
 *   • A failed check is recorded as a failure with a retry time — never as "no changes". The first check of a source only
 *     takes a baseline (what is already on the page is not "new").
 *   • Nobody is notified by this module.
 *   • "Unread" means unread by that user — it says nothing about whether the law is verified.
 */

'use strict';

const U = require('./util');

const TOPICS = ['GST', 'TDS/TCS', 'Income Tax', 'E-way bill', 'E-invoice', 'ISD', 'Provident Fund', 'ESIC', 'Professional Tax', 'ROC/LLP', 'SEBI', 'FEMA/RBI', 'Other statutory'];
const KINDS = { notification: 'Notification', circular: 'Circular / order', portal_advisory: 'Portal advisory', official_announcement: 'Official announcement', standing_guidance: 'Standing guidance',
  historical: 'Historical announcement', state_reference: 'State reference', proposed: 'Proposed / draft', withdrawn: 'Withdrawn', superseded: 'Superseded', unclassified: 'Not yet classified' };
const STATUSES = { candidate: 'Candidate — unverified', in_review: 'In review', verified: 'Verified', rejected: 'Rejected', superseded: 'Superseded' };
const IMPACT = ['unknown', 'none', 'low', 'medium', 'high'];
const OFFICIAL = ['incometax.gov.in', 'incometaxindia.gov.in', 'cbic.gov.in', 'cbic-gst.gov.in', 'gst.gov.in', 'gstcouncil.gov.in', 'ewaybillgst.gov.in', 'einvoice1.gst.gov.in', 'einvoice6.gst.gov.in',
  'epfindia.gov.in', 'esic.gov.in', 'esic.nic.in', 'mca.gov.in', 'sebi.gov.in', 'rbi.org.in', 'egazette.gov.in', 'pib.gov.in', 'mahagst.gov.in', 'commercialtax.gujarat.gov.in', 'nsdl.co.in', 'tin-nsdl.com', 'protean-tinpan.com'];

/** Default sources — official pages; the admin checks each URL and enables the monitor (nothing runs until then) */
const DEFAULT_SOURCES = [
  ['Income Tax Department — latest updates', 'CBDT / Income Tax Department', 'Income Tax', 'https://www.incometax.gov.in/iec/foportal/latest-news'],
  ['GST portal — news and updates', 'GSTN', 'GST', 'https://www.gst.gov.in/newsandupdates'],
  ['CBIC — GST notifications', 'CBIC', 'GST', 'https://cbic-gst.gov.in/central-tax-notifications.html'],
  ['NIC e-way bill — announcements', 'NIC e-Way Bill portal', 'E-way bill', 'https://docs.ewaybillgst.gov.in/apidocs/announcements.html'],
  ['NIC e-invoice — updates', 'NIC e-invoice portal', 'E-invoice', 'https://einvoice1.gst.gov.in/'],
  ['EPFO — what\'s new', 'EPFO', 'Provident Fund', 'https://www.epfindia.gov.in/site_en/WhatsNew.php'],
  ['ESIC — news and updates', 'ESIC', 'ESIC', 'https://www.esic.gov.in/'],
  ['Maharashtra — PT notices', 'Maharashtra GST Department', 'Professional Tax', 'https://www.mahagst.gov.in/'],
];
const EMPTY = () => ({ updates: [], sources: [], runs: [], actions: [], user_state: {}, settings: { enabled: false, time: '09:00', extra_domains: [] } });

function seedSources(doc) {
  if (doc.sources.length) return 0;
  for (const [name, authority, topic, url] of DEFAULT_SOURCES) doc.sources.push({ id: U.uid('SRC-'), name, authority, topic, url, kind: 'page', enabled: true, state: null, last_success: null, last_failure: null, last_error: null, failures: 0, next_retry: null, seen: [], baseline_at: null, created_at: U.nowIso() });
  return DEFAULT_SOURCES.length;
}

// ── Untrusted text ────────────────────────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', hellip: '…', rupee: '₹' };
function plain(s, max = 4000) {
  return String(s ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => (e[0] === '#' ? (() => { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 31 && n < 0x10ffff ? String.fromCodePoint(n) : ' '; })() : ENT[e.toLowerCase()] ?? ' '))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function officialUrl(raw, extra = []) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    const ok = [...OFFICIAL, ...extra].some(d => host === d || host.endsWith(`.${d}`));
    return ok ? u.toString() : null;
  } catch (_) { return null; }
}
const hashOf = (...parts) => U.sha256(parts.map(p => plain(p, 2000).toLowerCase()).join('|')).slice(0, 32);

// ── Update records ────────────────────────────────────────────────────────────
function clean(input, { org, extra }) {
  const errors = [];
  const u = {
    topic: String(input.topic || ''), kind: String(input.kind || 'unclassified'), issuer: plain(input.issuer, 200), source_url: null, reference: plain(input.reference, 120),
    published: input.published || '', effective: input.effective || '', state: plain(input.state, 60) || 'All India', title: plain(input.title, 300), summary: plain(input.summary, 4000),
    previous_requirement: plain(input.previous_requirement, 2000), new_requirement: plain(input.new_requirement, 2000), impact: IMPACT.includes(input.impact) ? input.impact : 'unknown',
    entity_ids: (Array.isArray(input.entity_ids) ? input.entity_ids : []).map(String).filter(id => org.entities.some(e => e.id === id)),
    registration_ids: (Array.isArray(input.registration_ids) ? input.registration_ids : []).map(String).filter(id => org.registrations.some(r => r.id === id)),
    published_text: plain(input.published_text, 80), effective_text: plain(input.effective_text, 120),
  };
  if (!TOPICS.includes(u.topic)) errors.push(`Topic must be one of: ${TOPICS.join(', ')}`);
  if (!KINDS[u.kind]) errors.push('Choose what kind of item this is (notification, circular, advisory …)');
  if (!u.title) errors.push('Title is required');
  if (!u.issuer) errors.push('Official issuer is required');
  if (input.source_url) { u.source_url = officialUrl(input.source_url, extra); if (!u.source_url) errors.push('The source link must be an https link on an official government / regulator domain'); }
  if (u.published && !U.isDate(u.published)) errors.push('Publication date must be a date (or leave it blank and describe it in words)');
  if (u.effective && !U.isDate(u.effective)) errors.push('Effective date must be a date (or describe it in words)');
  return { u, errors };
}

function add(doc, input, { org, actor, curated = false, sourceId = null }) {
  const { u, errors } = clean(input, { org, extra: doc.settings.extra_domains });
  if (errors.length) throw U.httpError(400, errors.join('; '));
  const content_hash = hashOf(u.issuer, u.reference, u.title, u.summary);
  const dupe = doc.updates.find(x => x.content_hash === content_hash || (u.reference && x.reference && x.issuer.toLowerCase() === u.issuer.toLowerCase() && x.reference.toLowerCase() === u.reference.toLowerCase() && x.status !== 'superseded'));
  if (dupe) throw U.httpError(409, `This update is already recorded (${dupe.id}: ${dupe.title}). Record a correction on it, or mark it superseded.`);
  const now = U.nowIso();
  const rec = { id: U.uid('UP-'), ...u, status: curated ? 'verified' : 'in_review', retrieved_at: now, content_hash, curated, source_id: sourceId, supersedes: null, superseded_by: null, notes: [], rule_links: [],
    created_by: actor.name, created_by_id: actor.id, created_at: now, history: [{ at: now, by: actor.name, action: curated ? 'curated reference entry' : 'recorded' }] };
  doc.updates.push(rec);
  return rec;
}

function edit(doc, id, input, { org, actor }) {
  const x = doc.updates.find(u => u.id === id);
  if (!x) throw U.httpError(404, 'Update not found');
  const { u, errors } = clean({ ...x, ...input }, { org, extra: doc.settings.extra_domains });
  if (errors.length) throw U.httpError(400, errors.join('; '));
  const before = U.clone(x);
  Object.assign(x, u, { content_hash: hashOf(u.issuer, u.reference, u.title, u.summary) });
  if (x.status === 'verified') { x.status = 'in_review'; x.verified_by = null; x.verified_by_id = null; }        // a changed record is checked again
  x.history.push({ at: U.nowIso(), by: actor.name, action: 'corrected', before: { title: before.title, summary: before.summary, reference: before.reference, effective: before.effective } });
  return x;
}

/** Reviewer queue decisions: verify (another person than the one who recorded / last corrected it), reject, supersede */
function decide(doc, id, action, { actor, note, supersededBy }) {
  const x = doc.updates.find(u => u.id === id);
  if (!x) throw U.httpError(404, 'Update not found');
  const now = U.nowIso();
  if (action === 'verify') {
    if (!['candidate', 'in_review'].includes(x.status)) throw U.httpError(400, 'Only a candidate or an item in review can be verified');
    if (!x.source_url) throw U.httpError(400, 'Add the official source link before verifying');
    if (x.kind === 'unclassified') throw U.httpError(400, 'Classify the item (notification, circular, advisory …) before verifying');
    const last = [...x.history].reverse().find(h => ['recorded', 'corrected', 'classified'].includes(h.action));
    if (x.created_by_id === actor.id || (last && last.by === actor.name)) throw U.httpError(403, 'Another person must verify an update you recorded or corrected');
    Object.assign(x, { status: 'verified', verified_by: actor.name, verified_by_id: actor.id, verified_at: now });
  } else if (action === 'reject') {
    if (String(note || '').trim().length < 5) throw U.httpError(400, 'Say why it is rejected');
    x.status = 'rejected';
  } else if (action === 'supersede') {
    const by = doc.updates.find(u => u.id === supersededBy);
    if (!by || by.id === x.id) throw U.httpError(400, 'Choose the newer update that supersedes this one');
    x.status = 'superseded'; x.superseded_by = by.id; by.supersedes = x.id;
  } else throw U.httpError(400, 'action must be verify, reject or supersede');
  x.history.push({ at: now, by: actor.name, action, note: plain(note, 1000) });
  return x;
}

function addNote(doc, id, text, actor) {
  const x = doc.updates.find(u => u.id === id);
  if (!x) throw U.httpError(404, 'Update not found');
  const t = plain(text, 2000);
  if (!t) throw U.httpError(400, 'Write the note');
  x.notes.push({ id: U.uid('N-'), at: U.nowIso(), by: actor.name, text: t });
  return x;
}

/** Assignable action; the same title for the same update and company is refused (deduplication) */
function addAction(doc, input, { actor, users }) {
  const x = doc.updates.find(u => u.id === input.update_id);
  if (!x) throw U.httpError(404, 'Update not found');
  const title = plain(input.title, 300);
  if (!title) throw U.httpError(400, 'Describe the action');
  if (input.owner_id && !users.some(u => u.id === input.owner_id)) throw U.httpError(400, 'Choose an owner from the user list');
  if (input.deadline && !U.isDate(input.deadline)) throw U.httpError(400, 'The action deadline must be a date');
  const entity_id = input.entity_id || null;
  const key = `${x.id}|${entity_id || ''}|${title.toLowerCase()}`;
  const dupe = doc.actions.find(a => a.key === key && a.status !== 'cancelled');
  if (dupe) throw U.httpError(409, `This action already exists (${dupe.id})`);
  const rec = { id: U.uid('AC-'), key, update_id: x.id, entity_id, title, owner_id: input.owner_id || null, deadline: input.deadline || null, status: 'open', created_by: actor.name, created_at: U.nowIso(), history: [] };
  doc.actions.push(rec);
  return rec;
}
function setAction(doc, id, status, actor) {
  const a = doc.actions.find(x => x.id === id);
  if (!a) throw U.httpError(404, 'Action not found');
  if (!['open', 'done', 'cancelled'].includes(status)) throw U.httpError(400, 'status must be open, done or cancelled');
  a.status = status;
  a.history.push({ at: U.nowIso(), by: actor.name, status });
  return a;
}

function mark(doc, userId, id, what, on) {
  if (!doc.updates.some(u => u.id === id)) throw U.httpError(404, 'Update not found');
  const st = doc.user_state[userId] || (doc.user_state[userId] = { read: [], saved: [] });
  const list = what === 'saved' ? 'saved' : 'read';
  st[list] = on ? U.uniq([...st[list], id]) : st[list].filter(x => x !== id);
  return st;
}

/** Filtered list for one user */
function list(doc, { userId, filter = {}, canSeeEntity = () => true }) {
  const st = doc.user_state[userId] || { read: [], saved: [] };
  const q = String(filter.search || '').toLowerCase();
  return doc.updates.filter(u => (!u.entity_ids.length || u.entity_ids.some(canSeeEntity)))
    .map(u => ({ ...u, read: st.read.includes(u.id), saved: st.saved.includes(u.id), actions: doc.actions.filter(a => a.update_id === u.id) }))
    .filter(u => (!filter.topic || u.topic === filter.topic) && (!filter.state || u.state === filter.state) && (!filter.impact || u.impact === filter.impact) && (!filter.status || u.status === filter.status)
      && (!filter.kind || u.kind === filter.kind) && (!filter.entity_id || u.entity_ids.includes(filter.entity_id)) && (filter.unread !== 'true' || !u.read) && (filter.saved !== 'true' || u.saved)
      && (!filter.from || (u.published || u.created_at.slice(0, 10)) >= filter.from) && (!filter.to || (u.published || u.created_at.slice(0, 10)) <= filter.to)
      && (!q || `${u.title} ${u.summary} ${u.issuer} ${u.reference}`.toLowerCase().includes(q)))
    .sort((a, b) => (b.published || b.created_at).localeCompare(a.published || a.created_at));
}

// ── Source monitor ────────────────────────────────────────────────────────────
function extractItems(body, baseUrl, extra) {
  const items = [];
  const text = String(body || '').slice(0, 3 * 1024 * 1024);
  if (/<rss|<feed[\s>]/i.test(text.slice(0, 2000))) {
    for (const m of text.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
      const block = m[0];
      const title = plain((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, ''), 300);
      const link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || (block.match(/<link[^>]*href="([^"]+)"/i) || [])[1];
      const date = plain((block.match(/<(pubDate|updated|published)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2], 60);
      if (title) items.push({ title, url: officialUrl(new URL(plain(link, 1000) || baseUrl, baseUrl).toString(), extra), date });
    }
  } else {
    for (const m of text.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const title = plain(m[2], 300);
      if (title.length < 15) continue;
      let url = null;
      try { url = officialUrl(new URL(m[1], baseUrl).toString(), extra); } catch (_) { url = null; }
      if (url) items.push({ title, url, date: '' });
    }
  }
  const seen = new Set();
  return items.filter(i => { const k = hashOf(i.title, i.url || ''); if (seen.has(k)) return false; seen.add(k); i.hash = k; return true; }).slice(0, 300);
}

/**
 * Checks every enabled source once. fetcher(url) → { ok, status, text } (tests inject one). Returns the run record.
 * A failure keeps the source's earlier baseline and schedules a retry (15 min, 1 h, then the next daily run).
 */
async function runMonitor(doc, { fetcher, actor = { name: 'Source monitor', id: 'system' }, trigger = 'schedule', maxNew = 30 } = {}) {
  const started = U.nowIso();
  const run = { id: U.uid('RUN-'), started, trigger, by: actor.name, results: [] };
  for (const s of doc.sources.filter(x => x.enabled)) {
    const url = officialUrl(s.url, doc.settings.extra_domains);
    const r = { source_id: s.id, name: s.name, at: U.nowIso() };
    if (!url) { Object.assign(r, { ok: false, error: 'The source URL is not an https link on an official domain — not checked' }); }
    else {
      try {
        const res = await fetcher(url);
        if (!res || !res.ok) throw new Error(`HTTP ${res?.status || 'no response'}`);
        const items = extractItems(res.text, url, doc.settings.extra_domains);
        if (!items.length) throw new Error('The page was fetched but no items could be read from it (layout changed?) — treated as a failure, not as "no changes"');
        const known = new Set(s.seen);
        const fresh = items.filter(i => !known.has(i.hash));
        if (!s.baseline_at) {
          Object.assign(r, { ok: true, baseline: true, items: items.length, new: 0, note: `Baseline taken: ${items.length} item(s) already on the page are not listed as new` });
          s.baseline_at = r.at;
        } else {
          let added = 0;
          for (const i of fresh.slice(0, maxNew)) {
            const content_hash = hashOf(s.authority, '', i.title, '');
            if (doc.updates.some(u => u.content_hash === content_hash || (i.url && u.source_url === i.url))) continue;
            doc.updates.push({ id: U.uid('UP-'), topic: s.topic, kind: 'unclassified', issuer: s.authority, source_url: i.url, reference: '', published: '', published_text: i.date, effective: '', effective_text: '', state: s.topic === 'Professional Tax' ? '' : 'All India',
              title: i.title, summary: '', previous_requirement: '', new_requirement: '', impact: 'unknown', entity_ids: [], registration_ids: [], status: 'candidate', retrieved_at: r.at, content_hash, curated: false, source_id: s.id,
              supersedes: null, superseded_by: null, notes: [], rule_links: [], created_by: actor.name, created_by_id: actor.id, created_at: r.at, history: [{ at: r.at, by: actor.name, action: 'detected by source monitor (unverified)' }] });
            added += 1;
          }
          Object.assign(r, { ok: true, items: items.length, new: added, skipped: Math.max(0, fresh.length - maxNew) });
        }
        s.seen = U.uniq([...s.seen, ...items.map(i => i.hash)]).slice(-2000);
        Object.assign(s, { state: 'ok', last_success: r.at, last_error: null, failures: 0, next_retry: null });
      } catch (e) {
        Object.assign(r, { ok: false, error: plain(e.message, 300) });
      }
    }
    if (!r.ok) {
      s.failures = (s.failures || 0) + 1;
      Object.assign(s, { state: 'failed', last_failure: r.at, last_error: r.error, next_retry: s.failures === 1 ? new Date(U.clock.now() + 15 * 60000).toISOString() : s.failures === 2 ? new Date(U.clock.now() + 3600000).toISOString() : null });
    }
    run.results.push(r);
  }
  run.finished = U.nowIso();
  run.ok = run.results.filter(x => x.ok).length;
  run.failed = run.results.filter(x => !x.ok).length;
  doc.runs.push(run);
  doc.runs = doc.runs.slice(-60);
  return run;
}

/** Freshness of each source: ok within 36 h = fresh; older or never = stale; failing = failed */
function sourceStatus(doc) {
  const now = U.clock.now();
  return doc.sources.map(s => {
    const age = s.last_success ? Math.round((now - Date.parse(s.last_success)) / 3600000) : null;
    return { ...s, seen: undefined, seen_count: s.seen.length, age_hours: age, freshness: !s.enabled ? 'disabled' : s.state === 'failed' ? 'failed' : age === null ? 'never checked' : age <= 36 ? 'fresh' : 'stale' };
  });
}

/** Is a scheduled run due now? (IST wall clock at or after the configured time, and no scheduled run yet today) */
function due(doc) {
  if (!doc.settings.enabled) return false;
  const nowIst = U.istText(U.clock.now());
  const [d, hm] = nowIst.split(' ');
  if (hm < (doc.settings.time || '09:00')) {
    return doc.sources.some(s => s.enabled && s.next_retry && Date.parse(s.next_retry) <= U.clock.now());
  }
  const last = [...doc.runs].reverse().find(r => r.trigger === 'schedule');
  if (!last || U.istText(last.started).slice(0, 10) !== d) return true;
  return doc.sources.some(s => s.enabled && s.next_retry && Date.parse(s.next_retry) <= U.clock.now());
}

module.exports = { TOPICS, KINDS, STATUSES, IMPACT, OFFICIAL, DEFAULT_SOURCES, EMPTY, seedSources, plain, officialUrl, hashOf, clean, add, edit, decide, addNote, addAction, setAction, mark, list, extractItems, runMonitor, sourceStatus, due };
