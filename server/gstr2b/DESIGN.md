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
* **Scheduler.** Own timer (office PC only), default **13:20, 15:20, 18:20, 21:20 IST** — the hours requested, 20 minutes past so it never collides with the shared sync at :00 or the Neddle MSME sync at :10. The first run of each IST day also re-checks for deleted documents. Vercel Cron is **not** changed (no shared schedule touched); online, the buttons are used.
* **Online sync (Vercel).** A function may run 300 s, so a request runs **one slice** (`sync.slice_seconds`, default 200, capped at 250 so saving and the follow-up reconciliation still fit) and ends cleanly as `partial`; the page asks for the next slice until the run is `completed`, paused (daily budget / Zoho limit), stopped, or 40 slices have run. Resumable by construction: the detail queue is the stored documents that still say `detail_pending`. Three safeguards for the slice model: (1) months listed within the last 6 hours are not listed again by a repeated or resumed *period* run (the two newest months and every *re-check* always are), so the slice's calls go to amounts, not to re-listing; (2) the change-feed starting point is fixed at the first listing, so edits made while a multi-slice first sync is under way are caught afterwards; (3) a **lease** (`run_id`, user, expiry = slice deadline + 90 s) in the stored sync state stops a second click, tab or user on *another serverless instance* from starting an overlapping sync — the in-memory "running" flag only sees its own process. The lease is online-only (on the PC the process is the authority, and a stale lease must not block a sync after a restart) and expires by itself if the platform kills a slice.

### Storage keys
| Key | Content |
|---|---|
| `config` | companies → registrations (GSTIN, branch ids, GSTR-9 filing dates, verification), tolerances, schedule, sync limits, per-user access |
| `sync_<co>` | change-feed high-water marks, window log, daily Zoho-call budget, last 30 runs |
| `books_<co>_<YYYY_MM>` + `books_idx_<co>` | Books documents by posting month; id → month index (a document whose posting date is edited moves) |
| `stmt_idx`, `stmt_<id>` | statement metadata (version, current flag, sha256, control totals) and its documents / row problems |
| `recon_<co>_<gstin>` | latest reconciliation: rows, partition hashes, summary, what changed since the previous run, stale links |
| `review_<co>` | manual links, "not a match" blocks, exclusions, owner / workflow / next action, notes, history |
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
| Change filter | `GET /bills?last_modified_time=<ts>` | returned 4 rows vs 200 unfiltered — **honoured** | Verified |
| Vendor credits | `GET /vendorcredits/{id}` | `taxes[]`, line taxes, `gst_no`, `bill_id` / `bill_number` link, `bills_credited[]`, `reason_for_debit_note`; list rows carry **no** GSTIN | Verified |
| GST-bearing expenses | `GET /expenses`, `/expenses/{id}` | list has `total` and `total_without_tax` (tax = difference); detail has `gst_no`, `taxes[]`, `itc_eligibility`. **21 of 2,400 expenses this FY carry GST**; no vendor id on the sample | Verified |
| Vendor master | central `vendors_all` | `gst_no`, `pan_no`, `gst_treatment`, `place_of_contact` | Verified (existing sync data) |
| Payments / allocations | inside bill detail `payments[]` (date, amount, status) | enough for the Phase 2 180-day review | Verified |
| Deleted records | `GET /bills/{id}` → 404 / code 1002 | same technique as the existing sync engine | Verified (existing engine) |
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
| Overview | cards, deadline notice, status table, deadline table, bridge, exclusions, "how calculated" |
| Reconciliation workbench | Books and GSTR-2B side by side, components, differences, rule, flags, source links, owner / next action; filters; saved filters; bulk assign / approve / reject; manual link / unlink; row drawer with full explanation, candidates, notes, history |
| Books only · GSTR-2B only · Mismatch & duplicate review | the same workbench pre-filtered |
| Vendor summary | open items, recurrence, delay, filing status ("Unknown" unless 2B states it) |
| ITC register | **Phase 2** screen with the verified rules |
| Imports & sync | Zoho sync controls and status; upload → preview → import; statements, versions, original file, version diff |
| Settings & audit | companies / GSTIN / branch onboarding with verification; tolerances; schedule and limits; access; coverage matrix; rules and sources; audit trail with chain check; demo data |

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
| 2 | Choose where the module is the system of record: office PC or Vercel (they hold separate data; Vercel accepts uploads up to 4 MB, has no scheduler and syncs in steps while a page is open) | where finance works | **Decision for you** — both are built and tested (Vercel only against an in-memory stand-in for Neon and Blob). The office PC gives the 4-times-a-day schedule and larger files; online gives access from anywhere. Do not mix: statements and review decisions made in one are not in the other |
| 3 | Zoho call budget: first detail fill of FY 2025-26 + 2026-27 is roughly 11,000 calls | speed of the first full sync | Configurable (default 2,500/day for this module); shared with every other module |
| 4 | A dedicated read-only Zoho refresh token (scopes in `zohoRead.js`) | least privilege (the module only reads either way) | Optional — recommended |
| 5 | GSP / ASP subscription, per-GSTIN API enablement, OTP workflow | Phase 3 direct GSTN / IMS | Not assumed; not needed for Phase 1–2 |
| 6 | Finance-team confirmations (see README §7): credit-note numbering, debit-note convention, expense dates, Neddle's invoice-date field | accuracy of specific document types | Assumptions documented and configurable |

---

## 11. Phases

| Phase | Scope | State |
|---|---|---|
| **1** | Zoho read-only sync (period, change feed, deletion check, resumable, budgeted); GSTR-2B JSON / Excel import with preview, duplicate protection, immutable originals, versions and diff, control totals; matching engine; review; dashboards; vendor summary; Excel export with bridge; audit trail; rights and scoping; demo data | **Implemented and tested** |
| **2** | ITC register (eligibility with reasons and evidence, available / deferred / ineligible / claimed / reversed / reclaimed, claim periods), Section 16 / 17(5) / 37 / 37A / RCM / import / ISD / credit-note / common-credit reviews with partial payments, GSTR-3B working (proposed vs filed), duplicate-claim prevention, approvals, vendor message **drafts** (sending only after an enabled approval workflow, recipients verified, one vendor's data never in another's draft), period locks and frozen snapshots with post-lock change report, evidence attachments, ISD / import matching | **Planned** (data model and hooks are in place) |
| **3** | Authorised GSTN / IMS connectivity, IMS status display, supplier filing-status source, advanced analytics (AI may only suggest candidates or explain — never set amounts or entitlement) | **Planned** — depends on blocker 5 |

---

## 12. Tests

`npm run test:gstr2b` — see README for the current count and the scenario list. Phase 1 covers: exact and rounded matches, number-collision and duplicate handling, wrong GSTIN, equal totals with different components (no offsetting), split and consolidated invoices, credit notes, amendments, recomputed statements, late reporting across years, repeated uploads, edited / voided / deleted Zoho records, interrupted and resumed sync, partition-only reprocessing, reviewer decisions surviving re-runs, access limits, audit tamper detection and export structure.
**Not yet testable (Phase 2):** partial-payment 180-day review, duplicate-claim prevention, locked-period changes.
