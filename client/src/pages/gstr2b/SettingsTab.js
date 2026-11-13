import React, { useEffect, useState } from 'react';
import { g, errMsg } from './gApi';
import { S, Tag, Field, Msg, Modal, dt, dtm } from './ui';

const SECTIONS = [['companies', 'Companies & GSTINs'], ['matching', 'Matching & tolerances'], ['schedule', 'Schedule & sync limits'], ['access', 'Access'], ['coverage', 'Coverage'], ['rules', 'Rules & sources'], ['audit', 'Audit trail'], ['demo', 'Demo data']];

export default function SettingsTab({ meta, reloadMeta }) {
  const [sec, setSec] = useState(() => { try { return sessionStorage.getItem('g2b_settings') || 'companies'; } catch (_) { return 'companies'; } });
  const go = id => { setSec(id); try { sessionStorage.setItem('g2b_settings', id); } catch (_) { /* optional */ } };
  const cfg = meta.rights.config;
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {SECTIONS.map(([id, label]) => <button key={id} style={{ ...(sec === id ? S.primary : S.ghost) }} onClick={() => go(id)}>{label}</button>)}
      </div>
      {!cfg && ['companies', 'matching', 'schedule', 'access', 'audit', 'demo'].includes(sec) && <div style={S.info}>You can look at these settings; changing them needs the "Configure" right.</div>}
      {sec === 'companies' && <Companies meta={meta} reloadMeta={reloadMeta} />}
      {sec === 'matching' && <Matching meta={meta} reloadMeta={reloadMeta} />}
      {sec === 'schedule' && <Schedule meta={meta} reloadMeta={reloadMeta} />}
      {sec === 'access' && <Access meta={meta} reloadMeta={reloadMeta} />}
      {sec === 'coverage' && <Coverage meta={meta} />}
      {sec === 'rules' && <Rules meta={meta} />}
      {sec === 'audit' && cfg && <Audit />}
      {sec === 'audit' && !cfg && <div style={S.info}>The audit trail needs the "Configure" right.</div>}
      {sec === 'demo' && <Demo meta={meta} reloadMeta={reloadMeta} />}
    </div>
  );
}

// ── Companies, GSTINs and branches (onboarding) ──────────────────────────────
function Companies({ meta, reloadMeta }) {
  const canEdit = meta.rights.config;
  const fys = (() => { const t = new Date(Date.now() + 330 * 60000); const y = t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1; return [y - 1, y].map(s => `${s}-${String(s + 1).slice(2)}`); })();
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(meta.companies.filter(c => !c.demo))));
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [warn, setWarn] = useState([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [check, setCheck] = useState(null);
  useEffect(() => { setDraft(JSON.parse(JSON.stringify(meta.companies.filter(c => !c.demo)))); }, [meta.companies]);
  const upd = (i, patch) => setDraft(d => d.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const updReg = (i, j, patch) => setDraft(d => d.map((c, k) => (k === i ? { ...c, registrations: c.registrations.map((r, m) => (m === j ? { ...r, ...patch } : r)) } : c)));
  const save = async list => {
    setBusy(true); setError(''); setOk(''); setWarn([]);
    try { const r = await g.saveCompanies(list); setWarn(r.warnings || []); setOk('Saved. Each GSTIN was checked against the organisation\'s branches in Zoho (read-only).'); reloadMeta(); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <div>
      <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />
      {warn.map((w, i) => <div key={i} style={S.notice}>{w}</div>)}
      <div style={S.info}>A company is one Zoho Books organisation. Its recipient GSTINs come from the branches in Zoho (each branch carries its GSTIN). Reconciliation never mixes GSTINs or companies; PAN-level grouping is only used to investigate. Nothing here is pre-filled — organisation ids, GSTINs and branches are read from Zoho and confirmed by you.</div>
      {draft.length === 0 && <div style={S.notice}>No company is set up yet. Use "Add a company" below.</div>}
      {draft.map((c, i) => (
        <div key={c.id} style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>{c.name} <span style={S.small}>· Zoho organisation {c.org_id}</span></span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{!c.active && <Tag tone="amber">Switched off</Tag>}
              <button style={S.ghost} disabled={busy} onClick={async () => { setCheck(null); try { setCheck({ company: c.name, ...(await g.check(c.id)) }); } catch (e) { setError(errMsg(e)); } }}>Check Zoho access</button></span></div>
          <div style={S.cardBody}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
              <Field label="Name"><input style={{ ...S.input, width: '100%' }} disabled={!canEdit} value={c.name} onChange={e => upd(i, { name: e.target.value })} /></Field>
              <Field label="Short name"><input style={{ ...S.input, width: '100%' }} disabled={!canEdit} value={c.short} onChange={e => upd(i, { short: e.target.value })} /></Field>
              <Field label="Supplier invoice date field in Zoho bills" hint="API name of the custom field (e.g. cf_vendor_bill_date). Empty = the posting date is used and marked assumed."><input style={{ ...S.input, width: '100%' }} disabled={!canEdit} value={c.invoice_date_field} onChange={e => upd(i, { invoice_date_field: e.target.value })} /></Field>
              <Field label="Credit-note number is taken from" hint="Zoho's own number or the supplier's reference"><select style={{ ...S.select, width: '100%' }} disabled={!canEdit} value={c.credit_number_field} onChange={e => upd(i, { credit_number_field: e.target.value })}><option value="vendor_credit_number">Credit Note # (vendor_credit_number)</option><option value="reference_number">Reference # (reference_number)</option></select></Field>
              <Field label="Credit-note date field (optional)" hint="Custom field with the supplier's note date"><input style={{ ...S.input, width: '100%' }} disabled={!canEdit} value={c.credit_date_field} onChange={e => upd(i, { credit_date_field: e.target.value })} /></Field>
              <Field label="Reconcile this company"><label style={{ fontSize: '0.8rem', display: 'flex', gap: 6 }}><input type="checkbox" disabled={!canEdit} checked={c.active} onChange={e => upd(i, { active: e.target.checked })} /> Active (synced and reconciled)</label></Field>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
              <thead><tr><th style={S.th}>Recipient GSTIN</th><th style={S.th}>Label</th><th style={S.th}>Branches in Zoho</th><th style={S.th}>Verified</th><th style={S.th} title="Switched on: this GSTIN is reconciled and its Books amounts are read from Zoho at each sync. Switch off the GSTINs you are not reconciling yet — the sync reads one Zoho call per document, so fewer GSTINs is much faster. A GSTIN switched on again is read at the next sync.">Active</th>{fys.map(f => <th key={f} style={S.th} title="Once the annual return for the year is filed, ITC on that year's invoices can no longer be claimed after that date (Section 16(4))">GSTR-9 filed — {f}</th>)}</tr></thead>
              <tbody>{c.registrations.map((r, j) => (
                <tr key={r.gstin}>
                  <td style={{ ...S.td, fontWeight: 600 }}>{r.gstin}</td>
                  <td style={S.td}><input style={{ ...S.input, width: 150 }} disabled={!canEdit} value={r.label || ''} onChange={e => updReg(i, j, { label: e.target.value })} /></td>
                  <td style={S.td}>{(r.branch_ids || []).length}</td>
                  <td style={S.td}>{r.verified ? <Tag tone="green" title={(r.verified.branch_names || []).join(', ')}>Verified in Zoho {dt((r.verified.at || '').slice(0, 10))}</Tag> : <Tag tone="red" title="This GSTIN was not found on a Zoho branch">Not verified</Tag>}</td>
                  <td style={S.td}><input type="checkbox" disabled={!canEdit} checked={r.active !== false} onChange={e => updReg(i, j, { active: e.target.checked })} /></td>
                  {fys.map(f => <td key={f} style={S.td}><input type="date" style={S.input} disabled={!canEdit} value={(r.gstr9_filed || {})[f] || ''} onChange={e => updReg(i, j, { gstr9_filed: { ...(r.gstr9_filed || {}), [f]: e.target.value } })} /></td>)}
                </tr>))}</tbody>
            </table>
            {canEdit && <div style={{ marginTop: 10 }}><button style={S.primary} disabled={busy} onClick={() => save(draft)}>{busy ? 'Saving…' : 'Save and verify against Zoho'}</button></div>}
          </div>
        </div>
      ))}
      {check && (
        <Modal title={`Zoho access check — ${check.company}`} onClose={() => setCheck(null)}>
          <p style={{ ...S.muted, marginTop: 0 }}>Credentials in use: {check.credentials}. This module only reads; it has no way to write to Zoho.</p>
          {check.results.map(x => <div key={x.label} style={{ padding: '3px 0', fontSize: '0.82rem' }}>{x.ok ? '✅' : '❌'} {x.label}{x.message ? ` — ${x.message}` : ''}</div>)}
          <p style={{ ...S.small, marginTop: 10 }}>For least privilege, create a separate Zoho refresh token with only read scopes ({check.scopes_for_dedicated_token.join(', ')}) and put it in GSTR2B_ZOHO_REFRESH_TOKEN (and, if different from the app's, GSTR2B_ZOHO_CLIENT_ID / GSTR2B_ZOHO_CLIENT_SECRET).</p>
        </Modal>
      )}
      {canEdit && (adding ? <AddCompany meta={meta} existing={draft} onCancel={() => setAdding(false)} onSave={async c => { await save([...draft, c]); setAdding(false); }} /> : <button style={S.btn} onClick={() => setAdding(true)}>+ Add a company</button>)}
    </div>
  );
}

function AddCompany({ meta, existing, onCancel, onSave }) {
  const [orgs, setOrgs] = useState(null);
  const [org, setOrg] = useState('');
  const [br, setBr] = useState(null);
  const [pick, setPick] = useState({});
  const [f, setF] = useState({ id: '', name: '', short: '', invoice_date_field: 'cf_vendor_bill_date', credit_number_field: 'vendor_credit_number', credit_date_field: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const find = async () => { setBusy(true); setError(''); try { setOrgs((await g.zohoOrgs()).organizations); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); } };
  const read = async () => {
    setBusy(true); setError(''); setBr(null);
    try {
      const r = await g.branches(org); setBr(r);
      setPick(Object.fromEntries(r.registrations.filter(x => x.valid).map(x => [x.gstin, true])));
      const o = (orgs || []).find(x => x.id === org);
      if (o && !f.name) setF(x => ({ ...x, name: o.name, short: o.name.split(' ')[0].slice(0, 12), id: o.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) }));
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const chosen = br ? br.registrations.filter(x => pick[x.gstin]) : [];
  return (
    <div style={S.card}>
      <div style={S.cardHead}><span style={S.cardTitle}>Add a company — read from Zoho, confirm, save</span><button style={S.ghost} onClick={onCancel}>Cancel</button></div>
      <div style={S.cardBody}>
        <Msg error={error} />
        <div style={S.label}>Step 1 — the Zoho organisation</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <button style={S.btn} disabled={busy} onClick={find}>Find the organisations this Zoho login can read</button>
          {orgs && <select style={S.select} value={org} onChange={e => setOrg(e.target.value)}><option value="">Choose…</option>{orgs.map(o => <option key={o.id} value={o.id} disabled={o.configured || existing.some(c => c.org_id === o.id)}>{o.name} ({o.id}){o.configured ? ' — already set up' : ''}{o.gst_registered ? '' : ' — not GST-registered'}</option>)}</select>}
          <Field label="…or type the organisation id"><input style={{ ...S.input, width: 180 }} value={org} onChange={e => setOrg(e.target.value.replace(/\D/g, ''))} placeholder="digits only" /></Field>
          <button style={S.primary} disabled={busy || !org} onClick={read}>Read its branches and GSTINs</button>
        </div>
        {br && (
          <>
            <div style={S.label}>Step 2 — confirm the recipient GSTINs ({br.branches} branches in Zoho)</div>
            {br.registrations.map(r => (
              <div key={r.gstin} style={{ border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.55rem 0.8rem', marginBottom: 6, background: pick[r.gstin] ? '#F0F7F4' : '#fff' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.84rem', fontWeight: 600 }}><input type="checkbox" checked={!!pick[r.gstin]} disabled={!r.valid} onChange={e => setPick({ ...pick, [r.gstin]: e.target.checked })} /> {r.gstin} <span style={S.muted}>{r.label} · PAN {r.pan}</span></label>
                {r.checks.map((c, i) => <div key={i} style={{ fontSize: '0.76rem', color: c.ok ? '#15803D' : '#B91C1C', marginLeft: 24 }}>{c.ok ? '✓' : '✗'} {c.text}</div>)}
                <div style={{ ...S.small, marginLeft: 24 }}>Branches: {r.branches.map(b => `${b.name}${b.active ? '' : ' (inactive)'}`).join(', ')}</div>
              </div>))}
            {br.unmapped.length > 0 && <div style={S.notice}>{br.unmapped.length} branch(es) have no GSTIN in Zoho, so their documents cannot be reconciled until a GSTIN is entered there: {br.unmapped.map(b => b.name).join(', ')}.</div>}
            <div style={{ ...S.label, marginTop: 12 }}>Step 3 — name it and save</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
              <Field label="Company name"><input style={{ ...S.input, width: '100%' }} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="Short name"><input style={{ ...S.input, width: '100%' }} value={f.short} onChange={e => setF({ ...f, short: e.target.value })} /></Field>
              <Field label="Id (letters / digits)" hint="used inside the module; cannot be changed later"><input style={{ ...S.input, width: '100%' }} value={f.id} onChange={e => setF({ ...f, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} /></Field>
              <Field label="Supplier invoice date field" hint="custom field api name in Zoho bills"><input style={{ ...S.input, width: '100%' }} value={f.invoice_date_field} onChange={e => setF({ ...f, invoice_date_field: e.target.value })} /></Field>
              <Field label="Credit-note number from"><select style={{ ...S.select, width: '100%' }} value={f.credit_number_field} onChange={e => setF({ ...f, credit_number_field: e.target.value })}><option value="vendor_credit_number">Credit Note #</option><option value="reference_number">Reference #</option></select></Field>
            </div>
            <button style={{ ...S.primary, marginTop: 10 }} disabled={busy || !f.id || !f.name || !chosen.length}
              onClick={async () => { setBusy(true); try { await onSave({ ...f, org_id: org, active: true, registrations: chosen.map(r => ({ gstin: r.gstin, label: r.label, branch_ids: r.branch_ids, active: true, gstr9_filed: {} })) }); } finally { setBusy(false); } }}>Save company</button>
          </>)}
      </div>
    </div>
  );
}

// ── Matching settings ────────────────────────────────────────────────────────
function Matching({ meta, reloadMeta }) {
  const s = meta.settings, canEdit = meta.rights.config;
  const [f, setF] = useState(() => ({ ...s, tol: Object.fromEntries(Object.entries(s.tol_p).map(([k, v]) => [k, v / 100])) }));
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const N = (k, label, hint, min = 0, max = 31) => <Field label={label} hint={hint}><input type="number" min={min} max={max} style={{ ...S.input, width: 110 }} disabled={!canEdit} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /></Field>;
  const save = async () => {
    setBusy(true); setError(''); setOk('');
    try {
      await g.saveSettings({ ...f, tol_p: Object.fromEntries(Object.entries(f.tol).map(([k, v]) => [k, Math.round(Number(v) * 100)])) });
      setOk('Saved. The next reconciliation run recomputes every supplier group with the new settings.');
      reloadMeta();
      for (const c of meta.companies.filter(x => x.registrations.length)) g.reconRun({ company: c.id }).catch(() => {});
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div style={S.card}>
      <div style={S.cardHead}><span style={S.cardTitle}>Matching rules and tolerances</span><span style={S.small}>Changes are recorded in the audit trail</span></div>
      <div style={S.cardBody}>
        <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />
        <div style={S.label}>Rounding tolerance per component (₹) — each component is checked on its own; a difference in one is never offset against another</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {[['taxable', 'Taxable value'], ['igst', 'IGST'], ['cgst', 'CGST'], ['sgst', 'SGST / UTGST'], ['cess', 'Cess']].map(([k, n]) => <Field key={k} label={n}><input type="number" step="0.01" min="0" max="100" style={{ ...S.input, width: 100 }} disabled={!canEdit} value={f.tol[k]} onChange={e => setF({ ...f, tol: { ...f.tol, [k]: e.target.value } })} /></Field>)}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {N('date_window_days', 'Suggestion date window (days)', 'how far apart two dates may be for a suggestion')}
          {N('fuzzy_edit_distance', 'Characters that may differ in a number', 'for suggestions only', 0, 3)}
          {N('normal_gap_months', 'Normal reporting gap (months)', 'later than this = late reporting', 0, 3)}
          {N('closing_soon_days', '"Closing soon" days', 'ITC deadline warning', 1, 180)}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, alignItems: 'flex-end' }}>
          <Field label="Split / consolidated invoices"><label style={{ fontSize: '0.8rem', display: 'flex', gap: 6 }}><input type="checkbox" disabled={!canEdit} checked={!!f.group_enabled} onChange={e => setF({ ...f, group_enabled: e.target.checked })} /> Suggest grouped matches</label></Field>
          {N('group_max', 'Largest group', 'documents on the many side', 2, 6)}
          {N('group_date_window_days', 'Group date window (days)', '', 0, 31)}
          <Field label="Default period basis"><select style={S.select} disabled={!canEdit} value={f.period_basis} onChange={e => setF({ ...f, period_basis: e.target.value })}>{Object.entries(meta.period_bases).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        </div>
        <div style={{ ...S.muted, marginTop: 12, lineHeight: 1.6 }}>
          <b>What the rules never do:</b> match on vendor name, PAN or similar amounts alone; match across different recipient GSTINs or companies; match automatically when more than one candidate fits; treat IGST and CGST+SGST as interchangeable; strip leading zeros from invoice numbers automatically (that is only ever a suggestion).
        </div>
        {canEdit && <button style={{ ...S.primary, marginTop: 12 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save and re-run'}</button>}
      </div>
    </div>
  );
}

// ── Schedule and sync limits ─────────────────────────────────────────────────
function Schedule({ meta, reloadMeta }) {
  const canEdit = meta.rights.config;
  const [sch, setSch] = useState({ enabled: meta.schedule.enabled, times: meta.schedule.times.join(', ') });
  const [lim, setLim] = useState({ ...meta.sync });
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const save = async () => {
    setError(''); setOk('');
    try {
      await g.saveSchedule({ enabled: sch.enabled, times: sch.times.split(/[,\s]+/).filter(Boolean) });
      await g.saveSync({ rate_per_min: +lim.rate_per_min, concurrency: +lim.concurrency, daily_budget: +lim.daily_budget, zoho_reserve: +lim.zoho_reserve, slice_seconds: +lim.slice_seconds });
      setOk('Saved. The schedule takes effect at the next scheduled time.'); reloadMeta();
    } catch (e) { setError(errMsg(e)); }
  };
  return (
    <div style={S.card}>
      <div style={S.cardHead}><span style={S.cardTitle}>Scheduled Zoho sync (this module only)</span></div>
      <div style={S.cardBody}>
        <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />
        {!meta.integrations.scheduler && <div style={S.info}>Online, the automatic sync is run by the dashboard's scheduler: every {meta.online_schedule.every_min} minutes round the clock (at {meta.online_schedule.minutes.map(m => `:${String(m).padStart(2, '0')}`).join(', ')} past each hour) it reads what was added or edited in Zoho since the last check, and at {meta.online_schedule.recheck_ist} India time it compares everything with Zoho. These times are set in the dashboard's deployment, not here; the times below apply to the office PC copy only. Imports &amp; sync shows when the scheduler last called in.</div>}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Scheduled sync"><label style={{ fontSize: '0.8rem', display: 'flex', gap: 6 }}><input type="checkbox" disabled={!canEdit} checked={sch.enabled} onChange={e => setSch({ ...sch, enabled: e.target.checked })} /> On</label></Field>
          <Field label="Times (India time, 24-hour)" hint="Default 13:20, 15:20, 18:20, 21:20 — the hours asked for (1, 3, 6, 9 PM), 20 minutes after the hour so it never competes with the dashboard's own sync at :00 / :10"><input style={{ ...S.input, width: 300 }} disabled={!canEdit} value={sch.times} onChange={e => setSch({ ...sch, times: e.target.value })} /></Field>
        </div>
        <p style={{ ...S.muted, lineHeight: 1.5 }}>Each scheduled run reads what changed in Zoho since the last one, then fetches amounts for new and edited documents. The first run of each day also re-checks the period for deleted documents. The shared sync schedule of the other modules is not touched.</p>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
          <Field label="Zoho calls per minute" hint="10–120 · a higher number is faster. Zoho allows this organisation's user 150 a minute, shared with the dashboard's other modules"><input type="number" style={{ ...S.input, width: 120 }} disabled={!canEdit} value={lim.rate_per_min} onChange={e => setLim({ ...lim, rate_per_min: e.target.value })} /></Field>
          <Field label="Calls at the same time" hint="1–6 · Zoho allows 20"><input type="number" style={{ ...S.input, width: 120 }} disabled={!canEdit} value={lim.concurrency} onChange={e => setLim({ ...lim, concurrency: e.target.value })} /></Field>
          <Field label="Zoho calls per day for this module" hint="100–80000 · a first sync of a financial year needs about 8,000"><input type="number" style={{ ...S.input, width: 120 }} disabled={!canEdit} value={lim.daily_budget} onChange={e => setLim({ ...lim, daily_budget: e.target.value })} /></Field>
          <Field label="Calls kept free for other integrations" hint="0–60000 · the sync stops for the day when Zoho reports that the whole organisation has this few calls left"><input type="number" style={{ ...S.input, width: 120 }} disabled={!canEdit} value={lim.zoho_reserve} onChange={e => setLim({ ...lim, zoho_reserve: e.target.value })} /></Field>
          <Field label="Seconds per sync step (online)" hint="30–250; online a sync runs in steps of this length (never more than 180)"><input type="number" style={{ ...S.input, width: 120 }} disabled={!canEdit} value={lim.slice_seconds} onChange={e => setLim({ ...lim, slice_seconds: e.target.value })} /></Field>
        </div>
        <p style={{ ...S.muted, lineHeight: 1.5 }}>Zoho counts every integration of the organisation against one daily allowance (90,000 calls on the current plan, starting again at midnight India time). This module reads Zoho's own count after every call: it never uses more than its own daily number above, and it also stops for the day if the organisation's remaining allowance falls to the number kept free — so the other integrations cannot be starved by a long sync. If Zoho answers "too many requests", the sync waits as long as Zoho asks and then carries on.</p>
        {canEdit && <button style={{ ...S.primary, marginTop: 12 }} onClick={save}>Save</button>}
      </div>
    </div>
  );
}

// ── Access ───────────────────────────────────────────────────────────────────
function Access({ meta, reloadMeta }) {
  const [acc, setAcc] = useState(() => JSON.parse(JSON.stringify(meta.access || {})));
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  if (!meta.rights.admin) return <div style={S.info}>Limiting a user to particular companies or GSTINs is set by an administrator. Rights themselves (Prepare, Review, Approve / lock, Configure) are ticked per user in User Settings.</div>;
  const users = (meta.admin_users || []).filter(u => u.role !== 'admin');
  const all = meta.companies.flatMap(c => c.registrations.map(r => ({ company: c.id, name: c.short || c.name, gstin: r.gstin })));
  const toggle = (uid, field, val) => setAcc(a => { const cur = (a[uid] || {})[field] || []; const next = cur.includes(val) ? cur.filter(x => x !== val) : [...cur, val]; return { ...a, [uid]: { ...(a[uid] || {}), [field]: next } }; });
  const save = async () => { setError(''); setOk(''); try { await g.saveAccess(Object.fromEntries(Object.entries(acc).filter(([, v]) => (v.companies || []).length || (v.gstins || []).length))); setOk('Saved.'); reloadMeta(); } catch (e) { setError(errMsg(e)); } };
  return (
    <div style={S.card}>
      <div style={S.cardHead}><span style={S.cardTitle}>Limit users to companies and GSTINs</span><span style={S.small}>Nothing ticked = no limit (everything their rights allow)</span></div>
      <div style={S.cardBody}>
        <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />
        <p style={{ ...S.muted, marginTop: 0 }}>Rights (Prepare, Review, Approve / lock, Configure) are ticked per user in <b>User Settings → GSTR-2B Reco</b>; the module itself is hidden from anyone it is not ticked for. Roles: <b>preparer</b> = Prepare · <b>reviewer</b> = Prepare + Review · <b>CFO / admin</b> = all rights · <b>read-only</b> = module ticked, no rights.</p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={S.th}>User</th><th style={S.th}>Companies</th><th style={S.th}>GSTINs</th></tr></thead>
          <tbody>{users.map(u => (
            <tr key={u.id}><td style={{ ...S.td, fontWeight: 600 }}>{u.name}</td>
              <td style={S.td}>{meta.companies.map(c => <label key={c.id} style={{ fontSize: '0.76rem', marginRight: 10, whiteSpace: 'nowrap' }}><input type="checkbox" checked={((acc[u.id] || {}).companies || []).includes(c.id)} onChange={() => toggle(u.id, 'companies', c.id)} /> {c.short || c.name}</label>)}</td>
              <td style={S.td}>{all.map(r => <label key={r.gstin} style={{ fontSize: '0.74rem', marginRight: 10, whiteSpace: 'nowrap' }}><input type="checkbox" checked={((acc[u.id] || {}).gstins || []).includes(r.gstin)} onChange={() => toggle(u.id, 'gstins', r.gstin)} /> {r.gstin}</label>)}</td></tr>))}
            {users.length === 0 && <tr><td colSpan={3} style={{ ...S.td, color: '#9BA8B0' }}>No non-admin users.</td></tr>}</tbody>
        </table>
        <button style={{ ...S.primary, marginTop: 12 }} onClick={save}>Save access limits</button>
      </div>
    </div>
  );
}

// ── Coverage ─────────────────────────────────────────────────────────────────
function Coverage({ meta }) {
  const [company, setCompany] = useState((meta.companies.find(c => !c.demo) || meta.companies[0] || {}).id || '');
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { if (company) g.coverage(company).then(setD).catch(e => setError(errMsg(e))); }, [company]);
  const TONE = { included: 'green', excluded: 'grey', 'needs convention': 'amber', 'supplemental import': 'amber', 'imported, not matched': 'amber' };
  return (
    <div>
      <Msg error={error} />
      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Which transaction types are in the reconciliation</span><span style={S.small}>Prevents double counting: bills, vendor credits and expenses are separate Zoho records and each appears once</span></div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={S.th}>Source</th><th style={S.th}>Status</th><th style={S.th}>How it is handled</th></tr></thead>
          <tbody>{meta.coverage_matrix.map(m => <tr key={m.source}><td style={{ ...S.td, fontWeight: 600, minWidth: 280 }}>{m.source}</td><td style={S.td}><Tag tone={TONE[m.status] || 'grey'}>{m.status}</Tag></td><td style={{ ...S.td, lineHeight: 1.5 }}>{m.how}</td></tr>)}</tbody>
        </table>
      </div>
      {meta.companies.length > 1 && <div style={{ marginBottom: 8 }}><select style={S.select} value={company} onChange={e => { setD(null); setCompany(e.target.value); }}>{meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
      {d && d.documents && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>{d.company.name} — documents read from Zoho</span></div>
          <div style={S.cardBody}>
            {d.attention.map((a, i) => <div key={i} style={S.notice}>{a}</div>)}
            <div style={{ fontSize: '0.82rem', lineHeight: 1.7 }}>
              {d.documents.total} documents ({Object.entries(d.documents.by_kind).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ')}) · {d.documents.in_scope} can be matched · {d.documents.detailed} have amounts · {d.documents.waiting_for_details} waiting for amounts · {d.documents.edited_not_refreshed} edited in Zoho and not yet refreshed{d.documents.failing ? ` · ${d.documents.failing} failing` : ''}
            </div>
            <div style={{ ...S.muted, marginTop: 4 }}>Excluded: {Object.entries(d.documents.excluded).map(([k, n]) => `${k.replace(/_/g, ' ')}: ${n}`).join(' · ') || 'none'}</div>
            <div style={{ ...S.label, marginTop: 12 }}>Branches in Zoho and their GSTINs {d.branches_at ? `(read ${dtm(d.branches_at)})` : ''}</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={S.th}>Branch</th><th style={S.th}>State</th><th style={S.th}>GSTIN</th><th style={S.th}>Set up here?</th></tr></thead>
              <tbody>{d.branches.map(b => <tr key={b.id}><td style={S.td}>{b.name}{!b.active && <span style={S.small}> (inactive)</span>}</td><td style={S.td}>{b.state}</td><td style={S.td}>{b.gstin || <Tag tone="red">no GSTIN</Tag>}</td><td style={S.td}>{b.configured ? <Tag tone="green">Yes</Tag> : b.gstin ? <Tag tone="amber">No — add in Companies</Tag> : '—'}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Rules ────────────────────────────────────────────────────────────────────
function Rules({ meta }) {
  return (
    <div>
      <div style={S.info}>The statutory rules this module relies on are kept as dated data with their official source, verified {meta.rules.as_of}. Phase 1 uses only the Section 16(4) claim deadline; the others are for the Phase 2 ITC register. Not legal advice — confirm with your tax advisor.</div>
      {meta.rules.sections.map(r => (
        <div key={r.id} style={S.card}><div style={S.cardHead}><span style={S.cardTitle}>{r.title}</span><span style={S.small}>in force from {dt(r.effective_from)} · {r.used_in}</span></div>
          <div style={S.cardBody}><p style={{ margin: '0 0 6px', fontSize: '0.82rem', lineHeight: 1.6 }}>{r.text}</p>{r.note && <p style={{ ...S.muted, margin: '0 0 6px' }}>{r.note}</p>}<div style={S.small}>Source: {r.source}</div></div></div>))}
      {meta.rules.pending.map(p => <div key={p.id} style={S.notice}><b>{p.title}</b> — {p.status}. {p.detail} <span style={S.small}>({p.source})</span></div>)}
    </div>
  );
}

// ── Audit trail ──────────────────────────────────────────────────────────────
function Audit() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [d, setD] = useState(null);
  const [v, setV] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { setD(null); g.audit(month).then(setD).catch(e => setError(errMsg(e))); }, [month]);
  return (
    <div style={S.card}>
      <div style={S.cardHead}><span style={S.cardTitle}>Audit trail</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="month" style={S.input} value={month} onChange={e => setMonth(e.target.value)} /><button style={S.btn} onClick={async () => setV(await g.auditVerify().catch(e => ({ ok: false, reason: errMsg(e) })))}>Verify the chain</button></span></div>
      <div style={S.cardBody}>
        <Msg error={error} />
        {v && (v.ok ? <div style={S.ok}>The audit chain is intact ({v.checked} entries checked): no entry has been changed or removed.</div> : <div style={S.error}>The chain is broken at entry #{v.at_seq}: {v.reason}.</div>)}
        <p style={{ ...S.muted, marginTop: 0 }}>Imports, syncs, configuration and rule changes, matches, links, approvals, exclusions, assignments and exports are recorded here; each entry carries a fingerprint of the one before it, so a changed or deleted entry is detectable.</p>
        {!d ? <div style={S.center}>Loading…</div> : (
          <div style={{ overflowX: 'auto', maxHeight: '60vh' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th}>#</th><th style={S.th}>When</th><th style={S.th}>Who</th><th style={S.th}>Action</th><th style={S.th}>GSTIN</th><th style={S.th}>Detail</th></tr></thead>
            <tbody>{d.entries.length === 0 && <tr><td colSpan={6} style={{ ...S.td, textAlign: 'center', color: '#9BA8B0' }}>Nothing recorded in this month.</td></tr>}
              {d.entries.map(e => <tr key={e.seq}><td style={S.td}>{e.seq}</td><td style={{ ...S.td, whiteSpace: 'nowrap' }}>{dtm(e.at)}</td><td style={S.td}>{e.by}</td><td style={S.td}>{e.action}</td><td style={S.td}>{e.gstin}</td><td style={{ ...S.td, ...S.muted }}>{e.detail}</td></tr>)}</tbody>
          </table></div>)}
      </div>
    </div>
  );
}

// ── Demo ─────────────────────────────────────────────────────────────────────
function Demo({ meta, reloadMeta }) {
  const has = meta.companies.some(c => c.demo);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  if (!meta.rights.admin) return <div style={S.info}>Demo data is managed by an administrator.</div>;
  const run = async fn => { setBusy(true); setError(''); setMsg(''); try { await fn(); reloadMeta(); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); } };
  return (
    <div style={S.card}>
      <div style={S.cardHead}><span style={S.cardTitle}>Demo data</span>{has ? <Tag tone="violet">Loaded</Tag> : <Tag>Not loaded</Tag>}</div>
      <div style={S.cardBody}>
        <Msg error={error} ok={msg} />
        <p style={{ ...S.muted, marginTop: 0, lineHeight: 1.6 }}>Creates a separate company called <b>Demo Company (synthetic)</b> with made-up suppliers, bills and GSTR-2B statements that show every situation the reconciliation handles (exact and rounded matches, mismatches, missing invoices, wrong GSTIN, duplicates, split and consolidated invoices, credit notes, amendments, late reporting across years, ISD and import records, and invoices near the Section 16(4) deadline). It never touches Zoho, uses no real GSTIN or supplier, is labelled DEMO on every screen, and can be removed completely at any time. Real companies are not affected.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={S.primary} disabled={busy} onClick={() => run(async () => { const r = await g.demoLoad(); setMsg(`Loaded: ${r.counts.books_documents} Books documents, ${r.counts.statements} statements, ${r.counts.reconciliation_rows} reconciliation rows.`); })}>{busy ? 'Working…' : has ? 'Reload the demo data' : 'Load the demo data'}</button>
          {has && <button style={S.danger} disabled={busy} onClick={() => { if (window.confirm('Remove the demo company and everything in it? (Real companies are not touched.)')) run(async () => { await g.demoRemove(); setMsg('Demo data removed.'); }); }}>Remove the demo data</button>}
        </div>
      </div>
    </div>
  );
}
