import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { bb, errMsg } from './bbApi';
import { S, Tag, Msg, dt } from './ui';

// ─── Confirmed mappings ───────────────────────────────────────────────────────
// What the team confirmed on a bill ("for this vendor and this kind of line, use this account / GST"),
// kept per company + vendor + category so similar bills need no input next time. Review and correct here.

export default function MappingsTab({ meta }) {
  const [list, setList] = useState(null);
  const [look, setLook] = useState({});
  const [q, setQ] = useState('');
  const [company, setCompany] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const can = meta.rights.review;

  const load = useCallback(() => bb.mappings().then(r => setList(r.mappings)).catch(e => setError(errMsg(e))), []);
  useEffect(() => { load(); }, [load]);
  const companies = useMemo(() => [...new Set((list || []).map(m => m.company))], [list]);
  useEffect(() => {
    if (!can) return;
    for (const c of companies) if (!look[c]) bb.lookups(c).then(l => setLook(x => ({ ...x, [c]: l }))).catch(() => {});
  }, [companies, can, look]);

  async function change(m, patch, msg) {
    setError(''); setOk('');
    try { await bb.saveMapping(m.id, patch); await load(); setOk(msg); } catch (e) { setError(errMsg(e)); }
  }

  const shown = (list || []).filter(m => (!company || m.company === company)
    && (!q || `${m.vendor_name} ${m.description} ${m.account_name} ${m.category_name} ${m.field_id || ''}`.toLowerCase().includes(q.toLowerCase())));
  const coName = id => meta.companies.find(c => c.id === id)?.name || id;

  return (
    <div>
      <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />
      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.cardTitle}>Confirmed mappings <span style={S.small}>{list ? `${shown.length} of ${list.length}` : ''}</span></span>
          <div style={{ display: 'flex', gap: 6 }}>
            <select style={S.select} value={company} onChange={e => setCompany(e.target.value)}><option value="">All companies</option>{meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <input style={{ ...S.input, width: 220 }} placeholder="Vendor, description, account…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
        </div>
        <div style={{ overflow: 'auto', maxHeight: '70vh' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
            <thead><tr>{['Company', 'Vendor', 'Category', 'Bill line like…', 'Expense account', 'GST tax', 'Confirmed by', 'Active', ''].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {!list && <tr><td colSpan={9} style={S.center}>Loading…</td></tr>}
              {list && !shown.length && <tr><td colSpan={9} style={S.center}>No mappings yet — they are saved when the team chooses an account on a bill with "Remember" ticked.</td></tr>}
              {shown.map(m => {
                const l = look[m.company];
                return (
                  <tr key={m.id} style={{ opacity: m.active === false ? 0.5 : 1 }}>
                    <td style={S.td}>{coName(m.company)}</td>
                    <td style={S.td}><b>{m.vendor_name}</b></td>
                    <td style={S.td}>{m.category_name || <span style={S.small}>any</span>}</td>
                    <td style={{ ...S.td, maxWidth: 260 }}>
                      {m.kind === 'field' ? <><Tag tone="violet">Field</Tag> {m.field_id} = <b>{typeof m.value === 'object' ? m.value?.name : String(m.value)}</b></>
                        : can ? <input style={{ ...S.input, width: '100%' }} defaultValue={m.description} placeholder="(all bills of this vendor)" onBlur={e => e.target.value !== m.description && change(m, { description: e.target.value }, 'Description updated')} />
                          : (m.description || <span style={S.small}>all bills of this vendor</span>)}
                    </td>
                    <td style={S.td}>
                      {m.kind === 'field' ? '—' : can && l ? (
                        <select style={{ ...S.select, maxWidth: 220 }} value={m.account_id} onChange={e => change(m, { account_id: e.target.value }, 'Account updated')}>
                          {!l.accounts.some(a => a.id === m.account_id) && <option value={m.account_id}>{m.account_name}</option>}
                          {l.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      ) : m.account_name}
                    </td>
                    <td style={S.td}>
                      {m.kind === 'field' ? '—' : can && l ? (
                        <select style={{ ...S.select, maxWidth: 150 }} value={m.tax_id || ''} onChange={e => change(m, { tax_id: e.target.value }, 'GST tax updated')}>
                          <option value="">— not confirmed —</option>
                          {l.taxes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      ) : (m.tax_name || '—')}
                    </td>
                    <td style={S.td}>{m.updated_by || m.created_by}<div style={S.small}>{dt(m.updated_at || m.created_at)}{m.from_bill ? ` · ${m.from_bill}` : ''}</div></td>
                    <td style={S.td}><input type="checkbox" disabled={!can} checked={m.active !== false} onChange={e => change(m, { active: e.target.checked }, e.target.checked ? 'Mapping on' : 'Mapping off')} /></td>
                    <td style={S.td}>{can && <button style={{ ...S.ghost, padding: 4 }} title="Delete" onClick={() => { if (window.confirm('Delete this mapping?')) bb.removeMapping(m.id).then(load).catch(e => setError(errMsg(e))); }}><Trash2 size={12} /></button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
