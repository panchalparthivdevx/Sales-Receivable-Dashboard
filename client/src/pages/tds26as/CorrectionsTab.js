import React, { useEffect, useState } from 'react';
import { t, errMsg } from './api';
import { S, r, rs, dt, Msg, StatusPill, tableWrap, table } from './ui';

export default function CorrectionsTab({ meta, params, stamp }) {
  const [kind, setKind] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setD(null); setErr(''); t.corrections({ ...params, kind }).then(setD).catch(e => setErr(errMsg(e))); }, [JSON.stringify(params), kind, stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const exportIt = async () => { setBusy(true); try { await t.exportXlsx({ ...params, report: 'corrections' }); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  return (
    <div>
      <Msg error={err} onClose={() => setErr('')} />
      <div style={S.info}>Possible corrections in Zoho Books found by the reconciliation. This module never changes Zoho — open the record with the link and correct it there; the next Zoho sync picks the change up.</div>
      <div style={{ ...S.card, padding: '0.6rem 0.9rem', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={kind === '' ? S.primary : S.ghost} onClick={() => setKind('')}>All</button>
        {d && Object.entries(d.kinds).map(([k, v]) => <button key={k} style={kind === k ? S.primary : S.ghost} onClick={() => setKind(k)}>{v} ({d.counts[k]})</button>)}
        <div style={{ flex: 1 }} /><button style={S.btn} disabled={busy} onClick={exportIt}>{busy ? 'Preparing…' : 'Export to Excel'}</button>
      </div>
      {!d ? <div style={S.center}>Loading…</div> : (
        <div style={S.card}>
          <div style={tableWrap}>
            <table style={table}>
              <thead><tr>{['Area', 'Issue', 'Client', 'Zoho record', '26AS credit', 'Amount', 'Detail', 'Status'].map((c, i) => <th key={c} style={{ ...S.th, ...(i === 5 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
              <tbody>
                {d.rows.length === 0 && <tr><td colSpan={8} style={S.center}>Nothing to correct for this period.</td></tr>}
                {d.rows.map((x, i) => (
                  <tr key={i}>
                    <td style={{ ...S.td, fontSize: '0.72rem' }}>{d.kinds[x.kind]}</td>
                    <td style={{ ...S.td, fontWeight: 600 }}>{x.label}</td>
                    <td style={S.td}>{x.client}</td>
                    <td style={{ ...S.td, fontSize: '0.72rem' }}>{x.zoho ? <>{x.zoho.url ? <a href={x.zoho.url} target="_blank" rel="noreferrer">{x.zoho.type_label} {x.zoho.number} ↗</a> : `${x.zoho.type_label} ${x.zoho.number}`}<div style={S.small}>{dt(x.zoho.date)} · {x.zoho.ledgers.join(', ')}</div></> : (x.candidate_invoices || []).map(c => <div key={c.no}>book against {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.no} ↗</a> : c.no} <span style={S.small}>(basic {r(c.basic)})</span></div>)}</td>
                    <td style={{ ...S.td, fontSize: '0.72rem' }}>{x.credit ? <>{x.credit.deductor} ({x.credit.tan})<div style={S.small}>{dt(x.credit.txn_date)} · {x.credit.section_raw} · deposited {r(x.credit.deposited)}</div></> : '—'}</td>
                    <td style={{ ...S.td, ...S.num }}>{rs(x.amount)}</td>
                    <td style={{ ...S.td, fontSize: '0.72rem', maxWidth: 360 }}>{x.detail}</td>
                    <td style={S.td}>{x.status && <StatusPill status={x.status} statuses={meta.statuses} small />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
