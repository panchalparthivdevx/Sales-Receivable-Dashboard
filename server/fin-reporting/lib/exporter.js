/**
 * Financial Reporting — Excel exports. Every export starts with the context it was produced in: company, reporting basis,
 * periods, unit, financial version, import version (files and when they were imported), filters and generation date.
 */

'use strict';

const XLSX = require('xlsx');

function workbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const aoa = [[s.title], ...s.meta.map(([k, v]) => [k, v]), [], s.columns.map(c => c.label), ...s.rows.map(r => s.columns.map(c => {
      const v = typeof c.get === 'function' ? c.get(r) : r[c.key];
      return v == null ? '' : v;
    }))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = s.columns.map(c => ({ wch: c.width || Math.max(12, Math.min(60, c.label.length + 4)) }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function contextMeta(o) {
  return [
    ['Company', 'Dev Accelerator Ltd'],
    ['Reporting basis', o.basis === 'CO' ? 'Consolidated' : o.basis === 'SA' ? 'Standalone' : o.basis || 'Standalone and consolidated'],
    ['Periods', o.periods || ''],
    ['Unit', o.unit || '₹ lakh (EPS in ₹; ratios, days and percentages unscaled)'],
    ['Financial version', o.mode === 'latest' ? 'Latest reported / regrouped' : 'As originally reported'],
    ['Import version', o.version ? `${o.version.id} — imported ${o.version.builtAt} by ${o.version.builtBy || '—'}; files: ${o.version.files.map(f => f.name).join('; ')}` : '—'],
    ['Filters', o.filters || '—'],
    ['Generated', new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
  ];
}

module.exports = { workbook, contextMeta };
