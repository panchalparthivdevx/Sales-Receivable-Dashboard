import React, { useCallback, useEffect, useState } from 'react';
import { api, errMsg, download, openFile } from './api';
import { C, S, Btn, Note, Modal, Area } from './ui';
import { Panel, DataTable, Badge, REVIEW_TONE, money, moneyOr } from './ui2';

// Monthly reconciliation inputs (V8): entered once here, read by the reports. Server: lib/recon.js (maker / checker enforced
// there). Blank = missing, 0 = confirmed zero. Uploaded ECR / returns / challans are evidence only — nothing is read from them.

const INFO = {
  GST: 'Enter net tax-head figures in ₹, including confirmed zero for unused heads. Positive adjusted GSTR-1 minus GSTR-3B variance means outward liability exceeds the comparable 3B amount. Net adjustments may be negative. Cash is the ledger debit for tax, not the challan deposit.',
  VENDOR: 'Enter monthly supplier filing status and mutually exclusive ITC buckets. Filing regularity is not a statutory eligibility verdict. Attribute a vendor hold only with a documented cause; statutorily blocked ITC (e.g. 17(5)) is not vendor non-compliance.',
  PF: 'Use the same employee key to align payroll and ECR rows. ECR has no basic-wage column: basic is context; compare payroll EPF wages with ECR EPF wages. Employer EPF and EPS are separate. Blank cells mean missing source, not zero.',
  ESIC: 'Confirm coverage and exemptions per employee. Contributory wages are not capped automatically. Rates and rounding are reviewable; the default per-member next-rupee calculation is indicative until checked against the portal.',
  TDS: 'Record liability by governing Act and the actual section code. Deposits are read from the section-wise register by company, TAN, liability month, Act and code — no allocation means unreconciled, not zero paid.',
  PT: 'Record state, PTRC / PTEC and the assessed period liability. No national PT rate is assumed. PTEC is the entity enrolment, not a payroll deduction.',
};
export const TYPE_EVIDENCE = { GST: 'return_file', VENDOR: 'working', PF: 'ecr_source', ESIC: 'esic_source', TDS: 'working', PT: 'challan' };

const regLabel = r => `${r.state ? `${r.state} · ` : ''}${r.number}`;

/** Calculation tables for one record (from the server's calc) */
export function ReconDetail({ r }) {
  const x = r.calc;
  if (!x) return <div style={S.muted}>Incomplete inputs — no calculation until every figure is entered.</div>;
  if (r.type === 'GST') return (
    <>
      <DataTable headers={['Tax head', 'GSTR-1 + 1A + scope adj.', '3B outward declared', 'Declaration variance', 'Outward paid (cash + ITC)', 'Payment variance', 'Total tax liability', 'Cash ledger debit', 'Credit ledger debit', 'Unsettled / excess']} numeric={[1, 2, 3, 4, 5, 6, 7, 8, 9]}
        rows={x.heads.map(h => [h.head, money(h.outward), money(h.declared), money(h.variance), money(h.outPaid), money(h.paidVariance), money(h.liability), money(h.cash), money(h.credit), money(h.gap)])} />
      <p style={{ ...S.muted, marginTop: 8 }}>Positive variance = first measure exceeds the comparator. Opposite tax-head differences are shown individually and never netted for alerts (absolute sum {money(x.absVariance)}). Interest and fees are excluded.</p>
    </>
  );
  if (r.type === 'PF') return (
    <>
      <DataTable headers={['Payroll expected incl. charges', 'ECR incl. charges', 'Payroll − ECR', 'Challan − ECR', 'Paid − challan']} numeric={[0, 1, 2, 3, 4]} rows={[[moneyOr(x.payroll), moneyOr(x.ecr), moneyOr(x.variance), moneyOr(x.challanGap), moneyOr(x.paidGap)]]} />
      <div style={{ height: 10 }} />
      <DataTable headers={['Employee', 'Payroll basic (context)', 'Gross Δ', 'EPF wage Δ', 'Employee PF Δ', 'Employer EPF Δ', 'Employer EPS Δ', 'Source completeness']} numeric={[1, 2, 3, 4, 5, 6]}
        rows={x.employees.map(e => [e.employee, moneyOr(e.basic), moneyOr(e.gross), moneyOr(e.wage), moneyOr(e.ee), moneyOr(e.er), moneyOr(e.eps), e.complete ? 'Both sources entered' : 'Unmatched / missing source'])} />
      <p style={{ ...S.muted, marginTop: 8 }}>Δ = payroll minus ECR. Basic is context only. Employer EPF and EPS are separate components — never enter the combined employer contribution in both.</p>
    </>
  );
  if (r.type === 'ESIC') return (
    <>
      <DataTable headers={['Contribution', 'Calculated expectation', 'Payroll', 'Portal member total', 'Challan', 'Payroll − challan', 'Expected − challan']} numeric={[1, 2, 3, 4, 5, 6]}
        rows={[['Employee', moneyOr(x.ee), moneyOr(x.pEE), moneyOr(x.portalEE), moneyOr(x.challanEE), moneyOr(x.payrollMinusChallanEE), moneyOr(x.expectedMinusChallanEE)], ['Employer', moneyOr(x.er), moneyOr(x.pER), moneyOr(x.portalER), moneyOr(x.challanER), moneyOr(x.payrollMinusChallanER), moneyOr(x.expectedMinusChallanER)]]} />
      <div style={{ height: 10 }} />
      <DataTable headers={['Employee', 'Covered / exempt EE, ER', 'ESI wages', 'Expected EE / ER', 'Payroll EE / ER', 'Portal EE / ER', 'Payroll − portal EE / ER']}
        rows={x.employees.map(e => [e.employee, `${e.covered} / ${e.eeExempt}, ${e.erExempt}`, moneyOr(e.wage), `${moneyOr(e.expectedEE)} / ${moneyOr(e.expectedER)}`, `${moneyOr(e.pEE)} / ${moneyOr(e.pER)}`, `${moneyOr(e.portalEE)} / ${moneyOr(e.portalER)}`, `${moneyOr(e.deltaEE)} / ${moneyOr(e.deltaER)}`])} />
      <p style={{ ...S.muted, marginTop: 8 }}>Rates {r.values.eeRate}% EE / {r.values.erRate}% ER · per member: {r.values.rounding}. Paid − challan: {moneyOr(x.paidMinusChallan)}. Unknown coverage or blank sources never produce a "matched" result.</p>
    </>
  );
  if (r.type === 'VENDOR') return (
    <DataTable headers={['Vendor', 'GSTR-1 / IFF', 'GSTR-3B', 'Invoice ITC', 'In GSTR-2B (info)', 'Eligible', 'Vendor hold', 'Statutory blocked', 'Other / unresolved']} numeric={[3, 4, 5, 6, 7, 8]}
      rows={[[`${r.values.vendor} / ${r.values.vendorGstin}`, x.s1, x.s3, moneyOr(x.invoiceITC), moneyOr(x.reflected), moneyOr(x.eligible), moneyOr(x.vendorHold), moneyOr(x.blocked), moneyOr(x.otherHold)]]} />
  );
  if (r.type === 'TDS') return (
    <DataTable headers={['Act / actual section', 'Deducted / payable', 'Principal deposited', 'Liability − deposits', 'Allocations']} numeric={[1, 2, 3, 4]}
      rows={x.lines.map(l => [`${l.act === '2025' ? '2025 Act' : l.act === '1961' ? '1961 Act' : l.act} / ${l.code}${l.alias && l.alias !== l.code ? ` (${l.alias})` : ''}`, moneyOr(l.liability), l.deposited === null ? 'No recorded allocations' : money(l.deposited), l.gap === null ? 'Unreconciled' : money(l.gap), l.allocations])} />
  );
  if (r.type === 'PT') return (
    <DataTable headers={['State / type', 'Payroll deductions', 'Assessed liability', 'Paid', 'Deduction − assessment', 'Assessment − paid', 'State rule source']} numeric={[1, 2, 3, 4, 5]}
      rows={[[`${x.state || '—'} / ${x.type}`, x.type === 'PTEC' ? 'Not applicable' : moneyOr(x.deducted), moneyOr(x.assessed), moneyOr(x.paid), x.type === 'PTEC' ? 'Not applicable' : moneyOr(x.deductionMinusAssessed), moneyOr(x.assessedMinusPaid), x.ruleSource || 'Not entered']]} />
  );
  return null;
}

/** "Monthly reporting inputs" card listing the saved records of some types */
export function InputCards({ types, ws, org, records, onOpen, onReports, canPrepare, illustrative }) {
  const ents = new Map(org.entities.map(e => [e.id, e]));
  const rows = records.filter(r => types.includes(r.type));
  return (
    <Panel title="Monthly reporting inputs" note="Enter the source figures once; the reconciliation reports use these saved records. They are separate from payment entries, so the same challan is never counted twice.">
      <div style={{ ...S.row, marginBottom: 12 }}>
        {types.map(t => <Btn key={t} kind="primary" onClick={() => onOpen(t, null)} disabled={!canPrepare || illustrative} title={illustrative ? 'Switch the dataset to "Recorded" to add your own inputs' : undefined}>+ {ws.recon.types[t]}</Btn>)}
        {onReports && <Btn kind="ghost" onClick={onReports}>View reports →</Btn>}
      </div>
      <DataTable headers={['Section / period', 'Company / registration', 'Status / completeness', 'Evidence', '']}
        rows={rows.map(r => [<><b>{ws.recon.types[r.type]}</b><br />{r.month}{r.values?.vendor ? ` · ${r.values.vendor}` : ''}</>, <>{ents.get(r.entity_id)?.short_code || '—'}<br /><small>{r.registration_number}</small></>,
          <><Badge tone={REVIEW_TONE[r.status]}>{ws.recon.statuses[r.status]}</Badge>{r.version > 1 && <Badge tone="grey">v{r.version}</Badge>}{r.illustrative && <Badge tone="amber">Illustrative</Badge>}<br /><small>{r.missing.length ? 'Needs inputs' : r.status === 'reviewed' ? `Reviewed by ${r.reviewed_by}` : 'Inputs entered; review required'}</small></>,
          `${r.evidence.length} source file(s)`, <Btn small onClick={() => onOpen(r.type, r.id)}>Edit / inspect</Btn>])} />
    </Panel>
  );
}

/** Editor dialog for one record (create / edit / submit / review / return / evidence) */
export function ReconEditor({ type, id, ws, org, meta, onClose, onSaved }) {
  const [rec, setRec] = useState(null);
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const grid = ws.recon.grid[type], fields = ws.recon.fields[type];
  const rights = meta.actor.rights;

  const fresh = useCallback(() => {
    const values = Object.fromEntries(fields.map(([k, , t, d]) => [k, d !== undefined ? String(d) : t.startsWith('select:') ? t.slice(7).split('|')[0] : '']));
    return { type, entity_id: org.entities[0]?.id || '', registration_id: '', month: '', values, rows: type === 'GST' ? ws.recon.gst_heads.map(head => Object.fromEntries(grid.map(([k]) => [k, k === 'head' ? head : '']))) : [], notes: '' };
  }, [type, fields, grid, org.entities, ws.recon.gst_heads]);
  useEffect(() => {
    if (!id) { setDraft(fresh()); return; }
    api.reconOne(id).then(r => { setRec(r.record); setDraft({ type: r.record.type, entity_id: r.record.entity_id, registration_id: r.record.registration_id, month: r.record.month, values: { ...r.record.values }, rows: r.record.rows.map(x => ({ ...x })), notes: r.record.notes, rev: r.record.rev }); }).catch(e => setErr(errMsg(e)));
  }, [id, fresh]);
  if (!draft) return <Modal title={ws.recon.types[type]} onClose={onClose} width={1100}>{err ? <Note tone="error">{err}</Note> : 'Loading…'}</Modal>;

  const regs = org.registrations.filter(r => r.entity_id === draft.entity_id && ws.recon.reg_of[type].includes(r.type));
  const locked = rec && rec.status !== 'draft' && !(correcting && rec.status === 'reviewed');
  const illustrative = !!rec?.illustrative;
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const setVal = (k, v) => setDraft(d => ({ ...d, values: { ...d.values, [k]: v } }));
  const setCell = (i, k, v) => setDraft(d => ({ ...d, rows: d.rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)) }));
  const addRow = () => setDraft(d => ({ ...d, rows: [...d.rows, Object.fromEntries(grid.map(([k, , t]) => [k, t.startsWith('select:') ? t.slice(7).split('|')[0] : '']))] }));
  const run = async (fn, okMsg) => {
    setBusy(true); setErr(''); setMsg('');
    try { const out = await fn(); if (out?.record) { setRec({ ...out.record }); setDraft(d => ({ ...d, rev: out.record.rev })); setCorrecting(false); } setMsg(okMsg); onSaved && onSaved(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const save = () => run(() => api.saveRecon(draft, rec?.id), 'Saved as a draft. Attach the source evidence, then submit for review.');
  const act = a => run(() => api.reconAct(rec.id, a, { rev: draft.rev, note }), a === 'submit' ? 'Submitted for review — a different person reviews it.' : a === 'review' ? 'Marked reviewed.' : 'Returned to the preparer.');
  const importCsv = async file => {
    if (!file) return;
    const f = new FormData(); f.append('file', file);
    try { const r = await api.reconImport(type, f); setDraft(d => ({ ...d, rows: r.rows })); setMsg(`Imported ${r.rows.length} rows into the draft. Review and save; no source file has been attached.`); } catch (e) { setErr(errMsg(e)); }
  };
  const uploadEvidence = async file => {
    if (!file || !rec) return;
    const f = new FormData();
    f.append('entity_id', rec.entity_id); f.append('kind', TYPE_EVIDENCE[type]); f.append('module', 'recon'); f.append('record_id', rec.id); f.append('file', file);
    await run(async () => { await api.uploadFile(f); return api.reconOne(rec.id); }, 'Evidence attached (encrypted; the same file is stored once).');
  };
  const field = ([k, l, t]) => {
    const v = draft.values[k] ?? '';
    const dis = locked || illustrative;
    if (t.startsWith('select:')) return <label key={k}><span style={S.label}>{l}</span><select disabled={dis} value={v} onChange={e => setVal(k, e.target.value)} style={S.input}>{t.slice(7).split('|').map(o => <option key={o}>{o}</option>)}</select></label>;
    return <label key={k}><span style={S.label}>{l}</span><input disabled={dis} type={t === 'number' || t === 'signed' ? 'number' : t} min={t === 'number' ? 0 : undefined} step="0.01" value={v} placeholder={t === 'number' || t === 'signed' ? 'Blank = not entered; 0 = confirmed zero' : ''} onChange={e => setVal(k, e.target.value)} style={S.input} /></label>;
  };
  return (
    <Modal title={`${ws.recon.types[type]}${rec ? ` · ${rec.registration_number} · ${rec.month}` : ''}`} onClose={onClose} width={1180}>
      <p style={{ ...S.muted, marginTop: 0 }}>{INFO[type]}</p>
      {illustrative && <Note tone="demo">Illustrative record — invented figures, shown for review only. Add your own record in the recorded dataset.</Note>}
      {rec && <div style={{ ...S.row, marginBottom: 10 }}><Badge tone={REVIEW_TONE[rec.status]}>{ws.recon.statuses[rec.status]}</Badge><Badge tone="grey">Version {rec.version}</Badge><span style={S.muted}>Prepared by {rec.prepared_by || '—'} · Reviewer {rec.reviewed_by || '—'}</span></div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, background: '#FAFBFE', border: '1px solid #EDF0F6', borderRadius: 12, padding: 14 }}>
        <label><span style={S.label}>Company</span><select disabled={!!rec} value={draft.entity_id} onChange={e => setDraft(d => ({ ...d, entity_id: e.target.value, registration_id: '' }))} style={S.input}>{org.entities.map(e => <option key={e.id} value={e.id}>{e.short_code} — {e.legal_name}</option>)}</select></label>
        <label><span style={S.label}>{type === 'GST' || type === 'VENDOR' ? 'Recipient GSTIN' : type === 'TDS' ? 'TAN' : 'Registration'}</span><select disabled={locked || illustrative} value={draft.registration_id} onChange={e => set('registration_id', e.target.value)} style={S.input}><option value="">Choose…</option>{regs.map(r => <option key={r.id} value={r.id}>{regLabel(r)}</option>)}</select>{!regs.length && <span style={S.small}>This company has no {type === 'TDS' ? 'TAN' : type} registration — add it in Companies &amp; GSTINs.</span>}</label>
        <label><span style={S.label}>Liability / wage month</span><input disabled={locked || illustrative} type="month" value={draft.month} onChange={e => set('month', e.target.value)} style={S.input} /></label>
        {fields.map(field)}
      </div>
      {grid && (
        <div style={{ marginTop: 14 }}>
          <div style={{ ...S.row, marginBottom: 8 }}>
            {type !== 'GST' && <Btn small onClick={addRow} disabled={locked || illustrative}>+ Add {type === 'TDS' ? 'section' : 'employee'} row</Btn>}
            <Btn small kind="ghost" onClick={() => download(`/recon-template/${type}.csv`, {}, `${type}_template.csv`).catch(e => setErr(errMsg(e)))}>Download CSV template</Btn>
            <label style={{ ...S.muted, display: 'inline-flex', gap: 6, alignItems: 'center' }}>Import completed template CSV <input type="file" accept=".csv" disabled={locked || illustrative} onChange={e => importCsv(e.target.files[0])} /></label>
          </div>
          <div className="c2-scroll" style={{ overflow: 'auto', maxHeight: 340, border: `1px solid ${C.border}`, borderRadius: 10 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>{grid.map(([k, l]) => <th key={k} style={{ ...S.th, whiteSpace: 'normal', minWidth: 110 }}>{l}</th>)}{type !== 'GST' && <th style={S.th} />}</tr></thead>
              <tbody>
                {draft.rows.length === 0 && <tr><td colSpan={grid.length + 1} style={{ ...S.td, color: C.muted, textAlign: 'center' }}>No rows — add rows, import the template, or send a payroll import here.</td></tr>}
                {draft.rows.map((row, i) => (
                  <tr key={i}>
                    {grid.map(([k, l, t]) => (
                      <td key={k} style={{ ...S.td, padding: 4 }}>
                        {t.startsWith('select:')
                          ? <select aria-label={`${l} row ${i + 1}`} disabled={locked || illustrative} value={row[k]} onChange={e => setCell(i, k, e.target.value)} style={{ ...S.input, padding: 5 }}>{t.slice(7).split('|').map(o => <option key={o}>{o}</option>)}</select>
                          : <input aria-label={`${l} row ${i + 1}`} disabled={locked || illustrative || (type === 'GST' && k === 'head')} type={t === 'number' || t === 'signed' ? 'number' : 'text'} step="0.01" value={row[k] ?? ''} onChange={e => setCell(i, k, e.target.value)} style={{ ...S.input, padding: 5, minWidth: 90 }} />}
                      </td>
                    ))}
                    {type !== 'GST' && <td style={{ ...S.td, padding: 4 }}><Btn small kind="ghost" disabled={locked || illustrative} onClick={() => setDraft(d => ({ ...d, rows: d.rows.filter((_, j) => j !== i) }))}>Remove</Btn></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={S.small}>CSV uses the exact template headers; blank numeric cells stay missing. Import replaces the draft grid after validation. Uploaded native ECR / PDF / challan files are evidence only — nothing is extracted from them automatically.</p>
        </div>
      )}
      <label style={{ display: 'block', marginTop: 12 }}><span style={S.label}>Cause, scope / exemption rationale and corrective action</span><Area disabled={locked || illustrative} value={draft.notes} onChange={e => set('notes', e.target.value)} /></label>
      <div style={{ marginTop: 12, ...S.row }}>
        <span style={S.label}>Source evidence</span>
        {(rec?.files || []).map(f => <Btn key={f.id} small kind="ghost" onClick={() => openFile(f.id).catch(e => setErr(errMsg(e)))}>{f.name}{f.sample ? ' (sample)' : ''}</Btn>)}
        {!rec?.files?.length && <span style={S.muted}>None yet.</span>}
        {rec && !locked && !illustrative && rights.prepare && <label style={{ ...S.muted, display: 'inline-flex', gap: 6, alignItems: 'center' }}>Attach (PDF, image, CSV, XLSX, TXT) <input type="file" onChange={e => uploadEvidence(e.target.files[0])} /></label>}
        {!rec && <span style={S.small}>Save the draft first, then attach evidence.</span>}
      </div>
      {err && <Note tone="error" style={{ marginTop: 12 }}>{err}</Note>}
      {msg && <Note tone="ok" style={{ marginTop: 12 }}>{msg}</Note>}
      {!illustrative && <div style={{ ...S.row, marginTop: 14, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
        {(!rec || rec.status === 'draft' || correcting) && rights.prepare && <Btn kind="primary" disabled={busy} onClick={save}>{correcting ? 'Save as a new version' : 'Save reporting inputs'}</Btn>}
        {rec?.status === 'reviewed' && rights.prepare && !correcting && <Btn disabled={busy} onClick={() => setCorrecting(true)} title="Saving creates a new draft version; the reviewed figures stay in the history">Correct (new version)</Btn>}
        {rec?.status === 'draft' && rights.prepare && <Btn disabled={busy} onClick={() => act('submit')}>Submit for review</Btn>}
        {rec?.status === 'ready_for_review' && (rights.review || rights.approve) && <Btn kind="primary" disabled={busy} onClick={() => act('review')}>Mark reviewed</Btn>}
        {rec?.status === 'ready_for_review' && (rights.review || rights.approve) && <><input value={note} onChange={e => setNote(e.target.value)} placeholder="Why it goes back (required to return)" style={{ ...S.input, width: 280 }} /><Btn kind="danger" disabled={busy} onClick={() => act('return')}>Return to preparer</Btn></>}
      </div>}
      {rec && <div style={{ marginTop: 14 }}><h4 style={{ margin: '0 0 8px', fontSize: 13 }}>Calculation</h4><ReconDetail r={rec} /></div>}
      {rec?.history?.length > 0 && <details style={{ marginTop: 12 }}><summary style={{ cursor: 'pointer', fontSize: 12, color: C.muted }}>Change history</summary><ul style={{ fontSize: 12, color: C.muted }}>{rec.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · {h.by} · {h.action} → {ws.recon.statuses[h.status] || h.status}{h.note ? ` — ${h.note}` : ''}</li>)}</ul></details>}
    </Modal>
  );
}

/** Loads recon records of some types for a dataset; returns [records, reload] */
export function useRecon(types, dataset, stamp) {
  const [recs, setRecs] = useState([]);
  const [err, setErr] = useState('');
  const key = types.join(',');
  const load = useCallback(() => api.recon({ types: key, dataset }).then(r => setRecs(r.records)).catch(e => setErr(errMsg(e))), [key, dataset]);
  useEffect(() => { load(); }, [load, stamp]);
  return [recs, load, err];
}
