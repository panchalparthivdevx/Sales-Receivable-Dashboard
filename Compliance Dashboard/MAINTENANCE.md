# Compliance Dashboard — MAINTENANCE

Simple steps for the everyday changes. “Master ›” means the **Master** tab of the Compliance Dashboard.

---

## Users and passwords

**Add a user**
1. Master › **Users and Roles** › **Add User** (app Administrators only).
2. Enter username, name, a password (at least 8 characters) and the compliance role.
3. Optional: tick companies to limit what they can see. Leave all unticked for all companies.
4. Give them the password privately. The new login can open only the Compliance Dashboard. To give it more modules, use the app's **User Settings**.

**Give an existing user a role** — Master › Users and Roles › **Role** next to the person › choose the role and companies › Save.

**Reset a password** — Master › Users and Roles › key icon › type the new password › Reset password.

**Disable a user** — Master › Users and Roles › red icon. Enable again with the green icon. You cannot disable yourself or the last admin.

**Change what a role may do** — Master › **Lists / Settings** › *Roles and permissions* › tick/untick › **Save**. Permissions:
- *Edit tasks* — status, remarks, completion date, upload documents
- *Replace / delete documents*
- *Edit master* — masters, applicability, generate tasks, folder setup
- *Import Excel*
- *Admin* — settings, users and roles, audit trail

App Administrators are always compliance Admins. Users without a role get the *default role* (Viewer to start with).

---

## Due Date Rule syntax

Write it in Master › Compliance Master › Edit › **Due Date Rule**. Click **Check dates** to see the dates it produces before saving.

| Rule | Meaning |
|---|---|
| `11th of following month` | day 11 of the month after the period |
| `20 of next month` | same as “following month” |
| `last day of following month` | last day of the month after the period |
| `7th of same month` | day 7 of the period’s own last month |
| `15th of 2 months after` | day 15, two months after the period |
| `31-Jul` | the first 31 July after the period ends (good for yearly items) |
| `7th of following month; MAR=30-Apr` | a default plus a special date for March |
| `Q1=31-Jul; Q2=31-Oct; Q3=31-Jan; Q4=31-May` | one date per quarter |

- Parts are separated by `;`. A special date is `PERIOD=date`, where PERIOD is `APR`…`MAR`, `Q1`…`Q4`, `H1`, `H2` or `FY`.
- Days never spill into the next month: the 31st in February becomes the 28th or 29th.
- Changing a rule re-dates the **open** tasks whose date came from the rule. Dates typed by hand and completed tasks are kept.
- For something that applies only in some months (for example LWF in June and December), keep Frequency = Monthly and fill **Applicable Months** (`JUN,DEC`).

---

## Add a new module (for example ESI, PF or ROC)

No code change is needed.
1. Master › Lists / Settings › *Modules* › **Add module** › key and label (for example `ROC`), folder (for example `Other Compliance`) › **Save**.
2. Master › Compliance Master › **Add Compliance** for each item (module = ROC).
3. Master › Company Applicability › set Yes/No and people.
4. Master › Task Data › Generate Tasks.
5. Optional: add a top-level folder for it in Lists / Settings › *Folder modules*, set it as the module's folder, then run Folder Setup.

## Add a new Financial Year

Master › Lists / Settings › *Financial Years* › type `2028-29` › Add › **Save**. Then Folder Setup (choose the new year) and Generate Tasks.

## Change the storage folder (Storage Root)

Master › Lists / Settings › *Storage* › **Storage Root** › for example `D:\Compliance Documents` › **Save**.
- Existing files are **not** moved. To move them, first copy the whole old folder (with everything inside) into the new location, then change the setting. The paths inside stay the same.
- Run Folder Setup again for the new location.
- The folder must not be a shared or public web folder. Documents are served only through the app's login.

## Add a document type

Master › Lists / Settings › *Document Types* › Add › Save. A type containing “Challan” goes to the Challan folder, one containing “Receipt” to Receipt, everything else to Other Data.

## Change thresholds

Master › Lists / Settings › *Thresholds and uploads*: Due Soon days, Upcoming report tabs, maximum upload size, allowed file types, and whether the same file may sit on two tasks. Program files (`.exe`, `.bat`, `.js`, `.html` …) can never be allowed.

---

## Backup and restore

**Automatic:** every Excel import takes a backup first, in `server/compliance/backups/`. The newest 30 are kept.

**Manual backup (recommended weekly):** copy these to a safe place:
- the folder `server/compliance/data/` (all compliance records, audit trail, Zoho cache, settings)
- your **Storage Root** folder (the documents)
- `server/compliance/config/` (your default settings)

**Restore:**
1. Close the server window.
2. To undo an import: copy the backup file you want from `server/compliance/backups/` to `server/compliance/data/compliance_data.json` (replace it).
   To restore a manual backup: copy the saved `data` folder back over `server/compliance/data/`.
3. Start the server again (`start-server.bat`).

---

## Edit reports or add fields (for a developer)

- **Columns** of every master, task sheet, task table and export are listed once in `server/compliance/lib/columns.js`. Add a column there; the template, import, export and UI header pick it up together. Add the field's validation in `lib/masters.js` (masters) or `lib/tasks.js` (tasks) so manual entry and import both check it.
- **KPIs and reports**: `server/compliance/lib/reports.js` (period filtering, company/module groups, upcoming, overdue) and `lib/statusEngine.js` (statuses, Compliance %). Screens: `client/src/pages/compliance/Reports.js`.
- **Data shape changes**: add a migration in `server/compliance/schema/migrations.js` (see `SCHEMA.md`).
- After server changes restart the server. After client changes rebuild (see INSTALL.md). Then run `npm run test:compliance`.

## Zoho Books mapping

What *Sync Selected Period* reads is in `server/compliance/config/compliance.config.json` → `zoho.entities`. Each entry is the Zoho list API path, the list name, the date field, the amount field, the statuses to leave out and the modules it belongs to. Zoho is called only when someone clicks a Sync button. A period that was synced before is never fetched again unless someone clicks **Sync again**. The app-wide **Sync Monitor** (Full Sync) is separate and unchanged.

## Where to look when something goes wrong

- **Master › Audit Trail** — who changed what, and when.
- The server window — errors start with `[compliance]`.
- “The dashboard server is running an older version” — restart the server.
