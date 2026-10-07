import React from 'react';

export default function ChartCard({ title, toggle, onToggle, toggleOptions, children, loading }) {
  const opts = toggleOptions || ['This Month', 'As on Date'];
  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <h3 style={styles.title}>{title}</h3>
        {toggle && (
          <div style={styles.toggleWrap}>
            {opts.map(opt => (
              <button
                key={opt}
                style={{ ...styles.toggleBtn, ...(toggle === opt ? styles.toggleActive : {}) }}
                onClick={() => onToggle(opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={styles.body}>
        {loading ? <div style={styles.skeleton} /> : children}
      </div>
    </div>
  );
}

const styles = {
  card: {
    background: '#FFFFFF',
    borderRadius: '10px',
    padding: '1.25rem 1.5rem',
    border: '1px solid #DFE7E3',
    boxShadow: '0 1px 3px rgba(0,18,20,0.06)',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' },
  title: { margin: 0, color: '#18191B', fontSize: '0.95rem', fontWeight: 600 },
  toggleWrap: { display: 'flex', background: '#F2F2F2', borderRadius: '8px', padding: '2px', border: '1px solid #DFE7E3' },
  toggleBtn: { padding: '4px 12px', borderRadius: '6px', border: 'none', background: 'none', color: '#5D6C7B', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500 },
  toggleActive: { background: '#1C4942', color: '#fff' },
  body: { minHeight: '200px' },
  skeleton: { height: '200px', background: '#EAF4EF', borderRadius: '8px', animation: 'pulse 1.5s infinite' },
};
