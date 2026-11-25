# 26AS Reconciliation

TDS receivable booked in Zoho Books against the credit shown in Form 26AS, per legal entity and period.

- **Where:** sidebar → **26AS Reconciliation**, directly below Financial Statements.
- **Page:** `client/src/pages/Tds26asReco.js` plus `client/src/pages/tds26as/`.
- **Server:** `server/tds26as/`, mounted at `/api/tds26as` in `server/index.js`.

It answers three questions for a chosen entity and period:

1. How much TDS receivable is booked in Zoho, and how much credit does Form 26AS show?
2. Which differences come from rounding, timing, a wrong amount or a missing entry?
3. Which clients need follow-up, for how much, and on which transactions?

**TDS difference = Zoho TDS receivable − 26AS tax deposited.** A positive difference means the books show more TDS than the statement credits. The 26AS tax deducted is shown separately.

## Access

| Right (User Settings → 26AS Reconciliation) | Allows |
|---|---|
| module ticked | viewing the dashboard, reports, exports, statements and mapping |
| `t26_prepare` Prepare | Zoho sync, uploading statements, re-running the reconciliation |
| `t26_review` Review | final status, remarks, references and attachments, carry forward, reviewer links, client mapping, owners |
| `t26_config` Configure | entities, ledgers, settings, schedule |

- The module is shown only to admins and to users ticked for it (`grantOnly`).
- Each right is ticked one by one.
- An admin can limit a user to some entities (Settings & audit → Access by entity).

## Sources

### Zoho Books (read-only)

The Zoho client has GET only (`server/gstr2b/lib/zohoRead.js`). The fields below were verified live on DevX on 22 Nov 2026.

| What | Call | Fields used |
|---|---|---|
| **Control amount** | `GET /chartofaccounts/transactions?account_id&date_start&date_end`, per mapped TDS Receivable ledger. This report **ignores `date.start`/`date.end`** (and `from_date`/`to_date`) and then returns the whole ledger history; only `date_start`/`date_end` apply a range (verified live). Every answer is checked, and postings outside the window stop the sync. | `categorized_transaction_id`, `transaction_type` (invoice / customer_payment / journal / creditnote …), `transaction_id` (**empty for customer_payment**), `transaction_date`, `customer_id`, `payee`, `description`, `entry_number` (the invoice number on invoice and payment rows), `debit_amount`, `credit_amount` |
| Invoice | `GET /invoices/{id}` | `sub_total` (basic), `tax_total` (GST), `total` (net of TDS), `tds_amount`, `tds_percent`, `tds_summary[].tds_name`, and the client's TAN when kept in a custom field (DevX: `cf_organization_tan_number`) |
| Payment | `GET /customerpayments/{id}` | `invoices[].tax_amount_withheld`, `amount_applied`, `total`. The payment behind a posting is found by customer, date and invoice number. The dashboard's central `customer_payments_fy` cache is used where it covers the month. |
| Journal | `GET /journals/{id}` | `line_items[].customer_id`. The TDS line often has no customer, but the receivable line does. The notes and reference supply invoice numbers. |

How postings become Zoho entries (`lib/booksModel.js`):

- **The ledger posting is the amount.** Documents only add detail, so one TDS amount is counted once.
- **Journal lines:**
  - Lines on mapped ledgers are netted per customer and section.
  - A journal that only moves TDS between the entity's own TDS ledgers nets to zero. It is listed as a transfer and not counted.
  - A journal whose customer cannot be identified is **unallocated** and shown separately.
- **Comparable base:**
  - TDS booked on an invoice uses the invoice basic value.
  - A payment uses the share of the invoice it settles: (applied + TDS) ÷ gross.

**Sync** (`lib/booksSync.js`), started with "Sync the selected period":

- **Ledger listing:** for each ledger, windows of up to three months inside one quarter. A window with more than one page is split.
- **Fresh data:** each listing replaces what was stored, so edits and deletions in Zoho are picked up.
- **Details:** fetched only for new or changed documents (incremental).
- **Daily allowance:** this module's own allowance of Zoho calls per day (20,000).
- **PC schedule:** the office PC re-reads the current financial year daily (default 13:40 IST) for entities whose first sync is done. The online copy has no scheduler.

> **Zoho limit (learned 22 Nov 2026):** the account-transactions **report** has its own per-minute limit, well below the 150-a-minute limit of normal APIs.
>
> - About 50 calls in 38 seconds got that report blocked for 60 minutes (code 43). Ordinary APIs kept working.
> - Report calls are therefore paced separately: `sync.ledger_rate_per_min`, default 25 a minute.
> - After a block the module records `blocked_until` and does not call the report again before then.
> - Other dashboard features use the same report (Branch P&L prefetch, RPT loan ledgers). Do not raise the pace.

### Form 26AS (`lib/parse26as.js`)

Accepted formats:

- PDF from the e-filing portal or TRACES, including password-protected files (a password prompt; the password is never stored)
- The TRACES text export (`^`-separated), as `.txt` or inside the ZipCrypto-protected `.zip`
- Excel or CSV: the text file split into columns, or a flat sheet with its own headings

How it is read:

- **Part read:** only **PART-I** (Details of Tax Deducted at Source).
- **Columns:** found by their headings, never by position alone.
- **Source kept:** every row keeps the file, the line, sheet row or PDF page, and the text as printed.
- **Checked against a published statement:** the PDF layout and the booking-status legend (U, M, P, F, O, Z). Two layout facts worth knowing: dates print as `15-Apr-2026`, and a date can be printed in two pieces.

Before import, the preview validates:

- the PAN against the selected entity (a mismatch blocks the import)
- the statement period and date
- the row count
- deductor control totals against their rows
- unreadable rows and missing fields

Versions (`lib/statements.js`):

- **Version in use:** one per entity and financial year, the one with the latest statement date.
- **Same file again:** a re-upload of the same bytes changes nothing.
- **Revised statement:** replaces the earlier credits; credits are not added up. The preview shows the rows added, removed and changed.
- **Credit key:** entity + FY + TAN + section + transaction date + amount paid + tax deducted + occurrence. A revised deposit keeps the credit and its review decisions.

## Reconciliation (`lib/match.js`)

Cut-off: Zoho entries by **TDS posting date**, 26AS credits by **transaction date**. Invoice, payment and booking dates are shown separately.

| Step | Rule |
|---|---|
| 0 | Reviewer links: pairs or groups a reviewer confirmed, with both sides inside the period. Carry-forward settlements consume their credits first. |
| 1 | **Identify the client by the deductor TAN** (`lib/clients.index`, see "Clients are matched on the TAN" below): an entry belongs to the client of the TAN recorded on its Zoho invoice, so several Zoho customers with one TAN are one client. Reviewer client groups cover what the TAN cannot tell. Unmapped → Need to Check. A TAN can be marked "no Zoho customer". |
| 2 | **Transaction-wise:** TDS equal within ₹2 to the 26AS tax deducted or deposited. Among equal candidates, an exact amount, the section family (194I(a)/(b) → 194I), the base (amount paid vs Books base) or a clearly closer date decides. When a client has **the same amount as many times in Zoho as in the 26AS** within the period (a monthly fee), they are paired in date order — first entry with first credit — and flagged "Same amount — paired by date" (the pairing changes no difference; added 24 Nov 2026 after a client whose two ₹2,977 invoices and two ₹2,977 credits in one quarter had been shown as timing differences against other quarters). If the sections could tell them apart and the date order would pair differing sections, they go to review instead. Otherwise → **Need to Check — ambiguous**. |
| 3 | **Client total:** a unique subset (one credit = several entries, or the reverse), then the remaining totals per client. Method "Client total"; invoice attribution stays open. |
| 4 | **Investigate:** first, timing (a credit or booking of the same client in another period → **Need to Check — timing**, with both periods shown and the other-period amount kept out of this period's totals). Then leftovers paired on evidence → **Not Matched**. The rest are one-sided: **Not in 26AS / Not in Zoho Books** only when the other source covers the date, otherwise **Need to Check — coverage gap**. A quarter counts as covered when its statement is dated on or after the deductors' filing date (31 Jul / 31 Oct / 31 Jan / 31 May). |

Each source amount is used once. The ₹2 tolerance applies once per match or group.

**Clients are matched on the TAN (23 Nov 2026).** Form 26AS lists a client once, under its TAN. DevX's books hold many clients as
several customers, one per branch with slightly different names (e.g. "… - 14 Floor", "… - Mumbai - 1", "… - Hyderabad"), all recording
the same TAN in `cf_organization_tan_number`. Before, only customers a reviewer had mapped were matched, so the other branches were
"not mapped" and listed as "Customer may be booked under the wrong Zoho customer". Now each entry's client is found in this order:

1. the TAN on the entry's own invoice, when a client group holds it or an uploaded statement has credits from it;
2. otherwise the customer's client group;
3. otherwise the one known TAN the customer records on its other invoices (credit notes and journals without an invoice);
4. otherwise that TAN even though no statement has it yet. This makes a client of its own whose entries become **Not in 26AS** once a statement covers the date (reason `tan_not_in_26as`; often a wrong TAN on the invoice).

Anything else is "not mapped": no TAN on the customer's invoices, or several. Every TAN no group holds is an automatic client `tan:<TAN>`, named after the deductor in the statement. No approval is needed for these. Reviewer decisions come first:

- a TAN in a client group belongs to that group;
- a customer ↔ TAN pair marked **not this client** is never used (Undo on Client mapping);
- a TAN marked **no Zoho customer** gets no automatic client.

Client groups are still used for a client that deducts from several TANs, and for customers whose invoices carry no TAN. Approving a name suggestion for a TAN that no invoice records also adds the TAN the customer is already matched on, so the client is not split.

The corrections report adds two checks:

- "Invoice TAN belongs to another client than the customer";
- "TAN on the Zoho invoice is in no Form 26AS" (when the customer's other invoices record a known TAN).

Statuses:

| Status | When |
|---|---|
| Matched | difference exactly ₹0 |
| Matched Rounding Diff. | difference above ₹0 and up to ₹2.00 inclusive |
| Not Matched | both sides identified, difference above ₹2 |
| Not in 26AS | booked in Zoho only |
| Not in Zoho Books | credited in 26AS only |
| Need to Check | timing, ambiguous, unmapped, unallocated, coverage gap |
| Carry Forward | reviewer-approved |

**Likely reason** comes with its figures. Examples: short booking in Zoho, short deduction by the client, deducted > deposited, base including GST, part of the invoice, insufficient evidence. Responsibility is named only where the record shows it: a 26AS row whose deducted amount exceeds the deposit names the deductor.

**Review** (`lib/review.js`):

- **What a reviewer records:** final status, remarks, references and attachments.
- **History:** every save is kept, with the system status at that time.
- **Confirmed non-deposit:** needs evidence (a description plus a reference or attachment).
- **Carry Forward:** records the origin, balance, target quarter or year, and reason. A later credit (or booking) of the same client and amount, from the target period on, settles the item once. The original period keeps its picture. A reviewer can also close an item with a reason.

## Reports (`lib/reports.js`, Excel via `lib/exporter.js`)

All reports filter by entity, period, client, TAN, section and status, and export to Excel.

- **Dashboard:**
  - figures: Zoho TDS receivable (checked against the ledger postings), 26AS deducted and deposited, matched credit, rounding difference, open on each side, carry-forward balance
  - every figure drills down to its items
  - the bridge ties Zoho to 26AS deposited (unexplained = ₹0.00)
  - coverage panel: statement dates, last Zoho sync, gaps
- **Client follow-up (priority report):**
  - **follow-up amount** = credit missing + deducted not deposited + other short credit + confirmed non-deposit, from **open** items only
  - shown separately: excess credit (never netted), subsequent-period credit, needs review first
  - also: owner, remarks, oldest open date
  - rows for unmapped customers or deductors and unallocated postings, so the totals tie to both sources
- **Transactions:** both source references, dates, base values, TDS amounts, signed difference, method, system and final status, likely reason. A side-by-side drawer shows the comparison.
- **Zoho corrections:**
  - 26AS credits missing from Zoho, with candidate invoices
  - TDS amount errors and TDS booked twice
  - customer mapping (TAN on the invoice ≠ deductor, invoice TAN of another client than the customer's group, invoice TAN in no statement)
  - ledger allocation (another FY's ledger, section differences)
  - unallocated journals
  - links to the Zoho records
- **Carry forward:** quarter-wise or year-wise opening, additions, credits identified later, closures and closing balance, with drill-down from each item to its origin and settlement.

## Storage

Store keys start with `t26_`:

- Office PC: files in `server/tds26as/data/`
- Online: Neon `kv_store`

Every key holding entity data carries the entity id: `ledger_<entity>_<fy>`, `docs_<entity>`, `sync_<entity>`, `clients_<entity>`, `review_<entity>`, `cf_<entity>`. Statements are `stmt_idx` and `stmt_<id>`.

Original files (statements and attachments):

- Office PC: `server/tds26as/files/<sha256>`
- Online: private Blob `tds26as/<sha256>`

Both folders are git-ignored. The audit trail is hash-chained (`audit_YYYY_MM`), and Settings & audit → Verify checks the chain.

## Setting up

1. **Map an entity.**
   - Go to Settings & audit → Entities → Add an entity.
   - Click **Load my Zoho organisations** and choose the organisation.
   - Enter the legal name and the **PAN** printed on its Form 26AS.
   - Click **Find ledgers in Zoho** and tick every TDS Receivable ledger: 194C, 194I, 194J, 194A, 194H, 194Q and the year-wise "TDS Receivable U/s. … F.Y. …" ledgers.
   - Save, then click **Check Zoho access**.
2. **First Zoho sync.** On Statements & Zoho sync, choose the financial year above and click **Sync the selected period**. Keep the tab open until it says finished.
3. **Upload the first statement.**
   - On the same tab, choose the PDF, text or ZIP file.
   - Click **Preview** and enter the password if asked.
   - Read the checks, then click **Import this statement**.
4. **Check the clients.** Clients whose TAN is on their Zoho invoices are matched automatically ("Matched automatically by TAN" on Client mapping). Review the name suggestions, the deductors no invoice records, and the customers whose invoices carry no TAN. If a customer is wrongly matched on a TAN, use **not this client**.
5. **Export the follow-up report.** On Client follow-up, set the filters and click **Export to Excel**.

Admins can load **demo data** (Settings & audit) to see every case first. It is synthetic, labelled on every screen, and removable.

## Tests

`npm run test:tds26as` (44 tests):

- parser: text, Excel, CSV, PDF, protected PDF, protected ZIP
- clients matched on the TAN (`tests/tanmatch.test.js`, synthetic): one TAN under three Zoho customers with only one mapped, one TAN under two customers with nothing mapped, a mistyped invoice TAN, another client's TAN on an invoice, a ruled-out pair, a name suggestion joining two TANs, order independence
- the Tax Year 2026-27 statement layout (Excel and PDF, synthetic data), section codes, reversal pairs, Gross Total
- every acceptance case on the demo scenario
- sync on a fake Zoho with the live response shapes, the report pacing, the block handling and the stored lock
- the HTTP routes: rights, entity limits, upload, review, export, audit

## Tax Year 2026-27 statement (seen 23 Nov 2026)

DevX's own statement for Tax Year 2026-27 (the portal's Excel download, "Data updated till 14-Nov-2026") was read locally, without
importing it anywhere: 1,655 rows under 207 deductors, TDS deposited ₹6,64,68,507.21, equal to the statement's summary and its PART-I
Gross Total; every deductor total equals its rows; no unreadable rows. What that layout needed:

- **Header:** "Data updated till 14-Nov-2026" is one cell; "Name of Assessee" has the name on the row below.
- **Headings:** "S.No." (not "Sr. No."), "Section Code", "PAN of Deductor (If Available)" after the TAN; transactions numbered 1.1, 1.2 …;
  booking status as a word ("Final", "Overbooked", "Unmatched").
- **Page furniture** ("Page 2 of 59", "Annual Tax Statement") repeats inside PART-I and is skipped.
- **Section codes** are the Income-tax Act, 2025 codes (1009 = 393(1) Sl. 2(ii).D(b) rent …). Zoho still names TDS by the 1961 sections
  (Sep 2026 invoices: 194I, 194C, 194J, 194A, 194H), so `config.ACT2025_CODES` maps each code to the 1961 section it continues
  (1008/1009 → 194I, 1023/1024 → 194C, 1026/1027/1028 → 194J, 1020–1022 → 194A, 1006 → 194H, 1031 → 194Q …). The new-Act section
  and description come from the legend printed at the end of the statement. Settings → section aliases still override.
- **Reversal pairs:** a deductor's reprocessed statement prints a credit, the same credit in brackets (remark G "Reprocessing of
  Statement", or B "Rectification … by deductor"), then the credit again. DevX's statement has 74 such pairs. `statements.netReversals`
  cancels each bracketed row against one equal positive row before matching (totals unchanged); otherwise every such invoice would be
  ambiguous between equal credits. A bracketed row with no equal positive row goes to Need to Check (reason `reversal_26as`).

The PDF of the same statement has not been seen; the PDF reader accepts the same headings, numbering, PAN column and status words.

## Validated live (read-only, DevX, September 2026, 22 Nov 2026)

- 296 postings in 15 ledgers, all dated in September; 17 report calls; 324 calls in all; about 5 minutes.
- Entries total ₹1,37,86,051.47, equal to the ledger postings.
- 258/258 invoice postings have their basic value; 19/19 payment postings are linked to their payment and allocation.
- 4 journals take the customer from their receivable line; 8 entries (₹21,72,142.03) have no customer and are shown as unallocated.
- 212 of 296 entries carry the client TAN from Zoho.

## Not yet validated with live data

- **Real statements:** DevX's Tax Year 2026-27 Excel has been read end to end (above). Not yet seen: the PDF of that statement, a TRACES text export, and any FY 2025-26 (old-Act, "194I(b)") statement of a company.
- **Section codes 1039–1057 (non-resident payments) and TCS codes** keep their code; map them under Settings → Section aliases if they ever appear.
- **Zoho web links:** invoice links use the same pattern as the dashboard's bill links. The links for payments, journals and credit notes are not verified. Credit notes are not linked to their invoice.
- **Online (Vercel):** the sync runs in steps while the page is open; there is no online scheduler. Uploads are limited to 4 MB.
  A step holds a stored lock, so a second click that lands on another server instance is refused instead of running alongside.
  When Vercel itself stops a request (5-minute limit, size limit, crash) it answers `{ error: { code, message } }`; the page turns that
  into a sentence (`client/src/pages/tds26as/api.js` errMsg) — showing the object as it was crashed the whole app (React error #31,
  23 Nov 2026, a sync step on Vr. 22.0, which still had the date-filter bug and read whole ledgers until Vercel stopped it).
