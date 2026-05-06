import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './components/auth/AuthContext';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import Insights from './pages/Insights';
import Marketing from './pages/Marketing';
import Sidebar from './components/Sidebar';
import ProtectedRoute from './components/auth/ProtectedRoute';

const AppLayout = ({ children }: { children: React.ReactNode }) => (
  <ProtectedRoute>
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 p-8 overflow-auto">{children}</main>
    </div>
  </ProtectedRoute>
);

function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/onboarding" element={<ProtectedRoute><Onboarding /></ProtectedRoute>} />
          <Route path="/" element={<AppLayout><Dashboard /></AppLayout>} />
          <Route path="/insights" element={<AppLayout><Insights /></AppLayout>} />
          <Route path="/marketing" element={<AppLayout><Marketing /></AppLayout>} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;