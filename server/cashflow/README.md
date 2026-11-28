# Management Cash Flow

What we planned to pay each month, which bills came, whether payment was initiated on time, what was actually paid, and what still needs action. Every total opens the transactions behind it. In the sidebar it sits under **Finance Overview → Management Cash Flow**. The page is `client/src/pages/CashFlow.js`, and its parts are in `client/src/pages/cashflow/`.

Phase 1 covers three outflow categories, each with its own tab: **Brokerage Charges**, **Rent Expense** and **Electricity Charges**, plus the monthly overview. The other inflow and outflow categories follow once these three are reviewed.

## Where the figures come from

Zoho Books is only **read**: there is a GET client and nothing else.

| What | Source |
|---|---|
| Bill, payment, vendor and customer lists | The dashboard's central sync: `bills_fy` (and its future bills), `bills_open`, `bills_overdue`, `vendor_payments_fy`, `vendors_all` and `invoices_fy`. These cost no Zoho call here. |
| A bill's lines, payments, credits and TDS | `GET /bills/{id}`, paced at about 50 a minute, and only for bills that may belong to a category. A bill is read again only when Zoho changes its last-modified time, balance, status or total. |
| Category of a bill line | Its expense account. "Office Rent", "Brokerage Charges", "Electricity Expense" or **any account under them** in Zoho's chart of accounts (read daily, active and inactive accounts). Settings → Categories changes the root accounts. |
| Which bills are read in detail | The bill's "Vendor Category" (Landlord, Electricity, Brokrage), the vendor master's category (Rent/Maint. Vendors, Brokers), words in the vendor name (electricity providers), or a vendor that had a bill of the category before. |
| Payment initiation | Records the team enters (date, amount, reference, status), plus **Finance Portal "vendor payment" requests raised against the bill**. A request that is pending or in progress counts as initiated, completed counts as settled, and rejected counts as cancelled. |

A bill with lines of two categories (a landlord bill with rent and an electricity recharge) gives one part per category. Each part carries its share of the bill: its lines with GST over all lines. That share also splits the payments, credits and Zoho's balance. Maintenance and other lines stay out.

## Calculation rules

| Figure | Rule |
|---|---|
| Outstanding before advance adjustment | Net payable (after TDS) − direct payments − credit notes applied. Each deduction is counted once. |
| Final bill outstanding | Outstanding before advance − advances applied to this bill. A payment made **before the bill's date** is an advance. Its cash counts on the day it was paid; applying it (Zoho's apply date) only lowers the bill. |
| Initiated and pending | Initiations not yet settled by a Zoho payment made on or after them, first in first out. Failed or cancelled ones never count. It is at most the final outstanding. |
| Still to initiate | min(scheduled amount not yet paid, final outstanding) − initiated and pending. Without a schedule, the whole net payable is scheduled on the due date (or the bill date). |
| Remaining monthly budget | Finalised budget − cash payments allocated to it (bill payments, advances applied, and advances linked to the line). Negative means exceeded, and it is flagged. |
| Awaiting bill | The whole budget while no bill is linked. Once a bill is linked, only when **more bills are expected**. Otherwise the difference stays visible as "budget not billed (review)". |
| Cash outflow of a month | Payments by their payment date, whatever month they were planned for. Advance money not yet applied counts once, as the advance. |
| Month-end vs current | Month-end shows everything as it stood on the month's last day. Current shows it as it stands today. A November bill paid on 3 December is outstanding at 30 November, "paid after month-end" today, and its cash is December's. It is also one of December's opening dues. |

**Planned payment month of a bill:** the month the team set, else its linked budget line's month, else the due-date month (or the bill month). Earlier bills still unpaid at the start of the month come in as **opening dues** (tagged with the month they were planned for).

**Linking bills to budget lines:**
- A link the team chose is kept, and so is "no budget".
- Otherwise the best fit of the same company and category wins: same vendor, client, branch and month.
- Rent and electricity link only within the bill's own month.
- A brokerage commitment naming the broker or client reaches two months either way.
- A commitment for one bill takes one bill, unless more bills are expected.
- Bills without a link stay visible as "received without a linked budget".

## Manual entries

They are kept per company in `plan_<company>`: budgets with their original figure, links, planned months, client names, meters, instalments, initiations, remarks, advance links and payment advice slips. A refresh from Zoho never touches them, and Zoho records are keyed by Zoho's ids, so nothing is duplicated. Every change goes to the module's activity log (`audit_<YYYY-MM>`).

## Rights (User Settings → Management Cash Flow)

| Right | Allows |
|---|---|
| Module ticked | Seeing the overview, the tabs, the drill-downs and the financial-year grid |
| Plan | Budgets and commitments, Pay On date and amount (instalments), links, planned month, client, meter, remarks, advance links |
| Payments | Initiation records and their status, payment advice slips |
| Configure | Category accounts and rules, refresh from Zoho |

Admins have every right. The module is shown only to admins and to users ticked for it.

## Data and schedule

- **Office PC:** `server/cashflow/data/*.json` and `server/cashflow/files/<sha256>` (slips). Both are git-ignored. The scheduler runs every 30 minutes, starting about 3 minutes after the server starts.
- **Vercel:** Neon `kv_store` keys `cf_*`, and private Blob `cashflow/<sha256>`. `/api/cron/cashflow` runs every 15 minutes (`vercel.json`, Bearer `CRON_SECRET`), each step about 230 s. The first full read of a year takes several steps (about 3,000 bills for DevX at about 50 a minute).

## Tests

`npm run test:cashflow` runs:
- the calculation rules, with the brief's example and the four cases (missing bill, partial payment, advance adjustment, payment settled in a later month);
- the classifier;
- reading Zoho through a stand-in;
- the API.
