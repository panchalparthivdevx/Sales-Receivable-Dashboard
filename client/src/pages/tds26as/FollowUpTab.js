import React, { useEffect, useState } from 'react';
import { t, errMsg } from './api';
import { S, r, dt, Msg, Modal, Field, tableWrap, table, STATUS_KEYS } from './ui';

const KIND = { client: '', unmapped_customer: 'Customer not mapped', unmapped_tan: 'Deductor not mapped', unallocated: 'Unallocated' };

export default function FollowUpTab({ meta, params, stamp, onDrill, onChanged }) {
  const [f, setF] = useState({ group: '', tan: '', section: '', status: '', only_open: '1' });
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const q = { ...params, ...f };
  const load = () => { setErr(''); t.followup(q).then(setD).catch(e => setErr(errMsg(e))); };
  useEffect(() => { setD(null); load(); }, [JSON.stringify(q), stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const exportIt = async () => { setBusy(true); setErr(''); try { await t.exportXlsx({ ...params, report: 'followup', group: f.group, tan: f.tan }); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const save = async () => {
    try { await t.setClient({ entity: params.entity, group: edit.id, owner_id: edit.owner_id, remarks: edit.remarks }); setOk(`Saved owner and remarks for ${edit.client}`); setEdit(null); load(); onChanged(); } catch (e) { setErr(errMsg(e)); }
  };
  const T = d ? d.totals : null;
  const cols = ['Client', 'TAN', 'TDS booked (Zoho)', 'Tax deducted (26AS)', 'Tax deposited (26AS)', 'Follow-up amount', 'Credit missing', 'Deducted > deposited', 'Other short credit', 'Confirmed non-deposit', 'Subsequent-period credit', 'Review first', 'Excess credit (not netted)', 'Oldest open', 'Owner', 'Remarks', ''];
  return (
    <div>
      <Msg error={err} ok={ok} onClose={() => { setErr(''); setOk(''); }} />
      <div style={{ ...S.card, padding: '0.6rem 0.9rem', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label><span style={S.label}>Client</span><select style={S.select} value={f.group} onChange={e => setF({ ...f, group: e.target.value })}><option value="">All clients</option>{(d ? d.rows.filter(x => x.kind === 'client') : []).map(x => <option key={x.id} value={x.id}>{x.client}</option>)}</select></label>
        <label><span style={S.label}>TAN</span><input style={{ ...S.input, width: 120 }} value={f.tan} onChange={e => setF({ ...f, tan: e.target.value.toUpperCase() })} placeholder="AHMA12345B" /></label>
        <label><span style={S.label}>Section</span><input style={{ ...S.input, width: 80 }} value={f.section} onChange={e => setF({ ...f, section: e.target.value.toUpperCase() })} placeholder="194C" /></label>
        <label><span style={S.label}>Status</span><select style={S.select} value={f.status} onChange={e => setF({ ...f, status: e.target.value })}><option value="">Any</option>{STATUS_KEYS.map(s => <option key={s} value={s}>{meta.statuses[s]}</option>)}</select></label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.78rem', paddingBottom: 6 }}><input type="checkbox" checked={f.only_open === '1'} onChange={e => setF({ ...f, only_open: e.target.checked ? '1' : '' })} /> Only clients with open items</label>
        <div style={{ flex: 1 }} />
        <button style={S.primary} disabled={busy} onClick={exportIt}>{busy ? 'Preparing…' : 'Export to Excel'}</button>
      </div>
      <div style={{ ...S.info }}>
        <b>Follow-up amount</b> = credit missing from the uploaded 26AS + tax deducted but not deposited + other short credit + confirmed non-deposit — from this client's <b>open</b> items only. A client's excess credit is shown in its own column and never reduces a shortfall. "Subsequent-period credit" (a matching credit in a later statement) and "Review first" (ambiguous, unmapped, coverage gap) are shown separately until checked.
      </div>
      {!d ? <div style={S.center}>Loading…</div> : (
        <div style={S.card}>
          <div style={tableWrap}>
            <table style={table}>
              <thead><tr>{cols.map((c, i) => <th key={c + i} style={{ ...S.th, ...(i >= 2 && i <= 12 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
              <tbody>
                {d.rows.length === 0 && <tr><td colSpan={cols.length} style={S.center}>Nothing to follow up for these filters.</td></tr>}
                {d.rows.map(x => (
                  <tr key={x.id}>
                    <td style={{ ...S.td, minWidth: 200 }}><div style={{ fontWeight: 600 }}>{x.client}</div>{KIND[x.kind] && <div style={S.small}>{KIND[x.kind]}</div>}</td>
                    <td style={{ ...S.td, fontSize: '0.7rem' }}>{x.tans.join(', ') || '—'}</td>
                    <td style={{ ...S.td, ...S.num }}>{r(x.zoho)}</td><td style={{ ...S.td, ...S.num }}>{r(x.deducted)}</td><td style={{ ...S.td, ...S.num }}>{r(x.deposited)}</td>
                    <td style={{ ...S.td, ...S.num, fontWeight: 700, color: x.follow_up ? '#B91C1C' : '#15803D' }}>{r(x.follow_up)}</td>
                    {['missing', 'ded_gt_dep', 'short_credit', 'non_deposit', 'subsequent', 'review_first', 'excess_credit'].map(k => <td key={k} style={{ ...S.td, ...S.num, color: x[k] ? '#18191B' : '#C4CDD3' }}>{x[k] ? r(x[k]) : '—'}</td>)}
                    <td style={S.td}>{x.oldest_open ? <>{dt(x.oldest_open)}<div style={S.small}>{x.age_days} days</div></> : '—'}</td>
                    <td style={S.td}>{x.owner || <span style={S.small}>—</span>}</td>
                    <td style={{ ...S.td, maxWidth: 220, fontSize: '0.72rem' }}>{x.remarks || <span style={S.small}>—</span>}{x.remarks_by && <div style={S.small}>{x.remarks_by}, {dt(x.remarks_at)}</div>}</td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                      {x.open_units.length > 0 && <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => onDrill({ ids: x.open_units.join(',') })}>{x.open_units.length} open item{x.open_units.length === 1 ? '' : 's'}</button>}
                      {x.kind === 'client' && meta.rights.review && <button style={{ ...S.ghost, padding: '0.15rem 0.5rem', marginLeft: 4 }} onClick={() => setEdit({ id: x.id, client: x.client, owner_id: x.owner_id, remarks: x.remarks })}>Owner / remarks</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
              {T && <tfoot><tr style={{ background: '#F9F9F9', fontWeight: 700 }}>
                <td style={S.td}>Total ({d.rows.length} rows)</td><td style={S.td} />
                {['zoho', 'deducted', 'deposited', 'follow_up', 'missing', 'ded_gt_dep', 'short_credit', 'non_deposit', 'subsequent', 'review_first', 'excess_credit'].map(k => <td key={k} style={{ ...S.td, ...S.num }}>{r(d.rows.reduce((a, x) => a + x[k], 0))}</td>)}
                <td style={S.td} colSpan={4} />
              </tr></tfoot>}
            </table>
          </div>
          {T && <div style={{ ...S.small, padding: '0.5rem 1rem' }}>All clients in the period (before filters): Zoho {r(d.all_totals.zoho)} · deducted {r(d.all_totals.deducted)} · deposited {r(d.all_totals.deposited)} · follow-up {r(d.all_totals.follow_up)} — the client rows (including the not-mapped and unallocated rows) add up to the entity's source totals.</div>}
        </div>
      )}
      {edit && (
        <Modal title={`Owner and remarks — ${edit.client}`} onClose={() => setEdit(null)}>
          <Field label="Owner (who follows up)">
            <select style={{ ...S.select, maxWidth: '100%', width: '100%' }} value={edit.owner_id || ''} onChange={e => setEdit({ ...edit, owner_id: e.target.value })}>
              <option value="">No owner</option>{meta.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Remarks" style={{ marginTop: 10 }}><textarea rows={4} style={{ ...S.input, width: '100%' }} value={edit.remarks || ''} onChange={e => setEdit({ ...edit, remarks: e.target.value })} /></Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}><button style={S.ghost} onClick={() => setEdit(null)}>Cancel</button><button style={S.primary} onClick={save}>Save</button></div>
        </Modal>
      )}
    </div>
  );
}
