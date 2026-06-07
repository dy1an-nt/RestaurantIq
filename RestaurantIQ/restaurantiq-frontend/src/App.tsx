import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './components/auth/AuthContext';
import { RestaurantProvider } from './components/restaurant/RestaurantContext';
import RequireRestaurant from './components/restaurant/RequireRestaurant';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import Insights from './pages/Insights';
import Marketing from './pages/Marketing';
import Integrations from './pages/Integrations';
import AlertsPage from './pages/AlertsPage';
import Analytics from './pages/Analytics';
import MarginAnalysis from './pages/MarginAnalysis';
import SyncHealth from './pages/SyncHealth';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import AlertsBanner from './components/AlertsBanner';
import Landing from './pages/Landing';
import ProtectedRoute from './components/auth/ProtectedRoute';

const AppLayout = ({ children }: { children: React.ReactNode }) => (
  <ProtectedRoute>
    <RequireRestaurant>
      <div className="flex min-h-screen bg-canvas text-ink">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <Topbar />
          <main className="flex-1 overflow-auto px-[30px] pt-7 pb-10">
            <AlertsBanner />
            {children}
          </main>
        </div>
      </div>
    </RequireRestaurant>
  </ProtectedRoute>
);

function App() {
  return (
    <AuthProvider>
      <RestaurantProvider>
        <Router>
          <Routes>
            <Route path="/welcome" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/onboarding" element={<ProtectedRoute><Onboarding /></ProtectedRoute>} />
            <Route path="/" element={<AppLayout><Dashboard /></AppLayout>} />
            <Route path="/dashboard" element={<Navigate to="/" replace />} />
            <Route path="/insights" element={<AppLayout><Insights /></AppLayout>} />
            <Route path="/marketing" element={<AppLayout><Marketing /></AppLayout>} />
            <Route path="/integrations" element={<AppLayout><Integrations /></AppLayout>} />
            <Route path="/alerts" element={<AppLayout><AlertsPage /></AppLayout>} />
            <Route path="/analytics" element={<AppLayout><Analytics /></AppLayout>} />
            <Route path="/margins" element={<AppLayout><MarginAnalysis /></AppLayout>} />
            <Route path="/sync-health" element={<AppLayout><SyncHealth /></AppLayout>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Router>
      </RestaurantProvider>
    </AuthProvider>
  );
}

export default App;