import React, { useCallback, useEffect, useState } from 'react';
import { api, errMsg, openFile } from './api';
import { S, Btn, Note, Modal } from './ui';
import { Hero, Stats, Panel, Notice, DataTable, Filters, FSel, FInput, Badge, money, moneyOr } from './ui2';

// Payroll imports (V10) — server: lib/memberImports.js. Salary XLSX / CSV with sheet, header row and column mapping; PF ECR
// (11 fields, #~#); ESIC member contribution XLSX / CSV. Matching on exact UAN / IP / employee ids only, never names. The rows
// are re-read on the server from the stored source files when a batch is saved (lineage kept).

const STATUS_TONE = { 'Amount matched · payment unverified': 'green', 'Payroll only · no deduction': 'grey', 'Employee contribution differs': 'amber', 'Amount missing': 'amber', 'Return only': 'red', 'Payroll deduction missing from return': 'red', 'Duplicate identifier': 'red', 'Missing identifier': 'red' };

export default function ImportsTab({ meta, org, ws, demo, stamp, onGoto }) {
  const [draft, setDraft] = useState({ entity_id: org.entities[0]?.id || '', registration_id: '', fund: 'PF', month: '', kind: 'regular' });
  const [payroll, setPayroll] = useState(null);
  const [returns, setReturns] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [batches, setBatches] = useState([]);
  const [open, setOpen] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [dataset, setDataset] = useState(demo ? 'illustrative' : 'recorded');
  useEffect(() => setDataset(demo ? 'illustrative' : 'recorded'), [demo]);
  const load = useCallback(() => api.importBatches({ dataset }).then(r => setBatches(r.batches)).catch(e => setErr(errMsg(e))), [dataset]);
  useEffect(() => { load(); }, [load, stamp]);
  const regs = org.registrations.filter(r => r.entity_id === draft.entity_id && r.type === draft.fund);
  const nameOf = id => org.entities.find(e => e.id === id)?.short_code || '—';
  const rights = meta.actor.rights;

  const upload = async (side, file) => {
    if (!file) return;
    setErr(''); setMsg('');
    const f = new FormData(); f.append('entity_id', draft.entity_id); f.append('side', side); f.append('fund', draft.fund); f.append('file', file);
    try {
      const r = await api.importParse(f);
      if (r.format === 'ecr_txt') { setReturns({ file: r.file, format: 'ecr_txt', rows: r.rows }); setMsg(`ECR read: ${r.rows.length} member rows (11 fields each).`); }
      else setMapping({ side, file: r.file, sheets: r.sheets, sheet: r.sheets[0]?.name, header_row: 1, map: {} });
    } catch (e) { setErr(errMsg(e)); }
  };
  const applyMap = async () => {
    try {
      const r = await api.importMap({ entity_id: draft.entity_id, file_id: mapping.file.id, sheet: mapping.sheet, header_row: mapping.header_row, mapping: mapping.map });
      const spec = { file: mapping.file, format: 'mapped', sheet: mapping.sheet, header_row: mapping.header_row, mapping: mapping.map, rows: r.rows, row_count: r.row_count };
      if (mapping.side === 'payroll') setPayroll(spec); else setReturns(spec);
      setMapping(null); setMsg(`${r.row_count} rows mapped from “${mapping.file.name}”. Each row keeps its source row number.`);
    } catch (e) { setErr(errMsg(e)); }
  };
  const save = async () => {
    setErr(''); setMsg('');
    try {
      const body = { ...draft, payroll: { file_id: payroll.file.id, sheet: payroll.sheet, header_row: payroll.header_row, mapping: payroll.mapping }, returns: returns.format === 'ecr_txt' ? { file_id: returns.file.id } : { file_id: returns.file.id, sheet: returns.sheet, header_row: returns.header_row, mapping: returns.mapping } };
      const { batch } = await api.importSave(body);
      setMsg(`Batch saved: ${batch.summary.exceptions} exception(s) to review. A matching return is not payment evidence — check the paid challan and bank proof separately.`);
      setPayroll(null); setReturns(null); setOpen(batch.id); load();
    } catch (e) { setErr(errMsg(e)); }
  };
  const toRecon = async id => { try { const { record } = await api.importToRecon(id); setMsg(`Sent to the ${record.type} reconciliation (draft ${record.month}). Confirm ESIC coverage / exemptions there, add references and submit for review.`); load(); } catch (e) { setErr(errMsg(e)); } };
  const cur = batches.find(b => b.id === open);
  return (
    <div>
      <Hero eyebrow="PAYROLL IMPORTS" title="Payroll, ECR & ESIC employee matching" sub="Upload payroll and the member-wise return independently. Review missing employees and contribution differences before checking paid-challan evidence." tag="Exact UAN / IP matching" tagSub="Names are never matched automatically" />
      <Notice>A summary challan does not identify every employee: PF needs the member-wise ECR, ESIC its employee contribution list. PDF / image challans are attached as proof only — nothing is read from them. A missing ECR entry is an exception to investigate, not proof of non-deposit; a matching ECR is not payment evidence.</Notice>
      {ws.datasets.length > 1 && <Filters><FSel label="Batches shown" value={dataset} onChange={setDataset} options={[['illustrative', 'Illustrative (demo)'], ['recorded', 'Imported by the team']]} width={220} /></Filters>}
      {rights.prepare && <Panel title="New import batch">
        <Filters>
          <FSel label="Company" value={draft.entity_id} onChange={v => setDraft({ ...draft, entity_id: v, registration_id: '' })} options={org.entities.map(e => [e.id, `${e.short_code} — ${e.legal_name}`])} width={230} />
          <FSel label="Fund" value={draft.fund} onChange={v => { setDraft({ ...draft, fund: v, registration_id: '' }); setReturns(null); }} options={Object.entries(ws.imports.funds)} width={220} />
          <FSel label={draft.fund === 'PF' ? 'Establishment code' : 'Employer code'} value={draft.registration_id} onChange={v => setDraft({ ...draft, registration_id: v })} options={regs.map(r => [r.id, r.number])} placeholder="Choose…" width={200} />
          <FInput label="Wage month" type="month" value={draft.month} onChange={v => setDraft({ ...draft, month: v })} width={150} />
          <FSel label="Return" value={draft.kind} onChange={v => setDraft({ ...draft, kind: v })} options={[['regular', 'Regular'], ['supplementary', 'Supplementary / amended (kept separate)']]} width={250} />
        </Filters>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
          <div style={{ border: '1px dashed #C9BFEE', borderRadius: 10, padding: 14 }}>
            <b>1 · Salary file</b> <span style={S.muted}>(XLSX / XLS / CSV — choose the sheet, header row and columns)</span><br />
            <input type="file" accept=".xlsx,.xls,.csv" onChange={e => upload('payroll', e.target.files[0])} style={{ marginTop: 8 }} />
            {payroll && <p style={S.muted}>✓ {payroll.file.name} · {payroll.row_count} rows · sheet “{payroll.sheet}”, header row {payroll.header_row}</p>}
          </div>
          <div style={{ border: '1px dashed #C9BFEE', borderRadius: 10, padding: 14 }}>
            <b>2 · {draft.fund === 'PF' ? 'Member-wise ECR' : 'ESIC member contribution file'}</b> <span style={S.muted}>({draft.fund === 'PF' ? 'monthly ECR TXT (11 fields, #~#) or XLSX / CSV' : 'XLSX / CSV'})</span><br />
            <input type="file" accept={draft.fund === 'PF' ? '.txt,.xlsx,.xls,.csv' : '.xlsx,.xls,.csv'} onChange={e => upload('returns', e.target.files[0])} style={{ marginTop: 8 }} />
            {returns && <p style={S.muted}>✓ {returns.file.name} · {returns.rows?.length || returns.row_count} rows{returns.format === 'ecr_txt' ? ' · ECR text' : ''}</p>}
          </div>
        </div>
        <div style={{ ...S.row, marginTop: 12 }}><Btn kind="primary" disabled={!payroll || !returns || !draft.registration_id || !draft.month} onClick={save}>Save batch and match</Btn><span style={S.small}>Both files are stored encrypted with their SHA-256; the match runs on the server from the stored files.</span></div>
      </Panel>}
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      <Panel title="Import batches">
        <DataTable headers={['Company / registration', 'Fund / month', 'Files', 'Members (payroll / return)', 'Exceptions', 'Status', '']}
          rows={batches.map(b => [`${nameOf(b.entity_id)} / ${b.registration_number}`, <>{b.fund} · {b.month}{b.kind === 'supplementary' && <Badge tone="amber">Supplementary</Badge>}{b.illustrative && <Badge tone="amber">Illustrative</Badge>}</>, <>{b.payroll.name}<br />{b.returns.name}</>, `${b.summary.members.payroll} / ${b.summary.members.returns}`,
            b.summary.blocking ? <Badge tone="red">{b.summary.exceptions} · resolve ids first</Badge> : <Badge tone={b.summary.exceptions ? 'amber' : 'green'}>{b.summary.exceptions}</Badge>, <>{b.status}{b.recon_id && <><br /><small>sent to reconciliation</small></>}</>,
            <><Btn small onClick={() => setOpen(b.id === open ? null : b.id)}>{b.id === open ? 'Hide' : 'Review'}</Btn>{rights.prepare && b.status !== 'withdrawn' && <Btn small kind="primary" disabled={b.summary.blocking} onClick={() => toRecon(b.id)}>Send to {b.fund} reconciliation</Btn>}</>])} empty="No import batches yet." />
      </Panel>
      {cur && <>
        <Stats items={[{ label: 'Payroll employee contribution', value: money(cur.summary.totals.payroll_ee), sub: `${cur.summary.members.payroll} payroll rows` }, { label: 'Return employee contribution', value: money(cur.summary.totals.return_ee), sub: `${cur.summary.members.returns} return rows` }, { label: 'Employer (payroll / return)', value: `${money(cur.summary.totals.payroll_er)} / ${money(cur.summary.totals.return_er)}`, sub: cur.fund === 'PF' ? `EPS ${money(cur.summary.totals.payroll_eps)} / ${money(cur.summary.totals.return_eps)} (kept separate)` : 'ESIC employer share' }, { label: 'Exceptions', value: cur.summary.exceptions, sub: 'Missing, duplicate, differing or return-only' }]} />
        <Panel title={`Employee matching · ${cur.fund} ${cur.month}`} right={<>{cur.payroll.file_id && <Btn small kind="ghost" onClick={() => openFile(cur.payroll.file_id).catch(e => setErr(errMsg(e)))}>Salary file</Btn>}{cur.returns.file_id && <Btn small kind="ghost" onClick={() => openFile(cur.returns.file_id).catch(e => setErr(errMsg(e)))}>Return file</Btn>}</>}
          note="Identifiers are masked. Source rows refer to the stored files. Missing amounts are blank, never zero.">
          <DataTable headers={['Employee key (masked)', 'Name (display only)', 'Payroll EE', 'Return EE', 'Difference', 'Result', 'Source rows (payroll / return)']} numeric={[2, 3, 4]}
            rows={cur.summary.matches.map(m => [m.masked, m.name, moneyOr(m.p?.ee, '—'), moneyOr(m.r?.ee, '—'), moneyOr(m.delta, '—'), <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>, `${m.p_rows.join(', ') || '—'} / ${m.r_rows.join(', ') || '—'}`])} />
        </Panel>
        <p style={S.muted}>Next: {cur.recon_id ? <>the batch is in the {cur.fund} reconciliation — open <Btn small kind="ghost" onClick={() => onGoto('payroll')}>Provident Fund &amp; PT</Btn> to complete and submit it.</> : 'send it to the reconciliation once identifiers are clean.'}</p>
      </>}
      {mapping && <MappingDialog mapping={mapping} setMapping={setMapping} ws={ws} onApply={applyMap} onClose={() => setMapping(null)} err={err} />}
    </div>
  );
}

function MappingDialog({ mapping, setMapping, ws, onApply, onClose, err }) {
  const sheet = mapping.sheets.find(s => s.name === mapping.sheet) || mapping.sheets[0];
  const heads = sheet?.rows[mapping.header_row - 1] || [];
  const set = (k, v) => setMapping(m => ({ ...m, map: { ...m.map, [k]: v } }));
  return (
    <Modal title={`Map ${mapping.side === 'payroll' ? 'salary' : 'return'} columns · ${mapping.file.name}`} onClose={onClose} width={1000}>
      <p style={{ ...S.muted, marginTop: 0 }}>Choose the sheet and the header row, then the column for each field. Identifier and employee contribution are required. Format id columns as text — scientific-notation ids are refused. Remove total / footer rows.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        <label><span style={S.label}>Sheet</span><select value={mapping.sheet} onChange={e => setMapping(m => ({ ...m, sheet: e.target.value, map: {} }))} style={S.input}>{mapping.sheets.map(s => <option key={s.name} value={s.name}>{s.name} ({s.row_count} rows)</option>)}</select></label>
        <label><span style={S.label}>Header row</span><input type="number" min="1" value={mapping.header_row} onChange={e => setMapping(m => ({ ...m, header_row: Number(e.target.value) || 1, map: {} }))} style={S.input} /></label>
        {ws.imports.map_keys.map(k => <label key={k}><span style={S.label}>{ws.imports.map_labels[k]}</span><select value={mapping.map[k] ?? ''} onChange={e => set(k, e.target.value)} style={S.input}><option value="">— not in file —</option>{heads.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}</select></label>)}
      </div>
      <h4 style={{ fontSize: 13, margin: '14px 0 6px' }}>Preview (first rows)</h4>
      <DataTable headers={heads.map((h, i) => h || `Column ${i + 1}`)} rows={(sheet?.rows || []).slice(mapping.header_row, mapping.header_row + 8)} maxHeight={220} />
      {err && <Note tone="error" style={{ marginTop: 10 }}>{err}</Note>}
      <div style={{ ...S.row, marginTop: 12 }}><Btn kind="primary" onClick={onApply}>Apply mapping</Btn><Btn kind="ghost" onClick={onClose}>Cancel</Btn></div>
    </Modal>
  );
}
