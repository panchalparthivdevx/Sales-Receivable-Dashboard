import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errMsg, setContext, clean } from './compliance2/api';
import { C, S, GlobalStyle, Note, Btn, Select, Empty } from './compliance2/ui';
import { Pills, fyOf } from './compliance2/ui2';
import FilterBar, { EMPTY_FILTERS } from './compliance2/FilterBar';
import OverviewTab from './compliance2/OverviewTab';
import ReportsTab from './compliance2/ReportsTab';
import CalendarTab from './compliance2/CalendarTab';
import RegisterTab from './compliance2/RegisterTab';
import { GstTab, PayrollTab } from './compliance2/WorkspaceTabs';
import TdsTab from './compliance2/TdsTab';
import ImportsTab from './compliance2/ImportsTab';
import TaxAuditTab from './compliance2/TaxAuditTab';
import UpdatesTab, { PromptTab } from './compliance2/UpdatesTab';
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
// Design and tab order follow the user's reference demo (devX / Compliance control room). Group → entity → registrations →
// establishments; a versioned rule engine (nothing live until verified + approved); the initiator / approver workflow; an
// encrypted evidence vault; payments, TDS section-wise, reconciliations, payroll imports, tax-audit papers, updates and reports.
// Server: server/compliance2/. LIVE and DEMO spaces never share data. Compliance Dashboard v1 is separate and unchanged.

const TABS = [
  ['overview', 'Overview', true], ['reports', 'Reports'], ['register', 'Compliance register', true], ['calendar', 'Calendar', true], ['gst', 'GST workspace', true],
  ['tds', 'TDS Section-wise', true], ['payroll', 'Provident Fund & PT', true], ['imports', 'Payroll imports'], ['taxaudit', 'Tax audit'], ['updates', 'Compliance Updates'],
  ['coverage', 'Coverage & rules'], ['masters', 'Companies & GSTINs'], ['evidence', 'Evidence vault'], ['folders', 'Document Folders'], ['team', 'Team & approvals', true], ['prompt', 'Claude build prompt'], ['settings', 'Settings & audit'],
];
const OLD = { approvals: 'team', workload: 'team', rules: 'coverage' };          // tab ids saved by the previous layout
const read = (k, d) => { try { const v = JSON.parse(sessionStorage.getItem(k)); return v ?? d; } catch (_) { return d; } };
const write = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* optional */ } };

export default function Compliance2() {
  const [space, setSpace] = useState(() => read('c2_space', 'live'));
  const [persona, setPersona] = useState(() => read('c2_persona', ''));
  const [meta, setMeta] = useState(null);
  const [org, setOrg] = useState(null);
  const [ws, setWs] = useState(null);
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState(() => { const t = read('c2_tab', 'overview'); return OLD[t] || t; });
  const [sub, setSub] = useState({ coverage: 'coverage', team: 'approvals' });
  const [reportPage, setReportPage] = useState(null);
  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS, ...read('c2_filters', {}) }));
  const [registerView, setRegisterView] = useState(null);
  const [openTask, setOpenTask] = useState(null);
  const [stamp, setStamp] = useState(0);

  setContext({ space, persona });
  const loadAll = useCallback(() => {
    setErr('');
    return Promise.all([api.meta(), api.org(), api.users(), api.ws()])
      .then(([m, o, u, w]) => { setMeta(m); setOrg(o); setUsers(u.users); setWs(w); setFilters(f => (f.fy ? f : { ...f, fy: m.fys.includes(fyOf(m.today)) ? fyOf(m.today) : m.fys[m.fys.length - 1] || fyOf(m.today) })); })
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
  const goto = useCallback((id, page) => { setTab(id); if (id === 'reports') setReportPage(page || null); window.scrollTo?.(0, 0); }, []);
  const switchSpace = sp => { setSpace(sp); setPersona(''); setOrg(null); setFilters({ ...EMPTY_FILTERS }); setOpenTask(null); };

  if (!meta || !org || !ws) {
    return <div className="c2 c2-page" style={S.page}><GlobalStyle />{err ? <Note tone="error">{err}</Note> : <Empty>Loading Compliance Dashboard Vr.2.0…</Empty>}</div>;
  }
  const demo = space === 'demo';
  const fyOptions = [...new Set([...meta.fys, fyOf(meta.today)])].sort();
  const current = TABS.find(t => t[0] === tab) || TABS[0];
  const common = { meta, org, ws, demo, stamp, users, onOpenTask: setOpenTask, onChanged: changed, onGoto: goto, onGotoReport: p => goto('reports', p), params };
  return (
    <div className="c2 c2-page" style={{ ...S.page, padding: 0 }}>
      <GlobalStyle />
      <style>{`.c2 .c2-two { grid-template-columns: minmax(0,1.7fr) minmax(280px,1fr); } .c2 .c2-three { grid-template-columns: minmax(250px,1fr) minmax(0,1.6fr) minmax(250px,1fr); } @media (max-width: 1180px) { .c2 .c2-three { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); } } @media (max-width: 980px) { .c2 .c2-two { grid-template-columns: 1fr !important; } } @media print { .c2-noprint, .c2 header.c2-top, .c2 nav.c2-tabs { display: none !important; } .c2.c2-page { background: #fff !important; } }`}</style>
      <header className="c2-top" style={{ background: '#111B32', color: '#fff', padding: '20px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 22 }}><b>devX</b> <span style={{ fontWeight: 300 }}>/ Compliance</span> <span style={{ fontSize: 12, color: '#BFC9DF', marginLeft: 8 }}>Dashboard Vr.2.0</span></div>
          <small style={{ color: '#BFC9DF', fontSize: 11, letterSpacing: 0.4 }}>GROUP FINANCE · CONTROL ROOM · {meta.actor.name}{meta.actor.auditor ? ' (read-only auditor)' : ''}</small>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {demo && (
            <div style={{ width: 220 }} title="Lets one person try every role on demo data. A persona is not a login and is ignored in the live space.">
              <Select value={persona} onChange={setPersona} options={Object.entries(meta.constants.personas).map(([k, v]) => [k, `Persona: ${v} (demo)`])} placeholder="Myself (my own rights)" aria-label="Demo persona" style={{ background: '#1C2846', color: '#fff', border: '1px solid #3A4870' }} />
            </div>
          )}
          <div role="group" aria-label="Data space" style={{ display: 'flex', background: '#1C2846', border: '1px solid #3A4870', borderRadius: 10, padding: 3 }}>
            {[['live', 'Live'], ['demo', 'Demo']].map(([k, l]) => <Btn key={k} small kind={space === k ? 'primary' : 'onNavy'} onClick={() => switchSpace(k)} aria-pressed={space === k} style={{ border: 'none' }}>{l}</Btn>)}
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ display: 'inline-block', border: '1px solid #9A86E4', color: '#C9BFEE', background: demo ? '#2A2560' : '#163A3A', borderRadius: 4, padding: '3px 8px', fontSize: 11, letterSpacing: 0.5 }}>{demo ? 'INTERACTIVE REVIEW DEMO' : 'LIVE SPACE'}</span>
            <div style={{ fontSize: 12, color: '#DDE3F1', marginTop: 5 }}>{demo ? `Snapshot · ${new Date(`${meta.today}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}` : `Today · ${new Date(`${meta.today}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })} IST`}</div>
          </div>
        </div>
      </header>
      <div style={{ padding: '20px 28px 32px', maxWidth: 1560 }}>
        {demo && <div role="note" style={{ background: '#FFF9E9', border: '1px solid #EEE3C1', color: '#766B50', borderRadius: 10, fontSize: 12, padding: '12px 16px', marginBottom: 18, lineHeight: 1.6 }}>Sample records and placeholder registrations only. Standard due dates are illustrative baselines, subject to applicable notifications; unverified and state-specific rules are marked for review. Amounts, references and sample files are invented, and nothing here is a live feed, a real filing or a legal determination. Demo data never mixes with live data.</div>}
        {!demo && !org.entities.length && <Note tone="info">The live space has no companies yet. Start in <b>Companies &amp; GSTINs</b> (add, import, or carry over the Compliance v1 companies), approve them, decide applicability and verify the rules in <b>Coverage &amp; rules</b>, then generate tasks. Or open the <b>Demo</b> space to see everything working on illustrative data.</Note>}
        {err && <Note tone="error">{err}</Note>}
        <nav className="c2-tabs" aria-label="Compliance sections" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
          {TABS.map(([id, label]) => (
            <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); if (id === 'register') setRegisterView(null); if (id === 'reports') setReportPage(null); }}
              style={{ border: 'none', borderRadius: 9, padding: '10px 13px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', background: tab === id ? '#6554C5' : 'transparent', color: tab === id ? '#fff' : '#485570', boxShadow: tab === id ? '0 3px 10px #6554C51a' : 'none', fontWeight: tab === id ? 600 : 500 }}>{label}</button>
          ))}
        </nav>
        {current[2] && <FilterBar filters={filters} setFilters={setFilters} meta={meta} org={org} users={users} fyOptions={fyOptions} />}
        {tab === 'overview' && <OverviewTab {...common} onDrill={drill} />}
        {tab === 'reports' && <ReportsTab {...common} initialPage={reportPage} />}
        {tab === 'register' && <RegisterTab params={params} stamp={stamp} onOpenTask={setOpenTask} initialView={registerView} />}
        {tab === 'calendar' && <CalendarTab params={params} stamp={stamp} onOpenTask={setOpenTask} today={meta.today} demo={demo} />}
        {tab === 'gst' && <GstTab {...common} />}
        {tab === 'tds' && <TdsTab {...common} />}
        {tab === 'payroll' && <PayrollTab {...common} />}
        {tab === 'imports' && <ImportsTab {...common} />}
        {tab === 'taxaudit' && <TaxAuditTab {...common} />}
        {tab === 'updates' && <UpdatesTab {...common} />}
        {tab === 'coverage' && <>
          <Pills items={[['coverage', 'Coverage & applicability'], ['rules', 'Rules & versions']]} value={sub.coverage} onChange={v => setSub(s => ({ ...s, coverage: v }))} label="Coverage and rules" />
          {sub.coverage === 'coverage' ? <CoverageTab meta={meta} org={org} defaultFy={filters.fy || fyOf(meta.today)} stamp={stamp} onChanged={changed} /> : <RulesTab meta={meta} org={org} stamp={stamp} onChanged={changed} />}
        </>}
        {tab === 'masters' && <MastersTab meta={meta} org={org} users={users} stamp={stamp} onChanged={changed} />}
        {tab === 'evidence' && <EvidenceTab stamp={stamp} meta={meta} org={org} onOpenTask={setOpenTask} />}
        {tab === 'folders' && <FoldersTab meta={meta} org={org} stamp={stamp} onChanged={changed} />}
        {tab === 'team' && <>
          <Pills items={[['approvals', 'Approvals queue'], ['workload', 'Team workload']]} value={sub.team} onChange={v => setSub(s => ({ ...s, team: v }))} label="Team and approvals" />
          {sub.team === 'approvals' ? <ApprovalsTab params={params} stamp={stamp} onOpenTask={setOpenTask} meta={meta} onGoto={id => goto(OLD[id] || id)} /> : <WorkloadTab params={params} stamp={stamp} onDrill={drill} />}
          <p style={{ ...S.muted, color: C.muted }}>Who may prepare and file (Initiator) or check and close (Approver) is set in Settings &amp; audit; owners and reviewers for new tasks in Companies &amp; GSTINs → Team mapping.</p>
        </>}
        {tab === 'prompt' && <PromptTab meta={meta} />}
        {tab === 'settings' && <SettingsTab meta={meta} org={org} users={users} onChanged={changed} />}
        <div style={{ color: '#8993A4', fontSize: 11, marginTop: 18 }}>Designed for multi-company, multi-GSTIN operations · India / Asia–Kolkata · Compliance Dashboard Vr.2.0</div>
      </div>
      {openTask && <TaskDrawer id={openTask} meta={meta} users={users} onClose={() => setOpenTask(null)} onChanged={changed} />}
    </div>
  );
}
