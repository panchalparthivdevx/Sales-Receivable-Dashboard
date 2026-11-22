import React, { useEffect, useState } from 'react';
import { t, errMsg } from './api';
import { S, r, Msg, Modal, Field, Tag, tableWrap, table } from './ui';

export default function ClientsTab({ meta, entity, stamp, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [customers, setCustomers] = useState(null);
  const [edit, setEdit] = useState(null);
  const can = meta.rights.review;
  const load = () => t.clients(entity.id).then(setD).catch(e => setErr(errMsg(e)));
  useEffect(() => { setD(null); load(); }, [entity.id, stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, msg) => { setErr(''); setOk(''); try { await fn(); setOk(msg); await load(); onChanged(); } catch (e) { setErr(errMsg(e)); } };
  const openEdit = async g => {
    if (!customers) { try { setCustomers((await t.customers(entity.id)).customers); } catch (e) { setErr(errMsg(e)); } }
    setEdit({ id: g.id || '', name: g.name || '', customers: g.customers || [], tans: (g.tans || []).map(x => x.tan).join('\n'), pick: '' });
  };
  const saveEdit = () => act(async () => { await t.saveGroup(entity.id, { id: edit.id, name: edit.name, customers: edit.customers, tans: edit.tans.split(/[\s,]+/).filter(Boolean).map(tan => ({ tan })) }); setEdit(null); }, 'Client saved.');
  if (!d) return err ? <div style={S.error}>{err}</div> : <div style={S.center}>Loading…</div>;
  const tanBacked = d.suggestions.filter(s => s.basis === 'tan_field' && !s.competing);
  return (
    <div>
      <Msg error={err} ok={ok} onClose={() => { setErr(''); setOk(''); }} />
      <div style={S.info}>
        A client = the Zoho customer(s) and the 26AS deductor TAN(s) that are the same party, for <b>{entity.name}</b> only. Only approved clients are matched; suggestions wait for a reviewer.
        A client may deduct from several TANs, and may exist twice in Zoho — put them in one client.
      </div>

      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.cardTitle}>Suggestions ({d.suggestions.length})</span>
          {can && tanBacked.length > 0 && <button style={S.primary} onClick={() => act(() => t.approve(entity.id, tanBacked), `${tanBacked.length} mapping(s) approved.`)}>Approve all {tanBacked.length} backed by the TAN on Zoho invoices</button>}
        </div>
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr>{['Deductor (26AS)', 'TAN', 'Credits', 'Suggested Zoho customer', 'Zoho entries', 'Why', ''].map((c, i) => <th key={c + i} style={{ ...S.th, ...(i === 2 || i === 4 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
            <tbody>
              {d.suggestions.length === 0 && <tr><td colSpan={7} style={S.center}>No open suggestions.</td></tr>}
              {d.suggestions.map(s => (
                <tr key={s.id}>
                  <td style={{ ...S.td, fontWeight: 600 }}>{s.deductor}</td><td style={S.td}>{s.tan}</td><td style={{ ...S.td, ...S.num }}>{s.credits} · {r(s.deducted)}</td>
                  <td style={S.td}>{s.customer_name}{s.existing_group && <div style={S.small}>joins an existing client</div>}</td><td style={{ ...S.td, ...S.num }}>{s.zoho_entries} · {r(s.zoho_amount)}</td>
                  <td style={{ ...S.td, fontSize: '0.72rem', maxWidth: 300 }}><Tag tone={s.basis === 'tan_field' ? 'green' : 'amber'}>{s.basis === 'tan_field' ? 'TAN on Zoho invoice' : `Similar name ${Math.round(s.score * 100)}%`}</Tag>{s.competing && <Tag tone="red">other candidates</Tag>}<div>{s.detail}</div></td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{can && <><button style={{ ...S.btn, padding: '0.15rem 0.5rem' }} onClick={() => act(() => t.approve(entity.id, [s]), 'Mapping approved.')}>Approve</button> <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => act(() => t.reject(entity.id, s.customer_id, s.tan), 'Suggestion rejected.')}>Reject</button></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1rem' }}>
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Deductors not mapped ({d.unmapped_tans.length})</span></div>
          <div style={tableWrap}><table style={table}><tbody>
            {d.unmapped_tans.length === 0 && <tr><td style={S.center}>Every deductor in the statements is mapped.</td></tr>}
            {d.unmapped_tans.map(x => (
              <tr key={x.tan}><td style={S.td}><b>{x.name}</b><div style={S.small}>{x.tan} · {x.n} credit(s) · deducted {r(x.deducted)}</div></td>
                <td style={{ ...S.td, whiteSpace: 'nowrap', textAlign: 'right' }}>{can && <><button style={{ ...S.btn, padding: '0.15rem 0.5rem' }} onClick={() => openEdit({ name: x.name, tans: [{ tan: x.tan }] })}>Map…</button> <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} title="Its credits become Not in Zoho Books" onClick={() => act(() => t.noCustomer(entity.id, x.tan, true), `${x.tan} marked as having no Zoho customer.`)}>No Zoho customer</button></>}</td></tr>
            ))}
            {Object.entries(d.no_customer || {}).map(([tan, v]) => <tr key={tan}><td style={S.td}><span style={S.muted}>{tan} — marked "no Zoho customer" by {v.by}</span></td><td style={{ ...S.td, textAlign: 'right' }}>{can && <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => act(() => t.noCustomer(entity.id, tan, false), 'Mark removed.')}>Undo</button>}</td></tr>)}
          </tbody></table></div>
        </div>
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Zoho customers with TDS, not mapped ({d.unmapped_customers.length})</span></div>
          <div style={tableWrap}><table style={table}><tbody>
            {d.unmapped_customers.length === 0 && <tr><td style={S.center}>Every customer with TDS booked is mapped.</td></tr>}
            {d.unmapped_customers.map(x => (
              <tr key={x.id}><td style={S.td}><b>{x.name || x.id}</b><div style={S.small}>{x.entries} entr{x.entries === 1 ? 'y' : 'ies'} · {r(x.amount)}{x.tans.length ? ` · TAN on invoice ${x.tans.join(', ')}` : ''}</div></td>
                <td style={{ ...S.td, textAlign: 'right' }}>{can && <button style={{ ...S.btn, padding: '0.15rem 0.5rem' }} onClick={() => openEdit({ name: x.name, customers: [{ id: x.id, name: x.name }], tans: x.tans.map(tan => ({ tan })) })}>Add TAN…</button>}</td></tr>
            ))}
          </tbody></table></div>
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Clients ({d.groups.length})</span>{can && <button style={S.btn} onClick={() => openEdit({})}>New client</button>}</div>
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr>{['Client', 'Zoho customer(s)', 'TAN(s)', 'Zoho TDS (all periods)', '26AS deducted (all periods)', ''].map((c, i) => <th key={c + i} style={{ ...S.th, ...(i === 3 || i === 4 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
            <tbody>{d.groups.map(g => (
              <tr key={g.id}>
                <td style={{ ...S.td, fontWeight: 600 }}>{g.name}<div style={S.small}>{g.by}{g.at ? `, ${g.at.slice(0, 10)}` : ''}</div></td>
                <td style={{ ...S.td, fontSize: '0.72rem' }}>{g.customers.map(c => <div key={c.id}>{c.name || c.id}</div>)}</td>
                <td style={{ ...S.td, fontSize: '0.72rem' }}>{g.tans.map(x => <div key={x.tan}>{x.tan} <span style={S.small}>{x.basis === 'tan_field' ? '(TAN on invoice)' : x.basis === 'name' ? '(name)' : ''}</span></div>)}</td>
                <td style={{ ...S.td, ...S.num }}>{r(g.totals.zoho)}</td><td style={{ ...S.td, ...S.num }}>{r(g.totals.credits)}</td>
                <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{can && <><button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => openEdit(g)}>Edit</button> <button style={{ ...S.danger, padding: '0.15rem 0.5rem' }} onClick={() => window.confirm(`Remove client "${g.name}"? Its entries go back to "not mapped".`) && act(() => t.removeGroup(entity.id, g.id), 'Client removed.')}>Remove</button></>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      </div>

      {edit && (
        <Modal title={edit.id ? `Edit client — ${edit.name}` : 'Client'} onClose={() => setEdit(null)} width={600}>
          <Field label="Name"><input style={{ ...S.input, width: '100%' }} value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Zoho customer(s)" style={{ marginTop: 10 }}>
            <div>{edit.customers.map(c => <Tag key={c.id}>{c.name || c.id} <span style={{ cursor: 'pointer' }} onClick={() => setEdit({ ...edit, customers: edit.customers.filter(x => x.id !== c.id) })}>✕</span></Tag>)}</div>
            <select style={{ ...S.select, maxWidth: '100%', width: '100%', marginTop: 4 }} value="" onChange={e => { const c = (customers || []).find(x => x.id === e.target.value); if (c && !edit.customers.some(x => x.id === c.id)) setEdit({ ...edit, customers: [...edit.customers, c] }); }}>
              <option value="">Add a Zoho customer…</option>{(customers || []).map(c => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
            </select>
          </Field>
          <Field label="Deductor TAN(s) — one per line" style={{ marginTop: 10 }}><textarea rows={3} style={{ ...S.input, width: '100%', fontFamily: 'monospace' }} value={edit.tans} onChange={e => setEdit({ ...edit, tans: e.target.value.toUpperCase() })} /></Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}><button style={S.ghost} onClick={() => setEdit(null)}>Cancel</button><button style={S.primary} onClick={saveEdit}>Save client</button></div>
        </Modal>
      )}
    </div>
  );
}
