/**
 * Financial Reporting — follows a workbook figure back through its formulas to the trial-balance ledgers it is built from.
 *
 * traceCell(sheet, address) expresses the cell as a LINEAR combination of
 *   trial-balance terms   "<row>:<col>"  — col B opening, C debit, D credit, E closing balance (rupees), F the workbook-only
 *                         adjustment column (OBE); a reference to the "In Lacs" column G is (E + F) / 100000
 *   constants             numbers typed in a schedule or a formula, each kept with where it came from and its kind:
 *                         'opening'  a comparative column (an earlier date) or an earlier trial balance — an opening balance
 *                         'period'   typed in the current column of a schedule (e.g. a register or a classification)
 *                         'literal'  a number written inside a formula; 'rounding' when it is a ±0.05 plug
 *                         'opaque'   a part the tracer could not express linearly (kept at its cached value, flagged)
 * IF / MAX / MIN / ABS / IFERROR take the branch the workbook's own cached values take, so the expression reproduces the cell.
 * SUMIF / SUMIFS / VLOOKUP / INDEX-MATCH are resolved against the cached labels (Excel rules: case-insensitive, * ? wildcards).
 *
 * The check: evaluating the expression with the trial balance's own values must give the cell's cached value — a figure whose
 * trace does not reproduce it is reported, never used silently.
 */

'use strict';

const XLSX = require('xlsx');
const F = require('./xlformula');
const P = require('./periods');

const isNum = v => typeof v === 'number' && Number.isFinite(v);

class Lin {
  constructor() { this.t = new Map(); this.k = []; this.op = []; this.round = false; }
  static num(v, part) { const l = new Lin(); if (v) l.k.push({ ...part, v, coef: 1 }); return l; }
  static term(key, coef = 1) { const l = new Lin(); l.t.set(key, coef); return l; }
  get pure() { return this.t.size === 0 && this.op.length === 0; }
  constVal() { return this.k.reduce((s, c) => s + c.v * c.coef, 0); }
  add(o, sign = 1) {
    for (const [k, c] of o.t) { const n = (this.t.get(k) || 0) + sign * c; if (Math.abs(n) < 1e-15) this.t.delete(k); else this.t.set(k, n); }
    for (const c of o.k) this.k.push({ ...c, coef: c.coef * sign });
    for (const c of o.op) this.op.push({ ...c, coef: c.coef * sign });
    this.round = this.round || o.round;
    return this;
  }
  scale(f) {
    for (const [k, c] of this.t) this.t.set(k, c * f);
    this.k = this.k.map(c => ({ ...c, coef: c.coef * f }));
    this.op = this.op.map(c => ({ ...c, coef: c.coef * f }));
    return this;
  }
  clone() { const l = new Lin(); l.add(this); return l; }
}

function makeTracer(wb, opts) {
  const tbName = opts.tbSheet;
  const tb = wb.Sheets[tbName];
  if (!tb) throw new Error(`The workbook has no sheet "${tbName}".`);
  const periodStart = opts.periodStart, periodEnd = opts.periodEnd;
  const firstRow = opts.firstRow || 1;
  // trial-balance columns (letters) → term codes; 'lakh' is (closing + adjustment) / 100000
  const cols = { open: 'B', dr: 'C', cr: 'D', close: 'E', obe: 'F', lakh: 'G', ...(opts.cols || {}) };
  const codeOfCol = {}; for (const k of ['open', 'dr', 'cr', 'close', 'obe']) if (cols[k]) codeOfCol[F.colNum(cols[k])] = k;
  const lakhCol = cols.lakh ? F.colNum(cols.lakh) : null;
  const tbRange = XLSX.utils.decode_range(tb['!ref']);
  const lastRow = opts.lastRow || tbRange.e.r + 1;
  const otherTb = new Set(wb.SheetNames.filter(n => n !== tbName && /^tb\b/i.test(n.trim())));
  const memo = new Map();
  const stack = new Set();
  const cellOf = (sh, c, r) => wb.Sheets[sh]?.[F.addr(c, r)];
  const isTbAccountRow = r => r >= firstRow && r <= lastRow && tb[`A${r}`] && String(tb[`A${r}`].v).trim() !== '';

  // the date a column's figures are for: the nearest date heading above the cell in that column
  const headerMemo = new Map();
  function columnDate(sh, c, r) {
    const key = `${sh}|${c}|${r}`;
    if (headerMemo.has(key)) return headerMemo.get(key);
    let out = null;
    for (let rr = r - 1; rr >= Math.max(1, r - 120) && !out; rr--) {
      const cell = cellOf(sh, c, rr);
      if (!cell || cell.v == null) continue;
      if (cell.v instanceof Date) out = P.dateToIso(cell.v);
      else if (typeof cell.v === 'string') out = P.parseDateText(cell.v) || (P.parseLooseHeading(cell.v)?.date ?? null);
      else if (cell.t === 'n' && cell.z && /[dmy]/i.test(cell.z) && cell.v > 30000 && cell.v < 80000) out = P.dateToIso(new Date(Math.round((cell.v - 25569) * 86400000)));
    }
    headerMemo.set(key, out);
    return out;
  }
  function constKind(sh, c, r) {
    if (otherTb.has(sh)) return 'opening';
    const d = columnDate(sh, c, r);
    if (d && periodStart && d < periodStart) return 'opening';
    return 'period';
  }

  // ── numeric evaluation with the workbook's cached values (for conditions and branch choice) ──
  function ev(n, sh) {
    switch (n.t) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'bool': return n.v;
      case 'blank': return 0;
      case 'err': return { err: n.v };
      case 'ref': { const c = cellOf(n.sheet || sh, n.c, n.r); return c ? (c.t === 'e' ? { err: c.w || '#ERR' } : c.v) : 0; }
      case 'neg': { const v = ev(n.a, sh); return isNum(v) ? -v : v; }
      case 'pct': { const v = ev(n.a, sh); return isNum(v) ? v / 100 : v; }
      case 'bin': {
        const a = ev(n.a, sh), b = ev(n.b, sh);
        if (n.op === '&') return `${a ?? ''}${b ?? ''}`;
        if (['=', '<>', '<', '>', '<=', '>='].includes(n.op)) {
          const x = typeof a === 'string' ? a.toLowerCase() : a ?? 0, y = typeof b === 'string' ? b.toLowerCase() : b ?? 0;
          return { '=': x === y, '<>': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[n.op];
        }
        const xa = isNum(a) ? a : (a === '' || a == null ? 0 : NaN), xb = isNum(b) ? b : (b === '' || b == null ? 0 : NaN);
        return { '+': xa + xb, '-': xa - xb, '*': xa * xb, '/': xa / xb, '^': xa ** xb }[n.op];
      }
      case 'fn': {
        const a = n.args;
        if (n.name === 'AND') return a.every(x => !!ev(x, sh));
        if (n.name === 'OR') return a.some(x => !!ev(x, sh));
        if (n.name === 'NOT') return !ev(a[0], sh);
        if (n.name === 'IF') return ev(a[0], sh) ? ev(a[1], sh) : (a[2] ? ev(a[2], sh) : false);
        if (n.name === 'ABS') { const v = ev(a[0], sh); return isNum(v) ? Math.abs(v) : v; }
        if (n.name === 'ROUND') { const v = ev(a[0], sh), d = ev(a[1], sh) || 0; return isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : v; }
        if (n.name === 'ISBLANK') { const v = ev(a[0], sh); return v === '' || v == null; }
        return undefined;
      }
      default: return undefined;
    }
  }

  // Excel criteria: "<>x", ">=5", "a*b", exact text, case-insensitive
  function matcherFor(crit) {
    if (isNum(crit)) return v => isNum(v) && v === crit;
    let s = String(crit ?? '');
    const m = s.match(/^(<>|>=|<=|=|<|>)(.*)$/s);
    let op = '=';
    if (m) { op = m[1]; s = m[2]; }
    const num = s !== '' && !Number.isNaN(Number(s)) ? Number(s) : null;
    if (op !== '=' && op !== '<>') return v => { const x = isNum(v) ? v : Number(v); if (num == null || Number.isNaN(x)) return false; return { '<': x < num, '>': x > num, '<=': x <= num, '>=': x >= num }[op]; };
    let test;
    if (/[*?]/.test(s.replace(/~[*?]/g, ''))) {
      const re = new RegExp(`^${s.split(/(~[*?]|[*?])/).map(part => part === '*' ? '.*' : part === '?' ? '.' : part.startsWith('~') ? `\\${part[1]}` : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')}$`, 'is');
      test = v => re.test(String(v ?? ''));
    } else {
      const low = s.replace(/~([*?])/g, '$1').toLowerCase();
      test = v => (num != null && isNum(v) ? v === num : String(v ?? '').toLowerCase() === low);
    }
    return op === '<>' ? v => !test(v) : test;
  }

  function rangeCells(n, sh) {
    const s = n.sheet || sh;
    const ws = wb.Sheets[s];
    if (!ws || !ws['!ref']) return [];
    const R = XLSX.utils.decode_range(ws['!ref']);
    const r1 = Math.max(n.r1, R.s.r + 1), r2 = Math.min(n.r2, R.e.r + 1);
    const c1 = Math.max(n.c1, R.s.c + 1), c2 = Math.min(n.c2, R.e.c + 1);
    const out = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push({ sheet: s, c, r });
    return out;
  }
  const valueAt = x => { const c = cellOf(x.sheet, x.c, x.r); return c ? c.v : undefined; };

  // ── the linear expansion ──
  // a part summed in rupees into a total kept in lakh (a missing /100000 in the workbook) is read as lakh — but only when it adds
  // up to (nearly) nothing at the period end, so the workbook's own figure is unchanged; it is reported either way
  const anomalies = [];
  const scaleOf = l => { let mx = 0; for (const c of l.t.values()) mx = Math.max(mx, Math.abs(c)); return mx === 0 ? null : mx >= 1e-3 ? 'rupee' : mx <= 1e-4 ? 'lakh' : null; };
  function merge(parts, ctx, signs) {
    const classes = parts.map(scaleOf);
    const mixed = classes.includes('rupee') && classes.includes('lakh');
    const out = new Lin();
    parts.forEach((p, i) => {
      if (mixed && classes[i] === 'rupee' && Math.abs(evaluate(p)) < 0.5) { p.scale(1e-5); anomalies.push({ sheet: ctx.sheet, addr: ctx.addr, why: 'rupee amounts summed into a lakh total (missing /100000) — read as lakh' }); }
      out.add(p, signs ? signs[i] : 1);
    });
    return out;
  }
  function refLin(s, c, r, opening = false) {
    if (s === tbName && isTbAccountRow(r) && (codeOfCol[c] || c === lakhCol)) {
      if (c === lakhCol) { const l = Lin.term(`${r}:close`, 1e-5); if (cols.obe) l.add(Lin.term(`${r}:obe`, 1e-5)); return l; }
      return Lin.term(`${r}:${codeOfCol[c]}`);
    }
    const cell = cellOf(s, c, r);
    if (!cell) return new Lin();
    if (cell.f) return traceCell(s, F.addr(c, r), opening);
    if (cell.t === 'n' && isNum(cell.v)) return Lin.num(cell.v, { kind: opening ? 'opening' : constKind(s, c, r), sheet: s, addr: F.addr(c, r) });
    return new Lin();                                              // text, blank, boolean: no amount
  }

  function lin(n, sh, ctx) {
    switch (n.t) {
      case 'num': {
        // a number written in a formula of a comparative column (an earlier date) is part of an opening balance
        const { c, r } = F.splitCell(ctx.addr);
        const kind = ctx.opening || constKind(ctx.sheet, c, r) === 'opening' ? 'opening' : Math.abs(n.v) <= 0.05 ? 'rounding' : 'literal';
        return Lin.num(n.v, { kind, sheet: ctx.sheet, addr: ctx.addr });
      }
      case 'blank': case 'str': case 'bool': return new Lin();
      case 'err': { const l = new Lin(); l.op.push({ why: `Excel error ${n.v}`, sheet: ctx.sheet, addr: ctx.addr, v: 0, coef: 1 }); return l; }
      case 'ref': return refLin(n.sheet || sh, n.c, n.r, ctx.opening);
      case 'range': return merge(rangeCells(n, sh).map(x => refLin(x.sheet, x.c, x.r, ctx.opening)), ctx);
      case 'neg': return lin(n.a, sh, ctx).scale(-1);
      case 'pct': return lin(n.a, sh, ctx).scale(0.01);
      case 'bin': {
        if (n.op === '+' || n.op === '-') return merge([lin(n.a, sh, ctx), lin(n.b, sh, ctx)], ctx, [1, n.op === '-' ? -1 : 1]);
        if (n.op === '*' || n.op === '/') {
          const a = lin(n.a, sh, ctx), b = lin(n.b, sh, ctx);
          if (b.pure && (n.op === '/' || true)) { const f = b.constVal(); if (n.op === '/' && f === 0) return opaque(n, sh, ctx, 'division by zero'); return a.scale(n.op === '/' ? 1 / f : f); }
          if (a.pure && n.op === '*') return b.scale(a.constVal());
          return opaque(n, sh, ctx, 'a product of two traced amounts');
        }
        if (n.op === '^') { const a = lin(n.a, sh, ctx), b = lin(n.b, sh, ctx); if (a.pure && b.pure) return Lin.num(a.constVal() ** b.constVal(), { kind: 'literal', sheet: ctx.sheet, addr: ctx.addr }); return opaque(n, sh, ctx, 'a power of a traced amount'); }
        return new Lin();                                          // comparisons and text joins carry no amount
      }
      case 'fn': return fnLin(n, sh, ctx);
      default: return opaque(n, sh, ctx, 'unsupported');
    }
  }

  function opaque(n, sh, ctx, why) {
    const v = ev(n, sh);
    const l = new Lin();
    l.op.push({ why, sheet: ctx.sheet, addr: ctx.addr, v: isNum(v) ? v : 0, coef: 1 });
    return l;
  }

  function fnLin(n, sh, ctx) {
    const a = n.args;
    const sumArgs = list => merge(list.map(x => lin(x, sh, ctx)), ctx);
    switch (n.name) {
      case 'SUM': return sumArgs(a);
      case 'SUBTOTAL': { const k = ev(a[0], sh); if (k === 9 || k === 109) return sumArgs(a.slice(1)); return opaque(n, sh, ctx, `SUBTOTAL(${k})`); }
      case 'N': { const v = ev(a[0], sh); return isNum(v) ? lin(a[0], sh, ctx) : new Lin(); }
      case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': { const l = lin(a[0], sh, ctx); l.round = true; return l; }
      case 'IF': { const c = ev(a[0], sh); if (c === undefined || (c && typeof c === 'object')) return opaque(n, sh, ctx, 'IF condition not readable'); return c ? lin(a[1] || { t: 'blank' }, sh, ctx) : lin(a[2] || { t: 'blank' }, sh, ctx); }
      case 'IFERROR': { const v = ev(a[0], sh); return v && typeof v === 'object' && v.err ? lin(a[1], sh, ctx) : lin(a[0], sh, ctx); }
      case 'ABS': { const v = ev(a[0], sh); if (!isNum(v)) return opaque(n, sh, ctx, 'ABS of an unreadable value'); return lin(a[0], sh, ctx).scale(v < 0 ? -1 : 1); }
      case 'MAX': case 'MIN': {
        const items = [];
        for (const x of a) { if (x.t === 'range') for (const c of rangeCells(x, sh)) items.push({ node: { t: 'ref', sheet: c.sheet, c: c.c, r: c.r }, v: valueAt(c) }); else items.push({ node: x, v: ev(x, sh) }); }
        const nums = items.filter(x => isNum(x.v));
        if (!nums.length) return new Lin();
        const best = nums.reduce((m, x) => ((n.name === 'MAX' ? x.v > m.v : x.v < m.v) ? x : m));
        return lin(best.node, sh, ctx);
      }
      case 'SUMIF': {
        const range = a[0], crit = ev(a[1], sh), sumR = a[2] && a[2].t !== 'blank' ? a[2] : range;
        if (range.t !== 'range' || sumR.t !== 'range') return opaque(n, sh, ctx, 'SUMIF without ranges');
        const test = matcherFor(crit);
        const l = new Lin();
        for (const x of rangeCells(range, sh)) {
          if (!test(valueAt(x))) continue;
          const tc = sumR.c1 + (x.c - range.c1), tr = sumR.r1 === 1 && range.r1 === 1 ? x.r : sumR.r1 + (x.r - range.r1);
          l.add(refLin(sumR.sheet || sh, tc, tr, ctx.opening));
        }
        return l;
      }
      case 'SUMIFS': {
        const sumR = a[0];
        const pairs = [];
        for (let i = 1; i + 1 < a.length; i += 2) pairs.push({ range: a[i], test: matcherFor(ev(a[i + 1], sh)) });
        if (sumR.t !== 'range' || pairs.some(p => p.range.t !== 'range')) return opaque(n, sh, ctx, 'SUMIFS without ranges');
        const l = new Lin();
        for (const x of rangeCells(sumR, sh)) {
          const ok = pairs.every(p => { const c = p.range.c1 + (x.c - sumR.c1), r = p.range.r1 + (x.r - sumR.r1); return p.test(valueAt({ sheet: p.range.sheet || sh, c, r })); });
          if (ok) l.add(refLin(x.sheet, x.c, x.r, ctx.opening));
        }
        return l;
      }
      case 'VLOOKUP': case 'HLOOKUP': {
        const key = ev(a[0], sh), tbl = a[1], idx = ev(a[2], sh), exact = a[3] ? !ev(a[3], sh) : false;
        if (tbl.t !== 'range' || !isNum(idx)) return opaque(n, sh, ctx, `${n.name} not readable`);
        if (!exact) return opaque(n, sh, ctx, `${n.name} with approximate match`);
        const test = matcherFor(key);
        const s = tbl.sheet || sh;
        const cells = rangeCells(n.name === 'VLOOKUP' ? { ...tbl, c2: tbl.c1 } : { ...tbl, r2: tbl.r1 }, sh);
        const hit = cells.find(x => test(valueAt(x)));
        if (!hit) return opaque(n, sh, ctx, `${n.name}: "${key}" not found`);
        return n.name === 'VLOOKUP' ? refLin(s, tbl.c1 + idx - 1, hit.r, ctx.opening) : refLin(s, hit.c, tbl.r1 + idx - 1, ctx.opening);
      }
      case 'INDEX': {
        const tbl = a[0];
        if (tbl.t !== 'range') return opaque(n, sh, ctx, 'INDEX not readable');
        const rr = a[1] ? ev(a[1], sh) : 1, cc = a[2] ? ev(a[2], sh) : 1;
        if (!isNum(rr) || !isNum(cc)) return opaque(n, sh, ctx, 'INDEX position not readable');
        return refLin(tbl.sheet || sh, tbl.c1 + Math.max(1, cc) - 1, tbl.r1 + Math.max(1, rr) - 1, ctx.opening);
      }
      case 'MATCH': return opaque(n, sh, ctx, 'MATCH used outside INDEX');
      default: return opaque(n, sh, ctx, `function ${n.name}`);
    }
  }

  // INDEX(range, MATCH(x, col, 0)) — rewrite MATCH positions to numbers before tracing
  function resolveMatch(n, sh) {
    if (!n || typeof n !== 'object') return n;
    if (n.t === 'fn' && n.name === 'MATCH') {
      const key = ev(n.args[0], sh), rg = n.args[1];
      if (rg?.t === 'range') {
        const test = matcherFor(key);
        const cells = rangeCells(rg, sh);
        const i = cells.findIndex(x => test(valueAt(x)));
        if (i >= 0) return { t: 'num', v: i + 1 };
      }
      return n;
    }
    if (n.t === 'fn') return { ...n, args: n.args.map(x => resolveMatch(x, sh)) };
    if (n.t === 'bin') return { ...n, a: resolveMatch(n.a, sh), b: resolveMatch(n.b, sh) };
    if (n.t === 'neg' || n.t === 'pct') return { ...n, a: resolveMatch(n.a, sh) };
    return n;
  }

  function traceCell(sheet, address, openingIn = false) {
    const pos = F.splitCell(address);
    // everything under a comparative column (an earlier date) is part of an opening balance
    const opening = openingIn || constKind(sheet, pos.c, pos.r) === 'opening';
    const key = `${sheet}!${address}|${opening ? 'o' : 'c'}`;
    if (memo.has(key)) return memo.get(key).clone();
    const cell = wb.Sheets[sheet]?.[address];
    let out;
    if (!cell) out = new Lin();
    else if (!cell.f) {
      out = refLin(sheet, pos.c, pos.r, opening);
    } else if (stack.has(key)) {
      out = new Lin(); out.op.push({ why: 'circular reference', sheet, addr: address, v: isNum(cell.v) ? cell.v : 0, coef: 1 });
    } else {
      stack.add(key);
      try {
        const tree = resolveMatch(F.parse(cell.f), sheet);
        out = lin(tree, sheet, { sheet, addr: address, opening });
      } catch (e) {
        out = new Lin(); out.op.push({ why: `formula not readable (${e.message})`, sheet, addr: address, v: isNum(cell.v) ? cell.v : 0, coef: 1 });
      }
      stack.delete(key);
    }
    memo.set(key, out);
    return out.clone();
  }

  // value of a trial-balance term from the workbook's own trial balance
  function tbValue(key) {
    const [r, code] = key.split(':');
    const v = tb[`${cols[code]}${r}`]?.v;
    return isNum(v) ? v : 0;
  }
  function evaluate(l, termValue = tbValue) {
    let s = 0;
    for (const [k, c] of l.t) s += c * termValue(k);
    s += l.constVal();
    s += l.op.reduce((t, o) => t + o.v * o.coef, 0);
    return s;
  }
  function check(sheet, address) {
    const l = traceCell(sheet, address);
    const cached = wb.Sheets[sheet]?.[address]?.v;
    const got = evaluate(l);
    return { lin: l, cached: isNum(cached) ? cached : null, got, ok: isNum(cached) ? Math.abs(cached - got) < 0.005 + Math.abs(cached) * 1e-9 : Math.abs(got) < 0.005 };
  }
  function account(r) {
    return { row: r, name: String(tb[`A${r}`]?.v ?? '').replace(/\s+$/, ''), depth: Math.round((String(tb[`A${r}`]?.v ?? '').match(/^\s*/)[0].length) / 10),
      open: tbValue(`${r}:open`), dr: tbValue(`${r}:dr`), cr: tbValue(`${r}:cr`), close: tbValue(`${r}:close`), obe: cols.obe ? tbValue(`${r}:obe`) : 0,
      group: cols.group && tb[`${cols.group}${r}`] && tb[`${cols.group}${r}`].v !== 0 && String(tb[`${cols.group}${r}`].v).trim() !== '' ? String(tb[`${cols.group}${r}`].v) : null };
  }

  return { traceCell, evaluate, check, tbValue, account, isTbAccountRow, columnDate, firstRow, lastRow, tbName, cols, anomalies };
}

module.exports = { makeTracer, Lin };
