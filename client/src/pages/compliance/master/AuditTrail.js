import React, { useCallback, useEffect, useState } from 'react';
import { History, Download, Search } from 'lucide-react';
import { T } from '../../../theme';
import { capi, errSync } from '../complianceApi';
import { S, Card, Btn, Field, Input, Select, Spinner, ErrorBox, Empty, fmtDateTime, exportXlsx } from '../ui';

// Audit Trail (admin): every important change — who, what, when.
const changesText = ch => (ch || []).map(c => `${c.field}: ${typeof c.from === 'object' ? JSON.stringify(c.from) : c.from ?? ''} → ${typeof c.to === 'object' ? JSON.stringify(c.to) : c.to ?? ''}`).join('; ');

export default function AuditTrail({ meta, refreshKey }) {
  const [f, setF] = useState({ entity: '', user: '', q: '', from: '', to: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const qs = JSON.stringify(f);

  const load = useCallback(async () => {
    setError('');
    try { setData(await capi.audit({ ...JSON.parse(qs), limit: 1000 })); } catch (e) { setError(errSync(e)); }
  }, [qs]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load, refreshKey]);

  const cols = meta.columns.audit;
  const doExport = () => exportXlsx('Compliance_Audit_Trail.xlsx', 'Audit Trail', cols, data.rows,
    (r, c) => (c.type === 'datetime' ? fmtDateTime(r[c.key]) : c.type === 'changes' ? changesText(r.changes) : r[c.key] ?? ''));

  return (
    <Card title="Audit Trail" icon={History} subtitle={data ? `${data.total} entries recorded · newest first · showing up to 1,000` : ''}
      right={<Btn size="sm" icon={Download} onClick={doExport} disabled={!data?.rows.length}>Export</Btn>}>
      <div style={{ padding: '0.8rem 1.1rem', borderBottom: `1px solid ${T.border}`, background: T.page }}>
        <div className="cmp-filters">
          <Field label="Item"><Select value={f.entity} onChange={v => setF(x => ({ ...x, entity: v }))} options={[{ value: '', label: 'All' }, ...(data?.entities || []).map(e => ({ value: e, label: e }))]} /></Field>
          <Field label="User"><Select value={f.user} onChange={v => setF(x => ({ ...x, user: v }))} options={[{ value: '', label: 'All' }, ...(data?.users || []).map(u => ({ value: u, label: u }))]} /></Field>
          <Field label="From"><Input type="date" value={f.from} onChange={e => setF(x => ({ ...x, from: e.target.value }))} /></Field>
          <Field label="To"><Input type="date" value={f.to} onChange={e => setF(x => ({ ...x, to: e.target.value }))} /></Field>
          <Field label="Search" style={{ gridColumn: 'span 2' }}>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: T.textFaint }} />
              <Input value={f.q} onChange={e => setF(x => ({ ...x, q: e.target.value }))} placeholder="Task ID, document, field…" style={{ paddingLeft: 28 }} />
            </div>
          </Field>
        </div>
      </div>
      {error && <ErrorBox error={error} onRetry={load} />}
      {!data && !error && <Spinner />}
      {data && (data.rows.length === 0 ? <Empty icon={History}>No entries match.</Empty> : (
        <div className="cmp-scroll" style={{ maxHeight: 640, overflowY: 'auto' }}>
          <table style={S.table}>
            <thead><tr>{cols.map(c => <th key={c.key} style={S.th}>{c.header}</th>)}</tr></thead>
            <tbody>
              {data.rows.map(e => (
                <tr key={e.id} className="cmp-row">
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{fmtDateTime(e.at)}</td>
                  <td style={S.td}>{e.user}</td>
                  <td style={S.td}>{e.action}</td>
                  <td style={S.td}>{e.entity}</td>
                  <td style={{ ...S.td, fontFamily: T.mono, fontSize: '0.74rem', overflowWrap: 'anywhere', maxWidth: 220 }}>{e.entity_id}</td>
                  <td style={{ ...S.td, minWidth: 220, maxWidth: 420 }}>{e.summary}</td>
                  <td style={{ ...S.td, ...S.muted, minWidth: 200, maxWidth: 420, overflowWrap: 'anywhere' }}>{changesText(e.changes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </Card>
  );
}
