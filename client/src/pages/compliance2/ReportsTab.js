import React, { useEffect, useMemo, useState } from 'react';
import { api, errMsg, openFile } from './api';
import { S, Btn, Note, Modal, StatusBadge, Flags, Empty, dt } from './ui';
import { Hero, Pills, Stats, Panel, Notice, DataTable, TrendChart, GrowthChart, HBars, StackedBars, Toolbar, PrintBtn, Filters, FSel, Badge, REVIEW_TONE, downloadCsv, money, moneyOr, monthName, fyMonthList, fyLabel, signed } from './ui2';
import { ReconDetail, ReconEditor } from './ReconParts';
import { TaxAuditView } from './TaxAuditTab';

// Reports & analytics (V7), tax trends (V9), reconciliation reports (V8) and the yearly tax-audit papers (V10). Every number
// comes from the server (server/compliance2/lib/reports.js), so the chart, the table and the CSV are the same figures.

const PAGES = [
  ['monthly', 'Monthly payments'], ['trends', 'Tax trends · MoM / QoQ'], ['company', 'Company comparison'], ['section', 'Section analysis'], ['register', 'Payment register'],
  ['filing', 'Filing performance'], ['overdue', 'Overdue & upcoming'], ['evidence', 'Evidence & exceptions'], ['workload', 'Team workload'],
  ['gst13b', 'GSTR-1 vs GSTR-3B'], ['vendor', 'Vendor ITC risk'], ['gstcash', 'GST cash vs credit'], ['pf', 'Payroll vs PF ECR'], ['esic', 'Payroll vs ESIC'], ['tdsliab', 'TDS liability vs deposits'], ['pt', 'PT deductions vs payments'],
  ['taxaudit', 'Tax audit · yearly'],
];
const PAYMENT = ['monthly', 'trends', 'company', 'section', 'register'];
const TASKS = ['filing', 'overdue', 'evidence', 'workload'];
const RECON = ['gst13b', 'vendor', 'gstcash', 'pf', 'esic', 'tdsliab', 'pt'];
const CATEGORY_OF = { GST: 'GST', TDS: 'TDS/TCS', 'Provident Fund': 'Provident Fund', ESIC: 'ESIC', 'Professional Tax': 'Professional Tax', 'Income Tax': 'Income Tax', 'ROC / LLP': 'ROC/LLP', 'SEBI / exchange': 'SEBI/Exchange', 'FEMA / RBI': 'FEMA/RBI' };
const RECON_TYPE = { gst13b: 'GST', vendor: 'VENDOR', gstcash: 'GST', pf: 'PF', esic: 'ESIC', tdsliab: 'TDS', pt: 'PT' };

export default function ReportsTab({ meta, org, ws, demo, stamp, onOpenTask, initialPage, onChanged }) {
  const [page, setPage] = useState(initialPage || 'monthly');
  const [dataset, setDataset] = useState(demo ? 'illustrative' : 'recorded');
  const [fy, setFy] = useState(() => fyNow(meta.today));
  const [entity, setEntity] = useState('');
  const [section, setSection] = useState('');
  const [reg, setReg] = useState('');
  const [basis, setBasis] = useState('payment');
  const [month, setMonth] = useState('');
  const [status, setStatus] = useState('');
  const [chart, setChart] = useState('columns');
  const [metric, setMetric] = useState('principal');
  const [period, setPeriod] = useState('monthly');
  const [got, setGot] = useState(null);              // { key, data } — data is only used for the request it belongs to
  const [err, setErr] = useState('');
  const [capture, setCapture] = useState(false);
  const [edit, setEdit] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (initialPage) setPage(initialPage); }, [initialPage]);
  useEffect(() => { setDataset(demo ? 'illustrative' : 'recorded'); }, [demo]);

  const fys = useMemo(() => { const s = +fyNow(meta.today).slice(0, 4); return [s - 2, s - 1, s, s + 1].map(y => `${y}-${String((y + 1) % 100).padStart(2, '0')}`); }, [meta.today]);
  const params = useMemo(() => ({ dataset, fy, entity_ids: entity, registration_ids: reg, section: PAYMENT.includes(page) ? section : '', basis, month: page === 'trends' ? '' : month, status, metric, period }), [dataset, fy, entity, reg, section, basis, month, status, metric, period, page]);
  const reqKey = JSON.stringify([page, params, stamp, tick]);
  useEffect(() => {
    if (page === 'taxaudit') return;
    setErr('');
    const key = JSON.stringify([page, params, stamp, tick]);
    const p = PAYMENT.includes(page) ? (page === 'trends' ? api.reportTrends(params) : api.reportPayments(params))
      : TASKS.includes(page) ? api.reportTasks({ fy, entity_ids: entity, registration_ids: reg, categories: section ? CATEGORY_OF[section] || '' : '', months: month })
        : api.reportRecon(page, params);
    p.then(d => setGot({ key, data: d })).catch(e => setErr(errMsg(e)));
  }, [page, params, fy, entity, reg, section, month, stamp, tick]);
  const data = got && got.key === reqKey ? got.data : null;

  const ents = org.entities;
  const nameOf = id => ents.find(e => e.id === id)?.short_code || '—';
  const regs = org.registrations.filter(r => (!entity || r.entity_id === entity) && (!RECON.includes(page) || ws.recon.reg_of[RECON_TYPE[page]].includes(r.type)));
  const context = { Report: PAGES.find(p => p[0] === page)[1], Dataset: dataset === 'illustrative' ? 'Illustrative (invented, demo)' : 'Recorded', 'Financial year': fyLabel(fy), Company: entity ? nameOf(entity) : 'All', Registration: reg ? regs.find(r => r.id === reg)?.number || reg : 'All',
    ...(PAYMENT.includes(page) ? { Section: section || 'All', 'Period basis': basis === 'payment' ? 'Payment month' : 'Liability month' } : {}), Month: month || 'Full FY', ...(RECON.includes(page) ? { 'Review status': status || 'All' } : {}), Generated: `${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST` };
  const illustrative = dataset === 'illustrative';

  return (
    <div>
      <Hero eyebrow="REPORTS" title="Reports & analytics" sub="Monthly statutory payments, company comparisons and compliance controls in one review workspace." tag={demo ? 'Demo workspace' : 'Live workspace'} tagSub={`${demo ? `Snapshot ${dt(meta.today)}` : `As of ${dt(meta.today)} IST`} · ${fyLabel(fy)}`} />
      <Pills items={PAGES} value={page} onChange={p => { setPage(p); setReg(''); }} label="Reports" />
      {page === 'taxaudit' ? <TaxAuditView meta={meta} org={org} ws={ws} demo={demo} stamp={stamp} embedded onChanged={onChanged} /> : (
        <>
          <Filters>
            {RECON.includes(page) || PAYMENT.includes(page) ? <FSel label={RECON.includes(page) ? 'Reconciliation dataset' : 'Payment dataset'} value={dataset} onChange={setDataset} options={ws.datasets.map(d => [d, d === 'illustrative' ? (RECON.includes(page) ? 'Illustrative reconciliation' : 'Illustrative payments') : (RECON.includes(page) ? 'Team inputs' : 'Recorded payments')])} width={210} /> : null}
            <FSel label="Financial year" value={fy} onChange={v => { setFy(v); setMonth(''); }} options={fys.map(f => [f, fyLabel(f)])} width={130} />
            <FSel label="Company" value={entity} onChange={v => { setEntity(v); setReg(''); }} options={ents.map(e => [e.id, `${e.short_code} — ${e.legal_name}`])} placeholder="All companies" width={230} />
            {(PAYMENT.includes(page) || TASKS.includes(page)) && <FSel label="Compliance section" value={section} onChange={v => { setSection(v); setReg(''); }} options={ws.payment_sections} placeholder="All sections" width={170} />}
            <FSel label="Registration" value={reg} onChange={setReg} options={regs.map(r => [r.id, `${r.state ? `${r.state} · ` : ''}${r.number}`])} placeholder="All registrations" width={200} />
            {PAYMENT.includes(page) && <FSel label="Period basis" value={basis} onChange={setBasis} options={[['payment', 'Payment month'], ['liability', 'Liability month']]} width={150} />}
            {page !== 'trends' && <FSel label={RECON.includes(page) ? 'Liability / wage month' : 'Month'} value={month} onChange={setMonth} options={fyMonthList(fy).map(m => [m, monthName(m)])} placeholder="Full financial year" width={160} />}
            {RECON.includes(page) && <FSel label="Review status" value={status} onChange={setStatus} options={Object.entries(ws.recon.statuses)} placeholder="All statuses" width={160} />}
            {page === 'trends' && <><FSel label="Comparison" value={period} onChange={setPeriod} options={[['monthly', 'Month-on-month'], ['quarterly', 'Quarter-on-quarter']]} width={170} /><FSel label="Metric" value={metric} onChange={setMetric} options={[['principal', 'Principal'], ['total', 'Recorded total'], ['charges', 'Interest & fees']]} width={150} /></>}
          </Filters>
          <Notice>{PAYMENT.includes(page)
            ? <><b>{illustrative ? 'ILLUSTRATIVE PAYMENT DATA — invented amounts for visual review only.' : 'RECORDED PAYMENTS — entered by your team; not bank-verified.'}</b> TDS totals use section principal allocations, not full challan cash outflows. GST amounts are cash deposits only; ITC utilisation and return liability are not inferred. A month with no rows means no recorded payment, never a confirmed nil.</>
            : TASKS.includes(page) ? <><b>COMPLIANCE TASK DATA</b> — independent of the payment dataset. Tasks use the effective due date; tasks without a due date stay visible as unscheduled. {demo ? `Snapshot ${dt(meta.today)}.` : 'Dates in Asia/Kolkata.'}</>
              : <><b>{illustrative ? 'ILLUSTRATIVE RECONCILIATION — invented examples, not company results.' : 'TEAM INPUTS — figures entered or imported by your team.'}</b> All figures in ₹. Drafts are included unless you filter by status. Uploaded ECR, returns and challans are evidence only; no OCR, portal sync or government filing happens here.</>}</Notice>
          {err && <Note tone="error">{err}</Note>}
          {!data && !err && <Empty>Loading…</Empty>}
          {data && PAYMENT.includes(page) && page !== 'trends' && <PaymentPages page={page} data={data} chart={chart} setChart={setChart} basis={basis} context={context} illustrative={illustrative} demo={demo} meta={meta} onCapture={() => setCapture(true)} />}
          {data && page === 'trends' && <TrendsPage data={data} context={context} />}
          {data && TASKS.includes(page) && <TaskPages page={page} data={data} context={context} onOpenTask={onOpenTask} />}
          {data && RECON.includes(page) && <ReconPages page={page} data={data} context={context} ws={ws} nameOf={nameOf} illustrative={illustrative} canPrepare={meta.actor.rights.prepare} onOpen={id => setEdit({ type: RECON_TYPE[page], id })} />}
          <Panel title="Reporting scope & next-stage controls" note="Reports use the records in the system, not an exhaustive statutory population. Liability-versus-paid, statutory bank reconciliation, cash forecasts and interest exposure need liability, payroll, return and bank data — they show as unavailable until that data is recorded; no balances are invented." />
        </>
      )}
      {capture && <PaymentCapture meta={meta} org={org} ws={ws} onClose={() => setCapture(false)} onSaved={() => { setTick(t => t + 1); }} />}
      {edit && <ReconEditor type={edit.type} id={edit.id} ws={ws} org={org} meta={meta} onClose={() => setEdit(null)} onSaved={() => setTick(t => t + 1)} />}
    </div>
  );
}

function fyNow(date) { const y = +date.slice(0, 4), m = +date.slice(5, 7); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; }

// ── Payment pages ─────────────────────────────────────────────────────────────
function PaymentPages({ page, data, chart, setChart, basis, context, illustrative, demo, meta, onCapture }) {
  const k = data.kpis;
  const exportRows = () => {
    if (page === 'monthly') return [['Month', ...data.sections, 'Total recorded'], data.matrix.map(m => [m.month, ...data.sections.map(s => (m.cells[s] === null ? '' : m.cells[s])), m.total ?? ''])];
    if (page === 'company') return [['Company', 'Principal / deposits', 'Interest & fees', 'Total recorded', 'Rows'], data.by_company.map(g => [g.key, g.principal, g.charges, g.total, g.rows])];
    if (page === 'section') return [['Group', 'Key', 'Principal', 'Interest & fees', 'Total'], [...data.by_section.map(g => ['Section', g.key, g.principal, g.charges, g.total]), ...data.by_registration.map(g => ['Registration', g.key, g.principal, g.charges, g.total]), ...data.tds_by_code.map(g => ['TDS section', g.key, g.principal, '', g.total])]];
    return [['Company', 'Registration', 'Section', 'Liability month', 'Paid date', 'Reference', 'Actual TDS section', 'Principal', 'Interest', 'Fee', 'Total recorded', 'Evidence files'], data.register.map(r => [r.company, r.registration, r.section, r.liability_month, r.paid_date, r.reference, r.code, r.principal, r.charges_known ? r.interest : 'Not captured', r.charges_known ? r.fee : 'Not captured', r.total, r.evidence.length])];
  };
  return (
    <>
      <Toolbar>
        <Btn kind="ghost" onClick={() => { const [h, r] = exportRows(); downloadCsv(`Compliance_${context.Report}_${context.Dataset}.csv`, context, h, r); }}>Export this report · CSV</Btn>
        <PrintBtn />
        {!illustrative && meta.actor.rights.prepare && <Btn kind="primary" onClick={onCapture}>+ Record payment</Btn>}
        {illustrative && demo && <span style={S.muted}>Switch the dataset to “Recorded payments” to record your own (kept apart from the illustrative amounts).</span>}
      </Toolbar>
      <Stats items={[
        { label: 'Recorded amount in scope', value: money(k.recorded_total), sub: 'Payments + TDS principal allocations' },
        { label: 'Principal / cash deposits', value: money(k.principal), sub: 'Excludes interest and fees' },
        { label: 'Recorded interest & fees', value: money(k.charges), sub: k.charges_unknown_rows ? `TDS charges not captured (${k.charges_unknown_rows} allocation rows)` : 'Explicitly recorded charges only' },
        { label: 'Payment references', value: k.references, sub: `${k.rows} rows / allocations` },
      ]} />
      {page === 'monthly' && <>
        <Panel title="Monthly payment trend" right={['columns', 'line'].map(c => <Btn key={c} small kind={chart === c ? 'primary' : 'ghost'} onClick={() => setChart(c)}>{c === 'columns' ? 'Columns' : 'Line'}</Btn>)}
          note={`${basis === 'payment' ? 'Payment month' : 'Liability month'} · ₹ · Months without records are gaps (no recorded payment), not a confirmed nil. TDS includes principal allocations only.`}>
          <TrendChart kind={chart} data={data.matrix.map(m => ({ label: monthName(m.month), value: m.total }))} valueLabel="Recorded" />
        </Panel>
        <Panel title="Monthly payment report · section-wise" note="Select a compliance section above for its individual monthly report and chart. “—” means no recorded rows.">
          <DataTable headers={['Month', ...data.sections, 'Total recorded']} numeric={data.sections.map((_, i) => i + 1).concat(data.sections.length + 1)}
            rows={data.matrix.map(m => [<span className="c2-nowrap">{monthName(m.month)}</span>, ...data.sections.map(s => (m.cells[s] === null ? '—' : money(m.cells[s]))), m.total === null ? '—' : <b>{money(m.total)}</b>])} />
        </Panel>
      </>}
      {page === 'company' && <>
        <Panel title="Payments by company"><HBars entries={data.by_company.map(g => [g.key, g.total])} /></Panel>
        <Panel title="Company payment summary"><DataTable headers={['Company', 'Principal / deposits', 'Interest & fees', 'Total recorded', 'Rows']} numeric={[1, 2, 3, 4]} rows={data.by_company.map(g => [g.key, money(g.principal), g.charges_unknown ? `${money(g.charges)} + TDS not captured` : money(g.charges), money(g.total), g.rows])} /></Panel>
      </>}
      {page === 'section' && <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>
          <Panel title="Payments by compliance section"><HBars entries={data.by_section.map(g => [g.key, g.total])} /></Panel>
          <Panel title="Registration comparison"><HBars entries={data.by_registration.map(g => [g.key, g.total])} /></Panel>
        </div>
        <Panel title="TDS by actual section / Act" note="Principal allocations only. Legacy references are labels, not automatic statutory mappings."><HBars entries={data.tds_by_code.map(g => [g.key, g.total])} /></Panel>
        <Panel title="Interest & fee leakage" note="Based only on explicitly recorded charges. No interest or penalty is calculated; TDS charges are not captured by the section register."><HBars entries={data.charges_by_section.map(g => [g.key, g.total])} /></Panel>
      </>}
      {page === 'register' && <>
        <Panel title="Payment & challan detail">
          <DataTable headers={['Company / registration', 'Section / liability month', 'Paid date', 'Reference / actual TDS section', 'Principal', 'Interest / fees', 'Total recorded', 'Evidence']} numeric={[4, 5, 6]}
            rows={data.register.map(r => [<>{r.company}<br /><small>{r.registration || '—'}</small></>, <>{r.section}{r.status === 'reversed' && <Badge tone="red">Reversed</Badge>}{r.reversal_of && <Badge tone="amber">Reversal</Badge>}<br />{r.liability_month}</>, dt(r.paid_date),
              <>{r.reference}<br /><small>{r.code ? `${r.code}${r.alias && r.alias !== r.code ? ` · ${r.alias}` : ''}${r.mapping === 'unverified' ? ' · mapping unverified' : ''}` : ''}</small></>, money(r.principal), r.charges_known ? money((r.interest || 0) + (r.fee || 0)) : 'Not captured', money(r.total),
              r.evidence.length ? r.evidence.map(id => <Btn key={id} small kind="ghost" onClick={() => openFile(id).catch(() => {})}>Open</Btn>) : (illustrative ? 'Illustrative / no file' : 'Missing')])} />
        </Panel>
        <Notice>The generic filing task “amount paid” field is not added here: it has no separate liability month and may duplicate a challan. Record payments here, and TDS in TDS Section-wise, so each payment is counted once.</Notice>
      </>}
    </>
  );
}

// ── Trends ────────────────────────────────────────────────────────────────────
function TrendsPage({ data, context }) {
  const lab = s => (data.period === 'quarterly' ? s.label : monthName(s.label));
  const l = data.latest;
  return (
    <>
      <Toolbar>
        <Btn kind="ghost" onClick={() => downloadCsv(`Compliance_tax_trends_${data.period}.csv`, { ...context, Metric: data.metric, Comparison: data.period }, ['Period', 'Current', 'Prior', 'Change', 'Change %', 'Status'], data.series.map(s => [lab(s), s.current.value ?? '', s.prior.value ?? '', s.change.delta ?? '', s.change.pct ?? '', `${s.current.state}; ${s.change.label}`]))}>Export trends · CSV</Btn>
        <PrintBtn />
      </Toolbar>
      <Stats items={[
        { label: 'Latest complete period', value: l ? money(l.current.value) : '—', sub: l ? lab(l) : 'No complete period yet' },
        { label: 'Prior period', value: l ? moneyOr(l.prior.value, 'No data') : '—', sub: l ? `${monthName(l.prior.months[0])}${l.prior.months.length > 1 ? ` – ${monthName(l.prior.months[l.prior.months.length - 1])}` : ''} · ${data.period === 'quarterly' ? 'Q1 compares with the prior FY Q4' : 'April compares with March'}` : '' },
        { label: 'Absolute change', value: l ? signed(l.change.delta) : '—', sub: l?.change.label || '' },
        { label: '% change', value: l?.change.pct !== null && l?.change.pct !== undefined ? signed(l.change.pct, true) : 'N/A', sub: 'Change ÷ prior × 100; zero prior → not applicable' },
      ]} />
      <Panel title={`Amounts · ${data.period === 'quarterly' ? 'quarterly' : 'monthly'}`} note="Pale bars are partial / in-progress periods. A gap means no recorded data — never a fabricated zero.">
        <TrendChart data={data.series.map(s => ({ label: lab(s), value: s.current.value, partial: !s.current.complete }))} />
      </Panel>
      <Panel title="Movement against the prior period" note="Above zero = increase; below = decrease. This indicates movement, not good or bad performance. Missing bars are not comparable (missing data, zero baseline, or an incomplete period).">
        <GrowthChart data={data.series.map(s => ({ label: lab(s), pct: s.change.pct }))} />
      </Panel>
      <Panel title="Exact comparison table">
        <DataTable headers={['Period', 'Current', 'Prior', 'Change', '%', 'Data status']} numeric={[1, 2, 3, 4]}
          rows={data.series.map(s => [lab(s), moneyOr(s.current.value, '—'), moneyOr(s.prior.value, '—'), signed(s.change.delta), s.change.pct === null ? 'N/A' : signed(s.change.pct, true), `${s.current.state} · ${s.change.label}`])} />
      </Panel>
      <Panel title="Section small multiples">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
          {data.sections.map(sec => <div key={sec.section} style={{ border: '1px solid #EDF0F6', borderRadius: 10, padding: 10 }}><b style={{ fontSize: 13 }}>{sec.section}</b><TrendChart height={150} data={sec.series.map(s => ({ label: lab(s), value: s.current.value, partial: !s.current.complete }))} /></div>)}
          {!data.sections.length && <div style={S.muted}>No recorded payments for this selection.</div>}
        </div>
      </Panel>
      <Notice>{data.note}</Notice>
    </>
  );
}

// ── Task pages ────────────────────────────────────────────────────────────────
function TaskList({ tasks, onOpenTask }) {
  return <DataTable headers={['Obligation / entity', 'Due date', 'Status', '']} rows={tasks.map(t => [<><b>{t.rule_name}</b> · {t.period_label}<br /><small>{t.scope_label}</small></>, <>{t.effective_due ? dt(t.effective_due) : 'Not scheduled'}<br /><small>{t.revised_due ? 'Revised date' : t.internal ? 'Internal target' : 'Statutory date'}</small></>, <><StatusBadge status={t.status} label={t.status_label} /><br /><Flags flags={t.flags} skip={['sample']} /></>, <Btn small kind="ghost" onClick={() => onOpenTask(t.id)}>Open ↗</Btn>])} empty="No tasks for this selection." />;
}
function TaskPages({ page, data, context, onOpenTask }) {
  const k = data.kpis;
  const csv = () => {
    if (page === 'filing') return downloadCsv('Compliance_filing_performance.csv', context, ['Section', 'Tracked', 'Completed', 'Open', 'Completion %'], data.by_category.map(c => [c.key, c.tracked, c.completed, c.open, c.completion ?? 'Not configured']));
    if (page === 'workload') return downloadCsv('Compliance_team_workload.csv', context, ['Owner', 'Total', 'Open', 'Overdue', 'Awaiting review', 'Completed'], data.owners.map(o => [o.key, o.total, o.open, o.overdue, o.review, o.completed]));
    const list = page === 'overdue' ? [...data.overdue, ...data.upcoming, ...data.unscheduled] : data.exception_tasks;
    return downloadCsv(`Compliance_${page}.csv`, context, ['Task', 'Obligation', 'Period', 'Scope', 'Due date', 'Status', 'Flags'], list.map(t => [t.id, t.rule_name, t.period_label, t.scope_label, t.effective_due || 'Not scheduled', t.status_label, t.flags.join(' ')]));
  };
  return (
    <>
      <Toolbar><Btn kind="ghost" onClick={csv}>Export this report · CSV</Btn><PrintBtn /></Toolbar>
      <Stats items={[{ label: 'Tasks in scope', value: k.total, sub: 'Effective due date / unscheduled' }, { label: 'Completed', value: k.completed, sub: k.completion_pct === null ? 'No tasks in scope' : `${k.completion_pct}% of tracked tasks` }, { label: 'Overdue', value: k.overdue, sub: 'Not filed and past the effective date' }, { label: 'Unscheduled', value: k.unscheduled, sub: 'Due-date rule or event missing' }]} />
      {page === 'filing' && <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>
          <Panel title="Workflow status"><HBars isMoney={false} entries={data.status.map(s => [s.key, s.count])} /></Panel>
          <Panel title="Completed filing timeliness" note="Against the effective statutory date (extensions included). Not a certified statutory on-time score."><HBars isMoney={false} entries={data.timeliness.map(s => [s.key, s.count])} /></Panel>
        </div>
        <Panel title="Completion by compliance section"><DataTable headers={['Section', 'Tracked', 'Completed', 'Open', 'Completion']} numeric={[1, 2, 3, 4]} rows={data.by_category.map(c => [c.key, c.tracked, c.completed, c.open, c.completion === null ? 'Not configured' : `${c.completion}%`])} /></Panel>
      </>}
      {page === 'overdue' && <>
        <Panel title="Overdue ageing · task count"><HBars isMoney={false} entries={data.ageing.map(a => [a.key, a.count])} /></Panel>
        <Panel title="Overdue obligations"><TaskList tasks={data.overdue} onOpenTask={onOpenTask} /></Panel>
        <Panel title={`Due in the next 30 days · ${dt(data.window.from)} – ${dt(data.window.to)} inclusive`} note="Amount due is unavailable until liability data is recorded."><TaskList tasks={data.upcoming} onOpenTask={onOpenTask} /></Panel>
        <Panel title="Unscheduled obligations"><TaskList tasks={data.unscheduled} onOpenTask={onOpenTask} /></Panel>
      </>}
      {page === 'evidence' && <>
        <Panel title="Exception counts · may overlap"><HBars isMoney={false} entries={data.exceptions.map(e => [e.key, e.count])} /></Panel>
        <Panel title="Filing evidence gaps"><TaskList tasks={data.exception_tasks} onOpenTask={onOpenTask} /></Panel>
        <Notice>Sample (demo) documents do not count as uploaded evidence. Evidence presence is not an authenticity check.</Notice>
      </>}
      {page === 'workload' && <>
        <Panel title="Open tasks by owner"><HBars isMoney={false} entries={data.owners.map(o => [o.key, o.open])} /></Panel>
        <Panel title="Owner accountability report"><DataTable headers={['Owner', 'Total', 'Open', 'Overdue', 'Awaiting review', 'Completed']} numeric={[1, 2, 3, 4, 5]} rows={data.owners.map(o => [o.key, o.total, o.open, o.overdue, o.review, o.completed])} /></Panel>
      </>}
    </>
  );
}

// ── Reconciliation pages ──────────────────────────────────────────────────────
function ReconPages({ page, data, context, ws, nameOf, illustrative, canPrepare, onOpen }) {
  const k = data.kpis;
  const csv = () => {
    const rows = [];
    for (const r of data.records) {
      const base = [nameOf(r.entity_id), r.registration, r.month, ws.recon.statuses[r.status], r.missing.length ? 'Incomplete' : 'Complete'];
      if (page === 'gst13b' && r.calc) for (const h of r.calc.heads) rows.push([...base, h.head, h.outward, h.declared, h.variance, h.outPaid, h.paidVariance]);
      else if (page === 'gstcash' && r.calc) rows.push([...base, '', r.calc.liability, r.calc.cash, r.calc.credit, r.calc.settlementGap]);
      else if (page === 'pf' && r.calc) rows.push([...base, '', r.calc.payroll ?? '', r.calc.ecr ?? '', r.calc.variance ?? '', r.calc.challanGap ?? '', r.calc.paidGap ?? '']);
      else if (page === 'esic' && r.calc) rows.push([...base, '', r.calc.ee ?? '', r.calc.pEE ?? '', r.calc.challanEE ?? '', r.calc.er ?? '', r.calc.pER ?? '', r.calc.challanER ?? '']);
      else if (page === 'pt' && r.calc) rows.push([...base, r.calc.type, r.calc.deducted ?? '', r.calc.assessed ?? '', r.calc.paid ?? '']);
      else if (page === 'vendor') rows.push([...base, r.values.vendor, r.values.vendorGstin, r.values.s1, r.values.s3, r.values.invoiceITC, r.values.eligible, r.values.vendorHold, r.values.blocked, r.values.otherHold]);
      else if (page === 'tdsliab' && r.calc) for (const l of r.calc.lines) rows.push([...base, l.act, l.code, l.liability ?? '', l.deposited ?? 'No allocations', l.gap ?? 'Unreconciled']);
      else rows.push(base);
    }
    downloadCsv(`Compliance_${context.Report}.csv`, { ...context, Basis: 'Manual / imported inputs; source evidence not parsed; drafts may be included' }, ['Company', 'Registration', 'Month', 'Status', 'Completeness', 'Detail…'], rows);
  };
  return (
    <>
      <Toolbar>
        {!illustrative && canPrepare && <Btn kind="primary" onClick={() => onOpen(null)}>+ Add {ws.recon.types[data.type]}</Btn>}
        <Btn kind="ghost" onClick={csv}>Export reconciliation CSV</Btn><PrintBtn />
      </Toolbar>
      <Stats items={[{ label: 'Records in scope', value: k.records, sub: 'Selected entity, period and status' }, { label: 'Reviewed', value: k.reviewed, sub: 'Maker / checker enforced by the server' }, { label: 'Missing inputs', value: k.missing, sub: 'Incomplete data is not a match' }, { label: 'With source attachments', value: k.with_evidence, sub: 'Presence ≠ authenticity check' }]} />
      {page === 'gst13b' && <>
        <Panel title="Absolute declaration differences by GSTIN / month" note="Absolute tax-head differences are summed for review priority, so positive and negative heads cannot cancel. The tables below keep the signed differences."><HBars entries={data.chart.map(c => [c.key, c.value])} /></Panel>
        <Panel title="Liability comparison summary"><DataTable headers={['Company / GSTIN / month', 'Adjusted outward liability', '3B declared outward', 'Signed declaration gap', 'Comparable outward paid', 'Signed paid gap', 'Data']} numeric={[1, 2, 3, 4, 5]}
          rows={data.records.map(r => [`${nameOf(r.entity_id)} / ${r.registration} / ${r.month}`, ...['outward', 'declared', 'variance', 'outPaid', 'paidVariance'].map(x => (r.calc ? money(r.calc[x]) : 'Incomplete')), ws.recon.statuses[r.status]])} /></Panel>
        <Notice>Internal early-warning report only. The portal applies its own DRC-01B rules and thresholds; this report cannot guarantee that a notice is avoided. Review amendments, credit notes, advances, period shifts and table mapping before treating a difference as unpaid tax.</Notice>
      </>}
      {page === 'gstcash' && <>
        <Panel title="Cash versus ITC utilisation · monthly trend" note="Only complete GST input records enter this chart. No records means no recorded utilisation, not a confirmed nil return."><StackedBars aLabel="Cash ledger debit" bLabel="ITC utilised" groups={data.months.map(m => ({ label: monthName(m.month), a: m.cash, b: m.credit }))} /></Panel>
        <Panel title="GSTIN settlement mix"><DataTable headers={['Company / GSTIN / month', 'Tax liability', 'Cash utilised', 'Credit utilised', 'Cash %', 'Credit %', 'Unsettled / excess']} numeric={[1, 2, 3, 4, 5, 6]}
          rows={data.mix.map(m => [m.key, money(m.liability), money(m.cash), money(m.credit), m.cash_pct === null ? 'N/A' : `${m.cash_pct}%`, m.credit_pct === null ? 'N/A' : `${m.credit_pct}%`, money(m.gap)])} /></Panel>
        <Notice>Ledger tax debits only — interest, fees, deposits, refunds and cross-utilisation source heads are separate measures and are not mixed in. Monthly payment reports show cash deposits; nothing is counted twice.</Notice>
      </>}
      {page === 'vendor' && <>
        <Panel title="Supplier review priority · higher score = higher internal risk" note="0–100 internal score = 60 × (1 − on-time filings / known due filings) + 40 × (vendor-related ITC hold / assessed invoice ITC). One status per supplier / month / return is counted, even across recipient GSTINs. Unknown / conflicting status or incomplete inputs = Unrated. Not-due and not-applicable returns are excluded. A review aid — not an official rating or an ITC eligibility decision.">
          <HBars isMoney={false} entries={data.scorecard.filter(v => v.risk !== null).map(v => [`${v.name} / ${v.gstin}`, v.risk])} empty="No rated suppliers." />
        </Panel>
        <Panel title="Vendor compliance & ITC risk scorecard"><DataTable headers={['Supplier', 'Risk / 100', 'On-time / known due returns', 'Assessed invoice ITC', 'Vendor-related hold', 'Statutory blocked ITC', 'Other unresolved', 'Eligible assessment', 'How it was scored']} numeric={[3, 4, 5, 6, 7]}
          rows={data.scorecard.map(v => [`${v.name} / ${v.gstin}`, v.risk === null ? <Badge tone="amber">Unrated</Badge> : <b>{v.risk}</b>, `${v.on} / ${v.due}`, money(v.base), money(v.hold), money(v.blocked), money(v.other), money(v.eligible), <small>{v.why}</small>])} /></Panel>
        <Notice>Vendor-related holds are team-attributed and need evidence. Statutorily blocked ITC and other unresolved items stay in separate, non-overlapping buckets; GSTR-2B reflection alone does not establish eligibility.</Notice>
      </>}
      {['pf', 'esic', 'pt'].includes(page) && data.chart && <Panel title={page === 'pf' ? 'Absolute employee contribution differences · payroll vs ECR' : page === 'esic' ? 'Absolute payroll-versus-challan contribution differences' : 'Absolute assessed PT liability versus payment gap'}
        note={page === 'pf' ? 'Employee-level absolute differences (EE, ER, EPS); incomplete records are left out of the chart.' : page === 'esic' ? 'Employee and employer differences assessed separately, then absolute values summed.' : 'PTRC payroll deductions and PTEC entity liabilities remain distinct; state rules are referenced manually.'}>
        <HBars entries={data.chart.map(c => [c.key, c.value])} />
      </Panel>}
      {page === 'tdsliab' && <Panel title="TDS liability vs principal deposited" note="Joined on the exact company, TAN, liability month, Act and section code. Missing allocations are unreconciled — never zero verified payment.">
        <DataTable headers={['Company / TAN / month', 'Act / section', 'Deducted / payable', 'Principal deposited', 'Liability − deposits', 'Status']} numeric={[2, 3, 4]}
          rows={data.lines.map(l => [`${nameOf(l.entity_id)} / ${l.tan} / ${l.month}`, `${l.act === '2025' ? '2025 Act' : '1961 Act'} · ${l.code}`, moneyOr(l.liability), l.deposited === null ? 'No allocations' : money(l.deposited), l.gap === null ? 'Unreconciled' : money(l.gap), <Badge tone={l.state === 'allocated' ? 'green' : 'amber'}>{l.state}</Badge>])} />
      </Panel>}
      <h3 style={{ fontSize: 15, margin: '18px 0 10px' }}>Source records & detailed reconciliation</h3>
      {data.records.length === 0 && <Panel><span style={S.muted}>No reporting inputs for this selection. Add the source data in the relevant section; no data is not a nil variance.</span></Panel>}
      {data.records.map(r => (
        <details key={r.id} style={{ background: '#fff', border: '1px solid #E4E7EF', borderRadius: 13, padding: '12px 16px', marginBottom: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}><b>{nameOf(r.entity_id)}</b> · {r.registration} · {r.month}{r.values?.vendor ? ` · ${r.values.vendor}` : ''} <Badge tone={REVIEW_TONE[r.status]}>{ws.recon.statuses[r.status]}</Badge>{r.missing.length > 0 && <Badge tone="amber">Incomplete inputs</Badge>}</summary>
          <p style={{ ...S.muted, margin: '8px 0' }}>Prepared by {r.prepared_by || '—'} · Reviewer {r.reviewed_by || '—'} · {r.evidence} source file(s){r.version > 1 ? ` · version ${r.version}` : ''}</p>
          <ReconDetail r={{ ...r, type: data.type }} />
          {r.notes && <p style={{ ...S.muted, marginTop: 8 }}>Notes: {r.notes}</p>}
          <div style={{ marginTop: 8 }}>{illustrative ? <Badge tone="amber">Invented illustration · no real attachments</Badge> : <Btn small onClick={() => onOpen(r.id)}>Edit inputs / view source files</Btn>}</div>
        </details>
      ))}
      <Panel title="Official references & calculation boundaries" note="Design sources checked 14 November 2026. Rates, coverage, exemptions and filing rules need applicability review. PF does not assume basic equals contributory wages. No report here changes payment totals, ledger balances or filed returns.">
        <div style={{ fontSize: 12, lineHeight: 1.9 }}>
          <a href="https://tutorial.gst.gov.in/downloads/news/return_compliance_in_form_drc_01b.pdf" target="_blank" rel="noopener noreferrer">GST portal: DRC-01B liability differences ↗</a> · <a href="https://tutorial.gst.gov.in/userguide/returns/FAQ_gstr2b.htm" target="_blank" rel="noopener noreferrer">GST portal: GSTR-2B and ITC eligibility ↗</a> · <a href="https://esic.gov.in/attachments/publicationfile/Annual_Report_2024_2025_1768556111.pdf" target="_blank" rel="noopener noreferrer">ESIC: contribution rates ↗</a> · <a href="https://portal.esic.gov.in/InsuranceGlobalWebV4/ESICInsurancePortal/Documents/MC_Presentation.pdf" target="_blank" rel="noopener noreferrer">ESIC: monthly contribution entry / rounding ↗</a>
        </div>
      </Panel>
    </>
  );
}

// ── Payment capture (every section except TDS) ────────────────────────────────
function PaymentCapture({ meta, org, ws, onClose, onSaved }) {
  const [f, setF] = useState({ entity_id: org.entities[0]?.id || '', registration_id: '', section: 'GST', liability_month: '', paid_date: '', reference: '', principal: '', interest: '0', fee: '0', pt_type: '', notes: '' });
  const [file, setFile] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const regs = org.registrations.filter(r => r.entity_id === f.entity_id);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const { payment } = await api.addPayment({ ...f, registration_id: f.registration_id || null, pt_type: f.section === 'Professional Tax' ? f.pt_type || null : null });
      if (file) { const fd = new FormData(); fd.append('entity_id', payment.entity_id); fd.append('kind', 'challan'); fd.append('module', 'payment'); fd.append('record_id', payment.id); fd.append('file', file); await api.uploadFile(fd); }
      onSaved(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const inp = (k, label, type = 'text', extra = {}) => <label><span style={S.label}>{label}</span><input type={type} value={f[k]} onChange={e => set(k, e.target.value)} style={S.input} {...extra} /></label>;
  return (
    <Modal title="Record a statutory payment" onClose={onClose} width={760}>
      <p style={{ ...S.muted, marginTop: 0 }}>For TDS, use TDS Section-wise (challan + section allocations) so each principal amount is counted once. The liability month (the period the payment is for) and the payment date are separate.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, background: '#FAFBFE', border: '1px solid #EDF0F6', borderRadius: 12, padding: 14 }}>
        <label><span style={S.label}>Company</span><select value={f.entity_id} onChange={e => setF(x => ({ ...x, entity_id: e.target.value, registration_id: '' }))} style={S.input}>{org.entities.map(e => <option key={e.id} value={e.id}>{e.short_code} — {e.legal_name}</option>)}</select></label>
        <label><span style={S.label}>Section</span><select value={f.section} onChange={e => set('section', e.target.value)} style={S.input}>{ws.payable_sections.map(s => <option key={s}>{s}</option>)}</select></label>
        <label><span style={S.label}>Registration (optional for Income Tax / ROC)</span><select value={f.registration_id} onChange={e => set('registration_id', e.target.value)} style={S.input}><option value="">—</option>{regs.map(r => <option key={r.id} value={r.id}>{r.type} · {r.number}</option>)}</select></label>
        {inp('liability_month', 'Liability month', 'month')}
        {inp('paid_date', 'Payment date', 'date', { max: meta.today_ist })}
        {inp('reference', 'Challan / CPIN / TRRN / UTR reference')}
        {inp('principal', 'Principal / tax deposited (₹)', 'number', { min: 0, step: '0.01' })}
        {inp('interest', 'Interest (₹)', 'number', { min: 0, step: '0.01' })}
        {inp('fee', 'Late fee / penalty (₹)', 'number', { min: 0, step: '0.01' })}
        {f.section === 'Professional Tax' && <label><span style={S.label}>PT type</span><select value={f.pt_type} onChange={e => set('pt_type', e.target.value)} style={S.input}><option value="">—</option><option>PTRC</option><option>PTEC</option></select></label>}
        <label><span style={S.label}>Paid challan / bank proof (optional)</span><input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={e => setFile(e.target.files[0] || null)} /></label>
      </div>
      {err && <Note tone="error" style={{ marginTop: 12 }}>{err}</Note>}
      <div style={{ ...S.row, marginTop: 14 }}><Btn kind="primary" disabled={busy} onClick={save}>Save payment</Btn><Btn kind="ghost" onClick={onClose}>Cancel</Btn></div>
    </Modal>
  );
}
