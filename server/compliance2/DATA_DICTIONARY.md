# Compliance Vr.2.0 — data dictionary

## Storage

- **Office PC:** JSON files in `server/compliance2/data/` (or `C2_DATA_DIR`). Each file is written atomically.
- **Online:** rows in Neon `kv_store`, with keys prefixed `c2_`. A change writes all the documents it touched in one
  database transaction. If another server instance changed one of them meanwhile, nothing is written and the change is
  run again on the fresh data.
- **Spaces:** `live` and `demo` never share a document or a stored file.

| Key (without `c2_`) | Holds |
|---|---|
| `<sp>_org` | `{ groups, entities, registrations, establishments, people }` |
| `<sp>_rules` | `{ catalogue_version, rules[], extensions[] }` |
| `<sp>_applic` | `{ records[] }` (applicability decisions) |
| `<sp>_events` | `{ events[] }` |
| `<sp>_tasks_<FY>` | `{ tasks[] }`, one document per financial year (e.g. `live_tasks_2026-27`) |
| `<sp>_docs` | `{ documents[] }` (records and versions; the files are in the file store) |
| `<sp>_team` | `{ rows[] }` (owner / backup / checker mapping) |
| `<sp>_meta` | initialised time; demo snapshot date |
| `<sp>_audit_<YYYY_MM>`, `<sp>_audit_tail` | the hash-chained audit trail |
| `settings` | `{ access: { userId: { entities[], period_from, period_to } }, soon_days, retention_years, max_upload_mb, link_ttl_seconds }` |
| `<sp>_folders` | OneDrive folder mapping (see "Document folders" below) |
| `onedrive` | Live only: `{ status: connected\|revoked\|disconnected, sealed (encrypted refresh token), account { name, upn, id }, connected_by, connected_at, scopes, last_error }`. Never a password. |
| `demo_graphsim` | The demo's simulated OneDrive |

**Files.** On the PC they are in `server/compliance2/files/<space>/<sha256>.c2e`; online in the private Blob
`compliance2/<space>/<sha256>.c2e`. Each file is AES-256-GCM encrypted: `"C2E1"` + key id + IV + tag + ciphertext. The name is
the SHA-256 of the original bytes.

## Records

### Entity `E-…`

| Field | Meaning |
|---|---|
| `legal_name`, `short_code`, `type` | `PRIVATE`, `PUBLIC`, `OPC`, `SECTION8`, `LLP`, `FOREIGN` or `OTHER`. |
| `pan`, `cin`, `llpin` | Checked on save. PAN and CIN / LLPIN are required before approval. |
| `listed` (`true` / `false` / `null`), `listing_type`, `exchanges[]` | `listing_type` is `equity`, `debt` (NCDs only) or `equity_and_debt`; equity-listing and debt-listing obligations use it. `null` = not recorded, so SEBI obligations show "needs review". |
| `incorporation_date`, `fy` | The FY is always April–March. |
| `flags{}` | `has_employees`, `has_exports`, `has_fdi`, `has_odi`, `has_ecb`, `has_international_transactions`, `has_specified_domestic_transactions`, `has_reportable_sft`, `has_msme_dues_over_45_days`, `has_deposit_or_loan_receipts`, `cost_audit_sector`, `secretarial_audit_required`, `consolidated_financials`, `has_secured_listed_ncds`, `high_value_debt_listed`. A missing flag = not recorded. |
| `fy_facts{ '2025-26': {...} }` | Threshold history: `turnover`, `net_worth`, `net_profit`, `paid_up_capital`, `borrowings`, `headcount`, `tax_audit_required`, `source`. |
| `data_status` | `illustrative` (demo), `draft` or `approved`. `approved_by` / `approved_at`. A material change after approval sends the record back to draft. |
| `name_history[]`, `warnings[]`, `rev` | `rev` is the version used against stale updates. |

### Registration `R-…`

| Field | Meaning |
|---|---|
| `entity_id`, `type` | `GST_REGULAR`, `GST_COMPOSITION`, `GST_ISD`, `GST_TDS`, `GST_TCS`, `GST_NRTP`, `GST_OIDAR`, `GST_CASUAL`, `TAN`, `PF`, `ESIC`, `PT_PTRC`, `PT_PTEC`, `LWF`, `IEC`, `SHOPS_EST`, `CONTRACT_LABOUR`, `FSSAI`, `TRADE_LICENCE`, `FIRE_NOC`, `POLLUTION`, `SEZ_UNIT` or `OTHER_LICENCE`. |
| `number`, `state` | Two-letter GST code. |
| `active_from`, `active_to` | `active_to` is also the expiry date for renewals. |
| `filing_frequency`, `regime` | Frequency: `monthly`, `quarterly`, `half_yearly` or `annual`. Regime: `regular`, `qrmp`, `composition` or `other`. |
| `jurisdiction`, `authority`, `portal_url` | Never a password. |
| `establishment_ids[]` | |
| `flags{}` | `uses_iff`, `deducts_salary`, `deducts_non_salary`, `deducts_non_resident`, `collects_tcs`. |
| `data_status`, `rev` | |

### Establishment `B-…`

`entity_id`, `name`, `kind`, `state`, `city`, `address`, `headcount`, `flags{ engages_contract_labour, pays_property_tax }`,
`active_from`, `active_to`, `data_status`.

### Person `P-…`

`name`, `din` (8 digits; shown masked), `dsc_expiry`, `roles[{ entity_id, designation }]`.

### Rule

| Field | Meaning |
|---|---|
| `id`, `name`, `category`, `nature` | Nature: `return`, `payment`, `return_payment`, `internal`, `event`, `renewal`, `notice` or `transaction`. |
| `scope` | `{ type: entity, entity_kinds }`, `{ type: registration, reg_types }`, `{ type: establishment }`, `{ type: person, with }` or `{ type: event, event_types }`. |
| `frequency` | `monthly`, `quarterly`, `half_yearly`, `annual`, `installments`, `event`, `renewal`, `transaction`, or `per_registration` (the registration's own periodicity). |
| `months_in_quarter`, `installments` | |
| `filing{ ack, payment_ref }` | |
| `evidence{ review[], close[], payment[] }` | Document types required at each stage. |
| `reference{ key, due_text, status, trigger }` | The catalogue row exactly as supplied. |
| `reference_sources[]`, `history[]` | |
| `versions[]` | See below. |

**Version fields:** `version`, `status`, `law`, `provision`, `form`, `authority`, `source_url`, `notification_no`,
`notification_date`, `standing_provision`, `retrieved_at`, `verified_by(_id)`, `verified_at`, `verification_note`,
`approved_by(_id)`, `approved_at`, `approval{ note, scope }`, `effective_from`, `effective_to`, `applicability` (test),
`due` (expression), `internal_offset_days`, `notes`.

**Version status:** `draft` → `verified` → `approved`, or `withdrawn` / `superseded`.

**Extension `X-…`**

| Field | Meaning |
|---|---|
| `rule_id`, `kind` | `deadline_extension` or `fee_waiver`. |
| `period_keys[]`, `scope{ states[], entity_ids[], registration_ids[] }` | |
| `new_due_date` | Deadline extensions only. |
| `waiver_note`, `issuer`, `notification_no`, `notification_date`, `source_url`, `retrieved_at` | |
| `status` | `draft`, `approved`, `archived`, `withdrawn` or `superseded`. Plus `created_by`, `approved_by` and `history[]`. |

### Applicability decision `A-…`

`rule_id`, `scope_type`, `scope_id`, `entity_id`, `status` (`applicable` / `not_applicable` / `needs_review`), `reason`,
`evidence`, `basis` (`manual`, `suggestion_accepted` or `demo`), `effective_from`, `effective_to`, `reviewer(_id)`,
`recorded_at`, `superseded`.

### Event `V-…`

`entity_id`, `registration_id`, `type` (AGM, NOTICE, HEARING, ORDER, MATERIAL_EVENT, GST_CANCELLATION, …), `title`,
`event_date`, `event_at` (date-time with time zone, for hours-based deadlines), `fy` (for an AGM: the accounts adopted),
`response_due`, `reference`, `authority`, `status`, `history[]`, `rev`.

### Task `T<FY>-…`

| Field | Meaning |
|---|---|
| `identity` | `scope_type:scope_id`, then the rule, the period and `r<filing version>` (unique). |
| `rule_id`, `rule_version`, `rule_name`, `form`, `category`, `nature`, `internal` | |
| `entity_id`, `entity_ids[]` | `entity_ids` lists every entity of a person-level task. |
| `scope_type`, `scope_id`, `scope_label` | |
| `registration_id`, `establishment_id`, `person_id`, `event_id`, `state` | |
| `fy`, `period_key`, `period_label`, `period_start`, `period_end` | Period keys: `M:2026-04`, `Q:2026-27:Q1`, `H:2026-27:H1`, `Y:2026-27`, `I:2026-27:2`, `E:<event>`, `R:<scope>:<date>`. |
| `original_due` (+ `original_due_at`), `due_basis`, `due_pending`, `due_error`, `due_source` | `due_source` is `manual` when the date was entered by hand. |
| `revised_due`, `revised_by` | The extension id. |
| `fee_waivers[]`, `internal_target`, `internal_target_override` | |
| `status` | One of the seven workflow states. |
| `priority`, owner / backup / checker ids and names, `remarks` | |
| `workflow{}` | `prepared_by`, `checked_by`, `filed_by` and `verified_by` (each with `_id` and time). |
| `filing{}` | `filed_at`, `filed_on`, `ack_type`, `ack_no`, `portal_status`, `nil_return`, `payment{ date, ref_type, reference, bsr_code, challan_serial, amounts{ tax, interest, late_fee, penalty, other } }`, `remarks`, `warnings`. |
| `exception{}` | `status`, `missing[]`, `reason`, `requested_by`, `decided_by`, `decision_note`. |
| `evidence_rule`, `filing_ack`, `payment_ref` | |
| `filing_version`, `revision_of`, `revision_kind`, `revised_by_task`, `locked`, `closed_at` | |
| `sample`, `rule_unverified` | |
| `history[]`, `rev` | |

**Derived on every read, never stored:** `effective_due`, `overdue`, `days_overdue`, `due_soon`, `days_to_due`,
`no_due_date`, `filed`, `filed_late`, `on_time`, `evidence{ required, present, missing }`, `evidence_missing`, `flags[]`.

### Document `D-…`

| Field | Meaning |
|---|---|
| `entity_id`, `task_ids[]`, `doc_type` | Type: `working`, `reconciliation`, `approval`, `source_data`, `filed_return`, `acknowledgement`, `payment_proof`, `bank_advice`, `notice`, `reply`, `certificate` or `other`. |
| `status` | `active` or `withdrawn`. |
| `sample`, `legal_hold{ reason, by, at }`, `retention_until`, `history[]` | |
| `versions[]` | Each version: `v`, `sha256`, `size`, `type`, `mime`, `original_name`, `uploaded_by(_id)`, `at`, `scan{ status, engine, detail }`, `findings{ gstins, tans, pans, arns, months }`, `flags[{ code, text }]`, `restored_from`. |
| `current` | The newest version. |

### Audit entry

`seq`, `at`, `actor`, `actor_id`, `persona`, `action`, `object_type`, `object_id`, `entity_id`, `summary`, `reason`,
`before`, `after` (changed fields only), `prev`, `hash`.

### Document folders (`<sp>_folders`)

| Field | Meaning |
|---|---|
| `base` | `{ drive_id, item_id, web_url, path, url_given, set_by, set_at }`: the folder chosen from the pasted link, as resolved by Microsoft. |
| `root` | `{ item_id, web_url, name, parent_id }`: "Finance & Compliance". |
| `nodes` | Folder key → `{ item_id, parent_item_id, web_url, name, label, status (created\|reused\|linked\|failed\|missing), attempts, next_retry_at, error, invalid, names[] }`. Keys are built from immutable ids, e.g. `E:<entity>\|FY:2026-27\|C:gst\|R:<registration>\|P:M:2026-04\|D:04_GSTR-3B`; challan folders add `\|X:<date>_<reference>`. The key is the folder's identity; the name is a label (`names[]` keeps old names after a rename). `parent_item_id` lets each write check the chain up to the root. |
| `found` | `[{ item_id, name, web_url, first_seen, status: open\|linked\|ignored, entity_id }]`: company-level folders created by hand in OneDrive. |
| `settings` | `{ fys[], trigger: saved\|approved, copy_documents }` |
| `log[]` | The last 1,500 entries: `{ at, kind, key, name, detail }`. Plus `last_run` and `last_scan`. |

**On each document version:** `remote` = `{ status: uploaded | simulated | failed | unrouted, item_id, web_url, path, file_name, error, reason, attempts, at }`.

### Roles (User Settings ticks → rights)

| Tick | Rights |
|---|---|
| `c2_initiator` | prepare, file |
| `c2_approver` | review, verify, approve |
| `c2_master` | master |
| `c2_rules` | rules |
| `c2_admin` | admin |
| `c2_auditor` | read-only (overrides everything else) |

The first version's single ticks (`c2_prepare`, `c2_review`, `c2_file`, `c2_verify`, `c2_approve`) still work.
