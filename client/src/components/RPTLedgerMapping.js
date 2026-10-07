import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { X, Plus, Pencil, Trash2, Search, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';

// ─── RPT Ledger Mapping popup + transaction drill-down ────────────────────────
// Mappings are saved permanently on the server (not per FY). Each Zoho customer / vendor /
// ledger can belong to one related party; a party can have any number of them.
// Ledger mappings are keyed on the Zoho Account ID from the Chart of Accounts.

const SOURCES = [
  { key: 'sales',    label: 'Sales',    pick: 'Zoho Customer' },
  { key: 'purchase', label: 'Purchase', pick: 'Zoho Vendor' },
  { key: 'loan',     label: 'Loan',     pick: 'Chart of Accounts ledger' },
];
const SOURCE_LABEL = Object.fromEntries(SOURCES.map(s => [s.key, s.label]));

// Fallback until the server list arrives (server is the source of truth)
const DEFAULT_NATURES = [
  { key: 'loan_given', label: 'Loan Given', normal: 'debit' },
  { key: 'loan_received', label: 'Loan Received', normal: 'credit' },
  { key: 'advance_given', label: 'Advance Given', normal: 'debit' },
  { key: 'advance_received', label: 'Advance Received', normal: 'credit' },
  { key: 'repayment_received', label: 'Repayment Received', normal: 'credit' },
  { key: 'repayment_made', label: 'Repayment Made', normal: 'debit' },
  { key: 'interest_income', label: 'Interest Income', normal: 'credit' },
  { key: 'interest_expense', label: 'Interest Expense', normal: 'debit' },
  { key: 'deposit_given', label: 'Deposit Given', normal: 'debit' },
  { key: 'deposit_received', label: 'Deposit Received', normal: 'credit' },
  { key: 'investment', label: 'Investment', normal: 'debit' },
  { key: 'other_rpt', label: 'Other RPT', normal: null },
];

// Chart of Accounts groups for the ledger filter
const ACCOUNT_GROUPS = [
  { key: 'all',       label: 'All Accounts' },
  { key: 'asset',     label: 'Assets' },
  { key: 'liability', label: 'Liabilities' },
  { key: 'income',    label: 'Income' },
  { key: 'expense',   label: 'Expense' },
  { key: 'equity',    label: 'Equity' },
];
function accountGroup(type) {
  const t = String(type || '');
  if (t === 'equity') return 'equity';
  if (/income/.test(t)) return 'income';
  if (/expense|cost_of_goods/.test(t)) return 'expense';
  if (/liability|payable|credit_card|output_tax/.test(t)) return 'liability';
  if (/asset|bank|cash|receivable|stock|input_tax|payment_clearing/.test(t)) return 'asset';
  return 'other';
}
// Default Nature when a ledger is picked (user can change it)
function suggestNature(o) {
  const n = String(o?.name || '').toLowerCase(), g = accountGroup(o?.type);
  if (/interest/.test(n)) return g === 'income' ? 'interest_income' : g === 'expense' ? 'interest_expense' : 'other_rpt';
  if (/deposit/.test(n)) return g === 'liability' ? 'deposit_received' : 'deposit_given';
  if (/advance/.test(n)) return g === 'liability' ? 'advance_received' : 'advance_given';
  if (/loan|icd|borrow/.test(n)) return g === 'liability' ? 'loan_received' : 'loan_given';
  if (/investment|capital a\/?c|current a\/?c/.test(n) && g === 'asset') return 'investment';
  return g === 'asset' ? 'loan_given' : g === 'liability' ? 'loan_received' : 'other_rpt';
}
// Nature grows on debit but the account is credit-natured (or vice versa) → worth a second look
function natureMismatch(natures, natureKey, accountType) {
  const n = natures.find(x => x.key === natureKey);
  const g = accountGroup(accountType);
  if (!n?.normal || !accountType) return null;
  if (n.normal === 'debit' && ['liability', 'income', 'equity'].includes(g)) return `${n.label} on a ${g} account — check Nature`;
  if (n.normal === 'credit' && ['asset', 'expense'].includes(g)) return `${n.label} on an ${g} account — check Nature`;
  return null;
}
function typeLabel(o) {
  return o?.typeLabel || String(o?.type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
// "Code | Name — Type" for ledgers, plain name for customers / vendors
function optionLabel(o, isLedger) {
  if (!isLedger) return o.name;
  return `${o.code ? `${o.code} | ` : ''}${o.name}${o.type ? ` — ${typeLabel(o)}` : ''}`;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function errText(e) {
  return e?.response?.data?.error || e?.message || 'Request failed';
}

// Searchable single/multi picker over Zoho customers / vendors / Chart of Accounts
function ZohoPicker({ options, loading, selected, onChange, multi, takenBy, placeholder, ledger }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState('all');
  const sel = new Set(selected.map(o => o.id));
  const { list, matched } = useMemo(() => {
    const s = q.trim().toLowerCase();
    const f = options.filter(o => {
      if (ledger && group !== 'all' && accountGroup(o.type) !== group) return false;
      if (!s) return true;
      return [o.name, o.code, ledger ? typeLabel(o) : '', o.parent, o.info].some(v => String(v || '').toLowerCase().includes(s));
    });
    return { list: f.slice(0, 250), matched: f.length };
  }, [options, q, group, ledger]);

  const toggle = (o) => {
    if (!multi) { onChange([o]); setOpen(false); setQ(''); return; }
    onChange(sel.has(o.id) ? selected.filter(x => x.id !== o.id) : [...selected, o]);
  };

  return (
    <div style={{ position: 'relative', minWidth: 300 }}>
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
          {selected.map(o => (
            <span key={o.id} style={M.chip}>
              {optionLabel(o, ledger)}
              <X size={11} style={{ cursor: 'pointer' }} onClick={() => onChange(selected.filter(x => x.id !== o.id))} />
            </span>
          ))}
        </div>
      )}
      <div style={M.searchBox}>
        <Search size={13} color="#9BA8B0" />
        <input
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={loading ? 'Loading Zoho list…' : placeholder}
          style={M.searchInput}
        />
      </div>
      {open && (
        <div style={M.dropdown}>
          {ledger && (
            <div style={M.ddFilters} onMouseDown={e => e.preventDefault()}>
              {ACCOUNT_GROUPS.map(g => (
                <button key={g.key} onClick={() => setGroup(g.key)} style={{ ...M.ddFilter, ...(group === g.key ? M.ddFilterOn : {}) }}>{g.label}</button>
              ))}
            </div>
          )}
          {list.length === 0 && <div style={M.ddEmpty}>{loading ? 'Loading…' : options.length ? 'No match' : 'List not loaded from Zoho — use Reload Zoho lists'}</div>}
          {list.map(o => {
            const owner = takenBy(o.id);
            return (
              <div
                key={o.id}
                onMouseDown={e => { e.preventDefault(); if (!owner) toggle(o); }}
                style={{ ...M.ddItem, ...(owner ? M.ddItemDisabled : {}), ...(sel.has(o.id) ? M.ddItemSel : {}) }}
                title={owner ? `Already mapped to ${owner}` : ''}
              >
                {multi && <input type="checkbox" readOnly checked={sel.has(o.id)} disabled={!!owner} style={{ marginRight: 6 }} />}
                <span style={{ flex: 1 }}>
                  {ledger && o.code && <span style={{ color: '#5D6C7B' }}>{o.code} | </span>}
                  {o.name}
                  {ledger && o.type && <span style={{ color: '#5D6C7B' }}> — {typeLabel(o)}</span>}
                  {ledger && o.active === false && <span style={{ color: '#B45309', fontSize: '0.68rem' }}> (inactive)</span>}
                  {o.info && <span style={{ color: '#9BA8B0', fontSize: '0.7rem' }}> · {o.info}</span>}
                </span>
                {owner && <span style={{ color: '#9BA8B0', fontSize: '0.68rem' }}>→ {owner}</span>}
              </div>
            );
          })}
          {matched > list.length && <div style={M.ddEmpty}>Showing {list.length} of {matched.toLocaleString('en-IN')} — type to narrow…</div>}
        </div>
      )}
    </div>
  );
}

export function LedgerMappingModal({ parties, onClose, onChanged }) {
  const [mappings, setMappings] = useState([]);
  const [natures,  setNatures]  = useState(DEFAULT_NATURES);
  const [options,  setOptions]  = useState({ sales: [], purchase: [], loan: [] });
  const [optLoad,  setOptLoad]  = useState({ sales: true, purchase: true, loan: true });
  const [optErr,   setOptErr]   = useState({});
  const [unmapped, setUnmapped] = useState(null);
  const [unmapErr, setUnmapErr] = useState(null);
  const [partyFilter, setPartyFilter] = useState('');
  const [adding,   setAdding]   = useState(null);   // { source, party, nature, natureTouched, picks: [] }
  const [editing,  setEditing]  = useState(null);   // { id, source, party, nature, picks: [one] }
  const [unmapSel, setUnmapSel] = useState({});     // key → { party, nature }
  const [busy,     setBusy]     = useState(false);
  const [msg,      setMsg]      = useState(null);   // { type: 'ok'|'err', text }

  const loadMappings = useCallback(() => api.rptMapping().then(d => {
    setMappings(d.mappings || []);
    if (d.natures?.length) setNatures(d.natures);
  }), []);
  const loadUnmapped = useCallback(() => {
    setUnmapped(null); setUnmapErr(null);
    return api.rptMappingUnmapped()
      .then(d => setUnmapped(d.items || []))
      .catch(e => { setUnmapped([]); setUnmapErr(errText(e)); });
  }, []);
  const loadOptions = useCallback((refresh = false) => {
    SOURCES.forEach(({ key }) => {
      setOptLoad(l => ({ ...l, [key]: true }));
      api.rptMappingOptions(key, refresh)
        .then(d => { setOptions(o => ({ ...o, [key]: d.items || [] })); setOptErr(e => ({ ...e, [key]: d.error || null })); })
        .catch(e => setOptErr(er => ({ ...er, [key]: errText(e) })))
        .finally(() => setOptLoad(l => ({ ...l, [key]: false })));
    });
  }, []);

  useEffect(() => {
    loadMappings().catch(e => setMsg({ type: 'err', text: errText(e) }));
    loadOptions();
    loadUnmapped();
  }, [loadMappings, loadOptions, loadUnmapped]);

  const takenIndex = useMemo(() => {
    const m = {};
    mappings.forEach(x => { m[`${x.source}|${x.zohoId}`] = x; });
    return m;
  }, [mappings]);
  const optIndex = useMemo(() => {
    const idx = {};
    for (const s of Object.keys(options)) idx[s] = new Map(options[s].map(o => [o.id, o]));
    return idx;
  }, [options]);
  const takenBy = (source, exceptId) => (zohoId) => {
    const x = takenIndex[`${source}|${zohoId}`];
    return x && x.id !== exceptId ? x.party : null;
  };
  const optById = (source, id) => optIndex[source]?.get(id);
  const natureLabel = (m) => m.source === 'loan'
    ? (natures.find(n => n.key === m.nature)?.label || m.nature)
    : SOURCE_LABEL[m.source];

  // Status is saved as 'mapped'; the Zoho list shows whether the account/contact still exists
  const statusOf = (m) => {
    const o = optById(m.source, m.zohoId);
    if (!o) return optLoad[m.source] || !options[m.source].length ? { text: 'Mapped', tone: 'ok' } : { text: 'Not found in Zoho', tone: 'warn' };
    if (o.active === false) return { text: 'Mapped · inactive in Zoho', tone: 'warn' };
    return { text: 'Mapped', tone: 'ok' };
  };

  const close = onClose;

  const afterSave = async (text) => {
    setMsg({ type: 'ok', text });
    await Promise.all([loadMappings(), loadUnmapped()]);
    onChanged();
  };

  const save = async (rows, text) => {
    setBusy(true); setMsg(null);
    try {
      await api.rptMappingSave(rows);
      await afterSave(text);
      return true;
    } catch (e) {
      setMsg({ type: 'err', text: errText(e) });
      return false;
    } finally { setBusy(false); }
  };

  const rowFor = (source, o, party, nature, id) => ({
    ...(id ? { id } : {}), source, zohoId: o.id, zohoName: o.name, party,
    ...(source === 'loan' ? { nature, accountType: o.type || null, accountCode: o.code || '' } : {}),
  });

  const saveAdd = async () => {
    if (!adding.picks.length) return setMsg({ type: 'err', text: 'Select at least one Zoho name / ledger' });
    if (!adding.party) return setMsg({ type: 'err', text: 'Select the dashboard related party' });
    const rows = adding.picks.map(o => rowFor(adding.source, o, adding.party, adding.nature));
    if (await save(rows, `Saved ${rows.length} mapping${rows.length > 1 ? 's' : ''} → ${adding.party}`)) setAdding(null);
  };

  const saveEdit = async () => {
    const o = editing.picks[0];
    if (!o || !editing.party) return setMsg({ type: 'err', text: 'Select both the Zoho name / ledger and the related party' });
    if (await save([rowFor(editing.source, o, editing.party, editing.nature, editing.id)], 'Mapping updated')) setEditing(null);
  };

  const remove = async (m) => {
    if (!window.confirm(`Delete this mapping?\n\n${SOURCE_LABEL[m.source]}: ${m.zohoName}\n→ ${m.party}\n\nIts transactions will no longer be counted for this party.`)) return;
    setBusy(true); setMsg(null);
    try {
      await api.rptMappingDelete(m.id);
      await afterSave('Mapping deleted');
    } catch (e) { setMsg({ type: 'err', text: errText(e) }); }
    finally { setBusy(false); }
  };

  const mapUnmapped = async (u) => {
    const key = `${u.source}|${u.zohoId}`;
    const s = unmapSel[key] || {};
    const party = s.party ?? u.suggestedParty;
    if (!party) return setMsg({ type: 'err', text: 'Select an RPT party' });
    const o = optById(u.source, u.zohoId) || { id: u.zohoId, name: u.zohoName, type: u.accountType, code: u.accountCode };
    await save([rowFor(u.source, o, party, s.nature || u.nature)], `Mapped ${u.zohoName} → ${party}`);
  };

  const ignoreUnmapped = async (u) => {
    setBusy(true);
    try {
      await api.rptMappingIgnore({ source: u.source, zohoId: u.zohoId, zohoName: u.zohoName });
      setUnmapped(list => (list || []).filter(x => !(x.source === u.source && x.zohoId === u.zohoId)));
    } catch (e) { setMsg({ type: 'err', text: errText(e) }); }
    finally { setBusy(false); }
  };

  const reloadLists = () => { loadOptions(true); loadUnmapped(); };

  const shown = mappings
    .filter(m => !partyFilter || m.party === partyFilter)
    .sort((a, b) => a.party.localeCompare(b.party) || a.source.localeCompare(b.source) || a.zohoName.localeCompare(b.zohoName));
  const shownUnmapped = (unmapped || []).filter(u => !partyFilter || (unmapSel[`${u.source}|${u.zohoId}`]?.party ?? u.suggestedParty) === partyFilter);

  const partySelect = (value, onChange, extra = {}) => (
    <select value={value || ''} onChange={e => onChange(e.target.value)} style={{ ...M.select, ...extra }}>
      <option value="">Select RPT Party</option>
      {parties.map(p => <option key={p} value={p}>{p}</option>)}
    </select>
  );
  const natureSelect = (value, onChange, accountType) => {
    const warn = natureMismatch(natures, value, accountType);
    return (
      <>
        <select value={value || 'loan_given'} onChange={e => onChange(e.target.value)} style={{ ...M.select, width: 160 }}>
          {natures.map(n => <option key={n.key} value={n.key}>{n.label}</option>)}
        </select>
        {warn && <div style={M.hint}>⚠ {warn}</div>}
      </>
    );
  };
  // Picker for the selected Source Type: customers, vendors, or the Chart of Accounts
  const picker = (state, setState, multi, exceptId) => (
    <ZohoPicker
      multi={multi}
      ledger={state.source === 'loan'}
      options={options[state.source]}
      loading={optLoad[state.source]}
      selected={state.picks}
      onChange={picks => setState(x => {
        const next = { ...x, picks };
        if (x.source === 'loan' && !x.natureTouched && picks.length) next.nature = suggestNature(picks[0]);
        return next;
      })}
      takenBy={takenBy(state.source, exceptId)}
      placeholder={state.source === 'loan'
        ? 'Search Chart of Accounts by name, code or type'
        : `Select ${SOURCES.find(s => s.key === state.source).pick}${multi ? ' (one or more)' : ''}`}
    />
  );
  const sourceSelect = (state, setState) => (
    <select value={state.source} onChange={e => setState(x => ({ ...x, source: e.target.value, picks: [], natureTouched: false }))} style={{ ...M.select, width: 100 }}>
      {SOURCES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
    </select>
  );
  const COLS = 6;

  return (
    <div style={M.overlay} onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div style={M.box}>
        <div style={M.head}>
          <div>
            <div style={M.title}>Ledger Mapping</div>
            <div style={M.sub}>Map Zoho customers, vendors and loan ledgers to related parties. Saved permanently and applied to every F.Y.</div>
          </div>
          <button onClick={close} style={M.iconBtn} title="Close"><X size={18} /></button>
        </div>

        <div style={M.body}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={M.lbl}>Dashboard Related Party</span>
            <select value={partyFilter} onChange={e => setPartyFilter(e.target.value)} style={{ ...M.select, width: 280 }}>
              <option value="">All related parties</option>
              {parties.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <div style={{ flex: 1 }} />
            <button
              style={M.ghostBtn} onClick={reloadLists} disabled={Object.values(optLoad).some(Boolean)}
              title="Refresh the customer, vendor and Chart of Accounts lists from Zoho Books. Saved mappings are not changed."
            >
              <RefreshCw size={12} style={{ marginRight: 4, animation: Object.values(optLoad).some(Boolean) ? 'spin 1s linear infinite' : 'none' }} />
              {Object.values(optLoad).some(Boolean) ? 'Loading Zoho lists…' : 'Reload Zoho lists'}
            </button>
            <button
              style={M.primaryBtn}
              disabled={busy || !!adding}
              onClick={() => { setEditing(null); setAdding({ source: 'sales', party: partyFilter, nature: 'loan_given', natureTouched: false, picks: [] }); }}
            >
              <Plus size={13} style={{ marginRight: 4 }} /> Add Mapping
            </button>
          </div>

          {msg && <div style={msg.type === 'ok' ? M.okMsg : M.errMsg}>{msg.text}</div>}
          {Object.entries(optErr).filter(([, v]) => v).map(([k, v]) => (
            <div key={k} style={M.warnMsg}>{k === 'loan' ? 'Chart of Accounts' : `${SOURCE_LABEL[k]} list`} could not be loaded from Zoho: {v}</div>
          ))}

          <table style={M.table}>
            <thead>
              <tr>
                <th style={{ ...M.th, width: 110 }}>Source Type</th>
                <th style={M.th}>Zoho Name / Ledger</th>
                <th style={{ ...M.th, width: 170 }}>Nature</th>
                <th style={{ ...M.th, width: 250 }}>Dashboard Related Party</th>
                <th style={{ ...M.th, width: 110 }}>Status</th>
                <th style={{ ...M.th, width: 130, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {adding && (
                <tr style={M.editRow}>
                  <td style={M.td}>{sourceSelect(adding, setAdding)}</td>
                  <td style={M.td}>{picker(adding, setAdding, true)}</td>
                  <td style={M.td}>
                    {adding.source === 'loan'
                      ? natureSelect(adding.nature, v => setAdding(a => ({ ...a, nature: v, natureTouched: true })), adding.picks[0]?.type)
                      : <span style={M.muted}>{SOURCE_LABEL[adding.source]}</span>}
                  </td>
                  <td style={M.td}>{partySelect(adding.party, v => setAdding(a => ({ ...a, party: v })))}</td>
                  <td style={{ ...M.td, color: '#9BA8B0' }}>New</td>
                  <td style={{ ...M.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button style={M.primaryBtn} disabled={busy} onClick={saveAdd}>Save Mapping</button>
                    <button style={M.linkBtn} disabled={busy} onClick={() => setAdding(null)}>Cancel</button>
                  </td>
                </tr>
              )}

              {shown.length === 0 && !adding && (
                <tr><td colSpan={COLS} style={{ ...M.td, textAlign: 'center', color: '#5D6C7B', fontStyle: 'italic' }}>No mappings{partyFilter ? ' for this party' : ''} yet</td></tr>
              )}

              {shown.map(m => {
                if (editing?.id === m.id) {
                  return (
                    <tr key={m.id} style={M.editRow}>
                      <td style={M.td}>{sourceSelect(editing, setEditing)}</td>
                      <td style={M.td}>{picker(editing, setEditing, false, editing.id)}</td>
                      <td style={M.td}>
                        {editing.source === 'loan'
                          ? natureSelect(editing.nature, v => setEditing(x => ({ ...x, nature: v, natureTouched: true })), editing.picks[0]?.type)
                          : <span style={M.muted}>{SOURCE_LABEL[editing.source]}</span>}
                      </td>
                      <td style={M.td}>{partySelect(editing.party, v => setEditing(x => ({ ...x, party: v })))}</td>
                      <td style={{ ...M.td, color: '#9BA8B0' }}>Editing</td>
                      <td style={{ ...M.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button style={M.primaryBtn} disabled={busy} onClick={saveEdit}>Save</button>
                        <button style={M.linkBtn} disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
                      </td>
                    </tr>
                  );
                }
                const o = optById(m.source, m.zohoId);
                const current = o || { id: m.zohoId, name: m.zohoName, code: m.accountCode, type: m.accountType };
                const st = statusOf(m);
                return (
                  <tr key={m.id}>
                    <td style={M.td}><span style={M.srcBadge}>{SOURCE_LABEL[m.source]}</span></td>
                    <td style={M.td} title={o && o.name !== m.zohoName ? `Saved as "${m.zohoName}" — renamed in Zoho` : ''}>
                      {optionLabel(current, m.source === 'loan')}
                      {o?.info && <span style={{ color: '#9BA8B0', fontSize: '0.7rem' }}> · {o.info}</span>}
                    </td>
                    <td style={{ ...M.td, color: '#5D6C7B' }}>{natureLabel(m)}</td>
                    <td style={M.td}>{m.party}</td>
                    <td style={M.td}><span style={st.tone === 'ok' ? M.stOk : M.stWarn}>{st.text}</span></td>
                    <td style={{ ...M.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        style={M.iconBtn} title="Edit" disabled={busy}
                        onClick={() => {
                          setAdding(null);
                          setEditing({ id: m.id, source: m.source, party: m.party, nature: m.nature || 'loan_given', natureTouched: true, picks: [current] });
                        }}
                      ><Pencil size={14} /></button>
                      <button style={{ ...M.iconBtn, color: '#DC2626' }} title="Delete" disabled={busy} onClick={() => remove(m)}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div style={{ ...M.lbl, margin: '1.25rem 0 0.4rem', display: 'block' }}>Unmapped Zoho Names / Ledgers</div>
          <div style={{ color: '#9BA8B0', fontSize: '0.72rem', marginBottom: 6 }}>
            Zoho customers, vendors and ledgers whose name resembles a related party but are not mapped yet.
          </div>
          {unmapErr && <div style={M.warnMsg}>Could not check for unmapped items: {unmapErr}</div>}
          <table style={M.table}>
            <thead>
              <tr>
                <th style={{ ...M.th, width: 110 }}>Source</th>
                <th style={M.th}>Zoho Name</th>
                <th style={{ ...M.th, width: 170 }}>Nature</th>
                <th style={{ ...M.th, width: 250 }}>Map To</th>
                <th style={{ ...M.th, width: 130, textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody>
              {unmapped === null && <tr><td colSpan={5} style={{ ...M.td, textAlign: 'center', color: '#5D6C7B' }}>Checking Zoho…</td></tr>}
              {unmapped && !unmapErr && shownUnmapped.length === 0 && (
                <tr><td colSpan={5} style={{ ...M.td, textAlign: 'center', color: '#5D6C7B', fontStyle: 'italic' }}>Nothing unmapped</td></tr>
              )}
              {shownUnmapped.map(u => {
                const key = `${u.source}|${u.zohoId}`;
                const s = unmapSel[key] || {};
                const isLedger = u.source === 'loan';
                return (
                  <tr key={key}>
                    <td style={M.td}><span style={M.srcBadge}>{SOURCE_LABEL[u.source]}</span></td>
                    <td style={M.td}>
                      {optionLabel({ name: u.zohoName, code: u.accountCode, type: u.accountType, typeLabel: u.typeLabel }, isLedger)}
                      {u.info && <span style={{ color: '#9BA8B0', fontSize: '0.7rem' }}> · {u.info}</span>}
                    </td>
                    <td style={M.td}>
                      {isLedger
                        ? natureSelect(s.nature || u.nature, v => setUnmapSel(x => ({ ...x, [key]: { ...s, nature: v } })), u.accountType)
                        : <span style={M.muted}>{SOURCE_LABEL[u.source]}</span>}
                    </td>
                    <td style={M.td}>{partySelect(s.party ?? u.suggestedParty, v => setUnmapSel(x => ({ ...x, [key]: { ...s, party: v } })))}</td>
                    <td style={{ ...M.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button style={M.primaryBtn} disabled={busy} onClick={() => mapUnmapped(u)}>Map</button>
                      <button style={M.linkBtn} disabled={busy} onClick={() => ignoreUnmapped(u)} title="Not a related-party item — hide from this list">Ignore</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function RPTDrillDown({ title, rows, totalLabel, total, onClose }) {
  return (
    <div style={M.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...M.box, maxWidth: 1000 }}>
        <div style={M.head}>
          <div>
            <div style={M.title}>{title}</div>
            <div style={M.sub}>{rows.length} transaction{rows.length !== 1 ? 's' : ''}</div>
          </div>
          <button onClick={onClose} style={M.iconBtn} title="Close"><X size={18} /></button>
        </div>
        <div style={M.body}>
          <table style={M.table}>
            <thead>
              <tr>
                <th style={M.th}>Date</th>
                <th style={M.th}>Zoho Name / Ledger</th>
                <th style={M.th}>RPT Party</th>
                <th style={M.th}>Voucher No.</th>
                <th style={M.th}>Type</th>
                <th style={{ ...M.th, textAlign: 'right' }}>Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} style={{ ...M.td, textAlign: 'center', color: '#5D6C7B', fontStyle: 'italic' }}>No transactions</td></tr>}
              {rows.map((r, i) => (
                <tr key={i} style={i % 2 ? { background: '#F9F9F9' } : undefined}>
                  <td style={{ ...M.td, whiteSpace: 'nowrap' }}>{r.date}</td>
                  <td style={M.td}>{r.zoho_name}</td>
                  <td style={M.td}>{r.party}</td>
                  <td style={{ ...M.td, color: '#1C4942' }}>{r.voucher || '—'}</td>
                  <td style={M.td}>{r.type}</td>
                  <td style={{ ...M.td, textAlign: 'right', color: r.amount < 0 ? '#DC2626' : '#18191B' }}>{fmt(r.amount)}</td>
                </tr>
              ))}
              <tr style={{ background: '#EAF4EF' }}>
                <td colSpan={5} style={{ ...M.td, fontWeight: 700, color: '#5D6C7B' }}>{totalLabel}</td>
                <td style={{ ...M.td, textAlign: 'right', fontWeight: 700 }}>₹{fmt(total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const M = {
  overlay:   { position: 'fixed', inset: 0, background: 'rgba(24,25,27,0.35)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 16px' },
  box:       { background: '#FFFFFF', borderRadius: 10, border: '1px solid #DFE7E3', width: '100%', maxWidth: 1100, maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.15)' },
  head:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3' },
  title:     { fontSize: '1.05rem', fontWeight: 700, color: '#18191B' },
  sub:       { fontSize: '0.75rem', color: '#5D6C7B', marginTop: 2 },
  body:      { padding: '1rem 1.25rem', overflow: 'auto' },
  lbl:       { fontSize: '0.75rem', fontWeight: 600, color: '#5D6C7B', textTransform: 'uppercase', letterSpacing: '0.04em' },
  muted:     { color: '#9BA8B0' },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' },
  th:        { padding: '0.45rem 0.7rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', textAlign: 'left', whiteSpace: 'nowrap' },
  td:        { padding: '0.45rem 0.7rem', borderBottom: '1px solid #DFE7E3', color: '#18191B', verticalAlign: 'top' },
  editRow:   { background: '#F6FAF8' },
  select:    { border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.3rem 0.4rem', fontSize: '0.78rem', color: '#18191B', background: '#FFFFFF', width: '100%' },
  srcBadge:  { fontSize: '0.68rem', padding: '2px 7px', borderRadius: 3, fontWeight: 600, background: '#EAF4EF', color: '#1C4942' },
  chip:      { display: 'inline-flex', alignItems: 'center', gap: 4, background: '#EAF4EF', color: '#1C4942', borderRadius: 4, padding: '2px 6px', fontSize: '0.72rem' },
  searchBox: { display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.25rem 0.5rem', background: '#FFFFFF' },
  searchInput: { border: 'none', outline: 'none', fontSize: '0.78rem', width: '100%', background: 'transparent' },
  dropdown:  { position: 'absolute', zIndex: 10, top: '100%', left: 0, minWidth: '100%', width: 560, maxWidth: '70vw', marginTop: 2, background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, maxHeight: 320, overflowY: 'auto', boxShadow: '0 6px 20px rgba(0,0,0,0.1)' },
  ddItem:    { display: 'flex', alignItems: 'center', gap: 6, padding: '0.35rem 0.6rem', fontSize: '0.78rem', cursor: 'pointer', borderBottom: '1px solid #F3F5F4' },
  ddItemSel: { background: '#EAF4EF' },
  ddItemDisabled: { color: '#9BA8B0', cursor: 'not-allowed' },
  ddEmpty:   { padding: '0.5rem 0.6rem', fontSize: '0.74rem', color: '#9BA8B0' },
  primaryBtn:{ display: 'inline-flex', alignItems: 'center', background: '#1C4942', color: '#FFFFFF', border: '1px solid #1C4942', borderRadius: 6, padding: '0.32rem 0.7rem', fontSize: '0.76rem', cursor: 'pointer', fontWeight: 600 },
  ghostBtn:  { display: 'inline-flex', alignItems: 'center', background: '#FFFFFF', color: '#5D6C7B', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.32rem 0.7rem', fontSize: '0.76rem', cursor: 'pointer' },
  linkBtn:   { background: 'none', border: 'none', color: '#5D6C7B', fontSize: '0.76rem', cursor: 'pointer', marginLeft: 6 },
  iconBtn:   { background: 'none', border: 'none', color: '#5D6C7B', cursor: 'pointer', padding: 4 },
  okMsg:     { background: '#EAF4EF', color: '#15803D', borderRadius: 6, padding: '0.45rem 0.75rem', fontSize: '0.78rem', marginBottom: 8 },
  errMsg:    { background: '#FEF2F2', color: '#DC2626', borderRadius: 6, padding: '0.45rem 0.75rem', fontSize: '0.78rem', marginBottom: 8 },
  warnMsg:   { background: '#FFFBEB', color: '#B45309', borderRadius: 6, padding: '0.45rem 0.75rem', fontSize: '0.76rem', marginBottom: 8 },
  hint:      { color: '#B45309', fontSize: '0.68rem', marginTop: 3 },
  ddFilters: { display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0.4rem 0.5rem', borderBottom: '1px solid #DFE7E3', position: 'sticky', top: 0, background: '#FFFFFF' },
  ddFilter:  { background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', borderRadius: 12, padding: '1px 8px', fontSize: '0.7rem', cursor: 'pointer' },
  ddFilterOn:{ background: '#EAF4EF', border: '1px solid #1C4942', color: '#1C4942' },
  stOk:      { fontSize: '0.7rem', color: '#15803D', fontWeight: 600 },
  stWarn:    { fontSize: '0.7rem', color: '#B45309', fontWeight: 600 },
};
