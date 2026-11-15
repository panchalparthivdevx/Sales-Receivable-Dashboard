import React, { useEffect, useState } from 'react';
import { api, errMsg } from './api';
import { C, S, Section, Note, Btn, Table, Tag, Field, Input, Select, Multi, Empty, dtm } from './ui';

// Settings (administrators): module settings, who may see which entities (and, for auditors, which periods), the audit trail
// with its integrity check, and the demo reset. Rights themselves are ticked in User Settings → Compliance Dashboard Vr.2.0.

export default function SettingsTab({ meta, org, users, onChanged }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [audit, setAudit] = useState(null);
  const [chain, setChain] = useState(null);
  const [acc, setAcc] = useState({ user_id: '', entities: [], period_from: '', period_to: '' });
  const admin = meta.actor.rights.admin;
  useEffect(() => {
    if (admin) api.settings().then(setS).catch(e => setErr(errMsg(e)));
    api.audit({ limit: 300 }).then(r => setAudit(r.entries)).catch(e => setErr(errMsg(e)));
  }, [admin]);
  const pickUser = id => { const a = s?.access?.[id]; setAcc({ user_id: id, entities: a?.entities || [], period_from: a?.period_from || '', period_to: a?.period_to || '' }); };
  const saveAccess = () => api.saveAccess(acc).then(r => { setS({ ...s, access: r.access }); setMsg('Access saved'); onChanged(); }).catch(e => setErr(errMsg(e)));
  const ents = new Map(org.entities.map(e => [e.id, e.short_code]));
  return (
    <div>
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      {admin && s && <>
        <Section title="Module settings">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <Field label="Due soon (days)"><Input type="number" value={s.soon_days} onChange={e => setS({ ...s, soon_days: e.target.value })} /></Field>
            <Field label="Keep documents (years after FY end)" hint="Default 8 — verify the period each law requires"><Input type="number" value={s.retention_years} onChange={e => setS({ ...s, retention_years: e.target.value })} /></Field>
            <Field label="Upload limit (MB)" hint={meta.storage.vercel ? 'Online the limit is 4 MB per file' : ''}><Input type="number" value={s.max_upload_mb} onChange={e => setS({ ...s, max_upload_mb: e.target.value })} /></Field>
            <Field label="Download link lifetime (seconds)"><Input type="number" value={s.link_ttl_seconds} onChange={e => setS({ ...s, link_ttl_seconds: e.target.value })} /></Field>
          </div>
          <div style={{ marginTop: 10 }}><Btn kind="primary" onClick={() => api.saveSettings({ soon_days: s.soon_days, retention_years: s.retention_years, max_upload_mb: s.max_upload_mb, link_ttl_seconds: s.link_ttl_seconds }).then(x => { setS({ ...s, ...x }); setMsg('Settings saved'); onChanged(); }).catch(e => setErr(errMsg(e)))}>Save settings</Btn></div>
          <div style={{ ...S.small, marginTop: 10, lineHeight: 1.6 }}>Storage: {meta.storage.store} · live encryption key {meta.storage.live_key ? 'set' : <b style={{ color: C.red }}>NOT SET (C2_FILE_KEY) — live uploads are refused</b>} · malware scanner: {meta.storage.scanner}</div>
        </Section>
        <Section title="Access by entity" sub="Without a scope a user sees all entities, except an auditor, who sees nothing until given a scope (and optionally a period). Rights are ticked in User Settings.">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ width: 220 }}><span style={S.label}>User</span><Select value={acc.user_id} onChange={pickUser} options={users.filter(u => !u.admin && !u.demo).map(u => [u.id, `${u.name}${u.auditor ? ' (auditor)' : ''}`])} placeholder="Choose a user" /></div>
            {acc.user_id && <>
              <Multi label="Entities" options={org.entities.map(e => [e.id, `${e.short_code} — ${e.legal_name}`])} value={acc.entities} onChange={v => setAcc({ ...acc, entities: v })} width={240} />
              <div><span style={S.label}>Periods from (auditors)</span><Input type="date" value={acc.period_from} onChange={e => setAcc({ ...acc, period_from: e.target.value })} /></div>
              <div><span style={S.label}>to</span><Input type="date" value={acc.period_to} onChange={e => setAcc({ ...acc, period_to: e.target.value })} /></div>
              <Btn kind="primary" onClick={saveAccess}>Save access</Btn>
            </>}
          </div>
          <Table rows={users.filter(u => !u.demo)} rowKey={u => u.id} empty="No users have this module"
            cols={[{ label: 'User', render: u => <><b>{u.name}</b>{u.admin && <Tag tone="lav">admin</Tag>}{u.auditor && <Tag tone="amber">auditor (read-only)</Tag>}</> }, { label: 'Role', render: u => (u.roles || []).join(' + ') || (u.auditor ? 'Auditor' : '—') }, { label: 'Rights', render: u => u.rights.join(', ') || '—', hideSm: true },
              { label: 'Entities', render: u => (u.admin ? 'all' : s.access?.[u.id]?.entities?.length ? s.access[u.id].entities.map(id => ents.get(id) || id).join(', ') : u.auditor ? <b style={{ color: C.red }}>none (no scope)</b> : 'all') },
              { label: 'Period', render: u => (s.access?.[u.id]?.period_from || s.access?.[u.id]?.period_to ? `${s.access[u.id].period_from || '…'} → ${s.access[u.id].period_to || '…'}` : '—') }]} />
        </Section>
      </>}
      <Section title="Audit trail" sub="Append-only; each entry carries the hash of the previous one, so a changed or removed entry is detected" right={<Btn kind="onNavy" small onClick={() => api.verifyAudit().then(setChain).catch(e => setErr(errMsg(e)))}>Check integrity</Btn>}>
        {chain && <Note tone={chain.ok ? 'ok' : 'error'}>{chain.ok ? `Intact — ${chain.checked} entries checked.` : `BROKEN at entry #${chain.at_seq}: ${chain.reason}.`}</Note>}
        {!audit ? <Empty>Loading…</Empty> : <div style={{ maxHeight: 520, overflow: 'auto' }}>{audit.map(e => (
          <div key={`${e.seq}`} style={{ fontSize: '0.75rem', padding: '4px 0', borderBottom: `1px solid ${C.line}` }}>
            <span style={S.small}>#{e.seq} · {dtm(e.at)}</span> · <b>{e.actor}</b> · {e.action.replace(/_/g, ' ')} · {e.summary}{e.reason ? <i> — {e.reason}</i> : ''}
          </div>))}</div>}
      </Section>
      {admin && !meta.live && <Section title="Demo data" sub="Rebuild the illustrative demo space (live data is not touched)">
        <Btn kind="danger" onClick={() => { if (window.confirm('Rebuild the demo space? All demo changes are replaced by fresh illustrative data.')) api.demoReset().then(() => { setMsg('Demo rebuilt'); onChanged(); }).catch(e => setErr(errMsg(e))); }}>Reset demo</Btn>
      </Section>}
    </div>
  );
}
