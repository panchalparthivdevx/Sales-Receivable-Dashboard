import React, { useEffect, useState } from 'react';
import { S } from '../billbooking/ui';
import { cf, errMsg, inr, dmy, monthLabel } from './cfApi';
import { C, Num, Modal, PartsTable } from './cfUi';

// ─── Financial year, month-wise (Rent): branch × landlord rows, one column per month (April → March), drill-down per cell ───

const MEASURES = [
  ['billed', 'Bills (net payable)', 'Net payable of the bills, by planned payment month'],
  ['budget', 'Budget', 'Finalised budget lines, by planned payment month'],
  ['paid', 'Paid', 'Paid (and advances applied) against the bills of the month'],
  ['outstanding', 'Outstanding', 'Still unpaid today on the bills of the month'],
  ['cash', 'Cash paid', 'Payments by their payment date'],
];

export default function FyGrid({ cat, filters, meta, onOpenPart }) {
  const [measure, setMeasure] = useState('billed');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null);
  const { company, fy, branch, vendor } = filters;

  useEffect(() => {
    let live = true;
    setData(null); setError('');
    cf.fyGrid({ company, fy, category: cat, branch, vendor }).then(d => { if (live) setData(d); }).catch(e => { if (live) setError(errMsg(e)); });
    return () => { live = false; };
  }, [company, fy, cat, branch, vendor]);

  if (error) return <div style={S.error}>{error}</div>;
  if (!data) return <div style={S.center}>Loading the financial year…</div>;
  const months = data.months;
  const openCell = (row, m) => {
    const c = row ? row.cells[m] : null;
    const keys = row ? (c?.parts || []) : [...new Set(data.rows.flatMap(r => r.cells[m]?.parts || []))];
    setDrill({ title: row ? `${row.vendor} — ${monthLabel(m)}` : `All landlords — ${monthLabel(m)}`, sub: row ? row.branch : '', parts: keys.map(k => data.parts[k]).filter(Boolean) });
  };
  let lastBranch = null, sr = 0;
  const fyTotal = r => months.reduce((s, m) => s + (r.cells[m]?.[measure] || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', gap: 0, marginBottom: '0.6rem', flexWrap: 'wrap' }}>
        {MEASURES.map(([k, l, tip], i) => (
          <button key={k} type="button" title={tip} style={{ ...C.pill(measure === k), borderRadius: i === 0 ? '6px 0 0 6px' : i === MEASURES.length - 1 ? '0 6px 6px 0' : 0, marginLeft: i ? -1 : 0 }} onClick={() => setMeasure(k)}>{l}</button>
        ))}
        <span style={{ ...S.small, alignSelf: 'center', marginLeft: 10 }}>FY {data.fy} · click a figure for the bills behind it</span>
      </div>
      <div style={{ ...S.card, overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
          <thead>
            <tr>
              <th style={S.th} rowSpan={2}>Sr.</th><th style={S.th} rowSpan={2}>Branch</th><th style={S.th} rowSpan={2}>Landlord / developer</th>
              <th style={S.th} rowSpan={2}>Last bill</th>
              {['Basic', 'GST', 'Bill amount', 'TDS', 'Payable'].map(h => <th key={h} style={{ ...S.th, ...C.num }} rowSpan={2}>{h}<div style={{ fontWeight: 400, textTransform: 'none' }}>FY to date</div></th>)}
              <th style={{ ...S.th, textAlign: 'center', borderLeft: '2px solid #DFE7E3' }} colSpan={months.length + 1}>{MEASURES.find(x => x[0] === measure)[1]}</th>
            </tr>
            <tr>{months.map((m, i) => <th key={m} style={{ ...S.th, ...C.num, top: 30, ...(i === 0 ? { borderLeft: '2px solid #DFE7E3' } : {}) }}>{monthLabel(m)}</th>)}<th style={{ ...S.th, ...C.num, top: 30 }}>FY total</th></tr>
          </thead>
          <tbody>
            {!data.rows.length && <tr><td colSpan={10 + months.length} style={S.center}>No {cat} bills or budget lines in FY {data.fy}.</td></tr>}
            {data.rows.map(r => {
              const first = r.branch !== lastBranch; lastBranch = r.branch;
              return (
                <tr key={r.key}>
                  <td style={{ ...S.td, color: '#9BA8B0' }}>{++sr}</td>
                  <td style={{ ...S.td, fontWeight: first ? 600 : 400, color: first ? '#18191B' : '#9BA8B0' }}>{r.branch}</td>
                  <td style={S.td}>{r.vendor}</td>
                  <td style={S.td}>{r.last_bill ? <button type="button" style={C.link} onClick={() => data.parts[r.last_bill.key] && onOpenPart(data.parts[r.last_bill.key])}>{r.last_bill.no}</button> : '—'}{r.last_bill && <div style={S.small}>{dmy(r.last_bill.date)}</div>}</td>
                  {['basic', 'gst', 'gross', 'tds', 'net'].map(k => <td key={k} style={{ ...S.td, ...C.num }}>{inr(r[k])}</td>)}
                  {months.map((m, i) => <td key={m} style={{ ...S.td, ...C.num, ...(i === 0 ? { borderLeft: '2px solid #DFE7E3' } : {}) }}><Num value={r.cells[m]?.[measure]} onClick={measure === 'budget' ? undefined : () => openCell(r, m)} /></td>)}
                  <td style={{ ...S.td, ...C.num, fontWeight: 600 }}>{inr(fyTotal(r))}</td>
                </tr>
              );
            })}
            {data.rows.length > 0 && (
              <tr style={{ background: '#F6FAF8' }}>
                <td style={{ ...S.td, fontWeight: 700 }} colSpan={4}>Total</td>
                {['basic', 'gst', 'gross', 'tds', 'net'].map(k => <td key={k} style={{ ...S.td, ...C.num, fontWeight: 700 }}>{inr(data.rows.reduce((s, r) => s + r[k], 0))}</td>)}
                {months.map((m, i) => <td key={m} style={{ ...S.td, ...C.num, fontWeight: 700, ...(i === 0 ? { borderLeft: '2px solid #DFE7E3' } : {}) }}><Num value={data.totals[m][measure]} strong onClick={measure === 'budget' ? undefined : () => openCell(null, m)} /></td>)}
                <td style={{ ...S.td, ...C.num, fontWeight: 700 }}>{inr(months.reduce((s, m) => s + data.totals[m][measure], 0))}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={S.small}>Months follow the financial year you choose above; Basic, GST, Bill amount, TDS and Payable are the year's bills so far.</div>
      {drill && <Modal title={drill.title} sub={drill.sub} wide onClose={() => setDrill(null)}><PartsTable parts={drill.parts} onOpen={p => { setDrill(null); onOpenPart(p); }} /></Modal>}
    </div>
  );
}
