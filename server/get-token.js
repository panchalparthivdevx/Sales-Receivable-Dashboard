/**
 * Zoho Token Helper — run once to get a new refresh token with full scope.
 *
 * Usage:
 *   node server/get-token.js <authorization_code>
 *
 * If no code is passed, it prints the authorization URL you need to visit.
 */

require('dotenv').config();
const axios = require('axios');

const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ACCOUNTS_URL  = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in';

// Full access covers ALL Zoho Books modules including bills, vendor payments, expenses
const SCOPE = 'ZohoBooks.fullaccess.all';

const code = process.argv[2];

if (!code) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  STEP 1 — Generate an authorization code');
  console.log('══════════════════════════════════════════════════════');
  console.log('\nOption A (Self Client — easiest):');
  console.log('  1. Go to: https://api-console.zoho.in');
  console.log('  2. Select your app (client ID starts with 1000.G4XCC...)');
  console.log('  3. Click the "Self Client" tab');
  console.log('  4. Paste this scope:  ' + SCOPE);
  console.log('  5. Set duration: 10 minutes');
  console.log('  6. Click "Create" — copy the one-time code shown');
  console.log('\nOption B (Browser OAuth):');
  console.log('  Visit this URL and approve access:');
  const authUrl = `${ACCOUNTS_URL}/oauth/v2/auth`
    + `?scope=${SCOPE}`
    + `&client_id=${CLIENT_ID}`
    + `&response_type=code`
    + `&redirect_uri=https://www.zoho.com/books`
    + `&access_type=offline`
    + `&prompt=consent`;
  console.log('\n  ' + authUrl);
  console.log('\n  After approving, copy the "code" from the redirect URL.');
  console.log('\nSTEP 2 — Run this script with the code:');
  console.log('  node server/get-token.js  YOUR_CODE_HERE\n');
  process.exit(0);
}

(async () => {
  console.log('\nExchanging code for refresh token…');
  try {
    const res = await axios.post(`${ACCOUNTS_URL}/oauth/v2/token`, null, {
      params: {
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  'https://www.zoho.com/books',
        grant_type:    'authorization_code',
      },
    });

    const { access_token, refresh_token, error, error_description } = res.data;

    if (error) {
      console.error('\n✗ Zoho error:', error, '-', error_description);
      console.error('  Make sure the code is fresh (< 10 min) and redirect_uri matches your app.');
      process.exit(1);
    }

    console.log('\n✓ Success!\n');
    console.log('NEW REFRESH TOKEN:', refresh_token);
    console.log('\nUpdate your .env:');
    console.log('  ZOHO_REFRESH_TOKEN=' + refresh_token);
    console.log('\nThen restart the server.');

    // Also verify bills access with the new token
    console.log('\nVerifying bills access…');
    const test = await axios.get(`${process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in'}/books/v3/bills`, {
      headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
      params:  { organization_id: process.env.ZOHO_ORG_ID, per_page: 1 },
    });
    console.log('✓ Bills API:', test.data.message || 'accessible');
  } catch (e) {
    console.error('\n✗ Error:', e.response?.data || e.message);
  }
})();
