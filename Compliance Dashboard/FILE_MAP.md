# Compliance Dashboard — FILE MAP

## Where things live

| Topic | File(s) |
|---|---|
| **Login** (shared with the whole app) | `server/auth.js` (JWT, `authMiddleware`), `client/src/contexts/AuthContext.js` |
| **Compliance roles & permissions, company access** | `server/compliance/lib/access.js` |
| **User data** (logins) | `server/users.json` (app-wide). Compliance role per user: `server/compliance/data/compliance_data.json → user_roles` |
| **Users & roles screens** | `client/src/pages/compliance/master/UsersRoles.js`, API in `server/compliance/index.js` (`/users…`) |
| **Period logic** (month → quarter → half, FY) | `server/compliance/lib/period.js` (server), `client/src/pages/compliance/filterLogic.js` (dependent filters) |
| **Due-date rules** | `server/compliance/lib/dueDateRules.js` |
| **Status engine & KPI maths** | `server/compliance/lib/statusEngine.js` |
| **Task generation** | `server/compliance/lib/taskGenerator.js` |
| **Task create / update rules** (manual entry + import) | `server/compliance/lib/tasks.js` |
| **Masters** (company, compliance, applicability) | `server/compliance/lib/masters.js` |
| **Column definitions** (single source for template, import, export, UI) | `server/compliance/lib/columns.js` |
| **Excel template / import / export / error report** | `server/compliance/lib/importExport.js`; screens `client/src/pages/compliance/master/ImportDialog.js`; table exports `client/src/pages/compliance/ui.js → exportXlsx` |
| **Reports** (period filter, company-wise, module-wise, upcoming, overdue) | `server/compliance/lib/reports.js`; screens `client/src/pages/compliance/Reports.js` |
| **Zoho period sync & cache** | `server/compliance/lib/zohoSync.js`; config `compliance.config.json → zoho`; screen `client/src/pages/compliance/ZohoPanel.js` |
| **Upload, download, replace, delete** | `server/compliance/index.js` (`/tasks/:id/documents`, `/documents/:id/…`), rules in `server/compliance/lib/documents.js`; screen `client/src/pages/compliance/TaskDetail.js` |
| **Folder structure & upload routing** | `server/compliance/lib/documents.js`; screen `client/src/pages/compliance/master/FolderSetup.js` |
| **Audit trail** | `server/compliance/lib/audit.js`; screen `client/src/pages/compliance/master/AuditTrail.js` |
| **Storage, backups, write lock** | `server/compliance/lib/store.js` |
| **Settings** (defaults + saved overrides) | defaults `server/compliance/config/compliance.config.json`; logic `server/compliance/lib/settings.js`; screen `client/src/pages/compliance/master/SettingsLists.js` |
| **Starting data** (companies, compliances) | `server/compliance/config/seed.json` (used once, by migration v1) |
| **Data schema & migrations** | `server/compliance/schema/SCHEMA.md`, `server/compliance/schema/migrations.js` |
| **All API routes** (`/api/compliance/…`) | `server/compliance/index.js` |
| **Client API calls** | `client/src/pages/compliance/complianceApi.js` |
| **Design tokens** (colours, fonts, status colours) | `client/src/theme.js` |
| **Tests** | `server/compliance/tests/*.test.js` — run `npm run test:compliance` |

## Runtime data (created automatically, not in git)

| Path | Contents |
|---|---|
| `server/compliance/data/compliance_data.json` | companies, compliances, applicability, tasks, documents index, folders, user roles |
| `server/compliance/data/compliance_audit.json` | audit trail |
| `server/compliance/data/compliance_zoho_sync.json` | Zoho period cache (Company + FY + Month) |
| `server/compliance/data/compliance_settings.json` | settings saved in the app |
| `server/compliance/backups/` | automatic backups before each import |
| Storage Root (default `compliance_storage/`) | the documents, plus `_archive/` for replaced/deleted files |

## New files

```
server/compliance/
  index.js                         API router (mounted at /api/compliance)
  config/compliance.config.json    default settings (lists, roles, thresholds, Zoho mapping)
  config/seed.json                 starting companies + GST/Payroll/TDS compliances
  lib/period.js  dueDateRules.js  statusEngine.js  fields.js  masters.js  tasks.js
  lib/taskGenerator.js  reports.js  columns.js  importExport.js  zohoSync.js
  lib/documents.js  access.js  audit.js  settings.js  store.js
  schema/migrations.js  schema/SCHEMA.md
  tests/helpers.js  period.test.js  rules_status.test.js  isolation.test.js
  tests/import.test.js  zoho_documents.test.js  api.test.js

client/src/theme.js                                   shared Finance Suite tokens
client/src/pages/ComplianceDashboard.js               page shell (header, Dashboard / Master tabs)
client/src/pages/compliance/
  complianceApi.js  ui.js  filterLogic.js  FilterBar.js  ZohoPanel.js  Reports.js
  TaskTable.js  TaskDetail.js  DashboardTab.js  MasterTab.js
  master/useMaster.js  Companies.js  Compliances.js  Applicability.js  TaskData.js
  master/FolderSetup.js  SettingsLists.js  UsersRoles.js  AuditTrail.js  Instructions.js
  master/ImportDialog.js  TaskEntryModal.js

Compliance Dashboard/README.md  INSTALL.md  MAINTENANCE.md  FILE_MAP.md  CHANGELOG.md  TEST_RESULTS.md
```

`client/src/pages/ComplianceDashboard.js` replaces the old page of the same name, which had already been deleted from the working folder (it was an old dark-theme payroll compliance view).

## Existing files changed

| File | Change |
|---|---|
| `client/src/App.js` | import `ComplianceDashboard`; route `page === 'compliance'`; `'compliance'` added to the access-denied list |
| `server/index.js` | one line: `app.use('/api/compliance', require('./compliance'))`, before the React catch-all |
| `server/auth.js` | `compliance` added back to the module permission list, so admins can switch it on/off per user in User Settings |
| `package.json` | script `test:compliance` |
| `.gitignore` | ignore `compliance_storage/`, `server/compliance/data/`, `server/compliance/backups/` (confidential/runtime) |

Not changed: `Sidebar.js` (it already had the Compliance Dashboard item with the shield-check icon), `index.css`, the GST / TDS / Payroll dashboards, the Zoho client (`server/zoho.js`), the sync engine and Sync Monitor.
