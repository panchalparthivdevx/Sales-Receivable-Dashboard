/**
 * Task generation: Compliance rules × Companies × Periods.
 *
 *   • Only Active companies and Active compliances.
 *   • A period is generated when its month (the period's last month) is inside the chosen
 *     months — e.g. generating for Q2 creates JUL/AUG/SEP monthly tasks and the Q2 quarterly task.
 *   • Monthly compliances with "Applicable Months" only get those months.
 *   • Never creates a duplicate (same company + compliance + FY + period).
 *   • Applicability "No" creates the task as N/A.
 */

'use strict';

const P = require('./period');
const T = require('./tasks');

/**
 * Plan (and optionally apply) generation.
 * params: { fy, months: ['APR', ...], company_ids: [] (empty = all), modules: [] (empty = all) }
 * Returns { create: [task], skipped: [{ task_id, reason }], errors: [{ task_id, error }] }.
 * With apply = false nothing is changed (preview).
 */
function generate(state, params, ctx, { apply = false } = {}) {
  const { fy, months } = params;
  const companyIds = new Set(params.company_ids || []);
  const modules = new Set((params.modules || []).map(m => String(m).toLowerCase()));
  const work = apply ? state : { ...state, tasks: [...state.tasks] };   // preview: don't touch the real list

  const out = { create: [], skipped: [], errors: [] };
  const companies = state.companies.filter(c => c.status !== 'Inactive' && (!companyIds.size || companyIds.has(c.id)));
  const compliances = state.compliances.filter(c => c.active !== false && (!modules.size || modules.has(c.module.toLowerCase())));

  for (const co of companies) {
    for (const cm of compliances) {
      for (const pk of P.periodKeysOf(cm.frequency)) {
        const anchor = P.anchorMonth(pk);
        if (!months.includes(anchor)) continue;
        if (cm.frequency === 'Monthly' && cm.active_months && !cm.active_months.split(',').includes(pk)) continue;
        const taskId = T.buildTaskId(co.short_code, cm.id, fy, pk);
        if (T.findDuplicate(work, co.id, cm.id, fy, pk, taskId)) { out.skipped.push({ task_id: taskId, reason: 'Already exists' }); continue; }
        const r = T.createTask(work, { company_id: co.id, compliance_id: cm.id, fy, month: anchor }, { ...ctx, source: 'generated' });
        if (r.ok) out.create.push(r.record);
        else out.errors.push({ task_id: taskId, error: r.errors.map(e => e.error).join(' ') });
      }
    }
  }
  return out;
}

module.exports = { generate };
