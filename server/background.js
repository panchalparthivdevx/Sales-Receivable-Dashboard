/**
 * Background work started by a request (a sync, a cache refresh) must be registered
 * with Vercel's waitUntil, or Vercel freezes the function once the response is sent.
 * On the office PC the process simply keeps running, so this does nothing there.
 * Vercel still ends the work at the function's maxDuration (vercel.json).
 */
let _waitUntil = null;
if (process.env.VERCEL) {
  try { _waitUntil = require('@vercel/functions').waitUntil; } catch (_) {}
}

function background(promise) {
  if (_waitUntil) { try { _waitUntil(promise); } catch (_) {} }
  return promise;
}

module.exports = { background };
