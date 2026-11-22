import React, { useState, useEffect, useCallback } from 'react';
import { t, errMsg } from './tds26as/api';
import { S } from './tds26as/ui';
import DashboardTab from './tds26as/DashboardTab';
import FollowUpTab from './tds26as/FollowUpTab';
import TransactionsTab from './tds26as/TransactionsTab';
import CorrectionsTab from './tds26as/CorrectionsTab';
import CarryForwardTab from './tds26as/CarryForwardTab';
import ClientsTab from './tds26as/ClientsTab';
import ImportsTab from './tds26as/ImportsTab';
import SettingsTab from './tds26as/SettingsTab';

// ─── 26AS Reconciliation ──────────────────────────────────────────────────────
// TDS receivable booked in Zoho Books (the entity's TDS Receivable ledgers, read-only) against the credits in the uploaded Form 26AS,
// per legal entity and period. Server: server/tds26as/ (README.md there).

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'followup', label: 'Client follow-up' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'corrections', label: 'Zoho corrections' },
  { id: 'carry', label: 'Carry forward' },
  { id: 'clients', label: 'Client mapping' },
  { id: 'imports', label: 'Statements & Zoho sync' },
  { id: 'settings', label: 'Settings & audit' },
];
const PERIODIC = ['dashboard', 'followup', 'transactions', 'corrections', 'carry'];
const KEY = 't26_scope';
const readS = (k, d) => { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch (_) { return d; } };
const fyList = cur => { const s = +cur.slice(0, 4); return Array.from({ length: 6 }, (_, i) => { const y = s + 1 - i; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; }); };

export default function Tds26asReco() {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(() => readS('t26_tab', 'dashboard'));
  const [scope, setScope] = useState(() => readS(KEY, null));
  const [drill, setDrill] = useState(null);                 // filters chosen by clicking a figure (Transactions tab)
  const [stamp, setStamp] = useState(0);

  const loadMeta = useCallback(() => t.meta().then(m => { setMeta(m); setError(''); return m; }).catch(e => setError(errMsg(e))), []);
  useEffect(() => { loadMeta(); }, [loadMeta]);
  useEffect(() => {
    if (!meta) return;
    setScope(s => {
      const ok = s && meta.entities.some(e => e.id === s.entity);
      const prevFy = (() => { const y = +meta.current_fy.slice(0, 4) - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; })();
      return ok ? s : { entity: meta.entities[0] ? meta.entities[0].id : '', mode: 'fy', fy: s?.fy || prevFy, q: s?.q || 'all', from: '', to: '' };
    });
  }, [meta]);
  useEffect(() => { if (scope) try { sessionStorage.setItem(KEY, JSON.stringify(scope)); } catch (_) { /* optional */ } }, [scope]);
  const go = id => { setTab(id); try { sessionStorage.setItem('t26_tab', id); } catch (_) { /* optional */ } };
  const changed = () => setStamp(s => s + 1);

  if (!meta || !scope) return <div style={S.page}><h2 style={S.pageTitle}>26AS Reconciliation</h2>{error ? <div style={{ ...S.error, marginTop: 12 }}>{error}</div> : <div style={S.center}>Loading…</div>}</div>;
  const entity = meta.entities.find(e => e.id === scope.entity);
  const empty = meta.entities.length === 0;
  const params = scope.mode === 'custom' && scope.from && scope.to ? { entity: scope.entity, from: scope.from, to: scope.to } : { entity: scope.entity, fy: scope.fy, q: scope.q === 'all' ? '' : scope.q };
  const current = TABS.some(x => x.id === tab) ? tab : 'dashboard';
  const onDrill = (f, to = 'transactions') => { setDrill(f); go(to); };
  const set = patch => { setScope(s => ({ ...s, ...patch })); setDrill(null); };

  return (
    <div style={S.page}>
      <div style={S.topBar}>
        <div>
          <h2 style={S.pageTitle}>26AS Reconciliation</h2>
          <p style={S.pageSub}>TDS receivable booked in Zoho Books against the credit in Form 26AS — per legal entity and period. TDS difference = Zoho TDS receivable − 26AS tax deposited.</p>
        </div>
        <div style={S.muted}>Zoho Books: read-only ({meta.integrations.zoho})</div>
      </div>
      {entity && entity.demo && <div style={S.demo}>DEMO DATA — synthetic entity, clients and statements. Nothing here came from Zoho Books or TRACES. Remove it in Settings &amp; audit → Demo data.</div>}
      {empty && (
        <div style={S.notice}>
          <b>No entity is set up yet.</b> Open <b>Settings &amp; audit → Entities</b> to add a legal entity: its PAN, its Zoho Books organisation and its TDS Receivable ledger(s).
          {meta.rights.admin ? ' You can also load the synthetic demo data there to see every case first.' : ''}
        </div>
      )}

      {!empty && (
        <div style={{ ...S.card, padding: '0.6rem 0.9rem', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label><span style={S.label}>Entity</span>
            <select style={S.select} value={scope.entity} onChange={e => set({ entity: e.target.value })}>
              {meta.entities.map(e => <option key={e.id} value={e.id}>{e.name}{e.active === false ? ' (inactive)' : ''} — {e.pan}</option>)}
            </select>
          </label>
          <label><span style={S.label}>Period</span>
            <select style={S.select} value={scope.mode} onChange={e => set({ mode: e.target.value })}>
              <option value="fy">Financial year / quarter</option><option value="custom">Custom date range</option>
            </select>
          </label>
          {scope.mode !== 'custom' ? (
            <>
              <label><span style={S.label}>Financial year</span><select style={S.select} value={scope.fy} onChange={e => set({ fy: e.target.value })}>{fyList(meta.current_fy).map(f => <option key={f} value={f}>FY {f}</option>)}</select></label>
              <label><span style={S.label}>Quarter</span><select style={S.select} value={scope.q} onChange={e => set({ q: e.target.value })}>
                <option value="all">Whole year</option><option value="1">Q1 (Apr–Jun)</option><option value="2">Q2 (Jul–Sep)</option><option value="3">Q3 (Oct–Dec)</option><option value="4">Q4 (Jan–Mar)</option></select></label>
            </>
          ) : (
            <>
              <label><span style={S.label}>From</span><input type="date" style={S.input} value={scope.from} onChange={e => set({ from: e.target.value })} /></label>
              <label><span style={S.label}>To</span><input type="date" style={S.input} value={scope.to} onChange={e => set({ to: e.target.value })} /></label>
            </>
          )}
          <span style={{ ...S.small, maxWidth: 420, lineHeight: 1.4 }}>Zoho entries are cut off by their TDS posting date, 26AS credits by their transaction date. Invoice, payment and booking dates are shown separately.</span>
        </div>
      )}

      <div style={S.tabs}>{TABS.map(x => <button key={x.id} style={S.tab(current === x.id)} onClick={() => { go(x.id); if (x.id !== 'transactions') setDrill(null); }}>{x.label}</button>)}</div>
      {PERIODIC.includes(current) && !empty && scope.mode === 'custom' && !(scope.from && scope.to) && <div style={S.notice}>Choose both dates of the custom range.</div>}

      {current === 'dashboard' && !empty && <DashboardTab meta={meta} params={params} stamp={stamp} onDrill={onDrill} go={go} />}
      {current === 'followup' && !empty && <FollowUpTab meta={meta} params={params} stamp={stamp} onDrill={onDrill} onChanged={changed} />}
      {current === 'transactions' && !empty && <TransactionsTab meta={meta} params={params} stamp={stamp} drill={drill} clearDrill={() => setDrill(null)} onChanged={changed} />}
      {current === 'corrections' && !empty && <CorrectionsTab meta={meta} params={params} stamp={stamp} />}
      {current === 'carry' && !empty && <CarryForwardTab meta={meta} params={params} stamp={stamp} onChanged={changed} />}
      {current === 'clients' && !empty && <ClientsTab meta={meta} entity={entity} stamp={stamp} onChanged={changed} />}
      {current === 'imports' && !empty && <ImportsTab meta={meta} entity={entity} params={params} stamp={stamp} onChanged={changed} />}
      {current === 'settings' && <SettingsTab meta={meta} reloadMeta={() => { loadMeta(); changed(); }} />}
    </div>
  );
}
