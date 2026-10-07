import React from 'react';
import {
  TrendingUp, ShoppingCart, Receipt, Percent,
  Landmark, Users, ShieldCheck, BarChart3,
  ChevronLeft, ChevronRight, GitMerge, ClipboardList,
  Settings, LogOut, CreditCard, TrendingDown, Inbox, Activity, BookOpen, Target, BadgeCheck, RefreshCw, Layers, CheckSquare,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const NAV = [
  { id: 'fpa',          label: 'FP&A — Financial Model', icon: Layers,        live: true,  module: 'fpa'         },
  { id: 'fpa-step15d',  label: '⚙ Baseline Closure',     icon: Target,        live: true,  module: 'fpa',  sub: true },
  { id: 'fpa-step15f',  label: '✓ CFO Approval',          icon: CheckSquare,   live: true,  module: 'fpa',  sub: true },
  { id: 'fpa-step15g',  label: '⚡ Mgmt Closure',         icon: Activity,      live: true,  module: 'fpa',  sub: true },
  { id: 'fpa-step15h',  label: '📋 Mgmt Inputs',          icon: ClipboardList, live: true,  module: 'fpa',  sub: true },
  null,
  { id: 'finance-overview', label: 'Finance Overview',     icon: BarChart3,    live: true,  module: 'sales'       },
  { id: 'sales',        label: 'Sales & Receivables',  icon: TrendingUp,   live: true,  module: 'sales'       },
  { id: 'purchase',     label: 'Purchase & Payables',   icon: ShoppingCart, live: true,  module: 'purchase'        },
  { id: 'msme',         label: 'MSME Compliance',       icon: BadgeCheck,   live: true,  module: 'msme_compliance', sub: true },
  { id: 'vendor-regs',  label: 'Vendor Registrations',  icon: ClipboardList,live: true,  module: 'vendor_regs',    sub: true },
  { id: 'rpt',          label: 'Related Party Txns',    icon: GitMerge,     live: true,  module: 'rpt'         },
  null,
  { id: 'gst',          label: 'GST Dashboard',         icon: Receipt,      live: true,  module: 'gst' },
  { id: 'tds',          label: 'TDS Dashboard',         icon: Percent,      live: true,  module: 'tds' },
  { id: 'banking',      label: 'Banking Dashboard',     icon: Landmark,     live: false },
  { id: 'payroll',      label: 'Payroll Dashboard',     icon: Users,        live: true,  module: 'payroll' },
  { id: 'compliance',   label: 'Compliance Dashboard',  icon: ShieldCheck,  live: true,  module: 'compliance' },
  { id: 'fin-stmt',     label: 'Financial Statements',  icon: BookOpen,     live: true,  module: 'fin_stmt'    },
  { id: 'budget',       label: 'Budget vs. Actual',     icon: Target,       live: true,  module: 'budget'      },
  { id: 'loan',         label: 'Loan Module',           icon: CreditCard,   live: true,  module: 'loan'        },
  { id: 'pocm',         label: 'POCM Dashboard',        icon: TrendingDown, live: true,  module: 'pocm'        },
  { id: 'portal',       label: 'Finance Portal',        icon: Inbox,        live: true,  module: 'portal'      },
  { id: 'activity',     label: 'Activity Tracker',      icon: Activity,     live: true,  module: 'activity'    },
  { id: 'financial',    label: 'Financial Dashboard',   icon: BarChart3,    live: false },
];

export default function Sidebar({ page, onNavigate, open, onToggle }) {
  const { user, logout, hasModule } = useAuth();

  const visibleNav = NAV.map(item => {
    if (!item) return null;
    if (!item.live) return item;
    if (item.module && !hasModule(item.module)) return null;
    return item;
  });

  const cleanNav = visibleNav.filter((item, i, arr) => {
    if (item !== null) return true;
    const prev = arr[i - 1];
    const next = arr[i + 1];
    return prev !== null && prev !== undefined && next !== null && next !== undefined;
  });

  return (
    <div style={{ ...S.sidebar, width: open ? 240 : 60 }}>

      {/* Brand */}
      <div style={S.brand}>
        <div style={S.logo}>
          <span style={{ fontSize: '0.75rem', fontWeight: 800, color: '#fff', letterSpacing: '0.03em' }}>DA</span>
        </div>
        {open && (
          <div style={{ overflow: 'hidden' }}>
            <div style={S.brandName}>Dev Accelerator</div>
            <div style={S.brandSub}>Finance Suite</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav style={S.nav}>
        {cleanNav.map((item, i) => {
          if (!item) return <div key={i} style={S.divider} />;
          const Icon = item.icon;
          const active = page === item.id;
          return (
            <button
              key={item.id}
              title={!open ? item.label : undefined}
              onClick={() => item.live && onNavigate(item.id)}
              style={{
                ...S.navBtn,
                ...(active ? S.navBtnActive : {}),
                ...(!item.live ? S.navBtnDisabled : {}),
                padding: open ? (item.sub ? '0.45rem 1.1rem 0.45rem 2rem' : '0.6rem 1.1rem') : '0.6rem',
                justifyContent: open ? 'flex-start' : 'center',
              }}
            >
              <Icon
                size={18} style={{ flexShrink: 0 }}
                color={active ? '#EAF4EF' : item.live ? '#8BAAA6' : '#2d4a47'}
              />
              {open && (
                <>
                  <span style={{ ...S.navLabel, color: active ? '#FFFFFF' : item.live ? '#A8C4C0' : '#3d6a66' }}>
                    {item.label}
                  </span>
                  {!item.live && <span style={S.soonBadge}>Soon</span>}
                </>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom: user + admin + logout */}
      <div style={S.bottom}>
        {open && user && (
          <div style={S.userBadge}>
            <div style={S.userAvatar}>{(user.name || user.username)[0].toUpperCase()}</div>
            <div style={{ overflow: 'hidden' }}>
              <div style={S.userName}>{user.name || user.username}</div>
              <div style={S.userRole}>{user.role === 'admin' ? '⚡ Admin' : '👤 User'}</div>
            </div>
          </div>
        )}

        {user?.role === 'admin' && (
          <button
            style={{ ...S.navBtn, padding: open ? '0.55rem 1.1rem' : '0.55rem', justifyContent: open ? 'flex-start' : 'center', ...(page === 'sync-monitor' ? S.navBtnActive : {}) }}
            onClick={() => onNavigate('sync-monitor')}
            title={!open ? 'Sync Monitor' : undefined}
          >
            <RefreshCw size={16} color={page === 'sync-monitor' ? '#EAF4EF' : '#5a8a86'} style={{ flexShrink: 0 }} />
            {open && <span style={{ ...S.navLabel, color: page === 'sync-monitor' ? '#FFFFFF' : '#8BAAA6', fontSize: '0.79rem' }}>Sync Monitor</span>}
          </button>
        )}

        {user?.role === 'admin' && (
          <button
            style={{ ...S.navBtn, padding: open ? '0.55rem 1.1rem' : '0.55rem', justifyContent: open ? 'flex-start' : 'center', ...(page === 'admin' ? S.navBtnActive : {}) }}
            onClick={() => onNavigate('admin')}
            title={!open ? 'User Settings' : undefined}
          >
            <Settings size={16} color={page === 'admin' ? '#EAF4EF' : '#5a8a86'} style={{ flexShrink: 0 }} />
            {open && <span style={{ ...S.navLabel, color: page === 'admin' ? '#FFFFFF' : '#8BAAA6', fontSize: '0.79rem' }}>User Settings</span>}
          </button>
        )}

        <button
          style={{ ...S.navBtn, padding: open ? '0.55rem 1.1rem' : '0.55rem', justifyContent: open ? 'flex-start' : 'center' }}
          onClick={logout}
          title={!open ? 'Sign Out' : undefined}
        >
          <LogOut size={16} color="#5a8a86" style={{ flexShrink: 0 }} />
          {open && <span style={{ ...S.navLabel, color: '#8BAAA6', fontSize: '0.79rem' }}>Sign Out</span>}
        </button>

        <button style={{ ...S.toggleBtn, justifyContent: open ? 'flex-end' : 'center' }} onClick={onToggle}>
          {open ? <ChevronLeft size={16} color="#5a8a86" /> : <ChevronRight size={16} color="#5a8a86" />}
          {open && <span style={{ fontSize: '0.72rem', color: '#5a8a86', marginRight: 2 }}>Collapse</span>}
        </button>
      </div>

    </div>
  );
}

const S = {
  sidebar: {
    position: 'fixed', left: 0, top: 0, bottom: 0,
    background: '#001214',
    borderRight: '1px solid #002B31',
    display: 'flex', flexDirection: 'column',
    transition: 'width 0.2s ease',
    zIndex: 200,
    overflow: 'hidden',
  },
  brand: {
    display: 'flex', alignItems: 'center', gap: '0.65rem',
    padding: '1.1rem 0.85rem 0.9rem',
    borderBottom: '1px solid #002B31',
    whiteSpace: 'nowrap', overflow: 'hidden', flexShrink: 0,
  },
  logo: {
    width: 34, height: 34, flexShrink: 0,
    background: '#1C4942',
    borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid #2D6B62',
  },
  brandName: { color: '#E8F4F2', fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.3 },
  brandSub:  { color: '#4A7A76', fontSize: '0.68rem', marginTop: 1 },
  nav: { flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '0.4rem 0' },
  divider: { height: 1, background: '#002B31', margin: '0.4rem 0.75rem' },
  navBtn: {
    display: 'flex', alignItems: 'center', gap: '0.65rem',
    width: '100%', background: 'none',
    border: 'none', borderLeft: '3px solid transparent',
    cursor: 'pointer', textAlign: 'left',
    transition: 'background 0.12s',
    whiteSpace: 'nowrap', overflow: 'hidden',
  },
  navBtnActive: { background: '#1C4942', borderLeft: '3px solid #EAF4EF' },
  navBtnDisabled: { cursor: 'default' },
  navLabel: { flex: 1, fontSize: '0.81rem', overflow: 'hidden', textOverflow: 'ellipsis' },
  soonBadge: {
    fontSize: '0.6rem', background: '#002B31', color: '#3d6a66',
    padding: '1px 5px', borderRadius: 3, border: '1px solid #004A55', flexShrink: 0,
  },
  bottom: { borderTop: '1px solid #002B31', flexShrink: 0 },
  userBadge: {
    display: 'flex', alignItems: 'center', gap: '0.55rem',
    padding: '0.65rem 0.85rem', borderBottom: '1px solid #002B31',
    overflow: 'hidden',
  },
  userAvatar: {
    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
    background: '#1C4942',
    border: '1px solid #2D6B62',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '0.72rem', fontWeight: 700, color: '#EAF4EF',
  },
  userName: { color: '#A8C4C0', fontSize: '0.78rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  userRole: { color: '#4A7A76', fontSize: '0.68rem', marginTop: 1 },
  toggleBtn: {
    display: 'flex', alignItems: 'center', gap: '0.4rem',
    padding: '0.65rem 0.85rem',
    background: 'none', border: 'none', borderTop: '1px solid #002B31',
    cursor: 'pointer', color: '#4A7A76', width: '100%', flexShrink: 0,
  },
};
