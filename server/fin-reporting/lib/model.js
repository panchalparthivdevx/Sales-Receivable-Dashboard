/**
 * Financial Reporting — which figure a statement shows, and why.
 *
 * Every (basis, line, period) can have several source figures. The shown figure is chosen by an explicit priority:
 *   1. a recorded decision for that figure (Data Validation → decision requests), for the version it was made for
 *   2. version "original" (As originally reported, the default): the workbook prepared FOR that period (its "primary"
 *      columns — e.g. FY2025-26 from the audited annual workbook), else the earliest workbook that reports it as a comparative
 *      version "latest" (Latest reported / regrouped): the most recent workbook that reports the period
 *   3. a visible sheet before a hidden one; the SEBI results sheet before the detailed P&L for the P&L
 *   4. a figure with a value before a blank, never an Excel error before a valid figure
 * Working columns (outside the published statement) are used only when nothing else reports the period, and say so.
 *
 * Derived periods (only when not reported directly, same basis, same version; flow amounts only — never EPS,
 * balance-sheet items, paid-up capital, other equity, opening/closing cash or ratios):
 *   Q2 = H1 − Q1   Q3 = 9M − H1   Q4 = FY − 9M   H2 = FY − H1   (and, labelled the same way, Q1 = H1 − Q2, H1 = Q1 + Q2, 9M = H1 + Q3)
 */

'use strict';

const P = require('./periods');
const L = require('./lines');

const NON_ADDITIVE = new Set(['pl.paidup', 'pl.oth_eq', 'pl.eps_basic', 'pl.eps_diluted', 'cf.open', 'cf.close']);
const additive = l => !NON_ADDITIVE.has(l) && (l.startsWith('pl.') || l.startsWith('cf.'));

function factKey(fc) { return `${fc.f}|${fc.sh}|${fc.c}`; }

/** Build lookups once per version */
function index(version) {
  const by = new Map();
  for (const fc of version.facts) {
    const k = `${fc.b}|${fc.l}|${fc.p}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(fc);
  }
  const fileDate = version.files.map(f => f.reportingDate || '0000-00-00');
  return { version, by, fileDate };
}

function score(fc, mode, ix) {
  let s = 0;
  const date = ix.fileDate[fc.f] || '0000-00-00';
  const dateNum = Number(date.replace(/-/g, '')) / 1e8;      // 0.2026xxxx — a tie-breaker below every rule
  if (fc.role === 'working') s -= 400;
  if (mode === 'latest') s += dateNum * 100;
  else { if (fc.role === 'primary') s += 300; else if (fc.role === 'comparative') s += 200; s -= dateNum * 10; }
  if (fc.hid) s -= 100;
  if (fc.k === 'SEBI') s += 20; else if (fc.k === 'PLD') s += 10;
  if (fc.st === 'error' || fc.st === 'no_cached') s -= 1000;
  else if (fc.st === 'blank' || fc.st === 'text') s -= 50;
  if (fc.x) s -= 5;
  if (fc.unrel) s -= 2000;
  if (fc.ce) s -= 150;           // a column with several Excel errors
  return s;
}

/**
 * ctx = { ix, mode: 'original'|'latest', decisions: { [b|l|p|mode]: factKey }, adjustments: [...], withAdj }
 * Returns { v, st, fact, alts, decided, derived, adj }
 */
function cell(ctx, b, l, p, depth = 0) {
  const k = `${b}|${l}|${p}`;
  const memo = ctx.memo || (ctx.memo = new Map());
  const mk = `${k}|${ctx.mode}|${ctx.withAdj ? 1 : 0}|${depth ? 1 : 0}`;
  if (memo.has(mk)) return memo.get(mk);
  const cands = ctx.ix.by.get(k) || [];
  let out;
  if (cands.length) {
    const dk = ctx.decisions?.[`${k}|${ctx.mode}`];
    let chosen = dk ? cands.find(c => factKey(c) === dk) : null;
    const decided = !!chosen;
    if (!chosen) chosen = [...cands].sort((a, c) => score(c, ctx.mode, ctx.ix) - score(a, ctx.mode, ctx.ix))[0];
    const usable = chosen.st === 'ok' || chosen.st === 'dash' || chosen.st === 'blank';
    out = { v: chosen.st === 'blank' ? null : chosen.v, st: chosen.st, fact: chosen, alts: cands.filter(c => c !== chosen), decided, blank: chosen.st === 'blank' };
    if (!usable) out.v = null;
    // a blank cell in a reported statement is a nil line ("—"), not a missing figure; arithmetic reads it as 0 (num())
    // a figure available only from a working column is cross-checked against the derivation when one exists
    if (chosen.role === 'working' && additive(l) && depth === 0) {
      const d = derive(ctx, b, l, p, depth);
      if (d) out.crossDerived = d;
    }
  } else if (additive(l) && depth === 0) {
    out = derive(ctx, b, l, p, depth) || { v: null, st: 'missing', alts: [] };
  } else out = { v: null, st: 'missing', alts: [] };
  if (ctx.withAdj && ctx.adjustments?.length) {
    const adj = ctx.adjustments.filter(a => a.b === b && a.l === l && a.p === p && a.status !== 'reversed');
    if (adj.length && out.v != null) out = { ...out, v: out.v + adj.reduce((s, a) => s + a.amount, 0), adj, st: 'adjusted' };
  }
  memo.set(mk, out);
  return out;
}

/** The derivations that could produce period p, in order of preference */
function derivationsFor(p) {
  const per = P.fromId(p);
  if (!per || per.type === 'BS') return [];
  const fy = per.fy;
  const id = s => `FY${fy}-${s}`;
  if (per.type === 'Q') {
    return {
      1: [{ f: 'H1 − Q2', plus: [id('H1')], minus: [id('Q2')] }],
      2: [{ f: 'H1 − Q1', plus: [id('H1')], minus: [id('Q1')] }],
      3: [{ f: '9M − H1', plus: [id('9M')], minus: [id('H1')] }],
      4: [{ f: 'FY − 9M', plus: [id('FY')], minus: [id('9M')] }],
    }[per.q];
  }
  if (per.type === 'H' && per.h === 2) return [{ f: 'FY − H1', plus: [id('FY')], minus: [id('H1')] }, { f: 'Q3 + Q4', plus: [id('Q3'), id('Q4')], minus: [] }];
  if (per.type === 'H' && per.h === 1) return [{ f: 'Q1 + Q2', plus: [id('Q1'), id('Q2')], minus: [] }];
  if (per.type === '9M') return [{ f: 'H1 + Q3', plus: [id('H1'), id('Q3')], minus: [] }];
  if (per.type === 'FY') return [{ f: 'H1 + H2', plus: [id('H1'), id('H2')], minus: [] }];
  return [];
}

function derive(ctx, b, l, p, depth = 0) {
  for (const d of derivationsFor(p)) {
    const ins = [...d.plus.map(x => ({ p: x, sign: 1 })), ...d.minus.map(x => ({ p: x, sign: -1 }))];
    const vals = ins.map(i => ({ ...i, c: cell(ctx, b, l, i.p, depth + 1) }));
    if (vals.some(x => num(x.c) == null)) continue;
    if (vals.some(x => x.c.derived)) continue;             // never derive from a derived figure
    const v = vals.reduce((s, x) => s + x.sign * num(x.c), 0);
    const filesUsed = [...new Set(vals.map(x => x.c.fact?.f).filter(x => x != null))];
    return { v, st: 'derived', derived: { formula: d.f, inputs: vals.map(x => ({ p: x.p, sign: x.sign, v: x.c.v, f: x.c.fact?.f, sh: x.c.fact?.sh, c: x.c.fact?.c })), mixedFiles: filesUsed.length > 1 }, alts: [] };
  }
  return null;
}

/** Periods that have at least one figure for this basis + statement, plus derivable ones */
function periodsFor(ix, b, stmt) {
  const direct = new Set();
  for (const fc of ix.version.facts) if (fc.b === b && fc.s === stmt && fc.role !== 'working' && (fc.st === 'ok' || fc.st === 'dash')) direct.add(fc.p);
  const working = new Set();
  for (const fc of ix.version.facts) if (fc.b === b && fc.s === stmt && fc.role === 'working' && !fc.unrel && fc.st === 'ok' && !direct.has(fc.p)) working.add(fc.p);
  const derivable = new Set();
  if (stmt === 'PL' || stmt === 'CF') {
    const fys = new Set([...direct].map(p => P.fromId(p)?.fy).filter(Boolean));
    for (const fy of fys) {
      for (const s of ['Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2', '9M', 'FY']) {
        const p = `FY${fy}-${s}`;
        if (direct.has(p)) continue;
        const ok = derivationsFor(p).some(d => [...d.plus, ...d.minus].every(x => direct.has(x) || working.has(x)));
        if (ok) derivable.add(p);
      }
    }
  }
  const all = [...new Set([...direct, ...derivable, ...working])].sort(P.cmp).reverse();
  return all.map(p => ({ ...P.fromId(p), availability: direct.has(p) ? 'reported' : derivable.has(p) ? 'derived' : 'working' }));
}

/** Default columns: the latest results / statements as published */
function defaultColumns(version, b, stmt) {
  const sts = version.statements.filter(s => s.basis === b && !s.hidden && (stmt === 'PL' ? s.type === 'SEBI' : s.stmt === stmt));
  if (!sts.length) return [];
  const latest = sts.sort((x, y) => (version.files[y.f].reportingDate || '').localeCompare(version.files[x.f].reportingDate || ''))[0];
  return latest.periods.filter(p => p.role !== 'working').map(p => p.period);
}

/** Line order for a statement: canonical lines, plus extra rows (cash-flow items, unmapped rows) in their source order */
function linesFor(ix, b, stmt) {
  const facts = ix.version.facts.filter(fc => fc.b === b && fc.s === stmt);
  const present = new Set(facts.map(fc => fc.l));
  const canon = (stmt === 'PL' ? L.PL : stmt === 'BS' ? L.BS : stmt === 'CF' ? L.CF : L.RT).map(l => l.id);
  if (stmt !== 'CF') {
    const out = canon.filter(id => present.has(id) || (stmt === 'BS' && ['bs.ppe', 'bs.ta', 'bs.tel'].includes(id)));
    const extras = [...present].filter(id => !canon.includes(id));
    return { lines: out, extras };
  }
  // cash flow: order by the rows of the most complete visible statement
  const sheets = {};
  for (const fc of facts) { const k = `${fc.f}|${fc.sh}`; (sheets[k] = sheets[k] || { n: 0, hid: fc.hid, date: ix.fileDate[fc.f], rows: {} }).n++; sheets[k].rows[fc.l] = Math.min(sheets[k].rows[fc.l] || 1e9, +String(fc.c).replace(/^[A-Z]+/, '')); }
  const ref = Object.values(sheets).filter(s => !s.hid).sort((x, y) => (y.date || '').localeCompare(x.date || '') || y.n - x.n)[0] || Object.values(sheets)[0];
  const secOf = id => (id.startsWith('cf.') && L.BY_ID[id] ? L.BY_ID[id].sec : (id.match(/^cf\.([ABCZ])\.x\./) || [])[1] || 'Z');
  const order = { A: 1, B: 2, C: 3, Z: 4 };
  const ids = [...present];
  const rowOf = id => ref?.rows[id] ?? (1e6 + (Object.values(sheets).map(s => s.rows[id]).find(Boolean) || 0));
  ids.sort((x, y) => (order[secOf(x)] - order[secOf(y)]) || (L.BY_ID[x]?.total ? 1 : 0) - (L.BY_ID[y]?.total ? 1 : 0) || rowOf(x) - rowOf(y));
  return { lines: ids.filter(id => { const anyVal = facts.some(fc => fc.l === id && fc.st === 'ok' && fc.v !== 0); return anyVal || L.BY_ID[id]; }), extras: [] };
}

function labelOf(ix, id) {
  if (L.BY_ID[id]) return L.BY_ID[id].label;
  const fc = ix.version.facts.find(f => f.l === id);
  return fc ? fc.lbl.replace(/^[a-z]\)\s*/i, '') : id;
}

/** One statement, ready to render: rows × periods with provenance */
function statementView(ctx, b, stmt, periodIds) {
  const { lines, extras } = linesFor(ctx.ix, b, stmt);
  const rows = [...lines, ...extras].map(id => {
    const def = L.BY_ID[id] || {};
    const cells = {};
    for (const p of periodIds) {
      const c = cell(ctx, b, id, p);
      cells[p] = slim(c);
    }
    const sec = def.sec || (id.match(/^cf\.([ABCZ])\.x\./) || [])[1] || null;
    return { id, label: labelOf(ctx.ix, id), unit: def.unit || (id.startsWith('rt.') ? 'times' : 'lakh'), bold: !!def.bold, grand: !!def.grand, indent: def.indent || (id.includes('.x.') ? 1 : 0), sec, extra: !L.BY_ID[id], cells };
  });
  return { basis: b, stmt, periods: periodIds.map(p => P.fromId(p)), rows };
}

function slim(c) {
  const o = { v: c.v, st: c.st };
  if (c.fact) { o.src = { f: c.fact.f, sh: c.fact.sh, c: c.fact.c, fx: c.fact.fx, role: c.fact.role, k: c.fact.k, aud: c.fact.aud, err: c.fact.err, plug: c.fact.plug, der: c.fact.der, r2: c.fact.r2, hid: c.fact.hid, lbl: c.fact.lbl }; }
  if (c.alts?.length) o.alts = c.alts.filter(a => a.st === 'ok' || a.st === 'error').map(a => ({ v: a.v, st: a.st, f: a.f, sh: a.sh, c: a.c, role: a.role, k: a.k, r2: a.r2, err: a.err }));
  if (c.derived) o.derived = c.derived;
  if (c.crossDerived) o.crossDerived = { v: c.crossDerived.v, formula: c.crossDerived.derived.formula };
  if (c.decided) o.decided = true;
  if (c.adj) o.adj = c.adj;
  return o;
}

/** Convenience: value or null; num() reads a nil (blank) line as 0 but keeps a missing / error figure null */
const val = (ctx, b, l, p) => cell(ctx, b, l, p).v;
const num = c => (c.v != null ? c.v : c.blank ? 0 : null);

function makeCtx(version, opts = {}) {
  return { ix: opts.ix || index(version), mode: opts.mode || 'original', decisions: opts.decisions || {}, adjustments: opts.adjustments || [], withAdj: !!opts.withAdj };
}

module.exports = { index, makeCtx, cell, val, num, derive, derivationsFor, periodsFor, defaultColumns, statementView, linesFor, labelOf, factKey, additive, score };
