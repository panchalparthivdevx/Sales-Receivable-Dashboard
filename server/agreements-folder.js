// ─── Client Agreements folder (state / branch / client / PDF files) ─────────────
// Used by index.js (Agreement Master) and upload-to-neon.js, which stores this listing
// for Vercel — the PDFs themselves stay on the office PC / company OneDrive.
const fs   = require('fs');
const path = require('path');

const AGREEMENTS_DIR = path.join(__dirname, '..', 'Client Agreements');

function isAmendmentFile(name) {
  return /amendment|deed|variation|renewal|addendum|\d+(st|nd|rd|th)\s/i.test(name);
}

function scanClientFiles(dir, urlBase) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    const ext  = path.extname(item).toLowerCase();
    if (fs.statSync(full).isDirectory()) {
      files.push(...scanClientFiles(full, `${urlBase}/${encodeURIComponent(item)}`));
    } else if (['.pdf', '.docx', '.doc'].includes(ext)) {
      files.push({
        name: item,
        url:  `/api/agreements/file${urlBase}/${encodeURIComponent(item)}`,
        is_amendment: isAmendmentFile(item),
      });
    }
  }
  return files;
}

function scanAgreementsFolder() {
  const result = {};
  if (!fs.existsSync(AGREEMENTS_DIR)) return result;
  for (const state of fs.readdirSync(AGREEMENTS_DIR)) {
    const statePath = path.join(AGREEMENTS_DIR, state);
    if (!fs.statSync(statePath).isDirectory()) continue;
    for (const branch of fs.readdirSync(statePath)) {
      const branchPath = path.join(statePath, branch);
      if (!fs.statSync(branchPath).isDirectory()) continue;
      if (!result[branch]) result[branch] = { state, clients: {} };
      for (const client of fs.readdirSync(branchPath)) {
        const clientPath = path.join(branchPath, client);
        if (!fs.statSync(clientPath).isDirectory()) continue;
        const urlBase = `/${encodeURIComponent(state)}/${encodeURIComponent(branch)}/${encodeURIComponent(client)}`;
        result[branch].clients[client] = { files: scanClientFiles(clientPath, urlBase) };
      }
    }
  }
  return result;
}

module.exports = { AGREEMENTS_DIR, isAmendmentFile, scanClientFiles, scanAgreementsFolder };
