export function formatINR(value) {
  if (value === null || value === undefined) return '₹0';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
}

export function formatNumber(value) {
  if (value === null || value === undefined) return '0';
  return new Intl.NumberFormat('en-IN').format(value);
}

export function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function statusColor(status) {
  switch (status?.toLowerCase()) {
    case 'paid': return '#22c55e';
    case 'sent': return '#3b82f6';
    case 'overdue': return '#ef4444';
    case 'draft': return '#94a3b8';
    case 'partially_paid': return '#f59e0b';
    default: return '#94a3b8';
  }
}
