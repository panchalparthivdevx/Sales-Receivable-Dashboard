import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, Download, AlertTriangle, Info, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../utils/api';
import { formatDate } from '../utils/format';

// ─── Utility helpers ──────────────────────────────────────────────────────────

function fmtINR2(v) {
  if (v == null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}
function fmtPct(v) {
  return v == null ? '—' : `${(v * 100).toFixed(2)}%`;
}
// Zoho bill status ("partially_paid") → "Partially Paid" — same label as the Excel export
function billStatusLabel(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '—';
}
const round2 = v => Math.round(v * 100) / 100;

// Link is attached to the page and the object URL released later — some browsers
// cancel the download if it is revoked straight after click().
function saveBlob(data, filename) {
  const url = window.URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => window.URL.revokeObjectURL(url), 60000);
}

// Blob responses carry the server's JSON error inside the Blob
async function exportError(e) {
  const body = e.response?.data;
  if (body instanceof Blob) {
    try { const j = JSON.parse(await body.text()); if (j.error) return j.error; } catch (_) {}
  }
  return e.message;
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    'Approaching 180 Days': '#f59e0b',
    '180 Days Completed':   '#f97316',
    'Beyond 180 Days':      '#ef4444',
    'Within 180 Days':      '#64748b',
  };
  const c = map[status] || '#64748b';
  return (
    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700, lineHeight: 1.35, background: `${c}18`, color: c, border: `1px solid ${c}40` }}>
      {status}
    </span>
  );
}

function SummaryStat({ label, value, accent }) {
  return (
    <div style={{ background: accent ? '#DC26260A' : '#FFFFFF', border: `1px solid ${accent ? '#DC262630' : '#DFE7E3'}`, borderRadius: 8, padding: '0.35rem 0.75rem' }}>
      <div style={{ fontSize: '0.62rem', color: '#5D6C7B', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: '0.85rem', fontWeight: 700, fontFamily: 'monospace', color: accent ? '#DC2626' : '#1C4942', whiteSpace: 'nowrap', marginTop: 1 }}>{value}</div>
    </div>
  );
}

// ─── ReportTable ──────────────────────────────────────────────────────────────
// Layout: title → filters → summary → top scrollbar → detailed report table.
// itcKey/itcLabel: Report 1 shows the indicative (potential) reversal, Report 2 the required one.
// onExport(rows) receives exactly the rows currently shown (after search/filters).

function ReportTable({ title, subtitle, rows, emptyMsg, itcKey, itcLabel, itcTitle, onExport, defaultOpen = true }) {
  const [search, setSearch]       = useState('');
  const [vendor, setVendor]       = useState('');
  const [status, setStatus]       = useState('');
  const [open, setOpen]           = useState(defaultOpen);
  const [exporting, setExporting] = useState(false);

  const vendors  = useMemo(() => [...new Set(rows.map(r => r.vendor_name))].sort((a, b) => a.localeCompare(b)), [rows]);
  const statuses = useMemo(() => [...new Set(rows.map(r => r.status180))], [rows]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => rows.filter(r =>
    (!vendor || r.vendor_name === vendor) &&
    (!status || r.status180 === status) &&
    (!q ||
      r.vendor_name.toLowerCase().includes(q) ||
      (r.gstin || '').toLowerCase().includes(q) ||
      (r.bill_number || '').toLowerCase().includes(q))
  ), [rows, vendor, status, q]);
  const filtersOn = !!(q || vendor || status);
  const sum = key => round2(filtered.reduce((s, r) => s + (r[key] || 0), 0));
  // Report 1 only: bills that completed exactly 180 days today already count as required
  const nowRequired = itcKey !== 'itc_reversal_required' ? sum('itc_reversal_required') : 0;

  // Top scrollbar: a real scroll container whose inner width tracks the table's scroll width
  const topRef   = useRef(null);
  const tableRef = useRef(null);
  const [scrollW, setScrollW]         = useState(0);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = tableRef.current;
    if (!el) return undefined;
    const measure = () => {
      setScrollW(el.scrollWidth);
      setOverflowing(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [open, filtered.length]);
  // Writes only when positions differ, so the echo scroll event on the other side is a no-op
  const syncScroll = (from, to) => {
    if (from.current && to.current && to.current.scrollLeft !== from.current.scrollLeft) {
      to.current.scrollLeft = from.current.scrollLeft;
    }
  };
  useEffect(() => { if (overflowing) syncScroll(tableRef, topRef); }, [overflowing, scrollW]);

  const handleExport = async () => {
    setExporting(true);
    try {
      await onExport(filtered);
    } catch (e) {
      alert('Export failed: ' + await exportError(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, overflow: 'hidden', marginBottom: '1.25rem' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '0.9rem 1.25rem', borderBottom: open ? '1px solid #DFE7E3' : 'none', cursor: 'pointer' }}
      >
        <span style={{ color: open ? '#1C4942' : '#5D6C7B', marginTop: 2, flexShrink: 0 }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>{title}</div>
          <div style={{ color: '#5D6C7B', fontSize: '0.78rem', marginTop: 3 }}>{subtitle}</div>
        </div>
        <span style={{ fontSize: '0.75rem', color: '#9BA8B0', flexShrink: 0, marginTop: 2 }}>{rows.length} bill{rows.length !== 1 ? 's' : ''}</span>
      </div>

      {open && (
      <>
      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0.65rem 1.25rem', borderBottom: '1px solid #DFE7E3', alignItems: 'center', background: '#F9F9F9' }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search vendor / GSTIN / bill #…"
          style={{ ...S.control, width: 240 }}
        />
        <select value={vendor} onChange={e => setVendor(e.target.value)} style={{ ...S.control, maxWidth: 260 }} title="Filter by vendor">
          <option value="">All vendors ({vendors.length})</option>
          {vendors.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        {statuses.length > 1 && (
          <select value={status} onChange={e => setStatus(e.target.value)} style={S.control} title="Filter by 180-day status">
            <option value="">All statuses</option>
            {statuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {filtersOn && (
          <button onClick={() => { setSearch(''); setVendor(''); setStatus(''); }} style={S.linkBtn}>Clear filters</button>
        )}
        <span style={{ flex: 1 }} />
        {filtersOn && <span style={{ fontSize: '0.75rem', color: '#9BA8B0' }}>{filtered.length} of {rows.length} bills</span>}
        <button
          onClick={handleExport} disabled={exporting || filtered.length === 0} style={S.btn}
          title={filtersOn ? 'Export the filtered rows shown below' : 'Export all rows in this report'}
        >
          <Download size={13} /> {exporting ? 'Exporting…' : 'Export'}
        </button>
      </div>

      {/* Summary / totals — of the rows currently shown */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0.75rem 1.25rem', borderBottom: '1px solid #DFE7E3' }}>
        <SummaryStat label="Bills"        value={filtered.length} />
        <SummaryStat label="Basic Amount" value={fmtINR2(sum('sub_total'))} />
        <SummaryStat label="GST Amount"   value={fmtINR2(sum('gst_amount'))} />
        <SummaryStat label="Bill Amount"  value={fmtINR2(sum('bill_total'))} />
        <SummaryStat label="Paid Amount"  value={fmtINR2(sum('paid_amount'))} />
        <SummaryStat label="Balance Due"  value={fmtINR2(sum('balance_due'))} />
        <SummaryStat label={itcLabel}     value={fmtINR2(sum(itcKey))} accent />
        {nowRequired > 0 && (
          <SummaryStat label="of which now required (180 days completed)" value={fmtINR2(nowRequired)} accent />
        )}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#9BA8B0', fontSize: '0.83rem' }}>
          {rows.length === 0 ? emptyMsg : 'No bills match the current filters.'}
        </div>
      ) : (
        <>
          {/* Top horizontal scrollbar — drives the table below */}
          <div
            ref={topRef} onScroll={() => syncScroll(topRef, tableRef)} className="gst-hscroll"
            style={{ overflowX: 'auto', overflowY: 'hidden', display: overflowing ? 'block' : 'none', background: '#F9F9F9' }}
          >
            <div style={{ width: scrollW, height: 1 }} />
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0.55rem 1.25rem 0.45rem', borderTop: '1px solid #DFE7E3' }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#1C4942', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Detailed Report</span>
            <span style={{ fontSize: '0.72rem', color: '#9BA8B0' }}>{filtered.length} bill{filtered.length !== 1 ? 's' : ''}</span>
          </div>

          <div ref={tableRef} onScroll={() => syncScroll(tableRef, topRef)} className="gst-hscroll" style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Vendor Name</th>
                  <th style={S.th}>GSTIN</th>
                  <th style={S.th}>Bill #</th>
                  <th style={S.th}>Txn Posting Date</th>
                  <th style={S.thNum}>Basic Invoice Amount</th>
                  <th style={S.thNum}>GST Amount</th>
                  <th style={S.thNum} title="Zoho Books bill total — net of TDS where TDS is deducted">Bill Amount</th>
                  <th style={S.thNum}>Paid Amount</th>
                  <th style={S.thNum}>Balance Due</th>
                  <th style={S.th}>180-Day Due Date</th>
                  <th style={S.thNum}>Days Outstanding</th>
                  <th style={S.thNum}>Days Remaining</th>
                  <th style={S.th}>Status</th>
                  <th style={S.thNum} title={itcTitle}>{itcLabel}</th>
                  <th style={S.thNum} title="Balance Due ÷ Bill Amount">Outstanding %</th>
                  <th style={S.th}>Vendor Bill Date</th>
                  <th style={S.th}>Zoho Bill Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={r.bill_id || i} style={{
                    background: r.status180 === 'Beyond 180 Days' ? 'rgba(239,68,68,0.05)'
                      : r.status180 === '180 Days Completed' ? 'rgba(249,115,22,0.05)'
                      : 'rgba(245,158,11,0.04)',
                  }}>
                    <td style={S.tdText}><div style={{ minWidth: 160, maxWidth: 240 }}>{r.vendor_name}</div></td>
                    <td style={{ ...S.tdText, fontFamily: 'monospace', fontSize: '0.75rem', color: '#5D6C7B' }}><div style={{ minWidth: 118, maxWidth: 150 }}>{r.gstin}</div></td>
                    <td style={{ ...S.tdText, fontFamily: 'monospace', fontSize: '0.78rem' }}><div style={{ minWidth: 122, maxWidth: 180 }}>{r.bill_number}</div></td>
                    <td style={S.td}>{formatDate(r.transaction_posting_date)}</td>
                    <td style={S.num}>{r.pending_gst_amount ? '—' : fmtINR2(r.sub_total)}</td>
                    <td style={S.num}>
                      {r.pending_gst_amount
                        ? <span style={{ color: '#f59e0b' }} title="Fetching exact GST amount from Zoho Books…">Fetching…</span>
                        : fmtINR2(r.gst_amount)}
                    </td>
                    <td style={S.num}>{fmtINR2(r.bill_total)}</td>
                    <td style={S.num}>{fmtINR2(r.paid_amount)}</td>
                    <td style={S.num}>{fmtINR2(r.balance_due)}</td>
                    <td style={S.td}>{formatDate(r.due_date_180)}</td>
                    <td style={S.num}>{r.days_outstanding}d</td>
                    <td style={{ ...S.num, color: (r.days_remaining <= 7 && r.days_remaining >= 0) ? '#fbbf24' : '#9BA8B0', fontWeight: (r.days_remaining <= 7 && r.days_remaining >= 0) ? 700 : 400 }}>
                      {r.days_remaining}d
                    </td>
                    <td style={S.tdText}><div style={{ minWidth: 142, maxWidth: 170 }}><StatusBadge status={r.status180} /></div></td>
                    <td
                      style={{ ...S.num, fontWeight: 700, color: r[itcKey] ? '#DC2626' : '#9BA8B0' }}
                      title={itcKey !== 'itc_reversal_required' && r.itc_reversal_required > 0
                        ? '180 days completed — reversal now required (included in the ITC Reversal Required card)'
                        : undefined}
                    >
                      {r.pending_gst_amount || r[itcKey] == null ? '—' : fmtINR2(r[itcKey])}
                    </td>
                    <td style={S.num}>{fmtPct(r.outstanding_pct)}</td>
                    <td style={S.td}>{formatDate(r.bill_date)}</td>
                    <td style={S.tdText}><div style={{ minWidth: 70, maxWidth: 120 }}>{billStatusLabel(r.status)}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      </>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function GSTDashboard() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await api.gst180Report();
      setData(d);
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // While GST amounts are still being fetched from Zoho in the background, keep polling
  useEffect(() => {
    if (!data || !data.pending_enrichment) return;
    const t = setTimeout(load, 20000);
    return () => clearTimeout(t);
  }, [data, load]);

  // Full workbook — both reports + summary
  const handleExport = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const r = await api.gst180Export({ report1: data.report1, report2: data.report2, summary: data.summary, as_of_date: data.as_of_date, excluded_no_gstin: data.excluded_no_gstin });
      saveBlob(r.data, `GST_180_Day_ITC_Reversal_Report_${data.as_of_date}.xlsx`);
    } catch (e) {
      alert('Export failed: ' + await exportError(e));
    } finally {
      setExporting(false);
    }
  };

  // Single report — only the rows that report is currently showing
  const exportReport = async (report, rows) => {
    const r = await api.gst180Export({ report, rows, as_of_date: data.as_of_date });
    saveBlob(r.data, report === 'approaching' ? 'GST_180_Day_Approaching_Report.xlsx' : 'GST_180_Day_Beyond_Report.xlsx');
  };

  const summary = data?.summary || {};

  // 4 + 3 grid: volumes on the first row, GST / ITC amounts on the second
  const KPI_CARDS = data ? [
    { label: 'Bills Tracked',            val: summary.total_tracked,               color: '#6366f1' },
    { label: 'Approaching 180 Days',     val: summary.approaching_count,           color: '#f59e0b' },
    { label: 'Beyond 180 Days',          val: summary.overdue_count,               color: '#ef4444' },
    { label: 'Basic Amount',             val: fmtINR2(summary.basic_amount),       color: '#1C4942', wide: true,
      title: 'Total Basic Invoice Amount of all tracked bills (Report 1 + Report 2)' },
    { label: 'GST — Approaching',        val: fmtINR2(summary.approaching_gst_amount), color: '#f59e0b', wide: true },
    { label: 'GST — Beyond 180 Days',    val: fmtINR2(summary.overdue_gst_amount),     color: '#ef4444', wide: true },
    { label: 'ITC Reversal Required',    val: fmtINR2(summary.itc_reversal_required_amount), color: '#DC2626', wide: true,
      title: 'Sum of proportionate ITC reversal — GST × (Balance Due ÷ Bill Amount) — on bills that have completed 180 days. Not the total GST amount.' },
  ] : [];

  return (
    <div style={{ padding: '1.5rem 2rem', minHeight: '100vh', background: '#F9F9F9', fontFamily: "'Figtree','Inter',-apple-system,sans-serif" }}>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .gst-kpis { display: grid; grid-template-columns: repeat(4, minmax(150px, 210px)); gap: 8px; margin-bottom: 1.1rem; }
        @media (max-width: 900px) { .gst-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (max-width: 420px) { .gst-kpis { grid-template-columns: minmax(0, 1fr); } }
        .gst-hscroll::-webkit-scrollbar { height: 12px; }
        .gst-hscroll::-webkit-scrollbar-track { background: #EEF2F0; }
        .gst-hscroll::-webkit-scrollbar-thumb { background: #A9BDB5; border-radius: 6px; border: 2px solid #EEF2F0; }
        .gst-hscroll::-webkit-scrollbar-thumb:hover { background: #1C4942; }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: '1.25rem' }}>
        <div>
          <h1 style={{ color: '#18191B', fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>GST Dashboard — 180-Day ITC Reversal Monitoring</h1>
          <p style={{ color: '#5D6C7B', fontSize: '0.82rem', margin: '4px 0 0', maxWidth: 660 }}>
            Tracks vendor invoices approaching or exceeding the 180-day payment threshold and identifies applicable proportionate ITC reversal based on outstanding payment.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {data && <span style={{ fontSize: '0.72rem', color: '#9BA8B0' }}>As of {formatDate(data.as_of_date)}</span>}
          <button onClick={load} disabled={loading} title="Refresh" style={S.iconBtn}>
            <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          </button>
          <button onClick={handleExport} disabled={!data || exporting} style={S.btn} title="Both reports and the summary in one workbook">
            <Download size={13} /> {exporting ? 'Exporting…' : 'Export to Excel'}
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem' }}>
          <RefreshCw size={20} style={{ animation: 'spin 1s linear infinite', color: '#1C4942', display: 'block', margin: '0 auto 10px' }} />
          <div style={{ color: '#18191B', fontWeight: 600 }}>Loading GST 180-day report…</div>
        </div>
      )}

      {!loading && error && (
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <AlertTriangle size={24} style={{ color: '#f59e0b', display: 'block', margin: '0 auto 8px' }} />
          <div style={{ color: '#B45309', fontWeight: 600, marginBottom: 6 }}>Failed to load report</div>
          <div style={{ color: '#5D6C7B', fontSize: '0.8rem', marginBottom: 14 }}>{error}</div>
          <button onClick={load} style={S.btn}>Retry</button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div className="gst-kpis">
            {KPI_CARDS.map(k => (
              <div key={k.label} title={k.title} style={{ background: `${k.color}10`, border: `1px solid ${k.color}30`, borderRadius: 8, padding: '0.5rem 0.85rem', textAlign: 'center' }}>
                <div style={{ fontSize: k.wide ? '0.92rem' : '1.15rem', fontWeight: 700, color: k.color, fontFamily: 'monospace', lineHeight: 1.3, whiteSpace: 'nowrap' }}>{k.val}</div>
                <div style={{ fontSize: '0.66rem', color: '#5D6C7B', marginTop: 2, whiteSpace: 'nowrap' }}>{k.label}</div>
              </div>
            ))}
          </div>

          {data.pending_enrichment > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 1rem', padding: '0.6rem 0.9rem', background: '#EAF4EF', border: '1px solid #DFE7E3', borderRadius: 8, fontSize: '0.78rem', color: '#1C4942' }}>
              <Clock size={13} />
              Fetching exact GST amounts for {data.pending_enrichment} bill{data.pending_enrichment !== 1 ? 's' : ''} from Zoho Books — this list refreshes automatically every 20s until complete.
            </div>
          )}

          <ReportTable
            title="Report 1 — ITC Reversal Review: Approaching 180 Days"
            subtitle="Unpaid invoices within 7 days of the 180-day payment threshold. Review payment status and ITC position before the threshold is reached."
            rows={data.report1 || []}
            emptyMsg="No unpaid bills currently within 7 days of the 180-day mark."
            itcKey="itc_reversal_amount"
            itcLabel="Potential ITC Reversal"
            itcTitle="Indicative only — the reversal that would apply if the current balance is still unpaid at 180 days"
            onExport={rows => exportReport('approaching', rows)}
          />
          <ReportTable
            title="Report 2 — ITC Reversal Required: Beyond 180 Days"
            subtitle="Invoices outstanding beyond 180 days. Applicable ITC reversal is calculated proportionately based on the unpaid portion of the invoice."
            rows={data.report2 || []}
            emptyMsg="No unpaid bills currently beyond 180 days outstanding."
            itcKey="itc_reversal_required"
            itcLabel="ITC Reversal Required"
            itcTitle="GST Amount × (Balance Due ÷ Bill Amount)"
            onExport={rows => exportReport('beyond', rows)}
          />

          <div style={{ background: '#F9F9F9', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.9rem 1.1rem', fontSize: '0.75rem', color: '#5D6C7B', lineHeight: 1.7 }}>
            <div style={{ color: '#5D6C7B', fontWeight: 700, marginBottom: 4 }}><Info size={12} style={{ display: 'inline', marginRight: 5 }} />Notes</div>
            Only bills carrying a vendor GSTIN are included — bills from unregistered vendors or without a GSTIN are excluded{data.excluded_no_gstin > 0 ? ` (${data.excluded_no_gstin} bill${data.excluded_no_gstin !== 1 ? 's' : ''} excluded)` : ''}.<br />
            Report 1 identifies unpaid invoices within 7 days of completing 180 days. Its <strong>Potential ITC Reversal</strong> is indicative only — the reversal is not yet triggered.<br />
            Report 2 identifies invoices where payment remains outstanding beyond 180 days.<br />
            <strong>ITC Reversal Required</strong> = GST Amount × (Balance Due ÷ Bill Amount), never below ₹0 or above the GST Amount — fully paid bills reverse ₹0, fully unpaid bills reverse 100% of GST. It reflects the applicable reversal on the available Zoho data, not a confirmed reversal entry.<br />
            Bill Amount is the Zoho Books bill total (net of TDS where TDS is deducted), so Basic Invoice Amount + GST may differ from Bill Amount.<br />
            The ITC Reversal Required card also includes any bill completing exactly 180 days today (shown in Report 1 as <em>180 Days Completed</em>).<br />
            Each report's <strong>Export</strong> downloads only that report's rows, as currently filtered. <strong>Export to Excel</strong> (top right) downloads both reports with the summary.
          </div>
        </>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', tableLayout: 'auto' },
  // Headers may wrap onto two lines so labels don't dictate column width
  th:      { padding: '0.45rem 0.8rem', textAlign: 'left', verticalAlign: 'bottom', lineHeight: 1.35, fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9BA8B0', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'normal' },
  // Dates and other single-line values
  td:      { padding: '0.5rem 0.8rem', color: '#18191B', borderBottom: '1px solid #DFE7E3', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  // Text columns wrap; the inner div sets the column's min/max width
  tdText:  { padding: '0.5rem 0.8rem', color: '#18191B', borderBottom: '1px solid #DFE7E3', verticalAlign: 'middle', whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' },
  // Amounts, days and percentages never wrap
  num:     { padding: '0.5rem 0.8rem', color: '#18191B', borderBottom: '1px solid #DFE7E3', verticalAlign: 'middle', whiteSpace: 'nowrap', textAlign: 'right', fontFamily: 'monospace' },
  control: { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 5, color: '#18191B', fontSize: '0.78rem', padding: '0.35rem 0.6rem' },
  btn:     { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 6, border: '1px solid #DFE7E3', background: '#EAF4EF', color: '#1C4942', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  linkBtn: { background: 'none', border: 'none', color: '#1C4942', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', padding: 0 },
  iconBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '6px 9px', borderRadius: 6, border: '1px solid #DFE7E3', background: '#EAF4EF', color: '#5D6C7B', cursor: 'pointer' },
};
S.thNum = { ...S.th, textAlign: 'right' };
