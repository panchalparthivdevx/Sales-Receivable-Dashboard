import React, { useEffect, useState } from 'react';
import { t, errMsg } from './api';
import { S, Card, r, rs, dtm, dt, StatusPill } from './ui';

const OPEN = 'not_matched,not_in_26as,not_in_zoho,need_check';

export default function DashboardTab({ meta, params, stamp, onDrill, go }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { setD(null); setErr(''); t.dashboard(params).then(setD).catch(e => setErr(errMsg(e))); }, [JSON.stringify(params), stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div style={S.error}>{err}</div>;
  if (!d) return <div style={S.center}>Reconciling…</div>;
  const T = d.totals, def = d.definitions;
  const tie = T.zoho === T.ledger_control;
  return (
    <div>
      <div style={{ ...S.card, padding: '0.7rem 1rem' }}>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: '0.8rem' }}>
          <span><b>Period:</b> {d.period.label}</span>
          <span><b>Last Zoho sync:</b> {d.sync.last_ok_at ? dtm(d.sync.last_ok_at) : 'never'}{d.sync.running ? ' (running)' : ''}</span>
          {d.coverage.statements.map(s => <span key={s.fy}><b>Form 26AS FY {s.fy}:</b> {s.missing ? <span style={{ color: '#B45309' }}>not uploaded</span> : `dated ${dt(s.statement_date)} (version ${s.version})`}</span>)}
          <span><b>Client groups mapped:</b> {d.mapping.groups}</span>
        </div>
        {d.coverage.gaps.length > 0 && (
          <div style={{ ...S.notice, margin: '0.6rem 0 0' }}>
            <b>Coverage gaps — shown before any "Not in 26AS" / "Not in Zoho Books" is given:</b>
            <ul style={{ margin: '0.3rem 0 0 1.1rem', padding: 0 }}>{d.coverage.gaps.slice(0, 8).map(g => <li key={g}>{g}</li>)}</ul>
            {d.coverage.gaps.length > 8 && <div>…and {d.coverage.gaps.length - 8} more</div>}
            <div style={{ marginTop: 4 }}>Entries affected by a gap are marked <b>Need to Check — coverage gap</b>. <button style={{ ...S.ghost, padding: '0.1rem 0.5rem' }} onClick={() => go('imports')}>Upload a statement / sync Zoho</button></div>
          </div>
        )}
        {d.sync.last_error && <div style={{ ...S.error, margin: '0.6rem 0 0' }}>Last Zoho sync: {String(d.sync.last_error)}</div>}
      </div>

      <div style={S.grid(210)}>
        <Card title="Zoho TDS receivable" value={r(T.zoho)} sub={`${T.zoho_entries} entries · ledger postings ${tie ? '= ' : '≠ '}${r(T.ledger_control)}`} tone={tie ? undefined : 'bad'} def={def.zoho} onDrill={() => onDrill({ side: 'zoho' })} />
        <Card title="26AS tax deducted" value={r(T.deducted)} sub={`${T.credits} credits · amount paid ${r(T.amount_paid)}${T.reversal_pairs ? ` · ${T.reversal_pairs} reversal pair(s) netted` : ''}`} def={def.deducted} onDrill={() => onDrill({ side: '26as' })} />
        <Card title="26AS tax deposited" value={r(T.deposited)} sub={T.deducted !== T.deposited ? `deducted − deposited ${r(T.deducted - T.deposited)}` : 'equals tax deducted'} tone={T.deducted > T.deposited ? 'warn' : undefined} def={def.deposited} onDrill={() => onDrill({ side: '26as' })} />
        <Card title="Matched credit" value={r(T.matched)} sub={`${T.matched_units} matched item(s)`} tone="good" def={def.matched} onDrill={() => onDrill({ status: 'matched,rounding' })} />
        <Card title="Rounding difference" value={rs(T.rounding)} sub={`${T.rounding_units} item(s), each within ₹${meta.settings.rounding_tol_p / 100}`} def={def.rounding} onDrill={() => onDrill({ status: 'rounding' })} />
        <Card title="Open — Zoho side" value={r(T.open_zoho)} sub="booked, not (fully) credited" tone={T.open_zoho ? 'warn' : 'good'} def={def.open_zoho} onDrill={() => onDrill({ status: OPEN, side: 'zoho', open: '1' })} />
        <Card title="Open — 26AS side" value={r(T.open_26as)} sub="credited, not (fully) booked" tone={T.open_26as ? 'warn' : 'good'} def={def.open_26as} onDrill={() => onDrill({ status: OPEN, side: '26as', open: '1' })} />
        <Card title="Carry-forward balance" value={r(T.cf_open)} sub={`${T.cf_open_items} open item(s)`} def={def.cf} onDrill={() => go('carry')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Reconciliation bridge</span><span style={{ ...S.small, color: d.bridge.difference === 0 ? '#15803D' : '#B91C1C' }}>{d.bridge.difference === 0 ? 'Ties to both source totals' : `Unexplained ${r(d.bridge.difference)}`}</span></div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <tr><td style={{ ...S.td, fontWeight: 700 }}>{d.bridge.start.label}</td><td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{r(d.bridge.start.amount)}</td></tr>
              {d.bridge.lines.map(l => (
                <tr key={l.id} style={{ cursor: l.units ? 'pointer' : 'default', opacity: l.units ? 1 : 0.5 }} onClick={() => l.units && onDrill({ ids: l.filter.ids, label: l.label })} title={l.units ? 'Show the items' : ''}>
                  <td style={S.td}>less: {l.label} <span style={S.small}>({l.units})</span></td>
                  <td style={{ ...S.td, ...S.num }}>{l.effect ? rs(-l.effect) : '—'}</td>
                </tr>
              ))}
              <tr><td style={{ ...S.td, fontWeight: 700 }}>{d.bridge.end.label}</td><td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{r(d.bridge.end.amount)}</td></tr>
              <tr><td style={S.td}><span style={S.muted}>For reference: 26AS tax deducted − deposited</span></td><td style={{ ...S.td, ...S.num }}>{r(d.bridge.deducted_gap)}</td></tr>
            </tbody>
          </table>
          <div style={{ ...S.small, padding: '0.5rem 1rem' }}>Each line is Zoho − 26AS deposited of the items in that status. Click a line for the items behind it.</div>
        </div>
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>By status</span><span style={S.small}>system status, or the reviewer's final status where set</span></div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th}>Status</th><th style={{ ...S.th, ...S.thR }}>Items</th><th style={{ ...S.th, ...S.thR }}>Zoho</th><th style={{ ...S.th, ...S.thR }}>26AS deposited</th><th style={{ ...S.th, ...S.thR }}>Difference</th></tr></thead>
            <tbody>{d.by_status.map(s => (
              <tr key={s.status} style={{ cursor: s.units ? 'pointer' : 'default', opacity: s.units ? 1 : 0.45 }} onClick={() => s.units && onDrill({ status: s.status })}>
                <td style={S.td}><StatusPill status={s.status} statuses={meta.statuses} small /></td><td style={{ ...S.td, ...S.num }}>{s.units}</td><td style={{ ...S.td, ...S.num }}>{r(s.zoho)}</td><td style={{ ...S.td, ...S.num }}>{r(s.deposited)}</td><td style={{ ...S.td, ...S.num }}>{rs(s.diff)}</td>
              </tr>))}</tbody>
          </table>
          <div style={{ padding: '0.6rem 1rem', fontSize: '0.76rem', color: '#5D6C7B', lineHeight: 1.6 }}>
            Match methods: {d.by_method.map(m => `${m.label} ${m.units}`).join(' · ')}<br />
            {T.transfers > 0 && <>Transfers between this entity's own TDS ledgers in the period: {T.transfers} (net zero, not counted).<br /></>}
            {T.unallocated !== 0 && <>Unallocated Zoho postings (no customer): {r(T.unallocated)} — <button style={{ ...S.ghost, padding: '0.05rem 0.45rem' }} onClick={() => onDrill({ reason: 'unallocated' })}>show</button></>}
          </div>
        </div>
      </div>
    </div>
  );
}
