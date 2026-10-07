# Compliance Dashboard — TEST RESULTS (03-10-2026)

## 1. Automated tests — 49 of 49 passed

Run with `npm run test:compliance`. The tests use temporary folders, a fake Zoho client and the real API router. They never touch live data.

| Area (spec §13) | Tests | Result |
|---|---|---|
| April → Q1/H1, August → Q2/H1, November → Q3/H2, February → Q4/H2 | period.test.js | ✔ |
| H1 enables only Q1/Q2; H2 only Q3/Q4; each quarter only its months (the browser filter code itself) | period.test.js (UI tests) | ✔ |
| August + Q1 impossible in the UI (exhaustive walk of filter changes), rejected by the API and by import | period.test.js, import.test.js, api.test.js | ✔ |
| April never under August; H1 never with H2; Q1 never with Q2–Q4; FYs never mix | isolation.test.js, api.test.js | ✔ |
| Returning to a synced period makes **zero** Zoho calls; filter changes and status reads never call Zoho | zoho_documents.test.js, api.test.js | ✔ |
| Compliance % ignores N/A; Due Soon and Overdue are computed, never stored; Overdue can't be typed in | rules_status.test.js, api.test.js | ✔ |
| Folder creation idempotent; Challan/Receipt/Other Data routing; documents can't be fetched without login; forged token rejected | zoho_documents.test.js, api.test.js | ✔ |
| Due-date rules (following/same month, last day, clamping, leap year, MAR=30-Apr, quarterly, annual) | rules_status.test.js | ✔ |
| Import: preview writes nothing, confirm backs up first, duplicates skipped (in file + against data), blank vs #CLEAR, bulk update by Task ID, error report columns | import.test.js, api.test.js | ✔ |
| Generation: Task ID format, no duplicates, N/A from applicability, LWF only in Jun/Dec | isolation.test.js | ✔ |
| Upload security: content signature, size, blocked types, sanitised names, path traversal, duplicate hash | zoho_documents.test.js, api.test.js | ✔ |

<details><summary>Full test list</summary>

```
✔ API: everything needs a login (documents cannot be fetched without one)
✔ API: seeded masters, August + Q1 rejected, generation, isolated dashboard
✔ API: task update — Completed needs a date in the past; Overdue cannot be set
✔ API: Zoho — revisiting a synced month makes zero Zoho calls
✔ API: upload routing, duplicate block, authenticated download, replace, delete
✔ API: folder setup is idempotent
✔ API: import is Preview (no write) then Confirm (backup first, one write)
✔ template round-trip: template parses with example rows ignored
✔ import rejects August + Q1 (and H2 + August); preview writes nothing
✔ duplicates are skipped within the file and against existing data
✔ bulk update by Task ID: blank = unchanged, #CLEAR = empty, Completed needs a date
✔ import validates company, FY, month, compliance, dates and identity changes
✔ manual entry uses the same validation (August + Q1 rejected, Quarter/Half derived)
✔ master import: new company and compliance can be used by tasks in the same file
✔ Task ID format COMPANYSHORT-COMPLIANCEID-FY-PERIODKEY
✔ April data never appears under August (and vice versa)
✔ H1 never mixes with H2
✔ Q1 never mixes with Q2, Q3 or Q4
✔ FYs never mix
✔ quarterly task sits in its period end month only (TDS Q1 return under June)
✔ generation never duplicates; re-running skips existing tasks
✔ preview generation does not change the data
✔ LWF (Applicable Months JUN,DEC) is only generated for June and December
✔ applicability No creates N/A tasks; switching back restores open tasks
✔ April → Q1/H1, August → Q2/H1, November → Q3/H2, February → Q4/H2
✔ every month maps to exactly one quarter and half, consistently
✔ selection: August + Q1 is rejected; August alone derives Q2/H1
✔ selection: H1 + Q3 and H2 + August are rejected
✔ selection month lists: H1 = Apr–Sep, H2 = Oct–Mar, Q1 = Apr–Jun only
✔ FY normalisation and calendar mapping
✔ period keys and anchor months
✔ UI: H1 enables only Q1/Q2; H2 only Q3/Q4
✔ UI: each quarter enables only its three months
✔ UI: selecting a month auto-fills quarter and half
✔ UI: August + Q1 is impossible — changing a parent resets the child to All
✔ rule: Nth / last day of following month (with clamping)
✔ rule: month override MAR=30-Apr (TDS payment)
✔ rule: quarterly dates Q1=31-Jul; Q2=31-Oct; Q3=31-Jan; Q4=31-May
✔ rule: annual fixed date comes after the FY ends (GSTR-9 31-Dec, ITR 31-Jul)
✔ rule: invalid rules are rejected with a clear message
✔ every seeded compliance rule is valid for its frequency
✔ status: Due Soon and Overdue are computed at read time, never stored
✔ KPI: Compliance % = Completed / (Total − N/A); N/A is never pending
✔ Zoho: returning to an already-synced month makes zero Zoho calls
✔ Zoho: a broader selection reports "x of y periods synced"; unlinked companies are not counted
✔ Documents: upload routing Challan / Receipt / Other Data
✔ Documents: folder creation is idempotent and follows ROOT/COMPANY/FY/MODULE/Qn/Month/leaf
✔ Documents: sanitising and path traversal guard
✔ Documents: file type, size and content checks
ℹ tests 49 · pass 49 · fail 0
```
</details>

## 2. Browser tests on the live app (headless Chrome, port 3002)

| Check | Result |
|---|---|
| Sidebar › Compliance Dashboard opens the module (active teal item with left bar); light Finance Suite look | ✔ |
| Generate Tasks (FY 2026-27): preview 339, generated 339; preview again → 0 new, 339 already exist | ✔ |
| Month = August → Quarter Q2, Half H1 filled in; Q3/Q4 and non-Q2 months greyed out | ✔ |
| Quarter = Q1 after August → Month reset to All; Jul–Mar greyed out | ✔ |
| Half = H2 → Quarter reset to All; Q1/Q2 greyed out | ✔ |
| August shows only `…-AUG` tasks (24 rows = 3 companies × 8 monthly compliances) | ✔ |
| Task panel: set Completed + completion date + remarks → saved; KPI Completed 1, Compliance 12.5 % (DEVX, August) | ✔ |
| Upload Challan → `…/GST/Q2/August/Challan`; Payment Receipt → `…/Receipt`; same file again → blocked | ✔ |
| Task audit trail shows status change and both uploads with who/when | ✔ |
| KPI card click (Completed → 1 row, Overdue → 7 rows); company row click filters to that company | ✔ |
| Search across all periods ("TDS003") returns Q1–Q4 tasks | ✔ |
| All 9 Master sections open without errors | ✔ |
| Folder Setup: first run "created", second run "Already Exists" | ✔ |
| Import with errors: preview 1 update / 1 error (August + Q1) / 1 duplicate skipped; confirm saved 1, backup file created | ✔ |
| Manual Entry: Quarter/Half shown read-only from Month; duplicate task blocked with a clear message | ✔ |
| Phone width 390 px (sidebar collapsed): one-column filters, no sideways scrolling | ✔ |
| GST, TDS, Payroll, Sales dashboards still open normally | ✔ |
| Viewer role: can view; cannot edit tasks, generate, sync or open settings (403). User with the module switched off: 403 | ✔ |

## 3. Live Zoho Books check

“Sync Selected Period” for **Dev Accelerator Limited, August 2026** used 14 API calls. The figures were compared with the app's existing central Zoho sync for the same month:

| Document type | Compliance sync | Central sync | Match |
|---|---|---|---|
| Sales invoices (excl. void/draft) | 429 · ₹14,60,04,902 | 429 · ₹14,60,04,902 | ✔ |
| Credit notes | 33 · ₹1,13,83,708 | 33 · ₹1,13,83,708 | ✔ |
| Purchase bills | 1,045 · ₹21,06,89,631 | 1,045 · ₹21,06,89,631 | ✔ |
| Vendor payments | 781 · ₹42,11,25,496 | 781 · ₹42,11,25,496 | ✔ |

After switching to September and back to August: **no new Zoho call** (no new sync entry, cache file not rewritten).

## 4. Clean-up after testing

Test tasks, documents, folders and the import backup were removed. The data is back to the seeded masters (3 companies, 15 compliances, 45 applicability rows, no tasks). The real Zoho sync of DEVX August 2026 was kept.

## Not covered / known limits

- Needle And Thread Zoho sync was not run (verify one month — see README).
- On a phone the app's sidebar (unchanged) takes 240 px unless collapsed — the same on every page of the Finance Suite.
- “View” of a document opens it in a new browser tab. Pop-up blockers must allow the app.
