import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { api } from '../utils/api';

// ── Formatters ────────────────────────────────────────────────────────────────
const toCr = n => n / 1e7;
const fmtCr = (n, decimals = 2) =>
  n == null || n === 0 ? '—' : `₹${toCr(n).toFixed(decimals)} Cr`;
const fmtCrShort = n =>
  n == null || n === 0 ? '—' : `₹${toCr(n).toFixed(2)} Cr`;
const fmtPct = n => (n > 0 ? n.toFixed(2) + '%' : '—');

// ── Date helpers ──────────────────────────────────────────────────────────────
const MON_MAP = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

function parseEndDate(str) {
  if (!str) return null;
  const m = str.trim().match(/^([A-Za-z]{3})-(\d{2})$/);
  if (!m || MON_MAP[m[1]] === undefined) return null;
  return new Date(2000 + parseInt(m[2]), MON_MAP[m[1]], 1);
}

function monthsToNow(dateStr) {
  if (!dateStr) return Infinity;
  const d = parseEndDate(dateStr);
  if (!d) return Infinity;
  const now = new Date();
  return (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth());
}

function endDateColor(str) {
  const m = monthsToNow(str);
  if (m <= 3)  return '#DC2626';
  if (m <= 6)  return '#f97316';
  if (m <= 12) return '#eab308';
  if (m === Infinity) return '#5D6C7B';
  return '#9BA8B0';
}

function endDateUrgency(str) {
  const m = monthsToNow(str);
  if (m <= 3)  return '🔴 ';
  if (m <= 6)  return '🟠 ';
  if (m <= 12) return '🟡 ';
  return '';
}

// ── Priority scoring ─────────────────────────────────────────────────────────
// Criteria: (1) nearest end date, (2) has FD lien → releases capital,
//           (3) highest interest rate → saves most money
function computePriority(loan) {
  let score = 0;
  const m = monthsToNow(loan.endDateStr);

  // End-date weight (max 200): nearer = more urgent = higher score
  if (m <= 3)       score += 200;
  else if (m <= 6)  score += 150;
  else if (m <= 12) score += 100;
  else if (m <= 18) score += 70;
  else if (m <= 30) score += 40;
  else if (m !== Infinity) score += 20;
  else              score += 30; // no date → medium-low

  // Interest rate weight (max 80)
  const r = loan.rate;
  if (r >= 18)      score += 80;
  else if (r >= 16) score += 65;
  else if (r >= 15) score += 50;
  else if (r >= 14) score += 40;
  else if (r >= 12) score += 25;
  else if (r >= 10) score += 15;
  else if (r > 0)   score += 10;

  // FD lien weight (max 40): paying off releases locked capital
  if (loan.fdAmount > 0) score += 40;

  return score;
}

function priorityTag(score) {
  if (score >= 200) return { label: 'Critical', bg: '#7f1d1d', color: '#fca5a5', border: '#b91c1c' };
  if (score >= 130) return { label: 'High',     bg: '#7c2d12', color: '#fdba74', border: '#ea580c' };
  if (score >= 75)  return { label: 'Medium',   bg: '#713f12', color: '#fde047', border: '#ca8a04' };
  return               { label: 'Low',      bg: '#052e16', color: '#86efac', border: '#15803D' };
}

// ── Greedy auto-select: sorts by priority, fits as many loans as possible ────
function autoSelect(loans, budget) {
  const sorted = [...loans].sort((a, b) => b.priority - a.priority);
  const sel = new Set();
  let rem = budget;
  for (const l of sorted) {
    if (l.amount <= rem) { sel.add(l.id); rem -= l.amount; }
  }
  return sel;
}

// ── Annual interest helper ────────────────────────────────────────────────────
const annualInt = l => l.amount * (l.rate / 100);

// ─────────────────────────────────────────────────────────────────────────────
export default function LoanDashboard() {
  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [ncdCr,    setNcdCr]    = useState('100');         // Cr as string (user input)
  const [ncdAmt,   setNcdAmt]   = useState(1_000_000_000); // rupees
  const [eqCr,     setEqCr]     = useState('0');           // equity Cr input
  const [eqAmt,    setEqAmt]    = useState(0);             // equity rupees
  const [selected, setSelected] = useState(new Set());
  const [autoMode, setAutoMode] = useState(true);
  const [sortCol,  setSortCol]  = useState('priority');
  const [sortDir,  setSortDir]  = useState('desc');
  const [showAll,  setShowAll]  = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addSection,   setAddSection]   = useState('institutional');
  const [addForm,      setAddForm]      = useState({ name: '', amount: '', emi: '', rate: '', endDate: '', fdAmount: '', isCC: false });
  const [exporting,    setExporting]    = useState(false);

  useEffect(() => {
    api.loanData()
      .then(d => {
        const enriched = d.institutional.map(l => ({ ...l, priority: computePriority(l) }));
        setData({ ...d, institutional: enriched });
        setSelected(autoSelect(enriched, 1_000_000_000));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Fund / Equity amount change → re-run auto selection on combined total
  const handleNcd = useCallback((val, curEqAmt) => {
    setNcdCr(val);
    const n = parseFloat(val);
    if (!isNaN(n) && n >= 0) {
      const amt   = Math.round(n * 1e7);
      const total = amt + (curEqAmt ?? eqAmt);
      setNcdAmt(amt);
      if (autoMode && data) setSelected(autoSelect(data.institutional, total));
    }
  }, [autoMode, data, eqAmt]);

  const handleEquity = useCallback((val, curNcdAmt) => {
    setEqCr(val);
    const n = parseFloat(val);
    if (!isNaN(n) && n >= 0) {
      const amt   = Math.round(n * 1e7);
      const total = (curNcdAmt ?? ncdAmt) + amt;
      setEqAmt(amt);
      if (autoMode && data) setSelected(autoSelect(data.institutional, total));
    }
  }, [autoMode, data, ncdAmt]);

  const toggleLoan = id => {
    setAutoMode(false);
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const totalAmt = ncdAmt + eqAmt;

  const resetAuto = () => {
    setAutoMode(true);
    if (data) setSelected(autoSelect(data.institutional, totalAmt));
  };

  // ── Add Loan ────────────────────────────────────────────────────────────────
  const openAddModal = section => { setAddSection(section); setAddForm({ name: '', amount: '', emi: '', rate: '', endDate: '', fdAmount: '', isCC: false }); setShowAddModal(true); };

  const submitAddLoan = () => {
    const name   = addForm.name.trim();
    const amount = Math.round(parseFloat(addForm.amount || 0) * 1e7);
    if (!name || amount <= 0) return;
    if (addSection === 'institutional') {
      const rate      = parseFloat(addForm.rate    || 0);
      const emi       = Math.round(parseFloat(addForm.emi      || 0));
      const fdAmount  = Math.round(parseFloat(addForm.fdAmount || 0) * 1e7);
      const endDateStr = addForm.endDate.trim();
      const newLoan   = { id: 'c-' + Date.now(), name, amount, emi, rate, fdAmount, endDateStr, isCC: addForm.isCC, principal: 0, totalInt: 0, custom: true };
      newLoan.priority = computePriority(newLoan);
      setData(prev => {
        const newInst = [...prev.institutional, newLoan];
        if (autoMode) setSelected(autoSelect(newInst, totalAmt));
        return { ...prev, institutional: newInst };
      });
    } else {
      setData(prev => ({ ...prev, other: [...prev.other, { id: 'c-' + Date.now(), name, amount, endDateStr: addForm.endDate.trim(), custom: true }] }));
    }
    setShowAddModal(false);
  };

  // ── Export ──────────────────────────────────────────────────────────────────
  const handleExportExcel = async () => {
    try {
      setExporting(true);
      const resp = await fetch(`/api/loans/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('da_token')}` },
        body: JSON.stringify({
          fundCr:              parseFloat(ncdCr) || 0,
          equityCr:            parseFloat(eqCr)  || 0,
          selectedIds:         [...selected],
          customInstitutional: data.institutional.filter(l => l.custom),
          customOther:         data.other.filter(l => l.custom),
        }),
      });
      if (!resp.ok) throw new Error('Export failed');
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `Loan_Report_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
    } finally {
      setExporting(false);
    }
  };

  const handleExportPDF = () => window.print();

  // ── Sort helper ─────────────────────────────────────────────────────────────
  const toggleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const sorted = useMemo(() => {
    if (!data) return [];
    const arr = [...data.institutional];
    arr.sort((a, b) => {
      let va, vb;
      if (sortCol === 'priority')    { va = a.priority;   vb = b.priority; }
      else if (sortCol === 'amount') { va = a.amount;     vb = b.amount; }
      else if (sortCol === 'rate')   { va = a.rate;       vb = b.rate; }
      else if (sortCol === 'end')    { va = monthsToNow(a.endDateStr); vb = monthsToNow(b.endDateStr); return sortDir === 'asc' ? va - vb : vb - va; }
      else if (sortCol === 'fd')     { va = a.fdAmount;   vb = b.fdAmount; }
      else                           { va = a.priority;   vb = b.priority; }
      return sortDir === 'asc' ? va - vb : vb - va;
    });
    return arr;
  }, [data, sortCol, sortDir]);

  // ── Statistics ──────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!data) return {};
    const total     = ncdAmt + eqAmt;
    const selLoans  = data.institutional.filter(l => selected.has(l.id));
    const allocated = selLoans.reduce((s, l) => s + l.amount, 0);
    const fdRel     = selLoans.reduce((s, l) => s + l.fdAmount, 0);
    const intSaved  = selLoans.reduce((s, l) => s + annualInt(l), 0);
    const fundCost  = ncdAmt * 0.10;   // fund cost assumed at 10% p.a.
    const netSaving = intSaved - fundCost;
    const totInstit = data.institutional.reduce((s, l) => s + l.amount, 0);
    const totOther  = data.other.reduce((s, l) => s + l.amount, 0);
    const totFD     = data.institutional.reduce((s, l) => s + l.fdAmount, 0);
    const fundUsed   = Math.min(allocated, ncdAmt);
    const equityUsed = Math.max(0, allocated - ncdAmt);
    return {
      allocated, fdRel, intSaved, fundCost, netSaving,
      total, fundUsed, equityUsed,
      remaining:  total - allocated,
      pctUsed:    total > 0 ? (allocated   / total) * 100 : 0,
      fundPct:    total > 0 ? (fundUsed    / total) * 100 : 0,
      equityPct:  total > 0 ? (equityUsed  / total) * 100 : 0,
      overBudget: allocated > total,
      totInstit, totOther, grand: totInstit + totOther, totFD,
    };
  }, [data, selected, ncdAmt, eqAmt]);

  if (loading) return <div style={S.center}>Loading loan data…</div>;
  if (error)   return <div style={{ ...S.center, color: '#ef4444' }}>Error: {error}</div>;
  if (!data)   return null;

  const selLoans = data.institutional.filter(l => selected.has(l.id));

  return (
    <div style={S.page}>
      <style>{`@media print{.no-print{display:none!important}.print-only{display:block!important}body{background:#fff!important}}`}</style>

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div style={S.pageHeader}>
        <div>
          <div style={S.pageTitle}>Loan Utilization Planner</div>
          <div style={S.pageSub}>
            Plan repayment of existing loans · Priority based on maturity date, interest rate &amp; FD lien
          </div>
          {/* Export buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }} className="no-print">
            <button onClick={handleExportExcel} disabled={exporting} style={S.exportBtn}>
              {exporting ? '⏳ Exporting…' : '📥 Export Excel'}
            </button>
            <button onClick={handleExportPDF} style={{ ...S.exportBtn, background: '#F9F9F9', borderColor: '#DFE7E3' }}>
              🖨 Export PDF
            </button>
          </div>
        </div>

        {/* Fund + Equity inputs */}
        <div style={S.ncdCard}>
          {/* Fund row */}
          <div style={S.ncdLabel}>Fund Amount</div>
          <div style={S.ncdRow}>
            <span style={S.ncdRupee}>₹</span>
            <input
              type="number" value={ncdCr} min="0" max="5000" step="1"
              onChange={e => handleNcd(e.target.value, eqAmt)}
              style={S.ncdInput}
            />
            <span style={S.ncdUnit}>Crore</span>
          </div>

          {/* Equity row */}
          <div style={{ ...S.ncdLabel, marginTop: 10, color: '#a78bfa' }}>+ Equity Amount</div>
          <div style={S.ncdRow}>
            <span style={{ ...S.ncdRupee, color: '#a78bfa' }}>₹</span>
            <input
              type="number" value={eqCr} min="0" max="5000" step="1"
              onChange={e => handleEquity(e.target.value, ncdAmt)}
              style={{ ...S.ncdInput, borderColor: '#4c1d95' }}
            />
            <span style={{ ...S.ncdUnit, color: '#a78bfa' }}>Crore</span>
          </div>

          {/* Total */}
          <div style={{ marginTop: 8, padding: '5px 8px', background: '#F9F9F9', borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#5D6C7B', fontSize: '0.72rem' }}>= Total Available</span>
            <span style={{ color: '#18191B', fontWeight: 700, fontSize: '0.9rem' }}>
              ₹{toCr(totalAmt).toFixed(2)} Cr
            </span>
          </div>

          {!autoMode && (
            <button onClick={resetAuto} style={S.autoResetBtn}>↺ Reset to Auto-Select</button>
          )}
          {autoMode && <div style={S.autoNote}>Auto-selecting optimal loans</div>}
        </div>
      </div>

      {/* ── KPI row ──────────────────────────────────────────────────────── */}
      <div style={S.kpiRow}>
        <KpiCard label="Current Total Loan Outstanding" icon="📋" value={fmtCrShort(stats.grand)} sub={`Institutional ${fmtCrShort(stats.totInstit)} · Other ${fmtCrShort(stats.totOther)}`} accent="#f59e0b" />
        <KpiCard label="Fund Amount"        icon="💰" value={fmtCrShort(ncdAmt)}                   sub="Debt / borrowing available"                                accent="#1C4942" />
        <KpiCard label="Equity Amount"      icon="📈" value={eqAmt > 0 ? fmtCrShort(eqAmt) : '₹0.00 Cr'} sub="Equity infusion received"                           accent="#8b5cf6" />
        <KpiCard label="Total Available"    icon="🏦" value={fmtCrShort(stats.total)}              sub={eqAmt > 0 ? `Fund ${fmtCrShort(ncdAmt)} + Equity ${fmtCrShort(eqAmt)}` : 'Fund only'} accent="#06b6d4" />
        <KpiCard label="Allocated (Repayment)" icon="✅" value={fmtCrShort(stats.allocated)}       sub={`${stats.pctUsed.toFixed(1)}% of Total · ${selected.size} loans`} accent={stats.overBudget ? '#DC2626' : '#15803D'} />
        <KpiCard label="Remaining Balance"  icon="🏛" value={fmtCrShort(Math.max(0, stats.remaining))} sub="For working capital / other use"                      accent={stats.remaining < 0 ? '#ef4444' : '#a78bfa'} />
        <KpiCard label="FD to be Released"  icon="🔓" value={fmtCrShort(stats.fdRel)}              sub="Lien FD unlocked after repayment"                          accent="#f59e0b" />
        <KpiCard label="Annual Interest Saved" icon="📉" value={fmtCrShort(stats.intSaved)}        sub={`Fund cost ~${fmtCrShort(stats.fundCost)}/yr · Net: ${stats.netSaving >= 0 ? '+' : ''}${fmtCrShort(stats.netSaving)}`} accent="#15803D" />
      </div>

      {stats.overBudget && (
        <div style={S.warning}>
          ⚠ Selected loans total ₹{toCr(stats.allocated).toFixed(2)} Cr which exceeds Total Available of
          ₹{toCr(stats.total).toFixed(2)} Cr by ₹{toCr(stats.allocated - stats.total).toFixed(2)} Cr.
          Please deselect some loans below.
        </div>
      )}

      {/* ── Utilisation bar ───────────────────────────────────────────────── */}
      <div style={S.barSection}>
        <div style={S.barMeta}>
          <span>Loan Repayment: <b style={{ color: '#15803D' }}>₹{toCr(stats.allocated).toFixed(2)} Cr</b></span>
          <span>Remaining: <b style={{ color: '#a78bfa' }}>₹{toCr(Math.max(0, stats.remaining)).toFixed(2)} Cr</b></span>
          <span style={{ marginLeft: 'auto', color: '#5D6C7B' }}>
            {eqAmt > 0
              ? `Fund ₹${toCr(ncdAmt).toFixed(2)} Cr + Equity ₹${toCr(eqAmt).toFixed(2)} Cr = ₹${toCr(totalAmt).toFixed(2)} Cr`
              : `Total Fund: ₹${toCr(ncdAmt).toFixed(2)} Cr`}
          </span>
        </div>
        {eqAmt > 0 && (
          <div style={{ display: 'flex', gap: '1.25rem', marginBottom: 8, fontSize: '0.72rem' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: '#1C4942', display: 'inline-block' }} />
              <span style={{ color: '#5D6C7B' }}>Fund Used: {fmtCrShort(stats.fundUsed)}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: '#8b5cf6', display: 'inline-block' }} />
              <span style={{ color: '#5D6C7B' }}>Equity Used: {fmtCrShort(stats.equityUsed)}</span>
            </span>
          </div>
        )}
        <div style={S.barTrack}>
          {stats.overBudget ? (
            <div style={{ ...S.barFill, width: '100%', background: '#DC2626' }} />
          ) : (
            <>
              {stats.fundPct > 0 && (
                <div style={{
                  ...S.barFill,
                  width: `${stats.fundPct.toFixed(1)}%`,
                  background: 'linear-gradient(90deg, #1C4942 0%, #1C4942 100%)',
                }} />
              )}
              {stats.equityPct > 0 && (
                <div style={{
                  ...S.barFill,
                  width: `${stats.equityPct.toFixed(1)}%`,
                  background: 'linear-gradient(90deg, #7c3aed 0%, #a78bfa 100%)',
                }} />
              )}
            </>
          )}
        </div>
        <div style={S.barLabels}>
          <span>0 Cr</span>
          <span>₹{toCr(totalAmt / 4).toFixed(0)} Cr</span>
          <span>₹{toCr(totalAmt / 2).toFixed(0)} Cr</span>
          <span>₹{toCr(totalAmt * 0.75).toFixed(0)} Cr</span>
          <span>₹{toCr(totalAmt).toFixed(0)} Cr</span>
        </div>
      </div>

      {/* ── Main loan table ───────────────────────────────────────────────── */}
      <div style={S.section}>
        <div style={S.secHeader}>
          <div>
            <span style={S.secTitle}>Institutional Loan Portfolio</span>
            <span style={S.secBadge}>
              {selected.size} selected · Click row to include / exclude
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <div style={S.legend}>
              {[['Critical','#ef4444'],['High','#f97316'],['Medium','#eab308'],['Low','#22c55e']].map(([l,c]) => (
                <span key={l} style={{ display:'flex', alignItems:'center', gap:4 }}>
                  <span style={{ width:8, height:8, borderRadius:'50%', background:c, display:'inline-block' }} />
                  <span style={{ color:'#5D6C7B', fontSize:'0.75rem' }}>{l}</span>
                </span>
              ))}
            </div>
            <button onClick={() => openAddModal('institutional')} style={S.addBtn} className="no-print">
              + Add Loan
            </button>
          </div>
        </div>

        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                <Th style={{ width: 36 }}></Th>
                <Th>Lender</Th>
                <Th right sort="amount" cur={sortCol} dir={sortDir} onSort={toggleSort}>Outstanding</Th>
                <Th right>Pay through Fund</Th>
                <Th right>Monthly EMI</Th>
                <Th sort="end" cur={sortCol} dir={sortDir} onSort={toggleSort}>End Date</Th>
                <Th right sort="rate" cur={sortCol} dir={sortDir} onSort={toggleSort}>Rate</Th>
                <Th right sort="fd" cur={sortCol} dir={sortDir} onSort={toggleSort}>FD Lien</Th>
                <Th right>Annual Interest</Th>
                <Th sort="priority" cur={sortCol} dir={sortDir} onSort={toggleSort}>Priority</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(loan => {
                const isSel = selected.has(loan.id);
                const pt    = priorityTag(loan.priority);
                const ec    = endDateColor(loan.endDateStr);
                const ai    = annualInt(loan);
                return (
                  <tr
                    key={loan.id}
                    onClick={() => toggleLoan(loan.id)}
                    style={{
                      ...S.tr,
                      background: isSel ? '#EAF4EF' : 'transparent',
                      borderLeft: isSel ? '3px solid #1C4942' : '3px solid transparent',
                    }}
                  >
                    {/* Checkbox */}
                    <td style={S.td}>
                      <div style={{
                        width: 18, height: 18, borderRadius: 4,
                        border: `2px solid ${isSel ? '#1C4942' : '#DFE7E3'}`,
                        background: isSel ? '#1C4942' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        {isSel && <span style={{ color: '#fff', fontSize: 11, lineHeight: 1 }}>✓</span>}
                      </div>
                    </td>

                    {/* Lender */}
                    <td style={{ ...S.td, maxWidth: 220 }}>
                      <div style={{ color: isSel ? '#18191B' : '#9BA8B0', fontWeight: isSel ? 600 : 400, fontSize: '0.82rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {loan.name}
                        {loan.isCC && <span style={S.ccBadge}>CC/OD</span>}
                        {loan.custom && <span style={{ ...S.ccBadge, background: '#EAF4EF', color: '#1C4942', borderColor: '#DFE7E3' }}>Added</span>}
                      </div>
                      {loan.fdAmount > 0 && (
                        <div style={{ color: '#f59e0b', fontSize: '0.71rem', marginTop: 2 }}>
                          🔒 FD Lien: {fmtCrShort(loan.fdAmount)}
                        </div>
                      )}
                    </td>

                    {/* Outstanding */}
                    <td style={{ ...S.td, textAlign: 'right', color: '#18191B', fontWeight: 600 }}>
                      {fmtCrShort(loan.amount)}
                    </td>

                    {/* Pay through Fund */}
                    <td style={{ ...S.td, textAlign: 'right' }}>
                      {isSel ? (
                        <span style={{ color: '#15803D', fontWeight: 700, fontSize: '0.85rem' }}>
                          {fmtCrShort(loan.amount)}
                        </span>
                      ) : (
                        <span style={{ color: '#9BA8B0', fontSize: '0.8rem' }}>—</span>
                      )}
                    </td>

                    {/* EMI */}
                    <td style={{ ...S.td, textAlign: 'right', color: '#5D6C7B', fontSize: '0.8rem' }}>
                      {loan.emi > 0 ? `₹${Math.round(loan.emi).toLocaleString('en-IN')}` : '—'}
                    </td>

                    {/* End date */}
                    <td style={{ ...S.td, color: ec, fontWeight: loan.endDateStr ? 600 : 400, fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
                      {loan.endDateStr
                        ? endDateUrgency(loan.endDateStr) + loan.endDateStr
                        : <span style={{ color: '#9BA8B0' }}>—</span>}
                    </td>

                    {/* Rate */}
                    <td style={{
                      ...S.td, textAlign: 'right', fontWeight: 700, fontSize: '0.82rem',
                      color: loan.rate >= 16 ? '#DC2626' : loan.rate >= 14 ? '#f97316' : loan.rate >= 12 ? '#eab308' : '#9BA8B0',
                    }}>
                      {fmtPct(loan.rate)}
                    </td>

                    {/* FD lien */}
                    <td style={{ ...S.td, textAlign: 'right', color: loan.fdAmount > 0 ? '#B45309' : '#FFFFFF', fontSize: '0.8rem' }}>
                      {loan.fdAmount > 0 ? fmtCrShort(loan.fdAmount) : '—'}
                    </td>

                    {/* Annual interest */}
                    <td style={{ ...S.td, textAlign: 'right', color: '#5D6C7B', fontSize: '0.8rem' }}>
                      {ai > 0 ? fmtCrShort(ai) : '—'}
                    </td>

                    {/* Priority */}
                    <td style={S.td}>
                      <span style={{
                        display: 'inline-block', fontSize: '0.72rem', fontWeight: 700,
                        padding: '2px 8px', borderRadius: 4,
                        background: pt.bg, color: pt.color, border: `1px solid ${pt.border}`,
                        whiteSpace: 'nowrap',
                      }}>
                        {pt.label}
                      </span>
                      <div style={{ color: '#9BA8B0', fontSize: '0.68rem', marginTop: 2 }}>
                        Score: {loan.priority}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '1px solid #DFE7E3' }}>
                <td colSpan={2} style={{ ...S.td, color: '#9BA8B0', fontWeight: 700, paddingTop: 10 }}>
                  Total Institutional (A)
                </td>
                <td style={{ ...S.td, textAlign: 'right', color: '#B45309', fontWeight: 700, paddingTop: 10 }}>
                  {fmtCrShort(stats.totInstit)}
                </td>
                <td style={{ ...S.td, textAlign: 'right', color: '#15803D', fontWeight: 700, paddingTop: 10 }}>
                  {fmtCrShort(stats.allocated)}
                </td>
                <td colSpan={4} style={S.td} />
                <td style={{ ...S.td, textAlign: 'right', color: '#B45309', fontWeight: 700, paddingTop: 10 }}>
                  {fmtCrShort(data.institutional.reduce((s, l) => s + annualInt(l), 0))}
                </td>
                <td style={S.td} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* ── Repayment Summary ─────────────────────────────────────────────── */}
      {selLoans.length > 0 && (
        <div style={S.section}>
          <div style={S.secTitle}>Selected Repayment Plan — Rationale</div>
          <div style={S.ratGrid}>
            {selLoans
              .sort((a, b) => b.priority - a.priority)
              .map(loan => {
                const pt = priorityTag(loan.priority);
                const m  = monthsToNow(loan.endDateStr);
                const reasons = [];
                if (m !== Infinity && m <= 12) reasons.push(`Matures in ${m} month${m !== 1 ? 's' : ''}`);
                if (loan.rate >= 14) reasons.push(`High rate ${loan.rate}% p.a.`);
                if (loan.fdAmount > 0) reasons.push(`Releases ${fmtCrShort(loan.fdAmount)} FD`);
                if (!reasons.length && loan.rate > 0) reasons.push(`Rate ${loan.rate}% p.a.`);
                return (
                  <div key={loan.id} style={{ ...S.ratCard, borderLeft: `3px solid ${pt.color}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                      <div style={{ color: '#18191B', fontSize: '0.8rem', fontWeight: 600, flex: 1 }}>{loan.name}</div>
                      <span style={{ ...S.ratBadge, background: pt.bg, color: pt.color }}>{pt.label}</span>
                    </div>
                    <div style={{ color: '#15803D', fontWeight: 700, fontSize: '0.9rem', marginTop: 6 }}>
                      {fmtCrShort(loan.amount)}
                    </div>
                    <div style={{ marginTop: 4 }}>
                      {reasons.map((r, i) => (
                        <div key={i} style={{ color: '#5D6C7B', fontSize: '0.72rem', marginTop: 2 }}>
                          · {r}
                        </div>
                      ))}
                    </div>
                    <div style={{ color: '#9BA8B0', fontSize: '0.72rem', marginTop: 4 }}>
                      Interest saved: {fmtCrShort(annualInt(loan))}/yr
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* ── Remaining Loans in Books ─────────────────────────────────────── */}
      {(() => {
        const remaining = data.institutional.filter(l => !selected.has(l.id));
        const totOut  = remaining.reduce((s, l) => s + l.amount, 0);
        const totEmi  = remaining.reduce((s, l) => s + l.emi, 0);
        const totMInt = remaining.reduce((s, l) => s + (l.amount * l.rate / 100 / 12), 0);
        const totMPri = remaining.reduce((s, l) => {
          const mi = l.amount * l.rate / 100 / 12;
          return s + (l.emi > 0 ? Math.max(0, l.emi - mi) : 0);
        }, 0);
        const totAInt = remaining.reduce((s, l) => s + l.amount * l.rate / 100, 0);
        return (
          <div style={S.section}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <div>
                <span style={S.secTitle}>Loans Remaining in Books — Post Repayment</span>
                <span style={S.secBadge}>{remaining.length} loans still outstanding</span>
              </div>
            </div>

            {/* Summary mini-cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
              {[
                { label: 'Total Outstanding',      value: fmtCrShort(totOut),  color: '#B45309', sub: 'Remaining principal' },
                { label: 'Total Monthly EMI',       value: `₹${Math.round(totEmi).toLocaleString('en-IN')}`, color: '#DC2626', sub: 'Monthly outflow' },
                { label: 'Monthly Interest Burden', value: `₹${Math.round(totMInt).toLocaleString('en-IN')}`, color: '#fb923c', sub: 'Interest component' },
                { label: 'Monthly Principal Pmt',   value: `₹${Math.round(totMPri).toLocaleString('en-IN')}`, color: '#15803D', sub: 'Principal component' },
                { label: 'Annual Interest Burden',  value: fmtCrShort(totAInt), color: '#a78bfa', sub: 'Full year interest cost' },
              ].map(c => (
                <div key={c.label} style={{ background: '#F9F9F9', border: `1px solid #DFE7E3`, borderLeft: `3px solid ${c.color}`, borderRadius: 8, padding: '0.7rem 0.9rem' }}>
                  <div style={{ color: c.color, fontWeight: 700, fontSize: '0.95rem' }}>{c.value}</div>
                  <div style={{ color: '#5D6C7B', fontSize: '0.7rem', fontWeight: 600, marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{c.label}</div>
                  <div style={{ color: '#9BA8B0', fontSize: '0.68rem', marginTop: 2 }}>{c.sub}</div>
                </div>
              ))}
            </div>

            {remaining.length === 0 ? (
              <div style={{ color: '#15803D', fontSize: '0.85rem', textAlign: 'center', padding: '1.5rem', background: '#052e16', borderRadius: 8, border: '1px solid #166534' }}>
                ✅ All institutional loans are selected for repayment — no outstanding debt remaining.
              </div>
            ) : (
              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <Th>Lender</Th>
                      <Th right>Outstanding (Cr)</Th>
                      <Th right>Monthly EMI (₹)</Th>
                      <Th right>Monthly Interest (₹)</Th>
                      <Th right>Monthly Principal (₹)</Th>
                      <Th right>Rate</Th>
                      <Th>End Date</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {remaining.map(loan => {
                      const mi  = loan.amount * loan.rate / 100 / 12;
                      const mp  = loan.emi > 0 ? Math.max(0, loan.emi - mi) : 0;
                      const ec  = endDateColor(loan.endDateStr);
                      return (
                        <tr key={loan.id} style={{ ...S.tr, cursor: 'default' }}>
                          <td style={{ ...S.td, maxWidth: 220 }}>
                            <div style={{ color: '#9BA8B0', fontSize: '0.82rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {loan.name}
                              {loan.isCC && <span style={S.ccBadge}>CC/OD</span>}
                              {loan.custom && <span style={{ ...S.ccBadge, background: '#EAF4EF', color: '#1C4942', borderColor: '#DFE7E3' }}>Added</span>}
                            </div>
                            {loan.fdAmount > 0 && (
                              <div style={{ color: '#f59e0b', fontSize: '0.7rem', marginTop: 2 }}>🔒 FD: {fmtCrShort(loan.fdAmount)}</div>
                            )}
                          </td>
                          <td style={{ ...S.td, textAlign: 'right', color: '#B45309', fontWeight: 700 }}>
                            {fmtCrShort(loan.amount)}
                          </td>
                          <td style={{ ...S.td, textAlign: 'right', color: '#18191B', fontWeight: 600 }}>
                            {loan.emi > 0 ? `₹${Math.round(loan.emi).toLocaleString('en-IN')}` : '—'}
                          </td>
                          <td style={{ ...S.td, textAlign: 'right', color: '#fb923c' }}>
                            {loan.rate > 0 ? `₹${Math.round(mi).toLocaleString('en-IN')}` : '—'}
                          </td>
                          <td style={{ ...S.td, textAlign: 'right', color: '#15803D' }}>
                            {loan.emi > 0 && loan.rate > 0 ? `₹${Math.round(mp).toLocaleString('en-IN')}` : '—'}
                          </td>
                          <td style={{
                            ...S.td, textAlign: 'right', fontWeight: 700, fontSize: '0.82rem',
                            color: loan.rate >= 16 ? '#DC2626' : loan.rate >= 14 ? '#f97316' : loan.rate >= 12 ? '#eab308' : '#9BA8B0',
                          }}>
                            {fmtPct(loan.rate)}
                          </td>
                          <td style={{ ...S.td, color: ec, fontWeight: loan.endDateStr ? 600 : 400, fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
                            {loan.endDateStr ? endDateUrgency(loan.endDateStr) + loan.endDateStr : <span style={{ color: '#9BA8B0' }}>—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid #DFE7E3' }}>
                      <td style={{ ...S.td, color: '#9BA8B0', fontWeight: 700, paddingTop: 10 }}>Total Remaining</td>
                      <td style={{ ...S.td, textAlign: 'right', color: '#B45309', fontWeight: 700, paddingTop: 10 }}>{fmtCrShort(totOut)}</td>
                      <td style={{ ...S.td, textAlign: 'right', color: '#18191B', fontWeight: 700, paddingTop: 10 }}>
                        {totEmi > 0 ? `₹${Math.round(totEmi).toLocaleString('en-IN')}` : '—'}
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', color: '#fb923c', fontWeight: 700, paddingTop: 10 }}>
                        {totMInt > 0 ? `₹${Math.round(totMInt).toLocaleString('en-IN')}` : '—'}
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', color: '#15803D', fontWeight: 700, paddingTop: 10 }}>
                        {totMPri > 0 ? `₹${Math.round(totMPri).toLocaleString('en-IN')}` : '—'}
                      </td>
                      <td colSpan={2} style={S.td} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Other loans ──────────────────────────────────────────────────── */}
      <div style={S.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <span style={S.secTitle}>Other Loans (Section B)</span>
            <span style={S.secBadge}>{data.other.length} loans · {fmtCrShort(stats.totOther)}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => openAddModal('other')} style={S.addBtn} className="no-print">+ Add Loan</button>
            <button onClick={() => setShowAll(x => !x)} style={S.toggleBtn}>
              {showAll ? '▲ Hide' : '▼ Show all'}
            </button>
          </div>
        </div>

        {/* Overdue / urgent alerts */}
        {(() => {
          const overdue  = data.other.filter(l => l.endDateStr && monthsToNow(l.endDateStr) <= 0);
          const urgent   = data.other.filter(l => l.endDateStr && monthsToNow(l.endDateStr) > 0 && monthsToNow(l.endDateStr) <= 3);
          return (
            <>
              {overdue.length > 0 && (
                <div style={{ ...S.warning, marginBottom: 8 }}>
                  🚨 <b>OVERDUE — Immediate Action Required:</b>{' '}
                  {overdue.map(l => `${l.name} (${fmtCrShort(l.amount)}, due ${l.endDateStr})`).join(' · ')}
                </div>
              )}
              {urgent.length > 0 && (
                <div style={{ background: '#431407', border: '1px solid #9a3412', borderRadius: 8, color: '#fdba74', padding: '0.6rem 1rem', marginBottom: 8, fontSize: '0.82rem' }}>
                  ⚠ <b>Due within 3 months:</b>{' '}
                  {urgent.map(l => `${l.name} (${fmtCrShort(l.amount)}, due ${l.endDateStr})`).join(' · ')}
                </div>
              )}
            </>
          );
        })()}

        {showAll && (
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <Th>Lender</Th>
                  <Th right>Amount</Th>
                  <Th>End Date</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {data.other
                  .slice()
                  .sort((a, b) => monthsToNow(a.endDateStr) - monthsToNow(b.endDateStr))
                  .map(l => {
                    const m  = monthsToNow(l.endDateStr);
                    const ec = endDateColor(l.endDateStr);
                    const isOverdue = m <= 0;
                    const statusLabel = isOverdue
                      ? { text: 'OVERDUE', color: '#ef4444', bg: '#450a0a' }
                      : m <= 3  ? { text: 'Critical', color: '#fca5a5', bg: '#7f1d1d' }
                      : m <= 6  ? { text: 'Urgent',   color: '#fdba74', bg: '#7c2d12' }
                      : m <= 12 ? { text: 'Due Soon', color: '#fde047', bg: '#713f12' }
                      : { text: 'Normal', color: '#86efac', bg: '#052e16' };
                    return (
                      <tr key={l.id} style={{ ...S.tr, background: isOverdue ? '#1a0505' : 'transparent' }}>
                        <td style={{ ...S.td, color: isOverdue ? '#fca5a5' : '#9BA8B0', fontWeight: isOverdue ? 600 : 400 }}>
                          {l.name}
                          {l.custom && <span style={{ ...S.ccBadge, background: '#EAF4EF', color: '#1C4942', borderColor: '#DFE7E3', marginLeft: 6 }}>Added</span>}
                        </td>
                        <td style={{ ...S.td, textAlign: 'right', color: '#18191B', fontWeight: 600 }}>
                          {fmtCrShort(l.amount)}
                        </td>
                        <td style={{ ...S.td, color: ec, fontWeight: l.endDateStr ? 600 : 400, whiteSpace: 'nowrap' }}>
                          {l.endDateStr ? endDateUrgency(l.endDateStr) + l.endDateStr : '—'}
                        </td>
                        <td style={S.td}>
                          {l.endDateStr ? (
                            <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: statusLabel.bg, color: statusLabel.color }}>
                              {statusLabel.text}
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '1px solid #DFE7E3' }}>
                  <td style={{ ...S.td, color: '#9BA8B0', fontWeight: 700, paddingTop: 10 }}>Total (B)</td>
                  <td style={{ ...S.td, textAlign: 'right', color: '#B45309', fontWeight: 700, paddingTop: 10 }}>
                    {fmtCrShort(stats.totOther)}
                  </td>
                  <td colSpan={2} style={S.td} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {!showAll && (
          <div style={{ color: '#5D6C7B', fontSize: '0.8rem', marginTop: 4 }}>
            Click "Show all" to view loan-wise details with maturity dates
          </div>
        )}
      </div>

      {/* ── Grand Total ───────────────────────────────────────────────────── */}
      <div style={S.section}>
        <div style={S.secTitle}>Portfolio Summary</div>
        <div style={S.summaryGrid}>
          <SummaryRow label="Institutional Loans (A)" value={fmtCrShort(stats.totInstit)} />
          <SummaryRow label="Other Loans (B)" value={fmtCrShort(stats.totOther)} />
          <SummaryRow label="Grand Total (A + B)" value={fmtCrShort(stats.grand)} highlight />
          <div style={S.divider} />
          <SummaryRow label="Total FD Lien (all institutional loans)" value={fmtCrShort(stats.totFD)} color="#f59e0b" />
          <SummaryRow label={`Fund Used for Repayment${eqAmt > 0 ? ` (of ${fmtCrShort(ncdAmt)})` : ''}`} value={fmtCrShort(stats.fundUsed)} color="#1C4942" />
          {eqAmt > 0 && <SummaryRow label={`Equity Used for Repayment (of ${fmtCrShort(eqAmt)})`} value={fmtCrShort(stats.equityUsed)} color="#8b5cf6" />}
          <SummaryRow label="Total Allocated (Loan Repayment)" value={fmtCrShort(stats.allocated)} color="#15803D" />
          <SummaryRow label={eqAmt > 0 ? "Remaining Available (working capital)" : "Remaining Fund (working capital)"} value={fmtCrShort(Math.max(0, stats.remaining))} color="#a78bfa" />
          <div style={S.divider} />
          <SummaryRow label="Annual Interest Saved (on repaid loans)" value={fmtCrShort(stats.intSaved)} color="#06b6d4" />
          <SummaryRow label="Fund Annual Cost (est. @ 10% p.a.)" value={fmtCrShort(stats.fundCost)} color="#DC2626" />
          <SummaryRow
            label="Net Annual Saving (Interest saved minus Fund cost)"
            value={`${stats.netSaving >= 0 ? '+' : ''}${fmtCrShort(Math.abs(stats.netSaving))}`}
            color={stats.netSaving >= 0 ? '#15803D' : '#DC2626'}
            highlight
          />
        </div>

        <div style={S.remark}>
          <b>Priority Scoring Methodology</b><br />
          Each loan is scored out of 320 points: End-date proximity (max 200 pts) + Interest rate (max 80 pts) + FD lien (40 pts).
          Loans are auto-selected in priority order until the Fund amount is fully utilised. You can manually override any selection above.
          Annual interest saving assumes full principal outstanding at stated rate. Fund cost estimated at 10% p.a. — adjust if actual borrowing rate differs.
        </div>
      </div>

      {/* ── Add Loan Modal ───────────────────────────────────────────────── */}
      {showAddModal && (
        <div style={S.modalOverlay} onClick={() => setShowAddModal(false)}>
          <div style={S.modalBox} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <span style={S.modalTitle}>Add {addSection === 'institutional' ? 'Institutional' : 'Other'} Loan</span>
              <button onClick={() => setShowAddModal(false)} style={S.modalClose}>✕</button>
            </div>
            <div style={S.modalBody}>
              <div style={S.formRow}>
                <label style={S.formLabel}>Lender / Loan Name *</label>
                <input style={S.formInput} value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. ICICI Bank OD" autoFocus />
              </div>
              <div style={S.formRow}>
                <label style={S.formLabel}>Outstanding Amount (₹ Crore) *</label>
                <input type="number" style={S.formInput} value={addForm.amount} onChange={e => setAddForm(f => ({ ...f, amount: e.target.value }))} placeholder="e.g. 5.25" step="0.01" min="0" />
              </div>
              {addSection === 'institutional' && (
                <>
                  <div style={S.formRow}>
                    <label style={S.formLabel}>Interest Rate (% p.a.) *</label>
                    <input type="number" style={S.formInput} value={addForm.rate} onChange={e => setAddForm(f => ({ ...f, rate: e.target.value }))} placeholder="e.g. 14.5" step="0.01" min="0" />
                  </div>
                  <div style={S.formRow}>
                    <label style={S.formLabel}>Monthly EMI (₹)</label>
                    <input type="number" style={S.formInput} value={addForm.emi} onChange={e => setAddForm(f => ({ ...f, emi: e.target.value }))} placeholder="e.g. 500000" min="0" />
                  </div>
                  <div style={S.formRow}>
                    <label style={S.formLabel}>FD Lien Amount (₹ Crore)</label>
                    <input type="number" style={S.formInput} value={addForm.fdAmount} onChange={e => setAddForm(f => ({ ...f, fdAmount: e.target.value }))} placeholder="e.g. 2.0" step="0.01" min="0" />
                  </div>
                  <div style={S.formRow}>
                    <label style={{ ...S.formLabel, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input type="checkbox" checked={addForm.isCC} onChange={e => setAddForm(f => ({ ...f, isCC: e.target.checked }))} style={{ width: 14, height: 14 }} />
                      CC / OD Account
                    </label>
                  </div>
                </>
              )}
              <div style={S.formRow}>
                <label style={S.formLabel}>End / Maturity Date (e.g. Dec-26)</label>
                <input style={S.formInput} value={addForm.endDate} onChange={e => setAddForm(f => ({ ...f, endDate: e.target.value }))} placeholder="Mon-YY (e.g. Jun-27)" />
              </div>
              {(!addForm.name.trim() || parseFloat(addForm.amount || 0) <= 0) && (
                <div style={{ color: '#f59e0b', fontSize: '0.72rem', marginTop: 4 }}>* Name and Amount are required</div>
              )}
            </div>
            <div style={S.modalFooter}>
              <button onClick={() => setShowAddModal(false)} style={S.modalCancelBtn}>Cancel</button>
              <button
                onClick={submitAddLoan}
                disabled={!addForm.name.trim() || parseFloat(addForm.amount || 0) <= 0}
                style={{ ...S.modalSubmitBtn, opacity: (!addForm.name.trim() || parseFloat(addForm.amount || 0) <= 0) ? 0.4 : 1 }}
              >
                Add Loan
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function KpiCard({ label, icon, value, sub, accent }) {
  return (
    <div style={{ ...S.kpi, borderTop: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ color: accent, fontSize: '1.35rem', fontWeight: 700, letterSpacing: '-0.02em' }}>{value}</div>
        <span style={{ fontSize: '1.4rem' }}>{icon}</span>
      </div>
      <div style={{ color: '#9BA8B0', fontSize: '0.75rem', fontWeight: 600, marginTop: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ color: '#5D6C7B', fontSize: '0.72rem', marginTop: 3 }}>{sub}</div>
    </div>
  );
}

function Th({ children, right, sort, cur, dir, onSort, style: extra = {} }) {
  const active = sort && cur === sort;
  return (
    <th
      onClick={sort ? () => onSort(sort) : undefined}
      style={{
        ...S.th,
        textAlign: right ? 'right' : 'left',
        cursor: sort ? 'pointer' : 'default',
        color: active ? '#1C4942' : '#5D6C7B',
        userSelect: 'none',
        ...extra,
      }}
    >
      {children}
      {sort && <span style={{ marginLeft: 3, opacity: active ? 1 : 0.3 }}>{active && dir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  );
}

function SummaryRow({ label, value, highlight, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #DFE7E3' }}>
      <span style={{ color: highlight ? '#9BA8B0' : '#5D6C7B', fontSize: '0.82rem', fontWeight: highlight ? 600 : 400 }}>{label}</span>
      <span style={{ color: color || (highlight ? '#18191B' : '#5D6C7B'), fontWeight: highlight ? 700 : 600, fontSize: '0.82rem' }}>{value}</span>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  page: { padding: '1.5rem 2rem 3rem', maxWidth: 1400, margin: '0 auto' },
  center: { padding: '4rem', textAlign: 'center', color: '#5D6C7B' },

  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '2rem', marginBottom: '1.5rem', flexWrap: 'wrap' },
  pageTitle:  { color: '#18191B', fontSize: '1.3rem', fontWeight: 700 },
  pageSub:    { color: '#5D6C7B', fontSize: '0.8rem', marginTop: 4, maxWidth: 520 },

  ncdCard:    { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '1rem 1.25rem', minWidth: 280 },
  ncdLabel:   { color: '#5D6C7B', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 },
  ncdRow:     { display: 'flex', alignItems: 'center', gap: 6 },
  ncdRupee:   { color: '#9BA8B0', fontSize: '1.1rem', fontWeight: 700 },
  ncdInput:   {
    background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6,
    color: '#18191B', fontSize: '1.5rem', fontWeight: 700, width: 100,
    padding: '4px 8px', outline: 'none', textAlign: 'right',
  },
  ncdUnit:     { color: '#5D6C7B', fontSize: '0.85rem', fontWeight: 600 },
  autoResetBtn:{ marginTop: 8, fontSize: '0.75rem', color: '#1C4942', background: 'transparent', border: '1px solid #DFE7E3', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', width: '100%' },
  autoNote:    { marginTop: 6, fontSize: '0.72rem', color: '#9BA8B0', textAlign: 'center' },

  kpiRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: '1rem', marginBottom: '1.5rem' },
  kpi:    { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '1rem 1.1rem' },

  warning: { background: '#450a0a', border: '1px solid #991b1b', borderRadius: 8, color: '#fca5a5', padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.82rem' },

  barSection: { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '1rem 1.25rem', marginBottom: '1.5rem' },
  barMeta:    { display: 'flex', gap: '1.5rem', fontSize: '0.82rem', color: '#9BA8B0', marginBottom: 10, flexWrap: 'wrap' },
  barTrack:   { background: '#F9F9F9', borderRadius: 6, height: 14, overflow: 'hidden', display: 'flex' },
  barFill:    { height: '100%', borderRadius: 6, transition: 'width 0.4s ease' },
  barLabels:  { display: 'flex', justifyContent: 'space-between', color: '#9BA8B0', fontSize: '0.69rem', marginTop: 4 },

  section:    { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '1.25rem', marginBottom: '1.25rem' },
  secHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: 8 },
  secTitle:   { color: '#9BA8B0', fontSize: '0.82rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 },
  secBadge:   { color: '#1C4942', fontSize: '0.75rem', marginLeft: 10 },
  legend:     { display: 'flex', gap: '1rem', flexWrap: 'wrap' },

  tableWrap:  { overflowX: 'auto' },
  table:      { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' },
  th:         { padding: '8px 10px', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  tr:         { borderBottom: '1px solid #DFE7E3', cursor: 'pointer', transition: 'background 0.1s' },
  td:         { padding: '9px 10px', verticalAlign: 'middle' },

  ccBadge:    { marginLeft: 6, fontSize: '0.65rem', padding: '1px 5px', borderRadius: 3, background: '#FFFFFF', color: '#5D6C7B', border: '1px solid #DFE7E3' },

  ratGrid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: '0.75rem', marginTop: 12 },
  ratCard:    { background: '#F9F9F9', borderRadius: 8, padding: '0.85rem', border: '1px solid #DFE7E3' },
  ratBadge:   { fontSize: '0.68rem', fontWeight: 700, padding: '2px 6px', borderRadius: 3, whiteSpace: 'nowrap' },

  toggleBtn:  { fontSize: '0.75rem', color: '#5D6C7B', background: 'transparent', border: '1px solid #DFE7E3', borderRadius: 5, padding: '3px 10px', cursor: 'pointer' },

  summaryGrid: { marginTop: 8 },
  divider:     { height: 1, background: '#DFE7E3', margin: '8px 0' },

  remark: {
    marginTop: 16, padding: '0.75rem 1rem', background: '#F9F9F9',
    border: '1px solid #DFE7E3', borderRadius: 8,
    color: '#5D6C7B', fontSize: '0.75rem', lineHeight: 1.6,
  },

  exportBtn: {
    fontSize: '0.78rem', fontWeight: 600, padding: '6px 14px',
    background: '#EAF4EF', border: '1px solid #DFE7E3', borderRadius: 6,
    color: '#15803D', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  addBtn: {
    fontSize: '0.75rem', fontWeight: 600, padding: '4px 12px',
    background: '#EAF4EF', border: '1px solid #DFE7E3', borderRadius: 5,
    color: '#1C4942', cursor: 'pointer', whiteSpace: 'nowrap',
  },

  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modalBox: {
    background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12,
    width: 440, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto',
    boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
  },
  modalHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3',
  },
  modalTitle:  { color: '#18191B', fontWeight: 700, fontSize: '0.95rem' },
  modalClose:  { background: 'none', border: 'none', color: '#5D6C7B', cursor: 'pointer', fontSize: '1.1rem', padding: '2px 6px', borderRadius: 4 },
  modalBody:   { padding: '1.1rem 1.25rem' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0.85rem 1.25rem', borderTop: '1px solid #DFE7E3' },
  modalCancelBtn: { fontSize: '0.82rem', padding: '6px 16px', background: 'transparent', border: '1px solid #DFE7E3', borderRadius: 6, color: '#5D6C7B', cursor: 'pointer' },
  modalSubmitBtn: { fontSize: '0.82rem', fontWeight: 700, padding: '6px 18px', background: '#1C4942', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer' },

  formRow:   { marginBottom: '0.85rem' },
  formLabel: { display: 'block', color: '#5D6C7B', fontSize: '0.75rem', fontWeight: 600, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' },
  formInput: {
    width: '100%', boxSizing: 'border-box',
    background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6,
    color: '#18191B', fontSize: '0.88rem', padding: '7px 10px', outline: 'none',
  },
};
