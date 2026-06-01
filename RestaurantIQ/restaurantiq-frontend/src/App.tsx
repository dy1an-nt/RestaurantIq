import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './components/auth/AuthContext';
import { RestaurantProvider } from './components/restaurant/RestaurantContext';
import RequireRestaurant from './components/restaurant/RequireRestaurant';
import Login from './pages/Login';
import Signup from './pages/Signup';
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
import AlertsBanner from './components/AlertsBanner';
import ProtectedRoute from './components/auth/ProtectedRoute';

const AppLayout = ({ children }: { children: React.ReactNode }) => (
  <ProtectedRoute>
    <RequireRestaurant>
      <div className="flex min-h-screen bg-gray-50">
        <Sidebar />
        <main className="flex-1 p-8 overflow-auto">
          <AlertsBanner />
          {children}
        </main>
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
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
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