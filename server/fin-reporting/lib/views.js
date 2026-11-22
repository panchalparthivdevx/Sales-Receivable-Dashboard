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

// the same note item worded slightly differently in two workbooks (a typo, a plural): matched for derived periods only
const normItem = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)).join(' ');
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const sameItem = (a, b) => { const x = normItem(a), y = normItem(b); return x === y || (Math.min(x.length, y.length) >= 10 && editDistance(x, y) <= 2); };

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
    const lineSet = [...new Set(cands.flatMap(n => n.lines))];
    const stmtOf = p => { const vals = lineSet.map(id => M.num(M.cell(ctx, b, id, p))); return vals.some(v => v != null) ? vals.reduce((s, v) => s + (v || 0), 0) : null; };
    // two notes of one workbook can point to the same line (e.g. two notes numbered 12): the one whose total agrees
    // with the statement line comes first, then the usual source priority
    const agrees = (n, p) => { const t = n.items.filter(i => i.total).pop()?.v[p]; const st = stmtOf(p); return t && t.v != null && st != null && Math.abs(t.v - st) < 0.02 ? 1 : 0; };
    const pick = p => { const withP = cands.filter(n => n.items.some(i => i.v[p])); return withP.length ? withP.sort((x, y) => agrees(y, p) - agrees(x, p) || noteRank(ctx, y, p) - noteRank(ctx, x, p))[0] : null; };
    const chosen = {};
    for (const p of periodIds) { const n = pick(p); if (n) chosen[p] = n; }
    // a flow period no workbook has a note for (e.g. Q2 when the workbooks give Q1 and H1) is derived item by item from
    // the notes of the periods it is made of — shown as derived, never as reported; balance-sheet dates are never derived
    const derivedP = {};
    for (const p of periodIds) {
      if (chosen[p] || P.fromId(p)?.type === 'BS') continue;
      for (const d of M.derivationsFor(p)) {
        const parts = [...d.plus.map(q => ({ q, sign: 1 })), ...d.minus.map(q => ({ q, sign: -1 }))].map(x => ({ ...x, n: pick(x.q) }));
        if (parts.every(x => x.n)) { derivedP[p] = { f: d.f, parts }; break; }
      }
    }
    if (!Object.keys(chosen).length && !Object.keys(derivedP).length) continue;
    // rows follow the note of the latest workbook; items only in other workbooks' notes go in above the total
    const primaryNote = Object.values(chosen).sort((x, y) => (ctx.ix.fileDate[y.f] || '').localeCompare(ctx.ix.fileDate[x.f] || ''))[0] || Object.values(derivedP)[0].parts[0].n;
    const kindOf = it => `${it.key}|${it.total ? 'T' : it.subhead ? 'S' : 'I'}`;
    const rows = [];
    const byKey = new Map();
    // p: the period being filled — an item worded slightly differently in another workbook joins the row that has no
    // figure for that period yet
    const addRow = (it, p) => {
      const k = kindOf(it);
      let row = byKey.get(k);
      if (!row && p && !it.subhead) row = rows.find(r => !r.subhead && r.total === !!it.total && !r.cells[p] && sameItem(r.label, it.label));
      if (!row) {
        row = { label: it.label, key: it.key, total: !!it.total, subhead: !!it.subhead, cells: {} };
        const lastTotal = rows.map(r => r.total).lastIndexOf(true);
        if (!row.total && lastTotal >= 0) rows.splice(lastTotal, 0, row); else rows.push(row);
      }
      byKey.set(k, row);
      return row;
    };
    for (const it of primaryNote.items) addRow(it);
    // each note's closing total sits on the main note's total row, whatever the workbook calls it
    const mainTotal = byKey.get(kindOf(primaryNote.items.filter(i => i.total).pop() || {}));
    for (const [p, n] of Object.entries(chosen)) {
      const closing = n.items.filter(i => i.total).pop();
      for (const it of n.items) {
        if (it.subhead && n !== primaryNote) continue;      // other workbooks' headings would only repeat empty
        const row = it === closing && mainTotal && !mainTotal.cells[p] && !byKey.has(kindOf(it)) ? mainTotal : addRow(it, p);
        const c = it.v[p];
        if (c) row.cells[p] = { v: c.st === 'ok' || c.st === 'dash' ? c.v : null, st: c.st, err: c.err, src: { f: n.f, sh: n.sheet, c: c.c, note: n.num, fx: c.fx } };
      }
    }
    const gaps = {};
    for (const [p, d] of Object.entries(derivedP)) {
      const used = d.parts.map(() => new Set());
      gaps[p] = [];
      d.parts.forEach((x, pi) => {
        for (const it of x.n.items) {
          if (it.subhead || used[pi].has(kindOf(it))) continue;
          const found = d.parts.map((y, j) => {
            if (j === pi) return it;
            const free = y.n.items.filter(i => !i.subhead && !used[j].has(kindOf(i)));
            return free.find(i => kindOf(i) === kindOf(it)) || free.find(i => !!i.total === !!it.total && sameItem(i.label, it.label)) || null;
          });
          found.forEach((fi, j) => fi && used[j].add(kindOf(fi)));
          // every part must carry the item (a figure or a dash); an item missing from one part is left blank, not assumed nil
          const ins = d.parts.map((y, j) => ({ x: y, c: found[j]?.v[y.q] }));
          if (ins.some(({ c }) => !c || !(c.st === 'ok' || c.st === 'dash'))) {
            if (ins.some(({ c }) => c?.st === 'ok' && c.v)) gaps[p].push({ label: it.label, only: ins.filter(({ c }) => c).map(({ x: y }) => y.q) });
            continue;
          }
          const v = Math.round(ins.reduce((s, { x: y, c }) => s + y.sign * (Number(c.v) || 0), 0) * 1e6) / 1e6;
          addRow(found[0], p).cells[p] = { v, st: 'derived', derived: { formula: d.f, inputs: ins.map(({ x: y, c }, j) => ({ p: y.q, sign: y.sign, v: c.v, f: y.n.f, sh: y.n.sheet, c: c.c, note: y.n.num, lbl: found[j].label })), mixedFiles: new Set(d.parts.map(y => y.n.f)).size > 1 } };
        }
      });
    }
    const stmtCells = {};
    for (const p of periodIds) {
      const cs = [...new Set(cands.flatMap(n => n.lines))].map(id => M.cell(ctx, b, id, p));
      const vals = cs.map(M.num);
      stmtCells[p] = vals.some(v => v != null) ? vals.reduce((s, v) => s + (v || 0), 0) : null;
    }
    groups.push({ lines: [...new Set(cands.flatMap(n => n.lines))], lineLabel: [...new Set(cands.flatMap(n => n.lines))].map(id => L.BY_ID[id]?.label || id).join(' + '), title: primaryNote.title,
      derivedGaps: gaps,
      sourceNotes: { ...Object.fromEntries(Object.entries(chosen).map(([p, n]) => [p, { num: n.num, f: n.f, sheet: n.sheet, file: ctx.ix.version.files[n.f]?.name }])),
        ...Object.fromEntries(Object.entries(derivedP).map(([p, d]) => [p, { derived: d.f, from: d.parts.map(x => ({ p: x.q, num: x.n.num, file: ctx.ix.version.files[x.n.f]?.name })) }])) }, rows: rows.filter(r => r.subhead || Object.keys(r.cells).length), statement: stmtCells,
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
