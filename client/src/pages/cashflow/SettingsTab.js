import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { S, Field, Tag, dtm } from '../billbooking/ui';
import { cf, errMsg } from './cfApi';
import { Section } from './cfUi';

// ─── Settings: which Zoho accounts make each category, which bills are read, refresh status per company ───

export default function SettingsTab({ meta, onRefresh, reloadMeta }) {
  const [cats, setCats] = useState(meta.category_config || {});
  const [accounts, setAccounts] = useState({});
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  useEffect(() => setCats(meta.category_config || {}), [meta]);
  useEffect(() => {
    meta.companies.forEach(c => cf.accounts(c.id).then(d => setAccounts(a => ({ ...a, [c.id]: d }))).catch(() => {}));
  }, [meta.companies]);
  const field = (k, f) => (Array.isArray(cats[k]?.[f]) ? cats[k][f].join(', ') : '');
  const setField = (k, f, v) => setCats(c => ({ ...c, [k]: { ...c[k], [f]: v.split(',') } }));
  const dirty = JSON.stringify(cats) !== JSON.stringify(meta.category_config || {});

  return (
    <div style={{ maxWidth: 1150 }}>
      {err && <div style={S.error}>{err}</div>}
      {ok && <div style={S.ok}>{ok}</div>}
      <Section title="Zoho data" right={<button type="button" style={S.btn} onClick={() => onRefresh('all', true)}><RefreshCw size={12} /> Refresh now (and reload accounts)</button>}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Company', 'Bills listed', 'Read in detail (candidates)', 'Waiting to be read', 'Last refresh', 'Complete as of', 'Notes'].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {meta.companies.map(c => {
              const st = meta.status?.[c.id] || {};
              return (
                <tr key={c.id}>
                  <td style={S.td}><b>{c.name}</b><div style={S.small}>{c.org_id}</div></td>
                  <td style={S.td}>{st.listed ?? '—'}</td><td style={S.td}>{st.candidates ?? '—'}</td>
                  <td style={S.td}>{st.remaining ? <Tag tone="amber">{st.remaining}</Tag> : st.last_step_at ? <Tag tone="green">0</Tag> : '—'}</td>
                  <td style={S.td}>{st.last_step_at ? `${dtm(st.last_step_at)} (${st.last_step_by || ''})` : 'never'}</td>
                  <td style={S.td}>{st.last_complete_at ? dtm(st.last_complete_at) : '—'}</td>
                  <td style={S.td}>{(st.errors || []).slice(0, 3).map((e, i) => <div key={i} style={{ ...S.small, color: '#B91C1C' }}>{e}</div>)}{st.coa_accounts ? <div style={S.small}>{st.coa_accounts} accounts read {dtm(st.coa_at)}</div> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ ...S.small, marginTop: 6 }}>Bill and payment lists come from the dashboard's Zoho sync (Sync Monitor). Only bills that may belong to a category are read in detail, once each, and again only when they change in Zoho. {meta.vercel ? 'Online the reading continues every 15 minutes by itself.' : 'On this PC it continues every 30 minutes by itself.'}</div>
      </Section>

      <Section title="Categories" right={dirty && <button type="button" style={S.primary} onClick={async () => { setErr(''); setOk(''); try { await cf.saveConfig(cats); setOk('Saved — the tabs use the new accounts at once; a refresh reads any newly matching bills.'); await reloadMeta(); } catch (e) { setErr(errMsg(e)); } }}>Save</button>}>
        {meta.categories.map(c => (
          <div key={c.key} style={{ borderBottom: '1px solid #F0F2F1', paddingBottom: 10, marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: '0.86rem', marginBottom: 6 }}>{c.label}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Zoho accounts (with every account under them)"><input style={{ ...S.input, width: '100%' }} value={field(c.key, 'account_roots')} onChange={e => setField(c.key, 'account_roots', e.target.value)} /></Field>
              <Field label="Bill 'Vendor Category' values to read"><input style={{ ...S.input, width: '100%' }} value={field(c.key, 'bill_vendor_categories')} onChange={e => setField(c.key, 'bill_vendor_categories', e.target.value)} /></Field>
              <Field label="Vendor master categories to read"><input style={{ ...S.input, width: '100%' }} value={field(c.key, 'vendor_master_categories')} onChange={e => setField(c.key, 'vendor_master_categories', e.target.value)} /></Field>
              <Field label="Words in the vendor name to read"><input style={{ ...S.input, width: '100%' }} value={field(c.key, 'name_hints')} onChange={e => setField(c.key, 'name_hints', e.target.value)} /></Field>
            </div>
            <div style={{ marginTop: 6 }}>
              {meta.companies.map(co => {
                const list = accounts[co.id]?.accounts?.[c.key] || [];
                return <details key={co.id} style={{ fontSize: '0.76rem' }}><summary>{co.name}: {list.length} account(s) in this category</summary>
                  <div style={{ columns: 2, padding: '4px 0 0 14px' }}>{list.map(a => <div key={a.id}>{a.name}{a.active === false ? <span style={S.small}> (inactive)</span> : null}</div>)}</div></details>;
              })}
            </div>
          </div>
        ))}
        <div style={S.small}>A bill line is in a category when its expense account is one of these accounts or under one of them in Zoho's chart of accounts. The other three rules only decide which bills are worth reading in detail.</div>
      </Section>
    </div>
  );
}
