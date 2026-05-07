import { Navigate } from 'react-router-dom';
import { useRestaurant } from './RestaurantContext';

/**
 * Gate that redirects to /onboarding if the signed-in user has no restaurant
 * row yet. Wrap inside ProtectedRoute (it assumes the user is authenticated).
 */
const RequireRestaurant: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { restaurant, loading } = useRestaurant();

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (!restaurant) return <Navigate to="/onboarding" replace />;

  return <>{children}</>;
};

export default RequireRestaurant;
