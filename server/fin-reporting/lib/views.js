/**
 * Financial Reporting — assembled views: notes to accounts, CFO overview (statement-based part), trends, alerts.
 *
 * Notes are matched to statement lines by meaning (the line each note supports), not by note number — numbering differs
 * between workbooks. Each period's figures come from the note of the workbook chosen for that period by the same priority
 * as the statements; the source note number and cell are kept on every figure.
 *
 * Alerts: a metric is "Within threshold" only when its value is available AND a threshold has been set. Missing data is
 * "Missing data", an unset threshold is "No threshold set" — never a green "healthy".
 */

'use strict';

const P = require('./periods');
const L = require('./lines');
const M = require('./model');
const RA = require('./ratios');

const ORDER = [...L.BS, ...L.PL].map(l => l.id);

function noteRank(ctx, n, p) {
  const any = n.items.find(i => i.v[p])?.v[p];
  const role = any?.role;
  const date = Number((ctx.ix.fileDate[n.f] || '0').replace(/-/g, '')) / 1e8;
  return (role === 'primary' ? 300 : role === 'comparative' ? 200 : 0) + (ctx.mode === 'latest' ? date * 100 : -date * 10) - (n.hid ? 100 : 0);
}

function notesView(ctx, b, periodIds) {
  const notes = ctx.ix.version.notes.filter(n => n.b === b);
  const linked = notes.filter(n => n.lines?.length);
  const lineIds = [...new Set(linked.flatMap(n => n.lines))].sort((a, c) => ORDER.indexOf(a) - ORDER.indexOf(c));
  const groups = [];
  const seenLineSets = new Set();
  for (const l of lineIds) {
    const cands = linked.filter(n => n.lines.includes(l));
    const setKey = [...new Set(cands.flatMap(n => n.lines))].sort().join('+');
    if (seenLineSets.has(setKey + '|' + cands.map(n => n.title).join())) continue;
    seenLineSets.add(setKey + '|' + cands.map(n => n.title).join());
    const chosen = {};
    for (const p of periodIds) {
      const withP = cands.filter(n => n.items.some(i => i.v[p]));
      if (withP.length) chosen[p] = withP.sort((x, y) => noteRank(ctx, y, p) - noteRank(ctx, x, p))[0];
    }
    if (!Object.keys(chosen).length) continue;
    const primaryNote = Object.values(chosen)[0];
    const rows = [];
    const keyIndex = new Map();
    const addRow = (it) => { const k = `${it.key}|${it.total ? 'T' : it.subhead ? 'S' : 'I'}`; if (!keyIndex.has(k)) { keyIndex.set(k, rows.length); rows.push({ label: it.label, key: it.key, total: !!it.total, subhead: !!it.subhead, cells: {} }); } return rows[keyIndex.get(k)]; };
    for (const it of primaryNote.items) addRow(it);
    for (const [p, n] of Object.entries(chosen)) {
      for (const it of n.items) {
        const row = addRow(it);
        const c = it.v[p];
        if (c) row.cells[p] = { v: c.st === 'ok' || c.st === 'dash' ? c.v : null, st: c.st, err: c.err, src: { f: n.f, sh: n.sheet, c: c.c, note: n.num, fx: c.fx } };
      }
    }
    const stmtCells = {};
    for (const p of periodIds) {
      const cs = [...new Set(cands.flatMap(n => n.lines))].map(id => M.cell(ctx, b, id, p));
      const vals = cs.map(M.num);
      stmtCells[p] = vals.some(v => v != null) ? vals.reduce((s, v) => s + (v || 0), 0) : null;
    }
    groups.push({ lines: [...new Set(cands.flatMap(n => n.lines))], lineLabel: [...new Set(cands.flatMap(n => n.lines))].map(id => L.BY_ID[id]?.label || id).join(' + '), title: primaryNote.title,
      sourceNotes: Object.fromEntries(Object.entries(chosen).map(([p, n]) => [p, { num: n.num, f: n.f, sheet: n.sheet, file: ctx.ix.version.files[n.f]?.name }])), rows: rows.filter(r => r.subhead || Object.keys(r.cells).length), statement: stmtCells,
      text: primaryNote.text });
  }
  // notes not tied to a statement line (disclosures, sub-schedules) from the latest workbook of this basis
  const latestF = [...new Set(notes.map(n => n.f))].sort((a, c) => (ctx.ix.fileDate[c] || '').localeCompare(ctx.ix.fileDate[a] || ''))[0];
  const other = notes.filter(n => !n.lines?.length && n.f === latestF && !n.hid).map(n => ({ num: n.num, title: n.title, sheet: n.sheet, f: n.f, periods: n.periods, items: n.items.slice(0, 80), text: n.text }));
  const narrative = ctx.ix.version.narrative.filter(nn => nn.b === b && nn.f === latestF);
  return { basis: b, periods: periodIds.map(P.fromId), groups, other, narrative, narrativeFile: ctx.ix.version.files[latestF]?.name };
}

// ── CFO overview (statement-based) ──────────────────────────────────────────
function comparatorOf(p) {
  const x = P.fromId(p);
  if (x.type === 'Q') return { qoq: x.q === 1 ? `FY${x.fy - 1}-Q4` : `FY${x.fy}-Q${x.q - 1}`, yoy: `FY${x.fy - 1}-Q${x.q}` };
  return { yoy: p.replace(/^FY(\d{4})/, (m, y) => `FY${+y - 1}`) };
}

function cfo(ctx, b, p, inputs = {}, extras = {}) {
  const per = P.fromId(p);
  const r = RA.compute(ctx, b, p, inputs).values;
  const cmp = comparatorOf(p);
  const rc = cmp.yoy ? RA.compute(ctx, b, cmp.yoy, inputs).values : {};
  const rq = cmp.qoq ? RA.compute(ctx, b, cmp.qoq, inputs).values : null;
  const line = (id, pid) => M.cell(ctx, b, id, pid);
  const kv = (id, label, unit, cur, prev, prevQ, drill) => ({ id, label, unit, v: cur?.v ?? null, status: cur?.status || (cur?.v == null ? 'Missing Input' : 'OK'), note: cur?.note,
    yoy: prev?.v ?? null, qoq: prevQ?.v ?? null, drill });
  const lineK = (id, label) => { const c = line(id, p); return kv(id, label, 'lakh', { v: M.num(c), status: c.st === 'missing' ? 'Missing Input' : c.derived ? 'Derived' : 'OK', note: c.derived ? `derived: ${c.derived.formula}` : null }, { v: cmp.yoy ? M.num(line(id, cmp.yoy)) : null }, cmp.qoq ? { v: M.num(line(id, cmp.qoq)) } : null, { kind: 'line', line: id }); };
  const ratioK = (id, label, unit) => kv(id, label, unit, r[id], rc[id], rq ? rq[id] : null, { kind: 'ratio', ratio: id });
  const kpis = [
    lineK('pl.rev', 'Revenue from operations'), ratioK('prof.ebitda', 'EBITDA', 'lakh'), ratioK('prof.ebitda_m', 'EBITDA margin', 'fraction'),
    lineK('pl.pbt', 'Profit before tax'), lineK('pl.pat', 'Profit after tax'), ratioK('prof.pat_m', 'PAT margin', 'fraction'),
    stockK(ctx, b, p, 'cash', 'Cash, bank & liquid investments', ['bs.cash', 'bs.obank', 'bs.c_inv']), ratioK('lev.debt', 'Borrowings (excl. leases)', 'lakh'),
    ratioK('lev.net_debt', 'Net debt (excl. leases)', 'lakh'), ratioK('lev.net_debt_l', 'Net debt incl. leases', 'lakh'),
    stockK(ctx, b, p, 'rec', 'Trade receivables', ['bs.tr']), stockK(ctx, b, p, 'pay', 'Trade payables', ['bs.cl_tp_msme', 'bs.cl_tp_other']),
    ratioK('wc.dso', 'DSO (days)', 'days'), ratioK('wc.dpo', 'DPO (days, proxy)', 'days'),
  ];
  // balance-sheet KPIs: also compared with the latest earlier balance-sheet date (there is no balance sheet for every comparator)
  const bsDates = M.periodsFor(ctx.ix, b, 'BS').filter(x => x.availability === 'reported' && x.end < per.end).sort(P.cmp);
  const prior = bsDates[bsDates.length - 1];
  if (prior) {
    const rp = RA.compute(ctx, b, prior.id, inputs).values;
    for (const k of kpis) {
      if (k.drill?.kind === 'bs') { const vs = k.drill.lines.map(id => M.num(M.cell(ctx, b, id, prior.id))); k.prior = vs.every(x => x == null) ? null : vs.reduce((s, x) => s + (x || 0), 0); k.priorLabel = prior.short; }
      if (['lev.debt', 'lev.net_debt', 'lev.net_debt_l'].includes(k.drill?.ratio)) { k.prior = rp[k.drill.ratio]?.v ?? null; k.priorLabel = prior.short; }
    }
  }
  const alerts = evaluateAlerts(r, inputs.settings?.alerts || {});
  return { basis: b, period: per, comparators: { yoy: cmp.yoy ? P.fromId(cmp.yoy) : null, qoq: cmp.qoq ? P.fromId(cmp.qoq) : null }, kpis, alerts, trends: trends(ctx, b), ratios: r, dataQuality: extras.dataQuality || null };
}

function stockK(ctx, b, p, id, label, ids) {
  const per = P.fromId(p);
  const at = d => { const cs = ids.map(x => M.cell(ctx, b, x, `BS-${d}`)); const vs = cs.map(M.num); return vs.every(v => v == null) ? null : vs.reduce((s, v) => s + (v || 0), 0); };
  const cur = at(per.end);
  const prevEnd = P.fromId(comparatorOf(p).yoy)?.end;
  return { id, label, unit: 'lakh', v: cur, status: cur == null ? 'Missing Input' : 'OK', note: cur == null ? `balance sheet as at ${per.end} not available` : null, yoy: prevEnd ? at(prevEnd) : null, qoq: null, drill: { kind: 'bs', lines: ids, at: `BS-${per.end}` } };
}

/** Revenue / EBITDA / PAT by quarter and by year (reported, else derived and labelled) */
function trends(ctx, b) {
  const all = M.periodsFor(ctx.ix, b, 'PL');
  const pick = (type) => all.filter(x => x.type === type && x.availability !== 'working').sort(P.cmp);
  const row = x => {
    const g = id => M.cell(ctx, b, id, x.id);
    const rev = g('pl.rev'), pbt = g('pl.pbt'), fin = g('pl.exp_fin'), dep = g('pl.exp_dep'), pat = g('pl.pat');
    const e = [pbt, fin, dep].map(M.num);
    return { p: x.id, short: x.short, availability: x.availability, rev: M.num(rev), ebitda: e.some(v => v == null) ? null : e[0] + e[1] + e[2], pat: M.num(pat), derived: [rev, pbt, pat].some(c => c.derived) };
  };
  return { quarterly: pick('Q').map(row), half: pick('H').map(row), annual: pick('FY').map(row) };
}

function evaluateAlerts(values, alerts) {
  const out = [];
  const label = id => RA.dictionary().find(d => d.id === id)?.name || id;
  const watched = new Set([...Object.keys(alerts), 'liq.cr', 'lev.de', 'lev.nd_ebitda_l', 'cov.iscr', 'cov.dscr_ebitda', 'wc.dso', 'prof.ebitda_m', 'prof.pat_m', 'unit.occupancy', 'cov.dscr_lender']);
  for (const id of watched) {
    const v = values[id];
    const t = alerts[id];
    const has = v && v.v != null;
    let status, msg;
    if (!has) { status = 'Missing data'; msg = v?.note || 'value not available'; }
    else if (!t || (t.min == null && t.max == null)) { status = 'No threshold set'; msg = 'Set a threshold on Management Inputs → Settings to evaluate this metric.'; }
    else if ((t.min != null && v.v < t.min) || (t.max != null && v.v > t.max)) { status = 'Breach'; msg = `${t.min != null && v.v < t.min ? `below the minimum ${t.min}` : `above the maximum ${t.max}`}`; }
    else { status = 'Within threshold'; msg = `within ${t.min != null ? `min ${t.min}` : ''}${t.min != null && t.max != null ? ' / ' : ''}${t.max != null ? `max ${t.max}` : ''}`; }
    if (has && v.status === 'Proxy' && status === 'Within threshold') { status = 'Within threshold (proxy)'; msg += ' — computed on a proxy basis'; }
    out.push({ id, label: label(id), value: has ? v.v : null, valueStatus: v?.status, threshold: t || null, status, msg });
  }
  const order = { Breach: 0, 'Missing data': 1, 'Within threshold (proxy)': 2, 'No threshold set': 3, 'Within threshold': 4 };
  return out.sort((a, c) => order[a.status] - order[c.status]);
}

module.exports = { notesView, cfo, trends, evaluateAlerts, comparatorOf };
