import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Plus } from 'lucide-react';
import { S, Msg, dtm } from './billbooking/ui';
import { cf, errMsg, monthLabel, longMonth, fyMonths, fyOfMonth, addMonths } from './cashflow/cfApi';
import { C } from './cashflow/cfUi';
import Overview from './cashflow/Overview';
import CategoryTab from './cashflow/CategoryTab';
import BudgetForm from './cashflow/BudgetForm';
import SettingsTab from './cashflow/SettingsTab';
import { PartDrawer, BudgetDrawer, AdvanceDrawer } from './cashflow/RowDrawer';

// ─── Management Cash Flow (Phase 1: Brokerage Charges, Rent Expense, Electricity Charges + monthly overview) ───
// Server: server/cashflow (reads Zoho Books only). Every figure opens the transactions behind it.

export default function CashFlow() {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [tab, setTab] = useState('overview');
  const [filters, setFilters] = useState(null);
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);         // { type: 'part'|'budget'|'advance', key|id|pid, obj }
  const [form, setForm] = useState(null);         // budget being added / edited
  const [audit, setAudit] = useState(null);

  const loadMeta = useCallback(() => cf.meta().then(m => {
    setMeta(m);
    setFilters(f => f || { company: 'all', fy: m.current_fy, month: m.current_month, branch: '', vendor: '', mode: 'current' });
    return m;
  }).catch(e => setError(errMsg(e))), []);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  const loadView = useCallback(async () => {
    if (!filters) return;
    setLoading(true);
    try { setView(await cf.view({ company: filters.company, month: filters.month, mode: filters.mode, branch: filters.branch, vendor: filters.vendor })); setError(''); }
    catch (e) { setError(errMsg(e)); }
    finally { setLoading(false); }
  }, [filters]);
  useEffect(() => { loadView(); }, [loadView]);

  // keep the open drawer on the fresh figures after a change
  const openObj = useMemo(() => {
    if (!open || !view) return open?.obj || null;
    if (open.type === 'part') return view.rows.parts.find(p => p.key === open.key && p.company === open.company) || open.obj;
    if (open.type === 'budget') return view.rows.budgets.find(b => b.id === open.id) || open.obj;
    if (open.type === 'advance') return view.rows.advances.find(a => a.pid === open.pid) || open.obj;
    return null;
  }, [open, view]);

  if (error && !meta) return <div style={S.page}><div style={S.error}>{error}</div></div>;
  if (!meta || !filters) return <div style={S.page}><div style={S.center}>Loading…</div></div>;

  const rights = meta.rights;
  const catLabel = k => meta.categories.find(c => c.key === k)?.label || k;
  const setF = patch => setFilters(f => ({ ...f, ...patch }));
  const months = fyMonths(filters.fy);
  const statuses = view?.statuses || meta.status || {};
  const waiting = Object.values(statuses).reduce((s, x) => s + (x?.remaining || 0), 0);
  const lastStep = Object.values(statuses).map(x => x?.last_step_at).filter(Boolean).sort().pop();
  const running = Object.values(statuses).some(x => x?.running_until && Date.parse(x.running_until) > Date.now());
  const openPart = p => setOpen({ type: 'part', key: p.key, company: p.company, obj: p });
  const openBudget = b => (b.advance ? setOpen({ type: 'advance', pid: b.advance.pid, obj: b.advance }) : setOpen({ type: 'budget', id: b.id, obj: b }));
  const changed = async () => { await loadView(); };

  async function refresh(company = filters.company, reloadAccounts = false) {
    setError(''); setOk('');
    try {
      const r = await cf.refresh({ company, reload_accounts: reloadAccounts });
      setOk(`Reading Zoho for about ${Math.round(r.seconds / 60)} minute(s) in the background — the figures update as bills come in. Press Reload in a minute.`);
      setTimeout(() => { loadMeta(); loadView(); }, 15000);
    } catch (e) { setError(errMsg(e)); }
  }
  async function copyBudgets(cat) {
    const from = addMonths(filters.month, -1);
    const company = filters.company === 'all' ? (window.prompt(`Copy for which company? (${meta.companies.map(c => c.id).join(' / ')})`, meta.companies[0].id) || '').trim() : filters.company;
    if (!company) return;
    if (!window.confirm(`Copy ${monthLabel(from)}'s ${catLabel(cat)} budget lines to ${monthLabel(filters.month)}? Lines already there are not copied again.`)) return;
    try { const r = await cf.copyBudgets({ company, from_month: from, to_month: filters.month, category: cat }); setOk(`${r.added} budget line(s) copied to ${longMonth(filters.month)}.`); loadView(); }
    catch (e) { setError(errMsg(e)); }
  }

  const TABS = [['overview', 'Overview'], ...meta.categories.map(c => [c.key, c.label]), ...(rights.config ? [['settings', 'Settings']] : []), ['activity', 'Activity log']];

  return (
    <div style={S.page}>
      <div style={S.topBar}>
        <div>
          <h1 style={S.pageTitle}>Management Cash Flow</h1>
          <p style={S.pageSub}>Planned vs. actual payments by category · Phase 1: Brokerage, Rent and Electricity outflows · data from Zoho Books (read only)</p>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={S.small}>{running ? 'Reading Zoho…' : lastStep ? `Zoho read ${dtm(lastStep)}` : 'Zoho not read yet'}{waiting ? ` · ${waiting} bill(s) waiting` : ''}</span>
          <button type="button" style={S.ghost} onClick={() => { loadMeta(); loadView(); }}><RefreshCw size={12} /> Reload</button>
          {rights.config && <button type="button" style={S.btn} onClick={() => refresh()}><RefreshCw size={12} /> Refresh from Zoho</button>}
          {rights.plan && <button type="button" style={S.primary} onClick={() => setForm({ category: ['brokerage', 'rent', 'electricity'].includes(tab) ? tab : 'rent', planned_month: filters.month, company: filters.company === 'all' ? meta.companies[0].id : filters.company })}><Plus size={13} /> Budget line</button>}
        </div>
      </div>

      <div style={{ ...S.card, padding: '0.6rem 0.9rem', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label><span style={S.label}>Company</span>
          <select style={S.select} value={filters.company} onChange={e => setF({ company: e.target.value, branch: '' })}>
            <option value="all">All companies</option>{meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <label><span style={S.label}>Financial year</span>
          <select style={S.select} value={filters.fy} onChange={e => { const fy = e.target.value; const m = fyMonths(fy).includes(meta.current_month) ? meta.current_month : fyMonths(fy)[0]; setF({ fy, month: m }); }}>
            {meta.fys.map(f => <option key={f} value={f}>FY {f}</option>)}
          </select></label>
        <label><span style={S.label}>Month (planned payment)</span>
          <select style={S.select} value={filters.month} onChange={e => setF({ month: e.target.value, fy: fyOfMonth(e.target.value) })}>
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}{m === meta.current_month ? ' (this month)' : ''}</option>)}
          </select></label>
        <label><span style={S.label}>Branch</span>
          <select style={S.select} value={filters.branch} onChange={e => setF({ branch: e.target.value })}>
            <option value="">All branches</option>{(view?.branches || []).map(b => <option key={b} value={b}>{b}</option>)}
          </select></label>
        <label><span style={S.label}>Vendor</span>
          <input style={{ ...S.input, width: 170 }} defaultValue={filters.vendor} placeholder="Name contains…" onKeyDown={e => { if (e.key === 'Enter') setF({ vendor: e.target.value.trim() }); }} onBlur={e => { if (e.target.value.trim() !== filters.vendor) setF({ vendor: e.target.value.trim() }); }} /></label>
        <div><span style={S.label}>Status</span>
          <div style={{ display: 'flex' }}>
            {[['current', 'Current status'], ['month_end', 'Month-end status']].map(([k, l], i) => (
              <button key={k} type="button" title={k === 'month_end' ? 'Everything as it stood on the last day of the month' : 'As it stands today (payments made after the month show as paid later)'}
                style={{ ...C.pill(filters.mode === k), borderRadius: i ? '0 6px 6px 0' : '6px 0 0 6px', marginLeft: i ? -1 : 0 }} onClick={() => setF({ mode: k })}>{l}</button>
            ))}
          </div>
        </div>
        {loading && <span style={S.small}>Loading…</span>}
      </div>

      <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />
      {view && !view.coa_ready && <div style={S.notice}>Zoho has not been read yet for {(view.coa_missing || []).join(', ') || 'a company'}, so its bills are not in these figures yet. {meta.vercel ? 'Reading starts by itself every 15 minutes; the first full read of the year takes a few hours.' : 'Reading starts by itself every 30 minutes.'}{rights.config ? ' Press Refresh from Zoho to start now.' : ''}</div>}
      {view && view.coa_ready && waiting > 0 && <div style={S.notice}>{waiting} bill(s) are still being read from Zoho; the figures fill in as they arrive{meta.vercel ? ' (every 15 minutes, or press Refresh from Zoho)' : ''}.</div>}

      <div style={S.tabs}>{TABS.map(([k, l]) => <button key={k} type="button" style={S.tab(tab === k)} onClick={() => { setTab(k); if (k === 'activity') cf.audit(filters.month).then(setAudit).catch(e => setError(errMsg(e))); }}>{l}</button>)}</div>

      {!view && tab !== 'settings' && tab !== 'activity' && <div style={S.center}>{loading ? 'Loading…' : 'No data.'}</div>}
      {view && tab === 'overview' && <Overview view={view} categories={meta.categories} onOpenPart={openPart} onOpenBudget={openBudget} onTab={setTab} />}
      {view && meta.categories.some(c => c.key === tab) && (
        <CategoryTab key={tab} cat={tab} catLabel={catLabel(tab)} view={view} meta={meta} filters={filters} rights={rights}
          onOpenPart={openPart} onOpenBudget={openBudget} copyBudgets={copyBudgets}
          onAddBudget={cat => setForm({ category: cat, planned_month: filters.month, company: filters.company === 'all' ? meta.companies[0].id : filters.company })} />
      )}
      {tab === 'settings' && rights.config && <SettingsTab meta={meta} onRefresh={refresh} reloadMeta={loadMeta} />}
      {tab === 'activity' && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Activity log — {audit ? longMonth(audit.month) : ''}</span></div>
          <div style={{ ...S.cardBody, maxHeight: 520, overflow: 'auto' }}>
            {!audit && <div style={S.center}>Loading…</div>}
            {audit && !audit.entries.length && <div style={S.muted}>Nothing recorded this month.</div>}
            {audit?.entries.map((a, i) => <div key={i} style={{ fontSize: '0.76rem', borderBottom: '1px solid #F2F2F2', padding: '3px 0' }}><span style={S.small}>{dtm(a.at)}</span> · <b>{a.by}</b> · {a.action.replace(/_/g, ' ')} — {a.detail}</div>)}
          </div>
        </div>
      )}

      {open?.type === 'part' && openObj && <PartDrawer key={open.key} part={openObj} meta={meta} rights={rights} catLabel={catLabel(openObj.category)} onClose={() => setOpen(null)} onChanged={changed} />}
      {open?.type === 'budget' && openObj && view && <BudgetDrawer key={open.id} budget={openObj} view={view} meta={meta} rights={rights} catLabel={catLabel(openObj.category)} onClose={() => setOpen(null)} onChanged={changed} onOpenPart={openPart} onEdit={b => setForm(b)} />}
      {open?.type === 'advance' && openObj && <AdvanceDrawer key={open.pid} advance={openObj} rights={rights} categories={meta.categories} onClose={() => setOpen(null)} onChanged={changed} />}
      {form && <BudgetForm meta={meta} initial={form} branches={view?.branches} onClose={() => setForm(null)} onSaved={() => { setForm(null); setOk('Budget line saved.'); loadView(); }} />}
    </div>
  );
}
