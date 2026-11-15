import React, { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from './api';
import { S, Btn, Note, Modal, Empty, dt, dtm } from './ui';
import { Hero, Pills, Stats, Panel, Notice, DataTable, Filters, FSel, FInput, Badge } from './ui2';

// Compliance Updates (V2) — server: lib/updates.js. Source text is untrusted: the server strips tags and keeps only official
// https links; this screen renders everything as plain text. The monitor only finds candidates for the reviewer queue; an
// update can propose a rule DRAFT, which still needs verification, an impact preview and approval by another person.

const IMPACT_TONE = { high: 'red', medium: 'amber', low: 'lav', none: 'grey', unknown: 'grey' };
const STATUS_TONE = { candidate: 'amber', in_review: 'amber', verified: 'green', rejected: 'grey', superseded: 'grey' };
const VIEWS = [['feed', 'Updates'], ['queue', 'Reviewer queue'], ['actions', 'Actions'], ['sources', 'Sources & monitor']];

export default function UpdatesTab({ meta, org, ws, demo, stamp, users }) {
  const [view, setView] = useState('feed');
  const [filter, setFilter] = useState({ topic: '', state: '', impact: '', entity_id: '', unread: '', saved: '', search: '', from: '', to: '' });
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = useCallback(() => api.updates({ ...filter, ...(view === 'queue' ? { status: '' } : {}) }).then(setData).catch(e => setErr(errMsg(e))), [filter, view]);
  useEffect(() => { load(); }, [load, stamp]);
  const r = meta.actor.rights;
  const act = async (fn, m) => { setErr(''); setMsg(''); try { await fn(); if (m) setMsg(m); load(); } catch (e) { setErr(errMsg(e)); } };
  if (!data) return <div><Hero eyebrow="COMPLIANCE UPDATES" title="Compliance updates" sub="Official notifications, circulars, portal advisories and standing guidance — reviewed before they affect any rule." />{err ? <Note tone="error">{err}</Note> : <Empty>Loading…</Empty>}</div>;
  const set = (k, v) => setFilter(f => ({ ...f, [k]: v }));
  const list = view === 'queue' ? data.updates.filter(u => ['candidate', 'in_review'].includes(u.status)) : data.updates;
  const states = [...new Set(data.updates.map(u => u.state).filter(Boolean))];
  const nameOf = id => org.entities.find(e => e.id === id)?.short_code || id;
  return (
    <div>
      <Hero eyebrow="COMPLIANCE UPDATES" title="Compliance updates" sub="Official notifications, circulars, portal advisories and standing guidance for GST, TDS/TCS, Income Tax, e-way bill, e-invoice, ISD, PF, ESIC, PT, ROC/LLP, SEBI and FEMA — reviewed before they affect any rule or due date."
        tag={data.curated_only ? 'Curated reference entries' : data.live_feed ? `Source monitor on · ${data.settings.time} IST daily` : 'Source monitor off'} tagSub={data.curated_only ? 'Demo — not a live feed' : data.live_feed ? 'New items arrive as unverified candidates' : 'An administrator turns it on in Sources & monitor'} />
      {data.curated_only
        ? <Notice><b>CURATED REFERENCE ENTRIES — not a live feed.</b> These demo entries point to public official pages and are for review practice. Read / saved / actions here are real records in the demo space. The scheduled source monitor runs only in the live space.</Notice>
        : <Notice>“Unread” means unread by you — it says nothing about whether the law is verified. Items found by the monitor stay <b>unverified candidates</b> until a reviewer checks the official source. Nobody is notified automatically. Links open the official site in a new tab; nothing on these pages is ever acted on as an instruction.</Notice>}
      <Stats items={[{ label: 'Updates', value: data.counts.total, sub: 'Visible to you' }, { label: 'Unread by you', value: data.counts.unread, sub: 'Per user, not per law' }, { label: 'Reviewer queue', value: data.counts.queue, sub: 'Candidates and items in review' }, { label: 'Open actions', value: data.counts.open_actions, sub: 'Assigned follow-ups' }]} />
      <Pills items={VIEWS} value={view} onChange={setView} label="Update views" />
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      {(view === 'feed' || view === 'queue') && <>
        <Filters>
          <FSel label="Topic" value={filter.topic} onChange={v => set('topic', v)} options={ws.updates.topics} placeholder="All topics" width={160} />
          <FSel label="State" value={filter.state} onChange={v => set('state', v)} options={states} placeholder="All states" width={150} />
          <FSel label="Impact" value={filter.impact} onChange={v => set('impact', v)} options={ws.updates.impact} placeholder="Any impact" width={130} />
          <FSel label="Applicable company" value={filter.entity_id} onChange={v => set('entity_id', v)} options={org.entities.map(e => [e.id, e.short_code])} placeholder="Any" width={150} />
          <FInput label="Published from" type="date" value={filter.from} onChange={v => set('from', v)} width={150} />
          <FInput label="to" type="date" value={filter.to} onChange={v => set('to', v)} width={150} />
          <FSel label="Show" value={filter.unread ? 'unread' : filter.saved ? 'saved' : ''} onChange={v => setFilter(f => ({ ...f, unread: v === 'unread' ? 'true' : '', saved: v === 'saved' ? 'true' : '' }))} options={[['unread', 'Unread by me'], ['saved', 'Saved by me']]} placeholder="All" width={140} />
          <FInput label="Search" value={filter.search} onChange={v => set('search', v)} placeholder="Title, issuer, reference" width={200} />
          {r.rules && <Btn kind="primary" onClick={() => setForm({})}>+ Record an update</Btn>}
        </Filters>
        {list.length === 0 && <Panel><span style={S.muted}>No updates for this selection.</span></Panel>}
        {list.map(u => (
          <article key={u.id} style={{ background: '#fff', border: '1px solid #E4E7EF', borderTop: '3px solid #B5A6EB', borderRadius: 13, padding: '16px 20px', marginBottom: 12 }}>
            <div style={{ ...S.row, justifyContent: 'space-between' }}>
              <div style={S.row}><Badge>{u.topic}</Badge><Badge tone="grey">{ws.updates.kinds[u.kind] || u.kind}</Badge><Badge tone={STATUS_TONE[u.status]}>{ws.updates.statuses[u.status]}</Badge><Badge tone={IMPACT_TONE[u.impact]}>Impact: {u.impact}</Badge>{u.state && <Badge tone="grey">{u.state}</Badge>}{u.curated && <Badge tone="amber">Curated reference</Badge>}{!u.read && <Badge tone="lav">Unread</Badge>}{u.saved && <Badge tone="green">Saved</Badge>}</div>
              <div style={S.row}>
                <Btn small kind="ghost" onClick={() => act(() => api.markUpdate(u.id, 'read', !u.read))}>{u.read ? 'Mark unread' : 'Mark read'}</Btn>
                <Btn small kind="ghost" onClick={() => act(() => api.markUpdate(u.id, 'saved', !u.saved))}>{u.saved ? 'Unsave' : 'Save'}</Btn>
              </div>
            </div>
            <h3 style={{ margin: '12px 0 6px', fontSize: 16 }}>{u.title}</h3>
            <div style={{ ...S.muted, lineHeight: 1.8 }}>{u.issuer}{u.reference ? ` · ${u.reference}` : ''} · Published {u.published ? dt(u.published) : u.published_text || 'date not stated'} · Effective {u.effective ? dt(u.effective) : u.effective_text || 'not stated'} · Retrieved {dtm(u.retrieved_at)}</div>
            {u.summary && <p style={{ fontSize: 13, color: '#485570', lineHeight: 1.6 }}>{u.summary}</p>}
            {(u.previous_requirement || u.new_requirement) && <DataTable headers={['Previous requirement', 'New requirement']} rows={[[u.previous_requirement || '—', u.new_requirement || '—']]} />}
            {u.entity_ids.length > 0 && <p style={S.muted}>Affects: {u.entity_ids.map(nameOf).join(', ')}</p>}
            <div style={{ ...S.row, marginTop: 8, paddingTop: 10, borderTop: '1px solid #EEF0F6' }}>
              {u.source_url ? <a href={u.source_url} target="_blank" rel="noopener noreferrer nofollow" style={{ fontSize: 12, color: '#6957B9' }}>Official source ↗</a> : <span style={S.small}>No official link recorded</span>}
              <Btn small kind="ghost" onClick={() => setOpenId(openId === u.id ? null : u.id)}>{openId === u.id ? 'Hide details' : `Notes, actions & history (${u.notes.length + u.actions.length})`}</Btn>
              {['candidate', 'in_review'].includes(u.status) && (r.approve || r.rules) && <Btn small kind="primary" onClick={() => act(() => api.decideUpdate(u.id, { action: 'verify' }), 'Verified.')}>Verify against source</Btn>}
              {['candidate', 'in_review'].includes(u.status) && (r.approve || r.rules) && <Btn small kind="danger" onClick={() => { const why = window.prompt('Why is it rejected?'); if (why) act(() => api.decideUpdate(u.id, { action: 'reject', note: why }), 'Rejected.'); }}>Reject</Btn>}
              {r.rules && <Btn small kind="ghost" onClick={() => setForm(u)}>Correct / classify</Btn>}
              {u.status === 'verified' && r.rules && <ProposeRule u={u} onDone={m => act(async () => {}, m)} onErr={setErr} />}
            </div>
            {openId === u.id && <UpdateDetail u={u} users={users} org={org} meta={meta} onAct={act} updates={data.updates} />}
          </article>
        ))}
      </>}
      {view === 'actions' && <Panel title="Assigned actions" note="Actions are follow-ups recorded against an update. The same action for the same update and company is recorded once.">
        <DataTable headers={['Action', 'Update', 'Company', 'Owner', 'Deadline', 'Status', '']}
          rows={data.updates.flatMap(u => u.actions.map(a => [a.title, u.title, a.entity_id ? nameOf(a.entity_id) : 'All', users.find(x => x.id === a.owner_id)?.name || 'Unassigned', a.deadline ? dt(a.deadline) : '—', <Badge tone={a.status === 'done' ? 'green' : a.status === 'cancelled' ? 'grey' : 'amber'}>{a.status}</Badge>,
            a.status === 'open' ? <><Btn small onClick={() => act(() => api.setAction(a.id, 'done'), 'Action done.')}>Done</Btn><Btn small kind="ghost" onClick={() => act(() => api.setAction(a.id, 'cancelled'), 'Action cancelled.')}>Cancel</Btn></> : <Btn small kind="ghost" onClick={() => act(() => api.setAction(a.id, 'open'), 'Re-opened.')}>Re-open</Btn>]))} empty="No actions recorded." />
      </Panel>}
      {view === 'sources' && <Sources data={data} meta={meta} demo={demo} ws={ws} onAct={act} />}
      {form && <UpdateForm init={form} ws={ws} org={org} onClose={() => setForm(null)} onSaved={m => { setForm(null); setMsg(m); load(); }} />}
    </div>
  );
}

function ProposeRule({ u, onDone, onErr }) {
  const [rules, setRules] = useState(null);
  const [ruleId, setRuleId] = useState('');
  if (!rules) return <Btn small kind="ghost" onClick={() => api.rules().then(x => setRules(x.rules)).catch(e => onErr(errMsg(e)))}>Propose a rule change…</Btn>;
  return (
    <span style={S.row}>
      <select value={ruleId} onChange={e => setRuleId(e.target.value)} style={{ ...S.input, width: 260, padding: 5 }}><option value="">Choose the rule…</option>{rules.map(x => <option key={x.id} value={x.id}>{x.id} — {x.name}</option>)}</select>
      <Btn small disabled={!ruleId} onClick={async () => { try { const { result } = await api.proposeRule(u.id, { rule_id: ruleId }); onDone(`Draft version ${result.rule_version} of ${ruleId} created from this update. It changes nothing until it is verified, previewed and approved in Coverage & rules.`); setRules(null); } catch (e) { onErr(errMsg(e)); } }}>Create rule draft</Btn>
    </span>
  );
}

function UpdateDetail({ u, users, org, meta, onAct, updates }) {
  const [text, setText] = useState('');
  const [a, setA] = useState({ title: '', owner_id: '', deadline: '', entity_id: '' });
  const [sup, setSup] = useState('');
  return (
    <div style={{ marginTop: 12, background: '#FAFBFE', border: '1px solid #EDF0F6', borderRadius: 10, padding: 12 }}>
      <b style={{ fontSize: 13 }}>Notes</b>
      {u.notes.map(n => <p key={n.id} style={{ ...S.muted, margin: '4px 0' }}>{dtm(n.at)} · {n.by}: {n.text}</p>)}
      <div style={{ ...S.row, marginTop: 6 }}><input value={text} onChange={e => setText(e.target.value)} placeholder="Add a note" style={{ ...S.input, flex: 1 }} /><Btn small onClick={() => { onAct(() => api.noteUpdate(u.id, text), 'Note added.'); setText(''); }} disabled={!text.trim()}>Add note</Btn></div>
      <b style={{ fontSize: 13, display: 'block', marginTop: 12 }}>Actions</b>
      {u.actions.map(x => <p key={x.id} style={{ ...S.muted, margin: '4px 0' }}>• {x.title} — {x.status}{x.deadline ? ` · by ${dt(x.deadline)}` : ''}</p>)}
      {(meta.actor.rights.prepare || meta.actor.rights.rules || meta.actor.rights.approve) && <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: 8, marginTop: 6 }}>
        <input value={a.title} onChange={e => setA({ ...a, title: e.target.value })} placeholder="Action to take" style={S.input} />
        <select value={a.owner_id} onChange={e => setA({ ...a, owner_id: e.target.value })} style={S.input}><option value="">Owner…</option>{users.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <select value={a.entity_id} onChange={e => setA({ ...a, entity_id: e.target.value })} style={S.input}><option value="">All companies</option>{org.entities.map(x => <option key={x.id} value={x.id}>{x.short_code}</option>)}</select>
        <input type="date" value={a.deadline} onChange={e => setA({ ...a, deadline: e.target.value })} style={S.input} />
        <Btn small disabled={!a.title.trim()} onClick={() => { onAct(() => api.addAction({ ...a, update_id: u.id }), 'Action recorded.'); setA({ title: '', owner_id: '', deadline: '', entity_id: '' }); }}>Add</Btn>
      </div>}
      {u.rule_links.length > 0 && <p style={S.muted}>Rule drafts proposed: {u.rule_links.map(l => `${l.rule_id} v${l.version}`).join(', ')}</p>}
      {(meta.actor.rights.approve || meta.actor.rights.rules) && u.status !== 'superseded' && <div style={{ ...S.row, marginTop: 10 }}><select value={sup} onChange={e => setSup(e.target.value)} style={{ ...S.input, width: 320 }}><option value="">Superseded by…</option>{updates.filter(x => x.id !== u.id).map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</select><Btn small kind="ghost" disabled={!sup} onClick={() => onAct(() => api.decideUpdate(u.id, { action: 'supersede', superseded_by: sup }), 'Marked superseded (kept in history).')}>Mark superseded</Btn></div>}
      <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontSize: 12, color: '#738097' }}>History</summary>{u.history.map((h, i) => <p key={i} style={{ ...S.small, margin: '2px 0' }}>{dtm(h.at)} · {h.by} · {h.action}{h.note ? ` — ${h.note}` : ''}</p>)}</details>
    </div>
  );
}

function Sources({ data, meta, demo, ws, onAct }) {
  const [time, setTime] = useState(data.settings.time);
  const [extra, setExtra] = useState((data.settings.extra_domains || []).join(', '));
  const [src, setSrc] = useState({ name: '', authority: '', topic: ws.updates.topics[0], url: '' });
  const admin = meta.actor.rights.admin;
  const tone = { fresh: 'green', stale: 'amber', failed: 'red', 'never checked': 'grey', disabled: 'grey' };
  return (
    <>
      <Panel title="Daily source monitor" note={demo ? 'The demo shows curated entries only; the monitor runs in the live space.' : meta.storage?.vercel ? 'Online there is no always-running process: the daily check runs on the office PC server, or use “Check now”.' : 'Runs on this server at the set time (Asia/Kolkata). A failed source is shown as failed with a retry time — never as “no changes”. The first check of a source only takes a baseline.'}>
        <div style={S.row}>
          <Badge tone={data.settings.enabled ? 'green' : 'grey'}>{data.settings.enabled ? `On · ${data.settings.time} IST` : 'Off'}</Badge>
          {admin && !demo && <>
            <label style={S.muted}>Time (IST) <input type="time" value={time} onChange={e => setTime(e.target.value)} style={{ ...S.input, width: 110 }} /></label>
            <label style={S.muted}>Extra official domains <input value={extra} onChange={e => setExtra(e.target.value)} placeholder="e.g. state.gov.in" style={{ ...S.input, width: 220 }} /></label>
            <Btn small onClick={() => onAct(() => api.updateSettings({ enabled: !data.settings.enabled, time, extra_domains: extra }), data.settings.enabled ? 'Monitor turned off.' : 'Monitor turned on.')}>{data.settings.enabled ? 'Turn off' : 'Turn on'}</Btn>
            <Btn small kind="ghost" onClick={() => onAct(() => api.updateSettings({ time, extra_domains: extra }), 'Saved.')}>Save time / domains</Btn>
            <Btn small kind="primary" onClick={() => onAct(() => api.runMonitor(), 'Check finished — see the results below.')}>Check now</Btn>
          </>}
        </div>
      </Panel>
      <Panel title="Sources" note="Official pages only (https on government / regulator domains). Each URL should be checked by the administrator before enabling.">
        <DataTable headers={['Source', 'Topic', 'URL', 'Freshness', 'Last success', 'Last failure / retry', '']}
          rows={data.sources.map(s => [<><b>{s.name}</b><br /><small>{s.authority}</small></>, s.topic, <small style={{ wordBreak: 'break-all' }}>{s.url}</small>, <Badge tone={tone[s.freshness]}>{s.freshness}{s.age_hours !== null ? ` · ${s.age_hours} h` : ''}</Badge>, s.last_success ? dtm(s.last_success) : '—',
            s.last_failure ? <>{dtm(s.last_failure)}<br /><small>{s.last_error}</small>{s.next_retry && <><br /><small>Retry {dtm(s.next_retry)}</small></>}</> : '—', admin && !demo ? <Btn small kind="ghost" onClick={() => onAct(() => api.setSource(s.id, { enabled: !s.enabled }), 'Saved.')}>{s.enabled ? 'Disable' : 'Enable'}</Btn> : ''])} />
        {admin && !demo && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 2fr auto', gap: 8, marginTop: 12 }}>
          <input value={src.name} onChange={e => setSrc({ ...src, name: e.target.value })} placeholder="Name" style={S.input} />
          <input value={src.authority} onChange={e => setSrc({ ...src, authority: e.target.value })} placeholder="Authority" style={S.input} />
          <select value={src.topic} onChange={e => setSrc({ ...src, topic: e.target.value })} style={S.input}>{ws.updates.topics.map(t => <option key={t}>{t}</option>)}</select>
          <input value={src.url} onChange={e => setSrc({ ...src, url: e.target.value })} placeholder="https://… (official domain)" style={S.input} />
          <Btn small onClick={() => onAct(() => api.addSource(src), 'Source added.')}>Add source</Btn>
        </div>}
      </Panel>
      <Panel title="Recent checks">
        <DataTable headers={['Started', 'Trigger', 'OK', 'Failed', 'New candidates', 'Details']}
          rows={data.runs.map(x => [dtm(x.started), x.trigger, x.ok, x.failed, x.results.reduce((a, y) => a + (y.new || 0), 0), <small>{x.results.map(y => `${y.name}: ${y.ok ? (y.baseline ? 'baseline' : `${y.new} new`) : `failed — ${y.error}`}`).join(' · ')}</small>])} empty="No checks yet." />
      </Panel>
    </>
  );
}

function UpdateForm({ init, ws, org, onClose, onSaved }) {
  const [f, setF] = useState({ topic: init.topic || ws.updates.topics[0], kind: init.kind || 'notification', issuer: init.issuer || '', reference: init.reference || '', title: init.title || '', summary: init.summary || '', source_url: init.source_url || '', published: init.published || '', effective: init.effective || '', published_text: init.published_text || '', effective_text: init.effective_text || '', state: init.state || 'All India', previous_requirement: init.previous_requirement || '', new_requirement: init.new_requirement || '', impact: init.impact || 'unknown', entity_ids: init.entity_ids || [] });
  const [err, setErr] = useState('');
  const save = async () => { setErr(''); try { if (init.id) await api.editUpdate(init.id, f); else await api.addUpdate(f); onSaved(init.id ? 'Corrected — it goes back to review.' : 'Recorded — another person verifies it against the source.'); } catch (e) { setErr(errMsg(e)); } };
  const inp = (k, l, type = 'text') => <label><span style={S.label}>{l}</span><input type={type} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} style={S.input} /></label>;
  return (
    <Modal title={init.id ? 'Correct / classify an update' : 'Record an update'} onClose={onClose} width={900}>
      <p style={{ ...S.muted, marginTop: 0 }}>Distinguish an actual notification from a portal advisory, standing guidance or a proposed / withdrawn item. Do not record old guidance as a new update. The link must be the official https source.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <label><span style={S.label}>Topic</span><select value={f.topic} onChange={e => setF({ ...f, topic: e.target.value })} style={S.input}>{ws.updates.topics.map(t => <option key={t}>{t}</option>)}</select></label>
        <label><span style={S.label}>Kind</span><select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })} style={S.input}>{Object.entries(ws.updates.kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {inp('issuer', 'Official issuer')}{inp('reference', 'Circular / notification number')}{inp('source_url', 'Official source URL (https)')}{inp('state', 'State covered')}
        {inp('published', 'Publication date', 'date')}{inp('published_text', '…or as stated (if no exact date)')}{inp('effective', 'Effective date', 'date')}{inp('effective_text', '…or as stated')}
        <label><span style={S.label}>Impact</span><select value={f.impact} onChange={e => setF({ ...f, impact: e.target.value })} style={S.input}>{ws.updates.impact.map(t => <option key={t}>{t}</option>)}</select></label>
        <label><span style={S.label}>Affected companies</span><select multiple value={f.entity_ids} onChange={e => setF({ ...f, entity_ids: [...e.target.selectedOptions].map(o => o.value) })} style={{ ...S.input, height: 70 }}>{org.entities.map(x => <option key={x.id} value={x.id}>{x.short_code}</option>)}</select></label>
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
        {inp('title', 'Title')}
        <label><span style={S.label}>Summary (plain text)</span><textarea value={f.summary} onChange={e => setF({ ...f, summary: e.target.value })} style={{ ...S.input, minHeight: 70 }} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label><span style={S.label}>Previous requirement</span><textarea value={f.previous_requirement} onChange={e => setF({ ...f, previous_requirement: e.target.value })} style={{ ...S.input, minHeight: 60 }} /></label>
          <label><span style={S.label}>New requirement</span><textarea value={f.new_requirement} onChange={e => setF({ ...f, new_requirement: e.target.value })} style={{ ...S.input, minHeight: 60 }} /></label>
        </div>
      </div>
      {err && <Note tone="error" style={{ marginTop: 10 }}>{err}</Note>}
      <div style={{ ...S.row, marginTop: 12 }}><Btn kind="primary" onClick={save}>Save</Btn><Btn kind="ghost" onClick={onClose}>Cancel</Btn></div>
    </Modal>
  );
}

export function PromptTab({ meta }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api.prompt().then(setP).catch(e => setErr(errMsg(e))), []);
  useEffect(() => { load(); }, [load]);
  const upload = async file => { if (!file) return; const f = new FormData(); f.append('file', file); try { await api.savePrompt(f); setMsg('Build prompt replaced.'); load(); } catch (e) { setErr(errMsg(e)); } };
  return (
    <div>
      <Hero eyebrow="CLAUDE BUILD PROMPT" title="Claude build prompt" sub="The specification this module is built from (versions V1–V10), shown read-only for reference and review." tag="Read-only" tagSub="Stored outside the code" />
      <Notice>The prompt names people and companies, so it is never part of the program code: it is kept in the data store (an administrator uploads the .txt) or, on the office PC, in the private data folder. It is displayed as plain text.</Notice>
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      <div style={{ ...S.row, marginBottom: 12 }}>
        {p?.text && <Btn kind="ghost" onClick={() => navigator.clipboard?.writeText(p.text).then(() => setMsg('Copied to the clipboard.'))}>Copy prompt</Btn>}
        {meta.actor.rights.admin && <label style={{ ...S.muted, display: 'inline-flex', gap: 6, alignItems: 'center' }}>Upload / replace (.txt) <input type="file" accept=".txt" onChange={e => upload(e.target.files[0])} /></label>}
        {p?.text && <span style={S.small}>{p.source} · {p.length.toLocaleString('en-IN')} characters · sha256 {p.sha256}…</span>}
      </div>
      {!p ? <Empty>Loading…</Empty> : !p.text ? <Panel><span style={S.muted}>No build prompt stored yet. An administrator can upload it as a .txt file.</span></Panel>
        : <pre style={{ background: '#fff', border: '1px solid #E4E7EF', borderRadius: 13, padding: 24, color: '#536079', lineHeight: 1.85, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, fontFamily: 'inherit', maxHeight: '75vh', overflow: 'auto' }}>{p.text}</pre>}
    </div>
  );
}
