/**
 * Financial Reporting — reads ONE workbook and extracts its statements, note schedules and narrative notes.
 *
 * What decides what a figure is:
 *   statement type   the statement's own title ("…Financial Results…", "Balance Sheet as at…", "Cash Flow…") — not the sheet name
 *   basis            "Standalone" / "Consolidated" in that title (inherited from the workbook only when a title says neither)
 *   period           each column's header wording + date ("QUARTER ENDED 30/06/2026", "As at March 31, 2026"), and its audit label
 *   line             the row label's meaning in its section (see lines.js)
 * Columns headed DevX / Neddle / Saasjoy / Elim (consolidation components and eliminations) and columns standing apart to
 * the right of the statement (working / check columns) are never taken as the reported result.
 *
 * Every figure keeps: file, sheet, cell, the formula, the saved (cached) result, Excel errors, external links, rounding
 * plugs ("…-0.01") and whether the source itself derived the column from other columns ("=+H8-F8").
 * Errors and missing results stay errors — never zero.
 */

'use strict';

const XLSX = require('xlsx');
const crypto = require('crypto');
const P = require('./periods');
const L = require('./lines');

const COMPONENT_RE = /^(devx|dev x|neddle|needle|saasjoy|saas joy|elim|elimination|eliminations|elemination|devx m\d\d|neddle m\d\d|saasjoy m\d\d|elim \d\d)\b/i;
const isComponent = t => t.length <= 45 && COMPONENT_RE.test(t);
const AUDIT_RE = /^\(?\s*(unaudited|audited|reviewed|provisional|limited review)\s*\)?$/i;
const EXT_LINK_RE = /\[\d+\]/;
const PLUG_RE = /([+-])\s*(0\.0\d{1,3})(?![\d.])/g;
const MAX_ROWS = 400, MAX_COLS = 40;

const addr = (r, c) => XLSX.utils.encode_cell({ r, c });
const colName = c => XLSX.utils.encode_col(c);

function cellText(cell) {
  if (!cell) return '';
  if (cell.t === 's' || cell.t === 'str') return String(cell.v || '').replace(/ /g, ' ').trim();
  return '';
}

/** Value of a figure cell, with everything needed to audit it */
function readFigure(ws, r, c) {
  const a = addr(r, c);
  const cell = ws[a];
  const out = { c: a };
  if (!cell || cell.t === 'z' || (cell.v === undefined && !cell.f)) return { ...out, st: 'blank', v: null };
  if (cell.f) out.fx = cell.f.length > 160 ? `${cell.f.slice(0, 157)}…` : cell.f;
  if (cell.f && EXT_LINK_RE.test(cell.f)) out.ext = true;
  if (cell.t === 'e') return { ...out, st: 'error', v: null, err: cell.w || `#ERR${cell.v}` };
  if (cell.v === undefined || cell.v === null) return { ...out, st: cell.f ? 'no_cached' : 'blank', v: null };
  if (cell.t === 'n') return { ...out, st: 'ok', v: cell.v };
  if (cell.t === 'b') return { ...out, st: 'text', v: null, raw: String(cell.v) };
  if (cell.t === 'd') return { ...out, st: 'text', v: null, raw: P.dateToIso(cell.v) };
  const s = String(cell.v).trim();
  if (!s) return { ...out, st: 'blank', v: null };
  if (/^[-–—]+$/.test(s) || /^nil$/i.test(s)) return { ...out, st: 'dash', v: 0, raw: s };
  if (/^#(REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/.test(s)) return { ...out, st: 'error', v: null, err: s };
  const num = Number(s.replace(/,/g, '').replace(/^\((.*)\)$/, '-$1'));
  if (s && !isNaN(num) && /\d/.test(s)) return { ...out, st: 'ok', v: num, raw: s, textNumber: true };
  return { ...out, st: 'text', v: null, raw: s.slice(0, 120) };
}

function plugsIn(fx) {
  if (!fx) return 0;
  let total = 0; let m;
  PLUG_RE.lastIndex = 0;
  while ((m = PLUG_RE.exec(fx))) total += (m[1] === '-' ? -1 : 1) * Number(m[2]);
  return Math.round(total * 1000) / 1000;
}

/** Sheet title: text of the first rows before the header */
function titleOf(ws, rows = 6) {
  const parts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < 14; c++) { const t = cellText(ws[addr(r, c)]); if (t && t.length > 3) parts.push(t); }
  return parts.join(' | ');
}
const TITLE_PART = /financial results|balance sheet|assets and liabilities|cash ?flow|profit (and|&) loss|statement of/i;

/** A notes sheet without a title: note number + title rows, each followed by a "Particulars" heading row */
function looksLikeNotes(ws) {
  const rg = sheetRange(ws);
  if (!rg) return false;
  let hits = 0;
  for (let r = rg.r0; r < Math.min(rg.r1, 400); r++) {
    const a = ws[addr(r, 0)];
    if (!a || a.t !== 'n' || !cellText(ws[addr(r, 1)])) continue;
    for (let k = 1; k <= 2; k++) if (/^\s*particulars\s*$/i.test(cellText(ws[addr(r + k, 1)]))) { hits++; break; }
    if (hits >= 3) return true;
  }
  return false;
}

function classify(title) {
  const t = title.toLowerCase();
  if (/financial results/.test(t)) return 'SEBI';
  if (/notes forming part|notes to (the )?(standalone |consolidated )?financial statements?/.test(t)) return 'NOTES';
  if (/balance sheet|statement of (consolidated )?assets and liabilities|assets and liabilities as at/.test(t)) return 'BS';
  if (/cash ?flows?/.test(t) && !/bridge|working/.test(t)) return 'CF';
  if (/statement of (consolidated )?profit (and|&) loss|^profit and loss\b|\| profit and loss\b/.test(t)) return 'PLD';
  return null;
}
const basisIn = t => (/consolidated/i.test(t) ? 'CO' : /standalone|standandalone/i.test(t) ? 'SA' : null);
const auditIn = t => (/unaudited/i.test(t) ? 'Unaudited' : /audited/i.test(t) ? 'Audited' : null);
function unitIn(t) {
  const s = t.toLowerCase();
  if (/lakh|lacs\b/.test(s)) return 'lakh';
  if (/crore/.test(s)) return 'crore';
  if (/million/.test(s)) return 'million';
  if (/thousand/.test(s)) return 'thousand';
  return null;
}
function titleDate(title) {
  const ds = [];
  for (const part of title.split(' | ')) { if (!TITLE_PART.test(part)) continue; const d = P.parseDateText(part); if (d) ds.push(d); }
  return ds.length ? ds[ds.length - 1] : null;
}

/**
 * Header analysis for a statement / note table. hdrRows are 0-based rows to read; returns the period columns,
 * component columns and anything odd.
 */
function analyseHeader(ws, hdrRows, firstCol, lastCol, merges) {
  const cols = {};
  const groupCells = [];
  const compCells = [];
  for (const r of hdrRows) {
    for (let c = firstCol; c <= lastCol; c++) {
      const cell = ws[addr(r, c)];
      if (!cell) continue;
      const info = cols[c] || (cols[c] = { c, texts: [] });
      if (cell.t === 'd') { info.date = P.dateToIso(cell.v); info.dateCell = addr(r, c); continue; }
      const t = cellText(cell);
      if (!t || t.length > 70) continue;          // statement titles are long; column headings are short
      info.texts.push(t);
      if (AUDIT_RE.test(t)) { info.audit = t.replace(/[()]/g, '').trim().replace(/^\w/, ch => ch.toUpperCase()); continue; }
      if (isComponent(t)) { info.component = t; compCells.push({ r, c, text: t }); continue; }
      const d = P.parseDateText(t);
      const k = P.parseKind(t);
      const loose = !d && !k ? P.parseLooseHeading(t) : null;
      if (d) { info.date = d; info.dateCell = addr(r, c); if (k) info.kind = k; info.header = t.replace(/\s+/g, ' '); }
      else if (loose) { info.date = loose.date; info.dateCell = addr(r, c); info.loose = loose.form; info.header = t.replace(/\s+/g, ' '); }
      else if (k) groupCells.push({ r, c, kind: k, text: t });
    }
  }
  // a company / elimination heading above its columns ("DevX" over three dated columns) marks all of them as components:
  // its merged range, or the columns to its right up to the next heading in that row (at most 3 more, and never a column
  // whose own heading names another component)
  for (const g of compCells) {
    const m = merges.find(mg => mg.s.r <= g.r && mg.e.r >= g.r && mg.s.c <= g.c && mg.e.c >= g.c);
    let c1 = g.c;
    if (m && m.e.c > m.s.c) c1 = m.e.c;
    else {
      while (c1 + 1 <= lastCol && c1 - g.c < 3) {
        const nxt = ws[addr(g.r, c1 + 1)];
        if (nxt && (nxt.t !== 's' || String(nxt.v).trim())) break;
        if (cols[c1 + 1]?.texts.some(isComponent)) break;
        c1++;
      }
    }
    for (let c = g.c; c <= c1; c++) if (cols[c]) cols[c].component = cols[c].component || g.text;
  }
  // group headers ("QUARTER ENDED") cover their merged range, or the run of dated columns to their right
  for (const g of groupCells) {
    const m = merges.find(mg => mg.s.r <= g.r && mg.e.r >= g.r && mg.s.c <= g.c && mg.e.c >= g.c);
    let c0 = g.c, c1 = g.c;
    if (m && m.e.c > m.s.c) { c0 = m.s.c; c1 = m.e.c; }
    else {
      while (c1 + 1 <= lastCol && cols[c1 + 1]?.date && !groupCells.some(o => o.r === g.r && o.c === c1 + 1)) c1++;
    }
    for (let c = c0; c <= c1; c++) if (cols[c] && !cols[c].kind) { cols[c].kind = g.kind; cols[c].group = g.text; }
  }
  return cols;
}

/**
 * Which columns are period columns, which stand apart (working / check).
 * context 'bs': an undated-kind column is a balance-sheet date; 'flow' (P&L, cash flow, P&L notes): "As on <date>" and a
 * bare month heading mean the period ended on that date, cumulative from 1 April.
 */
function periodColumns(cols, context, issues, ctx, o = {}) {
  const dated = Object.values(cols).filter(x => x.date && !x.component).sort((a, b) => a.c - b.c);
  const out = [];
  let lastMain = null;
  for (const col of dated) {
    let kind = col.kind || null;
    if (col.loose === 'fylabel') kind = context === 'bs' ? 'asat' : 'year';
    if (col.loose === 'monthyear') kind = context === 'bs' ? 'asat' : 'period';
    if (!kind && context === 'bs') kind = 'asat';
    if (kind === 'asat' && context === 'flow') kind = 'period';
    if (col.loose) issues.push({ sev: 'info', code: 'HEADING_INTERPRETED', sheet: ctx.sheet, cell: col.dateCell, msg: `Heading "${col.header}" in ${ctx.sheet}!${col.dateCell} has no full date / period wording; read as ${kind === 'asat' ? 'the balance at' : kind === 'year' ? 'the year ended' : 'the period ended (from 1 April)'} ${col.date}.` });
    const per = P.makePeriod(kind, col.date);
    if (!per) {
      issues.push({ sev: 'warning', code: 'PERIOD_NOT_RECOGNISED', sheet: ctx.sheet, cell: col.dateCell, msg: `Column ${colName(col.c)} has the date ${col.date} but its heading ("${(col.group || col.header || col.texts.join(' ')).slice(0, 60)}") does not identify a quarter, half year, nine months, year or balance-sheet date — not imported.` });
      continue;
    }
    // a column separated from the statement by a fully empty column is a working / check column
    let role = 'reported';
    if (lastMain != null && !o.noGap) {
      let gap = false;
      for (let c = lastMain + 1; c < col.c; c++) if (!cols[c] || (!cols[c].texts.length && !cols[c].date)) { gap = true; break; }
      if (gap) role = 'working';
    }
    if (role === 'reported') lastMain = col.c;
    out.push({ c: col.c, col: colName(col.c), period: per.id, kind, audit: col.audit || null, header: (col.group ? `${col.group} ` : '') + (col.header || col.date), role, dateCell: col.dateCell });
  }
  // once a working column is seen, everything after it is working too
  let working = false;
  for (const pc of out) { if (pc.role === 'working') working = true; else if (working) pc.role = 'working'; }
  // the same period twice in one table: consolidation sheets put company columns first and the final column last
  const final = [];
  for (const pc of out) {
    const later = out.filter(o => o.period === pc.period && o.c > pc.c && o.role === pc.role);
    if (later.length) { issues.push({ sev: 'info', code: 'SUPERSEDED_COLUMN', sheet: ctx.sheet, cell: pc.dateCell, period: pc.period, msg: `${ctx.sheet} column ${pc.col} and column ${later[later.length - 1].col} are both ${pc.period}; the right-most (final) column ${later[later.length - 1].col} is used, ${pc.col} is treated as a working column.` }); continue; }
    final.push(pc);
  }
  return final;
}

// Row numbering cells ("I", "XIV", "(a)", "ii)", "A", "1.") are not part of the label
const ENUM_CELL = /^\(?(?:[ivxlIVXL]{1,5}|[a-zA-Z]|\d{1,2})[.)]?\)?$/;
const textCols = (ws, r, firstCol, upto) => {
  const parts = [];
  for (let c = firstCol; c < upto; c++) {
    const cell = ws[addr(r, c)];
    const t = cellText(cell);
    if (t && !ENUM_CELL.test(t)) parts.push(t);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

function sheetRange(ws) {
  const ref = ws['!ref'];
  if (!ref) return null;
  const rg = XLSX.utils.decode_range(ref);
  return { r0: rg.s.r, r1: Math.min(rg.e.r, MAX_ROWS), c0: rg.s.c, c1: Math.min(rg.e.c, MAX_COLS) };
}

/** Is this column a source-side derivation from two other period columns of the same row ("=+H8-F8")? */
function derivation(fx, row, periodByCol) {
  if (!fx) return null;
  const m = fx.replace(/\s+/g, '').match(/^\+*\(?([A-Z]{1,3})(\d+)-([A-Z]{1,3})(\d+)\)?([+-]0\.0\d+)?$/);
  if (!m) return null;
  if (+m[2] !== row + 1 || +m[4] !== row + 1) return null;
  const a = periodByCol[m[1]], b = periodByCol[m[3]];
  if (!a || !b) return null;
  return { plus: a, minus: b };
}

// ── statement sheets ─────────────────────────────────────────────────────────
function extractStatement(ws, sheet, type, ctx) {
  const issues = [];
  const rg = sheetRange(ws);
  if (!rg) return null;
  const merges = ws['!merges'] || [];
  const stmt = type === 'SEBI' || type === 'PLD' ? 'PL' : type;
  // the first row whose label is a canonical line is where figures start; headers are above it
  const probe = L.matcher(stmt);
  let dataStart = null;
  for (let r = rg.r0; r <= Math.min(rg.r1, 40) && dataStart == null; r++) {
    const lbl = textCols(ws, r, 0, 8);
    const hit = lbl && probe.feed(lbl);
    if (hit && hit.id) dataStart = r;
  }
  if (dataStart == null) return null;
  const hdrRows = []; for (let r = Math.max(0, dataStart - 8); r < dataStart; r++) hdrRows.push(r);
  const cols = analyseHeader(ws, hdrRows, 1, rg.c1, merges);
  const pcs = periodColumns(cols, stmt === 'BS' ? 'bs' : 'flow', issues, { sheet });
  if (!pcs.length) return null;
  const components = Object.values(cols).filter(x => x.component).map(x => ({ col: colName(x.c), header: x.component }));
  const firstFig = Math.min(...pcs.map(p => p.c), ...Object.values(cols).filter(x => x.component).map(x => x.c));
  const title = titleOf(ws, Math.max(3, Math.min(dataStart, 6)));
  const hdrText = [title, ...hdrRows.map(r => textCols(ws, r, 0, rg.c1 + 1))].join(' | ');
  const noteCol = (() => {
    for (const r of hdrRows) for (let c = 0; c < firstFig; c++) if (/^notes?(\s*no\.?)?$/i.test(cellText(ws[addr(r, c)]))) return c;
    return null;
  })();
  const periodByCol = Object.fromEntries(pcs.map(p => [p.col, p.period]));

  const rows = [];
  const m = L.matcher(stmt);
  let lastRatio = null;
  // start a few rows above the first line: section headings ("CASH FLOW FROM OPERATING ACTIVITIES") sit there
  for (let r = Math.max(rg.r0, dataStart - 3); r <= rg.r1; r++) {
    const label = textCols(ws, r, 0, firstFig);
    if (r < dataStart && /^particulars/i.test(label)) continue;
    const figs = pcs.map(pc => ({ pc, f: readFigure(ws, r, pc.c) }));
    const hasFig = figs.some(x => x.f.st !== 'blank');
    if (!label && !hasFig) continue;
    if (!label) continue;
    if (/^(place|date)\s*:?/i.test(label) || /^for,? dev accelerator/i.test(label)) break;
    const hit = m.feed(label);
    if (!hit) {
      if (hasFig && figs.some(x => x.f.st === 'ok' && x.f.v !== 0)) rows.push({ r, label, id: `${stmt.toLowerCase()}.x.${L.slug(label)}`, unmapped: true, figs, sec: m.sec });
      continue;
    }
    if (hit.header) continue;
    if (hit.ratioText) { if (lastRatio && !lastRatio.definition && !/annuali[sz]ed/i.test(hit.ratioText)) lastRatio.definition = hit.ratioText.trim(); else if (/annuali[sz]ed/i.test(hit.ratioText)) ctx.ratioNote = hit.ratioText.trim(); continue; }
    const id = hit.id || hit.extra;
    const note = noteCol != null ? ws[addr(r, noteCol)] : null;
    const row = { r, label, id, figs, sec: hit.sec, noteRef: note && note.v != null && note.t !== 'e' ? String(note.v) : null, extra: !!hit.extra };
    rows.push(row);
    if (id.startsWith('rt.')) lastRatio = row;
  }

  // the same line on several rows (a left-over placeholder row and the real one): merged column by column — each column
  // takes the row that carries a figure there; when two rows both carry one, the first is used and both are reported
  const groups = new Map();
  for (const row of rows) { if (!groups.has(row.id)) groups.set(row.id, []); groups.get(row.id).push(row); }
  for (const [id, rs] of groups) {
    if (rs.length < 2) continue;
    const has = (row, i) => row.figs[i].f.st === 'ok' && row.figs[i].f.v !== 0;
    const main = [...rs].sort((a, b) => pcs.filter((_, i) => has(b, i)).length - pcs.filter((_, i) => has(a, i)).length || b.r - a.r)[0];
    const merged = { ...main, figs: main.figs.map((x, i) => {
      const carriers = rs.filter(row => has(row, i));
      if (carriers.length > 1) issues.push({ sev: 'warning', code: 'DUPLICATE_LINE', sheet, cell: carriers[1].figs[i].f.c, period: pcs[i].period, line: id,
        msg: `"${carriers[0].label}" (row ${carriers[0].r + 1}) and "${carriers[1].label}" (row ${carriers[1].r + 1}) both carry a ${pcs[i].period} figure for the same line (${carriers[0].figs[i].f.v} and ${carriers[1].figs[i].f.v}); the first is used and the workbook's own total should be checked.` });
      if (carriers.length) return carriers[0].figs[i];
      return rs.map(row => row.figs[i]).find(y => y.f.st !== 'blank') || x;
    }), mergedRows: rs.map(row => row.r + 1) };
    for (const row of rs) row.dropped = row === main ? 'merged' : 'merged into row ' + (main.r + 1);
    merged.dropped = null;
    rows.splice(rows.indexOf(main), 1, merged);
  }
  // cash-flow rows that only break down the row above them (a sub-total followed by its items) are marked as detail,
  // so they are shown indented and never added twice
  if (stmt === 'CF') {
    const live = rows.filter(x => !x.dropped);
    for (let i = 0; i < live.length; i++) {
      const head = live[i];
      if (L.BY_ID[head.id]?.bold) continue;
      for (let n = 2; n <= 8 && i + n < live.length; n++) {
        const kids = live.slice(i + 1, i + 1 + n);
        if (kids.some(k => L.BY_ID[k.id]?.bold || k.detailOf)) break;
        let cols = 0, ok = true;
        pcs.forEach((_, ci) => {
          const hv = head.figs[ci].f, kv = kids.map(k => k.figs[ci].f);
          if (hv.st !== 'ok' || kv.every(k => k.st !== 'ok')) return;
          const sum = kv.reduce((s, k) => s + (k.st === 'ok' ? k.v : 0), 0);
          if (Math.abs(hv.v - sum) > 0.011 || hv.v === 0) ok = false; else cols++;
        });
        if (ok && cols >= 2) { kids.forEach(k => { k.detailOf = head.id; }); head.hasDetail = true; i += n; break; }
      }
    }
  }

  const basisT = basisIn(title);
  const st = {
    sheet, type, stmt, title: title.slice(0, 400), basis: basisT, basisFromTitle: !!basisT, titleDate: titleDate(title), titleAudit: auditIn(title),
    unit: unitIn(hdrText), epsUnitNoted: /except eps/i.test(hdrText), hidden: !!ctx.hidden, periods: pcs, components, dataStart: dataStart + 1,
    ratioNote: ctx.ratioNote || null, rows: rows.filter(x => !x.dropped), droppedRows: rows.filter(x => x.dropped).map(x => ({ r: x.r + 1, label: x.label, why: x.dropped })),
    periodByCol, issues,
  };
  return st;
}

// ── note schedules ───────────────────────────────────────────────────────────
function extractNotes(ws, sheet, ctx) {
  const rg = sheetRange(ws);
  if (!rg) return { notes: [], issues: [] };
  const issues = [];
  const merges = ws['!merges'] || [];
  const notes = [];
  let cur = null;
  let pcs = null, firstFig = 2;
  // P&L notes read "As on <date>" as a period end, balance-sheet notes as a balance date (a note's own title decides first)
  const sheetFlow = /p\s*&\s*l|profit/i.test(sheet);
  const maxR = Math.min(rg.r1 + 1, 3000) - 1;
  const rr = sheetRangeFull(ws, 3000);
  for (let r = rr.r0; r <= rr.r1; r++) {
    const a = ws[addr(r, 0)];
    const titleCell = cellText(ws[addr(r, 1)]);
    const num = a && (a.t === 'n' || (a.t === 's' && /^\d{1,2}(\.\d{1,2})?$/.test(String(a.v).trim()))) ? String(a.t === 'n' ? +a.v.toFixed(2) : String(a.v).trim()) : null;
    // header row: two or more period headings
    // the row above a heading row carries company group labels ("DevX", "Neddle", "Elim") in consolidation notes
    const hdr = analyseHeader(ws, r > 0 ? [r - 1, r] : [r], 2, rr.c1, merges);
    const flow = cur ? cur.flow : sheetFlow;
    // note tables put company columns (separated by spacer columns) before the final ones: no working-column split here
    const hdrPcs = periodColumns(hdr, flow ? 'flow' : 'bs', [], { sheet }, { noGap: true }).filter(p => p.role === 'reported');
    const hdrLabel = cellText(ws[addr(r, 1)]).replace(/\s+/g, ' ').trim();
    if (hdrPcs.length >= 1 && (!hdrLabel || /^particulars$/i.test(hdrLabel))) {
      pcs = hdrPcs;
      firstFig = Math.min(...hdrPcs.map(p => p.c), ...Object.values(hdr).filter(x => x.component).map(x => x.c));
      if (cur) cur.periods = [...new Set([...(cur.periods || []), ...pcs.map(p => p.period)])];
      continue;
    }
    if (num && titleCell && titleCell.length > 2 && !/^\d/.test(titleCell)) {
      const tl = L.lineForNoteTitle(titleCell);
      cur = { num, title: titleCell.replace(/\s+/g, ' ').trim(), sheet, row: r + 1, items: [], periods: [], text: [], flow: tl ? tl.startsWith('pl.') : sheetFlow };
      notes.push(cur);
      pcs = null;
      continue;
    }
    if (!cur) continue;
    const label = textCols(ws, r, 1, pcs ? firstFig : Math.min(rr.c1 + 1, 6));
    if (!label) continue;
    if (!pcs) { if (label.length > 30 && cur.text.length < 8) cur.text.push(label.slice(0, 1500)); continue; }
    const figs = pcs.map(pc => ({ pc, f: readFigure(ws, r, pc.c) }));
    const hasFig = figs.some(x => x.f.st !== 'blank' && x.f.st !== 'text');
    const isTotal = /^(total|grand total|net total)\b/i.test(label.trim());
    cur.items.push({ r: r + 1, label: label.slice(0, 200), key: L.slug(label), total: isTotal, subhead: !hasFig, figs: hasFig ? figs.map(x => ({ p: x.pc.period, role: x.pc.role, col: x.pc.col, ...x.f })) : [] });
  }
  void maxR;
  // drop empty notes; keep note text for narrative ones
  return { notes: notes.filter(n => n.items.some(i => !i.subhead) || n.text.length), issues };
}
function sheetRangeFull(ws, maxRows) {
  const ref = ws['!ref'];
  const rg = XLSX.utils.decode_range(ref);
  return { r0: rg.s.r, r1: Math.min(rg.e.r, maxRows), c0: rg.s.c, c1: Math.min(rg.e.c, MAX_COLS) };
}

// ── narrative notes to the results ────────────────────────────────────────────
function extractNarrative(ws, sheet) {
  const rg = sheetRange(ws);
  if (!rg) return [];
  const out = [];
  let cur = null;
  for (let r = rg.r0; r <= rg.r1; r++) {
    const a = ws[addr(r, 0)];
    const num = a && a.t === 'n' ? a.v : null;
    const texts = [];
    for (let c = 1; c < Math.min(rg.c1 + 1, 12); c++) { const t = cellText(ws[addr(r, c)]); if (t) texts.push(t); }
    const nums = [];
    for (let c = 1; c < Math.min(rg.c1 + 1, 12); c++) { const cell = ws[addr(r, c)]; if (cell && cell.t === 'n') nums.push({ c: addr(r, c), v: cell.v }); }
    if (!texts.length && !nums.length) continue;
    if (/^(place|date)\s*:?$/i.test(texts[0] || '') || /^for,? dev accelerator/i.test(texts[0] || '')) break;
    if (num != null && texts.length) { cur = { num, text: texts.join(' ').slice(0, 3000), sheet, row: r + 1, table: [] }; out.push(cur); continue; }
    if (cur && (texts.length || nums.length)) cur.table.push({ r: r + 1, label: texts.join(' | ').slice(0, 300), values: nums });
  }
  return out;
}

/** Whole workbook → extraction (no storage) */
function extractWorkbook(buf, meta = {}) {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const wb = XLSX.read(buf, { cellFormula: true, cellDates: true, cellNF: false, cellStyles: false });
  const hiddenOf = Object.fromEntries((wb.Workbook?.Sheets || []).map(s => [s.name, !!s.Hidden]));
  const statements = [];
  const notes = [];
  const narrative = [];
  const issues = [];
  const errorsSeen = [];
  const skippedSheets = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const title = titleOf(ws);
    let type = classify(title);
    if (!type && looksLikeNotes(ws)) type = 'NOTES';
    const isSebiNotes = /^notes?:?$/i.test(cellText(ws.A1)) || (/results notes/i.test(name) && !type);
    if (isSebiNotes) { narrative.push(...extractNarrative(ws, name).map(n => ({ ...n, hidden: !!hiddenOf[name] }))); continue; }
    if (!type) { skippedSheets.push(name); continue; }
    if (type === 'NOTES') {
      const res = extractNotes(ws, name, {});
      for (const n of res.notes) { n.hidden = !!hiddenOf[name]; n.basis = basisIn(title); notes.push(n); }
      issues.push(...res.issues);
      continue;
    }
    const st = extractStatement(ws, name, type, { hidden: !!hiddenOf[name] });
    if (!st) { skippedSheets.push(name); continue; }
    statements.push(st);
  }

  // workbook basis: what the statement titles say (all must agree)
  const said = [...new Set(statements.filter(s => s.basis).map(s => s.basis))];
  let basis = said.length === 1 ? said[0] : null;
  if (said.length > 1) issues.push({ sev: 'error', code: 'BASIS_CONFLICT', msg: `Statement titles in this workbook disagree on the reporting basis (${said.join(' and ')}). The workbook was not imported.` });
  const fnBasis = basisIn(meta.name || '');
  if (basis && fnBasis && fnBasis !== basis) issues.push({ sev: 'warning', code: 'BASIS_FILENAME', msg: `The file name suggests ${fnBasis === 'CO' ? 'consolidated' : 'standalone'} but the statement titles say ${basis === 'CO' ? 'consolidated' : 'standalone'}; the titles are used.` });
  if (!basis && fnBasis) { basis = fnBasis; issues.push({ sev: 'warning', code: 'BASIS_FROM_FILENAME', msg: 'No statement title states the reporting basis; it was taken from the file name.' }); }
  for (const s of statements) {
    if (!s.basis) { s.basis = basis; s.issues.push({ sev: 'info', code: 'BASIS_INFERRED', sheet: s.sheet, msg: `The title of "${s.sheet}" does not say standalone or consolidated; the workbook's basis (${basis === 'CO' ? 'consolidated' : 'standalone'}) is used.` }); }
  }
  for (const n of notes) if (!n.basis) n.basis = basis;

  // reporting date: the latest date in a results/statement title — the period this workbook was prepared for
  const titleDates = statements.filter(s => s.type === 'SEBI' && s.titleDate).map(s => s.titleDate);
  const reportingDate = (titleDates.length ? titleDates : statements.map(s => s.titleDate).filter(Boolean)).sort().pop() || null;

  for (const s of statements) {
    const ends = s.periods.map(p => P.fromId(p.period)?.end);
    for (const pc of s.periods) {
      const per = P.fromId(pc.period);
      if (pc.role === 'working') continue;
      pc.role = per.end === reportingDate ? 'primary' : 'comparative';
    }
    // stale titles / sheet names
    if (s.titleDate && !ends.includes(s.titleDate)) {
      s.issues.push({ sev: 'warning', code: 'STALE_TITLE', sheet: s.sheet, msg: `The statement title of "${s.sheet}" refers to ${s.titleDate}, but its columns are ${[...new Set(s.periods.map(p => p.period))].join(', ')}. The columns' own headings were used.` });
      // a hidden sheet whose title and columns disagree is an old working table: kept for reference, never shown as reported
      if (s.hidden) { for (const pc of s.periods) pc.role = 'working'; s.issues.push({ sev: 'warning', code: 'UNRELIABLE_HIDDEN_SHEET', sheet: s.sheet, msg: `"${s.sheet}" is hidden and its title contradicts its column headings; its figures are kept only as a working source and are not used in any statement.` }); }
    }
    const nm = s.sheet.match(/\bQ([1-4])\s*FY\s*(\d{2})\s*-\s*(\d{2})/i);
    if (nm && s.type === 'SEBI') {
      const prim = s.periods.find(p => p.role === 'primary' && P.fromId(p.period).type === 'Q');
      const named = `FY20${nm[3]}-Q${nm[1]}`;
      if (prim && prim.period !== named) s.issues.push({ sev: 'warning', code: 'STALE_SHEET_NAME', sheet: s.sheet, msg: `The sheet is named "${s.sheet}" (Q${nm[1]} FY${nm[2]}-${nm[3]}), but its statement heading and columns are for ${P.fromId(prim.period).label}. It was mapped by its heading and dates, not its name.` });
    }
    if (!s.unit) {
      const units = [...new Set(statements.filter(o => o.unit && !o.unitInferred).map(o => o.unit))];
      if (units.length === 1) { s.unit = units[0]; s.unitInferred = true; s.issues.push({ sev: 'warning', code: 'UNIT_INFERRED', sheet: s.sheet, msg: `"${s.sheet}" does not state its unit; the unit of the workbook's other statements (${units[0]}) is assumed. The cross-statement checks on the Data Validation tab test this.` }); }
      else s.issues.push({ sev: 'warning', code: 'UNIT_UNKNOWN', sheet: s.sheet, msg: `No unit (lakhs / crores) is stated in the heading of "${s.sheet}". Its figures are kept but flagged.` });
    }
    if (s.hidden) s.issues.push({ sev: 'info', code: 'HIDDEN_SHEET', sheet: s.sheet, msg: `"${s.sheet}" is a hidden sheet. Its figures are kept as a lower-priority source (for cross-checking repeated figures).` });
    if (s.components.length) s.issues.push({ sev: 'info', code: 'COMPONENT_COLUMNS_SKIPPED', sheet: s.sheet, msg: `Consolidation component / elimination columns ${s.components.map(c => `${c.col} (${c.header})`).join(', ')} were not imported — only the final consolidated columns.` });
    for (const pc of s.periods.filter(p => p.role === 'working')) s.issues.push({ sev: 'info', code: 'WORKING_COLUMN', sheet: s.sheet, cell: pc.dateCell, period: pc.period, msg: `Column ${pc.col} ("${pc.header}") stands apart from the published statement. Its figures are kept as a working (unpublished) source.` });
  }
  for (const n of notes) for (const it of n.items) for (const f of it.figs) {
    const per = P.fromId(f.p);
    if (f.role !== 'working') f.role = per && per.end === reportingDate ? 'primary' : 'comparative';
  }

  // per-figure findings
  for (const s of statements) {
    // Excel errors per column: a column broken in several lines is a weak source (kept, flagged, never a decision driver)
    for (const pc of s.periods) pc.errors = s.rows.filter(row => row.figs.find(x => x.pc === pc)?.f.st === 'error').length;
    const derivedSeen = new Set();
    for (const row of s.rows) {
      for (const { pc, f } of row.figs) {
        if (f.st === 'error') { errorsSeen.push({ sheet: s.sheet, cell: f.c, err: f.err }); s.issues.push({ sev: 'error', code: 'EXCEL_ERROR', sheet: s.sheet, cell: f.c, period: pc.period, line: row.id, msg: `${f.err} in ${s.sheet}!${f.c} ("${row.label}", ${pc.period}). Kept as an error — not zero.` }); }
        if (f.st === 'no_cached') s.issues.push({ sev: 'error', code: 'NO_CACHED_VALUE', sheet: s.sheet, cell: f.c, period: pc.period, line: row.id, msg: `${s.sheet}!${f.c} has a formula but no saved result (open and save the workbook in Excel).` });
        if (f.ext) s.issues.push({ sev: f.st === 'ok' ? 'info' : 'error', code: 'EXTERNAL_LINK', sheet: s.sheet, cell: f.c, period: pc.period, line: row.id, msg: `${s.sheet}!${f.c} links to another workbook (${f.fx}); ${f.st === 'ok' ? 'the saved result is used' : 'no saved result is available'}.` });
        const plug = plugsIn(f.fx);
        if (plug) { f.plug = plug; s.issues.push({ sev: 'info', code: 'ROUNDING_PLUG', sheet: s.sheet, cell: f.c, period: pc.period, line: row.id, value: plug, msg: `${s.sheet}!${f.c} ("${row.label}") includes a manual adjustment of ${plug > 0 ? '+' : ''}${plug} in its formula (=${f.fx}).` }); }
        const der = derivation(f.fx, row.r, s.periodByCol);
        if (der) {
          f.der = der;
          const isEps = row.id.startsWith('pl.eps');
          const key = `${pc.period}|${isEps}`;
          if (!derivedSeen.has(key)) {
            derivedSeen.add(key);
            s.issues.push({ sev: isEps ? 'warning' : 'info', code: isEps ? 'EPS_DERIVED_IN_SOURCE' : 'DERIVED_IN_SOURCE', sheet: s.sheet, cell: f.c, period: pc.period, line: isEps ? row.id : null,
              msg: isEps ? `The source derives ${pc.period} EPS by subtracting cumulative EPS (${der.plus} − ${der.minus}) in ${s.sheet}!${f.c}. EPS is not additive across periods; the figure is kept as reported and flagged.`
                : `In "${s.sheet}" the ${pc.period} column is calculated in the workbook as ${der.plus} − ${der.minus} (e.g. ${f.c} =${f.fx}).` });
          }
        }
        if (f.st === 'ok' && !f.fx && Math.abs(f.v * 100 - Math.round(f.v * 100)) < 1e-6 && Math.abs(f.v) >= 0.01) f.r2 = true;   // typed, rounded to 2 decimals
      }
      if (row.unmapped) s.issues.push({ sev: 'warning', code: 'UNMAPPED_ROW', sheet: s.sheet, cell: `${s.periods[0]?.col}${row.r + 1}`, line: row.id, msg: `Row ${row.r + 1} "${row.label}" in "${s.sheet}" carries figures but matches no standard line; kept as "${row.id}".` });
    }
  }

  return {
    file: { name: meta.name || 'workbook.xlsx', sha256, size: buf.length, mtime: meta.mtime || null },
    basis, reportingDate, statements, notes, narrative, issues, skippedSheets, sheetCount: wb.SheetNames.length,
    hiddenSheets: Object.entries(hiddenOf).filter(([, h]) => h).map(([n]) => n),
  };
}

module.exports = { extractWorkbook, readFigure, analyseHeader, classify, plugsIn, derivation };
