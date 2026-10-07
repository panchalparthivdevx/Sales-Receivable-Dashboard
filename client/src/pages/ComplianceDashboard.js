import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, LayoutDashboard, Database } from 'lucide-react';
import { T } from '../theme';
import { capi, errSync } from './compliance/complianceApi';
import { S, PAGE_CSS, Spinner, ErrorBox } from './compliance/ui';
import DashboardTab from './compliance/DashboardTab';
import MasterTab, { MASTER_SECTIONS } from './compliance/MasterTab';

// ─── Compliance Dashboard ─────────────────────────────────────────────────────
// Two parts: Dashboard (period-filtered tracker) and Master (setup, import, admin).
// Modules (GST, Payroll, TDS …) come from Master > Lists / Settings — nothing here is
// specific to one module, so new modules need only master data / config.

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'master',    label: 'Master',    icon: Database },
];

export default function ComplianceDashboard() {
  const [meta, setMeta]       = useState(null);
  const [error, setError]     = useState('');
  const [tab, setTab]         = useState('dashboard');
  const [section, setSection] = useState('companies');

  const loadMeta = useCallback(async () => {
    setError('');
    try { setMeta(await capi.meta()); }
    catch (e) { setError(errSync(e)); }
  }, []);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  // Status colours come from the editable config (falls back to the theme)
  const colors = useMemo(() => {
    const c = { ...T.status };
    for (const s of meta?.settings?.statuses || []) if (s.color) c[s.key] = s.color;
    return c;
  }, [meta]);

  const sectionLabel = MASTER_SECTIONS.find(s => s.id === section)?.label;

  return (
    <div className="cmp-page" style={S.page}>
      <style>{PAGE_CSS}</style>

      {/* Header */}
      <div style={S.crumbs}>
        Finance Suite <span style={{ margin: '0 4px' }}>›</span> Compliance Dashboard
        <span style={{ margin: '0 4px' }}>›</span> {tab === 'dashboard' ? 'Dashboard' : `Master › ${sectionLabel}`}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: '1.1rem' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: T.primarySoft, border: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <ShieldCheck size={20} color={T.primary} />
          </div>
          <div>
            <h1 style={S.h1}>Compliance Dashboard</h1>
            <p style={S.sub}>
              Statutory compliance tracker for {meta ? meta.settings.modules.map(m => m.label).join(', ') : 'GST, Payroll and TDS'} — tasks, due dates, documents and Zoho Books period data for one selected period at a time.
            </p>
          </div>
        </div>
        {meta && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span title={Object.entries(meta.me.flags).filter(([, v]) => v).map(([k]) => k.replace('_', ' ')).join(', ') || 'view only'}
              style={{ fontSize: '0.72rem', color: T.primary, background: T.primarySoft, border: `1px solid ${T.border}`, borderRadius: 12, padding: '3px 10px', fontWeight: 600 }}>
              {meta.me.name} · {meta.me.role_label}{meta.me.companies.length ? ` · ${meta.me.companies.length} compan${meta.me.companies.length === 1 ? 'y' : 'ies'}` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ ...S.tabs, marginBottom: '1.1rem' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ ...S.tab(tab === t.id), display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {!meta && !error && <Spinner label="Loading Compliance Dashboard…" />}
      {error && <ErrorBox error={error} onRetry={loadMeta} />}

      {meta && tab === 'dashboard' && <DashboardTab meta={meta} colors={colors} />}
      {meta && tab === 'master' && (
        <MasterTab meta={meta} colors={colors} section={section} onSection={setSection} onMetaChange={loadMeta} />
      )}
    </div>
  );
}
