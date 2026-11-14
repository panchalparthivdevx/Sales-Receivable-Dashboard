/**
 * The text of the reminder emails. Pure functions: items in, { subject, html } out — nothing is read or sent here.
 *
 * An item is one reconciliation row as lib/reminders.js describes it (supplier, document, recipient GSTIN, status, GST in Books and in
 * GSTR-2B, next action, due date). Everything that comes from Zoho or from a person is escaped before it goes into the HTML.
 * Styles are inline and the layout is plain tables, because that is what mail programs display reliably.
 */

'use strict';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_ROWS = 25;                    // per section; the rest is counted ("and 12 more")

const esc = s => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const day = iso => (/^\d{4}-\d{2}-\d{2}/.test(iso || '') ? `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : '');
/** paise → "₹1,23,456.78" (Indian digit grouping) */
function inr(p) {
  if (p === null || p === undefined) return '';
  const neg = p < 0, abs = Math.abs(Math.round(p));
  const r = String(Math.floor(abs / 100)), f = String(abs % 100).padStart(2, '0');
  const g = r.length > 3 ? `${r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${r.slice(-3)}` : r;
  return `${neg ? '-' : ''}₹${g}.${f}`;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const C = { text: '#18191B', muted: '#5D6C7B', line: '#DFE7E3', head: '#F4F7F5', brand: '#1C4942', red: '#B91C1C', amber: '#B45309' };
const TD = `padding:6px 8px;border-bottom:1px solid ${C.line};vertical-align:top;font-size:13px;`;
const TH = `padding:6px 8px;border-bottom:1px solid ${C.line};background:${C.head};text-align:left;font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:0.03em;`;

function gstText(i) {
  if (i.books_gst !== null && i.portal_gst !== null) {
    const d = i.diff_gst;
    return `Books ${inr(i.books_gst)}<br>GSTR-2B ${inr(i.portal_gst)}${d ? `<br><b style="color:${C.red}">Difference ${d > 0 ? '+' : '-'}${inr(Math.abs(d))}</b>` : ''}`;
  }
  return i.books_gst !== null ? `Books ${inr(i.books_gst)}` : i.portal_gst !== null ? `GSTR-2B ${inr(i.portal_gst)}` : '';
}
function dueText(i) {
  if (!i.due) return `<span style="color:${C.muted}">No due date</span>`;
  if (i.state === 'overdue') return `<b style="color:${C.red}">${esc(day(i.due))}</b><br><span style="color:${C.red}">overdue by ${plural(-i.days, 'day')}</span>`;
  if (i.state === 'today') return `<b style="color:${C.amber}">Today</b>`;
  if (i.state === 'soon' || i.state === 'later') return `${esc(day(i.due))}<br><span style="color:${C.muted}">in ${plural(i.days, 'day')}</span>`;
  return esc(day(i.due));
}

/** One table of rows; `owner` adds an Owner column (the managers' summary) */
function table(items, { owner = false } = {}) {
  const rows = items.slice(0, MAX_ROWS).map(i => `<tr>
${owner ? `<td style="${TD}"><b>${esc(i.owner)}</b></td>` : ''}<td style="${TD}"><b>${esc(i.supplier || '—')}</b><br><span style="color:${C.muted}">${esc(i.supplier_gstin)}</span></td>
<td style="${TD}">${esc(i.doc_no || '—')}${i.doc_type === 'CRN' ? ' (credit note)' : i.doc_type === 'DBN' ? ' (debit note)' : ''}<br><span style="color:${C.muted}">${esc(day(i.doc_date))}</span></td>
<td style="${TD}">${esc(i.gstin)}<br><span style="color:${C.muted}">${esc([i.company_name, i.gstin_label].filter(Boolean).join(' · '))}</span></td>
<td style="${TD}">${esc(i.status_label)}${i.workflow_label ? `<br><span style="color:${C.muted}">${esc(i.workflow_label)}</span>` : ''}</td>
<td style="${TD}white-space:nowrap;">${gstText(i)}</td>
<td style="${TD}">${esc(i.next_action || '')}</td>
<td style="${TD}white-space:nowrap;">${dueText(i)}</td>
</tr>`).join('\n');
  const more = items.length > MAX_ROWS ? `<p style="margin:6px 0 0;color:${C.muted};font-size:12px;">… and ${items.length - MAX_ROWS} more — open the dashboard to see all of them.</p>` : '';
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid ${C.line};">
<tr>${owner ? `<th style="${TH}">Owner</th>` : ''}<th style="${TH}">Supplier</th><th style="${TH}">Document</th><th style="${TH}">Our GSTIN</th><th style="${TH}">Status</th><th style="${TH}">GST</th><th style="${TH}">Next action</th><th style="${TH}">Due</th></tr>
${rows}
</table>${more}`;
}
const section = (title, color, items, opts) => (items.length ? `<h3 style="margin:18px 0 6px;font-size:15px;color:${color};">${esc(title)} (${items.length})</h3>\n${table(items, opts)}` : '');

/** The link into the dashboard: straight to "My rows" for an owner, to the module for a manager */
function button(appUrl, { label = 'Open my rows in the dashboard', mine = true } = {}) {
  const where = mine ? 'GSTR-2B Reco → My rows' : 'GSTR-2B Reco';
  if (!appUrl) return `<p style="margin:18px 0 0;">To see them: open the finance dashboard → <b>${where}</b>.</p>`;
  const href = `${appUrl.replace(/\/+$/, '')}/?open=gstr2b${mine ? '&g2b=mine' : ''}`;
  return `<p style="margin:18px 0 0;"><a href="${esc(href)}" style="display:inline-block;background:${C.brand};color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:6px;font-weight:600;font-size:14px;">${esc(label)}</a></p>
<p style="margin:6px 0 0;color:${C.muted};font-size:12px;">Or open the finance dashboard → ${where}.</p>`;
}
const wrap = inner => `<div style="font-family:'Segoe UI',Arial,sans-serif;color:${C.text};font-size:14px;line-height:1.5;max-width:920px;">
${inner}
<p style="margin:22px 0 0;padding-top:10px;border-top:1px solid ${C.line};color:${C.muted};font-size:12px;">Sent automatically by GSTR-2B Reco in the finance dashboard. A row leaves these emails when it becomes matched, or when it is marked "Accepted as is" or "Resolved". Amounts are GST (IGST + CGST + SGST + cess) as recorded in Zoho Books and in GSTR-2B.</p>
</div>`;

/** The daily email to one owner. sections = { overdue, today, soon, fresh, undated }, counts = { open, later, … } */
function digest({ name, sections: s, counts, appUrl = '', soonDays = 0 }) {
  const parts = [];
  if (s.overdue.length) parts.push(`${s.overdue.length} overdue`);
  if (s.today.length) parts.push(`${s.today.length} due today`);
  if (s.soon.length) parts.push(`${s.soon.length} due soon`);
  if (s.fresh.length) parts.push(`${s.fresh.length} newly assigned`);
  if (!parts.length) parts.push(`${plural(s.undated.length, 'open row')} without a due date`);
  const subject = `GSTR-2B Reco: ${parts.join(', ')} — ${plural(counts.open, 'open row')} with you`;
  const rest = counts.open - s.overdue.length - s.today.length - s.soon.length - s.fresh.length - s.undated.length;
  const html = wrap(`<p style="margin:0 0 4px;">Hello ${esc(name)},</p>
<p style="margin:0;">${plural(counts.open, 'GSTR-2B reconciliation row')} ${counts.open === 1 ? 'is' : 'are'} assigned to you and still open.${s.overdue.length ? ` <b style="color:${C.red}">${s.overdue.length} ${s.overdue.length === 1 ? 'is' : 'are'} past the due date.</b>` : ''}</p>
${section('Overdue', C.red, s.overdue)}
${section('Due today', C.amber, s.today)}
${section(`Due in the next ${plural(soonDays, 'day')}`, C.text, s.soon)}
${section('Newly assigned to you', C.brand, s.fresh)}
${section('Open, without a due date', C.muted, s.undated)}
${rest > 0 ? `<p style="margin:14px 0 0;color:${C.muted};">${plural(rest, 'more open row')} ${rest === 1 ? 'is' : 'are'} with you and not listed today (due later, or without a due date).</p>` : ''}
${button(appUrl)}`);
  return { subject, html };
}

/** The email that goes out at once when rows are given to somebody */
function assigned({ name, by, items, appUrl = '' }) {
  const subject = `GSTR-2B Reco: ${plural(items.length, 'row')} assigned to you by ${by}`;
  const html = wrap(`<p style="margin:0 0 4px;">Hello ${esc(name)},</p>
<p style="margin:0;"><b>${esc(by)}</b> has assigned ${items.length === 1 ? 'this GSTR-2B reconciliation row' : `these ${items.length} GSTR-2B reconciliation rows`} to you.</p>
${section('Assigned to you', C.brand, items)}
${button(appUrl)}`);
  return { subject, html };
}

/** One summary for the managers: every owner's numbers, then the overdue and due-today rows */
function summary({ owners, overdue, today, unreachable = [], appUrl = '' }) {
  const n = { overdue: overdue.length, today: today.length };
  const subject = `GSTR-2B Reco follow-ups: ${n.overdue} overdue, ${n.today} due today`;
  const ownerRows = owners.map(o => `<tr><td style="${TD}"><b>${esc(o.name)}</b></td><td style="${TD}text-align:right;">${o.open}</td><td style="${TD}text-align:right;${o.overdue ? `color:${C.red};font-weight:700;` : ''}">${o.overdue}</td><td style="${TD}text-align:right;">${o.today}</td><td style="${TD}text-align:right;">${o.soon}</td><td style="${TD}text-align:right;">${o.undated}</td></tr>`).join('\n');
  const html = wrap(`<p style="margin:0;">Open GSTR-2B reconciliation rows by owner, as of today.</p>
<h3 style="margin:18px 0 6px;font-size:15px;">By owner</h3>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${C.line};">
<tr><th style="${TH}">Owner</th><th style="${TH}text-align:right;">Open rows</th><th style="${TH}text-align:right;">Overdue</th><th style="${TH}text-align:right;">Due today</th><th style="${TH}text-align:right;">Due soon</th><th style="${TH}text-align:right;">No due date</th></tr>
${ownerRows}
</table>
${section('Overdue', C.red, overdue, { owner: true })}
${section('Due today', C.amber, today, { owner: true })}
${unreachable.length ? `<p style="margin:14px 0 0;color:${C.amber};">Not reminded by email: ${unreachable.map(u => `${esc(u.who)} (${esc(u.why)}, ${plural(u.rows, 'row')})`).join('; ')}.</p>` : ''}
${button(appUrl, { label: 'Open GSTR-2B Reco', mine: false })}`);
  return { subject, html };
}

/** "Send a test email": proves the connection works, carries no data */
function test({ by, from }) {
  return { subject: 'GSTR-2B Reco: test email',
    html: wrap(`<p style="margin:0;">This is a test email from GSTR-2B Reco, sent by ${esc(by)}${from ? ` from the mailbox ${esc(from)}` : ''}.</p>
<p style="margin:10px 0 0;">If you are reading it, the dashboard can send reminder emails. Nothing else needs to be done with this message.</p>`) };
}

module.exports = { digest, assigned, summary, test, esc, inr, day, MAX_ROWS };
