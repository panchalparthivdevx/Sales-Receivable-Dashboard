import React, { useState } from 'react';
import { Download, Upload, Trash2 } from 'lucide-react';
import { api } from '../../utils/api';
import { fsApi, errText } from './api';
import { C, S, Card, Note, Loading, useLoad } from './ui';
import { BUDGET_LINES } from './calc';

const ALERT_METRICS = [['liq.cr', 'Current ratio (×)'], ['lev.de', 'Debt / equity excl. leases (×)'], ['lev.nd_ebitda_l', 'Net debt incl. leases / TTM EBITDA (×)'], ['cov.iscr', 'Interest coverage (×)'], ['cov.dscr_ebitda', 'EBITDA-based DSCR (×)'],
  ['wc.dso', 'DSO (days)'], ['prof.ebitda_m', 'EBITDA margin (fraction, e.g. 0.6)'], ['prof.pat_m', 'PAT margin (fraction)'], ['unit.occupancy', 'Occupancy (fraction)']];

export default function InputsTab({ rights }) {
  const inp = useLoad(() => fsApi.inputs(), []);
  const [type, setType] = useState('budget');
  const [form, setForm] = useState({ basis: 'SA', source: '', values: {} });
  const [msg, setMsg] = useState('');
  const [settings, setSettings] = useState(null);
  if (inp.loading && !inp.data) return <Loading />;
  if (inp.error) return <div style={{ ...S.card, color: C.bad }}>{inp.error}</div>;
  const d = inp.data;
  const T = d.types[type];
  const recs = d.records.filter(r => r.type === type).sort((a, b) => (b.periodEnd || b.effectiveDate || '').localeCompare(a.periodEnd || a.effectiveDate || ''));
  const can = rights?.inputs;
  const st = settings || { thresholds: d.settings?.thresholds || {}, alerts: d.settings?.alerts || {}, gstOnReceivables: d.settings?.gstOnReceivables ?? '' };
  const flash = t => { setMsg(t); setTimeout(() => setMsg(''), 5000); };
  const save = async () => {
    try { await fsApi.saveInput({ type, basis: form.basis, source: form.source, values: form.values }); setForm({ basis: form.basis, source: form.source, values: {} }); flash('Saved.'); inp.reload(); }
    catch (e) { flash(errText(e)); }
  };
  const upload = async file => { try { const r = await fsApi.uploadInputs(type, file); flash(`Saved ${r.saved} row(s).`); inp.reload(); } catch (e) { flash(errText(e)); } };
  const prefill = async () => {
    const date = window.prompt('Effective date for these seat counts (YYYY-MM-DD)?');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const src = window.prompt('Source of these figures (e.g. "Finance Overview branch capacity table, confirmed by Ops on …")?', 'Finance Overview — branch capacity (seats, sq ft)');
    if (!src) return;
    const cap = await api.plCapacity();
    let n = 0;
    for (const [branch, v] of Object.entries(cap || {})) { if (!v?.seats) continue; await fsApi.saveInput({ type: 'branch_capacity', basis: 'SA', source: src, values: { branch, effectiveDate: date, capacitySeats: v.seats, areaSqft: v.sqft } }); n++; }
    flash(`Added ${n} branch capacity rows (occupied seats still to be entered).`); inp.reload();
  };
  return (
    <div>
      {msg && <div style={{ ...S.card, background: C.tint, color: C.green, fontSize: '0.8rem' }}>{msg}</div>}
      {!can && <Note tone="warn">You can view the inputs. Entering them needs the "Management inputs" right (User Settings → Financial Statements).</Note>}
      <Card title="What each report is waiting for">
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={S.th}>Report</th><th style={S.th}>Inputs it needs (records entered)</th></tr></thead>
          <tbody>{Object.entries(d.coverage.reports).map(([rep, list]) => <tr key={rep}><td style={{ ...S.td, fontWeight: 600 }}>{rep}</td><td style={S.td}>{list.map(x => <span key={x.type} onClick={() => setType(x.type)} style={{ display: 'inline-block', marginRight: 10, cursor: 'pointer', color: x.records ? C.good : C.warn }}>{x.records ? '✓' : '○'} {x.label} ({x.records})</span>)}</td></tr>)}</tbody>
        </table></div>
        <div style={{ ...S.small, marginTop: 6 }}>Nothing here has a default. The sample amounts and thresholds in the requirements are illustrative and are not loaded.</div>
      </Card>
      <Card title="Enter or upload" right={<>
        <select style={S.select} value={type} onChange={e => { setType(e.target.value); setForm({ basis: form.basis, source: form.source, values: {} }); }}>{Object.entries(d.types).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}</select>
        <button style={S.btn('outline')} onClick={() => fsApi.download(`/inputs/template/${type}`, {}, `${type}_template.xlsx`)}><Download size={14} />Template</button>
        {can && <label style={{ ...S.btn('outline'), cursor: 'pointer' }}><Upload size={14} />Upload Excel<input type="file" accept=".xlsx" style={{ display: 'none' }} onChange={e => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ''; }} /></label>}
        {can && type === 'branch_capacity' && <button style={S.btn('outline')} onClick={prefill} title="Copy the seats and sq ft kept for the Finance Overview branch P&L (undated) as rows effective from a date you give">Prefill from Finance Overview</button>}
      </>}>
        <div style={{ ...S.small, marginBottom: 10 }}>{T.help} Unit: {T.unit}.</div>
        {can && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <label style={S.small}>Company<br /><input style={S.input} value="Dev Accelerator Ltd" disabled /></label>
          <label style={S.small}>Basis<br /><select style={S.select} value={form.basis} onChange={e => setForm(f => ({ ...f, basis: e.target.value }))}><option value="SA">Standalone</option><option value="CO">Consolidated</option></select></label>
          {T.fields.map(f => <label key={f.key} style={S.small}>{f.label}{f.required ? ' *' : ''}<br />
            {type === 'budget' && f.key === 'line' ? <select style={S.select} value={form.values.line || ''} onChange={e => setForm(x => ({ ...x, values: { ...x.values, line: e.target.value } }))}><option value="">—</option>{BUDGET_LINES.map(([l]) => <option key={l}>{l}</option>)}</select>
              : f.key === 'operator' ? <select style={S.select} value={form.values.operator || ''} onChange={e => setForm(x => ({ ...x, values: { ...x.values, operator: e.target.value } }))}><option value="">—</option><option>{'>='}</option><option>{'<='}</option></select>
              : f.key === 'class' ? <select style={S.select} value={form.values.class || ''} onChange={e => setForm(x => ({ ...x, values: { ...x.values, class: e.target.value } }))}><option value="">—</option><option>Fixed</option><option>Variable</option><option>Semi-variable</option></select>
              : type === 'cost_class' && f.key === 'item' ? <select style={S.select} value={form.values.item || ''} onChange={e => setForm(x => ({ ...x, values: { ...x.values, item: e.target.value } }))}><option value="">—</option>{['Operating expenses', 'Employee benefits expense', 'Other expenses', 'Finance costs', 'Depreciation and amortisation'].map(l => <option key={l}>{l}</option>)}</select>
              : <input style={{ ...S.input, width: f.type === 'text' ? 170 : 130 }} type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'} step="any" value={form.values[f.key] ?? ''} onChange={e => setForm(x => ({ ...x, values: { ...x.values, [f.key]: e.target.value } }))} />}
          </label>)}
          <label style={S.small}>Source *<br /><input style={{ ...S.input, width: 240 }} placeholder="e.g. Board-approved budget, 12 Apr 2026" value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))} /></label>
          <button style={S.btn('primary')} onClick={save}>Save</button>
        </div>}
        {!recs.length ? <div style={S.small}>No records of this type yet.</div> :
          <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th}>Basis</th>{T.fields.map(f => <th key={f.key} style={S.th}>{f.label}</th>)}<th style={S.th}>Source</th><th style={S.th}>Entered</th>{can && <th style={S.th} />}</tr></thead>
            <tbody>{recs.map(r => <tr key={r.id}><td style={S.td}>{r.basis === 'CO' ? 'Cons.' : 'Stand.'}</td>{T.fields.map(f => <td key={f.key} style={{ ...S.td, ...(f.type === 'number' ? S.num : {}) }}>{r.values[f.key] ?? ''}</td>)}<td style={S.td}>{r.source}</td><td style={{ ...S.td, ...S.small }}>{r.by}, {r.at?.slice(0, 10)}</td>
              {can && <td style={S.td}><button title="Delete" style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.bad }} onClick={async () => { if (window.confirm('Delete this record?')) { await fsApi.deleteInput(r.id); inp.reload(); } }}><Trash2 size={14} /></button></td>}</tr>)}</tbody>
          </table></div>}
      </Card>
      <Card title="Settings: reconciliation tolerances, GST basis and alert thresholds" right={can && <button style={S.btn('primary')} onClick={async () => { try { await fsApi.saveSettings(st); setSettings(null); flash('Settings saved.'); inp.reload(); } catch (e) { flash(errText(e)); } }}>Save settings</button>}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
          {[['tolerance', 'Rounding tolerance (₹ lakh)', '0.015'], ['materiality', 'Materiality for decisions (₹ lakh)', '1.00'], ['epsTolerance', 'EPS tolerance (₹)', '0.0005'], ['epsMateriality', 'EPS materiality (₹)', '0.01']].map(([k, l, def]) => (
            <label key={k} style={S.small}>{l}<br /><input style={{ ...S.input, width: 120 }} type="number" step="any" placeholder={`default ${def}`} disabled={!can} value={st.thresholds[k] ?? ''} onChange={e => setSettings({ ...st, thresholds: { ...st.thresholds, [k]: e.target.value } })} /></label>))}
          <label style={S.small}>GST rate included in receivables (e.g. 0.18)<br /><input style={{ ...S.input, width: 120 }} type="number" step="any" placeholder="not set" disabled={!can} value={st.gstOnReceivables ?? ''} onChange={e => setSettings({ ...st, gstOnReceivables: e.target.value })} /></label>
        </div>
        <table style={{ borderCollapse: 'collapse' }}><thead><tr><th style={S.th}>Alert metric</th><th style={S.th}>Minimum</th><th style={S.th}>Maximum</th></tr></thead>
          <tbody>{ALERT_METRICS.map(([id, l]) => <tr key={id}><td style={S.td}>{l}</td>{['min', 'max'].map(k => <td key={k} style={S.td}><input style={{ ...S.input, width: 100 }} type="number" step="any" disabled={!can} value={st.alerts[id]?.[k] ?? ''} onChange={e => setSettings({ ...st, alerts: { ...st.alerts, [id]: { ...(st.alerts[id] || {}), [k]: e.target.value } } })} /></td>)}</tr>)}</tbody></table>
        <div style={{ ...S.small, marginTop: 6 }}>Leave blank for "No threshold set". Thresholds are your approved targets — none are pre-filled. {d.settings?.updatedBy ? `Last changed by ${d.settings.updatedBy} on ${d.settings.updatedAt?.slice(0, 10)}.` : ''}</div>
      </Card>
    </div>
  );
}
