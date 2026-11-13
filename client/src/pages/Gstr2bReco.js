import React, { useState, useEffect, useCallback } from 'react';
import { g, errMsg } from './gstr2b/gApi';
import { S } from './gstr2b/ui';
import FilterBar from './gstr2b/FilterBar';
import OverviewTab from './gstr2b/OverviewTab';
import WorkbenchTab from './gstr2b/WorkbenchTab';
import VendorsTab from './gstr2b/VendorsTab';
import ItcTab from './gstr2b/ItcTab';
import ImportsTab from './gstr2b/ImportsTab';
import SettingsTab from './gstr2b/SettingsTab';

// ─── GSTR-2B Reco ─────────────────────────────────────────────────────────────
// Books (Zoho Books, read-only) × GSTR-2B statements (GST portal JSON / Excel uploads) per recipient GSTIN → reconciliation
// the finance team reviews. Server: server/gstr2b/. Reconciliation status is NOT ITC eligibility (ITC register: Phase 2).

const TABS = [
  { id: 'overview',  label: 'Overview' },
  { id: 'workbench', label: 'Reconciliation workbench' },
  { id: 'books',     label: 'Books only' },
  { id: 'portal',    label: 'GSTR-2B only' },
  { id: 'review',    label: 'Mismatch & duplicate review' },
  { id: 'vendors',   label: 'Vendor summary' },
  { id: 'itc',       label: 'ITC register' },
  { id: 'imports',   label: 'Imports & sync' },
  { id: 'settings',  label: 'Settings & audit' },
];
const SCOPED = ['overview', 'workbench', 'books', 'portal', 'review', 'vendors'];
const FILTER_KEY = 'g2b_filters';
const readSession = (k, d) => { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch (_) { return d; } };

export default function Gstr2bReco() {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(() => readSession('g2b_tab', 'overview'));
  const [filters, setFilters] = useState(() => readSession(FILTER_KEY, { company: 'all' }));
  const [drill, setDrill] = useState(null);                       // filters chosen by clicking a figure; applied on top of the scope
  const [stamp, setStamp] = useState(0);                          // bumps when data changes elsewhere, so lists reload

  const loadMeta = useCallback(() => g.meta().then(m => { setMeta(m); setError(''); }).catch(e => setError(errMsg(e))), []);
  useEffect(() => { loadMeta(); }, [loadMeta]);
  // Keep the Books data fresh while the module is open: every few minutes the server is asked whether a sync step is due — a change check,
  // or the rest of a sync that is still going (POST /sync/kick). Online such a step runs inside that request, so it is simply left to
  // finish; when it says there is more, the next one follows at once. The scheduler does the same when nobody has the module open.
  const realIds = meta ? meta.companies.filter(c => !c.demo && c.active !== false).map(c => c.id).join(',') : '';
  useEffect(() => {
    if (!realIds) return undefined;
    let stop = false, timer = null;
    const round = async () => {
      let again = false;
      for (const id of realIds.split(',')) {
        if (stop) return;
        try { const r = await g.syncKick(id); if (r.ran && r.fetched > 0) setStamp(s => s + 1); if (r.ran && r.more) again = true; } catch (_) { /* tried again at the next round */ }
      }
      if (!stop) timer = setTimeout(round, again ? 2000 : 4 * 60000);
    };
    timer = setTimeout(round, 1500);
    return () => { stop = true; clearTimeout(timer); };
  }, [realIds]);
  useEffect(() => { try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch (_) { /* optional */ } }, [filters]);
  const go = id => { setTab(id); try { sessionStorage.setItem('g2b_tab', id); } catch (_) { /* optional */ } };
  const onDrill = (extra, to = 'workbench') => { setDrill(extra); go(to); };
  const changed = () => setStamp(s => s + 1);

  if (!meta) {
    return <div style={S.page}><h2 style={S.pageTitle}>GSTR-2B Reco</h2>{error ? <div style={{ ...S.error, marginTop: 12 }}>{error}</div> : <div style={S.center}>Loading…</div>}</div>;
  }
  const current = TABS.some(t => t.id === tab) ? tab : 'overview';
  const company = meta.companies.find(c => c.id === filters.company);
  const demoOnly = meta.companies.length > 0 && meta.companies.every(c => c.demo);
  const showDemo = (company && company.demo) || (filters.company === 'all' && meta.companies.some(c => c.demo));
  const empty = meta.companies.length === 0;
  const effective = drill ? { ...filters, ...drill } : filters;

  return (
    <div style={S.page}>
      <div style={S.topBar}>
        <div>
          <h2 style={S.pageTitle}>GSTR-2B Reco</h2>
          <p style={S.pageSub}>Books in Zoho (read-only) against GSTR-2B from the GST portal, per recipient GSTIN. Reconciliation status is not ITC eligibility.</p>
        </div>
        <div style={S.muted}>Zoho access: {meta.integrations.zoho}{meta.integrations.zoho_dedicated ? '' : ' (shared — a dedicated read-only token is recommended)'}</div>
      </div>
      {showDemo && <div style={S.demo}>{company && company.demo ? 'DEMO DATA — ' : 'Includes DEMO DATA — '}synthetic suppliers, invoices and statements. Nothing here came from Zoho Books or the GST portal. Remove it in Settings → Demo data.</div>}
      {empty && (
        <div style={S.notice}>
          <b>Nothing is set up yet.</b> Open <b>Settings &amp; audit → Companies &amp; GSTINs</b> to connect a Zoho organisation and confirm its GSTINs and branches
          {meta.rights.admin ? ', or load the synthetic demo data to try the screens first.' : '.'}
        </div>
      )}
      {demoOnly && !empty && <div style={S.info}>Only the demo company is set up. Add your real companies in Settings → Companies &amp; GSTINs.</div>}
      <div style={S.tabs}>{TABS.map(t => <button key={t.id} style={S.tab(current === t.id)} onClick={() => { go(t.id); if (!['workbench', 'books', 'portal', 'review'].includes(t.id)) setDrill(null); }}>{t.label}</button>)}</div>

      {SCOPED.includes(current) && !empty && <FilterBar meta={meta} filters={filters} setFilters={f => { setFilters(f); setDrill(null); }} />}
      {drill && SCOPED.includes(current) && (
        <div style={S.info}>Showing: {Object.entries(drill).map(([k, v]) => `${k.replace('_', ' ')} = ${v}`).join(' · ')} <button style={{ ...S.ghost, marginLeft: 8, padding: '0.15rem 0.55rem' }} onClick={() => setDrill(null)}>Show everything in scope</button></div>
      )}

      {/* `stamp` makes a tab re-read its data after a change elsewhere; the tab itself is kept, so its messages and selections survive */}
      {current === 'overview' && <OverviewTab stamp={stamp} meta={meta} filters={effective} onDrill={onDrill} onChanged={changed} />}
      {current === 'workbench' && <WorkbenchTab key="w" stamp={stamp} meta={meta} filters={effective} onChanged={changed} title="Reconciliation workbench" />}
      {current === 'books' && <WorkbenchTab key="b" stamp={stamp} meta={meta} filters={{ ...effective, queue: 'books_only' }} onChanged={changed} title="Books only — in Zoho, not in GSTR-2B" queue="books_only" />}
      {current === 'portal' && <WorkbenchTab key="p" stamp={stamp} meta={meta} filters={{ ...effective, queue: 'portal_only' }} onChanged={changed} title="GSTR-2B only — reported by the supplier, not in Books" queue="portal_only" />}
      {current === 'review' && <WorkbenchTab key="r" stamp={stamp} meta={meta} filters={{ ...effective, queue: 'review' }} onChanged={changed} title="Mismatches, suggested matches and duplicates" queue="review" />}
      {current === 'vendors' && <VendorsTab stamp={stamp} meta={meta} filters={effective} onDrill={onDrill} />}
      {current === 'itc' && <ItcTab meta={meta} />}
      {current === 'imports' && <ImportsTab stamp={stamp} meta={meta} filters={filters} onChanged={() => { changed(); loadMeta(); }} />}
      {current === 'settings' && <SettingsTab meta={meta} reloadMeta={() => { loadMeta(); changed(); }} />}
    </div>
  );
}
