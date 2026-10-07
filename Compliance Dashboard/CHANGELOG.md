# Compliance Dashboard — CHANGELOG

## 1.0.0 — 03-10-2026

First release of the real module, built into the Finance Suite. It replaces the blank page behind the *Compliance Dashboard* sidebar item.

**Dashboard**
- Dependent filters: FY → Company → Half → Quarter → Month → Module. Quarter and Half are derived from the Month; invalid combinations can't be selected.
- 8 KPI cards: Total, Completed, Pending, Overdue, Due Soon, In Progress, N/A, Compliance % = Completed ÷ (Total − N/A).
- Reports: company-wise, module-wise, upcoming (7/15/30 days), overdue, drilldown Company → Module → Compliance → Task. All exportable to Excel.
- Task table and task panel: status, completion date, remarks, people, documents, links and audit trail.
- Search by Task ID, company, compliance, person or document name, within the period or across all periods.
- Zoho Books period sync per Company + FY + Month: stored data is reused, and Zoho is only called on an explicit click. Shows “x of y periods synced” for wider selections.

**Master**
- Company Master, Compliance Master (with Due Date Rule language and a date check), Company Applicability (pushes changes to open tasks), Task Data (Generate Tasks without duplicates, manual entry, delete), Folder Setup, Lists / Settings, Users and Roles, Audit Trail, Instructions.
- Excel template, export and two-step import (Preview → Confirm with automatic backup), blank = unchanged, `#CLEAR`, bulk update by Task ID, downloadable error report.

**Documents**
- Automatic filing to `ROOT / COMPANY / FY / MODULE / Qn / Month / Challan | Receipt | Other Data`.
- SHA-256 duplicate check, allowed file types with a content check, size limit, sanitised names, path-traversal guard.
- Served only through logged-in API calls with company-level permission. Replaced and deleted files are archived. Every action is audited.

**Seed data** (verify before use)
- Companies: Dev Accelerator Limited (DEVX), Needle And Thread Designs LLP (NTD), Saasjoy Solutions Pvt Ltd (SAAS).
- GST: GSTR-1, GSTR-3B, GST payment, ITC reconciliation, GSTR-9, GSTR-9C. Payroll: PF, ESIC, PT, LWF. TDS: payment, 24Q, 26Q, Form 16A, Form 16.

**Existing files touched:** `client/src/App.js`, `server/index.js`, `server/auth.js`, `package.json`, `.gitignore` (details in FILE_MAP.md).
