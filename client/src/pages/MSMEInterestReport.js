import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { RefreshCw, Lock, Unlock, Download, ChevronDown, ChevronRight, Settings, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { api } from '../utils/api';
import DataFreshness from '../components/DataFreshness';
import { formatINR, formatDate } from '../utils/format';
import { useAuth } from '../contexts/AuthContext';

const BASE = `/api`;

// ─── Constants ────────────────────────────────────────────────────────────────

function getCurrentFY() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  return m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function getQuarterConfig(fy) {
  const y = parseInt(fy.split('-')[0], 10);
  return [
    { id: 'Q1', label: 'Q1', range: `1 Apr – 30 Jun ${y}`,   end: new Date(`${y}-06-30`),   start: new Date(`${y}-04-01`) },
    { id: 'Q2', label: 'Q2', range: `1 Jul – 30 Sep ${y}`,   end: new Date(`${y}-09-30`),   start: new Date(`${y}-07-01`) },
    { id: 'Q3', label: 'Q3', range: `1 Oct – 31 Dec ${y}`,   end: new Date(`${y}-12-31`),   start: new Date(`${y}-10-01`) },
    { id: 'Q4', label: 'Q4', range: `1 Jan – 31 Mar ${y+1}`, end: new Date(`${y+1}-03-31`), start: new Date(`${y+1}-01-01`) },
  ];
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function fmtINR2(v) {
  if (!v) return '₹0.00';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

function fmtPct(v) {
  if (v == null) return '—';
  return (v * 100).toFixed(4) + '%';
}

function fmtTs(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function groupBillsByVendor(bills) {
  const map = {};
  for (const b of bills) {
    if (!map[b.vendor_id]) {
      map[b.vendor_id] = {
        vendor_id: b.vendor_id, vendor_name: b.vendor_name,
        enterprise_type: b.enterprise_type, major_activity: b.major_activity,
        major_activity_source: b.major_activity_source || null,
        bills: [], total_amount: 0, total_balance: 0, total_interest: 0, total_itr: 0,
        has_exceptions: false, bill_count: 0,
      };
    }
    const v = map[b.vendor_id];
    v.bills.push(b);
    v.total_amount   += b.bill_amount;
    v.total_balance  += b.balance_due;
    v.total_interest += b.interest_amount;
    v.total_itr      += b.itr_disallowed;
    v.bill_count     += 1;
    if (b.exceptions?.length) v.has_exceptions = true;
  }
  return Object.values(map).sort((a, b) => b.total_interest - a.total_interest);
}

function filterBills(bills, f) {
  const { search = '', entType = '', majAct = '', overdueOnly = false, appOnly = false } = f || {};
  return bills.filter(b => {
    if (search && !b.vendor_name.toLowerCase().includes(search.toLowerCase()) && !b.bill_number.toLowerCase().includes(search.toLowerCase())) return false;
    if (entType && b.enterprise_type !== entType) return false;
    if (majAct  && b.major_activity  !== majAct)  return false;
    if (overdueOnly && b.interest_days <= 0) return false;
    if (appOnly && b.msme_applicable !== true) return false;
    return true;
  });
}

// ─── EntTypeBadge & ActBadge ──────────────────────────────────────────────────

function EntBadge({ type }) {
  const map = { Micro: '#06b6d4', Small: '#3b82f6', Medium: '#8b5cf6' };
  const c = map[type] || '#6b7280';
  return (
    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700, background: `${c}18`, color: c, border: `1px solid ${c}40`, whiteSpace: 'nowrap' }}>
      {type || '—'}
    </span>
  );
}

function ActBadge({ act }) {
  const map = { Manufacturing: '#f59e0b', Services: '#10b981', Trading: '#6b7280' };
  const c = act ? (map[act] || '#6b7280') : '#9BA8B0';
  return (
    <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 600, background: `${c}15`, color: act ? c : '#9BA8B0', border: `1px solid ${c}30`, whiteSpace: 'nowrap' }}>
      {act || 'Unknown'}
    </span>
  );
}

function AppBadge({ applicable }) {
  if (applicable === true)  return <span style={{ color: '#22c55e', fontSize: '0.7rem', fontWeight: 700 }}>✓ Applicable</span>;
  if (applicable === false) return <span style={{ color: '#6b7280', fontSize: '0.7rem' }}>✗ N/A</span>;
  return <span style={{ color: '#f59e0b', fontSize: '0.7rem' }}>? Unknown</span>;
}

// ─── CalcDetailModal ──────────────────────────────────────────────────────────

function CalcDetailModal({ bill, quarterCloseDate, onClose }) {
  if (!bill) return null;
  const items = [
    ['Bill Date', formatDate(bill.date)],
    ['Transaction Posting Date', formatDate(bill.posting_date)],
    ['Quarter Closing Date', formatDate(quarterCloseDate)],
    ['Bill Amount', fmtINR2(bill.bill_amount)],
    ['Amount Paid', fmtINR2(bill.amount_paid)],
    ['Balance Due (Outstanding)', fmtINR2(bill.balance_due)],
    null,
    ['Credit Period Used', `${bill.credit_days_used} days`],
    ['Ageing Days (Quarter Close − Bill Date)', `${bill.ageing_days} days`],
    ['Days for Interest Calculation (Ageing − Credit)', `${bill.interest_days} days`],
    ['Maximum Days (cap at 365)', `${bill.max_days} days`],
    null,
    ['Enterprise Type', bill.enterprise_type || '—'],
    ['Major Activity', `${bill.major_activity || '—'}${bill.major_activity_source ? ` (source: ${bill.major_activity_source === 'zoho' ? 'Zoho Books' : bill.major_activity_source === 'vendor_reg' ? 'Vendor Registration' : 'Manual override'})` : ''}`],
    ['MSME Interest Applicable', bill.msme_applicable === true ? 'Yes' : bill.msme_applicable === false ? 'No (Trading or Medium)' : 'Unknown — missing data'],
    null,
    ['Applicable Rate', fmtPct(bill.applicable_rate) + (bill.interest_days > 365 ? ' (Effective compound rate)' : ' (Simple rate = Bank Rate × 3)')],
    ['Formula', `₹${bill.balance_due.toFixed(2)} × ${fmtPct(bill.applicable_rate)} × ${bill.max_days} / 365`],
    ['Interest Amount', fmtINR2(bill.interest_amount)],
    ['Amount Disallowed in ITR', fmtINR2(bill.itr_disallowed)],
  ];
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>Interest Calculation Detail</div>
            <div style={{ color: '#5D6C7B', fontSize: '0.78rem', marginTop: 2 }}>{bill.vendor_name} — {bill.bill_number}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#5D6C7B', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '1rem 1.25rem' }}>
          {items.map((item, i) => item === null
            ? <div key={i} style={{ height: 1, background: '#DFE7E3', margin: '0.6rem 0' }} />
            : (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0.3rem 0', gap: 12 }}>
                <span style={{ fontSize: '0.78rem', color: '#5D6C7B', flexShrink: 0 }}>{item[0]}</span>
                <span style={{ fontSize: '0.82rem', color: '#18191B', fontFamily: 'monospace', textAlign: 'right' }}>{item[1]}</span>
              </div>
            )
          )}
          {bill.exceptions?.length > 0 && (
            <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 6 }}>
              <div style={{ fontSize: '0.75rem', color: '#f59e0b', fontWeight: 600, marginBottom: 3 }}>⚠ Data Exceptions</div>
              {bill.exceptions.map(e => (
                <div key={e} style={{ fontSize: '0.73rem', color: '#B45309' }}>
                  {e === 'enterprise_type_missing' && '• Enterprise Type (Micro/Small/Medium) not set in Zoho vendor profile'}
                  {e === 'major_activity_missing'  && '• Major Activity not set — fill "MSME Sector" in the Zoho Books vendor profile (Custom Fields)'}
                  {e === 'major_activity_unrecognized' && '• MSME Sector in Zoho is not Manufacturing/Services/Trading — review vendor profile (interest not auto-calculated)'}
                  {e === 'bill_date_missing'        && '• Bill date is missing — cannot calculate ageing'}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── FreezeDialog ─────────────────────────────────────────────────────────────

function FreezeDialog({ fy, quarter, summary, onConfirm, onCancel, loading }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div style={{ background: '#FFFFFF', border: '1px solid rgba(28,73,66,0.4)', borderRadius: 12, width: '100%', maxWidth: 480 }}>
        <div style={{ padding: '1.1rem 1.25rem', borderBottom: '1px solid #DFE7E3' }}>
          <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>Freeze {quarter} FY {fy}?</div>
          <div style={{ color: '#5D6C7B', fontSize: '0.78rem', marginTop: 4 }}>
            Once frozen, this quarter will stop fetching updated data from Zoho Books. The current values will be stored as the final quarter-end snapshot.
          </div>
        </div>
        <div style={{ padding: '1rem 1.25rem' }}>
          <div style={{ background: '#EAF4EF', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.78rem', color: '#5D6C7B', marginBottom: 6 }}>Snapshot to be frozen:</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              {[
                ['MSME Bills', summary?.total_msme_bills],
                ['Total Interest', fmtINR2(summary?.total_interest)],
                ['ITR Disallowed', fmtINR2(summary?.total_itr_disallowed)],
                ['Overdue Bills', summary?.overdue_bills],
              ].map(([l, v]) => (
                <div key={l} style={{ background: '#F9F9F9', borderRadius: 6, padding: '0.4rem 0.6rem' }}>
                  <div style={{ fontSize: '0.68rem', color: '#5D6C7B' }}>{l}</div>
                  <div style={{ fontSize: '0.88rem', color: '#1C4942', fontWeight: 700, fontFamily: 'monospace' }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={onCancel} style={{ ...S.btn, background: '#F9F9F9', borderColor: '#DFE7E3', color: '#5D6C7B' }}>
              Cancel
            </button>
            <button onClick={onConfirm} disabled={loading} style={{ ...S.btn, background: 'rgba(28,73,66,0.2)', borderColor: 'rgba(28,73,66,0.5)', color: '#1C4942', opacity: loading ? 0.6 : 1 }}>
              <Lock size={13} />
              {loading ? 'Freezing…' : 'Confirm & Freeze'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── UnfreezeDialog ───────────────────────────────────────────────────────────

function UnfreezeDialog({ fy, quarter, onConfirm, onCancel, loading }) {
  const [reason, setReason] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div style={{ background: '#FFFFFF', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 12, width: '100%', maxWidth: 440 }}>
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3' }}>
          <div style={{ color: '#DC2626', fontWeight: 700, fontSize: '0.95rem' }}>Unfreeze {quarter} FY {fy}?</div>
          <div style={{ color: '#5D6C7B', fontSize: '0.78rem', marginTop: 4 }}>This will resume live data fetching from Zoho Books and discard the frozen snapshot.</div>
        </div>
        <div style={{ padding: '1rem 1.25rem' }}>
          <label style={{ fontSize: '0.78rem', color: '#5D6C7B', display: 'block', marginBottom: 5 }}>Reason for unfreezing (required)</label>
          <textarea
            value={reason} onChange={e => setReason(e.target.value)}
            rows={3} placeholder="e.g. Late payment recorded after quarter close…"
            style={{ width: '100%', background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, color: '#18191B', fontSize: '0.82rem', padding: '0.5rem 0.7rem', resize: 'vertical', boxSizing: 'border-box', marginBottom: '0.85rem' }}
          />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={onCancel} style={{ ...S.btn, background: '#F9F9F9', borderColor: '#DFE7E3', color: '#5D6C7B' }}>Cancel</button>
            <button onClick={() => onConfirm(reason)} disabled={loading || !reason.trim()} style={{ ...S.btn, background: 'rgba(239,68,68,0.15)', borderColor: 'rgba(239,68,68,0.4)', color: '#DC2626', opacity: (loading || !reason.trim()) ? 0.5 : 1 }}>
              <Unlock size={13} />
              {loading ? 'Unfreezing…' : 'Unfreeze Quarter'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── VendorGroupRow ───────────────────────────────────────────────────────────

function VendorGroupRow({ vendor, quarterCloseDate, isAdmin, onCalcDetail, onSetActivity }) {
  const [open, setOpen] = useState(false);
  const hasInterest = vendor.total_interest > 0;
  const rowBg = hasInterest ? 'rgba(239,68,68,0.04)' : 'rgba(0,0,0,0.01)';

  return (
    <>
      <tr style={{ background: rowBg, cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <td style={S.td}>
          <span style={{ color: '#5D6C7B', fontSize: '0.7rem', marginRight: 6 }}>{open ? '▼' : '▶'}</span>
          <span style={{ fontWeight: 600, color: '#18191B' }}>{vendor.vendor_name}</span>
          {vendor.has_exceptions && (
            <span title="Missing MSME data for some bills" style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.68rem', color: '#f59e0b' }}>
              <AlertTriangle size={11} />
            </span>
          )}
        </td>
        <td style={S.td}><EntBadge type={vendor.enterprise_type} /></td>
        <td style={S.td}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <ActBadge act={vendor.major_activity} />
            {vendor.major_activity && vendor.major_activity_source && (
              <span title={`Source: ${vendor.major_activity_source === 'zoho' ? 'Zoho Books vendor custom field "MSME Sector"' : vendor.major_activity_source === 'vendor_reg' ? 'Vendor Registration form' : 'Manual override'}`}
                style={{ fontSize: '0.62rem', color: '#9BA8B0', background: '#F9F9F9', border: '1px solid #DFE7E3', borderRadius: 3, padding: '1px 4px', cursor: 'default', whiteSpace: 'nowrap' }}>
                {vendor.major_activity_source === 'zoho' ? 'Zoho' : vendor.major_activity_source === 'vendor_reg' ? 'Reg' : 'Manual'}
              </span>
            )}
            {isAdmin && vendor.major_activity_source !== 'zoho' && (
              <button onClick={e => { e.stopPropagation(); onSetActivity(vendor); }}
                style={{ fontSize: '0.67rem', color: vendor.major_activity ? '#5D6C7B' : '#1C4942', background: 'none', border: `1px solid ${vendor.major_activity ? '#DFE7E3' : 'rgba(28,73,66,0.3)'}`, borderRadius: 4, padding: '1px 5px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {vendor.major_activity ? 'Override' : 'Set'}
              </button>
            )}
          </div>
        </td>
        <td style={{ ...S.td, textAlign: 'center', fontSize: '0.8rem', color: '#5D6C7B' }}>{vendor.bill_count}</td>
        <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.82rem', color: '#9BA8B0' }}>{formatINR(vendor.total_balance)}</td>
        <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.85rem', fontWeight: 700, color: hasInterest ? '#DC2626' : '#9BA8B0' }}>
          {fmtINR2(vendor.total_interest)}
        </td>
        <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.82rem', color: hasInterest ? '#B45309' : '#9BA8B0' }}>
          {formatINR(vendor.total_itr)}
        </td>
      </tr>

      {open && vendor.bills.map((bill, bi) => (
        <tr key={bill.bill_id || bi} style={{ background: 'rgba(0,0,0,0.03)' }}>
          <td style={{ ...S.td, paddingLeft: '2.5rem' }}>
            <span style={{ color: '#1C4942', fontFamily: 'monospace', fontSize: '0.78rem' }}>↳ {bill.bill_number || 'N/A'}</span>
            <span style={{ color: '#9BA8B0', fontSize: '0.72rem', marginLeft: 8 }}>{formatDate(bill.date)}</span>
          </td>
          <td style={S.td}>
            <span style={{ fontSize: '0.75rem', color: '#5D6C7B', fontFamily: 'monospace' }}>{bill.status}</span>
          </td>
          <td style={S.td}>
            <span style={{ fontSize: '0.75rem', color: '#5D6C7B' }}>
              {bill.interest_days > 0
                ? <span style={{ color: '#ef4444', fontWeight: 600 }}>{bill.ageing_days}d age / {bill.interest_days}d interest</span>
                : <span style={{ color: '#9BA8B0' }}>{bill.ageing_days}d age</span>}
            </span>
          </td>
          <td style={{ ...S.td, textAlign: 'center', fontSize: '0.75rem', color: '#5D6C7B' }}>{bill.max_days}d / {fmtPct(bill.applicable_rate)}</td>
          <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.8rem', color: '#9BA8B0' }}>{formatINR(bill.balance_due)}</td>
          <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 700, color: bill.interest_amount > 0 ? '#DC2626' : '#9BA8B0' }}>
            {fmtINR2(bill.interest_amount)}
          </td>
          <td style={{ ...S.td, textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
              <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: bill.itr_disallowed > 0 ? '#B45309' : '#9BA8B0' }}>{formatINR(bill.itr_disallowed)}</span>
              <button onClick={() => onCalcDetail(bill)} title="View calculation detail"
                style={{ background: 'none', border: '1px solid #DFE7E3', borderRadius: 4, color: '#1C4942', cursor: 'pointer', padding: '2px 5px', fontSize: '0.65rem', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <Info size={10} /> Calc
              </button>
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

// ─── SetActivityModal ─────────────────────────────────────────────────────────

function SetActivityModal({ vendor, onSave, onCancel, saving }) {
  const [act, setAct] = useState(vendor?.major_activity || '');
  const [cp, setCp]   = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, width: 380 }}>
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3' }}>
          <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.9rem' }}>Set MSME Activity</div>
          <div style={{ color: '#5D6C7B', fontSize: '0.75rem', marginTop: 3 }}>{vendor?.vendor_name}</div>
        </div>
        <div style={{ padding: '1rem 1.25rem' }}>
          <label style={{ fontSize: '0.78rem', color: '#5D6C7B', display: 'block', marginBottom: 5 }}>Major Activity</label>
          <select value={act} onChange={e => setAct(e.target.value)}
            style={{ width: '100%', background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, color: '#18191B', fontSize: '0.82rem', padding: '0.45rem 0.6rem', marginBottom: '0.75rem' }}>
            <option value="">— Select —</option>
            <option value="Manufacturing">Manufacturing</option>
            <option value="Services">Services</option>
            <option value="Trading">Trading</option>
          </select>
          <label style={{ fontSize: '0.78rem', color: '#5D6C7B', display: 'block', marginBottom: 5 }}>Credit Period (days, optional override)</label>
          <input type="number" value={cp} onChange={e => setCp(e.target.value)} placeholder="Leave blank to use default (45)"
            style={{ width: '100%', background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, color: '#18191B', fontSize: '0.82rem', padding: '0.45rem 0.6rem', boxSizing: 'border-box', marginBottom: '0.85rem' }} />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={onCancel} style={{ ...S.btn, background: '#F9F9F9', borderColor: '#DFE7E3', color: '#5D6C7B' }}>Cancel</button>
            <button onClick={() => onSave(act, cp)} disabled={!act || saving}
              style={{ ...S.btn, background: 'rgba(28,73,66,0.2)', borderColor: 'rgba(28,73,66,0.4)', color: '#1C4942', opacity: (!act || saving) ? 0.5 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── RateSettingsPanel ────────────────────────────────────────────────────────

function RateSettingsPanel({ settings, onSave }) {
  const [form, setForm] = useState({ bank_rate: '', multiplier: '', credit_period_agreement: '', credit_period_no_agreement: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (settings) setForm({
      bank_rate:                  ((settings.bank_rate || 0.055) * 100).toFixed(2),
      multiplier:                 String(settings.multiplier || 3),
      credit_period_agreement:    String(settings.credit_period_agreement || 45),
      credit_period_no_agreement: String(settings.credit_period_no_agreement || 15),
    });
  }, [settings]);

  const handleSave = async () => {
    setSaving(true); setMsg('');
    try {
      await api.msmeIRSetSettings({
        bank_rate:                  parseFloat(form.bank_rate) / 100,
        multiplier:                 parseFloat(form.multiplier),
        credit_period_agreement:    parseInt(form.credit_period_agreement, 10),
        credit_period_no_agreement: parseInt(form.credit_period_no_agreement, 10),
      });
      setMsg('Settings saved. Reload quarters to see updated calculations.');
      onSave();
    } catch (e) {
      setMsg('Error: ' + (e.response?.data?.error || e.message));
    } finally { setSaving(false); }
  };

  const simpleRate   = (parseFloat(form.bank_rate || 0) / 100) * parseFloat(form.multiplier || 3);
  const effectiveRate = Math.pow(1 + simpleRate / 12, 12) - 1;

  return (
    <div style={{ background: '#F9F9F9', border: '1px solid #DFE7E3', borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>
      <div style={{ color: '#1C4942', fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Settings size={14} /> Interest Rate Settings
        {settings?.updated_by && <span style={{ fontWeight: 400, color: '#9BA8B0', fontSize: '0.72rem', marginLeft: 4 }}>
          Last updated {fmtTs(settings.updated_at)} by {settings.updated_by}
        </span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '0.75rem' }}>
        {[
          { label: 'Bank Rate (%)', key: 'bank_rate', help: 'RBI Bank Rate (e.g. 5.5)' },
          { label: 'MSME Multiplier', key: 'multiplier', help: '3× bank rate per MSME Act' },
          { label: 'Credit Period (Written Agreement, days)', key: 'credit_period_agreement', help: 'Max 45 days per MSME Act' },
          { label: 'Credit Period (No Agreement, days)', key: 'credit_period_no_agreement', help: '15 days per MSME Act' },
        ].map(({ label, key, help }) => (
          <div key={key}>
            <label style={{ fontSize: '0.72rem', color: '#5D6C7B', display: 'block', marginBottom: 4 }}>{label}</label>
            <input type="number" step="0.01" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              style={{ width: '100%', background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 5, color: '#18191B', fontSize: '0.82rem', padding: '0.35rem 0.5rem', boxSizing: 'border-box' }} />
            <div style={{ fontSize: '0.67rem', color: '#9BA8B0', marginTop: 2 }}>{help}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: '0.75rem', color: '#5D6C7B' }}>
          Effective Rates: <span style={{ color: '#1C4942', fontFamily: 'monospace' }}>{(simpleRate * 100).toFixed(2)}%</span> (simple) /
          <span style={{ color: '#a78bfa', fontFamily: 'monospace', marginLeft: 4 }}>{(effectiveRate * 100).toFixed(4)}%</span> (compound, when interest days &gt; 365)
        </div>
        <button onClick={handleSave} disabled={saving} style={{ ...S.btn, marginLeft: 'auto' }}>
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: '0.75rem', color: msg.startsWith('Error') ? '#DC2626' : '#15803D' }}>{msg}</div>}
    </div>
  );
}

// ─── QuarterPanel ─────────────────────────────────────────────────────────────

function QuarterPanel({ fy, qConfig, user, isAdmin, onFreezeRequest, onUnfreezeRequest }) {
  const { id: q, label, range, start, end } = qConfig;
  const now     = new Date();
  const started = now >= start;
  const isCurrent = now >= start && now <= end;

  const [qData,   setQData]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [filter,  setFilter]  = useState({ search: '', entType: '', majAct: '', overdueOnly: false, appOnly: false });
  const [calcBill, setCalcBill] = useState(null);
  const [setActVendor, setSetActVendor] = useState(null);
  const [setActSaving, setSetActSaving] = useState(false);
  const [collapsed, setCollapsed] = useState(!started);

  const load = useCallback(async (force = false) => {
    if (!started && !force) return;
    setLoading(true); setError('');
    try {
      const d = await api.msmeIRQuarter(fy, q);
      setQData(d);
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load');
    } finally { setLoading(false); }
  }, [fy, q, started]);

  useEffect(() => { if (started) load(); }, [load]);

  const handleSetActivity = async (act, creditPeriod) => {
    if (!setActVendor) return;
    setSetActSaving(true);
    try {
      const body = {};
      if (act)        body.major_activity = act;
      if (creditPeriod) body.credit_period = parseInt(creditPeriod, 10);
      await api.msmeIRSetVendorAct(setActVendor.vendor_id, body);
      setSetActVendor(null);
      load(true);
    } catch (e) {
      alert('Error: ' + (e.response?.data?.error || e.message));
    } finally { setSetActSaving(false); }
  };

  const handleExport = async () => {
    if (!qData) return;
    try {
      const r = await api.msmeIRExport({ fy, quarter: q, bills: qData.bills, summary: qData.summary, quarter_close_date: qData.quarter_close_date, status: qData.status });
      const url = window.URL.createObjectURL(new Blob([r.data]));
      const a   = document.createElement('a');
      a.href = url; a.download = `MSME_Interest_${fy}_${q}.xlsx`; a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) { alert('Export failed: ' + e.message); }
  };

  // Filtered and grouped bills
  const allBills    = qData?.bills || [];
  const filtered    = filterBills(allBills, filter);
  const grouped     = groupBillsByVendor(filtered);
  const isFrozen    = qData?.status === 'frozen';
  const summary     = qData?.summary || {};
  const rateS       = qData?.rate_settings || {};

  const KPI_CARDS = qData ? [
    { label: 'MSME Bills', val: summary.total_msme_bills, color: '#6366f1' },
    { label: 'Total Outstanding', val: formatINR(summary.total_outstanding), color: '#3b82f6', wide: true },
    { label: 'Overdue Bills', val: summary.overdue_bills, color: '#f59e0b' },
    { label: 'Overdue Amount', val: formatINR(summary.total_overdue_amount), color: '#f59e0b', wide: true },
    { label: 'MSME Interest', val: fmtINR2(summary.total_interest), color: '#ef4444', wide: true },
    { label: 'ITR Disallowed', val: fmtINR2(summary.total_itr_disallowed), color: '#ef4444', wide: true },
    { label: 'Vendors Liable', val: summary.applicable_vendors, color: '#ec4899' },
    { label: 'Exceptions', val: summary.exceptions_count, color: summary.exceptions_count > 0 ? '#f59e0b' : '#22c55e' },
  ] : [];

  return (
    <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, overflow: 'hidden', marginBottom: '1.25rem' }}>
      {/* Quarter header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', borderBottom: qData || loading ? '1px solid #DFE7E3' : 'none', flexWrap: 'wrap', gap: 8, cursor: 'pointer' }}
        onClick={() => setCollapsed(c => !c)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: collapsed ? '#5D6C7B' : '#1C4942' }}>{collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</span>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>{label} — FY {fy}</span>
              {isCurrent && <span style={{ fontSize: '0.65rem', background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 4, padding: '1px 6px', fontWeight: 700 }}>Current</span>}
              {isFrozen && (
                <span style={{ fontSize: '0.65rem', background: 'rgba(147,197,253,0.1)', color: '#93c5fd', border: '1px solid rgba(93,162,235,0.3)', borderRadius: 4, padding: '1px 6px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <Lock size={9} /> Frozen
                </span>
              )}
              {!started && <span style={{ fontSize: '0.65rem', color: '#9BA8B0', background: '#F9F9F9', borderRadius: 4, padding: '1px 6px', border: '1px solid #DFE7E3' }}>Not Started</span>}
            </div>
            <div style={{ fontSize: '0.75rem', color: '#5D6C7B', marginTop: 2 }}>{range}</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={e => e.stopPropagation()}>
          {qData && isFrozen && (
            <div style={{ fontSize: '0.71rem', color: '#5D6C7B', textAlign: 'right', marginRight: 4 }}>
              <div style={{ color: '#5D6C7B' }}>Frozen {fmtTs(qData.frozen_at)}</div>
              <div>by {qData.frozen_by}</div>
            </div>
          )}
          {qData && !isFrozen && (
            <div style={{ fontSize: '0.7rem', color: '#9BA8B0' }}>
              Synced {fmtTs(qData.last_synced)}
            </div>
          )}
          {started && !loading && (
            <button onClick={() => load(true)} title="Refresh" style={{ ...S.iconBtn }}>
              <RefreshCw size={13} />
            </button>
          )}
          {qData && isAdmin && !isFrozen && (
            <button onClick={() => onFreezeRequest(fy, q, qData)} style={{ ...S.btn, padding: '4px 10px', fontSize: '0.75rem' }}>
              <Lock size={12} /> Freeze {q}
            </button>
          )}
          {qData && isAdmin && isFrozen && (
            <button onClick={() => onUnfreezeRequest(fy, q)} style={{ ...S.btn, padding: '4px 10px', fontSize: '0.75rem', borderColor: 'rgba(239,68,68,0.3)', color: '#DC2626', background: 'rgba(239,68,68,0.08)' }}>
              <Unlock size={12} /> Unfreeze
            </button>
          )}
          {qData && (
            <button onClick={handleExport} title="Export to Excel" style={{ ...S.iconBtn }}>
              <Download size={13} />
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Loading */}
          {loading && (
            <div style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
              <RefreshCw size={20} style={{ animation: 'spin 1s linear infinite', color: '#1C4942', display: 'block', margin: '0 auto 10px' }} />
              <div style={{ color: '#18191B', fontWeight: 600, marginBottom: 4 }}>Calculating MSME interest…</div>
              <div style={{ color: '#9BA8B0', fontSize: '0.78rem' }}>Fetching Zoho Bills + Vendor profiles. May take 30–60 seconds.</div>
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <AlertTriangle size={24} style={{ color: '#f59e0b', display: 'block', margin: '0 auto 8px' }} />
              <div style={{ color: '#B45309', fontWeight: 600, marginBottom: 6 }}>Failed to load {q}</div>
              <div style={{ color: '#5D6C7B', fontSize: '0.8rem', marginBottom: 14 }}>{error}</div>
              <button onClick={() => load(true)} style={S.btn}>Retry</button>
            </div>
          )}

          {/* Not started */}
          {!loading && !error && !qData && !started && (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#9BA8B0', fontSize: '0.85rem' }}>
              This quarter starts on {range.split('–')[0].trim()}. No data available yet.
            </div>
          )}

          {/* KPI cards */}
          {!loading && qData && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0.85rem 1.25rem', borderBottom: '1px solid #DFE7E3' }}>
                {KPI_CARDS.map(k => (
                  <div key={k.label} style={{ background: `${k.color}10`, border: `1px solid ${k.color}30`, borderRadius: 8, padding: '0.4rem 0.75rem', textAlign: 'center', minWidth: k.wide ? 130 : 75 }}>
                    <div style={{ fontSize: k.wide ? '0.88rem' : '1.05rem', fontWeight: 700, color: k.color === '#22c55e' && k.val === 0 ? '#9BA8B0' : k.color, fontFamily: 'monospace', lineHeight: 1.3 }}>{k.val}</div>
                    <div style={{ fontSize: '0.65rem', color: '#5D6C7B', marginTop: 2, whiteSpace: 'nowrap' }}>{k.label}</div>
                  </div>
                ))}
                <div style={{ background: '#F9F9F9', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.4rem 0.75rem', textAlign: 'center', minWidth: 80 }}>
                  <div style={{ fontSize: '0.72rem', color: '#5D6C7B', fontFamily: 'monospace' }}>{(rateS.simple_rate * 100 || 0).toFixed(1)}%</div>
                  <div style={{ fontSize: '0.65rem', color: '#9BA8B0', marginTop: 2, whiteSpace: 'nowrap' }}>Rate (≤365d)</div>
                </div>
                <div style={{ background: '#F9F9F9', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.4rem 0.75rem', textAlign: 'center', minWidth: 80 }}>
                  <div style={{ fontSize: '0.72rem', color: '#5D6C7B', fontFamily: 'monospace' }}>{rateS.credit_days || 45}d</div>
                  <div style={{ fontSize: '0.65rem', color: '#9BA8B0', marginTop: 2 }}>Credit Period</div>
                </div>
              </div>

              {/* Filter bar */}
              <div style={{ display: 'flex', gap: 8, padding: '0.65rem 1.25rem', borderBottom: '1px solid #DFE7E3', flexWrap: 'wrap', alignItems: 'center', background: '#F9F9F9' }}>
                <input value={filter.search} onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
                  placeholder="Search vendor / bill #…"
                  style={{ ...S.filterInput, width: 200 }} />
                <select value={filter.entType} onChange={e => setFilter(f => ({ ...f, entType: e.target.value }))} style={S.filterSelect}>
                  <option value="">All Types</option>
                  <option value="Micro">Micro</option>
                  <option value="Small">Small</option>
                  <option value="Medium">Medium</option>
                </select>
                <select value={filter.majAct} onChange={e => setFilter(f => ({ ...f, majAct: e.target.value }))} style={S.filterSelect}>
                  <option value="">All Activities</option>
                  <option value="Manufacturing">Manufacturing</option>
                  <option value="Services">Services</option>
                  <option value="Trading">Trading</option>
                </select>
                <label style={{ fontSize: '0.75rem', color: '#5D6C7B', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={filter.overdueOnly} onChange={e => setFilter(f => ({ ...f, overdueOnly: e.target.checked }))} />
                  Overdue only
                </label>
                <label style={{ fontSize: '0.75rem', color: '#5D6C7B', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={filter.appOnly} onChange={e => setFilter(f => ({ ...f, appOnly: e.target.checked }))} />
                  Applicable only
                </label>
                <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#9BA8B0' }}>
                  {filtered.length} bills / {grouped.length} vendors
                </span>
              </div>

              {/* Table */}
              {grouped.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: '#9BA8B0', fontSize: '0.83rem' }}>
                  {allBills.length === 0
                    ? 'No MSME vendor bills found for this quarter. Ensure vendors have MSME Type set in Zoho Books.'
                    : 'No bills match the current filters.'}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        <th style={S.th}>Vendor Name</th>
                        <th style={S.th}>Enterprise Type</th>
                        <th style={S.th}>Major Activity</th>
                        <th style={{ ...S.th, textAlign: 'center' }}>Bills</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>Balance Due</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>Interest (₹)</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>ITR Disallowed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grouped.map((vendor, i) => (
                        <VendorGroupRow
                          key={vendor.vendor_id || i}
                          vendor={vendor}
                          quarterCloseDate={qData.quarter_close_date}
                          isAdmin={isAdmin}
                          onCalcDetail={setCalcBill}
                          onSetActivity={setSetActVendor}
                        />
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: '2px solid #DFE7E3', background: '#F9F9F9' }}>
                        <td colSpan={4} style={{ ...S.td, fontWeight: 700, color: '#5D6C7B', fontSize: '0.78rem' }}>
                          Total ({grouped.length} vendor{grouped.length !== 1 ? 's' : ''}, {filtered.length} bills)
                        </td>
                        <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#9BA8B0' }}>
                          {formatINR(filtered.reduce((s, b) => s + b.balance_due, 0))}
                        </td>
                        <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#DC2626' }}>
                          {fmtINR2(filtered.reduce((s, b) => s + b.interest_amount, 0))}
                        </td>
                        <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#B45309' }}>
                          {formatINR(filtered.reduce((s, b) => s + b.itr_disallowed, 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {/* Exception notice */}
              {summary.exceptions_count > 0 && (
                <div style={{ margin: '0.5rem 1.25rem 0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6, fontSize: '0.75rem', color: '#B45309' }}>
                  <AlertTriangle size={12} style={{ display: 'inline', marginRight: 5 }} />
                  {summary.exceptions_count} bill{summary.exceptions_count !== 1 ? 's' : ''} have missing MSME data (Enterprise Type or Major Activity). Interest is set to ₹0 for these bills. {isAdmin ? 'Use the "Set" button beside a vendor to configure Major Activity.' : 'Contact your admin to resolve.'}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Modals */}
      {calcBill && <CalcDetailModal bill={calcBill} quarterCloseDate={qData?.quarter_close_date} onClose={() => setCalcBill(null)} />}
      {setActVendor && <SetActivityModal vendor={setActVendor} onSave={handleSetActivity} onCancel={() => setSetActVendor(null)} saving={setActSaving} />}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MSMEInterestReport() {
  const { user } = useAuth();
  const isAdmin  = user?.role === 'admin';

  const [fy, setFy] = useState(getCurrentFY);
  const [settings, setSettings] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [freezeReq,   setFreezeReq]   = useState(null); // { fy, q, data }
  const [unfreezeReq, setUnfreezeReq] = useState(null); // { fy, q }
  const [freezeLoading, setFreezeLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api.msmeIRSettings().then(setSettings).catch(() => {});
  }, []);

  const fyOptions = (() => {
    const cur = getCurrentFY();
    const y   = parseInt(cur.split('-')[0], 10);
    return [
      `${y-2}-${String(y - 1).slice(2)}`,
      `${y-1}-${String(y).slice(2)}`,
      cur,
      `${y+1}-${String(y + 2).slice(2)}`,
    ];
  })();

  const quarters = getQuarterConfig(fy);

  const doFreeze = async () => {
    if (!freezeReq) return;
    setFreezeLoading(true);
    try {
      await api.msmeIRFreeze({ fy: freezeReq.fy, quarter: freezeReq.q, frozen_by: user?.name || user?.username, quarter_data: freezeReq.data });
      setFreezeReq(null);
      setRefreshKey(k => k + 1);
    } catch (e) {
      alert('Freeze failed: ' + (e.response?.data?.error || e.message));
    } finally { setFreezeLoading(false); }
  };

  const doUnfreeze = async (reason) => {
    if (!unfreezeReq) return;
    setFreezeLoading(true);
    try {
      await api.msmeIRUnfreeze({ fy: unfreezeReq.fy, quarter: unfreezeReq.q, reason, unfrozen_by: user?.name || user?.username });
      setUnfreezeReq(null);
      setRefreshKey(k => k + 1);
    } catch (e) {
      alert('Unfreeze failed: ' + (e.response?.data?.error || e.message));
    } finally { setFreezeLoading(false); }
  };

  return (
    <div style={{ marginTop: '1.5rem', fontFamily: "'Figtree','Inter',-apple-system,sans-serif" }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, overflow: 'hidden', marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '1.1rem 1.5rem', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ color: '#18191B', fontSize: '1.05rem', fontWeight: 700, margin: 0 }}>MSME Interest Report</h2>
            <p style={{ color: '#5D6C7B', fontSize: '0.78rem', margin: '3px 0 0' }}>
              Quarterly MSME interest liability & ITR disallowance under the MSMED Act — 3× Bank Rate ({settings ? ((settings.bank_rate * settings.multiplier * 100).toFixed(1) + '%') : '16.5%'})
            </p>
            <DataFreshness entities={['bills_open', 'bills_overdue', 'vendor_msme_master']} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: '#5D6C7B' }}>
              <span>FY:</span>
              <select value={fy} onChange={e => { setFy(e.target.value); setRefreshKey(k => k + 1); }}
                style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 5, color: '#18191B', fontSize: '0.8rem', padding: '0.3rem 0.5rem' }}>
                {fyOptions.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            {isAdmin && (
              <button onClick={() => setSettingsOpen(o => !o)} style={{ ...S.iconBtn, ...(settingsOpen ? { background: 'rgba(59,130,246,0.15)', borderColor: 'rgba(59,130,246,0.4)', color: '#93c5fd' } : {}) }}>
                <Settings size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Methodology note */}
        <div style={{ padding: '0 1.5rem 0.85rem', fontSize: '0.73rem', color: '#9BA8B0' }}>
          <Info size={11} style={{ display: 'inline', marginRight: 4 }} />
          Interest = Balance Due × Rate × MIN(Days, 365) / 365. Rate: {settings ? (settings.simple_rate * 100).toFixed(2) : '16.5'}% (≤365 interest days) / {settings ? (settings.effective_rate * 100).toFixed(4) : '17.8068'}% (>365 days, compound). Applicable: Manufacturing &amp; Services (Micro + Small only). Not applicable: Trading or Medium enterprise. Credit period: {settings?.credit_period_agreement || 45} days (written agreement) / {settings?.credit_period_no_agreement || 15} days (none).
        </div>
      </div>

      {/* Rate settings (admin) */}
      {isAdmin && settingsOpen && settings && (
        <RateSettingsPanel settings={settings} onSave={() => api.msmeIRSettings().then(setSettings).catch(() => {})} />
      )}

      {/* Quarter panels */}
      {quarters.map(qConfig => (
        <QuarterPanel
          key={`${fy}-${qConfig.id}-${refreshKey}`}
          fy={fy}
          qConfig={qConfig}
          user={user}
          isAdmin={isAdmin}
          onFreezeRequest={(fy, q, data) => setFreezeReq({ fy, q, data })}
          onUnfreezeRequest={(fy, q) => setUnfreezeReq({ fy, q })}
        />
      ))}

      {/* Freeze dialog */}
      {freezeReq && (
        <FreezeDialog
          fy={freezeReq.fy} quarter={freezeReq.q}
          summary={freezeReq.data?.summary}
          onConfirm={doFreeze} onCancel={() => setFreezeReq(null)}
          loading={freezeLoading}
        />
      )}

      {/* Unfreeze dialog */}
      {unfreezeReq && (
        <UnfreezeDialog
          fy={unfreezeReq.fy} quarter={unfreezeReq.q}
          onConfirm={doUnfreeze} onCancel={() => setUnfreezeReq(null)}
          loading={freezeLoading}
        />
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  table:       { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' },
  th:          { padding: '0.45rem 0.9rem', textAlign: 'left', fontSize: '0.67rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9BA8B0', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  td:          { padding: '0.55rem 0.9rem', color: '#18191B', borderBottom: '1px solid #DFE7E3', verticalAlign: 'middle' },
  btn:         { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 6, border: '1px solid #DFE7E3', background: '#EAF4EF', color: '#1C4942', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  iconBtn:     { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px 8px', borderRadius: 6, border: '1px solid #DFE7E3', background: '#EAF4EF', color: '#5D6C7B', cursor: 'pointer' },
  filterInput: { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 5, color: '#18191B', fontSize: '0.78rem', padding: '0.35rem 0.6rem' },
  filterSelect:{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 5, color: '#18191B', fontSize: '0.78rem', padding: '0.35rem 0.5rem' },
};
