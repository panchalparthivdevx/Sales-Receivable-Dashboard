'use strict';
// ─── Recurring Expense Comparison Report (pure functions — no Zoho, no files) ──────────────────────
// Compares two periods (month on month, quarter on quarter, half year to half year or any custom
// months) of the Month-wise & Branch-wise Recurring Expense Report: per expense head (main row) and
// branch (sub row) the Basic amount of both periods, the change, the % change and a reason for the
// change worked out from the bills themselves:
// • vendor by vendor — new vendor, no bill this period, more / fewer bills;
// • item by item from the bill lines (Zoho bill DETAIL, kept per bill by recurring-expense.js) —
//   quantity effect (change in quantity × previous rate) and rate effect (change in rate × current
//   quantity), new items, items not billed; lump-sum lines (quantity 1) are compared by amount;
// • service periods written on the bill line ("01-Oct-2026 To 31-Dec-2026" = a 3-month bill);
// • bills that need attention: possible duplicates (same vendor, same amount, same month; or the
//   same bill number in both periods), rate increases above 10 %, a vendor that billed last period
//   but not this one, and big increases the bill lines do not explain.

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const r2  = v => Math.round(num(v) * 100) / 100;
const r4  = v => Math.round(num(v) * 10000) / 10000;

const MIN_MONTH = '2025-04';           // FY 2025-26 is the oldest year the report reads
const MON3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON_RE = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;

// ── Months and labels ─────────────────────────────────────────────────────────────────────────────
const addMonths = (mk, n) => {
  let [y, m] = mk.split('-').map(Number);
  m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
};
function monthsBetween(from, to) {
  const out = [];
  for (let k = from; k <= to && out.length < 36; k = addMonths(k, 1)) out.push(k);
  return out;
}
const monLabel = mk => { const [y, m] = mk.split('-').map(Number); return `${MON3[m - 1][0].toUpperCase()}${MON3[m - 1].slice(1)}-${String(y).slice(2)}`; };
const fyShort = sy => `${String(sy).slice(2)}-${String(sy + 1).slice(2)}`;

/** Label of a period: one month "Oct-26", an FY quarter "Q-3", an FY half "H-2", else "Oct-26 to Dec-26". */
function periodLabel(from, to) {
  const [y, m] = from.split('-').map(Number);
  const sy = m >= 4 ? y : y - 1;
  const span = monthsBetween(from, to).length;
  const range = `${monLabel(from)} to ${monLabel(to)}`;
  if (from === to) return { short: monLabel(from), long: monLabel(from) };
  if (span === 3 && [4, 7, 10, 1].includes(m)) {
    const q = { 4: 1, 7: 2, 10: 3, 1: 4 }[m];
    return { short: `Q-${q}`, long: `Q-${q} FY ${fyShort(sy)} (${range})` };
  }
  if (span === 6 && [4, 10].includes(m)) {
    const h = m === 4 ? 1 : 2;
    return { short: `H-${h}`, long: `H-${h} FY ${fyShort(sy)} (${range})` };
  }
  return { short: range, long: range };
}

// ── Number formats used in the reason text ────────────────────────────────────────────────────────
const inr  = n => `${n < -0.5 ? '−' : ''}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
const sinr = n => `${n < 0 ? '−' : '+'}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
const inr2 = n => `₹${num(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fq   = n => num(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const spct = p => `${p < 0 ? '−' : '+'}${Math.abs(p).toFixed(1)}%`;
const fmtD = d => { const [y, m, dd] = d.split('-'); return `${dd}-${MON3[Number(m) - 1][0].toUpperCase()}${MON3[Number(m) - 1].slice(1)}-${y}`; };

// ── Service period written on a bill line ─────────────────────────────────────────────────────────
const monOf = tok => {
  if (/^\d{1,2}$/.test(tok)) { const n = Number(tok); return n >= 1 && n <= 12 ? n : 0; }
  return MON_RE.test(tok) ? MON3.indexOf(tok.toLowerCase().slice(0, 3)) + 1 : 0;
};
const yearOf = tok => { const n = Number(tok); const y = tok.length === 2 ? 2000 + n : n; return y >= 2015 && y <= 2040 ? y : 0; };
const isoOf = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const SEP = '\\s*(?:to|till|upto|up to|-|–|—)\\s*';
const DMY = '(\\d{1,2})[\\s./-]+([a-z]{3,9}|\\d{1,2})[\\s./,-]+(\\d{4}|\\d{2})';
const MY  = '([a-z]{3,9})[\\s\'’.,-]*(\\d{4}|\\d{2})';
const RE_DMY = new RegExp(`${DMY}${SEP}${DMY}`, 'i');
const RE_MY  = new RegExp(`\\b${MY}${SEP}${MY}\\b`, 'i');

/** "01-Oct-2026 To 31-Dec-2026", "01/10/2026 - 31/12/2026", "Oct-26 to Dec-26" → { from, to, months } */
function servicePeriod(text) {
  const s = String(text || '');
  let from = null, to = null;
  let m = RE_DMY.exec(s);
  if (m) {
    const [d1, m1, y1, d2, m2, y2] = [Number(m[1]), monOf(m[2]), yearOf(m[3]), Number(m[4]), monOf(m[5]), yearOf(m[6])];
    if (m1 && m2 && y1 && y2 && d1 >= 1 && d1 <= lastDay(y1, m1) && d2 >= 1 && d2 <= lastDay(y2, m2)) { from = isoOf(y1, m1, d1); to = isoOf(y2, m2, d2); }
  }
  if (!from && (m = RE_MY.exec(s))) {
    const [m1, y1, m2, y2] = [MON_RE.test(m[1]) ? monOf(m[1]) : 0, yearOf(m[2]), MON_RE.test(m[3]) ? monOf(m[3]) : 0, yearOf(m[4])];
    if (m1 && m2 && y1 && y2) { from = isoOf(y1, m1, 1); to = isoOf(y2, m2, lastDay(y2, m2)); }
  }
  if (!from || to < from) return null;
  const days = (Date.parse(to) - Date.parse(from)) / 864e5 + 1;
  if (days > 731) return null;
  return { from, to, months: Math.max(1, Math.round(days / 30.44)) };
}

// ── Bill item lines ───────────────────────────────────────────────────────────────────────────────
/** Keep only the lines of a bill DETAIL posted to the given expense accounts: [account_id, text, qty, rate, amount, description] */
function slimItems(bill, accountIds, lmt) {
  const li = [];
  for (const l of bill.line_items || []) {
    if (!accountIds.has(String(l.account_id))) continue;
    const desc = String(l.description || '').replace(/\s+/g, ' ').trim();
    const name = String(l.name || '').replace(/\s+/g, ' ').trim();
    li.push([String(l.account_id), (name || desc || '(no description)').slice(0, 80), r4(l.quantity), r4(l.rate), r2(l.item_total), desc.slice(0, 160)]);
  }
  return { lmt: lmt || bill.last_modified_time || null, at: new Date().toISOString(), li };
}
// A month written with its year: "SEPT 2026", "july 2026", "Aug-26", "Nov'26"
const MONTH_YEAR_G = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s'’.,-]*(\d{4}|\d{2})\b/gi;
const DATE_G = /\b\d{1,2}[./-](?:\d{1,2}|[a-z]{3,9})[./-](?:\d{4}|\d{2})\b/gi;

/** The item name without the months / dates written in it ("housekeeping service - SEPT 2026" → "housekeeping service") */
function baseName(t) {
  const s = String(t || '');
  const cut = s.replace(new RegExp(RE_DMY.source, 'gi'), ' ').replace(new RegExp(RE_MY.source, 'gi'), ' ')
    .replace(DATE_G, ' ').replace(MONTH_YEAR_G, ' ')
    .replace(/\b(for|of|month|the)\s*$/i, ' ').replace(/^[\s\-–—:,/()]+|[\s\-–—:,/(]+$/g, '').replace(/\s+/g, ' ').trim();
  return cut || s.trim();
}
// Matching key of an item: lower case, months removed, plural "s" dropped ("Electronics" = "ELECTRONIC")
const normItem = t => baseName(t).toLowerCase().replace(/[^a-z0-9%&+]+/g, ' ').replace(/\s+/g, ' ').trim()
  .split(' ').map(w => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w)).join(' ') || '(no description)';

// Similarity of two item keys (1 = same): 1 − edit distance ÷ longer length. Catches typos like "supllies".
function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
const normBillNo = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Months a bill line is for: a service period (from–to) or a single "Month Year" written on it; null when none */
function lineMonths(text) {
  const sp = servicePeriod(text);
  if (sp) return { from: sp.from.slice(0, 7), to: sp.to.slice(0, 7), sp };
  const found = new Set();
  for (const m of String(text || '').matchAll(MONTH_YEAR_G)) {
    const mo = monOf(m[1]), y = yearOf(m[2]);
    if (mo && y) found.add(`${y}-${String(mo).padStart(2, '0')}`);
  }
  if (found.size !== 1) return null;
  const mk = [...found][0];
  return { from: mk, to: mk, sp: null };
}

// ── One head × branch: the reasons ───────────────────────────────────────────────────────────────
function analyzeRow(h, curB, prevB, items, ctx) {
  const { curLabel, prevLabel, curRunning, curStart } = ctx;
  const linesOf = b => {
    const e = items[b.bill_id];
    if (!e) return null;
    return (e.li || []).filter(l => l[0] === h.account_id)
      .map(l => ({ t: l[1], name: baseName(l[1]), key: normItem(l[1]), q: num(l[2]), rate: num(l[3]), amt: num(l[4]), desc: l[5] || '' }));
  };
  // Service months written on one period's bill lines: amount by month (or month range) and how many
  // distinct months they cover. null when no line says which month it is for.
  const svcMonths = bills => {
    const by = new Map(), months = new Set();
    for (const bl of bills) {
      for (const l of linesOf(bl) || []) {
        const lm = lineMonths(`${l.t} ${l.desc}`);
        if (!lm) continue;
        const k = lm.from === lm.to ? monLabel(lm.from) : `${monLabel(lm.from)} to ${monLabel(lm.to)}`;
        by.set(k, { amt: (by.get(k)?.amt || 0) + l.amt, from: lm.from });
        for (const mk of monthsBetween(lm.from, lm.to)) months.add(mk);
      }
    }
    if (!by.size) return null;
    const list = [...by.entries()].sort((x, y) => x[1].from.localeCompare(y[1].from)).map(([k, x]) => `${k} ${inr(x.amt)}`);
    return { text: `${list.join(', ')} (${months.size} month${months.size !== 1 ? 's' : ''})`, count: months.size };
  };
  const periodOf = b => {
    const ls = linesOf(b);
    if (!ls) return null;
    for (const l of ls) { const sp = servicePeriod(`${l.t} ${l.desc}`); if (sp) return sp; }
    return null;
  };
  const sum = list => list.reduce((s, b) => s + num(b.basic), 0);
  const plural = (n, w) => `${n} ${w}${n !== 1 ? 's' : ''}`;

  const billAttn = new Map();      // bill_id → [why]
  const flag = (b, why) => { if (!billAttn.has(b.bill_id)) billAttn.set(b.bill_id, []); billAttn.get(b.bill_id).push(why); };

  const vendors = new Map();
  const vOf = b => {
    const k = b.vendor_id || b.vendor_name || '?';
    if (!vendors.has(k)) vendors.set(k, { name: b.vendor_name || 'Unknown vendor', cur: [], prev: [] });
    return vendors.get(k);
  };
  for (const b of curB) vOf(b).cur.push(b);
  for (const b of prevB) vOf(b).prev.push(b);

  const anyNew  = [...vendors.values()].some(v => v.cur.length && !v.prev.length);
  const blocks = [];
  const itemsCmp = [];
  let itemsPending = 0;

  for (const v of vendors.values()) {
    const a = sum(v.cur), b = sum(v.prev), d = a - b;
    const nA = v.cur.length, nB = v.prev.length;
    const lines = [];
    let head;

    // Possible duplicates this period: same vendor, same month, same amount — more such bills than the
    // vendor sent in any month of the previous period (a vendor billing each phone line separately
    // sends many equal bills every month)
    const byMonthAmt = list => {
      const m = new Map();
      for (const bl of list) {
        if (Math.abs(num(bl.basic)) < 1 || !/^\d{4}-\d{2}/.test(bl.date || '')) continue;
        const k = `${bl.date.slice(0, 7)}|${Math.round(num(bl.basic))}`;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(bl);
      }
      return m;
    };
    const prevUsual = new Map();                     // amount → most such bills in one month of the previous period
    for (const [k, g] of byMonthAmt(v.prev)) { const amt = k.split('|')[1]; prevUsual.set(amt, Math.max(prevUsual.get(amt) || 1, g.length)); }
    const billList = g => (g.length > 4 ? `${g.slice(0, 4).map(x => x.bill_number || '—').join(', ')} and ${g.length - 4} more` : g.map(x => x.bill_number || '—').join(', '));
    let dupFound = false;
    for (const [k, g] of byMonthAmt(v.cur)) {
      const usual = prevUsual.get(k.split('|')[1]) || 1;
      if (g.length <= usual) continue;
      dupFound = true;
      lines.push({ text: `Possible duplicate: ${g.length} bills of the same amount ${inr(g[0].basic)} in ${monLabel(g[0].date.slice(0, 7))}${usual > 1 ? ` (${usual} in a month in ${prevLabel})` : ''}: ${billList(g)}`, amt: 0, attn: true });
      for (const x of g) flag(x, `Possible duplicate — same amount ${inr(x.basic)} as ${billList(g.filter(y => y !== x))}`);
    }
    // The same bill number booked in both periods
    const prevNos = new Map(v.prev.map(x => [normBillNo(x.bill_number), x]));
    for (const bl of v.cur) {
      const p = prevNos.get(normBillNo(bl.bill_number));
      if (p && normBillNo(bl.bill_number) && p.bill_id !== bl.bill_id) {
        dupFound = true;
        lines.push({ text: `Bill no. ${bl.bill_number} was also booked in ${prevLabel} (${inr(p.basic)}) — possible duplicate`, amt: 0, attn: true });
        flag(bl, `Same bill no. as a ${prevLabel} bill`);
      }
    }
    // Bills of this period covering several months (a quarterly bill, say)
    for (const bl of v.cur) {
      const sp = periodOf(bl);
      if (sp && sp.months > 1 && sp.to >= curStart) lines.push({ text: `Bill ${bl.bill_number} covers ${fmtD(sp.from)} to ${fmtD(sp.to)} (${sp.months} months)`, amt: 0, info: true });
    }
    // Service months written on the bills: when the two periods' bills cover a different number of
    // months (two months' bills booked in one period, say), that is the reason for most one-off jumps
    const svcCur = nA ? svcMonths(v.cur) : null, svcPrev = nB ? svcMonths(v.prev) : null;
    const moreMonths = !!(svcCur && svcPrev && svcCur.count > svcPrev.count);
    if (svcCur && svcPrev && svcCur.count !== svcPrev.count) {
      lines.push({ text: `Service months on the bills — ${curLabel}: ${svcCur.text}; ${prevLabel}: ${svcPrev.text}`, amt: 0, info: true });
    }

    if (!nB) {
      head = { text: `${v.name}: new this period — ${plural(nA, 'bill')}, ${inr(a)} (nothing in ${prevLabel})`, amt: a };
    } else if (!nA) {
      const cover = v.prev.map(bl => ({ bl, sp: periodOf(bl) })).find(x => x.sp && x.sp.to.slice(0, 7) >= curStart.slice(0, 7));
      const prevUnread = v.prev.filter(bl => !linesOf(bl)).length;
      if (cover) {
        head = { text: `${v.name}: no bill this period — the ${prevLabel} bill ${cover.bl.bill_number} covers ${fmtD(cover.sp.from)} to ${fmtD(cover.sp.to)} (${cover.sp.months} months)`, amt: -b };
      } else if (curRunning) {
        head = { text: `${v.name}: not billed yet (${inr(b)} in ${prevLabel}) — the period is still running`, amt: -b };
      } else if (anyNew) {
        head = { text: `${v.name}: no bill this period (${inr(b)} in ${prevLabel}) — another vendor billed instead`, amt: -b };
      } else if (prevUnread) {
        // Whether the earlier bill covers this period too is written on its lines: no flag until they are read
        itemsPending += prevUnread;
        head = { text: `${v.name}: no bill this period (${inr(b)} in ${prevLabel}) — checking the ${prevLabel} bill lines`, amt: -b };
      } else {
        head = { text: `${v.name}: no bill this period (${inr(b)} in ${prevLabel}) — check whether the bill is still to be booked`, amt: -b, attn: true };
      }
    } else {
      head = Math.abs(d) < 1
        ? { text: `${v.name}: no change (${inr(a)})`, amt: 0 }
        : { text: `${v.name}: ${inr(b)} → ${inr(a)} (${sinr(d)}${b > 0.5 ? `, ${spct(d / b * 100)}` : ''})`, amt: d };
      // More / fewer bills at a similar amount per bill: the number of bills is the reason
      const avgA = a / nA, avgB = b / nB;
      const sameAvg = avgB > 0.5 && Math.abs(avgA - avgB) / avgB <= 0.25;
      if (nA !== nB) lines.push({ text: `${plural(nA, 'bill')} this period vs ${nB} in ${prevLabel} (average ${inr(avgA)} vs ${inr(avgB)} per bill)`, amt: 0, info: true });
      const moreBills = nA > nB && sameAvg;

      // Item by item
      const curL = v.cur.map(linesOf), prevL = v.prev.map(linesOf);
      const missing = [...curL, ...prevL].filter(x => x == null).length;
      let qtyExplained = 0;
      if (missing) {
        itemsPending += missing;
        lines.push({ text: `Item lines still being read from Zoho for ${plural(missing, 'bill')}`, amt: 0, info: true });
      } else {
        const agg = new Map();
        const add = (side, ls, bl) => {
          for (const l of ls) {
            const it = agg.get(l.key) || { name: l.name, qa: 0, aa: 0, oneA: true, qb: 0, ab: 0, oneB: true, curBills: new Set() };
            if (side === 'a') { it.qa += l.q; it.aa += l.amt; if (Math.abs(l.q - 1) > 1e-9) it.oneA = false; it.curBills.add(bl); }
            else { it.qb += l.q; it.ab += l.amt; if (Math.abs(l.q - 1) > 1e-9) it.oneB = false; }
            agg.set(l.key, it);
          }
        };
        v.cur.forEach((bl, i) => add('a', curL[i], bl));
        v.prev.forEach((bl, i) => add('b', prevL[i], bl));
        // Items billed in only one period whose names differ by a typo are the same item
        const hasA = it => it.qa !== 0 || it.aa !== 0, hasB = it => it.qb !== 0 || it.ab !== 0;
        const onlyA = [...agg.entries()].filter(([, it]) => hasA(it) && !hasB(it));
        const onlyB = [...agg.entries()].filter(([, it]) => hasB(it) && !hasA(it));
        const pairs = [];
        for (const [ka] of onlyA) for (const [kb] of onlyB) { const s = similarity(ka, kb); if (s >= 0.8) pairs.push([s, ka, kb]); }
        pairs.sort((x, y) => y[0] - x[0]);
        const used = new Set();
        for (const [, ka, kb] of pairs) {
          if (used.has(ka) || used.has(kb)) continue;
          used.add(ka); used.add(kb);
          const A = agg.get(ka), Bi = agg.get(kb);
          Object.assign(A, { qb: Bi.qb, ab: Bi.ab, oneB: Bi.oneB });
          agg.delete(kb);
        }

        const itemLines = [];
        let itemSum = 0;
        for (const it of agg.values()) {
          const eff = it.aa - it.ab;
          itemSum += eff;
          const inA = it.aa !== 0 || it.qa !== 0, inB = it.ab !== 0 || it.qb !== 0;
          const qtyBased = !(it.oneA && it.oneB) && it.qa > 0 && it.qb > 0;
          const ra = it.qa > 0 ? it.aa / it.qa : 0, rb = it.qb > 0 ? it.ab / it.qb : 0;
          itemsCmp.push({ vendor: v.name, item: it.name, qb: r4(it.qb), rb: r2(rb), ab: r2(it.ab), qa: r4(it.qa), ra: r2(ra), aa: r2(it.aa), change: r2(eff) });
          if (inA && !inB) { itemLines.push({ text: `New item ${it.name}: ${it.oneA ? '' : `${fq(it.qa)} × ${inr2(ra)} = `}${inr(it.aa)}`, amt: eff }); continue; }
          if (inB && !inA) { itemLines.push({ text: `Not billed this time: ${it.name} (${inr(it.ab)} in ${prevLabel})`, amt: eff }); continue; }
          if (Math.abs(eff) < 1 && Math.abs(it.qa - it.qb) < 1e-9) continue;
          if (!qtyBased) { itemLines.push({ text: `${it.name}: ${inr(it.ab)} → ${inr(it.aa)} (${sinr(eff)})`, amt: eff }); continue; }
          const vol = (it.qa - it.qb) * rb;
          const rateEff = eff - vol;
          const parts = [];
          if (Math.abs(vol) >= 1) parts.push(`qty ${fq(it.qb)} → ${fq(it.qa)} (${sinr(vol)})`);
          if (Math.abs(rateEff) >= 1) parts.push(`rate ${inr2(rb)} → ${inr2(ra)} (${sinr(rateEff)})`);
          if (!parts.length) continue;
          qtyExplained += eff;
          const ratePct = rb > 0 ? (ra - rb) / rb * 100 : 0;
          const attn = ratePct > 10 && rateEff >= 500;
          itemLines.push({ text: `${it.name}: ${parts.join(' · ')}${attn ? ` — rate up ${ratePct.toFixed(1)}%` : ''}`, amt: eff, attn });
          if (attn) for (const bl of it.curBills) flag(bl, `${it.name} rate up ${ratePct.toFixed(1)}% (${inr2(rb)} → ${inr2(ra)})`);
        }
        itemLines.sort((x, y) => Math.abs(y.amt) - Math.abs(x.amt));
        const shown = itemLines.filter((l, i) => i < 6 || l.attn);
        const rest = itemLines.filter(l => !shown.includes(l));
        lines.push(...shown);
        if (rest.length) lines.push({ text: `${plural(rest.length, 'other item')}: ${sinr(rest.reduce((s, l) => s + l.amt, 0))}`, amt: rest.reduce((s, l) => s + l.amt, 0) });
        const residual = d - itemSum;
        if (Math.abs(residual) >= Math.max(100, Math.abs(d) * 0.02)) {
          lines.push({ text: `Other differences (discounts, rounding or amounts not on the item lines): ${sinr(residual)}`, amt: residual, info: true });
        }
      }
      // A big increase the item lines (or a possible duplicate, or more service months) do not explain;
      // not judged until the item lines are read
      if (!missing && !dupFound && !moreMonths && !moreBills && b > 0.5 && d >= 10000 && d / b > 0.25 && Math.abs(qtyExplained) < d * 0.5) {
        lines.push({ text: `Up ${spct(d / b * 100)} with no quantity or rate change on the bill lines to explain it — check the bill`, amt: 0, attn: true });
        for (const bl of v.cur) flag(bl, `Up ${spct(d / b * 100)} vs ${prevLabel} — check`);
      }
    }
    blocks.push({ head, lines, order: Math.abs(d) });
  }

  blocks.sort((x, y) => y.order - x.order || x.head.text.localeCompare(y.head.text));
  const reasons = [];
  for (const bk of blocks) {
    if (bk.head.amt === 0 && !bk.lines.length) continue;            // vendor with no change at all
    reasons.push({ level: 0, text: bk.head.text, amt: r2(bk.head.amt), ...(bk.head.attn ? { attn: true } : {}) });
    for (const l of bk.lines) reasons.push({ level: 1, text: l.text, amt: r2(l.amt), ...(l.attn ? { attn: true } : {}), ...(l.info ? { info: true } : {}) });
  }
  if (!reasons.length) reasons.push({ level: 0, text: 'Same vendors and amounts in both periods', amt: 0 });
  return { reasons, billAttn, itemsCmp, itemsPending, attention: reasons.filter(r => r.attn).length, linesOf };
}

/**
 * The comparison rows. `rows` = computeReport rows (monthly cells with bills; may be merged across
 * FYs), curKeys / prevKeys = month keys of the two periods, items = bill_id → slimItems.
 */
function computeComparison({ heads, rows, curKeys, prevKeys, items = {}, curLabel, prevLabel, curRunning = false }) {
  const pick = (r, keys) => keys.flatMap(k => r.monthly?.[k]?.bills || []);
  const ctx = { curLabel, prevLabel, curRunning, curStart: `${curKeys[0]}-01` };
  const out = [];
  for (const r of rows) {
    const h = heads.find(x => x.key === r.head_key);
    if (!h) continue;
    const curB = pick(r, curKeys), prevB = pick(r, prevKeys);
    if (!curB.length && !prevB.length) continue;
    const cur = curB.reduce((s, b) => s + num(b.basic), 0);
    const prev = prevB.reduce((s, b) => s + num(b.basic), 0);
    const a = analyzeRow(h, curB, prevB, items, ctx);
    const slim = b => {
      const ls = a.linesOf(b);
      return {
        bill_id: b.bill_id, account_name: b.account_name, branch_name: b.branch_name, vendor_name: b.vendor_name,
        bill_number: b.bill_number, date: b.date, basic: b.basic, gst: b.gst, tds: b.tds, bill_amount: b.bill_amount,
        paid_date: b.paid_date, paid_amount: b.paid_amount, outstanding: b.outstanding, part: b.part, est: b.est,
        items: ls ? ls.map(l => [l.t, l.q, l.rate, l.amt]) : null,
        attn: a.billAttn.get(b.bill_id) || undefined,
      };
    };
    out.push({
      head_key: r.head_key, head_label: r.head_label, branch: r.branch,
      cur: r2(cur), prev: r2(prev), change: r2(cur - prev), pct: prev > 0.5 ? Math.round((cur - prev) / prev * 1000) / 10 : null,
      reasons: a.reasons, attention: a.attention, items_pending: a.itemsPending,
      items_cmp: a.itemsCmp.sort((x, y) => Math.abs(y.change) - Math.abs(x.change)),
      bills: { cur: curB.map(slim), prev: prevB.map(slim) },
    });
  }
  return out;
}

module.exports = {
  MIN_MONTH, addMonths, monthsBetween, monLabel, periodLabel, servicePeriod, slimItems, normItem, computeComparison,
};
