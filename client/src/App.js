import React, { useState } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Sidebar from './components/Sidebar';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import PurchaseDashboard from './pages/PurchaseDashboard';
import RPTDashboard from './pages/RPTDashboard';
import VendorRegistrationForm from './pages/VendorRegistrationForm';
import VendorRegistrations from './pages/VendorRegistrations';
import AdminPage from './pages/AdminPage';
import TDSDashboard from './pages/TDSDashboard';
import PayrollDashboard from './pages/PayrollDashboard';
import LoanDashboard from './pages/LoanDashboard';
import POCMDashboard from './pages/POCMDashboard';
import FinancePortal from './pages/FinancePortal';
import ActivityTracker from './pages/ActivityTracker';
import FinancialStatements from './pages/FinancialStatements';
import BudgetVsActual from './pages/BudgetVsActual';
import { MSMECompanies } from './pages/MSMECompliance';
import GSTDashboard from './pages/GSTDashboard';
import SyncMonitor from './pages/SyncMonitor';
import FPADashboard from './pages/FPADashboard';
import Step15DWorkspace from './pages/Step15DWorkspace';
import Step15FWorkspace from './pages/Step15FWorkspace';
import Step15GWorkspace from './pages/Step15GWorkspace';
import Step15HWorkspace from './pages/Step15HWorkspace';
import FinanceOverview from './pages/FinanceOverview';
import ComplianceDashboard from './pages/ComplianceDashboard';

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) return (
      <div style={{ background: '#0f172a', color: '#f87171', minHeight: '100vh', padding: '2rem', fontFamily: 'monospace' }}>
        <h2 style={{ color: '#ef4444' }}>App Error</h2>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>{this.state.error?.toString()}</pre>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', color: '#94a3b8' }}>{this.state.error?.stack}</pre>
      </div>
    );
    return this.props.children;
  }
}

function AppInner() {
  const { user, loading, hasModule } = useAuth();
  const [page, setPage] = useState('sales');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Public vendor registration form — no auth required
  if (window.location.pathname === '/vendor-register') {
    return <ErrorBoundary><VendorRegistrationForm /></ErrorBoundary>;
  }

  if (loading) {
    return (
      <div style={{ background: '#0f172a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#475569', fontSize: '0.9rem' }}>Loading…</div>
      </div>
    );
  }

  if (!user) {
    return <ErrorBoundary><LoginPage /></ErrorBoundary>;
  }

  const sidebarW = sidebarOpen ? 240 : 60;

  return (
    <ErrorBoundary>
      <div style={{ display: 'flex', background: '#F9F9F9', minHeight: '100vh' }}>
        <Sidebar
          page={page}
          onNavigate={setPage}
          open={sidebarOpen}
          onToggle={() => setSidebarOpen(o => !o)}
        />
        <div style={{ flex: 1, marginLeft: sidebarW, transition: 'margin-left 0.2s ease', minWidth: 0 }}>
          {page === 'fpa'          && hasModule('fpa')           && <FPADashboard />}
          {page === 'fpa-step15d'  && hasModule('fpa')           && <Step15DWorkspace />}
          {page === 'fpa-step15f'  && hasModule('fpa')           && <Step15FWorkspace />}
          {page === 'fpa-step15g'  && hasModule('fpa')           && <Step15GWorkspace />}
          {page === 'fpa-step15h'  && hasModule('fpa')           && <Step15HWorkspace />}
          {page === 'finance-overview' && (hasModule('sales') || hasModule('purchase')) && <FinanceOverview />}
          {page === 'sales'        && hasModule('sales')        && <Dashboard />}
          {page === 'purchase'     && hasModule('purchase')     && <PurchaseDashboard />}
          {(page === 'msme' || page === 'msme-neddle') && hasModule('msme_compliance') && <MSMECompanies active={page === 'msme-neddle' ? 'neddle' : 'devx'} />}
          {page === 'vendor-regs'  && hasModule('vendor_regs')  && <VendorRegistrations />}
          {page === 'rpt'          && hasModule('rpt')          && <RPTDashboard />}
          {page === 'gst'          && hasModule('gst')          && <GSTDashboard />}
          {page === 'tds'          && hasModule('tds')          && <TDSDashboard />}
          {page === 'payroll'      && hasModule('payroll')      && <PayrollDashboard />}
          {page === 'compliance'   && hasModule('compliance')   && <ComplianceDashboard />}
          {page === 'loan'         && hasModule('loan')         && <LoanDashboard />}
          {page === 'pocm'         && hasModule('pocm')         && <POCMDashboard />}
          {page === 'portal'       && <FinancePortal />}
          {page === 'activity'     && <ActivityTracker />}
          {page === 'fin-stmt'     && <FinancialStatements />}
          {page === 'budget'       && <BudgetVsActual />}
          {page === 'admin'        && user.role === 'admin'     && <AdminPage />}
          {page === 'sync-monitor' && user.role === 'admin'     && <SyncMonitor />}
          {/* Access denied message */}
          {['sales','purchase','vendor-regs','rpt','gst','tds','payroll','compliance','loan','pocm','msme','msme-neddle'].includes(page) &&
            !hasModule(page === 'vendor-regs' ? 'vendor_regs' : (page === 'msme' || page === 'msme-neddle') ? 'msme_compliance' : page) && (
            <div style={{ padding: '4rem 2rem', textAlign: 'center', color: '#334155' }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔒</div>
              <div style={{ fontSize: '1rem', fontWeight: 600, color: '#475569', marginBottom: 8 }}>Access Restricted</div>
              <div style={{ fontSize: '0.85rem', color: '#1e3a5f' }}>You don't have permission to view this module. Contact your administrator.</div>
            </div>
          )}
        </div>
      </div>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}
