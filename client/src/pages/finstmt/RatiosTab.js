import React, { useEffect, useState } from 'react';
import { fsApi } from './api';
import { C, S, Card, Note, Badge, Loading, ErrorBox, fmtVal, useLoad, ExportButtons, exportPdf, pdfMeta } from './ui';

const yoyOf = p => p.replace(/^FY(\d{4})/, (m, y) => `FY${+y - 1}`);

export default function RatiosTab({ F, periodsInfo, onGoImport }) {
  const [cols, setCols] = useState([]);
  const [showDict, setShowDict] = useState(false);
  const [cat, setCat] = useState('');
  useEffect(() => {
    if (!F.period) return;
    const avail = new Set((periodsInfo?.PL?.available || []).map(p => p.id));
    const lastFy = (periodsInfo?.PL?.available || []).filter(p => p.type === 'FY').map(p => p.id).sort().pop();
    setCols([F.period, yoyOf(F.period), lastFy].filter((p, i, a) => p && avail.has(p) && a.indexOf(p) === i));
  }, [F.period, periodsInfo]);
  const { loading, data, error } = useLoad(() => (cols.length ? fsApi.ratios({ basis: F.basis, periods: cols.join(','), mode: F.mode }) : Promise.resolve(null)), [F.basis, cols.join(','), F.mode]);
  if (error) return <ErrorBox error={error} onGo={onGoImport} />;
  const dict = data?.dictionary || [];
  const cats = [...new Set(dict.map(d => d.cat))];
  const results = data?.results || [];
  const avail = (periodsInfo?.PL?.available || []).filter(p => p.availability !== 'working');
  const shown = dict.filter(d => !cat || d.cat === cat);
  return (
    <div>
      <Note>Recalculated management ratios, each with its status. <b>Proxy</b> = computed on a stated substitute basis (e.g. closing balance because no opening balance sheet exists, or purchases approximated); <b>Missing input</b> = a figure the statements cannot supply (enter it on Management Inputs); <b>Not meaningful</b> = e.g. a negative or zero denominator. Interim returns and turnovers are annualised by actual days and say so. Ratios disclosed in the results are shown beside the recalculated value with their own definition.</Note>
      <Card title="Ratio analytics" right={<>
        <select style={S.select} value={cat} onChange={e => setCat(e.target.value)}><option value="">All categories</option>{cats.map(c => <option key={c}>{c}</option>)}</select>
        <select style={S.select} value="" onChange={e => e.target.value && setCols([...cols, e.target.value])}><option value="">+ add period…</option>{avail.filter(p => !cols.includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        <button style={S.btn('outline')} onClick={() => setShowDict(s => !s)}>{showDict ? 'Hide' : 'Show'} formula dictionary</button>
        <ExportButtons xlsx={{ path: '/export', params: { what: 'ratios', basis: F.basis, periods: cols.join(','), mode: F.mode }, filename: `Ratios_${F.basis}.xlsx` }}
          pdf={() => exportPdf({ title: `Ratio analytics (${F.basis === 'CO' ? 'consolidated' : 'standalone'})`, meta: pdfMeta(F, { periods: results.map(r => r.period.label).join('; ') }),
            columns: [{ label: 'Metric', key: 'name' }, ...results.map(r => ({ label: r.period.short, align: 'right', get: d => { const x = r.values[d.id]; return x?.v != null ? fmtVal(x.v, d.unit, F.unit) : x?.status || ''; } })), ...results.map(r => ({ label: `${r.period.short} status`, get: d => r.values[d.id]?.status || '' }))], rows: shown })} />
      </>}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>{cols.map(id => <span key={id} style={{ background: C.tint, borderRadius: 12, padding: '2px 4px 2px 10px', fontSize: '0.72rem', color: C.green }}>{avail.find(p => p.id === id)?.short || id}<button onClick={() => setCols(cols.filter(x => x !== id))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.ink2 }}>×</button></span>)}</div>
        {loading ? <Loading /> : <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={{ ...S.th, minWidth: 260 }}>Metric</th>{results.map(r => <th key={r.period.id} style={{ ...S.th, ...S.num, minWidth: 150 }}>{r.period.short}<div style={{ fontWeight: 500, fontSize: '0.62rem' }}>{r.period.days} days</div></th>)}</tr></thead>
            <tbody>{cats.filter(c => !cat || c === cat).map(c => <React.Fragment key={c}>
              <tr><td colSpan={1 + results.length} style={{ ...S.td, background: C.tint, fontWeight: 700, color: C.green, fontSize: '0.75rem', textTransform: 'uppercase' }}>{c}</td></tr>
              {dict.filter(d => d.cat === c).map(d => <tr key={d.id}>
                <td style={S.td} title={`${d.definition}\nFormula: ${d.formula}`}>{d.name}<div style={{ ...S.small, fontSize: '0.66rem' }}>{d.formula}</div></td>
                {results.map(r => { const x = r.values[d.id]; const disc = d.srcRatio ? r.disclosed[d.srcRatio] : null;
                  return <td key={r.period.id} style={{ ...S.td, ...S.num }} title={x?.note || ''}>
                    <div style={{ fontWeight: 600 }}>{x?.v != null ? fmtVal(x.v, d.unit, F.unit) : ''}</div>
                    {x && x.status !== 'OK' && <Badge status={x.status} title={x.note} />}
                    {x?.note && x.status === 'OK' && <div style={{ ...S.small, fontSize: '0.62rem' }}>{x.note.slice(0, 60)}</div>}
                    {disc && <div style={{ fontSize: '0.66rem', color: C.info }} title={disc.definition || ''}>disclosed: {fmtVal(disc.v, d.unit === 'fraction' ? 'fraction' : 'times')}</div>}
                  </td>; })}
              </tr>)}
            </React.Fragment>)}</tbody>
          </table>
          <div style={{ ...S.small, marginTop: 6 }}>Hover a metric for its definition, a value for its basis note. “disclosed” = the ratio as printed in the results (definition on hover); where it differs from the recalculated value, the definitions differ — e.g. the results' debtors turnover uses the closing receivable balance on annualised revenue; Q1 balance-sheet ratios in the Sep-26 working are averages of March and September ratios because no June balance sheet exists.</div>
        </div>}
      </Card>
      {showDict && <Card title="Formula dictionary">
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Metric', 'Definition', 'Formula', 'Inputs', 'Source', 'Period basis', 'Annualisation', 'Status'].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>{dict.map(d => <tr key={d.id}><td style={{ ...S.td, fontWeight: 600 }}>{d.name}</td><td style={S.td}>{d.definition}</td><td style={S.td}>{d.formula}</td><td style={S.td}>{d.inputs.join(', ')}</td><td style={S.td}>{d.source}</td><td style={S.td}>{d.basis}</td><td style={S.td}>{d.annual}</td><td style={S.td}>{d.status}</td></tr>)}</tbody>
        </table></div>
      </Card>}
    </div>
  );
}
