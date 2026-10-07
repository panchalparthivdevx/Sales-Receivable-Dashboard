import React, { useMemo, useState } from 'react';
import { T } from '../../../theme';
import { capi, errSync } from '../complianceApi';
import { S, Btn, Field, Input, Select, Modal, Note } from '../ui';
import { buildPeriodIndex } from '../filterLogic';

// Manual entry of one task. Quarter and Half Year are derived from the Month (read-only).
// The server applies exactly the same validation as Excel import.
export default function TaskEntryModal({ meta, onClose, onSaved }) {
  const idx = useMemo(() => buildPeriodIndex(meta.period), [meta.period]);
  const [f, setF] = useState({
    company: meta.companies[0]?.id || '', fy: meta.current.fy_default, month: meta.current.month,
    module: meta.settings.modules[0]?.key || '', compliance_id: '', applicable: '', due_date: '', responsible: '', reviewer: '', remarks: '',
  });
  const [err, setErr] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  const comps = meta.compliances.filter(c => c.module === f.module && c.active !== false);
  const comp = comps.find(c => c.id === f.compliance_id);
  const m = idx.monthByKey[f.month];
  const periodNote = comp && comp.frequency !== 'Monthly'
    ? `${comp.frequency} compliance — saved as period ${comp.frequency === 'Quarterly' ? m.quarter : comp.frequency === 'Half-Yearly' ? m.half : 'FY'} (filed under its last month).`
    : '';

  const save = async () => {
    setBusy(true); setErr([]);
    try {
      const r = await capi.createTask({ ...f, quarter: m.quarter, half: m.half });
      onSaved(`Task ${r.task_id} created.`);
      onClose();
    } catch (e) {
      const list = e.response?.data?.errors;
      setErr(list?.length ? list : [{ error: errSync(e) }]);
    } finally { setBusy(false); }
  };

  return (
    <Modal title="Manual Entry — New Task" subtitle="Same checks as Excel import. Leave Due Date blank to use the compliance's Due Date Rule." width={720} onClose={onClose}
      footer={<><Btn variant="ghost" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={save} disabled={busy || !f.compliance_id}>{busy ? 'Saving…' : 'Create Task'}</Btn></>}>
      {err.length > 0 && <Note kind="error" style={{ marginBottom: 10 }}>{err.map((e, i) => <div key={i}>{e.error}{e.fix ? <span style={{ color: T.textMuted }}> — {e.fix}</span> : null}</div>)}</Note>}
      <datalist id="cmp-people-new">{(meta.people || []).map(p => <option key={p} value={p} />)}</datalist>
      <div className="cmp-form3">
        <Field label="Company *"><Select value={f.company} onChange={v => set('company', v)} options={meta.companies.map(c => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Financial Year *"><Select value={f.fy} onChange={v => set('fy', v)} options={meta.settings.fy_list.map(y => ({ value: y, label: `FY ${y}` }))} /></Field>
        <Field label="Month *"><Select value={f.month} onChange={v => set('month', v)} options={meta.period.months.map(x => ({ value: x.key, label: x.label }))} /></Field>
        <Field label="Quarter (from Month)"><div style={{ ...S.control, background: T.page, color: T.textMuted }}>{m.quarter}</div></Field>
        <Field label="Half Year (from Month)"><div style={{ ...S.control, background: T.page, color: T.textMuted }}>{m.half}</div></Field>
        <Field label="Module *"><Select value={f.module} onChange={v => setF(x => ({ ...x, module: v, compliance_id: '' }))} options={meta.settings.modules.map(x => ({ value: x.key, label: x.label }))} /></Field>
      </div>
      <div className="cmp-form" style={{ marginTop: 12 }}>
        <Field label="Compliance *" hint={comp ? `${comp.frequency} · rule: ${comp.due_rule}` : ''}>
          <Select value={f.compliance_id} onChange={v => set('compliance_id', v)} options={[{ value: '', label: '— choose —' }, ...comps.map(c => ({ value: c.id, label: `${c.id} · ${c.name}` }))]} />
        </Field>
        <Field label="Applicable" hint="Default comes from Company Applicability.">
          <Select value={f.applicable} onChange={v => set('applicable', v)} options={[{ value: '', label: 'Default' }, { value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No (N/A)' }]} />
        </Field>
        <Field label="Due Date" hint="Blank = from the Due Date Rule."><Input type="date" value={f.due_date} onChange={e => set('due_date', e.target.value)} /></Field>
        <span />
        <Field label="Responsible" hint="Blank = from Company Applicability."><Input list="cmp-people-new" value={f.responsible} onChange={e => set('responsible', e.target.value)} /></Field>
        <Field label="Reviewer" hint="Blank = from Company Applicability."><Input list="cmp-people-new" value={f.reviewer} onChange={e => set('reviewer', e.target.value)} /></Field>
      </div>
      <Field label="Remarks" style={{ marginTop: 12 }}><Input value={f.remarks} onChange={e => set('remarks', e.target.value)} /></Field>
      {periodNote && <Note style={{ marginTop: 10 }}>{periodNote}</Note>}
    </Modal>
  );
}
