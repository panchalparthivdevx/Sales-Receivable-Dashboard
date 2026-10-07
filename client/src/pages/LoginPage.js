import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function LoginPage() {
  const { login }            = useAuth();
  const [username, setUser]  = useState('');
  const [password, setPass]  = useState('');
  const [error,    setError] = useState('');
  const [busy,     setBusy]  = useState(false);

  const submit = async e => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err?.response?.data?.error || 'Login failed. Check credentials.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.bg}>
      <div style={S.card}>
        {/* Logo */}
        <div style={S.logoRow}>
          <div style={S.logo}>
            <span style={{ fontSize: '0.85rem', fontWeight: 800, color: '#fff' }}>DA</span>
          </div>
          <div>
            <div style={S.brand}>Dev Accelerator</div>
            <div style={S.sub}>Finance Suite</div>
          </div>
        </div>

        <h2 style={S.title}>Sign in to continue</h2>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={S.label}>Username</label>
            <input
              style={S.input}
              value={username}
              onChange={e => setUser(e.target.value)}
              placeholder="Enter username"
              autoFocus
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label style={S.label}>Password</label>
            <input
              type="password"
              style={S.input}
              value={password}
              onChange={e => setPass(e.target.value)}
              placeholder="Enter password"
              autoComplete="current-password"
              required
            />
          </div>

          {error && <div style={S.error}>{error}</div>}

          <button type="submit" style={{ ...S.btn, opacity: busy ? 0.7 : 1 }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

const S = {
  bg: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#001214',
  },
  card: {
    background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 16,
    padding: '2.5rem 2.25rem', width: '100%', maxWidth: 380,
    boxShadow: '0 20px 60px rgba(0,18,20,0.35)',
  },
  logoRow: {
    display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.75rem',
  },
  logo: {
    width: 42, height: 42, borderRadius: 10,
    background: '#1C4942',
    border: '1px solid #2D6B62',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  brand: { color: '#18191B', fontSize: '0.95rem', fontWeight: 700 },
  sub:   { color: '#9BA8B0', fontSize: '0.73rem', marginTop: 2 },
  title: {
    color: '#18191B', fontSize: '1.15rem', fontWeight: 600,
    margin: '0 0 1.5rem', letterSpacing: '-0.01em',
  },
  label: { display: 'block', color: '#5D6C7B', fontSize: '0.77rem', fontWeight: 600, marginBottom: '0.35rem', letterSpacing: '0.04em', textTransform: 'uppercase' },
  input: {
    width: '100%', boxSizing: 'border-box',
    background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8,
    padding: '0.65rem 0.85rem', color: '#18191B', fontSize: '0.9rem', outline: 'none',
    transition: 'border-color 0.15s',
  },
  error: {
    background: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: 8, padding: '0.6rem 0.85rem', color: '#DC2626', fontSize: '0.82rem',
  },
  btn: {
    width: '100%', padding: '0.75rem',
    background: '#1C4942',
    border: 'none', borderRadius: 8, color: '#fff',
    fontSize: '0.92rem', fontWeight: 600, cursor: 'pointer',
    transition: 'opacity 0.15s, background 0.15s',
  },
};
