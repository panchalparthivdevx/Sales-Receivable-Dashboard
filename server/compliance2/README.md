# Compliance Dashboard Vr.2.0

A multi-entity compliance and evidence system inside the Finance dashboard (sidebar: **Compliance Dashboard Vr.2.0**, below
the existing Compliance Dashboard, which is unchanged).

**Model:** group → legal entity → registrations (GSTIN, TAN, PF, ESIC, PT, LWF, IEC, licences …) → establishments, plus people
(directors / signatories). Each obligation is keyed to the right level. A GST return is keyed to its GSTIN, a TDS task to its
TAN, the ITR and advance tax to the entity (PAN), ROC filings to the company, labour obligations to the PF / ESIC / PT
registration or establishment, and DIR-3 KYC to the person. An entity-level obligation is created once, never once per
GSTIN.

Other documents in this folder:

- `DATA_DICTIONARY.md`: every record and field.
- `API.md`: every route, with the right it needs.
- `RUNBOOK.md`: deployment, keys, backups, restore tests and troubleshooting.
- `env.example`: the names of the settings, with no values.

---

## Setup (office PC)

Run all of this from the project folder (`Sales & Receivable Dashboard`).

1. **Create the encryption key for evidence files.** It is needed once, and live uploads are refused without it:
   ```
   node -e "console.log('C2_FILE_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
   ```
   Add the printed line to `.env`. Keep a copy of it somewhere safe, apart from the backups: without it the stored files
   cannot be read.
2. **Restart the dashboard server.** It must load the new module.
3. **Build the screens:** `node "C:\Users\Parthiv Panchal\Desktop\Claude\build2.js"`. This is already done for this version.
4. **Give people access** in User Settings → *Compliance Dashboard Vr.2.0*. Tick the module, then the role:
   - **Initiator**: prepares tasks, uploads evidence, records the filing or payment.
   - **Approver**: approves the filing pack, verifies the acknowledgement and closes, decides exceptions.

   Nobody can approve or close something they initiated. Specialist ticks are *Master data*, *Rules & applicability* and
   *Administer*. An auditor gets only *Auditor (read-only)*, plus an entity scope in the module's Settings.
5. **OneDrive folders (optional, once):** your Microsoft 365 administrator registers one app for the dashboard (see
   "OneDrive" in `RUNBOOK.md`). Then, in **Document Folders**, an administrator clicks *Connect OneDrive*, signs in once and
   pastes the folder link.
6. **Run the tests:** `npm run test:compliance2`.

Online (Vercel): add `C2_FILE_KEY` (a different key from the PC's is fine) in Project → Settings → Environment Variables,
then deploy. See `RUNBOOK.md`.

## First use (live space)

1. **Masters.** Add your entities (or import the template, or carry over the three Compliance v1 companies as drafts).
   Then add registrations and establishments, and approve them. Only approved master data gets live tasks.
2. **Rules.** For each obligation you rely on, a person verifies a version against the official source: law, provision,
   form, source URL, notification and the date it was retrieved. A **second** person then approves it after reading the
   impact preview. Nothing is scheduled live from an unverified rule.
3. **Coverage.** Decide applicability per entity / registration (Applicable / Not applicable / Needs review, with a
   reason). Rows where the recorded facts settle the answer can be accepted in one click. "Unknown" is never treated as
   "not applicable".
4. **Coverage → Generate tasks.** Preview first, then create. Running it again never creates duplicates.
5. Work the tasks in **Register / Calendar / Approvals** and keep evidence in the task (Evidence vault).

The **Demo** space shows all of this on illustrative data (labelled everywhere, with a fixed snapshot date). Demo personas
let one person try the Initiator → Approver flow on demo data. A persona is not a login. The demo's Document Folders tab
builds the folder structure in a *simulated* OneDrive, so nothing reaches Microsoft.

---

## Status: what is built, and what still needs legal or data approval

### Built and tested (Phase 1 and the 15 Nov additions)

| Area | What works |
|---|---|
| Organisation model | Group, entities (company / LLP / others; CIN / LLPIN; PAN; listed, with the listing type (shares / NCDs / both), and exchanges; threshold history by FY), registrations of every type in the spec (several GSTINs per state), establishments, people. Identifier checks: GSTIN check character, PAN inside the GSTIN, state code, TAN, CIN, LLPIN, PF / ESIC formats. Duplicates are refused. Fields that look like passwords are refused. Draft → approved status. |
| Coverage catalogue | All catalogue rows (104 rules; PF ECR / payment / reconciliation, ESIC, PT-PTRC payment / return, PTEC and LWF kept separate). Equity-listed, debt-listed (NCD) and LLP obligations have their own rules and their own applicability. Debt-listing rules: results, utilisation / deviation, security cover, covenants / trustee, interest / redemption intimation, board-meeting intimation, material events, annual report and high-value debt-listed governance. A newer catalogue updates only rules nobody has edited. |
| Applicability | Three-valued tests on recorded facts (entity type, listing, FY thresholds, state, headcount, regime, frequency, flags). Decisions record reason, evidence, reviewer and effective dates, with history. Coverage-gap report, missing-rule queue and registration checks. |
| Rule engine | Versions with law, provision, form, authority, source URL, notification number and date, retrieved date, verified by, approved by and effective dates. Draft → verified → approved by a different person, quoting the impact preview. Live scheduling uses approved versions only. Old and new Income-tax Act versions are split at 1 Apr 2026, with new-Act forms left unmapped. Due-date expressions: following-month day with March exceptions, days after the period (SEBI 45 / 60), first date after the FY (GSTR-9, LLP-11 / 8, DPT-3, FLA, MSME-1 halves), advance-tax instalments, the QRMP 22nd / 24th state groups, per-state rules (PT / LWF: a state without a rule stays unscheduled), AGM + days, hours after a timed event, the reply date on a notice, expiry dates, and internal targets linked to another obligation. Dates are never rolled forward for weekends or holidays, and a non-existent day is an error, never silently moved. |
| Dates | Original statutory, revised statutory (approved extension), internal target and actual filing date are kept apart. A fee waiver is a separate record and never moves a date. Archived extensions stop applying. |
| Tasks | Generation with identity = scope + obligation + period + filing version (no duplicates); event-triggered tasks; date recomputation when an AGM or notice changes; team mapping (owner / backup / checker); derived flags (overdue, due soon, no due date, filed late, evidence missing, missing state rule, rule unverified). |
| Workflow | Not started → In progress → Ready for review → (Changes requested) → Approved to file → Filed awaiting verification → Completed. Server-side rights. The checker is never the preparer. The verifier is neither the preparer nor the filer, and this applies to administrators too. Uploading never marks anything filed. Closing is blocked while mandatory evidence is missing unless an exception is approved by a different person. Re-open creates a new version and the original stays as filed. Every action is checked against the record's version (stale updates are refused). |
| Filing record | Filing date and time (IST), type-specific acknowledgement (ARN / SRN / TRRN / token / challan), nil flag, portal status, payment date, reference type and reference, BSR and challan serial, tax / interest / late fee / penalty / other, remarks. |
| Documents | Type by content (PDF, images, Excel, CSV, text, JSON, ZIP; the extension must agree), size limit, malware scan (Microsoft Defender on the PC, ClamAV if configured, otherwise visibly "unscanned"), SHA-256, stored once, AES-256-GCM encryption at rest, versions with restore, links to several tasks, retention date, legal hold, withdraw (never delete), short-lived signed per-user download links. Text checks flag another GSTIN / TAN / PAN / period for a human. Scanned images are not read (no OCR). |
| Access | Initiator / Approver roles (plus Master data, Rules, Administer, Auditor) per user; an entity scope per user; an auditor is read-only and sees nothing until given entities (and optionally periods); other entities' records answer "not found". The demo and live spaces never share data or files. |
| Audit | Append-only, hash-chained audit trail with actor, time, action, before / after and reason, plus an integrity check. Downloads and exports are logged too. |
| Document folders (V4) | The approved OneDrive structure: Finance & Compliance → company legal name → FY → 01_Financials … 09_Notices_and_Correspondence → GSTIN (State_GSTIN) / TAN / PF / ESIC code / PT state + registration → month / quarter / half / year → document type. Connection via a one-time Microsoft sign-in (delegated Files.ReadWrite: the signed-in person's own OneDrive), with an encrypted stored token and no password. The folder comes from the pasted link and is resolved by Microsoft, never guessed. Folders are created automatically when a company or registration is saved (or approved, as a setting) and when a FY is added. Company folders created by hand in OneDrive are found every 15 minutes on the PC (exact legal name: linked; anything else: a person decides). Folder ids are mapped, so a company rename keeps its folder and renames it. Re-runs and retries reuse, never duplicate. Failures are retried with back-off. A preview makes no remote call. Before writing, OneDrive is asked where each folder really is (nothing outside Finance & Compliance). A revoked sign-in stops the engine. Uploaded documents are copied to their folder by compliance period (March paid in April stays in March), challan folders are created on real payments, and files follow the approved naming standard. The demo uses a simulated OneDrive. |
| Screens | Overview (CFO), Calendar (month / week / agenda), Register (views for statutory, internal, notices, renewals and revisions), Approvals, Coverage, Workload, Evidence vault, Document Folders, Masters, Rules, Settings & audit. Navy / lavender design, keyboard focus rings, and narrow-screen layout once the app sidebar is collapsed. |
| Exports | Register CSV / XLSX, calendar ICS, exception log, coverage CSV, and an audit ZIP (register, evidence manifest with SHA-256, the files and audit entries). Spreadsheet formula injection is neutralised. Every export states its dataset, filters, time and user. |
| Import | Excel / CSV master template with preview, validation and duplicate checks; all-or-nothing. Carry-over of the Compliance v1 companies as drafts. |
| Backups | `scripts/backup.js` makes a backup (encrypted files plus documents with a hash manifest, never the key) and runs a restore test (rebuild in a temp folder, check hashes, the audit chain and that every file decrypts). |
| Tests | 54 automated tests (`npm run test:compliance2`), including every case in the V4 folder test list. In checks, 26 deliberately planted defects (18 in Phase 1, 8 in the 15 Nov additions) were all caught. |

### Needs your legal or data approval before live use

1. **Every rule version is an unverified draft.** Standard dates come from the catalogue you supplied; law and provision
   texts were typed in at build time. A person must verify each version you rely on against the official source for the
   period, and a second person must approve it. Until then nothing is scheduled live.
2. **Rows with no date** (catalogue says "rule-based / verify / state-specific"): CMP-08 / GSTR-4 / GSTR-5, GSTR-10, LUT,
   refunds, TDS statements and certificates under the Income-tax Act 2025, ITR, tax audit, TP, SFT, AGM, DIR-3 KYC, the
   event forms (ADT-1, DIR-12, MGT-14, PAS-3, CHG-1), BEN-2 / IEPF, most SEBI items (equity and debt listing), FEMA event filings, LWF, PT (every
   state except a Gujarat draft taken from Compliance v1), CLRA, POSH and stamp duty. Each one needs its verified rule.
3. **Income-tax Act, 2025:** sections and forms for periods from 1 April 2026 are left blank on purpose.
4. **Labour Codes transition:** EPF / ESI / bonus / gratuity / contract-labour rules must be validated for each period.
5. **Thresholds** in the draft applicability tests (for example CSR) and the **QRMP 22nd / 24th state table** must be
   verified.
6. **Master data:** real entities, registrations, establishments, directors and team assignments must be entered (or
   imported) and approved. The Compliance v1 companies come across without PAN or CIN, with their entity type guessed
   from the name.
7. **Retention period:** the default is 8 years after the FY end and must be checked for each law.
8. **Debt-listing (NCD) obligations** were added as drafts, with regulation references typed in at build time. They need
   verifying against the current SEBI master circular for listed non-convertible securities. Two facts must also be
   recorded for DevX: *has secured listed NCDs* and *high value debt listed entity*.
9. **Folders for other categories:** your approved structure has no folders for Income Tax, ROC/LLP, SEBI, FEMA, State
   licences or Internal Controls. Documents of those tasks are not copied to OneDrive ("no folder in the approved
   structure") until you approve additional folders (e.g. 10_Income_Tax, 11_ROC_LLP …).

### Not built yet (later phases of the specification)

- Reminders and email (15 / 7 / 3 / 1 days, escalation) with job queue and delivery logs.
- Compliance Updates tab with a daily 09:00 IST source-monitoring job and a reviewer queue.
- TDS section-wise deposit tracking (V3).
- Instant OneDrive change notifications (webhooks). Polling every 15 minutes on the PC covers this for now.
- Applying Microsoft retention / permission labels when a period is closed.
- Reports & Analytics (V7) and reconciliation inputs for GST / PF / ESIC / PT / TDS (V8).
- Zoho Books integration for this module.
- OCR of scanned images.
- The part of the specification that was cut off after V8.
