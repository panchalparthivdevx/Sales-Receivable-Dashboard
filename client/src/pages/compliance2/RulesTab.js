import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errMsg } from './api';
import { C, S, Section, Note, Btn, Table, Tag, Modal, Field, Input, Area, Select, Empty, dt, dtm } from './ui';

// Rule engine screens. A version goes draft → verified (by a person, against an official source) → approved (by ANOTHER
// person, quoting the impact preview they looked at). Only approved versions schedule live tasks. Extensions and fee waivers
// are separate records with their own source and approval; a fee waiver never moves a due date.

const VS_TONE = { approved: 'green', verified: 'blue', draft: 'amber', withdrawn: 'grey', superseded: 'grey' };
const ruleState = r => (r.versions.some(v => v.status === 'approved') ? 'approved' : r.versions.some(v => v.status === 'verified') ? 'verified' : 'draft');

function EditDraft({ rule, v, onClose, onDone }) {
  const [f, setF] = useState({ law: v.law, provision: v.provision, form: v.form, authority: v.authority, effective_from: v.effective_from || '', effective_to: v.effective_to || '', internal_offset_days: v.internal_offset_days ?? '', notes: v.notes || '',
    due: JSON.stringify(v.due, null, 2), applicability: JSON.stringify(v.applicability, null, 2) });
  const [err, setErr] = useState('');
  const save = () => {
    let due, applicability;
    try { due = JSON.parse(f.due || 'null'); applicability = JSON.parse(f.applicability || 'null'); } catch (e) { setErr(`Not valid JSON: ${e.message}`); return; }
    const patch = { law: f.law, provision: f.provision, form: f.form, authority: f.authority, effective_from: f.effective_from || null, effective_to: f.effective_to || null, internal_offset_days: f.internal_offset_days === '' ? null : Number(f.internal_offset_days), notes: f.notes, due, applicability };
    api.editDraft(rule.id, v.version, patch).then(onDone).catch(e => setErr(errMsg(e)));
  };
  return (
    <Modal title={`Edit draft — ${rule.id} v${v.version}`} onClose={onClose} width={720}>
      {err && <Note tone="error">{err}</Note>}
      {v.status === 'verified' && <Note tone="warn">Editing a verified version sends it back to draft — it must be verified again.</Note>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        {['law', 'provision', 'form', 'authority'].map(k => <Field key={k} label={k}><Input value={f[k] || ''} onChange={e => setF({ ...f, [k]: e.target.value })} /></Field>)}
        <Field label="Effective from"><Input type="date" value={f.effective_from} onChange={e => setF({ ...f, effective_from: e.target.value })} /></Field>
        <Field label="Effective to"><Input type="date" value={f.effective_to} onChange={e => setF({ ...f, effective_to: e.target.value })} /></Field>
        <Field label="Internal target (days vs statutory)" hint="e.g. -2 = two days before"><Input type="number" value={f.internal_offset_days} onChange={e => setF({ ...f, internal_offset_days: e.target.value })} /></Field>
      </div>
      <Field label="Due-date rule (JSON — data, never code)" style={{ marginTop: 10 }} hint='e.g. {"type":"next_month_day","day":20,"months_after":1} · null = no rule. Types: next_month_day, days_after_period_end, next_date_after_period_end, fy_dates, state_group, by_state, event_offset (days / months / hours), event_field, expiry, linked, manual'>
        <Area value={f.due} onChange={e => setF({ ...f, due: e.target.value })} style={{ fontFamily: 'monospace', minHeight: 110 }} /></Field>
      <Field label="Applicability test (JSON)" hint='e.g. {"all":[{"fact":"registration.frequency","eq":"monthly"}]} · null = a person decides every case' style={{ marginTop: 10 }}>
        <Area value={f.applicability} onChange={e => setF({ ...f, applicability: e.target.value })} style={{ fontFamily: 'monospace', minHeight: 90 }} /></Field>
      <Field label="Notes" style={{ marginTop: 10 }}><Area value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></Field>
      <div style={{ ...S.row, justifyContent: 'flex-end', marginTop: 12 }}><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={save}>Save draft</Btn></div>
    </Modal>
  );
}

function VerifyModal({ rule, v, onClose, onDone }) {
  const [f, setF] = useState({ law: v.law, provision: v.provision, form: v.form, authority: v.authority, source_url: v.source_url || '', notification_no: v.notification_no || '', notification_date: v.notification_date || '', standing_provision: false, retrieved_at: new Date().toISOString().slice(0, 10), verification_note: '' });
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState('');
  const save = () => api.verifyRule(rule.id, v.version, f).then(r => onDone(r)).catch(e => setErr(errMsg(e)));
  return (
    <Modal title={`Verify — ${rule.id} v${v.version}`} onClose={onClose} width={680}>
      {err && <Note tone="error">{err}</Note>}
      <Note tone="info">Check the law, provision, form, authority, effective dates and the due-date rule <b>({v.due_text})</b> against the official source for the period, then record the source. A different person approves afterwards.</Note>
      {rule.reference_sources?.length > 0 && <div style={{ ...S.small, marginBottom: 8 }}>Reference sources to start from (not proof): {rule.reference_sources.map(u => <a key={u} href={u} target="_blank" rel="noopener noreferrer" style={{ marginRight: 8 }}>{new URL(u).hostname}</a>)}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        {['law', 'provision', 'form', 'authority'].map(k => <Field key={k} label={k}><Input value={f[k] || ''} onChange={e => setF({ ...f, [k]: e.target.value })} /></Field>)}
        <Field label="Official source URL (https)" style={{ gridColumn: '1 / -1' }}><Input value={f.source_url} onChange={e => setF({ ...f, source_url: e.target.value })} /></Field>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem' }}><input type="checkbox" checked={f.standing_provision} onChange={e => setF({ ...f, standing_provision: e.target.checked })} /> Standing provision (no notification)</label>
        {!f.standing_provision && <><Field label="Notification / circular no."><Input value={f.notification_no} onChange={e => setF({ ...f, notification_no: e.target.value })} /></Field><Field label="Notification date"><Input type="date" value={f.notification_date} onChange={e => setF({ ...f, notification_date: e.target.value })} /></Field></>}
        <Field label="Source retrieved on"><Input type="date" value={f.retrieved_at} onChange={e => setF({ ...f, retrieved_at: e.target.value })} /></Field>
        <Field label="What you checked (required)" style={{ gridColumn: '1 / -1' }}><Area value={f.verification_note} onChange={e => setF({ ...f, verification_note: e.target.value })} /></Field>
      </div>
      <label style={{ display: 'flex', gap: 8, fontSize: '0.8rem', marginTop: 10 }}><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /> I checked this version against the official source for its effective period.</label>
      <div style={{ ...S.row, justifyContent: 'flex-end', marginTop: 12 }}><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={!ok} onClick={save}>Record verification</Btn></div>
    </Modal>
  );
}

function ApproveModal({ rule, v, org, onClose, onDone }) {
  const [scope, setScope] = useState({ entity_ids: '', period_from: '', period_to: '' });
  const [p, setP] = useState(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => { setP(null); api.preview(rule.id, v.version, scope).then(setP).catch(e => setErr(errMsg(e))); }, [rule.id, v.version, scope]);
  useEffect(() => { load(); }, [load]);
  const approve = () => api.approveRule(rule.id, v.version, { preview_hash: p.hash, note, scope }).then(onDone).catch(e => { setErr(errMsg(e)); if (e?.response?.status === 409) load(); });
  return (
    <Modal title={`Impact preview & approval — ${rule.id} v${v.version}`} onClose={onClose} width={860}>
      {err && <Note tone="error">{err}</Note>}
      <Note tone="info">Verified by {v.verified_by} on {dtm(v.verified_at)} against <a href={v.source_url} target="_blank" rel="noopener noreferrer">{v.source_url}</a> ({v.notification_no || 'standing provision'}). Due-date rule: <b>{v.due_text}</b>. Approving changes only OPEN tasks in the scope below; filed and completed tasks keep the version they were filed under.</Note>
      <div style={{ ...S.row, marginBottom: 10 }}>
        <div style={{ width: 220 }}><span style={S.label}>Limit to entity</span><Select value={scope.entity_ids} onChange={x => setScope({ ...scope, entity_ids: x })} options={org.entities.map(e => [e.id, e.short_code])} placeholder="All entities" /></div>
        <div><span style={S.label}>Periods from</span><Input type="date" value={scope.period_from} onChange={e => setScope({ ...scope, period_from: e.target.value })} /></div>
        <div><span style={S.label}>to</span><Input type="date" value={scope.period_to} onChange={e => setScope({ ...scope, period_to: e.target.value })} /></div>
      </div>
      {!p ? <Empty>Computing…</Empty> : <>
        <div style={{ ...S.muted, marginBottom: 6 }}>{p.rows.length} existing task(s) in the window · {Object.entries(p.counts).map(([k, n]) => `${k}: ${n}`).join(' · ') || 'none'} · preview {p.hash}</div>
        <Table rows={p.rows} rowKey={r => r.task_id} maxHeight={300} empty="No existing tasks are affected — the version applies to tasks generated from now on"
          cols={[{ label: 'Task', render: r => <>{r.period_label}<div style={S.small}>{r.scope_label}</div></> }, { label: 'Status', key: 'status' }, { label: 'Before', render: r => `${dt(r.before)} (v${r.from_version})` }, { label: 'After', render: r => `${dt(r.after)} (v${r.to_version})` }, { label: 'Effect', render: r => <Tag tone={r.effect === 'due date changes' ? 'amber' : 'grey'}>{r.effect}</Tag> }]} />
        <div style={{ ...S.small, marginTop: 6 }}>{p.applicability_note}</div>
        <Field label="Approval note" style={{ marginTop: 10 }}><Area value={note} onChange={e => setNote(e.target.value)} /></Field>
        <div style={{ ...S.row, justifyContent: 'flex-end', marginTop: 12 }}><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={approve}>Approve this version</Btn></div>
      </>}
    </Modal>
  );
}

function ExtensionModal({ rule, org, meta, onClose, onDone }) {
  const [f, setF] = useState({ kind: 'deadline_extension', period_keys: '', new_due_date: '', waiver_note: '', states: '', entity_ids: '', notification_no: '', notification_date: '', source_url: '', retrieved_at: new Date().toISOString().slice(0, 10), issuer: '', notes: '' });
  const [err, setErr] = useState('');
  const save = () => api.createExt({ rule_id: rule.id, kind: f.kind, period_keys: f.period_keys, new_due_date: f.kind === 'deadline_extension' ? f.new_due_date : null, waiver_note: f.waiver_note,
    scope: { states: f.states ? f.states.split(',').map(x => x.trim().toUpperCase()).filter(Boolean) : [], entity_ids: f.entity_ids ? [f.entity_ids] : [] }, notification_no: f.notification_no, notification_date: f.notification_date || null, source_url: f.source_url, retrieved_at: f.retrieved_at, issuer: f.issuer, notes: f.notes })
    .then(onDone).catch(e => setErr(errMsg(e)));
  return (
    <Modal title={`Extension / fee waiver — ${rule.id}`} onClose={onClose} width={680}>
      {err && <Note tone="error">{err}</Note>}
      <Note tone="warn">A fee waiver is NOT a deadline extension: it never moves the due date and a late filing stays late. Record a separate deadline extension only if the notification extends the date.</Note>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        <Field label="Kind"><Select value={f.kind} onChange={v => setF({ ...f, kind: v })} options={[['deadline_extension', 'Deadline extension'], ['fee_waiver', 'Fee waiver']]} /></Field>
        <Field label="Periods" hint="Period keys, comma separated, e.g. M:2026-05, Q:2026-27:Q1, Y:2025-26"><Input value={f.period_keys} onChange={e => setF({ ...f, period_keys: e.target.value })} /></Field>
        {f.kind === 'deadline_extension' ? <Field label="New due date"><Input type="date" value={f.new_due_date} onChange={e => setF({ ...f, new_due_date: e.target.value })} /></Field>
          : <Field label="What is waived" style={{ gridColumn: '1 / -1' }}><Area value={f.waiver_note} onChange={e => setF({ ...f, waiver_note: e.target.value })} /></Field>}
        <Field label="Only these states (optional)" hint="e.g. GJ, MH"><Input value={f.states} onChange={e => setF({ ...f, states: e.target.value })} /></Field>
        <Field label="Only this entity (optional)"><Select value={f.entity_ids} onChange={v => setF({ ...f, entity_ids: v })} options={org.entities.map(e => [e.id, e.short_code])} placeholder="All" /></Field>
        <Field label="Issuer"><Input value={f.issuer} onChange={e => setF({ ...f, issuer: e.target.value })} placeholder="CBIC / CBDT / MCA …" /></Field>
        <Field label="Notification / circular no."><Input value={f.notification_no} onChange={e => setF({ ...f, notification_no: e.target.value })} /></Field>
        <Field label="Notification date"><Input type="date" value={f.notification_date} onChange={e => setF({ ...f, notification_date: e.target.value })} /></Field>
        <Field label="Official source URL" style={{ gridColumn: '1 / -1' }}><Input value={f.source_url} onChange={e => setF({ ...f, source_url: e.target.value })} /></Field>
        <Field label="Retrieved on"><Input type="date" value={f.retrieved_at} onChange={e => setF({ ...f, retrieved_at: e.target.value })} /></Field>
      </div>
      <div style={{ ...S.row, justifyContent: 'flex-end', marginTop: 12 }}><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={save}>Save as draft</Btn></div>
    </Modal>
  );
}

export default function RulesTab({ meta, org, stamp, onChanged }) {
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState({ search: '', category: '', state: '' });
  const [modal, setModal] = useState(null);
  const load = useCallback(() => api.rules().then(setDoc).catch(e => setErr(errMsg(e))), []);
  useEffect(() => { load(); }, [load, stamp]);
  const rules = useMemo(() => (doc?.rules || []).filter(r => (!q.category || r.category === q.category) && (!q.state || ruleState(r) === q.state) && (!q.search || `${r.id} ${r.name}`.toLowerCase().includes(q.search.toLowerCase()))), [doc, q]);
  if (!doc) return err ? <Note tone="error">{err}</Note> : <Empty>Loading…</Empty>;
  const rule = doc.rules.find(r => r.id === sel) || null;
  const rt = meta.actor.rights;
  const done = text => { setModal(null); setMsg(text); load(); onChanged(); };
  const exts = rule ? (doc.extensions || []).filter(x => x.rule_id === rule.id) : [];
  const counts = doc.rules.reduce((c, r) => { c[ruleState(r)] = (c[ruleState(r)] || 0) + 1; return c; }, {});
  return (
    <div>
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      <Note tone="warn">The catalogue ships with every version as an <b>unverified draft</b>: standard dates are starting references, not approved deadlines, and Income-tax Act, 2025 forms and sections are left unmapped. Nothing schedules live until a person verifies a version against an official source and a second person approves it. ({counts.approved || 0} approved · {counts.verified || 0} verified · {counts.draft || 0} draft)</Note>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) 1fr', gap: '1rem', alignItems: 'start' }}>
        <Section title={`Catalogue (${rules.length})`} flush>
          <div style={{ padding: '0.6rem 0.8rem', display: 'grid', gap: 6 }}>
            <Input placeholder="Search rules" value={q.search} onChange={e => setQ({ ...q, search: e.target.value })} aria-label="Search rules" />
            <div style={S.row}><Select value={q.category} onChange={v => setQ({ ...q, category: v })} options={meta.constants.categories} placeholder="All categories" style={{ flex: 1 }} /><Select value={q.state} onChange={v => setQ({ ...q, state: v })} options={[['approved', 'Approved'], ['verified', 'Verified'], ['draft', 'Unverified']]} placeholder="Any state" style={{ width: 120 }} /></div>
          </div>
          <div style={{ maxHeight: 640, overflow: 'auto' }}>
            {rules.map(r => (
              <button key={r.id} type="button" onClick={() => setSel(r.id)} aria-pressed={sel === r.id} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', borderBottom: `1px solid ${C.line}`, background: sel === r.id ? C.lavSoft : '#fff', padding: '7px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 700, color: sel === r.id ? C.lav : C.text }}>{r.name}</div>
                <div style={S.small}>{r.id} · {r.category} · <Tag tone={VS_TONE[ruleState(r)]}>{ruleState(r) === 'draft' ? 'unverified' : ruleState(r)}</Tag></div>
              </button>
            ))}
          </div>
        </Section>
        {!rule ? <Section title="Choose a rule"><div style={S.muted}>Pick an obligation on the left to see its versions, verify one, preview its impact and approve it, or record an extension.</div></Section> : (
          <div>
            <Section title={`${rule.name} (${rule.id})`} sub={`${rule.category} · ${rule.nature} · ${rule.frequency} · keyed to ${rule.scope.type}${rule.scope.reg_types ? ` (${rule.scope.reg_types.join(', ')})` : ''}${rule.scope.event_types ? ` (events: ${rule.scope.event_types.join(', ')})` : ''}`}
              right={rt.rules && <Btn kind="onNavy" small onClick={() => { const eff = window.prompt('New draft version: effective from (YYYY-MM-DD)', new Date().toISOString().slice(0, 10)); if (eff) api.newDraft(rule.id, { effective_from: eff }).then(() => done('Draft version created')).catch(e => setErr(errMsg(e))); }}>New draft version</Btn>}>
              <div style={{ fontSize: '0.8rem', lineHeight: 1.6 }}>
                <b>Catalogue row:</b> {rule.reference?.key} · {rule.reference?.due_text} · {rule.reference?.status} · {rule.reference?.trigger}<br />
                <b>Evidence to close:</b> {(rule.evidence?.close || []).map(k => meta.constants.doc_types[k]).join(', ') || 'none'}{rule.evidence?.payment?.length ? ` + ${rule.evidence.payment.map(k => meta.constants.doc_types[k]).join(', ')} when paid` : ''} · <b>Acknowledgement:</b> {meta.constants.ack_types[rule.filing?.ack] || '—'}
              </div>
            </Section>
            <Section title="Versions" sub="Effective-dated; the version covering a period's start date applies to it" flush>
              <Table rows={[...rule.versions].reverse()} rowKey={v => v.version}
                cols={[
                  { label: 'Version', render: v => <><b>v{v.version}</b> <Tag tone={VS_TONE[v.status]}>{v.status === 'draft' ? 'unverified draft' : v.status}</Tag></> },
                  { label: 'Effective', render: v => `${v.effective_from ? dt(v.effective_from) : '—'} → ${v.effective_to ? dt(v.effective_to) : 'open'}` },
                  { label: 'Law / provision / form', render: v => <>{v.law}{v.provision && ` · ${v.provision}`}{v.form && ` · ${v.form}`}{v.prefilled && <div style={{ ...S.small, color: C.amber }}>{v.prefilled}</div>}</> },
                  { label: 'Due-date rule', render: v => <>{v.due_text}{v.due_problems?.length > 0 && <div style={{ color: C.red, fontSize: '0.72rem' }}>{v.due_problems.join('; ')}</div>}{v.notes && <div style={S.small}>{v.notes}</div>}</> },
                  { label: 'Verified / approved', render: v => <>{v.verified_by ? <div>✓ {v.verified_by} {dt(v.verified_at)}<div style={S.small}>{v.notification_no || (v.standing_provision ? 'standing provision' : '')} · retrieved {dt(v.retrieved_at)}</div></div> : '—'}{v.approved_by && <div>✓ approved {v.approved_by} {dt(v.approved_at)}</div>}</> },
                  { label: '', render: v => <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {['draft', 'verified'].includes(v.status) && rt.rules && <Btn small kind="ghost" onClick={() => setModal({ kind: 'edit', v })}>Edit</Btn>}
                    {v.status === 'draft' && rt.rules && <Btn small onClick={() => setModal({ kind: 'verify', v })}>Verify</Btn>}
                    {v.status === 'verified' && rt.approve && <Btn small kind="primary" disabled={v.verified_by_id === meta.actor.id} title={v.verified_by_id === meta.actor.id ? 'You verified it — another person approves' : undefined} onClick={() => setModal({ kind: 'approve', v })}>Preview & approve</Btn>}
                    {['draft', 'verified'].includes(v.status) && rt.rules && <Btn small kind="ghost" onClick={() => { const reason = window.prompt('Why is this version withdrawn?'); if (reason) api.withdrawRule(rule.id, v.version, reason).then(() => done('Withdrawn')).catch(e => setErr(errMsg(e))); }}>Withdraw</Btn>}
                  </div> },
                ]} />
            </Section>
            <Section title={`Extensions & fee waivers (${exts.length})`} right={rt.rules && <Btn kind="onNavy" small onClick={() => setModal({ kind: 'ext' })}>Record</Btn>} flush>
              <Table rows={exts} empty="None recorded"
                cols={[{ label: 'Kind', render: x => (x.kind === 'fee_waiver' ? 'Fee waiver' : 'Deadline extension') }, { label: 'Periods', render: x => x.period_keys.join(', ') }, { label: 'New date / waiver', render: x => (x.new_due_date ? dt(x.new_due_date) : x.waiver_note) },
                  { label: 'Scope', render: x => [x.scope.states.join(', '), x.scope.entity_ids.length ? `${x.scope.entity_ids.length} entity` : ''].filter(Boolean).join(' · ') || 'all' }, { label: 'Source', render: x => <>{x.issuer} {x.notification_no}<div style={S.small}>{x.source_url}</div></> },
                  { label: 'Status', render: x => <Tag tone={x.status === 'approved' ? 'green' : x.status === 'draft' ? 'amber' : 'grey'}>{x.status}</Tag> },
                  { label: '', render: x => <div style={{ display: 'flex', gap: 4 }}>
                    {x.status === 'draft' && rt.approve && <Btn small kind="primary" disabled={x.created_by_id === meta.actor.id} onClick={() => api.extAction(x.id, 'approve').then(r => done(`Approved — ${r.tasks_changed} task due date(s) changed`)).catch(e => setErr(errMsg(e)))}>Approve</Btn>}
                    {['draft', 'approved'].includes(x.status) && rt.approve && <Btn small kind="ghost" onClick={() => { const reason = window.prompt('Reason for archiving'); if (reason) api.extAction(x.id, 'archive', { reason }).then(r => done(`Archived — ${r.tasks_changed} task(s) back to their original date`)).catch(e => setErr(errMsg(e))); }}>Archive</Btn>}
                  </div> }]} />
            </Section>
            <Section title="Rule history"><div style={{ maxHeight: 220, overflow: 'auto' }}>{[...(rule.history || [])].reverse().map((h, i) => <div key={i} style={{ fontSize: '0.75rem', padding: '3px 0', borderBottom: `1px solid ${C.line}` }}>{dtm(h.at)} · {h.by} · {h.action.replace(/_/g, ' ')}{h.version ? ` v${h.version}` : ''}{h.note ? ` — ${h.note}` : ''}</div>)}</div></Section>
          </div>
        )}
      </div>
      {modal?.kind === 'edit' && <EditDraft rule={rule} v={modal.v} onClose={() => setModal(null)} onDone={() => done('Draft saved')} />}
      {modal?.kind === 'verify' && <VerifyModal rule={rule} v={modal.v} onClose={() => setModal(null)} onDone={r => done(`Verified${r.warnings?.length ? ` — ${r.warnings.join('; ')}` : ''}. A different person can now approve it.`)} />}
      {modal?.kind === 'approve' && <ApproveModal rule={rule} v={modal.v} org={org} onClose={() => setModal(null)} onDone={r => done(`Approved — ${r.tasks_updated} open task(s) updated`)} />}
      {modal?.kind === 'ext' && <ExtensionModal rule={rule} org={org} meta={meta} onClose={() => setModal(null)} onDone={() => done('Saved as draft — another person approves it')} />}
    </div>
  );
}
