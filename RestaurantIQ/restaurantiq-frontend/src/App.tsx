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
import AIAssistant from './pages/AIAssistant';
import Marketing from './pages/Marketing';
import Integrations from './pages/Integrations';
import AlertsPage from './pages/AlertsPage';
import Analytics from './pages/Analytics';
import MarginAnalysis from './pages/MarginAnalysis';
import SyncHealth from './pages/SyncHealth';
import Advisor from './pages/Advisor';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import AlertsBanner from './components/AlertsBanner';
import Landing from './pages/Landing';
import ProtectedRoute from './components/auth/ProtectedRoute';
import { useAuth } from './components/auth/AuthContext';

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

const SmartHome = () => {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!user) return <Landing />;
  return <AppLayout><Dashboard /></AppLayout>;
};

function App() {
  return (
    <AuthProvider>
      <RestaurantProvider>
        <Router>
          <Routes>
            <Route path="/" element={<SmartHome />} />
            <Route path="/welcome" element={<Navigate to="/" replace />} />
            <Route path="/dashboard" element={<Navigate to="/" replace />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/onboarding" element={<ProtectedRoute><Onboarding /></ProtectedRoute>} />
            <Route path="/ai" element={<AppLayout><AIAssistant /></AppLayout>} />
            <Route path="/insights" element={<Navigate to="/ai" replace />} />
            <Route path="/chat" element={<Navigate to="/ai" replace />} />
            <Route path="/marketing" element={<AppLayout><Marketing /></AppLayout>} />
            <Route path="/integrations" element={<AppLayout><Integrations /></AppLayout>} />
            <Route path="/alerts" element={<AppLayout><AlertsPage /></AppLayout>} />
            <Route path="/analytics" element={<AppLayout><Analytics /></AppLayout>} />
            <Route path="/margins" element={<AppLayout><MarginAnalysis /></AppLayout>} />
            <Route path="/sync-health" element={<AppLayout><SyncHealth /></AppLayout>} />
            <Route path="/advisor" element={<AppLayout><Advisor /></AppLayout>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Router>
      </RestaurantProvider>
    </AuthProvider>
  );
}

export default App;