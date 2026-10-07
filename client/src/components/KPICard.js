import React from 'react';

export default function KPICard({ title, value, subValue, subLabel, icon: Icon, color, onClick, loading, error }) {
  const failed = !loading && (value === undefined || value === null || value === '...' || error);
  return (
    <div
      style={{ ...styles.card, borderTop: `3px solid ${failed ? '#C8D6D0' : color}`, cursor: onClick ? 'pointer' : 'default' }}
      onClick={onClick}
    >
      <div style={styles.top}>
        <span style={styles.title}>{title}</span>
        {Icon && <span style={{ ...styles.iconWrap, background: (failed ? '#C8D6D0' : color) + '22' }}><Icon size={18} color={failed ? '#C8D6D0' : color} /></span>}
      </div>
      {loading ? (
        <div style={styles.skeleton} />
      ) : failed ? (
        <div style={styles.errorState}>Unable to load — check server</div>
      ) : (
        <div style={styles.value}>{value}</div>
      )}
      {subValue !== undefined && !failed && (
        <div style={styles.sub}>
          <span style={styles.subLabel}>{subLabel}:</span>
          <span style={styles.subValue}>{loading ? '...' : subValue}</span>
        </div>
      )}
      {onClick && !failed && <div style={styles.drillHint}>Click for details →</div>}
    </div>
  );
}

const styles = {
  card: {
    background: '#FFFFFF',
    borderRadius: '10px',
    padding: '1.25rem 1.5rem',
    display: 'flex', flexDirection: 'column', gap: '0.5rem',
    border: '1px solid #DFE7E3',
    boxShadow: '0 1px 3px rgba(0,18,20,0.06)',
    transition: 'transform 0.15s, box-shadow 0.15s',
  },
  top: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: '#5D6C7B', fontSize: '0.82rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  iconWrap: { width: 34, height: 34, borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  value: { color: '#18191B', fontSize: '1.75rem', fontWeight: 700, lineHeight: 1.2 },
  skeleton: { height: '2rem', background: '#EAF4EF', borderRadius: '6px', animation: 'pulse 1.5s infinite' },
  errorState: { color: '#9BA8B0', fontSize: '0.78rem', fontStyle: 'italic', padding: '0.35rem 0' },
  sub: { display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' },
  subLabel: { color: '#5D6C7B', fontSize: '0.8rem' },
  subValue: { color: '#18191B', fontSize: '0.85rem', fontWeight: 600 },
  drillHint: { color: '#9BA8B0', fontSize: '0.75rem', marginTop: '0.25rem' },
};
