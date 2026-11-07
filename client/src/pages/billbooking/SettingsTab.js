import React, { useState, useEffect } from 'react';
import { ShieldCheck, FlaskConical, CheckCircle2, XCircle, Circle } from 'lucide-react';
import { bb, errMsg } from './bbApi';
import { S, Field, Msg, dtm, Tag } from './ui';

// ─── Integrations, Zoho checks, companies and tuning ─────────────────────────

const Dot = ({ on, warn }) => (on ? <CheckCircle2 size={14} color="#15803D" /> : warn ? <Circle size={14} color="#B45309" /> : <XCircle size={14} color="#B91C1C" />);

export default function SettingsTab({ meta, reloadMeta }) {
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const [s, setS] = useState(meta.settings);
  const [companies, setCompanies] = useState(meta.companies);
  const [test, setTest] = useState({ company: meta.companies[0]?.id || '', vendor: null, account_id: '' });
  const [vq, setVq] = useState('');
  const [vendors, setVendors] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [audit, setAudit] = useState(null);
  const r = meta.rights;
  const integ = meta.integrations;
  useEffect(() => { setS(meta.settings); setCompanies(meta.companies); }, [meta]);
  useEffect(() => {
    if (!r.admin || !test.company) return;
    bb.lookups(test.company).then(l => setAccounts(l.accounts.filter(a => a.type === 'expense'))).catch(() => setAccounts([]));
  }, [test.company, r.admin]);
  useEffect(() => {
    if (vq.length < 2 || !test.company) { setVendors([]); return undefined; }
    const t = setTimeout(() => bb.vendors(test.company, vq).then(x => setVendors(x.vendors)).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [vq, test.company]);

  async function run(label, fn, msg) {
    setBusy(label); setError(''); setOk('');
    try { const x = await fn(); if (msg) setOk(typeof msg === 'function' ? msg(x) : msg); await reloadMeta(); return x; } catch (e) { setError(errMsg(e)); return null; } finally { setBusy(''); }
  }

  const verifiedAny = Object.values(meta.settings.draft_capability || {}).some(x => x.verified);
  return (
    <div style={{ maxWidth: 1100 }}>
      <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Integrations</span></div>
        <div style={{ ...S.cardBody, fontSize: '0.8rem', lineHeight: 1.7 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Dot on={integ.claude.enabled} warn /><b>Bill reading:</b>&nbsp;{integ.claude.enabled ? `Claude (${integ.claude.model}) reads each bill; the built-in text/OCR reader is the fallback` : 'Built-in text/OCR reader only. Its readings need one confirmation per bill. Add ANTHROPIC_API_KEY on the server so Claude reads bills fully automatically.'}</div>
          {Object.entries(integ.providers).map(([k, p]) => (
            <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Dot on={p.configured} /><b>{p.label}:</b>&nbsp;{p.configured ? 'set up' : 'not set up'}</div>
          ))}
          <div style={{ marginTop: 6, ...S.muted }}>Mailbox sign-in return address (register it in the Microsoft / Google app): <code style={{ background: '#F2F4F5', padding: '1px 5px', borderRadius: 4 }}>{integ.redirect_uri}</code></div>
          <div style={S.small}>App credentials live in the server's .env (office PC) or Vercel environment variables — never on this page. See server/bill-booking/README.md.</div>
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Zoho Books — access and draft bills</span></div>
        <div style={S.cardBody}>
          <div style={S.notice}>
            Zoho's published Bills API has no documented "draft" option (a created bill is normally <b>Open</b>). Zoho support advises sending <code>is_draft: true</code>, which this module does.
            Before any real draft is created, the <b>draft test</b> creates a ₹1 test bill, checks that Zoho kept it as a draft, and deletes it. Draft creation stays locked until the test passes, and it locks again by itself if Zoho ever returns a non-draft bill.
            The module never opens, submits or approves a bill — your team does that in Zoho.
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Company', 'Zoho organisation', 'Access', 'GSTINs found in Zoho', 'Draft bills', ''].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {meta.companies.map(c => {
                const a = meta.settings.zoho_access?.[c.org_id];
                const d = meta.settings.draft_capability?.[c.org_id];
                return (
                  <tr key={c.id}>
                    <td style={S.td}><b>{c.name}</b></td>
                    <td style={S.td}>{c.org_id}</td>
                    <td style={S.td}>
                      {a ? <><div><Dot on={a.read} /> read &nbsp; <Dot on={a.create} /> create bills</div><div style={S.small}>checked {dtm(a.checked_at)}{a.counts?.accounts ? ` · ${a.counts.accounts} accounts, ${a.counts.taxes} taxes, ${a.counts.branches} branches` : ''}</div>
                        {(a.detail || []).filter(x => !/permitted/.test(x)).map((x, i) => <div key={i} style={{ ...S.small, color: '#B91C1C' }}>{x}</div>)}</> : <span style={S.small}>not checked</span>}
                    </td>
                    <td style={S.td}>{a?.gstins?.length ? a.gstins.join(', ') : <span style={S.small}>—</span>}</td>
                    <td style={S.td}>
                      {d ? <><Tag tone={d.verified ? 'green' : 'red'}>{d.verified ? 'Verified' : 'Not available'}</Tag><div style={S.small}>{d.detail}</div><div style={S.small}>{dtm(d.checked_at)} · {d.by}</div></> : <Tag tone="amber">Not tested</Tag>}
                    </td>
                    <td style={S.td}>{r.config && <button style={S.btn} disabled={!!busy} onClick={() => run(`z${c.id}`, () => bb.zohoCheck(c.id), x => `${c.name}: read ${x.read ? 'OK' : 'failed'}, create ${x.create ? 'permitted' : 'not permitted'}`)}><ShieldCheck size={12} /> {busy === `z${c.id}` ? 'Checking…' : 'Check access'}</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {r.admin && (
            <div style={{ marginTop: 14, borderTop: '1px solid #F0F2F1', paddingTop: 12 }}>
              <div style={{ fontWeight: 700, fontSize: '0.84rem', marginBottom: 6 }}><FlaskConical size={13} style={{ verticalAlign: -2 }} /> Draft test (administrator)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1.4fr auto', gap: 10, alignItems: 'end' }}>
                <Field label="Company">
                  <select style={{ ...S.select, width: '100%' }} value={test.company} onChange={e => setTest({ company: e.target.value, vendor: null, account_id: '' })}>
                    {meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </Field>
                <Field label="Vendor for the test bill">
                  {test.vendor ? <div style={{ fontSize: '0.8rem' }}><b>{test.vendor.name}</b> <button style={{ ...S.ghost, padding: '1px 6px' }} onClick={() => setTest({ ...test, vendor: null })}>change</button></div> : <>
                    <input style={{ ...S.input, width: '100%' }} placeholder="Search vendor" value={vq} onChange={e => setVq(e.target.value)} />
                    {vendors.length > 0 && <div style={{ border: '1px solid #DFE7E3', borderRadius: 6, maxHeight: 140, overflow: 'auto', position: 'absolute', background: '#fff', zIndex: 5, width: 300 }}>
                      {vendors.map(v => <div key={v.id} style={{ padding: '4px 8px', fontSize: '0.75rem', cursor: 'pointer' }} onClick={() => { setTest({ ...test, vendor: v }); setVq(''); setVendors([]); }}>{v.name}</div>)}
                    </div>}
                  </>}
                </Field>
                <Field label="Expense account for the test bill">
                  <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} value={test.account_id} onChange={e => setTest({ ...test, account_id: e.target.value })}>
                    <option value="">—</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Field>
                <button style={S.primary} disabled={!!busy || !test.vendor || !test.account_id} onClick={() => {
                  if (window.confirm('This creates a ₹1 test bill in Zoho Books, checks its status and deletes it again. Continue?')) {
                    run('test', () => bb.draftTest({ company: test.company, vendor_id: test.vendor.id, account_id: test.account_id }), x => x.detail);
                  }
                }}>{busy === 'test' ? 'Testing…' : 'Run draft test'}</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.cardTitle}>Companies — GSTINs and PANs</span>
          {r.config && JSON.stringify(companies) !== JSON.stringify(meta.companies) && <button style={S.primary} disabled={!!busy} onClick={() => run('co', () => bb.saveCompanies(companies), 'Companies saved')}>Save</button>}
        </div>
        <div style={S.cardBody}>
          <div style={{ ...S.muted, marginBottom: 8 }}>The billed-to GSTIN on a bill decides its company. GSTINs found in Zoho (Check access) are used automatically; add any others here.</div>
          {companies.map((c, i) => (
            <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '220px 1fr 1fr 1fr', gap: 10, marginBottom: 8, alignItems: 'end' }}>
              <div style={{ fontWeight: 600, fontSize: '0.82rem' }}>{c.name}<div style={S.small}>{c.org_id}</div></div>
              <Field label="GSTINs"><input style={{ ...S.input, width: '100%' }} disabled={!r.config} value={(c.gstins || []).join(', ')} onChange={e => setCompanies(companies.map((x, j) => (j === i ? { ...x, gstins: e.target.value.split(',').map(t => t.trim().toUpperCase()) } : x)))} /></Field>
              <Field label="PANs"><input style={{ ...S.input, width: '100%' }} disabled={!r.config} value={(c.pans || []).join(', ')} onChange={e => setCompanies(companies.map((x, j) => (j === i ? { ...x, pans: e.target.value.split(',').map(t => t.trim().toUpperCase()) } : x)))} /></Field>
              <Field label="Names on bills"><input style={{ ...S.input, width: '100%' }} disabled={!r.config} value={(c.name_hints || []).join(', ')} onChange={e => setCompanies(companies.map((x, j) => (j === i ? { ...x, name_hints: e.target.value.split(',').map(t => t.trimStart()) } : x)))} /></Field>
            </div>
          ))}
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.cardTitle}>Processing settings</span>
          {r.config && JSON.stringify(s) !== JSON.stringify(meta.settings) && <button style={S.primary} disabled={!!busy} onClick={() => run('s', () => bb.saveSettings(s), 'Settings saved')}>Save</button>}
        </div>
        <div style={{ ...S.cardBody, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <Field label="Create Zoho drafts automatically">
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem' }}>
              <input type="checkbox" disabled={!r.config || (!verifiedAny && !s.auto_create_drafts)} checked={!!s.auto_create_drafts} onChange={e => setS({ ...s, auto_create_drafts: e.target.checked })} />
              When a bill is Ready for Draft
            </label>
            {!verifiedAny && <div style={S.small}>Available once the draft test has passed.</div>}
          </Field>
          <Field label="History window (days)"><input type="number" style={{ ...S.input, width: '100%' }} disabled={!r.config} value={s.history_days} onChange={e => setS({ ...s, history_days: e.target.value })} /><div style={S.small}>Vendor's earlier bills compared for the account (3–4 months = 90–120)</div></Field>
          <Field label="Earlier bills compared (max)"><input type="number" style={{ ...S.input, width: '100%' }} disabled={!r.config} value={s.history_max_bills} onChange={e => setS({ ...s, history_max_bills: e.target.value })} /><div style={S.small}>Each uses one Zoho API call the first time</div></Field>
          <Field label="Line similarity needed (0.2–0.95)"><input type="number" step="0.05" style={{ ...S.input, width: '100%' }} disabled={!r.config} value={s.similarity_threshold} onChange={e => setS({ ...s, similarity_threshold: e.target.value })} /><div style={S.small}>Higher = stricter account matching</div></Field>
          <Field label="Category score needed"><input type="number" style={{ ...S.input, width: '100%' }} disabled={!r.config} value={s.category_min_score} onChange={e => setS({ ...s, category_min_score: e.target.value })} /></Field>
          <Field label="Check mailboxes every (minutes)"><input type="number" style={{ ...S.input, width: '100%' }} disabled={!r.config} value={s.poll_minutes} onChange={e => setS({ ...s, poll_minutes: e.target.value })} /></Field>
          <Field label="Which attachments to read">
            <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={!r.config} value={s.mail_scope} onChange={e => setS({ ...s, mail_scope: e.target.value })}>
              <option value="likely_bills">Bill-like emails and known vendors (others listed as skipped)</option>
              <option value="all_attachments">Every PDF / image attachment</option>
            </select>
          </Field>
          <Field label="First check reaches back (days)"><input type="number" style={{ ...S.input, width: '100%' }} disabled={!r.config} value={s.mail_lookback_days} onChange={e => setS({ ...s, mail_lookback_days: e.target.value })} /></Field>
        </div>
      </div>

      {r.config && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Set-up audit trail</span><button style={S.ghost} onClick={() => bb.audit().then(setAudit).catch(e => setError(errMsg(e)))}>Show this month</button></div>
          {audit && <div style={{ ...S.cardBody, maxHeight: 300, overflow: 'auto' }}>
            {!audit.entries.length && <div style={S.muted}>Nothing this month.</div>}
            {audit.entries.map((a, i) => <div key={i} style={{ fontSize: '0.75rem', borderBottom: '1px solid #F2F2F2', padding: '3px 0' }}><span style={S.small}>{dtm(a.at)}</span> · <b>{a.by}</b> · {a.action.replace(/_/g, ' ')} — {a.detail}</div>)}
          </div>}
        </div>
      )}
    </div>
  );
}
