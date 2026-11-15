import React, { useCallback, useEffect, useState } from 'react';
import { api, errMsg, openFile } from './api';
import { S, Btn, Note, Modal, Empty, dt } from './ui';
import { Hero, Pills, Stats, Panel, Notice, DataTable, HBars, Toolbar, PrintBtn, Filters, FSel, FInput, Badge, downloadCsv, money, moneyOr, fyLabel } from './ui2';

// Annual tax-audit working papers (V10) — server: lib/taxAudit.js. Liability lots, paid challans explicitly allocated to lots
// (never spread equally), and the employee 20(b) / opening 26(A) / current 26(B) schedules. Working papers only — not filed forms.

const SUB = [['employee', 'Employee contribution · 20(b)'], ['opening', 'Opening liabilities · 26(A)'], ['current', 'Current liabilities · 26(B)'], ['allocations', 'Payment allocations']];
const prevFy = today => { const y = +today.slice(0, 4), m = +today.slice(5, 7); const s = (m >= 4 ? y : y - 1) - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

export default function TaxAuditTab(props) { return <TaxAuditView {...props} />; }

export function TaxAuditView({ meta, org, ws, demo, stamp, embedded, onChanged }) {
  const [sub, setSub] = useState('employee');
  const [fy, setFy] = useState(() => prevFy(meta.today));
  const [entity, setEntity] = useState('');
  const [asOf, setAsOf] = useState(meta.today);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [lotForm, setLotForm] = useState(null);
  const [payForm, setPayForm] = useState(null);
  const [cutForm, setCutForm] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => { setErr(''); return api.taxaudit({ fy, entity_ids: entity, as_of: asOf }).then(setData).catch(e => setErr(errMsg(e))); }, [fy, entity, asOf]);
  useEffect(() => { load(); }, [load, stamp]);
  const fys = (() => { const s = +prevFy(meta.today).slice(0, 4); return [s - 1, s, s + 1].map(y => `${y}-${String((y + 1) % 100).padStart(2, '0')}`); })();
  const r = meta.actor.rights;
  const nameOf = id => org.entities.find(e => e.id === id)?.short_code || '—';
  const regOf = id => org.registrations.find(x => x.id === id)?.number || '—';
  const done = m => { setMsg(m); load(); onChanged && onChanged(); };
  const act = async (fn, m) => { setErr(''); try { await fn(); done(m); } catch (e) { setErr(errMsg(e)); } };

  if (!data) return <div>{!embedded && <Hero eyebrow="TAX AUDIT" title="Annual tax-audit working papers" sub="Employee contributions, opening and current statutory liabilities, and the paid challans allocated to them." />}{err ? <Note tone="error">{err}</Note> : <Empty>Loading…</Empty>}</div>;
  const sc = data.schedules, k = sc.kpis;
  const context = { Report: SUB.find(s => s[0] === sub)[1], 'Financial year': fyLabel(fy), Company: entity ? nameOf(entity) : 'All', 'As of': asOf, Form: sc.form.form, Basis: 'Review working paper; verified paid-challan allocations only; not a filed form', Generated: `${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST` };
  const csv = () => {
    if (sub === 'employee') return downloadCsv(`Tax_audit_20b_${fy}.csv`, context, ['Company', 'Registration', 'Fund', 'Wage month', 'Received from employees', 'Effective due date', 'Due basis', 'Paid (verified allocations)', 'Payment dates / references', 'On time', 'Late', 'Unpaid', 'Potential disallowance', 'Status'],
      sc.employee.map(x => (x.lot ? [nameOf(x.entity_id), regOf(x.registration_id), x.kind, x.month, x.lot.amount, x.calc.due || 'Not entered', x.calc.due_kind || '', x.calc.paid, x.calc.payments.map(p => `${p.paid} ${p.ref} ${p.amount}`).join('; '), x.calc.on ?? '', x.calc.late ?? '', x.calc.unpaid, x.calc.exposure ?? 'Unresolved', x.calc.state] : [nameOf(x.entity_id), regOf(x.registration_id), x.kind, x.month, 'Not entered', '', '', '', '', '', '', '', '', 'No input for this month'])));
    if (sub === 'allocations') return downloadCsv(`Tax_audit_allocations_${fy}.csv`, context, ['Company', 'Reference', 'Paid date', 'Basis', 'Verified', 'Total', 'Allocated', 'Unallocated', 'Lines'], data.payments.map(p => [nameOf(p.entity_id), p.reference, p.paid_date, p.basis, p.verified ? 'Yes' : 'No', p.total, p.allocated, p.unallocated, p.lines.map(l => `${l.kind} ${l.month}: ${l.amount}`).join('; ')]));
    const list = sub === 'opening' ? sc.opening : sc.current;
    return downloadCsv(`Tax_audit_${sub === 'opening' ? '26A' : '26B'}_${fy}.csv`, context, ['Company', 'Registration', 'Kind', 'State', 'Month', 'Liability', 'Prior treatment', 'Paid in FY', 'Paid after FY up to cut-off', 'Closing at 31 March', 'Beyond cut-off', 'Deduction claimed', 'Adjustment', 'Status'],
      list.map(x => [nameOf(x.lot.entity_id), regOf(x.lot.registration_id), x.lot.kind, x.lot.state, x.lot.month, x.lot.amount, x.lot.prior, x.calc.inFY, x.calc.after ?? 'Cut-off not set', x.calc.closing, x.calc.unpaidCutoff ?? '', x.lot.deduction, x.calc.adjustment ?? '', x.calc.state]));
  };
  const lotRow = x => (
    <>{x.lot.classification === 'approved' ? <Badge tone="green">Classification approved</Badge> : <Badge tone="amber">Classification pending</Badge>}
      {r.prepare && <Btn small kind="ghost" onClick={() => setLotForm(x.lot)}>Edit</Btn>}
      {x.lot.classification !== 'approved' && (r.review || r.approve) && <Btn small onClick={() => act(() => api.approveLot(x.lot.id), 'Classification approved.')}>Approve</Btn>}</>
  );
  return (
    <div>
      {!embedded && <Hero eyebrow="TAX AUDIT" title="Annual tax-audit working papers" sub="Employee contributions (36(1)(va)), opening and current statutory liabilities (43B), and the paid challans explicitly allocated to them." tag={sc.form.form} tagSub={`${fyLabel(fy)} · as of ${dt(asOf)}`} />}
      <Pills items={SUB} value={sub} onChange={setSub} label="Tax audit schedules" />
      <Filters>
        <FSel label="Financial year" value={fy} onChange={setFy} options={fys.map(f => [f, fyLabel(f)])} width={130} />
        <FSel label="Company" value={entity} onChange={setEntity} options={org.entities.map(e => [e.id, `${e.short_code} — ${e.legal_name}`])} placeholder="All companies" width={240} />
        <FInput label="As of" type="date" value={asOf} onChange={setAsOf} width={160} />
      </Filters>
      <Notice><b>{sc.form.mapped ? 'Working papers — not filed forms.' : 'UNMAPPED YEAR.'}</b> {sc.form.note} Only verified payments on a paid-challan / bank basis count; TRRN generation alone is not payment. Missing due-date review or evidence is unresolved, not compliant.{demo ? ' Demo: illustrative amounts and dates only.' : ''}</Notice>
      {!sc.form.mapped && <Notice tone="red">{sc.form.form}: clause references are working labels only — verify the current form and section mapping before relying on any export.</Notice>}
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      <Toolbar>
        {r.prepare && <Btn kind="primary" onClick={() => setLotForm({ fy })}>+ Liability (lot)</Btn>}
        {(r.prepare || r.file) && <Btn onClick={() => setPayForm({})}>+ Paid challan with allocations</Btn>}
        <Btn kind="ghost" onClick={() => setCutForm(true)}>Return due date (cut-off)</Btn>
        <Btn kind="ghost" onClick={csv}>Export this schedule · CSV</Btn><PrintBtn />
      </Toolbar>
      {sub === 'employee' && <>
        <Stats items={[{ label: 'Received from employees', value: money(k.employee_received), sub: `${sc.employee.filter(x => x.lot).length} monthly lots` }, { label: 'Paid after the due date', value: money(k.employee_late), sub: 'Each allocation judged on its own date' }, { label: 'Unpaid', value: money(k.employee_unpaid), sub: 'Pending until due; then late' }, { label: 'Potential 36(1)(va) exposure', value: money(k.employee_exposure), sub: `${k.employee_unresolved} lot(s) need due-date / classification review` }]} />
        <Panel title={`${sc.form.clauses.employee} · employee contributions`} note="Payment on the due date is on time. Wage month and receipt date are kept apart; a cross-year wage month appears in its receipt year. Months without input show as “not entered”.">
          <DataTable headers={['Company / registration', 'Fund', 'Wage month', 'Received from employees', 'Effective due date', 'Employee share paid', 'Payment date / reference', 'Delay', 'Flag', '']} numeric={[3, 5]}
            rows={sc.employee.map(x => (x.lot ? [`${nameOf(x.entity_id)} / ${regOf(x.registration_id)}`, x.kind, x.month, money(x.lot.amount), <>{x.calc.due ? dt(x.calc.due) : 'Not entered'}<br /><small>{x.calc.due_kind || ''}{x.lot.due_verified ? ' · verified' : ' · not verified'}</small></>,
              x.calc.payments.length ? x.calc.payments.map((p, i) => <div key={i}>{money(p.amount)}</div>) : 'No verified paid allocation', x.calc.payments.length ? x.calc.payments.map((p, i) => <div key={i}>{dt(p.paid)} · {p.ref}</div>) : '—',
              x.calc.payments.length ? x.calc.payments.map((p, i) => <div key={i}>{p.delay_days === null ? 'Unconfirmed' : `${p.delay_days} days`}</div>) : '—',
              x.calc.ready ? <>Late {money(x.calc.late)}<br />Unpaid {money(x.calc.unpaid)}<br /><b>Exposure {moneyOr(x.calc.exposure, '—')}</b></> : <Badge tone="amber">Due date / classification needs review</Badge>, lotRow(x)]
              : [`${nameOf(x.entity_id)} / ${regOf(x.registration_id)}`, x.kind, x.month, 'Not entered', '—', '—', '—', '—', 'No input for this month', '']))} />
        </Panel>
      </>}
      {sub === 'opening' && <>
        <Stats items={[{ label: 'Opening unpaid at 1 April', value: money(k.opening_total), sub: `${sc.opening.length} lot(s)` }, { label: 'Paid during the FY', value: money(k.opening_paid), sub: 'Verified allocations' }, { label: 'Still unpaid at year end', value: money(k.opening_total - k.opening_paid), sub: 'Never added back twice' }, { label: 'Unverified payments', value: money(k.unverified), sub: 'Not counted until verified' }]} />
        <Panel title={`${sc.form.clauses.opening} · opening employer liabilities`} note="A balance disallowed earlier may become deductible on payment; the same outstanding amount is never added back again.">
          <DataTable headers={['Company / registration', 'Kind', 'Month', 'Unpaid at 1 April', 'Prior treatment', 'Paid during FY', 'Year-end unpaid', 'Status', '']} numeric={[3, 5, 6]}
            rows={sc.opening.map(x => [`${nameOf(x.lot.entity_id)} / ${regOf(x.lot.registration_id)}`, x.lot.kind, x.lot.month, money(x.lot.amount), x.lot.prior || '—', money(x.calc.inFY), money(x.calc.closing), x.calc.state, lotRow(x)])} />
        </Panel>
      </>}
      {sub === 'current' && <>
        <Stats items={[{ label: 'Incurred in the FY', value: money(k.current_total), sub: `${sc.current.length} lot(s)` }, { label: 'Paid by 31 March', value: money(k.current_paid_fy), sub: 'Verified allocations' }, { label: 'Paid after year end, by cut-off', value: money(k.current_after), sub: 'Company-specific verified 139(1) date' }, { label: 'Remaining beyond cut-off', value: money(k.current_beyond), sub: 'Provisional until the cut-off is confirmed and passed' }]} />
        <Panel title="By component"><HBars entries={sc.by_kind.map(b => [b.kind, b.amount])} /></Panel>
        <Panel title={`${sc.form.clauses.current} · current-year employer liabilities`} note="Only amounts claimed as a deduction with an approved classification produce an adjustment. PT withheld from employees and not claimed in the P&L never creates a duplicate addback. PF admin charges need a reviewed classification.">
          <DataTable headers={['Company / registration', 'Kind', 'State', 'Month', 'Incurred', 'Paid by 31 March', 'Paid after, by cut-off', 'Beyond cut-off', 'Claimed', 'Adjustment', 'Status', '']} numeric={[4, 5, 6, 7, 9]}
            rows={sc.current.map(x => [`${nameOf(x.lot.entity_id)} / ${regOf(x.lot.registration_id)}`, x.lot.kind, x.lot.state || '—', x.lot.month, money(x.lot.amount), money(x.calc.inFY), x.calc.after === null ? 'Cut-off not set' : money(x.calc.after), x.calc.unpaidCutoff === null ? '—' : money(x.calc.unpaidCutoff), x.lot.deduction === 'yes' ? 'Yes' : 'No', moneyOr(x.calc.adjustment, '—'), x.calc.state, lotRow(x)])} />
        </Panel>
      </>}
      {sub === 'allocations' && <Panel title="Paid challans and their allocations" note="Every allocation is entered explicitly — a consolidated challan is never spread equally. Allocations cannot exceed the challan or the liability. A verified payment is locked.">
        <DataTable headers={['Company', 'Reference / basis', 'Paid date', 'Total', 'Allocated', 'Unallocated', 'Lines', 'Proof', 'Verification']} numeric={[3, 4, 5]}
          rows={data.payments.map(p => [nameOf(p.entity_id), <>{p.reference}{p.status === 'reversed' && <Badge tone="red">Reversed</Badge>}<br /><small>{p.basis === 'trrn_only' ? 'TRRN generation only — not payment' : 'Paid challan / bank'}</small></>, dt(p.paid_date), money(p.total), money(p.allocated), money(p.unallocated),
            p.lines.map((l, i) => <div key={i}>{l.kind} {l.month}: {money(l.amount)}</div>), p.proof.length ? p.proof.map(id => <Btn key={id} small kind="ghost" onClick={() => openFile(id).catch(() => {})}>Open</Btn>) : <Badge tone="amber">No proof</Badge>,
            <>{p.verified ? <Badge tone="green">Verified by {p.verified_by}</Badge> : <Badge tone="amber">Unverified</Badge>}<br />
              {!p.verified && p.status !== 'reversed' && (r.review || r.verify || r.approve) && <Btn small onClick={() => act(() => api.verifyTaPayment(p.id, true), 'Payment verified.')}>Verify</Btn>}
              {p.verified && (r.review || r.verify || r.approve) && <Btn small kind="ghost" onClick={() => act(() => api.verifyTaPayment(p.id, false), 'Verification removed.')}>Un-verify</Btn>}
              {!p.verified && p.status !== 'reversed' && (r.prepare || r.file) && <ProofUpload payment={p} onDone={() => done('Proof attached.')} onErr={setErr} />}</>])} />
      </Panel>}
      <Panel title="Scope & audit treatment" note="Review working papers, not filed tax-audit forms. Employee PF / ESIC is outside the employer 43B schedules. Verify against Form 3CD, the Checkmate Services judgment (12 October 2022), EPFO ECR documentation and the Income Tax Department's year-specific form guidance before use." />
      {lotForm && <LotForm init={lotForm} org={org} ws={ws} fys={fys} onClose={() => setLotForm(null)} onSaved={() => { setLotForm(null); done('Liability saved.'); }} />}
      {payForm && <PaymentForm org={org} lots={data.lots} onClose={() => setPayForm(null)} onSaved={m => { setPayForm(null); done(m); }} />}
      {cutForm && <CutoffForm org={org} fy={fy} settings={data.settings} meta={meta} onClose={() => setCutForm(false)} onSaved={m => { setCutForm(false); done(m); }} />}
    </div>
  );
}

function ProofUpload({ payment, onDone, onErr }) {
  const up = async file => {
    if (!file) return;
    const f = new FormData(); f.append('entity_id', payment.entity_id); f.append('kind', 'bank_proof'); f.append('module', 'taxaudit_payment'); f.append('record_id', payment.id); f.append('file', file);
    try { await api.uploadFile(f); onDone(); } catch (e) { onErr(errMsg(e)); }
  };
  return <label style={{ fontSize: 11, color: '#738097' }}>Attach proof <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={e => up(e.target.files[0])} style={{ width: 160 }} /></label>;
}

function LotForm({ init, org, ws, fys, onClose, onSaved }) {
  const [f, setF] = useState({ entity_id: org.entities[0]?.id || '', registration_id: '', fy: fys[1], opening: false, kind: ws.taxaudit.kinds[0], month: '', received: '', baseline: '', extended: '', due_source: '', due_verified: false, deduction: 'yes', prior: '', state: '', amount: '', notes: '', ...init });
  const [err, setErr] = useState('');
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const regs = org.registrations.filter(r => r.entity_id === f.entity_id && (f.kind.includes('ESIC') ? r.type === 'ESIC' : f.kind.startsWith('Professional') ? r.type.startsWith('PT_') : r.type === 'PF'));
  const save = async () => { setErr(''); try { await api.saveLot(f, init.id); onSaved(); } catch (e) { setErr(errMsg(e)); } };
  const inp = (k, l, type = 'text') => <label><span style={S.label}>{l}</span><input type={type} value={f[k] ?? ''} onChange={e => set(k, e.target.value)} style={S.input} /></label>;
  return (
    <Modal title={init.id ? 'Edit liability' : 'Add a liability (lot)'} onClose={onClose} width={820}>
      <p style={{ ...S.muted, marginTop: 0 }}>One lot per company, registration, component and wage month. The receipt / incurrence date decides the year. An allocated lot cannot change identity.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, background: '#FAFBFE', border: '1px solid #EDF0F6', borderRadius: 12, padding: 14 }}>
        <label><span style={S.label}>Company</span><select value={f.entity_id} onChange={e => setF(x => ({ ...x, entity_id: e.target.value, registration_id: '' }))} style={S.input}>{org.entities.map(e => <option key={e.id} value={e.id}>{e.short_code}</option>)}</select></label>
        <label><span style={S.label}>Financial year</span><select value={f.fy} onChange={e => set('fy', e.target.value)} style={S.input}>{fys.map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}</select></label>
        <label><span style={S.label}>Component</span><select value={f.kind} onChange={e => setF(x => ({ ...x, kind: e.target.value, registration_id: '' }))} style={S.input}>{ws.taxaudit.kinds.map(k => <option key={k}>{k}</option>)}</select></label>
        <label><span style={S.label}>Registration</span><select value={f.registration_id} onChange={e => set('registration_id', e.target.value)} style={S.input}><option value="">Choose…</option>{regs.map(r => <option key={r.id} value={r.id}>{r.state ? `${r.state} · ` : ''}{r.number}</option>)}</select></label>
        <label><span style={S.label}>Schedule</span><select value={f.opening ? 'yes' : 'no'} onChange={e => set('opening', e.target.value === 'yes')} style={S.input}><option value="no">Current year</option><option value="yes">Opening (unpaid at 1 April)</option></select></label>
        {inp('month', 'Wage / liability month', 'month')}{inp('received', 'Date received from employees / incurred', 'date')}{inp('amount', 'Amount (₹)', 'number')}
        {inp('baseline', 'Original statutory due date', 'date')}{inp('extended', 'Notified extension (if any)', 'date')}{inp('due_source', 'Due-date source / notification')}
        <label><span style={S.label}>Due date verified</span><select value={f.due_verified ? 'yes' : 'no'} onChange={e => set('due_verified', e.target.value === 'yes')} style={S.input}><option value="no">No</option><option value="yes">Yes — source checked</option></select></label>
        <label><span style={S.label}>Claimed as a deduction</span><select value={f.deduction} onChange={e => set('deduction', e.target.value)} style={S.input}><option value="yes">Yes</option><option value="no">No</option></select></label>
        {f.opening && inp('prior', 'Prior-year tax treatment')}
        {f.kind.startsWith('Professional') && inp('state', 'PT state / jurisdiction')}
        {inp('notes', 'Notes')}
      </div>
      <p style={S.small}>The classification is approved by another person (Approve on the schedule). Changing an approved amount or due date sends it back for review.</p>
      {err && <Note tone="error">{err}</Note>}
      <div style={S.row}><Btn kind="primary" onClick={save}>Save liability</Btn><Btn kind="ghost" onClick={onClose}>Cancel</Btn></div>
    </Modal>
  );
}

function PaymentForm({ org, lots, onClose, onSaved }) {
  const [f, setF] = useState({ entity_id: org.entities[0]?.id || '', reference: '', paid_date: '', basis: 'paid_challan', total: '' });
  const [alloc, setAlloc] = useState({});
  const [file, setFile] = useState(null);
  const [err, setErr] = useState('');
  const own = lots.filter(l => l.entity_id === f.entity_id && l.status !== 'withdrawn');
  const save = async () => {
    setErr('');
    try {
      const { result } = await api.saveTaPayment({ ...f, allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([lot_id, amount]) => ({ lot_id, amount })) });
      if (file) { const fd = new FormData(); fd.append('entity_id', result.entity_id); fd.append('kind', 'bank_proof'); fd.append('module', 'taxaudit_payment'); fd.append('record_id', result.id); fd.append('file', file); await api.uploadFile(fd); }
      onSaved('Payment recorded. Another person verifies it against the paid challan / bank statement.');
    } catch (e) { setErr(errMsg(e)); }
  };
  return (
    <Modal title="Paid challan with component allocations" onClose={onClose} width={860}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, background: '#FAFBFE', border: '1px solid #EDF0F6', borderRadius: 12, padding: 14 }}>
        <label><span style={S.label}>Company</span><select value={f.entity_id} onChange={e => { setF(x => ({ ...x, entity_id: e.target.value })); setAlloc({}); }} style={S.input}>{org.entities.map(e => <option key={e.id} value={e.id}>{e.short_code}</option>)}</select></label>
        <label><span style={S.label}>Challan / TRRN / UTR reference</span><input value={f.reference} onChange={e => setF(x => ({ ...x, reference: e.target.value }))} style={S.input} /></label>
        <label><span style={S.label}>Actual payment date</span><input type="date" value={f.paid_date} onChange={e => setF(x => ({ ...x, paid_date: e.target.value }))} style={S.input} /></label>
        <label><span style={S.label}>Basis</span><select value={f.basis} onChange={e => setF(x => ({ ...x, basis: e.target.value }))} style={S.input}><option value="paid_challan">Paid challan date (bank)</option><option value="trrn_only">TRRN generation only (not payment)</option></select></label>
        <label><span style={S.label}>Paid / challan total (₹)</span><input type="number" value={f.total} onChange={e => setF(x => ({ ...x, total: e.target.value }))} style={S.input} /></label>
        <label><span style={S.label}>Paid challan / bank proof</span><input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={e => setFile(e.target.files[0] || null)} /></label>
      </div>
      <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>Allocate to liabilities</h4>
      <DataTable headers={['Component', 'Month', 'Schedule', 'Liability', 'Already allocated', 'Remaining', 'Allocate now (₹)']} numeric={[3, 4, 5]}
        rows={own.map(l => [l.kind, l.month, l.opening ? 'Opening' : 'Current', money(l.amount), money(l.allocated), money(l.amount - l.allocated), <input type="number" min="0" step="0.01" value={alloc[l.id] || ''} onChange={e => setAlloc(a => ({ ...a, [l.id]: e.target.value }))} style={{ ...S.input, width: 120 }} aria-label={`Allocate to ${l.kind} ${l.month}`} />])}
        empty="This company has no liabilities yet — add a lot first." />
      {err && <Note tone="error" style={{ marginTop: 10 }}>{err}</Note>}
      <div style={{ ...S.row, marginTop: 12 }}><Btn kind="primary" onClick={save}>Save payment</Btn><Btn kind="ghost" onClick={onClose}>Cancel</Btn></div>
    </Modal>
  );
}

function CutoffForm({ org, fy, settings, meta, onClose, onSaved }) {
  const [entity, setEntity] = useState(org.entities[0]?.id || '');
  const cur = settings.find(s => s.entity_id === entity && s.fy === fy);
  const [cutoff, setCutoff] = useState(cur?.cutoff || '');
  const [source, setSource] = useState(cur?.source || '');
  const [err, setErr] = useState('');
  useEffect(() => { setCutoff(cur?.cutoff || ''); setSource(cur?.source || ''); }, [entity, cur?.cutoff, cur?.source]);
  const save = async confirmed => { setErr(''); try { await api.saveCutoff({ entity_id: entity, fy, cutoff, source, confirmed }); onSaved(confirmed ? 'Cut-off confirmed.' : 'Cut-off saved — another person confirms it.'); } catch (e) { setErr(errMsg(e)); } };
  return (
    <Modal title={`Return due date (section 139(1) cut-off) · ${fyLabel(fy)}`} onClose={onClose} width={620}>
      <p style={{ ...S.muted, marginTop: 0 }}>No universal ITR date is assumed: enter the company's own due date and its source. Balances before the confirmed cut-off are provisional.</p>
      <div style={{ display: 'grid', gap: 12 }}>
        <label><span style={S.label}>Company</span><select value={entity} onChange={e => setEntity(e.target.value)} style={S.input}>{org.entities.map(e => <option key={e.id} value={e.id}>{e.short_code} — {e.legal_name}</option>)}</select></label>
        <label><span style={S.label}>Cut-off date</span><input type="date" value={cutoff} onChange={e => setCutoff(e.target.value)} style={S.input} /></label>
        <label><span style={S.label}>Source (notification / audit applicability)</span><input value={source} onChange={e => setSource(e.target.value)} style={S.input} /></label>
      </div>
      {cur && <p style={S.muted}>Saved by {cur.set_by}{cur.confirmed ? ` · confirmed by ${cur.confirmed_by}` : ' · not yet confirmed'}</p>}
      {err && <Note tone="error">{err}</Note>}
      <div style={S.row}>
        <Btn kind="primary" onClick={() => save(false)}>Save cut-off</Btn>
        {cur && !cur.confirmed && cur.cutoff === cutoff && cur.source === source && (meta.actor.rights.review || meta.actor.rights.approve) && <Btn onClick={() => save(true)}>Confirm (another person)</Btn>}
        <Btn kind="ghost" onClick={onClose}>Close</Btn>
      </div>
    </Modal>
  );
}
