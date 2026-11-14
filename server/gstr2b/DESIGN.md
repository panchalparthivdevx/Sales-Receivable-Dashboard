# GSTR-2B Reco — design

Status as of **11 Nov 2026**. Everything here is marked **Verified** (seen live or in an official source, with the date), **Assumed** (a documented working assumption — change it in Settings or tell us), **Implemented** (Phase 1, in this repository, tested) or **Planned** (not built).

---

## 1. What was benchmarked, and how much of it is real

| Product | Verified from its own published page (11 Nov 2026) | Marketing only — not relied on |
|---|---|---|
| **Spectrum Cloud** — Smart Reconciliation | Multi-GSTIN (stated "100+ per entity"), PAN-level aggregation with GSTIN-level visibility; GSTR-2A/2B vs Books; "configurable tolerance levels"; invoice / supplier / HSN / status views; 2A/2B history to track amendments and missing records; Excel/PDF export. | "100% ITC recovery", "Zero Notice Prevention", "3x faster". No matching rules, no named Zoho/Tally integration, no pricing, no IMS, roles or audit trail are described. |
| **gstreconcile.in** | Statuses Matched / Partly matched / Not in 2B / Not in records; invoice-number normalisation (slashes, hyphens, leading zeros); near-match and typo candidates; per-component tax tolerance; same vendor under different GSTINs; duplicate detection in Books; date proximity; GSTIN format check; "ITC at risk"; per-match reason; GSTIN-wise report for vendors; colour-coded Excel with IGST/CGST/SGST/Cess. Upload-only (Excel exports from Tally, Busy, ClearTax or any ERP); free plan 3 reconciliations / month. | "99.99% accuracy", "21-point engine" (never listed), "₹450+ Cr ITC saved". |
| **Zoho Books — native GSTR-2B reconciliation** | Pulls GSTR-2B **directly from the GST portal** after you enable API access on the portal (My Profile → Manage API Access) and approve an OTP; categories Matched / Partially matched / Missing in GSTN / Missing in Zoho Books / Reconciled; actions Accept, Modify and Match, Create and Match; sequential by month (the previous month's GSTR-3B must be filed); regeneration after IMS actions. | Matching criteria and tolerances are **not published**; which transaction types are reconciled is not stated; multi-GSTIN / branch handling is not described. |

**What we copy functionally:** the status vocabulary, per-component tolerance, number normalisation, same-PAN / different-GSTIN detection, duplicate detection, per-match reasons, vendor-wise report, IMS awareness. **What we do not copy:** their interfaces or any (unpublished) matching algorithm — the rules in §6 are our own, deterministic and written down.

**Zoho's native 2B reconciliation is not available through Zoho's public API** (the API v3 reference has no GST-filing / GSTR module). It works through Zoho's own GST-portal connection (OTP), so it cannot be reused here — hence the upload-first design.

---

## 2. Architecture (Implemented)

```
Zoho Books ──GET only──► lib/zohoRead.js ──► lib/booksSync.js ──► lib/canonBooks.js ──► Books documents
                                                                                              │
GST portal JSON / Excel ─► lib/import2b.js ─► lib/statements.js (versions, amendments) ───────┤
                                                                                              ▼
Reviewer decisions (lib/review.js) ─────────────────────────────────────────►  lib/recon.js  (partition by supplier PAN,
                                                                                              only changed partitions re-run)
                                                                                              │  lib/match.js (pure rules)
                                                                                              ▼
                              lib/dash.js (cards, vendors, bridge)  ·  lib/exporter.js (Excel)  ·  index.js (API)  ·  UI (client/src/pages/gstr2b/)
```

* **Isolation.** The module is `server/gstr2b/` plus `client/src/pages/Gstr2bReco.js` and `client/src/pages/gstr2b/`. Shared files touched: `server/index.js` (mount + its own scheduler), `server/auth.js` and `client/.../AdminPage.js` (the permission list), `Sidebar.js`, `App.js`, `.gitignore`, `.vercelignore`, `package.json` (test script). No existing report reads or writes this module's data, and the module never writes to the shared sync engine or its schedule.
* **Read-only Zoho.** `lib/zohoRead.js` exports `get`, `list` and helpers — there is no POST/PUT/DELETE in the file, and a test asserts the exported object has no write method. It never creates bills, posts journals, files returns or sends messages.
* **Storage.** Same two modes as the rest of the app: JSON files on the office PC (`server/gstr2b/data`, atomic writes) or Neon `kv_store` (`g2b_*` keys) on Vercel. Original statement files: `server/gstr2b/files/<sha256>` or private Blob `gstr2b/<sha256>`; never overwritten. **Strict reads online:** `server/db.js` `readJSON` answers its default (always `null`) both for a record that does not exist and for a read that failed (it logs and swallows the error). `lib/store.js` tells the two apart — a missing record is the caller's empty default, and when a read answers nothing it asks `listKeys` (which does not swallow errors) whether the record exists: if it does, the request fails with "could not be read just now — nothing was changed" instead of treating the record as empty and writing a replacement over it.
* **Rights.** `gstr2b` module is *grant-only* (hidden unless ticked, like Bill Collection & Booking). Rights: **Prepare** (sync, upload, run, notes), **Review** (link, approve, exclude, accept/resolve), **Approve / lock** (Phase 2), **Configure** (companies, GSTINs, tolerances, schedule). Admin may also limit a user to particular companies / GSTINs.
* **Assignments** (`lib/tasks.js` — one definition for the filters, the cards, the lists and the reminders). A row's owner is a dashboard user who can open the module: `review.meta` keeps the name **and the user id** (`owner`, `owner_id`), plus who gave the row and when (`assigned_by`, `assigned_at`). A name typed before ids were kept is matched without regard to capitals; a name that belongs to nobody stays a name. **Open** = status mismatched / suggested / Books only / GSTR-2B only **and** workflow not *accepted* / *resolved*; **overdue** = open with a due date before today (India time) — so a row that became matched is neither open nor overdue. `GET /meta` gives every module user `people` (id and name only; the full user list stays admin-only). Filters: `owner` = `__me__` · `__none__` · `id:<user id>` · a name; `open=1`; `due` = `overdue` · `today` · `week` · `set` · `none`; `sort=due` (rows without a date last). `summary.tasks` = { mine, all } × { open, overdue, today }. Each list row carries `open`, `due_state`, `due_days`.
* **Email reminders** (`lib/reminders.js`, `lib/reminderMail.js`, `lib/mailer.js`) — the only thing the module sends, and only to its own users. Settings in `config.reminders` (off by default): time and weekdays in India time, "due within N days", undated rows weekly / daily / never, email on assignment, a managers' summary list, **addresses per user id** (the dashboard's user records have no email field) and the dashboard's address for the button. `reminders.tick()` is called from the scheduler's 15-minute call online (`router.cronTick`, before the sync step, capped at 40 s) and every 5 minutes from the PC timer; it does nothing until the time of day has come and today's emails have not gone out. One email per owner per day: overdue, due today, due soon, newly assigned since that person's last email, and — on the weekly day — undated rows. **Never emailed:** rows that are not open, the demo company, a GSTIN the owner's access does not include; every owner who cannot be emailed (not a user, no address, no access) is reported on the settings page instead. State `reminders`: per day and owner `sent` / `failed` with attempts (a failure is retried at the next call, three times a day), a refusal by the mailbox itself (sign-in, permission, no such mailbox) recorded once for the day rather than against each person, a log of the last 300 emails, and a short lease — online the caller whose mark is still there after 300 ms goes on, so two instances called in the same minute send one email, not two. On assignment `POST /recon/assign` starts `notifyAssigned` in the background (`waitUntil` online) for rows whose owner changed to somebody else. Everything from Zoho or typed by a person is escaped in the HTML. **Sending:** Microsoft Graph `POST /users/{mailbox}/sendMail` with the company's app registration (client credentials; env `MAIL_FROM`, `MAIL_MS_TENANT_ID`, `MAIL_MS_CLIENT_ID`, `MAIL_MS_CLIENT_SECRET`, falling back to Bill Collection's `BB_MS_*`); credentials are read from the environment only, never stored and never returned by the API. SMTP was not used: Microsoft switches basic-authentication SMTP off by default from December 2026, and Vercel recommends an HTTP sender over SMTP.
* **Scheduler (office PC).** Own timer, default **13:20, 15:20, 18:20, 21:20 IST** — the hours requested, 20 minutes past so it never collides with the shared sync at :00 or the Neddle MSME sync at :10. The first run of each IST day is a re-check (deleted documents, totals against Zoho, failed documents retried). Online the timer is Vercel's scheduler — next point.
* **Automatic sync online.** `vercel.json` puts two routes on Vercel's scheduler: `GET /api/cron/gstr2b` at minutes **7, 22, 37, 52 of every hour, every day** (15 minutes apart; the same minutes in IST; chosen to miss the dashboard's :00 / :10 / :20 / :30 syncs) and `GET /api/cron/gstr2b-recheck` at **19:30 UTC = 1:00 AM IST**. Both are behind `cronAuth` (Bearer `CRON_SECRET`, which Vercel's scheduler sends) and in `PUBLIC_API`, like the other cron routes. Sub-daily cron expressions need the **Vercel Pro plan** — on Hobby the deployment is refused. `lib/config.js ONLINE_SCHEDULE` holds the same minutes for the page, and a test keeps it and `vercel.json` in step.
  * **Why not GitHub's schedule:** it was the first design (583d9bd). On this repository GitHub registered the 15-minute workflow and then did not start it once in 4.5 hours (12 Nov 2026), and it runs the older `scheduled-sync.yml` about 4 of 10 times a day, hours late. `push` and `workflow_dispatch` triggers do start at once, so `.github/workflows/gstr2b-sync.yml` is now only the job that **carries a long sync through in the background**: after every push to main — it first waits until Vercel has marked the pushed commit as deployed (GitHub commit status), and **fails with that message, without calling the old version, if Vercel could not deploy it** — and on *Run workflow*, it calls `/api/cron/gstr2b?src=github` again and again while the answer says `"more":true` (up to 90 steps); GitHub's own schedule is kept as one extra call an hour, a second line only. A 401 fails the job loudly (wrong secret); other HTTP problems are retried up to four times with a growing wait.
  * **One tick** (`router.cronTick`) visits each active, non-demo company with a GSTIN switched on and asks the engine what is due (`sync.due`, one small read, no Zoho call): nothing before a first sync has been started on the page; the rest of an **unfinished listing** (a first sync or re-check cut short) first; otherwise the change feed, or a re-check when the route says so or when a first sync has just completed and has not been compared with Zoho yet. One step is at most 170 s (shared between companies). It reconciles when documents changed and the work is done (`recon_due` in the sync state is cleared only after the reconciliation ran, so an attempt cut off by the platform is made again). It answers `{ ok, mode, more, results }`; `more` is true only for a step that was cut short **and got somewhere** — never for a step that is stuck or paused for the day.
  * **The scheduler is shown as observed, not as configured.** Every call writes a small record (`auto`: when, by whom — "Vercel's scheduler" by its user agent, "the GitHub job" by `?src=github` — and what it did), also when a sync was already running. `GET /sync/status` returns `auto` = last call, the next due time and `overdue` (no call for more than 2 intervals + 5 minutes); the card says "not seen yet" or shows a red notice when calls stop. A run started by the scheduler or by an opened page that found nothing is kept out of `runs` and the audit trail (one every 15 minutes would bury them); `last_auto` records it.
  * **While the module is open** the page calls `POST /sync/kick` on load and every 4 minutes (any module user): if a first sync has been started and something is due — an unfinished listing, documents waiting, or no change check for 10 minutes — one step runs (awaited online, in the background on the PC). So the data catches up whenever the module is in use, whatever the schedulers do.
  * Real-time (webhooks created by a Zoho admin) is not built.
* **Scope — what a sync spends calls on.** Zoho's list has no GST amounts, so a sync costs one call per document. Two rules keep it to what can be reconciled now (`canonBooks.scopeExclusion`, applied at list time and, for documents already stored, by `booksStore.applyScope` — no Zoho call): (1) **`gstin_off`** — the document's recipient GSTIN is switched off (the *Active* box per GSTIN in Settings → Companies & GSTINs; reconciliation already honoured it, the sync did not; no GSTIN set up yet = no restriction); (2) **`outside_period`** — the document is dated before the first month synced (`synced_from`: the earliest period ever asked for, derived from the listed months for older states) — mostly vendor credits, whose list is read in full and reaches back years, and old documents the change feed reports as edited. Both reasons are "kept out", not lost: switching a GSTIN on or syncing an earlier period brings the documents back (a signature of the active GSTINs and first month, `scope_sig` in the sync state, triggers `applyScope` at the start of the amounts step), and documents that already have amounts are never touched. A re-check without months re-reads from `synced_from`. Measured live on 12 Nov 2026 (DevX, Sep–Nov 2026): all 8 GSTINs + all vendor credits ≈ 1,840 calls; Rajasthan only ≈ 124 calls (1.5 min).
* **Speed and limits.** Zoho reports the organisation's allowance in every answer (`x-rate-limit-limit` / `-remaining` / `-reset` for the day, `x-user-access-limit` / `-remaining` for the minute, `x-user-concurrency-limit`); read live for DevX on 12 Nov 2026: **90,000 calls a day for all integrations together, reset at midnight IST; 150 a minute and 20 at once per Zoho user**. `zohoRead.usage(org)` keeps the latest reading per organisation. The engine's limits (`config.sync`, Settings → Schedule & sync limits): `rate_per_min` **90** (10–120) — calls take turns in one queue (`booksSync.limiter`), turns are 60 / rate seconds apart however many workers wait; `concurrency` **4** (1–6) workers fetch amounts, so the rate holds whether Zoho answers in 0.2 s or 2 s; `daily_budget` **30,000** (100–80,000) for this module; `zoho_reserve` **15,000** — the run also stops for the day when Zoho's own count for the organisation falls to this (the other integrations cannot be starved by a long sync). "Too many requests" (429) holds every worker for as long as Zoho asks, then the call is retried; 5xx and network errors are retried twice with a growing wait; the daily-limit answer (code 45) ends the run as paused. Amounts are saved in batches (50 documents or 15 s). The first version had a "pause between calls (ms)" instead — lower meant faster, and online the run history showed exactly one call every 6 s (30 calls per 3-minute step), i.e. a pause of about 6000; stored limits of that shape are dropped by `config.syncLimits()` and the new defaults apply.
* **Steps, passes and what is resumable (online and PC).** A Vercel function may run 300 s, so a request runs **one step** (`sync.slice_seconds`, at most 180 s) and ends cleanly as `partial`; whoever asked — the scheduler, the GitHub job, the page — asks again. Two things make that cheap: (1) a **listing pass** (`state.pass`: mode, period, when it started) remembers which months it has listed, and the same request arriving again while its work is unfinished continues it — the months already listed in this pass are not listed again, so a step spends its calls on amounts (the earlier rule re-listed the two newest months and all vendor credits in every step: 12 of each step's calls); a period whose work is finished, a different period, or a pass left for 12 hours starts a new pass; (2) the detail queue is the stored documents that still say `detail_pending`. **Every listing is complete or says it is not** (`booksSync.listAll`): rows are sorted by created time and keyed by Zoho id, Zoho's own count is asked for whenever a listing took more than one page (always in a re-check), and while documents are missing the list is read again in the opposite order — see the paging row in §4.1. A list that stays short is flagged (`windows[…].complete = false`, a warning on the run, `verify.counts_ok = false`): nothing is deleted on its word, and a change check that came up short does not move its checkpoint. The change-feed starting point is fixed at the first listing, moves only after every page of a feed has been saved, and each feed re-reads 15 minutes before it (documents are keyed by Zoho id, so the overlap cannot duplicate one). A **lease** (`run_id`, by, expiry = step deadline + 90 s) in the stored state stops an overlapping run on another serverless instance; it is online-only and expires by itself. A run takes its place in the process before anything is awaited, so two requests in the same instant cannot both start.
* **First sync status** (`state.initial`, shown on the card): *not started* → *in progress* (listing, then amounts with a percentage) → *completed* / *completed — some documents could not be read* / *failed*. It is complete only when every month has been listed **and** every document that can be matched has its amounts; a document whose amounts could not be read three times is counted as failed, listed with Zoho's answer, retried once every night and by "Try these again", and is never shown as merely pending in between. A state written by the previous version is adopted as it stands (the months it listed, its change-feed start).
* **Checked against Zoho** (`state.verify`, written by every re-check pass): for each kind, the documents Zoho lists for the synced months and their total (net of TDS, as the list shows it); how many are not kept (expenses without GST), kept out of matching, still waiting, and with amounts — and for those, whether the total read from the document equals Zoho's list total. Differences are counted and listed, and the documents are re-read at the next sync (the change feed cannot see a change that did not move `last_modified_time`).

### Storage keys
| Key | Content |
|---|---|
| `config` | companies → registrations (GSTIN, branch ids, GSTR-9 filing dates, verification), tolerances, schedule, sync limits, per-user access, email-reminder settings and addresses |
| `sync_<co>` | change-feed high-water marks, month-listing log, the current listing pass, the first-sync record, counts, the check against Zoho, Zoho's last allowance reading, the daily Zoho-call budget, the lease, `recon_due`, last 30 runs |
| `auto` | the scheduler's last call (when, by whom, what it did) |
| `books_<co>_<YYYY_MM>` + `books_idx_<co>` | Books documents by posting month; id → month index (a document whose posting date is edited moves) |
| `stmt_idx`, `stmt_<id>` | statement metadata (version, current flag, sha256, control totals) and its documents / row problems |
| `recon_<co>_<gstin>` | latest reconciliation: rows, partition hashes, summary, what changed since the previous run, stale links |
| `review_<co>` | manual links, "not a match" blocks, exclusions, owner (name and user id) / workflow / next action / due date, who assigned and when, notes, history |
| `reminders` | per day: which owner was emailed (sent / failed, attempts, address, counts), the summary, a mailbox refusal; the last 300 emails; the sender's lease |
| `audit_<YYYY_MM>`, `audit_tail` | append-only, hash-chained audit trail |

---

## 3. Data model (Implemented)

**Amounts are integer paise** end to end (`lib/money.js` parses decimal text exactly; `118.75 + 118.76` is `237.51`). Originals are kept next to normalised values.

**Books document** — `id zb:<org>:<kind>:<zoho id>`, kind `bill | vendor_credit | expense`, `doc_type INV | CRN | DBN`, recipient (branch → GSTIN), supplier (vendor id, name, GSTIN, validity, PAN, vendor-master GSTIN), `doc_no` + `doc_no_norm` + `doc_no_core`, **separate dates** (`doc_date` = supplier invoice date, `date_assumed`, `posting_date`, `accounting_period`), `amounts {taxable, igst, cgst, sgst, cess}`, `invoice_value`, RCM flag and RCM tax, place of supply, lines (account, HSN, rate, per-line components, Zoho ITC-eligibility value, project), payments, balance, TDS, Zoho total (net of TDS — **never** used as invoice value), `source.lmt`, data-quality notes, revisions (last 10), exclusion reason, tombstone flag.

**GSTR-2B document** — section, `src_id` (statement + row), supplier (GSTIN, trade name, PAN, **supplier filing period / date as stated on 2B**), doc type, numbers, dates, `period` (GSTR-2B period), amendment link (`orig`, `lineage`), amounts, rate lines, `itc_available` (Y/N) + reason code, RCM, place of supply, IRN, issues.

**Reconciliation row** — `status` (one of seven), `rule`, `identity` (R1/R2 for tolerance matches), `books_ids`, `portal_ids`, `flags[]`, `diffs` per component (GSTR-2B − Books), `tolerance_p` applied, `candidates[]`, `explain[]`, `decision {mode auto|manual, by, at, reason, approved_from}`, `periods {record, books, portal, invoice}`.

**Four separate "periods" and four separate "states":** invoice date · accounting (posting) month · GSTR-2B period · ITC claim period (Phase 2) — and reconciliation status · ITC eligibility · claim status · workflow status. Phase 1 stores the first three periods and reconciliation + workflow; eligibility and claim are Phase 2 and are deliberately **not** inferred from "matched".

---

## 4. Verified API capability matrix

### 4.1 Zoho Books — verified live, read-only, **11 Nov 2026**, DevX (`60027116474`) and Neddle (`60007894213`)

| Need | Endpoint | Fields found | Result |
|---|---|---|---|
| Organisations | `GET /organizations/{id}` | `is_registered_for_gst`, fiscal year; **no GSTIN at organisation level** | Verified |
| **Recipient GSTIN per branch** | `GET /branches` (= `/locations`, same ids) | `tax_reg_no` (GSTIN), `tax_registration_id`, `address.state_code`, `is_branch_active`. **DevX: 46 branches → 8 distinct GSTINs** (GJ ×2 registrations, MH, KA, TS, RJ, UP, MP); 38 active. **Neddle: 2 branches → 2 GSTINs** (MH, GJ). | Verified |
| Bills — list | `GET /bills` | id, vendor, `gst_no`, `gst_treatment`, status, `bill_number`, `date`, `total` (**net of TDS**), `tds_total`, `balance`, `branch_id`, `last_modified_time`, custom fields incl. supplier invoice date. **No tax amounts** | Verified |
| Bills — detail | `GET /bills/{id}` | `sub_total`, `tax_total`, `taxes[]` (`"SGST9 (9%)"`, `"CGST9 (9%)"`, `"IGST18 (18%)"`), `line_items[]` (`item_total`, `tax_*`, `hsn_or_sac`, `itc_eligibility`, `line_item_taxes[]`, `reverse_charge_tax_*`, `project_*`), `is_reverse_charge_applied`, `source_of_supply` / `destination_of_supply` (2-letter state), `adjustment`, `tds_amount`, `payments[]`, `vendor_credits_applied`, `custom_field_hash`, `gst_return_details` (**empty** on every sample — Zoho is not tracking GST filing here) | Verified |
| Change filter | `GET /bills?last_modified_time=<ts>` (also `/vendorcredits`, `/expenses`) | returned 4 rows vs 200 unfiltered — **honoured**; works on all three lists. `<ts>` must be ISO 8601 with an offset (`2026-11-12T05:39:07+0000`); Zoho refuses `YYYY-MM-DD HH:MM:SS` | Verified (11 and 12 Nov 2026) |
| Sorting by last modified | `sort_column=last_modified_time` | **accepted** by `/bills` and `/vendorcredits`, **refused by `/expenses`** (HTTP 400, code 2, "Invalid value passed for sort_column"; `created_time` and `date` are accepted). The change feed therefore **filters** by `last_modified_time` and never sorts by it — it was first built sorted, passed every test against a fake that accepted any column, and failed on the first real "Sync changes now" after a first sync | Verified live 12 Nov 2026; the test double now refuses the same requests |
| Vendor credits | `GET /vendorcredits/{id}` | `taxes[]`, line taxes, `gst_no`, `bill_id` / `bill_number` link, `bills_credited[]`, `reason_for_debit_note`; list rows carry **no** GSTIN | Verified |
| GST-bearing expenses | `GET /expenses`, `/expenses/{id}` | list has `total` and `total_without_tax` (tax = difference); detail has `gst_no`, `taxes[]`, `itc_eligibility`. **21 of 2,400 expenses this FY carry GST**; no vendor id on the sample | Verified |
| Vendor master | central `vendors_all` | `gst_no`, `pan_no`, `gst_treatment`, `place_of_contact` | Verified (existing sync data) |
| Payments / allocations | inside bill detail `payments[]` (date, amount, status) | enough for the Phase 2 180-day review | Verified |
| Deleted records | `GET /bills/{id}` → 404 / code 1002 | same technique as the existing sync engine | Verified (existing engine) |
| **API allowance** | response headers of any call | `x-rate-limit-limit: 90000`, `-remaining`, `-reset` (seconds; lands on midnight IST), `x-user-access-limit: 150` / `-remaining` (a per-minute bucket per Zoho user that refills continuously: it stayed at 142–149 of 150 at 90 calls a minute), `x-user-concurrency-limit: 20` | Verified live 12 Nov 2026 (DevX); list answers ≈ 0.5 s, detail answers ≈ 0.2 s from the office PC |
| **A list's count** | any list with `response_option=2` | answers `page_context.total` and no rows; honours the date range and the `last_modified_time` filter (bills 7,100, expenses 3,216, vendor credits 522 on 13 Nov 2026 — each equal to the rows the list returns) | Verified live 13 Nov 2026 |
| **Paging** | lists sorted by `date` vs `created_time` | **Sorted by `date`, the vendor-credit list returned 522 rows but only 519 different documents — three twice, three never — on every reading**, while sorted by `created_time` (either order) all 522 came back (a month of bills, 746, was complete either way). Rows that sort alike can change places across a page boundary. All three lists accept `sort_column=created_time`, also together with the `last_modified_time` filter | Verified live 13 Nov 2026; the engine lists by created time and checks every multi-page listing against the count |
| Manual journals, opening ITC balances | — | not read | **Not verified — supplemental import (Phase 2)** |

**Documented but not used:** `bills.yml` OpenAPI file (line-item field list matched what was found live).

### 4.2 GST portal formats

| Item | Source | Status |
|---|---|---|
| Table names: B2B, B2BA, B2B-CDNR, B2B-CDNRA, ISD, ISDA, IMPG (+ amendments), IMPGSEZ (+ amendments), ECO, ECOA, ITC REVERSED (Rule 37A), B2B DNR/DNRA (Rule 37A) | GSTN's own GSTR-2B user manual, tutorial.gst.gov.in | **Verified** |
| Summary parts: ITC available, ITC not available, ITC reversal, **ITC rejected** (IMS) | same manual | **Verified** |
| Excel download = summary + all tables; JSON download for the Offline Matching Tool; tables not shown online above 1,000 documents | same manual | **Verified** |
| JSON key layout (`data.docdata.b2b[].inv[].items[]`, `oinum`/`oidt` on amendments, `cpsumm`, `itcsumm`, `chksum`) | third-party rendering of the GSTN API (Vayana docs) — **GSTN publishes no public JSON schema** | **Partly verified** — parser accepts invoice-level or item-level amounts, finds the data root itself, lists anything it does not recognise |
| Excel sheet / column layout | manual names the tables, not the columns | **Not verified against a real file** — parser reads by header text; shows exactly what it read and refuses to half-import a sheet |
| IMS rules (accept / reject / pending, deemed acceptance, recompute until GSTR-3B is filed, sequential 2B) | GST portal advisory "Invoice Management System" | **Verified**; IMS **status** is Phase 3 |

### 4.3 Direct GSTN access — **blocked on a provider** (Phase 3)
Needs an authorised **GSP/ASP** subscription (or GSTN-registered API access), per-GSTIN API enablement on the portal, and an OTP session per login. Not assumed; nothing in Phase 1 depends on it.

**Looked into on 14 Nov 2026 (nothing built; sources are GSTN's advisory of 17 Jul 2025 and providers' own pages — GSTN's developer portal could not be read):** GSTN gives API access only to licensed GSPs, so "fetch GSTR-2B in one click" needs a GSP subscription. Per GSTIN, on gst.gov.in: *My Profile → Manage API Access → Enable API Request = Yes*, the provider's **GSP and ASP names** (the explicit pair is a 2026 change) and a duration of up to **30 days**. A session starts with an **OTP to the authorised signatory's registered mobile / email**, lasts 6 hours and can be renewed up to that duration — so about one OTP per GSTIN per month cannot be avoided. The call needs the GSTIN and the portal **user name** (never the password). The answer has the layout `lib/import2b.js` was written against (`data.data`: `gstin`, `rtnprd`, `gendt`, `itcsumm`, `cpsumm`, `docdata`), so a fetch would go through the same import, preview and versioning as an upload. Pricing is by quote everywhere; a provider that insists on a fixed IP address would cost USD 100 a month on Vercel (Static IPs). Open with each provider: own-GSTIN use without registering as an ASP (one provider's published terms require an ISO 27001 audit), price, fixed IP, the GSP / ASP names, time to go live.

### 4.4 Email — Microsoft 365 (Microsoft Graph)

| Capability | Call | Status |
|---|---|---|
| Sign in as the app | `POST login.microsoftonline.com/{tenant}/oauth2/v2.0/token` (`grant_type=client_credentials`, `scope=https://graph.microsoft.com/.default`) | **Documented by Microsoft — not yet run against the real service** (no app registration exists yet) |
| Send from one mailbox | `POST graph.microsoft.com/v1.0/users/{mailbox}/sendMail` — `message` (subject, HTML body, recipients), `saveToSentItems: true`; answers 202 | **Documented — not yet run.** Needs the application permission `Mail.Send`; limited to the sender mailbox with Exchange Online "RBAC for Applications" (role *Application Mail.Send* with a management scope) |
| Refusals | 403 `ErrorAccessDenied` (no right for that mailbox), 404 (`MAIL_FROM` is not a mailbox), 429 / 5xx (wait `Retry-After`, twice), 401 (sign in again once) | Handled and tested against a stand-in; messages are in plain words |
| The company's mail system | Microsoft 365, domain `devx.work` | **Verified** 14 Nov 2026 (the signed-in Microsoft 365 profile) |
| Basic-authentication SMTP | switched off by default from December 2026 (Microsoft message centre MC786329, updated 27 Jan 2026) | Not used |

---

## 5. Source-to-field mapping (Implemented)

| Canonical | Zoho bill | Zoho credit | Zoho expense | GSTR-2B JSON |
|---|---|---|---|---|
| recipient GSTIN | `branch_id` → `/branches[].tax_reg_no` | same | same | file `gstin` |
| supplier GSTIN | `gst_no` on the bill | `gst_no` (detail) | `gst_no` (detail) | `ctin` |
| document no. | `bill_number` | `vendor_credit_number` (or `reference_number` — setting) | `reference_number` | `inum` / `ntnum` / `docnum` |
| document date | custom field (DevX `cf_vendor_bill_date`); else posting date, **flagged assumed** | custom field (setting) else posting date | expense date, **always assumed** | `dt` / `docdt` |
| taxable value | `sub_total` − bill-level discount | same | `sub_total` | `txval` (or Σ `items[]`) |
| IGST / CGST / SGST / cess | `taxes[]` by name (`IGST*`, `CGST*`, `SGST*`/`UTGST*`, `*CESS*`); fallback `line_item_taxes[]` | same | same | `igst` `cgst` `sgst` `cess` |
| reverse charge | `is_reverse_charge_applied`; tax from line `reverse_charge_tax_amount` (split by tax name) | same | same | `rev` |
| invoice value | taxable + tax **charged** + adjustment (never `total`) | same | — | `val` |
| doc type | INV | CRN | INV | `typ` C/D for notes |
| amendment | — | — | — | `oinum`/`oidt`, `ontnum`/`ontdt` |

Control checks recorded per document (never silently corrected): `sub_total − discount + tax + adjustment − TDS = Zoho total`; bill taxes vs line taxes; sub-total vs lines; IGST on an intra-state supply or CGST/SGST on an inter-state one; unknown tax names.

---

## 6. Matching rules and proposed tolerances (Implemented)

Run **inside one recipient GSTIN**, partitioned by supplier PAN; every document is consumed once; Books and GSTR-2B documents of different GSTINs or companies are never matched.

| Rule | Condition | Result |
|---|---|---|
| **MANUAL** | a reviewer's link (honoured first; may join different suppliers) | Exact / tolerance / Mismatched by the same arithmetic; decision and reviewer recorded |
| **R1** | same supplier GSTIN + type + document no. (exact text) + date, one-to-one | Exact matched, or R3 / Mismatched by amounts |
| **R2** | same, number normalised for **case, spaces, punctuation only** (leading zeros **kept**) | same; **collisions** (two raw numbers → one key) and duplicates are not matched, flagged |
| **R3** | R1/R2 identity, every component within its own tolerance | Matched within approved tolerance |
| **R4** | fuzzy number (≤ 2 characters, ≥ 4 long, or equal ignoring leading zeros), date within 7 days, amounts equal / within tolerance — unique best only | **Suggested — review required** (never automatic) |
| **R5** | cross-period (reported before / > 1 month after the invoice month, or across financial years) | flags `cross_period`, `late_reporting`, `cross_fy` on any matched row |
| **R6** | split / consolidated: ≤ 4 documents add up to one (each component within tolerance), dates within 5 days, **exactly one** explanation | **Suggested — review required**, flag `grouped` |
| **X1** | other GSTIN of the **same PAN**, or a GSTIN 1–2 characters off, with identical number, date and amounts | Suggested, flag `wrong_supplier_gstin` |
| (investigation) | same supplier / number / date / amounts is Books-only under one GSTIN and GSTR-2B-only under another | flag `wrong_recipient_gstin` on both — **nothing linked** |

**Tolerances (configurable, bounded):** ₹1.00 each for taxable value, IGST, CGST, SGST/UTGST, cess; each checked on its own. Equal totals with a different mix (IGST vs CGST+SGST) is **Mismatched** + `tax_type_mismatch`. A Books document whose date is only the posting date (`date_assumed`) is never auto-matched on number alone. Credit and debit notes match only their own type.

**Primary status (mutually exclusive):** Exact matched · Matched within approved tolerance · Suggested match — review required · Mismatched · Books only · GSTR-2B only · Excluded (with reason).
**Flags (overlays, never summed):** duplicate suspected / possible · invalid GSTIN · wrong supplier / recipient GSTIN · cross-period / late / cross-FY · amendment · credit / debit note · reverse charge · unsupported / incomplete data · ITC not available per portal · date assumed · ambiguous · normalisation collision · zero tax · changed in Zoho not refreshed.

**Real-data observations that shaped the rules** (DevX FY 2026-27 to 10 Nov, from the synced bills): 4,722 of 7,058 bills carry a supplier GSTIN; **99% of those have the supplier invoice date** in a custom field; the posting date differs from it for 21% (958 in a different month); **60% have TDS** (so `total` can never be the invoice value); **2,051 invoice numbers contain leading zeros** after a prefix (hence R4, not auto-stripping); 3 exact-duplicate groups and 2 normalisation collisions; every GSTIN present is format-valid, **2 fail the check digit** (one is a letter "I" for a "1") and **18 of 1,733** vendor-master GSTINs fail it.

---

## 7. Dashboard figures — definitions

Defined in `lib/dash.js` (`DEFINITIONS`) and shown on the card hover and in the Excel summary. Books GST and GSTR-2B GST are IGST+CGST+SGST+cess of matchable documents (credit notes negative; excluded documents shown apart). **Matched** = Exact + Within tolerance only. **Document rate (Books)** = matched Books documents ÷ matchable Books documents; **tax rate** likewise on GST; **document rate (GSTR-2B)** = matched ÷ matchable GSTR-2B documents. **Potential credit exposure** = Books-only GST (not credit notes, not reverse charge, not zero-tax) split into *time-barred* (past the Section 16(4) deadline), *closing soon* (default ≤ 60 days) and *open*; plus the shortfall where 2B shows less GST on mismatched documents. It is **unresolved, not lost.** The **bridge** ties Books − GSTR-2B to the sum of the status differences **per component**, and the screen turns red if it ever does not.

---

## 8. Screens

| Screen | Phase 1 |
|---|---|
| Overview | cards (including *Assigned to me* and *Overdue follow-ups*, which open the rows they count), deadline notice, status table, deadline table, bridge, exclusions, "how calculated" |
| Reconciliation workbench | Books and GSTR-2B side by side, components, differences, rule, flags, source links, owner / workflow / next action / due date (owner and "overdue" also under the status, at the left edge); filters incl. **My rows**, Owner, Due date, Open / closed; sort by due date; saved filters; bulk assign (owner from the list of people) / approve / reject; manual link / unlink; row drawer with full explanation, candidates, who assigned and when, notes, history |
| Books only · GSTR-2B only · Mismatch & duplicate review | the same workbench pre-filtered |
| Vendor summary | open items, recurrence, delay, filing status ("Unknown" unless 2B states it) |
| ITC register | **Phase 2** screen with the verified rules |
| Imports & sync | Zoho sync controls and status; upload → preview → import; statements, versions, original file, version diff |
| Settings & audit | companies / GSTIN / branch onboarding with verification; tolerances; schedule and limits; **email reminders** (whether email can be sent, time and days, people's addresses, who cannot be emailed and why, test email, preview, send now, the emails sent); access; coverage matrix; rules and sources; audit trail with chain check; demo data |

---

## 9. Legal rules (data, effective-dated; verified against the CBIC tax repository and GST portal, 11 Nov 2026)

* **Section 16(4)** — ITC cannot be claimed after the **earlier of 30 November following the financial year and the GSTR-9 filing date** (Finance Act 2022 s.100, w.e.f. 1 Oct 2022). *Used in Phase 1.*
* **Section 16(2)(aa) and (ba)** — supplier must have reported the invoice and it must have been communicated in GSTR-2B (aa: Finance Act 2021, 1 Jan 2022; ba: Finance Act 2022, 1 Oct 2022). *Why Books-only GST cannot be claimed until it appears in 2B.*
* **Section 16(2) second proviso + Rule 37** — 180 days from the **supplier's invoice date**; proportionate reversal with interest; reclaim on payment; not for reverse charge (Rule 37 as substituted w.e.f. 1 Oct 2022). *Phase 2.*
* **Rule 37A** — supplier has not filed GSTR-3B by 30 Sept following the year: reverse by 30 Nov, reclaim when they file (Notification 12/2024-CT, 10 Jul 2024). *Phase 2.*
* **IMS / GSTR-2B** — accepted / deemed accepted → "ITC available"; rejected → "ITC rejected", not in GSTR-3B; recompute until GSTR-3B is filed; sequential generation. *Phase 3 display.*
* **Recommended, not notified — never applied:** easing of s.17(5) (outdoor catering, health and life insurance, telecom towers, pipelines, free samples, expired goods) and new electronic RCM / credit-reversal statements and an ITC-alignment mechanism proposed from April 2027 (57th GST Council, PIB 9 Oct 2026).

> **Timing that matters now:** FY 2025-26 invoices can be claimed only in a return **filed by 30 Nov 2026** (earlier if GSTR-9 for 2025-26 is filed first). The Overview shows how much Books-only GST from that year is still not in GSTR-2B. This is a reading of the statute, not legal advice — confirm with your tax advisor.

> **Observation for the existing 180-day dashboard (not changed):** it counts the 180 days from the Zoho *posting date*; Rule 37 counts from the *supplier's invoice date* (a different date for 21% of bills). Worth a review.

---

## 10. Dependencies and genuine blockers

| # | Item | Blocks | Status |
|---|---|---|---|
| 1 | **Real GSTR-2B files from the portal** to lock the file mappings. **Excel: verified 12 Nov 2026** on a real September 2026 workbook (B2B read in full; tax totals tie to the portal's summary sheet; the other sheets were empty, so their headings are verified and their rows only against invented rows — `tests/portal_excel.test.js`). Still wanted: **one real JSON** (third-party-documented layout only) and **one Excel month with credit notes and amendments** | confidence in the importer, not the build | **Needed from you** — upload in Imports → Preview (nothing is imported until you confirm) |
| 2 | Choose where the module is the system of record: office PC or Vercel (they hold separate data; Vercel accepts uploads up to 4 MB and syncs in steps) | where finance works | **Decision for you** — both are built and tested (Vercel against an in-memory stand-in for Neon and Blob; the sync engine also live against Zoho from the PC). Online: Vercel's scheduler every 15 minutes (needs the Pro plan). Office PC: 4 times a day and larger files. Do not mix: statements and review decisions made in one are not in the other |
| 3 | Zoho calls: one per document that can be matched (DevX: about 600 a month, about 4,900 for April–November 2026) | speed of a first sync | About 90 documents a minute by default (Zoho allows the user 150 calls a minute): a month in about 7 minutes, April–November in under an hour. Daily limits: 30,000 for this module and a reserve of 15,000 of the organisation's 90,000 for the other integrations — both configurable |
| 4 | A dedicated read-only Zoho refresh token (scopes in `zohoRead.js`) | least privilege (the module only reads either way) | Optional — recommended |
| 5 | GSP / ASP subscription, per-GSTIN API enablement, OTP workflow | Phase 3 direct GSTN / IMS | Not assumed; not needed for Phase 1–2 |
| 6 | Finance-team confirmations (see README §7): credit-note numbering, debit-note convention, expense dates, Neddle's invoice-date field | accuracy of specific document types | Assumptions documented and configurable |
| 7 | A Microsoft 365 app registration that may send mail from one mailbox (`Mail.Send`), and its four values in the dashboard's environment (README, "Setting up the sending") | email reminders — everything else about assignments works without it | **Needed from your Microsoft 365 administrator.** Until then the page says "Not set up yet" and reminders cannot be switched on; no real email has been sent |

---

## 11. Phases

| Phase | Scope | State |
|---|---|---|
| **1** | Zoho read-only sync (period with resumable listing, change feed every 15 minutes, nightly re-check with deletion check and comparison of totals, rate-limited workers, budget and reserve, first-sync status); GSTR-2B JSON / Excel import with preview, duplicate protection, immutable originals, versions and diff, control totals; matching engine; review; assignments (owner from the user list, My rows, due dates, overdue) and email reminders to owners; dashboards; vendor summary; Excel export with bridge; audit trail; rights and scoping; demo data | **Implemented and tested** (reminder emails: tested with a recording mailer — not yet sent through Microsoft 365, see blocker 7) |
| **2** | ITC register (eligibility with reasons and evidence, available / deferred / ineligible / claimed / reversed / reclaimed, claim periods), Section 16 / 17(5) / 37 / 37A / RCM / import / ISD / credit-note / common-credit reviews with partial payments, GSTR-3B working (proposed vs filed), duplicate-claim prevention, approvals, vendor message **drafts** (sending only after an enabled approval workflow, recipients verified, one vendor's data never in another's draft), period locks and frozen snapshots with post-lock change report, evidence attachments, ISD / import matching | **Planned** (data model and hooks are in place) |
| **3** | Authorised GSTN / IMS connectivity, IMS status display, supplier filing-status source, advanced analytics (AI may only suggest candidates or explain — never set amounts or entitlement) | **Planned** — depends on blocker 5 |

---

## 12. Tests

`npm run test:gstr2b` — see README for the current count and the scenario list. Phase 1 covers: exact and rounded matches, number-collision and duplicate handling, wrong GSTIN, equal totals with different components (no offsetting), split and consolidated invoices, credit notes, amendments, recomputed statements, late reporting across years, repeated uploads, edited / voided / deleted Zoho records, interrupted and resumed sync, partition-only reprocessing, reviewer decisions surviving re-runs, access limits, audit tamper detection and export structure; assignments (owners, open / overdue, My rows, filters and figures) and email reminders (who is told what and when, what is never emailed, retries, the sender against a stand-in for Microsoft Graph).
**Not yet testable (Phase 2):** partial-payment 180-day review, duplicate-claim prevention, locked-period changes.
