import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errMsg, setContext, clean } from './compliance2/api';
import { C, S, GlobalStyle, Tabs, Note, Btn, Select, Empty } from './compliance2/ui';
import FilterBar, { EMPTY_FILTERS } from './compliance2/FilterBar';
import OverviewTab from './compliance2/OverviewTab';
import CalendarTab from './compliance2/CalendarTab';
import RegisterTab from './compliance2/RegisterTab';
import ApprovalsTab from './compliance2/ApprovalsTab';
import CoverageTab from './compliance2/CoverageTab';
import WorkloadTab from './compliance2/WorkloadTab';
import EvidenceTab from './compliance2/EvidenceTab';
import FoldersTab from './compliance2/FoldersTab';
import MastersTab from './compliance2/MastersTab';
import RulesTab from './compliance2/RulesTab';
import SettingsTab from './compliance2/SettingsTab';
import TaskDrawer from './compliance2/TaskDrawer';

// ─── Compliance Dashboard Vr.2.0 ──────────────────────────────────────────────
// Group → entity → registrations → establishments; a versioned rule engine (nothing live until verified + approved); the
// maker / checker / filer / verifier workflow; an encrypted evidence vault. Server: server/compliance2/. The LIVE and DEMO
// spaces never share data. Compliance Dashboard v1 (pages/ComplianceDashboard.js) is separate and unchanged.

const TABS = [
  { id: 'overview', label: 'Overview', filters: true }, { id: 'calendar', label: 'Calendar', filters: true }, { id: 'register', label: 'Register', filters: true },
  { id: 'approvals', label: 'Approvals', filters: true }, { id: 'coverage', label: 'Coverage' }, { id: 'workload', label: 'Workload', filters: true },
  { id: 'evidence', label: 'Evidence' }, { id: 'folders', label: 'Document Folders' }, { id: 'masters', label: 'Masters' }, { id: 'rules', label: 'Rules' }, { id: 'settings', label: 'Settings & audit' },
];
const read = (k, d) => { try { const v = JSON.parse(sessionStorage.getItem(k)); return v ?? d; } catch (_) { return d; } };
const write = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* optional */ } };

export default function Compliance2() {
  const [space, setSpace] = useState(() => read('c2_space', 'live'));
  const [persona, setPersona] = useState(() => read('c2_persona', ''));
  const [meta, setMeta] = useState(null);
  const [org, setOrg] = useState(null);
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState(() => read('c2_tab', 'overview'));
  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS, ...read('c2_filters', {}) }));
  const [registerView, setRegisterView] = useState(null);
  const [openTask, setOpenTask] = useState(null);
  const [stamp, setStamp] = useState(0);

  setContext({ space, persona });
  const loadAll = useCallback(() => {
    setErr('');
    return Promise.all([api.meta(), api.org(), api.users()])
      .then(([m, o, u]) => { setMeta(m); setOrg(o); setUsers(u.users); setFilters(f => (f.fy ? f : { ...f, fy: m.fys.includes(fyOf(m.today)) ? fyOf(m.today) : m.fys[m.fys.length - 1] || fyOf(m.today) })); })
      .catch(e => setErr(errMsg(e)));
  }, []);
  useEffect(() => { setMeta(null); loadAll(); }, [space, persona, loadAll]);
  useEffect(() => write('c2_space', space), [space]);
  useEffect(() => write('c2_persona', persona), [persona]);
  useEffect(() => write('c2_tab', tab), [tab]);
  useEffect(() => write('c2_filters', filters), [filters]);
  const params = useMemo(() => clean(filters), [filters]);
  const changed = useCallback(() => { setStamp(s => s + 1); api.org().then(setOrg).catch(() => {}); }, []);
  const drill = useCallback(extra => { setFilters(f => ({ ...f, ...extra })); setRegisterView('all'); setTab('register'); }, []);
  const switchSpace = sp => { setSpace(sp); setPersona(''); setOrg(null); setFilters({ ...EMPTY_FILTERS }); setOpenTask(null); };

  if (!meta || !org) {
    return <div className="c2 c2-page" style={S.page}><GlobalStyle />{err ? <Note tone="error">{err}</Note> : <Empty>Loading Compliance Dashboard Vr.2.0…</Empty>}</div>;
  }
  const demo = space === 'demo';
  const fyOptions = [...new Set([...meta.fys, fyOf(meta.today)])].sort();
  const current = TABS.find(t => t.id === tab) || TABS[0];
  return (
    <div className="c2 c2-page" style={S.page}>
      <GlobalStyle />
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.35rem', color: C.navy }}>Compliance Dashboard Vr.2.0</h1>
          <div style={{ ...S.muted, marginTop: 3 }}>Entities → registrations → obligations · verified rules only · initiator / approver workflow · evidence vault · OneDrive folders · {demo ? <b style={{ color: C.lav }}>DEMO space</b> : 'live space'} · {meta.actor.name}{meta.actor.auditor ? ' (read-only auditor)' : ''}</div>
        </div>
        <div style={{ ...S.row, gap: 10 }}>
          {demo && (
            <div style={{ width: 230 }} title="Lets one person try every role on demo data. A persona is not a login and is ignored in the live space.">
              <span style={S.label}>Demo persona (not a login)</span>
              <Select value={persona} onChange={setPersona} options={Object.entries(meta.constants.personas).map(([k, v]) => [k, `${v} (demo)`])} placeholder="Myself (my own rights)" />
            </div>
          )}
          <div role="group" aria-label="Data space" style={{ display: 'flex', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, padding: 3 }}>
            {[['live', 'Live'], ['demo', 'Demo']].map(([k, l]) => <Btn key={k} kind={space === k ? 'primary' : 'ghost'} small onClick={() => switchSpace(k)} aria-pressed={space === k} style={{ border: 'none' }}>{l}</Btn>)}
          </div>
        </div>
      </header>
      {demo && <Note tone="demo"><b>DEMO — illustrative data only.</b> Entities, registrations, filings, amounts and sample files are invented; rules may be unverified drafts; the snapshot date is fixed at {meta.demo?.snapshot_date}. Nothing here is a live feed, a real filing or a legal determination. Demo data never mixes with live data.</Note>}
      {!demo && !org.entities.length && <Note tone="info">The live space has no entities yet. Start in <b>Masters</b> (add, import, or carry over the Compliance v1 companies), approve them, decide applicability in <b>Coverage</b>, verify and approve the rules you rely on in <b>Rules</b>, then generate tasks. Or open the <b>Demo</b> space to see it working on illustrative data.</Note>}
      {err && <Note tone="error">{err}</Note>}
      <Tabs tabs={TABS} value={current.id} onChange={id => { setTab(id); if (id === 'register') setRegisterView(null); }} />
      {current.filters && <FilterBar filters={filters} setFilters={setFilters} meta={meta} org={org} users={users} fyOptions={fyOptions} />}
      {current.id === 'overview' && <OverviewTab params={params} stamp={stamp} onOpenTask={setOpenTask} onDrill={drill} meta={meta} demo={demo} />}
      {current.id === 'calendar' && <CalendarTab params={params} stamp={stamp} onOpenTask={setOpenTask} today={meta.today} demo={demo} />}
      {current.id === 'register' && <RegisterTab params={params} stamp={stamp} onOpenTask={setOpenTask} initialView={registerView} />}
      {current.id === 'approvals' && <ApprovalsTab params={params} stamp={stamp} onOpenTask={setOpenTask} meta={meta} onGoto={setTab} />}
      {current.id === 'coverage' && <CoverageTab meta={meta} org={org} defaultFy={filters.fy || fyOf(meta.today)} stamp={stamp} onChanged={changed} />}
      {current.id === 'workload' && <WorkloadTab params={params} stamp={stamp} onDrill={drill} />}
      {current.id === 'evidence' && <EvidenceTab stamp={stamp} meta={meta} org={org} onOpenTask={setOpenTask} />}
      {current.id === 'folders' && <FoldersTab meta={meta} org={org} stamp={stamp} onChanged={changed} />}
      {current.id === 'masters' && <MastersTab meta={meta} org={org} users={users} stamp={stamp} onChanged={changed} />}
      {current.id === 'rules' && <RulesTab meta={meta} org={org} stamp={stamp} onChanged={changed} />}
      {current.id === 'settings' && <SettingsTab meta={meta} org={org} users={users} onChanged={changed} />}
      {openTask && <TaskDrawer id={openTask} meta={meta} users={users} onClose={() => setOpenTask(null)} onChanged={changed} />}
    </div>
  );
}

function fyOf(date) {
  const y = +String(date).slice(0, 4), m = +String(date).slice(5, 7);
  const s = m >= 4 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}
