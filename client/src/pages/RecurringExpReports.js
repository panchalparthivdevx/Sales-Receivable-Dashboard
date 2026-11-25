import React, { useEffect, useState, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import DataFreshness from '../components/DataFreshness';
import { formatINR } from '../utils/format';
import Modal from '../components/Modal';
import { VCS, FYToggle, QUARTER_MONTHS, QUARTER_LABELS } from './PurchaseDashboard';
import RecurringComparisonReport from './RecurringComparisonReport';

// ─── Recurring Exps. Reports — sub-module of Purchase & Payables ─────────────
// Home of the recurring expense reports:
// • Month-wise & Branch-wise Recurring Expense Report, moved here from the Purchase & Payables page
//   (same data: /api/purchase/charts/recurring-expense-report);
// • Recurring Expense Comparison Report (RecurringComparisonReport.js): two periods with the change
//   and the reason for it (/api/purchase/charts/recurring-expense-comparison).
// Who can open the page follows the "Recurring Exps. Reports page" tick under Purchase & Payables in User Settings.

// Fallback colours for an expense head without its own colour in HEAD_COLORS
const COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#84cc16', '#f97316'];

// Bill pop-up columns (Note only when some row is part of a bill or still an estimate)
const billCols = hasNote => [
  { key: 'account_name', label: 'Category' },
  { key: 'branch_name',  label: 'Branch' },
  { key: 'vendor_name',  label: 'Vendor Name' },
  { key: 'bill_number',  label: 'Bill No.' },
  { key: 'date',         label: 'Bill Date',          type: 'date' },
  { key: 'basic',        label: 'Basic Amount',       type: 'currency', align: 'right' },
  { key: 'gst',          label: 'GST Amount',         type: 'currency', align: 'right' },
  { key: 'tds',          label: 'TDS',                type: 'currency', align: 'right' },
  { key: 'bill_amount',  label: 'Bill Amount',        type: 'currency', align: 'right' },
  { key: 'paid_date',    label: 'Paid Date',          type: 'date' },
  { key: 'paid_amount',  label: 'Paid Amount',        type: 'currency', align: 'right' },
  { key: 'outstanding',  label: 'Outstanding Amount', type: 'currency', align: 'right' },
  ...(hasNote ? [{ key: 'note', label: 'Note' }] : []),
];

export default function RecurringExpReports() {
  const [refreshing,   setRefreshing]   = useState(false);
  const [modal,        setModal]        = useState(null);

  const [recurData,    setRecurData]    = useState(null);
  const [recurLoading, setRecurLoading] = useState(false);
  const [recurBranch,  setRecurBranch]  = useState('All Branches');
  const [recurHead,    setRecurHead]    = useState('all');
  const [recurFY,      setRecurFY]      = useState('current');
  const [recurQuarter, setRecurQuarter] = useState('all');
  const [cmpReload,    setCmpReload]    = useState(0);     // bumped by Refresh: the comparison loads again

  // Bill list pop-up (both reports): Note column only when some row is part of a bill or still an estimate
  const openBills = (title, bills) => {
    const rows = bills.map(b => ({
      ...b,
      note: [b.part != null ? `Part of bill (${b.part}%)` : '', b.est ? 'Estimate — exact figures loading' : ''].filter(Boolean).join(' · '),
    }));
    setModal({ title, rows, columns: billCols(rows.some(r => r.note)) });
  };

  const loadRecur = useCallback((fy = 'current') => {
    setRecurLoading(true);
    setRecurBranch('All Branches');
    setRecurHead('all');
    setRecurQuarter('all');
    api.purRecurExpenseReport(fy === 'current' ? null : fy)
      .then(d => setRecurData(d))
      .catch(e => console.error('recur-expense-report', e))
      .finally(() => setRecurLoading(false));
  }, []);

  useEffect(() => { loadRecur('current'); }, [loadRecur]);

  // Same as the Purchase & Payables page's Refresh: clear the server cache, then load again
  const refresh = async () => {
    setRefreshing(true);
    try { await api.clearCache(); } catch (e) { console.error('cache clear', e); }
    setRefreshing(false);
    loadRecur(recurFY);
    setCmpReload(n => n + 1);
  };

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div>
          <h1 style={S.heading}>Recurring Exps. Reports</h1>
          <p style={S.subheading}>Dev Accelerator Limited · Purchase & Payables</p>
          <DataFreshness entities={['bills_fy', 'vendor_payments_fy']} />
        </div>
        <button
          style={{ ...S.refreshBtn, opacity: refreshing || recurLoading ? 0.6 : 1 }}
          onClick={refresh}
          disabled={refreshing || recurLoading}
        >
          <RefreshCw size={16} style={{ animation: refreshing || recurLoading ? 'spin 1s linear infinite' : 'none' }} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* ── Month-wise & Branch-wise Recurring Expense Report ───────────── */}
      <RecurringExpenseReport
        data={recurData}
        loading={recurLoading}
        branch={recurBranch}
        onBranchChange={setRecurBranch}
        head={recurHead}
        onHeadChange={setRecurHead}
        fy={recurFY}
        onFYChange={fy => { setRecurFY(fy); loadRecur(fy); }}
        quarter={recurQuarter}
        onQuarterChange={setRecurQuarter}
        onCellClick={openBills}
      />

      {/* ── Recurring Expense Comparison Report ─────────────────────────── */}
      <RecurringComparisonReport headColors={HEAD_COLORS} reloadKey={cmpReload} onBillsClick={openBills} />

      {modal && <Modal title={modal.title} data={modal.rows} columns={modal.columns} totals wide onClose={() => setModal(null)} />}

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

// ─── Month-wise & Branch-wise Recurring Expense Report (moved unchanged from PurchaseDashboard.js) ──
const HEAD_COLORS = {
  hk_material: '#3b82f6', hk_service: '#8b5cf6', internet: '#06b6d4',
  security: '#f59e0b', tc_machine: '#f97316', tc_milk: '#10b981', electricity: '#ef4444',
};

// Value colours of the recurring expense table
const RX = { basic: '#18191B', bill: '#2563EB', out: '#DC2626', dash: '#9BA8B0', total: '#B45309' };
const RX_COLS = [['basic', 'Basic Amt.'], ['bill', 'Bill Amt.'], ['outstanding', 'Outstanding Amt.']];

function RecurringExpenseReport({ data, loading, branch, onBranchChange, head, onHeadChange, fy, onFYChange, quarter, onQuarterChange, onCellClick }) {
  // Expense-head expand/collapse: head key → true (open) / false (closed).
  // A head not in the map is closed, except when only one head is shown or a single branch is picked.
  const [openHeads, setOpenHeads] = useState({});

  const allMonths   = data?.months       || [];
  const allRows     = data?.rows         || [];
  const allBranches = data?.all_branches || ['All Branches'];
  const allHeads    = data?.heads        || [];

  const qMonthNums = QUARTER_MONTHS[quarter] || null;
  const months     = qMonthNums ? allMonths.filter(m => qMonthNums.includes(parseInt(m.key.slice(5, 7), 10))) : allMonths;
  const monthKeys  = months.map(m => m.key);
  const periodText = qMonthNums ? `${QUARTER_LABELS[quarter]} ${data?.fy || ''}`.trim() : (data?.fy || 'FY');

  const rows = allRows.filter(r => {
    if (branch !== 'All Branches' && r.branch !== branch) return false;
    if (head   !== 'all'          && r.head_key !== head)  return false;
    return true;
  });

  // Group rows by head_key (the server sends them in head order)
  const groups = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.key === r.head_key) last.rows.push(r);
    else groups.push({ key: r.head_key, label: r.head_label, rows: [r] });
  }

  const headOpenByDefault = groups.length === 1 || branch !== 'All Branches';
  const isHeadOpen   = k => (k in openHeads ? openHeads[k] : headOpenByDefault);
  const toggleHead   = k => setOpenHeads(p => ({ ...p, [k]: !isHeadOpen(k) }));
  const setAllHeads  = open => setOpenHeads(p => {
    const next = { ...p };
    for (const g of groups) next[g.key] = open;
    return next;
  });
  const openHeadCount = groups.filter(g => isHeadOpen(g.key)).length;

  // Basic / Bill / Outstanding (and the bills behind them) over some rows × some months
  const sumOf = (list, keys) => {
    const s = { basic: 0, bill: 0, outstanding: 0, bills: [] };
    for (const r of list) for (const k of keys) {
      const c = r.monthly?.[k];
      if (!c) continue;
      s.basic += c.basic || 0; s.bill += c.bill || 0; s.outstanding += c.outstanding || 0;
      for (const b of c.bills || []) s.bills.push(b);
    }
    return s;
  };

  // Chart: basic amount per expense head per month
  const chartData = months.map(m => {
    const pt = { name: m.label };
    for (const h of allHeads) pt[h.key] = sumOf(rows.filter(r => r.head_key === h.key), [m.key]).basic;
    return pt;
  });

  // Click on a figure → its bills (an Outstanding figure lists only the bills still unpaid)
  const openBills = (title, s, kind) => {
    const list = kind === 'outstanding' ? s.bills.filter(b => b.outstanding > 0.5) : s.bills;
    if (list.length) onCellClick(`${title}${kind === 'outstanding' ? ' — outstanding bills' : ''}`, list);
  };
  const cells = (key, title, s, base, withCount) => {
    const show = { basic: Math.abs(s.basic) >= 0.5, bill: Math.abs(s.bill) >= 0.5, outstanding: s.outstanding >= 0.5 };
    const color = { basic: RX.basic, bill: RX.bill, outstanding: RX.out };
    return RX_COLS.map(([k]) => (
      <td key={`${key}-${k}`}
        onClick={show[k] ? e => { e.stopPropagation(); openBills(title, s, k); } : undefined}
        title={show[k] ? 'Click to see the bills' : undefined}
        style={{ ...base, color: show[k] ? color[k] : RX.dash, cursor: show[k] ? 'pointer' : 'default' }}>
        {show[k] ? formatINR(s[k]) : '—'}
        {k === 'basic' && withCount && show.basic && <span style={{ fontSize: '0.62rem', color: '#3b82f6', marginLeft: 3 }}>({s.bills.length})</span>}
      </td>
    ));
  };

  const _fmtNum = v => (Math.abs(v) >= 0.5 ? '₹' + Math.round(v).toLocaleString('en-IN') : '—');
  const exportLines = () => {
    // [label, kind, sums per month…, total] for every head, its branches and the grand total
    const out = [];
    for (const { label: hLabel, rows: hRows } of groups) {
      out.push({ label: hLabel, kind: 'head', per: months.map(m => sumOf(hRows, [m.key])), tot: sumOf(hRows, monthKeys) });
      for (const r of hRows) out.push({ label: r.branch, kind: 'branch', per: months.map(m => sumOf([r], [m.key])), tot: sumOf([r], monthKeys) });
    }
    out.push({ label: 'GRAND TOTAL', kind: 'grand', per: months.map(m => sumOf(rows, [m.key])), tot: sumOf(rows, monthKeys) });
    return out;
  };

  const exportToCSV = () => {
    const esc = s => `"${String(s).replace(/"/g, '""')}"`;
    const head1 = ['Expense Head / Branch', ...[...months.map(m => m.label), 'Total'].flatMap(l => RX_COLS.map(([, c]) => `${l} ${c}`))];
    const lines = [head1.map(esc).join(',')];
    for (const l of exportLines()) {
      const label = l.kind === 'branch' ? `   ${l.label}` : l.label;
      lines.push([esc(label), ...[...l.per, l.tot].flatMap(s => RX_COLS.map(([k]) => s[k].toFixed(2)))].join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `recurring-expenses-${(data?.fy || 'fy').replace(/\s/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const exportToPDF = () => {
    const groupsHead = [...months.map(m => m.label), 'Total'];
    const thead = `<tr><th rowspan="2">Expense Head / Branch</th>${groupsHead.map(l => `<th colspan="3" class="c">${l}</th>`).join('')}</tr>`
      + `<tr>${groupsHead.map(() => RX_COLS.map(([, c]) => `<th>${c}</th>`).join('')).join('')}</tr>`;
    const body = exportLines().map(l => {
      const cls = l.kind === 'head' ? 'gh' : l.kind === 'grand' ? 'gt' : '';
      const label = l.kind === 'branch' ? `&nbsp;&nbsp;↳ ${l.label}` : l.label;
      return `<tr class="${cls}"><td>${label}</td>${[...l.per, l.tot].map(s => RX_COLS.map(([k]) => `<td>${_fmtNum(s[k])}</td>`).join('')).join('')}</tr>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Recurring Expenses — ${data?.fy || ''}</title><style>
      body{font-family:Arial,sans-serif;font-size:8px;margin:12px;color:#18191B}
      h2{font-size:12px;margin:0 0 3px}p{font-size:8px;color:#5D6C7B;margin:0 0 8px}
      table{border-collapse:collapse;width:100%}
      th{background:#1C4942;color:#fff;padding:3px 5px;text-align:right;white-space:nowrap;font-size:8px;border:1px solid #2D6B62}
      th.c{text-align:center}th:first-child{text-align:left;min-width:140px}
      td{padding:2px 5px;text-align:right;border-bottom:1px solid #e2e8f0;white-space:nowrap}
      td:first-child{text-align:left}
      tr.gh td{background:#EAF4EF;color:#1C4942;font-weight:700}
      tr.gt td{background:#1C4942;color:#fff;font-weight:700}
      @media print{@page{size:A3 landscape;margin:8mm}body{margin:0}}
    </style></head><body>
    <h2>Month-wise &amp; Branch-wise Recurring Expense Report — ${periodText}</h2>
    <p>Basic Amt. = amount posted to the expense head · Bill Amt. = bill total payable (after TDS) · Outstanding Amt. = unpaid balance · Generated: ${new Date().toLocaleString('en-IN')}${branch !== 'All Branches' ? ' · Branch: ' + branch : ''}${head !== 'all' ? ' · Head: ' + (allHeads.find(h => h.key === head)?.label || head) : ''}</p>
    <table><thead>${thead}</thead><tbody>${body}</tbody></table>
    </body></html>`;
    const w = window.open('', '_blank', 'width=1300,height=850');
    w.document.write(html); w.document.close();
    w.addEventListener('load', () => w.print());
  };

  const anyFilter = branch !== 'All Branches' || head !== 'all' || (quarter || 'all') !== 'all';
  const clearAll  = () => { onBranchChange('All Branches'); onHeadChange('all'); onQuarterChange('all'); };
  const numCell   = { ...VCS.td, ...VCS.num };
  const grpCell   = { ...numCell, fontWeight: 700 };
  const totCell   = { ...grpCell, paddingTop: '0.75rem' };
  const stickyCol = bg => ({ position: 'sticky', left: 0, zIndex: 1, background: bg });
  const excl      = data?.excluded || {};
  const exclText  = [
    excl.journal       ? `${excl.journal.count} journal entr${excl.journal.count !== 1 ? 'ies' : 'y'}` : null,
    excl.vendor_credit ? `${excl.vendor_credit.count} vendor credit${excl.vendor_credit.count !== 1 ? 's' : ''} (${formatINR(excl.vendor_credit.amount)})` : null,
    ...Object.entries(excl).filter(([k]) => k !== 'journal' && k !== 'vendor_credit').map(([k, v]) => `${v.count} ${k.replace(/_/g, ' ')}`),
  ].filter(Boolean).join(', ');

  return (
    <div style={VCS.card}>
      {/* Header */}
      <div style={VCS.hdr}>
        <h2 style={VCS.title}>Month-wise &amp; Branch-wise Recurring Expense Report</h2>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {data && rows.length > 0 && (
            <>
              <button onClick={exportToCSV} title="Download as CSV (opens in Excel)" style={{ ...VCS.exportBtn, background: '#F0FBF4', color: '#15803D', borderColor: '#BBF7D0' }}>⬇ Excel</button>
              <button onClick={exportToPDF} title="Open printable PDF view" style={{ ...VCS.exportBtn, background: '#FFF7ED', color: '#C2410C', borderColor: '#FED7AA' }}>⬇ PDF</button>
            </>
          )}
          <FYToggle fy={fy} onChange={onFYChange} />
        </div>
      </div>

      {/* Filters */}
      <div style={VCS.filterRow}>
        <span style={VCS.filterLbl}>Filters:</span>
        <select value={branch} onChange={e => onBranchChange(e.target.value)} style={{ ...VCS.select, minWidth: 150, color: branch !== 'All Branches' ? '#1C4942' : '#18191B' }}>
          {allBranches.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={head} onChange={e => onHeadChange(e.target.value)} style={{ ...VCS.select, minWidth: 200, color: head !== 'all' ? HEAD_COLORS[head] || '#18191B' : '#18191B' }}>
          <option value="all">All Expense Heads</option>
          {allHeads.map(h => <option key={h.key} value={h.key}>{h.label}</option>)}
        </select>
        <select value={quarter || 'all'} onChange={e => onQuarterChange(e.target.value)} style={{ ...VCS.select, minWidth: 140, color: (quarter && quarter !== 'all') ? '#7C3AED' : '#18191B' }}>
          {Object.entries(QUARTER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {anyFilter && <button onClick={clearAll} style={VCS.clearBtn}>Clear</button>}
      </div>

      {!loading && data?.details_pending > 0 && (
        <div style={VCS.notice}>
          Reading exact GST and payment dates from Zoho for {data.details_pending} bill{data.details_pending !== 1 ? 's' : ''} — until then their figures are estimates (marked in the bill list). Refresh in a few minutes.
        </div>
      )}
      {!loading && data?.bills_pending > 0 && (
        <div style={VCS.notice}>
          {data.bills_pending} bill{data.bills_pending !== 1 ? 's' : ''} of {data.fy} ({formatINR(data.bills_pending_basic)} basic) {data.bills_pending !== 1 ? 'are' : 'is'} still being read from Zoho and not in the figures yet. Refresh in a few minutes.
        </div>
      )}
      {!loading && data?.ledger?.missing > 0 && (
        <div style={{ ...VCS.notice, background: '#FEF2F2', borderColor: '#FECACA', color: '#991B1B' }}>
          Zoho's ledger for {data.ledger.missing} expense head{data.ledger.missing !== 1 ? 's' : ''} could not be read{data.ledger.error ? ` (${data.ledger.error})` : ''}, so {data.ledger.missing !== 1 ? 'they are' : 'it is'} missing below. Try again in a few minutes.
        </div>
      )}

      {loading && <div style={VCS.empty}>Loading recurring expense data…</div>}
      {!loading && !data && <div style={VCS.empty}>No data available</div>}
      {!loading && data && rows.length === 0 && <div style={VCS.empty}>No data for selected filters.</div>}

      {!loading && data && rows.length > 0 && (
        <>
          {/* Stacked Bar Chart */}
          {chartData.some(pt => allHeads.some(h => (pt[h.key] || 0) > 0)) && (
            <div style={{ marginBottom: '1rem' }}>
              <p style={VCS.chartLbl}>Monthly Recurring Expense (Basic Amt.) — By Head</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                  <XAxis dataKey="name" tick={{ fill: '#5D6C7B', fontSize: 10 }} axisLine={{ stroke: '#DFE7E3' }} tickLine={false} />
                  <YAxis tickFormatter={v => `₹${(v / 100000).toFixed(0)}L`} tick={{ fill: '#5D6C7B', fontSize: 10 }} axisLine={false} tickLine={false} width={55} />
                  <Tooltip formatter={(v, name) => [formatINR(v), allHeads.find(h => h.key === name)?.label || name]} contentStyle={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, fontSize: '0.8rem' }} labelStyle={{ color: '#5D6C7B' }} cursor={{ fill: 'rgba(28,73,66,0.06)' }} />
                  {allHeads.filter(h => head === 'all' || h.key === head).map((h, i, arr) => (
                    <Bar key={h.key} dataKey={h.key} stackId="a" fill={HEAD_COLORS[h.key] || COLORS[i % COLORS.length]} radius={i === arr.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <div style={VCS.legend}>
                {allHeads.filter(h => head === 'all' || h.key === head).map(h => (
                  <span key={h.key} style={VCS.legendItem}>
                    <span style={{ ...VCS.legendSwatch, background: HEAD_COLORS[h.key] || '#9BA8B0' }} />{h.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Expand / Collapse controls */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ color: '#5D6C7B', fontSize: '0.75rem' }}>
              {openHeadCount} of {groups.length} expense head{groups.length !== 1 ? 's' : ''} expanded · click an expense head name to open or close it · click any amount to see its bills
            </span>
            <button onClick={() => setAllHeads(true)} disabled={openHeadCount === groups.length}
              style={{ ...VCS.clearBtn, opacity: openHeadCount === groups.length ? 0.5 : 1, cursor: openHeadCount === groups.length ? 'default' : 'pointer' }}>
              Expand all
            </button>
            <button onClick={() => setAllHeads(false)} disabled={openHeadCount === 0}
              style={{ ...VCS.clearBtn, opacity: openHeadCount === 0 ? 0.5 : 1, cursor: openHeadCount === 0 ? 'default' : 'pointer' }}>
              Collapse all
            </button>
          </div>

          {/* Pivot Table: per month Basic / Bill / Outstanding */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem', minWidth: 900 }}>
              <thead>
                <tr>
                  <th rowSpan={2} style={{ ...VCS.th, minWidth: 240, verticalAlign: 'bottom', ...stickyCol('#F9F9F9'), zIndex: 2 }}>Expense Head / Branch</th>
                  {months.map(m => (
                    <th key={m.key} colSpan={3} style={{ ...VCS.th, textAlign: 'center', color: '#18191B', borderLeft: '1px solid #DFE7E3' }}>{m.label}</th>
                  ))}
                  <th colSpan={3} style={{ ...VCS.th, textAlign: 'center', color: RX.total, borderLeft: '1px solid #DFE7E3' }}>Total</th>
                </tr>
                <tr>
                  {[...monthKeys, 'total'].flatMap(k => RX_COLS.map(([c, label], ci) => (
                    <th key={`${k}-${c}`} style={{ ...VCS.th, textAlign: 'right', minWidth: 95, color: c === 'bill' ? RX.bill : c === 'outstanding' ? RX.out : '#5D6C7B', ...(ci === 0 ? { borderLeft: '1px solid #DFE7E3' } : {}) }}>{label}</th>
                  )))}
                </tr>
              </thead>
              <tbody>
                {groups.map(({ key: hKey, label: hLabel, rows: hRows }) => {
                  const headColor = HEAD_COLORS[hKey] || '#64748b';
                  const isOpen    = isHeadOpen(hKey);
                  const branchTxt = branch !== 'All Branches' ? branch : 'All branches';
                  return (
                    <React.Fragment key={hKey}>
                      {/* Expense head (main) row — click its name to expand / collapse its branches */}
                      <tr style={VCS.grpRow}>
                        <td role="button" tabIndex={0} aria-expanded={isOpen}
                          title={isOpen ? 'Click to collapse' : 'Click to expand'}
                          onClick={() => toggleHead(hKey)}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHead(hKey); } }}
                          style={{ ...VCS.td, fontWeight: 700, color: headColor, whiteSpace: 'nowrap', cursor: 'pointer', ...stickyCol('#F9F9F9') }}>
                          <span style={{ display: 'inline-block', width: 14, color: '#475569', fontSize: '0.7rem' }}>{isOpen ? '▼' : '▶'}</span>
                          <span style={{ ...VCS.dot, background: headColor }} />
                          {hLabel}
                          <span style={VCS.count}>({hRows.length} branch{hRows.length !== 1 ? 'es' : ''})</span>
                        </td>
                        {months.flatMap(m => cells(m.key, `${hLabel} — ${branchTxt} — ${m.label}`, sumOf(hRows, [m.key]), grpCell))}
                        {cells('total', `${hLabel} — ${branchTxt} — ${periodText}`, sumOf(hRows, monthKeys), grpCell)}
                      </tr>
                      {/* Branch (sub) rows, only when the expense head is expanded */}
                      {isOpen && hRows.map((r, i) => (
                        <tr key={`${hKey}|||${r.branch}`} style={VCS.vendRow(i)}>
                          <td style={{ ...VCS.td, paddingLeft: '1.75rem', color: '#5D6C7B', fontSize: '0.82rem', whiteSpace: 'nowrap', ...stickyCol(i % 2 === 0 ? '#FFFFFF' : '#F9F9F9') }}>↳ {r.branch}</td>
                          {months.flatMap(m => cells(m.key, `${hLabel} — ${r.branch} — ${m.label}`, sumOf([r], [m.key]), { ...numCell, fontSize: '0.82rem' }, true))}
                          {cells('total', `${hLabel} — ${r.branch} — ${periodText}`, sumOf([r], monthKeys), { ...numCell, fontSize: '0.82rem', fontWeight: 600 })}
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #DFE7E3' }}>
                  <td style={{ ...VCS.td, fontWeight: 700, color: '#18191B', paddingTop: '0.75rem', ...stickyCol('#FFFFFF') }}>GRAND TOTAL</td>
                  {months.flatMap(m => cells(m.key, `All expense heads — ${m.label}`, sumOf(rows, [m.key]), totCell))}
                  {cells('total', `All expense heads — ${periodText}`, sumOf(rows, monthKeys), { ...totCell, fontSize: '0.92rem' })}
                </tr>
              </tfoot>
            </table>
          </div>

          <p style={{ color: '#5D6C7B', fontSize: '0.72rem', margin: '0.75rem 0 0', lineHeight: 1.5 }}>
            Basic Amt. = amount the bill posted to the expense head (as in Zoho's P&amp;L) · Bill Amt. = bill total payable to the vendor (after TDS) · Outstanding Amt. = unpaid balance · month = bill date.
            {exclText && <> Not included (not bills): {exclText}.</>}
            {data.ledger?.fetched_at && <> Zoho ledger read {new Date(data.ledger.fetched_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{data.ledger.refreshing ? ' — updating now' : ''}.</>}
          </p>
        </>
      )}
    </div>
  );
}
