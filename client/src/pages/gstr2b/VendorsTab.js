import React, { useEffect, useState } from 'react';
import { g, errMsg } from './gApi';
import { S, Tag, inr, monthName } from './ui';

// Per supplier: what is open, how often, how late. Supplier filing status is shown only where GSTR-2B itself states it
// (with its period and date); otherwise "Unknown". Message drafts and follow-up tracking arrive in Phase 2.
export default function VendorsTab({ meta, filters, stamp, onDrill }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const key = JSON.stringify(filters);
  useEffect(() => { g.vendors(filters).then(r => setList(r.vendors)).catch(e => setError(errMsg(e))); }, [key, stamp]); // eslint-disable-line

  if (error) return <div style={S.error}>{error}</div>;
  if (!list) return <div style={S.center}>Loading…</div>;
  const shown = list.filter(v => (!onlyOpen || v.discrepancy_rows > 0) && (!q || `${v.name} ${v.gstin}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div>
      <div style={S.info}>Vendor follow-up messages and tracking (owner, due date, response, resolution) are planned for Phase 2. For now, open a supplier's documents and use the owner / next action fields, or export the list to Excel (Vendor summary sheet).</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input style={{ ...S.input, width: 260 }} placeholder="Search supplier name or GSTIN" value={q} onChange={e => setQ(e.target.value)} />
        <label style={{ fontSize: '0.78rem', display: 'flex', gap: 4 }}><input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} /> Only suppliers with open items</label>
        <button style={S.ghost} onClick={() => g.exportXlsx(filters).catch(e => setError(errMsg(e)))}>Export to Excel</button>
        <span style={S.muted}>{shown.length} supplier(s)</span>
      </div>
      <div style={{ ...S.card, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto', maxHeight: '70vh' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1250 }}>
            <thead><tr>
              <th style={S.th}>Supplier</th><th style={{ ...S.th, ...S.thR }}>Matched</th><th style={{ ...S.th, ...S.thR }}>Suggested</th><th style={{ ...S.th, ...S.thR }}>Mismatched</th><th style={{ ...S.th, ...S.thR }}>Books only</th><th style={{ ...S.th, ...S.thR }}>GSTR-2B only</th>
              <th style={{ ...S.th, ...S.thR }}>GST at stake</th><th style={{ ...S.th, ...S.thR }}>Months with open items</th><th style={{ ...S.th, ...S.thR }}>Late-reported</th><th style={{ ...S.th, ...S.thR }}>Avg. delay (months)</th><th style={S.th}>Filing status</th><th style={S.th}>Notes</th>
            </tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={12} style={{ ...S.td, textAlign: 'center', padding: '2rem', color: '#9BA8B0' }}>No suppliers for the current filters.</td></tr>}
              {shown.map(v => (
                <tr key={v.gstin || v.name} style={{ cursor: 'pointer' }} onClick={() => onDrill({ vendor: v.gstin || v.name })}>
                  <td style={{ ...S.td, minWidth: 220 }}><div style={{ fontWeight: 600 }}>{v.name || '—'}</div><div style={S.small}>{v.gstin || 'no GSTIN'}</div></td>
                  <td style={{ ...S.td, ...S.num }}>{v.matched}</td><td style={{ ...S.td, ...S.num, color: v.suggested ? '#B45309' : undefined }}>{v.suggested}</td><td style={{ ...S.td, ...S.num, color: v.mismatched ? '#B91C1C' : undefined }}>{v.mismatched}</td>
                  <td style={{ ...S.td, ...S.num, color: v.books_only ? '#6D28D9' : undefined }}>{v.books_only}</td><td style={{ ...S.td, ...S.num, color: v.portal_only ? '#1D4ED8' : undefined }}>{v.portal_only}</td>
                  <td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{inr(v.gst_at_stake)}</td>
                  <td style={{ ...S.td, ...S.num }} title={v.months.map(monthName).join(', ')}>{v.recurring_months}</td>
                  <td style={{ ...S.td, ...S.num }}>{v.late}</td><td style={{ ...S.td, ...S.num }}>{v.avg_delay_months ?? '—'}</td>
                  <td style={S.td}>{v.filing_status.known ? <><div style={{ fontSize: '0.74rem' }}>{v.filing_status.text}</div><div style={S.small}>source: {v.filing_status.source}</div></> : <Tag tone="grey" title="No verified source states this supplier's filing status">Unknown</Tag>}</td>
                  <td style={S.td}>{v.invalid_gstin && <Tag tone="red">Invalid GSTIN</Tag>}{v.wrong_gstin && <Tag tone="red">Possible wrong GSTIN</Tag>}{v.duplicates > 0 && <Tag tone="red">Duplicates {v.duplicates}</Tag>}</td>
                </tr>))}
            </tbody>
          </table>
        </div>
      </div>
      <div style={S.small}>"GST at stake" = Books-only GST + mismatch differences + GSTR-2B-only GST. A supplier's filing status is shown only when GSTR-2B states it (period and filing date as reported on the statement); the GST portal's own filing-status lookup is not connected (Phase 3).</div>
    </div>
  );
}
