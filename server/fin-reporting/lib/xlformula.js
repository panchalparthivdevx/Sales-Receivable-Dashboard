/**
 * Financial Reporting — a small Excel formula parser (enough for the formulas in the results workbooks).
 *
 * parse('=+SUMIF(\'TB S26\'!H:H,B15,\'TB S26\'!G:G)-C3*25%') → an expression tree of
 *   { t: 'num', v } | { t: 'str', v } | { t: 'bool', v } | { t: 'err', v }
 *   { t: 'ref', sheet, c, r }                       one cell ($ signs dropped; sheet null = the formula's own sheet)
 *   { t: 'range', sheet, c1, r1, c2, r2 }           A1:B5, H:H (whole column: r1 = 1, r2 = Infinity), 3:3 (whole row)
 *   { t: 'fn', name, args: [] }                      SUM(…), SUMIF(…), …
 *   { t: 'bin', op, a, b } | { t: 'neg', a } | { t: 'pct', a }
 * Throws on anything it cannot read — the caller treats such a formula as opaque and says so.
 */

'use strict';

const colNum = s => s.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function tokenize(src) {
  const s = src.replace(/^\s*=/, '');
  const out = [];
  let i = 0;
  const peek = (k = 0) => s[i + k];
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let j = i + 1, v = '';
      for (;;) { if (j >= s.length) throw new Error('unterminated string'); if (s[j] === '"') { if (s[j + 1] === '"') { v += '"'; j += 2; continue; } break; } v += s[j++]; }
      out.push({ k: 'str', v }); i = j + 1; continue;
    }
    if (ch === "'") {                                                  // 'Sheet name'!
      let j = i + 1, v = '';
      for (;;) { if (j >= s.length) throw new Error('unterminated sheet name'); if (s[j] === "'") { if (s[j + 1] === "'") { v += "'"; j += 2; continue; } break; } v += s[j++]; }
      if (s[j + 1] !== '!') throw new Error('quoted name without !');
      out.push({ k: 'sheet', v }); i = j + 2; continue;
    }
    if (ch === '#') { const m = s.slice(i).match(/^#(REF!|VALUE!|DIV\/0!|N\/A|NAME\?|NUM!|NULL!)/); if (!m) throw new Error('bad error literal'); out.push({ k: 'err', v: m[0] }); i += m[0].length; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = s.slice(i).match(/^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/);
      // a whole-row range "3:3" starts with digits too
      const rr = s.slice(i).match(/^\$?(\d+):\$?(\d+)/);
      if (rr && !m[0].includes('.')) { out.push({ k: 'rowrange', r1: +rr[1], r2: +rr[2] }); i += rr[0].length; continue; }
      out.push({ k: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = s.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_.$]*/);
      const word = m[0];
      if (peek(word.length) === '!' ) { out.push({ k: 'sheet', v: word }); i += word.length + 1; continue; }
      if (/^\$?[A-Za-z]{1,3}\$?\d+$/.test(word)) { out.push({ k: 'cell', v: word.replace(/\$/g, '').toUpperCase() }); i += word.length; continue; }
      if (/^\$?[A-Za-z]{1,3}$/.test(word) && peek(word.length) === ':') {          // whole column H:H
        const rest = s.slice(i + word.length + 1).match(/^\$?([A-Za-z]{1,3})(?![A-Za-z0-9(])/);
        if (rest) { out.push({ k: 'colrange', c1: word.replace(/\$/g, '').toUpperCase(), c2: rest[1].toUpperCase() }); i += word.length + 1 + rest[0].length; continue; }
      }
      if (peek(word.length) === '(') { out.push({ k: 'fn', v: word.toUpperCase().replace(/^_XLFN\./, '') }); i += word.length + 1; continue; }
      if (/^(TRUE|FALSE)$/i.test(word)) { out.push({ k: 'bool', v: /^TRUE$/i.test(word) }); i += word.length; continue; }
      out.push({ k: 'name', v: word }); i += word.length; continue;
    }
    const two = s.slice(i, i + 2);
    if (['<>', '<=', '>='].includes(two)) { out.push({ k: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%'.includes(ch)) { out.push({ k: 'op', v: ch }); i++; continue; }
    if (ch === '(') { out.push({ k: '(' }); i++; continue; }
    if (ch === ')') { out.push({ k: ')' }); i++; continue; }
    if (ch === ',' || ch === ';') { out.push({ k: ',' }); i++; continue; }
    if (ch === ':') { out.push({ k: ':' }); i++; continue; }
    if (ch === '{') throw new Error('array constants are not supported');
    throw new Error(`unexpected "${ch}"`);
  }
  return out;
}

function parse(src) {
  const tk = tokenize(src);
  let p = 0;
  const peek = () => tk[p];
  const take = k => { const t = tk[p]; if (!t || (k && t.k !== k)) throw new Error(`expected ${k}`); p++; return t; };
  const isOp = (...ops) => peek() && peek().k === 'op' && ops.includes(peek().v);

  function cellOrRange(sheet) {
    const t = peek();
    if (!t) throw new Error('reference expected');
    if (t.k === 'colrange') { p++; return { t: 'range', sheet, c1: colNum(t.c1), r1: 1, c2: colNum(t.c2), r2: Infinity }; }
    if (t.k === 'rowrange') { p++; return { t: 'range', sheet, c1: 1, r1: t.r1, c2: Infinity, r2: t.r2 }; }
    if (t.k !== 'cell') throw new Error('cell expected');
    p++;
    const a = splitCell(t.v);
    if (peek() && peek().k === ':') {
      p++;
      if (peek() && peek().k === 'sheet') p++;                       // Sheet!A1:Sheet!B2 (rare)
      const b = take('cell');
      const bb = splitCell(b.v);
      return { t: 'range', sheet, c1: Math.min(a.c, bb.c), r1: Math.min(a.r, bb.r), c2: Math.max(a.c, bb.c), r2: Math.max(a.r, bb.r) };
    }
    return { t: 'ref', sheet, c: a.c, r: a.r };
  }

  function primary() {
    const t = peek();
    if (!t) throw new Error('unexpected end');
    if (t.k === 'num') { p++; return { t: 'num', v: t.v }; }
    if (t.k === 'str') { p++; return { t: 'str', v: t.v }; }
    if (t.k === 'bool') { p++; return { t: 'bool', v: t.v }; }
    if (t.k === 'err') { p++; return { t: 'err', v: t.v }; }
    if (t.k === 'sheet') { p++; return cellOrRange(t.v); }
    if (t.k === 'cell' || t.k === 'colrange' || t.k === 'rowrange') return cellOrRange(null);
    if (t.k === 'fn') {
      p++;
      const args = [];
      if (peek() && peek().k === ')') { p++; return { t: 'fn', name: t.v, args }; }
      for (;;) {
        if (peek() && peek().k === ',') { args.push({ t: 'blank' }); p++; continue; }
        args.push(expr());
        if (peek() && peek().k === ',') { p++; if (peek() && peek().k === ')') { args.push({ t: 'blank' }); } continue; }
        take(')');
        break;
      }
      return { t: 'fn', name: t.v, args };
    }
    if (t.k === '(') { p++; const e = expr(); take(')'); return e; }
    if (t.k === 'name') throw new Error(`named range "${t.v}" is not supported`);
    throw new Error(`unexpected token ${t.k}`);
  }
  function postfix() { let e = primary(); while (isOp('%')) { p++; e = { t: 'pct', a: e }; } return e; }
  function unary() {
    if (isOp('-')) { p++; return { t: 'neg', a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return postfix();
  }
  function power() { let e = unary(); while (isOp('^')) { p++; e = { t: 'bin', op: '^', a: e, b: unary() }; } return e; }
  function mul() { let e = power(); while (isOp('*', '/')) { const op = take().v; e = { t: 'bin', op, a: e, b: power() }; } return e; }
  function add() { let e = mul(); while (isOp('+', '-')) { const op = take().v; e = { t: 'bin', op, a: e, b: mul() }; } return e; }
  function concat() { let e = add(); while (isOp('&')) { p++; e = { t: 'bin', op: '&', a: e, b: add() }; } return e; }
  function cmp() { let e = concat(); while (isOp('=', '<>', '<', '>', '<=', '>=')) { const op = take().v; e = { t: 'bin', op, a: e, b: concat() }; } return e; }
  function expr() { return cmp(); }

  const e = expr();
  if (p < tk.length) throw new Error('unexpected trailing input');
  return e;
}

function splitCell(a) { const m = a.match(/^([A-Z]{1,3})(\d+)$/); return { c: colNum(m[1]), r: +m[2] }; }
const addr = (c, r) => `${colName(c)}${r}`;

module.exports = { parse, tokenize, colNum, colName, addr, splitCell };
