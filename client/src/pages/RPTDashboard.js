import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, ChevronDown, ChevronUp, Link2 } from 'lucide-react';
import { api } from '../utils/api';
import { LedgerMappingModal, RPTDrillDown } from '../components/RPTLedgerMapping';

// ─── FY & Period helpers ───────────────────────────────────────────────────────
const FY_OPTIONS = [
  { key: 'fy2425', label: 'F.Y. 2024-25', year: 2024 },
  { key: 'fy2526', label: 'F.Y. 2025-26', year: 2025 },
  { key: 'fy2627', label: 'F.Y. 2026-27', year: 2026 },
  { key: 'fy2728', label: 'F.Y. 2027-28', year: 2027 },
];

function getPeriodsForFY(fy) {
  const y = fy.year;
  const y1 = y + 1;
  return [
    { id: 'Q1',   label: 'Q1 (Apr–Jun)',  start: `${y}-04-01`,   end: `${y}-06-30`   },
    { id: 'Q2',   label: 'Q2 (Jul–Sep)',  start: `${y}-07-01`,   end: `${y}-09-30`   },
    { id: 'H1',   label: 'H1 (Apr–Sep)',  start: `${y}-04-01`,   end: `${y}-09-30`   },
    { id: 'Q3',   label: 'Q3 (Oct–Dec)',  start: `${y}-10-01`,   end: `${y}-12-31`   },
    { id: 'Q4',   label: 'Q4 (Jan–Mar)',  start: `${y1}-01-01`,  end: `${y1}-03-31`  },
    { id: 'H2',   label: 'H2 (Oct–Mar)', start: `${y}-10-01`,   end: `${y1}-03-31`  },
    { id: 'Full', label: 'Full Year',     start: `${y}-04-01`,   end: `${y1}-03-31`  },
  ];
}

function inPeriod(date, start, end) {
  return date >= start && date <= end;
}

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCr(n) {
  if (n == null) return '—';
  return (Number(n) / 1e7).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Cr';
}

function statusColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'paid') return '#15803D';
  if (s === 'overdue') return '#DC2626';
  if (s === 'void') return '#5D6C7B';
  return '#9BA8B0';
}

// ─── Limit utilization card ────────────────────────────────────────────────────
function LimitCard({ party, salesData, purchaseData, loansData, onDrill }) {
  const limitAmt = party.limitCr != null ? party.limitCr * 1e7 : null;

  const salesTotal = salesData
    ? (salesData.invoices || []).reduce((s, i) => s + (i.basic || 0), 0)
    : 0;
  const purchaseTotal = purchaseData
    ? (purchaseData.bills || []).reduce((s, b) => s + (b.basic || 0), 0)
    : 0;
  const loanGiven = loansData
    ? (loansData.entries || []).reduce((s, e) => s + (e.given || 0), 0)
    : 0;

  const used = salesTotal + purchaseTotal + loanGiven;
  const pct  = limitAmt ? Math.min((used / limitAmt) * 100, 100) : 0;
  const barColor = pct > 90 ? '#DC2626' : pct > 70 ? '#B45309' : '#1C4942';

  return (
    <div style={S.limitCard}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={S.partyName}>{party.name}</div>
          <span style={{ ...S.badge, background: '#EAF4EF', color: party.relation === 'Subsidiary' ? '#1C4942' : party.relation === 'Associate' ? '#818cf8' : '#9BA8B0' }}>
            {party.relation}
          </span>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: '#5D6C7B', fontSize: '0.72rem', marginBottom: 2 }}>Omnibus Limit</div>
          <div style={{ color: limitAmt ? '#18191B' : '#5D6C7B', fontWeight: 700, fontSize: '0.95rem' }}>
            {limitAmt ? fmtCr(limitAmt) : 'N/A'}
          </div>
        </div>
      </div>

      {/* Transactions show for every party; Available / utilisation only where a limit is approved */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: '0.78rem' }}>
        <div><span style={{ color: '#5D6C7B' }}>Sales: </span><span style={{ color: '#15803D', cursor: 'pointer' }} title="View transactions" onClick={() => onDrill('sales')}>₹{fmt(salesTotal)}</span></div>
        <div><span style={{ color: '#5D6C7B' }}>Purchase: </span><span style={{ color: '#B45309', cursor: 'pointer' }} title="View transactions" onClick={() => onDrill('purchase')}>₹{fmt(purchaseTotal)}</span></div>
        <div><span style={{ color: '#5D6C7B' }}>Loans: </span><span style={{ color: '#818cf8', cursor: 'pointer' }} title="View transactions" onClick={() => onDrill('loans')}>₹{fmt(loanGiven)}</span></div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#5D6C7B', marginBottom: 4 }}>
        <span>Used: ₹{fmt(used)}</span>
        <span>Available: {limitAmt ? `₹${fmt(Math.max(0, limitAmt - used))}` : 'N/A'}</span>
      </div>
      {limitAmt ? (
        <>
          <div style={{ background: '#EAF4EF', borderRadius: 4, height: 6 }}>
            <div style={{ width: `${pct}%`, height: 6, borderRadius: 4, background: barColor, transition: 'width 0.4s' }} />
          </div>
          <div style={{ textAlign: 'right', fontSize: '0.7rem', color: barColor, marginTop: 3 }}>{pct.toFixed(1)}% utilized</div>
        </>
      ) : (
        <div style={{ textAlign: 'right', fontSize: '0.7rem', color: '#9BA8B0', marginTop: 3 }}>No omnibus limit</div>
      )}
    </div>
  );
}

// ─── Invoice / Bill table ──────────────────────────────────────────────────────
function TransactionTable({ type, partyName, data, period, fyStart, loading }) {
  const [open, setOpen] = useState(false);
  if (loading) return <div style={S.tableWrap}><div style={S.emptyMsg}>Loading…</div></div>;
  if (!data) return null;

  const rows   = type === 'sales' ? (data.invoices || []) : (data.bills || []);
  const pStart = period.start;
  const pEnd   = period.end;
  const isFYStart = pStart === fyStart;

  const openingBal = (() => {
    if (type === 'sales') {
      if (isFYStart) return data.openingBal || 0;
      // For mid-FY periods: server openingBal + invoices from FY start up to pStart
      const priorInFY = rows.filter(r => r.date >= fyStart && r.date < pStart);
      return (data.openingBal || 0) + priorInFY.reduce((s, r) => s + r.total, 0);
    }
    const priorBills = rows.filter(r => r.date >= fyStart && r.date < pStart);
    return priorBills.reduce((s, r) => s + r.balance, 0);
  })();

  const periodRows  = rows.filter(r => inPeriod(r.date, pStart, pEnd));
  const periodTotal = periodRows.reduce((s, r) => s + r.total, 0);

  const closingBal = (() => {
    if (type === 'sales') {
      // For Full Year or Q1 we have the actual payments total from server
      const periodPay = isFYStart ? (data.paymentsTotal || 0) : 0;
      return openingBal + periodTotal - periodPay;
    }
    return openingBal + periodRows.reduce((s, r) => s + r.balance, 0);
  })();

  const noActivity = periodRows.length === 0 && openingBal === 0;

  return (
    <div style={S.tableWrap}>
      <button style={S.tableToggle} onClick={() => setOpen(o => !o)}>
        <span style={{ color: '#9BA8B0', fontSize: '0.82rem' }}>{partyName}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {noActivity && <span style={S.nilBadge}>NIL</span>}
          {!noActivity && <span style={{ fontSize: '0.78rem', color: '#5D6C7B' }}>{periodRows.length} txn{periodRows.length !== 1 ? 's' : ''}</span>}
          {open ? <ChevronUp size={14} color="#5D6C7B" /> : <ChevronDown size={14} color="#5D6C7B" />}
        </span>
      </button>

      {open && (
        <table style={S.table}>
          <thead>
            <tr>
              <th style={{ ...S.th, textAlign: 'left' }}>{type === 'sales' ? 'Invoice Date' : 'Bill Date'}</th>
              <th style={{ ...S.th, textAlign: 'left' }}>{type === 'sales' ? 'Invoice No.' : 'Bill No.'}</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Basic (₹)</th>
              <th style={{ ...S.th, textAlign: 'right' }}>GST (₹)</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Total (₹)</th>
              <th style={{ ...S.th, textAlign: 'right', width: 80 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {/* Opening Balance row */}
            <tr style={S.balanceRow}>
              <td colSpan={2} style={{ ...S.td, color: '#9BA8B0', fontStyle: 'italic' }}>Opening Balance (as at {pStart})</td>
              <td colSpan={3} style={{ ...S.td }} />
              <td style={{ ...S.td, textAlign: 'right', color: '#18191B', fontWeight: 700 }}>₹{fmt(openingBal)}</td>
            </tr>

            {/* Transaction rows */}
            {periodRows.length === 0 && (
              <tr><td colSpan={6} style={{ ...S.td, textAlign: 'center', color: '#5D6C7B', fontStyle: 'italic' }}>No transactions in this period</td></tr>
            )}
            {periodRows.map((row, i) => (
              <tr key={row.invoice_id || row.bill_id} style={i % 2 === 0 ? S.rowEven : S.rowOdd}>
                <td style={S.td}>{row.date}</td>
                <td style={{ ...S.td, color: '#1C4942' }}>{row.invoice_number || row.bill_number}</td>
                <td style={{ ...S.td, textAlign: 'right' }}>{row.basic ? fmt(row.basic) : '—'}</td>
                <td style={{ ...S.td, textAlign: 'right' }}>{row.gst ? fmt(row.gst) : '—'}</td>
                <td style={{ ...S.td, textAlign: 'right', fontWeight: 600 }}>₹{fmt(row.total)}</td>
                <td style={{ ...S.td, textAlign: 'right' }}>
                  <span style={{ color: statusColor(row.status), fontSize: '0.75rem', textTransform: 'capitalize' }}>{row.status}</span>
                </td>
              </tr>
            ))}

            {/* Period Totals row */}
            {periodRows.length > 0 && (
              <tr style={{ background: '#EAF4EF', borderTop: '2px solid #DFE7E3' }}>
                <td colSpan={2} style={{ ...S.td, color: '#5D6C7B', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Period Total ({periodRows.length} txn{periodRows.length !== 1 ? 's' : ''})
                </td>
                <td style={{ ...S.td, textAlign: 'right', color: '#1C4942', fontWeight: 700 }}>
                  {fmt(periodRows.reduce((s, r) => s + (r.basic || 0), 0))}
                </td>
                <td style={{ ...S.td, textAlign: 'right', color: '#9BA8B0', fontWeight: 700 }}>
                  {fmt(periodRows.reduce((s, r) => s + (r.gst || 0), 0))}
                </td>
                <td style={{ ...S.td, textAlign: 'right', color: '#18191B', fontWeight: 700 }}>
                  ₹{fmt(periodRows.reduce((s, r) => s + (r.total || 0), 0))}
                </td>
                <td style={S.td} />
              </tr>
            )}

            {/* Closing Balance row */}
            <tr style={S.balanceRow}>
              <td colSpan={2} style={{ ...S.td, color: '#9BA8B0', fontStyle: 'italic' }}>Closing Balance</td>
              <td colSpan={3} style={{ ...S.td }} />
              <td style={{ ...S.td, textAlign: 'right', color: '#15803D', fontWeight: 700 }}>₹{fmt(closingBal)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Loans table ───────────────────────────────────────────────────────────────
function LoansTable({ partyName, data, period, fyStart }) {
  const [open, setOpen] = useState(false);
  const all     = data?.entries || [];
  const entries = all.filter(e => inPeriod(e.date, period.start, period.end));
  // FY opening + movements earlier in the FY, so mid-year periods (Q2, H2, …) open correctly
  const openingBal = all
    .filter(e => e.date >= fyStart && e.date < period.start)
    .reduce((s, e) => s + (e.given || 0) - (e.repaid || 0), data?.openingBal || 0);
  const totalGiven  = entries.reduce((s, e) => s + (e.given || 0), 0);
  const totalRepaid = entries.reduce((s, e) => s + (e.repaid || 0), 0);
  const closingBal  = openingBal + totalGiven - totalRepaid;

  return (
    <div style={S.tableWrap}>
      <button style={S.tableToggle} onClick={() => setOpen(o => !o)}>
        <span style={{ color: '#9BA8B0', fontSize: '0.82rem' }}>{partyName}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {entries.length === 0 && openingBal === 0 && <span style={S.nilBadge}>NIL</span>}
          {!(entries.length === 0 && openingBal === 0) && <span style={{ fontSize: '0.78rem', color: '#5D6C7B' }}>{entries.length} txn{entries.length !== 1 ? 's' : ''}</span>}
          {open ? <ChevronUp size={14} color="#5D6C7B" /> : <ChevronDown size={14} color="#5D6C7B" />}
        </span>
      </button>

      {open && (
        <table style={S.table}>
          <thead>
            <tr>
              <th style={{ ...S.th, textAlign: 'left' }}>Transaction Date</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Opening Bal (₹)</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Given Amt (₹)</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Repaid Amt (₹)</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Closing Bal (₹)</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr><td colSpan={5} style={{ ...S.td, textAlign: 'center', color: '#5D6C7B', fontStyle: 'italic' }}>No transactions in this period</td></tr>
            )}
            {entries.reduce((acc, e, i) => {
              const prev = i === 0 ? openingBal : acc[i - 1].running;
              const running = prev + (e.given || 0) - (e.repaid || 0);
              acc.push({ ...e, opening: prev, running });
              return acc;
            }, []).map((e, i) => (
              <tr key={i} style={i % 2 === 0 ? S.rowEven : S.rowOdd}>
                <td style={S.td}>{e.date}</td>
                <td style={{ ...S.td, textAlign: 'right' }}>{fmt(e.opening)}</td>
                <td style={{ ...S.td, textAlign: 'right', color: e.given ? '#15803D' : '#5D6C7B' }}>{e.given ? fmt(e.given) : '—'}</td>
                <td style={{ ...S.td, textAlign: 'right', color: e.repaid ? '#DC2626' : '#5D6C7B' }}>{e.repaid ? fmt(e.repaid) : '—'}</td>
                <td style={{ ...S.td, textAlign: 'right', fontWeight: 600 }}>{fmt(e.running)}</td>
              </tr>
            ))}

            {/* Period Totals row */}
            {entries.length > 0 && (
              <tr style={{ background: '#EAF4EF', borderTop: '2px solid #DFE7E3' }}>
                <td colSpan={2} style={{ ...S.td, color: '#5D6C7B', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Total ({entries.length} txn{entries.length !== 1 ? 's' : ''})
                </td>
                <td style={{ ...S.td, textAlign: 'right', color: '#15803D', fontWeight: 700 }}>₹{fmt(totalGiven)}</td>
                <td style={{ ...S.td, textAlign: 'right', color: totalRepaid ? '#DC2626' : '#5D6C7B', fontWeight: 700 }}>{totalRepaid ? `₹${fmt(totalRepaid)}` : '—'}</td>
                <td style={S.td} />
              </tr>
            )}

            <tr style={S.balanceRow}>
              <td style={{ ...S.td, color: '#9BA8B0', fontStyle: 'italic' }}>Closing Balance</td>
              <td colSpan={3} style={S.td} />
              <td style={{ ...S.td, textAlign: 'right', color: '#15803D', fontWeight: 700 }}>₹{fmt(closingBal)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Section wrapper ───────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div style={S.section}>
      <h3 style={S.sectionTitle}>{title}</h3>
      {children}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function RPTDashboard() {
  const [selectedFY,  setSelectedFY]  = useState(FY_OPTIONS[2]); // default FY 2026-27
  const [periodIdx,   setPeriodIdx]   = useState(0);             // index into periods array
  const [parties,     setParties]     = useState([]);
  const [salesData,   setSalesData]   = useState(null);
  const [purData,     setPurData]     = useState(null);
  const [loanData,    setLoanData]    = useState(null);
  const [loading,     setLoading]     = useState({ parties: true, sales: true, purchase: true, loans: true });
  const [error,       setError]       = useState({});
  const [activeTab,   setActiveTab]   = useState('sales');
  const [showMapping, setShowMapping] = useState(false);
  const [drill,       setDrill]       = useState(null);

  const periods = getPeriodsForFY(selectedFY);
  const period  = periods[periodIdx] || periods[0];

  const loadFY = useCallback(async (fyKey, bust = false) => {
    if (bust) { try { await api.clearCache(); } catch (_) {} }
    setLoading(l => ({ ...l, sales: true, purchase: true, loans: true }));
    setError({});
    setSalesData(null);
    setPurData(null);

    api.rptLoans(fyKey)
      .then(d => { setLoanData(d); setLoading(l => ({ ...l, loans: false })); })
      .catch(() => setLoading(l => ({ ...l, loans: false })));

    api.rptSales(fyKey)
      .then(d => { setSalesData(d); setLoading(l => ({ ...l, sales: false })); })
      .catch(() => { setError(er => ({ ...er, sales: true })); setLoading(l => ({ ...l, sales: false })); });

    api.rptPurchase(fyKey)
      .then(d => { setPurData(d); setLoading(l => ({ ...l, purchase: false })); })
      .catch(() => { setError(er => ({ ...er, purchase: true })); setLoading(l => ({ ...l, purchase: false })); });
  }, []);

  const loadAll = useCallback(async (bust = false) => {
    if (bust) { try { await api.clearCache(); } catch (_) {} }
    setLoading({ parties: true, sales: true, purchase: true, loans: true });
    setError({});

    api.rptParties()
      .then(d => { setParties(d.parties || d); setLoading(l => ({ ...l, parties: false })); })
      .catch(() => setLoading(l => ({ ...l, parties: false })));

    api.rptSales(selectedFY.key)
      .then(d => { setSalesData(d); setLoading(l => ({ ...l, sales: false })); })
      .catch(() => { setError(er => ({ ...er, sales: true })); setLoading(l => ({ ...l, sales: false })); });

    api.rptPurchase(selectedFY.key)
      .then(d => { setPurData(d); setLoading(l => ({ ...l, purchase: false })); })
      .catch(() => { setError(er => ({ ...er, purchase: true })); setLoading(l => ({ ...l, purchase: false })); });

    api.rptLoans(selectedFY.key, bust)
      .then(d => { setLoanData(d); setLoading(l => ({ ...l, loans: false })); })
      .catch(() => setLoading(l => ({ ...l, loans: false })));
  }, [selectedFY.key]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // When FY changes (not on first mount — loadAll already handles it), refetch data only
  const prevFYKey = React.useRef(selectedFY.key);
  useEffect(() => {
    if (prevFYKey.current === selectedFY.key) return;
    prevFYKey.current = selectedFY.key;
    setPeriodIdx(0);
    loadFY(selectedFY.key);
  }, [selectedFY.key, loadFY]);

  const isLoading = Object.values(loading).some(Boolean);

  // Card figure → underlying transactions (same FY rows the card sums)
  const openDrill = (partyName, type) => {
    let rows = [], total = 0, label = '', totalLabel = '';
    if (type === 'sales' || type === 'purchase') {
      const list = type === 'sales' ? (salesData?.[partyName]?.invoices || []) : (purData?.[partyName]?.bills || []);
      rows = list.map(r => ({
        date: r.date, zoho_name: r.zoho_name || '—', party: partyName,
        voucher: r.invoice_number || r.bill_number, type: r.doc_type || (type === 'sales' ? 'Invoice' : 'Bill'), amount: r.basic || 0,
      }));
      total = rows.reduce((s, r) => s + r.amount, 0);
      label = type === 'sales' ? 'Sales' : 'Purchase';
      totalLabel = `Total ${label} (basic amount, as on card)`;
    } else {
      const entries = loanData?.loans?.[partyName]?.entries || [];
      rows = entries.map(e => ({
        date: e.date, zoho_name: e.ledger || 'Manual entry', party: partyName, voucher: e.voucher,
        type: [e.nature, e.type, e.given ? (e.nature ? '' : 'Given') : 'Repaid / Reversed'].filter(Boolean).join(' · '), amount: e.given ? e.given : -(e.repaid || 0),
      }));
      total = entries.reduce((s, e) => s + (e.given || 0), 0);
      label = 'Loans';
      totalLabel = 'Total Loans Given (as on card)';
    }
    setDrill({ title: `${label} — ${partyName} — ${selectedFY.label}`, rows, total, totalLabel });
  };

  // Saved mapping → server already dropped its computed RPT figures; reload them from synced data
  const onMappingChanged = () => loadFY(selectedFY.key);

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div>
          <h2 style={S.pageTitle}>Related Party Transactions</h2>
          <p style={S.pageSub}>{selectedFY.label} · Omnibus limits approved by Audit Committee</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => setShowMapping(true)} style={S.refreshBtn}>
          <Link2 size={14} style={{ marginRight: 4 }} />
          Ledger Mapping
        </button>
        <button onClick={() => loadAll(true)} disabled={isLoading} style={S.refreshBtn}>
          <RefreshCw size={14} style={{ marginRight: 4, animation: isLoading ? 'spin 1s linear infinite' : 'none' }} />
          {isLoading ? 'Loading…' : 'Refresh'}
        </button>
        </div>
      </div>

      {/* FY selector */}
      <div style={S.fyRow}>
        {FY_OPTIONS.map(fy => (
          <button
            key={fy.key}
            onClick={() => setSelectedFY(fy)}
            style={{ ...S.fyBtn, ...(selectedFY.key === fy.key ? S.fyBtnActive : {}) }}
          >
            {fy.label}
          </button>
        ))}
      </div>

      {/* Period filter */}
      <div style={S.periodRow}>
        {periods.map((p, i) => (
          <button
            key={p.id}
            onClick={() => setPeriodIdx(i)}
            style={{ ...S.periodBtn, ...(periodIdx === i ? S.periodBtnActive : {}) }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Limit utilization cards */}
      <div style={S.cardsGrid}>
        {parties.map(party => (
          <LimitCard
            key={party.name}
            party={party}
            salesData={salesData?.[party.name]}
            purchaseData={purData?.[party.name]}
            loansData={loanData?.loans?.[party.name]}
            onDrill={type => openDrill(party.name, type)}
          />
        ))}
      </div>

      {/* Tab switcher */}
      <div style={S.tabRow}>
        {['sales', 'purchase', 'loans', 'interest'].map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{ ...S.tabBtn, ...(activeTab === t ? S.tabBtnActive : {}) }}
          >
            {t === 'sales' ? 'Sales' : t === 'purchase' ? 'Purchase' : t === 'loans' ? 'Loans Given' : 'Interest Income'}
          </button>
        ))}
      </div>

      {/* Sales section */}
      {activeTab === 'sales' && (
        <Section title="Sales Transactions with Related Parties">
          {error.sales && <div style={S.errorMsg}>Failed to load sales data. Please refresh.</div>}
          {parties.map(party => (
            <TransactionTable
              key={party.name}
              type="sales"
              partyName={party.name}
              data={salesData?.[party.name]}
              period={period}
              fyStart={periods[0].start}
              loading={loading.sales}
            />
          ))}
        </Section>
      )}

      {/* Purchase section */}
      {activeTab === 'purchase' && (
        <Section title="Purchase Transactions with Related Parties">
          {error.purchase && <div style={S.errorMsg}>Failed to load purchase data. Please refresh.</div>}
          {parties.map(party => (
            <TransactionTable
              key={party.name}
              type="purchase"
              partyName={party.name}
              data={purData?.[party.name]}
              period={period}
              fyStart={periods[0].start}
              loading={loading.purchase}
            />
          ))}
        </Section>
      )}

      {/* Loans section */}
      {activeTab === 'loans' && (
        <Section title="Loans Given to Related Parties">
          <div style={S.manualNote}>
            Loan data comes from the Zoho ledgers mapped in Ledger Mapping. Parties without a mapped loan ledger show manually maintained entries.
          </div>
          {(loanData?.warnings || []).map((w, i) => <div key={i} style={S.errorMsg}>{w}</div>)}
          {parties.map(party => (
            <LoansTable
              key={party.name}
              partyName={party.name}
              data={loanData?.loans?.[party.name]}
              period={period}
              fyStart={periods[0].start}
            />
          ))}
        </Section>
      )}

      {/* Interest Income section */}
      {activeTab === 'interest' && (
        <Section title="Interest Income on Loans to Related Parties">
          <div style={S.manualNote}>
            Interest income comes from the Zoho ledgers mapped as Interest in Ledger Mapping. Parties without a mapped interest ledger show manually maintained entries.
          </div>
          {parties.map(party => (
            <LoansTable
              key={party.name}
              partyName={party.name}
              data={loanData?.interest?.[party.name]}
              period={period}
              fyStart={periods[0].start}
            />
          ))}
        </Section>
      )}

      {showMapping && (
        <LedgerMappingModal
          parties={parties.map(p => p.name)}
          onClose={() => setShowMapping(false)}
          onChanged={onMappingChanged}
        />
      )}
      {drill && <RPTDrillDown {...drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────
const S = {
  page:       { padding: '2rem', background: '#F9F9F9', minHeight: '100vh', color: '#18191B' },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' },
  pageTitle:  { margin: 0, fontSize: '1.4rem', fontWeight: 700, color: '#18191B' },
  pageSub:    { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.82rem' },
  refreshBtn: { display: 'flex', alignItems: 'center', background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#9BA8B0', padding: '0.45rem 0.9rem', borderRadius: 7, cursor: 'pointer', fontSize: '0.82rem' },

  fyRow:      { display: 'flex', gap: 6, marginBottom: '0.75rem', flexWrap: 'wrap' },
  fyBtn:      { background: '#F9F9F9', border: '1px solid #DFE7E3', color: '#5D6C7B', padding: '0.35rem 1rem', borderRadius: 20, cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, transition: 'all 0.15s' },
  fyBtnActive:{ background: '#EAF4EF', border: '1px solid #1C4942', color: '#1C4942' },

  periodRow:  { display: 'flex', gap: 6, marginBottom: '1.5rem', flexWrap: 'wrap' },
  periodBtn:  { background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', padding: '0.35rem 0.85rem', borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 500 },
  periodBtnActive: { background: '#EAF4EF', border: '1px solid #1C4942', color: '#1C4942' },

  cardsGrid:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: '2rem' },
  limitCard:  { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '1rem' },
  partyName:  { color: '#18191B', fontSize: '0.85rem', fontWeight: 600, marginBottom: 6 },
  badge:      { fontSize: '0.68rem', padding: '2px 7px', borderRadius: 3, fontWeight: 600 },

  tabRow:     { display: 'flex', gap: 0, marginBottom: '1.5rem', borderBottom: '1px solid #DFE7E3' },
  tabBtn:     { background: 'none', border: 'none', borderBottom: '2px solid transparent', color: '#5D6C7B', padding: '0.6rem 1.2rem', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500, transition: 'color 0.15s' },
  tabBtnActive: { color: '#1C4942', borderBottom: '2px solid #1C4942' },

  section:      { marginBottom: '2rem' },
  sectionTitle: { color: '#9BA8B0', fontSize: '0.85rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 0.75rem' },

  tableWrap:  { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, marginBottom: 8, overflow: 'hidden' },
  tableToggle:{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', background: 'none', border: 'none', padding: '0.75rem 1rem', cursor: 'pointer', textAlign: 'left' },
  nilBadge:   { fontSize: '0.65rem', background: '#F9F9F9', color: '#5D6C7B', padding: '2px 6px', borderRadius: 3, border: '1px solid #DFE7E3' },

  table:      { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' },
  th:         { padding: '0.5rem 1rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.73rem', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  td:         { padding: '0.55rem 1rem', borderBottom: '1px solid #DFE7E3', color: '#18191B' },
  rowEven:    { background: 'transparent' },
  rowOdd:     { background: '#F9F9F9' },
  balanceRow: { background: '#F9F9F9' },

  errorMsg:   { color: '#DC2626', fontSize: '0.82rem', padding: '0.5rem 0', marginBottom: 8 },
  manualNote: { background: '#F9F9F9', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.6rem 1rem', color: '#5D6C7B', fontSize: '0.78rem', marginBottom: 10 },
  emptyMsg:   { padding: '1.5rem', textAlign: 'center', color: '#5D6C7B', fontSize: '0.85rem' },
};
