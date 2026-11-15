import React, { useEffect, useMemo, useState } from 'react';
import { api, errMsg, download } from './api';
import { C, S, Section, Note, Btn, StatusBadge, Tabs, Empty, dt } from './ui';

// Calendar of effective statutory due dates (extended date where an approved extension applies). Tasks without a due date are
// listed separately — they are never placed on a day and never shown as overdue.

const DAY = 86400000;
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const parse = s => new Date(`${s}T00:00:00`);
const tone = t => (t.status === 'completed' ? C.green : t.overdue ? C.red : t.due_soon ? C.amber : C.lav);

function Chip({ t, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen(t.id)} title={`${t.rule_name} — ${t.period_label} — ${t.scope_label} (${t.status_label})`}
      style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', borderLeft: `3px solid ${tone(t)}`, background: '#F8F9FC', borderRadius: 4, padding: '2px 5px', marginBottom: 2, fontSize: '0.68rem', cursor: 'pointer', fontFamily: 'inherit', color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {t.form || t.rule_id} · {t.scope_label.split(' ').slice(-1)[0]}
    </button>
  );
}

export default function CalendarTab({ params, stamp, onOpenTask, today, demo }) {
  const [tasks, setTasks] = useState(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState('month');
  const [cursor, setCursor] = useState(() => parse(today || iso(new Date())));
  useEffect(() => { setTasks(null); api.tasks(params).then(r => setTasks(r.tasks)).catch(e => setErr(errMsg(e))); }, [params, stamp]);
  const byDay = useMemo(() => { const m = new Map(); for (const t of tasks || []) if (t.effective_due) (m.get(t.effective_due) || m.set(t.effective_due, []).get(t.effective_due)).push(t); return m; }, [tasks]);
  if (err) return <Note tone="error">{err}</Note>;
  if (!tasks) return <Empty>Loading…</Empty>;
  const undated = tasks.filter(t => !t.effective_due);
  const move = n => {
    const d = new Date(cursor);
    if (view === 'month') d.setMonth(d.getMonth() + n); else if (view === 'week') d.setDate(d.getDate() + 7 * n); else d.setDate(d.getDate() + 30 * n);
    setCursor(d);
  };
  let body;
  if (view === 'month') {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first.getTime() - ((first.getDay() + 6) % 7) * DAY);
    const days = Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * DAY));
    body = (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }} role="grid" aria-label="Month">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} style={{ ...S.label, textAlign: 'center' }}>{d}</div>)}
        {days.map(d => {
          const k = iso(d); const list = byDay.get(k) || []; const inMonth = d.getMonth() === cursor.getMonth();
          return (
            <div key={k} role="gridcell" aria-label={`${dt(k)}: ${list.length} due`} style={{ minHeight: 92, background: inMonth ? '#fff' : '#FAFBFD', border: `1px solid ${k === today ? C.lav : C.line}`, borderRadius: 8, padding: 4 }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: k === today ? C.lav : inMonth ? C.muted : C.faint }}>{d.getDate()}</div>
              {list.slice(0, 4).map(t => <Chip key={t.id} t={t} onOpen={onOpenTask} />)}
              {list.length > 4 && <button type="button" onClick={() => { setCursor(d); setView('agenda'); }} style={{ border: 'none', background: 'none', color: C.lav, fontSize: '0.68rem', cursor: 'pointer', padding: 0 }}>+{list.length - 4} more</button>}
            </div>
          );
        })}
      </div>
    );
  } else if (view === 'week') {
    const start = new Date(cursor.getTime() - ((cursor.getDay() + 6) % 7) * DAY);
    const days = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * DAY));
    body = (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 6 }}>
        {days.map(d => { const k = iso(d); const list = byDay.get(k) || []; return (
          <div key={k} style={{ background: '#fff', border: `1px solid ${k === today ? C.lav : C.line}`, borderRadius: 10, padding: 6, minHeight: 160 }}>
            <div style={{ fontSize: '0.74rem', fontWeight: 700, color: C.navy, marginBottom: 4 }}>{d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}</div>
            {list.length ? list.map(t => <Chip key={t.id} t={t} onOpen={onOpenTask} />) : <div style={S.small}>Nothing due</div>}
          </div>); })}
      </div>
    );
  } else {
    const from = iso(cursor); const to = iso(new Date(cursor.getTime() + 30 * DAY));
    const keys = [...byDay.keys()].filter(k => k >= from && k <= to).sort();
    body = keys.length ? keys.map(k => (
      <div key={k} style={{ marginBottom: 10 }}>
        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: k === today ? C.lav : C.navy, marginBottom: 4 }}>{dt(k)}</div>
        {byDay.get(k).map(t => (
          <button key={t.id} type="button" onClick={() => onOpenTask(t.id)} style={{ display: 'flex', gap: 10, alignItems: 'center', width: '100%', textAlign: 'left', border: `1px solid ${C.line}`, borderLeft: `4px solid ${tone(t)}`, background: '#fff', borderRadius: 8, padding: '6px 8px', marginBottom: 4, cursor: 'pointer', fontFamily: 'inherit' }}>
            <span style={{ flex: 1, fontSize: '0.8rem' }}><b>{t.rule_name}</b> · {t.period_label}<span style={{ ...S.small, display: 'block' }}>{t.scope_label}{t.revised_due ? ` · extended from ${dt(t.original_due)}` : ''}</span></span>
            <StatusBadge status={t.status} label={t.status_label} />
          </button>
        ))}
      </div>
    )) : <Empty>Nothing due between {dt(from)} and {dt(to)}</Empty>;
  }
  const title = view === 'month' ? cursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : view === 'week' ? `Week of ${dt(iso(new Date(cursor.getTime() - ((cursor.getDay() + 6) % 7) * DAY)))}` : `30 days from ${dt(iso(cursor))}`;
  return (
    <div>
      <Section title={`Calendar — ${title}`} sub={`Effective statutory due dates (extended dates where an approved extension applies)${demo ? ' · demo snapshot' : ' · Asia/Kolkata'}`} right={<>
        <Btn kind="onNavy" small onClick={() => move(-1)} aria-label="Previous">‹</Btn>
        <Btn kind="onNavy" small onClick={() => setCursor(parse(today))}>Today</Btn>
        <Btn kind="onNavy" small onClick={() => move(1)} aria-label="Next">›</Btn>
        <Btn kind="onNavy" small onClick={() => download('/export/calendar.ics', params, 'compliance.ics').catch(e => setErr(errMsg(e)))}>Export .ics</Btn>
      </>}>
        <Tabs tabs={[{ id: 'month', label: 'Month' }, { id: 'week', label: 'Week' }, { id: 'agenda', label: 'Agenda (30 days)' }]} value={view} onChange={setView} />
        {body}
        <div style={{ ...S.small, marginTop: 8 }}>Colour: <span style={{ color: C.red }}>■</span> overdue <span style={{ color: C.amber }}>■</span> due soon <span style={{ color: C.lav }}>■</span> upcoming <span style={{ color: C.green }}>■</span> completed. Dates are never moved for weekends or holidays.</div>
      </Section>
      {undated.length > 0 && (
        <Section title={`No due date (${undated.length})`} sub="Waiting for a rule, a state rule, an event date or a manual date — not on the calendar and never overdue">
          {undated.slice(0, 200).map(t => <button key={t.id} type="button" onClick={() => onOpenTask(t.id)} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', borderBottom: `1px solid ${C.line}`, background: 'none', padding: '5px 2px', fontSize: '0.78rem', cursor: 'pointer', fontFamily: 'inherit' }}><b>{t.rule_name}</b> · {t.period_label} · {t.scope_label} <span style={S.small}>— {t.due_pending}</span></button>)}
        </Section>
      )}
    </div>
  );
}
