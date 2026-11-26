'use strict';

// Logos, badges, banners, photos and marketing material are not bills: not collected, or set aside as
// Not a Bill with the reason — also for bills collected before this rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const C = require('../lib/config');
const PIC = require('../lib/pictures');
const ML = require('../lib/mail');

const user = { id: '1', username: 'admin', name: 'Admin A' };

// A reading that found nothing bill-like
const NOTHING = { doc_type: 'other', fields: { vendor_name: '', vendor_gstin: '', buyer_gstin: '', invoice_number: '', invoice_date: '', sub_total: null, cgst: 0, sgst: 0, tax_total: 0, total: null, description: '' }, lines: [] };

test('picture size is read from the file header (PNG, JPEG, GIF, BMP, WebP)', () => {
  assert.deepEqual(PIC.imageSize(H.png(600, 90)), { width: 600, height: 90 });
  assert.deepEqual(PIC.imageSize(H.jpg(1240, 1754)), { width: 1240, height: 1754 });
  const gif = Buffer.alloc(30); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(100, 8);
  assert.deepEqual(PIC.imageSize(gif), { width: 320, height: 100 });
  const bmp = Buffer.alloc(30); bmp.write('BM', 0, 'latin1'); bmp.writeInt32LE(800, 18); bmp.writeInt32LE(-600, 22);
  assert.deepEqual(PIC.imageSize(bmp), { width: 800, height: 600 });
  const webp = Buffer.alloc(32); webp.write('RIFF', 0, 'latin1'); webp.write('WEBP', 8, 'latin1'); webp.write('VP8X', 12, 'latin1');
  webp.writeUIntLE(1199, 24, 3); webp.writeUIntLE(1599, 27, 3);
  assert.deepEqual(PIC.imageSize(webp), { width: 1200, height: 1600 });
  assert.equal(PIC.imageSize(Buffer.from('not an image at all, just some text')), null);
});

test('which pictures are bills: logos, badges, banners and small pictures in the email text are not', () => {
  const v = (name, w, h) => PIC.verdict({ name, dims: { width: w, height: h } });
  assert.equal(v('image001.png', 600, 90).kind, 'logo');                 // GT Bharat banner
  assert.equal(v('image003.png', 480, 690).kind, 'logo');                // award badge
  assert.match(v('banner.jpg', 1800, 400).reason, /Banner-shaped/);
  assert.equal(v('image007.png', 800, 1000).kind, 'embedded');           // bigger badge inside the email text
  assert.match(v('image007.png', 800, 1000).reason, /Picture inside the email text \(800 × 1000 pixels\)/);
  assert.equal(v('Outlook-abc123.png', 900, 900).kind, 'embedded');      // new Outlook's signature names
  assert.equal(v('scan.jpg', 1240, 1754), null, 'a scanned bill');
  assert.equal(v('image001.png', 1240, 1754), null, 'a bill pasted into the email text is big enough to keep');
  assert.equal(v('receipt.jpg', 600, 2200), null, 'a long, narrow receipt photo is not a banner');
  assert.equal(PIC.verdict({ name: 'image002.jpg', dims: null, size: 40000 }).kind, 'embedded', 'size unknown: Outlook picture name and small file');
  assert.equal(PIC.verdict({ name: 'IMG_2026.jpg', dims: null, size: 40000 }), null);
});

async function ingest(env, name, buffer, extra = {}) {
  const r = await env.pipeline.ingest({ buffer, name, mime: '', source: 'email', member_id: 'm1', by: 'mailbox',
    source_ref: { message_id: `m-${name}`, mailbox: 'asha@devx.work', from: 'Siddharth <s@gt.com>', subject: 'Dev and Neddle | GST review', ...(extra.ref || {}) } });
  await env.pipeline.idle();
  return env.store.bill(r.id);
}

test('workflow: a logo is set aside as Not a Bill without being read; "Read again" reads it anyway', async () => {
  const env = H.setup();
  await H.seedConfig();
  const b = await ingest(env, 'image001.png', H.png(600, 90));
  assert.equal(b.status, 'not_bill'); assert.equal(b.not_bill.kind, 'picture');
  assert.match(b.not_bill.reason, /Picture of only 600 × 90 pixels/);
  assert.deepEqual(env.readCalls, [], 'no reading (OCR / Claude) spent on it');
  assert.equal(b.file.width, 600);
  assert.ok(b.audit.some(a => a.action === 'extracted' && /^Not read — Picture of only/.test(a.detail)));
  assert.ok(!env.zc.calls.some(c => c === 'vendorBills' || c.startsWith('detail:')), 'no Zoho look-ups either');

  const again = await env.pipeline.action(b.id, 'reprocess', {}, user);
  assert.deepEqual(env.readCalls, ['image001.png'], 'read when the team asks');
  assert.notEqual(again.status, 'not_bill', 'the reading found a bill (invoice number, total), so it is not "only a picture"');

  // a scan or photo of a bill is read as usual
  const scan = await ingest(env, 'scan.jpg', H.jpg(1240, 1754));
  assert.ok(env.readCalls.includes('scan.jpg')); assert.equal(scan.picture, null);
});

test('workflow: a picture inside the email text, and a photo in which OCR found no words, are Not a Bill', async () => {
  const env = H.setup({ reads: { 'photo.jpg': { ...NOTHING, engine: 'text', text_method: 'ocr', text: 'GT 90' }, '*': {} } });
  await H.seedConfig();
  const badge = await ingest(env, 'image007.png', H.png(800, 1000));
  assert.equal(badge.status, 'not_bill'); assert.match(badge.not_bill.reason, /Picture inside the email text/);
  const photo = await ingest(env, 'photo.jpg', H.jpg(1600, 1200));
  assert.equal(photo.status, 'not_bill'); assert.match(photo.not_bill.reason, /no readable text/);
});

test('re-check: pictures collected before this rule (OCR timed out online) become Not a Bill; the team\'s "It is a bill" is kept', async () => {
  const env = H.setup();
  await H.seedConfig();
  const ids = [];
  for (const [name, buf] of [['image005.jpg', H.jpg(500, 700)], ['image008.png', H.png(640, 120, 'b')], ['image009.png', H.png(400, 400, 'c')]]) ids.push((await ingest(env, name, buf)).id);
  // as they were collected before: read (OCR gave up), nothing found, size unknown, checked under older rules
  await env.store.tx(async t => {
    for (const id of ids) {
      const b = t.bill(id);
      b.extraction = { engine: 'text', text_method: 'none', unreadable: true, warnings: ['Text could not be read: OCR did not finish within 120 seconds'], text_sample: '', confidence: 'low' };
      b.fields = {}; b.lines = []; b.doc_type = { value: 'other', basis: 'No bill heading found' };
      delete b.file.width; delete b.file.height; delete b.rules_v; b.picture = null; b.not_bill = null; b.status = 'needs_input';
      t.putBill(b);
    }
    const kept = t.bill(ids[2]); kept.not_bill = { overridden: true, by: 'Rev' }; t.putBill(kept);
  });
  assert.equal(await env.pipeline.recheckOld(), 3);
  const [a, b, c] = await Promise.all(ids.map(id => env.store.bill(id)));
  assert.equal(a.status, 'not_bill'); assert.match(a.not_bill.reason, /500 × 700 pixels/); assert.equal(a.file.width, 500);
  assert.equal(b.status, 'not_bill'); assert.match(b.not_bill.reason, /640 × 120/);
  assert.notEqual(c.status, 'not_bill', 'the team said it is a bill');
});

test('marketing: an attachment from a newsletter with no bill heading is Not a Bill; a real invoice from the same email is kept', async () => {
  const env = H.setup({ reads: { 'brochure.pdf': NOTHING, '*': {} } });
  await H.seedConfig();
  const ref = { marketing: 'a newsletter or marketing email (it has an unsubscribe link)' };
  const br = await ingest(env, 'brochure.pdf', H.pdf('brochure'), { ref });
  assert.equal(br.status, 'not_bill'); assert.equal(br.not_bill.kind, 'marketing');
  assert.match(br.not_bill.reason, /newsletter or marketing email.*no bill heading, invoice number or total/);
  const inv = await ingest(env, 'invoice.pdf', H.pdf('inv'), { ref });
  assert.equal(inv.status, 'ready', 'a tax invoice is a bill, whatever email it came with');
});

test('mailbox: signature logos are ignored, pictures in the email text are listed as skipped, newsletters are marked; "Read as bill" reads one anyway', async () => {
  process.env.BB_MS_CLIENT_ID = process.env.BB_MS_CLIENT_ID || 'client-id-test';
  process.env.BB_MS_CLIENT_SECRET = process.env.BB_MS_CLIENT_SECRET || 'client-secret-test';
  const day0 = new Date(Date.now() - 2 * 86400000).toISOString();
  const content = { a1: H.png(600, 90), a2: H.png(800, 1000), a3: H.pdf('fees'), a4: H.jpg(1240, 1754) };
  const atts = [
    { id: 'a1', name: 'image001.png', contentType: 'image/png', size: 34000 },
    { id: 'a2', name: 'image003.png', contentType: 'image/png', size: 54000 },
    { id: 'a3', name: 'Fee note.pdf', contentType: 'application/pdf', size: 80000 },
    { id: 'a4', name: 'invoice photo.jpg', contentType: 'image/jpeg', size: 400000 },
  ];
  const seen = [];
  const http = {
    async post() { return { data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }; },
    async get(url, cfg = {}) {
      if (url.endsWith('/me')) return { data: { mail: 'asha@devx.work' } };
      if (/\/me\/messages\?/.test(url)) {
        seen.push(cfg.headers?.Prefer || '');
        return { data: { value: [{ id: 'msgA', internetMessageId: '<a@x>', subject: 'Invoice for October', from: { emailAddress: { name: 'GT', address: 's@gt.com' } }, receivedDateTime: day0,
          bodyPreview: 'Please find our invoice', body: { contentType: 'text', content: 'Please find our invoice.\n\nTo unsubscribe from our updates click here.' } }] } };
      }
      if (/\/attachments$/.test(url)) return { data: { value: atts.map(a => ({ '@odata.type': '#microsoft.graph.fileAttachment', isInline: false, ...a })) } };
      const v = url.match(/\/attachments\/(\w+)\/\$value$/);
      if (v) return { data: content[v[1]] };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const env = H.setup();
  await H.seedConfig();
  const mail = ML.create({ store: env.store, pipeline: env.pipeline, files: env.files, lookups: env.lookups, http, log: { error() {} } });
  const cfg = C.merge((await env.store.snapshot()).doc('bb_config'));
  const url = mail.authUrl(cfg.team[0], 'http://localhost:3002/api/bill-booking/oauth/callback', user);
  await mail.completeAuth(new URL(url).searchParams.get('state'), 'code-1', 'http://localhost:3002/api/bill-booking/oauth/callback');

  const [res] = await mail.pollAll();
  await env.pipeline.idle();
  assert.match(seen[0], /outlook\.body-content-type="text"/, 'the text body is asked for (to see the unsubscribe link)');
  assert.equal(res.pictures, 1, 'the banner is ignored');
  assert.equal(res.skipped, 1); assert.equal(res.ingested, 2, 'the fee note and the bill photo are collected');
  const m = (await env.store.snapshot()).doc('bb_mail');
  assert.equal(m.skipped[0].name, 'image003.png'); assert.equal(m.skipped[0].picture, true);
  assert.match(m.skipped[0].reason, /Picture inside the email text \(800 × 1000 pixels\)/);
  const bills = (await env.store.snapshot()).bills;
  assert.ok(bills.every(b => /unsubscribe link/.test(b.source_ref.marketing)), 'the newsletter mark travels with the bill');
  assert.ok(bills.every(b => b.status !== 'not_bill'), 'a subject saying "Invoice" and a read invoice keep them as bills');

  const r = await mail.processSkipped(m.skipped[0].key, user);
  await env.pipeline.idle();
  const read = await env.store.bill(r.id);
  assert.ok(env.readCalls.includes('image003.png'), 'read on request');
  assert.equal(read.not_bill.overridden, true); assert.notEqual(read.status, 'not_bill');
  assert.ok(read.audit.some(a => a.action === 'is_bill' && /on request/.test(a.detail)));
});
