import React, { useEffect, useState } from 'react';
import { RefreshCw, CheckCircle2, Circle, CloudOff, ChevronDown, ChevronRight, Cloud } from 'lucide-react';
import { T } from '../../theme';
import { capi, errSync } from './complianceApi';
import { Btn, S, fmtDateTime, fmtINR, Empty } from './ui';
import { toQuery } from './filterLogic';

// Zoho Books sync status for the selected period.
// Reads the stored period cache only. Zoho is called ONLY when the user clicks a Sync button.
export function ZohoStatus({ status, canSync, syncing, onSync, single }) {
  if (!status) return <span style={S.faint}>Zoho Books: checking…</span>;
  const pill = (icon, text, color) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.75rem', fontWeight: 600, color }}>{icon}{text}</span>
  );
  if (status.total === 0) {
    return pill(<CloudOff size={13} />, 'Zoho Books: company not linked (add a Zoho Org ID in Company Master)', T.textFaint);
  }
  const all = status.synced === status.total;
  const syncBtn = (label, onlyMissing, variant) => canSync && (
    <Btn size="sm" variant={variant} icon={RefreshCw} spin={syncing} disabled={syncing} onClick={() => onSync(onlyMissing)}
      title={onlyMissing ? 'Fetch only the periods that are not yet synced' : 'Fetch this period from Zoho Books again'}>
      {syncing ? 'Syncing…' : label}
    </Btn>
  );
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {single ? (
        all
          ? pill(<CheckCircle2 size={13} />, `Synced — Last Synced: ${fmtDateTime(status.last_synced_at)}`, T.success)
          : pill(<Circle size={13} />, 'Not Synced', T.textMuted)
      ) : (
        pill(all ? <CheckCircle2 size={13} /> : <Circle size={13} />,
          `Zoho Books: ${status.synced} of ${status.total} periods synced${status.last_synced_at ? ` · last ${fmtDateTime(status.last_synced_at)}` : ''}`,
          all ? T.success : T.textMuted)
      )}
      {!all && syncBtn(single ? 'Sync Selected Period' : 'Sync Missing Periods', !single, 'primary')}
      {all && syncBtn(single ? 'Sync again' : 'Re-sync all', false, 'ghost')}
    </span>
  );
}

// Zoho Books figures for the selected period (stored data only)
export function ZohoDataCard({ filters, refreshKey }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const q = JSON.stringify(toQuery(filters));

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setError('');
    capi.zohoData(JSON.parse(q)).then(d => alive && setData(d)).catch(e => alive && setError(errSync(e)));
    return () => { alive = false; };
  }, [open, q, refreshKey]);

  return (
    <div style={S.card}>
      <div onClick={() => setOpen(o => !o)} style={{ ...S.cardHead, cursor: 'pointer', borderBottom: open ? `1px solid ${T.border}` : 'none' }}>
        <span style={{ color: open ? T.primary : T.textMuted }}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
        <Cloud size={15} color={T.primary} />
        <div style={{ flex: 1 }}>
          <div style={S.cardTitle}>Zoho Books — Period Data</div>
          <div style={S.cardSub}>Reference figures from Zoho Books for the selected period (synced periods only). Read from stored data — opening this never calls Zoho.</div>
        </div>
      </div>
      {open && (
        <div style={{ padding: '0.8rem 1.1rem' }}>
          {error && <div style={{ color: T.danger, fontSize: '0.8rem' }}>{error}</div>}
          {!data && !error && <div style={S.faint}>Loading…</div>}
          {data && data.rows.length === 0 && <Empty icon={CloudOff} title="No synced periods in this selection">Use “Sync Selected Period” above to fetch this period from Zoho Books.</Empty>}
          {data && data.rows.length > 0 && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                {data.entities.map(e => (
                  <div key={e.key} style={{ background: T.page, border: `1px solid ${T.border}`, borderRadius: 8, padding: '0.4rem 0.8rem' }}>
                    <div style={{ fontSize: '0.62rem', color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{e.label} · {e.modules.join(', ')}</div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 700, fontFamily: T.mono, color: T.primary }}>{e.count} · {fmtINR(e.amount)}</div>
                  </div>
                ))}
              </div>
              <div className="cmp-scroll">
                <table style={S.table}>
                  <thead><tr>
                    <th style={S.th}>Company</th><th style={S.th}>Period</th>
                    {data.entities.map(e => <th key={e.key} style={{ ...S.th, textAlign: 'right' }}>{e.label}</th>)}
                    <th style={S.th}>Last Synced</th>
                  </tr></thead>
                  <tbody>
                    {data.rows.map(r => (
                      <tr key={`${r.company_id}${r.month}`} className="cmp-row">
                        <td style={S.td}>{r.company_name}</td>
                        <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{r.month_label}</td>
                        {data.entities.map(e => {
                          const v = r.entities[e.key];
                          return <td key={e.key} style={S.num} title={v?.error || (v?.truncated ? 'Stopped at the page limit — figures may be incomplete' : '')}>
                            {v ? (v.error ? <span style={{ color: T.danger }}>error</span> : `${v.count} · ${fmtINR(v.amount)}${v.truncated ? ' *' : ''}`) : '—'}
                          </td>;
                        })}
                        <td style={{ ...S.td, whiteSpace: 'nowrap', color: r.partial ? T.warning : T.textMuted }}>{fmtDateTime(r.synced_at)}{r.partial ? ' (partial)' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ ...S.faint, marginTop: 8 }}>
                Count · total amount per document type (void and draft excluded). Figures are as Zoho Books returned them at the last sync. {data.status.synced < data.status.total ? `${data.status.total - data.status.synced} period(s) in this selection are not synced and are not included.` : ''}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
