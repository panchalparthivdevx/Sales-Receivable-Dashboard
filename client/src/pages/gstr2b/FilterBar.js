import React, { useEffect, useState } from 'react';
import { S, STATUS_ORDER, Field } from './ui';
import { g } from './gApi';

// The scope shared by every screen: company, recipient GSTIN, branch, vendor, project, period, document, status, flags, owner.
// "Saved filters" are a per-browser convenience (localStorage).
const SAVED_KEY = 'g2b_saved_filters';
const loadSaved = () => { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '{}'); } catch (_) { return {}; } };
const storeSaved = v => { try { localStorage.setItem(SAVED_KEY, JSON.stringify(v)); } catch (_) { /* private window: skip */ } };

function Multi({ label, options, value, onChange, width = 230 }) {
  const sel = value ? value.split(',').filter(Boolean) : [];
  return (
    <details style={{ position: 'relative' }}>
      <summary style={{ ...S.select, cursor: 'pointer', listStyle: 'none', minWidth: width, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sel.length ? `${label}: ${sel.length} selected` : `All ${label.toLowerCase()}`}</span><span>▾</span>
      </summary>
      <div style={{ position: 'absolute', zIndex: 30, background: '#fff', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.4rem 0.6rem', minWidth: width, maxHeight: 280, overflowY: 'auto', boxShadow: '0 6px 18px rgba(0,18,20,0.14)' }}>
        {options.map(o => (
          <label key={o.value} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.78rem', padding: '3px 0', cursor: 'pointer' }}>
            <input type="checkbox" checked={sel.includes(o.value)} onChange={e => onChange((e.target.checked ? [...sel, o.value] : sel.filter(x => x !== o.value)).join(','))} />{o.label}
          </label>
        ))}
        {sel.length > 0 && <button style={{ ...S.ghost, marginTop: 4, padding: '0.15rem 0.5rem' }} onClick={() => onChange('')}>Clear</button>}
      </div>
    </details>
  );
}

export default function FilterBar({ meta, filters, setFilters, locked = [], showStatus = true }) {
  const [opts, setOpts] = useState({ vendors: [], branches: [], projects: [], fys: [], months: [] });
  const [saved, setSaved] = useState(loadSaved);
  const [more, setMore] = useState(false);
  const set = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const regs = meta.companies.filter(c => !filters.company || filters.company === 'all' || c.id === filters.company).flatMap(c => c.registrations.map(r => ({ value: r.gstin, label: `${r.gstin} · ${r.label || c.short}` })));
  useEffect(() => { g.options({ company: filters.company || 'all', gstin: filters.gstin }).then(setOpts).catch(() => {}); }, [filters.company, filters.gstin, meta.companies.length]);
  const dis = k => locked.includes(k);
  const active = Object.entries(filters).filter(([k, v]) => v && !['company', 'basis'].includes(k)).length;

  return (
    <div style={{ ...S.card, padding: '0.75rem 1rem' }}>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Company"><select style={S.select} value={filters.company || 'all'} onChange={e => setFilters(f => ({ ...f, company: e.target.value, gstin: '' }))}>
          <option value="all">All companies (consolidated)</option>{meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}{c.demo ? ' — DEMO' : ''}</option>)}</select></Field>
        <Field label="Recipient GSTIN"><Multi label="GSTINs" options={regs} value={filters.gstin || ''} onChange={v => set('gstin', v)} width={290} /></Field>
        <Field label="Financial year"><select style={S.select} value={filters.fy || ''} onChange={e => set('fy', e.target.value)}><option value="">All</option>{opts.fys.map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Quarter"><select style={S.select} value={filters.quarter || ''} onChange={e => set('quarter', e.target.value)}><option value="">All</option>{['Q1', 'Q2', 'Q3', 'Q4'].map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Half"><select style={S.select} value={filters.half || ''} onChange={e => set('half', e.target.value)}><option value="">All</option><option>H1</option><option>H2</option></select></Field>
        <Field label="Month"><select style={S.select} value={filters.month || ''} onChange={e => set('month', e.target.value)}><option value="">All</option>{opts.months.map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Custom period"><span style={{ display: 'flex', gap: 4 }}><input type="month" style={{ ...S.input, width: 130 }} value={filters.from || ''} onChange={e => set('from', e.target.value)} /><input type="month" style={{ ...S.input, width: 130 }} value={filters.to || ''} onChange={e => set('to', e.target.value)} /></span></Field>
        <Field label="Period basis"><select style={S.select} value={filters.basis || meta.settings.period_basis} onChange={e => set('basis', e.target.value)}>{Object.entries(meta.period_bases).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <button style={S.ghost} onClick={() => setMore(m => !m)}>{more ? 'Fewer filters' : 'More filters'}{active ? ` (${active})` : ''}</button>
      </div>
      {more && (
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10, paddingTop: 10, borderTop: '1px solid #F0F2F1' }}>
          <Field label="Branch"><select style={S.select} value={filters.branch || ''} onChange={e => set('branch', e.target.value)}><option value="">All branches</option><option value="__unallocated__">Unallocated branch (GSTR-2B only)</option>{opts.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label="Vendor (name or GSTIN)"><input list="g2b-vendors" style={{ ...S.input, width: 210 }} value={filters.vendor || ''} onChange={e => set('vendor', e.target.value)} placeholder="Type to search" />
            <datalist id="g2b-vendors">{opts.vendors.slice(0, 400).map(v => <option key={v.key} value={v.key.startsWith('name:') ? v.name : v.key}>{v.name}</option>)}</datalist></Field>
          <Field label="Project"><select style={S.select} value={filters.project || ''} onChange={e => set('project', e.target.value)}><option value="">All projects</option>{opts.projects.map(p => <option key={p}>{p}</option>)}</select></Field>
          <Field label="Document type"><select style={S.select} value={filters.doc_type || ''} onChange={e => set('doc_type', e.target.value)}><option value="">All</option><option value="INV">Invoice</option><option value="CRN">Credit note</option><option value="DBN">Debit note</option></select></Field>
          {showStatus && !dis('status') && <Field label="Reconciliation status"><Multi label="statuses" options={STATUS_ORDER.map(s => ({ value: s, label: meta.statuses[s] }))} value={filters.status || ''} onChange={v => set('status', v)} /></Field>}
          <Field label="Flag"><select style={S.select} value={filters.flag || ''} onChange={e => set('flag', e.target.value)}><option value="">Any</option>{Object.entries(meta.flags).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="ITC status" hint="Phase 2"><select style={S.select} disabled><option>—</option></select></Field>
          <Field label="Owner"><input list="g2b-owners" style={{ ...S.input, width: 140 }} value={filters.owner || ''} onChange={e => set('owner', e.target.value)} /><datalist id="g2b-owners">{(meta.admin_users || []).map(u => <option key={u.id} value={u.name} />)}</datalist></Field>
          <Field label="Workflow"><select style={S.select} value={filters.workflow || ''} onChange={e => set('workflow', e.target.value)}><option value="">Any</option><option value="__none__">Not started</option>{Object.entries(meta.workflow).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Search"><input style={{ ...S.input, width: 200 }} value={filters.q || ''} onChange={e => set('q', e.target.value)} placeholder="Document no., supplier, GSTIN, branch" /></Field>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={S.ghost} onClick={() => setFilters(f => ({ company: f.company || 'all' }))}>Clear filters</button>
        <select style={{ ...S.select, maxWidth: 200 }} value="" onChange={e => { if (e.target.value) setFilters({ company: 'all', ...saved[e.target.value] }); }}>
          <option value="">Saved filters…</option>{Object.keys(saved).map(k => <option key={k} value={k}>{k}</option>)}</select>
        <button style={S.ghost} onClick={() => { const name = window.prompt('Name this set of filters'); if (!name) return; const n = { ...saved, [name]: filters }; setSaved(n); storeSaved(n); }}>Save these filters</button>
        {Object.keys(saved).length > 0 && <button style={S.ghost} onClick={() => { const name = window.prompt(`Delete which saved filter?\n${Object.keys(saved).join(', ')}`); if (name && saved[name]) { const n = { ...saved }; delete n[name]; setSaved(n); storeSaved(n); } }}>Delete a saved filter</button>}
        <span style={S.small}>Saved filters stay in this browser.</span>
      </div>
    </div>
  );
}
