import React from 'react';
import { BookOpen } from 'lucide-react';
import { T } from '../../../theme';
import { S, Card } from '../ui';

// Instructions in plain language (also see "Compliance Dashboard/README.md" in the project folder).
const H = ({ children }) => <h3 style={{ fontSize: '0.92rem', margin: '1.1rem 0 0.4rem', color: T.primary }}>{children}</h3>;
const P = ({ children }) => <p style={{ fontSize: '0.82rem', lineHeight: 1.65, margin: '0 0 0.5rem', color: T.text }}>{children}</p>;
const Code = ({ children }) => <code style={{ fontFamily: T.mono, fontSize: '0.78rem', background: T.page, border: `1px solid ${T.border}`, borderRadius: 4, padding: '0 4px' }}>{children}</code>;

const RULES = [
  ['11th of following month', 'Day 11 of the month after the period (GSTR-1).'],
  ['20 of next month', 'Same as “following month”.'],
  ['last day of following month', 'Last calendar day of the month after the period.'],
  ['7th of same month', 'Day 7 of the period’s own last month.'],
  ['15th of 2 months after', 'Day 15, two months after the period.'],
  ['31-Jul', 'The first 31 July that comes after the period ends (annual items).'],
  ['7th of following month; MAR=30-Apr', 'Monthly rule with a different date for March (TDS payment).'],
  ['Q1=31-Jul; Q2=31-Oct; Q3=31-Jan; Q4=31-May', 'Quarterly returns: one date per quarter.'],
];

export default function Instructions({ meta }) {
  const s = meta.settings;
  return (
    <Card title="Instructions" icon={BookOpen} subtitle="How the Compliance Dashboard works, in simple steps.">
      <div style={{ padding: '0.4rem 1.3rem 1.2rem', maxWidth: 900 }}>
        <H>1. First-time setup (once)</H>
        <P>1. <strong>Company Master</strong> — check each company, its Short Code (used in every Task ID) and its Zoho Books organisation ID.</P>
        <P>2. <strong>Compliance Master</strong> — check every compliance and its Due Date Rule. Rows marked ⚠ have statutory or state-specific dates: <strong>verify them before relying on them</strong>.</P>
        <P>3. <strong>Company Applicability</strong> — set Applicable = No where a compliance does not apply to a company, and fill Responsible and Reviewer.</P>
        <P>4. <strong>Task Data › Generate Tasks</strong> — choose the Financial Year and click Preview, then Generate. Running it again never creates duplicates.</P>
        <P>5. <strong>Folder Setup</strong> — choose the company and year and click Create Folder Structure. Do this again for each new year.</P>

        <H>2. Every month</H>
        <P>1. On the <strong>Dashboard</strong>, pick the Financial Year and Month. Quarter and Half Year fill in automatically.</P>
        <P>2. If the Zoho line says <strong>Not Synced</strong>, click <strong>Sync Selected Period</strong> (only if you need the Zoho figures). Coming back to a synced month later reuses the stored data — Zoho is not called again.</P>
        <P>3. Click a task row. Set the Status, add a Completion Date and Remarks, and upload the challan / receipt. Click <strong>Save changes</strong>.</P>
        <P>4. Watch the <strong>Overdue</strong> and <strong>Upcoming</strong> reports. Click any KPI card or report row to list those tasks.</P>

        <H>3. Statuses</H>
        <P><strong>Not Started, In Progress, Completed</strong> — you set these. <strong>Due Soon</strong> (due within {s.due_soon_days} days) and <strong>Overdue</strong> (past the due date) are calculated automatically every time you open the page — they are never saved. <strong>N/A</strong> comes from Company Applicability = No.</P>
        <P><strong>Compliance %</strong> = Completed ÷ (Total − N/A). N/A tasks never count against you. TDS payment and TDS return are separate tasks.</P>

        <H>4. Periods</H>
        <P>H1 = Q1 (Apr, May, Jun) + Q2 (Jul, Aug, Sep). H2 = Q3 (Oct, Nov, Dec) + Q4 (Jan, Feb, Mar). Quarter and Half are always worked out from the Month, so a wrong combination like August + Q1 cannot be chosen or imported.</P>
        <P>Quarterly, half-yearly and yearly tasks are filed under the <strong>last month</strong> of their period — e.g. the Q1 TDS return appears under June, GSTR-9 under March.</P>
        <P>Task ID = <Code>COMPANY-COMPLIANCE-FY-PERIOD</Code>, e.g. <Code>DEVX-GST002-2026-27-AUG</Code> or <Code>DEVX-TDS003-2026-27-Q1</Code>.</P>

        <H>5. Due Date Rule syntax</H>
        <P>A rule is one or more parts separated by <Code>;</Code>. A part is either a default, or <Code>PERIOD=date</Code> where PERIOD is APR…MAR, Q1…Q4, H1, H2 or FY.</P>
        <table style={{ ...S.table, maxWidth: 820, marginBottom: 8 }}>
          <thead><tr><th style={S.th}>Rule</th><th style={S.th}>Meaning</th></tr></thead>
          <tbody>{RULES.map(([r, m]) => <tr key={r}><td style={{ ...S.td, fontFamily: T.mono, fontSize: '0.76rem' }}>{r}</td><td style={S.td}>{m}</td></tr>)}</tbody>
        </table>
        <P>Days are kept inside the month (31st in February becomes 28th or 29th). Use <strong>Check dates</strong> in the Compliance Master to see the dates a rule produces.</P>

        <H>6. Excel import</H>
        <P>1. Click <strong>Download Excel Template</strong> (or <strong>Export Master Data</strong> to edit what is already there).</P>
        <P>2. Fill the sheets. Rows starting with <Code>#</Code> are examples and are ignored. A <strong>blank cell</strong> leaves the existing value unchanged; <Code>#CLEAR</Code> empties it. Dates are DD-MM-YYYY.</P>
        <P>3. <strong>Import Excel › Preview</strong> — nothing is saved yet. Fix errors using the downloadable error report (Sheet, Row, Field, Error, Suggested Fix).</P>
        <P>4. <strong>Confirm Import</strong> — a backup is taken automatically, then all valid rows are saved together. To update many tasks at once, keep the Task ID column filled.</P>

        <H>7. Documents and folders</H>
        <P>Folders: <Code>{s.storage_root ? 'ROOT' : 'ROOT'} / COMPANY / {s.fy_folder_prefix || 'FY '}2025-26 / MODULE / Q1 / April / Receipt | Challan | Other Data</Code>.</P>
        <P>Uploads are filed automatically: type <strong>Challan</strong> → Challan; any type with <strong>Receipt</strong> → Receipt; everything else → Other Data. The same file cannot be uploaded twice. Allowed: {s.upload.allowed_extensions.join(' ')} up to {s.upload.max_size_mb} MB.</P>
        <P>Documents are confidential: they can only be opened by a signed-in user with access to that company. Every upload, view, download, replace and delete is written to the audit trail. Replaced and deleted files are kept in the <Code>_archive</Code> folder.</P>

        <H>8. Who can do what</H>
        <P><strong>Viewer</strong> — look only. <strong>Editor</strong> — update tasks and upload documents. <strong>Manager</strong> — also masters, task generation, folders, import, replace/delete documents. <strong>Admin</strong> — also settings, users and roles, audit trail. App Administrators are always Admin. Change these in Lists / Settings and Users and Roles.</P>
      </div>
    </Card>
  );
}
