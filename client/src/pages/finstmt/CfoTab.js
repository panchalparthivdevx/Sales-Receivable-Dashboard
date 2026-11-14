import React, { useState } from 'react';
import axios from 'axios';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from 'recharts';
import { api } from '../../utils/api';
import { fsApi } from './api';
import { C, S, Card, Note, Badge, Loading, ErrorBox, SourceDrill, fmtVal, fmtAmt, unitLabel, pctTxt, useLoad, MissingInputs } from './ui';
import { rsToLakh } from './calc';
import { BudgetVsActual, mLabel } from './BudgetSection';

const chg = (cur, prev) => (cur == null || prev == null || prev === 0 ? null : (cur - prev) / Math.abs(prev));

export function TrendChart({ rows, du, title, height = 240 }) {
  const data = rows.map(r => ({ name: r.short + (r.availability === 'derived' ? '*' : ''), Revenue: r.rev, EBITDA: r.ebitda, PAT: r.pat }));
  const tick = { fontSize: 11, fill: C.ink2 };
  return (
    <div>
      {title && <div style={{ ...S.small, fontWeight: 600, marginBottom: 4 }}>{title}</div>}
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid stroke="#EEF2F0" vertical={false} />
          <XAxis dataKey="name" tick={tick} axisLine={{ stroke: C.line }} tickLine={false} />
          <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={v => fmtAmt(v, du, 0)} width={70} />
          <Tooltip formatter={(v, n) => [`${fmtAmt(v, du)} ${unitLabel(du)}`, n]} contentStyle={{ fontSize: 12, borderRadius: 8, border: `1px solid ${C.line}` }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="Revenue" stroke={C.s1} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} connectNulls={false} />
          <Line type="monotone" dataKey="EBITDA" stroke={C.s2} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} connectNulls={false} />
          <Line type="monotone" dataKey="PAT" stroke={C.s3} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={S.th}>{unitLabel(du)}</th>{rows.map(r => <th key={r.p} style={{ ...S.th, ...S.num }}>{r.short}{r.availability === 'derived' ? '*' : ''}</th>)}</tr></thead>
          <tbody>{[['Revenue', 'rev'], ['EBITDA', 'ebitda'], ['PAT', 'pat']].map(([l, k]) => <tr key={k}><td style={S.td}>{l}</td>{rows.map(r => <td key={r.p} style={{ ...S.td, ...S.num }}>{fmtAmt(r[k], du)}</td>)}</tr>)}</tbody>
        </table>
        {rows.some(r => r.availability === 'derived') && <div style={S.small}>* derived (e.g. Q2 = H1 − Q1) because the period is not reported directly.</div>}
      </div>
    </div>
  );
}

export default function CfoTab({ F, onGoImport, goTab }) {
  const period = F.period;
  const cfo = useLoad(() => fsApi.cfo({ basis: F.basis, period, mode: F.mode }), [F.basis, period, F.mode]);
  const inputs = useLoad(() => fsApi.inputs(), []);
  const ar = useLoad(() => api.arAging().catch(() => null), []);
  const d = cfo.data;
  const p = d?.period?.id;
  const fyLabel = d?.period ? `${d.period.fy - 1}-${String(d.period.fy).slice(2)}` : null;
  const comp = useLoad(() => (fyLabel ? axios.get('/api/compliance/dashboard', { params: { fy: fyLabel } }).then(r => r.data).catch(e => ({ error: e?.response?.data?.error || e.message })) : Promise.resolve(null)), [fyLabel]);
  const fc = useLoad(() => fsApi.forecast(undefined, 6).catch(() => null), []);
  const debtDoc = useLoad(() => fsApi.debt().catch(() => null), []);
  const [drill, setDrill] = useState(null);
  const [ratioPop, setRatioPop] = useState(null);

  if (cfo.error) return <ErrorBox error={cfo.error} onGo={onGoImport} />;
  if (cfo.loading || !d) return <Loading />;
  const recs = inputs.data?.records || [];
  const openKpi = async k => {
    if (k.drill?.kind === 'ratio') return setRatioPop({ k, r: d.ratios[k.drill.ratio] });
    const ids = k.drill?.kind === 'line' ? [k.drill.line] : k.drill?.lines;
    const stmt = k.drill?.kind === 'line' ? 'PL' : 'BS';
    const per = k.drill?.kind === 'line' ? p : k.drill.at;
    const v = await fsApi.statement({ basis: F.basis, stmt, periods: per, mode: F.mode });
    const row = v.rows.find(r => r.id === ids[0]);
    if (row) setDrill({ label: ids.length > 1 ? `${row.label} (one of ${ids.length} lines in "${k.label}")` : row.label, p: v.periods[0], c: row.cells[per], files: v.files, unit: row.unit });
  };

  const capex = recs.filter(r => r.type === 'capex');
  const fcRows = fc.data?.table?.slice(0, 6) || [];
  const facs = debtDoc.data?.facilities || [], covs = debtDoc.data?.covenants || [];

  return (
    <div>
      <Note>All figures for <b>{d.period.label}</b>, {F.basis === 'CO' ? 'consolidated' : 'standalone'}, {F.mode === 'latest' ? 'latest reported' : 'as originally reported'}. Comparison: {d.comparators.qoq ? `previous quarter (${d.comparators.qoq.short}) and ` : ''}same period last year ({d.comparators.yoy?.short}). Click a card for the figures behind it. Monthly figures are not shown — the statements are quarterly / half-yearly and are never split into months.</Note>
      <MissingInputs report="CFO Overview" coverage={d.coverage} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, marginBottom: 16 }}>
        {d.kpis.map(k => {
          const yoy = k.unit === 'fraction' ? (k.v != null && k.yoy != null ? `${((k.v - k.yoy) * 100).toFixed(1)} pp` : '—') : pctTxt(chg(k.v, k.yoy));
          const qoq = d.comparators.qoq ? (k.unit === 'fraction' ? (k.v != null && k.qoq != null ? `${((k.v - k.qoq) * 100).toFixed(1)} pp` : '—') : pctTxt(chg(k.v, k.qoq))) : null;
          return (
            <div key={k.id} onClick={() => openKpi(k)} style={{ ...S.card, marginBottom: 0, cursor: 'pointer', padding: 12 }} title="Click for the figures behind this card">
              <div style={{ ...S.small, fontWeight: 600 }}>{k.label}</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: C.ink, margin: '4px 0' }}>{k.v == null ? '—' : fmtVal(k.v, k.unit, F.unit)}<span style={{ fontSize: '0.65rem', color: C.ink2, fontWeight: 500 }}> {k.unit === 'lakh' && k.v != null ? unitLabel(F.unit) : ''}</span></div>
              <div style={S.small}>YoY {yoy}{qoq ? ` · QoQ ${qoq}` : ''}</div>
              {k.priorLabel && <div style={S.small}>vs {k.priorLabel}: {pctTxt(chg(k.v, k.prior))} ({k.prior == null ? '—' : fmtVal(k.prior, k.unit, F.unit)})</div>}
              {k.status !== 'OK' && <div style={{ marginTop: 4 }}><Badge status={k.status} title={k.note} /></div>}
            </div>);
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <Card title="Revenue, EBITDA and PAT by quarter"><TrendChart rows={d.trends.quarterly} du={F.unit} /></Card>
        <Card title="Revenue, EBITDA and PAT by year"><TrendChart rows={d.trends.annual} du={F.unit} /></Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <Card title="CFO action alerts" right={<button style={S.btn('outline')} onClick={() => goTab('inputs')}>Set thresholds</button>}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={S.th}>Metric</th><th style={{ ...S.th, ...S.num }}>Value</th><th style={S.th}>Threshold</th><th style={S.th}>Status</th></tr></thead>
            <tbody>{d.alerts.map(a => <tr key={a.id}><td style={S.td}>{a.label}</td><td style={{ ...S.td, ...S.num }}>{a.value == null ? '—' : fmtVal(a.value, /margin|occupancy/.test(a.id) ? 'fraction' : a.id === 'wc.dso' ? 'days' : 'times', F.unit)}</td>
              <td style={S.td}>{a.threshold ? `${a.threshold.min != null ? `min ${a.threshold.min}` : ''}${a.threshold.min != null && a.threshold.max != null ? ' / ' : ''}${a.threshold.max != null ? `max ${a.threshold.max}` : ''}` : '—'}</td><td style={S.td} title={a.msg}><Badge status={a.status} title={a.msg} /></td></tr>)}</tbody></table>
          <div style={{ ...S.small, marginTop: 6 }}>A metric is never shown as healthy without both a value and a threshold approved by you.</div>
        </Card>
        <Card title="Data quality" right={<button style={S.btn('outline')} onClick={() => goTab('validation')}>Open validation</button>}>
          {d.dataQuality && <>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>{Object.entries(d.dataQuality.summary).map(([k, n]) => <div key={k}><Badge status={k} /> <b style={{ fontSize: '0.85rem' }}>{n}</b></div>)}</div>
            <div style={{ fontSize: '0.8rem' }}>{d.dataQuality.decisions ? <span style={{ color: C.bad }}><b>{d.dataQuality.decisions}</b> material source conflict(s) await your decision.</span> : 'No source conflicts await a decision.'}</div>
          </>}
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <Card title="Budget vs actual" right={<button style={S.btn('outline')} onClick={() => goTab('performance')}>Details</button>}>
          <BudgetVsActual F={F} period={p} goValidation={() => goTab('validation')} />
        </Card>
        <Card title="Receivables ageing (live, Sales module)" right={<button style={S.btn('outline')} onClick={() => goTab('ar')}>Details</button>}>
          {ar.loading ? <Loading /> : !ar.data ? <Note tone="warn">Receivables ageing is not available from the Sales module just now.</Note> : <>
            <div style={S.small}>As of {ar.data.as_of} — today's open invoices (incl. GST), not the {d.period.short} balance sheet.</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}><tbody>{ar.data.buckets.map(b => <tr key={b.label}><td style={S.td}>{b.label}</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(rsToLakh(b.amount), F.unit)}</td><td style={{ ...S.td, ...S.num, color: C.ink2 }}>{ar.data.total_outstanding ? `${(b.amount / ar.data.total_outstanding * 100).toFixed(1)}%` : ''}</td></tr>)}</tbody></table>
          </>}
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <Card title="Occupancy & unit economics" right={<button style={S.btn('outline')} onClick={() => goTab('branch')}>Details</button>}>
          {['unit.occupancy', 'unit.rev_seat', 'unit.rev_occ_seat', 'unit.rev_sqft', 'unit.ebitda_seat'].map(id => { const r = d.ratios[id]; return <div key={id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', padding: '3px 0', borderBottom: `1px solid ${C.line}` }}><span>{{ 'unit.occupancy': 'Occupancy (time-weighted)', 'unit.rev_seat': 'Revenue / capacity seat / month', 'unit.rev_occ_seat': 'Revenue / occupied seat / month', 'unit.rev_sqft': 'Revenue / sq ft / month', 'unit.ebitda_seat': 'EBITDA / seat / month' }[id]}</span><span>{r?.v != null ? fmtVal(r.v, id === 'unit.occupancy' ? 'fraction' : 'inr', F.unit) : <Badge status={r?.status || 'Missing Input'} title={r?.note} />}</span></div>; })}
        </Card>
        <Card title="Cash forecast & funding gap" right={<button style={S.btn('outline')} onClick={() => goTab('validation')}>Forecast</button>}>
          {fc.loading ? <Loading /> : !fcRows.length ? <Note tone="warn">The collections & payments forecast is not available just now (Data Validation & Reconciliation → Collections & payments forecast).</Note> :
            <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={S.th}>Month</th><th style={{ ...S.th, ...S.num }}>Collections</th><th style={{ ...S.th, ...S.num }}>Payments</th><th style={{ ...S.th, ...S.num }}>Closing cash</th></tr></thead>
              <tbody>{fcRows.map(r => <tr key={r.month}><td style={S.td}>{mLabel(r.month)}</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(r.totalIn, F.unit)}</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(r.totalOut, F.unit)}</td><td style={{ ...S.td, ...S.num, color: r.gap ? C.bad : C.ink }}>{r.closing == null ? 'opening cash n/a' : fmtAmt(r.closing, F.unit)}</td></tr>)}</tbody></table>}
          {fc.data && <div style={S.small}>From today, forecast from Zoho (clients' and vendors' payment days over the last 12 months){fc.data.budget ? ` and the budget "${fc.data.budget.name}"` : ''}. Opening: {fc.data.opening ? `${fc.data.opening.source === 'entered' ? 'bank balance entered' : 'balance-sheet cash'} as at ${fc.data.opening.asAt}` : 'not available'}. A negative closing balance is a funding gap.</div>}
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <Card title="Debt maturity & covenants" right={<button style={S.btn('outline')} onClick={() => goTab('debt')}>Details</button>}>
          <div style={{ fontSize: '0.8rem' }}>Borrowings at {d.period.end}: <b>{fmtVal(d.kpis.find(k => k.id === 'lev.debt')?.v, 'lakh', F.unit)}</b> {unitLabel(F.unit)}</div>
          <div style={{ fontSize: '0.8rem' }}>Scheduled principal, next 12 months from today: {facs.some(x => x.scheduleRows) ? <b>{fmtAmt(rsToLakh(facs.reduce((t, x) => t + (x.next12Principal || 0), 0)), F.unit)}</b> : <Badge status="Missing Input" title="Data Validation → Debt schedule & covenants" />}</div>
          <div style={{ fontSize: '0.8rem' }}>Covenants: {covs.length ? <>{covs.length} — {['Breach', 'Missing data', 'Within threshold'].map(st => [st, covs.filter(c => c.status === st).length]).filter(([, n]) => n).map(([st, n]) => `${n} ${st.toLowerCase()}`).join(', ')}</> : <Badge status="Missing Input" title="Data Validation → Debt schedule & covenants" />}</div>
        </Card>
        <Card title="Capex & expansion" right={<button style={S.btn('outline')} onClick={() => goTab('capex')}>Details</button>}>
          <div style={{ fontSize: '0.8rem' }}>Capex in the period (cash flow): <b>{d.ratios['cf.capex_rev']?.v != null ? fmtVal(d.ratios['cf.capex_rev'].v, 'fraction') + ' of revenue' : 'cash flow not available'}</b></div>
          <div style={{ fontSize: '0.8rem' }}>Projects with budgets: {capex.length ? capex.length : <Badge status="Missing Input" title="Management Inputs → Capex" />}</div>
        </Card>
        <Card title="Compliance exceptions" right={<button style={S.btn('outline')} onClick={() => goTab('compliance')}>Details</button>}>
          {comp.loading ? <Loading /> : comp.data?.error || !comp.data?.kpis ? <Note tone="warn">Compliance status is not available ({comp.data?.error || 'no tasks for this year'}). It is never assumed compliant.</Note> :
            comp.data.kpis.total === 0 ? <Note tone="warn">No compliance tasks exist for FY{fyLabel} — status unknown, not "compliant".</Note> :
            <div style={{ fontSize: '0.8rem' }}>Overdue: <b style={{ color: comp.data.kpis.overdue ? C.bad : C.ink }}>{comp.data.kpis.overdue}</b> · Due soon: <b>{comp.data.kpis.due_soon}</b> · Completed: {comp.data.kpis.completed}/{comp.data.kpis.applicable}</div>}
        </Card>
      </div>

      <SourceDrill open={!!drill} onClose={() => setDrill(null)} label={drill?.label} period={drill?.p} cell={drill?.c} files={drill?.files} unit={drill?.unit} du={F.unit} />
      {ratioPop && <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setRatioPop(null)}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 18, maxWidth: 560, width: '100%' }} onClick={e => e.stopPropagation()}>
          <div style={{ fontWeight: 700 }}>{ratioPop.k.label}</div>
          <div style={{ fontSize: '1.2rem', fontWeight: 700, margin: '6px 0' }}>{fmtVal(ratioPop.r?.v, ratioPop.k.unit, F.unit)} <Badge status={ratioPop.r?.status} /></div>
          {ratioPop.r?.note && <div style={S.small}>{ratioPop.r.note}</div>}
          {ratioPop.r?.parts && <table style={{ borderCollapse: 'collapse', marginTop: 8 }}><tbody>{Object.entries(ratioPop.r.parts).map(([k, v]) => <tr key={k}><td style={S.td}>{k}</td><td style={{ ...S.td, ...S.num }}>{typeof v === 'number' && Math.abs(v) > 50 ? fmtAmt(v, F.unit) : v}</td></tr>)}</tbody></table>}
          <div style={{ ...S.small, marginTop: 8 }}>Definition and formula: Ratio Analytics → formula dictionary.</div>
        </div>
      </div>}
    </div>
  );
}
