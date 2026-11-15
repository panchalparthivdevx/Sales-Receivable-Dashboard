import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errMsg } from './api';
import { C, S, Section, Note, Btn, Kpi, Tag, Table, Select, Input, Empty, dtm } from './ui';

// Document folders in OneDrive (V4): Finance & Compliance → company → FY → category → registration → period → document type.
// Live: the connected Microsoft account's OneDrive. Demo: a SIMULATED OneDrive — nothing is sent to Microsoft.

const STATUS_TONE = { created: 'green', reused: 'green', linked: 'green', mapped: 'green', planned: 'grey', failed: 'red', missing: 'amber' };
const KIND = { created: 'Created', reused: 'Reused', file_uploaded: 'File copied', file_reused: 'File already there', renamed: 'Renamed', failed: 'Failed', found: 'Found in OneDrive', linked: 'Linked', ignored: 'Ignored', missing: 'Missing' };

function fyChoices(today) {
  const y = +today.slice(0, 4), m = +today.slice(5, 7);
  const s = m >= 4 ? y : y - 1;
  return [s - 1, s, s + 1].map(x => `${x}-${String((x + 1) % 100).padStart(2, '0')}`);
}

function Tree({ nodes }) {
  const kids = useMemo(() => { const m = new Map(); for (const n of nodes) (m.get(n.parent) || m.set(n.parent, []).get(n.parent)).push(n); return m; }, [nodes]);
  const [open, setOpen] = useState(() => new Set(nodes.filter(n => ['root', 'company', 'fy'].includes(n.kind)).map(n => n.key)));
  const toggle = k => setOpen(s => { const x = new Set(s); if (x.has(k)) x.delete(k); else x.add(k); return x; });
  const row = (n, depth) => {
    const ch = kids.get(n.key) || [];
    const isOpen = open.has(n.key);
    return (
      <div key={n.key}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', paddingLeft: depth * 18, fontSize: '0.8rem', borderBottom: `1px solid ${C.line}` }}>
          {ch.length ? <button type="button" onClick={() => toggle(n.key)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${n.name}`} style={{ border: 'none', background: 'none', cursor: 'pointer', width: 18, color: C.muted }}>{isOpen ? '▾' : '▸'}</button> : <span style={{ width: 18 }} />}
          <span aria-hidden="true">📁</span>
          <span style={{ fontWeight: ['root', 'company', 'fy', 'category'].includes(n.kind) ? 700 : 400 }}>{n.name}</span>
          {ch.length > 0 && <span style={S.small}>({ch.length})</span>}
          <Tag tone={STATUS_TONE[n.status] || 'grey'}>{n.status === 'planned' ? 'not created yet' : n.status}</Tag>
          {n.error && <span style={{ color: C.red, fontSize: '0.72rem' }} title={n.error}>⚠ {n.error.slice(0, 80)}</span>}
          {n.web_url && /^https:\/\//.test(n.web_url) && !n.web_url.includes('.invalid/') && <a href={n.web_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.72rem', color: C.lav }}>Open</a>}
        </div>
        {isOpen && ch.map(c => row(c, depth + 1))}
      </div>
    );
  };
  const roots = nodes.filter(n => !n.parent || !nodes.some(p => p.key === n.parent));
  return <div style={{ maxHeight: 560, overflow: 'auto' }}>{roots.map(n => row(n, 0))}</div>;
}

export default function FoldersTab({ meta, org, stamp, onChanged }) {
  const [entityId, setEntityId] = useState('');
  const [fy, setFy] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [link, setLink] = useState('');
  const [pv, setPv] = useState(null);
  const [newCo, setNewCo] = useState('');
  const [coPv, setCoPv] = useState(null);
  const [linkTo, setLinkTo] = useState({});
  const [st, setSt] = useState(null);
  const load = useCallback(() => api.folders({ entity_id: entityId, fy }).then(x => { setD(x); setSt(s => s || x.settings); setErr(''); }).catch(e => setErr(errMsg(e))), [entityId, fy]);
  useEffect(() => { load(); }, [load, stamp]);
  const r = meta.actor.rights;
  const live = !d?.simulated;
  const run = async (label, fn, done) => {
    setBusy(label); setErr(''); setMsg('');
    try { const res = await fn(); if (done) setMsg(done(res)); await load(); onChanged(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(''); }
  };
  const summary = res => (res.busy ? res.message : `${res.simulated ? 'SIMULATED — ' : ''}${res.created} created, ${res.reused} reused, ${res.known} already there${res.renamed ? `, ${res.renamed} renamed` : ''}${res.failed ? `, ${res.failed} failed (retried later)` : ''}${res.blocked ? `, ${res.blocked} waiting` : ''}${res.queued ? `, ${res.queued} left for the next run` : ''}${res.scan?.linked?.length ? `; ${res.scan.linked.length} company folder(s) found in OneDrive and linked` : ''}${res.scan?.found?.length ? `; ${res.scan.found.length} folder(s) found that need a decision` : ''}${res.stopped === 'revoked' ? ' — STOPPED: the Microsoft sign-in is no longer valid, connect again' : ''}`);
  if (!d) return err ? <Note tone="error">{err}</Note> : <Empty>Loading…</Empty>;
  const conn = d.connection;
  const connected = conn.status === 'connected' || conn.status === 'simulated';
  const fys = fyChoices(meta.today);
  return (
    <div>
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      {!live && <Note tone="demo"><b>SIMULATED OneDrive</b> — the demo creates folders in a pretend OneDrive inside the dashboard so you can see the result. Nothing is sent to Microsoft and nothing appears in your real OneDrive.</Note>}
      <Note tone="info">Structure: <b>Finance & Compliance → company legal name → FY → 01_Financials … 09_Notices_and_Correspondence → registration (State_GSTIN, TAN, PF / ESIC code, PT state + registration) → period → document type</b>. Folders are created once and reused; nothing is ever deleted, moved or overwritten; nothing is written outside the chosen folder.</Note>

      {live && (
        <Section title="OneDrive connection" sub="A one-time Microsoft sign-in by an administrator of this module — no password is stored, only an encrypted sign-in token">
          {!conn.app.configured ? (
            <Note tone="warn">
              <b>Waiting for your Microsoft 365 administrator.</b> They register one app for the dashboard in Microsoft Entra ID with the delegated permissions <b>offline_access, Files.ReadWrite, User.Read</b>, add the redirect address <code>{window.location.origin}/api/compliance2/onedrive/callback</code>, and put its three values on the server (not in a chat): <b>{conn.app.missing.join(', ')}</b>. Then restart the server and click Connect here.
            </Note>
          ) : (
            <div style={{ ...S.row, gap: 14 }}>
              <div style={{ fontSize: '0.85rem' }}>Status: <Tag tone={conn.status === 'connected' ? 'green' : conn.status === 'revoked' ? 'red' : 'amber'}>{conn.status.replace('_', ' ')}</Tag>
                {conn.account && <> as <b>{conn.account.upn || conn.account.name}</b> (connected by {conn.connected_by}, {dtm(conn.connected_at)})</>}
                {conn.status === 'revoked' && <div style={{ color: C.red, fontSize: '0.78rem' }}>The sign-in stopped working ({conn.last_error}). Connect again.</div>}
              </div>
              {r.admin && conn.status !== 'connected' && <Btn kind="primary" disabled={!!busy} onClick={() => run('connect', async () => { const x = await api.connectUrl(); window.location.href = x.url; })}>Connect OneDrive</Btn>}
              {r.admin && conn.status === 'connected' && <Btn kind="ghost" onClick={() => { if (window.confirm('Disconnect OneDrive? The folders and the mapping stay; nothing new is created until you connect again.')) run('disconnect', () => api.disconnectOneDrive(), () => 'Disconnected'); }}>Disconnect</Btn>}
            </div>
          )}
          {connected && (
            <div style={{ marginTop: 12 }}>
              <div style={S.label}>Folder to use</div>
              {d.base ? <div style={{ fontSize: '0.82rem', marginBottom: 6 }}>{d.base.path} {d.base.web_url && <a href={d.base.web_url} target="_blank" rel="noopener noreferrer">open</a>} {d.root && <span style={S.small}>· Finance & Compliance {d.root.web_url && <a href={d.root.web_url} target="_blank" rel="noopener noreferrer">open</a>}</span>}</div> : <div style={{ ...S.muted, marginBottom: 6 }}>Not chosen yet.</div>}
              {r.admin && !d.root && <div style={S.row}><Input value={link} onChange={e => setLink(e.target.value)} placeholder="Paste the OneDrive folder link (e.g. https://devxwork-my.sharepoint.com/my?id=…)" style={{ flex: 1, minWidth: 280 }} aria-label="OneDrive folder link" />
                <Btn disabled={!link || !!busy} onClick={() => run('base', () => api.setBase(link), x => `Folder chosen: ${x.base.path}`)}>Use this folder</Btn></div>}
              <div style={{ ...S.small, marginTop: 4 }}>The link is checked with Microsoft and must be a folder in the connected person's own OneDrive.</div>
            </div>
          )}
        </Section>
      )}

      {st && <Section title="Settings" sub="Which financial years get folders, when a new company's folders are made, and whether uploaded documents are also copied to OneDrive">
        <div style={{ ...S.row, gap: 18 }}>
          <div><div style={S.label}>Financial years</div>{fys.map(y => <label key={y} style={{ marginRight: 12, fontSize: '0.82rem' }}><input type="checkbox" disabled={!r.admin} checked={(st.fys || []).includes(y)} onChange={e => setSt({ ...st, fys: e.target.checked ? [...(st.fys || []), y].sort() : (st.fys || []).filter(x => x !== y) })} /> FY {y}</label>)}</div>
          <div style={{ width: 260 }}><div style={S.label}>Create a company's folders</div><Select disabled={!r.admin} value={st.trigger} onChange={v => setSt({ ...st, trigger: v })} options={[['saved', 'As soon as it is saved in Masters'], ['approved', 'Only once its master data is approved']]} /></div>
          <label style={{ fontSize: '0.82rem' }}><input type="checkbox" disabled={!r.admin} checked={!!st.copy_documents} onChange={e => setSt({ ...st, copy_documents: e.target.checked })} /> Copy uploaded documents into their OneDrive folder</label>
          {r.admin && <Btn onClick={() => run('settings', () => api.saveFolderSettings(st), () => 'Settings saved')}>Save settings</Btn>}
        </div>
      </Section>}

      <div style={{ ...S.grid(150), marginBottom: '1rem' }}>
        <Kpi label="Folders in the plan" value={d.counts.total} />
        <Kpi label={live ? 'In OneDrive' : 'Simulated'} value={d.counts.mapped} tone="green" />
        <Kpi label="Still to create" value={d.counts.to_create} tone="lav" />
        <Kpi label="Failed (retried later)" value={d.counts.failed} tone={d.counts.failed ? 'red' : 'navy'} />
        <Kpi label="Waiting for data" value={d.counts.pending} tone="amber" sub="e.g. PT periodicity missing" />
      </div>

      <Section title="Create folders" sub={d.last_run ? `Last run ${dtm(d.last_run.at)}: ${summary(d.last_run)}` : 'Nothing created yet'} right={r.master && connected && d.base && <>
        <Btn kind="onNavy" small disabled={!!busy} onClick={() => run('preview', async () => { setPv(await api.foldersPreview({})); })}>Preview</Btn>
        <Btn kind="onNavy" small disabled={!!busy} onClick={() => run('provision', () => api.foldersProvision({}), summary)}>{busy === 'provision' ? 'Creating…' : live ? 'Create folders now' : 'Create (simulated)'}</Btn>
        {d.counts.failed > 0 && <Btn kind="onNavy" small disabled={!!busy} onClick={() => run('retry', () => api.foldersProvision({ force: true }), summary)}>Retry failed now</Btn>}
        <Btn kind="onNavy" small disabled={!!busy} onClick={() => run('scan', () => api.foldersScan(), summary)}>Look for folders added in OneDrive</Btn>
      </>}>
        {!connected || !d.base ? <div style={S.muted}>{live ? 'Connect OneDrive and choose the folder first.' : ''}</div> : pv ? (
          <div style={{ fontSize: '0.8rem' }}><b>Preview (nothing was sent to OneDrive):</b> {pv.to_create} folder(s) to create, {pv.mapped} already there{pv.pending.length ? `, ${pv.pending.length} waiting for data` : ''}.
            {pv.first.length > 0 && <details style={{ marginTop: 6 }}><summary style={{ cursor: 'pointer', ...S.small }}>First {pv.first.length} folders</summary>{pv.first.map(p => <div key={p} style={{ ...S.small, padding: '1px 0' }}>{p}</div>)}</details>}</div>
        ) : <div style={S.muted}>{live ? 'New companies and registrations get their folders automatically once this is set up; the office PC also looks for company folders added in OneDrive every 15 minutes.' : d.counts.mapped ? 'The simulated structure is built — open the tree below.' : 'Click "Create (simulated)" to see the structure built.'}</div>}
      </Section>

      <Section title="Folder tree" sub="Per company and financial year — status of every folder" right={<>
        <Select value={d.entity_id} onChange={setEntityId} options={(org?.entities || []).map(e => [e.id, `${e.short_code} — ${e.legal_name}`])} style={{ width: 240 }} aria-label="Company" />
        <Select value={d.fy} onChange={setFy} options={(d.settings.fys || []).map(y => [y, `FY ${y}`])} style={{ width: 120 }} aria-label="Financial year" />
      </>}>
        {d.tree.length > 1 ? <Tree key={`${d.entity_id}|${d.fy}|${d.tree.length}`} nodes={d.tree} /> : <div style={S.muted}>No company to show yet.</div>}
      </Section>

      {d.found.length > 0 && <Section title={`Folders found in OneDrive (${d.found.length})`} sub="Created directly in Finance & Compliance. Link a company folder to its entity (it then gets the standard structure), or mark it as not a company folder. Nothing is inferred from the folder's contents.">
        {d.found.map(f => <div key={f.item_id} style={{ ...S.row, padding: '6px 0', borderBottom: `1px solid ${C.line}` }}>
          <b>{f.name}</b> <span style={S.small}>first seen {dtm(f.first_seen)}</span>
          {r.master && <><Select value={linkTo[f.item_id] || ''} onChange={v => setLinkTo({ ...linkTo, [f.item_id]: v })} options={(org?.entities || []).map(e => [e.id, e.legal_name])} placeholder="Link to entity…" style={{ width: 260 }} />
            <Btn small disabled={!linkTo[f.item_id] || !!busy} onClick={() => run('link', () => api.foundAction(f.item_id, 'link', { entity_id: linkTo[f.item_id] }), x => `Linked${x.run ? ` — ${summary(x.run)}` : ''}`)}>Link</Btn>
            <Btn small kind="ghost" onClick={() => run('ignore', () => api.foundAction(f.item_id, 'ignore'), () => 'Marked as not a company folder')}>Not a company folder</Btn></>}
        </div>)}
      </Section>}

      {d.pending.length > 0 && <Section title={`Waiting for data (${d.pending.length})`} sub="These folders are not created until the missing information is recorded — nothing is guessed">
        {d.pending.map((p, i) => <div key={i} style={{ fontSize: '0.8rem', padding: '3px 0' }}>• {p.text}</div>)}
      </Section>}

      <Section title="Preview a new company" sub="The folders a company would get as soon as it is saved in Masters (nothing is created)">
        <div style={S.row}><Input value={newCo} onChange={e => setNewCo(e.target.value)} placeholder="Company legal name" style={{ width: 320 }} aria-label="New company legal name" /><Btn disabled={!newCo} onClick={() => api.previewCompany(newCo).then(setCoPv).catch(e => setErr(errMsg(e)))}>Preview</Btn></div>
        {coPv && <div style={{ marginTop: 8 }}><div style={S.small}>{coPv.total} folders for one financial year. {coPv.note}</div><Tree nodes={[...coPv.top.map(n => ({ ...n, status: 'planned', kind: n.key.split('|').length === 1 ? 'company' : n.key.split('|').length === 2 ? 'fy' : 'category' }))]} /></div>}
      </Section>

      <Section title="Activity log" sub="Created, reused, renamed, failed and found folders; copied documents" flush>
        <Table rows={d.log} rowKey={(x, i) => `${x.at}${i}`} maxHeight={320} empty="Nothing yet"
          cols={[{ label: 'When', render: x => dtm(x.at) }, { label: 'What', render: x => <Tag tone={x.kind === 'failed' ? 'red' : x.kind === 'found' ? 'amber' : 'green'}>{KIND[x.kind] || x.kind}</Tag> }, { label: 'Folder / file', key: 'name' }, { label: 'Detail', render: x => x.detail || '' }]} />
      </Section>
    </div>
  );
}
