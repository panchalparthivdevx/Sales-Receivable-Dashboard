import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Building2, Layers, RefreshCw } from 'lucide-react';
import { T } from '../../theme';
import { capi, errSync } from './complianceApi';
import { S, Btn, Chip, Input, Note, Spinner, ErrorBox } from './ui';
import FilterBar from './FilterBar';
import { ZohoStatus, ZohoDataCard } from './ZohoPanel';
import { KpiGrid, SummaryCard, UpcomingCard, OverdueCard, DrillTree } from './Reports';
import TaskTable from './TaskTable';
import TaskDetail from './TaskDetail';
import { ALL, emptyFilters, toQuery, buildPeriodIndex, isValidCombo, periodText } from './filterLogic';

// Everything on this tab uses ONE selected period (Company + FY + Month/Quarter/Half).
// KPI cards, reports, task table, exports and the Zoho status all come from the same
// filters — nothing from another period is shown unless the filters are widened on purpose.

const BUCKET_LABEL = {
  completed: 'Completed', pending: 'Pending', overdue: 'Overdue', due_soon: 'Due Soon',
  in_progress: 'In Progress', na: 'Not Applicable', applicable: 'Applicable (Compliance %)',
};
function inBucket(s, b) {
  switch (b) {
    case 'completed': return s === 'Completed';
    case 'pending': return s !== 'Completed' && s !== 'N/A';
    case 'overdue': return s === 'Overdue';
    case 'due_soon': return s === 'Due Soon';
    case 'in_progress': return s === 'In Progress';
    case 'na': return s === 'N/A';
    case 'applicable': return s !== 'N/A';
    default: return true;
  }
}
function matches(r, q) {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [r.task_id, r.company_name, r.company_short, r.compliance_name, r.compliance_id, r.form_name, r.responsible, r.reviewer, r.module, ...(r.doc_names || [])]
    .some(v => String(v || '').toLowerCase().includes(s));
}

const STORE_KEY = 'cmp_dash_filters';
function loadSaved(meta) {
  try {
    const f = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
    const idx = buildPeriodIndex(meta.period);
    if (f && meta.settings.fy_list.includes(f.fy) && isValidCombo(idx, f) && (f.company === ALL || meta.companies.some(c => c.id === f.company))) return f;
  } catch (_) { /* storage unavailable */ }
  return emptyFilters(meta.current.fy_default);
}

export default function DashboardTab({ meta, colors }) {
  const [filters, setFilters] = useState(() => loadSaved(meta));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [zStatus, setZStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [zKey, setZKey] = useState(0);
  const [drill, setDrill] = useState({});            // { company_id, module, compliance_id, bucket }
  const [q, setQ] = useState('');
  const [allPeriods, setAllPeriods] = useState(false);
  const [searchRes, setSearchRes] = useState(null);
  const [openTask, setOpenTask] = useState(null);
  const idx = useMemo(() => buildPeriodIndex(meta.period), [meta.period]);
  const qs = JSON.stringify(toQuery(filters));

  useEffect(() => { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(filters)); } catch (_) { /* ignore */ } }, [filters]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await capi.dashboard(JSON.parse(qs))); }
    catch (e) { setError(errSync(e)); }
    finally { setLoading(false); }
  }, [qs]);

  // Zoho status: stored data only — changing filters never calls Zoho
  const loadZoho = useCallback(async () => {
    try { setZStatus(await capi.zohoStatus(JSON.parse(qs))); } catch (_) { setZStatus(null); }
  }, [qs]);

  useEffect(() => { load(); loadZoho(); setDrill({}); setSyncMsg(null); }, [load, loadZoho]);

  // Search across all periods is an intentional widening — server side
  useEffect(() => {
    if (!allPeriods || q.trim().length < 2) { setSearchRes(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      capi.search({ q: q.trim(), scope: 'all' }).then(r => alive && setSearchRes(r)).catch(e => alive && setSearchRes({ error: errSync(e), rows: [] }));
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q, allPeriods]);

  const sync = async onlyMissing => {
    const n = zStatus ? (onlyMissing ? zStatus.total - zStatus.synced : zStatus.total) : 0;
    if (n > 3 && !window.confirm(`This fetches ${n} company-month periods from Zoho Books (several API calls each). Continue?\n\nTip: pick one Month and one Company to sync just that period.`)) return;
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await capi.zohoSync({ ...JSON.parse(qs), only_missing: onlyMissing });
      setZStatus(r.status);
      const failed = r.results.filter(x => x.ok === false || (x.errors && x.errors.length));
      setSyncMsg(failed.length
        ? { kind: 'warning', text: `Sync finished with problems: ${failed.map(f => `${f.key}: ${(f.errors || []).join('; ')}`).join(' | ')}` }
        : { kind: 'success', text: `Synced from Zoho Books (${r.api_calls} API call${r.api_calls === 1 ? '' : 's'}).` });
      setZKey(k => k + 1);
    } catch (e) { setSyncMsg({ kind: 'error', text: errSync(e) }); }
    finally { setSyncing(false); }
  };

  const rowsById = useMemo(() => new Map((data?.rows || []).map(r => [r.task_id, r])), [data]);
  const searching = allPeriods && q.trim().length >= 2;
  const baseRows = useMemo(() => (searching ? (searchRes?.rows || []) : (data?.rows || [])), [searching, searchRes, data]);
  const tableRows = useMemo(() => baseRows.filter(r =>
    (!drill.company_id || r.company_id === drill.company_id) &&
    (!drill.module || r.module === drill.module) &&
    (!drill.compliance_id || r.compliance_id === drill.compliance_id) &&
    (!drill.bucket || inBucket(r.display_status, drill.bucket)) &&
    (searching || matches(r, q))), [baseRows, drill, q, searching]);

  const companyName = id => meta.companies.find(c => c.id === id)?.name || id;
  const compName = id => meta.compliances.find(c => c.id === id)?.name || id;
  const singlePeriod = filters.month !== ALL && filters.company !== ALL;
  const canSync = meta.me.flags.edit_tasks;

  const chips = [];
  if (drill.company_id) chips.push(<Chip key="c" onRemove={() => setDrill(d => ({ ...d, company_id: undefined, module: undefined, compliance_id: undefined }))}>Company: {companyName(drill.company_id)}</Chip>);
  if (drill.module) chips.push(<Chip key="m" onRemove={() => setDrill(d => ({ ...d, module: undefined, compliance_id: undefined }))}>Module: {drill.module}</Chip>);
  if (drill.compliance_id) chips.push(<Chip key="cm" onRemove={() => setDrill(d => ({ ...d, compliance_id: undefined }))}>Compliance: {compName(drill.compliance_id)}</Chip>);
  if (drill.bucket) chips.push(<Chip key="b" color={colors[BUCKET_LABEL[drill.bucket]] || T.primary} onRemove={() => setDrill(d => ({ ...d, bucket: undefined }))}>Status: {BUCKET_LABEL[drill.bucket]}</Chip>);

  const toolbar = (
    <>
      <div style={{ position: 'relative', width: 300, maxWidth: '100%' }}>
        <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: T.textFaint }} />
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search Task ID, company, compliance, person, document…" style={{ paddingLeft: 28 }} aria-label="Search tasks" />
      </div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.75rem', color: T.textMuted, cursor: 'pointer' }} title="Search every period, not only the selected one">
        <input type="checkbox" checked={allPeriods} onChange={e => setAllPeriods(e.target.checked)} /> All periods
      </label>
      {chips}
      {(chips.length > 0 || q) && <button style={S.linkBtn} onClick={() => { setDrill({}); setQ(''); }}>Clear</button>}
    </>
  );

  return (
    <>
      <FilterBar meta={meta} filters={filters} onChange={setFilters}>
        <ZohoStatus status={zStatus} canSync={canSync} syncing={syncing} onSync={sync} single={singlePeriod} />
      </FilterBar>
      {syncMsg && <Note kind={syncMsg.kind} style={{ marginBottom: '1rem' }}>{syncMsg.text}</Note>}

      {loading && !data && <Spinner label="Loading compliance data…" />}
      {error && <ErrorBox error={error} onRetry={load} />}

      {data && !error && (
        <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ ...S.label, marginBottom: 0 }}>Key figures · {periodText(idx, filters)}{filters.company !== ALL ? ` · ${companyName(filters.company)}` : ''}{filters.module !== ALL ? ` · ${filters.module}` : ''}</span>
            <span style={{ flex: 1 }} />
            <Btn size="sm" variant="ghost" icon={RefreshCw} spin={loading} onClick={load} title="Reload (does not call Zoho)">Refresh</Btn>
          </div>
          <KpiGrid kpis={data.kpis} colors={colors} active={drill.bucket} onPick={b => setDrill(d => ({ ...d, bucket: b || undefined }))} />

          {data.kpis.total === 0 && (
            <Note style={{ marginBottom: '1.1rem' }}>
              No tasks exist for this period yet. {meta.me.flags.edit_master ? 'Go to Master › Task Data › Generate Tasks to create them from the Compliance Master.' : 'Ask a manager to generate tasks for this period.'}
            </Note>
          )}

          <div className="cmp-two">
            <SummaryCard title="Company-wise Report" icon={Building2} subtitle="Click a row to list its tasks" rows={data.by_company} columns={meta.columns.summary}
              activeKey={drill.company_id} onRowClick={k => setDrill(d => ({ ...d, company_id: d.company_id === k ? undefined : k, module: undefined, compliance_id: undefined }))} fileName="Compliance_Company_Report.xlsx" />
            <SummaryCard title="Module-wise Report" icon={Layers} subtitle="Click a row to list its tasks" rows={data.by_module} columns={meta.columns.summary}
              activeKey={drill.module} onRowClick={k => setDrill(d => ({ ...d, module: d.module === k ? undefined : k, compliance_id: undefined }))} fileName="Compliance_Module_Report.xlsx" />
          </div>
          <div className="cmp-two">
            <UpcomingCard data={data} rowsById={rowsById} windows={meta.settings.upcoming_windows || [7, 15, 30]} colors={colors} onOpen={setOpenTask} />
            <OverdueCard data={data} rowsById={rowsById} colors={colors} onOpen={setOpenTask} />
          </div>

          <DrillTree rows={data.rows} colors={colors} onOpen={setOpenTask} onFilter={f => setDrill(d => ({ bucket: d.bucket, ...f }))} />

          <ZohoDataCard filters={filters} refreshKey={zKey} />

          <TaskTable meta={meta} rows={tableRows} colors={colors} onOpen={setOpenTask} toolbar={toolbar}
            title={searching ? 'Search results — all periods' : 'Tasks'}
            subtitle={searching
              ? (searchRes?.error || `Matching "${q.trim()}" across every period you can see (not limited to the filters above).`)
              : `${periodText(idx, filters)} · click a row to update status, add documents or see its history`}
            exportName={`Compliance_Tasks_FY${filters.fy}${filters.month !== ALL ? '_' + filters.month : filters.quarter !== ALL ? '_' + filters.quarter : filters.half !== ALL ? '_' + filters.half : ''}.xlsx`} />
        </div>
      )}

      {openTask && <TaskDetail taskId={openTask} meta={meta} colors={colors} onClose={() => setOpenTask(null)} onChanged={load} />}
    </>
  );
}
