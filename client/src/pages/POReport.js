import React, { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import { formatINR } from '../utils/format';

// ── Status config (mirrors actual Zoho Books India PO statuses) ───────────────
const STATUS_LABEL = {
  draft:            'Draft',
  pending_approval: 'Pending Approval',
  approved:         'Approved',
  open:             'Issued / Open',
  accepted:         'Accepted',
  billed:           'Billed',
  partially_billed: 'Partly Billed',
  closed:           'Closed',
  void:             'Void',
  cancelled:        'Cancelled',
  rejected:         'Rejected',
};
const STATUS_COLOR = {
  draft:            '#64748b',
  pending_approval: '#a78bfa',
  approved:         '#3b82f6',
  open:             '#06b6d4',
  accepted:         '#22d3ee',
  billed:           '#10b981',
  partially_billed: '#f59e0b',
  closed:           '#475569',
  void:             '#ef4444',
  cancelled:        '#dc2626',
  rejected:         '#f43f5e',
};
const STATUS_BG = {
  draft:            'rgba(100,116,139,0.15)',
  pending_approval: 'rgba(167,139,250,0.12)',
  approved:         'rgba(59,130,246,0.12)',
  open:             'rgba(6,182,212,0.12)',
  accepted:         'rgba(34,211,238,0.12)',
  billed:           'rgba(16,185,129,0.12)',
  partially_billed: 'rgba(245,158,11,0.12)',
  closed:           'rgba(71,85,105,0.15)',
  void:             'rgba(239,68,68,0.12)',
  cancelled:        'rgba(220,38,38,0.12)',
  rejected:         'rgba(244,63,94,0.12)',
};
// Display order for status summary cards
const ALL_STATUSES = ['draft','pending_approval','approved','open','accepted','partially_billed','billed','closed','void','cancelled','rejected'];
// Statuses where a 90+ day PO warrants an alert
const ALERT_STATUSES = ['draft','pending_approval','approved','open','accepted','partially_billed'];

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const label = STATUS_LABEL[status] || status;
  const color = STATUS_COLOR[status] || '#64748b';
  const bg    = STATUS_BG[status]    || 'rgba(100,116,139,0.15)';
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: '0.71rem', fontWeight: 600, letterSpacing: '0.02em',
      background: bg, color, border: `1px solid ${color}40`,
      whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// ── 90-day alert chip ─────────────────────────────────────────────────────────
function AlertChip({ days }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px',
      borderRadius: 4, marginLeft: 5, background: 'rgba(239,68,68,0.15)',
      color: '#ef4444', fontSize: '0.68rem', fontWeight: 700,
      border: '1px solid rgba(239,68,68,0.3)',
    }}>⚠ {days}d</span>
  );
}

// ── Project group row ─────────────────────────────────────────────────────────
function ProjectGroup({ project, pos, isOpen, onToggle }) {
  const total      = pos.reduce((s, p) => s + p.total, 0);
  const alertCount = pos.filter(p => p.is_alert).length;

  // Sort: alert POs first, then by days_since desc
  const sorted = [...pos].sort((a, b) => {
    if (b.is_alert !== a.is_alert) return b.is_alert ? 1 : -1;
    return b.days_since - a.days_since;
  });

  return (
    <div style={{ borderBottom: '1px solid #DFE7E3' }}>
      {/* Project header */}
      <div style={S.projHdr} onClick={onToggle}>
        <span style={{ color: '#5D6C7B', fontSize: '0.72rem', flexShrink: 0 }}>
          {isOpen ? '▼' : '▶'}
        </span>
        <span style={S.projName}>{project}</span>
        <span style={S.projMeta}>{pos.length} PO{pos.length !== 1 ? 's' : ''}</span>
        {alertCount > 0 && (
          <span style={S.projAlertBadge}>
            ⚠ {alertCount} alert{alertCount > 1 ? 's' : ''}
          </span>
        )}
        <span style={S.projTotal}>{formatINR(total)}</span>
      </div>

      {/* PO table */}
      {isOpen && (
        <div style={{ overflowX: 'auto' }}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>PO Number</th>
                <th style={S.th}>Vendor</th>
                <th style={S.th}>Status</th>
                <th style={S.th}>PO Date</th>
                <th style={S.th}>Delivery Date</th>
                <th style={S.th}>Created By</th>
                <th style={{ ...S.th, textAlign: 'center' }}>Age</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((po, i) => (
                <tr
                  key={po.id || i}
                  style={{
                    background: po.is_alert
                      ? 'rgba(239,68,68,0.04)'
                      : i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.015)',
                  }}
                >
                  <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 600, color: '#1C4942', fontSize: '0.82rem' }}>
                    {po.number || '—'}
                  </td>
                  <td style={{ ...S.td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {po.vendor_name || '—'}
                  </td>
                  <td style={S.td}><StatusBadge status={po.status} /></td>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.8rem' }}>
                    {po.date || '—'}
                  </td>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.8rem', color: '#5D6C7B' }}>
                    {po.delivery_date || '—'}
                  </td>
                  <td style={{ ...S.td, color: '#5D6C7B', fontSize: '0.8rem', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {po.created_by || '—'}
                  </td>
                  <td style={{ ...S.td, textAlign: 'center', whiteSpace: 'nowrap' }}>
                    <span style={{
                      fontSize: '0.8rem', fontFamily: 'monospace',
                      color: po.days_since >= 90 ? '#ef4444' : '#5D6C7B',
                      fontWeight: po.days_since >= 90 ? 700 : 400,
                    }}>
                      {po.days_since}d
                    </span>
                    {po.is_alert && <AlertChip days={po.days_since} />}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, fontSize: '0.85rem' }}>
                    {formatINR(po.total)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '1px solid #DFE7E3', background: 'rgba(28,73,66,0.06)' }}>
                <td colSpan={7} style={{ ...S.td, fontWeight: 700, color: '#5D6C7B', fontSize: '0.78rem' }}>
                  Total ({pos.length} POs)
                </td>
                <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: '#18191B', fontFamily: 'monospace', fontSize: '0.88rem' }}>
                  {formatINR(total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function POReport({ data, loading }) {
  const [expandedProjects, setExpandedProjects] = useState({});
  const [filterStatus,     setFilterStatus]     = useState('all');
  const [alertOnly,        setAlertOnly]         = useState(false);
  const [search,           setSearch]            = useState('');

  const pos        = data?.pos         || [];
  const summary    = data?.summary     || {};
  const alertCount = data?.alert_count || 0;
  const totalPos   = data?.total_pos   || 0;

  const toggleProject = proj =>
    setExpandedProjects(p => ({ ...p, [proj]: !p[proj] }));

  const isOpen = proj => expandedProjects[proj] !== false; // default expanded

  // ── Filter ──────────────────────────────────────────────────────────────────
  const filtered = useMemo(() => pos.filter(po => {
    if (alertOnly && !po.is_alert) return false;
    if (filterStatus !== 'all' && po.status !== filterStatus) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!po.number.toLowerCase().includes(q) &&
          !po.vendor_name.toLowerCase().includes(q) &&
          !po.project.toLowerCase().includes(q) &&
          !(po.created_by || '').toLowerCase().includes(q)) return false;
    }
    return true;
  }), [pos, alertOnly, filterStatus, search]);

  // ── Group by project ─────────────────────────────────────────────────────────
  const byProject = useMemo(() => {
    const groups = {};
    for (const po of filtered) {
      if (!groups[po.project]) groups[po.project] = [];
      groups[po.project].push(po);
    }
    return groups;
  }, [filtered]);

  const projects = useMemo(() => Object.keys(byProject).sort((a, b) => {
    const aA = byProject[a].filter(p => p.is_alert).length;
    const bA = byProject[b].filter(p => p.is_alert).length;
    if (bA !== aA) return bA - aA;     // projects with alerts first
    const aT = byProject[a].reduce((s, p) => s + p.total, 0);
    const bT = byProject[b].reduce((s, p) => s + p.total, 0);
    return bT - aT;                    // then by total value desc
  }), [byProject]);

  const filteredTotal = filtered.reduce((s, p) => s + p.total, 0);

  return (
    <div style={S.wrap}>
      <div style={S.card}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={S.hdr}>
          <div>
            <h2 style={S.title}>Project-wise Purchase Order Report</h2>
            <p style={S.subtitle}>
              {totalPos} total POs
              {alertCount > 0 && <span style={{ color: '#ef4444', marginLeft: 8 }}>· {alertCount} require attention (90+ days active)</span>}
            </p>
          </div>
        </div>

        {/* ── Loading ────────────────────────────────────────────────────── */}
        {loading && (
          <div style={{ textAlign: 'center', color: '#5D6C7B', padding: '3rem 0', fontSize: '0.9rem' }}>
            Loading purchase orders…
          </div>
        )}

        {!loading && !data && (
          <div style={{ textAlign: 'center', color: '#9BA8B0', padding: '2.5rem', fontSize: '0.85rem' }}>
            No data available. Please refresh the page.
          </div>
        )}

        {!loading && data && (
          <>
            {/* ── 90-day Alert Banner ──────────────────────────────────── */}
            {alertCount > 0 && (
              <div style={S.alertBanner}>
                <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>⚠</span>
                <div style={{ flex: 1 }}>
                  <strong style={{ color: '#DC2626' }}>{alertCount} Purchase Order{alertCount > 1 ? 's' : ''}</strong>
                  {' '}in active status ({ALERT_STATUSES.map(s => STATUS_LABEL[s]).join(' / ')}) have been pending for{' '}
                  <strong style={{ color: '#DC2626' }}>90 or more days</strong> and require immediate review.
                </div>
                <button
                  onClick={() => { setAlertOnly(!alertOnly); setFilterStatus('all'); }}
                  style={{
                    flexShrink: 0, padding: '4px 14px', borderRadius: 5,
                    border: '1px solid #ef4444',
                    background: alertOnly ? '#ef4444' : 'transparent',
                    color: alertOnly ? '#fff' : '#ef4444',
                    fontSize: '0.76rem', fontWeight: 600, cursor: 'pointer',
                  }}>
                  {alertOnly ? 'Show All POs' : 'Show Alerts Only'}
                </button>
              </div>
            )}

            {/* ── Status Summary Cards ─────────────────────────────────── */}
            <div style={S.summaryRow}>
              <button
                style={S.summCard(filterStatus === 'all' && !alertOnly)}
                onClick={() => { setFilterStatus('all'); setAlertOnly(false); }}>
                <div style={S.summCount}>{totalPos}</div>
                <div style={S.summLabel}>All POs</div>
              </button>
              {ALL_STATUSES.map(st => {
                const cnt = summary[st] || 0;
                if (cnt === 0) return null;
                const active = filterStatus === st && !alertOnly;
                return (
                  <button
                    key={st}
                    style={S.summCard(active, STATUS_COLOR[st])}
                    onClick={() => { setFilterStatus(st); setAlertOnly(false); }}>
                    <div style={{ ...S.summCount, color: STATUS_COLOR[st] }}>{cnt}</div>
                    <div style={S.summLabel}>{STATUS_LABEL[st]}</div>
                  </button>
                );
              })}
            </div>

            {/* ── Filter bar ──────────────────────────────────────────────── */}
            <div style={S.filterBar}>
              <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
                <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#5D6C7B', pointerEvents: 'none' }}>
                  <Search size={14} />
                </span>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search PO#, vendor, project, created by…"
                  style={S.searchInp}
                />
              </div>
              <select
                value={filterStatus}
                onChange={e => { setFilterStatus(e.target.value); setAlertOnly(false); }}
                style={S.select}>
                <option value="all">All Statuses</option>
                {ALL_STATUSES.map(st => (
                  <option key={st} value={st}>{STATUS_LABEL[st]} ({summary[st] || 0})</option>
                ))}
              </select>
              {(filterStatus !== 'all' || alertOnly || search) && (
                <button
                  onClick={() => { setFilterStatus('all'); setAlertOnly(false); setSearch(''); }}
                  style={{ padding: '6px 12px', borderRadius: 5, border: '1px solid #DFE7E3', background: 'transparent', color: '#5D6C7B', fontSize: '0.78rem', cursor: 'pointer' }}>
                  Reset Filters
                </button>
              )}
              <div style={{ marginLeft: 'auto', fontSize: '0.8rem', color: '#5D6C7B', alignSelf: 'center', whiteSpace: 'nowrap' }}>
                {filtered.length} PO{filtered.length !== 1 ? 's' : ''}
                {filtered.length !== totalPos && ` (of ${totalPos})`}
                {' · '}{formatINR(filteredTotal)}
              </div>
            </div>

            {/* ── Project groups ─────────────────────────────────────────── */}
            {projects.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#9BA8B0', padding: '2.5rem', fontSize: '0.85rem' }}>
                No purchase orders match your current filters.
              </div>
            ) : (
              <>
                {/* Expand/collapse all */}
                <div style={{ display: 'flex', gap: 8, padding: '0.5rem 1.5rem', borderBottom: '1px solid #DFE7E3' }}>
                  <button onClick={() => { const n = {}; projects.forEach(p => { n[p] = true; }); setExpandedProjects(n); }} style={S.expandBtn}>
                    Expand All
                  </button>
                  <button onClick={() => { const n = {}; projects.forEach(p => { n[p] = false; }); setExpandedProjects(n); }} style={S.expandBtn}>
                    Collapse All
                  </button>
                  <span style={{ marginLeft: 'auto', fontSize: '0.78rem', color: '#9BA8B0', alignSelf: 'center' }}>
                    {projects.length} project{projects.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {projects.map(proj => (
                  <ProjectGroup
                    key={proj}
                    project={proj}
                    pos={byProject[proj]}
                    isOpen={isOpen(proj)}
                    onToggle={() => toggleProject(proj)}
                  />
                ))}

                {/* Grand total footer */}
                <div style={S.grandTotal}>
                  <span style={{ color: '#5D6C7B', fontSize: '0.82rem' }}>
                    Grand Total — {filtered.length} PO{filtered.length !== 1 ? 's' : ''} across {projects.length} project{projects.length !== 1 ? 's' : ''}
                  </span>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#18191B', fontSize: '1rem' }}>
                    {formatINR(filteredTotal)}
                  </span>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  wrap:     { marginTop: '1.5rem' },
  card:     { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, overflow: 'hidden' },
  hdr:      {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: '1.25rem 1.5rem', borderBottom: '1px solid #DFE7E3',
    flexWrap: 'wrap', gap: 10,
  },
  title:    { color: '#18191B', fontSize: '1.05rem', fontWeight: 700, margin: 0 },
  subtitle: { color: '#5D6C7B', fontSize: '0.8rem', margin: '4px 0 0', fontWeight: 400 },

  alertBanner: {
    display: 'flex', alignItems: 'center', gap: 12,
    background: 'rgba(239,68,68,0.07)', borderBottom: '1px solid rgba(239,68,68,0.2)',
    padding: '0.85rem 1.5rem', color: '#DC2626', fontSize: '0.85rem', flexWrap: 'wrap',
  },

  summaryRow: {
    display: 'flex', gap: '0.5rem', flexWrap: 'wrap',
    padding: '0.85rem 1.5rem', borderBottom: '1px solid #DFE7E3',
  },
  summCard: (active, accentColor) => ({
    background: active
      ? (accentColor ? `${accentColor}18` : '#EAF4EF')
      : '#F9F9F9',
    border: `1px solid ${active
      ? (accentColor || '#1C4942') + '60'
      : '#DFE7E3'}`,
    borderRadius: 8, padding: '0.5rem 0.9rem', cursor: 'pointer',
    textAlign: 'center', minWidth: 76, transition: 'all 0.15s',
  }),
  summCount: { fontSize: '1.25rem', fontWeight: 700, color: '#18191B', fontFamily: 'monospace', lineHeight: 1.2 },
  summLabel: { fontSize: '0.68rem', color: '#5D6C7B', marginTop: 3, whiteSpace: 'nowrap' },

  filterBar: {
    display: 'flex', gap: '0.5rem', flexWrap: 'wrap',
    padding: '0.65rem 1.5rem', borderBottom: '1px solid #DFE7E3', alignItems: 'center',
  },
  searchInp: {
    width: '100%', paddingLeft: 30, padding: '7px 10px 7px 30px',
    border: '1px solid #DFE7E3', borderRadius: 5, background: '#FFFFFF',
    color: '#18191B', fontSize: '0.82rem', outline: 'none', fontFamily: 'inherit',
  },
  select: {
    padding: '6px 10px', border: '1px solid #DFE7E3', borderRadius: 5,
    background: '#FFFFFF', color: '#9BA8B0', fontSize: '0.82rem',
    outline: 'none', cursor: 'pointer',
  },

  expandBtn: {
    padding: '3px 10px', borderRadius: 4, border: '1px solid #DFE7E3',
    background: 'transparent', color: '#5D6C7B', fontSize: '0.75rem',
    cursor: 'pointer',
  },

  projHdr: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '0.75rem 1.5rem', cursor: 'pointer',
    background: 'rgba(28,73,66,0.08)',
    transition: 'background 0.12s',
  },
  projName:        { color: '#18191B', fontWeight: 700, fontSize: '0.9rem', flex: 1 },
  projMeta:        { color: '#5D6C7B', fontSize: '0.78rem', flexShrink: 0 },
  projAlertBadge:  {
    display: 'inline-flex', padding: '2px 8px', borderRadius: 4, flexShrink: 0,
    background: 'rgba(239,68,68,0.1)', color: '#ef4444',
    fontSize: '0.71rem', fontWeight: 600, border: '1px solid rgba(239,68,68,0.25)',
  },
  projTotal: {
    color: '#1C4942', fontWeight: 700, fontFamily: 'monospace',
    fontSize: '0.9rem', marginLeft: 4, flexShrink: 0,
  },

  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' },
  th: {
    padding: '0.5rem 1rem', textAlign: 'left', fontSize: '0.7rem',
    fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
    color: '#9BA8B0', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '0.6rem 1rem', color: '#18191B', borderBottom: '1px solid #DFE7E3',
    verticalAlign: 'middle',
  },

  grandTotal: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '0.85rem 1.5rem', background: 'rgba(28,73,66,0.06)',
    borderTop: '1px solid #DFE7E3',
  },
};
