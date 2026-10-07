// Dependent period filters: Financial Year → Company → Half Year → Quarter → Month → Module
//
// Rules (also enforced by the server):
//   • Quarter and Half Year are always derived from Month (selecting a month fills them in).
//   • H1 enables only Q1, Q2; H2 only Q3, Q4. A quarter enables only its own 3 months.
//   • When a parent changes and the selected child no longer fits, the child resets to "All".
//   • So an invalid combination such as August + Q1 can never be selected.
//
// Pure functions only (no React) — unit-tested from server/compliance/tests.
// The month/quarter/half table comes from the server (GET /api/compliance/meta → period).

export const ALL = 'All';

export function buildPeriodIndex(period) {
  return {
    months: period.months,
    quarters: period.quarters,
    halves: period.halves,
    monthByKey: Object.fromEntries(period.months.map(m => [m.key, m])),
    quarterByKey: Object.fromEntries(period.quarters.map(q => [q.key, q])),
  };
}

export function emptyFilters(fy) {
  return { fy, company: ALL, half: ALL, quarter: ALL, month: ALL, module: ALL };
}

/** Quarter options with enabled flags for the selected half */
export function quarterOptions(idx, half) {
  return idx.quarters.map(q => ({ key: q.key, label: q.label, enabled: half === ALL || q.half === half }));
}

/** Month options with enabled flags for the selected half/quarter */
export function monthOptions(idx, half, quarter) {
  return idx.months.map(m => ({
    key: m.key,
    label: m.label,
    enabled: quarter !== ALL ? m.quarter === quarter : half !== ALL ? m.half === half : true,
  }));
}

/** Make Quarter/Half agree with Month (and Half with Quarter) */
export function normalizeFilters(idx, f) {
  const out = { ...f };
  const m = out.month !== ALL ? idx.monthByKey[out.month] : null;
  if (out.month !== ALL && !m) out.month = ALL;
  if (m) { out.quarter = m.quarter; out.half = m.half; }
  const q = out.quarter !== ALL ? idx.quarterByKey[out.quarter] : null;
  if (out.quarter !== ALL && !q) out.quarter = ALL;
  if (q) out.half = q.half;
  return out;
}

/** Apply one filter change and reset any child that no longer fits */
export function applyFilterChange(idx, filters, field, value) {
  const f = { ...filters, [field]: value };
  if (field === 'half') {
    if (value === ALL) { f.quarter = ALL; f.month = ALL; }
    else {
      if (f.quarter !== ALL && idx.quarterByKey[f.quarter]?.half !== value) f.quarter = ALL;
      if (f.month !== ALL && idx.monthByKey[f.month]?.half !== value) f.month = ALL;
    }
  }
  if (field === 'quarter') {
    if (value === ALL) f.month = ALL;                       // a month would imply a quarter
    else {
      f.half = idx.quarterByKey[value].half;                // auto-fill
      if (f.month !== ALL && idx.monthByKey[f.month]?.quarter !== value) f.month = ALL;
    }
  }
  if (field === 'month' && value !== ALL) {
    f.quarter = idx.monthByKey[value].quarter;              // auto-fill
    f.half = idx.monthByKey[value].half;
  }
  return normalizeFilters(idx, f);
}

/** True when Quarter/Half agree with Month and Half with Quarter */
export function isValidCombo(idx, f) {
  const m = f.month !== ALL ? idx.monthByKey[f.month] : null;
  if (f.month !== ALL && !m) return false;
  if (m && ((f.quarter !== ALL && f.quarter !== m.quarter) || (f.half !== ALL && f.half !== m.half))) return false;
  const q = f.quarter !== ALL ? idx.quarterByKey[f.quarter] : null;
  if (f.quarter !== ALL && !q) return false;
  if (q && f.half !== ALL && f.half !== q.half) return false;
  return true;
}

/** Month keys covered by the filters */
export function monthsOf(idx, f) {
  if (f.month !== ALL) return [f.month];
  if (f.quarter !== ALL) return idx.months.filter(m => m.quarter === f.quarter).map(m => m.key);
  if (f.half !== ALL) return idx.months.filter(m => m.half === f.half).map(m => m.key);
  return idx.months.map(m => m.key);
}

/** Human description of the selected period, e.g. "August · Q2 · H1 · FY 2026-27" */
export function periodText(idx, f) {
  const parts = [];
  if (f.month !== ALL) parts.push(idx.monthByKey[f.month].label);
  if (f.quarter !== ALL) parts.push(f.quarter);
  if (f.half !== ALL) parts.push(f.half);
  parts.push(`FY ${f.fy}`);
  return f.month === ALL && f.quarter === ALL && f.half === ALL ? `Full year · FY ${f.fy}` : parts.join(' · ');
}

/** Query parameters for the API */
export function toQuery(f) {
  return { fy: f.fy, company: f.company, half: f.half, quarter: f.quarter, month: f.month, module: f.module };
}
