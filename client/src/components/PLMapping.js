import React, { useState, useEffect, useRef } from 'react';
import { X, Search, Plus, Save, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../utils/api';

const SECTION_LABELS = {
  revenue:   'Revenue',
  occupancy: 'Occupancy Cost',
  recurring: 'Recurring Expenses',
  opex:      'Operating Expenses',
  other:     'Other Expenses',
  finance:   'Interest & Finance Cost',
};
const SECTION_ORDER = ['revenue', 'occupancy', 'recurring', 'opex', 'other', 'finance'];

export default function PLMapping({ onClose }) {
  const [mapping,    setMapping]    = useState(null);
  const [mapLoading, setMapLoading] = useState(true);
  const [coa,        setCoa]        = useState([]);
  const [coaLoading, setCoaLoading] = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [tab,        setTab]        = useState('heads');  // 'heads' | 'unmapped'
  const [search,     setSearch]     = useState('');       // COA search per head
  const [activeHead, setActiveHead] = useState(null);     // head id with search open
  const [headSearch, setHeadSearch] = useState('');       // text in search box
  const [collapsed,  setCollapsed]  = useState({});
  const [error,      setError]      = useState('');
  const [saveOk,     setSaveOk]     = useState(false);
  const dropRef = useRef(null);

  useEffect(() => {
    setMapLoading(true);
    api.plMapping()
      .then(d => { setMapping(d); setMapLoading(false); })
      .catch(() => { setError('Failed to load mapping'); setMapLoading(false); });
    setCoaLoading(true);
    api.plCoa().then(d => { setCoa(Array.isArray(d) ? d : []); setCoaLoading(false); }).catch(() => { setCoaLoading(false); });
  }, []);

  useEffect(() => {
    if (!activeHead) return;
    const handle = (e) => { if (dropRef.current && !dropRef.current.contains(e.target)) setActiveHead(null); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [activeHead]);

  const allMappedIds = new Set(
    (mapping?.heads || []).flatMap(h => (h.accounts || []).map(a => a.account_id))
  );

  function removeAccount(headId, accountId) {
    setMapping(prev => ({
      ...prev,
      heads: prev.heads.map(h =>
        h.id === headId ? { ...h, accounts: h.accounts.filter(a => a.account_id !== accountId) } : h
      ),
    }));
  }

  function addAccount(headId, acct) {
    if (allMappedIds.has(acct.account_id)) return; // already mapped somewhere
    setMapping(prev => ({
      ...prev,
      heads: prev.heads.map(h =>
        h.id === headId ? { ...h, accounts: [...(h.accounts || []), { account_id: acct.account_id, account_name: acct.account_name, account_type: acct.account_type }] } : h
      ),
    }));
    setActiveHead(null);
    setHeadSearch('');
  }

  async function handleSave() {
    setSaving(true); setError(''); setSaveOk(false);
    try {
      await api.plSaveMapping(mapping);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  }

  const grouped = {};
  for (const head of (mapping?.heads || [])) {
    if (!grouped[head.section]) grouped[head.section] = [];
    grouped[head.section].push(head);
  }

  const filteredCoa = (Array.isArray(coa) ? coa : []).filter(a =>
    !allMappedIds.has(a.account_id) &&
    (a.account_name?.toLowerCase().includes(headSearch.toLowerCase()) ||
     (a.account_code || '').toLowerCase().includes(headSearch.toLowerCase()))
  );

  return (
    <div style={S.overlay}>
      <div style={S.modal}>
        {/* Header */}
        <div style={S.header}>
          <div>
            <div style={S.title}>P&amp;L Account Mapping</div>
            <div style={S.subtitle}>Assign Zoho COA accounts to each P&amp;L line item</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {saveOk && <span style={{ color: '#22c55e', fontSize: '0.8rem', fontWeight: 600 }}>Saved ✓</span>}
            <button onClick={handleSave} disabled={saving} style={S.saveBtn}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={onClose} style={S.closeBtn}><X size={18} /></button>
          </div>
        </div>

        {error && (
          <div style={S.errBar}><AlertCircle size={14} />{error}</div>
        )}

        {/* Tabs */}
        <div style={S.tabs}>
          {[['heads','P&L Heads'], ['info','How to use']].map(([id, lbl]) => (
            <button key={id} onClick={() => setTab(id)} style={{ ...S.tab, ...(tab === id ? S.tabActive : {}) }}>{lbl}</button>
          ))}
        </div>

        <div style={S.body}>
          {tab === 'info' && (
            <div style={{ color: '#475569', fontSize: '0.85rem', lineHeight: 1.7, maxWidth: 540 }}>
              <p><strong>Step 1:</strong> For each P&L line (e.g. "Office Rent"), click <em>+ Add Account</em> and search for the matching Zoho Chart of Accounts entry.</p>
              <p><strong>Step 2:</strong> One Zoho account can only be mapped to one P&L line. Duplicate assignments are blocked.</p>
              <p><strong>Step 3:</strong> Click <em>Save</em> when done. Changes apply to all future P&L reports immediately.</p>
              <p><strong>Revenue From Operations:</strong> Map your Zoho sales/income accounts to it like any other line. Until at least one account is mapped, it is computed from synced invoices minus applied credit notes. Other Income is mapped the same way.</p>
              <p><strong>Unmapped accounts:</strong> Bills charged to accounts not in any P&L line will appear in the "Unmapped" panel at the bottom of the P&L table.</p>
            </div>
          )}

          {tab === 'heads' && mapLoading && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '3rem 0', color: '#64748b' }}>
              <div style={{ width: 24, height: 24, border: '3px solid #e2e8f0', borderTopColor: '#1e3a5f', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              <span style={{ fontSize: '0.85rem' }}>Loading P&amp;L heads…</span>
            </div>
          )}

          {tab === 'heads' && !mapLoading && !(mapping?.heads?.length) && !error && (
            <div style={{ padding: '2.5rem 1rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>
              No P&amp;L heads found. Please reload the page and try again.
            </div>
          )}

          {tab === 'heads' && !mapLoading && (mapping?.heads?.length > 0) && SECTION_ORDER.map(sec => {
            const heads = grouped[sec] || [];
            if (!heads.length) return null;
            const isCollapsed = collapsed[sec];
            return (
              <div key={sec} style={S.section}>
                <button style={S.sectionHeader} onClick={() => setCollapsed(p => ({ ...p, [sec]: !p[sec] }))}>
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span style={S.sectionLabel}>{SECTION_LABELS[sec]}</span>
                  <span style={S.sectionCount}>{heads.reduce((s, h) => s + (h.accounts?.length || 0), 0)} accounts</span>
                </button>
                {!isCollapsed && heads.map(head => (
                  <div key={head.id} style={S.headRow}>
                    <div style={S.headName}>
                      {head.label}
                      {head.id === 'revenue' && !(head.accounts || []).length && <span style={S.autoBadge}>auto</span>}
                    </div>
                    <div style={S.accountChips}>
                      {head.id === 'revenue' && !(head.accounts || []).length && (
                        <span style={S.autoNote}>Computed from synced invoices − credit notes until an account is mapped</span>
                      )}
                        <>
                          {(head.accounts || []).map(a => (
                            <span key={a.account_id} style={S.chip}>
                              {a.account_name}
                              <button style={S.chipX} onClick={() => removeAccount(head.id, a.account_id)} title="Remove"><X size={10} /></button>
                            </span>
                          ))}
                          <div style={{ position: 'relative' }} ref={activeHead === head.id ? dropRef : null}>
                            <button
                              style={S.addBtn}
                              onClick={() => { setActiveHead(activeHead === head.id ? null : head.id); setHeadSearch(''); }}
                              disabled={coaLoading}
                            >
                              <Plus size={12} /> Add Account
                            </button>
                            {activeHead === head.id && (
                              <div style={S.drop}>
                                <div style={S.dropSearch}>
                                  <Search size={12} style={{ color: '#94a3b8', flexShrink: 0 }} />
                                  <input
                                    autoFocus
                                    placeholder="Search account…"
                                    value={headSearch}
                                    onChange={e => setHeadSearch(e.target.value)}
                                    style={S.dropInput}
                                  />
                                </div>
                                <div style={S.dropList}>
                                  {filteredCoa.length === 0 && (
                                    <div style={S.dropEmpty}>{headSearch ? 'No match' : 'All accounts already mapped'}</div>
                                  )}
                                  {filteredCoa.slice(0, 60).map(a => (
                                    <button key={a.account_id} style={S.dropItem} onClick={() => addAccount(head.id, a)}>
                                      <span style={S.dropItemName}>{a.account_name}</span>
                                      <span style={S.dropItemType}>{a.account_type}</span>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

const S = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 2000,
  },
  modal: {
    background: '#fff', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
    width: '90vw', maxWidth: 780, maxHeight: '88vh', display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid #e2e8f0',
    background: '#f8fafc',
  },
  title: { fontSize: '1.05rem', fontWeight: 700, color: '#0f172a' },
  subtitle: { fontSize: '0.78rem', color: '#64748b', marginTop: 3 },
  saveBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: 7,
    padding: '0.45rem 1rem', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer',
  },
  closeBtn: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: 4, borderRadius: 4 },
  errBar: {
    display: 'flex', gap: 8, alignItems: 'center',
    background: '#fef2f2', color: '#dc2626', fontSize: '0.8rem',
    padding: '0.6rem 1.5rem', borderBottom: '1px solid #fee2e2',
  },
  tabs: { display: 'flex', borderBottom: '1px solid #e2e8f0', padding: '0 1.5rem', background: '#f8fafc' },
  tab: { padding: '0.65rem 1rem', fontSize: '0.82rem', fontWeight: 500, color: '#64748b', background: 'none', border: 'none', borderBottom: '2px solid transparent', cursor: 'pointer' },
  tabActive: { color: '#1e3a5f', borderBottomColor: '#1e3a5f', fontWeight: 700 },
  body: { flex: 1, overflowY: 'auto', padding: '1rem 1.5rem 1.5rem', minHeight: 220 },
  section: { marginBottom: '0.75rem', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' },
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: '0.6rem 0.9rem',
    background: '#f1f5f9', border: 'none', cursor: 'pointer', textAlign: 'left',
  },
  sectionLabel: { flex: 1, fontSize: '0.82rem', fontWeight: 700, color: '#1e293b' },
  sectionCount: { fontSize: '0.74rem', color: '#94a3b8', background: '#e2e8f0', borderRadius: 999, padding: '1px 7px' },
  headRow: {
    display: 'flex', alignItems: 'flex-start', gap: 12,
    padding: '0.65rem 0.9rem', borderTop: '1px solid #f1f5f9',
    minHeight: 44,
  },
  headName: { width: 210, flexShrink: 0, fontSize: '0.82rem', color: '#334155', fontWeight: 500, paddingTop: 5 },
  accountChips: { flex: 1, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  autoBadge: { marginLeft: 6, fontSize: '0.65rem', background: '#dbeafe', color: '#1d4ed8', borderRadius: 999, padding: '1px 7px', fontWeight: 600, verticalAlign: 'middle' },
  autoNote: { fontSize: '0.75rem', color: '#94a3b8', fontStyle: 'italic' },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0',
    borderRadius: 999, padding: '2px 8px 2px 10px', fontSize: '0.75rem', fontWeight: 500,
  },
  chipX: { background: 'none', border: 'none', cursor: 'pointer', color: '#4ade80', padding: 0, display: 'flex', alignItems: 'center', lineHeight: 1 },
  addBtn: {
    display: 'flex', alignItems: 'center', gap: 4,
    background: '#f0f9ff', color: '#0284c7', border: '1px dashed #bae6fd',
    borderRadius: 999, padding: '3px 10px', fontSize: '0.74rem', cursor: 'pointer',
  },
  drop: {
    position: 'absolute', top: '110%', left: 0, zIndex: 100,
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.12)', width: 320, maxHeight: 280, display: 'flex', flexDirection: 'column',
  },
  dropSearch: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '0.55rem 0.75rem', borderBottom: '1px solid #f1f5f9',
  },
  dropInput: { flex: 1, border: 'none', outline: 'none', fontSize: '0.8rem', color: '#1e293b', background: 'transparent' },
  dropList: { overflowY: 'auto', maxHeight: 210 },
  dropEmpty: { padding: '0.9rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem' },
  dropItem: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    width: '100%', padding: '0.5rem 0.75rem', background: 'none', border: 'none',
    cursor: 'pointer', textAlign: 'left', gap: 8,
    '&:hover': { background: '#f8fafc' },
  },
  dropItemName: { fontSize: '0.8rem', color: '#1e293b', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dropItemType: { fontSize: '0.7rem', color: '#94a3b8', flexShrink: 0 },
};
