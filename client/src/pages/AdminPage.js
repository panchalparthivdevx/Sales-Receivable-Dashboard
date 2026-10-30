import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Plus, Edit2, Trash2, X, Check, Eye, EyeOff, ShieldCheck, User } from 'lucide-react';

const BASE = `/api`;

// ── Permission module definitions (mirrors server/auth.js MODULES) ───────────
const MODULES = {
  sales: {
    label: 'Sales & Receivables',
    sections: {
      kpi_avg_delay:           'Avg Payment Delay KPI',
      kpi_invoice_count:       'Invoice Count KPI',
      kpi_revenue:             'Revenue KPI',
      kpi_collections:         'Collections KPI',
      kpi_receivables:         'Receivables KPI',
      kpi_ar_ratios:           'AR Ratios',
      kpi_occupancy:           'Occupancy Report',
      kpi_ar_aging:            'AR Aging Report',
      chart_rev_category:      'Revenue by Category',
      chart_rev_tier:          'Revenue by Tier',
      chart_rev_city:          'Revenue by City',
      chart_branch_outstanding:'Branch Outstanding',
      chart_top_clients:       'Top Clients',
      chart_payment_delay:     'Client Payment Delay',
      section_agreements:      'Agreement Expiry',
      section_forex:           'Foreign Exchange',
    },
  },
  purchase: {
    label: 'Purchase & Payables',
    sections: {
      kpi_avg_delay:      'Avg Payment Delay KPI',
      kpi_bill_count:     'Bill Count KPI',
      kpi_expense:        'Expense KPI',
      kpi_payables:       'Payables KPI',
      kpi_payments:       'Payments KPI',
      kpi_ap_aging:       'AP Aging Report',
      chart_exp_category: 'Expense by Category',
      chart_exp_branch:   'Expense by Branch',
      chart_top_vendors:  'Top Vendors',
      report_rent:        'Month-wise Rent Report',
      report_vendor_cat:  'Vendor Category Report',
      report_po:          'Project-wise PO Report',
      report_vendor_payments: 'Vendor Payment Report',
      report_msme:        'MSME Vendor Payment Report',
      vpr_purchase_team:  'Vendor Payment Report – Purchase Team (upload bills, Purchase Team Remarks)',
      vpr_accounts_team:  'Vendor Payment Report – Accounts Team (Accounts Team Remarks)',
    },
  },
  vendor_regs:  { label: 'Vendor Registrations',     sections: {} },
  rpt:          { label: 'Related Party Transactions', sections: {} },
  gst:          { label: 'GST Dashboard',              sections: {} },
  tds:          { label: 'TDS Dashboard',              sections: {} },
  payroll:      { label: 'Payroll Dashboard',          sections: {} },
  loan:         { label: 'Loan Module',                sections: {} },
  pocm:         { label: 'POCM Dashboard',             sections: {} },
  fin_stmt:     { label: 'Financial Statements',       sections: {} },
  budget:       { label: 'Budget vs. Actual',          sections: {} },
  portal:       { label: 'Finance Portal',             sections: {} },
  activity:     { label: 'Activity Tracker',           sections: {} },
};

function emptyPerms() {
  const p = {};
  for (const [mod, def] of Object.entries(MODULES)) {
    p[mod] = { enabled: false, sections: {} };
    for (const sk of Object.keys(def.sections)) p[mod].sections[sk] = false;
  }
  return p;
}

// Edit rights (not just viewing): ticked one by one — never by "All" or a new user's default access
const GRANT_ONLY = new Set(['vpr_purchase_team', 'vpr_accounts_team']);

function fullPerms() {
  const p = {};
  for (const [mod, def] of Object.entries(MODULES)) {
    p[mod] = { enabled: true, sections: {} };
    for (const sk of Object.keys(def.sections)) p[mod].sections[sk] = !GRANT_ONLY.has(sk);
  }
  return p;
}

// ── Styles ───────────────────────────────────────────────────────────────────
const S = {
  page:    { padding: '2rem', color: '#18191B', minHeight: '100vh', background: '#F9F9F9' },
  header:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.75rem' },
  heading: { margin: 0, fontSize: '1.4rem', fontWeight: 700, color: '#18191B' },
  sub:     { color: '#5D6C7B', fontSize: '0.82rem', marginTop: 4 },
  card:    { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, overflow: 'hidden' },
  th:      { padding: '0.65rem 1rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.73rem', textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'left', borderBottom: '1px solid #DFE7E3' },
  td:      { padding: '0.75rem 1rem', borderBottom: '1px solid #DFE7E3', fontSize: '0.86rem' },
  btnPrimary: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0.55rem 1.1rem', background: '#1C4942', border: 'none', borderRadius: 8, color: '#fff', fontSize: '0.84rem', fontWeight: 600, cursor: 'pointer' },
  btnIcon:    { background: 'none', border: 'none', cursor: 'pointer', padding: '0.3rem', borderRadius: 6, display: 'inline-flex', alignItems: 'center' },
  badge: (role) => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 8px', borderRadius: 20, fontSize: '0.72rem', fontWeight: 600,
    background: role === 'admin' ? 'rgba(139,92,246,0.15)' : '#EAF4EF',
    color: role === 'admin' ? '#a78bfa' : '#1C4942',
    border: `1px solid ${role === 'admin' ? '#4c1d95' : '#A7C4BC'}`,
  }),
  active: (on) => ({ width: 8, height: 8, borderRadius: '50%', background: on ? '#15803D' : '#DFE7E3', display: 'inline-block', marginRight: 6 }),
};

// ── Overlay modal ─────────────────────────────────────────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '2rem 1rem' }}>
      <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 14, width: '100%', maxWidth: 780, boxShadow: '0 20px 60px rgba(0,18,20,0.15)', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.1rem 1.5rem', borderBottom: '1px solid #DFE7E3' }}>
          <span style={{ fontWeight: 700, fontSize: '1rem', color: '#18191B' }}>{title}</span>
          <button style={{ ...S.btnIcon, color: '#5D6C7B' }} onClick={onClose}><X size={18} /></button>
        </div>
        <div style={{ padding: '1.5rem' }}>{children}</div>
      </div>
    </div>
  );
}

// ── Permission matrix ─────────────────────────────────────────────────────────
function PermMatrix({ perms, onChange, isAdmin }) {
  const toggle = (mod, section, val) => {
    const next = JSON.parse(JSON.stringify(perms));
    if (section === '__module__') {
      next[mod].enabled = val;
      // if disabling module, uncheck all sections
      if (!val) for (const sk of Object.keys(next[mod].sections)) next[mod].sections[sk] = false;
    } else {
      next[mod].sections[section] = val;
      // if enabling a section, auto-enable the module
      if (val) next[mod].enabled = true;
    }
    onChange(next);
  };

  const selectAll = (mod, val) => {
    const next = JSON.parse(JSON.stringify(perms));
    next[mod].enabled = val;
    next[mod].sections = next[mod].sections || {};
    for (const sk of new Set([...Object.keys(next[mod].sections), ...Object.keys(MODULES[mod].sections)])) {
      next[mod].sections[sk] = GRANT_ONLY.has(sk) ? (val && !!next[mod].sections[sk]) : val;
    }
    onChange(next);
  };

  if (isAdmin) {
    return (
      <div style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid #4c1d95', borderRadius: 10, padding: '1rem 1.25rem', color: '#a78bfa', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 8 }}>
        <ShieldCheck size={16} /> Admin role has full access to all modules and reports — permissions are not editable.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {Object.entries(MODULES).map(([mod, def]) => {
        const mp         = perms[mod] || { enabled: false, sections: {} };
        const hasSections = Object.keys(def.sections).length > 0;
        return (
          <div key={mod} style={{ background: '#F9F9F9', border: `1px solid ${mp.enabled ? '#DFE7E3' : '#DFE7E3'}`, borderRadius: 10, overflow: 'hidden' }}>
            {/* Module header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.65rem 1rem', background: mp.enabled ? '#EAF4EF' : 'transparent', borderBottom: hasSections && mp.enabled ? '1px solid #DFE7E3' : 'none' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }}>
                <input
                  type="checkbox"
                  checked={!!mp.enabled}
                  onChange={e => toggle(mod, '__module__', e.target.checked)}
                  style={{ accentColor: '#1C4942', width: 16, height: 16 }}
                />
                <span style={{ fontWeight: 700, color: mp.enabled ? '#18191B' : '#9BA8B0', fontSize: '0.88rem' }}>{def.label}</span>
              </label>
              {hasSections && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={{ ...S.btnIcon, fontSize: '0.7rem', color: '#5D6C7B', padding: '2px 8px', border: '1px solid #DFE7E3', borderRadius: 5 }} onClick={() => selectAll(mod, true)}>All</button>
                  <button style={{ ...S.btnIcon, fontSize: '0.7rem', color: '#5D6C7B', padding: '2px 8px', border: '1px solid #DFE7E3', borderRadius: 5 }} onClick={() => selectAll(mod, false)}>None</button>
                </div>
              )}
            </div>
            {/* Sections */}
            {hasSections && mp.enabled && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '0.4rem', padding: '0.75rem 1rem' }}>
                {Object.entries(def.sections).map(([sk, slabel]) => (
                  <label key={sk} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '0.25rem 0.4rem', borderRadius: 6 }}>
                    <input
                      type="checkbox"
                      checked={!!mp.sections?.[sk]}
                      onChange={e => toggle(mod, sk, e.target.checked)}
                      style={{ accentColor: '#1C4942', width: 14, height: 14 }}
                    />
                    <span style={{ color: '#9BA8B0', fontSize: '0.81rem' }}>{slabel}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── User form modal ───────────────────────────────────────────────────────────
function UserModal({ user: editUser, onClose, onSaved }) {
  const isNew = !editUser;
  const [name,     setName]     = useState(editUser?.name     || '');
  const [username, setUsername] = useState(editUser?.username || '');
  const [password, setPassword] = useState('');
  const [role,     setRole]     = useState(editUser?.role     || 'user');
  const [active,   setActive]   = useState(editUser?.active !== false);
  const [perms,    setPerms]    = useState(() => editUser?.permissions || fullPerms());
  const [showPass, setShowPass] = useState(false);
  const [tab,      setTab]      = useState('info');
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState('');

  const save = async () => {
    if (!username.trim()) return setError('Username is required');
    if (isNew && !password)  return setError('Password is required for new users');
    setBusy(true); setError('');
    try {
      const payload = { name: name || username, username, role, active, permissions: perms };
      if (password) payload.password = password;
      if (isNew) {
        await axios.post(`${BASE}/auth/users`, payload);
      } else {
        await axios.put(`${BASE}/auth/users/${editUser.id}`, payload);
      }
      onSaved();
    } catch (e) {
      setError(e?.response?.data?.error || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const I = { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 7, padding: '0.6rem 0.8rem', color: '#18191B', fontSize: '0.88rem', outline: 'none', width: '100%', boxSizing: 'border-box' };
  const LB = { display: 'block', color: '#5D6C7B', fontSize: '0.72rem', fontWeight: 600, marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.04em' };

  return (
    <Modal title={isNew ? 'Add New User' : `Edit — ${editUser.username}`} onClose={onClose}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1.25rem', borderBottom: '1px solid #DFE7E3', paddingBottom: '0.75rem' }}>
        {['info', 'permissions'].map(t => (
          <button key={t} style={{ padding: '0.35rem 0.9rem', borderRadius: 6, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem', background: tab === t ? '#EAF4EF' : 'transparent', color: tab === t ? '#1C4942' : '#5D6C7B' }} onClick={() => setTab(t)}>
            {t === 'info' ? 'User Info' : 'Permissions'}
          </button>
        ))}
      </div>

      {tab === 'info' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={LB}>Full Name</label>
              <input style={I} value={name} onChange={e => setName(e.target.value)} placeholder="Display name" />
            </div>
            <div>
              <label style={LB}>Username *</label>
              <input style={I} value={username} onChange={e => setUsername(e.target.value)} placeholder="login username" disabled={!isNew} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={LB}>{isNew ? 'Password *' : 'New Password (leave blank to keep)'}</label>
              <div style={{ position: 'relative' }}>
                <input type={showPass ? 'text' : 'password'} style={{ ...I, paddingRight: '2.5rem' }} value={password} onChange={e => setPassword(e.target.value)} placeholder={isNew ? 'Set password' : 'Leave blank to keep'} />
                <button style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#5D6C7B' }} onClick={() => setShowPass(v => !v)}>
                  {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <div>
              <label style={LB}>Role</label>
              <select style={I} value={role} onChange={e => setRole(e.target.value)}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          {!isNew && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} style={{ accentColor: '#1C4942', width: 16, height: 16 }} />
              <span style={{ color: '#9BA8B0', fontSize: '0.86rem' }}>Account active (uncheck to disable login without deleting)</span>
            </label>
          )}
        </div>
      )}

      {tab === 'permissions' && (
        <PermMatrix perms={perms} onChange={setPerms} isAdmin={role === 'admin'} />
      )}

      {error && <div style={{ marginTop: '1rem', background: 'rgba(220,38,38,0.06)', border: '1px solid #DC2626', borderRadius: 8, padding: '0.6rem 0.85rem', color: '#DC2626', fontSize: '0.82rem' }}>{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid #DFE7E3' }}>
        <button style={{ padding: '0.55rem 1.1rem', background: 'none', border: '1px solid #DFE7E3', borderRadius: 8, color: '#5D6C7B', cursor: 'pointer', fontSize: '0.84rem' }} onClick={onClose}>Cancel</button>
        <button style={{ ...S.btnPrimary, opacity: busy ? 0.7 : 1 }} onClick={save} disabled={busy}>
          <Check size={15} /> {busy ? 'Saving…' : 'Save User'}
        </button>
      </div>
    </Modal>
  );
}

// ── Main AdminPage ────────────────────────────────────────────────────────────
export default function AdminPage() {
  const [users,    setUsers]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [editUser, setEditUser] = useState(null);   // null = closed, false = new, obj = edit
  const [confirm,  setConfirm]  = useState(null);   // user to delete

  const load = useCallback(() => {
    setLoading(true);
    axios.get(`${BASE}/auth/users`)
      .then(r => setUsers(r.data))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const deleteUser = async (id) => {
    await axios.delete(`${BASE}/auth/users/${id}`);
    setConfirm(null);
    load();
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div>
          <h1 style={S.heading}>User Management</h1>
          <p style={S.sub}>Control who can access the dashboard and which modules/reports they can see</p>
        </div>
        <button style={S.btnPrimary} onClick={() => setEditUser(false)}>
          <Plus size={15} /> Add User
        </button>
      </div>

      {/* Default credentials notice */}
      <div style={{ background: '#FFFDF0', border: '1px solid #B45309', borderRadius: 10, padding: '0.8rem 1.1rem', marginBottom: '1.5rem', fontSize: '0.82rem', color: '#B45309' }}>
        Default admin credentials: username <strong>admin</strong> / password <strong>Admin@1234</strong> — change the password after first login.
      </div>

      <div style={S.card}>
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: '#9BA8B0' }}>Loading users…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Name', 'Username', 'Role', 'Status', 'Modules Visible', 'Actions'].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const enabledMods = u.role === 'admin'
                  ? Object.values(MODULES).map(m => m.label)
                  : Object.entries(MODULES).filter(([mod]) => u.permissions?.[mod]?.enabled).map(([, def]) => def.label);
                return (
                  <tr key={u.id}>
                    <td style={S.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 30, height: 30, borderRadius: '50%', background: u.role === 'admin' ? 'rgba(139,92,246,0.15)' : '#EAF4EF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {u.role === 'admin' ? <ShieldCheck size={14} color="#a78bfa" /> : <User size={14} color="#1C4942" />}
                        </div>
                        <span style={{ color: '#18191B', fontWeight: 500 }}>{u.name || u.username}</span>
                      </div>
                    </td>
                    <td style={{ ...S.td, color: '#5D6C7B', fontFamily: 'monospace', fontSize: '0.82rem' }}>{u.username}</td>
                    <td style={S.td}><span style={S.badge(u.role)}>{u.role === 'admin' ? '⚡ Admin' : '👤 User'}</span></td>
                    <td style={S.td}><span style={S.active(u.active !== false)} />{u.active !== false ? 'Active' : <span style={{ color: '#ef4444' }}>Disabled</span>}</td>
                    <td style={{ ...S.td, maxWidth: 280 }}>
                      {u.role === 'admin'
                        ? <span style={{ color: '#a78bfa', fontSize: '0.8rem' }}>All modules</span>
                        : enabledMods.length === 0
                          ? <span style={{ color: '#9BA8B0', fontSize: '0.8rem' }}>No access</span>
                          : <span style={{ color: '#5D6C7B', fontSize: '0.78rem' }}>{enabledMods.join(', ')}</span>
                      }
                    </td>
                    <td style={S.td}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button style={{ ...S.btnIcon, color: '#1C4942' }} title="Edit" onClick={() => setEditUser(u)}><Edit2 size={15} /></button>
                        {u.role !== 'admin' && (
                          <button style={{ ...S.btnIcon, color: '#ef4444' }} title="Delete" onClick={() => setConfirm(u)}><Trash2 size={15} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Edit / Add modal */}
      {editUser !== null && (
        <UserModal
          user={editUser || null}
          onClose={() => setEditUser(null)}
          onSaved={() => { setEditUser(null); load(); }}
        />
      )}

      {/* Delete confirm */}
      {confirm && (
        <Modal title="Delete User" onClose={() => setConfirm(null)}>
          <p style={{ color: '#9BA8B0', margin: '0 0 1.5rem' }}>
            Are you sure you want to delete <strong style={{ color: '#18191B' }}>{confirm.name || confirm.username}</strong>? This cannot be undone.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button style={{ padding: '0.5rem 1rem', background: 'none', border: '1px solid #DFE7E3', borderRadius: 8, color: '#5D6C7B', cursor: 'pointer' }} onClick={() => setConfirm(null)}>Cancel</button>
            <button style={{ padding: '0.5rem 1rem', background: '#ef4444', border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer', fontWeight: 600 }} onClick={() => deleteUser(confirm.id)}>Delete</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
