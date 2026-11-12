/**
 * Excel export. Every sheet is built from the same rows the screens show, so figures cannot differ between the
 * dashboard and the workbook. Amounts are real numbers in rupees (formatted #,##0.00), dates are real Excel dates.
 */

'use strict';

const XLSX = require('xlsx');
const N = require('./normalize');
const D = require('./dash');
const { STATUS } = require('./match');
const { claimDeadline, exposureClass } = require('./rules');
const { COMPONENTS } = require('./money');

const MONEY = '#,##0.00', DATE = 'dd-mmm-yyyy';
const rupees = p => (p === null || p === undefined ? null : Math.round(p) / 100);
const serial = iso => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000 : null);
const FLAG_TEXT = {
  duplicate_suspected: 'Duplicate suspected', duplicate_possible: 'Possible duplicate (same date and amounts)', invalid_gstin: 'Invalid GSTIN', wrong_supplier_gstin: 'Wrong supplier GSTIN?', wrong_recipient_gstin: 'Wrong recipient GSTIN?',
  cross_period: 'Cross-period', late_reporting: 'Late reporting', early_reporting: 'Early reporting', cross_fy: 'Across financial years', amendment: 'Amendment', credit_note: 'Credit note', debit_note: 'Debit note', reverse_charge: 'Reverse charge',
  incomplete_data: 'Incomplete data', unsupported_section: 'Unsupported section', itc_not_available_per_portal: 'ITC not available per portal', date_assumed: 'Invoice date assumed (posting date)', tax_type_mismatch: 'IGST vs CGST/SGST mismatch',
  ambiguous: 'Ambiguous (several candidates)', normalization_collision: 'Number normalisation collision', invoice_value_differs: 'Invoice value differs', zero_tax: 'No GST on document', grouped: 'Grouped (split / consolidated)',
  zoho_changed_not_refreshed: 'Changed in Zoho — not refreshed', data_quality_note: 'Data-quality note', portal_duplicate: 'Reported twice on GSTR-2B', number_differs: 'Different document numbers',
};
const flagText = r => r.flags.map(f => FLAG_TEXT[f] || f).join('; ');

/** A sheet from column definitions: [header, getter, kind] with kind 'money' | 'date' | undefined */
function sheet(cols, rows, { widths } = {}) {
  const aoa = [cols.map(c => c[0])];
  for (const r of rows) aoa.push(cols.map(([, get, kind]) => {
    let v = get(r);
    if (kind === 'money') { v = rupees(v); return v === null ? '' : { t: 'n', v, z: MONEY }; }
    if (kind === 'date') { const s = serial(v); return s === null ? (v || '') : { t: 'n', v: s, z: DATE }; }
    return v === undefined || v === null ? '' : v;
  }));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = cols.map((c, i) => ({ wch: (widths && widths[i]) || Math.min(44, Math.max(10, String(c[0]).length + 2)) }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}
const note = text => XLSX.utils.aoa_to_sheet([[text]]);

function detailCols(ctx) {
  const A = (side, c) => r => { const v = side === 'b' ? r.b : r.p; return v.length ? v.reduce((s, x) => s + (r.doc_type === 'CRN' ? -1 : 1) * ((x.amounts && x.amounts[c]) || 0), 0) : null; };
  const val = side => r => { const v = side === 'b' ? r.b : r.p; return v.length ? v.reduce((s, x) => s + (r.doc_type === 'CRN' ? -1 : 1) * (x.value || 0), 0) : null; };
  const join = (side, f) => r => (side === 'b' ? r.b : r.p).map(f).join(' + ');
  const meta = r => ctx.meta[r.books_ids[0] || r.portal_ids[0]] || {};
  const notes = r => ((ctx.notes[r.books_ids[0] || r.portal_ids[0]]) || []).length;
  return [
    ['Company', r => ctx.companyName(r.company)], ['Recipient GSTIN', r => r.recipient_gstin], ['Primary status', r => STATUS[r.status]], ['Rule', r => (r.rule === 'R3' && r.identity ? `R3 (${r.identity} identity)` : r.rule || '')],
    ['Decision', r => `${r.decision.mode}${r.decision.by ? ` — ${r.decision.by}` : ''}`], ['Flags', flagText],
    ['Supplier GSTIN', r => r.supplier_gstin], ['Supplier', r => r.supplier_name], ['Type', r => ({ INV: 'Invoice', CRN: 'Credit note', DBN: 'Debit note' })[r.doc_type]],
    ['Books document no.', join('b', v => v.no)], ['Books date (supplier invoice)', r => (r.b[0] || {}).date, 'date'], ['Books posting date', r => (r.b[0] || {}).posting, 'date'], ['Books accounting month', r => (r.b[0] || {}).period],
    ['Books taxable', A('b', 'taxable'), 'money'], ['Books IGST', A('b', 'igst'), 'money'], ['Books CGST', A('b', 'cgst'), 'money'], ['Books SGST/UTGST', A('b', 'sgst'), 'money'], ['Books Cess', A('b', 'cess'), 'money'], ['Books invoice value', val('b'), 'money'],
    ['GSTR-2B document no.', join('p', v => v.no)], ['GSTR-2B date', r => (r.p[0] || {}).date, 'date'], ['GSTR-2B period', r => (r.p[0] || {}).period], ['GSTR-2B section', r => r.p.map(v => v.section).join(' + ')], ['ITC available per portal', r => r.p.map(v => v.itc).join(' + ')],
    ['GSTR-2B taxable', A('p', 'taxable'), 'money'], ['GSTR-2B IGST', A('p', 'igst'), 'money'], ['GSTR-2B CGST', A('p', 'cgst'), 'money'], ['GSTR-2B SGST/UTGST', A('p', 'sgst'), 'money'], ['GSTR-2B Cess', A('p', 'cess'), 'money'], ['GSTR-2B invoice value', val('p'), 'money'],
    ['Diff taxable (2B − Books)', r => r.diffs && r.diffs.taxable, 'money'], ['Diff IGST', r => r.diffs && r.diffs.igst, 'money'], ['Diff CGST', r => r.diffs && r.diffs.cgst, 'money'], ['Diff SGST/UTGST', r => r.diffs && r.diffs.sgst, 'money'], ['Diff Cess', r => r.diffs && r.diffs.cess, 'money'],
    ['Tolerance per component (₹)', r => (r.tolerance_p ? `taxable ${r.tolerance_p.taxable / 100}, IGST ${r.tolerance_p.igst / 100}, CGST ${r.tolerance_p.cgst / 100}, SGST ${r.tolerance_p.sgst / 100}, cess ${r.tolerance_p.cess / 100}` : '')],
    ['Branch', r => (r.b[0] ? r.b[0].branch : 'Unallocated branch')], ['Projects', r => [...new Set(r.b.flatMap(v => v.projects || []))].join(', ')],
    ['Owner', r => meta(r).owner || ''], ['Workflow', r => (meta(r).workflow ? ctx.workflow[meta(r).workflow] || meta(r).workflow : '')], ['Next action', r => meta(r).next_action || ''], ['Due', r => meta(r).due || '', 'date'], ['Notes', notes],
    ['Zoho link', r => (r.b[0] || {}).url || ''], ['Why', r => r.explain.join(' ')],
  ];
}

/**
 * @param ctx { rows, filters, summary, bridge, vendors, statements, companies, regOf, meta, notes, workflow, syncInfo, generatedBy, today }
 * @returns { buffer, sheets }
 */
function build(ctx) {
  const wb = XLSX.utils.book_new();
  const add = (name, ws) => XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  const rows = ctx.rows, today = ctx.today || N.todayIST();
  const cname = id => (ctx.companies.find(c => c.id === id) || {}).name || id;
  const dc = detailCols({ ...ctx, companyName: cname });
  const s = ctx.summary, ex = s.exposure;

  // 1 — Executive summary
  const sum = [
    ['GSTR-2B Reconciliation — executive summary'], [],
    ['Generated', `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by ${ctx.generatedBy}`],
    ['Scope', ctx.scopeText], ['Period basis', ctx.basisText], [],
    ['Data used'], ...ctx.statements.map(st => [`GSTR-2B ${st.gstin} ${st.period}`, `version ${st.version}${st.gendt ? `, generated ${st.gendt}` : ''}, imported ${String(st.imported_at).slice(0, 10)}${st.demo ? ' — DEMO DATA' : ''}`]),
    ...(ctx.syncInfo || []).map(x => [x.label, x.value]), [],
    ['Key figures (₹)', 'Amount', 'How it is calculated'],
    ['GST on Books documents (matchable)', rupees(s.books.gst), s.definitions.books_gst],
    ['GST on GSTR-2B documents (matchable)', rupees(s.portal.gst), s.definitions.portal_gst],
    ['GST on matched documents — Books side', rupees(s.matched.books_gst), s.definitions.matched],
    ['GST on matched documents — GSTR-2B side', rupees(s.matched.portal_gst), ''],
    ['Matched Books documents — document rate', s.rates.doc_books === null ? '' : `${(s.rates.doc_books * 100).toFixed(1)}%`, s.definitions.doc_rate_books],
    ['Matched Books documents — tax rate', s.rates.tax_books === null ? '' : `${(s.rates.tax_books * 100).toFixed(1)}%`, s.definitions.tax_rate_books],
    ['Matched GSTR-2B documents — document rate', s.rates.doc_portal === null ? '' : `${(s.rates.doc_portal * 100).toFixed(1)}%`, s.definitions.doc_rate_portal], [],
    ['Potential credit exposure (₹)', 'Amount', s.definitions.exposure],
    ['Books-only GST — total', rupees(ex.books_only_gst), ''], ['   confirmed time-barred (Section 16(4))', rupees(ex.time_barred_gst), 'Past the earlier of 30 Nov following the financial year and the GSTR-9 filing date'],
    [`   closing within ${ex.soon_days} days`, rupees(ex.closing_soon_gst), ''], ['   still open', rupees(ex.open_gst), ''],
    ['Mismatch shortfall (GSTR-2B shows less GST)', rupees(ex.mismatch_shortfall_gst), ''], ['Suggested matches awaiting review (Books GST)', rupees(ex.suggested_gst), ''],
    ['Reverse-charge Books-only GST (not exposure)', rupees(ex.rcm_books_only_gst), ''], ['Books-only credit notes (not exposure)', rupees(ex.credit_note_books_only_gst), ''], [],
    ['Counts by primary status', 'Rows', 'Books documents', 'GSTR-2B documents', 'Books GST (₹)', 'GSTR-2B GST (₹)'],
    ...Object.keys(STATUS).map(k => [STATUS[k], s.by_status[k].rows, s.by_status[k].books_docs, s.by_status[k].portal_docs, rupees(D.gst(s.by_status[k].books)), rupees(D.gst(s.by_status[k].portal))]),
    ['Total', s.rows, '', '', '', ''], [],
    ['Pending review', s.pending_review, s.definitions.pending_review], ['Suppliers with open items', s.follow_up.vendors_with_issues, s.definitions.follow_up], [],
    ['Not in Phase 1', 'ITC eligibility, claim / reversal / reclaim register, GSTR-3B working, vendor message drafts, period locks, IMS status, direct GSTN access — planned (see DESIGN.md).'],
    ['Note', 'Reconciliation status is not ITC eligibility. A matched invoice may still be ineligible, deferred or unclaimed; Books-only GST is unresolved exposure, not lost credit.'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(sum);
  ws['!cols'] = [{ wch: 50 }, { wch: 22 }, { wch: 22 }, { wch: 22 }, { wch: 18 }, { wch: 18 }];
  for (const addr of Object.keys(ws)) { const c = ws[addr]; if (c && c.t === 'n' && !c.z && /^B\d+$/.test(addr) && Math.abs(c.v) > 50) c.z = MONEY; }
  add('Executive summary', ws);

  // 2 — Detailed reconciliation
  add('Detailed reconciliation', sheet(dc, rows, { widths: dc.map((c, i) => (i === dc.length - 1 ? 70 : undefined)) }));
  const only = (name, pred, extra = []) => add(name, sheet([...dc.slice(0, 8), ...extra, ...dc.slice(8)], rows.filter(pred)));
  // 3 — Books only (with the Section 16(4) deadline)
  const dl = r => claimDeadline((r.b[0] || {}).date, ctx.regOf(r.recipient_gstin));
  only('Books only', r => r.status === 'books_only', [
    ['Section 16(4) deadline', r => (dl(r) || {}).deadline || '', 'date'], ['Days left', r => (dl(r) ? N.daysBetween(today, dl(r).deadline) : '')],
    ['Exposure class', r => ({ time_barred: 'Time-barred', closing_soon: 'Closing soon', open: 'Open' })[exposureClass(dl(r) && dl(r).deadline, today, ctx.summary.exposure.soon_days)]]]);
  // 4–7
  only('GSTR-2B only', r => r.status === 'portal_only');
  only('Mismatches', r => r.status === 'mismatched');
  only('Suggested (review)', r => r.status === 'suggested');
  only('Duplicates', r => r.flags.includes('duplicate_suspected') || r.flags.includes('duplicate_possible') || r.flags.includes('portal_duplicate'));
  // 8 — Vendors
  add('Vendor summary', sheet([
    ['Supplier GSTIN', v => v.gstin], ['Supplier', v => v.name], ['PAN', v => v.pan], ['Rows', v => v.rows], ['Matched', v => v.matched], ['Suggested', v => v.suggested], ['Mismatched', v => v.mismatched], ['Books only', v => v.books_only], ['GSTR-2B only', v => v.portal_only],
    ['Books-only GST', v => v.books_only_gst, 'money'], ['Mismatch difference', v => v.mismatch_gst, 'money'], ['GSTR-2B-only GST', v => v.portal_only_gst, 'money'], ['GST at stake', v => v.gst_at_stake, 'money'],
    ['Months with open items', v => v.recurring_months], ['Late-reported documents', v => v.late], ['Average reporting delay (months)', v => v.avg_delay_months], ['Filing status', v => v.filing_status.text], ['Filing source', v => v.filing_status.source || ''],
    ['Invalid GSTIN', v => (v.invalid_gstin ? 'Yes' : '')], ['Possible wrong GSTIN', v => (v.wrong_gstin ? 'Yes' : '')]], ctx.vendors));
  // 9 — GSTIN summary
  const byG = new Map();
  for (const r of rows) { const k = `${r.company}|${r.recipient_gstin}`; (byG.get(k) || byG.set(k, []).get(k)).push(r); }
  add('GSTIN summary', sheet([
    ['Company', g => cname(g.company)], ['Recipient GSTIN', g => g.gstin], ['Rows', g => g.s.rows], ['Exact', g => g.s.by_status.exact.rows], ['Within tolerance', g => g.s.by_status.tolerance.rows], ['Suggested', g => g.s.by_status.suggested.rows], ['Mismatched', g => g.s.by_status.mismatched.rows],
    ['Books only', g => g.s.by_status.books_only.rows], ['GSTR-2B only', g => g.s.by_status.portal_only.rows], ['Excluded', g => g.s.by_status.excluded.rows],
    ['Books GST', g => g.s.books.gst, 'money'], ['GSTR-2B GST', g => g.s.portal.gst, 'money'], ['Books-only GST', g => g.s.exposure.books_only_gst, 'money'], ['Time-barred', g => g.s.exposure.time_barred_gst, 'money']],
  [...byG.entries()].map(([k, list]) => ({ company: list[0].company, gstin: list[0].recipient_gstin, s: D.summarize(list, { regOf: ctx.regOf, today, soonDays: ctx.summary.exposure.soon_days }) }))));
  // 10 — cross-period and amendments
  only('Cross-period & amendments', r => r.flags.includes('cross_period') || r.flags.includes('amendment') || r.flags.includes('cross_fy'));
  // 11 — excluded
  const first = r => r.b[0] || r.p[0] || {};
  const side = (r, c) => D.sumSide(r.b.length ? r.b : r.p, r.doc_type === 'CRN' ? -1 : 1)[c];
  add('Excluded', sheet([
    ['Company', r => cname(r.company)], ['Recipient GSTIN', r => r.recipient_gstin], ['Reason', r => (r.exclusion || {}).text || ''], ['Reason code', r => (r.exclusion || {}).code || ''],
    ['Source', r => (r.books_ids.length ? 'Books' : 'GSTR-2B')], ['Section / kind', r => (r.p[0] ? r.p[0].section : (r.b[0] || {}).kind)], ['Supplier GSTIN', r => r.supplier_gstin], ['Supplier', r => r.supplier_name],
    ['Document no.', r => first(r).no], ['Document date', r => first(r).date, 'date'], ['Taxable', r => side(r, 'taxable'), 'money'], ['IGST', r => side(r, 'igst'), 'money'], ['CGST', r => side(r, 'cgst'), 'money'], ['SGST/UTGST', r => side(r, 'sgst'), 'money'], ['Cess', r => side(r, 'cess'), 'money'],
    ['Flags', flagText], ['Zoho link', r => (r.b[0] || {}).url || ''],
  ], rows.filter(r => r.status === 'excluded')));

  // 12 — bridge and control totals
  const br = ctx.bridge;
  const names = { taxable: 'Taxable value', igst: 'IGST', cgst: 'CGST', sgst: 'SGST/UTGST', cess: 'Cess', gst: 'Total GST' };
  const b = [['Reconciliation bridge — each component ties out independently (₹)'], [],
    ['', ...Object.keys(names).map(k => names[k])]];
  const line = (label, key) => b.push([label, ...Object.keys(names).map(c => rupees(br.components[c][key]))]);
  line('Books — matchable documents', 'books_total'); line('   of which matched (exact + tolerance)', 'matched_books'); line('   of which suggested (not yet approved)', 'suggested_books'); line('   of which mismatched', 'mismatched_books'); line('   of which Books only', 'books_only');
  b.push([]); line('GSTR-2B — matchable documents', 'portal_total'); line('   of which matched', 'matched_portal'); line('   of which suggested', 'suggested_portal'); line('   of which mismatched', 'mismatched_portal'); line('   of which GSTR-2B only', 'portal_only');
  b.push([]); line('Difference: Books − GSTR-2B', 'difference'); line('Explained by the statuses above', 'explained');
  b.push(['Ties out', ...Object.keys(names).map(c => (br.components[c].ties ? 'Yes' : 'NO — investigate'))], [], ['Excluded documents (outside the bridge)'], ['Reason', 'Books docs', 'GSTR-2B docs', 'Books taxable', 'Books GST', 'GSTR-2B taxable', 'GSTR-2B GST']);
  for (const e of br.excluded) b.push([e.text, e.books_docs, e.portal_docs, rupees(e.books.taxable), rupees(D.gst(e.books)), rupees(e.portal.taxable), rupees(D.gst(e.portal))]);
  b.push([], ['Statements imported (control totals read per section)'], ['GSTIN', 'Period', 'Version', 'Generated', 'Section', 'Documents', 'Taxable (₹)', 'IGST (₹)', 'CGST (₹)', 'SGST (₹)', 'Cess (₹)', 'Portal summary check']);
  for (const st of ctx.statements) for (const [sec, v] of Object.entries(st.sections || {})) b.push([st.gstin, st.period, st.version, st.gendt || '', v.label, v.count, rupees(v.amounts.taxable), rupees(v.amounts.igst), rupees(v.amounts.cgst), rupees(v.amounts.sgst), rupees(v.amounts.cess), st.control && st.control.ok === true ? 'agrees' : st.control && st.control.ok === false ? 'DIFFERS' : 'not available']);
  const wsb = XLSX.utils.aoa_to_sheet(b);
  wsb['!cols'] = [{ wch: 46 }, ...Array(11).fill({ wch: 16 })];
  add('Bridge & control totals', wsb);

  // 13 — imports
  add('Imports', sheet([['GSTIN', s => s.gstin], ['Period', s => s.period], ['Version', s => s.version], ['Current', s => (s.is_current ? 'Yes' : 'No')], ['Generated', s => s.gendt || ''], ['Imported', s => String(s.imported_at).slice(0, 16).replace('T', ' ')], ['Imported by', s => s.imported_by], ['File', s => s.file_name],
    ['SHA-256', s => s.sha256], ['Documents', s => s.docs], ['Row problems', s => s.error_count], ['Unsupported sections', s => (s.unsupported || []).map(u => `${u.label} (${u.count})`).join('; ')], ['Demo data', s => (s.demo ? 'YES' : '')]], ctx.statements));

  // 14–15 — not in Phase 1
  add('ITC register (Phase 2)', note('Not implemented in Phase 1. The ITC register (eligibility, claim / reversal / reclaim, GSTR-3B working) is planned for Phase 2 — see server/gstr2b/DESIGN.md.'));
  add('Post-lock changes (Phase 2)', note('Not implemented in Phase 1. Period locks, frozen snapshots and the post-lock change report are planned for Phase 2.'));
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), sheets: wb.SheetNames };
}

module.exports = { build, FLAG_TEXT, flagText };
