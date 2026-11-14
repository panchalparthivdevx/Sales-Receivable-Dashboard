import React, { useEffect, useState } from 'react';
import { fsApi } from './api';
import { C, S, Card, Note, Loading, ErrorBox, fmtVal, fmtAmt, unitLabel, pctTxt, useLoad, ExportButtons, exportPdf, pdfMeta } from './ui';

export function ComparisonTable({ data, du }) {
  if (!data) return null;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={{ ...S.th, minWidth: 250 }}>Particulars</th><th style={{ ...S.th, ...S.num }}>{data.current.short}</th><th style={{ ...S.th, ...S.num }}>{data.comparator.short}</th>
          <th style={{ ...S.th, ...S.num }}>Change</th><th style={{ ...S.th, ...S.num }}>Change %</th><th style={{ ...S.th, ...S.num }}>% of revenue {data.current.short}</th><th style={{ ...S.th, ...S.num }}>% of revenue {data.comparator.short}</th><th style={{ ...S.th, ...S.num }}>Margin move</th><th style={{ ...S.th, minWidth: 260 }}>Interpretation (confirmed movement)</th>
        </tr></thead>
        <tbody>{data.rows.map(r => (
          <tr key={r.id} style={{ background: r.bold ? C.page : 'transparent' }}>
            <td style={{ ...S.td, fontWeight: r.bold ? 700 : 400 }}>{r.label}{r.derived && <span style={{ color: C.info }} title={r.derived}> *</span>}{r.warn && <span style={{ color: C.warn }} title={r.warn}> ⚠</span>}</td>
            <td style={{ ...S.td, ...S.num, fontWeight: r.bold ? 700 : 400 }}>{fmtVal(r.cur, r.unit, du)}</td>
            <td style={{ ...S.td, ...S.num }}>{fmtVal(r.cmp, r.unit, du)}</td>
            <td style={{ ...S.td, ...S.num }}>{r.unit === 'fraction' ? (r.pp == null ? '' : `${r.pp >= 0 ? '+' : ''}${r.pp.toFixed(2)} pp`) : fmtVal(r.abs, r.unit, du)}</td>
            <td style={{ ...S.td, ...S.num }}>{r.unit === 'fraction' ? '' : pctTxt(r.pct, r.pctNote)}</td>
            <td style={{ ...S.td, ...S.num, color: C.ink2 }}>{r.csCur != null ? `${(r.csCur * 100).toFixed(1)}%` : ''}</td>
            <td style={{ ...S.td, ...S.num, color: C.ink2 }}>{r.csCmp != null ? `${(r.csCmp * 100).toFixed(1)}%` : ''}</td>
            <td style={{ ...S.td, ...S.num }}>{r.bps != null ? `${r.bps >= 0 ? '+' : ''}${r.bps} bps` : r.csMove != null ? `${r.csMove >= 0 ? '+' : ''}${r.csMove.toFixed(1)} pp` : ''}</td>
            <td style={{ ...S.td, color: C.ink2 }}>{r.interpretation}</td>
          </tr>))}</tbody>
      </table>
      <div style={{ ...S.small, marginTop: 6 }}>Change % is not shown on a zero base, and profit ↔ loss movements are named instead of given a percentage. Margins move in percentage points / basis points. * a figure derived because the period is not reported directly. ⚠ an EPS derived in the workbook by subtracting cumulative EPS.</div>
    </div>
  );
}

export function Commentary({ data, du }) {
  if (!data) return null;
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginTop: 12 }}>
    <div style={{ background: C.tint, borderRadius: 8, padding: 12 }}><div style={{ fontWeight: 700, fontSize: '0.8rem', color: C.green, marginBottom: 6 }}>Confirmed movements</div><ul style={{ margin: 0, paddingLeft: 18 }}>{data.commentary.confirmed.map((t, i) => <li key={i} style={{ fontSize: '0.78rem', marginBottom: 4 }}>{t}</li>)}</ul></div>
    <div style={{ background: '#FFF7ED', borderRadius: 8, padding: 12 }}><div style={{ fontWeight: 700, fontSize: '0.8rem', color: '#9A3412', marginBottom: 6 }}>To investigate (possible explanations, not facts)</div>
      {data.commentary.investigate.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{data.commentary.investigate.map((t, i) => <li key={i} style={{ fontSize: '0.78rem', marginBottom: 4 }}>{t}</li>)}</ul> : <div style={S.small}>Nothing stands out beyond the confirmed movements.</div>}
      {data.drivers?.length > 0 && <div style={{ marginTop: 8 }}>{data.drivers.map(dr => <div key={dr.line} style={{ fontSize: '0.74rem', marginBottom: 4 }}><b>{dr.label}</b> (note {dr.note.num}): {dr.moves.map(m => `${m.label} ${m.abs >= 0 ? '+' : '−'}${fmtAmt(Math.abs(m.abs), du)}`).join('; ')}</div>)}</div>}
    </div>
  </div>;
}

export default function CompareTab({ F, periodsInfo, onGoImport }) {
  const presets = useLoad(() => fsApi.presets(F.basis, F.mode), [F.basis, F.mode]);
  const [pair, setPair] = useState(null);
  const [q, setQ] = useState(1);
  const [h, setH] = useState(1);
  useEffect(() => { if (presets.data && !pair) { const first = presets.data.find(x => x.ok); if (first) setPair({ cur: first.cur, cmp: first.cmp }); } }, [presets.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const cmp = useLoad(() => (pair ? fsApi.compare({ basis: F.basis, cur: pair.cur, cmp: pair.cmp, mode: F.mode }) : Promise.resolve(null)), [F.basis, pair && pair.cur, pair && pair.cmp, F.mode]);
  const ty = useLoad(() => fsApi.threeYear({ basis: F.basis, quarter: q, half: h, mode: F.mode }), [F.basis, q, h, F.mode]);
  const flow = (periodsInfo?.PL?.available || []).filter(p => p.availability !== 'working');
  if (presets.error) return <ErrorBox error={presets.error} onGo={onGoImport} />;
  const groups = [...new Set((presets.data || []).map(x => x.group))];
  return (
    <div>
      <Card title="Standard comparisons">
        {presets.loading ? <Loading /> : groups.map(g => <div key={g} style={{ marginBottom: 8 }}>
          <div style={{ ...S.small, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>{g}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{presets.data.filter(x => x.group === g).map(x => (
            <button key={x.title} disabled={!x.ok} title={x.ok ? `${x.curAvail === 'derived' || x.cmpAvail === 'derived' ? 'One side is derived. ' : ''}` : `Not available: ${x.missing.join(' ')}`}
              onClick={() => setPair({ cur: x.cur, cmp: x.cmp })} style={{ ...S.btn(pair?.cur === x.cur && pair?.cmp === x.cmp ? 'primary' : 'outline'), opacity: x.ok ? 1 : 0.45, cursor: x.ok ? 'pointer' : 'not-allowed' }}>
              {x.title}{(x.curAvail === 'derived' || x.cmpAvail === 'derived') ? ' *' : ''}</button>))}</div>
        </div>)}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <span style={S.small}>Or any two periods:</span>
          <select style={S.select} value={pair?.cur || ''} onChange={e => setPair(p => ({ ...(p || {}), cur: e.target.value }))}>{flow.map(p => <option key={p.id} value={p.id}>{p.label}{p.availability === 'derived' ? ' — derived' : ''}</option>)}</select>
          <span style={S.small}>vs</span>
          <select style={S.select} value={pair?.cmp || ''} onChange={e => setPair(p => ({ ...(p || {}), cmp: e.target.value }))}>{flow.map(p => <option key={p.id} value={p.id}>{p.label}{p.availability === 'derived' ? ' — derived' : ''}</option>)}</select>
        </div>
        {(presets.data || []).some(x => !x.ok) && <div style={{ ...S.small, marginTop: 8 }}>Greyed-out comparisons need periods that are not in the imported workbooks — hover for exactly what is missing.</div>}
      </Card>
      {cmp.error && <ErrorBox error={cmp.error} />}
      {cmp.data && <Card title={`${cmp.data.current.label}  vs  ${cmp.data.comparator.label}`} right={<ExportButtons xlsx={{ path: '/export', params: { what: 'compare', basis: F.basis, cur: pair.cur, cmp: pair.cmp, mode: F.mode }, filename: `Comparison_${pair.cur}_vs_${pair.cmp}.xlsx` }}
        pdf={() => exportPdf({ title: `${cmp.data.current.short} vs ${cmp.data.comparator.short} (${F.basis === 'CO' ? 'consolidated' : 'standalone'})`, meta: pdfMeta(F, { periods: `${cmp.data.current.label} vs ${cmp.data.comparator.label}` }),
          columns: [{ label: 'Particulars', key: 'label' }, { label: cmp.data.current.short, align: 'right', get: r => fmtVal(r.cur, r.unit, F.unit) }, { label: cmp.data.comparator.short, align: 'right', get: r => fmtVal(r.cmp, r.unit, F.unit) }, { label: 'Change', align: 'right', get: r => (r.unit === 'fraction' ? (r.pp != null ? `${r.pp.toFixed(2)} pp` : '') : fmtVal(r.abs, r.unit, F.unit)) }, { label: 'Change %', align: 'right', get: r => (r.unit === 'fraction' ? '' : pctTxt(r.pct, r.pctNote)) }, { label: 'Interpretation', key: 'interpretation' }], rows: cmp.data.rows })} />}>
        {cmp.data.current.type !== cmp.data.comparator.type && <Note tone="warn">These periods have different lengths ({cmp.data.current.days} vs {cmp.data.comparator.days} days). Compare margins and rates rather than totals.</Note>}
        <ComparisonTable data={cmp.data} du={F.unit} />
        <Commentary data={cmp.data} du={F.unit} />
      </Card>}
      <Card title="Three-year views" right={<>
        <label style={S.small}>Quarter <select style={S.select} value={q} onChange={e => setQ(+e.target.value)}>{[1, 2, 3, 4].map(x => <option key={x} value={x}>Q{x}</option>)}</select></label>
        <label style={S.small}>Half <select style={S.select} value={h} onChange={e => setH(+e.target.value)}><option value={1}>H1</option><option value={2}>H2</option></select></label>
      </>}>
        {ty.loading ? <Loading /> : ty.data && [['Completed financial years', ty.data.years], [`Same quarter (Q${q}) across three years`, ty.data.quarter], [`Same half year (H${h}) across three years`, ty.data.half]].map(([title, s]) => (
          <div key={title} style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: '0.82rem', marginBottom: 6 }}>{title}</div>
            <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={S.th}>{unitLabel(F.unit)}</th>{s.periods.map(p => <th key={p.id} style={{ ...S.th, ...S.num }}>{p.short}<div style={{ fontWeight: 500, fontSize: '0.62rem' }}>{p.availability === 'missing' ? 'not available' : p.availability}</div></th>)}<th style={{ ...S.th, ...S.num }}>CAGR / change</th></tr></thead>
              <tbody>{s.rows.map(r => { const v = r.values; const first = v[0], last = v[2]; const n = 2; const cagr = r.kind !== 'margin' && r.kind !== 'eps' && first > 0 && last > 0 ? Math.pow(last / first, 1 / n) - 1 : null;
                return <tr key={r.id} style={{ background: r.bold ? C.page : 'transparent' }}><td style={{ ...S.td, fontWeight: r.bold ? 700 : 400 }}>{r.label}</td>{v.map((x, i) => <td key={i} style={{ ...S.td, ...S.num }}>{x == null ? <span style={{ color: C.ink3 }}>—</span> : fmtVal(x, r.kind === 'margin' ? 'fraction' : r.kind === 'eps' ? 'inr' : 'lakh', F.unit)}</td>)}
                  <td style={{ ...S.td, ...S.num, color: C.ink2 }}>{title.startsWith('Completed') && cagr != null ? `${(cagr * 100).toFixed(1)}% CAGR` : r.kind === 'margin' && first != null && last != null ? `${((last - first) * 100).toFixed(1)} pp` : ''}</td></tr>; })}</tbody>
            </table></div>
            {s.missing.length > 0 && <Note tone="warn"><b>Missing data checklist:</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{s.missing.map((m, i) => <li key={i}>{m}</li>)}</ul></Note>}
          </div>))}
      </Card>
    </div>
  );
}
