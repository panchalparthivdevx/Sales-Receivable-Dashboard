/**
 * Uploaded documents: vendor-registration attachments, Finance Portal files, CRM bills.
 *
 * Office PC: saved in their folders as before (callers keep their own disk code).
 * Vercel (disk is temporary): a private Vercel Blob store connected to the project
 * (Storage → Create → Blob → Private). Files are read back only through the dashboard's
 * own routes, after its login — a blob URL alone cannot open them.
 */
const { Readable } = require('stream');

const enabled = !!process.env.VERCEL;
let _sdk = null;
const sdk = () => (_sdk || (_sdk = require('@vercel/blob')));

async function save(pathname, buffer, contentType) {
  await sdk().put(pathname, buffer, {
    access: 'private', contentType: contentType || undefined, addRandomSuffix: false, allowOverwrite: true,
  });
}

async function exists(pathname) {
  try { await sdk().head(pathname); return true; } catch (_) { return false; }
}

// Streams the stored file to the response; false when it does not exist
async function send(res, pathname) {
  const r = await sdk().get(pathname, { access: 'private' });
  if (!r || r.statusCode !== 200 || !r.stream) return false;
  res.setHeader('Content-Type', r.blob.contentType || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  Readable.fromWeb(r.stream).pipe(res);
  return true;
}

module.exports = { enabled, save, exists, send };
