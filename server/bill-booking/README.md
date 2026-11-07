# Bill Collection & Booking

Purchase bills from the finance team's mailboxes and from manual ERP uploads are read, matched and prepared as **draft** bills in Zoho Books. The team reviews each draft and opens or approves it in Zoho. Sidebar: **Purchase & Payables → Bill Collection & Booking**. The page is `client/src/pages/BillBooking.js`, and its tabs live in `client/src/pages/billbooking/`.

## Workflow

Every bill goes through the same steps:

**collect → read → company → vendor → duplicates → category → expense account and GST per line → branch and TDS → category fields → checks → Zoho draft → review tracking**

Each step records its basis on the bill and adds an entry to the bill's audit trail.

| Step | Source of truth | Used without asking only when |
|---|---|---|
| Read | Claude (if `ANTHROPIC_API_KEY` is set), otherwise the PDF text layer or OCR | Claude read it. A built-in reading needs one "details checked" confirmation. |
| Company | Billed-to GSTIN or PAN (GSTINs from Zoho plus Settings), then the name on the bill, then the receiving member | It matches a GSTIN or PAN, or the name. Taking the member's company is flagged. |
| Vendor | Synced `vendors_all` of that company: GSTIN, then PAN, then name | Exactly one active vendor has the GSTIN (or the name is unique with no GSTIN on the bill) |
| Category | Keywords in the bill lines and email, the vendor's earlier categories here, the Zoho vendor category, the member's categories (tie-break only) | The score reaches `category_min_score` and is 1.5 times the next category |
| Account | 1) a confirmed mapping, 2) a similar line among the vendor's last `history_days` of Zoho bills | Similarity is at least `similarity_threshold` and the similar lines agree. The vendor alone never decides. |
| GST tax | A mapping for vendor and account, or the same tax on the vendor's earlier lines of that account | Same rate and the same IGST or CGST+SGST split as the bill |
| Branch / TDS | The same value on all of the vendor's recent bills | The value is consistent; mixed values are left for the reviewer |
| Duplicates | Same file, same vendor and number, already in Zoho (sync data, plus a live check before creating), same date and total | Exact or likely matches are marked Duplicate; possible ones go to the team |

The statuses are Received, Extracted, Needs Input, Ready for Draft, Draft Created, Reviewed, Duplicate, Failed and Not a Bill.

## Zoho draft bills

Zoho's published Bills API documents no draft option; a created bill is normally Open. Zoho support advises sending `is_draft: true`, which this module does. Three safeguards make sure only drafts are created:

1. **Draft test.** In Settings, an administrator runs a draft test. It creates a ₹1 bill, reads its status and deletes it. Drafting stays locked for that organisation until the test passes.
2. **Lock on a non-draft result.** If Zoho ever returns a bill that is not a draft, the bill is flagged "Not a draft in Zoho". Drafting locks again for that organisation and automatic drafts are switched off.
3. **No status changes.** The module never calls `/status/open`, `/submit` or `/approve`.

The module only ever writes three things to Zoho: it creates bills (`POST /bills`), attaches the original file (`POST /bills/{id}/attachment`) and adds a review comment. It deletes a bill only in the draft test, and only the test bill.

## Set-up (server environment: `.env` on the office PC, Vercel environment variables online)

| Variable | For |
|---|---|
| `ANTHROPIC_API_KEY` | Claude reads the bills (strongly recommended). Optional: `BB_CLAUDE_MODEL` (default `claude-opus-5-5`). |
| `BB_MS_CLIENT_ID`, `BB_MS_CLIENT_SECRET` | Microsoft 365 app registration (Azure portal → App registrations). Delegated permissions: `Mail.Read`, `User.Read`, `offline_access`. Redirect URI: the one shown in Settings & Integrations. |
| `BB_MS_TENANT_ID` | The company tenant id. It is required for "company app access" (application permission `Mail.Read` with admin consent; limit it to the finance mailboxes with an Exchange application access policy). |
| `BB_GOOGLE_CLIENT_ID`, `BB_GOOGLE_CLIENT_SECRET` | Only if a mailbox is on Google: OAuth client with the `gmail.readonly` scope |
| `BB_PUBLIC_URL` | Optional: the dashboard's public address, used for the sign-in redirect (otherwise the address in the browser) |
| `BB_TOKEN_KEY` | Optional: 64 hex characters used to encrypt mailbox tokens (otherwise derived from `JWT_SECRET`) |

The Zoho refresh token must include `ZohoBooks.bills.CREATE`. Settings → **Check access** shows whether it does, without creating anything.

## Data

- **Office PC:** `server/bill-booking/data/*.json` and `server/bill-booking/files/<bill id>/`, both git-ignored.
- **Vercel:** Neon `kv_store` (keys `bb_*`) and private Blob storage under `bill-booking/`.
- **Mailbox tokens:** AES-256-GCM in `bb_secrets`. They are never returned by any route or written to logs.
- **Mail access:** read-only. Nothing is moved, marked or sent.
- **Mailbox checks:** every `poll_minutes`, and Zoho draft status every 30 minutes, on the office PC only. On Vercel, use "Check mailboxes now".

## Tests

`npm run test:bill-booking` runs the unit, workflow, mailbox (fake Microsoft Graph) and API tests, with a fake Zoho.
