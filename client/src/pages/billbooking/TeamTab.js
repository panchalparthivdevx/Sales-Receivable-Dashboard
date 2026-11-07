import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Link2, Unlink, Mail, Pencil, Trash2 } from 'lucide-react';
import { bb, errMsg } from './bbApi';
import { S, Tag, Field, Msg, dtm } from './ui';

// ─── Team members, their mailboxes and responsibilities ───────────────────────
// Mailboxes connect through the provider's own sign-in (OAuth). No mailbox password is typed here,
// and tokens are kept encrypted on the server — never shown on this page.

const CONN = {
  connected: ['Connected', 'green'], not_connected: ['Not connected', 'grey'], error: ['Needs reconnecting', 'red'], not_applicable: ['No mailbox', 'grey'],
};
const ROLES = { preparer: 'Prepares / resolves exceptions', reviewer: 'Reviews drafts', approver: 'Approves in Zoho' };
const blank = { name: '', email: '', provider: 'microsoft', categories: [], companies: [], review_role: 'preparer', review_scope: '', dashboard_user: '', active: true };

export default function TeamTab({ meta, reloadMeta }) {
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState(null);
  const canConfig = meta.rights.config;
  const prov = meta.integrations.providers;

  const loadLog = useCallback(() => bb.mailLog().then(setLog).catch(() => {}), []);
  useEffect(() => { loadLog(); }, [loadLog]);
  // Back from the provider's sign-in page: show the new status
  useEffect(() => {
    const f = () => { if (document.visibilityState === 'visible') reloadMeta(); };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, [reloadMeta]);

  async function run(label, fn, msg) {
    setBusy(label); setError(''); setOk('');
    try { const r = await fn(); if (msg) setOk(typeof msg === 'function' ? msg(r) : msg); await reloadMeta(); await loadLog(); return r; } catch (e) { setError(errMsg(e)); return null; } finally { setBusy(''); }
  }

  async function save() {
    const body = { ...edit };
    const r = await run('save', () => (edit.id ? bb.saveMember(edit.id, body) : bb.addMember(body)), edit.id ? 'Saved' : 'Team member added');
    if (r) setEdit(null);
  }

  async function connect(m) {
    const r = await run(`c${m.id}`, () => bb.connect(m.id));
    if (r?.url) window.open(r.url, '_blank', 'noopener');
    else if (r?.connected) setOk(`${m.name}'s mailbox is connected`);
  }

  const mine = m => m.dashboard_user && m.dashboard_user === meta.me.username;
  return (
    <div>
      <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />
      {!Object.values(prov).some(p => p.configured) && (
        <div style={S.notice}>No mailbox provider is set up on the server yet, so mailboxes cannot be connected. The company's Microsoft 365 app registration (or Google client) is needed — see <b>Settings &amp; Integrations</b>.</div>
      )}
      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.cardTitle}>Team &amp; mailboxes</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {meta.rights.review && <button style={S.btn} disabled={!!busy} onClick={() => run('poll', () => bb.poll(), x => `Checked ${x.results.length} mailbox(es): ${x.results.reduce((s, y) => s + y.ingested, 0)} new bill(s)`)}><Mail size={13} /> {busy === 'poll' ? 'Checking…' : 'Check all now'}</button>}
            {canConfig && <button style={S.primary} onClick={() => setEdit({ ...blank, companies: meta.companies.length === 1 ? [meta.companies[0].id] : [] })}><Plus size={13} /> Add member</button>}
          </div>
        </div>
        <div style={{ overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
            <thead><tr>{['Member', 'Mailbox', 'Connection', 'Bill categories', 'Company / Zoho org', 'Review responsibility', 'Status', ''].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {!meta.team.length && <tr><td colSpan={8} style={S.center}>No team members yet{canConfig ? ' — add the finance team members and their mailboxes.' : '.'}</td></tr>}
              {meta.team.map(m => {
                const [label, tone] = CONN[m.connection?.status] || CONN.not_connected;
                const cursor = log?.cursors?.[m.id];
                return (
                  <tr key={m.id} style={{ opacity: m.active ? 1 : 0.55 }}>
                    <td style={S.td}><div style={{ fontWeight: 600 }}>{m.name}</div>{m.dashboard_user && <div style={S.small}>login: {m.dashboard_user}</div>}</td>
                    <td style={S.td}><div>{m.email}</div><div style={S.small}>{prov[m.provider]?.label || 'No mailbox'}</div></td>
                    <td style={S.td}>
                      <Tag tone={tone}>{label}</Tag>
                      {m.connection?.account && <div style={S.small}>{m.connection.account}</div>}
                      {m.connection?.warning && <div style={{ ...S.small, color: '#B45309' }}>{m.connection.warning}</div>}
                      {(m.connection?.last_error) && <div style={{ ...S.small, color: '#B91C1C' }}>{m.connection.last_error}</div>}
                      {cursor?.last_poll && <div style={S.small}>Checked {dtm(cursor.last_poll)}</div>}
                    </td>
                    <td style={S.td}>{m.categories.map(c => meta.categories.find(x => x.id === c)?.name || c).join(', ') || '—'}</td>
                    <td style={S.td}>{m.companies.map(c => { const co = meta.companies.find(x => x.id === c); return co ? `${co.name} (${co.org_id})` : c; }).join(', ')}</td>
                    <td style={S.td}>{ROLES[m.review_role]}{m.review_scope && <div style={S.small}>{m.review_scope}</div>}</td>
                    <td style={S.td}>{m.active ? <Tag tone="green">Active</Tag> : <Tag>Inactive</Tag>}</td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                      {m.provider !== 'none' && (canConfig || mine(m)) && (m.connection?.status === 'connected'
                        ? <button style={S.ghost} disabled={!!busy} onClick={() => { if (window.confirm(`Disconnect ${m.email}? Bills already collected stay.`)) run(`d${m.id}`, () => bb.disconnect(m.id), 'Disconnected'); }}><Unlink size={12} /> Disconnect</button>
                        : <button style={S.btn} disabled={!!busy || !prov[m.provider]?.configured} title={prov[m.provider]?.configured ? '' : 'Provider not set up on the server'} onClick={() => connect(m)}><Link2 size={12} /> {m.connection?.status === 'error' ? 'Reconnect' : 'Connect'}</button>)}
                      {m.connection?.status === 'connected' && meta.rights.review && <button style={{ ...S.ghost, marginLeft: 4 }} disabled={!!busy} onClick={() => run(`p${m.id}`, () => bb.poll(m.id), x => `${x.results[0]?.ingested || 0} new bill(s)${x.results[0]?.error ? ` — ${x.results[0].error}` : ''}`)}><Mail size={12} /></button>}
                      {canConfig && <button style={{ ...S.ghost, marginLeft: 4 }} onClick={() => setEdit({ ...m })}><Pencil size={12} /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {edit && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>{edit.id ? `Edit ${edit.name}` : 'Add team member'}</span></div>
          <div style={{ ...S.cardBody, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <Field label="Name"><input style={{ ...S.input, width: '100%' }} value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Email address (mailbox)"><input style={{ ...S.input, width: '100%' }} value={edit.email} onChange={e => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Email provider">
              <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} value={edit.provider} onChange={e => setEdit({ ...edit, provider: e.target.value })}>
                {Object.entries(prov).map(([k, p]) => <option key={k} value={k}>{p.label}{p.configured ? '' : ' — not set up yet'}</option>)}
                <option value="none">No mailbox (ERP uploads / review only)</option>
              </select>
            </Field>
            <Field label="Company / Zoho Books organisation">
              {meta.companies.map(c => (
                <label key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={edit.companies.includes(c.id)} onChange={e => setEdit({ ...edit, companies: e.target.checked ? [...edit.companies, c.id] : edit.companies.filter(x => x !== c.id) })} />
                  {c.name} <span style={S.small}>({c.org_id})</span>
                </label>
              ))}
            </Field>
            <Field label="Assigned bill categories">
              <div style={{ maxHeight: 150, overflow: 'auto', border: '1px solid #EEF2F0', borderRadius: 6, padding: 6 }}>
                {meta.categories.filter(c => c.active !== false).map(c => (
                  <label key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.78rem', cursor: 'pointer' }}>
                    <input type="checkbox" checked={edit.categories.includes(c.id)} onChange={e => setEdit({ ...edit, categories: e.target.checked ? [...edit.categories, c.id] : edit.categories.filter(x => x !== c.id) })} /> {c.name}
                  </label>
                ))}
              </div>
              <div style={S.small}>Context for categorising — the bill's own contents decide.</div>
            </Field>
            <div>
              <Field label="Review responsibility">
                <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} value={edit.review_role} onChange={e => setEdit({ ...edit, review_role: e.target.value })}>
                  {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Responsibility note (optional)" style={{ marginTop: 8 }}><input style={{ ...S.input, width: '100%' }} value={edit.review_scope} onChange={e => setEdit({ ...edit, review_scope: e.target.value })} placeholder="e.g. reviews all rent & CAM drafts" /></Field>
            </div>
            <Field label="Dashboard login (optional)">
              <input style={{ ...S.input, width: '100%' }} value={edit.dashboard_user} onChange={e => setEdit({ ...edit, dashboard_user: e.target.value })} placeholder="their username here" />
              <div style={S.small}>Lets the member connect their own mailbox.</div>
            </Field>
            <Field label="Status">
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={edit.active} onChange={e => setEdit({ ...edit, active: e.target.checked })} /> Active (inactive members' mailboxes are not checked)
              </label>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, padding: '0 1.1rem 1rem' }}>
            <button style={S.primary} disabled={busy === 'save'} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            <button style={S.ghost} onClick={() => setEdit(null)}>Cancel</button>
            {edit.id && <button style={{ ...S.danger, marginLeft: 'auto' }} onClick={() => { if (window.confirm(`Remove ${edit.name}? (Members with bills can only be made inactive.)`)) run('rm', () => bb.removeMember(edit.id), 'Removed').then(r => r && setEdit(null)); }}><Trash2 size={12} /> Remove</button>}
          </div>
        </div>
      )}

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Mailbox checks</span><span style={S.small}>Mail is read only — nothing is moved, marked or sent</span></div>
        <div style={{ ...S.cardBody, maxHeight: 220, overflow: 'auto' }}>
          {!log?.log?.length && <div style={S.muted}>No mailbox checks yet.</div>}
          {(log?.log || []).slice(0, 40).map((l, i) => (
            <div key={i} style={{ fontSize: '0.76rem', padding: '3px 0', borderBottom: '1px solid #F2F2F2', color: l.error ? '#B91C1C' : '#18191B' }}>
              {dtm(l.at)} · <b>{l.member}</b> · {l.messages} email(s), {l.attachments} attachment(s) → {l.ingested} new, {l.existing} already collected, {l.skipped} skipped{l.error ? ` · ${l.error}` : ''}
            </div>
          ))}
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Skipped attachments</span><span style={S.small}>Attachments that did not look like bills — read any of them on request</span></div>
        <div style={{ ...S.cardBody, maxHeight: 300, overflow: 'auto' }}>
          {!log?.skipped?.length && <div style={S.muted}>Nothing skipped.</div>}
          {(log?.skipped || []).map(s => (
            <div key={s.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.76rem', padding: '4px 0', borderBottom: '1px solid #F2F2F2' }}>
              <div style={{ flex: 1 }}>
                <b>{s.name}</b> <span style={S.small}>· {s.mailbox} · {dtm(s.received_at)}</span>
                <div style={S.small}>{s.from} — {s.subject} · {s.reason}</div>
              </div>
              {meta.rights.review && <button style={S.btn} disabled={!!busy} onClick={() => run(`s${s.key}`, () => bb.processSkipped(s.key), r => `Collected as ${r.id}`)}>Read as bill</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
