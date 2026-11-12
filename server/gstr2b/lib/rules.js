/**
 * Statutory rules, effective-dated and kept as data — NOT buried in code, so they can be reviewed with the tax
 * advisor and changed when the law changes. Each entry names its source. Verified 11 Nov 2026 against the CBIC tax
 * repository (taxinformation.cbic.gov.in) and the GST portal's own advisories.
 *
 * Phase 1 uses only the Section 16(4) claim deadline (to separate time-barred Books-only GST from GST that could
 * still appear in a later GSTR-2B). The rest are recorded for the Phase 2 ITC register.
 */

'use strict';

const N = require('./normalize');

const RULES = {
  as_of: '2026-11-11',
  sections: [
    {
      id: 's16_4', title: 'Time limit to claim ITC — Section 16(4)',
      effective_from: '2022-10-01', status: 'in force', used_in: 'Phase 1 (time-barred / closing-soon exposure)',
      text: 'ITC on an invoice or debit note cannot be claimed after the EARLIER of (a) 30 November following the end of the financial year to which the invoice or debit note pertains, and (b) the date the annual return (GSTR-9) for that year is furnished.',
      source: 'CGST Act s.16(4) as substituted by Finance Act 2022 s.100 w.e.f. 1 Oct 2022 — CBIC tax repository, section 16 (active version)',
      note: 'Record the GSTR-9 filing date per GSTIN and year in Settings once filed; it can close the window before 30 November.',
    },
    {
      id: 's16_2_aa', title: 'Supplier must have reported the invoice — Section 16(2)(aa) and (ba)',
      effective_from: '2022-01-01', status: 'in force', used_in: 'Phase 1 (why Books-only GST cannot be claimed until it appears in GSTR-2B)',
      text: 'ITC is available only if the supplier has furnished the invoice / debit note details in their outward-supplies statement and they have been communicated to the recipient (GSTR-2B); and ITC details communicated under s.38 have not been restricted.',
      source: 'CGST Act s.16(2)(aa) (Finance Act 2021 s.109, w.e.f. 1 Jan 2022) and s.16(2)(ba) (Finance Act 2022 s.100, w.e.f. 1 Oct 2022) — CBIC tax repository',
    },
    {
      id: 'r37', title: '180-day payment rule — Section 16(2) second proviso and Rule 37',
      effective_from: '2022-10-01', status: 'in force', used_in: 'Phase 2',
      text: 'If the recipient has not paid the supplier within 180 days of the invoice date, ITC proportionate to the unpaid amount is reversed with interest (s.50) in GSTR-3B for the period after the 180 days, and may be re-availed on payment. Not applicable to reverse-charge supplies.',
      source: 'CGST Rules r.37 as substituted by Notification 19/2022-CT (w.e.f. 1 Oct 2022) and amended by Notification 26/2022-CT — CBIC tax repository',
      note: 'The 180 days run from the date of the supplier\'s invoice. The existing 180-day dashboard counts from the Zoho posting date; this module will use the supplier invoice date.',
    },
    {
      id: 'r37a', title: 'Supplier has not filed GSTR-3B — Rule 37A',
      effective_from: '2024-07-10', status: 'in force', used_in: 'Phase 2',
      text: 'ITC claimed on an invoice reported by the supplier, where the supplier has not filed GSTR-3B for that period by 30 September following the financial year, is reversed in GSTR-3B filed by 30 November after that year, and can be reclaimed if the supplier later files.',
      source: 'CGST Rules r.37A inserted by Notification 12/2024-CT dated 10 Jul 2024 — CBIC tax repository',
    },
    {
      id: 'ims', title: 'Invoice Management System (IMS) and GSTR-2B',
      effective_from: '2024-10-01', status: 'in force', used_in: 'Phase 3 (IMS status display)',
      text: 'Accepted and deemed-accepted records enter GSTR-2B "ITC available"; rejected records go to "ITC Rejected" and are not auto-populated in GSTR-3B; pending records stay in IMS. GSTR-2B can be recomputed until GSTR-3B is filed. GSTR-2B generation is sequential (the previous period\'s GSTR-3B must be filed).',
      source: 'GST portal advisory "Invoice Management System" and the GSTR-2B user manual — tutorial.gst.gov.in',
    },
  ],
  // Recommended by the GST Council but NOT notified — never applied until switched on here with a notification reference.
  pending: [
    { id: 'p17_5', title: 'Easing of blocked credit — Section 17(5)', status: 'recommended, not notified — not applied', detail: 'Outdoor catering, health and life insurance, telecom towers, pipelines outside factory premises, free samples, goods destroyed/written off after shelf life.', source: '57th GST Council recommendations (Oct 2026), PIB release "Next-Gen GST Process Reforms", 9 Oct 2026' },
    { id: 'pstmts', title: 'New electronic statements and ITC alignment', status: 'recommended, proposed from the April 2027 return period — not applied', detail: 'Electronic RCM statement, electronic credit reversal and reclaim statement, and a mechanism to align ITC in GSTR-3B with GSTR-2B.', source: '57th GST Council recommendations (Oct 2026), PIB release, 9 Oct 2026' },
  ],
};

/** The date after which ITC on a document dated `docDate` can no longer be claimed */
function claimDeadline(docDate, registration = null) {
  if (!docDate) return null;
  const fy = N.fyLabel(docDate);
  const start = N.fyStart(docDate);
  const nov30 = `${start + 1}-11-30`;
  const g9 = registration && registration.gstr9_filed && registration.gstr9_filed[fy];
  const earlier = g9 && g9 < nov30;
  return {
    fy, deadline: earlier ? g9 : nov30, basis: earlier ? 'gstr9_filed' : 'nov30',
    legacy: start < 2022,
    text: earlier ? `GSTR-9 for ${fy} was filed on ${g9}, which closes the window earlier than 30 Nov ${start + 1}` : `30 November ${start + 1} (end of the financial year following ${fy}), unless GSTR-9 is filed earlier`,
  };
}

/** time_barred | closing_soon | open */
function exposureClass(deadline, today, soonDays = 60) {
  if (!deadline) return 'open';
  if (today > deadline) return 'time_barred';
  return N.daysBetween(today, deadline) <= soonDays ? 'closing_soon' : 'open';
}

module.exports = { RULES, claimDeadline, exposureClass };
