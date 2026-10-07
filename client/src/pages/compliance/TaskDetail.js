import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Save, Upload, Link2, Eye, Download, Replace, Trash2, FileText, History, ExternalLink, Lock } from 'lucide-react';
import { T } from '../../theme';
import { capi, errSync, errText } from './complianceApi';
import { S, Btn, Drawer, Field, Input, Select, StatusBadge, Spinner, ErrorBox, Note, Empty, fmtDate, fmtDateTime, fmtSize, saveBlob } from './ui';

// Task detail panel: update status / remarks / completion date, documents, audit trail.

function Section({ title, icon: Icon, children, right }) {
  return (
    <div style={{ ...S.card, marginBottom: '0.9rem' }}>
      <div style={{ ...S.cardHead, padding: '0.6rem 0.9rem' }}>
        {Icon && <Icon size={14} color={T.primary} />}
        <div style={{ ...S.cardTitle, fontSize: '0.84rem', flex: 1 }}>{title}</div>
        {right}
      </div>
      <div style={{ padding: '0.75rem 0.9rem' }}>{children}</div>
    </div>
  );
}

const Info = ({ label, children }) => (
  <div style={{ minWidth: 0 }}>
    <div style={S.label}>{label}</div>
    <div style={{ fontSize: '0.82rem', color: T.text, overflowWrap: 'anywhere' }}>{children || <span style={S.faint}>—</span>}</div>
  </div>
);

function leafFor(meta, docType) {
  const L = { receipt: 'Receipt', challan: 'Challan', other: 'Other Data', ...(meta.settings.folder_leaves || {}) };
  const t = String(docType || '').toLowerCase();
  return t.includes('challan') ? L.challan : t.includes('receipt') ? L.receipt : L.other;
}

export default function TaskDetail({ taskId, meta, colors, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [docType, setDocType] = useState(meta.settings.document_types[0]);
  const [file, setFile] = useState(null);
  const [link, setLink] = useState({ url: '', title: '' });
  const [busyDoc, setBusyDoc] = useState('');
  const fileRef = useRef(null);
  const replaceRef = useRef(null);
  const replaceTarget = useRef(null);
  const can = meta.me.flags;

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await capi.task(taskId);
      setData(d);
      const t = d.task;
      setForm({ status: t.status, completion_date: t.completion_date || '', remarks: t.remarks, responsible: t.responsible, reviewer: t.reviewer, due_date: t.due_date, applicable: t.applicable ? 'Yes' : 'No' });
    } catch (e) { setError(errSync(e)); }
  }, [taskId]);
  useEffect(() => { load(); }, [load]);

  const flash = (kind, text) => { setMsg({ kind, text }); if (kind === 'success') setTimeout(() => setMsg(null), 3500); };

  const save = async () => {
    const t = data.task;
    const body = {};
    for (const k of ['status', 'remarks', 'responsible', 'reviewer']) if ((form[k] || '') !== (t[k] || '')) body[k] = form[k];
    if (form.status === 'Completed' && form.completion_date !== (t.completion_date || '')) body.completion_date = form.completion_date;
    if (can.edit_master) {
      if (form.due_date !== t.due_date) body.due_date = form.due_date;
      if ((form.applicable === 'Yes') !== t.applicable) body.applicable = form.applicable;
    }
    if (!Object.keys(body).length) return flash('info', 'Nothing changed.');
    setSaving(true);
    try {
      await capi.updateTask(t.task_id, body);
      flash('success', 'Saved.');
      await load();
      onChanged();
    } catch (e) { flash('error', errSync(e)); }
    finally { setSaving(false); }
  };

  const resetDueDate = async () => {
    setSaving(true);
    try { await capi.updateTask(data.task.task_id, { due_date: '' }); flash('success', 'Due date reset to the rule.'); await load(); onChanged(); }
    catch (e) { flash('error', errSync(e)); }
    finally { setSaving(false); }
  };

  const upload = async () => {
    if (!file) return flash('error', 'Choose a file first.');
    setBusyDoc('upload');
    try {
      await capi.uploadDoc(data.task.task_id, file, docType);
      setFile(null); if (fileRef.current) fileRef.current.value = '';
      flash('success', `Uploaded to the ${leafFor(meta, docType)} folder.`);
      await load(); onChanged();
    } catch (e) { flash('error', errSync(e)); }
    finally { setBusyDoc(''); }
  };

  const addLink = async () => {
    setBusyDoc('link');
    try {
      await capi.addLink(data.task.task_id, { ...link, doc_type: docType });
      setLink({ url: '', title: '' });
      flash('success', 'Link added.');
      await load(); onChanged();
    } catch (e) { flash('error', errSync(e)); }
    finally { setBusyDoc(''); }
  };

  const openDoc = async (d, inline) => {
    // Open the tab first (before awaiting) so the browser doesn't block it as a pop-up
    const win = inline ? window.open('', '_blank') : null;
    setBusyDoc(d.id);
    try {
      const r = await capi.downloadDoc(d.id, inline);
      if (inline && win) {
        const url = URL.createObjectURL(new Blob([r.data], { type: r.headers['content-type'] || 'application/octet-stream' }));
        win.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      } else saveBlob(r.data, d.name);
      load();
    } catch (e) { if (win) win.close(); flash('error', await errText(e)); }
    finally { setBusyDoc(''); }
  };

  const replace = async e => {
    const f = e.target.files?.[0];
    const d = replaceTarget.current;
    e.target.value = '';
    if (!f || !d) return;
    setBusyDoc(d.id);
    try { await capi.replaceDoc(d.id, f); flash('success', 'Document replaced (old file archived).'); await load(); onChanged(); }
    catch (er) { flash('error', errSync(er)); }
    finally { setBusyDoc(''); }
  };

  const remove = async d => {
    if (!window.confirm(`Delete "${d.name}"? The file is moved to the archive folder and the action is logged.`)) return;
    setBusyDoc(d.id);
    try { await capi.deleteDoc(d.id); flash('success', 'Document deleted.'); await load(); onChanged(); }
    catch (e) { flash('error', errSync(e)); }
    finally { setBusyDoc(''); }
  };

  const t = data?.task;
  const statusOpts = meta.statuses.user.map(s => ({ value: s, label: s }));
  const people = meta.people || [];

  return (
    <Drawer title={taskId} subtitle={t ? `${t.company_name} · ${t.compliance_name}` : 'Loading…'} onClose={onClose}
      right={t && <StatusBadge status={t.display_status} colors={colors} late={t.completed_late} />}>
      {!data && !error && <Spinner label="Loading task…" />}
      {error && <ErrorBox error={error} onRetry={load} />}
      {t && form && (
        <>
          <datalist id="cmp-people">{people.map(p => <option key={p} value={p} />)}</datalist>
          {msg && <Note kind={msg.kind} style={{ marginBottom: 10 }}>{msg.text}</Note>}

          <Section title="Details" icon={FileText}>
            <div className="cmp-form">
              <Info label="Company">{t.company_name} <span style={S.faint}>({t.company_short})</span></Info>
              <Info label="Module">{t.module}</Info>
              <Info label="Compliance">{t.compliance_name}{t.form_name ? <span style={S.faint}> · {t.form_name}</span> : null}</Info>
              <Info label="Period">{t.period_label} <span style={S.faint}>· {t.month_label} · {t.quarter} · {t.half}</span></Info>
              <Info label="Due Date">
                {fmtDate(t.due_date)} <span style={S.faint}>· {t.due_date_source === 'manual' ? 'set manually' : `rule: ${data.compliance?.due_rule || ''}`}</span>
              </Info>
              <Info label="Applicable">{t.applicable ? 'Yes' : `No (N/A — ${t.na_source === 'applicability' ? 'from Company Applicability' : 'set on this task'})`}</Info>
              <Info label="Last Updated">{fmtDateTime(t.updated_at)} {t.updated_by ? <span style={S.faint}>by {t.updated_by}</span> : null}</Info>
              {data.compliance?.statutory && <Info label="Note">{data.compliance?.remarks}</Info>}
            </div>
          </Section>

          <Section title="Update" icon={Save} right={!can.edit_tasks && <span style={{ ...S.faint, display: 'inline-flex', gap: 4, alignItems: 'center' }}><Lock size={11} /> view only</span>}>
            {!t.applicable && <Note kind="warning" style={{ marginBottom: 10 }}>This task is Not Applicable (N/A). It does not count against compliance and its status cannot change{can.edit_master ? ' — set Applicable to Yes below to track it' : ''}.</Note>}
            <div className="cmp-form">
              <Field label="Status" hint="Due Soon and Overdue are calculated automatically.">
                <Select value={form.status} onChange={v => setForm(f => ({ ...f, status: v, completion_date: v === 'Completed' ? (f.completion_date || meta.today) : '' }))}
                  options={statusOpts} disabled={!can.edit_tasks || !t.applicable} />
              </Field>
              <Field label="Completion Date" hint={form.status === 'Completed' ? 'Required for Completed.' : 'Only for Completed tasks.'}>
                <Input type="date" value={form.completion_date} max={meta.today} disabled={!can.edit_tasks || form.status !== 'Completed'} onChange={e => setForm(f => ({ ...f, completion_date: e.target.value }))} />
              </Field>
              <Field label="Responsible"><Input list="cmp-people" value={form.responsible} disabled={!can.edit_tasks} onChange={e => setForm(f => ({ ...f, responsible: e.target.value }))} /></Field>
              <Field label="Reviewer"><Input list="cmp-people" value={form.reviewer} disabled={!can.edit_tasks} onChange={e => setForm(f => ({ ...f, reviewer: e.target.value }))} /></Field>
              {can.edit_master && (
                <>
                  <Field label="Due Date (master)" hint={t.due_date_source === 'manual' ? <button style={S.linkBtn} onClick={resetDueDate} disabled={saving}>Reset to rule</button> : 'Changing it marks the date as manual.'}>
                    <Input type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
                  </Field>
                  <Field label="Applicable (master)">
                    <Select value={form.applicable} onChange={v => setForm(f => ({ ...f, applicable: v }))} options={[{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No (N/A)' }]} />
                  </Field>
                </>
              )}
            </div>
            <Field label="Remarks" style={{ marginTop: 12 }}>
              <textarea value={form.remarks} disabled={!can.edit_tasks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} rows={3} style={{ ...S.control, resize: 'vertical' }} />
            </Field>
            {can.edit_tasks && <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}><Btn variant="primary" icon={Save} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Btn></div>}
          </Section>

          <Section title={`Documents (${data.documents.length})`} icon={Upload}>
            {data.documents.length === 0 ? <Empty>No documents yet.</Empty> : (
              <div style={{ marginBottom: 12, border: `1px solid ${T.border}`, borderRadius: 8 }}>
                {data.documents.map((d, i) => (
                  <div key={d.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', padding: '0.55rem 0.7rem', borderTop: i ? `1px solid ${T.border}` : 'none' }}>
                    <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: T.primary, background: T.primarySoft, border: `1px solid ${T.border}`, borderRadius: 4, padding: '0 6px' }}>{d.doc_type}</span>
                        <span style={{ fontWeight: 600, fontSize: '0.8rem', overflowWrap: 'anywhere' }}>{d.name}</span>
                        {d.version > 1 && <span style={S.faint}>v{d.version}</span>}
                      </div>
                      <div style={{ ...S.faint, overflowWrap: 'anywhere', marginTop: 2 }}>
                        {d.kind === 'link' ? 'Link' : `${fmtSize(d.size)} · ${d.folder}`}
                      </div>
                      <div style={S.faint}>{fmtDateTime(d.uploaded_at)} · {d.uploaded_by}{d.replaced_at ? ` · replaced ${fmtDateTime(d.replaced_at)}` : ''}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {d.kind === 'link' ? (
                        <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ ...S.linkBtn, display: 'inline-flex', gap: 3, alignItems: 'center' }}><ExternalLink size={11} />Open</a>
                      ) : (
                        <>
                          <Btn size="sm" variant="ghost" icon={Eye} disabled={busyDoc === d.id} onClick={() => openDoc(d, true)}>View</Btn>
                          <Btn size="sm" variant="ghost" icon={Download} disabled={busyDoc === d.id} onClick={() => openDoc(d, false)}>Download</Btn>
                          {can.manage_documents && <Btn size="sm" variant="ghost" icon={Replace} disabled={busyDoc === d.id} onClick={() => { replaceTarget.current = d; replaceRef.current?.click(); }}>Replace</Btn>}
                        </>
                      )}
                      {can.manage_documents && <Btn size="sm" variant="danger" icon={Trash2} disabled={busyDoc === d.id} onClick={() => remove(d)}>Delete</Btn>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <input ref={replaceRef} type="file" style={{ display: 'none' }} accept={meta.settings.upload.allowed_extensions.join(',')} onChange={replace} />
            {can.edit_tasks && (
              <div style={{ borderTop: data.documents.length ? `1px solid ${T.border}` : 'none', paddingTop: data.documents.length ? 12 : 0 }}>
                <div className="cmp-form">
                  <Field label="Document Type" hint={`Saved in the “${leafFor(meta, docType)}” folder.`}>
                    <Select value={docType} onChange={setDocType} options={meta.settings.document_types.map(d => ({ value: d, label: d }))} />
                  </Field>
                  <Field label="File" hint={`${meta.settings.upload.allowed_extensions.join(' ')} · max ${meta.settings.upload.max_size_mb} MB`}>
                    <input ref={fileRef} type="file" accept={meta.settings.upload.allowed_extensions.join(',')} onChange={e => setFile(e.target.files?.[0] || null)} style={{ ...S.control, padding: '0.3rem' }} />
                  </Field>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <Btn variant="primary" icon={Upload} onClick={upload} disabled={!file || busyDoc === 'upload'}>{busyDoc === 'upload' ? 'Uploading…' : 'Upload'}</Btn>
                </div>
                <div className="cmp-form" style={{ marginTop: 10 }}>
                  <Field label="Or add a link (e.g. portal acknowledgement)"><Input placeholder="https://…" value={link.url} onChange={e => setLink(l => ({ ...l, url: e.target.value }))} /></Field>
                  <Field label="Link title"><Input placeholder="e.g. GSTR-3B ARN" value={link.title} onChange={e => setLink(l => ({ ...l, title: e.target.value }))} /></Field>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <Btn icon={Link2} onClick={addLink} disabled={!link.url || busyDoc === 'link'}>Add link</Btn>
                </div>
              </div>
            )}
          </Section>

          <Section title="Audit Trail" icon={History}>
            {data.audit.length === 0 ? <Empty>No changes recorded yet.</Empty> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.audit.map(e => (
                  <div key={e.id} style={{ borderLeft: `3px solid ${T.border}`, paddingLeft: 10 }}>
                    <div style={{ fontSize: '0.78rem' }}><strong>{e.user}</strong> <span style={S.faint}>· {fmtDateTime(e.at)} · {e.action}</span></div>
                    <div style={{ fontSize: '0.78rem', color: T.textMuted }}>{e.summary}</div>
                    {e.changes?.map((c, i) => (
                      <div key={i} style={{ fontSize: '0.74rem', color: T.textMuted }}>
                        {c.field}: <span style={{ textDecoration: 'line-through', color: T.textFaint }}>{String(c.from ?? '') || '(empty)'}</span> → <span style={{ color: T.text }}>{String(c.to ?? '') || '(empty)'}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </Drawer>
  );
}
