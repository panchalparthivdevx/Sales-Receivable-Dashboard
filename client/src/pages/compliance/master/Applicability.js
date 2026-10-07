import React, { useMemo, useState } from 'react';
import { GitMerge, Pencil } from 'lucide-react';
import { T } from '../../../theme';
import { capi, errSync } from '../complianceApi';
import { S, Card, Btn, Field, Input, Select, Modal, Note, Spinner, ErrorBox, Empty, fmtDateTime } from '../ui';
import useMaster from './useMaster';

// Company × Compliance: Applicable Yes/No, Responsible, Reviewer.
// Saving pushes the change to OPEN tasks (No → N/A; people copied where not set by hand).
export default function Applicability({ meta, refreshKey, onChanged }) {
  const { data, error, reload } = useMaster(refreshKey);
  const [company, setCompany] = useState('All');
  const [mod, setMod] = useState('All');
  const [only, setOnly] = useState('All');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const can = meta.me.flags.edit_master;

  const rows = useMemo(() => (data?.applicability || []).filter(a =>
    (company === 'All' || a.company_id === company) && (mod === 'All' || a.module === mod) &&
    (only === 'All' || a.applicable === only) &&
    (!q || `${a.compliance_id} ${a.compliance_name} ${a.responsible} ${a.reviewer}`.toLowerCase().includes(q.toLowerCase()))), [data, company, mod, only, q]);

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const r = await capi.saveApplicability({ company_id: edit.company_id, compliance_id: edit.compliance_id, applicable: edit.applicable, responsible: edit.responsible, reviewer: edit.reviewer, remarks: edit.remarks });
      setEdit(null);
      setMsg({ kind: 'success', text: `${edit.company_short} · ${edit.compliance_id} ${r.action === 'nochange' ? 'unchanged' : 'saved'}.${r.effects?.length ? ' ' + r.effects.join(' ') : ''}` });
      reload(); onChanged();
    } catch (e) { setErr(errSync(e)); }
    finally { setSaving(false); }
  };

  return (
    <Card title="Company Applicability" icon={GitMerge} subtitle={`Which compliances apply to which company, and who is responsible. Not set = ${meta.settings.applicability_default} (default). Applicable = No makes open tasks N/A.`}
      right={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Select value={company} onChange={setCompany} options={[{ value: 'All', label: 'All companies' }, ...meta.companies.map(c => ({ value: c.id, label: c.short_code }))]} style={{ width: 130 }} />
        <Select value={mod} onChange={setMod} options={[{ value: 'All', label: 'All modules' }, ...meta.settings.modules.map(m => ({ value: m.key, label: m.label }))]} style={{ width: 130 }} />
        <Select value={only} onChange={setOnly} options={[{ value: 'All', label: 'Yes and No' }, { value: 'Yes', label: 'Applicable' }, { value: 'No', label: 'Not applicable' }]} style={{ width: 140 }} />
        <Input placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} style={{ width: 150 }} />
      </div>}>
      {msg && <Note kind={msg.kind} style={{ margin: '0.8rem 1.1rem 0' }}>{msg.text}</Note>}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Spinner />}
      {data && (rows.length === 0 ? <Empty icon={GitMerge}>No rows match.</Empty> : (
        <div className="cmp-scroll" style={{ maxHeight: 620, overflowY: 'auto' }}>
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>Company</th><th style={S.th}>Compliance</th><th style={S.th}>Module</th><th style={S.th}>Applicable</th>
              <th style={S.th}>Responsible</th><th style={S.th}>Reviewer</th><th style={S.th}>Remarks</th><th style={S.th}>Updated</th>{can && <th style={S.th} />}
            </tr></thead>
            <tbody>
              {rows.map(a => (
                <tr key={`${a.company_id}|${a.compliance_id}`} className="cmp-row">
                  <td style={{ ...S.td, fontFamily: T.mono, fontWeight: 700, color: T.primary }}>{a.company_short}</td>
                  <td style={S.td}><span style={{ fontFamily: T.mono, color: T.textMuted, marginRight: 6 }}>{a.compliance_id}</span>{a.compliance_name}</td>
                  <td style={S.td}>{a.module}</td>
                  <td style={S.td}>
                    <span style={{ fontWeight: 700, color: a.applicable === 'Yes' ? T.success : T.textFaint }}>{a.applicable === 'Yes' ? 'Yes' : 'No (N/A)'}</span>
                    {!a.explicit && <span style={S.faint}> · default</span>}
                  </td>
                  <td style={S.td}>{a.responsible || <span style={S.faint}>—</span>}</td>
                  <td style={S.td}>{a.reviewer || <span style={S.faint}>—</span>}</td>
                  <td style={{ ...S.td, ...S.muted, maxWidth: 220 }}>{a.remarks}</td>
                  <td style={{ ...S.td, ...S.faint, whiteSpace: 'nowrap' }}>{a.updated_at ? fmtDateTime(a.updated_at) : ''}</td>
                  {can && <td style={{ ...S.td, textAlign: 'right' }}><Btn size="sm" variant="ghost" icon={Pencil} onClick={() => { setErr(''); setEdit({ ...a }); }}>Edit</Btn></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {data && <div style={{ ...S.faint, padding: '0.5rem 1.1rem' }}>{rows.length} of {data.applicability.length} rows</div>}

      {edit && (
        <Modal title={`${edit.company_short} · ${edit.compliance_id}`} subtitle={`${edit.company_name} — ${edit.compliance_name}`} onClose={() => setEdit(null)}
          footer={<><Btn variant="ghost" onClick={() => setEdit(null)}>Cancel</Btn><Btn variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn></>}>
          {err && <Note kind="error" style={{ marginBottom: 10 }}>{err}</Note>}
          <datalist id="cmp-people-app">{(data?.people || []).map(p => <option key={p} value={p} />)}</datalist>
          <div className="cmp-form">
            <Field label="Applicable"><Select value={edit.applicable} onChange={v => setEdit(x => ({ ...x, applicable: v }))} options={[{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No — tasks become N/A' }]} /></Field>
            <span />
            <Field label="Responsible"><Input list="cmp-people-app" value={edit.responsible} onChange={e => setEdit(x => ({ ...x, responsible: e.target.value }))} /></Field>
            <Field label="Reviewer"><Input list="cmp-people-app" value={edit.reviewer} onChange={e => setEdit(x => ({ ...x, reviewer: e.target.value }))} /></Field>
          </div>
          <Field label="Remarks" style={{ marginTop: 12 }}><Input value={edit.remarks} onChange={e => setEdit(x => ({ ...x, remarks: e.target.value }))} /></Field>
          <Note style={{ marginTop: 10 }}>Saving updates this company's <strong>open</strong> tasks for this compliance (completed tasks are never changed). A Responsible/Reviewer typed directly on a task is kept.</Note>
        </Modal>
      )}
    </Card>
  );
}
