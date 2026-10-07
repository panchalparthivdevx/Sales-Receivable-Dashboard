import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../utils/api';
import { formatINR } from '../utils/format';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function MsmeBadge({ type }) {
  const colors = { Micro: '#06b6d4', Small: '#3b82f6', Medium: '#8b5cf6' };
  const c = colors[type] || '#6366f1';
  return (
    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700, background: `${c}18`, color: c, border: `1px solid ${c}40`, whiteSpace: 'nowrap' }}>
      {type}
    </span>
  );
}

// ─── Expandable vendor row ─────────────────────────────────────────────────────
function VendorRow({ vendor, mode }) {
  const [open, setOpen] = useState(false);
  const red = mode === 'overdue';

  return (
    <>
      <tr style={{ background: red ? 'rgba(239,68,68,0.04)' : 'rgba(245,158,11,0.04)', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <td style={S.td}>
          <span style={{ color: '#5D6C7B', fontSize: '0.7rem', marginRight: 6 }}>{open ? '▼' : '▶'}</span>
          <span style={{ fontWeight: 600, color: '#18191B' }}>{vendor.vendor_name}</span>
        </td>
        <td style={S.td}><MsmeBadge type={vendor.msme_type} /></td>
        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.78rem', color: '#5D6C7B' }}>
          {vendor.udyam_number || '—'}
        </td>
        <td style={{ ...S.td, fontSize: '0.8rem', color: '#9BA8B0' }}>{vendor.category}</td>
        <td style={{ ...S.td, fontSize: '0.8rem', color: '#5D6C7B' }}>{vendor.sub_category}</td>
        <td style={{ ...S.td, textAlign: 'center' }}>
          <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.83rem', color: red ? '#ef4444' : '#f59e0b' }}>
            {vendor.max_days}d
          </span>
          {red
            ? <span style={{ ...S.chip, background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', marginLeft: 5 }}>+{vendor.max_days - 45}d overdue</span>
            : <span style={{ ...S.chip, background: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)', marginLeft: 5 }}>{45 - vendor.max_days}d left</span>
          }
        </td>
        <td style={{ ...S.td, textAlign: 'center', fontSize: '0.8rem', color: '#5D6C7B' }}>{vendor.bills.length}</td>
        <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, fontSize: '0.9rem', color: red ? '#fca5a5' : '#fcd34d' }}>
          {formatINR(vendor.total_pending)}
        </td>
      </tr>

      {open && vendor.bills.map((bill, bi) => (
        <tr key={bill.bill_id || bi} style={{ background: red ? 'rgba(239,68,68,0.02)' : 'rgba(245,158,11,0.02)' }}>
          <td style={{ ...S.td, paddingLeft: '2.5rem', color: '#93c5fd', fontFamily: 'monospace', fontSize: '0.8rem' }}>
            ↳ {bill.bill_number || 'N/A'}
          </td>
          <td style={{ ...S.td, fontSize: '0.78rem', color: '#5D6C7B' }} colSpan={2}>
            <span style={{ fontFamily: 'monospace' }}>{bill.date}</span>
            {bill.due_date && <span style={{ color: '#9BA8B0', marginLeft: 10 }}>Due: {bill.due_date}</span>}
          </td>
          <td style={{ ...S.td, fontSize: '0.78rem', color: '#9BA8B0' }}>{bill.category}</td>
          <td style={{ ...S.td, fontSize: '0.78rem', color: '#9BA8B0' }}>{bill.sub_category}</td>
          <td style={{ ...S.td, textAlign: 'center' }}>
            <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: red ? '#ef4444' : '#f59e0b', fontWeight: 600 }}>
              {bill.days_since}d
            </span>
            {red && bill.days_overdue > 0 && (
              <span style={{ ...S.chip, background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)', marginLeft: 5 }}>+{bill.days_overdue}d</span>
            )}
            {!red && (
              <span style={{ ...S.chip, background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.25)', marginLeft: 5 }}>{bill.days_until_45}d left</span>
            )}
          </td>
          <td style={{ ...S.td, textAlign: 'center', fontFamily: 'monospace', fontSize: '0.78rem', color: '#5D6C7B' }}>{bill.status}</td>
          <td style={{ ...S.td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, fontSize: '0.83rem', color: '#18191B' }}>
            {formatINR(bill.balance)}
          </td>
        </tr>
      ))}
    </>
  );
}

// ─── MSME Vendors tab ─────────────────────────────────────────────────────────
function VendorList({ vendors }) {
  return (
    <div style={{ padding: '1rem 1.5rem' }}>
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{ color: '#18191B', fontWeight: 600, fontSize: '0.9rem' }}>MSME Vendors (from current open/overdue bills)</div>
        <div style={{ color: '#5D6C7B', fontSize: '0.78rem', marginTop: 2 }}>
          {vendors.length} vendor{vendors.length !== 1 ? 's' : ''} with MSME registration found in open/overdue bills.
        </div>
      </div>

      <div style={{ background: '#EAF4EF', border: '1px solid #A7C4BC', borderRadius: 6, padding: '0.5rem 0.8rem', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.77rem', color: '#1C4942' }}>
        <ExternalLink size={12} style={{ flexShrink: 0 }} />
        <span>To update MSME details: Zoho Books → Vendor Profile → set MSME Type + Udyam No. → save. Then refresh the report.</span>
      </div>

      {vendors.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#9BA8B0', padding: '1.5rem', fontSize: '0.82rem', border: '1px dashed #DFE7E3', borderRadius: 7 }}>
          No MSME-registered vendors found in current open/overdue bills.
        </div>
      ) : (
        <div style={{ border: '1px solid #DFE7E3', borderRadius: 8, overflow: 'hidden' }}>
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>#</th>
              <th style={S.th}>Vendor Name</th>
              <th style={S.th}>MSME Type</th>
              <th style={S.th}>Udyam Registration No.</th>
            </tr></thead>
            <tbody>
              {vendors.map((v, i) => (
                <tr key={v.vendor_id} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.02)' }}>
                  <td style={{ ...S.td, color: '#9BA8B0', fontSize: '0.75rem', width: 36 }}>{i + 1}</td>
                  <td style={{ ...S.td, fontWeight: 600, color: '#18191B' }}>{v.vendor_name}</td>
                  <td style={S.td}><MsmeBadge type={v.msme_type} /></td>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.78rem', color: v.udyam_number ? '#9BA8B0' : '#9BA8B0' }}>
                    {v.udyam_number || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function MSMEReport() {
  const [tab,     setTab]     = useState('report');
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [openSec, setOpenSec] = useState({ priority: false, overdue: false });

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api.purMSMEReport()
      .then(d => setData(d))
      .catch(e => setError(e.response?.data?.error || e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const overdue         = data?.overdue_vendors   || [];
  const dueSoon         = data?.due_soon_vendors  || [];
  const totalMSME       = data?.total_msme        || 0;
  const msmeVendors     = data?.msme_vendors      || [];
  const totalOverdueAmt = data?.total_overdue_amount  || 0;
  const totalDueSoonAmt = data?.total_due_soon_amount || 0;

  const TABLE_HDR = (
    <thead><tr>
      <th style={S.th}>Vendor Name</th>
      <th style={S.th}>MSME Type</th>
      <th style={S.th}>Udyam No.</th>
      <th style={S.th}>Category</th>
      <th style={S.th}>Sub-Category</th>
      <th style={{ ...S.th, textAlign: 'center' }}>Age / Status</th>
      <th style={{ ...S.th, textAlign: 'center' }}>Bills</th>
      <th style={{ ...S.th, textAlign: 'right' }}>Pending (₹)</th>
    </tr></thead>
  );

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <div style={S.card}>

        {/* Header */}
        <div style={S.hdr}>
          <div>
            <h2 style={{ color: '#18191B', fontSize: '1.05rem', fontWeight: 700, margin: 0 }}>MSME Vendor Payment Report</h2>
            <p style={{ color: '#5D6C7B', fontSize: '0.78rem', margin: '3px 0 0' }}>MSMED Act: Payment to MSME vendors must be made within 45 days of invoice date</p>
          </div>

          {!loading && !error && data && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {[
                { label: 'MSME Vendors (in bills)', val: totalMSME,                  color: '#6366f1' },
                { label: 'Overdue (45d+)',           val: overdue.length,              color: '#ef4444', vc: '#fca5a5' },
                { label: 'Due ≤ 7 Days',             val: dueSoon.length,              color: '#f59e0b', vc: '#fcd34d' },
                { label: 'Overdue Amount',            val: formatINR(totalOverdueAmt), color: '#ef4444', vc: '#fca5a5', wide: true },
                { label: 'Due Soon Amount',           val: formatINR(totalDueSoonAmt), color: '#f59e0b', vc: '#fcd34d', wide: true },
              ].map(k => (
                <div key={k.label} style={{ background: `${k.color}10`, border: `1px solid ${k.color}30`, borderRadius: 8, padding: '0.4rem 0.75rem', textAlign: 'center', minWidth: k.wide ? 120 : 70 }}>
                  <div style={{ fontSize: k.wide ? '0.88rem' : '1.1rem', fontWeight: 700, color: k.vc || '#18191B', fontFamily: 'monospace', lineHeight: 1.3 }}>{k.val}</div>
                  <div style={{ fontSize: '0.65rem', color: '#5D6C7B', marginTop: 2, whiteSpace: 'nowrap' }}>{k.label}</div>
                </div>
              ))}
              <button onClick={load} title="Refresh" style={{ ...S.btn, padding: '6px 10px' }}>
                <RefreshCw size={13} />
              </button>
            </div>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '3.5rem 2rem' }}>
            <RefreshCw size={22} style={{ animation: 'spin 1s linear infinite', color: '#1C4942', display: 'block', margin: '0 auto 14px' }} />
            <div style={{ color: '#18191B', fontWeight: 600, marginBottom: 6 }}>Loading MSME payment data…</div>
            <div style={{ color: '#5D6C7B', fontSize: '0.8rem' }}>Checking vendor profiles for MSME registration. May take 30–60 seconds on first load.</div>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '2.5rem', color: '#fca5a5' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: 8 }}>⚠</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Failed to load</div>
            <div style={{ fontSize: '0.8rem', color: '#5D6C7B', marginBottom: 14 }}>{error}</div>
            <button onClick={load} style={S.btn}>Retry</button>
          </div>
        )}

        {/* Tabs + Content */}
        {!loading && !error && data && (
          <>
            <div style={{ display: 'flex', borderBottom: '1px solid #DFE7E3' }}>
              {[{ id: 'report', label: '📊 Payment Report' }, { id: 'vendors', label: '🏭 MSME Vendors' }].map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  padding: '0.65rem 1.25rem', border: 'none', cursor: 'pointer',
                  background: tab === t.id ? '#EAF4EF' : 'transparent',
                  color: tab === t.id ? '#1C4942' : '#5D6C7B',
                  fontWeight: tab === t.id ? 700 : 400, fontSize: '0.82rem',
                  borderBottom: tab === t.id ? '2px solid #1C4942' : '2px solid transparent',
                }}>{t.label}</button>
              ))}
            </div>

            {tab === 'vendors' && <VendorList vendors={msmeVendors} />}

            {tab === 'report' && (
              <div>
                {totalMSME === 0 ? (
                  <div style={{ textAlign: 'center', color: '#9BA8B0', padding: '2.5rem', fontSize: '0.85rem' }}>
                    No MSME vendors found in current open/overdue bills.<br />
                    <span style={{ fontSize: '0.78rem', color: '#9BA8B0', display: 'block', marginTop: 6 }}>
                      In Zoho Books: open the vendor → check "MSME Registered?" → set type + Udyam number → save. Then refresh.
                    </span>
                  </div>
                ) : (
                  <>
                    {/* Priority: Due within 7 days */}
                    <div style={{ ...S.section, borderColor: openSec.priority ? 'rgba(245,158,11,0.4)' : 'rgba(245,158,11,0.2)' }}>
                      <div
                        style={{ ...S.sHdr, background: 'rgba(245,158,11,0.07)', borderColor: openSec.priority ? 'rgba(245,158,11,0.2)' : 'transparent', cursor: 'pointer', borderBottomWidth: openSec.priority ? undefined : 0 }}
                        onClick={() => setOpenSec(s => ({ ...s, priority: !s.priority }))}
                      >
                        <span style={{ color: openSec.priority ? '#fcd34d' : '#5D6C7B', flexShrink: 0 }}>
                          {openSec.priority ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </span>
                        <div>
                          <div style={{ color: '#fcd34d', fontWeight: 700, fontSize: '0.9rem' }}>Priority Payments — Due within 7 Days</div>
                          {openSec.priority && <div style={{ color: '#B45309', fontSize: '0.75rem', marginTop: 2 }}>Bills approaching the 45-day MSME Act limit — pay immediately.</div>}
                        </div>
                        <span style={{ marginLeft: 'auto', fontFamily: 'monospace', fontWeight: 700, color: '#fcd34d', fontSize: '0.88rem', flexShrink: 0 }}>
                          {dueSoon.length} vendor{dueSoon.length !== 1 ? 's' : ''} · {formatINR(totalDueSoonAmt)}
                        </span>
                      </div>
                      {openSec.priority && (
                        dueSoon.length === 0
                          ? <div style={{ padding: '1.25rem 1.5rem', color: '#5D6C7B', fontSize: '0.83rem' }}>✓ No MSME bills approaching the 45-day limit in the next 7 days.</div>
                          : <div style={{ overflowX: 'auto' }}><table style={S.table}>{TABLE_HDR}<tbody>
                              {dueSoon.map((v, i) => <VendorRow key={v.vendor_id || i} vendor={v} mode="due-soon" />)}
                            </tbody><tfoot><tr style={{ borderTop: '1px solid rgba(245,158,11,0.2)', background: 'rgba(245,158,11,0.05)' }}>
                              <td colSpan={7} style={{ ...S.td, fontWeight: 700, color: '#B45309', fontSize: '0.78rem' }}>Total ({dueSoon.length} vendor{dueSoon.length !== 1 ? 's' : ''})</td>
                              <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#fcd34d' }}>{formatINR(totalDueSoonAmt)}</td>
                            </tr></tfoot></table></div>
                      )}
                    </div>

                    {/* Overdue: 45+ days */}
                    <div style={{ ...S.section, borderColor: openSec.overdue ? 'rgba(239,68,68,0.4)' : 'rgba(239,68,68,0.2)', marginTop: 0 }}>
                      <div
                        style={{ ...S.sHdr, background: 'rgba(239,68,68,0.07)', borderColor: openSec.overdue ? 'rgba(239,68,68,0.2)' : 'transparent', cursor: 'pointer', borderBottomWidth: openSec.overdue ? undefined : 0 }}
                        onClick={() => setOpenSec(s => ({ ...s, overdue: !s.overdue }))}
                      >
                        <span style={{ color: openSec.overdue ? '#fca5a5' : '#5D6C7B', flexShrink: 0 }}>
                          {openSec.overdue ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </span>
                        <div>
                          <div style={{ color: '#fca5a5', fontWeight: 700, fontSize: '0.9rem' }}>Overdue MSME Payments — 45+ Days Pending</div>
                          {openSec.overdue && <div style={{ color: '#DC2626', fontSize: '0.75rem', marginTop: 2 }}>These payments already violate the MSMED Act. Click any vendor to see bills.</div>}
                        </div>
                        <span style={{ marginLeft: 'auto', fontFamily: 'monospace', fontWeight: 700, color: '#fca5a5', fontSize: '0.88rem', flexShrink: 0 }}>
                          {overdue.length} vendor{overdue.length !== 1 ? 's' : ''} · {formatINR(totalOverdueAmt)}
                        </span>
                      </div>
                      {openSec.overdue && (
                        overdue.length === 0
                          ? <div style={{ padding: '1.25rem 1.5rem', color: '#5D6C7B', fontSize: '0.83rem' }}>✓ No MSME payments overdue beyond 45 days.</div>
                          : <div style={{ overflowX: 'auto' }}><table style={S.table}>{TABLE_HDR}<tbody>
                              {overdue.map((v, i) => <VendorRow key={v.vendor_id || i} vendor={v} mode="overdue" />)}
                            </tbody><tfoot><tr style={{ borderTop: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.06)' }}>
                              <td colSpan={7} style={{ ...S.td, fontWeight: 700, color: '#ef4444', fontSize: '0.78rem' }}>Total ({overdue.length} vendor{overdue.length !== 1 ? 's' : ''})</td>
                              <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#fca5a5' }}>{formatINR(totalOverdueAmt)}</td>
                            </tr></tfoot></table></div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  card:    { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, overflow: 'hidden' },
  hdr:     { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '1.1rem 1.5rem', borderBottom: '1px solid #DFE7E3', gap: 12, flexWrap: 'wrap' },
  section: { border: '1px solid', margin: '1rem 1.5rem', borderRadius: 8, overflow: 'hidden' },
  sHdr:    { display: 'flex', alignItems: 'center', gap: 10, padding: '0.75rem 1rem', borderBottom: '1px solid', flexWrap: 'wrap' },
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' },
  th:      { padding: '0.5rem 1rem', textAlign: 'left', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9BA8B0', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  td:      { padding: '0.6rem 1rem', color: '#18191B', borderBottom: '1px solid #DFE7E3', verticalAlign: 'middle' },
  chip:    { display: 'inline-block', padding: '1px 5px', borderRadius: 4, fontSize: '0.67rem', fontWeight: 600 },
  btn:     { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 6, border: '1px solid #DFE7E3', background: '#EAF4EF', color: '#1C4942', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
};
