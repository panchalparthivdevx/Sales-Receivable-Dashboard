import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import MSMEReport from './MSMEReport';
import MSMEInterestReport from './MSMEInterestReport';
import MSMEForm1Report from './MSMEForm1Report';
import { MsmeCompanyContext, MSME_COMPANIES } from '../utils/msmeCompany';
import { companyApis } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';

// Another company's own sync state (its own engine): last synced + Sync Now (admin)
function CompanySyncBar({ company, onSynced }) {
  const capi = companyApis[company.id];
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [fresh, setFresh] = useState(null);
  const [prog, setProg]   = useState(null);
  const [err, setErr]     = useState(null);
  const wasRunning = useRef(false);

  const refresh = useCallback(async () => {
    try { setFresh(await capi.syncFreshness()); setErr(null); }
    catch (e) { setErr(e.response?.data?.error || e.message); }
    if (isAdmin) { try { setProg((await capi.syncProgress()).progress || null); } catch (_) {} }
  }, [capi, isAdmin]);

  useEffect(() => { refresh(); }, [refresh]);
  const running = prog?.status === 'running';
  useEffect(() => {
    if (running) { wasRunning.current = true; const id = setInterval(refresh, 3000); return () => clearInterval(id); }
    if (wasRunning.current) { wasRunning.current = false; onSynced(); }
  }, [running, refresh, onSynced]);

  async function syncNow() {
    try { await capi.syncRun('normal'); setProg({ status: 'running' }); }
    catch (e) { setErr(e.response?.data?.error || e.message); }
  }

  const ents = Object.values(fresh?.entities || {});
  const times = ents.map(e => e.last_synced_at).filter(Boolean).sort();
  const never = ents.length > 0 && times.length < ents.length;
  const failed = ents.some(e => e.status === 'failed');
  const fmt = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8, fontSize: '0.74rem', color: failed || err ? '#d97706' : '#5D6C7B' }}>
      <span>
        {company.short} data (Zoho org {company.orgId}):{' '}
        {err ? `sync status unavailable — ${err}`
          : running ? `syncing${prog?.current ? ` — ${prog.current}` : ''}…`
          : never ? (times.length ? `partly synced — first full sync still in progress (last: ${fmt(times[times.length - 1])})` : 'not synced yet — the first full sync runs automatically')
          : times.length ? `last synced ${fmt(times[0])}${failed ? ' · last sync had errors' : ''}` : 'checking…'}
      </span>
      {isAdmin && (
        <button onClick={syncNow} disabled={running}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 5, color: '#1C4942', padding: '2px 9px', fontSize: '0.72rem', cursor: running ? 'default' : 'pointer', opacity: running ? 0.6 : 1 }}
          title={`Incremental sync of ${company.name} only — DevX is not synced`}>
          <RefreshCw size={11} className={running ? 'spin' : ''} /> {running ? 'Syncing…' : 'Sync Now'}
        </button>
      )}
    </div>
  );
}

export default function MSMECompliance({ company = 'devx' }) {
  const co = MSME_COMPANIES[company] || MSME_COMPANIES.devx;
  const [dataKey, setDataKey] = useState(0);   // a finished company sync reloads its reports
  const onSynced = useCallback(() => setDataKey(k => k + 1), []);
  return (
    <MsmeCompanyContext.Provider value={co.id}>
      <div style={{ padding: '1.5rem 2rem', minHeight: '100vh', background: '#F9F9F9' }}>
        <div style={{ marginBottom: '1.25rem' }}>
          <h1 style={{ color: '#18191B', fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
            MSME Compliance <span style={{ color: '#5D6C7B', fontWeight: 500, fontSize: '0.95rem' }}>— {co.name}</span>
          </h1>
          <p style={{ color: '#5D6C7B', fontSize: '0.82rem', margin: '4px 0 0' }}>
            Monitor MSMED Act compliance — track payment timelines, quarterly interest liability and half-yearly Form-1 obligations for MSME-registered vendors
          </p>
          {co.id !== 'devx' && <CompanySyncBar company={co} onSynced={onSynced} />}
        </div>
        <React.Fragment key={dataKey}>
          <MSMEReport />
          <MSMEInterestReport />
          <MSMEForm1Report />
        </React.Fragment>
      </div>
    </MsmeCompanyContext.Provider>
  );
}

// MSME Compliance → DevX / Neddle. A company page stays mounted once opened, so switching between
// companies keeps each one's filters and loaded data (leaving MSME Compliance resets as before).
export function MSMECompanies({ active }) {
  const [opened, setOpened] = useState(() => [active]);
  useEffect(() => { setOpened(o => (o.includes(active) ? o : [...o, active])); }, [active]);
  return opened.map(id => (
    <div key={id} style={{ display: id === active ? 'block' : 'none' }}>
      <MSMECompliance company={id} />
    </div>
  ));
}
