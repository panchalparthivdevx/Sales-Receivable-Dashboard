# Financial Statements — imported results, reconciliation and CFO analytics

**Sidebar → Financial Statements.** The page now shows the published, audited / limited-reviewed figures from the results workbooks (standalone and consolidated), with every figure traceable to its file, sheet, cell and formula, plus comparisons, ratios, CFO dashboards and operational reports built on those validated figures.

*Written for the finance team. Code: `server/fin-reporting/` (API, mounted at `/api/fin-reporting`) and `client/src/pages/finstmt/` (tabs).*

## What it does — and does not do

| It does | It does not |
|---|---|
| Reads the results workbooks by their **statement titles, column headings, dates and audit labels** | Identify a period from a file or sheet name (the Q1 sheet named "SEBI Results PL Q4 FY 25-26" is read as the quarter ended 30 June 2026 because its heading says so) |
| Keeps **every source figure** — the same period repeated in several workbooks is kept from each, and the differences are listed | Overwrite, average or "correct" a source figure, or post a balancing entry to make a check agree |
| Keeps Excel errors (`#REF!`, `#VALUE!`), missing saved results and external links **as errors** | Turn an error or a missing value into zero |
| Takes only the **final consolidated** columns | Use the DevX / Neddle / Saasjoy / Elim component columns as results |
| Derives a missing flow period (Q2 = H1 − Q1, Q3 = 9M − H1, Q4 = FY − 9M, H2 = FY − H1) **and labels it** | Derive EPS, a balance sheet, opening / closing cash or a ratio by subtraction; split quarters into months |
| Shows ratios with a status: OK / Proxy / Missing input / Not meaningful / Unreconciled | Show a metric as healthy without both a value and a threshold you approved |
| Writes nothing to Zoho Books | — |

## Importing (Data Validation & Reconciliation tab → Import workbooks)

1. **Office PC:** *Import from folder* reads every `.xlsx` in `Financials & Presentations\Financials`. **Online:** *Upload workbook(s)* one at a time (the server cannot see the PC folder).
2. Check the staged list: basis, the period each workbook was prepared for, statements found with their periods (primary / comparative / working), and findings.
3. **Commit import.** The set becomes a **version**; the reconciliation runs and its summary is stored with the version.
   * The same files again → nothing new is stored ("already the active import").
   * A corrected workbook replaces the staged file of the same name, basis and period; committing makes a new version.
   * **Roll back** to any of the last 8 versions (a reason is asked and logged).
4. The earlier data (trial-balance balance sheet, Zoho-mapped P&L with *Configure Periods* / *Edit Values* / *Account Mapping*) is untouched and still available through **Source** on each statement tab.

## Which figure a statement shows

For each line and period the module picks one source figure and keeps the others as alternatives (click a figure to see them):

1. A **recorded decision** (decision requests on the Data Validation tab).
2. **Financial version** filter:
   * *As originally reported* (default): the workbook **prepared for** that period — FY2025-26 from the audited annual workbook, Q2 / H1 FY2026-27 from the September workbook — else the earliest workbook that shows it as a comparative.
   * *Latest reported / regrouped*: the most recent workbook that repeats the period.
3. Visible sheet before hidden; SEBI results sheet before the detailed statement of profit and loss.
4. A value before a blank; never an Excel error before a valid figure.

A blank cell in a published statement is shown as "—" (nil). A line or period that does not exist is "not available". Hidden sheets whose title contradicts their columns (an old working table) are kept only as a working source and never shown.

## Reconciliation statuses and thresholds

**Agrees** (< ₹0.0005 lakh) · **Rounding** (≤ tolerance, ₹0.015 lakh by default; +0.005 when one side was typed rounded to 2 decimals) · **Difference** (above tolerance, below materiality, ₹1.00 lakh by default) · **Material difference** (above materiality — when two sources conflict this becomes a **decision request**) · **Unreconciled** (an error or missing figure prevents the check) · **Info**. EPS: tolerance ₹0.0005, materiality ₹0.01. Change them on *Management Inputs → Settings*.

Checks: statement subtotals and totals, assets = equity + liabilities, consolidated attribution (owners + NCI), PBT → tax → PAT → OCI → total comprehensive income, cash-flow subtotals and opening → closing cash, closing cash vs balance-sheet cash, cash-flow PBT and D&A vs P&L, note totals vs statement lines, every repeated figure across workbooks, quarter / half-year / year consistency, EPS vs the share count it implies, borrowing and lease classification, Excel errors / external links / stale titles, and the balance sheet and P&L that were already in the module.

**Adjustments** (statement level) are stored separately with reason, evidence, user and date, and appear only when "Include recorded adjustments" is ticked.

## Rights (User Settings → Financial Statements)

Viewing follows the module tick. Each edit right is ticked one by one: **Import workbooks** · **Adjustments & source decisions** · **Management inputs**. Admins have all.

## Management inputs

Branch seats, occupancy & area (effective-dated, used time-weighted) · client cohorts & revenue · capex budgets / commitments / payments · fixed / variable cost classes · share counts, dilution, dividends and dated market prices · management targets. Each has a form and an Excel template; every row needs a source. Nothing has a default value. The coverage table shows which report is waiting for which input. Budget, branch opening dates, collection / payment forecasts, debt schedule and covenants moved to the planning sections below (older records of those types are still read).

## Planning (Data Validation & Reconciliation → Budget · Branch master · Collections & payments forecast · Debt schedule & covenants)

Built from the dashboard's own caches — nothing here calls Zoho, except "Fetch from Zoho" for a financial year of Branch P&L account transactions (`ops.plPrefetch`, background, about one call per mapped account). `server/index.js` hands the readers in through `init({ ops })`; `lib/sources.js` holds them. Amounts are kept in rupees; budget and forecast views are returned in ₹ lakh.

- **Budget** (`lib/budget.js`) — versions with settings, freeze / unfreeze, cell overrides (`rowId|month`), manual lines. Revenue: each client's Zoho billing before GST in the base month (or 3-month average), carried to the client's end date (pro-rated by day) with escalation from the date given; clients without an end date are projected to the budget end (setting) and flagged; invoices to Dev Accelerator itself are left out; a base month far above the client's usual month is flagged as a possible one-off. Rent: every Rent Recurring Module agreement (branch + landlord + office) at the covering module amount, then the increment % once a year after the last module (an increment on or before the module's start is already in its amount), to the end date given on "Rent agreements" or the module's agreement end. Branches with Zoho rent bills but no module row are carried at the base-month amount and flagged. Other heads of the Branch P&L mapping: 12-month trend (held within ±50% of the average), 12- or 3-month average, last month or nil per head; loan interest from the debt schedule when entered. Billing is compared with published revenue for the reported quarters of the current year.
- **Budget vs actual** (`/budget/vs-actual`, CFO Overview, Financial Performance) — only for statement periods the version covers in full. The budget is on the books' basis (rent is an expense); the published P&L follows Ind AS 116, so budget rent is compared with lease payments in the cash flow and budget EBITDA with lease-adjusted EBITDA.
- **Branch master** (`lib/branches.js`) — name, city, state, address, model, SEZ / Non-SEZ, super built-up and carpet area, seats, expense and revenue start dates, status. Suggestions from the branch list, Finance Overview capacity and the Rent module are never saved without review. Seats and super built-up area feed the per-seat / per-sq-ft ratios from the revenue start date unless the branch has its own capacity rows.
- **Collections & payments forecast** (`lib/forecast.js`) — per client, median days invoice → payment over the last 12 months, usual invoice day, GST factor and TDS share; per vendor, median days bill → payment. Open invoices and bills on those days; budget billing collected the same way (the current month less what is already invoiced); rent on the agreement's payment day after TDS (the current month less rent already billed); other budget expenses after a lag and net factor per head; debt service on due dates; manual lines. Invoices past their expected date are expected this month unless more than 60 days late (then listed as doubtful); bills past their expected date are paid this month. Opening cash: the balance entered, else balance-sheet cash with a warning.
- **Debt schedule & covenants** (`lib/debt.js`) — facilities, repayment schedule (uploaded, entered, or generated: EMI, equal principal, bullet; actual/365), covenants exactly as agreed and tested values. Feeds the forecast, the scheduled principal in DSCR and the lender-defined DSCR in Ratio Analytics (`ratioInputs()` in `index.js`).

## Zoho Books ledger, account mapping and provisional statements (Account Mapping tab, Sync Monitor)

Open periods (after the latest final workbook) are reported from Zoho Books; a final workbook placed in the folder and imported becomes the source for every figure it covers. Read only — nothing is written to Zoho.

- **Ledger** (`lib/gl.js`) — chart of accounts; trial balances as at 31 Mar 2025, 31 Mar 2026 and the cut-off date (`/reports/trialbalance` with `filter_by=TransactionDate.CustomDate` and `to_date` only — without the filter Zoho ignores the date and answers as at today); every month's debit / credit by account from April 2025 (`/reports/generalledger`, the current month to the cut-off date). Balances = opening trial balance + months, checked against Zoho's trial balance on every run.
  - Initial run: all of the above + the record index (journals listed; invoices, bills, payments, credits from the dashboard's sync caches). About 80 calls.
  - Hourly run (minute 45, India time; office PC timer `startScheduler()`, Vercel cron `/api/cron/fin-gl`): records modified since the checkpoint (journals, invoices, bills, credit notes, vendor credits, payments sorted by `last_modified_time`; expenses through Zoho's `last_modified_time` filter); the months they touch (old date and new date, from the record index); the open months; the trial-balance check. The first run of each India day re-reads every month and the chart of accounts — a deletion never appears in a "modified since" list. Months are replaced whole and records keyed by Zoho id, so nothing is counted twice; the checkpoint moves only after the whole run is saved (`gl_pending` resumes a run cut short).
- **Mapping** (`lib/xlformula.js`, `lib/wbtrace.js`, `lib/acmap.js`) — built from a final workbook's trial-balance sheet (TB S26 in the Q2 FY27 workbook): every balance-sheet / P&L line and note item is traced through the workbook's formulas (SUMIF on the Grouping column, VLOOKUP by ledger name, direct references, schedules) to the ledgers it adds up, with the workbook's signs, splits and subtotals. Typed figures are kept apart: opening balances from the comparative column (carried in that year), typed splits between two lines (allocations, carried in that year), everything else and the OBE column = workbook-only adjustments (listed). Ledgers the formulas never reach are placed by their grouping (FA → PPE, CWIP, Fixed Deposit split as classified) and flagged. Two workbook formula issues are handled and listed: rupees summed into a lakh total (read as lakh) and loans added to non-current borrowings with the wrong sign and cancelled by a typed figure (re-pointed). Self-check: the mapping on the TB sheet + workbook-only parts reproduces every line; what is left is a schedule that differs from Zoho's ledgers (fixed-asset register vs ledgers).
  - Edits (`acmap_edits`, right "Adjustments & source decisions"): line, note, sign, exclude, reviewed — kept for every later sync. Zoho accounts the workbook does not have are placed by their parent account's mapping when there is one (suggested) or shown on "awaiting mapping" lines; never dropped.
- **Figures** (`lib/live.js`) — role `zoho` ("Provisional – Zoho Books"): Zoho's balances through the mapping for every period from FY 2025-26 (other equity and deferred tax in Zoho's own terms, so the balance sheet balances); role `live` (default view of an open period): final figures rolled forward with Zoho's movement since the latest final date (31 Mar 2027 column = final 30 Sep 2026 balance sheet + movement to the cut-off; 9M = final H1 + Zoho Q3). Provisional cash flow (indirect method; half year, nine months, year) from the balance sheets at both ends — closing cash agrees with the balance sheet; items needing a schedule are flagged. Notes from the ledgers mapped to each item. Lines Zoho usually gets at the quarter end (depreciation, tax, interest accruals) are marked pending when nil in an open quarter.
- **Priority** (`lib/model.js`): a workbook figure, then one derived from workbook figures, then the provisional figure of an open period, then Zoho's own figure only for a period no workbook reports. Exports carry the source, cut-off date and last sync. Routes: `lib/zohoRoutes.js` (`/gl/status`, `/gl/run`, `/mapping`, `/mapping/build`, `/mapping/edit`, `/mapping/review`, `/mapping/recon`, `/mapping/export`).

## Files

| File | Purpose |
|---|---|
| `lib/extract.js` | Reads one workbook: statement types from titles, period columns from headings, components / working columns skipped, every figure with cell, formula, error, plug and source-side derivation |
| `lib/lines.js`, `lib/periods.js` | Canonical statement lines (matched by meaning in context) and Indian-FY periods |
| `lib/build.js` | Several extractions → one version (facts, notes linked to lines by meaning, narrative notes, issues) |
| `lib/model.js` | Which figure is shown, alternatives, derived periods |
| `lib/recon.js` | Data validation & reconciliation |
| `lib/compare.js`, `lib/ratios.js`, `lib/views.js` | Comparisons, ratio dictionary and calculations, notes view, CFO overview, alerts |
| `lib/inputs.js`, `lib/exporter.js`, `lib/store.js` | Management inputs, Excel exports, storage (`server/fin-reporting/data` on the PC, `fsr_*` keys in Neon online) |
| `lib/sources.js`, `lib/budget.js`, `lib/forecast.js`, `lib/debt.js`, `lib/branches.js` | Planning: dashboard data readers, budget, collections & payments forecast, debt schedule & covenants, branch master |
| `lib/gl.js`, `lib/xlformula.js`, `lib/wbtrace.js`, `lib/acmap.js`, `lib/live.js`, `lib/zohoRoutes.js` | Zoho Books ledger sync, formula parser and tracer, account mapping, provisional figures, their routes |
| `tests/` | `npm run test:fin-reporting` (real-workbook checks run when the folder is present; `planning.test.js` uses made-up data) |
