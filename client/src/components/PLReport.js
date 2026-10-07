import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Settings, ChevronDown, AlertCircle, X, Download } from 'lucide-react';
import { api } from '../utils/api';
import Modal from './Modal';

const CURRENT_FY = (() => {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${String(y + 1).slice(-2)}`;
})();

const FY_OPTIONS = ['2026-27', '2025-26', '2024-25', '2023-24', '2022-23'].filter(fy => {
  const [y] = fy.split('-').map(Number);
  return y <= parseInt(CURRENT_FY.split('-')[0], 10);
});

const PERIOD_TYPES = [
  { id: 'ytd',       label: 'Year-to-Date' },
  { id: 'month',     label: 'Month' },
  { id: 'quarter',   label: 'Quarter' },
  { id: 'half_year', label: 'Half-Year' },
];

const SECTION_META = {
  revenue:   { label: 'Revenue',                   color: '#1e3a5f', bg: '#e0f2fe' },
  occupancy: { label: 'Occupancy Cost',             color: '#4f46e5', bg: '#eef2ff' },
  recurring: { label: 'Recurring Expenses',         color: '#0f766e', bg: '#f0fdfa' },
  opex:      { label: 'Operating Expenses',         color: '#b45309', bg: '#fffbeb' },
  other:     { label: 'Other Expenses',             color: '#7c3aed', bg: '#faf5ff' },
  finance:   { label: 'Interest & Finance Cost',    color: '#be123c', bg: '#fff1f2' },
};
const SECTION_ORDER = ['revenue', 'occupancy', 'recurring', 'opex', 'other'];

function fmt(n, digits = 0) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}
// Actual rupees (whole), Indian grouping; negatives in brackets
function fmtInr(n) {
  if (n == null || isNaN(n)) return '—';
  const r = Math.round(n);
  const s = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(r));
  return (r < 0 ? '(₹' : '₹') + s + (r < 0 ? ')' : '');
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

function getMonthOptions(fy) {
  const [y] = fy.split('-').map(Number);
  const months = [];
  for (let m = 4; m <= 12; m++) months.push({ value: `${y}-${String(m).padStart(2,'0')}`, label: new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) });
  for (let m = 1; m <= 3;  m++) months.push({ value: `${y+1}-${String(m).padStart(2,'0')}`, label: new Date(y+1, m-1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) });
  return months;
}

function getQuarterOptions(fy) {
  const [y] = fy.split('-').map(Number);
  return [
    { value: 'Q1', label: `Q1 Apr–Jun ${y}` },
    { value: 'Q2', label: `Q2 Jul–Sep ${y}` },
    { value: 'Q3', label: `Q3 Oct–Dec ${y}` },
    { value: 'Q4', label: `Q4 Jan–Mar ${y+1}` },
  ];
}

function getHYOptions(fy) {
  const [y] = fy.split('-').map(Number);
  return [
    { value: 'H1', label: `H1 Apr–Sep ${y}` },
    { value: 'H2', label: `H2 Oct–Mar ${y}–${y+1}` },
  ];
}

// ─── Comparison Table Component ───────────────────────────────────────────────
function PLCompareTable({ data, sqft, seats }) {
  if (!data) return null;
  const { p1, p2, lines } = data;
  const EBITDA_SECS = ['occupancy','recurring','opex','other'];
  const bySection = {};
  for (const l of lines) {
    if (!bySection[l.section]) bySection[l.section] = [];
    bySection[l.section].push(l);
  }
  const varColor = (v) => v > 0 ? '#15803d' : v < 0 ? '#ef4444' : '#64748b';
  const fmtVar = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + fmtInr(v);
  const fmtVarPct = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';

  const secs = [...SECTION_ORDER, 'finance'];
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: '#1e3a5f' }}>Period Comparison</span>
        <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
          {p1.period} ({p1.dateFrom} → {p1.dateTo}) vs {p2.period} ({p2.dateFrom} → {p2.dateTo})
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
          <thead>
            <tr style={{ background: '#f1f5f9' }}>
              <th style={{ ...S.th, textAlign: 'left', width: '22%' }}>Particular</th>
              <th style={{ ...S.th, textAlign: 'right', background: '#e0f2fe' }}>{p1.period} Amount</th>
              <th style={{ ...S.th, textAlign: 'right', background: '#f0fdf4' }}>{p2.period} Amount</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Variance ₹</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Variance %</th>
              <th style={{ ...S.th, textAlign: 'right', background: '#e0f2fe' }}>{p1.period} % Rev</th>
              <th style={{ ...S.th, textAlign: 'right', background: '#f0fdf4' }}>{p2.period} % Rev</th>
            </tr>
          </thead>
          <tbody>
            {secs.map(sec => {
              const secLines = bySection[sec] || [];
              if (!secLines.length) return null;
              const meta = SECTION_META[sec] || { label: sec, color: '#64748b', bg: '#f8fafc' };
              const secP1 = secLines.reduce((s,l) => s + (l.p1_amount||0), 0);
              const secP2 = secLines.reduce((s,l) => s + (l.p2_amount||0), 0);
              const secVar = secP2 - secP1;
              const secVarPct = secP1 !== 0 ? secVar/Math.abs(secP1) : null;
              return (
                <React.Fragment key={sec}>
                  <tr>
                    <td colSpan={7} style={{ ...S.secHeader, background: meta.bg, color: meta.color }}>{meta.label}</td>
                  </tr>
                  {secLines.map(l => (
                    <tr key={l.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={S.tdLabel}>{l.label}{l.account_count === 0 && <span style={S.unmappedDot} />}</td>
                      <td style={{ ...S.tdAmt, background: '#f0f9ff' }}>{fmtInr(l.p1_amount)}</td>
                      <td style={{ ...S.tdAmt, background: '#f0fdf4' }}>{fmtInr(l.p2_amount)}</td>
                      <td style={{ ...S.tdAmt, color: varColor(l.var_abs) }}>{fmtVar(l.var_abs)}</td>
                      <td style={{ ...S.tdNum, color: varColor(l.var_pct) }}>{fmtVarPct(l.var_pct)}</td>
                      <td style={{ ...S.tdNum, background: '#f0f9ff' }}>{l.p1_pct_rev != null ? fmtPct(l.p1_pct_rev) : '—'}</td>
                      <td style={{ ...S.tdNum, background: '#f0fdf4' }}>{l.p2_pct_rev != null ? fmtPct(l.p2_pct_rev) : '—'}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#f8fafc', borderTop: '1px solid #e2e8f0', borderBottom: '1px solid #e2e8f0' }}>
                    <td style={{ ...S.tdBoldLabel }}>Total {meta.label}</td>
                    <td style={{ ...S.tdBoldAmt, background: '#e0f2fe' }}>{fmtInr(secP1)}</td>
                    <td style={{ ...S.tdBoldAmt, background: '#dcfce7' }}>{fmtInr(secP2)}</td>
                    <td style={{ ...S.tdBoldAmt, color: varColor(secVar) }}>{fmtVar(secVar)}</td>
                    <td style={{ ...S.tdNum, color: varColor(secVarPct) }}>{fmtVarPct(secVarPct)}</td>
                    <td colSpan={2} />
                  </tr>
                </React.Fragment>
              );
            })}
            {/* EBITDA comparison */}
            {[
              { label: 'Total Expense', a1: p1.total_expense, a2: p2.total_expense, style: S.totalExpRow },
              { label: 'EBITDA',        a1: p1.ebitda,        a2: p2.ebitda,        style: S.ebitdaRow },
              { label: 'Interest & Finance Cost', a1: p1.interest, a2: p2.interest, style: { background: '#fff1f2', borderTop: '1px solid #fecdd3' } },
            ].map(({ label, a1, a2, style }) => {
              const v = a2 - a1, vp = a1 !== 0 ? v/Math.abs(a1) : null;
              return (
                <tr key={label} style={style}>
                  <td style={{ ...S.tdBoldLabel, paddingLeft: '0.9rem' }}>{label}</td>
                  <td style={{ ...S.tdBoldAmt, background: '#e0f2fe' }}>{fmtInr(a1)}</td>
                  <td style={{ ...S.tdBoldAmt, background: '#dcfce7' }}>{fmtInr(a2)}</td>
                  <td style={{ ...S.tdBoldAmt, color: varColor(v) }}>{fmtVar(v)}</td>
                  <td style={{ ...S.tdNum, color: varColor(vp) }}>{fmtVarPct(vp)}</td>
                  <td colSpan={2} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const drillCols = [
  { key: 'date',           label: 'Date',           width: 100 },
  { key: 'branch_name',    label: 'Branch',         width: 180 },
  { key: 'account_name',   label: 'Account',        width: 180 },
  { key: 'voucher_type',   label: 'Type',           width: 110 },
  { key: 'voucher_number', label: 'Voucher #',      width: 130 },
  { key: 'party',          label: 'Party',          width: 200 },
  { key: 'description',    label: 'Description',    width: 200 },
  { key: 'amount',         label: 'Amount (₹)',     width: 130, render: v => fmt(v, 2) },
];

function BranchDropdown({ branches, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef();
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const filtered = branches.filter(b => b.toLowerCase().includes(search.toLowerCase()));
  const toggle = b => onChange(selected.includes(b) ? selected.filter(x => x !== b) : [...selected, b]);
  const label = selected.length === 0 ? 'All' : selected.length === 1 ? selected[0] : `${selected.length} selected`;
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0.32rem 0.7rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem', color: '#334155', fontFamily: 'inherit', whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden' }}
      >
        <span style={{ fontWeight: 600, color: '#475569' }}>Branch</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span style={{ color: '#94a3b8', fontSize: '0.65rem', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 500, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', width: 280, fontFamily: 'inherit' }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9' }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search branches…" autoFocus
              style={{ width: '100%', border: '1px solid #e2e8f0', borderRadius: 5, padding: '5px 8px', fontSize: '0.78rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }} />
          </div>
          <div style={{ display: 'flex', gap: 6, padding: '6px 10px', borderBottom: '1px solid #f1f5f9' }}>
            <button onClick={() => { onChange([]); setSearch(''); }} style={{ padding: '3px 10px', borderRadius: 4, border: 'none', background: '#1e3a5f', color: '#fff', fontSize: '0.74rem', cursor: 'pointer', fontFamily: 'inherit' }}>All</button>
            <button onClick={() => onChange([...branches])} style={{ padding: '3px 10px', borderRadius: 4, border: '1px solid #1e3a5f', background: '#fff', color: '#1e3a5f', fontSize: '0.74rem', cursor: 'pointer', fontFamily: 'inherit' }}>Select All</button>
            {selected.length > 0 && <button onClick={() => onChange([])} style={{ padding: '3px 10px', borderRadius: 4, border: 'none', background: '#fef2f2', color: '#dc2626', fontSize: '0.74rem', cursor: 'pointer', fontFamily: 'inherit' }}>Clear ({selected.length})</button>}
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.length === 0 && <div style={{ padding: '12px', textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem' }}>No branches found</div>}
            {filtered.map(b => (
              <label key={b} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', fontSize: '0.79rem', color: selected.includes(b) ? '#1e3a5f' : '#334155', background: selected.includes(b) ? '#f0f9ff' : 'transparent', borderBottom: '1px solid #f8fafc' }}>
                <input type="checkbox" checked={selected.includes(b)} onChange={() => toggle(b)} style={{ cursor: 'pointer', accentColor: '#1e3a5f' }} />
                {b}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PLReport({ onOpenMapping }) {
  const [fy,             setFy]          = useState(CURRENT_FY);
  const [periodType,     setPeriodType]  = useState('ytd');
  const [period,         setPeriod]      = useState('');
  const [branchList,     setBranchList]  = useState([]);
  const [selectedBranches, setSelectedBranches] = useState([]);
  const [data,           setData]        = useState(null);
  const [loading,        setLoading]     = useState(false);
  const [error,          setError]       = useState('');
  const [syncing,        setSyncing]     = useState(false);
  const [syncStatus,     setSyncStatus]  = useState(null);
  const [modal,          setModal]       = useState(null);
  const [drillLoading,   setDrillLoading] = useState(false);
  const [prefetching,    setPrefetching] = useState(false);
  const [prefetchStatus, setPrefetchStatus] = useState(null);
  const [compareMode,    setCompareMode] = useState(false);
  const [cmpPeriodType,  setCmpPeriodType] = useState('quarter');
  const [cmpP1,          setCmpP1]      = useState('Q1');
  const [cmpP2,          setCmpP2]      = useState('Q2');
  const [cmpData,        setCmpData]    = useState(null);
  const [cmpLoading,     setCmpLoading] = useState(false);

  useEffect(() => {
    api.financeBranches().then(d => setBranchList(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  // Poll prefetch status while running
  useEffect(() => {
    let timer;
    if (prefetching) {
      timer = setInterval(async () => {
        try {
          const st = await api.plPrefetchStatus(fy);
          setPrefetchStatus(st);
          if (!st.running) { setPrefetching(false); fetchReport(); }
        } catch {}
      }, 3000);
    }
    return () => clearInterval(timer);
  }, [prefetching, fy]); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultPeriod = useCallback((type, curFy) => {
    const now = new Date();
    if (type === 'month') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,'0')}`;
    if (type === 'quarter') {
      const m = now.getMonth() + 1;
      if (m >= 4 && m <= 6)  return 'Q1';
      if (m >= 7 && m <= 9)  return 'Q2';
      if (m >= 10 && m <= 12) return 'Q3';
      return 'Q4';
    }
    if (type === 'half_year') return (now.getMonth() + 1) <= 9 ? 'H1' : 'H2';
    return '';
  }, []);

  useEffect(() => {
    const def = defaultPeriod(periodType, fy);
    setPeriod(def);
  }, [periodType, fy, defaultPeriod]);

  const fetchReport = useCallback(() => {
    setLoading(true); setError('');
    const params = { fy, period_type: periodType, period };
    if (selectedBranches.length) params.branches = selectedBranches.join(',');
    api.plReport(params)
      .then(d => {
          if (d && !Array.isArray(d.lines))             d = { ...d, lines: [] };
          if (d && !Array.isArray(d.unmapped_accounts)) d = { ...d, unmapped_accounts: [] };
          setData(d); setLoading(false);
        })
      .catch(e => { setError(e?.response?.data?.error || e.message); setLoading(false); });
  }, [fy, periodType, period, selectedBranches]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  async function handleSync() {
    setSyncing(true); setError('');
    try {
      await api.plSync(fy);
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        const st = await api.plSyncStatus(fy);
        setSyncStatus(st);
        if (!st.running || tries > 60) {
          clearInterval(poll);
          setSyncing(false);
          if (!st.running && !st.error) fetchReport();
        }
      }, 3000);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
      setSyncing(false);
    }
  }

  async function handlePrefetch() {
    setPrefetching(true); setPrefetchStatus(null); setError('');
    try {
      const r = await api.plPrefetch(fy);
      if (!r.ok) { setError(r.message || 'Prefetch failed'); setPrefetching(false); return; }
      setPrefetchStatus({ running: true, total: r.account_count, done: 0 });
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
      setPrefetching(false);
    }
  }

  async function handleCompare() {
    setCmpLoading(true); setCmpData(null); setError('');
    try {
      const params = { fy, p1_type: cmpPeriodType, p1: cmpP1, p2_type: cmpPeriodType, p2: cmpP2 };
      if (selectedBranches.length) params.branches = selectedBranches.join(',');
      const d = await api.plCompare(params);
      setCmpData(d);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally { setCmpLoading(false); }
  }

  async function openDrill(line) {
    setDrillLoading(true);
    try {
      const params = { fy, period_type: periodType, period, head_id: line.id };
      if (selectedBranches.length) params.branches = selectedBranches.join(',');
      const result = await api.plDrill(params);
      setModal({
        title: `${line.label} — Transactions`,
        rows: result.rows,
        columns: drillCols,
      });
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setDrillLoading(false);
    }
  }

  // Group lines by section
  const bySection = {};
  for (const line of (data?.lines || [])) {
    if (!bySection[line.section]) bySection[line.section] = [];
    bySection[line.section].push(line);
  }

  const revenue      = data?.revenue      || 0;
  const totalExpense = data?.total_expense || 0;
  const ebitda       = data?.ebitda       || 0;
  const st           = data?.section_totals || {};
  const sqft         = data?.capacity?.sqft  || 0;
  const seats        = data?.capacity?.seats || 0;

  const ps = (a) => sqft  > 0 ? a / sqft  : null;
  const pt = (a) => seats > 0 ? a / seats : null;
  const pr = (a) => revenue > 0 ? a / revenue : null;

  return (
    <div style={S.wrap}>
      {/* Filter Bar */}
      <div style={S.filterBar}>
        <div style={S.filterTitle}>Branch P&amp;L Account</div>
        <div style={S.filterControls}>
          {/* FY */}
          <label style={S.filterLabel}>
            <span style={S.filterLabelText}>FY</span>
            <select value={fy} onChange={e => setFy(e.target.value)} style={S.sel}>
              {FY_OPTIONS.map(f => <option key={f} value={f}>FY {f}</option>)}
            </select>
          </label>
          {/* Period Type */}
          <label style={S.filterLabel}>
            <span style={S.filterLabelText}>Period</span>
            <select value={periodType} onChange={e => setPeriodType(e.target.value)} style={S.sel}>
              {PERIOD_TYPES.map(pt => <option key={pt.id} value={pt.id}>{pt.label}</option>)}
            </select>
          </label>
          {/* Period value */}
          {periodType === 'month' && (
            <select value={period} onChange={e => setPeriod(e.target.value)} style={S.sel}>
              {getMonthOptions(fy).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          {periodType === 'quarter' && (
            <select value={period} onChange={e => setPeriod(e.target.value)} style={S.sel}>
              {getQuarterOptions(fy).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          {periodType === 'half_year' && (
            <select value={period} onChange={e => setPeriod(e.target.value)} style={S.sel}>
              {getHYOptions(fy).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <BranchDropdown branches={branchList} selected={selectedBranches} onChange={setSelectedBranches} />
          <button onClick={onOpenMapping} style={S.mappingBtn} title="Configure P&L Account Mapping">
            <Settings size={14} /> P&L Mapping
          </button>
          {/* Fetch Data — triggers full FY prefetch of account transactions */}
          <button onClick={handlePrefetch} disabled={prefetching} style={{ ...S.syncBtn, background: prefetching ? '#64748b' : '#0f766e' }}
            title="Fetch all expense transaction data from Zoho Books for this FY">
            <RefreshCw size={14} style={prefetching ? { animation: 'spin 1s linear infinite' } : {}} />
            {prefetching ? `Fetching… (${prefetchStatus?.done||0}/${prefetchStatus?.total||'?'})` : 'Fetch Data'}
          </button>
          {/* Sync invoices/credit notes for revenue */}
          {(fy !== CURRENT_FY || data?.needs_refresh) && (
            <button onClick={handleSync} disabled={syncing} style={S.syncBtn}>
              <RefreshCw size={14} style={syncing ? { animation: 'spin 1s linear infinite' } : {}} />
              {syncing ? 'Syncing…' : 'Sync Revenue'}
            </button>
          )}
          {/* Compare toggle */}
          <button onClick={() => { setCompareMode(m => !m); setCmpData(null); }}
            style={{ ...S.mappingBtn, background: compareMode ? '#1e3a5f' : '#f1f5f9', color: compareMode ? '#fff' : '#475569' }}>
            Compare
          </button>
          <button onClick={fetchReport} disabled={loading} style={{ ...S.syncBtn, background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' }}>
            <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          </button>
        </div>
      </div>

      {error && (
        <div style={S.errBand}><AlertCircle size={13} />{error}<button style={S.errX} onClick={() => setError('')}><X size={12} /></button></div>
      )}

      {data?.needs_refresh && (
        <div style={S.needsRefresh}>
          <AlertCircle size={15} style={{ color: '#f59e0b' }} />
          <span>{fy === CURRENT_FY ? 'Current FY data not yet synced.' : `Data not yet synced for FY ${fy}.`} Click <strong>Sync Revenue</strong> to fetch from Zoho.</span>
          {syncStatus?.error && <span style={{ color: '#ef4444' }}>Last error: {syncStatus.error}</span>}
        </div>
      )}

      {syncing && syncStatus?.running && (
        <div style={S.syncBand}>Syncing FY {fy} revenue data from Zoho… this may take a few minutes.</div>
      )}

      {/* Cache status — shown when some accounts are missing disk cache */}
      {data?.cache_status?.missing_count > 0 && !prefetching && (
        <div style={{ ...S.needsRefresh, borderColor: '#fbbf24', background: '#fffbeb' }}>
          <AlertCircle size={15} style={{ color: '#d97706' }} />
          <span style={{ color: '#92400e' }}>
            {data.cache_status.missing_count} expense account(s) not yet cached — expense figures show ₹0.
            Click <strong>Fetch Data</strong> to load from Zoho Books (runs once, then updates nightly at 11 PM).
          </span>
        </div>
      )}

      {prefetching && (
        <div style={{ ...S.syncBand, background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' }}>
          <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
          Fetching expense transactions from Zoho Books…
          {prefetchStatus && ` (${prefetchStatus.done}/${prefetchStatus.total} accounts)`}
          {prefetchStatus?.total_txns > 0 && ` — ${prefetchStatus.total_txns.toLocaleString('en-IN')} transactions cached`}
          <span style={{ marginLeft: 8, fontSize: '0.76rem', opacity: 0.75 }}>Page will refresh automatically when done.</span>
        </div>
      )}

      {/* Compare mode controls */}
      {compareMode && (
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#1e3a5f' }}>Compare</span>
          <select value={cmpPeriodType} onChange={e => { setCmpPeriodType(e.target.value); setCmpP1('Q1'); setCmpP2('Q2'); }} style={S.sel}>
            <option value="quarter">Quarter</option>
            <option value="half_year">Half-Year</option>
            <option value="month">Month</option>
          </select>
          <select value={cmpP1} onChange={e => setCmpP1(e.target.value)} style={S.sel}>
            {cmpPeriodType === 'quarter'   && getQuarterOptions(fy).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            {cmpPeriodType === 'half_year' && getHYOptions(fy).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            {cmpPeriodType === 'month'     && getMonthOptions(fy).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>vs</span>
          <select value={cmpP2} onChange={e => setCmpP2(e.target.value)} style={S.sel}>
            {cmpPeriodType === 'quarter'   && getQuarterOptions(fy).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            {cmpPeriodType === 'half_year' && getHYOptions(fy).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            {cmpPeriodType === 'month'     && getMonthOptions(fy).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={handleCompare} disabled={cmpLoading} style={{ ...S.syncBtn, background: '#1e3a5f' }}>
            {cmpLoading ? 'Loading…' : 'Run Comparison'}
          </button>
        </div>
      )}

      {/* Capacity info */}
      {data && !data.needs_refresh && (
        <div style={S.capacityBar}>
          <span style={S.capItem}><strong>Period:</strong> {data.dateFrom} → {data.dateTo}</span>
          <span style={S.capItem}><strong>Branches:</strong> {data.branches === 'all' ? 'All' : (Array.isArray(data.branches) ? data.branches.length : '—')}</span>
          <span style={S.capItem}><strong>Area:</strong> {fmt(sqft)} sqft</span>
          <span style={S.capItem}><strong>Seats:</strong> {fmt(seats)}</span>
          {(data.capacity?.missing?.length > 0) && (
            <span style={{ ...S.capItem, color: '#f59e0b' }}>⚠ {data.capacity.missing.length} branches missing capacity data</span>
          )}
          {data.branch_pending > 0 && (
            <span style={{ ...S.capItem, color: '#b45309' }}>⏳ Assigning {data.branch_pending} journal entr{data.branch_pending !== 1 ? 'ies' : 'y'} to branches from Zoho — not yet in these figures; refresh in a few minutes</span>
          )}
          {data.synced_at && (
            <span style={{ ...S.capItem, color: '#64748b' }}>Data as of {new Date(data.synced_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </div>
      )}

      {loading && (
        <div style={S.loadingState}>
          <div style={S.spinner} />
          <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Computing P&L…</span>
        </div>
      )}

      {!loading && data && !data.needs_refresh && (
        <div style={S.tableWrap}>
          {/* ── Comparison Table ── */}
          {compareMode && cmpData && <PLCompareTable data={cmpData} sqft={sqft} seats={seats} />}

          {/* ── Main P&L Table ── */}
          {!compareMode && (() => {
            const mb      = data.monthly_breakdown; // present when period_type === 'quarter'
            const months  = mb?.months || [];       // [{month, label, from, to}]
            const mData   = mb?.data  || {};        // month -> {revenue, head_amounts, ...}
            const hasM    = months.length > 0;
            const colSpan = hasM ? 4 + months.length : 5; // label + N months + total + sqft + seat + % rev

            // helper to get monthly amount for a head
            const mAmt = (month, headId) => mData[month]?.head_amounts?.[headId] ?? 0;
            const mSecTotal = (month, sec) => mData[month]?.section_totals?.[sec] ?? 0;

            return (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={{ ...S.th, textAlign: 'left', width: hasM ? '28%' : '38%' }}>Particular</th>
                  {hasM && months.map(m => <th key={m.month} style={{ ...S.th, textAlign: 'right', background: '#f0fdf4', color: '#166534' }}>{m.label}</th>)}
                  <th style={{ ...S.th, textAlign: 'right' }}>{hasM ? 'Quarter Total' : 'Amount (₹)'}</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>₹ / Sqft</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>₹ / Seat</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>% of Revenue</th>
                </tr>
              </thead>
              <tbody>
                {SECTION_ORDER.map(sec => {
                  const lines    = bySection[sec] || [];
                  if (!lines.length) return null;
                  const meta     = SECTION_META[sec];
                  const secTotal = sec === 'revenue' ? revenue : (st[sec] || 0);

                  return (
                    <React.Fragment key={sec}>
                      <tr>
                        <td colSpan={colSpan} style={{ ...S.secHeader, background: meta.bg, color: meta.color }}>
                          {meta.label}
                        </td>
                      </tr>

                      {lines.map(line => (
                        <tr key={line.id} style={S.detailRow}
                          onMouseEnter={e => { e.currentTarget.style.background = '#f8fafc'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                        >
                          <td style={S.tdLabel}>
                            {line.id === 'revenue' ? (
                              <span style={S.lineLabel}>{line.label}</span>
                            ) : (
                              <button style={S.drillBtn} onClick={() => openDrill(line)} disabled={drillLoading}
                                title={line.account_count === 0 ? 'No accounts mapped — configure in P&L Mapping' : 'Click to drill down'}>
                                {line.label}
                                {line.account_count === 0 && <span style={S.unmappedDot} title="No accounts mapped" />}
                              </button>
                            )}
                          </td>
                          {hasM && months.map(m => (
                            <td key={m.month} style={{ ...S.tdAmt, background: '#f0fdf4', fontSize: '0.77rem', color: mAmt(m.month, line.id) < 0 ? '#ef4444' : '#374151' }}>
                              {fmtInr(mAmt(m.month, line.id))}
                            </td>
                          ))}
                          <td style={{ ...S.tdAmt, color: line.amount < 0 ? '#ef4444' : '#0f172a' }}>
                            {line.id === 'revenue' ? (
                              <button style={S.drillBtn} onClick={() => openDrill(line)} disabled={drillLoading}>{fmtInr(line.amount)}</button>
                            ) : fmtInr(line.amount)}
                          </td>
                          <td style={S.tdNum}>{line.per_sqft != null  ? '₹' + line.per_sqft.toFixed(2)  : '—'}</td>
                          <td style={S.tdNum}>{line.per_seat != null  ? '₹' + line.per_seat.toFixed(2)  : '—'}</td>
                          <td style={S.tdNum}>{line.pct_rev  != null  ? fmtPct(line.pct_rev) : '—'}</td>
                        </tr>
                      ))}

                      <tr style={S.subtotalRow}>
                        <td style={S.tdBoldLabel}>Total {meta.label}</td>
                        {hasM && months.map(m => (
                          <td key={m.month} style={{ ...S.tdBoldAmt, background: '#f0fdf4', fontSize: '0.77rem' }}>
                            {fmtInr(mSecTotal(m.month, sec))}
                          </td>
                        ))}
                        <td style={{ ...S.tdBoldAmt, color: secTotal < 0 ? '#ef4444' : '#0f172a' }}>{fmtInr(secTotal)}</td>
                        <td style={S.tdNum}>{sqft  > 0 ? '₹' + (secTotal / sqft).toFixed(2)  : '—'}</td>
                        <td style={S.tdNum}>{seats > 0 ? '₹' + (secTotal / seats).toFixed(2) : '—'}</td>
                        <td style={S.tdNum}>{revenue > 0 ? fmtPct(secTotal / revenue) : '—'}</td>
                      </tr>

                      {sec === 'occupancy' && revenue > 0 && (
                        <tr style={S.ratioRow}>
                          <td style={S.tdRatioLabel}>Rent to Revenue Ratio</td>
                          {hasM && months.map(m => <td key={m.month} style={{ ...S.tdNum, background: '#f0fdf4' }} />)}
                          <td colSpan={3} style={{ ...S.tdNum, textAlign: 'right' }} />
                          <td style={{ ...S.tdNum, fontWeight: 700, color: secTotal / revenue > 0.30 ? '#ef4444' : '#0f172a' }}>
                            {fmtPct(secTotal / revenue)}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}

                {/* Total Expense */}
                <tr style={S.totalExpRow}>
                  <td style={S.tdTotalLabel}>Total Expense</td>
                  {hasM && months.map(m => <td key={m.month} style={{ ...S.tdTotalAmt, background: '#fef9c3', fontSize: '0.77rem' }}>{fmtInr(mData[m.month]?.total_expense ?? 0)}</td>)}
                  <td style={{ ...S.tdTotalAmt, color: totalExpense < 0 ? '#ef4444' : '#0f172a' }}>{fmtInr(totalExpense)}</td>
                  <td style={S.tdNum}>{sqft  > 0 ? '₹' + (totalExpense / sqft).toFixed(2)  : '—'}</td>
                  <td style={S.tdNum}>{seats > 0 ? '₹' + (totalExpense / seats).toFixed(2) : '—'}</td>
                  <td style={S.tdNum}>{revenue > 0 ? fmtPct(totalExpense / revenue) : '—'}</td>
                </tr>

                {/* EBITDA */}
                <tr style={S.ebitdaRow}>
                  <td style={S.tdEbitdaLabel}>EBITDA</td>
                  {hasM && months.map(m => <td key={m.month} style={{ ...S.tdEbitdaAmt, fontSize: '0.77rem', color: (mData[m.month]?.ebitda??0) < 0 ? '#ef4444' : '#15803d' }}>{fmtInr(mData[m.month]?.ebitda ?? 0)}</td>)}
                  <td style={{ ...S.tdEbitdaAmt, color: ebitda < 0 ? '#ef4444' : '#15803d' }}>{fmtInr(ebitda)}</td>
                  <td style={S.tdNum}>{sqft  > 0 ? '₹' + (ebitda / sqft).toFixed(2)  : '—'}</td>
                  <td style={S.tdNum}>{seats > 0 ? '₹' + (ebitda / seats).toFixed(2) : '—'}</td>
                  <td style={{ ...S.tdNum, fontWeight: 700, color: ebitda < 0 ? '#ef4444' : '#15803d' }}>{revenue > 0 ? fmtPct(ebitda / revenue) : '—'}</td>
                </tr>

                {/* Interest & Finance section — shown after EBITDA */}
                {(() => {
                  const financeLines = bySection['finance'] || [];
                  const interestCost = data.interest_cost || 0;
                  const pbdt         = data.pbdt          || 0;
                  if (!financeLines.length && interestCost === 0) return null;
                  const finMeta = SECTION_META['finance'];
                  const finSpan = hasM ? 4 + months.length : 5;
                  return (
                    <React.Fragment>
                      <tr>
                        <td colSpan={finSpan} style={{ ...S.secHeader, background: finMeta.bg, color: finMeta.color }}>
                          {finMeta.label}
                        </td>
                      </tr>
                      {financeLines.map(line => (
                        <tr key={line.id} style={S.detailRow}
                          onMouseEnter={e => { e.currentTarget.style.background = '#f8fafc'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                        >
                          <td style={S.tdLabel}>
                            <button style={S.drillBtn} onClick={() => openDrill(line)} disabled={drillLoading}
                              title={line.account_count === 0 ? 'No accounts mapped — configure in P&L Mapping' : 'Click to drill down'}>
                              {line.label}
                              {line.account_count === 0 && <span style={S.unmappedDot} title="No accounts mapped" />}
                            </button>
                          </td>
                          {hasM && months.map(m => (
                            <td key={m.month} style={{ ...S.tdAmt, background: '#fff1f2', fontSize: '0.77rem', color: '#be123c' }}>
                              {fmtInr(mAmt(m.month, line.id))}
                            </td>
                          ))}
                          <td style={{ ...S.tdAmt, color: line.amount < 0 ? '#15803d' : '#be123c' }}>{fmtInr(line.amount)}</td>
                          <td style={S.tdNum}>{line.per_sqft != null  ? '₹' + line.per_sqft.toFixed(2)  : '—'}</td>
                          <td style={S.tdNum}>{line.per_seat != null  ? '₹' + line.per_seat.toFixed(2)  : '—'}</td>
                          <td style={S.tdNum}>{line.pct_rev  != null  ? fmtPct(line.pct_rev) : '—'}</td>
                        </tr>
                      ))}
                      {/* Profit Before Depreciation & Tax */}
                      <tr style={{ ...S.ebitdaRow, background: '#fdf2f8' }}>
                        <td style={{ ...S.tdEbitdaLabel, color: '#86198f' }}>Profit Before Dep. &amp; Tax (PBDT)</td>
                        {hasM && months.map(m => <td key={m.month} style={{ ...S.tdEbitdaAmt, fontSize: '0.77rem', color: (mData[m.month]?.pbdt??0) < 0 ? '#ef4444' : '#86198f' }}>{fmtInr(mData[m.month]?.pbdt ?? 0)}</td>)}
                        <td style={{ ...S.tdEbitdaAmt, color: pbdt < 0 ? '#ef4444' : '#86198f' }}>{fmtInr(pbdt)}</td>
                        <td style={S.tdNum}>{sqft  > 0 ? '₹' + (pbdt / sqft).toFixed(2)  : '—'}</td>
                        <td style={S.tdNum}>{seats > 0 ? '₹' + (pbdt / seats).toFixed(2) : '—'}</td>
                        <td style={{ ...S.tdNum, fontWeight: 700, color: pbdt < 0 ? '#ef4444' : '#86198f' }}>{revenue > 0 ? fmtPct(pbdt / revenue) : '—'}</td>
                      </tr>
                    </React.Fragment>
                  );
                })()}
              </tbody>
            </table>
            );
          })()}

          {/* Unmapped accounts panel */}
          {data.unmapped_accounts?.length > 0 && (
            <div style={S.unmappedPanel}>
              <div style={S.unmappedTitle}>
                <AlertCircle size={14} style={{ color: '#f59e0b' }} />
                Unmapped Accounts ({data.unmapped_accounts.length}) — Total: {fmtInr(data.unmapped_total)}
              </div>
              <div style={S.unmappedNote}>These bill accounts are not assigned to any P&L line. Configure them in P&L Mapping to include them in the report.</div>
              <table style={{ ...S.table, marginTop: 8 }}>
                <thead>
                  <tr>
                    <th style={{ ...S.th, textAlign: 'left' }}>Account Name</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Bills</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Amount (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.unmapped_accounts.map(a => (
                    <tr key={a.account_name} style={S.detailRow}>
                      <td style={S.tdLabel}>{a.account_name}</td>
                      <td style={{ ...S.tdNum, textAlign: 'right' }}>{a.bill_count}</td>
                      <td style={{ ...S.tdAmt, color: a.amount < 0 ? '#ef4444' : '#0f172a' }}>{fmtInr(a.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {modal && (
        <Modal
          title={modal.title}
          data={modal.rows}
          columns={modal.columns}
          onClose={() => setModal(null)}
        />
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const S = {
  wrap: { marginTop: 32 },
  filterBar: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12,
    padding: '0.85rem 1.1rem', background: '#fff',
    borderRadius: 10, border: '1px solid #e2e8f0',
    marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  filterTitle: { fontSize: '0.92rem', fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', marginRight: 4 },
  filterControls: { display: 'flex', alignItems: 'center', gap: 10, flex: 1, flexWrap: 'wrap' },
  filterLabel: { display: 'flex', alignItems: 'center', gap: 6 },
  filterLabelText: { fontSize: '0.77rem', color: '#64748b', fontWeight: 500, whiteSpace: 'nowrap' },
  sel: {
    fontSize: '0.82rem', color: '#1e293b', background: '#f8fafc',
    border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.3rem 0.6rem',
    cursor: 'pointer', outline: 'none',
  },
  mappingBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0',
    borderRadius: 7, padding: '0.38rem 0.85rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
  },
  syncBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: '#1e3a5f', color: '#fff', border: 'none',
    borderRadius: 7, padding: '0.38rem 0.85rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
  },
  errBand: {
    display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between',
    background: '#fef2f2', color: '#dc2626', fontSize: '0.8rem',
    padding: '0.55rem 1rem', borderRadius: 8, marginBottom: 10,
    border: '1px solid #fee2e2',
  },
  errX: { background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626' },
  needsRefresh: {
    display: 'flex', alignItems: 'center', gap: 10,
    background: '#fffbeb', color: '#92400e', fontSize: '0.82rem',
    padding: '0.7rem 1rem', borderRadius: 8, marginBottom: 10,
    border: '1px solid #fde68a',
  },
  syncBand: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#eff6ff', color: '#1d4ed8', fontSize: '0.8rem',
    padding: '0.55rem 1rem', borderRadius: 8, marginBottom: 10, border: '1px solid #bfdbfe',
  },
  capacityBar: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16,
    padding: '0.5rem 0.8rem', background: '#f8fafc',
    borderRadius: 8, marginBottom: 12, fontSize: '0.78rem', color: '#475569',
    border: '1px solid #f1f5f9',
  },
  capItem: {},
  loadingState: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
    padding: '3rem',
  },
  spinner: {
    width: 22, height: 22, borderRadius: '50%',
    border: '2px solid #e2e8f0', borderTopColor: '#1e3a5f',
    animation: 'spin 0.7s linear infinite',
  },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' },
  th: {
    padding: '0.55rem 0.9rem', background: '#f1f5f9', color: '#475569',
    fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '2px solid #e2e8f0', whiteSpace: 'nowrap',
  },
  secHeader: {
    padding: '0.5rem 0.9rem', fontWeight: 700, fontSize: '0.79rem',
    textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  detailRow: { transition: 'background 0.1s', borderBottom: '1px solid #f1f5f9' },
  tdLabel: { padding: '0.48rem 0.9rem', color: '#334155', fontWeight: 400 },
  tdAmt: { padding: '0.48rem 0.9rem', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  tdNum: { padding: '0.48rem 0.9rem', textAlign: 'right', color: '#64748b', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  lineLabel: { color: '#334155' },
  drillBtn: {
    background: 'none', border: 'none', cursor: 'pointer', color: '#334155',
    textDecoration: 'underline dotted', textDecorationColor: '#94a3b8',
    fontSize: '0.83rem', padding: 0, textAlign: 'left', fontWeight: 400,
    display: 'flex', alignItems: 'center', gap: 5,
  },
  unmappedDot: {
    display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
    background: '#f59e0b', flexShrink: 0,
  },
  subtotalRow: { background: '#f8fafc', borderTop: '1px solid #e2e8f0', borderBottom: '1px solid #e2e8f0' },
  tdBoldLabel: { padding: '0.55rem 0.9rem', color: '#1e293b', fontWeight: 700, paddingLeft: 24 },
  tdBoldAmt:   { padding: '0.55rem 0.9rem', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  ratioRow: { background: '#f0fdf4', borderBottom: '1px solid #e2e8f0' },
  tdRatioLabel: { padding: '0.45rem 0.9rem', color: '#166534', fontStyle: 'italic', paddingLeft: 24, fontSize: '0.8rem' },
  totalExpRow: { background: '#fff7ed', borderTop: '2px solid #e2e8f0' },
  tdTotalLabel: { padding: '0.65rem 0.9rem', color: '#7c2d12', fontWeight: 800, fontSize: '0.85rem' },
  tdTotalAmt:   { padding: '0.65rem 0.9rem', textAlign: 'right', fontWeight: 800, fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  ebitdaRow: { background: '#f0fdf4', borderTop: '2px solid #e2e8f0', borderBottom: '2px solid #e2e8f0' },
  tdEbitdaLabel: { padding: '0.75rem 0.9rem', fontWeight: 900, fontSize: '0.92rem', color: '#14532d' },
  tdEbitdaAmt:   { padding: '0.75rem 0.9rem', textAlign: 'right', fontWeight: 900, fontSize: '0.92rem', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  unmappedPanel: {
    marginTop: 20, background: '#fffbeb', border: '1px solid #fde68a',
    borderRadius: 10, padding: '1rem 1.1rem',
  },
  unmappedTitle: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontWeight: 700, color: '#92400e', fontSize: '0.85rem', marginBottom: 4,
  },
  unmappedNote: { color: '#92400e', fontSize: '0.77rem', marginBottom: 8 },
};
