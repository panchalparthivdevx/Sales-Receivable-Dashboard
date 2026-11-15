import React, { useEffect, useState } from 'react';
import { api, errMsg, download } from './api';
import { C, S, Section, Note, Btn, Table, Tag, Tabs, Modal, Field, Input, Area, Select, Multi, Empty, dt } from './ui';

// Masters: group → legal entity → registrations → establishments, people, events, team mapping, import.
// Records are drafts until approved; live tasks are generated only for approved entities and registrations.
// Never enter portal passwords anywhere — the server refuses any field that looks like one.

const STATUS_TAG = { approved: ['green', 'Approved'], draft: ['amber', 'Draft — not approved'], illustrative: ['lav', 'Illustrative (demo)'] };
const tri = v => (v === true ? 'yes' : v === false ? 'no' : '');
const fromTri = v => (v === 'yes' ? true : v === 'no' ? false : null);
const label = k => k.replace(/^has_/, '').replace(/_/g, ' ');

function RecordModal({ kind, rec, meta, org, onClose, onSaved }) {
  const blank = { entity: { type: 'PRIVATE', listed: null, flags: {}, fy_facts: {} }, registration: { flags: {}, establishment_ids: [] }, establishment: { kind: 'office', flags: {} }, person: { roles: [] } }[kind];
  // a recorded DIN comes masked; it is sent again only when retyped (the server keeps the stored one)
  const [f, setF] = useState(() => ({ ...JSON.parse(JSON.stringify(rec || blank)), ...(kind === 'person' && rec?.din_recorded ? { din: '' } : {}) }));
  const [fyKey, setFyKey] = useState(Object.keys(f.fy_facts || {})[0] || '');
  const [err, setErr] = useState('');
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const setFlag = (k, v) => setF(x => ({ ...x, flags: { ...x.flags, [k]: fromTri(v) } }));
  const save = () => {
    const body = { ...f, rev: rec?.rev };
    if (kind === 'person' && rec?.din_recorded && !f.din) delete body.din;
    if (body.flags) body.flags = Object.fromEntries(Object.entries(body.flags).filter(([, v]) => v !== null));
    api.saveOrg(kind, body, rec?.id).then(r => onSaved(r)).catch(e => setErr(errMsg(e) + (e?.response?.data?.warnings?.length ? ` (${e.response.data.warnings.join('; ')})` : '')));
  };
  const entOpts = org.entities.map(e => [e.id, `${e.short_code} — ${e.legal_name}`]);
  const states = (meta.constants.states || []).map(s => [s.abbr, `${s.abbr} — ${s.name}`]);
  const flagGrid = keys => <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, gridColumn: '1 / -1' }}>{keys.map(k => <Field key={k} label={label(k)}><Select value={tri(f.flags?.[k])} onChange={v => setFlag(k, v)} options={[['yes', 'Yes'], ['no', 'No']]} placeholder="Not recorded" /></Field>)}</div>;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 };
  return (
    <Modal title={`${rec ? 'Edit' : 'New'} ${kind}`} onClose={onClose} width={760}>
      {err && <Note tone="error">{err}</Note>}
      {rec?.data_status === 'approved' && <Note tone="warn">Changing identifiers, type, state, periodicity or dates sends an approved record back to draft until it is approved again.</Note>}
      {kind === 'entity' && <div style={grid}>
        <Field label="Legal name"><Input value={f.legal_name || ''} onChange={e => set('legal_name', e.target.value)} /></Field>
        <Field label="Short code (file names)"><Input value={f.short_code || ''} onChange={e => set('short_code', e.target.value)} /></Field>
        <Field label="Type"><Select value={f.type} onChange={v => set('type', v)} options={Object.entries(meta.constants.entity_types)} /></Field>
        <Field label="PAN"><Input value={f.pan || ''} onChange={e => set('pan', e.target.value)} /></Field>
        {f.type === 'LLP' ? <Field label="LLPIN"><Input value={f.llpin || ''} onChange={e => set('llpin', e.target.value)} /></Field> : <Field label="CIN"><Input value={f.cin || ''} onChange={e => set('cin', e.target.value)} /></Field>}
        {f.type !== 'LLP' && <Field label="Listed"><Select value={tri(f.listed)} onChange={v => set('listed', fromTri(v))} options={[['yes', 'Yes'], ['no', 'No']]} placeholder="Not recorded" /></Field>}
        {f.listed === true && <Field label="What is listed" hint="Shares and NCDs carry different SEBI obligations"><Select value={f.listing_type || ''} onChange={v => set('listing_type', v || null)} options={[['equity', 'Shares (equity)'], ['debt', 'Debt securities (NCDs) only'], ['equity_and_debt', 'Shares and NCDs']]} placeholder="Not recorded" /></Field>}
        {f.listed === true && <Field label="Exchanges"><Input value={(f.exchanges || []).join(', ')} onChange={e => set('exchanges', e.target.value.split(',').map(x => x.trim()).filter(Boolean))} placeholder="NSE, BSE" /></Field>}
        <Field label="Incorporation date"><Input type="date" value={f.incorporation_date || ''} onChange={e => set('incorporation_date', e.target.value)} /></Field>
        <Field label="Zoho Books organisation id"><Input value={f.zoho_org_id || ''} onChange={e => set('zoho_org_id', e.target.value)} /></Field>
        <Field label="Financial year">April–March</Field>
        <div style={{ gridColumn: '1 / -1', ...S.label, marginTop: 6 }}>Facts used by applicability tests (blank = not recorded → "needs review")</div>
        {flagGrid(meta.constants.entity_flags)}
        <div style={{ gridColumn: '1 / -1', ...S.label, marginTop: 6 }}>Threshold history (per financial year)</div>
        <div style={{ gridColumn: '1 / -1', ...S.row }}>
          <Input placeholder="FY e.g. 2025-26" value={fyKey} onChange={e => setFyKey(e.target.value)} style={{ width: 140 }} />
          {fyKey && !f.fy_facts?.[fyKey] && <Btn small onClick={() => setF(x => ({ ...x, fy_facts: { ...x.fy_facts, [fyKey]: {} } }))}>Add year</Btn>}
          {Object.keys(f.fy_facts || {}).map(k => <Tag key={k} tone="lav">{k}</Tag>)}
        </div>
        {fyKey && f.fy_facts?.[fyKey] && <div style={{ gridColumn: '1 / -1', ...grid }}>
          {meta.constants.fy_facts.map(k => <Field key={k} label={`${k.replace(/_/g, ' ')} (₹ / count)`}><Input type="number" value={f.fy_facts[fyKey][k] ?? ''} onChange={e => setF(x => ({ ...x, fy_facts: { ...x.fy_facts, [fyKey]: { ...x.fy_facts[fyKey], [k]: e.target.value } } }))} /></Field>)}
          <Field label="Tax audit required"><Select value={tri(f.fy_facts[fyKey].tax_audit_required)} onChange={v => setF(x => ({ ...x, fy_facts: { ...x.fy_facts, [fyKey]: { ...x.fy_facts[fyKey], tax_audit_required: fromTri(v) } } }))} options={[['yes', 'Yes'], ['no', 'No']]} placeholder="Not recorded" /></Field>
          <Field label="Source of these figures"><Input value={f.fy_facts[fyKey].source || ''} onChange={e => setF(x => ({ ...x, fy_facts: { ...x.fy_facts, [fyKey]: { ...x.fy_facts[fyKey], source: e.target.value } } }))} /></Field>
        </div>}
        <Field label="Notes" style={{ gridColumn: '1 / -1' }}><Area value={f.notes || ''} onChange={e => set('notes', e.target.value)} /></Field>
      </div>}
      {kind === 'registration' && <div style={grid}>
        <Field label="Entity"><Select value={f.entity_id || ''} onChange={v => set('entity_id', v)} options={entOpts} placeholder="Choose" /></Field>
        <Field label="Type"><Select value={f.type || ''} onChange={v => set('type', v)} options={Object.entries(meta.constants.reg_types)} placeholder="Choose" /></Field>
        <Field label="Number (GSTIN / TAN / code)" hint="Leave the record out until the real number is known — never a placeholder"><Input value={f.number || ''} onChange={e => set('number', e.target.value)} /></Field>
        <Field label="State"><Select value={f.state || ''} onChange={v => set('state', v)} options={states} placeholder="—" /></Field>
        <Field label="Filing frequency / periodicity"><Select value={f.filing_frequency || ''} onChange={v => set('filing_frequency', v)} options={['monthly', 'quarterly', 'half_yearly', 'annual']} placeholder="Not recorded" /></Field>
        <Field label="Regime"><Select value={f.regime || ''} onChange={v => set('regime', v)} options={[['regular', 'Regular'], ['qrmp', 'QRMP'], ['composition', 'Composition'], ['other', 'Other']]} placeholder="—" /></Field>
        <Field label="Active from"><Input type="date" value={f.active_from || ''} onChange={e => set('active_from', e.target.value)} /></Field>
        <Field label="Active to / expiry"><Input type="date" value={f.active_to || ''} onChange={e => set('active_to', e.target.value)} /></Field>
        <Field label="Jurisdiction"><Input value={f.jurisdiction || ''} onChange={e => set('jurisdiction', e.target.value)} /></Field>
        <Field label="Authority"><Input value={f.authority || ''} onChange={e => set('authority', e.target.value)} /></Field>
        <Field label="Portal URL (no passwords)"><Input value={f.portal_url || ''} onChange={e => set('portal_url', e.target.value)} /></Field>
        <div><Multi label="Establishments" options={org.establishments.filter(b => b.entity_id === f.entity_id).map(b => [b.id, b.name])} value={f.establishment_ids || []} onChange={v => set('establishment_ids', v)} width={220} /></div>
        {flagGrid(meta.constants.reg_flags)}
        <Field label="Notes" style={{ gridColumn: '1 / -1' }}><Area value={f.notes || ''} onChange={e => set('notes', e.target.value)} /></Field>
      </div>}
      {kind === 'establishment' && <div style={grid}>
        <Field label="Entity"><Select value={f.entity_id || ''} onChange={v => set('entity_id', v)} options={entOpts} placeholder="Choose" /></Field>
        <Field label="Name"><Input value={f.name || ''} onChange={e => set('name', e.target.value)} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={v => set('kind', v)} options={['office', 'branch', 'factory', 'warehouse', 'site']} /></Field>
        <Field label="State"><Select value={f.state || ''} onChange={v => set('state', v)} options={states} placeholder="Choose" /></Field>
        <Field label="City"><Input value={f.city || ''} onChange={e => set('city', e.target.value)} /></Field>
        <Field label="Headcount"><Input type="number" value={f.headcount ?? ''} onChange={e => set('headcount', e.target.value)} /></Field>
        <Field label="Active from"><Input type="date" value={f.active_from || ''} onChange={e => set('active_from', e.target.value)} /></Field>
        <Field label="Active to"><Input type="date" value={f.active_to || ''} onChange={e => set('active_to', e.target.value)} /></Field>
        <Field label="Address" style={{ gridColumn: '1 / -1' }}><Input value={f.address || ''} onChange={e => set('address', e.target.value)} /></Field>
        {flagGrid(meta.constants.est_flags)}
      </div>}
      {kind === 'person' && <div style={grid}>
        <Field label="Name"><Input value={f.name || ''} onChange={e => set('name', e.target.value)} /></Field>
        <Field label="DIN / DPIN" hint={rec?.din_recorded ? 'Recorded (shown masked). Enter again only to change it.' : ''}><Input value={f.din || ''} onChange={e => set('din', e.target.value)} placeholder={rec?.din_recorded ? rec.din : ''} /></Field>
        <Field label="DSC expiry"><Input type="date" value={f.dsc_expiry || ''} onChange={e => set('dsc_expiry', e.target.value)} /></Field>
        <div style={{ gridColumn: '1 / -1' }}><span style={S.label}>Roles (one DIR-3 KYC task per person, not per company)</span>
          {(f.roles || []).map((ro, i) => <div key={i} style={{ ...S.row, marginBottom: 6 }}><Select value={ro.entity_id} onChange={v => set('roles', f.roles.map((x, j) => (j === i ? { ...x, entity_id: v } : x)))} options={entOpts} style={{ width: 260 }} /><Input value={ro.designation} onChange={e => set('roles', f.roles.map((x, j) => (j === i ? { ...x, designation: e.target.value } : x)))} placeholder="Designation" style={{ width: 200 }} /><Btn small kind="ghost" onClick={() => set('roles', f.roles.filter((_, j) => j !== i))}>Remove</Btn></div>)}
          <Btn small onClick={() => set('roles', [...(f.roles || []), { entity_id: org.entities[0]?.id || '', designation: 'Director' }])}>Add role</Btn></div>
      </div>}
      <div style={{ ...S.row, justifyContent: 'flex-end', marginTop: 14 }}><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={save}>Save</Btn></div>
    </Modal>
  );
}

function EventModal({ ev, meta, org, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ status: 'open', ...(ev || {}), event_at_local: ev?.event_at ? new Date(Date.parse(ev.event_at) + 330 * 60000).toISOString().slice(0, 16) : '' }));
  const [err, setErr] = useState('');
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const save = () => {
    const { event_at_local, ...body } = f;
    body.event_at = event_at_local ? `${event_at_local}:00+05:30` : null;
    if (event_at_local && !body.event_date) body.event_date = event_at_local.slice(0, 10);
    api.saveEvent({ ...body, rev: ev?.rev }, ev?.id).then(onSaved).catch(e => setErr(errMsg(e)));
  };
  return (
    <Modal title={`${ev ? 'Edit' : 'Record'} event`} onClose={onClose} width={640}>
      {err && <Note tone="error">{err}</Note>}
      <Note tone="info">Saving an event creates the tasks it triggers (if their applicability is decided) and recomputes dates that depend on it, e.g. AOC-4 / MGT-7 from the AGM, a reply from the notice's date.</Note>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        <Field label="Entity"><Select value={f.entity_id || ''} onChange={v => set('entity_id', v)} options={org.entities.map(e => [e.id, `${e.short_code} — ${e.legal_name}`])} placeholder="Choose" /></Field>
        <Field label="Registration (optional)"><Select value={f.registration_id || ''} onChange={v => set('registration_id', v || null)} options={org.registrations.filter(r => r.entity_id === f.entity_id).map(r => [r.id, `${r.type} ${r.number}`])} placeholder="—" /></Field>
        <Field label="Type"><Select value={f.type || ''} onChange={v => set('type', v)} options={Object.entries(meta.constants.event_types)} placeholder="Choose" /></Field>
        <Field label="Title"><Input value={f.title || ''} onChange={e => set('title', e.target.value)} /></Field>
        <Field label="Event date"><Input type="date" value={f.event_date || ''} onChange={e => set('event_date', e.target.value)} /></Field>
        <Field label="Event time (Indian time) — for hours-based deadlines"><Input type="datetime-local" value={f.event_at_local} onChange={e => set('event_at_local', e.target.value)} /></Field>
        {f.type === 'AGM' && <Field label="FY of the accounts adopted"><Input value={f.fy || ''} onChange={e => set('fy', e.target.value)} placeholder="2025-26" /></Field>}
        <Field label="Reply / action due (from the document)"><Input type="date" value={f.response_due || ''} onChange={e => set('response_due', e.target.value)} /></Field>
        <Field label="Reference (notice no., DIN, order no.)"><Input value={f.reference || ''} onChange={e => set('reference', e.target.value)} /></Field>
        <Field label="Authority"><Input value={f.authority || ''} onChange={e => set('authority', e.target.value)} /></Field>
        <Field label="Status"><Select value={f.status} onChange={v => set('status', v)} options={['open', 'closed', 'cancelled']} /></Field>
        {ev && <Field label="Reason for the change"><Input value={f.reason || ''} onChange={e => set('reason', e.target.value)} /></Field>}
        <Field label="Notes" style={{ gridColumn: '1 / -1' }}><Area value={f.notes || ''} onChange={e => set('notes', e.target.value)} /></Field>
      </div>
      <div style={{ ...S.row, justifyContent: 'flex-end', marginTop: 12 }}><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={save}>Save</Btn></div>
    </Modal>
  );
}

function ImportPanel({ meta, onDone }) {
  const [file, setFile] = useState(null);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const run = (step, v1) => {
    setErr('');
    let p;
    if (v1) p = api.importV1(step);
    else { if (!file) { setErr('Choose a file'); return; } const fd = new FormData(); fd.append('file', file); p = api.importStep(step, fd); }
    p.then(r => { setRes(r); if (r.committed) onDone(); }).catch(e => { setErr(errMsg(e)); if (e?.response?.data?.results) setRes(e.response.data); });
  };
  return (
    <Section title="Import master data" sub="Preview first. The import is all-or-nothing: a single error stops the whole file. Imported records are drafts until approved.">
      {err && <Note tone="error">{err}</Note>}
      <div style={S.row}>
        <Btn kind="ghost" onClick={() => download('/import/template.xlsx', {}, 'template.xlsx').catch(e => setErr(errMsg(e)))}>Download template</Btn>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={e => setFile(e.target.files[0] || null)} aria-label="Import file" />
        <Btn onClick={() => run('preview')}>Preview</Btn>
        {res && !res.committed && !res.errors && <Btn kind="primary" onClick={() => run('commit')}>Import</Btn>}
      </div>
      {meta.live && <div style={{ ...S.row, marginTop: 10 }}><span style={S.muted}>Carry over the companies of Compliance Dashboard v1 (as drafts; PAN, CIN and type must then be checked):</span><Btn small onClick={() => run('preview', true)}>Preview v1 companies</Btn><Btn small kind="primary" onClick={() => { if (window.confirm('Add the Compliance v1 companies as draft entities?')) run('commit', true); }}>Carry over</Btn></div>}
      {res && <div style={{ marginTop: 10 }}>
        <div style={S.muted}>{res.committed ? 'Imported.' : 'Preview — nothing saved yet.'} {Object.entries(res.counts || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>
        {res.unknown_columns?.length > 0 && <Note tone="warn">Columns ignored: {res.unknown_columns.join('; ')}</Note>}
        <Table rows={res.results || []} rowKey={(r, i) => `${r.sheet}${r.row}${i}`} maxHeight={320} cols={[{ label: 'Sheet', key: 'sheet' }, { label: 'Row', key: 'row' }, { label: 'Record', render: r => r.label || '' }, { label: 'Result', render: r => <Tag tone={r.action === 'error' ? 'red' : r.action === 'new' ? 'green' : 'grey'}>{r.action}</Tag> }, { label: 'Messages', render: r => [r.error, ...(r.warnings || [])].filter(Boolean).join('; ') }]} />
      </div>}
    </Section>
  );
}

function TeamPanel({ meta, org, users, onDone }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.team().then(t => setRows(t.rows || [])).catch(e => setErr(errMsg(e))); }, []);
  if (!rows) return err ? <Note tone="error">{err}</Note> : <Empty>Loading…</Empty>;
  const people = [['', '—'], ...users.map(u => [u.id, u.name])];
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Section title="Team mapping" sub="Owner, backup owner and reviewer for new tasks. The most specific row wins (registration > entity + category > category > entity > everything). Existing tasks keep their people.">
      {err && <Note tone="error">{err}</Note>}
      <Table rows={rows} rowKey={(r, i) => r.id || i} empty="No mapping yet — new tasks are unassigned"
        cols={[
          { label: 'Entity', render: (r) => <Select value={r.entity_id || '*'} onChange={v => set(rows.indexOf(r), 'entity_id', v)} options={[['*', 'Any entity'], ...org.entities.map(e => [e.id, e.short_code])]} /> },
          { label: 'Category', render: r => <Select value={r.category || '*'} onChange={v => set(rows.indexOf(r), 'category', v)} options={[['*', 'Any category'], ...meta.constants.categories.map(c => [c, c])]} /> },
          { label: 'Registration', render: r => <Select value={r.registration_id || ''} onChange={v => set(rows.indexOf(r), 'registration_id', v)} options={org.registrations.filter(x => !r.entity_id || r.entity_id === '*' || x.entity_id === r.entity_id).map(x => [x.id, `${x.type} ${x.number}`])} placeholder="Any" /> },
          { label: 'Owner', render: r => <Select value={r.owner_id || ''} onChange={v => set(rows.indexOf(r), 'owner_id', v)} options={people} /> },
          { label: 'Backup', render: r => <Select value={r.backup_owner_id || ''} onChange={v => set(rows.indexOf(r), 'backup_owner_id', v)} options={people} /> },
          { label: 'Reviewer', render: r => <Select value={r.checker_id || ''} onChange={v => set(rows.indexOf(r), 'checker_id', v)} options={people} /> },
          { label: '', render: r => <Btn small kind="ghost" onClick={() => setRows(rows.filter(x => x !== r))}>Remove</Btn> },
        ]} />
      <div style={{ ...S.row, marginTop: 10 }}><Btn onClick={() => setRows([...rows, { entity_id: '*', category: '*' }])}>Add row</Btn><Btn kind="primary" onClick={() => api.saveTeam(rows).then(t => { setRows(t.rows); onDone('Team mapping saved'); }).catch(e => setErr(errMsg(e)))}>Save mapping</Btn></div>
    </Section>
  );
}

export default function MastersTab({ meta, org, users, stamp, onChanged }) {
  const [tab, setTab] = useState('entities');
  const [edit, setEdit] = useState(null);
  const [events, setEvents] = useState(null);
  const [evEdit, setEvEdit] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { if (tab === 'events') api.events().then(r => setEvents(r.events)).catch(e => setErr(errMsg(e))); }, [tab, stamp]);
  const r = meta.actor.rights;
  const ent = new Map(org.entities.map(e => [e.id, e]));
  const approve = (kind, id) => api.approveOrg(kind, id).then(() => { setMsg('Approved'); onChanged(); }).catch(e => setErr(errMsg(e)));
  const statusCell = x => <>{(() => { const [t, l] = STATUS_TAG[x.data_status] || ['grey', x.data_status]; return <Tag tone={t}>{l}</Tag>; })()}{x.warnings?.length > 0 && <div style={{ ...S.small, color: C.amber }}>{x.warnings.join('; ')}</div>}</>;
  const approveBtn = (kind, x) => (r.approve && x.data_status === 'draft' ? <Btn small onClick={e => { e.stopPropagation(); approve(kind, x.id); }}>Approve</Btn> : null);
  const add = kind => (r.master ? <Btn kind="onNavy" small onClick={() => setEdit({ kind, rec: null })}>Add {kind}</Btn> : null);
  return (
    <div>
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      {!meta.live && <Note tone="demo">Demo masters are illustrative and can never be approved as real master data.</Note>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'entities', label: 'Entities', count: org.entities.length }, { id: 'registrations', label: 'Registrations', count: org.registrations.length }, { id: 'establishments', label: 'Establishments', count: org.establishments.length }, { id: 'people', label: 'People', count: org.people.length }, { id: 'events', label: 'Events' }, { id: 'team', label: 'Team mapping' }, ...(r.master ? [{ id: 'import', label: 'Import' }] : [])]} />
      {tab === 'entities' && <Section title="Legal entities" sub="Group → entity. Entity-level obligations (ITR, ROC, advance tax) are created once per entity, never once per GSTIN." right={add('entity')} flush>
        <Table rows={org.entities} onRow={r.master ? x => setEdit({ kind: 'entity', rec: x }) : undefined} empty="No entities yet. Add one, import the template, or carry over the Compliance v1 companies (Import)."
          cols={[{ label: 'Entity', render: x => <><b>{x.short_code}</b> {x.legal_name}<div style={S.small}>{meta.constants.entity_types[x.type]}{x.listed ? ` · listed (${(x.exchanges || []).join(', ')})` : ''}</div></> }, { label: 'PAN', key: 'pan' }, { label: 'CIN / LLPIN', render: x => x.cin || x.llpin || '—', hideSm: true }, { label: 'Status', render: statusCell }, { label: '', render: x => approveBtn('entity', x) }]} /></Section>}
      {tab === 'registrations' && <Section title="Registrations" sub="GSTIN (regular / ISD / TDS / TCS), TAN, PF, ESIC, PT, LWF, IEC, licences — each with its own tasks. Several GSTINs in one state are tracked separately." right={add('registration')} flush>
        <Table rows={org.registrations} onRow={r.master ? x => setEdit({ kind: 'registration', rec: x }) : undefined} empty="No registrations"
          cols={[{ label: 'Entity', render: x => ent.get(x.entity_id)?.short_code }, { label: 'Type', render: x => meta.constants.reg_types[x.type] }, { label: 'Number', render: x => <b>{x.number}</b> }, { label: 'State', key: 'state' }, { label: 'Frequency', render: x => x.filing_frequency || <i style={{ color: C.amber }}>not recorded</i> }, { label: 'Active', render: x => `${x.active_from ? dt(x.active_from) : '—'} → ${x.active_to ? dt(x.active_to) : 'open'}`, hideSm: true }, { label: 'Status', render: statusCell }, { label: '', render: x => approveBtn('registration', x) }]} /></Section>}
      {tab === 'establishments' && <Section title="Establishments / branches" right={add('establishment')} flush>
        <Table rows={org.establishments} onRow={r.master ? x => setEdit({ kind: 'establishment', rec: x }) : undefined} empty="No establishments"
          cols={[{ label: 'Entity', render: x => ent.get(x.entity_id)?.short_code }, { label: 'Name', key: 'name' }, { label: 'State', key: 'state' }, { label: 'Headcount', num: true, render: x => x.headcount ?? '—' }, { label: 'Status', render: statusCell }]} /></Section>}
      {tab === 'people' && <Section title="People (directors / partners / signatories)" sub="DIR-3 KYC and DSC renewal are per person — once, even for a director of several group companies. DINs are shown masked." right={add('person')} flush>
        <Table rows={org.people} onRow={r.master ? x => setEdit({ kind: 'person', rec: x }) : undefined} empty="No people"
          cols={[{ label: 'Name', key: 'name' }, { label: 'DIN', render: x => x.din || '—' }, { label: 'DSC expiry', render: x => dt(x.dsc_expiry) }, { label: 'Roles', render: x => x.roles.map(ro => `${ent.get(ro.entity_id)?.short_code || '?'}: ${ro.designation}`).join(' · ') }]} /></Section>}
      {tab === 'events' && <Section title="Events" sub="AGMs, notices, hearings, orders, cancellations, material events, remittances … — they create and date event-driven tasks" right={r.master ? <Btn kind="onNavy" small onClick={() => setEvEdit({ ev: null })}>Record event</Btn> : null} flush>
        {!events ? <Empty>Loading…</Empty> : <Table rows={events} onRow={r.master ? x => setEvEdit({ ev: x }) : undefined} empty="No events"
          cols={[{ label: 'Date', render: x => <>{dt(x.event_date)}{x.event_at && <div style={S.small}>{new Date(x.event_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST</div>}</> }, { label: 'Type', render: x => meta.constants.event_types[x.type] }, { label: 'Entity', render: x => ent.get(x.entity_id)?.short_code }, { label: 'Title', render: x => <>{x.title}<div style={S.small}>{x.reference}</div></> }, { label: 'Reply due', render: x => dt(x.response_due) }, { label: 'Status', key: 'status' }]} />}
      </Section>}
      {tab === 'team' && <TeamPanel meta={meta} org={org} users={users} onDone={t => { setMsg(t); onChanged(); }} />}
      {tab === 'import' && <ImportPanel meta={meta} onDone={() => { setMsg('Imported'); onChanged(); }} />}
      {edit && <RecordModal kind={edit.kind} rec={edit.rec} meta={meta} org={org} onClose={() => setEdit(null)} onSaved={res => { setEdit(null); setMsg(`Saved${res.warnings?.length ? ` — check: ${res.warnings.join('; ')}` : ''}`); onChanged(); }} />}
      {evEdit && <EventModal ev={evEdit.ev} meta={meta} org={org} onClose={() => setEvEdit(null)} onSaved={res => { setEvEdit(null); setMsg(`Event saved: ${res.created.length} task(s) created, ${res.recomputed} date(s) recomputed${res.blocked.length ? `, ${res.blocked.length} blocked (see Coverage)` : ''}`); onChanged(); api.events().then(x => setEvents(x.events)); }} />}
    </div>
  );
}
