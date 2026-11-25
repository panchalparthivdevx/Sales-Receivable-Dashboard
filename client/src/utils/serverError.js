// Error answers from the server, always as text.
//
// The dashboard answers {"error": "text"}. When Vercel itself stops a request (over the 5-minute limit, a crash,
// an upload that is too large) it answers {"error": {"code": "...", "message": "..."}} instead. Pages show
// response.data.error as text, so that object crashed the whole app with React error #31 (25 Nov 2026,
// Bill Collection & Booking → "Check all now" online). normalizeServerError turns it into text once, for every page.

function vercelText(status, e) {
  const code = String(e.code || '');
  if (status === 504 || /TIMEOUT/i.test(code)) {
    return 'The online server stopped this request because it ran longer than its 5-minute limit. Work already finished is kept — try again to continue.';
  }
  if (status === 413 || /TOO_LARGE/i.test(code)) {
    return 'The request was larger than the online server accepts (about 4.5 MB) — send fewer or smaller files at a time.';
  }
  const msg = typeof e.message === 'string' ? e.message : '';
  return `The online server stopped this request${code ? ` (${code}${msg ? `: ${msg}` : ''})` : msg ? ` (${msg})` : ''}. Please try again.`;
}

/** Rewrites an axios error in place so that error.response.data.error is text (or absent), never an object */
export function normalizeServerError(err) {
  const res = err && err.response;
  const d = res && res.data;
  if (d && typeof d === 'object' && d.error && typeof d.error === 'object') {
    res.data = { ...d, error: vercelText(res.status, d.error) };
  }
  return err;
}

/** The text to show for a failed request */
export function serverErrorText(err, fallback = 'Something went wrong') {
  normalizeServerError(err);
  const x = err && err.response && err.response.data && err.response.data.error;
  if (typeof x === 'string' && x) return x;
  if (x != null && typeof x !== 'object') return String(x);
  return (err && typeof err.message === 'string' && err.message) || fallback;
}
