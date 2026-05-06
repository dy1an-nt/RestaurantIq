import MenuItemsTable from '../components/MenuItemsTable';

const Dashboard = () => (
  <div>
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-gray-900">Menu Performance</h1>
      <p className="text-sm text-gray-500 mt-1">The Rustic Fork · Last 30 days</p>
    </div>
    <MenuItemsTable />
  </div>
);

export default Dashboard;