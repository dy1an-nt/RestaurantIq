import MenuItemsTable from '../components/MenuItemsTable';
import DashboardKpis from '../components/DashboardKpis';
import { useRestaurant } from '../components/restaurant/RestaurantContext';

const Dashboard = () => {
  const { restaurant } = useRestaurant();
  const subParts = [restaurant?.name ?? 'Your restaurant', restaurant?.location, 'Last 30 days'].filter(Boolean);

  return (
    <div>
      <div className="mb-[22px]">
        <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">Menu Performance</h1>
        <p className="mt-[5px] text-[13.5px] font-medium text-ink-3">{subParts.join(' · ')}</p>
      </div>
      <DashboardKpis />
      <MenuItemsTable />
    </div>
  );
};

export default Dashboard;
