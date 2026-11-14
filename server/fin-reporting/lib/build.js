/**
 * Financial Reporting — turns the extractions of several workbooks into ONE import version.
 *
 * A version holds every figure as a fact with its provenance, so the same period can carry several competing source
 * figures (e.g. FY2025-26 from the audited annual workbook AND as repeated in the Sep-26 workbook). Nothing is merged or
 * overwritten here; model.js chooses which figure a statement shows and keeps the others visible as alternatives.
 *
 * Fact (compact keys, kept small because a version is stored as one document):
 *   b basis (SA|CO)  s statement (PL|BS|CF|RT)  l line id  p period id  v value (null for blank/error/text)  st status
 *   u unit  f file index  sh sheet  c cell  fx formula  err Excel error  role primary|comparative|working
 *   aud audit label  k source kind (SEBI|PLD|BS|CF)  hid hidden sheet  plug manual ±0.0x in formula
 *   der { plus, minus } source derived the column  r2 typed and rounded to 2 decimals  lbl source label
 *   nr note reference  ext external link  sec section  x unmapped/extra row
 */

'use strict';

const P = require('./periods');
const L = require('./lines');

function unitOf(lineId, stUnit) {
  const def = L.BY_ID[lineId];
  if (def?.unit) return def.unit;
  return stUnit || null;
}

function build(extractions, meta = {}) {
  const files = [];
  const facts = [];
  const notes = [];
  const narrative = [];
  const issues = [];
  const periods = {};
  const ratioDefs = {};
  const statements = [];
  const usePeriod = id => { if (!periods[id]) periods[id] = P.fromId(id); };

  extractions.forEach((x, fi) => {
    const fileIssues = [...x.issues];
    files.push({
      f: fi, name: x.file.name, sha256: x.file.sha256, size: x.file.size, mtime: x.file.mtime, basis: x.basis, reportingDate: x.reportingDate,
      sheetCount: x.sheetCount, hiddenSheets: x.hiddenSheets.length, skippedSheets: x.skippedSheets,
    });
    const noteLines = {};   // note ref → statement lines, within this workbook
    for (const s of x.statements) {
      const unreliable = s.issues.some(i => i.code === 'UNRELIABLE_HIDDEN_SHEET');
      statements.push({ f: fi, sheet: s.sheet, type: s.type, stmt: s.stmt, basis: s.basis, title: s.title, titleDate: s.titleDate, unit: s.unit, unitInferred: !!s.unitInferred,
        hidden: s.hidden, periods: s.periods.map(p => ({ col: p.col, period: p.period, role: p.role, audit: p.audit, header: p.header })), components: s.components, dropped: s.droppedRows, ratioNote: s.ratioNote });
      fileIssues.push(...s.issues);
      for (const row of s.rows) {
        if (row.noteRef && /^\d+(\.\d+)?$/.test(row.noteRef) && !row.id.includes('.x.')) (noteLines[row.noteRef] = noteLines[row.noteRef] || []).push(row.id);
        if (row.id.startsWith('rt.') && row.definition) ratioDefs[`${s.basis}|${row.id}`] = { definition: row.definition, f: fi, sheet: s.sheet };
        const stmt = row.id.startsWith('rt.') ? 'RT' : s.stmt;
        for (const { pc, f } of row.figs) {
          usePeriod(pc.period);
          const fact = { b: s.basis, s: stmt, l: row.id, p: pc.period, v: f.v, st: f.st, u: unitOf(row.id, s.unit), f: fi, sh: s.sheet, c: f.c, role: pc.role, k: s.type, lbl: row.label.slice(0, 140) };
          if (f.fx) fact.fx = f.fx;
          if (f.err) fact.err = f.err;
          if (pc.audit || s.titleAudit) fact.aud = pc.audit || null;
          if (s.hidden) fact.hid = 1;
          if (f.plug) fact.plug = f.plug;
          if (f.der) fact.der = f.der;
          if (f.r2) fact.r2 = 1;
          if (f.ext) fact.ext = 1;
          if (f.raw != null && f.st !== 'ok') fact.raw = f.raw;
          if (row.noteRef) fact.nr = row.noteRef;
          if (row.sec) fact.sec = row.sec;
          if (row.unmapped || row.extra) fact.x = 1;
          if (s.unitInferred) fact.ui = 1;
          if (unreliable) fact.unrel = 1;
          if (row.detailOf) fact.dt = row.detailOf;
          if (pc.errors >= 3) fact.ce = pc.errors;
          facts.push(fact);
        }
      }
    }
    for (const n of x.notes) {
      const linked = noteLines[n.num] || null;
      // linked by reference first; by title only for a main note ("28"), never a sub-note table ("45.1")
      const byTitle = /^d+$/.test(n.num) ? L.lineForNoteTitle(n.title) : null;
      let lines = linked || (byTitle ? [byTitle] : []);
      // trade payables are one note presented on two rows (MSME / others); the note reference sits on one of them
      if (lines.some(l => l === 'bs.cl_tp_msme' || l === 'bs.cl_tp_other')) lines = [...new Set([...lines, 'bs.cl_tp_msme', 'bs.cl_tp_other'])];
      const items = n.items.map(it => {
        const v = {};
        for (const fg of it.figs) { usePeriod(fg.p); v[fg.p] = { v: fg.v, st: fg.st, c: fg.c, ...(fg.fx ? { fx: fg.fx } : {}), ...(fg.err ? { err: fg.err } : {}), role: fg.role }; }
        return { label: it.label, key: it.key, total: it.total || undefined, subhead: it.subhead || undefined, r: it.r, v };
      });
      notes.push({ b: n.basis || x.basis, f: fi, sheet: n.sheet, hid: n.hidden ? 1 : undefined, num: n.num, title: n.title, row: n.row, lines, linkedBy: linked ? 'note reference' : byTitle ? 'title' : null,
        periods: n.periods, items, text: n.text.length ? n.text : undefined });
    }
    for (const nn of x.narrative) narrative.push({ b: x.basis, f: fi, sheet: nn.sheet, hid: nn.hidden ? 1 : undefined, num: nn.num, text: nn.text, table: nn.table, row: nn.row });
    for (const i of fileIssues) issues.push({ f: fi, ...i });
  });

  return {
    builtAt: new Date().toISOString(), builtBy: meta.user || null, files, statements, periods, facts, notes, narrative, issues, ratioDefs,
    counts: { facts: facts.length, notes: notes.length, noteValues: notes.reduce((s, n) => s + n.items.reduce((t, i) => t + Object.keys(i.v).length, 0), 0), issues: issues.length },
  };
}

module.exports = { build };
