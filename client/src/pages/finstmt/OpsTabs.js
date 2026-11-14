import React from 'react';
import axios from 'axios';
import { api } from '../../utils/api';
import PLReport from '../../components/PLReport';
import { fsApi } from './api';
import { C, S, Card, Note, Badge, Loading, ErrorBox, fmtVal, fmtAmt, unitLabel, useLoad, MissingInputs } from './ui';
import { rsToLakh } from './calc';

// Operational reports. Statement figures (period-matched) and live module data (as of today) are always labelled as such;
// nothing operational is inferred from statement totals.
const live = (what, asOf) => <div style={S.small}>Live from the {what}{asOf ? `, as of ${asOf}` : ''} — today's data, not matched to the selected financial period.</div>;
const T = ({ head, rows, num = [] }) => (
  <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
    <thead><tr>{head.map((h, i) => <th key={i} style={{ ...S.th, ...(num.includes(i) ? S.num : {}) }}>{h}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={{ ...S.td, ...(num.includes(j) ? S.num : {}) }}>{c}</td>)}</tr>)}</tbody>
  </table></div>
);

/** Statement lines across every balance-sheet date / flow period available for the basis */
function useSeries(F, stmt, ids) {
  return useLoad(async () => {
    const per = await fsApi.periods(F.basis, F.mode);
    const avail = per[stmt].available.filter(p => p.availability !== 'working').map(p => p.id).reverse();
    const v = await fsApi.statement({ basis: F.basis, stmt, periods: avail.join(','), mode: F.mode });
    return { periods: v.periods, get: (id, p) => v.rows.find(r => r.id === id)?.cells[p]?.v ?? null, has: id => v.rows.some(r => r.id === id) };
  }, [F.basis, F.mode, stmt, ids.join()]);
}
function useRatioSeries(F, ids) {
  return useLoad(async () => {
    const per = await fsApi.periods(F.basis, F.mode);
    const flows = per.PL.available.filter(p => p.availability === 'reported' && ['H', 'FY'].includes(p.type)).map(p => p.id).reverse();
    const qs = per.PL.available.filter(p => p.availability === 'reported' && p.type === 'Q').map(p => p.id).reverse().slice(-3);
    const r = await fsApi.ratios({ basis: F.basis, periods: [...flows, ...qs].join(','), mode: F.mode });
    return r;
  }, [F.basis, F.mode, ids.join()]);
}
const useInputs = () => useLoad(() => fsApi.inputs(), []);

// ── Branch Performance ───────────────────────────────────────────────────────
export function BranchTab({ F }) {
  const inp = useInputs();
  const occ = useLoad(() => api.occupancy().catch(() => null), []);
  const recs = inp.data?.records || [];
  const cap = recs.filter(r => r.type === 'branch_capacity').sort((a, b) => (a.branch || '').localeCompare(b.branch || '') || (a.effectiveDate || '').localeCompare(b.effectiveDate || ''));
  const open = recs.filter(r => r.type === 'branch_opening');
  return <div>
    <MissingInputs report="Branch Performance" coverage={inp.data?.coverage} />
    <Note>Branch results come from Zoho Books (the Finance Overview branch P&L report below), because the published statements are company-level only. Company-level figures are never split across branches here.</Note>
    <Card title="Branch P&L (Zoho Books — existing Finance Overview report)"><PLReport onOpenMapping={() => alert('Open Finance Overview to edit the branch P&L account mapping.')} /></Card>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
      <Card title="Seats, occupancy & area (management inputs)">
        {!cap.length ? <Note tone="warn">No branch capacity entered. Management Inputs → Branch seats, occupancy & area (with effective dates).</Note> :
          <T head={['Branch', 'From', 'Capacity seats', 'Occupied', 'Occupancy', 'Area (sq ft)', 'Source']} num={[2, 3, 4, 5]} rows={cap.map(r => [r.branch, r.effectiveDate, fmtVal(r.values.capacitySeats, 'nos'), r.values.occupiedSeats != null ? fmtVal(r.values.occupiedSeats, 'nos') : '—', r.values.occupiedSeats != null && r.values.capacitySeats ? fmtVal(r.values.occupiedSeats / r.values.capacitySeats, 'fraction') : '—', r.values.areaSqft != null ? fmtVal(r.values.areaSqft, 'nos') : '—', r.source])} />}
      </Card>
      <Card title="Occupancy by branch (Sales module)">
        {occ.loading ? <Loading /> : !Array.isArray(occ.data) && !occ.data?.branches ? <Note tone="warn">Not available from the Sales module just now.</Note> : <>
          <T head={['Branch', 'Total seats', 'Occupied', 'Occupancy']} num={[1, 2, 3]} rows={(Array.isArray(occ.data) ? occ.data : occ.data.branches || []).slice(0, 40).map(b => [b.branch_name, fmtVal(b.total_seats, 'nos'), fmtVal(b.occupied_seats, 'nos'), `${b.occupancy_pct}%`])} />
          {live('Sales module (seats on current invoices)')}</>}
      </Card>
    </div>
    <Card title="Branch opening dates">{!open.length ? <Note tone="warn">No opening dates entered (Management Inputs → Branch opening dates). Needed for like-for-like and ramp-up views.</Note> : <T head={['Branch', 'Opened', 'Closed', 'Model', 'Source']} rows={open.map(r => [r.branch, r.effectiveDate, r.values.closingDate || '—', r.values.model || '—', r.source])} />}</Card>
  </div>;
}

// ── AR & Collections ─────────────────────────────────────────────────────────
export function ArTab({ F, onGoImport }) {
  const s = useSeries(F, 'BS', ['bs.tr']);
  const r = useRatioSeries(F, ['wc.dso']);
  const ar = useLoad(() => api.arAging().catch(() => null), []);
  const inp = useInputs();
  const fc = (inp.data?.records || []).filter(x => x.type === 'collection_forecast').sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  if (s.error) return <ErrorBox error={s.error} onGo={onGoImport} />;
  return <div>
    <MissingInputs report="AR & Collections" coverage={inp.data?.coverage} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
      <Card title="Trade receivables in the balance sheet">{s.loading ? <Loading /> : <T head={['As at', `Trade receivables (${unitLabel(F.unit)})`]} num={[1]} rows={s.data.periods.map(p => [p.short, fmtAmt(s.data.get('bs.tr', p.id), F.unit)])} />}</Card>
      <Card title="Days sales outstanding">{r.loading ? <Loading /> : <T head={['Period', 'DSO', 'Status', 'Receivables turnover']} num={[1, 3]} rows={(r.data?.results || []).map(x => [x.period.short, fmtVal(x.values['wc.dso']?.v, 'days'), <Badge status={x.values['wc.dso']?.status} title={x.values['wc.dso']?.note} />, fmtVal(x.values['wc.rec_turn']?.v, 'times')])} />}
        <div style={S.small}>DSO = average receivables ÷ revenue × days in the period. Receivables include GST while revenue does not — set the GST rate for receivables on Management Inputs → Settings to align the bases.</div></Card>
    </div>
    <Card title="Ageing of open invoices (Sales module)">
      {ar.loading ? <Loading /> : !ar.data ? <Note tone="warn">Not available from the Sales module just now.</Note> : <>
        <T head={['Bucket (days past due)', `Outstanding (${unitLabel(F.unit)})`, 'Invoices', 'Share']} num={[1, 2, 3]} rows={ar.data.buckets.map(b => [b.label, fmtAmt(rsToLakh(b.amount), F.unit), b.count, ar.data.total_outstanding ? fmtVal(b.amount / ar.data.total_outstanding, 'fraction') : ''])} />
        <div style={{ ...S.h2, marginTop: 12 }}>Largest outstanding customers</div>
        <T head={['Customer', 'Outstanding', '> 90 days']} num={[1, 2]} rows={ar.data.customers.slice(0, 15).map(c => [c.customer_name, fmtAmt(rsToLakh(c.total_outstanding), F.unit), fmtAmt(rsToLakh(c.buckets.slice(2).reduce((t, b) => t + b.amount, 0)), F.unit)])} />
        {live('Sales module (Zoho invoices, incl. GST)', ar.data.as_of)}</>}
    </Card>
    <Card title="Collection forecast vs collections">{!fc.length ? <Note tone="warn">No collection forecast entered (Management Inputs → Collection forecast).</Note> : <T head={['Month', 'Branch', 'Client', `Expected (${unitLabel(F.unit)})`, 'Source']} num={[3]} rows={fc.map(x => [x.periodEnd, x.branch || '—', x.values.client || '—', fmtAmt(x.values.amount, F.unit), x.source])} />}</Card>
  </div>;
}

// ── AP & Payments ────────────────────────────────────────────────────────────
export function ApTab({ F, onGoImport }) {
  const s = useSeries(F, 'BS', ['bs.cl_tp_msme']);
  const r = useRatioSeries(F, ['wc.dpo']);
  const ap = useLoad(() => api.purApAging().catch(() => null), []);
  const inp = useInputs();
  const fc = (inp.data?.records || []).filter(x => x.type === 'payment_forecast').sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  if (s.error) return <ErrorBox error={s.error} onGo={onGoImport} />;
  return <div>
    <MissingInputs report="AP & Payments" coverage={inp.data?.coverage} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
      <Card title="Trade payables in the balance sheet">{s.loading ? <Loading /> : <T head={['As at', 'Micro & small (MSME)', 'Others', 'Total']} num={[1, 2, 3]} rows={s.data.periods.map(p => { const a = s.data.get('bs.cl_tp_msme', p.id), b = s.data.get('bs.cl_tp_other', p.id); return [p.short, fmtAmt(a, F.unit), fmtAmt(b, F.unit), fmtAmt(a == null && b == null ? null : (a || 0) + (b || 0), F.unit)]; })} />}
        <div style={S.small}>MSME interest and Form-1 status: MSME Compliance module.</div></Card>
      <Card title="Days payables outstanding (proxy)">{r.loading ? <Loading /> : <T head={['Period', 'DPO', 'Status']} num={[1]} rows={(r.data?.results || []).map(x => [x.period.short, fmtVal(x.values['wc.dpo']?.v, 'days'), <Badge status={x.values['wc.dpo']?.status} title={x.values['wc.dpo']?.note} />])} />}
        <div style={S.small}>Purchases are not in the statements: operating + other expenses are used as the base, so DPO is a proxy.</div></Card>
    </div>
    <Card title="Ageing of open bills (Purchase module)">
      {ap.loading ? <Loading /> : !ap.data ? <Note tone="warn">Not available from the Purchase module just now.</Note> : <>
        <T head={['Bucket (days past due)', `Outstanding (${unitLabel(F.unit)})`, 'Bills']} num={[1, 2]} rows={['current', '0-30', '31-60', '61-90', '90+'].map(k => [k === 'current' ? 'Not yet due' : k, fmtAmt(rsToLakh(ap.data[k]?.total), F.unit), ap.data[k]?.count ?? ''])} />
        {live('Purchase module (Zoho bills)')}</>}
    </Card>
    <Card title="Payment forecast">{!fc.length ? <Note tone="warn">No payment forecast entered (Management Inputs → Payment forecast).</Note> : <T head={['Month', 'Category', 'Branch', `Amount (${unitLabel(F.unit)})`, 'Source']} num={[3]} rows={fc.map(x => [x.periodEnd, x.values.category, x.branch || '—', fmtAmt(x.values.amount, F.unit), x.source])} />}</Card>
  </div>;
}

// ── Cash & Treasury ──────────────────────────────────────────────────────────
export function CashTab({ F, onGoImport }) {
  const bs = useSeries(F, 'BS', ['bs.cash']);
  const cf = useSeries(F, 'CF', ['cf.cfo']);
  const inp = useInputs();
  const recs = inp.data?.records || [];
  const coll = recs.filter(r => r.type === 'collection_forecast'), pay = recs.filter(r => r.type === 'payment_forecast'), dsch = recs.filter(r => r.type === 'debt_schedule');
  const months = [...new Set([...coll, ...pay, ...dsch].map(r => r.periodEnd))].sort();
  if (bs.error) return <ErrorBox error={bs.error} onGo={onGoImport} />;
  const lastBs = bs.data?.periods?.[bs.data.periods.length - 1];
  let run = lastBs ? ['bs.cash', 'bs.obank', 'bs.c_inv'].reduce((t, id) => t + (bs.data.get(id, lastBs.id) || 0), 0) : null;
  return <div>
    <MissingInputs report="Cash & Treasury" coverage={inp.data?.coverage} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
      <Card title="Cash, bank and liquid investments">{bs.loading ? <Loading /> : <T head={['As at', 'Cash & equivalents', 'Other bank balances', 'Current investments', 'Total']} num={[1, 2, 3, 4]} rows={bs.data.periods.map(p => { const v = ['bs.cash', 'bs.obank', 'bs.c_inv'].map(id => bs.data.get(id, p.id)); return [p.short, ...v.map(x => fmtAmt(x, F.unit)), fmtAmt(v.every(x => x == null) ? null : v.reduce((t, x) => t + (x || 0), 0), F.unit)]; })} />}
        <div style={S.small}>Other bank balances can be under lien (e.g. security for term loans) — see the note on other bank balances before treating them as free cash.</div></Card>
      <Card title="Cash flows">{cf.loading ? <Loading /> : <T head={['Period', 'Operating', 'Investing', 'Financing', 'Net change', 'Free cash flow']} num={[1, 2, 3, 4, 5]} rows={cf.data.periods.map(p => { const o = cf.data.get('cf.cfo', p.id), c = cf.data.get('cf.capex', p.id); return [p.short, fmtAmt(o, F.unit), fmtAmt(cf.data.get('cf.cfi', p.id), F.unit), fmtAmt(cf.data.get('cf.cff', p.id), F.unit), fmtAmt(cf.data.get('cf.net', p.id), F.unit), fmtAmt(o != null && c != null ? o + c : null, F.unit)]; })} />}
        <div style={S.small}>Cash flow statements are published for half years and years; quarters are not available and are not derived.</div></Card>
    </div>
    <Card title="Cash forecast and funding gap">
      {!months.length ? <Note tone="warn">No collection, payment or debt-service forecast entered. Management Inputs → Collection forecast, Payment forecast, Debt schedule.</Note> :
        <T head={['Month', 'Collections', 'Payments', 'Debt service', 'Net', 'Closing cash']} num={[1, 2, 3, 4, 5]} rows={months.map(m => { const a = coll.filter(r => r.periodEnd === m).reduce((t, r) => t + r.values.amount, 0), b = pay.filter(r => r.periodEnd === m).reduce((t, r) => t + r.values.amount, 0), d = dsch.filter(r => r.periodEnd === m).reduce((t, r) => t + r.values.principal + (r.values.interest || 0), 0); run = run == null ? null : run + a - b - d; return [m, fmtAmt(a, F.unit), fmtAmt(b, F.unit), fmtAmt(d, F.unit), fmtAmt(a - b - d, F.unit), <span style={{ color: run != null && run < 0 ? C.bad : C.ink }}>{run == null ? 'n/a' : fmtAmt(run, F.unit)}{run != null && run < 0 ? ' funding gap' : ''}</span>]; })} />}
      {lastBs && <div style={S.small}>Opening balance = cash, bank and liquid investments as at {lastBs.label.replace('As at ', '')}. Months between that date and the first forecast month are not filled in.</div>}
    </Card>
  </div>;
}

// ── Debt & Covenants ─────────────────────────────────────────────────────────
export function DebtTab({ F, onGoImport }) {
  const bs = useSeries(F, 'BS', ['bs.ncl_borrow']);
  const r = useRatioSeries(F, ['cov.iscr']);
  const loans = useLoad(() => api.loanData().catch(() => null), []);
  const inp = useInputs();
  const recs = inp.data?.records || [];
  const sch = recs.filter(x => x.type === 'debt_schedule'), cov = recs.filter(x => x.type === 'covenant');
  if (bs.error) return <ErrorBox error={bs.error} onGo={onGoImport} />;
  const lastBs = bs.data?.periods?.[bs.data.periods.length - 1];
  const asOf = lastBs ? lastBs.end : null;
  const addY = (d, y) => `${+d.slice(0, 4) + y}${d.slice(4)}`;
  const buckets = asOf ? [['Within 1 year', asOf, addY(asOf, 1)], ['1–2 years', addY(asOf, 1), addY(asOf, 2)], ['2–5 years', addY(asOf, 2), addY(asOf, 5)], ['Over 5 years', addY(asOf, 5), '9999-12-31']] : [];
  return <div>
    <MissingInputs report="Debt & Covenants" coverage={inp.data?.coverage} />
    <Card title="Borrowings and lease liabilities">{bs.loading ? <Loading /> : <T head={['As at', 'Borrowings — non-current', 'Borrowings — current', 'Total borrowings', 'Lease liabilities', 'Debt incl. leases']} num={[1, 2, 3, 4, 5]} rows={bs.data.periods.map(p => { const g = id => bs.data.get(id, p.id); const b = (g('bs.ncl_borrow') || 0) + (g('bs.cl_borrow') || 0), l = (g('bs.ncl_lease') || 0) + (g('bs.cl_lease') || 0); return [p.short, fmtAmt(g('bs.ncl_borrow'), F.unit), fmtAmt(g('bs.cl_borrow'), F.unit), fmtAmt(b, F.unit), fmtAmt(l, F.unit), fmtAmt(b + l, F.unit)]; })} />}</Card>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
      <Card title="Coverage and leverage (from the statements)">{r.loading ? <Loading /> : <T head={['Period', 'Interest cover (EBITDA)', 'EBITDA-based DSCR', 'Net debt incl. leases / TTM EBITDA', 'Debt / equity']} num={[1, 2, 3, 4]} rows={(r.data?.results || []).map(x => [x.period.short, fmtVal(x.values['cov.iscr']?.v, 'times'), <span>{fmtVal(x.values['cov.dscr_ebitda']?.v, 'times')} <Badge status={x.values['cov.dscr_ebitda']?.status} title={x.values['cov.dscr_ebitda']?.note} /></span>, fmtVal(x.values['lev.nd_ebitda_l']?.v, 'times'), fmtVal(x.values['lev.de']?.v, 'times')])} />}
        <div style={S.small}>The EBITDA-based DSCR is not the lender's DSCR. Lender covenants are tested below on their own definitions.</div></Card>
      <Card title="Maturity profile (debt schedule)">{!sch.length ? <Note tone="warn">No debt schedule entered (Management Inputs → Debt principal & interest schedule).</Note> : <T head={['Bucket', 'Principal', 'Interest']} num={[1, 2]} rows={buckets.map(([l, a, b]) => { const rr = sch.filter(x => x.periodEnd > a && x.periodEnd <= b); return [l, fmtAmt(rr.reduce((t, x) => t + x.values.principal, 0), F.unit), fmtAmt(rr.reduce((t, x) => t + (x.values.interest || 0), 0), F.unit)]; })} />}
        {asOf && sch.length > 0 && <div style={S.small}>From the latest balance-sheet date ({asOf}).</div>}</Card>
    </div>
    <Card title="Covenant headroom">{!cov.length ? <Note tone="warn">No covenants entered (Management Inputs → Covenants: lender, facility, metric, definition, test and threshold). Covenant status is never assumed.</Note> :
      <T head={['Lender / facility', 'Metric', 'Definition', 'Test', 'Tested value', 'Headroom', 'Status']} rows={cov.map(c => { const v = c.values.testedValue; const ok = v == null ? null : c.values.operator === '>=' ? v >= c.values.threshold : v <= c.values.threshold; const head = v == null ? null : c.values.operator === '>=' ? v - c.values.threshold : c.values.threshold - v;
        return [`${c.values.lender} / ${c.values.facility}`, c.values.metric, c.values.definition, `${c.values.operator} ${c.values.threshold}`, v == null ? '—' : `${v}${c.values.periodEnd ? ` (${c.values.periodEnd})` : ''}`, head == null ? '' : head.toFixed(2), <Badge status={v == null ? 'Missing data' : ok ? 'Within threshold' : 'Breach'} />]; })} />}</Card>
    <Card title="Loans (Loan module)">{loans.loading ? <Loading /> : !loans.data?.institutional?.length ? <Note tone="warn">No loan data in the Loan module.</Note> : <>
      <T head={['Lender / facility', 'Amount', 'EMI', 'Principal', 'Rate', 'Ends']} num={[1, 2, 3, 4]} rows={loans.data.institutional.map(l => [l.name, fmtVal(l.amount, 'nos'), fmtVal(l.emi, 'nos'), fmtVal(l.principal, 'nos'), `${l.rate}%`, l.endDateStr])} />
      <div style={S.small}>As kept in the Loan module (its own units and dates); use it to enter the debt schedule above.</div></>}</Card>
  </div>;
}

// ── Capex & Expansion ────────────────────────────────────────────────────────
export function CapexTab({ F, onGoImport }) {
  const bs = useSeries(F, 'BS', ['bs.cwip']);
  const cf = useSeries(F, 'CF', ['cf.capex']);
  const notes = useLoad(() => fsApi.notes({ basis: F.basis, mode: F.mode }), [F.basis, F.mode]);
  const inp = useInputs();
  const capex = (inp.data?.records || []).filter(r => r.type === 'capex');
  if (bs.error) return <ErrorBox error={bs.error} onGo={onGoImport} />;
  const ipo = (notes.data?.narrative || []).find(n => /ipo/i.test(n.text) && n.table?.length);
  return <div>
    <MissingInputs report="Capex & Expansion" coverage={inp.data?.coverage} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
      <Card title="Fixed assets in the balance sheet">{bs.loading ? <Loading /> : <T head={['As at', 'PPE', 'Capital WIP', 'Right-of-use', 'Intangibles (+ under dev.)', 'Capital advances / other NCA']} num={[1, 2, 3, 4, 5]} rows={bs.data.periods.map(p => { const g = id => bs.data.get(id, p.id); return [p.short, fmtAmt(g('bs.ppe'), F.unit), fmtAmt(g('bs.cwip'), F.unit), fmtAmt(g('bs.rou'), F.unit), fmtAmt((g('bs.intang') || 0) + (g('bs.intang_dev') || 0), F.unit), fmtAmt(g('bs.nc_other'), F.unit)]; })} />}</Card>
      <Card title="Capex in the cash flow">{cf.loading ? <Loading /> : <T head={['Period', 'Purchase of PPE / CWIP / intangibles', 'Sale of PPE']} num={[1, 2]} rows={cf.data.periods.map(p => [p.short, fmtAmt(cf.data.get('cf.capex', p.id), F.unit), fmtAmt(cf.data.get('cf.ppe_sale', p.id), F.unit)])} />}</Card>
    </div>
    {ipo && <Card title="IPO proceeds utilisation (as disclosed in the results)"><div style={{ ...S.small, marginBottom: 6 }}>{ipo.text.slice(0, 400)}…</div>
      <T head={['Object', 'Per prospectus', 'Utilised', 'Unutilised']} num={[1, 2, 3]} rows={ipo.table.filter(t => t.values.length >= 2).map(t => [t.label, ...t.values.slice(0, 3).map(v => fmtAmt(v.v, F.unit))])} /></Card>}
    <Card title="Projects: budget, commitments and payments">{!capex.length ? <Note tone="warn">No capex budgets entered (Management Inputs → Capex budgets, commitments & payments).</Note> :
      <T head={['Project / centre', 'As at', 'Budget', 'Committed', 'Paid', 'Paid % of budget', 'Expected opening', 'Seats']} num={[2, 3, 4, 5, 7]} rows={capex.map(r => [r.values.project, r.values.periodEnd, fmtAmt(r.values.budget, F.unit), fmtAmt(r.values.committed, F.unit), fmtAmt(r.values.paid, F.unit), r.values.budget ? fmtVal(r.values.paid / r.values.budget, 'fraction') : '', r.values.expectedOpening || '—', r.values.seats != null ? fmtVal(r.values.seats, 'nos') : '—'])} />}</Card>
  </div>;
}

// ── Client & Revenue Analytics ───────────────────────────────────────────────
export function ClientTab({ F }) {
  const top = useLoad(() => api.topClients().catch(() => null), []);
  const cat = useLoad(() => api.revenueByCategory().catch(() => null), []);
  const inp = useInputs();
  const cr = (inp.data?.records || []).filter(r => r.type === 'client_revenue');
  const list = Array.isArray(top.data) ? top.data : [];
  const cats = cat.data?.all_time || [];
  // denominator: all invoiced revenue of the year (every category), not just the ten largest clients
  const tot = cats.reduce((t, c) => t + (c.revenue || 0), 0);
  const share = n => (tot && list.length ? list.slice(0, n).reduce((t, c) => t + c.revenue, 0) / tot : null);
  // retention from client revenue inputs: clients in both of the two latest periods
  const pers = [...new Set(cr.map(r => r.periodEnd))].sort();
  const [p0, p1] = pers.slice(-2);
  const by = p => Object.fromEntries(cr.filter(r => r.periodEnd === p).map(r => [r.values.client, r.values.revenue]));
  const a = p0 ? by(p0) : {}, b = p1 ? by(p1) : {};
  const kept = Object.keys(a).filter(k => b[k] != null);
  return <div>
    <MissingInputs report="Client & Revenue Analytics" coverage={inp.data?.coverage} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
      <Card title="Client concentration (Sales module, current financial year)">
        {top.loading ? <Loading /> : !list.length ? <Note tone="warn">Not available from the Sales module just now.</Note> : <>
          {!tot && <Note tone="warn">Total invoiced revenue is not available, so shares cannot be computed.</Note>}<div style={{ display: 'flex', gap: 18, marginBottom: 8, fontSize: '0.82rem' }}><div>Top client: <b>{fmtVal(share(1), 'fraction')}</b></div><div>Top 5: <b>{fmtVal(share(5), 'fraction')}</b></div><div>Top 10: <b>{fmtVal(share(10), 'fraction')}</b></div></div>
          <T head={['Client', `Invoiced (${unitLabel(F.unit)})`, 'Share', 'Outstanding']} num={[1, 2, 3]} rows={list.slice(0, 15).map(c => [c.customer_name, fmtAmt(rsToLakh(c.revenue), F.unit), tot ? fmtVal(c.revenue / tot, 'fraction') : '', fmtAmt(rsToLakh(c.outstanding), F.unit)])} />
          {live('Sales module (invoices of the current financial year, before GST)')}</>}
      </Card>
      <Card title="Revenue by category (Sales module, current financial year)">{cat.loading ? <Loading /> : !cats.length ? <Note tone="warn">Not available just now.</Note> : <><T head={['Category', `Revenue (${unitLabel(F.unit)})`, 'Share']} num={[1, 2]} rows={cats.slice(0, 20).map(c => [c.category || c.name || c.label, fmtAmt(rsToLakh(c.revenue), F.unit), tot ? fmtVal(c.revenue / tot, 'fraction') : ''])} />{live('Sales module (invoices, before GST)')}</>}</Card>
    </div>
    <Card title="Retention and churn (client revenue inputs)">
      {pers.length < 2 ? <Note tone="warn">Needs client-level revenue for at least two periods (Management Inputs → Client cohorts & revenue). Retention and churn are never inferred from statement totals.</Note> : <>
        <div style={{ display: 'flex', gap: 18, fontSize: '0.82rem', marginBottom: 8 }}>
          <div>Logo retention {p0} → {p1}: <b>{fmtVal(kept.length / Object.keys(a).length, 'fraction')}</b></div>
          <div>Logo churn: <b>{fmtVal(1 - kept.length / Object.keys(a).length, 'fraction')}</b></div>
          <div>Net revenue retention: <b>{fmtVal(kept.reduce((t, k) => t + b[k], 0) / Object.values(a).reduce((t, v) => t + v, 0), 'fraction')}</b></div>
          <div>New clients in {p1}: <b>{Object.keys(b).filter(k => a[k] == null).length}</b></div>
        </div>
        <div style={S.small}>Logo retention = clients billed in both periods ÷ clients billed in {p0}. Net revenue retention = {p1} revenue from those clients ÷ {p0} revenue from all {p0} clients.</div></>}
    </Card>
  </div>;
}

// ── Compliance & Controls ────────────────────────────────────────────────────
export function ComplianceTab({ F, goTab }) {
  const per = useLoad(() => fsApi.periods(F.basis, F.mode).catch(() => null), [F.basis]);
  const fy = F.fy || (per.data ? Math.max(...per.data.PL.available.map(p => p.fy)) : null);
  const fyLabel = fy ? `${fy - 1}-${String(fy).slice(2)}` : null;
  const comp = useLoad(() => (fyLabel ? axios.get('/api/compliance/dashboard', { params: { fy: fyLabel } }).then(r => r.data).catch(e => ({ error: e?.response?.data?.error || e.message })) : Promise.resolve(null)), [fyLabel]);
  const rec = useLoad(() => fsApi.recon(F.mode).catch(() => null), [F.mode]);
  const k = comp.data?.kpis;
  return <div>
    <Note>Statutory compliance status comes only from the Compliance Dashboard's task tracker. Where it has no tasks, the status is unknown — it is never shown as compliant. GST, TDS, MSME and related-party status are in their own modules.</Note>
    <Card title={`Compliance tasks FY${fyLabel || ''} (Compliance Dashboard)`}>
      {comp.loading ? <Loading /> : comp.data?.error ? <Note tone="warn">Not available: {comp.data.error}</Note> : !k || k.total === 0 ? <Note tone="warn">No compliance tasks exist for this year — status unknown.</Note> : <>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: '0.82rem', marginBottom: 8 }}><div>Applicable: <b>{k.applicable}</b></div><div>Completed: <b>{k.completed}</b> ({k.compliance_pct}%)</div><div style={{ color: k.overdue ? C.bad : C.ink }}>Overdue: <b>{k.overdue}</b></div><div>Due soon: <b>{k.due_soon}</b></div><div>Not started: <b>{k.not_started}</b></div></div>
        {comp.data.overdue?.length > 0 && <T head={['Overdue task', 'Company', 'Due', 'Responsible']} rows={comp.data.rows.filter(r => comp.data.overdue.includes(r.task_id)).slice(0, 25).map(r => [r.compliance_name || r.task_id, r.company_short || r.company_name, r.due_date, r.responsible || '—'])} />}</>}
    </Card>
    <Card title="Financial reporting controls" right={<button style={S.btn('outline')} onClick={() => goTab('validation')}>Open validation</button>}>
      {rec.loading ? <Loading /> : !rec.data ? <Note tone="warn">No import yet.</Note> : <T head={['Control', 'Result']} rows={[
        ['Statement arithmetic and cross-checks', Object.entries(rec.data.summary).map(([s, n]) => `${s}: ${n}`).join(' · ')],
        ['Material conflicts between source workbooks awaiting a decision', rec.data.decisions.length],
        ['Excel errors in imported figures (kept as errors)', rec.data.rows.filter(r => r.check === 'Source exception' && /excel error/i.test(r.particulars)).length],
        ['Unreconciled checks', rec.data.rows.filter(r => r.status === 'Unreconciled').length],
        ['Recorded decisions', Object.keys(rec.data.recorded || {}).length],
      ]} />}
    </Card>
  </div>;
}
