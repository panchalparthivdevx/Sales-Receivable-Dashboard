import React, { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle2, Clock, X, FileSpreadsheet, GitBranch } from 'lucide-react';
import * as XLSX from 'xlsx';
import { api } from '../utils/api';
import { formatINR, formatDate } from '../utils/format';
import EscrowMappingModal from './EscrowMappingModal';

const INR = (v) =>
  v == null ? '—'
  : (v < 0 ? '-' : '') + '₹' + Math.abs(Math.round(v)).toLocaleString('en-IN');

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function DueStatus({ dueDay }) {
  const today = new Date().getDate();
  const diff  = dueDay - today;
  if (diff < 0)   return <span style={{ color: '#ef4444', fontSize: '0.72rem', display: 'block' }}>Overdue</span>;
  if (diff === 0)  return <span style={{ color: '#f59e0b', fontSize: '0.72rem', display: 'block' }}>Due Today</span>;
  if (diff <= 4)   return <span style={{ color: '#f59e0b', fontSize: '0.72rem', display: 'block' }}>{diff}d left</span>;
  return null;
}

function BalanceChip({ balance, emi }) {
  if (balance == null) return null;
  if (balance >= emi) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'rgba(34,197,94,0.1)', color: '#22c55e', borderRadius: 4, padding: '1px 6px', fontSize: '0.72rem', fontWeight: 600 }}>
      <CheckCircle2 size={10} /> Surplus
    </span>
  );
  if (balance > 0) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'rgba(245,158,11,0.1)', color: '#f59e0b', borderRadius: 4, padding: '1px 6px', fontSize: '0.72rem', fontWeight: 600 }}>
      <Clock size={10} /> Partial
    </span>
  );
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'rgba(239,68,68,0.1)', color: '#ef4444', borderRadius: 4, padding: '1px 6px', fontSize: '0.72rem', fontWeight: 600 }}>
      <AlertTriangle size={10} /> Deficit
    </span>
  );
}

// ── Inline detail modal ────────────────────────────────────────────────────────
function DetailModal({ title, onClose, loading, error, children, onExcel }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
         onClick={onClose}>
      <div style={{ background: '#FFFFFF', borderRadius: 12, width: '100%', maxWidth: 1100, maxHeight: '88vh', display: 'flex', flexDirection: 'column', border: '1px solid #DFE7E3', boxShadow: '0 20px 60px rgba(0,18,20,0.2)' }}
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.5rem', borderBottom: '1px solid #DFE7E3', flexShrink: 0 }}>
          <h3 style={{ margin: 0, color: '#18191B', fontSize: '1rem', fontWeight: 700 }}>{title}</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {onExcel && !loading && !error && (
              <button onClick={onExcel} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#F0FDF4', border: '1px solid #BBF7D0', color: '#15803D', padding: '0.3rem 0.7rem', borderRadius: 6, fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600 }}>
                <FileSpreadsheet size={13} /> Excel
              </button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#9BA8B0', cursor: 'pointer', padding: 4 }}><X size={20} /></button>
          </div>
        </div>
        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '0 1.5rem 1rem' }}>
          {loading && <p style={{ color: '#5D6C7B', textAlign: 'center', padding: '2rem' }}>Loading…</p>}
          {error   && <p style={{ color: '#DC2626', textAlign: 'center', padding: '2rem' }}>{error}</p>}
          {!loading && !error && children}
        </div>
      </div>
    </div>
  );
}

const thS = { padding: '0.55rem 0.75rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#F9F9F9', zIndex: 1 };
const tdS = { padding: '0.5rem 0.75rem', borderBottom: '1px solid #F2F2F2', fontSize: '0.83rem', color: '#18191B' };
const tdR = { ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

function statusBadge(s) {
  const colors = { paid: '#22c55e', sent: '#3b82f6', overdue: '#ef4444', draft: '#94a3b8', 'partially paid': '#f59e0b' };
  const c = colors[(s || '').toLowerCase()] || '#94a3b8';
  return <span style={{ background: c + '22', color: c, borderRadius: 20, padding: '1px 8px', fontSize: '0.75rem', fontWeight: 500, textTransform: 'capitalize' }}>{s}</span>;
}

// ── Receivables detail table ───────────────────────────────────────────────────
function ReceivablesTable({ data }) {
  if (!data?.invoices?.length) return <p style={{ color: '#5D6C7B', padding: '1.5rem 0', textAlign: 'center' }}>No open invoices found for this ESCROW account this month.</p>;
  const { invoices, total } = data;
  return (
    <>
      <div style={{ padding: '0.75rem 0', color: '#5D6C7B', fontSize: '0.82rem' }}>
        {invoices.length} open invoice{invoices.length !== 1 ? 's' : ''} · Total outstanding: <strong style={{ color: '#fb923c' }}>{INR(total)}</strong>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={thS}>Invoice #</th>
            <th style={thS}>Customer</th>
            <th style={thS}>Branch</th>
            <th style={{ ...thS, textAlign: 'right' }}>Invoice Date</th>
            <th style={{ ...thS, textAlign: 'right' }}>Due Date</th>
            <th style={{ ...thS, textAlign: 'right' }}>Invoice Total</th>
            <th style={{ ...thS, textAlign: 'right' }}>Balance Due</th>
            <th style={{ ...thS, textAlign: 'center' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(15,23,42,0.3)' }}>
              <td style={tdS}>{inv.invoice_number}</td>
              <td style={tdS}>{inv.customer_name}</td>
              <td style={tdS}>{inv.branch_name}</td>
              <td style={{ ...tdR }}>{inv.invoice_date || '—'}</td>
              <td style={{ ...tdR, color: inv.due_date && inv.due_date < new Date().toISOString().slice(0,10) ? '#ef4444' : '#e2e8f0' }}>{inv.due_date || '—'}</td>
              <td style={tdR}>{INR(inv.total)}</td>
              <td style={{ ...tdR, color: '#fb923c', fontWeight: 600 }}>{INR(inv.balance)}</td>
              <td style={{ ...tdS, textAlign: 'center' }}>{statusBadge(inv.status)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ background: '#F2F2F2', borderTop: '2px solid #DFE7E3' }}>
            <td colSpan={6} style={{ ...tdS, fontWeight: 700, color: '#18191B' }}>Total Outstanding</td>
            <td style={{ ...tdR, fontWeight: 700, color: '#fb923c', fontSize: '0.9rem' }}>{INR(total)}</td>
            <td style={tdS} />
          </tr>
        </tfoot>
      </table>
    </>
  );
}

// ── Fund transactions detail table ────────────────────────────────────────────
function FundTable({ data }) {
  if (!data?.transactions) return null;
  const { transactions, accountName, balance, fromDate, toDate } = data;
  if (!transactions.length) return (
    <p style={{ color: '#64748b', padding: '1.5rem 0', textAlign: 'center' }}>No transactions found for {fromDate} – {toDate}.</p>
  );
  return (
    <>
      <div style={{ padding: '0.75rem 0', color: '#5D6C7B', fontSize: '0.82rem' }}>
        {accountName} · {transactions.length} transaction{transactions.length !== 1 ? 's' : ''} from {fromDate} to {toDate} · Current balance: <strong style={{ color: '#e2e8f0' }}>{INR(balance)}</strong>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={thS}>Date</th>
            <th style={thS}>Description / Ref</th>
            <th style={{ ...thS, textAlign: 'center' }}>Type</th>
            <th style={{ ...thS, textAlign: 'right' }}>Credit (In)</th>
            <th style={{ ...thS, textAlign: 'right' }}>Debit (Out)</th>
            <th style={{ ...thS, textAlign: 'right' }}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((t, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(15,23,42,0.3)' }}>
              <td style={tdS}>{t.date || '—'}</td>
              <td style={tdS}>{t.description}</td>
              <td style={{ ...tdS, textAlign: 'center' }}>
                <span style={{ background: t.type === 'credit' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: t.type === 'credit' ? '#22c55e' : '#ef4444', borderRadius: 20, padding: '1px 8px', fontSize: '0.73rem', fontWeight: 500, textTransform: 'capitalize' }}>{t.type}</span>
              </td>
              <td style={{ ...tdR, color: '#22c55e' }}>{t.credit ? INR(t.credit) : '—'}</td>
              <td style={{ ...tdR, color: '#ef4444' }}>{t.debit ? INR(t.debit) : '—'}</td>
              <td style={tdR}>{t.running_balance != null ? INR(t.running_balance) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function EscrowCollectionReport() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);

  // Modal state
  const [modal, setModal] = useState(null); // { type: 'receivables'|'fund', acctNo, label, data, loading, error }
  const [showMapping, setShowMapping] = useState(false);

  async function load() {
    setLoading(true); setError(false);
    try { setData(await api.escrowReport()); }
    catch { setError(true); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function openReceivables(row) {
    setModal({ type: 'receivables', acctNo: row.acctNo, label: row.accountName, data: null, loading: true, error: null });
    try {
      const d = await api.escrowReceivablesDetail(row.acctNo);
      setModal(m => ({ ...m, data: d, loading: false }));
    } catch (e) {
      setModal(m => ({ ...m, loading: false, error: 'Failed to load receivables detail.' }));
    }
  }

  async function openFund(row) {
    setModal({ type: 'fund', acctNo: row.acctNo, label: row.accountName, data: null, loading: true, error: null });
    try {
      const d = await api.escrowFundDetail(row.acctNo);
      setModal(m => ({ ...m, data: d, loading: false }));
    } catch (e) {
      setModal(m => ({ ...m, loading: false, error: 'Failed to load bank transactions.' }));
    }
  }

  function exportModal() {
    if (!modal?.data) return;
    let rows = [], headers = [];
    if (modal.type === 'receivables') {
      headers = ['Invoice #', 'Customer', 'Branch', 'Invoice Date', 'Due Date', 'Total', 'Balance', 'Status'];
      rows = (modal.data.invoices || []).map(i => [i.invoice_number, i.customer_name, i.branch_name, i.invoice_date, i.due_date, i.total, i.balance, i.status]);
    } else {
      headers = ['Date', 'Description', 'Type', 'Credit', 'Debit', 'Balance'];
      rows = (modal.data.transactions || []).map(t => [t.date, t.description, t.type, t.credit || 0, t.debit || 0, t.running_balance]);
    }
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    XLSX.writeFile(wb, `${modal.label}_${modal.type}.xlsx`);
  }

  const thBase = {
    padding: '0.6rem 0.9rem', color: '#64748b', fontWeight: 600,
    fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em',
    background: '#0f172a', borderBottom: '1px solid #334155', whiteSpace: 'nowrap',
  };
  const tdBase = { padding: '0.85rem 0.9rem', borderBottom: '1px solid #1e293b', fontSize: '0.84rem', color: '#e2e8f0' };
  const tdNum  = { ...tdBase, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  const clickStyle = { cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: 'rgba(255,255,255,0.2)', textUnderlineOffset: 3 };

  const monthStr = (() => {
    const ml = data?.monthLabel;
    if (!ml) return '';
    const [y, m] = ml.split('-');
    return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
  })();

  return (
    <>
      <div style={{ background: '#1e293b', borderRadius: 12, border: '1px solid #334155', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '1.25rem 1.5rem', borderBottom: '1px solid #334155', gap: '1rem' }}>
          <div>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '1rem', fontWeight: 700 }}>
              ESCROW Collection Report
              {monthStr && <span style={{ marginLeft: 10, fontSize: '0.78rem', fontWeight: 400, color: '#64748b' }}>— {monthStr}</span>}
            </h3>
            <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '0.8rem' }}>
              Live bank balances from Zoho Books · Receivables from current-month invoices · Click any figure for detail
              {loading && <span style={{ color: '#3b82f6', marginLeft: 8 }}>Loading…</span>}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button onClick={() => setShowMapping(true)} style={{ display: 'flex', alignItems: 'center', background: '#0f2040', border: '1px solid #3b82f6', color: '#60a5fa', padding: '0.45rem 0.9rem', borderRadius: 7, cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, gap: 5 }}>
              <GitBranch size={14} /> Map Clients
            </button>
            <button onClick={load} disabled={loading} style={{ display: 'flex', alignItems: 'center', background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', padding: '0.45rem 0.9rem', borderRadius: 7, cursor: loading ? 'not-allowed' : 'pointer', fontSize: '0.82rem', gap: 4 }}>
              <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {error && (
          <div style={{ padding: '1.5rem', color: '#f87171', fontSize: '0.85rem', textAlign: 'center' }}>
            <AlertTriangle size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Failed to load ESCROW data. Check server logs.
          </div>
        )}

        {/* Table */}
        {!error && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
              <thead>
                <tr>
                  <th style={{ ...thBase, textAlign: 'left', minWidth: 240 }}>Bank Account Name</th>
                  <th style={{ ...thBase, textAlign: 'right', minWidth: 150 }}>
                    Receivables
                    <div style={{ fontSize: '0.65rem', fontWeight: 400, color: '#475569', textTransform: 'none', letterSpacing: 0 }}>click to view invoices</div>
                  </th>
                  <th style={{ ...thBase, textAlign: 'right', minWidth: 160 }}>
                    Available Fund /<br />Amount Rec'd.
                    <div style={{ fontSize: '0.65rem', fontWeight: 400, color: '#475569', textTransform: 'none', letterSpacing: 0 }}>click for transactions</div>
                  </th>
                  <th style={{ ...thBase, textAlign: 'right', minWidth: 140 }}>EMI Amount</th>
                  <th style={{ ...thBase, textAlign: 'center', minWidth: 130 }}>EMI Due Date</th>
                  <th style={{ ...thBase, textAlign: 'right', minWidth: 175 }}>Balance Fund<br />(Available − EMI)</th>
                </tr>
              </thead>
              <tbody>
                {loading && !data && (
                  <tr><td colSpan={6} style={{ ...tdBase, textAlign: 'center', color: '#64748b', padding: '2rem' }}>Fetching data from Zoho Books…</td></tr>
                )}

                {data?.rows?.map((row, i) => {
                  const surplus = row.availableFund != null && row.availableFund > row.emi ? row.availableFund - row.emi : 0;
                  return (
                    <tr key={row.acctNo} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(15,23,42,0.3)' }}>

                      {/* Account name */}
                      <td style={tdBase}>
                        <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{row.accountName}</div>
                        <div style={{ fontSize: '0.72rem', color: '#475569', marginTop: 2 }}>{row.label} · #{row.acctNo}</div>
                      </td>

                      {/* Receivables — clickable */}
                      <td style={tdNum}>
                        {row.receivables > 0
                          ? <span style={{ ...clickStyle, color: '#fb923c' }} onClick={() => openReceivables(row)} title="Click to see invoice breakdown">{INR(row.receivables)}</span>
                          : <span style={{ color: '#475569' }}>—</span>
                        }
                      </td>

                      {/* Available Fund — clickable */}
                      <td style={tdNum}>
                        {row.availableFund == null
                          ? <span style={{ color: '#475569' }}>Not linked</span>
                          : <span style={{ ...clickStyle, color: '#e2e8f0' }} onClick={() => openFund(row)} title="Click to see bank transactions">{INR(row.availableFund)}</span>
                        }
                      </td>

                      {/* EMI */}
                      <td style={{ ...tdNum, color: '#f87171' }}>
                        {row.emi === 0 ? <span style={{ color: '#475569' }}>—</span> : INR(row.emi)}
                      </td>

                      {/* Due date */}
                      <td style={{ ...tdBase, textAlign: 'center' }}>
                        {row.dueDay === 0
                          ? <span style={{ color: '#475569' }}>—</span>
                          : <>
                              <div style={{ color: '#94a3b8' }}>
                                {row.dueDay}{[1,21,31].includes(row.dueDay)?'st':[2,22].includes(row.dueDay)?'nd':[3,23].includes(row.dueDay)?'rd':'th'} of Every Month
                              </div>
                              <DueStatus dueDay={row.dueDay} />
                            </>
                        }
                      </td>

                      {/* Balance Fund */}
                      <td style={tdNum}>
                        {row.emi === 0
                          ? <span style={{ color: '#475569' }}>—</span>
                          : <>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                                <span style={{ color: row.balanceFund == null ? '#475569' : row.balanceFund >= 0 ? '#22c55e' : '#ef4444' }}>
                                  {row.balanceFund == null ? '—' : INR(row.balanceFund)}
                                </span>
                                <BalanceChip balance={row.balanceFund} emi={row.emi} />
                              </div>
                              {surplus > 0 && (
                                <div style={{ fontSize: '0.7rem', color: '#22c55e', textAlign: 'right', marginTop: 2 }}>
                                  ↑ {INR(surplus)} transferable to DevX
                                </div>
                              )}
                            </>
                        }
                      </td>
                    </tr>
                  );
                })}

                {/* ICICI DevX row */}
                {data && (
                  <tr style={{ background: 'rgba(59,130,246,0.05)', borderTop: '2px solid #334155' }}>
                    <td style={{ ...tdBase, fontWeight: 600, color: '#94a3b8' }}>
                      {data.iciciName}
                      <div style={{ fontSize: '0.72rem', color: '#475569', fontWeight: 400 }}>DevX Operating Account · Transfer destination</div>
                    </td>
                    <td style={tdNum}>—</td>
                    <td style={{ ...tdNum, color: data.iciciBalance != null && data.iciciBalance < 0 ? '#ef4444' : '#60a5fa', fontWeight: 600 }}>
                      {data.iciciBalance != null ? INR(data.iciciBalance) : '—'}
                    </td>
                    <td style={tdNum}>—</td>
                    <td style={tdBase} />
                    <td style={tdNum}>—</td>
                  </tr>
                )}

                {/* Totals */}
                {data && (
                  <tr style={{ background: '#0f172a', borderTop: '2px solid #334155' }}>
                    <td style={{ ...tdBase, fontWeight: 700, color: '#f1f5f9' }}>Total</td>
                    <td style={{ ...tdNum, fontWeight: 700, color: '#fb923c' }}>
                      {data.totalReceivables > 0 ? INR(data.totalReceivables) : '—'}
                    </td>
                    <td style={{ ...tdNum, fontWeight: 700 }}>{INR(data.totalAvailable)}</td>
                    <td style={{ ...tdNum, fontWeight: 700, color: '#f87171' }}>{INR(data.totalEmi)}</td>
                    <td style={tdBase} />
                    <td style={{ ...tdNum, fontWeight: 700, color: data.totalBalance >= 0 ? '#22c55e' : '#ef4444' }}>
                      {INR(data.totalBalance)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer note */}
        <div style={{ padding: '0.75rem 1.5rem', borderTop: '1px solid #1e293b', fontSize: '0.72rem', color: '#475569' }}>
          ¹ Available Fund = current bank balance from Zoho Books &nbsp;·&nbsp;
          ² Receivables = open invoice balances for clients in this ESCROW account (current month) &nbsp;·&nbsp;
          ³ Balance Fund = Available Fund − EMI Amount &nbsp;·&nbsp;
          Surplus can be transferred to DevX ICICI current account before EMI due date
        </div>
      </div>

      {/* Mapping Modal */}
      {showMapping && (
        <EscrowMappingModal
          onClose={() => setShowMapping(false)}
          onSaved={() => { setShowMapping(false); load(); }}
        />
      )}

      {/* Detail Modal */}
      {modal && (
        <DetailModal
          title={modal.type === 'receivables'
            ? `Receivables — ${modal.label}`
            : `Bank Transactions — ${modal.label}`}
          onClose={() => setModal(null)}
          loading={modal.loading}
          error={modal.error}
          onExcel={modal.data ? exportModal : null}
        >
          {modal.type === 'receivables'
            ? <ReceivablesTable data={modal.data} />
            : <FundTable data={modal.data} />
          }
        </DetailModal>
      )}
    </>
  );
}
