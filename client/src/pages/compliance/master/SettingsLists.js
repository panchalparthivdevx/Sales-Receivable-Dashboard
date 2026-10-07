import React, { useCallback, useEffect, useState } from 'react';
import { SlidersHorizontal, Save, RotateCcw, X, Plus, Trash2 } from 'lucide-react';
import { T } from '../../../theme';
import { capi, errSync } from '../complianceApi';
import { S, Card, Btn, Field, Input, Select, Note, Spinner, ErrorBox } from '../ui';

// Lists / Settings (admin). Defaults come from server/compliance/config/compliance.config.json;
// what is saved here overrides them. "Reset to defaults" removes the overrides.

const KEYS = ['fy_list', 'modules', 'folder_modules', 'default_folder_module', 'document_types', 'storage_root', 'due_soon_days', 'upcoming_windows',
  'upload', 'allow_duplicate_across_tasks', 'applicability_default', 'default_role', 'roles'];
const FLAGS = [
  { key: 'edit_tasks', label: 'Edit tasks', help: 'Status, remarks, completion date, upload documents' },
  { key: 'manage_documents', label: 'Replace / delete documents' },
  { key: 'edit_master', label: 'Edit master', help: 'Masters, applicability, generate tasks, folder setup' },
  { key: 'import', label: 'Import Excel' },
  { key: 'admin', label: 'Admin', help: 'Settings, users and roles, audit trail' },
];

function ChipList({ values, onChange, placeholder, normalise = v => v.trim(), mono }) {
  const [v, setV] = useState('');
  const add = () => { const n = normalise(v); if (n && !values.includes(n)) onChange([...values, n]); setV(''); };
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {values.map(x => (
          <span key={x} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, fontSize: '0.75rem', background: T.primarySoft, color: T.primary, border: `1px solid ${T.border}`, fontFamily: mono ? T.mono : T.font }}>
            {x}<button onClick={() => onChange(values.filter(y => y !== x))} title="Remove" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: T.primary, display: 'inline-flex' }}><X size={11} /></button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Input value={v} placeholder={placeholder} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Btn size="sm" icon={Plus} onClick={add} disabled={!v.trim()}>Add</Btn>
      </div>
    </div>
  );
}

const Block = ({ title, help, children }) => (
  <div style={{ padding: '0.9rem 1.1rem', borderBottom: `1px solid ${T.border}` }}>
    <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: 2 }}>{title}</div>
    {help && <div style={{ ...S.faint, marginBottom: 8 }}>{help}</div>}
    {children}
  </div>
);

export default function SettingsLists({ meta, onChanged }) {
  const [src, setSrc] = useState(null);
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [newRole, setNewRole] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await capi.settings();
      setSrc(r);
      setS(JSON.parse(JSON.stringify(Object.fromEntries(KEYS.map(k => [k, r.effective[k]])))));
    } catch (e) { setError(errSync(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!s) return <Spinner />;

  const set = (k, v) => setS(x => ({ ...x, [k]: v }));
  const dirty = KEYS.filter(k => JSON.stringify(s[k]) !== JSON.stringify(src.effective[k]));

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      await capi.saveSettings(Object.fromEntries(dirty.map(k => [k, s[k]])));
      setMsg({ kind: 'success', text: `Saved: ${dirty.join(', ')}.${dirty.includes('fy_list') ? ' Set up folders for a new FY in Folder Setup.' : ''}` });
      await load(); onChanged();
    } catch (e) { setMsg({ kind: 'error', text: errSync(e) }); }
    finally { setSaving(false); }
  };
  const reset = async () => {
    if (!window.confirm('Reset ALL settings to the defaults in compliance.config.json?')) return;
    try { await capi.resetSettings(); setMsg({ kind: 'success', text: 'Settings reset to defaults.' }); await load(); onChanged(); }
    catch (e) { setMsg({ kind: 'error', text: errSync(e) }); }
  };
  const nextFy = (() => { const last = [...s.fy_list].sort().pop(); const y = last ? Number(last.slice(0, 4)) + 1 : new Date().getFullYear(); return `${y}-${String(y + 1).slice(2)}`; })();

  return (
    <Card title="Lists / Settings" icon={SlidersHorizontal} subtitle="Editable lists and thresholds. Nothing here is hard-coded — defaults live in server/compliance/config/compliance.config.json."
      right={<div style={{ display: 'flex', gap: 8 }}>
        <Btn variant="ghost" icon={RotateCcw} onClick={reset}>Reset to defaults</Btn>
        <Btn variant="primary" icon={Save} onClick={save} disabled={!dirty.length || saving}>{saving ? 'Saving…' : `Save${dirty.length ? ` (${dirty.length})` : ''}`}</Btn>
      </div>}>
      {msg && <Note kind={msg.kind} style={{ margin: '0.8rem 1.1rem 0' }}>{msg.text}</Note>}

      <Block title="Financial Years" help={`Years you can select and generate tasks for. A year with tasks cannot be removed. Next year would be ${nextFy}.`}>
        <ChipList values={s.fy_list} onChange={v => set('fy_list', [...v].sort())} placeholder={`e.g. ${nextFy}`} mono />
      </Block>

      <Block title="Modules" help="Compliance areas. Adding a module (e.g. ESI, PF, ROC) needs only a row here plus its compliances in the Compliance Master. Folder = where its documents are stored.">
        <div className="cmp-scroll">
          <table style={{ ...S.table, maxWidth: 640 }}>
            <thead><tr><th style={S.th}>Key</th><th style={S.th}>Label</th><th style={S.th}>Folder</th><th style={S.th} /></tr></thead>
            <tbody>
              {s.modules.map((m, i) => (
                <tr key={i}>
                  <td style={S.td}><Input value={m.key} onChange={e => set('modules', s.modules.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} /></td>
                  <td style={S.td}><Input value={m.label} onChange={e => set('modules', s.modules.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></td>
                  <td style={S.td}><Select value={m.folder || s.default_folder_module} onChange={v => set('modules', s.modules.map((x, j) => (j === i ? { ...x, folder: v } : x)))} options={s.folder_modules.map(f => ({ value: f, label: f }))} /></td>
                  <td style={S.td}><Btn size="sm" variant="danger" icon={Trash2} title="Remove (only if no compliance uses it)" onClick={() => set('modules', s.modules.filter((_, j) => j !== i))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Btn size="sm" icon={Plus} style={{ marginTop: 6 }} onClick={() => set('modules', [...s.modules, { key: '', label: '', folder: s.default_folder_module }])}>Add module</Btn>
      </Block>

      <Block title="Document Types" help="Types containing “Challan” go to the Challan folder, types containing “Receipt” to Receipt, the rest to Other Data.">
        <ChipList values={s.document_types} onChange={v => set('document_types', v)} placeholder="e.g. Assessment Order" />
      </Block>

      <Block title="Storage" help="Where document folders are created. Use a full path, e.g. D:\Compliance Documents (a relative path is inside the project folder). Changing it does not move existing files.">
        <div className="cmp-form">
          <Field label="Storage Root" hint={`Now resolves to: ${src.storage_root_resolved}`}><Input value={s.storage_root} onChange={e => set('storage_root', e.target.value)} style={{ fontFamily: T.mono }} /></Field>
          <Field label="Folder for other modules"><Select value={s.default_folder_module} onChange={v => set('default_folder_module', v)} options={s.folder_modules.map(f => ({ value: f, label: f }))} /></Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <span style={S.label}>Folder modules (top-level folders under each FY)</span>
          <ChipList values={s.folder_modules} onChange={v => set('folder_modules', v)} placeholder="e.g. ROC" />
        </div>
      </Block>

      <Block title="Thresholds and uploads">
        <div className="cmp-form3">
          <Field label="Due Soon window (days)" hint="Not completed and due within this many days = Due Soon."><Input type="number" min={0} max={90} value={s.due_soon_days} onChange={e => set('due_soon_days', Number(e.target.value))} /></Field>
          <Field label="Upcoming report tabs (days)" hint="Comma separated, e.g. 7,15,30">
            <Input value={s.upcoming_windows.join(',')} onChange={e => set('upcoming_windows', e.target.value.split(',').map(x => Number(x.trim())).filter(n => n > 0 && n <= 365))} />
          </Field>
          <Field label="Max upload size (MB)"><Input type="number" min={1} max={100} value={s.upload.max_size_mb} onChange={e => set('upload', { ...s.upload, max_size_mb: Number(e.target.value) })} /></Field>
          <Field label="Applicability when not set"><Select value={s.applicability_default} onChange={v => set('applicability_default', v)} options={[{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]} /></Field>
          <Field label="Same file on two tasks">
            <Select value={s.allow_duplicate_across_tasks ? 'yes' : 'no'} onChange={v => set('allow_duplicate_across_tasks', v === 'yes')} options={[{ value: 'no', label: 'Block (recommended)' }, { value: 'yes', label: 'Allow' }]} />
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <span style={S.label}>Allowed file types</span>
          <ChipList values={s.upload.allowed_extensions} onChange={v => set('upload', { ...s.upload, allowed_extensions: v })} placeholder=".pdf" mono
            normalise={v => { const t = v.trim().toLowerCase(); return t && !t.startsWith('.') ? `.${t}` : t; }} />
        </div>
      </Block>

      <Block title="Roles and permissions" help="App Administrators are always Admin here. Assign roles to people in Users and Roles.">
        <div className="cmp-scroll">
          <table style={S.table}>
            <thead><tr><th style={S.th}>Role</th><th style={S.th}>Label</th>{FLAGS.map(f => <th key={f.key} style={{ ...S.th, textAlign: 'center' }} title={f.help}>{f.label}</th>)}<th style={S.th} /></tr></thead>
            <tbody>
              {Object.entries(s.roles).map(([name, r]) => (
                <tr key={name}>
                  <td style={{ ...S.td, fontFamily: T.mono, fontWeight: 700 }}>{name}</td>
                  <td style={S.td}><Input value={r.label || ''} onChange={e => set('roles', { ...s.roles, [name]: { ...r, label: e.target.value } })} style={{ width: 120 }} /></td>
                  {FLAGS.map(f => (
                    <td key={f.key} style={{ ...S.td, textAlign: 'center' }}>
                      <input type="checkbox" checked={name === 'admin' || !!r[f.key]} disabled={name === 'admin'} onChange={e => set('roles', { ...s.roles, [name]: { ...r, [f.key]: e.target.checked } })} />
                    </td>
                  ))}
                  <td style={S.td}>{!['admin', 'manager', 'editor', 'viewer'].includes(name) && <Btn size="sm" variant="danger" icon={Trash2} onClick={() => { const x = { ...s.roles }; delete x[name]; set('roles', x); }} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="New role name" style={{ width: 200 }}><Input value={newRole} onChange={e => setNewRole(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="e.g. auditor" /></Field>
          <Btn size="sm" icon={Plus} disabled={!newRole || s.roles[newRole]} onClick={() => { set('roles', { ...s.roles, [newRole]: { label: newRole, edit_tasks: false, manage_documents: false, edit_master: false, import: false, admin: false } }); setNewRole(''); }}>Add role</Btn>
          <Field label="Role for users with no role assigned" style={{ width: 240 }}>
            <Select value={s.default_role} onChange={v => set('default_role', v)} options={Object.keys(s.roles).map(r => ({ value: r, label: s.roles[r].label || r }))} />
          </Field>
        </div>
      </Block>

      <Block title="Statuses (system)" help="Fixed meanings — the status engine depends on them. Colours can be changed in compliance.config.json.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {(src.effective.statuses || []).map(st => (
            <div key={st.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', maxWidth: 320 }} title={st.help}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: st.color }} /><strong>{st.key}</strong><span style={S.faint}>({st.kind})</span>
            </div>
          ))}
        </div>
      </Block>

      <Block title="Zoho Books period sync (read-only here)" help="What “Sync Selected Period” reads for one Company + FY + Month. Edit in compliance.config.json → zoho.entities.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: '0.78rem' }}>
          {(src.effective.zoho?.entities || []).map(e => <span key={e.key}><strong>{e.label}</strong> <span style={S.faint}>{e.path} · {e.date_field} · {e.amount_field} · {e.modules.join('/')}</span></span>)}
        </div>
      </Block>
    </Card>
  );
}
