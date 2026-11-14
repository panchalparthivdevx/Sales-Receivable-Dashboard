/**
 * Sending email — through Microsoft 365 (Microsoft Graph "sendMail"), with the company's own app registration.
 *
 * The Microsoft 365 administrator registers an app, gives it the right to send mail (Mail.Send, application permission) and limits it
 * to the ONE mailbox the reminders are sent from — see README.md "Email reminders". Nothing is read from any mailbox.
 *
 * The credentials come from the environment only (.env on the office PC, Vercel → Settings → Environment Variables). They are never
 * stored by the module and never sent to a browser:
 *   MAIL_FROM              the mailbox the emails are sent from, e.g. finance@yourcompany.com
 *   MAIL_MS_TENANT_ID      Directory (tenant) ID          ┐ of the app registration. When these three are not set, the ones of Bill
 *   MAIL_MS_CLIENT_ID      Application (client) ID        │ Collection & Booking (BB_MS_TENANT_ID / BB_MS_CLIENT_ID / BB_MS_CLIENT_SECRET)
 *   MAIL_MS_CLIENT_SECRET  a client secret of that app    ┘ are used, so one registration can serve both modules.
 */

'use strict';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const NAMES = { from: ['MAIL_FROM'], tenant: ['MAIL_MS_TENANT_ID', 'BB_MS_TENANT_ID'], id: ['MAIL_MS_CLIENT_ID', 'BB_MS_CLIENT_ID'], secret: ['MAIL_MS_CLIENT_SECRET', 'BB_MS_CLIENT_SECRET'] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function create({ http = require('axios'), env = process.env, wait = sleep } = {}) {
  const conf = () => Object.fromEntries(Object.entries(NAMES).map(([k, names]) => [k, String(names.map(n => env[n]).find(Boolean) || '').trim()]));

  /** What the settings page shows: whether email can be sent and from which mailbox — never a credential */
  function status() {
    const c = conf();
    const missing = Object.entries(NAMES).filter(([k]) => !c[k]).map(([, names]) => names[0]);
    return { provider: 'microsoft', label: 'Microsoft 365', configured: missing.length === 0, from: c.from, missing };
  }

  let tok = null;
  async function token(c) {
    if (tok && tok.key === `${c.tenant}|${c.id}` && tok.expires_at > Date.now()) return tok.value;
    let r;
    try {
      r = await http.post(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`,
        new URLSearchParams({ client_id: c.id, client_secret: c.secret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
    } catch (e) {
      const d = e.response && e.response.data;
      const why = d && d.error_description ? String(d.error_description).split(/\r?\n/)[0].slice(0, 220) : e.message;
      throw Object.assign(new Error(`Microsoft 365 did not accept the app's sign-in (tenant ID, client ID or client secret): ${why}`), { code: 'mail_auth' });
    }
    tok = { key: `${c.tenant}|${c.id}`, value: r.data.access_token, expires_at: Date.now() + ((r.data.expires_in || 3600) - 120) * 1000 };
    return tok.value;
  }

  const recipients = list => [...new Set((Array.isArray(list) ? list : [list]).filter(Boolean).map(a => String(a).trim()))].map(address => ({ emailAddress: { address } }));

  /** Sends one HTML email from the configured mailbox. Throws an Error with a plain message when Microsoft 365 refuses it. */
  async function send({ to, cc = [], subject, html }) {
    const st = status();
    if (!st.configured) throw Object.assign(new Error(`Email sending is not set up yet (missing: ${st.missing.join(', ')})`), { code: 'mail_not_set_up' });
    const c = conf();
    const toList = recipients(to);
    if (!toList.length) throw new Error('No address to send to');
    const body = { message: { subject: String(subject || '').slice(0, 250), body: { contentType: 'HTML', content: String(html || '') }, toRecipients: toList, ccRecipients: recipients(cc) }, saveToSentItems: true };
    for (let attempt = 1; ; attempt++) {
      try {
        await http.post(`${GRAPH}/users/${encodeURIComponent(c.from)}/sendMail`, body, { headers: { Authorization: `Bearer ${await token(c)}`, 'Content-Type': 'application/json' }, timeout: 30000 });
        return { ok: true, from: c.from, to: toList.map(x => x.emailAddress.address) };
      } catch (e) {
        if (e.code === 'mail_auth') throw e;
        const status = e.response && e.response.status, err = (e.response && e.response.data && e.response.data.error) || {};
        if (status === 401 && attempt === 1) { tok = null; continue; }                                  // a token that expired early: sign in again once
        if ((status === 429 || status >= 500) && attempt < 3) { await wait(Math.min(10, Number(e.response.headers && e.response.headers['retry-after']) || 2 * attempt) * 1000); continue; }
        if (status === 403) throw Object.assign(new Error(`Microsoft 365 does not allow the app to send from ${c.from}: the administrator has to give it the "Mail.Send" permission for this mailbox (${err.code || 'access denied'}).`), { code: 'mail_forbidden' });
        if (status === 404) throw Object.assign(new Error(`The mailbox ${c.from} was not found in Microsoft 365 — check MAIL_FROM (${err.code || 'not found'}).`), { code: 'mail_no_mailbox' });
        throw Object.assign(new Error(`Microsoft 365 could not send the email: ${err.message || e.message}${err.code ? ` (${err.code})` : ''}`), { code: 'mail_failed' });
      }
    }
  }

  return { status, send };
}

module.exports = { create };
