import React, { useEffect, useState, useCallback } from 'react';
import { g, errMsg } from './gApi';
import { S, Card, StatusPill, STATUS_ORDER, inr, inr0, pct, dt, dtm, Msg, Tag } from './ui';

const COMPS = [['taxable', 'Taxable value'], ['igst', 'IGST'], ['cgst', 'CGST'], ['sgst', 'SGST / UTGST'], ['cess', 'Cess'], ['gst', 'Total GST']];
const CLASS_TAG = { time_barred: ['red', 'Time-barred'], closing_soon: ['amber', 'Closing soon'], open: ['green', 'Open'] };

export default function OverviewTab({ meta, filters, stamp, onDrill, onChanged }) {
  const [data, setData] = useState(null);
  const [bridge, setBridge] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(filters);

  const load = useCallback(() => {
    setError('');
    Promise.all([g.summary(filters), g.bridge(filters)]).then(([s, b]) => { setData(s); setBridge(b); }).catch(e => setError(errMsg(e)));
  }, [key]); // eslint-disable-line
  useEffect(() => { load(); }, [load, stamp]);

  const rerun = async () => {
    setBusy(true); setNote(''); setError('');
    try {
      const companies = filters.company && filters.company !== 'all' ? [filters.company] : meta.companies.filter(c => c.registrations.length).map(c => c.id);
      for (const company of companies) await g.reconRun({ company, mode: 'all' });
      setNote('Reconciliation re-run for the whole scope.'); onChanged();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const exportXlsx = async () => { setBusy(true); setError(''); try { await g.exportXlsx(filters); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); } };

  if (error && !data) return <div style={S.error}>{error}</div>;
  if (!data) return <div style={S.center}>Loading…</div>;
  const s = data.summary, st = s.by_status, ex = s.exposure, def = s.definitions;
  const gstOf = a => (a.igst || 0) + (a.cgst || 0) + (a.sgst || 0) + (a.cess || 0);
  const pending = s.excluded.find(e => e.code === 'pending_detail');
  const soon = ex.by_deadline.filter(x => x.class === 'closing_soon');
  const lastRun = data.runs[0];
  const unreconciled = data.registrations.filter(r => !r.reconciled);
  const dr = x => () => onDrill(x);

  return (
    <div>
      <Msg error={error} ok={note} onClose={() => { setError(''); setNote(''); }} />
      {soon.length > 0 && (
        <div style={{ ...S.notice, background: '#FEF3C7', borderColor: '#F59E0B', color: '#78350F' }}>
          <b>ITC claim window closing.</b> {soon.map(x => `Invoices of FY ${x.fy} can be claimed only up to ${dt(x.deadline)} (${x.days_left} day${x.days_left === 1 ? '' : 's'} left; earlier if GSTR-9 is filed first): ${x.docs} Books document(s), ${inr0(x.gst)} of GST, are not in GSTR-2B yet.`).join(' ')}
          {' '}<button style={{ ...S.btn, marginLeft: 6 }} onClick={() => onDrill({ queue: 'books_only', basis: 'invoice', fy: soon[0].fy })}>Show these documents</button>
          <div style={{ fontSize: '0.74rem', marginTop: 4 }}>Rule: Section 16(4) CGST Act — the earlier of 30 November following the financial year and the GSTR-9 filing date. Confirm the position with your tax advisor.</div>
        </div>
      )}
      {pending && <div style={S.notice}>{pending.books_docs} Books document(s) are still waiting for their amounts from Zoho (the sync is not finished), so the figures below are incomplete. See Imports &amp; sync.</div>}
      {unreconciled.length > 0 && <div style={S.info}>{unreconciled.length} GSTIN(s) have not been reconciled yet — sync Zoho and upload their GSTR-2B statements (Imports &amp; sync), then they appear here.</div>}
      {data.runs.some(r => r.stale_links && r.stale_links.length) && <div style={S.notice}>Some manual links no longer apply because a document changed or disappeared: {data.runs.flatMap(r => r.stale_links || []).length} link(s). Review the affected rows.</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={S.primary} disabled={busy} onClick={exportXlsx}>Export to Excel</button>
        {meta.rights.prepare && <button style={S.btn} disabled={busy} onClick={rerun}>Re-run reconciliation</button>}
        <span style={S.small}>{lastRun ? `Last run: ${dtm(lastRun.ran_at)} (version ${lastRun.version}${lastRun.changes && !lastRun.changes.first_run ? `, ${lastRun.changes.moved || 0} row(s) changed status, ${lastRun.changes.new_rows} new` : ''})` : 'Not reconciled yet'}</span>
        <span style={S.small}>Period basis: {meta.period_bases[filters.basis || meta.settings.period_basis]}</span>
      </div>

      <div style={S.grid(210)}>
        <Card title="GST in Books" value={inr0(s.books.gst)} sub={`${s.books.docs} documents · taxable ${inr0(s.books.amounts.taxable)}`} def={def.books_gst} onDrill={dr({})} />
        <Card title="GST in GSTR-2B" value={inr0(s.portal.gst)} sub={`${s.portal.docs} documents · taxable ${inr0(s.portal.amounts.taxable)}`} def={def.portal_gst} onDrill={dr({})} />
        <Card title="Matched" value={`${s.matched.rows} rows`} tone="good" def={def.matched} onDrill={dr({ status: 'exact,tolerance' })}
          sub={<>Books {inr0(s.matched.books_gst)} · 2B {inr0(s.matched.portal_gst)}<br />Books docs {pct(s.rates.doc_books)} · tax {pct(s.rates.tax_books)} · 2B docs {pct(s.rates.doc_portal)}</>} />
        <Card title="Suggested — review" value={st.suggested.rows} tone={st.suggested.rows ? 'warn' : undefined} sub={`Books GST ${inr0(gstOf(st.suggested.books))}`} def="A rule found a likely pair but a person must approve it; not counted as matched." onDrill={dr({ status: 'suggested' })} />
        <Card title="Mismatched" value={st.mismatched.rows} tone={st.mismatched.rows ? 'bad' : undefined} sub={`Books ${inr0(gstOf(st.mismatched.books))} · 2B ${inr0(gstOf(st.mismatched.portal))}`} def="Same document in both, but an amount differs by more than the tolerance." onDrill={dr({ status: 'mismatched' })} />
        <Card title="Books only" value={st.books_only.rows} tone={st.books_only.rows ? 'warn' : undefined} sub={`GST ${inr0(gstOf(st.books_only.books))}`} def="In Zoho Books, not reported by the supplier in GSTR-2B." onDrill={dr({ queue: 'books_only' })} />
        <Card title="GSTR-2B only" value={st.portal_only.rows} sub={`GST ${inr0(gstOf(st.portal_only.portal))}`} def="Reported by the supplier, not found in Books." onDrill={dr({ queue: 'portal_only' })} />
        <Card title="Potential credit exposure" value={inr0(ex.books_only_gst + ex.mismatch_shortfall_gst)} tone={ex.closing_soon_gst || ex.time_barred_gst ? 'warn' : undefined} def={def.exposure} onDrill={dr({ queue: 'books_only' })}
          sub={<>Time-barred {inr0(ex.time_barred_gst)} · closing in {ex.soon_days} days {inr0(ex.closing_soon_gst)} · open {inr0(ex.open_gst)}<br />Mismatch shortfall {inr0(ex.mismatch_shortfall_gst)}</>} />
        <Card title="Pending review" value={s.pending_review} tone={s.pending_review ? 'warn' : undefined} def={def.pending_review} onDrill={dr({ queue: 'review' })} sub="Suggested, mismatched and flagged rows not yet accepted or resolved" />
        <Card title="Vendor follow-up" value={s.follow_up.vendors_with_issues} def={def.follow_up} sub={`${s.follow_up.open_followups} row(s) in vendor follow-up`} onDrill={() => onDrill({}, 'vendors')} />
        <Card title="Excluded" value={st.excluded.rows} def="Documents deliberately kept out of matching, each with its reason (below)." sub={s.excluded.map(e => `${e.text.split(' — ')[0]}: ${e.books_docs + e.portal_docs}`).slice(0, 2).join(' · ')} onDrill={dr({ status: 'excluded' })} />
      </div>
      <div style={{ ...S.grid(170), marginTop: '0.75rem' }}>
        {s.phase2.map(t => <Card key={t} title={t} value="Phase 2" muted def="Planned — the ITC register is not built yet. Reconciliation status is not ITC eligibility." />)}
      </div>

      <div style={{ ...S.card, marginTop: '1rem' }}>
        <div style={S.cardHead}><span style={S.cardTitle}>Primary status — every document is in exactly one</span><span style={S.small}>Flags (duplicate, cross-period, credit note …) overlay these and are never added up</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th}>Status</th><th style={{ ...S.th, ...S.thR }}>Rows</th><th style={{ ...S.th, ...S.thR }}>Books docs</th><th style={{ ...S.th, ...S.thR }}>GSTR-2B docs</th><th style={{ ...S.th, ...S.thR }}>Books GST</th><th style={{ ...S.th, ...S.thR }}>GSTR-2B GST</th><th style={S.th} /></tr></thead>
            <tbody>
              {STATUS_ORDER.map(k => (
                <tr key={k}>
                  <td style={S.td}><StatusPill status={k} statuses={meta.statuses} /></td>
                  <td style={{ ...S.td, ...S.num }}>{st[k].rows}</td><td style={{ ...S.td, ...S.num }}>{st[k].books_docs}</td><td style={{ ...S.td, ...S.num }}>{st[k].portal_docs}</td>
                  <td style={{ ...S.td, ...S.num }}>{inr(gstOf(st[k].books))}</td><td style={{ ...S.td, ...S.num }}>{inr(gstOf(st[k].portal))}</td>
                  <td style={S.td}>{st[k].rows > 0 && <button style={{ ...S.ghost, padding: '0.1rem 0.5rem' }} onClick={() => onDrill({ status: k })}>Show</button>}</td>
                </tr>))}
              <tr><td style={{ ...S.td, fontWeight: 700 }}>Total</td><td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{s.rows}</td><td colSpan={5} style={S.td} /></tr>
            </tbody>
          </table>
        </div>
      </div>

      {ex.by_deadline.length > 0 && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Books-only GST by ITC claim deadline (Section 16(4))</span><span style={S.small}>Unresolved, not lost: the supplier may still report it. Credit notes and reverse-charge items are not included.</span></div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th}>Financial year</th><th style={S.th}>Deadline</th><th style={{ ...S.th, ...S.thR }}>Days left</th><th style={S.th}>Position</th><th style={{ ...S.th, ...S.thR }}>Documents</th><th style={{ ...S.th, ...S.thR }}>GST</th><th style={S.th}>Basis</th><th style={S.th} /></tr></thead>
            <tbody>{ex.by_deadline.map(x => (
              <tr key={x.deadline}>
                <td style={S.td}>{x.fy}</td><td style={S.td}>{dt(x.deadline)}</td>
                <td style={{ ...S.td, ...S.num, color: x.days_left < 0 ? '#B91C1C' : x.class === 'closing_soon' ? '#B45309' : undefined, fontWeight: x.class !== 'open' ? 700 : 400 }}>{x.days_left}</td>
                <td style={S.td}><Tag tone={CLASS_TAG[x.class][0]}>{CLASS_TAG[x.class][1]}</Tag></td>
                <td style={{ ...S.td, ...S.num }}>{x.docs}</td><td style={{ ...S.td, ...S.num }}>{inr(x.gst)}</td><td style={{ ...S.td, ...S.muted }}>{x.text}</td>
                <td style={S.td}><button style={{ ...S.ghost, padding: '0.1rem 0.5rem' }} onClick={() => onDrill({ queue: 'books_only', basis: 'invoice', fy: x.fy })}>Show</button></td>
              </tr>))}</tbody>
          </table>
        </div>
      )}

      {bridge && (
        <div style={S.card}>
          <div style={S.cardHead}>
            <span style={S.cardTitle}>Reconciliation bridge — every tax component ties out on its own</span>
            <Tag tone={bridge.ties ? 'green' : 'red'}>{bridge.ties ? 'All components tie out' : 'DOES NOT TIE — investigate'}</Tag>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={S.th} />{COMPS.map(([k, n]) => <th key={k} style={{ ...S.th, ...S.thR }}>{n}</th>)}</tr></thead>
              <tbody>
                {[['Books — matchable documents', 'books_total', 1], ['   matched (exact + tolerance)', 'matched_books'], ['   suggested (not yet approved)', 'suggested_books'], ['   mismatched', 'mismatched_books'], ['   Books only', 'books_only'],
                  ['GSTR-2B — matchable documents', 'portal_total', 1], ['   matched', 'matched_portal'], ['   suggested', 'suggested_portal'], ['   mismatched', 'mismatched_portal'], ['   GSTR-2B only', 'portal_only'],
                  ['Difference: Books − GSTR-2B', 'difference', 1], ['Explained by the statuses', 'explained']].map(([label, k, bold]) => (
                  <tr key={k}><td style={{ ...S.td, fontWeight: bold ? 700 : 400, whiteSpace: 'pre' }}>{label}</td>{COMPS.map(([c]) => <td key={c} style={{ ...S.td, ...S.num, fontWeight: bold ? 700 : 400 }}>{inr(bridge.components[c][k])}</td>)}</tr>))}
                <tr><td style={S.td}>Ties out</td>{COMPS.map(([c]) => <td key={c} style={{ ...S.td, ...S.num, color: bridge.components[c].ties ? '#15803D' : '#B91C1C', fontWeight: 700 }}>{bridge.components[c].ties ? '✓' : '✗'}</td>)}</tr>
              </tbody>
            </table>
          </div>
          {bridge.excluded.length > 0 && (
            <div style={{ padding: '0 1.1rem 1rem' }}>
              <div style={{ ...S.label, marginTop: 8 }}>Excluded documents — outside the bridge, with the reason</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={S.th}>Reason</th><th style={{ ...S.th, ...S.thR }}>Books docs</th><th style={{ ...S.th, ...S.thR }}>GSTR-2B docs</th><th style={{ ...S.th, ...S.thR }}>Books GST</th><th style={{ ...S.th, ...S.thR }}>GSTR-2B GST</th></tr></thead>
                <tbody>{bridge.excluded.map(e => <tr key={e.code}><td style={S.td}>{e.text}</td><td style={{ ...S.td, ...S.num }}>{e.books_docs}</td><td style={{ ...S.td, ...S.num }}>{e.portal_docs}</td><td style={{ ...S.td, ...S.num }}>{inr(gstOf(e.books))}</td><td style={{ ...S.td, ...S.num }}>{inr(gstOf(e.portal))}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <details style={{ ...S.card, padding: '0.7rem 1.1rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: '0.85rem' }}>How each figure is calculated</summary>
        <div style={{ marginTop: 8 }}>{Object.entries(def).map(([k, v]) => <p key={k} style={{ ...S.muted, margin: '0 0 6px', lineHeight: 1.5 }}><b style={{ color: '#18191B' }}>{k.replace(/_/g, ' ')}:</b> {v}</p>)}</div>
      </details>
    </div>
  );
}
