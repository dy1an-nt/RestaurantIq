import MenuItemsTable from '../components/MenuItemsTable';
import { useRestaurant } from '../components/restaurant/RestaurantContext';

const Dashboard = () => {
  const { restaurant } = useRestaurant();
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Menu Performance</h1>
        <p className="text-sm text-gray-500 mt-1">
          {restaurant?.name ?? 'Your restaurant'} · Last 30 days
        </p>
      </div>
      <MenuItemsTable />
    </div>
  );
};

export default Dashboard;