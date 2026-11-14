import React from 'react';
import { fsApi } from './api';
import { C, S, Card, Note, Badge, Loading, ErrorBox, fmtVal, fmtAmt, unitLabel, useLoad, MissingInputs } from './ui';
import { ComparisonTable, Commentary } from './CompareTab';
import { TrendChart } from './CfoTab';
import { lineValue } from './calc';
import { BudgetVsActual } from './BudgetSection';

const yoyOf = p => p.replace(/^FY(\d{4})/, (m, y) => `FY${+y - 1}`);

export default function PerformanceTab({ F, onGoImport }) {
  const cur = F.period;
  const cmpP = F.cmp && F.cmp !== 'auto' ? F.cmp : cur ? yoyOf(cur) : null;
  const cmp = useLoad(() => (cur ? fsApi.compare({ basis: F.basis, cur, cmp: cmpP, mode: F.mode }) : Promise.resolve(null)), [F.basis, cur, cmpP, F.mode]);
  const rat = useLoad(() => (cur ? fsApi.ratios({ basis: F.basis, periods: `${cur},${cmpP}`, mode: F.mode }) : Promise.resolve(null)), [F.basis, cur, cmpP, F.mode]);
  const cfo = useLoad(() => fsApi.cfo({ basis: F.basis, period: cur, mode: F.mode }), [F.basis, cur, F.mode]);
  const inputs = useLoad(() => fsApi.inputs(), []);
  const pl = useLoad(() => (cur ? fsApi.statement({ basis: F.basis, stmt: 'PL', periods: cur, mode: F.mode }) : Promise.resolve(null)), [F.basis, cur, F.mode]);
  const notes = useLoad(() => (cur ? fsApi.notes({ basis: F.basis, periods: cur, mode: F.mode }) : Promise.resolve(null)), [F.basis, cur, F.mode]);
  if (cmp.error) return <ErrorBox error={cmp.error} onGo={onGoImport} />;
  if (!cur) return <Loading />;
  const R = rat.data?.results || [];
  const rv = (i, id) => R[i]?.values?.[id];
  const recs = inputs.data?.records || [];
  const per = cmp.data?.current;
  const classes = recs.filter(r => r.type === 'cost_class');
  const revNote = notes.data?.groups?.find(g => g.lines.includes('pl.rev'));
  const revItems = revNote ? revNote.rows.filter(r => !r.subhead && !r.total && r.cells[cur]?.v) : [];
  const revTot = revItems.reduce((s, r) => s + r.cells[cur].v, 0);

  // break-even from the fixed / variable classification of statement lines
  let breakEven = null;
  if (classes.length && pl.data) {
    const map = { 'operating expenses': 'pl.exp_ops', 'employee benefits expense': 'pl.exp_emp', 'other expenses': 'pl.exp_oth', 'finance costs': 'pl.exp_fin', 'depreciation and amortisation': 'pl.exp_dep' };
    let fixed = 0, variable = 0, unmatched = [];
    for (const c of classes) {
      const id = map[String(c.values.item).toLowerCase()];
      const v = id ? lineValue(pl.data, id, cur) : null;
      if (v == null) { unmatched.push(c.values.item); continue; }
      const share = /^variable/i.test(c.values.class) ? 1 : /^semi/i.test(c.values.class) ? Number(c.values.variableShare || 0) : 0;
      variable += v * share; fixed += v * (1 - share);
    }
    const rev = lineValue(pl.data, 'pl.rev', cur);
    const cm = rev ? 1 - variable / rev : null;
    breakEven = { fixed, variable, rev, cm, be: cm && cm > 0 ? fixed / cm : null, unmatched };
  }
  const leaseRows = rv(0, 'prof.ebitda_lease')?.parts;
  return (
    <div>
      <MissingInputs report="Financial Performance" coverage={cfo.data?.coverage} />
      {cmp.loading ? <Loading /> : cmp.data && <Card title={`Profit and loss — ${cmp.data.current.label} vs ${cmp.data.comparator.label}`}><ComparisonTable data={cmp.data} du={F.unit} /><Commentary data={cmp.data} du={F.unit} /></Card>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <Card title="Expense-to-revenue">
          {rat.loading ? <Loading /> : <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={S.th}>Cost as % of revenue</th><th style={{ ...S.th, ...S.num }}>{R[0]?.period.short}</th><th style={{ ...S.th, ...S.num }}>{R[1]?.period.short}</th><th style={{ ...S.th, ...S.num }}>Move</th></tr></thead>
            <tbody>{['exp.ops', 'exp.rent', 'exp.elec', 'exp.hk', 'exp.maint', 'exp.emp', 'exp.salary', 'exp.oth', 'exp.fin', 'exp.dep', 'exp.tot'].map(id => { const a = rv(0, id), b = rv(1, id); const name = rat.data.dictionary.find(d => d.id === id)?.name.replace(' % of revenue', '');
              return <tr key={id}><td style={{ ...S.td, paddingLeft: ['exp.rent', 'exp.elec', 'exp.hk', 'exp.maint'].includes(id) || id === 'exp.salary' ? 24 : 10, fontWeight: id === 'exp.tot' ? 700 : 400 }}>{name}</td>
                <td style={{ ...S.td, ...S.num }}>{a?.v != null ? fmtVal(a.v, 'fraction') : <Badge status={a?.status || 'Missing Input'} title={a?.note} />}</td><td style={{ ...S.td, ...S.num }}>{b?.v != null ? fmtVal(b.v, 'fraction') : <Badge status={b?.status || 'Missing Input'} title={b?.note} />}</td>
                <td style={{ ...S.td, ...S.num }}>{a?.v != null && b?.v != null ? `${((a.v - b.v) * 100).toFixed(1)} pp` : ''}</td></tr>; })}</tbody></table>}
          <div style={{ ...S.small, marginTop: 6 }}>Indented lines come from the note schedules (available for half years, years and Q1; a quarter derived by subtraction has no note).</div>
        </Card>
        <Card title="EBITDA, reported vs lease-adjusted">
          {!leaseRows ? <Note tone="warn">{rv(0, 'prof.ebitda_lease')?.note || 'Needs the cash flow statement of the period (lease payments).'} Quarterly cash flows are not published.</Note> :
            <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
              <tr><td style={S.td}>EBITDA as reported (PBT + finance costs + D&A)</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(leaseRows.EBITDA, F.unit)}</td></tr>
              <tr><td style={S.td}>Less: interest paid on lease liabilities (cash flow)</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(leaseRows['Lease interest paid'], F.unit)}</td></tr>
              <tr><td style={S.td}>Less: principal paid on lease liabilities (cash flow)</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(leaseRows['Lease principal paid'], F.unit)}</td></tr>
              <tr style={{ background: C.page }}><td style={{ ...S.td, fontWeight: 700 }}>Lease-adjusted (pre-Ind AS 116) EBITDA</td><td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{fmtAmt(rv(0, 'prof.ebitda_lease')?.v, F.unit)}</td></tr>
              <tr><td style={S.td}>Margin: reported / lease-adjusted</td><td style={{ ...S.td, ...S.num }}>{fmtVal(rv(0, 'prof.ebitda_m')?.v, 'fraction')} / {fmtVal(rv(0, 'prof.ebitda_lease_m')?.v, 'fraction')}</td></tr>
            </tbody></table>}
          <div style={{ ...S.small, marginTop: 6 }}>Rent on short-term / variable leases is already inside operating expenses and is not deducted again. {unitLabel(F.unit)}.</div>
        </Card>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <Card title="Budget vs actual">
          <BudgetVsActual F={F} period={cur} />
        </Card>
        <Card title="Break-even (fixed / variable costs)">
          {!breakEven ? <Note tone="warn">Needs the fixed / variable classification of expense lines (Management Inputs → Fixed / variable cost classification). Nothing is assumed.</Note> :
            <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
              <tr><td style={S.td}>Fixed costs in the period</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(breakEven.fixed, F.unit)}</td></tr>
              <tr><td style={S.td}>Variable costs</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(breakEven.variable, F.unit)}</td></tr>
              <tr><td style={S.td}>Contribution margin</td><td style={{ ...S.td, ...S.num }}>{fmtVal(breakEven.cm, 'fraction')}</td></tr>
              <tr style={{ background: C.page }}><td style={{ ...S.td, fontWeight: 700 }}>Break-even revenue (same period)</td><td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{breakEven.be == null ? 'n/m' : fmtAmt(breakEven.be, F.unit)}</td></tr>
              <tr><td style={S.td}>Actual revenue / margin of safety</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(breakEven.rev, F.unit)}{breakEven.be ? ` / ${(((breakEven.rev - breakEven.be) / breakEven.rev) * 100).toFixed(1)}%` : ''}</td></tr>
            </tbody></table>}
          {breakEven?.unmatched?.length > 0 && <div style={S.small}>Not matched to a statement line: {breakEven.unmatched.join(', ')}.</div>}
        </Card>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <Card title={`Revenue mix — ${per?.short || ''}`}>
          {!revItems.length ? <Note tone="warn">No revenue note for this period (notes exist for half years, years and Q1).</Note> :
            <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>{revItems.sort((a, b) => b.cells[cur].v - a.cells[cur].v).map(r => <tr key={r.label}><td style={S.td}>{r.label}</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(r.cells[cur].v, F.unit)}</td><td style={{ ...S.td, ...S.num, color: C.ink2 }}>{(r.cells[cur].v / revTot * 100).toFixed(1)}%</td></tr>)}</tbody></table>}
          {revNote && <div style={S.small}>From note {revNote.sourceNotes[cur]?.num} ({revNote.sourceNotes[cur]?.file}).</div>}
        </Card>
        <Card title="Quarterly trend">{cfo.data ? <TrendChart rows={cfo.data.trends.quarterly} du={F.unit} height={200} /> : <Loading />}</Card>
      </div>
    </div>
  );
}
