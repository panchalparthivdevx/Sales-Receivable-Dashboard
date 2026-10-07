# Compliance Dashboard — data schema

Storage follows the rest of the app (`server/db.js`):

| Mode | Where |
|---|---|
| Local (no `DATABASE_URL`) | JSON files in `server/compliance/data/` (override with env `COMPLIANCE_DATA_DIR`) |
| Neon PostgreSQL (`DATABASE_URL` set) | rows in the existing `kv_store` table, keys below |

Every write goes through `lib/store.js → transaction()`: one writer at a time, each document written once at the end, atomically (temp file + rename) in local mode.

| Store document | File / kv key | Holds |
|---|---|---|
| data | `compliance_data` | masters, tasks, documents, folders, user roles |
| audit | `compliance_audit` | audit trail (newest last, capped at `audit_max_entries`) |
| zoho | `compliance_zoho_sync` | Zoho period cache |
| settings | `compliance_settings` | settings changed in the app (override `config/compliance.config.json`) |

Schema version: `compliance_data.schema_version` (latest = 1). Migrations: `schema/migrations.js` — append a new migration to change the shape; never edit an old one. A backup is taken before any migration runs on existing data.

## compliance_data

```
schema_version  number
companies[]     { id 'CO-001', name, short_code 'DEVX', status 'Active'|'Inactive', zoho_org_id, remarks,
                  created_at, created_by, updated_at, updated_by }
compliances[]   { id 'GST002', name, module 'GST', frequency 'Monthly'|'Quarterly'|'Half-Yearly'|'Annual',
                  due_rule '20th of following month', form_name, active_months 'JUN,DEC'|'' , statutory bool,
                  remarks, active bool, created_*, updated_* }
applicability[] { company_id, compliance_id, applicable 'Yes'|'No', responsible, reviewer, remarks, created_*, updated_* }
tasks[]         { task_id 'DEVX-GST002-2026-27-AUG', company_id, compliance_id, fy '2026-27',
                  period_key 'AUG'|'Q1'|'H1'|'FY', month 'AUG' (period's last month — the period identity),
                  due_date 'YYYY-MM-DD', due_date_source 'rule'|'manual',
                  applicable bool, na_source 'applicability'|'manual'|null,
                  status 'Not Started'|'In Progress'|'Completed', completion_date 'YYYY-MM-DD'|'',
                  responsible, reviewer, remarks, source 'generated'|'manual'|'import', created_*, updated_* }
documents[]     { id (24 hex, random), task_id, kind 'file'|'link', doc_type, company_id, compliance_id, fy, module, month,
                  original_name, stored_name, stored_path (relative to storage root), folder, size, mime, sha256,
                  url (links), title (links), uploaded_by, uploaded_by_id, uploaded_at, replaced_at, replaced_by, version }
folders[]       { company_id, fy, module, quarter, month, path, created_at, created_by }
user_roles[]    { user_id, username, role, companies [] (empty = all), updated_at, updated_by }
```

Never stored (always calculated when read): Quarter, Half Year, Due Soon, Overdue, Compliance %.

Identity rules: a task is unique on `company_id + compliance_id + fy + period_key`; `task_id` is unique.

## compliance_audit

```
[{ id, at ISO, user, user_id, action, entity, entity_id, summary, changes [{ field, from, to }], task_id? }]
```

## compliance_zoho_sync

```
{ periods: { 'CO-001|2026-27|AUG': { company_id, fy, month, org_id, from, to, synced_at, synced_by,
                                     ok, partial, api_calls, errors [],
                                     entities: { invoices: { count, amount, by_status, excluded, truncated }, … } } } }
```

## Column definitions

All Excel/UI columns are defined once in `lib/columns.js`.
