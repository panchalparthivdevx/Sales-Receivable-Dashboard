import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Users, IndianRupee, RefreshCw, ChevronDown, ChevronRight, Search, Lock } from 'lucide-react';
import { api } from '../utils/api';

// ── Constants ──────────────────────────────────────────────────────────────────
const COMPANIES = ['Dev Accelerator Limited', 'Neddle And Thread Designs LLP', 'Saasjoy Solutions Pvt Ltd', 'Eezily Network Pvt Ltd'];
const CO_SHORT  = {
  'Dev Accelerator Limited': 'DevX',
  'Neddle And Thread Designs LLP': 'Neddle',
  'Saasjoy Solutions Pvt Ltd': 'Saasjoy',
  'Eezily Network Pvt Ltd': 'Eezily',
};
const MONTH_LABELS = { '01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'May','06':'Jun','07':'Jul','08':'Aug','09':'Sep','10':'Oct','11':'Nov','12':'Dec' };

function monthLabel(key) {
  if (!key) return '';
  const [y, m] = key.split('-');
  return `${MONTH_LABELS[m] || m} ${y}`;
}

function fyOf(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function quarterOf(monthKey) {
  const m = parseInt(monthKey.split('-')[1]);
  if (m >= 4 && m <= 6)  return 'Q1';
  if (m >= 7 && m <= 9)  return 'Q2';
  if (m >= 10 && m <= 12) return 'Q3';
  return 'Q4';
}

const INR = n => typeof n === 'number' && n > 0
  ? `₹${Math.round(n).toLocaleString('en-IN')}` : '—';

// ── Shared styles ──────────────────────────────────────────────────────────────
const card = { background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3', overflow: 'hidden' };
const thSt = { padding: '0.55rem 0.85rem', color: '#9BA8B0', fontWeight: 600, fontSize: '0.7rem',
               textTransform: 'uppercase', letterSpacing: '0.04em', background: '#F9F9F9',
               borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' };
const tdSt = { padding: '0.65rem 0.85rem', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' };
const numTd = { ...tdSt, textAlign: 'right' };
const totalTd = { ...numTd, fontWeight: 700, color: '#18191B' };

// ── Section wrapper with collapse ─────────────────────────────────────────────
function Section({ title, sub, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ ...card, marginBottom: '1.25rem' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                 padding: '1rem 1.25rem', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <div>
          <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>{title}</div>
          {sub && <div style={{ color: '#5D6C7B', fontSize: '0.75rem', marginTop: 2 }}>{sub}</div>}
        </div>
        {open ? <ChevronDown size={16} color="#5D6C7B" /> : <ChevronRight size={16} color="#5D6C7B" />}
      </button>
      {open && <div style={{ borderTop: '1px solid #DFE7E3' }}>{children}</div>}
    </div>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KCard({ label, value, sub, icon: Icon, color }) {
  return (
    <div style={{ ...card, padding: '1.25rem', flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: '#5D6C7B', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{label}</div>
          <div style={{ color: '#18191B', fontSize: '1.6rem', fontWeight: 700, lineHeight: 1.2 }}>{value}</div>
          {sub && <div style={{ color: '#5D6C7B', fontSize: '0.76rem', marginTop: 4 }}>{sub}</div>}
        </div>
        <div style={{ background: `${color}22`, borderRadius: 10, padding: '0.5rem' }}>
          <Icon size={20} color={color} />
        </div>
      </div>
    </div>
  );
}

// ── Scrollable table wrapper ───────────────────────────────────────────────────
const TblWrap = ({ children }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>{children}</table>
  </div>
);

// ── Dept count helper (pure) — company-list-agnostic, derives columns from data ─
function deptCountsForMonth(scopedAllRows, month) {
  const src = month ? scopedAllRows.filter(r => r.month === month) : scopedAllRows;
  const dMap = {};
  src.forEach(r => {
    if (!r.department) return;
    if (!dMap[r.department]) dMap[r.department] = { _all: new Set(), _byCo: {} };
    const id = r.emp_number || r.name;
    if (!dMap[r.department]._byCo[r.company]) dMap[r.department]._byCo[r.company] = new Set();
    dMap[r.department]._byCo[r.company].add(id);
    dMap[r.department]._all.add(id);
  });
  const result = {};
  Object.entries(dMap).forEach(([dept, d]) => {
    result[dept] = { Total: d._all.size };
    Object.entries(d._byCo).forEach(([co, set]) => { result[dept][co] = set.size; });
  });
  return result;
}

// ── Global company multi-select chips ──────────────────────────────────────────
function CompanyMultiSelect({ selected, onChange }) {
  const allSelected = selected.length === COMPANIES.length;
  const toggle = c => {
    if (selected.includes(c)) {
      const next = selected.filter(x => x !== c);
      onChange(next.length ? next : COMPANIES); // never allow an empty selection
    } else {
      onChange([...selected, c]);
    }
  };
  const chip = active => ({
    background: active ? '#1C4942' : '#F9F9F9', color: active ? '#fff' : '#5D6C7B',
    border: '1px solid', borderColor: active ? '#1C4942' : '#DFE7E3',
    borderRadius: 6, padding: '0.35rem 0.7rem', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600,
  });
  return (
    <>
      <button onClick={() => onChange(COMPANIES)} style={chip(allSelected)}>All Companies</button>
      {COMPANIES.map(c => (
        <button key={c} onClick={() => toggle(c)} style={chip(!allSelected && selected.includes(c))}>
          {CO_SHORT[c]}
        </button>
      ))}
    </>
  );
}

// ── Generic multi-select dropdown (checkbox list) — used where the option set
// is too long for chips (months, categories, etc.) ────────────────────────────
function MultiSelectDropdown({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const allSelected = options.length > 0 && selected.length === options.length;
  const toggle = v => {
    if (selected.includes(v)) {
      const next = selected.filter(x => x !== v);
      onChange(next.length ? next : options.map(o => o.v));
    } else {
      onChange([...selected, v]);
    }
  };

  const summary = options.length === 0 ? '—'
    : allSelected ? 'All'
    : selected.length === 1 ? (options.find(o => o.v === selected[0])?.l || selected[0])
    : `${selected.length} selected`;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ background: '#F9F9F9', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.3rem 0.65rem', fontSize: '0.75rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: '#5D6C7B' }}>{label}:</span> {summary}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30, background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.4rem', minWidth: 190, maxHeight: 260, overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
          <button type="button" onClick={() => onChange(options.map(o => o.v))}
            style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: '#1C4942', fontSize: '0.75rem', fontWeight: 600, padding: '0.3rem 0.4rem', cursor: 'pointer', borderBottom: '1px solid #DFE7E3', marginBottom: 4 }}>
            Select All
          </button>
          {options.map(o => (
            <label key={o.v} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.28rem 0.4rem', fontSize: '0.78rem', color: '#18191B', cursor: 'pointer', borderRadius: 4 }}>
              <input type="checkbox" checked={selected.includes(o.v)} onChange={() => toggle(o.v)} />
              {o.l}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Password gate — protects Payroll Dashboard only. Token stored in sessionStorage
// so it clears when the tab closes; re-entered per browser session.
// ══════════════════════════════════════════════════════════════════════════════
function PayrollPasswordGate({ onUnlock }) {
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async e => {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true); setError('');
    try {
      const { token } = await api.payrollAuth(password);
      sessionStorage.setItem('payroll_token', token);
      onUnlock(token);
    } catch (err) {
      setError(err.response?.data?.error || 'Incorrect password');
    } finally {
      setSubmitting(false);
      setPassword('');
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#F9F9F9', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <form onSubmit={handleSubmit} style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, padding: '2rem', width: '100%', maxWidth: 380, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          <div style={{ background: '#EAF4EF', borderRadius: '50%', padding: 14, display: 'flex' }}>
            <Lock size={22} color="#1C4942" />
          </div>
        </div>
        <h2 style={{ color: '#18191B', fontSize: '1.05rem', fontWeight: 700, textAlign: 'center', margin: '0 0 6px' }}>Payroll Dashboard</h2>
        <p style={{ color: '#5D6C7B', fontSize: '0.8rem', textAlign: 'center', margin: '0 0 20px', lineHeight: 1.5 }}>
          This dashboard contains confidential employee salary data.<br />Enter the password to continue.
        </p>
        <input
          type="password" value={password} autoFocus
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
          style={{ width: '100%', boxSizing: 'border-box', background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, color: '#18191B', fontSize: '0.9rem', padding: '0.65rem 0.85rem', marginBottom: 12 }}
        />
        {error && <div style={{ color: '#DC2626', fontSize: '0.8rem', marginBottom: 12, textAlign: 'center' }}>{error}</div>}
        <button type="submit" disabled={submitting || !password}
          style={{ width: '100%', padding: '0.65rem', borderRadius: 8, border: 'none', background: '#1C4942', color: '#fff', fontWeight: 600, fontSize: '0.88rem', cursor: 'pointer', opacity: (submitting || !password) ? 0.6 : 1 }}>
          {submitting ? 'Checking…' : 'Unlock Dashboard'}
        </button>
      </form>
    </div>
  );
}

export default function PayrollDashboard() {
  const [token, setToken] = useState(() => sessionStorage.getItem('payroll_token') || '');

  if (!token) {
    return <PayrollPasswordGate onUnlock={t => setToken(t)} />;
  }
  return (
    <PayrollDashboardContent
      token={token}
      onLocked={() => { sessionStorage.removeItem('payroll_token'); setToken(''); }}
    />
  );
}

// ══════════════════════════════════════════════════════════════════════════════
function PayrollDashboardContent({ token, onLocked }) {
  const [raw, setRaw]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(false);

  // Global FY/Quarter/Company filter (used across ALL reports)
  const [fy, setFy]         = useState('');
  const [quarter, setQuarter] = useState('All');
  const [selectedCompanies, setSelectedCompanies] = useState(COMPANIES);

  // Employee search filters (Report 11)
  const [sfName,    setSfName]    = useState('');
  const [r11Month,  setR11Month]  = useState('All');
  const [sfCaptive, setSfCaptive] = useState('All');
  const [sfBranch,  setSfBranch]  = useState('All');
  const [sfCat,     setSfCat]     = useState('All');

  // Section 2 month / comparison filters
  const [r2Month,       setR2Month]       = useState('');
  const [r2CompareMode, setR2CompareMode] = useState(false);
  const [r2MonthA,      setR2MonthA]      = useState('');
  const [r2MonthB,      setR2MonthB]      = useState('');

  // Section 6 churn granularity
  const [r6Granularity, setR6Granularity] = useState('Monthly'); // Monthly | Quarterly | HalfYearly | Yearly

  // Section 5 filters — independent of the global filter bar, own Company/Month/Category
  const [r5Companies,  setR5Companies]  = useState(COMPANIES);
  const [r5Months,     setR5Months]     = useState([]);
  const [r5Categories, setR5Categories] = useState([]);

  const load = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      setRaw(await api.payrollData(token));
    } catch (e) {
      if (e.response?.status === 401) { onLocked(); return; }
      setError(true);
    } finally { setLoading(false); }
  }, [token, onLocked]);

  useEffect(() => { load(); }, [load]);

  // ── Derived base values ────────────────────────────────────────────────────
  const rows = raw?.rows || [];

  // Company-scoped rows — the global company filter applies to every report below.
  // availableMonths/fys stay based on the FULL row set so toggling companies never
  // hides an FY/month option just because that company had no data that period.
  const scopedRows = useMemo(() =>
    rows.filter(r => selectedCompanies.includes(r.company)), [rows, selectedCompanies]);

  const availableMonths = useMemo(() =>
    [...new Set(rows.map(r => r.month))].sort(), [rows]);

  const fys = useMemo(() =>
    [...new Set(availableMonths.map(fyOf))].sort().reverse(), [availableMonths]);

  // Set default FY once data loads
  useEffect(() => { if (fys.length && !fy) setFy(fys[0]); }, [fys, fy]);

  // Reset Section 2 month selectors when global FY/Quarter filter changes
  useEffect(() => {
    if (!filteredMonths.length) return;
    const last = filteredMonths[filteredMonths.length - 1];
    const prev = filteredMonths.length >= 2 ? filteredMonths[filteredMonths.length - 2] : last;
    setR2Month(last);
    setR2MonthA(prev);
    setR2MonthB(last);
  }, [fy, quarter]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredMonths = useMemo(() =>
    availableMonths.filter(m => {
      if (fy && fyOf(m) !== fy) return false;
      if (quarter !== 'All' && quarterOf(m) !== quarter) return false;
      return true;
    }), [availableMonths, fy, quarter]);

  const currentMonth = useMemo(() =>
    availableMonths.length ? availableMonths[availableMonths.length - 1] : '', [availableMonths]);

  const filteredRows = useMemo(() =>
    scopedRows.filter(r => filteredMonths.includes(r.month)), [scopedRows, filteredMonths]);

  // ── KPI values ────────────────────────────────────────────────────────────
  const currentMonthRows = useMemo(() =>
    scopedRows.filter(r => r.month === currentMonth), [scopedRows, currentMonth]);

  const totalEmp = currentMonthRows.length;
  const totalGrossMonth = currentMonthRows.reduce((s, r) => s + r.gross, 0);
  const totalGrossCumulative = scopedRows.filter(r => fy ? fyOf(r.month) === fy : true)
    .reduce((s, r) => s + r.gross, 0);

  // ── Report 1: Month-wise employee count ───────────────────────────────────
  const r1Data = useMemo(() => {
    return filteredMonths.map(m => {
      const mr = scopedRows.filter(r => r.month === m);
      const counts = {};
      selectedCompanies.forEach(c => { counts[c] = mr.filter(r => r.company === c).length; });
      counts['Total'] = mr.length;
      return { month: m, ...counts };
    });
  }, [scopedRows, filteredMonths, selectedCompanies]);

  // ── Report 2: Dept & company employee count ───────────────────────────────
  const r2SingleData = useMemo(() => {
    const counts = deptCountsForMonth(scopedRows, r2Month);
    return Object.entries(counts)
      .map(([dept, c]) => ({ dept, ...c }))
      .sort((a, b) => b.Total - a.Total);
  }, [scopedRows, r2Month]);

  const r2CompData = useMemo(() => {
    const cA = deptCountsForMonth(scopedRows, r2MonthA);
    const cB = deptCountsForMonth(scopedRows, r2MonthB);
    const depts = [...new Set([...Object.keys(cA), ...Object.keys(cB)])];
    return depts.map(dept => ({
      dept,
      ...selectedCompanies.reduce((acc, c) => ({
        ...acc,
        [`${c}_A`]: cA[dept]?.[c] || 0,
        [`${c}_B`]: cB[dept]?.[c] || 0,
      }), {}),
      TotalA: cA[dept]?.Total || 0,
      TotalB: cB[dept]?.Total || 0,
      delta:  (cB[dept]?.Total || 0) - (cA[dept]?.Total || 0),
    })).sort((a, b) => b.TotalB - a.TotalB);
  }, [scopedRows, r2MonthA, r2MonthB, selectedCompanies]);

  // ── Report 3: Month-wise Gross & Net Salary ────────────────────────────────
  const r3Data = useMemo(() => {
    return filteredMonths.map(m => {
      const mr = scopedRows.filter(r => r.month === m);
      return {
        month: m,
        gross: mr.reduce((s, r) => s + r.gross, 0),
        netPay: mr.reduce((s, r) => s + r.net_pay, 0),
        totalNetPay: mr.reduce((s, r) => s + r.total_net_pay, 0),
      };
    });
  }, [scopedRows, filteredMonths]);

  // ── Report 4: Branch & company Gross Salary ───────────────────────────────
  const r4Data = useMemo(() => {
    const bMap = {};
    filteredRows.forEach(r => {
      if (!r.branch) return;
      if (!bMap[r.branch]) bMap[r.branch] = {};
      bMap[r.branch][r.company] = (bMap[r.branch][r.company] || 0) + r.gross;
    });
    return Object.entries(bMap).map(([branch, byCompany]) => {
      const total = Object.values(byCompany).reduce((s, v) => s + v, 0);
      return { branch, ...byCompany, Total: total };
    }).sort((a, b) => b.Total - a.Total);
  }, [filteredRows]);

  // ── Report 5: Promoter / KMP salary ──────────────────────────────────────
  // Own Company/Month/Category filters — independent of the global filter bar.
  const promoterCategories = useMemo(() =>
    [...new Set(rows.map(r => r.category).filter(c => c && c !== 'Employee'))].sort(), [rows]);

  useEffect(() => { if (availableMonths.length)     setR5Months(availableMonths); }, [availableMonths]);
  useEffect(() => { if (promoterCategories.length)   setR5Categories(promoterCategories); }, [promoterCategories]);

  const promoterRows = useMemo(() =>
    rows.filter(r => r.category && r.category !== 'Employee')
      .filter(r => r5Companies.includes(r.company))
      .filter(r => r5Months.length === 0 || r5Months.includes(r.month))
      .filter(r => r5Categories.length === 0 || r5Categories.includes(r.category))
      .sort((a, b) => b.gross - a.gross),
  [rows, r5Companies, r5Months, r5Categories]);

  // ── Report 6: Churning Rate ───────────────────────────────────────────────
  // Groups months into periods per the selected granularity, then diffs the
  // employee set at the last month of each period vs. the previous period —
  // the same headcount-snapshot logic as before, just re-bucketed.
  const r6Data = useMemo(() => {
    const sorted = [...availableMonths.filter(m => fy ? fyOf(m) === fy : true)].sort();
    if (sorted.length < 2) return [];

    let periods;
    if (r6Granularity === 'Monthly') {
      periods = sorted.map(m => ({ lastMonth: m, label: monthLabel(m) }));
    } else {
      const groups = {};
      sorted.forEach(m => {
        const mm = parseInt(m.split('-')[1], 10);
        let key, label;
        if (r6Granularity === 'Quarterly')       { key = `${fyOf(m)}|${quarterOf(m)}`; label = `${quarterOf(m)} FY${fyOf(m)}`; }
        else if (r6Granularity === 'HalfYearly') { const half = (mm >= 4 && mm <= 9) ? 'H1' : 'H2'; key = `${fyOf(m)}|${half}`; label = `${half} FY${fyOf(m)}`; }
        else                                     { key = fyOf(m); label = `FY ${fyOf(m)}`; }
        if (!groups[key]) groups[key] = { months: [], label };
        groups[key].months.push(m);
      });
      periods = Object.values(groups)
        .map(g => ({ lastMonth: [...g.months].sort().slice(-1)[0], label: g.label }))
        .sort((a, b) => a.lastMonth.localeCompare(b.lastMonth));
    }
    if (periods.length < 2) return [];

    const result = [];
    for (let i = 1; i < periods.length; i++) {
      const prev = periods[i - 1].lastMonth;
      const curr = periods[i].lastMonth;
      selectedCompanies.forEach(co => {
        const prevEmps = new Set(rows.filter(r => r.month === prev && r.company === co).map(r => r.emp_number));
        const currEmps = new Set(rows.filter(r => r.month === curr && r.company === co).map(r => r.emp_number));
        const joined = [...currEmps].filter(e => !prevEmps.has(e)).length;
        const left   = [...prevEmps].filter(e => !currEmps.has(e)).length;
        const avg    = (prevEmps.size + currEmps.size) / 2;
        const churnRate = avg > 0 ? Math.round((left / avg) * 10000) / 100 : 0;
        result.push({ period: `${periods[i - 1].label} → ${periods[i].label}`, company: CO_SHORT[co],
                      prevCount: prevEmps.size, currCount: currEmps.size, joined, left, churnRate });
      });
    }
    return result;
  }, [rows, availableMonths, fy, r6Granularity, selectedCompanies]);

  // ── Report 7: Net Salary Payable (selectable month, company-wise) ─────────
  const [r7Month, setR7Month] = useState('');
  useEffect(() => { if (currentMonth && !r7Month) setR7Month(currentMonth); }, [currentMonth, r7Month]);

  const r7MonthRows = useMemo(() =>
    scopedRows.filter(r => r.month === r7Month), [scopedRows, r7Month]);

  const r7Data = useMemo(() => {
    return selectedCompanies.map(co => {
      const coRows = r7MonthRows.filter(r => r.company === co);
      return {
        company: co,
        count: coRows.length,
        netPay: coRows.reduce((s, r) => s + r.net_pay, 0),
        totalNetPay: coRows.reduce((s, r) => s + r.total_net_pay, 0),
      };
    });
  }, [r7MonthRows, selectedCompanies]);

  // ── Report 8: Captive Billing (quarterly, per-employee % split) ───────────
  const captiveBilling = useMemo(() => {
    const cap = raw?.captiveSalary;
    if (!cap || !cap.employees.length) return { quarters: [], billingCodes: [], devxCode: null };

    const { employees, monthKeys, companyOrder } = cap;
    const devxCode      = companyOrder.find(c => /devx/i.test(c)) || null;
    const selectedShort = new Set(selectedCompanies.map(c => CO_SHORT[c]));
    // "Bill to" columns are narrowed to the globally-selected companies (DevX itself
    // is never a "bill to" column — its own share always shows separately)
    const billingCodes = companyOrder.filter(c => c !== devxCode && selectedShort.has(c));

    const relevantMonths = monthKeys.filter(m => filteredMonths.includes(m));
    const qMap = {};
    relevantMonths.forEach(m => {
      const q = quarterOf(m);
      if (!qMap[q]) qMap[q] = [];
      qMap[q].push(m);
    });

    const quarters = Object.keys(qMap).sort().map(q => {
      const qMonths = qMap[q];
      const deptMap = {};
      employees.forEach(emp => {
        let empGross = 0;
        let devxInternal = 0;
        const billing = Object.fromEntries(billingCodes.map(c => [c, 0]));
        qMonths.forEach(m => {
          const g = emp.months[m] || 0;
          if (!g) return;
          empGross += g;
          billingCodes.forEach(c => { billing[c] += g * (emp.pctByCompanyByMonth[c]?.[m] || 0); });
          if (devxCode) devxInternal += g * (emp.pctByCompanyByMonth[devxCode]?.[m] || 0);
        });
        if (empGross <= 0) return;
        const dept = emp.department || 'Unassigned';
        if (!deptMap[dept]) deptMap[dept] = { department: dept, totalGross: 0, devxInternal: 0, billing: Object.fromEntries(billingCodes.map(c => [c, 0])) };
        deptMap[dept].totalGross   += empGross;
        deptMap[dept].devxInternal += devxInternal;
        billingCodes.forEach(c => { deptMap[dept].billing[c] += billing[c]; });
      });
      const depts = Object.values(deptMap).sort((a, b) => b.totalGross - a.totalGross);
      const [y0, m0] = qMonths[0].split('-');
      const mN = qMonths[qMonths.length - 1].split('-')[1];
      const rangeLabel = `${MONTH_LABELS[m0] || m0} – ${MONTH_LABELS[mN] || mN} ${y0}`;
      return { quarter: q, rangeLabel, months: qMonths, depts };
    }).filter(qb => qb.depts.length > 0);

    return { quarters, billingCodes, devxCode };
  }, [raw, filteredMonths, selectedCompanies]);

  // ── Reports 9 & 10: PF / ESIC / PT (aggregated from payroll rows) ────────
  const r9r10Data = useMemo(() => {
    const src = (raw?.pfEsicPt) || [];

    const allMonths = [...new Set(src.map(r => r.month))].sort();
    const fyMonths  = allMonths.filter(m => !fy || fyOf(m) === fy);

    const qMap = {};
    fyMonths.forEach(m => {
      const q = quarterOf(m);
      if (!qMap[q]) qMap[q] = [];
      qMap[q].push(m);
    });

    const cols = ['Q1','Q2','Q3','Q4'].filter(q => qMap[q]).map(q => {
      const qMonths = qMap[q];
      const qRows   = src.filter(r =>
        qMonths.includes(r.month) &&
        selectedCompanies.includes(r.company)
      );
      const [y0, m0] = qMonths[0].split('-');
      const [, mN]   = qMonths[qMonths.length - 1].split('-');
      const label = `${MONTH_LABELS[m0] || m0}–${MONTH_LABELS[mN] || mN} ${y0}`;
      const sum = f => qRows.reduce((s, r) => s + (r[f] || 0), 0);
      return {
        quarter: q, label,
        esic_employer: sum('esic_employer'),
        eps_ac10:      sum('eps_ac10'),
        epf_ac01:      sum('epf_ac01'),
        total_pf:      sum('total_pf'),
        total_esic:    sum('total_esic'),
        total_pt:      sum('total_pt'),
      };
    });

    const fyTotal = cols.reduce((acc, c) => {
      ['esic_employer','eps_ac10','epf_ac01','total_pf','total_esic','total_pt']
        .forEach(k => { acc[k] = (acc[k] || 0) + c[k]; });
      return acc;
    }, {});

    return { cols, fyTotal };
  }, [raw, fy, selectedCompanies]);

  // ── Report 11: All Employees (any month, not just current) ───────────────
  const allBranches  = useMemo(() => ['All', ...new Set(scopedRows.map(r => r.branch).filter(Boolean))].sort(), [scopedRows]);
  const allCats      = useMemo(() => ['All', ...new Set(scopedRows.map(r => r.category).filter(Boolean))].sort(), [scopedRows]);

  const empTableRows = useMemo(() => {
    return scopedRows
      .filter(r => r11Month === 'All' || r.month === r11Month)
      .filter(r => !sfName    || r.emp_name.toLowerCase().includes(sfName.toLowerCase()))
      .filter(r => sfCaptive === 'All' || r.captive === sfCaptive)
      .filter(r => sfBranch  === 'All' || r.branch  === sfBranch)
      .filter(r => sfCat     === 'All' || r.category === sfCat)
      .sort((a, b) => b.month === a.month ? a.emp_name.localeCompare(b.emp_name) : b.month.localeCompare(a.month));
  }, [scopedRows, r11Month, sfName, sfCaptive, sfBranch, sfCat]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ padding: '3rem', textAlign: 'center', color: '#5D6C7B' }}>
      <div style={{ fontSize: '0.9rem' }}>Loading payroll data…</div>
    </div>
  );
  if (error) return (
    <div style={{ padding: '3rem', textAlign: 'center', color: '#DC2626' }}>
      <div>Failed to load payroll data. Check server.</div>
      <button onClick={load} style={{ marginTop: 12, padding: '0.4rem 1rem', background: '#F9F9F9', border: '1px solid #DFE7E3', color: '#9BA8B0', borderRadius: 6, cursor: 'pointer' }}>Retry</button>
    </div>
  );

  return (
    <div style={{ padding: '1.5rem 2rem', background: '#F9F9F9', minHeight: '100vh', fontFamily: "'Figtree','Inter',-apple-system,sans-serif" }}>

      {/* ── Page header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, color: '#18191B', fontSize: '1.3rem', fontWeight: 700 }}>Payroll Dashboard</h1>
          <p style={{ margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.8rem' }}>
            Payroll data for {selectedCompanies.map(c => CO_SHORT[c]).join(', ')} · Data up to {monthLabel(currentMonth)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#9BA8B0', fontSize: '0.72rem' }}>
            <Lock size={11} /> Confidential
          </span>
          <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#F9F9F9', border: '1px solid #DFE7E3', color: '#9BA8B0', padding: '0.45rem 1rem', borderRadius: 7, cursor: 'pointer', fontSize: '0.82rem' }}>
            <RefreshCw size={13} /> Refresh Data
          </button>
        </div>
      </div>

      {/* ── KPI row ── */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <KCard label={`Total Employees — ${monthLabel(currentMonth)}`}
          value={totalEmp.toLocaleString('en-IN')}
          sub={selectedCompanies.map(c => `${CO_SHORT[c]} ${currentMonthRows.filter(r=>r.company===c).length}`).join(' · ')}
          icon={Users} color="#1C4942" />
        <KCard label={`Total Gross Salary — ${monthLabel(currentMonth)}`}
          value={INR(totalGrossMonth)}
          sub={selectedCompanies.map(c => `${CO_SHORT[c]} ${INR(currentMonthRows.filter(r=>r.company===c).reduce((s,r)=>s+r.gross,0))}`).join(' · ')}
          icon={IndianRupee} color="#15803D" />
        <KCard label={`Total Gross Salary — FY ${fy} (Cumulative)`}
          value={INR(totalGrossCumulative)}
          sub={`Across ${scopedRows.filter(r => fy ? fyOf(r.month) === fy : true).reduce((s,r)=>s+1,0).toLocaleString('en-IN')} employee-months`}
          icon={IndianRupee} color="#8b5cf6" />
      </div>

      {/* ── Global FY / Quarter / Company filter — applies to every report below ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: '#5D6C7B', fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Filter Reports:</span>
        <select value={fy} onChange={e => setFy(e.target.value)}
          style={{ background: '#F9F9F9', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.35rem 0.7rem', fontSize: '0.78rem' }}>
          {fys.map(f => <option key={f} value={f}>FY {f}</option>)}
        </select>
        {['All','Q1','Q2','Q3','Q4'].map(q => (
          <button key={q} onClick={() => setQuarter(q)}
            style={{ background: quarter === q ? '#1C4942' : '#F9F9F9', color: quarter === q ? '#fff' : '#5D6C7B',
                     border: '1px solid', borderColor: quarter === q ? '#1C4942' : '#DFE7E3',
                     borderRadius: 6, padding: '0.35rem 0.7rem', fontSize: '0.75rem', cursor: 'pointer' }}>
            {q}
          </button>
        ))}
        <span style={{ color: '#DFE7E3' }}>|</span>
        <CompanyMultiSelect selected={selectedCompanies} onChange={setSelectedCompanies} />
      </div>
      <div style={{ marginBottom: '1.25rem' }}>
        <span style={{ color: '#9BA8B0', fontSize: '0.72rem' }}>
          Showing: {selectedCompanies.length === COMPANIES.length ? 'All Companies' : selectedCompanies.map(c => CO_SHORT[c]).join(', ')}
          {' · '}{filteredMonths.map(monthLabel).join(', ') || 'No months'}
        </span>
      </div>

      {/* ════ Report 1: Month-wise Employee Count ════ */}
      <Section title="1. Month-wise Employee Count" sub="Selected companies — combined and individual">
        <TblWrap>
          <thead>
            <tr>
              <th style={{ ...thSt, textAlign: 'left' }}>Month</th>
              {selectedCompanies.map(c => <th key={c} style={{ ...thSt, textAlign: 'right' }}>{CO_SHORT[c]}</th>)}
              <th style={{ ...thSt, textAlign: 'right', color: '#18191B' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {r1Data.length === 0 && (
              <tr><td colSpan={selectedCompanies.length + 2} style={{ ...tdSt, textAlign: 'center', color: '#9BA8B0' }}>No data for selected period</td></tr>
            )}
            {r1Data.map((row, i) => (
              <tr key={row.month} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                <td style={{ ...tdSt, color: '#18191B' }}>{monthLabel(row.month)}</td>
                {selectedCompanies.map(c => <td key={c} style={{ ...numTd, color: '#9BA8B0' }}>{(row[c]||0).toLocaleString('en-IN')}</td>)}
                <td style={totalTd}>{row.Total.toLocaleString('en-IN')}</td>
              </tr>
            ))}
            {r1Data.length > 1 && (
              <tr style={{ background: 'rgba(28,73,66,0.04)', borderTop: '2px solid #DFE7E3' }}>
                <td style={{ ...tdSt, color: '#5D6C7B', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase' }}>Avg / Month</td>
                {selectedCompanies.map(c => <td key={c} style={{ ...numTd, color: '#5D6C7B' }}>{Math.round(r1Data.reduce((s,r)=>s+(r[c]||0),0)/r1Data.length)}</td>)}
                <td style={{ ...totalTd, color: '#5D6C7B' }}>{Math.round(r1Data.reduce((s,r)=>s+r.Total,0)/r1Data.length)}</td>
              </tr>
            )}
          </tbody>
        </TblWrap>
      </Section>

      {/* ════ Report 2: Dept & Company-wise Employee Count ════ */}
      <Section
        title="2. Department-wise & Company-wise Employee Count"
        sub={r2CompareMode
          ? `Comparing ${monthLabel(r2MonthA)} vs ${monthLabel(r2MonthB)}`
          : `Unique employees · ${monthLabel(r2Month)}`}
      >
        {/* ── Filter bar ── */}
        <div style={{ display: 'flex', gap: 8, padding: '0.65rem 1.25rem', borderBottom: '1px solid #DFE7E3', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Mode toggle */}
          {[false, true].map(mode => (
            <button key={String(mode)} onClick={() => setR2CompareMode(mode)}
              style={{ background: r2CompareMode === mode ? '#1C4942' : '#F9F9F9',
                       color: r2CompareMode === mode ? '#fff' : '#5D6C7B',
                       border: '1px solid', borderColor: r2CompareMode === mode ? '#1C4942' : '#DFE7E3',
                       borderRadius: 6, padding: '0.3rem 0.75rem', fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600 }}>
              {mode ? 'Compare Months' : 'Single Month'}
            </button>
          ))}
          <span style={{ color: '#DFE7E3', margin: '0 4px' }}>|</span>
          {!r2CompareMode ? (
            <select value={r2Month} onChange={e => setR2Month(e.target.value)}
              style={{ background: '#F9F9F9', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {filteredMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          ) : (
            <>
              <span style={{ color: '#5D6C7B', fontSize: '0.72rem' }}>Month A</span>
              <select value={r2MonthA} onChange={e => setR2MonthA(e.target.value)}
                style={{ background: '#F9F9F9', color: '#1C4942', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                {availableMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
              <span style={{ color: '#5D6C7B', fontSize: '0.72rem', fontWeight: 700 }}>vs</span>
              <span style={{ color: '#5D6C7B', fontSize: '0.72rem' }}>Month B</span>
              <select value={r2MonthB} onChange={e => setR2MonthB(e.target.value)}
                style={{ background: '#F9F9F9', color: '#15803D', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                {availableMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </>
          )}
        </div>

        {/* ── Single Month Table ── */}
        {!r2CompareMode && (
          <TblWrap>
            <thead>
              <tr>
                <th style={{ ...thSt, textAlign: 'left' }}>Department</th>
                {selectedCompanies.map(c => <th key={c} style={{ ...thSt, textAlign: 'right' }}>{CO_SHORT[c]}</th>)}
                <th style={{ ...thSt, textAlign: 'right', color: '#18191B' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {r2SingleData.length === 0 && (
                <tr><td colSpan={selectedCompanies.length + 2} style={{ ...tdSt, textAlign: 'center', color: '#9BA8B0' }}>No data for selected month</td></tr>
              )}
              {r2SingleData.map((row, i) => (
                <tr key={row.dept} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                  <td style={{ ...tdSt, color: '#18191B' }}>{row.dept}</td>
                  {selectedCompanies.map(c => <td key={c} style={{ ...numTd, color: '#9BA8B0' }}>{row[c] || '—'}</td>)}
                  <td style={totalTd}>{row.Total}</td>
                </tr>
              ))}
              <tr style={{ background: 'rgba(28,73,66,0.04)', borderTop: '2px solid #DFE7E3' }}>
                <td style={{ ...tdSt, color: '#5D6C7B', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase' }}>Total</td>
                {selectedCompanies.map(c => <td key={c} style={{ ...numTd, color: '#5D6C7B', fontWeight: 700 }}>{r2SingleData.reduce((s,r)=>s+(r[c]||0),0)||'—'}</td>)}
                <td style={totalTd}>{r2SingleData.reduce((s,r)=>s+r.Total,0)}</td>
              </tr>
            </tbody>
          </TblWrap>
        )}

        {/* ── Comparison Table ── */}
        {r2CompareMode && (
          <TblWrap>
            <thead>
              <tr>
                <th rowSpan={2} style={{ ...thSt, textAlign: 'left', verticalAlign: 'middle' }}>Department</th>
                <th colSpan={selectedCompanies.length + 1} style={{ ...thSt, textAlign: 'center', color: '#1C4942', background: '#EAF4EF', borderBottom: '1px solid #DFE7E3' }}>{monthLabel(r2MonthA)}</th>
                <th colSpan={selectedCompanies.length + 1} style={{ ...thSt, textAlign: 'center', color: '#15803D', background: 'rgba(21,128,61,0.08)', borderBottom: '1px solid rgba(21,128,61,0.3)' }}>{monthLabel(r2MonthB)}</th>
                <th rowSpan={2} style={{ ...thSt, textAlign: 'right', color: '#18191B', verticalAlign: 'middle' }}>Change</th>
              </tr>
              <tr>
                {selectedCompanies.map(c => <th key={`A_${c}`} style={{ ...thSt, textAlign: 'right', color: '#1C4942', background: '#EAF4EF' }}>{CO_SHORT[c]}</th>)}
                <th style={{ ...thSt, textAlign: 'right', color: '#1C4942', fontWeight: 800, background: '#EAF4EF' }}>Total</th>
                {selectedCompanies.map(c => <th key={`B_${c}`} style={{ ...thSt, textAlign: 'right', color: '#15803D', background: 'rgba(21,128,61,0.06)' }}>{CO_SHORT[c]}</th>)}
                <th style={{ ...thSt, textAlign: 'right', color: '#15803D', fontWeight: 800, background: 'rgba(21,128,61,0.06)' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {r2CompData.length === 0 && (
                <tr><td colSpan={2 * selectedCompanies.length + 3} style={{ ...tdSt, textAlign: 'center', color: '#9BA8B0' }}>No data</td></tr>
              )}
              {r2CompData.map((row, i) => {
                const deltaColor = row.delta > 0 ? '#15803D' : row.delta < 0 ? '#DC2626' : '#5D6C7B';
                return (
                  <tr key={row.dept} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                    <td style={{ ...tdSt, color: '#18191B' }}>{row.dept}</td>
                    {selectedCompanies.map(c => <td key={`A_${c}`} style={{ ...numTd, color: '#5D6C7B' }}>{row[`${c}_A`]||'—'}</td>)}
                    <td style={{ ...numTd, color: '#1C4942', fontWeight: 700 }}>{row.TotalA || '—'}</td>
                    {selectedCompanies.map(c => <td key={`B_${c}`} style={{ ...numTd, color: '#5D6C7B' }}>{row[`${c}_B`]||'—'}</td>)}
                    <td style={{ ...numTd, color: '#15803D', fontWeight: 700 }}>{row.TotalB || '—'}</td>
                    <td style={{ ...numTd, color: deltaColor, fontWeight: 700 }}>
                      {row.delta === 0 ? '—' : row.delta > 0 ? `+${row.delta}` : row.delta}
                    </td>
                  </tr>
                );
              })}
              {/* Totals row */}
              {r2CompData.length > 0 && (
                <tr style={{ background: 'rgba(28,73,66,0.04)', borderTop: '2px solid #DFE7E3' }}>
                  <td style={{ ...tdSt, color: '#5D6C7B', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase' }}>Total</td>
                  {selectedCompanies.map(c => <td key={`A_${c}`} style={{ ...numTd, color: '#1C4942', fontWeight: 700 }}>{r2CompData.reduce((s,r)=>s+(r[`${c}_A`]||0),0)||'—'}</td>)}
                  <td style={{ ...numTd, color: '#1C4942', fontWeight: 800 }}>{r2CompData.reduce((s,r)=>s+r.TotalA,0)}</td>
                  {selectedCompanies.map(c => <td key={`B_${c}`} style={{ ...numTd, color: '#15803D', fontWeight: 700 }}>{r2CompData.reduce((s,r)=>s+(r[`${c}_B`]||0),0)||'—'}</td>)}
                  <td style={{ ...numTd, color: '#15803D', fontWeight: 800 }}>{r2CompData.reduce((s,r)=>s+r.TotalB,0)}</td>
                  <td style={{ ...numTd, fontWeight: 800, color: (() => { const d = r2CompData.reduce((s,r)=>s+r.delta,0); return d>0?'#15803D':d<0?'#DC2626':'#5D6C7B'; })() }}>
                    {(() => { const d = r2CompData.reduce((s,r)=>s+r.delta,0); return d===0?'—':d>0?`+${d}`:d; })()}
                  </td>
                </tr>
              )}
            </tbody>
          </TblWrap>
        )}
      </Section>

      {/* ════ Report 3: Month-wise Gross & Net Salary ════ */}
      <Section title="3. Month-wise Gross Salary & Net Salary" sub={selectedCompanies.length === COMPANIES.length ? 'Combined across all companies' : `Combined across ${selectedCompanies.map(c => CO_SHORT[c]).join(', ')}`}>
        <div style={{ display: 'flex', gap: 8, padding: '0.75rem 1.25rem', borderBottom: '1px solid #DFE7E3', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#5D6C7B', fontSize: '0.75rem', fontWeight: 600 }}>Company:</span>
          <CompanyMultiSelect selected={selectedCompanies} onChange={setSelectedCompanies} />
        </div>
        <TblWrap>
          <thead>
            <tr>
              <th style={{ ...thSt, textAlign: 'left' }}>Month</th>
              <th style={{ ...thSt, textAlign: 'right' }}>Gross Salary (A)</th>
              <th style={{ ...thSt, textAlign: 'right' }}>Net Pay (A-B-C)</th>
              <th style={{ ...thSt, textAlign: 'right' }}>Total Net Pay</th>
            </tr>
          </thead>
          <tbody>
            {r3Data.map((row, i) => (
              <tr key={row.month} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                <td style={{ ...tdSt, color: '#18191B' }}>{monthLabel(row.month)}</td>
                <td style={{ ...numTd, color: '#15803D', fontWeight: 600 }}>{INR(row.gross)}</td>
                <td style={{ ...numTd, color: '#9BA8B0' }}>{INR(row.netPay)}</td>
                <td style={{ ...numTd, color: '#18191B', fontWeight: 600 }}>{INR(row.totalNetPay)}</td>
              </tr>
            ))}
            {r3Data.length > 1 && (
              <tr style={{ background: 'rgba(28,73,66,0.04)', borderTop: '2px solid #DFE7E3' }}>
                <td style={{ ...tdSt, fontWeight: 700, color: '#5D6C7B', fontSize: '0.72rem', textTransform: 'uppercase' }}>Total</td>
                <td style={{ ...numTd, color: '#15803D', fontWeight: 700 }}>{INR(r3Data.reduce((s,r)=>s+r.gross,0))}</td>
                <td style={{ ...numTd, color: '#5D6C7B', fontWeight: 700 }}>{INR(r3Data.reduce((s,r)=>s+r.netPay,0))}</td>
                <td style={{ ...numTd, color: '#18191B', fontWeight: 700 }}>{INR(r3Data.reduce((s,r)=>s+r.totalNetPay,0))}</td>
              </tr>
            )}
          </tbody>
        </TblWrap>
      </Section>

      {/* ════ Report 4: Branch & Company-wise Gross Salary ════ */}
      <Section title="4. Branch-wise & Company-wise Gross Salary" sub="Gross salary grouped by branch and company for selected period">
        <TblWrap>
          <thead>
            <tr>
              <th style={{ ...thSt, textAlign: 'left' }}>Branch</th>
              {selectedCompanies.map(c => <th key={c} style={{ ...thSt, textAlign: 'right' }}>{CO_SHORT[c]}</th>)}
              <th style={{ ...thSt, textAlign: 'right', color: '#18191B' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {r4Data.length === 0 && (
              <tr><td colSpan={selectedCompanies.length + 2} style={{ ...tdSt, textAlign: 'center', color: '#9BA8B0' }}>No data</td></tr>
            )}
            {r4Data.map((row, i) => (
              <tr key={row.branch} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                <td style={{ ...tdSt, color: '#18191B' }}>{row.branch || '—'}</td>
                {selectedCompanies.map(c => <td key={c} style={{ ...numTd, color: '#9BA8B0' }}>{row[c] ? INR(row[c]) : '—'}</td>)}
                <td style={{ ...totalTd, color: '#15803D' }}>{INR(row.Total)}</td>
              </tr>
            ))}
            <tr style={{ background: 'rgba(28,73,66,0.04)', borderTop: '2px solid #DFE7E3' }}>
              <td style={{ ...tdSt, fontWeight: 700, color: '#5D6C7B', fontSize: '0.72rem', textTransform: 'uppercase' }}>Grand Total</td>
              {selectedCompanies.map(c => <td key={c} style={{ ...numTd, fontWeight: 700, color: '#5D6C7B' }}>{INR(r4Data.reduce((s,r)=>s+(r[c]||0),0))}</td>)}
              <td style={{ ...totalTd, color: '#15803D' }}>{INR(r4Data.reduce((s,r)=>s+r.Total,0))}</td>
            </tr>
          </tbody>
        </TblWrap>
      </Section>

      {/* ════ Report 5: Promoter / KMP Salary ════ */}
      <Section title="5. Promoter & KMP Salary" sub="Employees with category KMP / SMP / Relative / Promoter">
        <div style={{ display: 'flex', gap: 8, padding: '0.75rem 1.25rem', borderBottom: '1px solid #DFE7E3', alignItems: 'center', flexWrap: 'wrap' }}>
          <MultiSelectDropdown label="Company" options={COMPANIES.map(c => ({ v: c, l: CO_SHORT[c] }))} selected={r5Companies} onChange={setR5Companies} />
          <MultiSelectDropdown label="Month" options={availableMonths.map(m => ({ v: m, l: monthLabel(m) }))} selected={r5Months} onChange={setR5Months} />
          <MultiSelectDropdown label="Category" options={promoterCategories.map(c => ({ v: c, l: c }))} selected={r5Categories} onChange={setR5Categories} />
          <span style={{ color: '#9BA8B0', fontSize: '0.72rem', marginLeft: 4 }}>{promoterRows.length} records</span>
        </div>
        {promoterRows.length === 0
          ? <div style={{ padding: '1.5rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.82rem' }}>No promoter/KMP data match the filter</div>
          : (
          <TblWrap>
            <thead>
              <tr>
                <th style={{ ...thSt, textAlign: 'left' }}>Employee</th>
                <th style={{ ...thSt, textAlign: 'left' }}>Category</th>
                <th style={{ ...thSt, textAlign: 'left' }}>Company</th>
                <th style={{ ...thSt, textAlign: 'left' }}>Department</th>
                <th style={{ ...thSt, textAlign: 'left' }}>Month</th>
                <th style={{ ...thSt, textAlign: 'right' }}>Gross Salary</th>
                <th style={{ ...thSt, textAlign: 'right' }}>Net Pay</th>
              </tr>
            </thead>
            <tbody>
              {promoterRows.map((r, i) => (
                <tr key={`${r.emp_number}-${r.month}`} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                  <td style={{ ...tdSt, color: '#18191B' }}>{r.emp_name}</td>
                  <td style={{ ...tdSt }}>
                    <span style={{ background: 'rgba(245,158,11,0.15)', color: '#B45309', borderRadius: 4, padding: '1px 7px', fontSize: '0.7rem', fontWeight: 600 }}>{r.category}</span>
                  </td>
                  <td style={{ ...tdSt, color: '#5D6C7B' }}>{CO_SHORT[r.company] || r.company}</td>
                  <td style={{ ...tdSt, color: '#5D6C7B' }}>{r.department || '—'}</td>
                  <td style={{ ...tdSt, color: '#5D6C7B' }}>{monthLabel(r.month)}</td>
                  <td style={{ ...numTd, color: '#15803D', fontWeight: 600 }}>{INR(r.gross)}</td>
                  <td style={{ ...numTd, color: '#9BA8B0' }}>{INR(r.net_pay)}</td>
                </tr>
              ))}
              <tr style={{ background: 'rgba(28,73,66,0.04)', borderTop: '2px solid #DFE7E3' }}>
                <td colSpan={5} style={{ ...tdSt, fontWeight: 700, color: '#5D6C7B', fontSize: '0.72rem', textTransform: 'uppercase' }}>Total</td>
                <td style={{ ...numTd, color: '#15803D', fontWeight: 700 }}>{INR(promoterRows.reduce((s,r)=>s+r.gross,0))}</td>
                <td style={{ ...numTd, color: '#9BA8B0', fontWeight: 700 }}>{INR(promoterRows.reduce((s,r)=>s+r.net_pay,0))}</td>
              </tr>
            </tbody>
          </TblWrap>
        )}
      </Section>

      {/* ════ Report 6: Churning Rate ════ */}
      <Section title="6. Employee Churning Rate" sub={`${r6Granularity === 'HalfYearly' ? 'Half-Yearly' : r6Granularity} turnover by company (within selected FY)`} defaultOpen={false}>
        <div style={{ display: 'flex', gap: 8, padding: '0.65rem 1.25rem', borderBottom: '1px solid #DFE7E3', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: '#5D6C7B', fontSize: '0.72rem', fontWeight: 600 }}>Period:</span>
          {['Monthly','Quarterly','HalfYearly','Yearly'].map(g => (
            <button key={g} onClick={() => setR6Granularity(g)}
              style={{ background: r6Granularity === g ? '#1C4942' : '#F9F9F9', color: r6Granularity === g ? '#fff' : '#5D6C7B',
                       border: '1px solid', borderColor: r6Granularity === g ? '#1C4942' : '#DFE7E3',
                       borderRadius: 6, padding: '0.3rem 0.7rem', fontSize: '0.72rem', cursor: 'pointer' }}>
              {g === 'HalfYearly' ? 'Half-Yearly' : g}
            </button>
          ))}
        </div>
        {r6Data.length === 0
          ? <div style={{ padding: '1.5rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.82rem' }}>At least 2 periods of data required to compute churning rate</div>
          : (
          <TblWrap>
            <thead>
              <tr>
                <th style={{ ...thSt, textAlign: 'left' }}>Period</th>
                <th style={{ ...thSt, textAlign: 'left' }}>Company</th>
                <th style={{ ...thSt, textAlign: 'right' }}>Opening</th>
                <th style={{ ...thSt, textAlign: 'right' }}>Closing</th>
                <th style={{ ...thSt, textAlign: 'right', color: '#15803D' }}>Joined</th>
                <th style={{ ...thSt, textAlign: 'right', color: '#DC2626' }}>Left</th>
                <th style={{ ...thSt, textAlign: 'right' }}>Churn Rate</th>
              </tr>
            </thead>
            <tbody>
              {r6Data.map((row, i) => (
                <tr key={`${row.period}-${row.company}`} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                  <td style={{ ...tdSt, color: '#9BA8B0' }}>{row.period}</td>
                  <td style={{ ...tdSt, color: '#18191B' }}>{row.company}</td>
                  <td style={numTd}>{row.prevCount}</td>
                  <td style={numTd}>{row.currCount}</td>
                  <td style={{ ...numTd, color: '#15803D', fontWeight: 600 }}>+{row.joined}</td>
                  <td style={{ ...numTd, color: row.left > 0 ? '#DC2626' : '#9BA8B0', fontWeight: 600 }}>{row.left > 0 ? `-${row.left}` : '0'}</td>
                  <td style={{ ...numTd, color: row.churnRate > 5 ? '#B45309' : '#9BA8B0', fontWeight: 600 }}>
                    {row.churnRate.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </TblWrap>
        )}
      </Section>

      {/* ════ Report 7: Net Salary Payable (selectable month) ════ */}
      <Section title={`7. Net Salary Payable — ${monthLabel(r7Month)}`} sub="Company-wise net salary for the selected payroll month">
        <div style={{ display: 'flex', gap: 8, padding: '0.75rem 1.25rem', borderBottom: '1px solid #DFE7E3', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#5D6C7B', fontSize: '0.75rem', fontWeight: 600 }}>Month:</span>
          <select value={r7Month} onChange={e => setR7Month(e.target.value)}
            style={{ background: '#F9F9F9', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
            {availableMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </div>
        <TblWrap>
          <thead>
            <tr>
              <th style={{ ...thSt, textAlign: 'left' }}>Company</th>
              <th style={{ ...thSt, textAlign: 'right' }}>Employees</th>
              <th style={{ ...thSt, textAlign: 'right' }}>Net Pay (A-B-C)</th>
              <th style={{ ...thSt, textAlign: 'right', color: '#18191B' }}>Total Net Pay (incl. advances)</th>
            </tr>
          </thead>
          <tbody>
            {r7Data.map((row, i) => (
              <tr key={row.company} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                <td style={{ ...tdSt, color: '#18191B' }}>{row.company}</td>
                <td style={numTd}>{row.count.toLocaleString('en-IN')}</td>
                <td style={{ ...numTd, color: '#9BA8B0' }}>{INR(row.netPay)}</td>
                <td style={{ ...numTd, color: '#15803D', fontWeight: 600 }}>{INR(row.totalNetPay)}</td>
              </tr>
            ))}
            <tr style={{ background: 'rgba(28,73,66,0.04)', borderTop: '2px solid #DFE7E3' }}>
              <td style={{ ...tdSt, fontWeight: 700, color: '#5D6C7B', fontSize: '0.72rem', textTransform: 'uppercase' }}>Grand Total</td>
              <td style={{ ...numTd, fontWeight: 700, color: '#18191B' }}>{r7Data.reduce((s,r)=>s+r.count,0)}</td>
              <td style={{ ...numTd, fontWeight: 700, color: '#5D6C7B' }}>{INR(r7Data.reduce((s,r)=>s+r.netPay,0))}</td>
              <td style={{ ...numTd, fontWeight: 700, color: '#15803D' }}>{INR(r7Data.reduce((s,r)=>s+r.totalNetPay,0))}</td>
            </tr>
          </tbody>
        </TblWrap>
      </Section>

      {/* ════ Captive Billing ════ */}
      <Section title="8. Captive Department Billing — Quarterly" sub="Bills raised from DevX to subsidiary entities each quarter · based on the Captive sheet's per-employee allocation %">
        {captiveBilling.quarters.length === 0
          ? <div style={{ padding: '1.5rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.82rem' }}>No captive billing data for the selected period</div>
          : (() => {
            const { quarters, billingCodes, devxCode } = captiveBilling;

            const fyGross   = quarters.reduce((s, q) => s + q.depts.reduce((ss, d) => ss + d.totalGross, 0), 0);
            const fyDevx    = quarters.reduce((s, q) => s + q.depts.reduce((ss, d) => ss + d.devxInternal, 0), 0);
            const fyBilling = {};
            billingCodes.forEach(c => {
              fyBilling[c] = quarters.reduce((s, q) => s + q.depts.reduce((ss, d) => ss + (d.billing[c] || 0), 0), 0);
            });

            return (
              <>
                <TblWrap>
                  <thead>
                    <tr>
                      <th style={{ ...thSt, textAlign: 'left', minWidth: 180 }}>Quarter / Department</th>
                      <th style={{ ...thSt, textAlign: 'right' }}>Total Gross</th>
                      <th style={{ ...thSt, textAlign: 'right' }}>{devxCode || 'DevX'} Share</th>
                      {billingCodes.map(c => (
                        <th key={c} style={{ ...thSt, textAlign: 'right', color: '#1C4942' }}>
                          Bill to {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {quarters.map(qb => (
                      <React.Fragment key={qb.quarter}>
                        <tr style={{ background: 'rgba(28,73,66,0.06)' }}>
                          <td colSpan={3 + billingCodes.length} style={{
                            ...tdSt, borderBottom: 'none',
                            color: '#1C4942', fontWeight: 700, fontSize: '0.78rem',
                            letterSpacing: '0.05em', textTransform: 'uppercase',
                            paddingTop: '0.75rem', paddingBottom: '0.5rem',
                          }}>
                            {qb.quarter} &nbsp;·&nbsp; {qb.rangeLabel}
                          </td>
                        </tr>

                        {qb.depts.map((d, i) => (
                          <tr key={d.department} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.015)' }}>
                            <td style={{ ...tdSt, color: '#18191B', paddingLeft: '2rem' }}>{d.department}</td>
                            <td style={{ ...numTd, color: '#18191B', fontWeight: 600 }}>{INR(d.totalGross)}</td>
                            <td style={{ ...numTd, color: '#9BA8B0' }}>{INR(d.devxInternal)}</td>
                            {billingCodes.map(c => (
                              <td key={c} style={{ ...numTd, color: '#1C4942', fontWeight: 600 }}>{INR(d.billing[c])}</td>
                            ))}
                          </tr>
                        ))}

                        <tr style={{ background: 'rgba(28,73,66,0.04)', borderTop: '1px solid #DFE7E3', borderBottom: '2px solid #DFE7E3' }}>
                          <td style={{ ...tdSt, fontWeight: 700, color: '#9BA8B0', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                            {qb.quarter} Total
                          </td>
                          <td style={{ ...numTd, fontWeight: 700, color: '#18191B' }}>
                            {INR(qb.depts.reduce((s, d) => s + d.totalGross, 0))}
                          </td>
                          <td style={{ ...numTd, fontWeight: 700, color: '#5D6C7B' }}>
                            {INR(qb.depts.reduce((s, d) => s + d.devxInternal, 0))}
                          </td>
                          {billingCodes.map(c => (
                            <td key={c} style={{ ...numTd, fontWeight: 700, color: '#1C4942' }}>
                              {INR(qb.depts.reduce((s, d) => s + (d.billing[c] || 0), 0))}
                            </td>
                          ))}
                        </tr>
                      </React.Fragment>
                    ))}

                    {quarters.length > 1 && (
                      <tr style={{ background: 'rgba(28,73,66,0.06)', borderTop: '2px solid #DFE7E3' }}>
                        <td style={{ ...tdSt, fontWeight: 700, color: '#1C4942', textTransform: 'uppercase', fontSize: '0.75rem' }}>
                          FY Total
                        </td>
                        <td style={{ ...numTd, fontWeight: 700, color: '#18191B' }}>{INR(fyGross)}</td>
                        <td style={{ ...numTd, fontWeight: 700, color: '#5D6C7B' }}>{INR(fyDevx)}</td>
                        {billingCodes.map(c => (
                          <td key={c} style={{ ...numTd, fontWeight: 700, color: '#1C4942' }}>{INR(fyBilling[c])}</td>
                        ))}
                      </tr>
                    )}
                  </tbody>
                </TblWrap>
                <div style={{ padding: '0.6rem 1.25rem', borderTop: '1px solid #DFE7E3', color: '#9BA8B0', fontSize: '0.7rem' }}>
                  Source: "Captive F.Y. 2026-27" sheet · Bill to entity = employee's monthly gross × that employee's allocation % for the entity · Only employees with Captive = Yes appear on this sheet
                </div>
              </>
            );
          })()
        }
      </Section>

      {/* ════ Section 9: Defined Contribution Plans ════ */}
      {(() => {
        const qCols = r9r10Data.cols;
        const ft = r9r10Data.fyTotal;
        const items9 = [
          { key: 'esic_employer', label: "Employer's Contribution to State Insurance Corporation (ESIC)", color: '#15803D' },
          { key: 'eps_ac10',      label: "Employer's EPS Contribution — AC-10",                           color: '#B45309' },
          { key: 'epf_ac01',      label: "Employer's Contribution to Provident Fund — EPF (AC-01)",       color: '#8b5cf6' },
        ];
        return (
          <Section title="9. Defined Contribution Plans — Employer's Contribution" sub="Quarterly employer statutory contributions (ESIC · EPS · EPF) — respects the company filter above">
            {qCols.length === 0
              ? <div style={{ padding: '1.5rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.82rem' }}>No data for selected FY</div>
              : (
              <TblWrap>
                <thead>
                  <tr>
                    <th style={{ ...thSt, textAlign: 'left', minWidth: 260 }}>Particulars</th>
                    {qCols.map(c => (
                      <th key={c.quarter} style={{ ...thSt, textAlign: 'right' }}>
                        <div>{c.quarter}</div>
                        <div style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: '0.67rem', marginTop: 2 }}>{c.label}</div>
                      </th>
                    ))}
                    <th style={{ ...thSt, textAlign: 'right', color: '#18191B' }}>FY {fy} Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items9.map((item, i) => (
                    <tr key={item.key} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                      <td style={{ ...tdSt, color: '#18191B' }}>{item.label}</td>
                      {qCols.map(c => (
                        <td key={c.quarter} style={{ ...numTd, color: item.color, fontWeight: 600 }}>{INR(c[item.key])}</td>
                      ))}
                      <td style={{ ...numTd, fontWeight: 700, color: item.color }}>{INR(ft[item.key] || 0)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: 'rgba(28,73,66,0.04)', borderTop: '2px solid #DFE7E3' }}>
                    <td style={{ ...tdSt, fontWeight: 700, color: '#9BA8B0', fontSize: '0.75rem', textTransform: 'uppercase' }}>Total Employer Contribution</td>
                    {qCols.map(c => (
                      <td key={c.quarter} style={{ ...numTd, fontWeight: 700, color: '#18191B' }}>
                        {INR((c.esic_employer||0) + (c.eps_ac10||0) + (c.epf_ac01||0))}
                      </td>
                    ))}
                    <td style={{ ...numTd, fontWeight: 700, color: '#18191B' }}>
                      {INR((ft.esic_employer||0) + (ft.eps_ac10||0) + (ft.epf_ac01||0))}
                    </td>
                  </tr>
                </tbody>
              </TblWrap>
            )}
            <div style={{ padding: '0.6rem 1.25rem', borderTop: '1px solid #DFE7E3', color: '#9BA8B0', fontSize: '0.7rem' }}>
              EPS (AC-10) = min(Basic × 8.33%, ₹1,250) per employee per month when PF is applicable · EPF (AC-1) = PF Employer − EPS
            </div>
          </Section>
        );
      })()}

      {/* ════ Section 10: Total PF / ESIC / PT ════ */}
      {(() => {
        const qCols = r9r10Data.cols;
        const ft = r9r10Data.fyTotal;
        const items10 = [
          { label: 'Total PF (Employee + Employer)',   color: '#8b5cf6', colVal: c => c.total_pf||0,   fyVal: ft.total_pf||0 },
          { label: 'Total ESIC (Employee + Employer)', color: '#15803D', colVal: c => c.total_esic||0, fyVal: ft.total_esic||0 },
          { label: 'Professional Tax (PT)',             color: '#1C4942', colVal: c => c.total_pt||0,   fyVal: ft.total_pt||0 },
        ];
        const grandFy = items10.reduce((s, i) => s + i.fyVal, 0);
        return (
          <Section title="10. Total PF, ESIC & Professional Tax Summary" sub="Combined employee + employer contributions, quarterly and FY-wise — respects the company filter above">
            {qCols.length === 0
              ? <div style={{ padding: '1.5rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.82rem' }}>No data for selected FY</div>
              : (
              <TblWrap>
                <thead>
                  <tr>
                    <th style={{ ...thSt, textAlign: 'left', minWidth: 260 }}>Particulars</th>
                    {qCols.map(c => (
                      <th key={c.quarter} style={{ ...thSt, textAlign: 'right' }}>
                        <div>{c.quarter}</div>
                        <div style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: '0.67rem', marginTop: 2 }}>{c.label}</div>
                      </th>
                    ))}
                    <th style={{ ...thSt, textAlign: 'right', color: '#18191B' }}>FY {fy} Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items10.map((item, i) => (
                    <tr key={item.label} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                      <td style={{ ...tdSt, color: '#18191B' }}>{item.label}</td>
                      {qCols.map(c => (
                        <td key={c.quarter} style={{ ...numTd, color: item.color, fontWeight: 600 }}>{INR(item.colVal(c))}</td>
                      ))}
                      <td style={{ ...numTd, fontWeight: 700, color: item.color }}>{INR(item.fyVal)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: 'rgba(28,73,66,0.04)', borderTop: '2px solid #DFE7E3' }}>
                    <td style={{ ...tdSt, fontWeight: 700, color: '#9BA8B0', fontSize: '0.75rem', textTransform: 'uppercase' }}>Grand Total</td>
                    {qCols.map(c => (
                      <td key={c.quarter} style={{ ...numTd, fontWeight: 700, color: '#18191B' }}>
                        {INR(items10.reduce((s, item) => s + item.colVal(c), 0))}
                      </td>
                    ))}
                    <td style={{ ...numTd, fontWeight: 700, color: '#18191B' }}>{INR(grandFy)}</td>
                  </tr>
                </tbody>
              </TblWrap>
            )}
            <div style={{ padding: '0.6rem 1.25rem', borderTop: '1px solid #DFE7E3', color: '#9BA8B0', fontSize: '0.7rem' }}>
              Total PF = PF Employee + PF Employer (EPF AC-1 + EPS AC-10) · Total ESIC = ESI Employee + ESI Employer
            </div>
          </Section>
        );
      })()}

      {/* ════ Employee Search Table ════ */}
      <Section title="11. All Employees" sub={r11Month === 'All' ? 'All payroll months — use the Month filter to narrow to one' : `Payroll month: ${monthLabel(r11Month)}`} defaultOpen={false}>
        {/* Filter controls */}
        <div style={{ display: 'flex', gap: 8, padding: '0.85rem 1.25rem', flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid #DFE7E3' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#5D6C7B' }} />
            <input value={sfName} onChange={e => setSfName(e.target.value)} placeholder="Search name…"
              style={{ background: '#F9F9F9', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.3rem 0.6rem 0.3rem 1.6rem', fontSize: '0.75rem', width: 160 }} />
          </div>
          {[
            { label: 'Month', state: r11Month, set: setR11Month, opts: [{ v: 'All', l: 'All Months' }, ...availableMonths.map(m => ({ v: m, l: monthLabel(m) }))] },
            { label: 'Captive', state: sfCaptive, set: setSfCaptive, opts: [{ v:'All', l:'All' }, { v:'Yes', l:'Captive' }, { v:'No', l:'Non-Captive' }] },
            { label: 'Branch', state: sfBranch, set: setSfBranch, opts: allBranches.map(b => ({ v: b, l: b })) },
            { label: 'Category', state: sfCat, set: setSfCat, opts: allCats.map(c => ({ v: c, l: c })) },
          ].map(({ label, state, set, opts }) => (
            <select key={label} value={state} onChange={e => set(e.target.value)}
              style={{ background: '#F9F9F9', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          ))}
          <span style={{ color: '#9BA8B0', fontSize: '0.72rem', marginLeft: 4 }}>{empTableRows.length} employee-records</span>
        </div>
        <TblWrap>
          <thead>
            <tr>
              <th style={{ ...thSt, textAlign: 'left' }}>Name</th>
              <th style={{ ...thSt, textAlign: 'left' }}>Month</th>
              <th style={{ ...thSt, textAlign: 'left' }}>Company</th>
              <th style={{ ...thSt, textAlign: 'left' }}>Department</th>
              <th style={{ ...thSt, textAlign: 'left' }}>Branch</th>
              <th style={{ ...thSt, textAlign: 'left' }}>Category</th>
              <th style={{ ...thSt, textAlign: 'center' }}>Captive</th>
              <th style={{ ...thSt, textAlign: 'right' }}>Gross</th>
              <th style={{ ...thSt, textAlign: 'right' }}>Net Pay</th>
            </tr>
          </thead>
          <tbody>
            {empTableRows.length === 0 && (
              <tr><td colSpan={9} style={{ ...tdSt, textAlign: 'center', color: '#9BA8B0' }}>No employees match the filter</td></tr>
            )}
            {empTableRows.slice(0, 200).map((r, i) => (
              <tr key={`${r.emp_number}-${r.month}`} style={{ background: i%2===0?'transparent':'rgba(0,0,0,0.015)' }}>
                <td style={{ ...tdSt, color: '#18191B' }}>{r.emp_name}</td>
                <td style={{ ...tdSt, color: '#5D6C7B', fontSize: '0.75rem' }}>{monthLabel(r.month)}</td>
                <td style={{ ...tdSt, color: '#5D6C7B', fontSize: '0.75rem' }}>{CO_SHORT[r.company] || r.company}</td>
                <td style={{ ...tdSt, color: '#9BA8B0', fontSize: '0.75rem' }}>{r.department || '—'}</td>
                <td style={{ ...tdSt, color: '#9BA8B0', fontSize: '0.72rem' }}>{r.branch || '—'}</td>
                <td style={{ ...tdSt }}>
                  {r.category && r.category !== 'Employee'
                    ? <span style={{ background: 'rgba(245,158,11,0.15)', color: '#B45309', borderRadius: 4, padding: '1px 6px', fontSize: '0.67rem', fontWeight: 600 }}>{r.category}</span>
                    : <span style={{ color: '#9BA8B0', fontSize: '0.72rem' }}>Employee</span>}
                </td>
                <td style={{ ...tdSt, textAlign: 'center' }}>
                  {r.captive?.toLowerCase() === 'yes'
                    ? <span style={{ background: '#EAF4EF', color: '#1C4942', borderRadius: 4, padding: '1px 6px', fontSize: '0.67rem', fontWeight: 600 }}>Captive</span>
                    : <span style={{ color: '#9BA8B0', fontSize: '0.67rem' }}>—</span>}
                </td>
                <td style={{ ...numTd, color: '#15803D', fontWeight: 600 }}>{INR(r.gross)}</td>
                <td style={{ ...numTd, color: '#9BA8B0' }}>{INR(r.net_pay)}</td>
              </tr>
            ))}
            {empTableRows.length > 200 && (
              <tr><td colSpan={9} style={{ ...tdSt, textAlign: 'center', color: '#5D6C7B', fontSize: '0.72rem' }}>
                Showing first 200 of {empTableRows.length} — use filters to narrow down
              </td></tr>
            )}
          </tbody>
        </TblWrap>
      </Section>

    </div>
  );
}
