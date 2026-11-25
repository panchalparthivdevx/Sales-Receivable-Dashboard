import React, { useEffect, useState } from 'react';
import { t, errMsg } from './api';
import { S, r, rs, dt, Msg, Statuses, Flags, tableWrap, table, STATUS_KEYS } from './ui';
import UnitDrawer from './UnitDrawer';

const REASONS = { timing: 'Timing difference', ambiguous: 'Ambiguous', deducted_exceeds_deposited: 'Deducted > deposited', short_deduction: 'Possible short deduction', short_booking: 'Possible short booking', base_gross: 'Base incl. GST',
  different_base: 'Different base', partial_base: 'Part of the invoice', amount_differs: 'TDS differs', insufficient: 'Insufficient evidence', unallocated: 'Unallocated', customer_unmapped: 'Customer not mapped', deductor_unmapped: 'Deductor not mapped',
  coverage_26as: 'Coverage gap (26AS)', coverage_zoho: 'Coverage gap (Zoho)', reversal: 'Reversal', rounding: 'Rounding', not_in_26as: 'Not in 26AS', not_in_zoho: 'Not in Zoho Books', no_customer: 'No Zoho customer', cf_settlement: 'Carry-forward settlement', cf_inside: 'Carried forward, settled in period' };

export default function TransactionsTab({ meta, params, stamp, drill, clearDrill, onChanged }) {
  const [f, setF] = useState({ group: '', tan: '', section: '', status: '', method: '', reason: '', search: '' });
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState(0);
  const q = { ...params, ...f, ...(drill || {}), label: undefined };
  useEffect(() => { setD(null); setErr(''); t.units(q).then(setD).catch(e => setErr(errMsg(e))); }, [JSON.stringify(q), stamp, mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const exportIt = async () => { setBusy(true); try { await t.exportXlsx({ ...q, report: 'transactions' }); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const zRef = u => u.zoho_lines.map(z => `${z.type_label} ${z.number || ''}`.trim()).join(' + ');
  // the Zoho customer(s) behind a client's entries, shown when they differ from the client's name (branches sharing one TAN)
  const zCust = u => [...new Set(u.zoho_lines.map(z => z.customer).filter(Boolean))].filter(n => n !== u.client).join(', ');
  return (
    <div>
      <Msg error={err} onClose={() => setErr('')} />
      <div style={{ ...S.card, padding: '0.6rem 0.9rem', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label><span style={S.label}>Client</span><select style={S.select} value={f.group} onChange={e => setF({ ...f, group: e.target.value })}><option value="">All</option><option value="__none__">Not mapped / unallocated</option>{(d ? d.groups : []).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
        <label><span style={S.label}>TAN</span><input style={{ ...S.input, width: 110 }} value={f.tan} onChange={e => setF({ ...f, tan: e.target.value.toUpperCase() })} /></label>
        <label><span style={S.label}>Section</span><select style={S.select} value={f.section} onChange={e => setF({ ...f, section: e.target.value })}><option value="">All</option>{(d ? d.sections : []).map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <label><span style={S.label}>Status</span><select style={S.select} value={f.status} onChange={e => setF({ ...f, status: e.target.value })}><option value="">All</option>{STATUS_KEYS.map(s => <option key={s} value={s}>{meta.statuses[s]}</option>)}</select></label>
        <label><span style={S.label}>Match method</span><select style={S.select} value={f.method} onChange={e => setF({ ...f, method: e.target.value })}><option value="">All</option>{Object.entries(meta.methods).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label><span style={S.label}>Likely reason</span><select style={S.select} value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })}><option value="">All</option>{Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label><span style={S.label}>Search</span><input style={{ ...S.input, width: 170 }} value={f.search} onChange={e => setF({ ...f, search: e.target.value })} placeholder="client, invoice, TAN" /></label>
        <div style={{ flex: 1 }} />
        <button style={S.primary} disabled={busy} onClick={exportIt}>{busy ? 'Preparing…' : 'Export to Excel'}</button>
      </div>
      {drill && <div style={S.info}>Showing {drill.label ? `"${drill.label}"` : Object.entries(drill).filter(([k]) => k !== 'ids').map(([k, v]) => `${k} = ${v}`).join(' · ') || 'the items behind the figure'} <button style={{ ...S.ghost, marginLeft: 8, padding: '0.15rem 0.55rem' }} onClick={clearDrill}>Show everything</button></div>}
      {!d ? <div style={S.center}>Loading…</div> : (
        <div style={S.card}>
          <div style={S.cardHead}>
            <span style={S.cardTitle}>{d.total} item{d.total === 1 ? '' : 's'}{d.total > d.units.length ? ` (first ${d.units.length} shown — narrow the filters or export)` : ''}</span>
            <span style={S.muted}>Zoho {r(d.sums.zoho)} · deducted {r(d.sums.deducted)} · deposited {r(d.sums.deposited)} · difference {rs(d.sums.diff)}</span>
          </div>
          <div style={tableWrap}>
            <table style={table}>
              <thead><tr>{['Client / TAN', 'Zoho reference', 'Zoho dates', '26AS (deductor, date, section)', 'Basic value', 'Zoho TDS', '26AS deducted', '26AS deposited', 'Difference', 'Method', 'Status', 'Likely reason'].map((c, i) => <th key={c} style={{ ...S.th, ...(i >= 4 && i <= 8 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
              <tbody>
                {d.units.length === 0 && <tr><td colSpan={12} style={S.center}>No items for these filters.</td></tr>}
                {d.units.map(u => {
                  const basic = u.zoho_lines.length && u.zoho_lines.every(z => z.base && z.base.comparable != null) ? u.zoho_lines.reduce((a, z) => a + z.base.comparable, 0) : null;
                  return (
                    <tr key={u.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(u.id)}>
                      <td style={S.td}><div style={{ fontWeight: 600 }}>{u.client || '—'}</div><div style={S.small}>{u.tans.join(', ')}</div>{zCust(u) && <div style={S.small} title="The Zoho customer the entry is booked under (one client can be several Zoho customers with the same TAN)">Zoho: {zCust(u)}</div>}</td>
                      <td style={{ ...S.td, fontSize: '0.72rem' }}>{zRef(u) || <span style={S.small}>—</span>}{u.zoho_lines.some(z => z.invoice_no && z.type !== 'invoice') && <div style={S.small}>inv {u.zoho_lines.map(z => z.invoice_no).filter(Boolean).join(', ')}</div>}</td>
                      <td style={{ ...S.td, fontSize: '0.72rem' }}>{u.zoho_lines.length ? <>posted {u.zoho_lines.map(z => dt(z.date)).filter((v, i, a) => a.indexOf(v) === i).join(', ')}{u.zoho_lines.some(z => z.invoice_date && z.invoice_date !== z.date) && <div style={S.small}>invoice {u.zoho_lines.map(z => dt(z.invoice_date)).join(', ')}</div>}{u.zoho_lines.some(z => z.payment) && <div style={S.small}>payment {u.zoho_lines.filter(z => z.payment).map(z => dt(z.payment.date)).join(', ')}</div>}</> : '—'}</td>
                      <td style={{ ...S.td, fontSize: '0.72rem' }}>{u.credit_lines.length ? u.credit_lines.map(c => <div key={c.key}>{dt(c.txn_date)} · {c.section_raw} · {c.status}{u.credit_lines.length === 1 && <div style={S.small}>{c.deductor}</div>}</div>) : u.evidence.length ? <span style={{ color: '#B45309' }}>other period: {u.evidence.map(e => dt(e.txn_date || e.date)).join(', ')}</span> : '—'}</td>
                      <td style={{ ...S.td, ...S.num }}>{basic != null ? r(basic) : '—'}{u.credit_lines.length > 0 && <div style={S.small}>paid {r(u.paid)}</div>}</td>
                      <td style={{ ...S.td, ...S.num }}>{u.zoho.length ? r(u.z_amount) : '—'}</td>
                      <td style={{ ...S.td, ...S.num }}>{u.credits.length ? r(u.deducted) : '—'}</td>
                      <td style={{ ...S.td, ...S.num }}>{u.credits.length ? r(u.deposited) : '—'}</td>
                      <td style={{ ...S.td, ...S.num, fontWeight: 600, color: u.diff === 0 ? '#15803D' : Math.abs(u.diff) <= meta.settings.rounding_tol_p ? '#0F766E' : '#B91C1C' }}>{rs(u.diff)}{u.matched_amount > 0 && (u.open_zoho > 0 || u.open_26as > 0) && <div style={S.small}>matched {r(u.matched_amount)}</div>}</td>
                      <td style={{ ...S.td, fontSize: '0.72rem' }}>{u.method_label}</td>
                      <td style={S.td}><Statuses u={u} statuses={meta.statuses} />{u.cf_item && <div style={S.small}>CF {u.cf_item.status}</div>}</td>
                      <td style={{ ...S.td, fontSize: '0.72rem', maxWidth: 320 }}>{u.reason ? u.reason.text : ''}<div><Flags flags={u.flags} /></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {open && <UnitDrawer meta={meta} params={params} id={open} onClose={() => setOpen(null)} onSaved={() => { setMine(x => x + 1); onChanged(); }} />}
    </div>
  );
}
