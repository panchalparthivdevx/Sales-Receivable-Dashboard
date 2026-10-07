import React, { useMemo, useState } from 'react';
import { ListChecks, Plus, Pencil, Trash2, CalendarDays, AlertTriangle } from 'lucide-react';
import { T } from '../../../theme';
import { capi, errSync } from '../complianceApi';
import { S, Card, Btn, Field, Input, Select, Modal, Note, Spinner, ErrorBox, Empty, fmtDate } from '../ui';
import useMaster from './useMaster';

// Compliance Master: what must be done, how often, and the due-date rule.
const BLANK = { id: '', name: '', module: '', frequency: 'Monthly', due_rule: '', form_name: '', active_months: '', statutory: 'Yes', remarks: '', active: 'Yes' };
const yn = b => (b ? 'Yes' : 'No');

export default function Compliances({ meta, refreshKey, onChanged }) {
  const { data, error, reload } = useMaster(refreshKey);
  const [mod, setMod] = useState('All');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [preview, setPreview] = useState(null);
  const can = meta.me.flags.edit_master;
  const help = Object.fromEntries(meta.columns.sheets.compliances.columns.map(c => [c.key, c.help]));

  const rows = useMemo(() => (data?.compliances || []).filter(c =>
    (mod === 'All' || c.module === mod) &&
    (!q || `${c.id} ${c.name} ${c.form_name} ${c.remarks}`.toLowerCase().includes(q.toLowerCase()))), [data, mod, q]);

  const open = c => {
    setErr(''); setPreview(null);
    setIsNew(!c);
    setEdit(c ? { ...c, statutory: yn(c.statutory), active: yn(c.active !== false) } : { ...BLANK, module: meta.settings.modules[0]?.key || '' });
  };

  const showDates = async () => {
    setPreview(null); setErr('');
    try { setPreview(await capi.rulePreview({ due_rule: edit.due_rule, frequency: edit.frequency, fy: meta.current.fy_default })); }
    catch (e) { setErr(errSync(e)); }
  };

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const body = { id: edit.id, name: edit.name, module: edit.module, frequency: edit.frequency, due_rule: edit.due_rule, form_name: edit.form_name,
        active_months: edit.active_months, statutory: edit.statutory, remarks: edit.remarks, active: edit.active };
      const r = await capi.saveCompliance(body, isNew ? undefined : edit.id);
      setEdit(null);
      setMsg({ kind: 'success', text: `${r.record.id} ${r.action === 'create' ? 'added' : r.action === 'nochange' ? 'unchanged' : 'saved'}.${r.effects?.length ? ' ' + r.effects.join(' ') : ''}` });
      reload(); onChanged();
    } catch (e) { setErr(errSync(e)); }
    finally { setSaving(false); }
  };
  const remove = async c => {
    if (!window.confirm(`Delete ${c.id} ${c.name}?`)) return;
    try { await capi.deleteCompliance(c.id); setMsg({ kind: 'success', text: `${c.id} deleted.` }); reload(); onChanged(); }
    catch (e) { setMsg({ kind: 'error', text: errSync(e) }); }
  };

  return (
    <Card title="Compliance Master" icon={ListChecks} subtitle="Rows marked ⚠ have statutory or state-specific dates — verify them before relying on the due dates."
      right={<div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select value={mod} onChange={setMod} options={[{ value: 'All', label: 'All modules' }, ...meta.settings.modules.map(m => ({ value: m.key, label: m.label }))]} style={{ width: 140 }} />
        <Input placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} style={{ width: 160 }} />
        {can && <Btn variant="primary" icon={Plus} onClick={() => open(null)}>Add Compliance</Btn>}
      </div>}>
      {msg && <Note kind={msg.kind} style={{ margin: '0.8rem 1.1rem 0' }}>{msg.text}</Note>}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Spinner />}
      {data && (rows.length === 0 ? <Empty icon={ListChecks}>No compliances match.</Empty> : (
        <div className="cmp-scroll">
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>ID</th><th style={S.th}>Compliance</th><th style={S.th}>Module</th><th style={S.th}>Frequency</th><th style={S.th}>Due Date Rule</th>
              <th style={S.th}>Months</th><th style={S.th}>Active</th><th style={{ ...S.th, textAlign: 'right' }}>Tasks</th><th style={S.th}>Remarks</th>{can && <th style={S.th} />}
            </tr></thead>
            <tbody>
              {rows.map(c => {
                const verify = /verify/i.test(c.remarks || '');
                return (
                  <tr key={c.id} className="cmp-row" style={{ opacity: c.active === false ? 0.55 : 1 }}>
                    <td style={{ ...S.td, fontFamily: T.mono, fontWeight: 700, color: T.primary, whiteSpace: 'nowrap' }}>{c.id}</td>
                    <td style={{ ...S.td, minWidth: 180 }}><div style={{ fontWeight: 600 }}>{c.name}</div><div style={S.faint}>{c.form_name}{c.statutory ? ' · statutory' : ' · internal'}</div></td>
                    <td style={S.td}>{c.module}</td>
                    <td style={S.td}>{c.frequency}</td>
                    <td style={{ ...S.td, fontFamily: T.mono, fontSize: '0.74rem', minWidth: 180 }}>{c.due_rule}</td>
                    <td style={S.td}>{c.active_months || <span style={S.faint}>all</span>}</td>
                    <td style={S.td}>{c.active === false ? 'No' : 'Yes'}</td>
                    <td style={S.num}>{c.task_count}</td>
                    <td style={{ ...S.td, ...S.muted, minWidth: 220, maxWidth: 380 }}>
                      {verify && <AlertTriangle size={12} color={T.warning} style={{ marginRight: 4, verticalAlign: '-2px' }} />}{c.remarks}
                    </td>
                    {can && <td style={{ ...S.td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <Btn size="sm" variant="ghost" icon={Pencil} onClick={() => open(c)}>Edit</Btn>
                      {c.task_count === 0 && <Btn size="sm" variant="danger" icon={Trash2} style={{ marginLeft: 4 }} onClick={() => remove(c)} title="Delete (only when it has no tasks)" />}
                    </td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {edit && (
        <Modal title={isNew ? 'Add Compliance' : `Edit ${edit.id}`} width={680} onClose={() => setEdit(null)}
          footer={<><Btn variant="ghost" onClick={() => setEdit(null)}>Cancel</Btn><Btn variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn></>}>
          {err && <Note kind="error" style={{ marginBottom: 10 }}>{err}</Note>}
          <div className="cmp-form">
            <Field label="Compliance ID *" hint={help.id}><Input value={edit.id} disabled={!isNew} onChange={e => setEdit(x => ({ ...x, id: e.target.value.toUpperCase() }))} maxLength={12} /></Field>
            <Field label="Compliance Name *"><Input value={edit.name} onChange={e => setEdit(x => ({ ...x, name: e.target.value }))} /></Field>
            <Field label="Module *" hint={!isNew && edit.task_count ? 'Fixed once tasks exist.' : help.module}>
              <Select value={edit.module} disabled={!isNew && edit.task_count > 0} onChange={v => setEdit(x => ({ ...x, module: v }))} options={meta.settings.modules.map(m => ({ value: m.key, label: m.label }))} />
            </Field>
            <Field label="Frequency *" hint={!isNew && edit.task_count ? 'Fixed once tasks exist.' : help.frequency}>
              <Select value={edit.frequency} disabled={!isNew && edit.task_count > 0} onChange={v => setEdit(x => ({ ...x, frequency: v, active_months: v === 'Monthly' ? x.active_months : '' }))} options={meta.period.frequencies.map(f => ({ value: f, label: f }))} />
            </Field>
          </div>
          <Field label="Due Date Rule *" style={{ marginTop: 12 }} hint={<>Examples: <code>11th of following month</code> · <code>last day of following month</code> · <code>7th of following month; MAR=30-Apr</code> · <code>Q1=31-Jul; Q2=31-Oct; Q3=31-Jan; Q4=31-May</code> · <code>31-Dec</code>. Full syntax in Instructions.</>}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={edit.due_rule} onChange={e => { setPreview(null); setEdit(x => ({ ...x, due_rule: e.target.value })); }} style={{ fontFamily: T.mono }} />
              <Btn icon={CalendarDays} onClick={showDates} disabled={!edit.due_rule}>Check dates</Btn>
            </div>
          </Field>
          {preview && (
            <div style={{ marginTop: 8, padding: '0.5rem 0.7rem', background: T.page, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: '0.76rem', display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
              <strong style={{ width: '100%' }}>Due dates for FY {preview.fy}:</strong>
              {preview.dates.map(d => <span key={d.period}>{d.period}: <strong>{fmtDate(d.due_date)}</strong></span>)}
            </div>
          )}
          <div className="cmp-form" style={{ marginTop: 12 }}>
            <Field label="Form / Return Name"><Input value={edit.form_name} onChange={e => setEdit(x => ({ ...x, form_name: e.target.value }))} /></Field>
            <Field label="Applicable Months" hint={help.active_months}><Input value={edit.active_months} disabled={edit.frequency !== 'Monthly'} placeholder="blank = every month" onChange={e => setEdit(x => ({ ...x, active_months: e.target.value.toUpperCase() }))} /></Field>
            <Field label="Statutory Date" hint={help.statutory}><Select value={edit.statutory} onChange={v => setEdit(x => ({ ...x, statutory: v }))} options={[{ value: 'Yes', label: 'Yes — set by law' }, { value: 'No', label: 'No — internal deadline' }]} /></Field>
            <Field label="Active" hint={help.active}><Select value={edit.active} onChange={v => setEdit(x => ({ ...x, active: v }))} options={[{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]} /></Field>
          </div>
          <Field label="Remarks" style={{ marginTop: 12 }}><textarea rows={2} value={edit.remarks} onChange={e => setEdit(x => ({ ...x, remarks: e.target.value }))} style={{ ...S.control, resize: 'vertical' }} /></Field>
          {!isNew && edit.task_count > 0 && <Note style={{ marginTop: 10 }}>Changing the rule re-dates open tasks whose due date came from the rule. Dates typed by hand and completed tasks are kept.</Note>}
        </Modal>
      )}
    </Card>
  );
}
