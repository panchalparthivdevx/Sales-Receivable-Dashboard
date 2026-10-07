import React, { useState, useMemo } from 'react';
import { X, FileSpreadsheet, FileText } from 'lucide-react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatINR, formatDate, statusColor } from '../utils/format';

export default function Modal({ title, data, columns, onClose }) {
  const [branchFilter, setBranchFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');

  const [vendorFilter,   setVendorFilter]   = useState('All');
  const [categoryFilter, setCategoryFilter] = useState('All');

  const colsArr     = Array.isArray(columns) ? columns : [];
  const hasBranch   = colsArr.some(c => c.key === 'branch_name');
  const hasStatus   = colsArr.some(c => c.key === 'status');
  const hasVendor   = colsArr.some(c => c.key === 'vendor_name');
  const hasCategory = colsArr.some(c => c.key === 'account_name');

  const dataArr = Array.isArray(data) ? data : [];

  const branches = useMemo(() => {
    if (!hasBranch) return [];
    return ['All', ...[...new Set(dataArr.map(r => r.branch_name).filter(Boolean))].sort()];
  }, [dataArr, hasBranch]);

  const statuses = useMemo(() => {
    if (!hasStatus) return [];
    return ['All', ...[...new Set(dataArr.map(r => r.status).filter(Boolean))].sort()];
  }, [dataArr, hasStatus]);

  const vendors = useMemo(() => {
    if (!hasVendor) return [];
    return ['All', ...[...new Set(dataArr.map(r => r.vendor_name).filter(Boolean))].sort()];
  }, [dataArr, hasVendor]);

  const categories = useMemo(() => {
    if (!hasCategory) return [];
    return ['All', ...[...new Set(dataArr.map(r => r.account_name).filter(Boolean))].sort()];
  }, [dataArr, hasCategory]);

  const filtered = useMemo(() => dataArr.filter(r => {
    if (branchFilter   !== 'All' && r.branch_name  !== branchFilter)   return false;
    if (statusFilter   !== 'All' && r.status        !== statusFilter)   return false;
    if (vendorFilter   !== 'All' && r.vendor_name   !== vendorFilter)   return false;
    if (categoryFilter !== 'All' && r.account_name  !== categoryFilter) return false;
    return true;
  }), [dataArr, branchFilter, statusFilter, vendorFilter, categoryFilter]);

  const cellText = (row, col) => {
    if (col.type === 'currency') return formatINR(row[col.key]);
    if (col.type === 'date') return formatDate(row[col.key]);
    return String(row[col.key] ?? '-');
  };

  const exportExcel = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      colsArr.map(c => c.label),
      ...filtered.map(row => colsArr.map(col =>
        col.type === 'currency' ? (row[col.key] ?? 0)
          : col.type === 'date' ? formatDate(row[col.key])
          : (row[col.key] ?? '')
      )),
    ]);
    const colWidths = colsArr.map((col, ci) => ({
      wch: Math.max(col.label.length, ...filtered.map(r => String(r[col.key] ?? '').length).slice(0, 200)) + 2
    }));
    ws['!cols'] = colWidths;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    XLSX.writeFile(wb, `${title.replace(/[^\w\s-]/g, '').trim()}.xlsx`);
  };

  const exportPDF = () => {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(24, 25, 27);
    doc.setFillColor(28, 73, 66);
    doc.rect(0, 0, doc.internal.pageSize.getWidth(), 60, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text(title, 40, 28);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(234, 244, 239);
    doc.text(
      `${filtered.length} records  ·  Generated: ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
      40, 46
    );
    autoTable(doc, {
      startY: 68,
      head: [colsArr.map(c => c.label)],
      body: filtered.map(row => colsArr.map(col => cellText(row, col))),
      styles: { fontSize: 8, cellPadding: 5, textColor: [24, 25, 27] },
      headStyles: { fillColor: [28, 73, 66], textColor: [255, 255, 255], fontStyle: 'bold', lineColor: [223, 231, 227], lineWidth: 0.5 },
      alternateRowStyles: { fillColor: [242, 242, 242] },
      bodyStyles: { fillColor: [255, 255, 255], lineColor: [223, 231, 227], lineWidth: 0.3 },
      margin: { left: 40, right: 40 },
    });
    doc.save(`${title.replace(/[^\w\s-]/g, '').trim()}.pdf`);
  };

  if (data == null) return null;

  const showFilters = hasBranch || hasStatus;

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={S.header}>
          <h2 style={S.title}>{title}</h2>
          <button style={S.closeBtn} onClick={onClose}><X size={20} /></button>
        </div>

        {/* Filter + Export bar */}
        {(showFilters || true) && (
          <div style={S.toolbar}>
            <div style={S.filters}>
              {hasBranch && (
                <div style={S.filterGroup}>
                  <label style={S.filterLabel}>Branch</label>
                  <select style={S.select} value={branchFilter} onChange={e => setBranchFilter(e.target.value)}>
                    {branches.map(b => <option key={b}>{b}</option>)}
                  </select>
                </div>
              )}
              {hasStatus && (
                <div style={S.filterGroup}>
                  <label style={S.filterLabel}>Status</label>
                  <select style={S.select} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                    {statuses.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
              )}
              {hasVendor && (
                <div style={S.filterGroup}>
                  <label style={S.filterLabel}>Vendor</label>
                  <select style={S.select} value={vendorFilter} onChange={e => setVendorFilter(e.target.value)}>
                    {vendors.map(v => <option key={v}>{v}</option>)}
                  </select>
                </div>
              )}
              {hasCategory && (
                <div style={S.filterGroup}>
                  <label style={S.filterLabel}>Category</label>
                  <select style={S.select} value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
                    {categories.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div style={S.exportBtns}>
              <button style={S.exportBtn} onClick={exportExcel} title="Export to Excel">
                <FileSpreadsheet size={15} />
                Excel
              </button>
              <button style={{ ...S.exportBtn, ...S.exportBtnPdf }} onClick={exportPDF} title="Export to PDF">
                <FileText size={15} />
                PDF
              </button>
            </div>
          </div>
        )}

        {/* Table */}
        <div style={S.body}>
          {filtered.length === 0 ? (
            <p style={{ color: '#5D6C7B', textAlign: 'center', padding: '2rem' }}>No data available.</p>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  {colsArr.map(c => <th key={c.key} style={S.th}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, i) => (
                  <tr key={i} style={i % 2 === 0 ? S.rowEven : S.rowOdd}>
                    {colsArr.map(c => (
                      <td key={c.key} style={{ ...S.td, textAlign: c.align || 'left' }}>
                        {c.type === 'status' ? (
                          <span style={{ ...S.badge, background: statusColor(row[c.key]) + '22', color: statusColor(row[c.key]) }}>
                            {row[c.key] || '-'}
                          </span>
                        ) : cellText(row, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div style={S.footer}>
          <span style={{ color: '#5D6C7B', fontSize: '0.82rem' }}>
            {filtered.length !== (data || []).length
              ? `${filtered.length} of ${dataArr.length} records (filtered)`
              : `${filtered.length} records`}
          </span>
        </div>

      </div>
    </div>
  );
}

const S = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  modal: { background: '#FFFFFF', borderRadius: '12px', width: '100%', maxWidth: '1020px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', border: '1px solid #DFE7E3', boxShadow: '0 8px 40px rgba(0,18,20,0.15)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.1rem 1.5rem', borderBottom: '1px solid #DFE7E3', flexShrink: 0 },
  title: { margin: 0, color: '#18191B', fontSize: '1.05rem', fontWeight: 600 },
  closeBtn: { background: 'none', border: 'none', color: '#5D6C7B', cursor: 'pointer', padding: '4px', borderRadius: '6px', flexShrink: 0 },

  toolbar: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '1rem', padding: '0.75rem 1.5rem', borderBottom: '1px solid #DFE7E3', background: '#F9F9F9', flexShrink: 0, flexWrap: 'wrap' },
  filters: { display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' },
  filterGroup: { display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  filterLabel: { color: '#5D6C7B', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  select: { background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#18191B', padding: '0.35rem 0.6rem', borderRadius: 6, fontSize: '0.81rem', cursor: 'pointer', minWidth: 140 },

  exportBtns: { display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 },
  exportBtn: { display: 'flex', alignItems: 'center', gap: '0.35rem', background: '#EAF4EF', border: '1px solid #BBF7D0', color: '#15803D', padding: '0.35rem 0.85rem', borderRadius: 6, fontSize: '0.8rem', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' },
  exportBtnPdf: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626' },

  body: { overflowY: 'auto', padding: '0 1.5rem 0.5rem' },
  footer: { padding: '0.65rem 1.5rem', borderTop: '1px solid #DFE7E3', flexShrink: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' },
  th: { padding: '0.6rem 0.75rem', color: '#5D6C7B', fontWeight: 600, textAlign: 'left', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#FFFFFF', zIndex: 1 },
  td: { padding: '0.55rem 0.75rem', color: '#18191B', borderBottom: '1px solid #F2F2F2' },
  rowEven: { background: 'transparent' },
  rowOdd: { background: '#F9F9F9' },
  badge: { padding: '2px 8px', borderRadius: '20px', fontSize: '0.77rem', fontWeight: 500, textTransform: 'capitalize' },
};
