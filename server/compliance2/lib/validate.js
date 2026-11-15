/**
 * Identifier checks: GSTIN (with its check character), PAN, TAN, CIN, LLPIN, PF establishment code, ESIC code, and the
 * GST state code table. Errors stop a save; warnings are shown and saved with the record for a human to look at.
 */

'use strict';

// GST state codes (first two characters of a GSTIN)
const STATES = [
  ['01', 'JK', 'Jammu and Kashmir'], ['02', 'HP', 'Himachal Pradesh'], ['03', 'PB', 'Punjab'], ['04', 'CH', 'Chandigarh'],
  ['05', 'UK', 'Uttarakhand'], ['06', 'HR', 'Haryana'], ['07', 'DL', 'Delhi'], ['08', 'RJ', 'Rajasthan'], ['09', 'UP', 'Uttar Pradesh'],
  ['10', 'BR', 'Bihar'], ['11', 'SK', 'Sikkim'], ['12', 'AR', 'Arunachal Pradesh'], ['13', 'NL', 'Nagaland'], ['14', 'MN', 'Manipur'],
  ['15', 'MZ', 'Mizoram'], ['16', 'TR', 'Tripura'], ['17', 'ML', 'Meghalaya'], ['18', 'AS', 'Assam'], ['19', 'WB', 'West Bengal'],
  ['20', 'JH', 'Jharkhand'], ['21', 'OD', 'Odisha'], ['22', 'CG', 'Chhattisgarh'], ['23', 'MP', 'Madhya Pradesh'], ['24', 'GJ', 'Gujarat'],
  ['26', 'DN', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'MH', 'Maharashtra'], ['29', 'KA', 'Karnataka'], ['30', 'GA', 'Goa'],
  ['31', 'LD', 'Lakshadweep'], ['32', 'KL', 'Kerala'], ['33', 'TN', 'Tamil Nadu'], ['34', 'PY', 'Puducherry'],
  ['35', 'AN', 'Andaman and Nicobar Islands'], ['36', 'TS', 'Telangana'], ['37', 'AP', 'Andhra Pradesh'], ['38', 'LA', 'Ladakh'],
  ['97', 'OT', 'Other Territory'],
].map(([code, abbr, name]) => ({ code, abbr, name }));
const STATE_BY_CODE = new Map(STATES.map(s => [s.code, s]));
const STATE_BY_ABBR = new Map(STATES.map(s => [s.abbr, s]));
const stateOf = v => STATE_BY_ABBR.get(String(v || '').toUpperCase()) || STATE_BY_CODE.get(String(v || '')) || null;

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Check character of the first 14 characters of a GSTIN */
function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const p = v * ((i % 2) + 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

const norm = v => String(v || '').trim().toUpperCase().replace(/\s+/g, '');
const result = () => ({ ok: true, errors: [], warnings: [] });
const fail = (r, m) => { r.ok = false; r.errors.push(m); return r; };

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
// 4th character of a PAN: the kind of holder
const PAN_HOLDER = { C: 'company', F: 'firm / LLP', P: 'individual', H: 'HUF', A: 'AOP', T: 'trust', B: 'BOI', L: 'local authority', J: 'artificial juridical person', G: 'government' };
const PAN_EXPECT = { company: 'C', llp: 'F' };

function pan(v, entityKind) {
  const r = result(); const p = norm(v); r.value = p;
  if (!PAN_RE.test(p)) return fail(r, 'PAN must be 5 letters, 4 digits and a letter (e.g. AAAAA9999A)');
  const want = PAN_EXPECT[entityKind];
  if (want && p[3] !== want) r.warnings.push(`PAN 4th character is "${p[3]}" (${PAN_HOLDER[p[3]] || 'unknown holder type'}); a ${entityKind === 'llp' ? 'LLP' : 'company'} PAN usually has "${want}"`);
  return r;
}

function tan(v) {
  const r = result(); const t = norm(v); r.value = t;
  if (!TAN_RE.test(t)) return fail(r, 'TAN must be 4 letters, 5 digits and a letter (e.g. AHMA99999A)');
  return r;
}

/**
 * GSTIN. kind: GST_REGULAR / GST_COMPOSITION / GST_ISD (PAN-based, 14th character Z), GST_TDS (TAN-based, 14th D),
 * GST_TCS (PAN-based, 14th C), GST_NRTP / GST_OIDAR / GST_CASUAL (format and check character only).
 * entityPan: the entity's PAN — must be inside a PAN-based GSTIN. state: the registration's state (abbr or code).
 */
function gstin(v, { kind = 'GST_REGULAR', entityPan, entityTan, state } = {}) {
  const r = result(); const g = norm(v); r.value = g;
  if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(g)) return fail(r, 'GSTIN must be 15 characters: a 2-digit state code and 13 letters / digits');
  const want = gstinCheckChar(g.slice(0, 14));
  if (want !== g[14]) return fail(r, `GSTIN check character is wrong (the 15th character should be ${want || '?'}) — please re-check the number`);
  const st = STATE_BY_CODE.get(g.slice(0, 2));
  r.state_code = g.slice(0, 2);
  if (!st && !['GST_OIDAR', 'GST_NRTP'].includes(kind)) return fail(r, `GSTIN state code ${g.slice(0, 2)} is not a known GST state code`);
  if (st) r.state = st.abbr;
  if (state && st && stateOf(state) && stateOf(state).code !== st.code) fail(r, `GSTIN state code ${st.code} (${st.name}) does not match the registration state ${stateOf(state).name}`);
  const fourteenth = g[13];
  if (['GST_REGULAR', 'GST_COMPOSITION', 'GST_ISD', 'GST_CASUAL'].includes(kind)) {
    if (!PAN_RE.test(g.slice(2, 12))) fail(r, 'Characters 3–12 of this GSTIN should be the PAN');
    if (fourteenth !== 'Z') r.warnings.push(`The 14th character is "${fourteenth}"; for a normal taxpayer it is usually "Z"`);
    if (entityPan && g.slice(2, 12) !== norm(entityPan)) fail(r, `This GSTIN belongs to PAN ${g.slice(2, 12)}, not to the entity's PAN ${norm(entityPan)}`);
  } else if (kind === 'GST_TCS') {
    if (entityPan && g.slice(2, 12) !== norm(entityPan)) fail(r, `This GSTIN belongs to PAN ${g.slice(2, 12)}, not to the entity's PAN ${norm(entityPan)}`);
    if (fourteenth !== 'C') r.warnings.push(`A GST TCS registration usually has "C" as the 14th character (this one has "${fourteenth}")`);
  } else if (kind === 'GST_TDS') {
    if (!TAN_RE.test(g.slice(2, 12))) r.warnings.push('Characters 3–12 of a GST TDS registration are usually the TAN');
    else if (entityTan && !entityTan.includes(g.slice(2, 12))) r.warnings.push(`Characters 3–12 (${g.slice(2, 12)}) are not one of the entity's TANs`);
    if (fourteenth !== 'D') r.warnings.push(`A GST TDS registration usually has "D" as the 14th character (this one has "${fourteenth}")`);
  }
  r.pan = g.slice(2, 12);
  return r;
}

function cin(v, { listed, listingType } = {}) {
  const r = result(); const c = norm(v); r.value = c;
  if (!/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(c)) return fail(r, 'CIN must be 21 characters, e.g. U12345GJ2020PTC123456');
  // a company whose only listed securities are debt (NCDs) usually keeps a "U" CIN — warn for listed shares only
  if (listed === true && listingType !== 'debt' && c[0] !== 'L') r.warnings.push('The entity is marked as having listed shares but its CIN starts with "U" (unlisted)');
  if (listed === false && c[0] === 'L') r.warnings.push('The CIN starts with "L" (listed) but the entity is not marked listed');
  return r;
}

function llpin(v) {
  const r = result(); const c = norm(v); r.value = c;
  if (!/^[A-Z]{3}-[0-9]{4}$/.test(c)) return fail(r, 'LLPIN must look like AAA-1234');
  return r;
}

function pfCode(v) {
  const r = result(); const c = norm(v).replace(/[/-]/g, ''); r.value = c;
  if (!/^[A-Z0-9]{5,22}$/.test(c)) return fail(r, 'PF establishment code should be letters and digits');
  if (!/^[A-Z]{5}[0-9]{7,10}$/.test(c)) r.warnings.push('A PF establishment code is usually 2 letters (state) + 3 letters (office) + 7 digits (+3-digit extension)');
  return r;
}

function esicCode(v) {
  const r = result(); const c = norm(v).replace(/[/-]/g, ''); r.value = c;
  if (!/^[0-9]{10,17}$/.test(c)) return fail(r, 'ESIC employer code should be digits');
  if (c.length !== 17) r.warnings.push('An ESIC employer code is usually 17 digits');
  return r;
}

module.exports = { STATES, stateOf, gstinCheckChar, gstin, pan, tan, cin, llpin, pfCode, esicCode, norm, PAN_HOLDER };
