require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const path   = require('path');
const db     = require('./db');

const USERS_FILE = path.join(__dirname, 'users.json');
// No built-in fallback: a secret written in the code would let anyone who has seen
// the code sign an admin login. Set JWT_SECRET in .env (local) / Vercel settings.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is not set — add it to .env (local) or the Vercel project environment variables');

// ── Permission master list ────────────────────────────────────────────────────
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
      // Edit rights on the Vendor Payment Report: only when ticked (see vprUser in index.js)
      vpr_purchase_team:  'Vendor Payment Report – Purchase Team (upload bills, Purchase Team Remarks)',
      vpr_accounts_team:  'Vendor Payment Report – Accounts Team (Accounts Team Remarks)',
    },
  },
  msme_compliance: { label: 'MSME Compliance', sections: {} },
  vendor_regs: { label: 'Vendor Registrations', sections: {} },
  rpt:         { label: 'Related Party Transactions', sections: {} },
  gst:         { label: 'GST Dashboard', sections: {} },
  tds:         { label: 'TDS Dashboard', sections: {} },
  payroll:     { label: 'Payroll Dashboard', sections: {} },
  compliance:  { label: 'Compliance Dashboard', sections: {} },
  loan:        { label: 'Loan Module', sections: {} },
  pocm:        { label: 'POCM Dashboard', sections: {} },
  fin_stmt:    { label: 'Financial Statements', sections: {} },
  budget:      { label: 'Budget vs. Actual', sections: {} },
  portal:      { label: 'Finance Portal', sections: {} },
  activity:    { label: 'Activity Tracker', sections: {} },
  fpa:         { label: 'FP&A — Financial Model', sections: {} },
};

function allPerms() {
  const p = {};
  for (const [mod, def] of Object.entries(MODULES)) {
    p[mod] = { enabled: true, sections: {} };
    for (const sk of Object.keys(def.sections)) {
      p[mod].sections[sk] = true;
    }
  }
  return p;
}

// ── User store (DB-backed, async) ─────────────────────────────────────────────
async function loadUsers() {
  const users = await db.readJSON('users', USERS_FILE, null);
  if (!users) {
    const admin = {
      id: '1', username: 'admin', name: 'Administrator',
      password: bcrypt.hashSync('Admin@1234', 10),
      role: 'admin', active: true, permissions: allPerms(),
    };
    await db.writeJSON('users', USERS_FILE, [admin]);
    return [admin];
  }
  return users;
}

async function saveUsers(users) {
  await db.writeJSON('users', USERS_FILE, users);
}

// ── JWT helpers ───────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET, { expiresIn: '30d' }
  );
}

// ── Middleware ────────────────────────────────────────────────────────────────
// authMiddleware stays sync (JWT verification is CPU-only, no I/O needed)
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { MODULES, allPerms, loadUsers, saveUsers, signToken, authMiddleware, adminOnly };
