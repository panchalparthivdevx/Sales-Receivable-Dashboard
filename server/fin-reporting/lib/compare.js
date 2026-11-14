/**
 * Financial Reporting — period comparisons (April–March financial year).
 *
 * Each comparison row: current | comparator | absolute change | change % | common-size % (of revenue from operations) |
 * margin movement (percentage points and basis points, for margin rows) | interpretation.
 *
 * Change % on a zero, missing or negative base is never shown as a plain percentage:
 *   zero base → "n/m (zero base)"; profit → loss / loss → profit are named as such; loss → smaller/larger loss is
 *   measured against the absolute size of the loss and says "loss narrowed / widened".
 * Interpretation states only the confirmed movement in numbers; where note schedules exist for both periods the largest
 * movements inside the note are listed as contributors. Anything that would be an explanation is worded as a question
 * to investigate, never as a fact.
 */

'use strict';

const P = require('./periods');
const L = require('./lines');
const M = require('./model');

// Lines compared, and lines computed from them (company definition of EBITDA: PBT + finance costs + D&A, as in the
// company's SEBI ratio working)
const PL_ROWS = [
  { id: 'pl.rev', kind: 'income' }, { id: 'pl.oth_inc', kind: 'income' }, { id: 'pl.tot_inc', kind: 'income', bold: true },
  { id: 'pl.exp_ops', kind: 'cost' }, { id: 'pl.exp_emp', kind: 'cost' }, { id: 'pl.exp_oth', kind: 'cost' },
  { id: 'm.ebitda', kind: 'profit', bold: true, label: 'EBITDA (PBT + finance costs + D&A)', calc: g => sum(g('pl.pbt'), g('pl.exp_fin'), g('pl.exp_dep')) },
  { id: 'm.op_ebitda', kind: 'profit', label: 'Operating EBITDA (EBITDA − other income)', calc: g => sum(g('pl.pbt'), g('pl.exp_fin'), g('pl.exp_dep'), neg(g('pl.oth_inc'))) },
  { id: 'pl.exp_fin', kind: 'cost' }, { id: 'pl.exp_dep', kind: 'cost' }, { id: 'pl.exp_tot', kind: 'cost', bold: true },
  { id: 'pl.exceptional', kind: 'cost' }, { id: 'pl.share_assoc', kind: 'income', cons: true },
  { id: 'pl.pbt', kind: 'profit', bold: true }, { id: 'pl.tax_tot', kind: 'cost' }, { id: 'pl.pat', kind: 'profit', bold: true },
  { id: 'pl.pat_owners', kind: 'profit', cons: true }, { id: 'pl.oci_tot', kind: 'profit' }, { id: 'pl.tci', kind: 'profit', bold: true },
  { id: 'pl.eps_basic', kind: 'eps' }, { id: 'pl.eps_diluted', kind: 'eps' },
  { id: 'm.ebitda_m', kind: 'margin', label: 'EBITDA margin', calc: g => ratio(sum(g('pl.pbt'), g('pl.exp_fin'), g('pl.exp_dep')), g('pl.rev')) },
  { id: 'm.op_ebitda_m', kind: 'margin', label: 'Operating EBITDA margin (= SEBI "operating margin")', calc: g => ratio(sum(g('pl.pbt'), g('pl.exp_fin'), g('pl.exp_dep'), neg(g('pl.oth_inc'))), g('pl.rev')) },
  { id: 'm.pbt_m', kind: 'margin', label: 'PBT margin', calc: g => ratio(g('pl.pbt'), g('pl.rev')) },
  { id: 'm.pat_m', kind: 'margin', label: 'PAT margin (= SEBI "net profit margin")', calc: g => ratio(g('pl.pat'), g('pl.rev')) },
  { id: 'm.etr', kind: 'margin', label: 'Effective tax rate (total tax ÷ PBT)', calc: g => ratio(g('pl.tax_tot'), g('pl.pbt')) },
];
const sum = (...xs) => (xs.some(x => x == null) ? null : xs.reduce((s, x) => s + x, 0));
const neg = x => (x == null ? null : -x);
const ratio = (a, b) => (a == null || b == null || b === 0 ? null : a / b);

function pctChange(cur, cmp, kind) {
  if (cur == null || cmp == null) return { pct: null, note: 'not available' };
  if (cmp === 0) return { pct: null, note: cur === 0 ? 'no change (both nil)' : 'n/m (zero base)' };
  if (kind === 'profit' || kind === 'income' || kind === 'eps') {
    if (cmp < 0 && cur >= 0) return { pct: null, note: 'loss → profit' };
    if (cmp > 0 && cur < 0) return { pct: null, note: 'profit → loss' };
    if (cmp < 0 && cur < 0) return { pct: (cur - cmp) / Math.abs(cmp), note: cur > cmp ? 'loss narrowed' : 'loss widened' };
  }
  if (kind === 'cost' && (cmp < 0) !== (cur < 0)) return { pct: null, note: cmp < 0 ? 'credit → charge' : 'charge → credit' };
  if (kind === 'cost' && cmp < 0 && cur < 0) return { pct: null, note: 'credit in both periods' };
  return { pct: (cur - cmp) / Math.abs(cmp), note: null };
}

/** Compare two periods of one basis */
function compare(ctx, b, cur, cmp, opts = {}) {
  const getter = p => id => M.num(M.cell(ctx, b, id, p));
  const gc = getter(cur), gp = getter(cmp);
  const revC = gc('pl.rev'), revP = gp('pl.rev');
  const rows = [];
  for (const r of PL_ROWS) {
    if (r.cons && b !== 'CO') continue;
    const cellC = r.calc ? null : M.cell(ctx, b, r.id, cur), cellP = r.calc ? null : M.cell(ctx, b, r.id, cmp);
    const vc = r.calc ? r.calc(gc) : M.num(cellC), vp = r.calc ? r.calc(gp) : M.num(cellP);
    const label = r.label || L.BY_ID[r.id]?.label || r.id;
    const row = { id: r.id, label, kind: r.kind, bold: !!r.bold, cur: vc, cmp: vp, unit: r.kind === 'margin' ? 'fraction' : r.kind === 'eps' ? 'inr' : 'lakh' };
    if (cellC) row.curSrc = srcOf(cellC); if (cellP) row.cmpSrc = srcOf(cellP);
    if (r.kind === 'margin') {
      row.abs = vc != null && vp != null ? vc - vp : null;              // fraction points
      row.pp = row.abs == null ? null : row.abs * 100; row.bps = row.abs == null ? null : Math.round(row.abs * 10000);
      row.pctNote = row.abs == null ? 'not available' : null;
      if (r.id === 'm.etr' && ((vc != null && (vc < 0 || vc > 1)) || (vp != null && (vp < 0 || vp > 1)))) { row.pctNote = 'n/m (tax credit or loss)'; row.pp = null; row.bps = null; }
    } else {
      row.abs = vc != null && vp != null ? vc - vp : null;
      const pc = pctChange(vc, vp, r.kind);
      row.pct = pc.pct; row.pctNote = pc.note;
      if (r.kind !== 'eps') { row.csCur = ratio(vc, revC); row.csCmp = ratio(vp, revP); row.csMove = row.csCur != null && row.csCmp != null ? (row.csCur - row.csCmp) * 100 : null; }
    }
    if (r.kind === 'eps' && ((cellC?.fact?.der) || (cellP?.fact?.der))) row.warn = 'One of these EPS figures was derived in the workbook by subtracting cumulative EPS, which is not additive.';
    if (cellC?.derived || cellP?.derived) row.derived = [cellC?.derived, cellP?.derived].filter(Boolean).map(d => d.formula).join('; ');
    row.interpretation = interpret(row, r, opts);
    rows.push(row);
  }
  const drivers = opts.notes === false ? [] : noteDrivers(ctx, b, cur, cmp);
  return { basis: b, current: P.fromId(cur), comparator: P.fromId(cmp), rows, drivers, commentary: commentary(rows, P.fromId(cur), P.fromId(cmp), drivers) };
}

function srcOf(c) {
  if (c.derived) return { derived: c.derived.formula };
  if (!c.fact) return null;
  return { f: c.fact.f, sh: c.fact.sh, c: c.fact.c, role: c.fact.role };
}

const L2 = v => (v == null ? '—' : `₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} lakh`);
function interpret(row, r) {
  if (row.cur == null || row.cmp == null) return 'Not comparable — one period is not available.';
  if (r.kind === 'margin' && row.pp == null) return row.pctNote || 'Not meaningful.';
  if (r.kind === 'margin') return `${row.pp >= 0 ? 'Up' : 'Down'} ${Math.abs(row.pp).toFixed(2)} pp (${row.bps >= 0 ? '+' : ''}${row.bps} bps).`;
  if (r.kind === 'eps') return `${row.abs >= 0 ? 'Up' : 'Down'} ₹${Math.abs(row.abs).toFixed(4)} per share${row.pctNote ? ` (${row.pctNote})` : row.pct != null ? ` (${(row.pct * 100).toFixed(1)}%)` : ''}. EPS is compared as reported, never re-derived.`;
  const dir = row.abs > 0 ? 'up' : row.abs < 0 ? 'down' : 'unchanged';
  let t = `${dir === 'unchanged' ? 'Unchanged' : `${dir === 'up' ? 'Up' : 'Down'} ${L2(row.abs)}`}${row.pctNote ? ` (${row.pctNote})` : row.pct != null ? ` (${row.pct >= 0 ? '+' : ''}${(row.pct * 100).toFixed(1)}%)` : ''}.`;
  if (r.kind === 'cost' && row.csMove != null && Math.abs(row.csMove) >= 0.5) t += ` ${row.csMove > 0 ? 'Rose' : 'Fell'} ${Math.abs(row.csMove).toFixed(1)} pp as a share of revenue.`;
  return t;
}

/** Largest item movements inside the note schedules behind the P&L lines, where both periods are in the notes */
function noteDrivers(ctx, b, cur, cmp) {
  const out = [];
  const lines = ['pl.rev', 'pl.oth_inc', 'pl.exp_ops', 'pl.exp_emp', 'pl.exp_fin', 'pl.exp_dep', 'pl.exp_oth'];
  for (const l of lines) {
    const ni = noteItems(ctx, b, l, [cur, cmp]);
    if (!ni) continue;
    const moves = ni.items.filter(it => it.v[cur] != null && it.v[cmp] != null).map(it => ({ label: it.label, cur: it.v[cur], cmp: it.v[cmp], abs: it.v[cur] - it.v[cmp] }))
      .filter(x => Math.abs(x.abs) >= 0.005).sort((a, c) => Math.abs(c.abs) - Math.abs(a.abs)).slice(0, 4);
    if (moves.length) out.push({ line: l, label: L.BY_ID[l].label, note: ni.note, moves });
  }
  return out;
}

/**
 * Items of the note behind a statement line for given periods: one note per period chosen by the same priority as the
 * statements (primary column of the workbook prepared for the period first). Returns { note, items:[{label,key,v:{p:v}}] }.
 */
function noteItems(ctx, b, lineId, periods) {
  const notes = ctx.ix.version.notes.filter(n => n.b === b && n.lines?.includes(lineId) && !n.hid);
  if (!notes.length) return null;
  const byKey = new Map();
  let used = null;
  for (const p of periods) {
    const cands = [];
    for (const n of notes) for (const it of n.items) if (it.v[p] && !it.total && !it.subhead) cands.push({ n, it, cell: it.v[p] });
    if (!cands.length) continue;
    // one note per period: the note whose column for p ranks best
    const rank = n => { const any = n.items.find(i => i.v[p])?.v[p]; const role = any?.role; return (role === 'primary' ? 300 : role === 'comparative' ? 200 : 0) - (Number((ctx.ix.fileDate[n.f] || '0').replace(/-/g, '')) / 1e8) * (ctx.mode === 'latest' ? -10 : 10); };
    const best = [...new Set(cands.map(c => c.n))].sort((x, y) => rank(y) - rank(x))[0];
    used = used || best;
    for (const c of cands.filter(c => c.n === best)) {
      const k = c.it.key;
      if (!byKey.has(k)) byKey.set(k, { label: c.it.label, key: k, v: {}, src: {} });
      const e = byKey.get(k);
      e.v[p] = c.cell.st === 'ok' ? (e.v[p] || 0) + c.cell.v : e.v[p] ?? null;
      e.src[p] = `${ctx.ix.version.files[best.f]?.name} › ${best.sheet}!${c.cell.c}`;
    }
  }
  if (!used) return null;
  return { note: { num: used.num, title: used.title, f: used.f, sheet: used.sheet }, items: [...byKey.values()] };
}

function commentary(rows, cur, cmp, drivers) {
  const g = id => rows.find(r => r.id === id);
  const confirmed = [];
  const investigate = [];
  const rev = g('pl.rev'), ebitda = g('m.ebitda'), pat = g('pl.pat'), em = g('m.ebitda_m'), oi = g('pl.oth_inc');
  if (rev?.abs != null) confirmed.push(`Revenue from operations ${rev.interpretation.replace(/\.$/, '')} (${cur.short} vs ${cmp.short}).`);
  if (ebitda?.abs != null) confirmed.push(`EBITDA ${ebitda.interpretation.replace(/\.$/, '')}; EBITDA margin ${em?.interpretation || ''}`);
  if (pat?.abs != null) confirmed.push(`Profit for the period ${pat.interpretation}`);
  for (const r of rows.filter(r => r.kind === 'cost' && !['pl.exp_tot', 'pl.tax_tot', 'pl.exceptional'].includes(r.id) && r.csMove != null && Math.abs(r.csMove) >= 3).sort((a, b) => Math.abs(b.csMove) - Math.abs(a.csMove)).slice(0, 3)) investigate.push(`${r.label} moved ${r.csMove > 0 ? '+' : ''}${r.csMove.toFixed(1)} pp of revenue — is this a run-rate change or timing / one-off?`);
  if (oi?.pct != null && Math.abs(oi.pct) > 0.5 && Math.abs(oi.abs) > 25) investigate.push(`Other income changed ${(oi.pct * 100).toFixed(0)}% (${L2(oi.abs)}) — check whether one-off gains (investment sales, fair-value changes, interest) explain it before reading through to profit.`);
  for (const d of drivers.slice(0, 3)) investigate.push(`${d.label}: largest moves in note ${d.note.num} — ${d.moves.slice(0, 2).map(m => `${m.label} ${m.abs >= 0 ? '+' : '−'}${L2(m.abs).replace('₹', '₹')}`).join('; ')}. Confirm the reason with the ledger.`);
  if (cur.type !== cmp.type) investigate.push(`The two periods are of different lengths (${cur.days} vs ${cmp.days} days); compare rates, not totals.`);
  return { confirmed, investigate };
}

/** Standard comparison sets for a basis, with availability and what is missing */
function presets(ctx, b) {
  const avail = new Map(M.periodsFor(ctx.ix, b, 'PL').map(p => [p.id, p.availability]));
  const has = p => avail.has(p);
  const latestQ = [...avail.keys()].filter(p => P.fromId(p).type === 'Q').sort(P.cmp).pop();
  const latestH = [...avail.keys()].filter(p => P.fromId(p).type === 'H').sort(P.cmp).pop();
  const latestFY = [...avail.keys()].filter(p => P.fromId(p).type === 'FY').sort(P.cmp).pop();
  const prevQ = p => { const x = P.fromId(p); return x.q === 1 ? `FY${x.fy - 1}-Q4` : `FY${x.fy}-Q${x.q - 1}`; };
  const yoy = p => p.replace(/^FY(\d{4})/, (m, y) => `FY${+y - 1}`);
  const prevH = p => { const x = P.fromId(p); return x.h === 1 ? `FY${x.fy - 1}-H2` : `FY${x.fy}-H1`; };
  const out = [];
  const mk = (group, title, cur, cmp) => out.push({ group, title, cur, cmp, ok: has(cur) && has(cmp), curAvail: avail.get(cur) || 'missing', cmpAvail: avail.get(cmp) || 'missing', missing: [cur, cmp].filter(p => !has(p)).map(p => missingText(p, b)) });
  for (const q of [...avail.keys()].filter(p => P.fromId(p).type === 'Q').sort(P.cmp).reverse().slice(0, 4)) {
    mk('Quarter', `${P.fromId(q).short} vs previous quarter (${P.fromId(prevQ(q)).short})`, q, prevQ(q));
    mk('Quarter', `${P.fromId(q).short} vs same quarter last year (${P.fromId(yoy(q)).short})`, q, yoy(q));
  }
  for (const h of [...avail.keys()].filter(p => P.fromId(p).type === 'H').sort(P.cmp).reverse().slice(0, 3)) {
    mk('Half year', `${P.fromId(h).short} vs prior-year ${P.fromId(yoy(h)).short}`, h, yoy(h));
    mk('Half year', `${P.fromId(h).short} vs preceding ${P.fromId(prevH(h)).short}`, h, prevH(h));
  }
  if (latestFY) mk('Annual', `${P.fromId(latestFY).short} vs ${P.fromId(yoy(latestFY)).short}`, latestFY, yoy(latestFY));
  if (latestH) { const x = P.fromId(latestH); if (x.h === 1) mk('YTD', `YTD Apr–Sep ${P.fyLabel(x.fy)} vs YTD Apr–Sep ${P.fyLabel(x.fy - 1)}`, latestH, yoy(latestH)); }
  void latestQ;
  return out;
}

/** Three-year views: completed years, same quarter, same half — with the missing-data checklist */
function threeYear(ctx, b, opts = {}) {
  const avail = new Map(M.periodsFor(ctx.ix, b, 'PL').map(p => [p.id, p.availability]));
  const latestFY = opts.fy || Math.max(...[...avail.keys()].filter(p => P.fromId(p).type === 'FY').map(p => P.fromId(p).fy));
  const series = (ids) => ({ periods: ids.map(id => ({ ...P.fromId(id), availability: avail.get(id) || 'missing' })), rows: PL_ROWS.filter(r => !(r.cons && b !== 'CO')).map(r => ({ id: r.id, label: r.label || L.BY_ID[r.id]?.label, kind: r.kind, bold: !!r.bold,
    values: ids.map(id => { if (!avail.has(id)) return null; const g = x => M.num(M.cell(ctx, b, x, id)); return r.calc ? r.calc(g) : g(r.id); }) })),
  missing: ids.filter(id => !avail.has(id)).map(id => missingText(id, b)) });
  const fys = [latestFY - 2, latestFY - 1, latestFY];
  const q = opts.quarter || 1, h = opts.half || 1;
  const latestQfy = Math.max(...[...avail.keys()].filter(p => P.fromId(p).type === 'Q' && P.fromId(p).q === q).map(p => P.fromId(p).fy), latestFY);
  const latestHfy = Math.max(...[...avail.keys()].filter(p => P.fromId(p).type === 'H' && P.fromId(p).h === h).map(p => P.fromId(p).fy), latestFY);
  return {
    years: series(fys.map(fy => `FY${fy}-FY`)),
    quarter: series([latestQfy - 2, latestQfy - 1, latestQfy].map(fy => `FY${fy}-Q${q}`)),
    half: series([latestHfy - 2, latestHfy - 1, latestHfy].map(fy => `FY${fy}-H${h}`)),
  };
}

function missingText(id, b) {
  const p = P.fromId(id);
  if (!p) return id;
  const basis = b === 'CO' ? 'consolidated' : 'standalone';
  const what = p.type === 'Q' ? `the ${basis} results for the quarter ended ${p.headerDate}` : p.type === 'H' ? `the ${basis} results for the half year ended ${p.headerDate}` : p.type === '9M' ? `the ${basis} results for the nine months ended ${p.headerDate}` : `the ${basis} annual financial statements for the year ended ${p.headerDate}`;
  return `${p.short} (${p.label}) — not in the imported workbooks and not derivable; needs ${what} (or the workbook that carries it as a comparative).`;
}

module.exports = { compare, presets, threeYear, noteItems, pctChange, PL_ROWS };
