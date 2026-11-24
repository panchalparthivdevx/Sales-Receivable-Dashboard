import React, { useEffect, useState } from 'react';
import { t, errMsg } from './api';
import { S, Msg, Field, Tag, dtm, tableWrap, table } from './ui';

const blank = { id: '', name: '', short: '', pan: '', org_id: '', active: true, ledgers: [], tan_field: 'cf_organization_tan_number' };
const slugOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'entity';

export default function SettingsTab({ meta, reloadMeta }) {
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [edit, setEdit] = useState(null);           // entity being edited (copy)
  const [orgs, setOrgs] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [busy, setBusy] = useState('');
  const [check, setCheck] = useState(null);
  const [st, setSt] = useState({ ...meta.settings, aliases: Object.entries(meta.settings.section_aliases || {}).map(([k, v]) => `${k} = ${v}`).join('\n') });
  const [sched, setSched] = useState({ enabled: meta.schedule.enabled, times: meta.schedule.times.join(', ') });
  const [access, setAccess] = useState(meta.access || {});
  const [audit, setAudit] = useState(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [verify, setVerify] = useState(null);
  const real = meta.entities.filter(e => !e.demo);
  const run = async (key, fn, msg) => { setBusy(key); setErr(''); setOk(''); try { const x = await fn(); if (msg) setOk(typeof msg === 'function' ? msg(x) : msg); return x; } catch (e) { setErr(errMsg(e)); return null; } finally { setBusy(''); } };
  useEffect(() => { t.audit(month).then(setAudit).catch(() => {}); }, [month]);

  const saveEntity = async () => {
    const e = { ...edit, id: edit.id || slugOf(edit.short || edit.name), pan: edit.pan.toUpperCase().trim() };
    const list = [...meta.entities.filter(x => x.id !== (edit._orig || e.id)), e].map(({ _orig, ...x }) => x);
    const x = await run('save', () => t.saveEntities(list), 'Entity saved. Next: Statements & Zoho sync → sync a period, then upload its Form 26AS.');
    if (x) { setEdit(null); setAccounts(null); reloadMeta(); }
  };
  const findLedgers = async () => {
    const x = await run('ledgers', () => t.ledgers(edit.org_id));
    if (x) { setAccounts(x); if (!edit.ledgers.length) setEdit(e => ({ ...e, ledgers: x.accounts.filter(a => a.suggested).map(a => ({ account_id: a.account_id, name: a.name, section: a.section, parent: a.parent })) })); }
  };
  const toggle = a => setEdit(e => ({ ...e, ledgers: e.ledgers.some(l => l.account_id === a.account_id) ? e.ledgers.filter(l => l.account_id !== a.account_id) : [...e.ledgers, { account_id: a.account_id, name: a.name, section: a.section, parent: a.parent }] }));
  const saveSettings = () => {
    const aliases = {};
    for (const line of st.aliases.split('\n')) { const m = line.split('='); if (m.length === 2 && m[0].trim() && m[1].trim()) aliases[m[0].trim()] = m[1].trim(); }
    return run('settings', () => t.saveSettings({ rounding_tol_p: Math.round(Number(st.rounding_tol_p)), base_tol_bp: st.base_tol_bp, date_close_days: st.date_close_days, date_gap_days: st.date_gap_days, near_pct: st.near_pct, near_days: st.near_days, timing_days: st.timing_days, max_subset: st.max_subset, section_aliases: aliases }), 'Settings saved.').then(x => x && reloadMeta());
  };
  const num = (k, label, hint) => <Field label={label} hint={hint}><input type="number" style={{ ...S.input, width: 110 }} value={st[k]} onChange={e => setSt({ ...st, [k]: e.target.value })} /></Field>;

  return (
    <div>
      <Msg error={err} ok={ok} onClose={() => { setErr(''); setOk(''); }} />
      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Entities</span>{meta.rights.config && <button style={S.primary} onClick={() => { setEdit({ ...blank }); setAccounts(null); }}>Add an entity</button>}</div>
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr>{['Entity', 'PAN', 'Zoho organisation', 'TDS Receivable ledgers', 'Active', ''].map(c => <th key={c} style={S.th}>{c}</th>)}</tr></thead>
            <tbody>
              {meta.entities.length === 0 && <tr><td colSpan={6} style={S.center}>No entity yet.</td></tr>}
              {meta.entities.map(e => (
                <tr key={e.id}>
                  <td style={S.td}><b>{e.name}</b> {e.demo && <Tag tone="violet">demo</Tag>}<div style={S.small}>{e.short} · id {e.id}</div></td>
                  <td style={S.td}>{e.pan}</td><td style={S.td}>{e.org_id || '—'}</td>
                  <td style={{ ...S.td, fontSize: '0.72rem' }}>{e.ledgers.map(l => <div key={l.account_id}>{l.name} <span style={S.small}>{l.section}</span></div>)}</td>
                  <td style={S.td}>{e.active ? 'yes' : 'no'}</td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{meta.rights.config && !e.demo && <>
                    <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => { setEdit({ ...e, _orig: e.id }); setAccounts(null); }}>Edit</button>{' '}
                    <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} disabled={busy === `chk${e.id}`} onClick={async () => { const x = await run(`chk${e.id}`, () => t.check(e.id)); if (x) setCheck({ e, x }); }}>Check Zoho access</button></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {check && <div style={{ ...S.cardBody, borderTop: '1px solid #DFE7E3' }}><b style={{ fontSize: '0.8rem' }}>Zoho access for {check.e.name} ({check.x.credentials}, read-only):</b>{check.x.results.map(x => <div key={x.label} style={{ fontSize: '0.76rem', color: x.ok ? '#15803D' : '#B91C1C' }}>{x.ok ? '✔' : '✖'} {x.label}{x.message ? ` — ${x.message}` : ''}</div>)}</div>}
      </div>

      {edit && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>{edit._orig ? `Edit ${edit.name}` : 'New entity'}</span><button style={S.ghost} onClick={() => setEdit(null)}>Cancel</button></div>
          <div style={{ ...S.cardBody, display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Field label="Zoho Books organisation" hint={edit._orig ? 'cannot be changed for an existing entity' : 'the organisation whose TDS Receivable ledgers are reconciled'}>
                {orgs && !edit._orig ? (
                  <select style={S.select} value={edit.org_id} onChange={e => { const o = orgs.find(x => x.id === e.target.value); setEdit({ ...edit, org_id: e.target.value, name: edit.name || (o ? o.name : ''), ledgers: [] }); setAccounts(null); }}>
                    <option value="">Choose…</option>{orgs.map(o => <option key={o.id} value={o.id}>{o.name} ({o.id})</option>)}
                  </select>
                ) : <input style={{ ...S.input, width: 160 }} disabled={!!edit._orig} value={edit.org_id} onChange={e => setEdit({ ...edit, org_id: e.target.value.trim() })} placeholder="60027116474" />}
              </Field>
              {!edit._orig && !orgs && <button style={S.ghost} disabled={busy === 'orgs'} onClick={async () => { const x = await run('orgs', () => t.zohoOrgs()); if (x) setOrgs(x.organizations); }}>{busy === 'orgs' ? 'Loading…' : 'Load my Zoho organisations'}</button>}
              <Field label="Legal name"><input style={{ ...S.input, width: 300 }} value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Short name"><input style={{ ...S.input, width: 110 }} value={edit.short} onChange={e => setEdit({ ...edit, short: e.target.value })} /></Field>
              <Field label="PAN" hint={edit._orig ? 'cannot be changed' : 'as printed on its Form 26AS'}><input style={{ ...S.input, width: 120, textTransform: 'uppercase' }} disabled={!!edit._orig} value={edit.pan} onChange={e => setEdit({ ...edit, pan: e.target.value })} /></Field>
              <label style={{ fontSize: '0.78rem', display: 'flex', gap: 5, alignItems: 'center', paddingBottom: 6 }}><input type="checkbox" checked={edit.active !== false} onChange={e => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
            </div>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <b style={{ fontSize: '0.82rem' }}>TDS Receivable ledgers ({edit.ledgers.length} chosen)</b>
                <button style={S.btn} disabled={!edit.org_id || busy === 'ledgers'} onClick={findLedgers}>{busy === 'ledgers' ? 'Reading the chart of accounts…' : 'Find ledgers in Zoho'}</button>
              </div>
              <div style={{ ...S.small, margin: '4px 0' }}>Tick every ledger TDS receivable is posted to (e.g. 194C, 194I, 194J and the year-wise "TDS Receivable U/s. … F.Y. …" ledgers). The section is read from the ledger name. Transfers between ticked ledgers net to zero.</div>
              {accounts && (
                <div style={{ ...tableWrap, maxHeight: 280, border: '1px solid #DFE7E3', borderRadius: 8 }}>
                  <table style={table}><tbody>{accounts.accounts.map(a => (
                    <tr key={a.account_id} style={{ opacity: a.active ? 1 : 0.55 }}>
                      <td style={S.td}><input type="checkbox" checked={edit.ledgers.some(l => l.account_id === a.account_id)} onChange={() => toggle(a)} /></td>
                      <td style={S.td}>{a.name}<div style={S.small}>{a.parent || ''}{a.active ? '' : ' · inactive'}</div></td><td style={S.td}>{a.section || '—'}</td><td style={{ ...S.td, ...S.small }}>{a.fy_label ? `FY ${a.fy_label}` : ''}</td>
                    </tr>))}</tbody></table>
                </div>
              )}
              {!accounts && edit.ledgers.length > 0 && <div>{edit.ledgers.map(l => <Tag key={l.account_id}>{l.name} · {l.section || '?'}</Tag>)}</div>}
            </div>
            <Field label="Zoho custom field holding the client's TAN on invoices (optional)" hint="DevX uses cf_organization_tan_number — clients are matched on this TAN"><input style={{ ...S.input, width: 280 }} value={edit.tan_field || ''} onChange={e => setEdit({ ...edit, tan_field: e.target.value })} /></Field>
            <div><button style={S.primary} disabled={busy === 'save'} onClick={saveEntity}>Save entity</button></div>
          </div>
        </div>
      )}

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Matching settings</span><span style={S.small}>apply to every entity</span></div>
        <div style={{ ...S.cardBody, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {num('rounding_tol_p', 'Rounding tolerance (paise)', '200 = ₹2.00 — "Matched Rounding Diff." up to and including this')}
          {num('base_tol_bp', 'Base agrees within (basis points)', '50 = 0.5 %')}
          {num('date_close_days', 'Same-date window (days)')}
          {num('date_gap_days', 'Decisive date gap (days)')}
          {num('near_pct', 'Leftover pairing: amount within %')}
          {num('near_days', 'Leftover pairing: dated within days')}
          {num('timing_days', 'Timing evidence searched within days')}
          {num('max_subset', 'Largest group for one credit')}
          <Field label="Section aliases (26AS code = family, one per line)" hint="for the Income-tax Act, 2025 section 393 table codes once a real statement shows them"><textarea rows={3} style={{ ...S.input, width: 280, fontFamily: 'monospace' }} value={st.aliases} onChange={e => setSt({ ...st, aliases: e.target.value })} /></Field>
        </div>
        {meta.rights.config && <div style={{ padding: '0 1.1rem 1rem' }}><button style={S.primary} disabled={busy === 'settings'} onClick={saveSettings}>Save settings</button></div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1rem' }}>
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Daily Zoho check (office PC)</span></div>
          <div style={S.cardBody}>
            <label style={{ fontSize: '0.78rem', display: 'flex', gap: 6 }}><input type="checkbox" checked={sched.enabled} onChange={e => setSched({ ...sched, enabled: e.target.checked })} /> Re-read the current financial year every day (entities whose first sync is done)</label>
            <Field label="Times (India, HH:MM)" style={{ marginTop: 8 }}><input style={S.input} value={sched.times} onChange={e => setSched({ ...sched, times: e.target.value })} /></Field>
            {!meta.integrations.scheduler && <div style={S.small}>The online copy has no scheduler: use "Sync the selected period".</div>}
            {meta.rights.config && <button style={{ ...S.btn, marginTop: 8 }} onClick={() => run('sched', () => t.saveSchedule({ enabled: sched.enabled, times: sched.times.split(/[\s,]+/).filter(Boolean) }), 'Schedule saved.').then(x => x && reloadMeta())}>Save</button>}
          </div>
        </div>
        {meta.rights.admin && (
          <div style={S.card}>
            <div style={S.cardHead}><span style={S.cardTitle}>Access by entity</span><span style={S.small}>rights are ticked in User Settings</span></div>
            <div style={S.cardBody}>
              {(meta.admin_users || []).filter(u => u.role !== 'admin').map(u => {
                const a = access[u.id];
                return (
                  <div key={u.id} style={{ fontSize: '0.78rem', padding: '0.25rem 0', borderBottom: '1px solid #F0F2F1' }}>
                    <b>{u.name}</b>: <label><input type="checkbox" checked={!a} onChange={e => setAccess({ ...access, [u.id]: e.target.checked ? undefined : { entities: [] } })} /> all entities</label>
                    {a && meta.entities.map(en => <label key={en.id} style={{ marginLeft: 10 }}><input type="checkbox" checked={a.entities.includes(en.id)} onChange={e => setAccess({ ...access, [u.id]: { entities: e.target.checked ? [...a.entities, en.id] : a.entities.filter(x => x !== en.id) } })} /> {en.short}</label>)}
                  </div>
                );
              })}
              <button style={{ ...S.btn, marginTop: 8 }} onClick={() => run('access', () => t.saveAccess(Object.fromEntries(Object.entries(access).filter(([, v]) => v))), 'Access saved.').then(x => x && reloadMeta())}>Save access</button>
            </div>
          </div>
        )}
        {meta.rights.admin && (
          <div style={S.card}>
            <div style={S.cardHead}><span style={S.cardTitle}>Demo data</span></div>
            <div style={S.cardBody}>
              <p style={{ ...S.muted, marginTop: 0, lineHeight: 1.5 }}>Two synthetic entities (PANs ZZZ…) that show every case: exact match, ₹2.00 rounding, ₹2.01 mismatch, one credit for three invoices, two equal candidates, March booking / April credit, Zoho only, 26AS only, deducted &gt; deposited, an unmapped client, an unallocated journal, a transfer, a partial payment, a revised statement and the same client in both entities. Real entities are not touched.</p>
              <button style={S.btn} disabled={!!busy} onClick={() => run('demo', () => t.demoLoad(), x => `Demo loaded: ${x.imported.length} statements imported.`).then(x => x && reloadMeta())}>Load demo data</button>{' '}
              {meta.entities.some(e => e.demo) && <button style={S.danger} disabled={!!busy} onClick={() => window.confirm('Remove the demo entities and everything recorded on them?') && run('demo', () => t.demoRemove(), 'Demo data removed.').then(x => x && reloadMeta())}>Remove demo data</button>}
              {real.length === 0 && <div style={{ ...S.small, marginTop: 6 }}>No real entity is set up yet.</div>}
            </div>
          </div>
        )}
      </div>

      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.cardTitle}>Audit trail</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="month" style={S.input} value={month} onChange={e => setMonth(e.target.value)} />
            {meta.rights.config && <button style={S.ghost} onClick={() => t.auditVerify().then(setVerify).catch(e => setErr(errMsg(e)))}>Verify the chain</button>}
            {verify && <span style={{ fontSize: '0.76rem', color: verify.ok ? '#15803D' : '#B91C1C' }}>{verify.ok ? `intact (${verify.checked} entries)` : `broken at #${verify.at_seq}: ${verify.reason}`}</span>}
          </span>
        </div>
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr>{['When', 'Who', 'What', 'Entity', 'Detail'].map(c => <th key={c} style={S.th}>{c}</th>)}</tr></thead>
            <tbody>{(audit ? audit.entries : []).map(e => <tr key={e.seq}><td style={S.td}>{dtm(e.at)}</td><td style={S.td}>{e.by}</td><td style={S.td}>{e.action}</td><td style={S.td}>{e.entity}</td><td style={{ ...S.td, fontSize: '0.72rem', maxWidth: 520 }}>{String(e.detail)}</td></tr>)}
              {audit && audit.entries.length === 0 && <tr><td colSpan={5} style={S.center}>Nothing recorded this month.</td></tr>}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
