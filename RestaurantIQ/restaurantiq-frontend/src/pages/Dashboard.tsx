import MenuItemsTable from '../components/MenuItemsTable';
import DashboardKpis from '../components/DashboardKpis';
import DashboardPriority from '../components/DashboardPriority';
import LastSyncedIndicator from '../components/LastSyncedIndicator';
import { useRestaurant } from '../components/restaurant/RestaurantContext';

// Dashboard sections are ordered to answer an owner's three questions in turn
// (Sprint T5): what needs attention today (priority strip) → how am I doing
// (KPIs) → the detail behind it (menu table). The revenue methodology note was
// removed as a duplicate — the same explanation now lives only in the 30-Day
// Revenue KPI tooltip, reducing clutter.
const Dashboard = () => {
  const { restaurant } = useRestaurant();
  const subParts = [restaurant?.name ?? 'Your restaurant', restaurant?.location, 'Last 30 days'].filter(Boolean);

  return (
    <div>
      <div className="mb-[22px] flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">Menu Performance</h1>
          <p className="mt-[5px] text-[13.5px] font-medium text-ink-3">{subParts.join(' · ')}</p>
        </div>
        <LastSyncedIndicator />
      </div>
      <DashboardPriority />
      <DashboardKpis />
      <MenuItemsTable />
    </div>
  );
};

export default Dashboard;
