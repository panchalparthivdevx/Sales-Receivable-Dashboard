import React, { useEffect, useState } from 'react';
import { api, errMsg } from './api';
import { S, Btn, Note, StatusBadge, Flags, Empty, dt } from './ui';
import { Hero, Panel, Notice, DataTable, Filters, FSel, Badge } from './ui2';
import { InputCards, ReconEditor, useRecon } from './ReconParts';

// GST workspace and Provident Fund & PT (V2 + V8): the section's own tasks (from the register, same filters) plus the monthly
// reconciliation inputs for that section. The TDS tab has its own file (TdsTab.js).

export function TaskBlock({ title, params, categories, stamp, onOpenTask, note }) {
  const [tasks, setTasks] = useState(null);
  const [err, setErr] = useState('');
  const key = categories.join(',');
  useEffect(() => { setTasks(null); api.tasks({ ...params, categories: key }).then(r => setTasks(r.tasks)).catch(e => setErr(errMsg(e))); }, [params, key, stamp]);
  return (
    <Panel title={title} note={note}>
      {err && <Note tone="error">{err}</Note>}
      {!tasks && !err ? <Empty>Loading…</Empty> : (
        <DataTable headers={['Obligation / scope', 'Period', 'Due date', 'Status', 'Owner', '']}
          rows={(tasks || []).slice(0, 300).map(t => [<><b>{t.rule_name}</b><br /><small>{t.scope_label}</small></>, t.period_label, <>{t.effective_due ? dt(t.effective_due) : <Badge tone="amber">Not scheduled</Badge>}{t.missing_rule && <><br /><small>State rule missing — never overdue</small></>}</>,
            <><StatusBadge status={t.status} label={t.status_label} /><br /><Flags flags={t.flags} skip={['sample']} /></>, t.owner_name || 'Unassigned', <Btn small kind="ghost" onClick={() => onOpenTask(t.id)}>Open ↗</Btn>])}
          empty="No tasks for these filters. Generate tasks from Coverage & rules once registrations and rules are approved." />
      )}
    </Panel>
  );
}

function useDataset(demo) {
  const [dataset, setDataset] = useState(demo ? 'illustrative' : 'recorded');
  useEffect(() => setDataset(demo ? 'illustrative' : 'recorded'), [demo]);
  return [dataset, setDataset];
}
const DatasetPicker = ({ ws, dataset, setDataset }) => (ws.datasets.length > 1 ? <Filters><FSel label="Reconciliation dataset" value={dataset} onChange={setDataset} options={[['illustrative', 'Illustrative reconciliation (demo)'], ['recorded', 'Team inputs']]} width={260} /></Filters> : null);

export function GstTab({ meta, org, ws, demo, params, stamp, onOpenTask, onGotoReport }) {
  const [dataset, setDataset] = useDataset(demo);
  const [recs, reload, err] = useRecon(['GST', 'VENDOR'], dataset, stamp);
  const [edit, setEdit] = useState(null);
  return (
    <div>
      <Hero eyebrow="GST WORKSPACE" title="GST reconciliation workspace" sub="Tax-head liability comparisons, actual ledger utilisation and supplier ITC assessments, alongside every GST filing task." tag="GSTR-1 · GSTR-3B · GSTR-2B" tagSub="Inputs entered once, reports read them" />
      <DatasetPicker ws={ws} dataset={dataset} setDataset={setDataset} />
      {err && <Note tone="error">{err}</Note>}
      <InputCards types={['GST', 'VENDOR']} ws={ws} org={org} records={recs} canPrepare={meta.actor.rights.prepare} illustrative={dataset === 'illustrative'} onOpen={(type, id) => setEdit({ type, id })} onReports={() => onGotoReport('gst13b')} />
      <TaskBlock title="GST filing tasks" params={params} categories={['GST']} stamp={stamp} onOpenTask={onOpenTask} />
      <Notice>Enter the cash / credit ledger debits used to discharge tax — not challan deposits. Compare outward liability on the same scope and period; RCM and other liabilities are kept apart. A variance starts an internal review; it does not guarantee that a notice is avoided.</Notice>
      {edit && <ReconEditor type={edit.type} id={edit.id} ws={ws} org={org} meta={meta} onClose={() => setEdit(null)} onSaved={reload} />}
    </div>
  );
}

export function PayrollTab({ meta, org, ws, demo, params, stamp, onOpenTask, onGotoReport, onGoto }) {
  const [dataset, setDataset] = useDataset(demo);
  const [recs, reload, err] = useRecon(['PF', 'ESIC', 'PT'], dataset, stamp);
  const [edit, setEdit] = useState(null);
  const ptRegs = org.registrations.filter(r => r.type.startsWith('PT_'));
  return (
    <div>
      <Hero eyebrow="PROVIDENT FUND & PROFESSIONAL TAX" title="Provident Fund, ESIC & Professional Tax" sub="ECR preparation and the separate contribution payment, ESIC contributions, state-wise PTRC deduction / return and PTEC enrolment — with payroll-to-return reconciliation inputs." tag="EPFO · ESIC · State PT" tagSub="No nationwide PT date is assumed" />
      <DatasetPicker ws={ws} dataset={dataset} setDataset={setDataset} />
      <Notice>PF: ECR submission and the contribution payment are separate tasks; capture the TRRN and keep the ECR and payment evidence apart. PT: each state has its own rules, slabs and periodicity — a state without an approved rule stays unscheduled in the missing-rule queue and is never shown as overdue. PTEC is the entity's own enrolment, not a payroll deduction.</Notice>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Panel title="Registrations in scope">
          <DataTable headers={['Company', 'Type', 'Number', 'State / periodicity']} rows={org.registrations.filter(r => ['PF', 'ESIC', 'PT_PTRC', 'PT_PTEC', 'LWF'].includes(r.type)).map(r => [org.entities.find(e => e.id === r.entity_id)?.short_code, r.type.replace('PT_', 'PT · '), r.number, `${r.state || '—'}${r.filing_frequency ? ` · ${r.filing_frequency}` : r.type.startsWith('PT_') ? ' · periodicity not recorded' : ''}`])} empty="No PF / ESIC / PT registrations yet — add them in Companies & GSTINs." />
        </Panel>
        <Panel title="Payroll imports" note="Upload the salary file and the member-wise ECR / ESIC list, match on exact UAN / IP numbers, then send the reviewed batch here as the reconciliation grid.">
          <Btn kind="primary" onClick={() => onGoto('imports')}>Open Payroll imports →</Btn>
          {ptRegs.some(r => !r.filing_frequency) && <p style={{ ...S.muted, marginTop: 10 }}>Some PT registrations have no periodicity recorded: their tasks stay unscheduled until it is.</p>}
        </Panel>
      </div>
      {err && <Note tone="error">{err}</Note>}
      <InputCards types={['PF', 'ESIC', 'PT']} ws={ws} org={org} records={recs} canPrepare={meta.actor.rights.prepare} illustrative={dataset === 'illustrative'} onOpen={(type, id) => setEdit({ type, id })} onReports={() => onGotoReport('pf')} />
      <TaskBlock title="Provident Fund tasks" params={params} categories={['Provident Fund']} stamp={stamp} onOpenTask={onOpenTask} />
      <TaskBlock title="ESIC tasks" params={params} categories={['ESIC']} stamp={stamp} onOpenTask={onOpenTask} />
      <TaskBlock title="Professional Tax tasks (state-wise)" params={params} categories={['Professional Tax']} stamp={stamp} onOpenTask={onOpenTask} note="Unscheduled PT items have no approved state rule or periodicity yet — they are listed, never counted as overdue." />
      {edit && <ReconEditor type={edit.type} id={edit.id} ws={ws} org={org} meta={meta} onClose={() => setEdit(null)} onSaved={reload} />}
    </div>
  );
}
