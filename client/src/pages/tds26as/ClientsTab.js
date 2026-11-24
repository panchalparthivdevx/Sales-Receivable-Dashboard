import React, { useEffect, useState } from 'react';
import { t, errMsg } from './api';
import { S, r, Msg, Modal, Field, Tag, tableWrap, table } from './ui';

const AUTO_SHOWN = 60;

export default function ClientsTab({ meta, entity, stamp, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [customers, setCustomers] = useState(null);
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
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

  const auto = d.auto || [];
  const needle = q.trim().toUpperCase();
  const autoHit = needle ? auto.filter(g => g.name.toUpperCase().includes(needle) || g.tans.some(x => x.tan.includes(needle)) || g.tan_customers.some(c => String(c.name).toUpperCase().includes(needle))) : auto;
  const autoShown = all || needle ? autoHit : autoHit.slice(0, AUTO_SHOWN);
  const multi = auto.filter(g => g.tan_customers.length > 1).length;
  const custName = id => { for (const g of [...auto, ...d.groups]) { const c = [...g.customers, ...(g.tan_customers || [])].find(x => x.id === id); if (c) return c.name || id; } return id; };

  return (
    <div>
      <Msg error={err} ok={ok} onClose={() => { setErr(''); setOk(''); }} />
      <div style={S.info}>
        Clients are matched on the <b>deductor TAN</b>, for <b>{entity.name}</b> only. Every Zoho entry belongs to the client whose TAN is recorded on its invoice
        ({entity.tan_field || 'the TAN field'}), so several Zoho customers with the same TAN — one per branch, names slightly different — are one client and are matched
        together against that TAN's 26AS credits. No approval is needed for this. Use <b>client groups</b> only where the TAN cannot tell: a client that deducts from
        several TANs, or customers whose invoices carry no TAN.
      </div>

      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.cardTitle}>Matched automatically by TAN ({auto.length})</span>
          <span style={S.small}>{multi} of them combine more than one Zoho customer</span>
        </div>
        <div style={{ padding: '0.5rem 1rem' }}>
          <input style={{ ...S.input, width: 320 }} placeholder="Search client, TAN or Zoho customer" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr>{['Client (deductor in 26AS)', 'TAN', 'Zoho customers with this TAN on their invoices', 'Zoho TDS (all periods)', '26AS deducted (all periods)', ''].map((c, i) => <th key={c + i} style={{ ...S.th, ...(i === 3 || i === 4 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
            <tbody>
              {autoShown.length === 0 && <tr><td colSpan={6} style={S.center}>{needle ? 'Nothing matches the search.' : 'No Zoho invoice records a TAN yet — sync Zoho, or check the TAN field in Settings.'}</td></tr>}
              {autoShown.map(g => {
                const tan = g.tans[0].tan;
                return (
                  <tr key={g.id}>
                    <td style={{ ...S.td, fontWeight: 600 }}>{g.name}{!g.in_statement && <div><Tag tone="amber">in no uploaded 26AS</Tag></div>}</td>
                    <td style={{ ...S.td, fontFamily: 'monospace' }}>{tan}</td>
                    <td style={{ ...S.td, fontSize: '0.72rem' }}>
                      {g.tan_customers.map(c => (
                        <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                          <span>{c.name || c.id}</span>
                          {g.totals.per_customer[c.id] ? <span style={S.small}>{r(g.totals.per_customer[c.id])}</span> : null}
                          {can && <button style={{ ...S.ghost, padding: '0 0.35rem', fontSize: '0.68rem' }} title="This customer is not this deductor — its entries stop being matched on this TAN"
                            onClick={() => window.confirm(`${c.name || c.id} is NOT the deductor with TAN ${tan}? Its entries stop being matched on this TAN.`) && act(() => t.reject(entity.id, c.id, tan, true, c.name), `${c.name || c.id} is no longer matched on ${tan}.`)}>not this client</button>}
                        </div>
                      ))}
                    </td>
                    <td style={{ ...S.td, ...S.num }}>{r(g.totals.zoho)}<div style={S.small}>{g.totals.entries} entr{g.totals.entries === 1 ? 'y' : 'ies'}</div></td>
                    <td style={{ ...S.td, ...S.num }}>{r(g.totals.credits)}<div style={S.small}>{g.totals.n_credits} credit(s)</div></td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{can && <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} title="Name it, or add another TAN of the same client" onClick={() => openEdit({ name: g.name, customers: g.tan_customers, tans: g.tans })}>Make a group…</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!all && !needle && autoHit.length > AUTO_SHOWN && <div style={{ padding: '0.5rem 1rem' }}><button style={S.ghost} onClick={() => setAll(true)}>Show all {autoHit.length}</button></div>}
      </div>

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Suggestions — deductors no Zoho invoice records ({d.suggestions.length})</span></div>
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr>{['Deductor (26AS)', 'TAN', 'Credits', 'Suggested Zoho customer', 'Zoho entries', 'Why', ''].map((c, i) => <th key={c + i} style={{ ...S.th, ...(i === 2 || i === 4 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
            <tbody>
              {d.suggestions.length === 0 && <tr><td colSpan={7} style={S.center}>No open suggestions.</td></tr>}
              {d.suggestions.map(s => (
                <tr key={s.id}>
                  <td style={{ ...S.td, fontWeight: 600 }}>{s.deductor}</td><td style={S.td}>{s.tan}</td><td style={{ ...S.td, ...S.num }}>{s.credits} · {r(s.deducted)}</td>
                  <td style={S.td}>{s.customer_name}{s.existing_group && <div style={S.small}>joins client "{s.existing_name}"{s.customer_tans && s.customer_tans.length ? ` (TAN ${s.customer_tans.join(', ')})` : ''}</div>}</td><td style={{ ...S.td, ...S.num }}>{s.zoho_entries} · {r(s.zoho_amount)}</td>
                  <td style={{ ...S.td, fontSize: '0.72rem', maxWidth: 300 }}><Tag tone="amber">{`Similar name ${Math.round(s.score * 100)}%`}</Tag>{s.competing && <Tag tone="red">other candidates</Tag>}<div>{s.detail}</div></td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{can && <><button style={{ ...S.btn, padding: '0.15rem 0.5rem' }} onClick={() => act(() => t.approve(entity.id, [s]), 'Mapping approved.')}>Approve</button> <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => act(() => t.reject(entity.id, s.customer_id, s.tan, true, s.customer_name), 'Suggestion rejected.')}>Reject</button></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1rem' }}>
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Deductors not mapped ({d.unmapped_tans.length})</span><span style={S.small}>no Zoho invoice records their TAN</span></div>
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
          <div style={S.cardHead}><span style={S.cardTitle}>Zoho customers with TDS, not matched by TAN ({d.unmapped_customers.length})</span></div>
          <div style={tableWrap}><table style={table}><tbody>
            {d.unmapped_customers.length === 0 && <tr><td style={S.center}>Every customer with TDS booked has a client.</td></tr>}
            {d.unmapped_customers.map(x => (
              <tr key={x.id}><td style={S.td}><b>{x.name || x.id}</b><div style={S.small}>{x.entries} entr{x.entries === 1 ? 'y' : 'ies'} · {r(x.amount)} · {x.why}</div></td>
                <td style={{ ...S.td, textAlign: 'right' }}>{can && <button style={{ ...S.btn, padding: '0.15rem 0.5rem' }} onClick={() => openEdit({ name: x.name, customers: [{ id: x.id, name: x.name }], tans: x.tans.map(tan => ({ tan })) })}>Add TAN…</button>}</td></tr>
            ))}
          </tbody></table></div>
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Client groups ({d.groups.length})</span>{can && <button style={S.btn} onClick={() => openEdit({})}>New client group</button>}</div>
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr>{['Client', 'Zoho customer(s)', 'TAN(s)', 'Zoho TDS (all periods)', '26AS deducted (all periods)', ''].map((c, i) => <th key={c + i} style={{ ...S.th, ...(i === 3 || i === 4 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
            <tbody>
              {d.groups.length === 0 && <tr><td colSpan={6} style={S.center}>No client groups — the TAN matching above covers the clients.</td></tr>}
              {d.groups.map(g => (
                <tr key={g.id}>
                  <td style={{ ...S.td, fontWeight: 600 }}>{g.name}<div style={S.small}>{g.by}{g.at ? `, ${g.at.slice(0, 10)}` : ''}</div></td>
                  <td style={{ ...S.td, fontSize: '0.72rem' }}>
                    {g.customers.map(c => <div key={c.id}>{c.name || c.id}</div>)}
                    {(g.tan_customers || []).length > 0 && <div style={{ ...S.small, marginTop: 3 }}>also by the TAN on their invoices: {g.tan_customers.map(c => c.name || c.id).join(', ')}</div>}
                  </td>
                  <td style={{ ...S.td, fontSize: '0.72rem' }}>{g.tans.map(x => <div key={x.tan}>{x.tan} <span style={S.small}>{x.basis === 'tan_field' ? '(TAN on invoice)' : x.basis === 'name' ? '(name)' : ''}</span></div>)}</td>
                  <td style={{ ...S.td, ...S.num }}>{r(g.totals.zoho)}</td><td style={{ ...S.td, ...S.num }}>{r(g.totals.credits)}</td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{can && <><button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => openEdit(g)}>Edit</button> <button style={{ ...S.danger, padding: '0.15rem 0.5rem' }} onClick={() => window.confirm(`Remove client group "${g.name}"? Its entries go back to the TAN matching.`) && act(() => t.removeGroup(entity.id, g.id), 'Client group removed.')}>Remove</button></>}</td>
                </tr>))}
            </tbody>
          </table>
        </div>
      </div>

      {(d.rejected || []).length > 0 && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Not the same client ({d.rejected.length})</span><span style={S.small}>customer ↔ TAN pairs a reviewer ruled out — never matched</span></div>
          <div style={tableWrap}><table style={table}><tbody>
            {d.rejected.map(x => (
              <tr key={`${x.customer_id}|${x.tan}`}><td style={S.td}>{x.name || custName(x.customer_id)} <span style={S.muted}>≠ {x.tan}</span><div style={S.small}>{x.by}{x.at ? `, ${String(x.at).slice(0, 10)}` : ''}</div></td>
                <td style={{ ...S.td, textAlign: 'right' }}>{can && <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => act(() => t.reject(entity.id, x.customer_id, x.tan, false), 'Restored.')}>Undo</button>}</td></tr>
            ))}
          </tbody></table></div>
        </div>
      )}

      {edit && (
        <Modal title={edit.id ? `Edit client group — ${edit.name}` : 'Client group'} onClose={() => setEdit(null)} width={600}>
          <Field label="Name"><input style={{ ...S.input, width: '100%' }} value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Zoho customer(s)" style={{ marginTop: 10 }}>
            <div>{edit.customers.map(c => <Tag key={c.id}>{c.name || c.id} <span style={{ cursor: 'pointer' }} onClick={() => setEdit({ ...edit, customers: edit.customers.filter(x => x.id !== c.id) })}>✕</span></Tag>)}</div>
            <select style={{ ...S.select, maxWidth: '100%', width: '100%', marginTop: 4 }} value="" onChange={e => { const c = (customers || []).find(x => x.id === e.target.value); if (c && !edit.customers.some(x => x.id === c.id)) setEdit({ ...edit, customers: [...edit.customers, c] }); }}>
              <option value="">Add a Zoho customer…</option>{(customers || []).map(c => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
            </select>
          </Field>
          <Field label="Deductor TAN(s) — one per line" style={{ marginTop: 10 }}><textarea rows={3} style={{ ...S.input, width: '100%', fontFamily: 'monospace' }} value={edit.tans} onChange={e => setEdit({ ...edit, tans: e.target.value.toUpperCase() })} /></Field>
          <div style={{ ...S.small, marginTop: 6 }}>Entries whose invoice records one of these TANs are matched under this group, whichever Zoho customer they are booked to.</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}><button style={S.ghost} onClick={() => setEdit(null)}>Cancel</button><button style={S.primary} onClick={saveEdit}>Save client group</button></div>
        </Modal>
      )}
    </div>
  );
}
