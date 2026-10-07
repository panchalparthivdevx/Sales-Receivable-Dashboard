import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { formatINR } from '../utils/format';

function ratingFor(ratio, type) {
  if (type === 'turnover') {
    if (ratio >= 6)  return { label: 'Excellent', color: '#22c55e', bg: '#22c55e18' };
    if (ratio >= 3)  return { label: 'Good',      color: '#84cc16', bg: '#84cc1618' };
    if (ratio >= 1.5)return { label: 'Average',   color: '#f59e0b', bg: '#f59e0b18' };
    return           { label: 'Poor',             color: '#ef4444', bg: '#ef444418' };
  } else {
    if (ratio <= 15) return { label: 'Excellent', color: '#22c55e', bg: '#22c55e18' };
    if (ratio <= 25) return { label: 'Good',      color: '#84cc16', bg: '#84cc1618' };
    if (ratio <= 40) return { label: 'Average',   color: '#f59e0b', bg: '#f59e0b18' };
    return           { label: 'High Risk',        color: '#ef4444', bg: '#ef444418' };
  }
}

function FormulaRow({ label, value }) {
  return (
    <div style={S.formulaRow}>
      <span style={S.formulaLabel}>{label}</span>
      <span style={S.formulaVal}>{value}</span>
    </div>
  );
}

function RatioCard({ title, value, unit, formula, description, type, components, extraMetric }) {
  const [showDetail, setShowDetail] = useState(false);
  const rating = ratingFor(parseFloat(value), type);

  return (
    <div style={{ ...S.ratioCard, borderTop: `3px solid ${rating.color}` }}>
      {/* Header */}
      <div style={S.ratioHeader}>
        <div>
          <p style={S.ratioTitle}>{title}</p>
          <p style={S.ratioFormula}>{formula}</p>
        </div>
        <span style={{ ...S.badge, background: rating.bg, color: rating.color }}>{rating.label}</span>
      </div>

      {/* Big number */}
      <div style={S.ratioValue}>
        <span style={{ color: rating.color }}>{value}</span>
        <span style={S.ratioUnit}>{unit}</span>
      </div>

      {/* Extra metric */}
      {extraMetric && (
        <div style={S.extraMetric}>
          <span style={S.extraLabel}>{extraMetric.label}:</span>
          <span style={{ ...S.extraVal, color: rating.color }}>{extraMetric.value}</span>
        </div>
      )}

      {/* Description */}
      <p style={S.ratioDesc}>{description}</p>

      {/* Formula breakdown toggle */}
      <button style={S.detailBtn} onClick={() => setShowDetail(d => !d)}>
        {showDetail ? '▲ Hide' : '▼ Formula breakdown'}
      </button>

      {showDetail && (
        <div style={S.formulaBox}>
          {components.map((c, i) => <FormulaRow key={i} label={c.label} value={c.value} />)}
        </div>
      )}
    </div>
  );
}

export default function ARRatios() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState('fy');

  useEffect(() => {
    api.arRatios()
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={S.section}>
      <div style={S.sectionHeader}>
        <h3 style={S.sectionTitle}>Analytical Ratios</h3>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <div style={S.skeleton} /><div style={S.skeleton} />
      </div>
    </div>
  );

  if (!data) return null;

  const d = tab === 'fy' ? data.fy : data.this_month;
  const tabLabel = tab === 'fy' ? 'FY 2026-27' : 'This Month';

  const fyLabel = (() => {
    const now = new Date();
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `FY ${y}-${String(y + 1).slice(2)}`;
  })();

  return (
    <div style={S.section}>
      <div style={S.sectionHeader}>
        <div>
          <h3 style={S.sectionTitle}>Analytical Ratios — Sales & Receivables</h3>
          <p style={S.sectionSub}>Key efficiency metrics for credit management and cash collection</p>
        </div>
        <div style={S.toggleWrap}>
          {[['fy', fyLabel], ['this_month', 'This Month']].map(([k, lbl]) => (
            <button key={k} style={{ ...S.tab, ...(tab === k ? S.tabActive : {}) }} onClick={() => setTab(k)}>{lbl}</button>
          ))}
        </div>
      </div>

      <div style={S.grid}>
        <RatioCard
          title="Accounts Receivable Turnover Ratio"
          value={d.ar_turnover.toFixed(2)}
          unit="x"
          formula="Net Credit Sales ÷ Average Accounts Receivable"
          description="Measures how many times receivables are collected during the period. Higher = more efficient credit management."
          type="turnover"
          extraMetric={{ label: 'Equivalent days to collect', value: `${d.days_to_collect} days` }}
          components={[
            { label: 'Net Credit Sales',        value: formatINR(d.net_credit_sales) },
            { label: 'Opening AR (period start)',value: formatINR(d.opening_ar) },
            { label: 'Closing AR (today)',       value: formatINR(d.closing_ar) },
            { label: 'Average AR',               value: formatINR(d.average_ar) },
            { label: 'AR Turnover Ratio',        value: `${d.ar_turnover.toFixed(2)}x` },
          ]}
        />

        <RatioCard
          title="Receivables to Sales Ratio"
          value={d.receivables_to_sales_pct.toFixed(2)}
          unit="%"
          formula="Average Accounts Receivable ÷ Total Net Sales × 100"
          description="Proportion of sales that remain unpaid. Lower % = reduced liquidity risk and better collections efficiency."
          type="receivables_pct"
          extraMetric={{ label: 'Amount tied up in receivables', value: formatINR(d.average_ar) }}
          components={[
            { label: 'Average AR (numerator)',   value: formatINR(d.average_ar) },
            { label: 'Total Net Sales (denominator)', value: formatINR(d.net_credit_sales) },
            { label: 'Receivables to Sales',     value: `${d.receivables_to_sales_pct.toFixed(2)}%` },
            { label: 'Opening AR',               value: formatINR(d.opening_ar) },
            { label: 'Closing AR',               value: formatINR(d.closing_ar) },
          ]}
        />
      </div>

      {/* Benchmark legend */}
      <div style={S.legend}>
        <span style={S.legendTitle}>Benchmarks:</span>
        {[
          { label: 'Excellent', color: '#22c55e' },
          { label: 'Good',      color: '#84cc16' },
          { label: 'Average',   color: '#f59e0b' },
          { label: 'Poor / High Risk', color: '#ef4444' },
        ].map(b => (
          <span key={b.label} style={S.legendItem}>
            <span style={{ ...S.dot, background: b.color }} />
            {b.label}
          </span>
        ))}
        <span style={{ color: '#9BA8B0', fontSize: '0.75rem', marginLeft: 'auto' }}>
          Turnover: Excellent ≥6x · Good ≥3x · Average ≥1.5x &nbsp;|&nbsp; Receivables %: Excellent ≤15% · Good ≤25% · Average ≤40%
        </span>
      </div>
    </div>
  );
}

const S = {
  section: { background: '#FFFFFF', borderRadius: '10px', border: '1px solid #DFE7E3', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', boxShadow: '0 1px 3px rgba(0,18,20,0.06)' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' },
  sectionTitle: { margin: 0, color: '#18191B', fontSize: '0.95rem', fontWeight: 600 },
  sectionSub: { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.78rem' },
  toggleWrap: { display: 'flex', background: '#F2F2F2', borderRadius: '8px', padding: 2 },
  tab: { padding: '5px 14px', borderRadius: '6px', border: 'none', background: 'none', color: '#5D6C7B', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 500 },
  tabActive: { background: '#1C4942', color: '#fff' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' },
  skeleton: { height: 220, background: '#EAF4EF', borderRadius: 8 },
  // Ratio card
  ratioCard: { background: '#F9F9F9', borderRadius: '10px', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.6rem', border: '1px solid #DFE7E3' },
  ratioHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' },
  ratioTitle: { margin: 0, color: '#18191B', fontSize: '0.9rem', fontWeight: 600 },
  ratioFormula: { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.75rem', fontStyle: 'italic' },
  badge: { padding: '3px 10px', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 },
  ratioValue: { display: 'flex', alignItems: 'baseline', gap: '0.4rem' },
  ratioValueNum: { fontSize: '2.25rem', fontWeight: 800, lineHeight: 1 },
  ratioUnit: { color: '#9BA8B0', fontSize: '1.1rem', fontWeight: 500 },
  extraMetric: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#F2F2F2', borderRadius: 6, padding: '0.4rem 0.75rem' },
  extraLabel: { color: '#5D6C7B', fontSize: '0.78rem' },
  extraVal: { fontWeight: 600, fontSize: '0.85rem' },
  ratioDesc: { margin: 0, color: '#5D6C7B', fontSize: '0.8rem', lineHeight: 1.5 },
  detailBtn: { background: 'none', border: 'none', color: '#1C4942', cursor: 'pointer', fontSize: '0.78rem', textAlign: 'left', padding: 0 },
  formulaBox: { background: '#F2F2F2', borderRadius: 8, padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', border: '1px solid #DFE7E3' },
  formulaRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  formulaLabel: { color: '#5D6C7B', fontSize: '0.8rem' },
  formulaVal: { color: '#18191B', fontSize: '0.85rem', fontWeight: 600 },
  legend: { display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid #DFE7E3' },
  legendTitle: { color: '#5D6C7B', fontSize: '0.78rem', fontWeight: 600 },
  legendItem: { display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#9BA8B0', fontSize: '0.78rem' },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
};
