import React, { useEffect, useState, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import DataFreshness from '../components/DataFreshness';
import { formatINR } from '../utils/format';
import Modal from '../components/Modal';
import { VCS, FYToggle, QUARTER_MONTHS, QUARTER_LABELS } from './PurchaseDashboard';

// ─── Rent Reports — sub-module of Purchase & Payables ─────────────────────────
// Home of the rent reports. The first one is the Month-wise Rent Expense Report, moved here from
// the Purchase & Payables page (same data: /api/purchase/charts/rent-monthwise). Who can open it
// follows the "Month-wise Rent Report" tick under Purchase & Payables in User Settings.

// Bill drill-down columns (same as the Purchase & Payables page)
const billCols = [
  { key: 'bill_number',  label: 'Bill #' },
  { key: 'vendor_name',  label: 'Vendor' },
  { key: 'date',         label: 'Date',      type: 'date' },
  { key: 'due_date',     label: 'Due Date',  type: 'date' },
  { key: 'branch_name',  label: 'Branch' },
  { key: 'account_name', label: 'Category' },
  { key: 'sub_total',    label: 'Amount (ex-tax)', type: 'currency', align: 'right' },
  { key: 'status',       label: 'Status',    type: 'status' },
];

export default function RentReports() {
  const [refreshing,    setRefreshing]    = useState(false);
  const [modal,         setModal]         = useState(null);

  const [rentData,      setRentData]      = useState(null);
  const [rentLoading,   setRentLoading]   = useState(false);
  const [rentBranch,    setRentBranch]    = useState('All Branches');
  const [rentVendor,    setRentVendor]    = useState('All Vendors');
  const [rentVendorCat, setRentVendorCat] = useState('All Categories');
  const [rentSubCat,    setRentSubCat]    = useState('All Sub-Categories');
  const [rentFY,        setRentFY]        = useState('current');
  const [rentQuarter,   setRentQuarter]   = useState('all');

  const loadRent = useCallback((fy = 'current') => {
    setRentLoading(true);
    setRentBranch('All Branches');
    setRentVendor('All Vendors');
    setRentVendorCat('All Categories');
    setRentSubCat('All Sub-Categories');
    api.purRentMonthwise(fy === 'current' ? null : fy)
      .then(d => setRentData(d))
      .catch(e => console.error('rent-monthwise', e))
      .finally(() => setRentLoading(false));
  }, []);

  useEffect(() => { loadRent('current'); }, [loadRent]);

  // Same as the Purchase & Payables page's Refresh: clear the server cache, then load again
  const refresh = async () => {
    setRefreshing(true);
    try { await api.clearCache(); } catch (e) { console.error('cache clear', e); }
    setRefreshing(false);
    loadRent(rentFY);
  };

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div>
          <h1 style={S.heading}>Rent Reports</h1>
          <p style={S.subheading}>Dev Accelerator Limited · Purchase & Payables</p>
          <DataFreshness entities={['bills_fy']} />
        </div>
        <button
          style={{ ...S.refreshBtn, opacity: refreshing || rentLoading ? 0.6 : 1 }}
          onClick={refresh}
          disabled={refreshing || rentLoading}
        >
          <RefreshCw size={16} style={{ animation: refreshing || rentLoading ? 'spin 1s linear infinite' : 'none' }} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* ── Month-wise Rent Expense Report ───────────────────────────────── */}
      <RentReport
        data={rentData}
        loading={rentLoading}
        branch={rentBranch}
        onBranchChange={setRentBranch}
        vendor={rentVendor}
        onVendorChange={setRentVendor}
        vendorCategory={rentVendorCat}
        onVendorCategoryChange={setRentVendorCat}
        subCategory={rentSubCat}
        onSubCategoryChange={setRentSubCat}
        fy={rentFY}
        onFYChange={fy => { setRentFY(fy); setRentQuarter('all'); loadRent(fy); }}
        quarter={rentQuarter}
        onQuarterChange={setRentQuarter}
        onRowClick={(title, bills) => setModal({ title, rows: bills })}
      />

      {modal && <Modal title={modal.title} data={modal.rows} columns={billCols} onClose={() => setModal(null)} />}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        *::-webkit-scrollbar{width:6px;height:6px}
        *::-webkit-scrollbar-track{background:#F2F2F2}
        *::-webkit-scrollbar-thumb{background:#C8D6D0;border-radius:3px}
      `}</style>
    </div>
  );
}

// Page styles (same as the Purchase & Payables page header)
const S = {
  page:       { minHeight: '100vh', background: '#F9F9F9', padding: '1.5rem 2rem', fontFamily: "'Figtree', 'Inter', -apple-system, sans-serif" },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' },
  heading:    { margin: 0, color: '#18191B', fontSize: '1.5rem', fontWeight: 700 },
  subheading: { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.9rem' },
  refreshBtn: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', padding: '0.5rem 1rem', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem' },
};

// ─── Month-wise Rent Expense Report (pivot format: rows = Branch×Vendor, cols = months) ──
const RENT_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899',
  '#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6','#eab308',
  '#a855f7','#22c55e','#0ea5e9','#d946ef','#fb923c','#4ade80',
];
// Rent table value colours (same palette as the Vendor Category report)
const RC = { agreed: '#3b82f6', diff: '#8b5cf6', total: '#f59e0b', pos: '#22c55e', neg: '#ef4444', muted: '#64748b', dash: '#9BA8B0' };
const rentDiffColor = d => d > 0 ? RC.pos : d < 0 ? RC.neg : RC.muted;

function RentReport({ data, loading, branch, onBranchChange, vendor, onVendorChange, vendorCategory, onVendorCategoryChange, subCategory, onSubCategoryChange, fy, onFYChange, quarter, onQuarterChange, onRowClick }) {
  // Branch expand/collapse: branch name → true (open) / false (closed).
  // A branch not in the map is closed, except when it is the only branch shown.
  const [openBranches, setOpenBranches] = useState({});

  const allMonths            = data?.months               || [];
  const allRows              = data?.rows                 || [];
  const allBranches          = data?.all_branches         || ['All Branches'];
  const allVendors           = data?.all_vendors          || ['All Vendors'];
  const allVendorCategories  = data?.all_vendor_categories || ['All Categories'];
  const allSubCategories     = data?.all_sub_categories   || ['All Sub-Categories'];

  // Filter months by selected quarter (client-side)
  const qMonthNums = QUARTER_MONTHS[quarter] || null;
  const months = qMonthNums
    ? allMonths.filter(m => qMonthNums.includes(parseInt(m.key.slice(5, 7), 10)))
    : allMonths;

  // Apply all active filters
  const visibleRows = allRows.filter(r => {
    if (branch         !== 'All Branches'      && r.branch_full      !== branch)         return false;
    if (vendor         !== 'All Vendors'        && r.vendor           !== vendor)         return false;
    if (vendorCategory !== 'All Categories'     && r.vendor_category  !== vendorCategory) return false;
    if (subCategory    !== 'All Sub-Categories' && r.sub_category     !== subCategory)    return false;
    return true;
  });

  const anyFilterActive = branch !== 'All Branches' || vendor !== 'All Vendors' ||
                          vendorCategory !== 'All Categories' || subCategory !== 'All Sub-Categories' ||
                          (quarter || 'all') !== 'all';
  const clearFilters = () => {
    onBranchChange('All Branches');
    onVendorChange('All Vendors');
    onVendorCategoryChange('All Categories');
    onSubCategoryChange('All Sub-Categories');
    onQuarterChange('all');
  };

  // Recalculate totals for visible rows (scoped to visible months for quarter)
  const monthlyTotals = Object.fromEntries(
    months.map(m => [m.key, visibleRows.reduce((s, r) => s + (r.monthly[m.key] || 0), 0)])
  );
  const grandTotal = visibleRows.reduce((s, r) =>
    s + months.reduce((ms, m) => ms + (r.monthly[m.key] || 0), 0), 0);

  const agreedMonthlyTotals = Object.fromEntries(
    months.map(m => [m.key, visibleRows.reduce((s, r) => s + (r.agreed_monthly?.[m.key] || 0), 0)])
  );
  const agreedGrandTotal = visibleRows.reduce((s, r) =>
    s + months.reduce((ms, m) => ms + (r.agreed_monthly?.[m.key] || 0), 0), 0);

  // Chart: stacked bar by branch (top 8 + Others)
  const branchColorMap = {};
  [...new Set(allRows.map(r => r.branch_full))].sort().forEach((br, i) => {
    branchColorMap[br] = RENT_COLORS[i % RENT_COLORS.length];
  });

  const chartBranches = [...new Set(visibleRows.map(r => r.branch_full))].sort();
  const topChartBranches = chartBranches.slice(0, 10);
  const hasOther = chartBranches.length > 10;

  const chartData = months.map(m => {
    const point = { name: m.label };
    for (const br of topChartBranches) {
      point[br] = visibleRows.filter(r => r.branch_full === br).reduce((s, r) => s + (r.monthly[m.key] || 0), 0);
    }
    if (hasOther) {
      point['Other'] = visibleRows.filter(r => !topChartBranches.includes(r.branch_full)).reduce((s, r) => s + (r.monthly[m.key] || 0), 0);
    }
    return point;
  });

  const stackKeys = hasOther ? [...topChartBranches, 'Other'] : topChartBranches;

  const TT = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const total = payload.reduce((s, p) => s + (p.value || 0), 0);
    return (
      <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.75rem 1rem', fontSize: '0.8rem', maxWidth: 260, boxShadow: '0 2px 8px rgba(0,18,20,0.1)' }}>
        <p style={{ color: '#5D6C7B', margin: '0 0 6px', fontWeight: 600 }}>{label}</p>
        {payload.slice().reverse().map(p => (
          <p key={p.dataKey} style={{ color: p.fill, margin: '2px 0', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ color: '#5D6C7B', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.dataKey}</span>
            <span style={{ fontWeight: 600 }}>{formatINR(p.value)}</span>
          </p>
        ))}
        <p style={{ color: RC.total, margin: '6px 0 0', fontWeight: 700, borderTop: '1px solid #DFE7E3', paddingTop: 4 }}>Total: {formatINR(total)}</p>
      </div>
    );
  };

  // Group consecutive rows by branch
  const groups = [];
  for (const row of visibleRows) {
    const last = groups[groups.length - 1];
    if (last && last.branch === row.branch_full) last.rows.push(row);
    else groups.push({ branch: row.branch_full, rows: [row] });
  }

  const isBranchOpen = br => (br in openBranches ? openBranches[br] : groups.length === 1);
  const toggleBranch = br => setOpenBranches(p => ({ ...p, [br]: !isBranchOpen(br) }));
  const setAllBranches = open => setOpenBranches(p => {
    const next = { ...p };
    for (const g of groups) next[g.branch] = open;
    return next;
  });
  const openCount = groups.filter(g => isBranchOpen(g.branch)).length;

  const grpCell = { ...VCS.td, ...VCS.num, fontWeight: 700 };
  const totCell = { ...grpCell, paddingTop: '0.75rem' };

  // Agreed / Actual / Diff cells for a branch or grand-total row
  const sumCells = (key, agr, act, base) => {
    const shown = agr > 0 || act > 0;
    return [
      <td key={`${key}-agr`} style={{ ...base, color: agr > 0 ? RC.agreed : RC.dash }}>{agr > 0 ? formatINR(agr) : '—'}</td>,
      <td key={`${key}-act`} style={{ ...base, color: act > 0 ? RC.total : RC.dash }}>{act > 0 ? formatINR(act) : '—'}</td>,
      <td key={`${key}-dif`} style={{ ...base, color: shown ? rentDiffColor(agr - act) : RC.dash }}>{shown ? formatINR(agr - act) : '—'}</td>,
    ];
  };

  return (
    <div style={VCS.card}>
      {/* ── Header ── */}
      <div style={VCS.hdr}>
        <h2 style={VCS.title}>Month-wise Rent Expense Report</h2>
        <FYToggle fy={fy} onChange={onFYChange} />
      </div>

      {/* ── Filters ── */}
      <div style={VCS.filterRow}>
        <span style={VCS.filterLbl}>Filters:</span>
        <select value={branch} onChange={e => onBranchChange(e.target.value)} style={{ ...VCS.select, minWidth: 160, color: branch !== 'All Branches' ? '#1C4942' : '#18191B' }}>
          {allBranches.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={vendor} onChange={e => onVendorChange(e.target.value)} style={{ ...VCS.select, minWidth: 200 }}>
          {allVendors.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select value={vendorCategory} onChange={e => onVendorCategoryChange(e.target.value)} style={{ ...VCS.select, minWidth: 140 }}>
          {allVendorCategories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={subCategory} onChange={e => onSubCategoryChange(e.target.value)} style={{ ...VCS.select, minWidth: 180 }}>
          {allSubCategories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={quarter || 'all'} onChange={e => onQuarterChange(e.target.value)} style={{ ...VCS.select, minWidth: 140, color: (quarter && quarter !== 'all') ? '#7C3AED' : '#18191B' }}>
          {Object.entries(QUARTER_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        {anyFilterActive && <button onClick={clearFilters} style={VCS.clearBtn}>Clear</button>}
      </div>

      {!loading && data?.details_pending > 0 && (
        <div style={VCS.notice}>
          Fetching exact bill amounts from Zoho — {data.details_pending} bill{data.details_pending !== 1 ? 's' : ''} currently show an estimate. Refresh in a few minutes.
        </div>
      )}

      {loading && <div style={VCS.empty}>Loading rent data…</div>}
      {!loading && !data && <div style={VCS.empty}>No data available</div>}

      {!loading && data && (
        <>
          {/* ── Stacked Bar Chart ── */}
          {chartData.some(pt => stackKeys.some(k => (pt[k] || 0) > 0)) && (
            <div style={{ marginBottom: '1rem' }}>
              <p style={VCS.chartLbl}>Monthly Rent — Branch Breakdown</p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                  <XAxis dataKey="name" tick={{ fill: '#5D6C7B', fontSize: 10 }} axisLine={{ stroke: '#DFE7E3' }} tickLine={false} />
                  <YAxis tickFormatter={v => `₹${(v / 100000).toFixed(0)}L`} tick={{ fill: '#5D6C7B', fontSize: 10 }} axisLine={false} tickLine={false} width={55} />
                  <Tooltip content={<TT />} cursor={{ fill: 'rgba(28,73,66,0.06)' }} />
                  {stackKeys.map((br, i) => (
                    <Bar key={br} dataKey={br} stackId="a" fill={br === 'Other' ? '#C9D3D8' : (branchColorMap[br] || RENT_COLORS[i % RENT_COLORS.length])} radius={i === stackKeys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <div style={VCS.legend}>
                {stackKeys.map((br, i) => (
                  <span key={br} style={VCS.legendItem}>
                    <span style={{ ...VCS.legendSwatch, background: br === 'Other' ? '#C9D3D8' : (branchColorMap[br] || RENT_COLORS[i % RENT_COLORS.length]) }} />
                    {br}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ── Expand / Collapse controls ── */}
          {groups.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ color: '#5D6C7B', fontSize: '0.75rem' }}>
                {openCount} of {groups.length} branch{groups.length !== 1 ? 'es' : ''} expanded · click a branch row to open or close it
              </span>
              <button onClick={() => setAllBranches(true)} disabled={openCount === groups.length}
                style={{ ...VCS.clearBtn, opacity: openCount === groups.length ? 0.5 : 1, cursor: openCount === groups.length ? 'default' : 'pointer' }}>
                Expand all
              </button>
              <button onClick={() => setAllBranches(false)} disabled={openCount === 0}
                style={{ ...VCS.clearBtn, opacity: openCount === 0 ? 0.5 : 1, cursor: openCount === 0 ? 'default' : 'pointer' }}>
                Collapse all
              </button>
            </div>
          )}

          {/* ── Pivot Table ── */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 900 }}>
              <thead>
                <tr>
                  <th rowSpan={2} style={{ ...VCS.th, minWidth: 220, verticalAlign: 'bottom' }}>Branch / Office No.</th>
                  <th rowSpan={2} style={{ ...VCS.th, minWidth: 180, verticalAlign: 'bottom' }}>Developer Name</th>
                  {months.map(m => (
                    <th key={m.key} colSpan={3} style={{ ...VCS.th, textAlign: 'center', minWidth: 240, color: '#18191B' }}>{m.label}</th>
                  ))}
                  <th colSpan={3} style={{ ...VCS.th, textAlign: 'center', minWidth: 255, color: RC.total }}>Total</th>
                </tr>
                <tr>
                  {[...months.map(m => m.key), 'total'].flatMap(k => [
                    <th key={`${k}-agr`} style={{ ...VCS.th, textAlign: 'right', minWidth: 80, color: RC.agreed }}>Agreed</th>,
                    <th key={`${k}-act`} style={{ ...VCS.th, textAlign: 'right', minWidth: 80 }}>Actual</th>,
                    <th key={`${k}-dif`} style={{ ...VCS.th, textAlign: 'right', minWidth: 80, color: RC.diff }}>Diff.</th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 && (
                  <tr><td colSpan={2 + months.length * 3 + 3} style={{ ...VCS.td, textAlign: 'center', color: '#475569', padding: '2rem' }}>No data for selected filters</td></tr>
                )}
                {groups.map(({ branch: br, rows }) => {
                  const brColor   = branchColorMap[br] || '#64748b';
                  const bAgrTotal = rows.reduce((s, r) => s + months.reduce((ms, m) => ms + (r.agreed_monthly?.[m.key] || 0), 0), 0);
                  const bActTotal = rows.reduce((s, r) => s + months.reduce((ms, m) => ms + (r.monthly[m.key] || 0), 0), 0);
                  const isOpen    = isBranchOpen(br);
                  return (
                    <React.Fragment key={br}>
                      {/* Branch row — click to expand / collapse its offices */}
                      <tr style={{ ...VCS.grpRow, cursor: 'pointer' }}
                        role="button" tabIndex={0} aria-expanded={isOpen}
                        title={isOpen ? 'Click to collapse' : 'Click to expand'}
                        onClick={() => toggleBranch(br)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBranch(br); } }}>
                        <td colSpan={2} style={{ ...VCS.td, fontWeight: 700, color: brColor, whiteSpace: 'nowrap' }}>
                          <span style={{ display: 'inline-block', width: 14, color: '#475569', fontSize: '0.7rem' }}>{isOpen ? '▼' : '▶'}</span>
                          <span style={{ ...VCS.dot, background: brColor }} />
                          {br}
                          <span style={VCS.count}>({rows.length} developer{rows.length !== 1 ? 's' : ''})</span>
                        </td>
                        {months.flatMap(m => sumCells(
                          m.key,
                          rows.reduce((s, r) => s + (r.agreed_monthly?.[m.key] || 0), 0),
                          rows.reduce((s, r) => s + (r.monthly[m.key] || 0), 0),
                          grpCell,
                        ))}
                        {sumCells('total', bAgrTotal, bActTotal, grpCell)}
                      </tr>

                      {/* Office rows (only when the branch is expanded) */}
                      {isOpen && rows.map((row, i) => {
                        const rowActTotal = months.reduce((s, m) => s + (row.monthly[m.key] || 0), 0);
                        const rowAgrTotal = months.reduce((s, m) => s + (row.agreed_monthly?.[m.key] || 0), 0);
                        const hasAgr = months.some(m => row.agreed_monthly?.[m.key] != null);
                        const cell = { ...VCS.td, ...VCS.num, fontSize: '0.82rem' };
                        return (
                          <tr key={`${row.branch_full}|||${row.vendor}`} style={VCS.vendRow(i)}>
                            <td style={{ ...VCS.td, paddingLeft: '1.75rem', color: '#18191B', fontSize: '0.82rem', whiteSpace: 'nowrap' }}>↳ {row.office || '—'}</td>
                            <td style={{ ...VCS.td, color: '#5D6C7B', fontSize: '0.8rem' }}>{row.vendor}</td>
                            {months.flatMap(m => {
                              const amt   = row.monthly[m.key] || 0;
                              const agr   = row.agreed_monthly?.[m.key];
                              const diff  = agr != null ? agr - amt : null;
                              const bills = row.bills_by_month?.[m.key] || [];
                              return [
                                <td key={`${m.key}-agr`} style={{ ...cell, color: agr != null ? RC.agreed : RC.dash }}>
                                  {agr != null ? formatINR(agr) : '—'}
                                </td>,
                                <td key={`${m.key}-act`}
                                  onClick={() => amt > 0 && onRowClick(`${row.office} — ${m.label}`, bills)}
                                  style={{ ...cell, color: amt > 0 ? '#18191B' : RC.dash, cursor: amt > 0 ? 'pointer' : 'default' }}>
                                  {amt > 0 ? formatINR(amt) : '—'}
                                </td>,
                                <td key={`${m.key}-dif`} style={{ ...cell, color: diff != null ? rentDiffColor(diff) : RC.dash }}>
                                  {diff != null ? formatINR(diff) : '—'}
                                </td>,
                              ];
                            })}
                            <td style={{ ...cell, fontWeight: 600, color: hasAgr ? RC.agreed : RC.dash }}>
                              {hasAgr ? formatINR(rowAgrTotal) : '—'}
                            </td>
                            <td style={{ ...cell, fontWeight: 600, color: RC.total }}>
                              {formatINR(rowActTotal)}
                            </td>
                            <td style={{ ...cell, fontWeight: 600, color: hasAgr ? rentDiffColor(rowAgrTotal - rowActTotal) : RC.dash }}>
                              {hasAgr ? formatINR(rowAgrTotal - rowActTotal) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
              {visibleRows.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid #DFE7E3' }}>
                    <td colSpan={2} style={{ ...VCS.td, fontWeight: 700, color: '#18191B', paddingTop: '0.75rem' }}>GRAND TOTAL</td>
                    {months.flatMap(m => sumCells(m.key, agreedMonthlyTotals[m.key] || 0, monthlyTotals[m.key] || 0, totCell))}
                    {sumCells('total', agreedGrandTotal, grandTotal, { ...totCell, fontSize: '0.95rem' })}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </div>
  );
}
