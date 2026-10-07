// Finance Suite design tokens.
//
// These are the colours, font, radii and shadow the existing dashboards already use inline
// (GSTDashboard, FinancialStatements, KPICard, Sidebar …), collected in one place so new
// modules match exactly. Existing pages are NOT changed to import this file.
//
// Status colours are the only addition (Compliance Dashboard). The editable copy of the
// status colours lives in server/compliance/config/compliance.config.json; these are the
// fallback used until that config has loaded.

export const T = {
  // Brand / surfaces
  primary:     '#1C4942',   // buttons, active tab, links, bars
  primarySoft: '#EAF4EF',   // soft button background, highlights
  primaryLine: '#2D6B62',
  sidebar:     '#001214',
  page:        '#F9F9F9',   // page background, table header background
  card:        '#FFFFFF',
  border:      '#DFE7E3',
  track:       '#EEF2F0',   // progress-bar track, scrollbar track
  scroll:      '#C8D6D0',

  // Text
  text:      '#18191B',
  textMuted: '#5D6C7B',
  textFaint: '#9BA8B0',

  // Feedback
  success: '#15803D',
  info:    '#2563EB',
  warning: '#D97706',
  danger:  '#DC2626',

  // Compliance statuses (fallback — see note above)
  status: {
    'Completed':   '#15803D',
    'In Progress': '#2563EB',
    'Not Started': '#64748B',
    'Due Soon':    '#D97706',
    'Overdue':     '#DC2626',
    'N/A':         '#9BA8B0',
  },

  font:   "'Figtree', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono:   'monospace',
  radius: { sm: 5, md: 8, lg: 12 },
  shadow: '0 1px 3px rgba(0,18,20,0.06)',
};

export default T;
