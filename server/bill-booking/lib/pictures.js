/**
 * Pictures that are not bills: email signature logos, award badges, banners, marketing pictures.
 *
 * Decided from the picture itself — its size in pixels and its shape, read from the file header — and from
 * how it came: Outlook names the pictures placed inside an email's text "image001.png", "image002.jpg" …
 * (new Outlook: "Outlook-xxxxxx.png"), and Microsoft does not always mark them as inline. A readable bill
 * needs far more pixels than a logo, so these pictures are set aside without reading them (no OCR / Claude
 * time is spent on them).
 */

'use strict';

const OUTLOOK_PICTURE = /^(image\d{3,}|outlook-[a-z0-9]{5,}|~wrd\d+)\.(png|jpe?g|gif|bmp|webp)$/i;
const MP = 1e6;
const LOGO_MAX_PX = 0.4 * MP;        // a readable bill (even a phone photo of a small receipt) has more pixels
const LOGO_MAX_SIDE = 300;           // narrower than this on its short side: never readable
const BANNER_RATIO = 3;              // three times wider than high: a banner (tall receipts are allowed)
const IN_TEXT_MAX_PX = 1.5 * MP;     // a picture inside the email text smaller than this is a logo or marketing picture
const IN_TEXT_MAX_BYTES = 150 * 1024;

/** Width and height from the file header (PNG, JPEG, GIF, BMP, WebP) → { width, height } | null */
function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  const ok = (w, h) => (w > 0 && h > 0 && w < 100000 && h < 100000 ? { width: w, height: h } : null);
  // PNG: signature, then the IHDR chunk
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') return ok(buf.readUInt32BE(16), buf.readUInt32BE(20));
  // GIF
  if (buf.toString('latin1', 0, 4) === 'GIF8') return ok(buf.readUInt16LE(6), buf.readUInt16LE(8));
  // BMP
  if (buf.toString('latin1', 0, 2) === 'BM' && buf.length >= 26) return ok(buf.readInt32LE(18), Math.abs(buf.readInt32LE(22)));
  // WebP
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' && buf.length >= 30) {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return ok(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    if (chunk === 'VP8L') {
      const b = buf.subarray(21, 25);
      return ok(1 + (((b[1] & 0x3f) << 8) | b[0]), 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)));
    }
    if (chunk === 'VP8X') return ok(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
    return null;
  }
  // JPEG: walk the segments to the frame header (SOFn)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
      if (m === 0xd9 || m === 0xda) return null;
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/**
 * Is this picture a bill at all? → null (it may be) or { kind, reason }
 *   kind 'logo'      too small or banner-shaped to be a readable bill (logo, badge, banner)
 *        'embedded'  a picture inside the email text that is not big enough to be a pasted bill
 * name: file name; dims: { width, height } (null when unknown); inline: the mail service marked it inline.
 */
function verdict({ name = '', dims = null, inline = false, size = 0 }) {
  const inText = inline || OUTLOOK_PICTURE.test(String(name).trim());
  if (dims) {
    const { width: w, height: h } = dims;
    const px = w * h, sz = `${w} × ${h} pixels`;
    if (px < LOGO_MAX_PX || Math.min(w, h) < LOGO_MAX_SIDE) return { kind: 'logo', reason: `Picture of only ${sz} — too small to be a readable bill (a logo, badge or banner)` };
    if (w / h > BANNER_RATIO) return { kind: 'logo', reason: `Banner-shaped picture (${sz}) — not a bill` };
    if (inText && px < IN_TEXT_MAX_PX) return { kind: 'embedded', reason: `Picture inside the email text (${sz}) — a logo, signature or marketing picture, not a bill attachment` };
    return null;
  }
  if (inText && size > 0 && size < IN_TEXT_MAX_BYTES) return { kind: 'embedded', reason: 'Picture inside the email text — a logo, signature or marketing picture, not a bill attachment' };
  return null;
}

const isImage = b => String(b?.file?.type || '').startsWith('image/');

/**
 * A collected bill that is only a picture → { kind, reason } | null. Never when the reading found bill
 * details (a bill heading, invoice number, total or supplier GSTIN): then it is a photo or scan of a bill.
 * billTypes: the document types that are bills (extract.BILL_TYPES).
 */
function forBill(b, dims, billTypes) {
  if (!isImage(b)) return null;
  const f = b.fields || {};
  if ((b.doc_type && billTypes.has(b.doc_type.value)) || f.invoice_number || f.total > 0 || f.vendor_gstin) return null;
  const v = verdict({ name: b.source_ref?.attachment_name || b.file?.name, dims, inline: !!b.source_ref?.inline, size: b.file?.size || 0 });
  if (v) return v;
  // OCR finished and found (almost) no words: a photo or graphic
  const ex = b.extraction || {};
  if (ex.text_method === 'ocr' && (String(ex.text_sample || '').match(/[a-z]/gi) || []).length < 25) {
    return { kind: 'no_text', reason: 'Picture with no readable text — a photo or graphic, not a bill' };
  }
  return null;
}

module.exports = { imageSize, verdict, forBill, isImage, OUTLOOK_PICTURE };
