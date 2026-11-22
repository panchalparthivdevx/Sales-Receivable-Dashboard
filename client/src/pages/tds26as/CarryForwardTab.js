import React, { useEffect, useState } from 'react';
import { t, errMsg } from './api';
import { S, r, rs, dt, Msg, Modal, Field, tableWrap, table, qLabel } from './ui';

export default function CarryForwardTab({ meta, params, stamp, onChanged }) {
  const [by, setBy] = useState('quarter');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [show, setShow] = useState(null);            // { label, ids }
  const [close, setClose] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => t.carryforward({ ...params, by }).then(setD).catch(e => setErr(errMsg(e)));
  useEffect(() => { setD(null); setErr(''); load(); }, [JSON.stringify(params), by, stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = d ? Object.fromEntries(d.items.map(x => [x.id, x])) : {};
  const list = show ? show.ids.map(id => items[id]).filter(Boolean) : d ? d.items : [];
  const doClose = async () => {
    try { await t.closeCf({ entity: params.entity, id: close.id, reason: close.reason, evidence: close.evidence }); setOk('Closed. The balance leaves the carry-forward in this quarter.'); setClose(null); load(); onChanged(); } catch (e) { setErr(errMsg(e)); }
  };
  const rerun = async () => { setBusy(true); try { const x = await t.rerun(params.entity); setOk(`${x.settled} carry-forward item(s) settled by credits found later.`); load(); onChanged(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const exportIt = async () => { setBusy(true); try { await t.exportXlsx({ ...params, report: 'carryforward', by }); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const cell = (row, key, label) => <td style={{ ...S.td, ...S.num, cursor: row.items[key].length ? 'pointer' : 'default', textDecoration: row.items[key].length ? 'underline dotted' : 'none' }} onClick={() => row.items[key].length && setShow({ label: `${row.label} — ${label}`, ids: row.items[key] })}>{r(row[key === 'settled' ? 'settled' : key === 'closed' ? 'closed' : key])}</td>;
  return (
    <div>
      <Msg error={err} ok={ok} onClose={() => { setErr(''); setOk(''); }} />
      <div style={{ ...S.card, padding: '0.6rem 0.9rem', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={by === 'quarter' ? S.primary : S.ghost} onClick={() => setBy('quarter')}>Quarter-wise</button>
        <button style={by === 'fy' ? S.primary : S.ghost} onClick={() => setBy('fy')}>Year-wise</button>
        <span style={S.muted}>Items are created in Transactions → an item → Review → Final status "Carry Forward".</span>
        <div style={{ flex: 1 }} />
        {meta.rights.prepare && <button style={S.ghost} disabled={busy} onClick={rerun}>Look for later credits now</button>}
        <button style={S.btn} disabled={busy} onClick={exportIt}>Export to Excel</button>
      </div>
      {!d ? <div style={S.center}>Loading…</div> : (
        <>
          <div style={S.card}>
            <table style={table}>
              <thead><tr>{['Period', 'Opening balance', 'Additions', 'Credits identified later', 'Reviewer-approved closures', 'Closing balance'].map((c, i) => <th key={c} style={{ ...S.th, ...(i ? S.thR : {}) }}>{c}</th>)}</tr></thead>
              <tbody>{d.rows.map(x => (
                <tr key={x.id}><td style={{ ...S.td, fontWeight: 600 }}>{x.label}</td>{cell(x, 'opening', 'opening')}{cell(x, 'additions', 'additions')}{cell(x, 'settled', 'credits identified later')}{cell(x, 'closed', 'closures')}{cell(x, 'closing', 'closing items')}</tr>
              ))}</tbody>
            </table>
            <div style={{ ...S.small, padding: '0.5rem 1rem' }}>Closing = opening + additions − credits identified later − closures. Click a figure for the items; each item shows its originating quarter and its settlement.</div>
          </div>
          <div style={S.card}>
            <div style={S.cardHead}><span style={S.cardTitle}>{show ? show.label : 'All carry-forward items'}</span>{show && <button style={S.ghost} onClick={() => setShow(null)}>Show all</button>}</div>
            <div style={tableWrap}>
              <table style={table}>
                <thead><tr>{['Client', 'Waiting for', 'Originating quarter', 'Balance', 'Target', 'Reason', 'Approved', 'Status', 'Settlement / closure', ''].map((c, i) => <th key={c + i} style={{ ...S.th, ...(i === 3 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
                <tbody>
                  {list.length === 0 && <tr><td colSpan={10} style={S.center}>No carry-forward items.</td></tr>}
                  {list.map(x => (
                    <tr key={x.id}>
                      <td style={{ ...S.td, fontWeight: 600 }}>{x.client}</td><td style={{ ...S.td, fontSize: '0.72rem' }}>{x.side === 'zoho' ? 'a 26AS credit (booked in Zoho)' : 'a Zoho booking (credited in 26AS)'}</td>
                      <td style={S.td}>{x.origin_label}</td><td style={{ ...S.td, ...S.num }}>{r(x.balance)}</td><td style={S.td}>{x.target_label}</td>
                      <td style={{ ...S.td, fontSize: '0.72rem', maxWidth: 240 }}>{x.reason}</td><td style={{ ...S.td, fontSize: '0.72rem' }}>{x.by}<div style={S.small}>{dt(x.at)}</div></td>
                      <td style={S.td}><b style={{ color: x.status === 'open' ? '#B45309' : '#15803D' }}>{x.status}</b></td>
                      <td style={{ ...S.td, fontSize: '0.72rem' }}>{x.settlement ? <>{qLabel(x.settlement.quarter)}: {x.settlement.detail}{x.settlement.diff ? <div style={S.small}>difference {rs(x.settlement.diff)}</div> : null}</> : x.closure ? <>{x.closed_label}: {x.closure.reason}</> : '—'}</td>
                      <td style={S.td}>{x.status === 'open' && meta.rights.review && <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => setClose({ id: x.id, client: x.client, balance: x.balance, reason: '', evidence: '' })}>Close…</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {close && (
        <Modal title={`Close ${r(close.balance)} — ${close.client}`} onClose={() => setClose(null)}>
          <p style={S.muted}>A reviewer-approved closure (e.g. written off, credit claimed under another TAN). The original period's history is kept.</p>
          <Field label="Reason (required)"><textarea rows={3} style={{ ...S.input, width: '100%' }} value={close.reason} onChange={e => setClose({ ...close, reason: e.target.value })} /></Field>
          <Field label="Evidence references (one per line)" style={{ marginTop: 8 }}><textarea rows={2} style={{ ...S.input, width: '100%' }} value={close.evidence} onChange={e => setClose({ ...close, evidence: e.target.value })} /></Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}><button style={S.ghost} onClick={() => setClose(null)}>Cancel</button><button style={S.primary} disabled={!close.reason.trim()} onClick={doClose}>Close the balance</button></div>
        </Modal>
      )}
    </div>
  );
}
