import React, { useState } from 'react';
import { Percent, BarChart2, FileText, GitMerge } from 'lucide-react';
import TDSPayableDashboard from './TDSPayableDashboard';
import TDSReturnDashboard from './TDSReturnDashboard';
import TDSKPIOverview from '../components/TDSKPIOverview';

// ─── Module registry — add new dashboards here in the future ─────────────────
const MODULES = [
  {
    id:    'payable',
    label: 'TDS Payable Dashboard',
    icon:  BarChart2,
    desc:  'Section-wise deduction, deposit & challan tracking',
  },
  {
    id:    'reconciliation',
    label: 'Reconciliation Tool',
    icon:  GitMerge,
    desc:  'TRACES conso vs Books matching at Section / PAN level',
  },
  {
    id:    'returns',
    label: 'TDS Return Dashboard',
    icon:  FileText,
    desc:  'Quarterly 24Q / 26Q filing, Form 16A & corrections',
  },
];

// ─── Landing screen shown when no module is selected ─────────────────────────
function LandingScreen({ onSelect }) {
  return (
    <div style={L.root}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={L.header}>
        <div style={L.icon}>
          <Percent size={28} color="#1C4942" />
        </div>
        <div>
          <h2 style={L.heading}>TDS Dashboard</h2>
          <p style={L.sub}>Dev Accelerator Ltd · TDS Control Centre</p>
        </div>
      </div>

      {/* ── Module cards ───────────────────────────────────────────────────── */}
      <div style={L.sectionLabel}>MODULES</div>
      <div style={L.cards}>
        {MODULES.map(mod => {
          const Icon = mod.icon;
          return (
            <button key={mod.id} onClick={() => onSelect(mod.id)} style={L.card}>
              <div style={L.cardIcon}>
                <Icon size={18} color="#1C4942" />
              </div>
              <div style={L.cardText}>
                <div style={L.cardLabel}>{mod.label}</div>
                <div style={L.cardDesc}>{mod.desc}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Divider ────────────────────────────────────────────────────────── */}
      <div style={L.divider} />

      {/* ── KPI Overview ───────────────────────────────────────────────────── */}
      <div style={L.sectionLabel}>KPI OVERVIEW</div>
      <TDSKPIOverview />

    </div>
  );
}

// ─── Main TDS Dashboard ───────────────────────────────────────────────────────
export default function TDSDashboard() {
  const [active, setActive] = useState(null);   // null = no module selected
  const [hover,  setHover]  = useState(null);

  return (
    <div style={S.shell}>

      {/* ── Left navigation panel ──────────────────────────────────────────── */}
      <nav style={S.nav}>

        {/* Panel header */}
        <div style={S.navHeader}>
          <div style={S.navIcon}>
            <Percent size={14} color="#fff" />
          </div>
          <div>
            <div style={S.navTitle}>TDS Dashboard</div>
            <div style={S.navSub}>Dev Accelerator Ltd</div>
          </div>
        </div>

        {/* Section label */}
        <div style={S.sectionLabel}>MODULES</div>

        {/* Nav items */}
        <div style={S.navItems}>
          {MODULES.map(mod => {
            const Icon     = mod.icon;
            const isActive = active === mod.id;
            const isHover  = hover  === mod.id && !isActive;
            return (
              <button
                key={mod.id}
                onClick={() => setActive(mod.id)}
                onMouseEnter={() => setHover(mod.id)}
                onMouseLeave={() => setHover(null)}
                style={{
                  ...S.navItem,
                  ...(isActive ? S.navItemActive : {}),
                  ...(isHover  ? S.navItemHover  : {}),
                }}
                title={mod.desc}
              >
                <Icon
                  size={16}
                  style={{ flexShrink: 0 }}
                  color={isActive ? '#1C4942' : isHover ? '#9BA8B0' : '#5D6C7B'}
                />
                <span style={{ ...S.navItemLabel, color: isActive ? '#18191B' : isHover ? '#5D6C7B' : '#9BA8B0' }}>
                  {mod.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* ── Right content area ─────────────────────────────────────────────── */}
      <main style={S.main}>
        {active === null && <LandingScreen onSelect={setActive} />}

        {active === 'reconciliation' && (
          <iframe
            src="/tds.html"
            title="TDS Reconciler"
            style={S.iframe}
          />
        )}

        {active === 'payable'  && <TDSPayableDashboard />}
        {active === 'returns'  && <TDSReturnDashboard />}
      </main>

      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
      `}</style>
    </div>
  );
}

// ─── Layout styles ────────────────────────────────────────────────────────────
const S = {
  shell: {
    display: 'flex',
    height: '100vh',
    overflow: 'hidden',
    background: '#F9F9F9',
    fontFamily: "'Figtree', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  },

  // ── Left nav panel ──────────────────────────────────────────────────────────
  nav: {
    width: 192,                      // compact — icon + label only
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: '#FFFFFF',
    borderRight: '1px solid #DFE7E3',
    overflowY: 'auto',
    overflowX: 'hidden',
  },

  navHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0.85rem 0.85rem 0.75rem',
    borderBottom: '1px solid #DFE7E3',
    flexShrink: 0,
  },

  navIcon: {
    width: 28, height: 28, borderRadius: 7, flexShrink: 0,
    background: 'linear-gradient(135deg, #1C4942 0%, #8b5cf6 100%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  navTitle: {
    color: '#18191B', fontSize: '0.8rem', fontWeight: 700, lineHeight: 1.3,
    whiteSpace: 'nowrap',
  },

  navSub: {
    color: '#9BA8B0', fontSize: '0.66rem', marginTop: 1,
    whiteSpace: 'nowrap',
  },

  sectionLabel: {
    padding: '0.85rem 0.85rem 0.35rem',
    fontSize: '0.6rem', fontWeight: 700,
    letterSpacing: '0.08em', textTransform: 'uppercase',
    color: '#9BA8B0', userSelect: 'none',
    flexShrink: 0,
  },

  navItems: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    padding: '0 0.35rem',
    flex: 1,
  },

  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0.5rem 0.65rem',
    borderRadius: 6,
    border: 'none',
    borderLeft: '2px solid transparent',
    background: 'none',
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
    transition: 'background 0.12s, border-color 0.12s',
    boxSizing: 'border-box',
  },

  navItemActive: {
    background: '#EAF4EF',
    borderLeft: '2px solid #1C4942',
  },

  navItemHover: {
    background: 'rgba(255,255,255,0.035)',
  },

  navItemLabel: {
    fontSize: '0.8rem',
    fontWeight: 500,
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  // ── Right content area ───────────────────────────────────────────────────────
  main: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    minWidth: 0,
    background: '#F9F9F9',
  },

  iframe: {
    width: '100%',
    height: '100vh',
    border: 'none',
    display: 'block',
  },
};

// ─── Landing screen styles ────────────────────────────────────────────────────
const L = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    padding: '2rem 2.5rem',
    boxSizing: 'border-box',
    maxWidth: 1100,
    width: '100%',
    margin: '0 auto',
  },

  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    marginBottom: '1.5rem',
  },

  icon: {
    width: 52, height: 52,
    borderRadius: 14,
    background: '#EAF4EF',
    border: '1px solid #DFE7E3',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },

  heading: {
    margin: 0,
    color: '#18191B',
    fontSize: '1.25rem',
    fontWeight: 700,
  },

  sub: {
    margin: '3px 0 0',
    color: '#5D6C7B',
    fontSize: '0.8rem',
  },

  sectionLabel: {
    fontSize: '0.62rem',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#9BA8B0',
    marginBottom: '0.65rem',
    userSelect: 'none',
  },

  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '0.65rem',
    width: '100%',
    marginBottom: 0,
  },

  divider: {
    height: 1,
    background: '#DFE7E3',
    margin: '1.5rem 0 1.25rem',
  },

  card: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '0.85rem 1rem',
    background: '#FFFFFF',
    border: '1px solid #DFE7E3',
    borderRadius: 10,
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
    transition: 'border-color 0.15s, background 0.15s',
    fontFamily: "'Figtree', 'Inter', -apple-system, sans-serif",
  },

  cardIcon: {
    width: 34, height: 34, borderRadius: 8, flexShrink: 0,
    background: '#EAF4EF',
    border: '1px solid #DFE7E3',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginTop: 1,
  },

  cardText: {
    display: 'flex', flexDirection: 'column', gap: 3,
  },

  cardLabel: {
    color: '#18191B', fontSize: '0.84rem', fontWeight: 600,
  },

  cardDesc: {
    color: '#5D6C7B', fontSize: '0.74rem', lineHeight: 1.4,
  },
};
