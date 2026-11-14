/**
 * Financial Reporting — Data Validation & Reconciliation.
 *
 * Every check produces a row:  basis | period | statement | particulars | source figure | module figure | difference |
 * source reference | status | explanation.  "Source figure" is what the workbook shows; "module figure" is what the module
 * recalculates (sum of components, the other statement, the note total, the repeated figure, the legacy module value).
 * Every difference is listed, including those inside the rounding tolerance. Nothing is adjusted to make a check agree.
 *
 * Status:  Agrees (< 0.0005) · Rounding (≤ tolerance; + 0.005 when one side was typed rounded to 2 decimals)
 *          Difference (above tolerance, below materiality) · Material difference (above materiality — a decision request
 *          when it is a conflict between sources) · Unreconciled (an Excel error / missing figure prevents the check) · Info
 * Defaults: amounts tolerance ₹0.015 lakh, materiality ₹1.00 lakh; EPS tolerance ₹0.0005, materiality ₹0.01; editable
 * on Management Inputs → Thresholds.
 */

'use strict';

const P = require('./periods');
const L = require('./lines');
const M = require('./model');

const DEFAULTS = { tolerance: 0.015, materiality: 1.0, epsTolerance: 0.0005, epsMateriality: 0.01, ratioTolerance: 0.0005 };
const r6 = x => (x == null ? null : Math.round(x * 1e6) / 1e6);

function statusOf(diff, o) {
  if (diff == null) return 'Unreconciled';
  const a = Math.abs(diff);
  if (a < (o.eps ? 0.00005 : 0.0005)) return 'Agrees';
  if (a <= o.tol + (o.rounded ? (o.eps ? 0.005 : 0.005) : 0) + 1e-9) return 'Rounding';
  if (a <= o.mat + 1e-9) return 'Difference';
  return 'Material difference';
}

function ref(version, fc) {
  if (!fc) return '';
  const file = version.files[fc.f]?.name || `file ${fc.f}`;
  return `${file} › ${fc.sh}!${fc.c}${fc.fx ? ` (=${fc.fx})` : ''}`;
}

function reconcile(version, opts = {}) {
  const o = { ...DEFAULTS, ...(opts.thresholds || {}) };
  const ctx = opts.ctx || M.makeCtx(version, { mode: opts.mode || 'original', decisions: opts.decisions });
  const rows = [];
  const decisions = [];
  let seq = 0;
  const add = r => rows.push({ id: ++seq, ...r, source: r6(r.source), module: r6(r.module), diff: r6(r.diff) });
  const files = version.files;

  // ── 1. arithmetic inside each source statement (per sheet, per period column) ───────────────────────────────────
  const bySheet = new Map();
  for (const fc of version.facts) {
    if (fc.unrel) continue;
    const k = `${fc.f}|${fc.sh}|${fc.p}`;
    if (!bySheet.has(k)) bySheet.set(k, new Map());
    bySheet.get(k).set(fc.l, fc);
  }
  for (const [k, m] of bySheet) {
    const [f, sh, p] = k.split('|');
    const any = [...m.values()][0];
    const b = any.b, stmt = any.s === 'RT' ? 'PL' : any.s;
    const get = id => m.get(id);
    const valOf = id => { const fc = get(id); if (!fc) return { v: 0, missing: true }; if (fc.st === 'ok' || fc.st === 'dash') return { v: fc.v }; if (fc.st === 'blank') return { v: 0, blank: true }; return { v: null, err: fc }; };
    const check = (cat, totalId, parts, label) => {
      const tot = get(totalId);
      if (!tot || tot.st === 'blank') return;
      const comps = parts.map(([id, sign]) => ({ id, sign, ...valOf(id) }));
      if (!comps.some(c => !c.missing)) return;
      const errs = comps.filter(c => c.err);
      const srcV = tot.st === 'ok' ? tot.v : null;
      const modV = errs.length ? null : comps.reduce((s, c) => s + c.sign * c.v, 0);
      const diff = srcV != null && modV != null ? srcV - modV : null;
      let expl = '';
      if (tot.st === 'error') expl = `The total itself is ${tot.err} in the workbook.`;
      else if (errs.length) expl = `Component ${errs.map(e => `${L.BY_ID[e.id]?.label || e.id} (${e.err.err || e.err.st} at ${e.err.sh}!${e.err.c})`).join(', ')} is an Excel error / has no value, so the total cannot be recomputed.`;
      else if (diff != null && Math.abs(diff) >= 0.0005 && tot.plug && Math.abs(Math.abs(diff) - Math.abs(tot.plug)) < 0.0015) expl = `The difference equals the manual adjustment (${tot.plug > 0 ? '+' : ''}${tot.plug}) typed into the total's formula in the workbook.`;
      else if (diff != null && Math.abs(diff) >= 0.0005) {
        const plugged = parts.map(([id]) => get(id)).filter(x => x?.plug);
        expl = plugged.length ? `Components carry manual adjustments in their formulas (${plugged.map(x => `${x.c}: ${x.plug}`).join(', ')}).` : 'Components do not add up to the total shown in the workbook.';
      } else expl = 'Total equals the sum of its components.';
      const blanks = comps.filter(c => c.blank).map(c => L.BY_ID[c.id]?.label || c.id);
      if (blanks.length && diff != null) expl += ` Blank lines read as nil: ${blanks.join(', ')}.`;
      add({ b, p, stmt, check: cat, particulars: label || `${L.BY_ID[totalId]?.label || totalId} = ${parts.map(([id, s]) => `${s < 0 ? '− ' : '+ '}${L.BY_ID[id]?.label || id}`).join(' ').replace(/^\+ /, '')}`,
        source: srcV, module: modV, diff, ref: ref(version, tot), status: tot.st === 'error' || errs.length ? 'Unreconciled' : statusOf(diff, { tol: o.tolerance, mat: o.materiality }), expl, line: totalId, f: +f, sh });
    };
    const plus = ids => ids.map(id => [id, 1]);
    if (stmt === 'PL') {
      check('Subtotal', 'pl.tot_inc', plus(['pl.rev', 'pl.oth_inc']), 'Revenue + other income = total income');
      check('Subtotal', 'pl.exp_tot', plus(['pl.exp_ops', 'pl.exp_emp', 'pl.exp_fin', 'pl.exp_dep', 'pl.exp_oth']), 'Expense components = total expenses');
      check('Subtotal', 'pl.pbe', [['pl.tot_inc', 1], ['pl.exp_tot', -1]], 'Total income − total expenses = profit before exceptional items and tax');
      if (get('pl.pb_assoc')) {
        check('Subtotal', 'pl.pb_assoc', [['pl.pbe', 1], ['pl.exceptional', -1]], 'Profit before exceptional items − exceptional items = profit before share of associates');
        check('Subtotal', 'pl.pbt', [['pl.pb_assoc', 1], ['pl.share_assoc', 1]], 'Profit before share of associates + share of associates = PBT');
      } else if (get('pl.share_assoc')) check('Subtotal', 'pl.pbt', [['pl.pbe', 1], ['pl.exceptional', -1], ['pl.share_assoc', 1]], 'Profit before exceptional items − exceptional items + share of associates = PBT');
      else check('Subtotal', 'pl.pbt', [['pl.pbe', 1], ['pl.exceptional', -1]], 'Profit before exceptional items − exceptional items = PBT');
      check('Subtotal', 'pl.tax_tot', plus(['pl.tax_cur', 'pl.tax_def', 'pl.tax_prior']), 'Current + deferred + earlier-year tax = total tax');
      check('Subtotal', 'pl.pat', [['pl.pbt', 1], ['pl.tax_tot', -1]], 'PBT − total tax = PAT');
      check('Subtotal', 'pl.oci_tot', plus(['pl.oci_nr', 'pl.oci_nr_tax', 'pl.oci_r', 'pl.oci_r_tax']), 'OCI items and their tax = total OCI');
      check('Subtotal', 'pl.tci', plus(['pl.pat', 'pl.oci_tot']), 'PAT + OCI = total comprehensive income');
      if (get('pl.pat_owners')) {
        check('Attribution', 'pl.pat', plus(['pl.pat_owners', 'pl.pat_nci']), 'PAT = owners + non-controlling interests');
        check('Attribution', 'pl.oci_tot', plus(['pl.oci_owners', 'pl.oci_nci']), 'OCI = owners + non-controlling interests');
        check('Attribution', 'pl.tci', plus(['pl.tci_owners', 'pl.tci_nci']), 'Total comprehensive income = owners + non-controlling interests');
      }
    }
    if (stmt === 'BS') {
      for (const id of ['bs.nca_tot', 'bs.ca_tot', 'bs.ta', 'bs.ncl_tot', 'bs.cl_tot', 'bs.tel']) check('Subtotal', id, plus(L.BY_ID[id].sum));
      if (get('bs.eq_owners')?.st === 'ok') { check('Subtotal', 'bs.eq_owners', plus(['bs.share_cap', 'bs.oth_eq'])); check('Subtotal', 'bs.eq_tot', plus(['bs.eq_owners', 'bs.nci'])); }
      else check('Subtotal', 'bs.eq_tot', plus(['bs.share_cap', 'bs.oth_eq', 'bs.nci']));
      check('Balance', 'bs.ta', [['bs.tel', 1]], 'Total assets = total equity and liabilities');
    }
    if (stmt === 'CF') {
      const rowNo = fc => +String(fc.c).replace(/^[A-Z]+/, '');
      const items = [...m.values()].filter(fc => fc.s === 'CF');
      const subs = new Set(['cf.op_bwc', 'cf.wc', 'cf.cash_gen', 'cf.cfo', 'cf.cfi', 'cf.cff', 'cf.net', 'cf.open', 'cf.close']);
      const secOf = fc => fc.sec || L.BY_ID[fc.l]?.sec;
      const between = (sec, lo, hi) => items.filter(fc => secOf(fc) === sec && !subs.has(fc.l) && !fc.dt && rowNo(fc) > lo && rowNo(fc) < hi).map(fc => [fc.l, 1]);
      const rowOf = id => (get(id) ? rowNo(get(id)) : null);
      if (rowOf('cf.op_bwc')) check('Subtotal', 'cf.op_bwc', between('A', 0, rowOf('cf.op_bwc')), 'Profit before tax + non-cash adjustments = operating profit before working capital changes');
      if (rowOf('cf.wc') && rowOf('cf.op_bwc')) check('Subtotal', 'cf.wc', between('A', rowOf('cf.op_bwc'), rowOf('cf.wc')), 'Working capital movements = net change in working capital');
      if (rowOf('cf.cfo')) check('Subtotal', 'cf.cfo', between('A', 0, rowOf('cf.cfo')), 'Operating items = net cash from operating activities');
      if (rowOf('cf.cfi')) check('Subtotal', 'cf.cfi', between('B', 0, rowOf('cf.cfi')), 'Investing items = net cash from investing activities');
      if (rowOf('cf.cff')) check('Subtotal', 'cf.cff', between('C', 0, rowOf('cf.cff')), 'Financing items = net cash from financing activities');
      check('Cash flow movement', 'cf.net', plus(['cf.cfo', 'cf.cfi', 'cf.cff']), 'Operating + investing + financing = net change in cash');
      const zExtra = items.filter(fc => fc.l.startsWith('cf.Z.x.') && fc.st === 'ok').map(fc => fc.l);
      check('Cash flow movement', 'cf.close', plus(['cf.open', 'cf.net', ...zExtra]), `Opening cash + net change${zExtra.length ? ' + other cash movements shown below it' : ''} = closing cash`);
    }
  }

  // ── 2. across statements, per basis and period (figures as shown in the module) ─────────────────────────────────
  const bases = [...new Set(version.facts.map(fc => fc.b))];
  const cmpShown = (cat, b, p, stmt, label, srcCell, modCell, expl0, tolExtra = 0) => {
    const s = srcCell, mm = modCell;
    const sv = M.num(s), mv = M.num(mm);
    if (sv == null && mv == null) return;
    const diff = sv != null && mv != null ? sv - mv : null;
    add({ b, p, stmt, check: cat, particulars: label, source: sv, module: mv, diff, ref: [ref(version, s.fact), ref(version, mm.fact)].filter(Boolean).join('  ↔  '),
      status: diff == null ? 'Unreconciled' : statusOf(diff, { tol: o.tolerance + tolExtra, mat: o.materiality }), expl: diff == null ? 'One side is not available for this period.' : expl0 });
  };
  for (const b of bases) {
    const cfPeriods = M.periodsFor(ctx.ix, b, 'CF').filter(p => p.availability === 'reported');
    for (const per of cfPeriods) {
      const bsEnd = P.bsAtEnd(per), bsStart = P.bsAtStart(per);
      const close = M.cell(ctx, b, 'cf.close', per.id), open = M.cell(ctx, b, 'cf.open', per.id);
      const cashEnd = M.cell(ctx, b, 'bs.cash', bsEnd), cashStart = M.cell(ctx, b, 'bs.cash', bsStart);
      if (cashEnd.fact || close.fact) cmpShown('Cash vs balance sheet', b, per.id, 'CF', `Closing cash (cash flow) vs cash and cash equivalents in the balance sheet as at ${per.end}`, close, cashEnd,
        'Cash-flow closing cash should equal the balance-sheet "cash and cash equivalents" (any difference: bank overdrafts / restricted balances treated differently).');
      if (cashStart.fact || open.fact) cmpShown('Cash vs balance sheet', b, per.id, 'CF', `Opening cash (cash flow) vs cash and cash equivalents in the balance sheet as at ${bsStart?.slice(3)}`, open, cashStart,
        'Cash-flow opening cash should equal the balance-sheet cash at the end of the previous period.');
      const cfPbt = M.cell(ctx, b, 'cf.pbt', per.id), plPbt = M.cell(ctx, b, 'pl.pbt', per.id), plPba = M.cell(ctx, b, 'pl.pb_assoc', per.id);
      if (b === 'CO' && M.num(cfPbt) != null && M.num(plPba) != null && Math.abs(M.num(cfPbt) - M.num(plPba)) < Math.abs(M.num(cfPbt) - (M.num(plPbt) ?? Infinity)))
        cmpShown('Cross-statement', b, per.id, 'CF', 'Profit before tax: cash flow vs P&L profit before share of associates', cfPbt, plPba, 'This year the consolidated cash flow starts from profit BEFORE the share of associates (a non-cash item), not from PBT after it.');
      else cmpShown('Cross-statement', b, per.id, 'CF', 'Profit before tax: cash flow vs statement of profit and loss', cfPbt, plPbt, 'The cash flow starts from the P&L profit before tax.');
      cmpShown('Cross-statement', b, per.id, 'CF', 'Depreciation and amortisation: cash flow vs P&L', M.cell(ctx, b, 'cf.dep', per.id), M.cell(ctx, b, 'pl.exp_dep', per.id), 'Non-cash charge added back in the cash flow.');
    }
    // other equity in the results (year-end) vs the balance sheet; paid-up capital vs share capital
    for (const per of M.periodsFor(ctx.ix, b, 'PL').filter(p => p.type === 'FY' && p.availability === 'reported')) {
      const oe = M.cell(ctx, b, 'pl.oth_eq', per.id);
      if (oe.v) cmpShown('Cross-statement', b, per.id, 'PL', 'Other equity (results) vs other equity (balance sheet)', oe, M.cell(ctx, b, 'bs.oth_eq', P.bsAtEnd(per)), 'The results disclose other equity at the year end.');
    }
    for (const per of M.periodsFor(ctx.ix, b, 'BS').filter(p => p.availability === 'reported')) {
      const sc = M.cell(ctx, b, 'bs.share_cap', per.id);
      const pu = [...ctx.ix.version.facts].filter(fc => fc.b === b && fc.l === 'pl.paidup' && P.fromId(fc.p)?.end === per.end && fc.st === 'ok')[0];
      if (sc.v != null && pu) {
        const diff = sc.v - pu.v;
        add({ b, p: per.id, stmt: 'BS', check: 'Cross-statement', particulars: 'Equity share capital (balance sheet) vs paid-up equity share capital (results)', source: sc.v, module: pu.v, diff,
          ref: `${ref(version, sc.fact)}  ↔  ${ref(version, pu)}`, status: Math.abs(diff) < 0.0005 ? 'Agrees' : 'Info',
          expl: Math.abs(diff) < 0.0005 ? 'Same amount.' : 'The balance-sheet line can include instruments other than equity shares (e.g. preference shares / share capital suspense); the results line is equity shares only. See the share capital note before relying on either for EPS or market capitalisation.' });
      }
      // classification of borrowings and leases
      const nb = M.cell(ctx, b, 'bs.ncl_borrow', per.id), cb = M.cell(ctx, b, 'bs.cl_borrow', per.id), nl = M.cell(ctx, b, 'bs.ncl_lease', per.id), cl = M.cell(ctx, b, 'bs.cl_lease', per.id);
      if (nb.v != null || cb.v != null) add({ b, p: per.id, stmt: 'BS', check: 'Classification', particulars: `Borrowings: non-current ${fmt(M.num(nb))} + current ${fmt(M.num(cb))}; lease liabilities: non-current ${fmt(M.num(nl))} + current ${fmt(M.num(cl))}`,
        source: (M.num(nb) || 0) + (M.num(cb) || 0), module: (M.num(nl) || 0) + (M.num(cl) || 0), diff: null, ref: ref(version, nb.fact), status: 'Info',
        expl: 'Source = total borrowings, module = total lease liabilities (kept apart: debt is shown both excluding and including leases). The current portion of long-term borrowings sits in current borrowings — confirm against the borrowings note and the loan schedule.' });
    }
  }

  // ── 3. notes vs statement lines (same workbook, same period) ─────────────────────────────────────────────────────
  const factIn = (f, b, l, p) => version.facts.find(fc => fc.f === f && fc.b === b && fc.l === l && fc.p === p && (fc.s === 'BS' || fc.k === 'PLD' || fc.k === 'SEBI') && !fc.unrel);
  for (const n of version.notes) {
    if (!n.lines?.length) continue;
    const per = new Set(); n.items.forEach(it => Object.keys(it.v).forEach(p => per.add(p)));
    for (const p of per) {
      const its = n.items.filter(it => it.v[p]);
      const totals = its.filter(it => it.total);
      let noteV = null, noteRef = null, err = null;
      const stF = n.lines.map(l => factIn(n.f, n.b, l, p));
      if (stF.every(x => !x)) continue;
      const stErr = stF.find(x => x && x.st === 'error');
      const stV = stErr ? null : stF.reduce((s, x) => s + (x && (x.st === 'ok' || x.st === 'dash') ? x.v : 0), 0);
      // a note can hold several tables, each with its own "Total" row: the total row closest to the statement line is
      // compared (the explanation says how many there were)
      let pickNote = '';
      if (totals.length) {
        const vals = totals.map(it => it.v[p]).filter(t => t.st === 'ok' || t.st === 'error');
        const okT = vals.filter(t => t.st === 'ok');
        const t = okT.length && stV != null ? okT.sort((a, c) => Math.abs(a.v - stV) - Math.abs(c.v - stV))[0] : vals[vals.length - 1] || totals[totals.length - 1].v[p];
        noteV = t.st === 'ok' ? t.v : t.st === 'blank' ? 0 : null; noteRef = `${n.sheet}!${t.c}`; if (t.st === 'error') err = t.err;
        if (totals.length > 1) pickNote = ` The note has ${totals.length} total rows; the one closest to the statement line (${t.c}) is compared.`;
      }
      else if (its.length === 1) { const t = its[0].v[p]; noteV = t.st === 'ok' ? t.v : null; noteRef = `${n.sheet}!${t.c}`; if (t.st === 'error') err = t.err; }
      else continue;   // no total row: the note's items cannot be told apart from its sub-totals reliably
      const diff = noteV != null && stV != null ? noteV - stV : null;
      add({ b: n.b, p, stmt: n.lines[0].startsWith('pl.') ? 'PL' : 'BS', check: 'Notes vs statement', particulars: `Note ${n.num} "${n.title}" total vs ${n.lines.map(l => L.BY_ID[l]?.label || l).join(' + ')}`,
        source: noteV, module: stV, diff, ref: `${files[n.f]?.name} › ${noteRef}  ↔  ${stF.filter(Boolean).map(x => `${x.sh}!${x.c}`).join(' + ')}`,
        status: err || stErr ? 'Unreconciled' : statusOf(diff, { tol: o.tolerance, mat: o.materiality }),
        expl: err ? `The note total is ${err} in the workbook.` : `Note linked by ${n.linkedBy}. ${diff != null && Math.abs(diff) >= 0.0005 ? 'The note total differs from the statement line — check the note for sub-totals or lines presented elsewhere.' : 'Note total agrees with the statement.'}${pickNote}` });
    }
  }

  // ── 4. the same figure in several sources ────────────────────────────────────────────────────────────────────────
  for (const [k, cands] of ctx.ix.by) {
    const valid = cands.filter(c => c.st === 'ok' && !c.unrel);
    if (valid.length < 2) continue;
    const [b, l, p] = k.split('|');
    const shown = M.cell(ctx, b, l, p);
    if (!shown.fact || shown.fact.st !== 'ok') continue;
    const isEps = l.startsWith('pl.eps'), isRatio = l.startsWith('rt.');
    const mat = isEps ? o.epsMateriality : isRatio ? 0.01 : o.materiality;
    const tol = isEps ? o.epsTolerance : isRatio ? o.ratioTolerance : o.tolerance;
    const competing = [];
    for (const alt of valid) {
      if (alt === shown.fact) continue;
      const diff = alt.v - shown.fact.v;
      const rounded = !!(alt.r2 || shown.fact.r2);
      const status = statusOf(diff, { tol, mat, rounded, eps: isEps });
      const sameFile = alt.f === shown.fact.f;
      let expl = sameFile ? `Same workbook, ${alt.k === shown.fact.k ? 'another sheet' : `${kindName(alt.k)} vs ${kindName(shown.fact.k)}`}${alt.hid ? ' (hidden sheet)' : ''}.` : `Repeated as ${alt.role === 'working' ? 'a working column' : alt.role} in ${files[alt.f]?.name}${alt.hid ? ' (hidden sheet)' : ''}.`;
      if (status === 'Rounding' && rounded) expl += ' One side was typed rounded to 2 decimals.';
      else if (status === 'Difference' || status === 'Material difference') expl += ' Reason not established (rounding, regrouping, restatement or adjustment) — kept as separate source versions.';
      if (alt.lbl && shown.fact.lbl && L.norm(alt.lbl) !== L.norm(shown.fact.lbl)) expl += ` Labels differ: "${alt.lbl}" vs "${shown.fact.lbl}".`;
      add({ b, p, stmt: shown.fact.s, check: 'Repeated figure', particulars: `${L.BY_ID[l]?.label || shown.fact.lbl} — ${files[alt.f]?.name.replace(/\.xlsx$/i, '')} vs shown figure`,
        source: alt.v, module: shown.fact.v, diff, ref: `${ref(version, alt)}  ↔  shown: ${ref(version, shown.fact)}`, status, expl, line: l, unit: isEps ? 'inr' : isRatio ? 'times' : 'lakh' });
      if (alt.ce) expl += ` That source column has ${alt.ce} Excel errors, so it is not offered as a decision option.`;
      if (status === 'Material difference' && !alt.ce && !alt.unrel) competing.push(alt);
    }
    if (competing.length) decisions.push({ key: k, b, l, p, label: L.BY_ID[l]?.label || shown.fact.lbl, unit: isEps ? 'inr' : 'lakh',
      shown: { factKey: M.factKey(shown.fact), v: shown.fact.v, ref: ref(version, shown.fact), role: shown.fact.role, decided: shown.decided },
      options: [shown.fact, ...competing].map(fc => ({ factKey: M.factKey(fc), v: fc.v, ref: ref(version, fc), role: fc.role, file: files[fc.f]?.name, reportingDate: files[fc.f]?.reportingDate })) });
  }

  // ── 5. quarter / half-year / year consistency (directly reported figures only) ────────────────────────────────────
  const KEY = ['pl.rev', 'pl.oth_inc', 'pl.tot_inc', 'pl.exp_tot', 'pl.pbt', 'pl.tax_tot', 'pl.pat', 'pl.tci'];
  for (const b of bases) {
    const direct = new Set(M.periodsFor(ctx.ix, b, 'PL').filter(p => p.availability !== 'derived').map(p => p.id));
    const fys = [...new Set([...direct].map(p => P.fromId(p).fy))];
    const rel = [['H1', ['Q1', 'Q2']], ['9M', ['H1', 'Q3']], ['FY', ['9M', 'Q4']], ['FY', ['H1', 'H2']]];
    for (const fy of fys) for (const [whole, parts] of rel) {
      const W = `FY${fy}-${whole}`, Ps = parts.map(x => `FY${fy}-${x}`);
      if (!direct.has(W) || !Ps.every(x => direct.has(x))) continue;
      for (const l of KEY) {
        const w = M.cell(ctx, b, l, W), cs = Ps.map(x => M.cell(ctx, b, l, x));
        if (M.num(w) == null) continue;
        const sum = cs.some(c => M.num(c) == null) ? null : cs.reduce((s, c) => s + M.num(c), 0);
        const diff = sum == null ? null : M.num(w) - sum;
        const mixed = new Set([w.fact?.f, ...cs.map(c => c.fact?.f)].filter(x => x != null)).size > 1;
        add({ b, p: W, stmt: 'PL', check: 'Quarter/half-year consistency', particulars: `${L.BY_ID[l].label}: ${whole} vs ${parts.join(' + ')}`, source: M.num(w), module: sum, diff,
          ref: [w, ...cs].map(c => ref(version, c.fact)).filter(Boolean).join('  ;  '), status: statusOf(diff, { tol: o.tolerance * 2, mat: o.materiality, rounded: cs.some(c => c.fact?.r2) }),
          expl: `${mixed ? 'Figures come from different workbooks. ' : ''}${w.fact?.der || cs.some(c => c.fact?.der) ? 'The workbook itself derives one of these columns by subtraction, so agreement is expected by construction. ' : ''}Directly reported figures compared; no figure was derived for this check.` });
      }
    }
  }

  // ── 6. EPS against the share count it implies ───────────────────────────────────────────────────────────────────
  for (const b of bases) {
    for (const per of M.periodsFor(ctx.ix, b, 'PL').filter(p => p.availability === 'reported')) {
      const eps = M.cell(ctx, b, 'pl.eps_basic', per.id);
      const prof = M.cell(ctx, b, b === 'CO' ? 'pl.pat_owners' : 'pl.pat', per.id);
      const pu = M.cell(ctx, b, 'pl.paidup', per.id);
      if (eps.v == null || !eps.v || prof.v == null || !pu.v) continue;
      const implied = (prof.v * 1e5) / eps.v;           // shares
      const atEnd = (pu.v * 1e5) / 2;                    // face value ₹2
      const ratio = implied / atEnd;
      const ok = ratio > 0.6 && ratio <= 1.02;
      add({ b, p: per.id, stmt: 'PL', check: 'EPS check', particulars: `Basic EPS ₹${eps.v.toFixed(4)}: implied weighted shares vs shares at period end (paid-up ÷ ₹2)`, source: Math.round(implied), module: Math.round(atEnd), diff: Math.round(implied - atEnd),
        ref: ref(version, eps.fact), status: ok ? 'Info' : 'Material difference', unit: 'nos',
        expl: `${b === 'CO' ? 'Profit attributable to owners' : 'Profit for the period'} ÷ EPS implies ${Math.round(implied).toLocaleString('en-IN')} weighted shares (${(ratio * 100).toFixed(1)}% of shares at the period end). ${ok ? 'Plausible for a weighted average.' : 'Outside the plausible range for a weighted average — check the EPS figure and its share count.'}${eps.fact?.der ? ' The workbook derives this EPS by subtracting cumulative EPS, which is not additive.' : ''}${eps.fact?.r2 ? ' The EPS was typed rounded to 2 decimals.' : ''}` });
    }
  }

  // ── 7. source exceptions (Excel errors, missing results, external links) ─────────────────────────────────────────
  for (const i of version.issues) {
    if (!['EXCEL_ERROR', 'NO_CACHED_VALUE', 'EXTERNAL_LINK', 'UNRELIABLE_HIDDEN_SHEET', 'STALE_TITLE', 'STALE_SHEET_NAME', 'UNIT_INFERRED', 'UNIT_UNKNOWN', 'UNMAPPED_ROW', 'DUPLICATE_LINE', 'EPS_DERIVED_IN_SOURCE', 'BASIS_CONFLICT', 'PERIOD_NOT_RECOGNISED'].includes(i.code)) continue;
    const fb = version.files[i.f]?.basis;
    add({ b: fb, p: i.period || '', stmt: i.line ? L.STATEMENT_OF(i.line) : '', check: 'Source exception', particulars: i.code.replace(/_/g, ' ').toLowerCase(), source: null, module: null, diff: null,
      ref: `${files[i.f]?.name}${i.sheet ? ` › ${i.sheet}${i.cell ? `!${i.cell}` : ''}` : ''}`, status: i.sev === 'error' ? 'Unreconciled' : 'Info', expl: i.msg });
  }

  // ── 8. data already in the module before this import (TB-based balance sheet, Zoho-mapped P&L) ──────────────────
  if (opts.legacy) legacyChecks(version, ctx, opts.legacy, add, o);

  const summary = {};
  for (const r of rows) { const s = summary[r.status] || (summary[r.status] = 0); summary[r.status] = s + 1; }
  return { rows, decisions, summary, thresholds: o, mode: ctx.mode };
}

const fmt = v => (v == null ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
const kindName = k => ({ SEBI: 'SEBI results', PLD: 'detailed statement of P&L', BS: 'balance sheet', CF: 'cash flow' })[k] || k;

const LEGACY_BS = { bs_ppe: 'bs.ppe', bs_cwip: 'bs.cwip', bs_rou: 'bs.rou', bs_intangible: 'bs.intang', bs_intang_dev: 'bs.intang_dev', bs_nc_invest: 'bs.nc_inv', bs_nc_loans: 'bs.nc_loans', bs_nc_ofa: 'bs.nc_ofa',
  bs_dta: 'bs.dta', bs_nc_other: 'bs.nc_other', bs_c_invest: 'bs.c_inv', bs_tr: 'bs.tr', bs_cash: 'bs.cash', bs_obank: 'bs.obank', bs_c_loans: 'bs.c_loans', bs_c_ofa: 'bs.c_ofa', bs_cta: 'bs.cta', bs_c_other: 'bs.c_other',
  bs_share_cap: 'bs.share_cap', bs_other_equity: 'bs.oth_eq', bs_nc_borrow: 'bs.ncl_borrow', bs_nc_lease: 'bs.ncl_lease', bs_nc_ofl: 'bs.ncl_ofl', bs_nc_prov: 'bs.ncl_prov', bs_c_borrow: 'bs.cl_borrow',
  bs_tp_msme: 'bs.cl_tp_msme', bs_tp_others: 'bs.cl_tp_other', bs_c_lease: 'bs.cl_lease', bs_c_ofl: 'bs.cl_ofl', bs_c_other_liab: 'bs.cl_other', bs_c_prov: 'bs.cl_prov' };
const LEGACY_PL = { I: ['pl.rev', 'n1_'], II: ['pl.oth_inc', 'n2_'], IVa: ['pl.exp_ops', 'n3_'], IVb: ['pl.exp_emp', 'n4_'], IVc: ['pl.exp_fin', 'n5_'], IVd: ['pl.exp_dep', 'n6_'], IVe: ['pl.exp_oth', 'n7_'] };

function legacyChecks(version, ctx, legacy, add, o) {
  const bsPer = { c4: 'BS-2026-03-31', c5: 'BS-2025-03-31' };
  for (const [lk, id] of Object.entries(LEGACY_BS)) {
    const vals = legacy.bs?.lines?.[lk];
    if (!vals) continue;
    for (const [ck, p] of Object.entries(bsPer)) {
      if (vals[ck] == null) continue;
      const shown = M.cell(ctx, 'SA', id, p);
      const sv = M.num(shown);
      const diff = sv == null ? null : vals[ck] - sv;
      add({ b: 'SA', p, stmt: 'BS', check: 'Legacy module data', particulars: `${L.BY_ID[id].label}: balance sheet previously in the module (trial-balance based) vs imported`, source: sv, module: vals[ck], diff: diff == null ? null : -diff,
        ref: `server/financial_bs_data.json lines.${lk}.${ck}  ↔  ${shown.fact ? `${version.files[shown.fact.f].name} › ${shown.fact.sh}!${shown.fact.c}` : '—'}`, status: diff == null ? 'Unreconciled' : statusOf(diff, { tol: o.tolerance, mat: o.materiality }),
        expl: 'The Balance Sheet tab now shows the imported figures; the earlier trial-balance figures are kept unchanged for comparison.' });
    }
  }
  const pl = legacy.pl;
  if (pl?.periods && pl.values) {
    for (const per of pl.periods) {
      const kind = per.colType === 'Year Ended' ? 'year' : 'quarter';
      const P2 = P.makePeriod(kind, per.to);
      if (!P2) continue;
      for (const [, [id, prefix]] of Object.entries(LEGACY_PL)) {
        const items = Object.entries(pl.values).filter(([k]) => k.startsWith(prefix));
        if (!items.length) continue;
        const any = items.some(([, v]) => v && v[per.key] != null);
        if (!any) continue;
        const legacyV = items.reduce((s, [, v]) => s + (Number(v?.[per.key]) || 0), 0);
        const shown = M.cell(ctx, 'SA', id, P2.id);
        const sv = M.num(shown);
        const diff = sv == null ? null : legacyV - sv;
        add({ b: 'SA', p: P2.id, stmt: 'PL', check: 'Legacy module data', particulars: `${L.BY_ID[id].label}: P&L previously in the module (Zoho account mapping, "${per.label}") vs imported`, source: sv, module: legacyV, diff: diff == null ? null : -diff,
          ref: `server/financial_pl_data.json (${prefix}* items, ${per.key})`, status: diff == null ? 'Unreconciled' : statusOf(diff, { tol: o.tolerance, mat: o.materiality }),
          expl: 'The Zoho-mapped P&L depends on the account mapping (Account Mapping tab) and is kept as its own view ("Zoho mapping" source). Large differences mean the mapping is incomplete — the imported published figures are shown by default.' });
      }
    }
  }
}

module.exports = { reconcile, DEFAULTS, statusOf };
