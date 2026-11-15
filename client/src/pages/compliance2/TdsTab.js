import React, { useCallback, useEffect, useState } from 'react';
import { api, errMsg, openFile } from './api';
import { S, Btn, Note, Modal, Empty, dt } from './ui';
import { Hero, Pills, Stats, Panel, Notice, DataTable, Toolbar, PrintBtn, Filters, FSel, FInput, Badge, REVIEW_TONE, downloadCsv, money, moneyOr, monthName } from './ui2';
import { InputCards, ReconEditor, useRecon } from './ReconParts';
import { TaskBlock } from './WorkspaceTabs';

// TDS Section-wise (V3) — server: lib/tds.js. One challan = one cash payment (header with tax, surcharge, cess, interest, fee);
// its principal is allocated to section codes exactly as paid (each rupee once). Several challans may cover one month and
// section. The monthly TDS task closes only after its allocation and the paid challan are recorded.

const VIEWS = [['summary', 'Monthly section summary'], ['pivot', 'Month × section'], ['challans', 'Challans & allocations'], ['queue', 'Reconciliation queue'], ['master', 'Section master']];

export default function TdsTab({ meta, org, ws, demo, params, stamp, onOpenTask, onGotoReport }) {
  const [view, setView] = useState('summary');
  const [dataset, setDataset] = useState(demo ? 'illustrative' : 'recorded');
  const [entity, setEntity] = useState('');
  const [month, setMonth] = useState('');
  const [payMonth, setPayMonth] = useState('');
  const [section, setSection] = useState('');
  const [tan, setTan] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [challanForm, setChallanForm] = useState(false);
  const [allocForm, setAllocForm] = useState(null);
  const [edit, setEdit] = useState(null);
  const [recs, reloadRecon] = useRecon(['TDS'], dataset, stamp);
  useEffect(() => setDataset(demo ? 'illustrative' : 'recorded'), [demo]);
  const load = useCallback(() => api.tds({ dataset, entity_ids: entity, registration_ids: tan, months: month, payment_months: payMonth, section }).then(setData).catch(e => setErr(errMsg(e))), [dataset, entity, tan, month, payMonth, section]);
  useEffect(() => { load(); }, [load, stamp]);
  const r = meta.actor.rights;
  const nameOf = id => org.entities.find(e => e.id === id)?.short_code || '—';
  const act = async (fn, m) => { setErr(''); setMsg(''); try { await fn(); setMsg(m); load(); } catch (e) { setErr(errMsg(e)); } };
  const ill = dataset === 'illustrative';
  if (!data) return <div><Hero eyebrow="TDS SECTION-WISE" title="TDS deposits · section-wise" sub="Which sections your team paid under, for each company, TAN and deduction month." />{err ? <Note tone="error">{err}</Note> : <Empty>Loading…</Empty>}</div>;
  const rows = data.rows;
  const principal = rows.reduce((s, x) => s + x.principal, 0);
  const sections = data.sections.map(s => [s.code, `${s.act === '2025' ? '2025 Act' : '1961 Act'} · ${s.code} — ${s.nature}`]);
  const csv = () => downloadCsv('TDS_section_wise_monthly.csv', { Report: 'TDS section-wise monthly', Dataset: ill ? 'Illustrative (demo)' : 'Recorded', Company: entity ? nameOf(entity) : 'All', 'Liability month': month || 'All', 'Payment month': payMonth || 'All', Section: section || 'All', Basis: 'Principal (+ surcharge + cess) allocations; interest / fees stay on the challan' },
    ['Company', 'TAN', 'Liability month', 'Act', 'Actual section / code', 'Legacy reference', 'Nature', 'TDS liability', 'Principal deposited', 'Balance', 'Excess', 'Due date', 'Payment dates', 'Challans', 'Allocations with evidence', 'Review status', 'Mapping'],
    rows.map(x => [nameOf(x.entity_id), x.tan, x.liability_month, x.act, x.section_code, x.legacy_ref, x.nature, x.liability ?? 'Not entered', x.principal, x.balance ?? '', x.excess ?? '', x.due_date || 'From approved rule only', x.paid_dates.join(' '), x.challans.length, x.evidence, x.review.join(' '), x.mapping_unverified ? 'Requires verification' : 'Verified']));
  return (
    <div>
      <Hero eyebrow="TDS SECTION-WISE" title="TDS deposits · section-wise" sub="See which sections your team paid under, for each company, TAN and deduction month — challan header, section allocations, evidence and review." tag="ITNS 281 / 281N" tagSub="Liability month ≠ payment month" />
      {ws.datasets.length > 1 && <Filters><FSel label="Dataset" value={dataset} onChange={setDataset} options={[['illustrative', 'Illustrative (demo)'], ['recorded', 'Recorded by the team']]} width={220} /></Filters>}
      <Notice><b>{ill ? 'Illustrative allocation register.' : 'Allocation register.'}</b> The amount is the principal TDS allocated to a section, not the full challan cash. A challan covering several sections has one allocation per section; interest and fees stay on the challan. A section code is shown as “requires verification” until someone verifies it against the portal — an old-Act alias is never substituted for a new-Act code.</Notice>
      <Filters>
        <FSel label="Company" value={entity} onChange={v => { setEntity(v); setTan(''); }} options={org.entities.map(e => [e.id, `${e.short_code} — ${e.legal_name}`])} placeholder="All companies" width={220} />
        <FSel label="TAN" value={tan} onChange={setTan} options={data.tans.filter(t => !entity || t.entity_id === entity).map(t => [t.id, t.number])} placeholder="All TANs" width={150} />
        <FInput label="Deduction / liability month" type="month" value={month} onChange={setMonth} width={190} />
        <FInput label="Payment month" type="month" value={payMonth} onChange={setPayMonth} width={160} />
        <FSel label="Section / legacy reference" value={section} onChange={setSection} options={sections} placeholder="All sections" width={260} />
      </Filters>
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      <Toolbar>
        {!ill && (r.prepare || r.file) && <Btn kind="primary" onClick={() => setChallanForm(true)}>+ Record challan</Btn>}
        <Btn kind="ghost" onClick={csv}>Export monthly report · CSV</Btn><PrintBtn />
      </Toolbar>
      <Stats items={[{ label: 'Principal TDS deposited', value: money(principal), sub: 'Selected months and filters' }, { label: 'Section allocations', value: rows.reduce((s, x) => s + x.allocations.length, 0), sub: 'Each line is a section allocation' }, { label: 'Challan references', value: data.challans.filter(c => c.status !== 'reversed').length, sub: 'Distinct challans (counted once)' }, { label: 'Sections reported', value: new Set(rows.map(x => `${x.act}|${x.section_code}`)).size, sub: 'Act and actual code kept separate' }]} />
      <Pills items={VIEWS.map(([k, l]) => [k, k === 'queue' ? `${l} (${data.queue.length})` : l])} value={view} onChange={setView} label="TDS views" />
      {view === 'summary' && <Panel title="Monthly section summary" note="Liability comes from the TDS monthly liability inputs below (exact company, TAN, month, Act and code). No input = not entered, never zero. The due date is taken from the approved monthly TDS task.">
        <DataTable headers={['Company / TAN / month', 'Act / actual section', 'Legacy · nature', 'TDS liability', 'Principal deposited', 'Balance / excess', 'Due / paid', 'Challans · evidence', 'Review']} numeric={[3, 4]}
          rows={rows.map(x => [<><b>{nameOf(x.entity_id)}</b> · {x.tan}<br />{monthName(x.liability_month)}</>, <>{x.act === '2025' ? '2025 Act' : '1961 Act'}<br /><b>{x.section_code}</b>{x.mapping_unverified && <><br /><Badge tone="amber">Requires verification</Badge></>}</>, <>{x.legacy_ref || '—'}<br /><small>{x.nature}</small></>,
            moneyOr(x.liability), money(x.principal), x.liability === null ? 'Unreconciled' : <>{x.balance > 0 && <Badge tone="red">Balance {money(x.balance)}</Badge>}{x.excess > 0 && <Badge tone="amber">Excess {money(x.excess)}</Badge>}{!x.balance && !x.excess && <Badge tone="green">Matched</Badge>}</>,
            <>{x.due_date ? dt(x.due_date) : 'No approved due date'}<br /><small>Paid {x.paid_dates.map(dt).join(', ')}</small>{x.late && <><br /><Badge tone="red">Paid after due date</Badge></>}</>, `${x.challans.length} challan(s) · ${x.evidence}/${x.allocations.length} with evidence`, x.review.map(s => <Badge key={s} tone={REVIEW_TONE[s]}>{s.replace(/_/g, ' ')}</Badge>)])}
          empty="No deposits recorded for this selection. Use “Record challan” to start." />
      </Panel>}
      {view === 'pivot' && <Panel title="Month × section (principal deposited)" note="Principal allocations by deduction month. Drill into Challans & allocations for the challans behind a figure.">
        <DataTable headers={['Act / section', 'Legacy', ...data.pivot.months.map(monthName), 'Total']} numeric={data.pivot.months.map((_, i) => i + 2).concat(data.pivot.months.length + 2)}
          rows={[...data.pivot.sections.map(s => [`${s.act === '2025' ? '2025' : '1961'} · ${s.code}`, s.legacy_ref || '—', ...data.pivot.months.map(m => (s.cells[m] === undefined ? '—' : money(s.cells[m]))), <b>{money(s.total)}</b>]),
            ...(data.pivot.sections.length ? [[<b>Total</b>, '', ...data.pivot.months.map(m => <b>{money(data.pivot.totals[m])}</b>), <b>{money(Object.values(data.pivot.totals).reduce((a, b) => a + b, 0))}</b>]] : [])]} />
      </Panel>}
      {view === 'challans' && <Panel title="Challans & section allocations">
        {data.challans.length === 0 && <span style={S.muted}>No challans for this selection.</span>}
        {data.challans.map(c => {
          const lines = data.allocations.filter(a => a.challan_id === c.id && a.status === 'active');
          return (
            <details key={c.id} style={{ border: '1px solid #EDF0F6', borderRadius: 10, padding: '10px 14px', marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13 }}><b>{nameOf(c.entity_id)}</b> · {c.tan} · ITNS {c.itns} · BSR {c.bsr_code} / {c.challan_serial} · {dt(c.paid_date)} · {money(c.total)} <Badge tone={REVIEW_TONE[c.review.status]}>{c.review.status.replace(/_/g, ' ')}</Badge>{c.status === 'reversed' && <Badge tone="red">Reversed</Badge>}{c.balance.principal_unallocated > 0 && <Badge tone="amber">{money(c.balance.principal_unallocated)} unallocated</Badge>}{!c.evidence.length && <Badge tone="red">No challan copy</Badge>}</summary>
              <p style={{ ...S.muted, margin: '8px 0' }}>{c.act === '2025' ? 'Income-tax Act, 2025' : 'Income-tax Act, 1961'} · {c.tax_year} · {ws.tds.deductee[c.deductee_type]} · tax {money(c.components.tax)}, surcharge {money(c.components.surcharge)}, cess {money(c.components.cess)}, interest {money(c.components.interest)}, fee {money(c.components.fee)}, other {money(c.components.other)} · prepared by {c.review.prepared_by}{c.review.reviewed_by ? ` · reviewed by ${c.review.reviewed_by}` : ''}</p>
              <DataTable headers={['Liability month', 'Section (as paid)', 'Legacy', 'Principal', 'Surcharge + cess', 'Mapping', '']} numeric={[3, 4]}
                rows={lines.map(a => [monthName(a.liability_month), a.section_code, a.legacy_ref || '—', money(a.principal), money(a.surcharge + a.cess), a.mapping === 'verified' ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Requires verification</Badge>,
                  !ill && c.review.status !== 'reviewed' && c.status !== 'reversed' && (r.prepare || r.file) ? <><Btn small kind="ghost" onClick={() => setAllocForm({ challan: c, alloc: a })}>Edit</Btn><Btn small kind="danger" onClick={() => { const why = window.prompt('Why is this allocation reversed?'); if (why) act(() => api.reverseAllocation(a.id, why), 'Allocation reversed (kept in history).'); }}>Reverse</Btn></> : ''])} empty="No allocations yet." />
              <div style={{ ...S.row, marginTop: 8 }}>
                {c.evidence.map(id => <Btn key={id} small kind="ghost" onClick={() => openFile(id).catch(e => setErr(errMsg(e)))}>Open challan copy</Btn>)}
                {!ill && c.status !== 'reversed' && c.review.status !== 'reviewed' && (r.prepare || r.file) && <>
                  <Btn small onClick={() => setAllocForm({ challan: c })}>+ Allocate to a section</Btn>
                  <label style={{ ...S.muted, display: 'inline-flex', gap: 6, alignItems: 'center' }}>Attach paid challan <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={async e => { const file = e.target.files[0]; if (!file) return; const f = new FormData(); f.append('entity_id', c.entity_id); f.append('kind', 'challan'); f.append('module', 'tds_challan'); f.append('record_id', c.id); f.append('file', file); act(() => api.uploadFile(f), 'Challan copy attached (one stored copy, reused by every allocation).'); }} /></label>
                  {c.review.status === 'draft' && <Btn small kind="primary" onClick={() => act(() => api.reviewChallan(c.id, 'submit'), 'Submitted for review.')}>Submit for review</Btn>}
                </>}
                {!ill && c.review.status === 'ready_for_review' && (r.review || r.approve) && <><Btn small kind="primary" onClick={() => act(() => api.reviewChallan(c.id, 'approve', 'Checked'), 'Challan reviewed.')}>Mark reviewed</Btn><Btn small kind="danger" onClick={() => { const why = window.prompt('Why does it go back?'); if (why) act(() => api.reviewChallan(c.id, 'return', why), 'Returned to the preparer.'); }}>Return</Btn></>}
                {!ill && c.status !== 'reversed' && (r.file || r.approve) && <Btn small kind="ghost" onClick={() => { const why = window.prompt('Why is this challan reversed? (its allocations are reversed too; nothing is deleted)'); if (why) act(() => api.reverseChallan(c.id, why), 'Challan reversed.'); }}>Reverse challan</Btn>}
              </div>
            </details>
          );
        })}
      </Panel>}
      {view === 'queue' && <Panel title="Reconciliation queue" note="Challans with principal, surcharge or cess not yet allocated, or without the paid-challan copy. Nothing closes automatically because amounts look equal.">
        <DataTable headers={['Company / TAN', 'Paid date', 'Challan total', 'What is open']} numeric={[2]} rows={data.queue.map(q => [`${nameOf(q.entity_id)} / ${q.tan}`, dt(q.paid_date), money(q.total), q.reasons.map(x => <Badge key={x} tone="amber">{x}</Badge>)])} empty="Nothing waiting — every challan is fully allocated and has its copy." />
      </Panel>}
      {view === 'master' && <SectionMaster data={data} meta={meta} onChanged={m => { setMsg(m); load(); }} onErr={setErr} />}
      <InputCards types={['TDS']} ws={ws} org={org} records={recs} canPrepare={r.prepare} illustrative={ill} onOpen={(type, id) => setEdit({ type, id })} onReports={() => onGotoReport('tdsliab')} />
      <TaskBlock title="Monthly TDS deposit and statement tasks" params={params} categories={['TDS/TCS']} stamp={stamp} onOpenTask={onOpenTask} note="A monthly TDS deposit task can be closed only after its section-wise allocation and the paid challan are recorded here." />
      {challanForm && <ChallanForm org={org} ws={ws} tans={data.tans} meta={meta} onClose={() => setChallanForm(false)} onSaved={c => { setChallanForm(false); setMsg('Challan recorded. Attach the paid challan and allocate the principal to section codes.'); load(); setView('challans'); setAllocForm({ challan: c }); }} />}
      {allocForm && <AllocForm challan={allocForm.challan} alloc={allocForm.alloc} sections={data.sections} onClose={() => setAllocForm(null)} onSaved={() => { setAllocForm(null); setMsg('Allocation saved.'); load(); }} />}
      {edit && <ReconEditor type={edit.type} id={edit.id} ws={ws} org={org} meta={meta} onClose={() => setEdit(null)} onSaved={() => { reloadRecon(); load(); }} />}
    </div>
  );
}

function SectionMaster({ data, meta, onChanged, onErr }) {
  const [f, setF] = useState({ act: '2025', code: '', legacy_ref: '', nature: '', effective_from: '2026-04-01', source: '' });
  const r = meta.actor.rights;
  return (
    <Panel title="Section master (effective-dated)" note="Familiar old-Act references are kept for navigation and comparison only. Every entry needs verification against the portal's current code list before it counts as an approved mapping. No tax rate is inferred from a section.">
      <DataTable headers={['Act', 'Code (as on the portal)', 'Legacy reference', 'Nature', 'Effective', 'Status', '']}
        rows={data.sections.map(s => [s.act === '2025' ? 'Income-tax Act, 2025' : 'Income-tax Act, 1961', s.code, s.legacy_ref || '—', s.nature, `${dt(s.effective_from)}${s.effective_to ? ` – ${dt(s.effective_to)}` : ' onwards'}`, s.status === 'verified' ? <Badge tone="green" title={s.source}>Verified by {s.verified_by}</Badge> : <Badge tone="amber">Requires verification</Badge>,
          s.status !== 'verified' && (r.rules || r.approve) ? <Btn small onClick={async () => { const src = window.prompt('Which official source did you check? (portal code list / notification)'); if (!src) return; try { await api.verifySection(s.id, src); onChanged('Section verified.'); } catch (e) { onErr(errMsg(e)); } }}>Verify</Btn> : ''])} />
      {r.rules && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginTop: 14, alignItems: 'end' }}>
        <label><span style={S.label}>Act</span><select value={f.act} onChange={e => setF({ ...f, act: e.target.value })} style={S.input}><option value="2025">2025</option><option value="1961">1961</option></select></label>
        {[['code', 'Section / table code'], ['legacy_ref', 'Legacy reference'], ['nature', 'Nature of payment'], ['source', 'Official source']].map(([k, l]) => <label key={k}><span style={S.label}>{l}</span><input value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} style={S.input} /></label>)}
        <label><span style={S.label}>Effective from</span><input type="date" value={f.effective_from} onChange={e => setF({ ...f, effective_from: e.target.value })} style={S.input} /></label>
        <Btn kind="primary" onClick={async () => { try { await api.addSection(f); onChanged('Section added — another person verifies it.'); setF({ ...f, code: '', legacy_ref: '', nature: '' }); } catch (e) { onErr(errMsg(e)); } }}>Add section</Btn>
      </div>}
    </Panel>
  );
}

function ChallanForm({ org, ws, tans, meta, onClose, onSaved }) {
  const [f, setF] = useState({ entity_id: org.entities.find(e => tans.some(t => t.entity_id === e.id))?.id || '', registration_id: '', itns: '281N', deductee_type: 'non_company', act: '2025', tax_year: '', paid_date: '', bsr_code: '', challan_serial: '', cin: '', components: { tax: '', surcharge: '', cess: '', interest: '', fee: '', other: '' }, total: '' });
  const [err, setErr] = useState('');
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const setC = (k, v) => setF(x => ({ ...x, components: { ...x.components, [k]: v } }));
  const sum = Object.values(f.components).reduce((a, v) => a + (Number(v) || 0), 0);
  const save = async () => { setErr(''); try { const { challan } = await api.addChallan(f); onSaved(challan); } catch (e) { setErr(errMsg(e)); } };
  return (
    <Modal title="Record a TDS challan (header)" onClose={onClose} width={860}>
      <p style={{ ...S.muted, marginTop: 0 }}>Enter the challan exactly as paid. The total must equal its components. Section allocations come next; interest, fees and other charges stay on the challan.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, background: '#FAFBFE', border: '1px solid #EDF0F6', borderRadius: 12, padding: 14 }}>
        <label><span style={S.label}>Company</span><select value={f.entity_id} onChange={e => setF(x => ({ ...x, entity_id: e.target.value, registration_id: '' }))} style={S.input}>{org.entities.map(e => <option key={e.id} value={e.id}>{e.short_code}</option>)}</select></label>
        <label><span style={S.label}>TAN</span><select value={f.registration_id} onChange={e => set('registration_id', e.target.value)} style={S.input}><option value="">Choose…</option>{tans.filter(t => t.entity_id === f.entity_id).map(t => <option key={t.id} value={t.id}>{t.number}</option>)}</select></label>
        <label><span style={S.label}>Payment type</span><select value={f.itns} onChange={e => set('itns', e.target.value)} style={S.input}>{Object.entries(ws.tds.itns).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label><span style={S.label}>Deductee type</span><select value={f.deductee_type} onChange={e => set('deductee_type', e.target.value)} style={S.input}>{Object.entries(ws.tds.deductee).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label><span style={S.label}>Governing Act</span><select value={f.act} onChange={e => set('act', e.target.value)} style={S.input}><option value="2025">Income-tax Act, 2025</option><option value="1961">Income-tax Act, 1961</option></select></label>
        {[['tax_year', 'AY / tax year (as on challan)', 'text'], ['paid_date', 'Tender / payment date', 'date'], ['bsr_code', 'BSR code (7 digits)', 'text'], ['challan_serial', 'Challan serial no.', 'text'], ['cin', 'CIN / reference (optional)', 'text']].map(([k, l, t]) => <label key={k}><span style={S.label}>{l}</span><input type={t} value={f[k]} max={t === 'date' ? meta.today_ist : undefined} onChange={e => set(k, e.target.value)} style={S.input} /></label>)}
        {ws.tds.components.map(k => <label key={k}><span style={S.label}>{k === 'tax' ? 'Tax (principal)' : k} (₹)</span><input type="number" min="0" step="0.01" value={f.components[k]} onChange={e => setC(k, e.target.value)} style={S.input} /></label>)}
        <label><span style={S.label}>Challan total (₹, check)</span><input type="number" value={f.total} placeholder={String(sum)} onChange={e => set('total', e.target.value)} style={S.input} /></label>
      </div>
      <p style={S.small}>Components add up to {money(sum)}. ITNS 281 carries one section; 281N up to {ws.tds.max_281n} section codes per deductee type (verify the current portal limit).</p>
      {err && <Note tone="error">{err}</Note>}
      <div style={S.row}><Btn kind="primary" onClick={save}>Save challan</Btn><Btn kind="ghost" onClick={onClose}>Cancel</Btn></div>
    </Modal>
  );
}

function AllocForm({ challan, alloc, sections, onClose, onSaved }) {
  const [f, setF] = useState({ liability_month: alloc?.liability_month || '', section_code: alloc?.section_code || '', legacy_ref: alloc?.legacy_ref || '', nature: alloc?.nature || '', principal: alloc?.principal ?? '', surcharge: alloc?.surcharge ?? '', cess: alloc?.cess ?? '' });
  const [err, setErr] = useState('');
  const own = sections.filter(s => s.act === challan.act);
  const pick = code => { const s = own.find(x => x.code === code); setF(x => ({ ...x, section_code: code, legacy_ref: s?.legacy_ref || x.legacy_ref, nature: s?.nature || x.nature })); };
  const save = async () => { setErr(''); try { await api.allocate({ ...f, challan_id: challan.id }, alloc?.id); onSaved(); } catch (e) { setErr(errMsg(e)); } };
  return (
    <Modal title={`${alloc ? 'Edit' : 'Allocate'} · challan ${challan.challan_serial} (${challan.tan})`} onClose={onClose} width={760}>
      <p style={{ ...S.muted, marginTop: 0 }}>Unallocated principal on this challan: <b>{money(challan.balance.principal_unallocated + (alloc?.principal || 0))}</b>. Enter the section code exactly as paid; picking from the master fills the legacy label, which is never used as the code itself. The paid challan copy is reused — no second upload.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, background: '#FAFBFE', border: '1px solid #EDF0F6', borderRadius: 12, padding: 14 }}>
        <label><span style={S.label}>Deduction / liability month</span><input type="month" value={f.liability_month} onChange={e => setF({ ...f, liability_month: e.target.value })} style={S.input} /></label>
        <label><span style={S.label}>Pick from the master (optional)</span><select value="" onChange={e => pick(e.target.value)} style={S.input}><option value="">—</option>{own.map(s => <option key={s.id} value={s.code}>{s.code} — {s.nature}{s.status !== 'verified' ? ' (unverified)' : ''}</option>)}</select></label>
        {[['section_code', 'Section / table code as paid'], ['legacy_ref', 'Legacy reference (label)'], ['nature', 'Nature of payment']].map(([k, l]) => <label key={k}><span style={S.label}>{l}</span><input value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} style={S.input} placeholder={k === 'section_code' ? 'e.g. 393(1) Table Sl. No. 6(i)' : ''} /></label>)}
        {[['principal', 'Principal TDS (₹)'], ['surcharge', 'Surcharge (₹)'], ['cess', 'Cess (₹)']].map(([k, l]) => <label key={k}><span style={S.label}>{l}</span><input type="number" min="0" step="0.01" value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} style={S.input} /></label>)}
      </div>
      {err && <Note tone="error" style={{ marginTop: 10 }}>{err}</Note>}
      <div style={{ ...S.row, marginTop: 12 }}><Btn kind="primary" onClick={save}>Save allocation</Btn><Btn kind="ghost" onClick={onClose}>Cancel</Btn></div>
    </Modal>
  );
}
