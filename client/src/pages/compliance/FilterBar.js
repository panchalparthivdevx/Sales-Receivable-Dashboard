import React, { useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import { T } from '../../theme';
import { Field, Select, S } from './ui';
import { ALL, buildPeriodIndex, quarterOptions, monthOptions, applyFilterChange, periodText, emptyFilters } from './filterLogic';

// Financial Year → Company → Half Year → Quarter → Month → Module
// Options that don't fit the parent are shown greyed out and cannot be picked.
export default function FilterBar({ meta, filters, onChange, children, showModule = true, showCompany = true }) {
  const idx = useMemo(() => buildPeriodIndex(meta.period), [meta.period]);
  const set = (field, value) => onChange(applyFilterChange(idx, filters, field, value));

  const fyOpts = meta.settings.fy_list.map(fy => ({ value: fy, label: `FY ${fy}` }));
  const coOpts = [{ value: ALL, label: 'All companies' }, ...meta.companies.map(c => ({ value: c.id, label: `${c.name}${c.status === 'Inactive' ? ' (inactive)' : ''}` }))];
  const halfOpts = [{ value: ALL, label: 'All' }, ...meta.period.halves.map(h => ({ value: h.key, label: h.label }))];
  const qOpts = [{ value: ALL, label: 'All' }, ...quarterOptions(idx, filters.half).map(q => ({ value: q.key, label: q.label, disabled: !q.enabled }))];
  const mOpts = [{ value: ALL, label: 'All' }, ...monthOptions(idx, filters.half, filters.quarter).map(m => ({ value: m.key, label: m.label, disabled: !m.enabled }))];
  const modOpts = [{ value: ALL, label: 'All modules' }, ...meta.settings.modules.map(m => ({ value: m.key, label: m.label }))];
  const isDefault = filters.company === ALL && filters.half === ALL && filters.quarter === ALL && filters.month === ALL && filters.module === ALL;

  return (
    <div style={{ ...S.card, padding: '0.85rem 1.1rem', overflow: 'visible' }}>
      <div className="cmp-filters">
        <Field label="Financial Year"><Select value={filters.fy} onChange={v => set('fy', v)} options={fyOpts} aria-label="Financial Year" /></Field>
        {showCompany && <Field label="Company"><Select value={filters.company} onChange={v => set('company', v)} options={coOpts} aria-label="Company" /></Field>}
        <Field label="Half Year"><Select value={filters.half} onChange={v => set('half', v)} options={halfOpts} aria-label="Half Year" /></Field>
        <Field label="Quarter"><Select value={filters.quarter} onChange={v => set('quarter', v)} options={qOpts} aria-label="Quarter" /></Field>
        <Field label="Month"><Select value={filters.month} onChange={v => set('month', v)} options={mOpts} aria-label="Month" /></Field>
        {showModule && <Field label="Module"><Select value={filters.module} onChange={v => set('module', v)} options={modOpts} aria-label="Module" /></Field>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.75rem', color: T.textMuted }}>
          Selected period: <strong style={{ color: T.text }}>{periodText(idx, filters)}</strong>
        </span>
        {!isDefault && (
          <button style={{ ...S.linkBtn, display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => onChange(emptyFilters(filters.fy))}>
            <RotateCcw size={11} /> Reset filters
          </button>
        )}
        <span style={{ flex: 1 }} />
        {children}
      </div>
    </div>
  );
}
