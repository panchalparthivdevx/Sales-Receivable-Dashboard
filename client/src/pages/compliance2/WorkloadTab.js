import React, { useEffect, useState } from 'react';
import { api, errMsg } from './api';
import { C, Section, Note, Table, Empty } from './ui';

// Open tasks per person (owner, reviewer, backup) for the current filters.
export default function WorkloadTab({ params, stamp, onDrill }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { setData(null); api.workload(params).then(setData).catch(e => setErr(errMsg(e))); }, [params, stamp]);
  if (err) return <Note tone="error">{err}</Note>;
  if (!data) return <Empty>Loading…</Empty>;
  return (
    <Section title={`Team workload — ${data.open_tasks} open task(s)`} sub="Click a person to see their tasks in the register. Assignments are not assumed: unassigned work is shown as such." flush>
      <Table rows={data.rows} rowKey={r => r.id || 'none'} onRow={r => onDrill({ owners: [r.id || '__none__'] })} empty="No open tasks"
        cols={[
          { label: 'Person', render: r => <b style={{ color: r.id ? C.text : C.red }}>{r.name}</b> },
          { label: 'Owner of', num: true, render: r => r.owner },
          { label: 'Overdue', num: true, render: r => <span style={{ color: r.owner_overdue ? C.red : C.text, fontWeight: r.owner_overdue ? 700 : 400 }}>{r.owner_overdue}</span> },
          { label: 'Due soon', num: true, render: r => r.owner_due_soon },
          { label: 'Reviewer of', num: true, render: r => r.checker },
          { label: 'Waiting for their review', num: true, render: r => r.review_waiting },
          { label: 'Backup for', num: true, render: r => r.backup },
        ]} />
    </Section>
  );
}
