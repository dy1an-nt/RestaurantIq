import MenuItemsTable from '../components/MenuItemsTable';
import DashboardKpis from '../components/DashboardKpis';
import LastSyncedIndicator from '../components/LastSyncedIndicator';
import { useRestaurant } from '../components/restaurant/RestaurantContext';

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
      <DashboardKpis />
      <MenuItemsTable />
      {/* Revenue methodology note — what the headline number does and doesn't
          include, so an owner comparing against their POS understands any gap
          instead of distrusting the dashboard (review §3 / R5). */}
      <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
        Revenue reflects menu&nbsp;item sales (quantity × item price) over the last 30 days.
        It may differ from your POS gross total, which can also include tax, tips, discounts,
        and service fees.
      </p>
    </div>
  );
};

export default Dashboard;
