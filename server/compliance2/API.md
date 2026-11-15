# Compliance Vr.2.0 — API contract

**Base path:** `/api/compliance2`.

**Login:** every route needs the dashboard login (`Authorization: Bearer <JWT>`), except `GET /dl/:token`.

**Space:** `?space=live|demo` or the header `X-C2-Space` (default `live`). The header `X-C2-Persona: maker|checker|filer|verifier|approver|auditor`
is honoured in the demo space only.

**Request bodies** are JSON unless stated.

**Errors** come back as `{ error, errors?, warnings?, missing?, current_rev?, preview? }` with these codes:

| Code | Meaning |
|---|---|
| 400 | Invalid input. |
| 401 | Not logged in. |
| 403 | Not allowed: a missing right, separation of duties, or an auditor. |
| 404 | Not found, including records outside the user's entity scope. |
| 409 | Stale update, conflict or duplicate. |
| 413 / 415 / 422 | File too large / file type refused / malware detected. |
| 503 | Encryption key missing. |

**Rights:** "view" means the module is ticked; the others are the ticks under it.

**Lists:** list filters are comma-separated: `fy`, `entity_ids`, `registration_ids`, `states`, `months` (YYYY-MM), `quarters`,
`categories`, `owners`, `checkers`, `priorities`, `statuses`, `flags` (`overdue`, `due_soon`, `review`,
`evidence_missing`, `no_due_date`, `missing_rule`, `filed_late`, `rule_unverified`, `document_flags`, `open`), `rule_ids`,
`natures`, `search`, `due_from`, `due_to`, `internal=include|exclude|only`, `revisions=include|exclude`.

## Meta and masters

| Method and path | Right | Purpose |
|---|---|---|
| GET `/meta` | view | Your identity and rights, the space, the demo snapshot, financial years with tasks, storage / scanner status, and constants. |
| GET `/users` | view | Users who have the module (for assignments). |
| GET `/org` | view | Masters you may see (DINs are masked). |
| POST `/org/:kind` | master | Create an `entity`, `registration`, `establishment` or `person`. Only an unscoped user may create an entity. |
| PUT `/org/:kind/:id` | master | Update. The body carries `rev`; returns 409 if stale. |
| POST `/org/:kind/:id/approve` | approve | Approve an entity or registration. PAN and CIN / LLPIN are required. |

## Rules, extensions, applicability

| Method and path | Right | Purpose |
|---|---|---|
| GET `/rules` | view | Rules with their versions (`due_text`, `due_problems`) and extensions. |
| POST `/rules/:id/versions` | rules | New draft `{ from_version?, effective_from? }`. |
| PUT `/rules/:id/versions/:v` | rules | Edit a draft `{ patch }`. A verified version goes back to draft. |
| POST `/rules/:id/versions/:v/verify` | rules | Body: `{ law, provision, form, authority, source_url, notification_no / standing_provision, notification_date, retrieved_at, verification_note }`. |
| GET `/rules/:id/versions/:v/preview` | approve or rules | Impact on existing tasks, with `?entity_ids&registration_ids&period_from&period_to`. Returns `{ rows, counts, hash }`. |
| POST `/rules/:id/versions/:v/approve` | approve | `{ preview_hash, note, scope }`. The approver ≠ the verifier. Returns 409 if the impact changed since the preview. Updates open tasks in scope. |
| POST `/rules/:id/versions/:v/withdraw` | rules | `{ reason }`. Draft or verified versions only. |
| POST `/extensions` | rules | Draft `{ rule_id, kind, period_keys, new_due_date (extension only), waiver_note, scope, issuer, notification_no, notification_date, source_url, retrieved_at }`. |
| POST `/extensions/:id/approve` | approve | Approver ≠ creator; re-applies to tasks. |
| POST `/extensions/:id/archive` and `/extensions/:id/withdraw` | approve | `{ reason }`; re-applies to tasks. |
| GET `/coverage?fy&entity_ids` | view | `{ rows, missing_rules, registration_checks, summary, gap_labels }`. |
| POST `/applicability` | rules | `{ rule_id, scope_type, scope_id, status, reason, evidence, effective_from, effective_to }`. |
| POST `/applicability/accept` | rules | `{ fy, items:[{ rule_id, scope_id }] }`. Only where the facts settle the answer; returns `{ accepted, skipped }`. |

## Events and tasks

| Method and path | Right | Purpose |
|---|---|---|
| GET `/events` | view | List events. |
| POST `/events`, PUT `/events/:id` | master | Save an event, then create its tasks and recompute dependent dates. Returns `{ event, created, blocked, recomputed }`. |
| POST `/tasks/generate` | master | `{ fy, entity_ids?, rule_ids?, commit }`. Without `commit` it is only a preview. Returns created / existing / not_applicable / blocked (with codes and reasons). |
| GET `/tasks` | view | Filtered tasks with derived flags. |
| GET `/overview` | view | CFO figures for the filter (see metrics.js), plus the queue tasks. |
| GET `/workload` | view | Open tasks per person. |
| GET `/tasks/:id` | view | `{ task, documents, actions, event, rule, audit, extensions }`. |
| POST `/tasks/:id/action` | by action | See below. Body: `{ action, rev, note, filing?, ack_verified?, decision?, kind? }`. |
| PATCH `/tasks/:id` | master, or prepare as owner | `{ rev, owner_id, backup_owner_id, checker_id, priority, remarks, internal_target_override, manual_due + reason }`. |

**Task actions:**

| Action | Right |
|---|---|
| `start`, `submit` | prepare |
| `request_changes`, `approve_filing` | review |
| `record_filing` | file |
| `return_to_filer`, `verify_close` | verify |
| `request_exception` | prepare or file |
| `decide_exception` | approve |
| `reopen` | approve |

## Documents

| Method and path | Right | Purpose |
|---|---|---|
| POST `/tasks/:id/documents` | prepare or file | Multipart: `file`, `doc_type`, `replace_doc_id?`. Returns `{ document, linked_existing, flags }`. |
| POST `/tasks/:id/documents/link` | prepare or file | `{ doc_id }`. Same entity only. |
| GET `/documents?doc_type&flag&status&search&entity_ids` | view | Evidence vault. |
| POST `/documents/:id/link-url` | view | `{ version? }`. Returns `{ url, expires_in }`; the link is signed, for this user only, and valid for 30–600 seconds. |
| GET `/dl/:token` | (signed link) | The file, after checking the signature, the expiry and the user's current access. Every download is audited. |
| POST `/documents/:id/restore` | prepare or file | `{ version }`. Adds the old version as a new version. |
| POST `/documents/:id/withdraw` | prepare or file | `{ reason }`. Not under legal hold, and not on a closed task. |
| POST `/documents/:id/hold` | approve | `{ on, reason }`. |

## Document folders and OneDrive

| Method and path | Right | Purpose |
|---|---|---|
| GET `/folders?entity_id&fy` | view | Connection status, the chosen folder, settings, counts, the folder tree of one company and FY (with status), pending items, folders found in OneDrive, and the log. |
| POST `/folders/preview` | view | `{ entity_ids?, fys? }`. What would be created. **No call to Microsoft.** |
| POST `/folders/provision` | master | `{ entity_ids?, fys?, force? }`. Creates what is missing, reuses what exists, retries failures (`force` = retry now). |
| POST `/folders/scan` | master (unscoped) | Finds company folders created directly in Finance & Compliance (an exact legal name is linked), then provisions. |
| POST `/folders/found/:itemId/link` | master (unscoped) | `{ entity_id }`. Links a found folder to its entity and provisions it. |
| POST `/folders/found/:itemId/ignore` | master (unscoped) | Marks a found folder "not a company folder". |
| PUT `/folders/settings` | admin | `{ fys[], trigger: saved\|approved, copy_documents }`. |
| GET `/folders/preview-company?name&fy` | view | The folders a new company would get (nothing is created). |
| POST `/onedrive/connect-url` | admin (live) | Returns `{ url }` for the Microsoft sign-in. Gives 400 with the missing setting names if the app registration is not configured. |
| GET `/onedrive/callback` | (signed state) | Microsoft returns here. Stores the encrypted refresh token and shows a page. |
| POST `/onedrive/base` | admin (live) | `{ url }`. Microsoft resolves the folder; it must be in the signed-in person's OneDrive; it can't change after set-up. |
| POST `/onedrive/disconnect` | admin | Stops the engine; folders and mapping stay. |
| POST `/documents/:id/onedrive` | prepare or file | `{ version? }`. Copies (again) to the document's OneDrive folder. Returns `{ remote }`. |

## Team, settings, audit, exports, import, demo

| Method and path | Right | Purpose |
|---|---|---|
| GET `/team`, PUT `/team` | view / master | `{ rows:[{ entity_id\|*, category\|*, registration_id, owner_id, backup_owner_id, checker_id }] }`. |
| GET `/settings`, PUT `/settings` | admin | Settings `soon_days`, `retention_years`, `max_upload_mb`, `link_ttl_seconds`. |
| PUT `/settings/access` | admin | `{ user_id, entities[], period_from?, period_to? }`. |
| GET `/audit?object_id&from&to&limit` | view | Scoped to the user's entities. |
| GET `/audit/verify` | view | `{ ok, checked, at_seq?, reason? }`. |
| GET `/export/register.csv` or `/export/register.xlsx` | view | Filtered register. |
| GET `/export/calendar.ics` | view | Filtered calendar. |
| GET `/export/exceptions.csv` | view | Filtered exception log. |
| GET `/export/coverage.csv?fy` | view | Coverage report. |
| GET `/export/audit.zip` | view | README, register, evidence manifest with SHA-256, the files and the audit entries. At most 5,000 tasks / 150 MB. |
| GET `/import/template.xlsx` | view | Master-data template. |
| POST `/import/preview` and `/import/commit` | master | Multipart `file`. All-or-nothing. |
| POST `/import-v1/preview` and `/import-v1/commit` | master | Compliance v1 companies become draft entities (live only). |
| POST `/demo/reset` | admin | Rebuild the demo space (demo only). |
