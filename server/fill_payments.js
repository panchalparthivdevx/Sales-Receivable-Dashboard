/**
 * fill_payments.js
 * Reads New_Bill_Details_with_Payments.xlsx, fetches payment data from Zoho Books
 * for blank "Payment Date(s)" and "Payment Amount" cells, writes updated file.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');
const XLSX  = require('xlsx');
const path  = require('path');
const fs    = require('fs');

const EXCEL_FILE = path.resolve(__dirname, '../New_Bill_Details_with_Payments.xlsx');
const TOKEN_FILE = path.resolve(__dirname, '.token_cache.json');

const ORG_ID    = process.env.ZOHO_ORG_ID;
const API_BASE  = (process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in') + '/books/v3';

// ── Token management ──────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  // Try reading cached token first
  if (!cachedToken) {
    try {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (d.token && Date.now() < Number(d.expiry)) {
        cachedToken = d.token;
        tokenExpiry = Number(d.expiry);
      }
    } catch (_) {}
  }
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  // Refresh token
  const res = await axios.post(`${process.env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    },
  });
  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

async function zohoGet(endpoint, params = {}) {
  const token = await getToken();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(`${API_BASE}${endpoint}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params:  { organization_id: ORG_ID, ...params },
        timeout: 30000,
      });
      return res.data;
    } catch (e) {
      if (e.response?.status === 429) {
        const wait = parseInt(e.response.headers['retry-after'] || '60', 10) * 1000;
        console.log(`  [rate-limit] waiting ${wait/1000}s…`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

// ── Build bill_number → bill_id lookup from Zoho ─────────────────────────────
async function buildBillLookup() {
  console.log('Fetching all bills from Zoho Books to build lookup map…');
  const lookup = {}; // bill_number (lowercase trim) → bill_id
  let page = 1, total = 0;
  while (true) {
    const d = await zohoGet('/bills', { filter_by: 'Status.All', per_page: 200, page });
    const bills = d.bills || [];
    for (const b of bills) {
      const key = (b.bill_number || '').trim().toLowerCase();
      if (key) lookup[key] = b.bill_id;
      // Also index by reference_number in case bill_number differs
      const refKey = (b.reference_number || '').trim().toLowerCase();
      if (refKey && !lookup[refKey]) lookup[refKey] = b.bill_id;
    }
    total += bills.length;
    process.stdout.write(`\r  Fetched ${total} bills (page ${page})…`);
    if (!d.page_context?.has_more_page) break;
    page++;
  }
  console.log(`\n  Done — ${Object.keys(lookup).length} unique bill keys in lookup.`);
  return lookup;
}

// ── Fetch payment details for a single bill ───────────────────────────────────
async function getBillPayments(billId) {
  try {
    const d = await zohoGet(`/bills/${billId}`);
    const bill = d.bill || {};

    // Cash / bank payments
    const cashPmts = (bill.payments || []).map(p => ({
      date:   p.date || '',
      amount: p.amount || 0,
      ref:    p.reference_number || p.payment_number || '',
    }));

    // Credit note payments (vendor_credits applied to this bill)
    const creditPmts = (bill.vendor_credits || []).map(vc => ({
      date:   vc.date || '',
      amount: vc.amount || 0,
      ref:    vc.vendor_credit_number || '',
    }));

    return [...cashPmts, ...creditPmts];
  } catch (_) { return []; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Reading Excel file…');
  const wb = XLSX.readFile(EXCEL_FILE);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const headers   = rows[0];
  const COL = {
    status:   headers.indexOf('Status'),
    bill:     headers.indexOf('Bill#'),
    payDate:  headers.indexOf('Payment Date(s)'),
    payAmt:   headers.indexOf('Payment Amount'),
    payVouch: headers.indexOf('Payment Voucher(s)'),
  };
  console.log('Column indices:', COL);

  // Collect rows that need filling (Paid or Open status, blank payment date)
  const toFill = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const status = r[COL.status];
    const billNo = (r[COL.bill] || '').trim();
    const payDate = r[COL.payDate];
    const payAmt  = r[COL.payAmt];
    if (!billNo) continue;
    if (payDate !== '' && payAmt !== '') continue; // already filled
    if (status !== 'Paid' && status !== 'Partially Paid' && status !== 'Open') continue;
    toFill.push({ rowIdx: i, billNo, status });
  }
  console.log(`Rows to fill: ${toFill.length} (Paid/Partial/Open with blank payment data)`);

  // Build bill lookup
  const lookup = await buildBillLookup();

  // Fetch payment details and fill rows
  let filled = 0, notFound = 0, noPayments = 0;
  for (let i = 0; i < toFill.length; i++) {
    const { rowIdx, billNo, status } = toFill[i];
    const key = billNo.toLowerCase();
    const billId = lookup[key];

    process.stdout.write(`\r  Processing ${i+1}/${toFill.length} — "${billNo}"…          `);

    if (!billId) {
      notFound++;
      continue;
    }

    const payments = await getBillPayments(billId);
    if (!payments.length) {
      noPayments++;
      continue;
    }

    // Format: if multiple payments, join with " | "
    const dates   = payments.map(p => p.date).filter(Boolean).join(' | ');
    const amounts = payments.reduce((s, p) => s + p.amount, 0);
    const vouchers = payments.map(p => p.ref).filter(Boolean).join(' | ');

    rows[rowIdx][COL.payDate]  = dates;
    rows[rowIdx][COL.payAmt]   = amounts;
    if (COL.payVouch >= 0 && rows[rowIdx][COL.payVouch] === '') {
      rows[rowIdx][COL.payVouch] = vouchers;
    }
    filled++;

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 120));
  }

  console.log(`\nDone. Filled: ${filled} | Not found in Zoho: ${notFound} | No payments in Zoho: ${noPayments}`);

  // Write updated Excel
  const newWs = XLSX.utils.aoa_to_sheet(rows);
  // Preserve column widths from original if possible
  if (ws['!cols']) newWs['!cols'] = ws['!cols'];
  wb.Sheets[sheetName] = newWs;

  const outFile = EXCEL_FILE.replace('.xlsx', '_FILLED.xlsx');
  XLSX.writeFile(wb, outFile);
  console.log(`Saved to: ${outFile}`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
