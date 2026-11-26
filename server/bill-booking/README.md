# Bill Collection & Booking

Purchase bills from the finance team's mailboxes and from manual ERP uploads are read, matched and prepared as **draft** bills in Zoho Books. The team reviews each draft and opens or approves it in Zoho. Sidebar: **Purchase & Payables → Bill Collection & Booking**. The page is `client/src/pages/BillBooking.js`, and its tabs live in `client/src/pages/billbooking/`.

## Workflow

Every bill goes through the same steps:

**collect → read → our own sales invoice? → company → vendor → duplicates → category → expense account and GST per line → branch and TDS → category fields → checks → Zoho draft → review tracking**

Each step records its basis on the bill and adds an entry to the bill's audit trail.

| Step | Source of truth | Used without asking only when |
|---|---|---|
| Read | Claude (if `ANTHROPIC_API_KEY` is set), otherwise the PDF text layer or OCR | Claude read it. A built-in reading needs one "details checked" confirmation. |
| Company | Billed-to GSTIN or PAN (GSTINs from Zoho plus Settings), then the name on the bill, then the receiving member | It matches a GSTIN or PAN, or the name. Taking the member's company is flagged. |
| Vendor | Synced `vendors_all` of that company: GSTIN, then PAN, then name | Exactly one active vendor has the GSTIN (or the name is unique with no GSTIN on the bill) |
| Category | 1) The vendor's similar bill already booked in Zoho: its Zoho "Category" (then "Vendor Category"), translated through each category's "Zoho categories" list. 2) Otherwise keywords in the bill lines and email, the vendor's earlier categories here, the Zoho vendor master category, the member's categories (tie-break only) | 1) The earlier bill is similar (same rule as the account) and its Zoho category is listed under one bill category. 2) The score reaches `category_min_score` and is 1.5 times the next category |
| Account | 1) a confirmed mapping, 2) a similar line among the vendor's last `history_days` of Zoho bills | Similarity is at least `similarity_threshold` and the similar lines agree. The vendor alone never decides. |
| GST tax | A mapping for vendor and account, or the same tax on the vendor's earlier lines of that account | Same rate and the same IGST or CGST+SGST split as the bill |
| Branch / TDS | The same value on all of the vendor's recent bills | The value is consistent; mixed values are left for the reviewer |
| Duplicates | Same file, same vendor and number, already in Zoho (sync data, plus a live check before creating), same date and total | Exact or likely matches are marked Duplicate; possible ones go to the team |

The statuses are Received, Extracted, Needs Input, Ready for Draft, Draft Created, Reviewed, Duplicate, Failed and Not a Bill. The report filters on one or several statuses (chips or the Status list).

## Our own sales invoices

Invoices issued by our own companies to customers (payment reminders from Accounts Receivable, forwarded invoices) are not vendor bills (`lib/ownsale.js`):

- **Not collected:** an email attachment named like one of our sales invoices in Zoho (central sync `invoices_fy`, e.g. `IN26-27GJ2632.pdf`) is listed under Team & Mailboxes → Skipped attachments with the reason.
- **Not a Bill:** a collected document is set aside with the reason when its number is one of our Zoho sales invoices (and the date or total does not contradict it), when the seller block before "Bill To / Buyer …" carries only our company's name and GSTIN, or when the reader found our GSTIN as the supplier. "It is a bill" overrules it.
- An invoice from one of our companies to another (DevX ↔ Neddle) is a purchase bill for the buyer and is collected as usual.
- Zoho's invoice PDFs put the totals first in the text, so the letterhead check looks for our name just above our GSTIN, wherever it sits.
- An invoice raised after the last sync (not in `invoices_fy` yet) is recognised by our numbering series (e.g. `IN/26-27/GJ/…`): a prefix with letters and digits, used at least 20 times. Generic numbering such as `INV-…` never counts.

## Read all again with Claude

Report → **Read all again with Claude** (Configure right, only when `ANTHROPIC_API_KEY` is set) reads again, from the stored files, every open bill that the built-in reader read. It first shows how many bills and a rough cost, then asks to confirm. Bills changed by hand, already read by Claude, set aside (Not a Bill, Duplicate), Zoho drafts and our own sales invoices are kept as they are. Online, the bills go back to Received and are read three at a time, by the request and by the 5-minute scheduler. The action is recorded in the module's audit log.

## Logos, badges, banners and marketing material

Email signatures and newsletters carry pictures that are not bills (`lib/pictures.js`). The picture's size and shape are read from the file header, so it is set aside without reading it (no OCR or Claude time):

- **Ignored at the mailbox** (counted in the mailbox log as "logos / pictures ignored"): pictures under 0.4 megapixels or under 300 pixels on the short side, and banners more than three times wider than high. Inline pictures and pictures under 30 KB were already ignored.
- **Listed under Skipped attachments** ("Read as bill" reads one anyway): pictures inside the email text, which Outlook names `image001.png`, `image002.jpg` … (new Outlook: `Outlook-xxxx.png`), under 1.5 megapixels.
- **Not a Bill after reading:** the same rules for pictures that were collected anyway, and pictures in which OCR found no words. A reading that found a bill heading, invoice number, total or supplier GSTIN always keeps it as a bill.
- **Newsletters / marketing emails** (an unsubscribe, preferences or "view in browser" link in the email text): their attachments are read, and set aside as Not a Bill only when they have no bill heading, invoice number or total.
- "Read again" and "It is a bill" always overrule these rules.

## Category from the vendor's Zoho bills

Zoho bills carry their own "Category" and "Vendor Category" fields. When a bill is similar to one of the vendor's bills in Zoho (the last `history_days`, the same line comparison as for the account), the category it was booked under there decides: each bill category lists the Zoho values that mean it ("Zoho categories" in Categories & Fields; DevX's values are filled in by default, once). The Zoho draft gets the same Zoho "Category" / "Vendor Category" as that similar bill, unless the team chose a different bill category.

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
- **Mailbox checks:** every `poll_minutes`. Zoho draft status is checked every 30 minutes on the office PC; online, use "Refresh Zoho status".
- **Reading online (Vercel):** Vercel ends every request after 300 s, so the work is split up:
  - `/api/cron/bill-booking` runs every 5 minutes (`vercel.json`, Bearer `CRON_SECRET`). It checks the mailboxes once `poll_minutes` have passed, then reads waiting bills until shortly before the limit.
  - "Check mailboxes now" and uploads also read until they answer.
  - Bills are taken one at a time (three at a time with Claude): the fewest tries first, then the oldest. Each is leased so two calls never read the same bill.
  - A bill not finished after 3 tries becomes **Failed** with the reason, so it cannot hold up the others.
  - OCR has a 120 s limit per bill.
  - After reading, the scheduler checks again the bills last checked under older rules (`RULES_V` in `lib/pipeline.js`), without reading them again and keeping the team's choices. The office PC does this when the server starts.

## Tests

`npm run test:bill-booking` runs the unit, workflow, mailbox (fake Microsoft Graph) and API tests, with a fake Zoho.
