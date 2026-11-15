# Compliance Vr.2.0 — deployment and runbook

## Office PC

The PC runs the dashboard through the hidden startup supervisor (`SalesDashboard.vbs`).

- **After a change to `server/**`:** stop the `node` process listening on port 3002. The supervisor starts it again within
  about 3 seconds with the new code.
- **After a change to `client/src`:** rebuild with `node "C:\Users\Parthiv Panchal\Desktop\Claude\build2.js"`, then press
  F5 in the browser.
- **Data:** `server/compliance2/data/` (JSON) and `server/compliance2/files/` (encrypted evidence). Both folders are
  git-ignored. Never copy them into the repository: it is public.
- **Malware scan:** Microsoft Defender's `MpCmdRun.exe` is used automatically when it is present. To use ClamAV instead, set
  `C2_CLAMD_HOST`.

## Vercel (online)

1. In Project → Settings → Environment Variables, add `C2_FILE_KEY` (64 hex characters) for Production.
2. Push to `main`. Vercel builds with ESLint switched on, so check first locally with
   `DISABLE_ESLINT_PLUGIN=false node build2.js`.
3. Data is stored in Neon (`kv_store`, keys `c2_*`); files in the private Blob store (`compliance2/<space>/…`).
4. Uploads are limited to 4 MB online (Vercel's request limit). There is no malware scanner online, so uploads are stored
   and shown as **unscanned**. Set `C2_CLAMD_HOST` to a reachable ClamAV service to scan online.
5. **Not yet verified against a real Neon database:** the safe-write functions added to `server/db.js`
   (`readJSONStamped`, `writeJSONManyIfUnchanged`) are tested with a stand-in only. Run the API tests against a real
   PostgreSQL before relying on the online version (see "Testing on PostgreSQL").
6. The PC and Vercel keep separate data, as they do for the rest of the dashboard.

## OneDrive folders (Document Folders tab)

**What your Microsoft 365 administrator does (once):**

1. In Microsoft Entra ID → App registrations → New registration, create an app named, for example, *Finance Dashboard*
   (single tenant). An existing registration made for the reminder emails or Bill Collection can be reused.
2. Add the redirect URI (type *Web*):
   - `http://localhost:3002/api/compliance2/onedrive/callback` for the office PC. Connect from the PC itself, because
     Microsoft accepts http only for localhost.
   - `https://salesreceivables.devx.work/api/compliance2/onedrive/callback` for the online version.
3. API permissions → Microsoft Graph → **Delegated**: `offline_access`, `Files.ReadWrite`, `User.Read`. Grant admin consent if
   the tenant requires it. No application permissions are needed; the app can reach only the signed-in person's own OneDrive.
4. Certificates & secrets → New client secret.
5. Put the Directory (tenant) ID, Application (client) ID and the secret value on the server, never in a chat or an email:
   `C2_MS_TENANT_ID`, `C2_MS_CLIENT_ID` and `C2_MS_CLIENT_SECRET`. They go in `.env` on the PC, or in Vercel → Environment
   Variables. Then restart the PC server or redeploy.

**What you do (once):**

1. Open Document Folders → *Connect OneDrive*, then sign in with the Microsoft account that owns the folder.
2. Paste the folder link → *Use this folder*.
3. Tick the financial years, then click *Create folders now*.

From then on, folders appear by themselves:
- when an entity or registration is saved (or approved, as a setting);
- when a FY is ticked;
- when someone creates a company folder directly in Finance & Compliance (picked up every 15 minutes on the PC).

**Facts worth knowing:**

- **One place only.** Run the folder engine on the PC *or* online, not both. Each keeps its own mapping; both would find
  and reuse the same folders by name, but logs and settings would differ.
- **Revoked sign-in.** A password change, an admin "revoke sessions" or a disconnect stops the engine. Document Folders
  then says so; *Connect OneDrive* again. Nothing is lost.
- **Which folder.** It can't be changed after the first set-up, because the folder ids are mapped. A reset needs a
  developer: clear `live_folders`. Nothing in OneDrive is deleted.
- **Documents.** They are copied to OneDrive *in addition to* the encrypted store, which stays the hash-verified system
  record. Your team opens them in OneDrive, where Microsoft encrypts them at rest.
- **Personal OneDrive or SharePoint.** A personal OneDrive belongs to one person. A SharePoint site owned by the finance
  team is better for company records. The engine needs the shared link plus `Files.ReadWrite.All` or `Sites.Selected`;
  ask before switching.

## Keys

| Key | Purpose |
|---|---|
| `C2_FILE_KEY` | Encrypts evidence files in the live space. Losing it makes the stored files unreadable. Keep two copies outside the server, in a password manager. |
| `JWT_SECRET` | Already used by the dashboard. Also signs download links and derives the demo-only file key. Changing it logs everyone out and makes demo files unreadable; reset the demo afterwards. Live files are not affected. |
| Key rotation | Not built yet. The file format carries a key id, so a later version can add `C2_FILE_KEY_2` and re-encrypt. |

## Backups and restore tests

- **Make a backup:** `node server/compliance2/scripts/backup.js backup "D:\Backups\Compliance"`. It copies every module
  document and every encrypted evidence file, with a SHA-256 manifest. The key is never written into a backup.
- **Restore test (monthly):** `node server/compliance2/scripts/backup.js check "D:\Backups\Compliance\c2-backup-…"`. It
  rebuilds the backup in a temporary folder and checks the hashes, the audit chain and that every file decrypts. It
  prints `RESTORE TEST PASSED` or lists the problems.
- **Restore:** `node server/compliance2/scripts/backup.js restore "<backup>" "<empty folder>"`. Then point `C2_DATA_DIR` and
  `C2_FILES_DIR` at its `data` and `files` folders and restart. The script refuses a folder that already has data.
- **Online:** run the same script on a PC whose `.env` has the production `DATABASE_URL` and a Blob read token. Neon's own
  point-in-time restore also covers the documents.

## Testing

- `npm run test:compliance2`: 54 tests (engine, API end to end, backup / restore, OneDrive folders against a simulated OneDrive).
- **Testing on PostgreSQL:** start a disposable PostgreSQL, then run
  `DATABASE_URL=postgres://… node --test server/compliance2/tests/engine.test.js` and a Neon-mode copy of the API tests.
  `helpers.js` sets the store to file mode; switch it to `useDb: true` for that run. Never point tests at the production
  database.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "The dashboard server is running an older version" | The server was not restarted after the update. |
| Uploads refused with "C2_FILE_KEY is not set" | Add the key to `.env` (PC) or to Vercel, then restart / redeploy. |
| Nothing is generated in live | Coverage shows why. Check that master data is approved, that applicability is decided, and that the rule version is verified **and** approved. |
| A task has no due date | The rule has no due-date rule, the state has no PT / LWF rule (missing-rule queue), the periodicity is missing, or the AGM / notice has not been recorded. |
| "Someone else saved a change at the same moment" | Two people saved at once online. Nothing was lost; press the button again. |
| The audit integrity check reports BROKEN | A stored audit document was changed outside the module. Restore that month from the latest good backup and find out who had file or database access. |
