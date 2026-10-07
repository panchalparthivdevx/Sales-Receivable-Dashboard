# Compliance Dashboard — README

The Compliance Dashboard is part of the Dev Accelerator Finance Suite. Open it from the sidebar: **Compliance Dashboard** (shield icon).

It tracks every statutory compliance (GST, Payroll, TDS — more can be added) for every company, month by month: what is due, who is responsible, what is done, the proof (challans, receipts) and the matching Zoho Books figures.

The file `compliance_tracker_prototype_1.html` in this folder was only the logic sample. The real module is built into the app in the Finance Suite design.

---

## The two tabs

### Dashboard
1. **Filters** (left to right): Financial Year → Company → Half Year → Quarter → Month → Module.
   - Choosing a Month fills in its Quarter and Half Year automatically.
   - H1 allows only Q1 and Q2; H2 only Q3 and Q4. A quarter allows only its three months. Options that don't fit are greyed out, so a wrong pair like *August + Q1* cannot be picked.
2. **Zoho Books line** (right of the filters): *✓ Synced — Last Synced …* or *○ Not Synced [Sync Selected Period]*. For a wider selection it says *x of y periods synced*. Zoho is **only** contacted when you click a Sync button.
3. **Eight KPI cards**: Total, Completed, Pending, Overdue, Due Soon, In Progress, Not Applicable, Compliance %. Click a card to list those tasks.
4. **Reports**: Company-wise, Module-wise, Upcoming (7 / 15 / 30 days), Overdue, and a Drilldown (Company → Module → Compliance → Task). Every report has **Export**. Clicking a row filters the task table.
5. **Zoho Books — Period Data**: invoices, credit notes, bills and vendor payments (count and amount) for the synced periods.
6. **Tasks table**: click a row to open the task. There you can change the status, completion date, remarks and people, upload documents or add links, and see the full history.
7. **Search**: Task ID, company, compliance, person or document name. Tick **All periods** to search beyond the selected period.

### Master
Top buttons: **Download Excel Template**, **Import Excel**, **Manual Entry** (and **Export Master Data**).

| Section | What it is for |
|---|---|
| Company Master | Companies, Short Code (starts every Task ID), Zoho Books organisation ID |
| Compliance Master | Each compliance: module, frequency, **Due Date Rule**, form name, remarks |
| Company Applicability | Which compliance applies to which company, Responsible, Reviewer |
| Task Data | **Generate Tasks** for a year/period, list, open or delete tasks |
| Folder Setup | Create the document folders for a company and year |
| Lists / Settings | Years, modules, document types, storage folder, Due Soon days, upload rules, roles |
| Users and Roles | Who can do what; add users, reset passwords, disable users |
| Audit Trail | Every change: who, what, when |
| Instructions | This guide, inside the app |

---

## Rules worth knowing

- **Status**: you set *Not Started*, *In Progress* or *Completed*. *Due Soon* and *Overdue* are calculated each time the page opens — they are never saved. *N/A* comes from Company Applicability = No.
- **Compliance %** = Completed ÷ (Total − N/A). N/A never counts against you.
- **TDS payment and TDS return** are separate compliances (separate tasks).
- **Task ID** = `COMPANY-COMPLIANCE-FY-PERIOD`, e.g. `DEVX-GST002-2026-27-AUG`, `DEVX-TDS003-2026-27-Q1`.
- **Quarterly / yearly items** sit in the last month of their period (the Q1 TDS return is under June, GSTR-9 under March).
- **Documents** go to `ROOT / COMPANY / FY 2026-27 / MODULE / Q2 / August / Challan | Receipt | Other Data` automatically, by type. The same file can't be uploaded twice. Documents open only for signed-in users with access to that company. Every view, download, replace and delete is logged.

---

## First-time setup (do these in order)

1. **Master › Lists / Settings › Storage** — set the **Storage Root** to your final documents folder (for example `D:\Compliance Documents`) and click **Save**. (Until then documents go to the `compliance_storage` folder inside the project.)
2. **Master › Company Master** — check names, Short Codes and Zoho Org IDs. *Saasjoy* has no Zoho Org ID yet.
3. **Master › Compliance Master** — check every rule (see “What you must verify” below).
4. **Master › Company Applicability** — set *No* where something does not apply; fill Responsible and Reviewer.
5. **Master › Users and Roles** — give your team roles. Everyone who is not an app Administrator starts as **Viewer**.
6. **Master › Task Data › Generate Tasks** — choose FY 2026-27, click **Preview**, then **Generate**.
7. **Master › Folder Setup** — All active companies, FY 2026-27, tick the modules, **Create Folder Structure**.
8. Past months will show as Overdue until marked done. To mark many at once: **Export Master Data** → in the *Tasks* sheet set Status = Completed and the Completion Date → **Import Excel**.

> Generate tasks only **after** checking the Compliance Master: a compliance's Frequency and Module are locked once it has tasks (rules and dates can still be changed).

---

## What you must verify

These are **starting values**. They are marked “VERIFY BEFORE USE” in the Compliance Master.

1. **Statutory due dates** — GSTR-1 (11th), GSTR-3B and GST payment (20th; QRMP filers differ), GSTR-9 / 9C (31-Dec; check notifications and turnover limits), PF and ESIC (15th), TDS payment (7th; March = 30-Apr), 24Q / 26Q (31-Jul, 31-Oct, 31-Jan, 31-May), Form 16A (15 days after the return), Form 16 (15-Jun). Form names and numbers may change under the **Income-tax Act, 2025** (in force from 1-Apr-2026).
2. **State-specific items** — **Professional Tax** (set to the 15th of the following month, Gujarat-style) and **Labour Welfare Fund** (set to June and December wages, due on the 15th of the following month). Change them to each company's state rules.
3. **ITC Reconciliation (GST004)** is an internal deadline (18th), not a statutory one.
4. **Applicability** — every compliance starts as *Yes* for all three companies. In particular check GSTR-9C (turnover threshold) and payroll items for each entity.
5. **Companies** — legal names, Short Codes (DEVX, NTD, SAAS) and Zoho Org IDs (Dev Accelerator 60027116474, Needle And Thread 60007894213, Saasjoy: blank).
6. **Zoho field mapping** — *Sync Selected Period* reads Sales Invoices, Credit Notes, Purchase Bills (date / total) and Vendor Payments (date / amount), and leaves out void and draft documents. For Dev Accelerator, August 2026 was checked against the app's central Zoho sync and matched exactly. Check one month for **Needle And Thread** yourself (it is a different Zoho organisation).
7. **Roles** — Admin, Manager, Editor, Viewer permissions (Lists / Settings › Roles) suit your team.

---

## More documents in this folder

- `INSTALL.md` — how to start it / install it
- `MAINTENANCE.md` — users, passwords, backups, adding fields and modules, rule syntax, storage folder
- `FILE_MAP.md` — which file does what, and which existing files were changed
- `CHANGELOG.md` — what changed
- `TEST_RESULTS.md` — test results
