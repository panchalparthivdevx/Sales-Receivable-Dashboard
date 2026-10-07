import React, { useState } from 'react';
import { Building2, Plus, Pencil, Trash2 } from 'lucide-react';
import { T } from '../../../theme';
import { capi, errSync } from '../complianceApi';
import { S, Card, Btn, Field, Input, Select, Modal, Note, Spinner, ErrorBox, Empty, fmtDateTime } from '../ui';
import useMaster from './useMaster';

// Company Master: name, short code (used in Task IDs), status, Zoho Books organisation ID.
const BLANK = { name: '', short_code: '', status: 'Active', zoho_org_id: '', remarks: '' };

export default function Companies({ meta, refreshKey, onChanged }) {
  const { data, error, reload } = useMaster(refreshKey);
  const [edit, setEdit] = useState(null);       // { id?, ...fields }
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const can = meta.me.flags.edit_master;
  const cols = meta.columns.sheets.companies.columns;
  const help = Object.fromEntries(cols.map(c => [c.key, c.help]));

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const { id, task_count, created_at, created_by, updated_at, updated_by, ...body } = edit;
      const r = await capi.saveCompany(body, id);
      setEdit(null);
      setMsg({ kind: 'success', text: `${r.record.name} ${r.action === 'create' ? 'added' : r.action === 'nochange' ? 'unchanged' : 'saved'}.${r.effects?.length ? ' ' + r.effects.join(' ') : ''}` });
      reload(); onChanged();
    } catch (e) { setErr(errSync(e)); }
    finally { setSaving(false); }
  };
  const remove = async c => {
    if (!window.confirm(`Delete ${c.name}? This cannot be undone.`)) return;
    try { await capi.deleteCompany(c.id); setMsg({ kind: 'success', text: `${c.name} deleted.` }); reload(); onChanged(); }
    catch (e) { setMsg({ kind: 'error', text: errSync(e) }); }
  };

  return (
    <Card title="Company Master" icon={Building2} subtitle="The Short Code starts every Task ID (e.g. DEVX-GST002-2026-27-AUG). Add the Zoho Books organisation ID to enable period sync."
      right={can && <Btn variant="primary" icon={Plus} onClick={() => { setErr(''); setEdit({ ...BLANK }); }}>Add Company</Btn>}>
      {msg && <Note kind={msg.kind} style={{ margin: '0.8rem 1.1rem 0' }}>{msg.text}</Note>}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Spinner />}
      {data && (data.companies.length === 0 ? <Empty icon={Building2}>No companies yet.</Empty> : (
        <div className="cmp-scroll">
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>Short Code</th><th style={S.th}>Company Name</th><th style={S.th}>Status</th><th style={S.th}>Zoho Org ID</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Tasks</th><th style={S.th}>Remarks</th><th style={S.th}>Last Updated</th>{can && <th style={S.th} />}
            </tr></thead>
            <tbody>
              {data.companies.map(c => (
                <tr key={c.id} className="cmp-row">
                  <td style={{ ...S.td, fontFamily: T.mono, fontWeight: 700, color: T.primary }}>{c.short_code}</td>
                  <td style={{ ...S.td, fontWeight: 600 }}>{c.name}</td>
                  <td style={S.td}><span style={{ color: c.status === 'Active' ? T.success : T.textFaint, fontWeight: 600 }}>{c.status}</span></td>
                  <td style={{ ...S.td, fontFamily: T.mono }}>{c.zoho_org_id || <span style={S.faint}>not linked</span>}</td>
                  <td style={S.num}>{c.task_count}</td>
                  <td style={{ ...S.td, ...S.muted, maxWidth: 300 }}>{c.remarks}</td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap', ...S.faint }}>{fmtDateTime(c.updated_at)}<br />{c.updated_by}</td>
                  {can && <td style={{ ...S.td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <Btn size="sm" variant="ghost" icon={Pencil} onClick={() => { setErr(''); setEdit({ ...c }); }}>Edit</Btn>
                    {c.task_count === 0 && <Btn size="sm" variant="danger" icon={Trash2} style={{ marginLeft: 4 }} onClick={() => remove(c)} title="Delete (only when it has no tasks)" />}
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'Add Company'} onClose={() => setEdit(null)}
          footer={<><Btn variant="ghost" onClick={() => setEdit(null)}>Cancel</Btn><Btn variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn></>}>
          {err && <Note kind="error" style={{ marginBottom: 10 }}>{err}</Note>}
          <div className="cmp-form">
            <Field label="Company Name *" hint={help.name}><Input value={edit.name} onChange={e => setEdit(x => ({ ...x, name: e.target.value }))} autoFocus /></Field>
            <Field label="Short Code *" hint={help.short_code}><Input value={edit.short_code} onChange={e => setEdit(x => ({ ...x, short_code: e.target.value.toUpperCase() }))} maxLength={10} /></Field>
            <Field label="Status" hint={help.status}><Select value={edit.status} onChange={v => setEdit(x => ({ ...x, status: v }))} options={[{ value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Inactive' }]} /></Field>
            <Field label="Zoho Org ID" hint={help.zoho_org_id}><Input value={edit.zoho_org_id} onChange={e => setEdit(x => ({ ...x, zoho_org_id: e.target.value.trim() }))} /></Field>
          </div>
          <Field label="Remarks" style={{ marginTop: 12 }}><Input value={edit.remarks} onChange={e => setEdit(x => ({ ...x, remarks: e.target.value }))} /></Field>
          {edit.id && edit.task_count > 0 && <Note kind="warning" style={{ marginTop: 10 }}>This company has {edit.task_count} tasks. Changing the Short Code does not rename existing Task IDs.</Note>}
        </Modal>
      )}
    </Card>
  );
}
