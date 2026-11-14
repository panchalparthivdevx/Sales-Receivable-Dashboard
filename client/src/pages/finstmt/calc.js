// Client-side helpers shared by the analytical tabs.

// Budget lines map 1:1 to statement lines (the budget form offers exactly these)
export const BUDGET_LINES = [
  ['Revenue from operations', 'pl.rev'], ['Other income', 'pl.oth_inc'], ['Total income', 'pl.tot_inc'],
  ['Operating expenses', 'pl.exp_ops'], ['Employee benefits expense', 'pl.exp_emp'], ['Other expenses', 'pl.exp_oth'],
  ['EBITDA', 'm.ebitda'], ['Finance costs', 'pl.exp_fin'], ['Depreciation and amortisation', 'pl.exp_dep'],
  ['Total expenses', 'pl.exp_tot'], ['Profit before tax', 'pl.pbt'], ['Profit for the period', 'pl.pat'], ['Capex', 'capex'],
];
export const lineOfBudget = label => (BUDGET_LINES.find(([l]) => l.toLowerCase() === String(label || '').trim().toLowerCase()) || [])[1] || null;

/** The reporting period a [start, end] range is, among the available ones (exact dates only — nothing is pro-rated) */
export function periodFor(available, start, end) {
  return available.find(p => p.end === end && (!start || p.start === start)) || null;
}

export const fyOfDate = iso => { const [y, m] = iso.split('-').map(Number); return m >= 4 ? y + 1 : y; };
export const monthLabel = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });

/** ₹ from module data (rupees) → lakh */
export const rsToLakh = v => (v == null ? null : v / 1e5);

/** Statement value of a line for a period from a statement view (null when absent); EBITDA computed */
export function lineValue(view, id, p) {
  if (!view) return null;
  const g = x => view.rows.find(r => r.id === x)?.cells[p]?.v ?? null;
  if (id === 'm.ebitda') { const a = g('pl.pbt'), f = g('pl.exp_fin'), d = g('pl.exp_dep'); return a == null || f == null || d == null ? null : a + f + d; }
  return g(id);
}

export function budgetVersions(inputs) { return [...new Set((inputs?.records || []).filter(r => r.type === 'budget').map(r => r.values.version))]; }
