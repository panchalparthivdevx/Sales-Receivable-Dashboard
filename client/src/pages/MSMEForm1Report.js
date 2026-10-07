import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Lock, Unlock, Download, ChevronDown, ChevronRight,
         AlertTriangle, CheckCircle, X, Info, FileText } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentFY() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  return m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function fyOptions() {
  const cur = getCurrentFY();
  const y0 = parseInt(cur.split('-')[0], 10);
  return [0, -1, -2].map(d => {
    const y = y0 + d;
    return `${y}-${String(y + 1).slice(2)}`;
  });
}

function fmtINR(v) {
  if (!v && v !== 0) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(v);
}

function fmtNum(n) {
  if (n == null) return '0';
  return new Intl.NumberFormat('en-IN').format(n);
}

function fmtTs(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Drill-Down Modal ─────────────────────────────────────────────────────────

const SETTLE_KIND = {
  payment:           'Payment',
  credit:            'Vendor credit',
  earlier:           'Earlier settlement',
  unapplied_payment: 'Unapplied payment',
  unapplied_credit:  'Unapplied credit',
};

function SettledVia({ items }) {
  if (!items?.length) return '—';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {items.map((s, i) => (
        <span key={i} title={`${SETTLE_KIND[s.kind] || s.kind} · ${s.date} · ${fmtINR(s.amount)}`}
              style={{ fontSize: '0.68rem', color: s.kind.startsWith('unapplied') ? '#B45309' : '#5D6C7B', whiteSpace: 'nowrap' }}>
          {s.ref || SETTLE_KIND[s.kind]} · {s.date} · {fmtINR(s.amount)}
        </span>
      ))}
    </div>
  );
}

// Admin: re-read this vendor from Zoho and show where Zoho and the dashboard differ
function RecheckResult({ r }) {
  const box = { border: '1px solid #DFE7E3', borderRadius: 8, padding: '10px 12px', marginTop: 10, background: '#FFFFFF' };
  const h = { fontSize: '0.72rem', fontWeight: 700, color: '#18191B', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' };
  const c = { padding: '4px 8px', fontSize: '0.72rem', borderBottom: '1px solid #DFE7E3', textAlign: 'right', color: '#18191B' };
  const cl = { ...c, textAlign: 'left' };
  const layer = { central_cache: 'Central cache (sync) differs from Zoho', msme_dataset: 'Form-1 settlement data differs from Zoho', none: 'No difference — Zoho, cache and Form-1 agree' };
  const mism = r.differences.items.filter(x => x.status !== 'match');
  const val = (v, item) => (v == null ? '—' : typeof v !== 'number' ? String(v) : /Count/.test(item) ? fmtNum(v) : fmtINR(v));
  return (
    <div style={{ padding: '0 20px 12px' }}>
      <div style={{ ...box, borderColor: r.first_mismatch === 'none' ? 'rgba(21,128,61,0.35)' : 'rgba(245,158,11,0.45)' }}>
        <div style={{ fontSize: '0.78rem', color: '#18191B' }}>
          <strong>First point of mismatch:</strong> {layer[r.first_mismatch] || r.first_mismatch}
          <span style={{ color: '#5D6C7B' }}> · {r.differences.total} records compared, {r.differences.mismatched} different · {r.applied ? 'live read applied to LIVE halves' : 'not applied'}</span>
        </div>
      </div>

      {mism.length > 0 && (
        <div style={box}>
          <div style={h}>Transaction differences (Zoho vs central cache)</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Type', 'Number', 'Status', 'Field', 'Zoho', 'Cache'].map(t => <th key={t} style={{ ...cl, color: '#5D6C7B', fontWeight: 600 }}>{t}</th>)}</tr></thead>
            <tbody>
              {mism.map(x => (
                <tr key={x.type + x.id}>
                  <td style={cl}>{x.type}</td><td style={cl}>{x.number}</td><td style={cl}>{x.status.replace(/_/g, ' ')}</td>
                  <td style={cl}>{(x.fields || []).join(', ') || '—'}</td>
                  <td style={cl}>{x.zoho ? Object.entries(x.zoho).map(([k, v]) => `${k}: ${v}`).join(' · ') : '—'}</td>
                  <td style={cl}>{x.cache ? Object.entries(x.cache).map(([k, v]) => `${k}: ${v}`).join(' · ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={box}>
        <div style={h}>Reconciliation</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Item', 'Zoho (live)', 'Central cache', 'Form-1 data', 'Form-1'].map(t => <th key={t} style={{ ...(t === 'Item' ? cl : c), color: '#5D6C7B', fontWeight: 600 }}>{t}</th>)}</tr></thead>
          <tbody>
            {r.reconciliation.map(row => (
              <tr key={row.item}>
                <td style={cl}>{row.item}</td><td style={c}>{val(row.zoho, row.item)}</td><td style={c}>{val(row.central, row.item)}</td>
                <td style={c}>{val(row.dataset, row.item)}</td><td style={c}>{val(row.form1, row.item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={box}>
        <div style={h}>Live Form-1 figures for this vendor (before → after)</div>
        {['H1', 'H2'].map(hk => (
          <div key={hk} style={{ fontSize: '0.75rem', color: '#18191B', padding: '2px 0' }}>
            <strong>{hk}</strong>: paid {fmtINR(r.before[hk]?.paid)} → {fmtINR(r.after[hk]?.paid)} · outstanding {fmtINR(r.before[hk]?.outstanding)} → {fmtINR(r.after[hk]?.outstanding)}
          </div>
        ))}
      </div>

      {r.frozen_differences?.length > 0 && (
        <div style={{ ...box, borderColor: 'rgba(220,38,38,0.35)' }}>
          <div style={h}>Frozen report reconciliation difference (snapshot not changed)</div>
          {r.frozen_differences.map(f => (
            <div key={f.half} style={{ fontSize: '0.75rem', color: '#18191B', padding: '2px 0' }}>
              <strong>{f.half}</strong> (frozen {f.frozen_at?.slice(0, 10)}): paid {fmtINR(f.frozen.paid)} → {fmtINR(f.recalculated.paid)} · outstanding {fmtINR(f.frozen.outstanding)} → {fmtINR(f.recalculated.outstanding)}
              <div style={{ color: '#5D6C7B', fontSize: '0.7rem' }}>{f.reason}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DrillDownModal({ vendor, onClose, fy, isAdmin, onRechecked }) {
  const [tab, setTab] = useState('paid');
  const [checking, setChecking] = useState(false);
  const [recheck, setRecheck]   = useState(null);
  const [checkErr, setCheckErr] = useState(null);
  if (!vendor) return null;

  async function runRecheck() {
    setChecking(true); setCheckErr(null);
    try {
      const r = await api.msmeF1RecheckVendor({ vendor_id: vendor.vendor_id, fy });
      setRecheck(r);
      onRechecked?.();
    } catch (e) { setCheckErr(e.response?.data?.error || e.message); }
    finally { setChecking(false); }
  }

  const paidBills = vendor.bills_paid || [];
  const outBills  = vendor.bills_outstanding || [];

  const tabStyle = (active) => ({
    padding: '6px 16px', fontSize: '0.78rem', fontWeight: 600,
    borderRadius: 6, cursor: 'pointer', border: 'none',
    background: active ? '#1C4942' : 'transparent',
    color: active ? '#fff' : '#9BA8B0',
  });

  const cellStyle = {
    padding: '8px 10px', fontSize: '0.75rem', color: '#18191B',
    borderBottom: '1px solid #DFE7E3', textAlign: 'right',
  };
  const cellL = { ...cellStyle, textAlign: 'left' };

  function ClassBadge({ cls }) {
    const map = {
      paid_within45: { bg: '#14532d', color: '#4ade80', label: 'Paid ≤45d' },
      paid_after45:  { bg: '#7c2d12', color: '#fb923c', label: 'Paid >45d' },
      out_within45:  { bg: '#EAF4EF', color: '#1C4942', label: 'Out ≤45d' },
      out_after45:   { bg: '#4c1d1d', color: '#f87171', label: 'Out >45d' },
    };
    const c = map[cls] || { bg: '#DFE7E3', color: '#9BA8B0', label: cls };
    return (
      <span style={{ background: c.bg, color: c.color, padding: '2px 8px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 600 }}>
        {c.label}
      </span>
    );
  }

  const bills = tab === 'paid' ? paidBills : outBills;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', overflowY: 'auto' }}>
      <div style={{ background: '#FFFFFF', borderRadius: 12, width: '100%', maxWidth: 900, border: '1px solid #DFE7E3' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #DFE7E3' }}>
          <div>
            <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>{vendor.vendor_name}</div>
            <div style={{ color: '#5D6C7B', fontSize: '0.75rem', marginTop: 2 }}>
              PAN: {vendor.pan || '⚠ Missing'} &nbsp;|&nbsp; MSME: {vendor.msme_type || '—'} &nbsp;|&nbsp; Udyam: {vendor.udyam_number || '—'}
            </div>
            {vendor.notes?.unapplied_knocked_off > 0 && (
              <div style={{ color: '#B45309', fontSize: '0.72rem', marginTop: 3 }}>
                {fmtINR(vendor.notes.unapplied_knocked_off)} of unapplied payments / credits in Zoho knocked off against the oldest bills (as the Zoho vendor statement nets them).
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isAdmin && (
              <button onClick={runRecheck} disabled={checking} title="Re-read this vendor from Zoho Books and reconcile"
                style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#F9F9F9', border: '1px solid #DFE7E3', borderRadius: 6, color: '#1C4942', padding: '5px 10px', fontSize: '0.75rem', cursor: checking ? 'wait' : 'pointer' }}>
                <RefreshCw size={12} className={checking ? 'spin' : ''} /> {checking ? 'Rechecking…' : 'Recheck vendor'}
              </button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5D6C7B' }}>
              <X size={18} />
            </button>
          </div>
        </div>
        {checkErr && (
          <div style={{ margin: '10px 20px 0', padding: '8px 12px', background: 'rgba(220,38,38,0.07)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6, color: '#DC2626', fontSize: '0.75rem' }}>
            {checkErr}
          </div>
        )}
        {recheck && <RecheckResult r={recheck} />}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 6, padding: '12px 20px', background: '#F9F9F9' }}>
          <button style={tabStyle(tab === 'paid')} onClick={() => setTab('paid')}>
            Paid Bills ({paidBills.length})
          </button>
          <button style={tabStyle(tab === 'out')} onClick={() => setTab('out')}>
            Outstanding Bills ({outBills.length})
          </button>
        </div>

        {/* Table */}
        <div style={{ overflowX: 'auto', maxHeight: 420 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: tab === 'paid' ? 900 : 720 }}>
            <thead>
              <tr style={{ background: '#F9F9F9' }}>
                {['Bill #', 'Bill Date', 'Due Date', 'Original Amt', tab === 'paid' ? 'Paid Amt' : 'Outstanding Amt',
                  tab === 'paid' ? 'Payment Date' : 'Ageing to Cutoff', 'Days', 'Classification',
                  ...(tab === 'paid' ? ['Settled via'] : [])].map(h => (
                  <th key={h} style={{ ...cellStyle, color: '#5D6C7B', fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bills.length === 0 ? (
                <tr><td colSpan={tab === 'paid' ? 9 : 8} style={{ ...cellL, textAlign: 'center', color: '#5D6C7B', padding: '24px' }}>No bills in this category</td></tr>
              ) : bills.map((b, i) => (
                <tr key={b.bill_id || i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.015)' }}>
                  <td style={cellL}>{b.bill_number || '—'}{b.source === 'journal' && <span style={{ color: '#B45309', fontSize: '0.68rem' }}> · journal</span>}</td>
                  <td style={cellStyle}>{b.bill_date || '—'}</td>
                  <td style={cellStyle}>{b.due_date || '—'}</td>
                  <td style={cellStyle}>{fmtINR(b.original_amount)}</td>
                  <td style={cellStyle}>{fmtINR(tab === 'paid' ? b.paid_amount : b.outstanding_amount)}</td>
                  <td style={cellStyle}>{tab === 'paid' ? (b.payment_date || '—') : `${b.days} days`}</td>
                  <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{b.days ?? '—'}</td>
                  <td style={{ ...cellStyle, textAlign: 'left' }}><ClassBadge cls={b.classification} /></td>
                  {tab === 'paid' && <td style={{ ...cellStyle, textAlign: 'left' }}><SettledVia items={b.settled_via} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ background: '#F9F9F9', color: '#18191B', border: '1px solid #DFE7E3', borderRadius: 6, padding: '6px 18px', fontSize: '0.8rem', cursor: 'pointer' }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── Freeze Dialog ────────────────────────────────────────────────────────────

function FreezeDialog({ fy, half, halfLabel, onConfirm, onCancel, loading }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#FFFFFF', borderRadius: 12, width: '100%', maxWidth: 480, border: '1px solid #f59e0b88', padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Lock size={20} color="#B45309" />
          <span style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>Freeze Report</span>
        </div>
        <p style={{ color: '#9BA8B0', fontSize: '0.82rem', lineHeight: 1.6, marginBottom: 20 }}>
          Are you sure you want to freeze the <strong style={{ color: '#18191B' }}>MSME Form-1 Report — {half} FY {fy} ({halfLabel})</strong>?
          <br /><br />
          Once frozen, this report will retain the current finalized numbers and will <strong style={{ color: '#B45309' }}>no longer automatically update from Zoho Books</strong>.
          The reason for delay column remains editable.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={loading} style={{ background: '#F9F9F9', color: '#18191B', border: '1px solid #DFE7E3', borderRadius: 6, padding: '8px 18px', fontSize: '0.82rem', cursor: 'pointer' }}>Cancel</button>
          <button onClick={onConfirm} disabled={loading} style={{ background: '#f59e0b', color: '#000', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer' }}>
            {loading ? 'Freezing…' : 'Freeze Report'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Unfreeze Dialog ──────────────────────────────────────────────────────────

function UnfreezeDialog({ fy, half, halfLabel, onConfirm, onCancel, loading }) {
  const [reason, setReason] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#FFFFFF', borderRadius: 12, width: '100%', maxWidth: 480, border: '1px solid #ef444488', padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Unlock size={20} color="#DC2626" />
          <span style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>Unfreeze Report</span>
        </div>
        <p style={{ color: '#9BA8B0', fontSize: '0.82rem', lineHeight: 1.6, marginBottom: 12 }}>
          You are about to <strong style={{ color: '#DC2626' }}>unfreeze</strong> the MSME Form-1 Report — {half} FY {fy} ({halfLabel}).
          The report will resume fetching live data from Zoho Books.
        </p>
        <div style={{ marginBottom: 16 }}>
          <label style={{ color: '#9BA8B0', fontSize: '0.78rem', display: 'block', marginBottom: 4 }}>Reason for unfreeze <span style={{ color: '#DC2626' }}>*</span></label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Provide a reason (required)…"
            rows={3}
            style={{ width: '100%', background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, color: '#18191B', padding: '8px 10px', fontSize: '0.82rem', resize: 'vertical', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={loading} style={{ background: '#F9F9F9', color: '#18191B', border: '1px solid #DFE7E3', borderRadius: 6, padding: '8px 18px', fontSize: '0.82rem', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => reason.trim() && onConfirm(reason.trim())} disabled={loading || !reason.trim()}
            style={{ background: !reason.trim() ? '#DFE7E3' : '#DC2626', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: '0.82rem', fontWeight: 700, cursor: reason.trim() ? 'pointer' : 'not-allowed' }}>
            {loading ? 'Unfreezing…' : 'Confirm Unfreeze'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Reason Cell (editable) ───────────────────────────────────────────────────

function ReasonCell({ fy, half, vendorId, initialValue, onSaved }) {
  const [value, setValue] = useState(initialValue || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef(null);

  async function save(v) {
    setSaving(true);
    try {
      await api.msmeF1SetReason({ fy, half, vendor_id: vendorId, reason: v });
      onSaved?.(vendorId, v);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch { } finally { setSaving(false); }
  }

  function handleChange(e) {
    const v = e.target.value;
    setValue(v);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(v), 800);
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={value}
        onChange={handleChange}
        placeholder="Add reason…"
        style={{
          width: '100%', background: 'transparent', border: '1px solid transparent',
          borderRadius: 4, color: '#9BA8B0', padding: '4px 6px', fontSize: '0.75rem',
          outline: 'none', boxSizing: 'border-box',
          transition: 'border-color 0.15s',
        }}
        onFocus={e => e.target.style.borderColor = '#1C4942'}
        onBlur={e => { e.target.style.borderColor = 'transparent'; save(value); }}
      />
      {saving && <span style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', fontSize: '0.65rem', color: '#5D6C7B' }}>…</span>}
      {saved  && <span style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', fontSize: '0.65rem', color: '#4ade80' }}>✓</span>}
    </div>
  );
}

// ─── Half-Year Panel ──────────────────────────────────────────────────────────

function HalfYearPanel({ fy, half, halfConfig, reloadKey, onRechecked }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.isAdmin;

  const [collapsed, setCollapsed]  = useState(true);
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [expanded, setExpanded]   = useState({});
  const [drillVendor, setDrill]   = useState(null);
  const [showFreeze, setShowFreeze]     = useState(false);
  const [showUnfreeze, setShowUnfreeze] = useState(false);
  const [actionLoading, setActLoad]     = useState(false);
  const [search, setSearch]       = useState('');

  const load = useCallback(async (bust = false) => {
    setLoading(true); setError(null);
    try {
      const result = await api.msmeF1HalfYear(fy, half, bust);
      setData(result);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setLoading(false); }
  }, [fy, half]);

  useEffect(() => { load(); }, [load]);
  // A vendor recheck changes both halves — reload this one too
  useEffect(() => { if (reloadKey) load(true); }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep an open drill-down in step with reloaded data
  useEffect(() => {
    setDrill(prev => (prev && data?.rows?.find(r => r.vendor_id === prev.vendor_id)) || prev);
  }, [data]);

  async function freeze() {
    if (!data) return;
    setActLoad(true);
    try {
      await api.msmeF1Freeze({ fy, half, half_data: data });
      setShowFreeze(false);
      await load(true);
    } catch (e) { alert(e.response?.data?.error || e.message); }
    finally { setActLoad(false); }
  }

  async function unfreeze(reason) {
    setActLoad(true);
    try {
      await api.msmeF1Unfreeze({ fy, half, reason });
      setShowUnfreeze(false);
      await load(true);
    } catch (e) { alert(e.response?.data?.error || e.message); }
    finally { setActLoad(false); }
  }

  async function exportExcel() {
    if (!data) return;
    try {
      const resp = await api.msmeF1Export({
        fy, half,
        half_label: data.half_label,
        cutoff_date: data.cutoff_date,
        rows: data.rows,
        totals: data.totals,
        status: data.status,
      });
      const url = URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement('a');
      a.href = url; a.download = `MSME_Form1_${fy}_${half}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert('Export failed: ' + (e.message || 'unknown error')); }
  }

  const frozen   = data?.status === 'frozen';
  const upcoming = data?.status === 'upcoming';
  const noData   = data?.status === 'pending' || data?.status === 'unavailable';
  const rows    = data?.rows || [];
  const totals  = data?.totals || {};

  const filtered = search
    ? rows.filter(r => r.vendor_name.toLowerCase().includes(search.toLowerCase()) || (r.pan || '').toLowerCase().includes(search.toLowerCase()))
    : rows;

  const fTotals = filtered.reduce((s, r) => ({
    paid_within45_count:  s.paid_within45_count  + r.paid_within45_count,
    paid_within45_amount: s.paid_within45_amount + r.paid_within45_amount,
    paid_after45_count:   s.paid_after45_count   + r.paid_after45_count,
    paid_after45_amount:  s.paid_after45_amount  + r.paid_after45_amount,
    out_within45_count:   s.out_within45_count   + r.out_within45_count,
    out_within45_amount:  s.out_within45_amount  + r.out_within45_amount,
    out_after45_count:    s.out_after45_count    + r.out_after45_count,
    out_after45_amount:   s.out_after45_amount   + r.out_after45_amount,
  }), { paid_within45_count:0, paid_within45_amount:0, paid_after45_count:0, paid_after45_amount:0,
        out_within45_count:0, out_within45_amount:0, out_after45_count:0, out_after45_amount:0 });

  // ── KPI summary cards ──
  function KpiCard({ label, count, amount, accent }) {
    return (
      <div style={{ background: '#F9F9F9', borderRadius: 8, padding: '12px 16px', border: `1px solid ${accent}22`, flex: 1, minWidth: 160 }}>
        <div style={{ color: '#5D6C7B', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
        <div style={{ color: accent, fontSize: '1.1rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtINR(amount)}</div>
        <div style={{ color: '#5D6C7B', fontSize: '0.72rem', marginTop: 2 }}>{count} bill{count !== 1 ? 's' : ''}</div>
      </div>
    );
  }

  // ── Table header style ──
  const th = (align = 'right') => ({
    padding: '8px 10px', fontSize: '0.67rem', color: '#5D6C7B', fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #DFE7E3',
    textAlign: align, background: '#F9F9F9', whiteSpace: 'nowrap',
  });
  const td = (align = 'right') => ({
    padding: '8px 10px', fontSize: '0.75rem', color: '#18191B',
    borderBottom: '1px solid rgba(0,0,0,0.06)', textAlign: align,
    fontVariantNumeric: 'tabular-nums',
  });

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3', overflow: 'hidden', marginTop: 16 }}>
      {/* Panel header */}
      <div
        style={{ padding: '14px 20px', borderBottom: collapsed ? 'none' : '1px solid #DFE7E3', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, cursor: 'pointer' }}
        onClick={() => setCollapsed(c => !c)}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: collapsed ? '#5D6C7B' : '#1C4942', flexShrink: 0 }}>
              {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            </span>
            <span style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>
              MSME Form-1 Report — {half}
            </span>
            <span style={{ color: '#5D6C7B', fontSize: '0.8rem' }}>{halfConfig.label}</span>
            {frozen ? (
              <span style={{ background: '#f59e0b22', color: '#f59e0b', border: '1px solid #f59e0b44', padding: '2px 8px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 700 }}>
                FROZEN
              </span>
            ) : upcoming || noData ? (
              <span style={{ background: '#64748b22', color: '#94a3b8', border: '1px solid #64748b44', padding: '2px 8px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 700 }}>
                {upcoming ? 'UPCOMING' : data.status.toUpperCase()}
              </span>
            ) : (
              <span style={{ background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44', padding: '2px 8px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 700 }}>
                LIVE
              </span>
            )}
          </div>
          <div style={{ color: '#5D6C7B', fontSize: '0.72rem', marginTop: 3 }}>
            {data ? (
              <>
                {frozen
                  ? `Frozen on ${fmtTs(data.frozen_at)} by ${data.frozen_by}`
                  : `Last refreshed: ${fmtTs(data.last_synced)} · Cut-off: ${data.cutoff_date}`}
                {' · '}{data.vendor_count ?? 0} MSE vendor{(data.vendor_count ?? 0) !== 1 ? 's' : ''}
                {data.debug && data.vendor_count === 0 && (
                  <span style={{ color: '#f59e0b', marginLeft: 8, fontSize: '0.75rem' }}>
                    (open: {data.debug.outstanding_bills} bills · paid: {data.debug.paid_bills} bills · contacts: {data.debug.contacts_fetched} · mse-eligible: {data.debug.mse_eligible_vendors})
                  </span>
                )}
              </>
            ) : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
          {!frozen && (
            <button onClick={() => load(true)} disabled={loading}
              style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#F9F9F9', border: '1px solid #DFE7E3', borderRadius: 6, color: '#9BA8B0', padding: '6px 12px', fontSize: '0.78rem', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          )}
          {!upcoming && (
            <button onClick={exportExcel} disabled={!data}
              style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#EAF4EF', border: '1px solid rgba(21,128,61,0.3)', borderRadius: 6, color: '#15803D', padding: '6px 12px', fontSize: '0.78rem', cursor: 'pointer' }}>
              <Download size={13} /> Export
            </button>
          )}
          {isAdmin && !frozen && !upcoming && !noData && (
            <button onClick={() => setShowFreeze(true)} disabled={!data}
              style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, color: '#B45309', padding: '6px 12px', fontSize: '0.78rem', cursor: 'pointer' }}>
              <Lock size={13} /> Freeze
            </button>
          )}
          {isAdmin && frozen && (
            <button onClick={() => setShowUnfreeze(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6, color: '#DC2626', padding: '6px 12px', fontSize: '0.78rem', cursor: 'pointer' }}>
              <Unlock size={13} /> Unfreeze
            </button>
          )}
        </div>
      </div>

      {!collapsed && <>

      {/* Error */}
      {error && (
        <div style={{ margin: '12px 20px', padding: '10px 14px', background: 'rgba(220,38,38,0.07)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, color: '#DC2626', fontSize: '0.8rem' }}>
          <AlertTriangle size={14} style={{ display: 'inline', marginRight: 6 }} />{error}
        </div>
      )}

      {data?.notice && (
        <div style={{ margin: '12px 20px', padding: '8px 12px', background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, color: '#B45309', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Info size={13} />{data.notice}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#5D6C7B', fontSize: '0.85rem' }}>
          Loading Form-1 data from Zoho Books…
        </div>
      )}

      {data && !upcoming && !noData && (
        <>
          {/* KPI cards */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '14px 20px', borderBottom: '1px solid #DFE7E3', background: 'rgba(0,0,0,0.02)' }}>
            <KpiCard label="Paid ≤45 Days"       count={fTotals.paid_within45_count}  amount={fTotals.paid_within45_amount}  accent="#4ade80" />
            <KpiCard label="Paid >45 Days"        count={fTotals.paid_after45_count}   amount={fTotals.paid_after45_amount}   accent="#fb923c" />
            <KpiCard label="Outstanding ≤45 Days" count={fTotals.out_within45_count}   amount={fTotals.out_within45_amount}   accent="#60a5fa" />
            <KpiCard label="Outstanding >45 Days" count={fTotals.out_after45_count}    amount={fTotals.out_after45_amount}    accent="#f87171" />
          </div>

          {/* Search */}
          <div style={{ padding: '10px 20px', borderBottom: '1px solid #DFE7E3' }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by vendor name or PAN…"
              style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, color: '#18191B', padding: '6px 12px', fontSize: '0.8rem', width: 280, outline: 'none' }}
            />
            {search && (
              <span style={{ marginLeft: 8, color: '#5D6C7B', fontSize: '0.75rem' }}>
                Showing {filtered.length} of {rows.length} vendors
              </span>
            )}
          </div>

          {/* Table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1000 }}>
              <thead>
                {/* Column group headers */}
                <tr>
                  <th colSpan={3} style={{ ...th('left'), borderRight: '1px solid #DFE7E3' }}></th>
                  <th colSpan={2} style={{ ...th(), borderRight: '1px solid #DFE7E3', background: '#14532d22', color: '#4ade80' }}>
                    (d) Paid within 45 Days
                  </th>
                  <th colSpan={2} style={{ ...th(), borderRight: '1px solid #DFE7E3', background: '#7c2d1222', color: '#fb923c' }}>
                    (e) Paid after 45 Days
                  </th>
                  <th colSpan={2} style={{ ...th(), borderRight: '1px solid #DFE7E3', background: '#EAF4EF', color: '#1C4942' }}>
                    (f) Outstanding ≤45 Days
                  </th>
                  <th colSpan={2} style={{ ...th(), borderRight: '1px solid #DFE7E3', background: '#4c1d1d22', color: '#f87171' }}>
                    (g) Outstanding >45 Days
                  </th>
                  <th style={th('left')}></th>
                </tr>
                {/* Sub-column headers */}
                <tr>
                  <th style={{ ...th('center'), width: 40 }}>#</th>
                  <th style={{ ...th('left'), minWidth: 200 }}>
                    <span style={{ color: '#1C4942' }}>↗</span> (b) Name of MSE Supplier
                  </th>
                  <th style={{ ...th('left'), borderRight: '1px solid #DFE7E3', minWidth: 120 }}>(c) PAN</th>
                  <th style={th()}>No.</th>
                  <th style={{ ...th(), borderRight: '1px solid #DFE7E3' }}>Amount (Rs.)</th>
                  <th style={th()}>No.</th>
                  <th style={{ ...th(), borderRight: '1px solid #DFE7E3' }}>Amount (Rs.)</th>
                  <th style={th()}>No.</th>
                  <th style={{ ...th(), borderRight: '1px solid #DFE7E3' }}>Amount (Rs.)</th>
                  <th style={th()}>No.</th>
                  <th style={{ ...th(), borderRight: '1px solid #DFE7E3' }}>Amount (Rs.)</th>
                  <th style={{ ...th('left'), minWidth: 180 }}>(h) Reason for Delay</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={12} style={{ ...td(), textAlign: 'center', padding: '32px', color: '#5D6C7B' }}>
                      <Info size={16} style={{ display: 'inline', marginRight: 6 }} />
                      {upcoming
                        ? `This half-year period starts on ${data?.half_start}. No data to show yet.`
                        : rows.length === 0
                          ? 'No MSE vendor transactions found for this period.'
                          : 'No vendors match the search filter.'}
                    </td>
                  </tr>
                ) : filtered.map((r, idx) => {
                  const isOpen = expanded[r.vendor_id];
                  const hasWarning = r.warnings?.length > 0;
                  return (
                    <tr key={r.vendor_id}
                      style={{ background: idx % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.015)',
                               borderLeft: hasWarning ? '2px solid #f59e0b' : 'none' }}>
                      <td style={{ ...td('center'), color: '#5D6C7B', fontSize: '0.72rem' }}>{idx + 1}</td>
                      <td style={{ ...td('left'), cursor: 'pointer' }} onClick={() => setDrill(r)}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: '#1C4942', fontWeight: 500 }}>{r.vendor_name}</span>
                          {hasWarning && <AlertTriangle size={12} color="#f59e0b" title={r.warnings.join(', ')} />}
                          <FileText size={11} color="#9BA8B0" title="Click to drill down" />
                        </div>
                        {r.udyam_number && <div style={{ color: '#5D6C7B', fontSize: '0.68rem' }}>Udyam: {r.udyam_number}</div>}
                        {r.notes?.medium_enterprise && (
                          <div style={{ color: '#5D6C7B', fontSize: '0.68rem' }}>Medium enterprise (Zoho Enterprise Type)</div>
                        )}
                        {r.notes?.advance_only_in_half > 0 && (
                          <div style={{ color: '#B45309', fontSize: '0.68rem' }}>Advance only — {fmtINR(r.notes.advance_only_in_half)} paid in this half, no bills yet</div>
                        )}
                      </td>
                      <td style={{ ...td('left'), borderRight: '1px solid #DFE7E3', fontFamily: 'monospace', letterSpacing: '0.05em', color: r.pan ? '#9BA8B0' : '#B45309' }}>
                        {r.pan || '⚠ Missing'}
                      </td>
                      <td style={{ ...td(), color: r.paid_within45_count > 0 ? '#4ade80' : '#9BA8B0', cursor: r.paid_within45_count > 0 ? 'pointer' : 'default' }}
                          onClick={() => r.paid_within45_count > 0 && setDrill({ ...r, _defaultTab: 'paid' })}>
                        {r.paid_within45_count}
                      </td>
                      <td style={{ ...td(), color: r.paid_within45_amount > 0 ? '#4ade80' : '#9BA8B0', borderRight: '1px solid #DFE7E3' }}>
                        {r.paid_within45_amount > 0 ? fmtINR(r.paid_within45_amount) : '—'}
                      </td>
                      <td style={{ ...td(), color: r.paid_after45_count > 0 ? '#fb923c' : '#9BA8B0', cursor: r.paid_after45_count > 0 ? 'pointer' : 'default' }}
                          onClick={() => r.paid_after45_count > 0 && setDrill({ ...r, _defaultTab: 'paid' })}>
                        {r.paid_after45_count}
                      </td>
                      <td style={{ ...td(), color: r.paid_after45_amount > 0 ? '#fb923c' : '#9BA8B0', borderRight: '1px solid #DFE7E3' }}>
                        {r.paid_after45_amount > 0 ? fmtINR(r.paid_after45_amount) : '—'}
                      </td>
                      <td style={{ ...td(), color: r.out_within45_count > 0 ? '#1C4942' : '#9BA8B0', cursor: r.out_within45_count > 0 ? 'pointer' : 'default' }}
                          onClick={() => r.out_within45_count > 0 && setDrill({ ...r, _defaultTab: 'out' })}>
                        {r.out_within45_count}
                      </td>
                      <td style={{ ...td(), color: r.out_within45_amount > 0 ? '#1C4942' : '#9BA8B0', borderRight: '1px solid #DFE7E3' }}>
                        {r.out_within45_amount > 0 ? fmtINR(r.out_within45_amount) : '—'}
                      </td>
                      <td style={{ ...td(), color: r.out_after45_count > 0 ? '#f87171' : '#9BA8B0', cursor: r.out_after45_count > 0 ? 'pointer' : 'default' }}
                          onClick={() => r.out_after45_count > 0 && setDrill({ ...r, _defaultTab: 'out' })}>
                        {r.out_after45_count}
                      </td>
                      <td style={{ ...td(), color: r.out_after45_amount > 0 ? '#f87171' : '#9BA8B0', borderRight: '1px solid #DFE7E3' }}>
                        {r.out_after45_amount > 0 ? fmtINR(r.out_after45_amount) : '—'}
                      </td>
                      <td style={td('left')}>
                        <ReasonCell
                          fy={fy} half={half} vendorId={r.vendor_id}
                          initialValue={r.reason}
                          onSaved={(vid, v) => {
                            setData(prev => prev ? {
                              ...prev,
                              rows: prev.rows.map(row => row.vendor_id === vid ? { ...row, reason: v } : row),
                            } : prev);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Totals row */}
              {filtered.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#F9F9F9', borderTop: '2px solid #DFE7E3' }}>
                    <td colSpan={3} style={{ ...td('left'), fontWeight: 700, color: '#9BA8B0', borderRight: '1px solid #DFE7E3' }}>
                      TOTAL ({filtered.length} vendor{filtered.length !== 1 ? 's' : ''})
                    </td>
                    <td style={{ ...td(), fontWeight: 700, color: '#4ade80' }}>{fmtNum(fTotals.paid_within45_count)}</td>
                    <td style={{ ...td(), fontWeight: 700, color: '#4ade80', borderRight: '1px solid #DFE7E3' }}>{fmtINR(fTotals.paid_within45_amount)}</td>
                    <td style={{ ...td(), fontWeight: 700, color: '#fb923c' }}>{fmtNum(fTotals.paid_after45_count)}</td>
                    <td style={{ ...td(), fontWeight: 700, color: '#fb923c', borderRight: '1px solid #DFE7E3' }}>{fmtINR(fTotals.paid_after45_amount)}</td>
                    <td style={{ ...td(), fontWeight: 700, color: '#1C4942' }}>{fmtNum(fTotals.out_within45_count)}</td>
                    <td style={{ ...td(), fontWeight: 700, color: '#1C4942', borderRight: '1px solid #DFE7E3' }}>{fmtINR(fTotals.out_within45_amount)}</td>
                    <td style={{ ...td(), fontWeight: 700, color: '#f87171' }}>{fmtNum(fTotals.out_after45_count)}</td>
                    <td style={{ ...td(), fontWeight: 700, color: '#f87171', borderRight: '1px solid #DFE7E3' }}>{fmtINR(fTotals.out_after45_amount)}</td>
                    <td style={td()}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Validation notes */}
          {rows.some(r => r.warnings?.includes('pan_missing')) && (
            <div style={{ margin: '0 20px 12px', padding: '8px 12px', background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, color: '#B45309', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={13} />
              {rows.filter(r => r.warnings?.includes('pan_missing')).length} vendor(s) have missing PAN. Update PAN in Zoho Books contact profile.
            </div>
          )}
        </>
      )}

      {/* Drill-down modal */}
      {drillVendor && <DrillDownModal vendor={drillVendor} onClose={() => setDrill(null)} fy={fy} isAdmin={isAdmin} onRechecked={onRechecked} />}

      </>}

      {/* Freeze / Unfreeze dialogs — always rendered so they work even when panel is collapsed */}
      {showFreeze && (
        <FreezeDialog fy={fy} half={half} halfLabel={data?.half_label || ''} onConfirm={freeze} onCancel={() => setShowFreeze(false)} loading={actionLoading} />
      )}
      {showUnfreeze && (
        <UnfreezeDialog fy={fy} half={half} halfLabel={data?.half_label || ''} onConfirm={unfreeze} onCancel={() => setShowUnfreeze(false)} loading={actionLoading} />
      )}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function MSMEForm1Report() {
  const [fy, setFy] = useState(getCurrentFY());
  const [reloadKey, setReloadKey] = useState(0);
  const options = fyOptions();
  const onRechecked = () => setReloadKey(k => k + 1);

  function halfConfigFor(f, h) {
    const y = parseInt(f.split('-')[0], 10);
    if (h === 'H1') return { label: `1 Apr – 30 Sep ${y}`,   start: `${y}-04-01`,   end: `${y}-09-30` };
    if (h === 'H2') return { label: `1 Oct ${y} – 31 Mar ${y+1}`, start: `${y}-10-01`, end: `${y+1}-03-31` };
    return {};
  }

  return (
    <div style={{ marginTop: 32, fontFamily: "'Figtree','Inter',-apple-system,sans-serif" }}>
      {/* Section title + FY selector */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 4 }}>
        <div>
          <h2 style={{ color: '#18191B', fontSize: '1.05rem', fontWeight: 700, margin: 0 }}>MSME Form-1 Report</h2>
          <p style={{ color: '#5D6C7B', fontSize: '0.78rem', margin: '3px 0 0' }}>
            Half-yearly statutory disclosure under Section 22 of MSMED Act — Micro &amp; Small Enterprise suppliers
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#5D6C7B', fontSize: '0.78rem' }}>Financial Year</span>
          <select
            value={fy}
            onChange={e => setFy(e.target.value)}
            style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, color: '#18191B', padding: '5px 10px', fontSize: '0.82rem', cursor: 'pointer', outline: 'none' }}
          >
            {options.map(f => <option key={f} value={f}>FY {f}</option>)}
          </select>
        </div>
      </div>

      {/* H1 Panel */}
      <HalfYearPanel key={`${fy}-H1`} fy={fy} half="H1" halfConfig={halfConfigFor(fy, 'H1')} reloadKey={reloadKey} onRechecked={onRechecked} />

      {/* Divider */}
      <div style={{ height: 1, background: '#DFE7E3', margin: '4px 0' }} />

      {/* H2 Panel */}
      <HalfYearPanel key={`${fy}-H2`} fy={fy} half="H2" halfConfig={halfConfigFor(fy, 'H2')} reloadKey={reloadKey} onRechecked={onRechecked} />
    </div>
  );
}
