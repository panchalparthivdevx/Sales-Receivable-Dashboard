const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const TOKEN_FILE = path.join(__dirname, '.token_cache.json');
const db = require('./db');

let cachedToken = null;
let tokenExpiry = 0;
let tokenInFlight = null;
let _tokenLoaded = false;

async function ensureTokenLoaded() {
  if (_tokenLoaded) return;
  _tokenLoaded = true;
  const data = await db.readZohoToken(TOKEN_FILE);
  if (data?.token && data?.expiry && Date.now() < Number(data.expiry)) {
    cachedToken = data.token;
    tokenExpiry = Number(data.expiry);
  }
}

async function getAccessToken() {
  await ensureTokenLoaded();
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = axios.post(`${process.env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    },
  }).then(async res => {
    cachedToken  = res.data.access_token;
    tokenExpiry  = Date.now() + (res.data.expires_in - 60) * 1000;
    await db.writeZohoToken(cachedToken, tokenExpiry, TOKEN_FILE);
    tokenInFlight = null;
    return cachedToken;
  }).catch(e => {
    tokenInFlight = null;
    throw e;
  });

  return tokenInFlight;
}

async function zohoGet(path, params = {}, retries = 3) {
  const token = await getAccessToken();
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.get(`${process.env.ZOHO_API_DOMAIN}/books/v3${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID, ...params },
        timeout: 30000,
      });
      return res.data;
    } catch (e) {
      if (e.response?.status === 429) {
        const body = e.response?.data;
        if (body?.code === 45) {
          console.error(`[zoho] Daily API limit exhausted (code 45). Resets at midnight UTC.`);
          throw new Error('ZOHO_DAILY_LIMIT: Zoho Books daily API limit (10,000 calls) has been reached. Please try again tomorrow or after midnight UTC when the limit resets.');
        }
        if (attempt < retries - 1) {
          const retryAfterSecs = parseInt(e.response.headers['retry-after'] || '60', 10);
          if (retryAfterSecs > 60) {
            console.error(`[zoho] 429 with retry-after=${retryAfterSecs}s — blocked, not retrying`);
            throw e;
          }
          const wait = retryAfterSecs * 1000;
          console.warn(`429 rate-limit on ${path}, waiting ${wait / 1000}s before retry ${attempt + 1}/${retries - 1}`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
      }
      throw e;
    }
  }
}

async function zohoGetAll(path, listKey, params = {}, opts = {}) {
  const { dateField = 'date', dateFrom = null, dateTo = null, maxPages = 20 } = opts;
  let page = 1;
  let all = [];

  while (page <= maxPages) {
    const data = await zohoGet(path, { ...params, page, per_page: 200 });
    const items = data[listKey] || [];
    if (items.length === 0) break;

    if (dateFrom) {
      const filtered = items.filter(i => {
        const d = i[dateField];
        return d && d >= dateFrom && (!dateTo || d <= dateTo);
      });
      all = all.concat(filtered);
      const anyAtOrAfterFrom = items.some(i => { const d = i[dateField]; return d && d >= dateFrom; });
      if (!anyAtOrAfterFrom) break;
    } else {
      all = all.concat(items);
    }

    if (!data.page_context?.has_more_page) break;
    page++;
  }

  if (page > maxPages) console.warn(`[zohoGetAll] ${path} hit maxPages=${maxPages} limit`);
  return all;
}

async function zohoPost(apiPath, data, retries = 3) {
  const token = await getAccessToken();
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.post(`${process.env.ZOHO_API_DOMAIN}/books/v3${apiPath}`, JSON.stringify(data), {
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        params: { organization_id: process.env.ZOHO_ORG_ID },
      });
      return res.data;
    } catch (e) {
      if (e.response?.status === 429 && attempt < retries - 1) {
        const wait = Math.min(parseInt(e.response.headers['retry-after'] || '60', 10), 120) * 1000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

async function zohoPut(apiPath, data, retries = 3) {
  const token = await getAccessToken();
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.put(`${process.env.ZOHO_API_DOMAIN}/books/v3${apiPath}`, JSON.stringify(data), {
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        params: { organization_id: process.env.ZOHO_ORG_ID },
      });
      return res.data;
    } catch (e) {
      if (e.response?.status === 429 && attempt < retries - 1) {
        const wait = Math.min(parseInt(e.response.headers['retry-after'] || '60', 10), 120) * 1000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

module.exports = { zohoGet, zohoGetAll, zohoPost, zohoPut };
