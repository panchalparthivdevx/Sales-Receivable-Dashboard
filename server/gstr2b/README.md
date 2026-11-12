# GSTR-2B Reco — setup and operating guide

**Sidebar → GSTR-2B Reco** (under GST Dashboard). It compares what is **booked in Zoho Books** with what suppliers have **reported to the GST portal (GSTR-2B)**, separately for each of your GST registrations, and tells you what matches, what is missing on either side, and what differs.

*Written for the finance team. How it is built, the verified Zoho / GST facts and the rules are in `DESIGN.md` in this folder.*

## What it does — and does not do

| It does | It does not |
|---|---|
| Reads bills, vendor credits and GST-bearing expenses from Zoho Books — **read-only** | Change anything in Zoho: it cannot create bills, post journals, file returns or send messages |
| Imports the GSTR-2B file you download from the GST portal (JSON or Excel), keeps the original untouched, tracks versions | Connect to the GST portal by itself (that needs a GSP subscription and OTP — Phase 3) |
| Matches by clear written rules and shows **why** every row got its status | Decide whether tax credit is **eligible** — "matched" is not "eligible". The ITC register is **Phase 2** and is not built yet |
| Shows Books-only GST as **unresolved exposure** (with the Section 16(4) deadline), never as "lost" | Match across different GSTINs or companies, or on a vendor name / similar amount alone |

## One-time setup (CFO / administrator)

1. **Restart the dashboard server once** (the module's server code is new) and press **F5** in the browser. The sidebar then shows **GSTR-2B Reco** to administrators.
2. **Give people access:** *User Settings → GSTR-2B Reco*. Tick the module, then the rights each person needs — they are ticked one by one and never by "All":
   * **Prepare** — Zoho sync, upload statements, run reconciliation, owner / notes · **Review** — link, approve suggestions, exclude documents, mark Accepted / Resolved · **Approve / lock** — Phase 2 · **Configure** — companies, GSTINs, tolerances, schedule.
   * Typical roles: *preparer* = Prepare · *reviewer* = Prepare + Review · *CFO* = all four · *read-only* = module ticked, nothing else.
   * An administrator can also limit a person to particular companies or GSTINs (*Settings & audit → Access*).
3. **Connect a company** — *Settings & audit → Companies & GSTINs → Add a company*:
   1. **Find the organisations** this Zoho login can read (or type the organisation id). Pick the company.
   2. **Read its branches and GSTINs.** Each Zoho branch carries a GSTIN; the screen groups branches by GSTIN and checks each one (correct check digit, branch addresses in the right state, same PAN). Branches **without a GSTIN** are listed — their documents cannot be reconciled until a GSTIN is entered in Zoho.
   3. Tick the GSTINs that are yours, name the company, confirm the **supplier invoice date field** (DevX uses `cf_vendor_bill_date`; for another company check which custom field holds the supplier's invoice date) and **Save**. The server re-checks every GSTIN against Zoho before it is saved.
   Nothing is pre-filled — organisation ids, GSTINs and branch mappings are never assumed.
4. **(Recommended) a read-only Zoho token.** The module only reads either way. For least privilege create a separate Zoho token with read scopes only (`ZohoBooks.bills.READ`, `.vendorcredits.READ`, `.expenses.READ`, `.contacts.READ`, `.settings.READ`, `.vendorpayments.READ`) and put it in `.env` as `GSTR2B_ZOHO_REFRESH_TOKEN` (plus `GSTR2B_ZOHO_CLIENT_ID` / `GSTR2B_ZOHO_CLIENT_SECRET` if the Zoho client differs from the dashboard's). The top-right of the screen says which credentials are in use. *Settings → Check Zoho access* tests each area.
5. **Record GSTR-9 filing dates** (*Companies & GSTINs*, per GSTIN and year) once the annual return is filed — it can close the ITC claim window before 30 November.

## First sync

*Imports & sync → Start the first sync…* Choose the months (default: last financial year + this one). Zoho's list has no GST amounts, so every bill that can be matched needs **one extra call**. Roughly 11,000 calls for two years of DevX, against a **budget of 2,500 calls a day** for this module (changeable in *Schedule & sync limits*; Zoho's limit is shared with every other module). So the first fill takes a few days — on the office PC it continues by itself at each scheduled run; online you click the button again each day (or when it pauses). It can be stopped and resumed at any time, and never fetches the same document twice. **Start with last year's invoices**: their ITC window closes first (see the deadline notice on Overview).

After that, the sync runs on the office PC at **1:20, 3:20, 6:20 and 9:20 PM** (changeable); the first run each day also checks for deleted documents. "Sync changes now" does the same on demand. **Online (Vercel) there is no scheduler** — use the buttons. A web request there can only run a few minutes, so the page syncs in **steps** (about 3½ minutes each) and asks for the next step by itself until the sync is finished or the day's budget is used; keep the tab open. If you close it, the step in progress still finishes and you click the button again to carry on. Two people cannot sync the same company at once — the second click is told it is already running.

## Every month (suggested routine)

1. **After the 14th** (when GSTR-2B is generated) — and again after any IMS action and *recompute* — download GSTR-2B for **each GSTIN** from the portal (Returns → GSTR-2B → Download; JSON is preferred).
2. **Imports & sync → Upload** the file → **Preview**. Check: the GSTIN and period read from the file, the sections and totals, any row problems, the "portal summary check" (Agrees / Differs). Then **Import**. A second upload for the same GSTIN and month becomes the next **version**; an older file never replaces a newer one; the same file cannot be imported twice.
3. **Work the queues** (each is a filtered view of the same workbench):
   * **Mismatch & duplicate review** — amounts that differ, suggested matches, duplicates, GSTIN problems.
   * **Books only** — in Zoho, not reported by the supplier: chase the supplier. The row shows the ITC claim deadline.
   * **GSTR-2B only** — reported by a supplier but not in your books.
   Click a row for the full explanation, both source documents, and what to do. Set an **owner**, **workflow** and **next action** so nothing is lost. *Suggested* matches must be **approved** with a reason; they are never accepted automatically.
4. **Overview** before you file GSTR-3B: *Pending review*, *Potential credit exposure*, and the deadline notice. **Export to Excel** for the working papers (it includes the bridge that ties Books to GSTR-2B per tax component).

## How to read a row

**Status (one per row):** *Exact matched* · *Matched within approved tolerance* (each tax component within its own rounding tolerance, default ₹1) · *Suggested match — review required* · *Mismatched* (same document, an amount differs beyond tolerance) · *Books only* · *GSTR-2B only* · *Excluded* (kept out of matching, always with the reason).

**Flags (extra notes on a row, never added up):** duplicate suspected · invalid GSTIN · wrong supplier / recipient GSTIN · cross-period / late reporting / across financial years · amendment · credit / debit note · reverse charge · incomplete or unsupported data · ITC not available per the portal · invoice date assumed · ambiguous · number-normalisation collision.

**Rules, in short:** same supplier GSTIN + document type + number + date → matched (R1); number equal after ignoring case, spaces and punctuation → matched (R2); leading zeros, small typos, nearby dates, split or consolidated invoices, another GSTIN of the same PAN → only ever **suggested**. Different recipient GSTINs and companies are never mixed.

## Please confirm (assumptions the module makes)

| # | Assumption | Where to change |
|---|---|---|
| 1 | In Zoho, **Credit Note #** is the supplier's credit-note number (otherwise use Reference #) | Companies → credit-note number |
| 2 | A **debit note received from a supplier** is booked as a bill | — (needs a convention) |
| 3 | The supplier's invoice date is in the custom field set per company; if empty the **posting date** is used and flagged "assumed" — such rows are never auto-matched on number alone | Companies → invoice date field |
| 4 | **Expenses with GST** (21 of 2,400 this year) are included but their date is never trusted as an invoice date | — |
| 5 | Reverse-charge purchases: the module splits the RCM tax into IGST / CGST / SGST by place of supply (Zoho keeps it on the lines) and flags it | — |

## Known limitations

* **GSTR-2B files:** the JSON layout is taken from third-party documentation of the GSTN API (GSTN publishes no public schema) and the **Excel layout has not been run against a real portal workbook** — the importer reads by heading text, shows exactly what it read, and refuses to half-import a sheet. **Please upload one real JSON and one real Excel file per GSTIN** (Preview does not import anything) so the mapping can be locked.
* **Sections imported but not matched yet** (shown as *Excluded* with the reason): ISD, imports of goods / SEZ, e-commerce operator documents, Rule 37A reversals.
* **Phase 2 is not built:** ITC register (eligibility, claim / reversal / reclaim), 180-day review with partial payments, GSTR-3B working, approvals, vendor message **drafts**, period locks and snapshots, evidence attachments. **Phase 3:** direct GSTN / IMS (needs a GSP subscription), supplier filing-status lookup. The screens say so; the Excel has labelled placeholder sheets.
* **PC and Vercel keep separate copies** of this module's data (statements, decisions, notes and the synced Books). Choose one as the place where finance works. The office PC syncs by itself 4 times a day and accepts files up to 40 MB; online has no scheduler (buttons only, in steps — see *First sync*) and accepts uploads up to 4 MB. Online, the module's data sits in Neon and the original statements in private Blob. The Neon side is tested with the dashboard's real database code (only the connection is simulated); the Blob side uses the dashboard's shared file store, tested with an in-memory stand-in, so the first real statement upload and first real sync online should still be watched.
* Journals and opening ITC balances are not read; bills of unregistered / overseas suppliers are listed but cannot appear in GSTR-2B.
* The Section 16(4) deadline uses the invoice's financial year and the GSTR-9 date you record. It is a reading of the statute, **not legal advice** — confirm with your tax advisor.

## If something looks wrong

| You see | Meaning / what to do |
|---|---|
| "N Books documents are still waiting for their amounts" | The first sync is not finished (daily budget). Figures are incomplete until it is. Imports & sync shows progress and the estimate. |
| "GSTIN … is not set up" when uploading | Add that GSTIN under Companies & GSTINs first. |
| A row says "Changed in Zoho — not refreshed" | The bill was edited after it was read; the next sync refreshes it, or use **Refresh from Zoho** in the row. |
| "Possible wrong recipient GSTIN" | The same invoice is Books-only under one GSTIN and GSTR-2B-only under another. Nothing is matched across GSTINs — decide which registration the invoice belongs to. |
| Bridge shows "DOES NOT TIE" | Should never happen; stop and report it (it means a document was lost or counted twice). |
| Sync paused: "daily budget" / "Zoho limit" | It resumes next day, or raise the budget in Schedule & sync limits (Zoho's limit is shared). |

## Tests and what was verified

* `npm run test:gstr2b` — **96 tests, all passing**: matching (24), GSTR-2B import (8), Zoho → document conversion (14), sync (17), reconciliation end to end (12), dashboards (9), HTTP API (8), online mode (4). They use **synthetic** data and a fake Zoho shaped exactly like the responses seen live. The online-mode tests run the whole flow (sync in slices, upload, review, export, demo) on the dashboard's **real** `server/db.js` with only the Neon connection simulated in memory, Blob simulated in memory and a read-only disk; they check that every screen loads on a brand-new database, that nothing is written to the disk, that every key sits under the module's own `g2b_` prefix, and that a momentary database read failure stops the request instead of overwriting a stored record. (An earlier version simulated `db.js` itself, which hid a bug that showed online on first use — a record that does not exist yet came back as `null`.)
* **Browser test** (headless Chrome against an isolated server with a fake Zoho; no real data touched): **35 of 35 checks passed** with no console errors — sidebar entry, onboarding wizard, first sync, upload / preview / import, repeated-upload refusal, every tab, the drawer, settings, audit-chain check, demo data, Excel download.
* **Live, read-only against your Zoho (11 Nov 2026):** field shapes, branch GSTINs, change filter, organisation list, and data-quality measurements on the real bills — recorded in `DESIGN.md` §4 and §6. No full sync was run and nothing was written.
* **Scenarios covered:** exact and rounded matches · invoice-number collisions · wrong GSTIN · identical totals with different tax components · duplicates and repeated uploads · split and consolidated invoices · late reporting across financial years · credit notes · amendments · recomputed statements · edited, voided and deleted Zoho records · interrupted sync and safe retry · only-affected-partitions reprocessing · reviewer decisions surviving re-runs · access limits · audit tamper detection.
* **Not yet testable (Phase 2):** partial payments (180-day), duplicate-claim prevention, locked-period changes.

## Demo data

*Settings & audit → Demo data* (administrators) creates **Demo Company (synthetic)** with made-up suppliers, bills and statements that show every situation above, including invoices close to the FY 2025-26 deadline. It never touches Zoho, is labelled **DEMO** on every screen and in every export, and **Remove** deletes it completely. Real companies are unaffected.

## Where things are

`server/gstr2b/` — `index.js` (API), `lib/` (rules, import, sync, dashboards, export), `tests/`, `DESIGN.md`, this file. `client/src/pages/Gstr2bReco.js` and `client/src/pages/gstr2b/` (screens). Data: `server/gstr2b/data` and `server/gstr2b/files` on the office PC (git-ignored; keep them in your backups), or Neon / Blob online. Optional `.env` settings: `GSTR2B_ZOHO_REFRESH_TOKEN`, `GSTR2B_ZOHO_CLIENT_ID`, `GSTR2B_ZOHO_CLIENT_SECRET`, `G2B_DATA_DIR`, `G2B_FILES_DIR`.
