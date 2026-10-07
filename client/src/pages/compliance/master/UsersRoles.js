import React, { useCallback, useEffect, useState } from 'react';
import { Users, UserPlus, KeyRound, UserX, UserCheck, Pencil } from 'lucide-react';
import { T } from '../../../theme';
import { capi, errSync } from '../complianceApi';
import { S, Card, Btn, Field, Input, Select, Modal, Note, Spinner, ErrorBox } from '../ui';

// Users and Roles. Uses the app's existing logins (same users as User Settings).
//  • Compliance role + company access: compliance admins.
//  • Create login / disable / reset password: app Administrators only.
export default function UsersRoles({ meta }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [edit, setEdit] = useState(null);      // role/access modal
  const [pwd, setPwd] = useState(null);        // reset password modal
  const [add, setAdd] = useState(null);        // new user modal
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isAppAdmin = meta.me.app_role === 'admin';

  const load = useCallback(async () => {
    setError('');
    try { setData(await capi.users()); } catch (e) { setError(errSync(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, ok) => {
    setBusy(true); setErr('');
    try { await fn(); setMsg({ kind: 'success', text: ok }); setEdit(null); setPwd(null); setAdd(null); load(); }
    catch (e) { setErr(errSync(e)); setMsg(m => (edit || pwd || add ? m : { kind: 'error', text: errSync(e) })); }
    finally { setBusy(false); }
  };

  const roleOpts = data ? Object.entries(data.roles).map(([k, r]) => ({ value: k, label: r.label || k })) : [];
  const coName = id => meta.companies.find(c => c.id === id)?.short_code || id;
  const toggleCo = (list, id) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

  const CompanyPicker = ({ value, onChange }) => (
    <div>
      <span style={S.label}>Company access</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {meta.companies.map(c => (
          <label key={c.id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: '0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={value.includes(c.id)} onChange={() => onChange(toggleCo(value, c.id))} /> {c.name}
          </label>
        ))}
      </div>
      <div style={{ ...S.faint, marginTop: 4 }}>None ticked = all companies. Ticked = this user sees only those companies' tasks, documents and Zoho data.</div>
    </div>
  );

  return (
    <Card title="Users and Roles" icon={Users} subtitle="Same logins as the rest of the Finance Suite. Role permissions are set in Lists / Settings."
      right={isAppAdmin && <Btn variant="primary" icon={UserPlus} onClick={() => { setErr(''); setAdd({ username: '', name: '', password: '', role: data?.default_role || 'viewer', companies: [] }); }}>Add User</Btn>}>
      {msg && <Note kind={msg.kind} style={{ margin: '0.8rem 1.1rem 0' }}>{msg.text}</Note>}
      {!isAppAdmin && <Note style={{ margin: '0.8rem 1.1rem 0' }}>You can change compliance roles and company access. Creating users, disabling users and resetting passwords needs an app Administrator.</Note>}
      {error && <ErrorBox error={error} onRetry={load} />}
      {!data && !error && <Spinner />}
      {data && (
        <div className="cmp-scroll">
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>Name</th><th style={S.th}>Username</th><th style={S.th}>App role</th><th style={S.th}>Login</th>
              <th style={S.th}>Compliance role</th><th style={S.th}>Company access</th><th style={S.th} />
            </tr></thead>
            <tbody>
              {data.users.map(u => (
                <tr key={u.id} className="cmp-row" style={{ opacity: u.active ? 1 : 0.5 }}>
                  <td style={{ ...S.td, fontWeight: 600 }}>{u.name}</td>
                  <td style={{ ...S.td, ...S.muted }}>{u.username}</td>
                  <td style={S.td}>{u.app_role === 'admin' ? 'Administrator' : 'User'}</td>
                  <td style={S.td}>{u.active ? <span style={{ color: T.success }}>Active</span> : <span style={{ color: T.danger }}>Disabled</span>}{!u.compliance_enabled && <div style={S.faint}>module off in User Settings</div>}</td>
                  <td style={S.td}>
                    <strong>{data.roles[u.role]?.label || u.role}</strong>{!u.assigned && <span style={S.faint}> · default</span>}
                  </td>
                  <td style={S.td}>{u.companies.length ? u.companies.map(coName).join(', ') : <span style={S.faint}>All</span>}</td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {u.app_role !== 'admin' && <Btn size="sm" variant="ghost" icon={Pencil} onClick={() => { setErr(''); setEdit({ ...u }); }}>Role</Btn>}
                    {isAppAdmin && <Btn size="sm" variant="ghost" icon={KeyRound} style={{ marginLeft: 4 }} title="Reset password" onClick={() => { setErr(''); setPwd({ id: u.id, name: u.name, password: '' }); }} />}
                    {isAppAdmin && u.id !== meta.me.id && (u.active
                      ? <Btn size="sm" variant="danger" icon={UserX} style={{ marginLeft: 4 }} title="Disable login" onClick={() => window.confirm(`Disable ${u.name}? They will not be able to sign in.`) && run(() => capi.updateUser(u.id, { active: false }), `${u.name} disabled.`)} />
                      : <Btn size="sm" icon={UserCheck} style={{ marginLeft: 4 }} title="Enable login" onClick={() => run(() => capi.updateUser(u.id, { active: true }), `${u.name} enabled.`)} />)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <Modal title={`Compliance role — ${edit.name}`} onClose={() => setEdit(null)}
          footer={<><Btn variant="ghost" onClick={() => setEdit(null)}>Cancel</Btn><Btn variant="primary" disabled={busy} onClick={() => run(() => capi.setUserRole(edit.id, { role: edit.role, companies: edit.companies }), `${edit.name}: role saved.`)}>Save</Btn></>}>
          {err && <Note kind="error" style={{ marginBottom: 10 }}>{err}</Note>}
          <Field label="Role"><Select value={edit.role} onChange={v => setEdit(x => ({ ...x, role: v }))} options={roleOpts} /></Field>
          <div style={{ marginTop: 12 }}><CompanyPicker value={edit.companies} onChange={v => setEdit(x => ({ ...x, companies: v }))} /></div>
        </Modal>
      )}

      {pwd && (
        <Modal title={`Reset password — ${pwd.name}`} onClose={() => setPwd(null)}
          footer={<><Btn variant="ghost" onClick={() => setPwd(null)}>Cancel</Btn><Btn variant="primary" disabled={busy || pwd.password.length < 8} onClick={() => run(() => capi.updateUser(pwd.id, { password: pwd.password }), `Password reset for ${pwd.name}.`)}>Reset password</Btn></>}>
          {err && <Note kind="error" style={{ marginBottom: 10 }}>{err}</Note>}
          <Field label="New password" hint="At least 8 characters. Share it with the user privately."><Input type="password" autoComplete="new-password" value={pwd.password} onChange={e => setPwd(x => ({ ...x, password: e.target.value }))} /></Field>
        </Modal>
      )}

      {add && (
        <Modal title="Add User" subtitle="Creates a Finance Suite login that can open only the Compliance Dashboard (widen it in User Settings if needed)." onClose={() => setAdd(null)}
          footer={<><Btn variant="ghost" onClick={() => setAdd(null)}>Cancel</Btn><Btn variant="primary" disabled={busy} onClick={() => run(() => capi.createUser(add), `Login created for ${add.name || add.username}.`)}>Create</Btn></>}>
          {err && <Note kind="error" style={{ marginBottom: 10 }}>{err}</Note>}
          <div className="cmp-form">
            <Field label="Username *"><Input value={add.username} onChange={e => setAdd(x => ({ ...x, username: e.target.value.trim() }))} autoComplete="off" /></Field>
            <Field label="Full name"><Input value={add.name} onChange={e => setAdd(x => ({ ...x, name: e.target.value }))} /></Field>
            <Field label="Password *" hint="At least 8 characters."><Input type="password" autoComplete="new-password" value={add.password} onChange={e => setAdd(x => ({ ...x, password: e.target.value }))} /></Field>
            <Field label="Compliance role"><Select value={add.role} onChange={v => setAdd(x => ({ ...x, role: v }))} options={roleOpts} /></Field>
          </div>
          <div style={{ marginTop: 12 }}><CompanyPicker value={add.companies} onChange={v => setAdd(x => ({ ...x, companies: v }))} /></div>
        </Modal>
      )}
    </Card>
  );
}
