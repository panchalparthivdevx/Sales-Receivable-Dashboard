import React, { useEffect, useState, useMemo } from 'react';
import { X, Search, Save, RefreshCw, CheckCircle2, ChevronDown, ChevronRight, FileSpreadsheet } from 'lucide-react';
import * as XLSX from 'xlsx';
import { api } from '../utils/api';

export default function EscrowMappingModal({ onClose, onSaved }) {
  const [data,    setData]    = useState(null);   // { branches, escrowAccounts, totalClients, mappedClients }
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);
  const [saved,   setSaved]   = useState(false);

  // local edits: { [customer_id]: acctNo | '' }
  const [edits, setEdits] = useState({});

  // UI state
  const [search,   setSearch]   = useState('');
  const [filterBy, setFilterBy] = useState('all'); // 'all' | 'mapped' | 'unmapped'
  const [expanded, setExpanded] = useState({});    // { [branch_name]: bool }

  async function load() {
    setLoading(true); setError(null); setSaved(false);
    try {
      const d = await api.escrowClientsByBranch();
      setData(d);
      // Pre-populate edits from existing mapping
      const init = {};
      for (const br of d.branches) {
        for (const c of br.clients) {
          init[c.customer_id] = c.escrow_acct || '';
        }
      }
      setEdits(init);
      // Expand first branch by default
      if (d.branches.length) setExpanded({ [d.branches[0].branch_name]: true });
    } catch (e) {
      setError('Failed to load client list. ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      // Only send entries that have a value (or explicit unmap via '')
      await api.escrowSaveMapping(edits);
      setSaved(true);
      if (onSaved) onSaved();
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError('Save failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  function setClientMap(customerId, acctNo) {
    setEdits(prev => ({ ...prev, [customerId]: acctNo }));
  }

  // Count changes
  const changes = useMemo(() => {
    if (!data) return 0;
    let n = 0;
    for (const br of data.branches) {
      for (const c of br.clients) {
        const orig = c.escrow_acct || '';
        const edit = edits[c.customer_id] ?? orig;
        if (edit !== orig) n++;
      }
    }
    return n;
  }, [edits, data]);

  const mappedCount = Object.values(edits).filter(v => v).length;

  // Export current state to Excel
  function exportExcel() {
    if (!data) return;
    const rows = [['Branch', 'Customer Name', 'ESCROW Account']];
    for (const br of data.branches) {
      for (const c of br.clients) {
        const mapped = edits[c.customer_id] || '';
        const label = data.escrowAccounts.find(e => e.acctNo === mapped)?.label || (mapped ? mapped : 'Not mapped');
        rows.push([br.branch_name, c.customer_name, label]);
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 30 }, { wch: 55 }, { wch: 35 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ESCROW Mapping');
    XLSX.writeFile(wb, 'ESCROW_Client_Mapping.xlsx');
  }

  // ── Filtered + searched view ──────────────────────────────────────────────
  const filteredBranches = useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase().trim();
    return data.branches
      .map(br => ({
        ...br,
        clients: br.clients.filter(c => {
          const matchSearch = !q || c.customer_name.toLowerCase().includes(q);
          const isMapped    = !!(edits[c.customer_id]);
          const matchFilter = filterBy === 'all' || (filterBy === 'mapped' && isMapped) || (filterBy === 'unmapped' && !isMapped);
          return matchSearch && matchFilter;
        }),
      }))
      .filter(br => br.clients.length > 0);
  }, [data, search, filterBy, edits]);

  // Toggle branch expansion
  function toggle(br) { setExpanded(p => ({ ...p, [br]: !p[br] })); }

  const acctColor = {
    '002405033164': '#f59e0b',
    '777705888101': '#8b5cf6',
    '777705888102': '#06b6d4',
    '777705888103': '#22c55e',
    '777705888107': '#3b82f6',
    '777705888109': '#f97316',
    'ABFCFG5023819': '#ec4899',
    '0100':          '#14b8a6',
  };

  function acctBadge(acctNo, escrowAccounts) {
    if (!acctNo) return null;
    const label = escrowAccounts.find(e => e.acctNo === acctNo)?.label || acctNo;
    const col   = acctColor[acctNo] || '#94a3b8';
    return (
      <span style={{ background: col + '22', color: col, borderRadius: 20, padding: '1px 8px', fontSize: '0.7rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {label}
      </span>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 2000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '1rem', overflowY: 'auto' }}
         onClick={onClose}>
      <div style={{ background: '#1e293b', borderRadius: 14, width: '100%', maxWidth: 1100, border: '1px solid #334155', marginTop: 20, marginBottom: 20 }}
           onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem 1.5rem', borderBottom: '1px solid #334155' }}>
          <div>
            <h2 style={{ margin: 0, color: '#f1f5f9', fontSize: '1.1rem', fontWeight: 700 }}>ESCROW Account Mapping</h2>
            <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '0.8rem' }}>
              Assign each client to their ESCROW account. Used to compute accurate Receivables in the report.
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 6 }}><X size={20} /></button>
        </div>

        {/* Stats bar */}
        {data && (
          <div style={{ display: 'flex', gap: '1.5rem', padding: '0.85rem 1.5rem', background: '#0f172a', borderBottom: '1px solid #334155', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ color: '#64748b', fontSize: '0.82rem' }}>
              <strong style={{ color: '#f1f5f9' }}>{data.totalClients}</strong> total clients
            </span>
            <span style={{ color: '#64748b', fontSize: '0.82rem' }}>
              <strong style={{ color: '#22c55e' }}>{mappedCount}</strong> mapped
            </span>
            <span style={{ color: '#64748b', fontSize: '0.82rem' }}>
              <strong style={{ color: '#f59e0b' }}>{data.totalClients - mappedCount}</strong> unmapped
            </span>
            {changes > 0 && (
              <span style={{ background: 'rgba(59,130,246,0.15)', color: '#60a5fa', borderRadius: 20, padding: '2px 10px', fontSize: '0.78rem', fontWeight: 600 }}>
                {changes} unsaved change{changes !== 1 ? 's' : ''}
              </span>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button onClick={exportExcel} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#0f2d1f', border: '1px solid #22c55e', color: '#22c55e', padding: '0.3rem 0.75rem', borderRadius: 6, fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600 }}>
                <FileSpreadsheet size={13} /> Export
              </button>
              <button onClick={load} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', padding: '0.3rem 0.75rem', borderRadius: 6, fontSize: '0.78rem', cursor: 'pointer' }}>
                <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} /> Reload
              </button>
              <button
                onClick={save}
                disabled={saving || loading}
                style={{ display: 'flex', alignItems: 'center', gap: 4, background: saved ? '#0f2d1f' : '#1d4ed8', border: `1px solid ${saved ? '#22c55e' : '#3b82f6'}`, color: saved ? '#22c55e' : '#fff', padding: '0.3rem 0.9rem', borderRadius: 6, fontSize: '0.82rem', cursor: 'pointer', fontWeight: 600, minWidth: 100, justifyContent: 'center' }}
              >
                {saved ? <><CheckCircle2 size={13} /> Saved!</> : saving ? <><RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</> : <><Save size={13} /> Save All</>}
              </button>
            </div>
          </div>
        )}

        {/* Filters */}
        <div style={{ display: 'flex', gap: '0.75rem', padding: '0.75rem 1.5rem', borderBottom: '1px solid #1e293b', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1', minWidth: 200 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
            <input
              type="text"
              placeholder="Search client name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '0.4rem 0.75rem 0.4rem 2rem', borderRadius: 7, fontSize: '0.83rem', boxSizing: 'border-box', outline: 'none' }}
            />
          </div>
          {['all', 'mapped', 'unmapped'].map(f => (
            <button key={f} onClick={() => setFilterBy(f)}
              style={{ background: filterBy === f ? '#1d4ed8' : '#0f172a', border: `1px solid ${filterBy === f ? '#3b82f6' : '#334155'}`, color: filterBy === f ? '#fff' : '#94a3b8', padding: '0.35rem 0.85rem', borderRadius: 6, fontSize: '0.78rem', cursor: 'pointer', fontWeight: filterBy === f ? 600 : 400, textTransform: 'capitalize' }}>
              {f === 'all' ? `All (${data?.totalClients || 0})` : f === 'mapped' ? `Mapped (${mappedCount})` : `Unmapped (${(data?.totalClients || 0) - mappedCount})`}
            </button>
          ))}
        </div>

        {/* ESCROW legend */}
        {data && (
          <div style={{ display: 'flex', gap: 8, padding: '0.5rem 1.5rem', borderBottom: '1px solid #1e293b', flexWrap: 'wrap' }}>
            {data.escrowAccounts.map(e => (
              <span key={e.acctNo} style={{ background: (acctColor[e.acctNo] || '#94a3b8') + '22', color: acctColor[e.acctNo] || '#94a3b8', borderRadius: 20, padding: '2px 10px', fontSize: '0.72rem', fontWeight: 600 }}>
                {e.label}
              </span>
            ))}
          </div>
        )}

        {/* Body */}
        <div style={{ maxHeight: '60vh', overflowY: 'auto', padding: '0.5rem 0' }}>
          {loading && <p style={{ color: '#64748b', textAlign: 'center', padding: '3rem' }}>Loading clients from Zoho Books…<br /><span style={{ fontSize: '0.78rem' }}>This may take a moment</span></p>}
          {error   && <p style={{ color: '#f87171', textAlign: 'center', padding: '2rem' }}>{error}</p>}
          {!loading && !error && filteredBranches.length === 0 && (
            <p style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>No clients match your filter.</p>
          )}

          {!loading && !error && filteredBranches.map(br => {
            const isOpen = !!expanded[br.branch_name];
            const branchMapped = br.clients.filter(c => edits[c.customer_id]).length;
            return (
              <div key={br.branch_name} style={{ borderBottom: '1px solid #1e293b' }}>
                {/* Branch header */}
                <div
                  onClick={() => toggle(br.branch_name)}
                  style={{ display: 'flex', alignItems: 'center', padding: '0.7rem 1.5rem', cursor: 'pointer', background: isOpen ? 'rgba(30,41,59,0.6)' : 'transparent', userSelect: 'none' }}
                >
                  {isOpen ? <ChevronDown size={15} style={{ color: '#64748b', marginRight: 8, flexShrink: 0 }} /> : <ChevronRight size={15} style={{ color: '#64748b', marginRight: 8, flexShrink: 0 }} />}
                  <span style={{ color: '#f1f5f9', fontWeight: 600, fontSize: '0.88rem', flex: 1 }}>{br.branch_name}</span>
                  <span style={{ color: '#64748b', fontSize: '0.78rem', marginRight: 12 }}>{br.clients.length} client{br.clients.length !== 1 ? 's' : ''}</span>
                  <span style={{ background: branchMapped === br.clients.length ? 'rgba(34,197,94,0.15)' : branchMapped > 0 ? 'rgba(245,158,11,0.15)' : 'rgba(100,116,139,0.15)', color: branchMapped === br.clients.length ? '#22c55e' : branchMapped > 0 ? '#f59e0b' : '#64748b', borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 600 }}>
                    {branchMapped}/{br.clients.length} mapped
                  </span>
                </div>

                {/* Clients table */}
                {isOpen && (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#0f172a' }}>
                        <th style={{ padding: '0.45rem 1.5rem 0.45rem 2.5rem', color: '#475569', fontWeight: 600, fontSize: '0.72rem', textAlign: 'left', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Client Name</th>
                        <th style={{ padding: '0.45rem 1.5rem', color: '#475569', fontWeight: 600, fontSize: '0.72rem', textAlign: 'left', textTransform: 'uppercase', letterSpacing: '0.04em', minWidth: 240 }}>ESCROW Account</th>
                      </tr>
                    </thead>
                    <tbody>
                      {br.clients.map((c, i) => {
                        const val   = edits[c.customer_id] ?? '';
                        const orig  = c.escrow_acct || '';
                        const dirty = val !== orig;
                        return (
                          <tr key={c.customer_id} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(15,23,42,0.25)' }}>
                            <td style={{ padding: '0.5rem 1.5rem 0.5rem 2.5rem', fontSize: '0.83rem', color: '#cbd5e1', borderBottom: '1px solid #1e293b11' }}>
                              {dirty && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }} />}
                              {c.customer_name}
                            </td>
                            <td style={{ padding: '0.4rem 1.5rem', borderBottom: '1px solid #1e293b11' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <select
                                  value={val}
                                  onChange={e => setClientMap(c.customer_id, e.target.value)}
                                  style={{ background: val ? (acctColor[val] ? acctColor[val] + '18' : '#0f172a') : '#0f172a', border: `1px solid ${dirty ? '#3b82f6' : val ? (acctColor[val] || '#334155') : '#334155'}`, color: val ? (acctColor[val] || '#e2e8f0') : '#64748b', padding: '0.3rem 0.6rem', borderRadius: 6, fontSize: '0.8rem', cursor: 'pointer', minWidth: 200, fontWeight: val ? 600 : 400 }}
                                >
                                  <option value="">— Not mapped —</option>
                                  {data.escrowAccounts.map(e => (
                                    <option key={e.acctNo} value={e.acctNo}>{e.label} (#{e.acctNo})</option>
                                  ))}
                                </select>
                                {val && acctBadge(val, data.escrowAccounts)}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.9rem 1.5rem', borderTop: '1px solid #334155' }}>
          <span style={{ color: '#475569', fontSize: '0.78rem' }}>
            Blue dot = unsaved change · Save All applies to the entire mapping
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ background: '#0f172a', border: '1px solid #334155', color: '#94a3b8', padding: '0.45rem 1rem', borderRadius: 7, cursor: 'pointer', fontSize: '0.83rem' }}>
              Close
            </button>
            <button
              onClick={save}
              disabled={saving || loading}
              style={{ display: 'flex', alignItems: 'center', gap: 4, background: saved ? '#0f2d1f' : '#1d4ed8', border: `1px solid ${saved ? '#22c55e' : '#3b82f6'}`, color: saved ? '#22c55e' : '#fff', padding: '0.45rem 1.25rem', borderRadius: 7, fontSize: '0.83rem', cursor: 'pointer', fontWeight: 600 }}
            >
              {saved ? <><CheckCircle2 size={14} /> Saved!</> : saving ? 'Saving…' : <><Save size={14} /> Save All</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
