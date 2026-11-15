import React, { useCallback, useEffect, useState } from 'react';
import { api, errMsg, openDocument } from './api';
import { C, S, Drawer, Modal, Section, Note, Btn, StatusBadge, Flags, Field, Input, Area, Select, Tag, dt, dtm, inr, Empty } from './ui';

// One task: dates (original / revised / internal / filed — kept apart), people, workflow, filing record, evidence, history.
// The server decides what is allowed; the buttons shown are only a convenience.

const nowLocalIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16);

function ActionModal({ action, task, view, meta, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [f, setF] = useState({ filed_at: nowLocalIST(), ack_no: '', portal_status: '', nil_return: false, remarks: '', pay_date: '', ref_type: '', reference: '', bsr_code: '', challan_serial: '', tax: '', interest: '', late_fee: '', penalty: '', other: '' });
  const [ack, setAck] = useState(false);
  const [decision, setDecision] = useState('approve');
  const [kind, setKind] = useState('revised_return');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const payment = ['payment', 'return_payment'].includes(task.nature);
  const submit = async () => {
    setBusy(true); setErr('');
    const body = { action: action.action, rev: task.rev, note };
    if (action.action === 'record_filing') {
      body.filing = { filed_at: `${f.filed_at}:00+05:30`, ack_no: f.ack_no, portal_status: f.portal_status, nil_return: f.nil_return, remarks: f.remarks,
        payment: { date: f.pay_date || null, ref_type: f.ref_type, reference: f.reference, bsr_code: f.bsr_code, challan_serial: f.challan_serial, amounts: { tax: f.tax, interest: f.interest, late_fee: f.late_fee, penalty: f.penalty, other: f.other } } };
    }
    if (action.action === 'verify_close') body.ack_verified = ack;
    if (action.action === 'decide_exception') body.decision = decision;
    if (action.action === 'reopen') body.kind = kind;
    try { const r = await api.act(task.id, body); onDone(r); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const ackLabel = meta.constants.ack_types[task.filing_ack] || 'Acknowledgement';
  return (
    <Modal title={action.label} onClose={onClose} width={action.action === 'record_filing' ? 640 : 480}>
      {err && <Note tone="error">{err}</Note>}
      {action.action === 'record_filing' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <Note tone="info" style={{ gridColumn: '1 / -1' }}>Record what was actually submitted on the portal. This does not close the task: an independent verifier checks the acknowledgement next.</Note>
          <Field label={`${payment && task.nature === 'payment' ? 'Paid' : 'Filed'} on (Indian time)`}><Input type="datetime-local" value={f.filed_at} onChange={e => set('filed_at', e.target.value)} /></Field>
          {task.nature !== 'payment' && !task.internal && <Field label={ackLabel}><Input value={f.ack_no} onChange={e => set('ack_no', e.target.value)} /></Field>}
          <Field label="Portal status"><Input value={f.portal_status} onChange={e => set('portal_status', e.target.value)} placeholder="e.g. Filed" /></Field>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem', marginTop: 18 }}><input type="checkbox" checked={f.nil_return} onChange={e => set('nil_return', e.target.checked)} /> Nil return / nothing payable</label>
          {(payment || f.tax) && <>
            <div style={{ gridColumn: '1 / -1', ...S.label, marginTop: 4 }}>Payment (leave blank if none)</div>
            <Field label="Payment date"><Input type="date" value={f.pay_date} onChange={e => set('pay_date', e.target.value)} /></Field>
            <Field label="Reference type"><Select value={f.ref_type} onChange={v => set('ref_type', v)} options={['CIN', 'CPIN', 'BRN', 'Challan', 'TRRN', 'CRN', 'UTR', 'GRN', 'Other']} placeholder="Choose" /></Field>
            <Field label="Reference (challan / CIN / CPIN / TRRN / UTR)"><Input value={f.reference} onChange={e => set('reference', e.target.value)} /></Field>
            {task.payment_ref === 'TDS' && <><Field label="BSR code"><Input value={f.bsr_code} onChange={e => set('bsr_code', e.target.value)} /></Field><Field label="Challan serial no."><Input value={f.challan_serial} onChange={e => set('challan_serial', e.target.value)} /></Field></>}
            {['tax', 'interest', 'late_fee', 'penalty', 'other'].map(k => <Field key={k} label={k.replace('_', ' ')}><Input type="number" min="0" step="0.01" value={f[k]} onChange={e => set(k, e.target.value)} /></Field>)}
          </>}
          <Field label="Remarks" style={{ gridColumn: '1 / -1' }}><Area value={f.remarks} onChange={e => set('remarks', e.target.value)} /></Field>
        </div>
      )}
      {action.action === 'verify_close' && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.82rem', marginBottom: 10 }}>
          <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
          <span>I checked the acknowledgement / challan reference <b>{view.task.filing?.ack_no || view.task.filing?.payment?.reference}</b> against the portal, and the mandatory evidence is attached (or an exception was approved).</span>
        </label>
      )}
      {action.action === 'decide_exception' && <Field label="Decision"><Select value={decision} onChange={setDecision} options={[['approve', 'Approve the exception'], ['reject', 'Reject']]} /></Field>}
      {action.action === 'reopen' && <><Note tone="warn">The completed filing stays as it is. A NEW version of this task is created for the revised return or correction.</Note><Field label="Kind"><Select value={kind} onChange={setKind} options={[['revised_return', 'Revised return'], ['correction', 'Correction']]} /></Field></>}
      {(action.note || ['approve_filing', 'verify_close', 'start', 'submit'].includes(action.action)) && <Field label={action.note ? 'Note (required)' : 'Note (optional)'} style={{ marginTop: 10 }}><Area value={note} onChange={e => setNote(e.target.value)} /></Field>}
      <div style={{ ...S.row, justifyContent: 'flex-end', marginTop: 12 }}><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : action.label}</Btn></div>
    </Modal>
  );
}

export default function TaskDrawer({ id, meta, users, onClose, onChanged }) {
  const [view, setView] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [action, setAction] = useState(null);
  const [up, setUp] = useState({ doc_type: 'working', file: null, replace: '' });
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(null);
  const [due, setDue] = useState({ date: '', reason: '' });
  const load = useCallback(tid => api.task(tid).then(v => { setView(v); setErr(''); setPlan({ owner_id: v.task.owner_id || '', backup_owner_id: v.task.backup_owner_id || '', checker_id: v.task.checker_id || '', priority: v.task.priority, remarks: v.task.remarks || '', internal_target_override: v.task.internal_target_override || '' }); }).catch(e => setErr(errMsg(e))), []);
  useEffect(() => { setView(null); load(id); }, [id, load]);
  const r = meta.actor.rights;
  const after = (res, text) => { setView(res); setMsg(text); setAction(null); onChanged(); if (res.task) load(res.task.id); };
  if (!view) return <Drawer title="Task" onClose={onClose}>{err ? <Note tone="error">{err}</Note> : <Empty>Loading…</Empty>}</Drawer>;
  const t = view.task;
  const doUpload = async () => {
    if (!up.file) { setErr('Choose a file'); return; }
    setBusy(true); setErr('');
    const fd = new FormData(); fd.append('doc_type', up.doc_type); if (up.replace) fd.append('replace_doc_id', up.replace); fd.append('file', up.file);
    try { const res = await api.upload(t.id, fd); setMsg(res.linked_existing ? 'This file was already stored for this entity — it was linked, not stored again.' : `Uploaded${res.flags?.length ? ` — check the flags: ${res.flags.map(x => x.text).join('; ')}` : ''}. The task status does not change by uploading.`); setUp({ ...up, file: null, replace: '' }); load(t.id); onChanged(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const docAct = async (d, act, body) => { setErr(''); try { await api.docAction(d.id, act, body); load(t.id); onChanged(); } catch (e) { setErr(errMsg(e)); } };
  const savePlan = async () => { setErr(''); try { const res = await api.edit(t.id, { ...plan, rev: t.rev }); setView(res); setMsg('Saved'); onChanged(); } catch (e) { setErr(errMsg(e)); } };
  const saveDue = async () => { setErr(''); try { const res = await api.edit(t.id, { manual_due: due.date, reason: due.reason, rev: t.rev }); setView(res); setMsg('Due date entered'); onChanged(); } catch (e) { setErr(errMsg(e)); } };
  const people = [['', '—'], ...users.map(u => [u.id, u.name])];
  const canPlan = !t.locked && (r.master || (r.prepare && (t.owner_id === meta.actor.id || t.backup_owner_id === meta.actor.id)));
  const dateRow = (label, v, extra) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', borderBottom: `1px solid ${C.line}`, fontSize: '0.8rem' }}><span style={{ color: C.muted }}>{label}</span><span style={{ textAlign: 'right' }}><b>{v}</b>{extra && <div style={S.small}>{extra}</div>}</span></div>;
  return (
    <Drawer title={`${t.rule_name} — ${t.period_label}`} onClose={onClose}>
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      {t.sample && <Note tone="demo">Sample task in the DEMO space — illustrative data, not a real obligation or filing.</Note>}
      {t.rule_unverified && <Note tone="warn">Generated from an <b>unverified</b> rule version (demo only). Live tasks come only from verified and approved rules.</Note>}
      <div style={{ ...S.row, marginBottom: 10 }}><StatusBadge status={t.status} label={t.status_label} /><Flags flags={t.flags} skip={['sample']} />{t.locked && <Tag tone="grey">Locked</Tag>}{t.filing_version > 1 && <Tag tone="lav">Version {t.filing_version} ({t.revision_kind === 'correction' ? 'correction' : 'revised return'})</Tag>}</div>
      <div style={{ ...S.muted, marginBottom: 12 }}>{t.scope_label} · {t.category} · {t.form || t.rule_id} · rule {t.rule_id} v{t.rule_version}{view.rule?.version ? ` (${view.rule.version.status})` : ''} · task {t.id}</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1rem' }}>
        <Section title="Dates" sub="Kept apart: the statutory dates, the company's target and what actually happened">
          {dateRow('Original statutory due', t.original_due ? dt(t.original_due) : '—', t.original_due_at ? `at ${dtm(t.original_due_at)} IST` : t.due_basis || t.due_pending)}
          {dateRow('Revised statutory due', t.revised_due ? dt(t.revised_due) : '—', t.revised_due ? `approved extension ${t.revised_by}` : 'no extension applies')}
          {dateRow('Effective statutory due', t.effective_due ? dt(t.effective_due) : 'none', t.overdue ? `${t.days_overdue} day(s) overdue` : t.days_to_due !== null && !t.filed ? `in ${t.days_to_due} day(s)` : '')}
          {dateRow('Internal target', t.internal_target ? dt(t.internal_target) : '—', t.internal_target_override ? 'set on this task' : t.internal ? 'internal control' : '')}
          {dateRow('Filed / paid', t.filing?.filed_at ? dtm(t.filing.filed_at) : '—', t.filed ? (t.on_time ? 'on or before the effective due date' : t.filed_late ? 'after the effective due date' : '') : '')}
          {t.fee_waivers?.length > 0 && <Note tone="info" style={{ marginTop: 8 }}>Fee waiver recorded ({t.fee_waivers.map(w => w.notification_no || w.id).join(', ')}): {t.fee_waivers.map(w => w.note).join(' ')} — a waiver does not move the due date.</Note>}
          {!t.original_due && r.master && !t.locked && (
            <div style={{ marginTop: 10 }}><div style={S.label}>Enter the due date (manual / event rules)</div>
              <div style={S.row}><Input type="date" value={due.date} onChange={e => setDue({ ...due, date: e.target.value })} style={{ width: 150 }} /><Input placeholder="Source: notice / order / contract …" value={due.reason} onChange={e => setDue({ ...due, reason: e.target.value })} style={{ flex: 1, minWidth: 160 }} /><Btn small onClick={saveDue}>Save</Btn></div></div>
          )}
        </Section>

        <Section title="People & planning" sub="Assignments come from the team mapping when tasks are generated">
          {plan && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Owner (Initiator)"><Select value={plan.owner_id} onChange={v => setPlan({ ...plan, owner_id: v })} options={people} disabled={!r.master || t.locked} /></Field>
            <Field label="Backup owner"><Select value={plan.backup_owner_id} onChange={v => setPlan({ ...plan, backup_owner_id: v })} options={people} disabled={!r.master || t.locked} /></Field>
            <Field label="Approver"><Select value={plan.checker_id} onChange={v => setPlan({ ...plan, checker_id: v })} options={people} disabled={!r.master || t.locked} /></Field>
            <Field label="Priority"><Select value={plan.priority} onChange={v => setPlan({ ...plan, priority: v })} options={[['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]} disabled={!canPlan} /></Field>
            <Field label="Internal target (override)"><Input type="date" value={plan.internal_target_override} onChange={e => setPlan({ ...plan, internal_target_override: e.target.value })} disabled={!canPlan} /></Field>
            <Field label="Remarks" style={{ gridColumn: '1 / -1' }}><Area value={plan.remarks} onChange={e => setPlan({ ...plan, remarks: e.target.value })} disabled={!canPlan} /></Field>
            {canPlan && <div><Btn small onClick={savePlan}>Save</Btn></div>}
          </div>}
          <div style={{ ...S.small, marginTop: 8, lineHeight: 1.6 }}>
            {t.workflow?.prepared_by && <>Prepared by {t.workflow.prepared_by} · </>}{t.workflow?.checked_by && <>checked by {t.workflow.checked_by} · </>}{t.workflow?.filed_by && <>filed by {t.workflow.filed_by} · </>}{t.workflow?.verified_by && <>verified by {t.workflow.verified_by}</>}
          </div>
        </Section>
      </div>

      <Section title="Workflow" sub="Initiator prepares → an Approver (not the Initiator) approves the filing pack → the Initiator records the filing → an Approver who neither prepared nor filed it verifies the acknowledgement and closes">
        {view.actions.length ? <div style={S.row}>{view.actions.map(a => <Btn key={a.action} kind={a.action === 'verify_close' || a.action === 'approve_filing' ? 'primary' : 'soft'} disabled={!!a.blocked} title={a.blocked ? `Not you: ${a.blocked}` : undefined} onClick={() => setAction(a)}>{a.label}{a.blocked ? ` (${a.blocked})` : ''}</Btn>)}</div>
          : <div style={S.muted}>{meta.actor.auditor ? 'Read-only access.' : t.locked ? 'Closed and locked.' : 'Nothing you can do on this task now.'}</div>}
        {t.exception && <Note tone={t.exception.status === 'approved' ? 'ok' : t.exception.status === 'rejected' ? 'error' : 'warn'} style={{ marginTop: 10 }}>Missing-evidence exception <b>{t.exception.status}</b>: {t.exception.reason} (asked by {t.exception.requested_by}{t.exception.decided_by ? `; ${t.exception.status} by ${t.exception.decided_by}: ${t.exception.decision_note}` : ''})</Note>}
        {t.filing && (
          <div style={{ marginTop: 10, fontSize: '0.8rem', lineHeight: 1.7 }}>
            <b>Filing record</b> — {dtm(t.filing.filed_at)} IST · {meta.constants.ack_types[t.filing.ack_type] || 'Reference'}: <b>{t.filing.ack_no || '—'}</b>{t.filing.nil_return ? ' · NIL' : ''}{t.filing.portal_status ? ` · ${t.filing.portal_status}` : ''}
            {t.filing.payment && <div>Payment {t.filing.payment.date ? dt(t.filing.payment.date) : '—'} · {t.filing.payment.ref_type} {t.filing.payment.reference}{t.filing.payment.bsr_code ? ` · BSR ${t.filing.payment.bsr_code} · serial ${t.filing.payment.challan_serial}` : ''} · tax {inr(t.filing.payment.amounts.tax)} · interest {inr(t.filing.payment.amounts.interest)} · late fee {inr(t.filing.payment.amounts.late_fee)} · penalty {inr(t.filing.payment.amounts.penalty)}</div>}
            {t.filing.warnings?.length > 0 && <div style={{ color: C.amber }}>{t.filing.warnings.join('; ')}</div>}
            {t.filing.remarks && <div style={S.muted}>{t.filing.remarks}</div>}
          </div>
        )}
      </Section>

      <Section title="Evidence" sub={`Required to close: ${t.evidence.required.map(k => meta.constants.doc_types[k]).join(', ') || 'none'}. Uploading never marks anything filed.`}>
        <div style={{ ...S.row, marginBottom: 10 }}>{t.evidence.required.map(k => <Tag key={k} tone={t.evidence.missing.includes(k) ? 'red' : 'green'}>{t.evidence.missing.includes(k) ? '✕' : '✓'} {meta.constants.doc_types[k]}</Tag>)}{t.evidence.sample && <Tag tone="lav">sample files</Tag>}</div>
        {!t.locked && (r.prepare || r.file) && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8, alignItems: 'end', marginBottom: 10 }}>
            <Field label="Document type"><Select value={up.doc_type} onChange={v => setUp({ ...up, doc_type: v })} options={Object.entries(meta.constants.doc_types)} /></Field>
            <Field label="Replace (new version of)"><Select value={up.replace} onChange={v => setUp({ ...up, replace: v })} options={view.documents.filter(d => d.status === 'active').map(d => [d.id, `${meta.constants.doc_types[d.doc_type]}: ${d.current.original_name}`])} placeholder="— new document —" /></Field>
            <Field label={`File (max ${meta.storage.max_upload_mb} MB)`}><input type="file" onChange={e => setUp({ ...up, file: e.target.files[0] || null })} style={{ fontSize: '0.78rem' }} /></Field>
            <Btn kind="primary" disabled={busy} onClick={doUpload}>{busy ? 'Uploading…' : 'Upload'}</Btn>
          </div>
        )}
        {!meta.storage.live_key && meta.live && <Note tone="warn">The server has no document encryption key (C2_FILE_KEY), so live uploads are refused until it is set.</Note>}
        {view.documents.length === 0 ? <div style={S.muted}>No documents yet.</div> : view.documents.map(d => (
          <div key={d.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: '8px 10px', marginBottom: 8, background: d.status === 'active' ? '#fff' : '#F9FAFB' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div><b>{meta.constants.doc_types[d.doc_type]}</b> · {d.current.original_name} <span style={S.small}>v{d.current.v} · {(d.current.size / 1024).toFixed(1)} KB · {d.current.uploaded_by} · {dtm(d.current.at)}</span>
                {d.status !== 'active' && <Tag tone="grey">withdrawn</Tag>}{d.legal_hold && <Tag tone="amber" title={d.legal_hold.reason}>legal hold</Tag>}{d.sample && <Tag tone="lav">sample</Tag>}
                <Tag tone={d.current.scan?.status === 'clean' ? 'green' : 'amber'}>scan: {d.current.scan?.status}</Tag>
              </div>
              <div style={S.row}>
                <Btn small kind="ghost" onClick={() => openDocument(d.id).catch(e => setErr(errMsg(e)))}>Download</Btn>
                {d.status === 'active' && !t.locked && (r.prepare || r.file) && <Btn small kind="ghost" onClick={() => { const reason = window.prompt('Why is this document withdrawn? (it is kept, only hidden from evidence)'); if (reason) docAct(d, 'withdraw', { reason }); }}>Withdraw</Btn>}
                {r.approve && <Btn small kind="ghost" onClick={() => { const reason = window.prompt(d.legal_hold ? 'Reason for releasing the legal hold' : 'Reason for the legal hold'); if (reason) docAct(d, 'hold', { on: !d.legal_hold, reason }); }}>{d.legal_hold ? 'Release hold' : 'Legal hold'}</Btn>}
              </div>
            </div>
            {(d.current.flags || []).map((x, i) => <div key={i} style={{ fontSize: '0.74rem', color: x.code === 'not_scanned' ? C.muted : C.amber, marginTop: 3 }}>⚑ {x.text}</div>)}
            {d.current.remote && <div style={{ fontSize: '0.74rem', marginTop: 3, color: d.current.remote.status === 'failed' ? C.red : C.muted }}>
              {d.current.remote.status === 'uploaded' && <>☁ In OneDrive: {d.current.remote.path} {d.current.remote.web_url && <a href={d.current.remote.web_url} target="_blank" rel="noopener noreferrer">open</a>}</>}
              {d.current.remote.status === 'simulated' && <>☁ Simulated OneDrive (demo): {d.current.remote.path}</>}
              {d.current.remote.status === 'unrouted' && <>☁ Not copied to OneDrive: {d.current.remote.reason}</>}
              {d.current.remote.status === 'failed' && <>☁ Copy to OneDrive failed: {d.current.remote.error} {(r.prepare || r.file) && <Btn small kind="ghost" onClick={() => api.docToOneDrive(d.id).then(() => load(t.id)).catch(e => setErr(errMsg(e)))}>Retry</Btn>}</>}
            </div>}
            {d.versions.length > 1 && <details style={{ marginTop: 4 }}><summary style={{ ...S.small, cursor: 'pointer' }}>{d.versions.length} versions</summary>
              {d.versions.slice().reverse().map(v => <div key={v.v} style={{ ...S.small, display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>v{v.v}{v.restored_from ? ` (restored from v${v.restored_from})` : ''} · {v.original_name} · {v.uploaded_by} · {dtm(v.at)} · sha256 {v.sha256.slice(0, 10)}…
                <Btn small kind="ghost" onClick={() => openDocument(d.id, v.v).catch(e => setErr(errMsg(e)))}>Download</Btn>
                {v.v !== d.current.v && !t.locked && (r.prepare || r.file) && <Btn small kind="ghost" onClick={() => docAct(d, 'restore', { version: v.v })}>Make current</Btn>}</div>)}
            </details>}
          </div>
        ))}
      </Section>

      {view.event && <Section title="Event" sub="The event this task comes from"><div style={{ fontSize: '0.8rem' }}><b>{meta.constants.event_types[view.event.type]}</b> {dt(view.event.event_date)}{view.event.event_at ? ` ${dtm(view.event.event_at)} IST` : ''} · {view.event.title} {view.event.reference && `· ${view.event.reference}`}{view.event.response_due && ` · reply due ${dt(view.event.response_due)}`}</div></Section>}
      {view.rule && <Section title="Rule" sub={`${view.rule.id} — ${view.rule.reference?.due_text || ''} (${view.rule.reference?.status || ''})`}>
        <div style={{ fontSize: '0.8rem', lineHeight: 1.6 }}>{view.rule.version?.law} {view.rule.version?.provision && `· ${view.rule.version.provision}`} {view.rule.version?.form && `· ${view.rule.version.form}`}<br />Due-date rule: {view.rule.version?.due_text}<br />
          {view.rule.version?.status === 'approved' ? <>Verified by {view.rule.version.verified_by} against <a href={view.rule.version.source_url} target="_blank" rel="noopener noreferrer">{view.rule.version.source_url}</a> ({view.rule.version.notification_no || 'standing provision'}, retrieved {dt(view.rule.version.retrieved_at)}); approved by {view.rule.version.approved_by}.</> : <span style={{ color: C.amber }}>This version is {view.rule.version?.status} — not verified against an official source.</span>}</div>
      </Section>}

      <Section title="History" sub="Task history and audit entries (newest first)">
        {[...t.history].reverse().map((h, i) => <div key={i} style={{ fontSize: '0.76rem', padding: '4px 0', borderBottom: `1px solid ${C.line}` }}><span style={S.small}>{dtm(h.at)}</span> · <b>{h.by}</b> · {h.action.replace(/_/g, ' ')}{h.from && h.to ? ` (${h.from} → ${h.to})` : ''}{h.note ? ` — ${h.note}` : ''}</div>)}
        <details style={{ marginTop: 8 }}><summary style={{ ...S.small, cursor: 'pointer' }}>{view.audit.length} audit entries</summary>
          {view.audit.map(e => <div key={e.seq} style={{ fontSize: '0.72rem', padding: '3px 0', borderBottom: `1px solid ${C.line}` }}>#{e.seq} {dtm(e.at)} · {e.actor} · {e.action} · {e.summary}{e.reason ? ` — ${e.reason}` : ''}</div>)}
        </details>
      </Section>

      {action && <ActionModal action={action} task={t} view={view} meta={meta} onClose={() => setAction(null)} onDone={res => after(res, `${action.label}: done${res.warnings?.length ? ` — ${res.warnings.join('; ')}` : ''}`)} />}
    </Drawer>
  );
}
