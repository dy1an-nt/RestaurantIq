import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MENU_ITEMS = [
  { name: 'Truffle Fries',        category: 'Appetizers', price_cents: 1200, cost_cents: 350,  dailyMin: 20, dailyMax: 30, trend: 'up'   },
  { name: 'Caesar Salad',         category: 'Appetizers', price_cents: 1100, cost_cents: 300,  dailyMin: 8,  dailyMax: 12, trend: 'flat' },
  { name: 'Wagyu Burger',         category: 'Mains',      price_cents: 2800, cost_cents: 1200, dailyMin: 15, dailyMax: 25, trend: 'up'   },
  { name: 'Grilled Salmon',       category: 'Mains',      price_cents: 3200, cost_cents: 1400, dailyMin: 10, dailyMax: 18, trend: 'up'   },
  { name: 'Mushroom Risotto',     category: 'Mains',      price_cents: 2400, cost_cents: 800,  dailyMin: 6,  dailyMax: 10, trend: 'flat' },
  { name: 'BBQ Ribs',             category: 'Mains',      price_cents: 3600, cost_cents: 1600, dailyMin: 8,  dailyMax: 15, trend: 'down' },
  { name: 'Chicken Tenders',      category: 'Mains',      price_cents: 1800, cost_cents: 500,  dailyMin: 5,  dailyMax: 9,  trend: 'flat' },
  { name: 'Chocolate Lava Cake',  category: 'Desserts',   price_cents: 1100, cost_cents: 250,  dailyMin: 12, dailyMax: 20, trend: 'up'   },
  { name: 'Cheesecake',           category: 'Desserts',   price_cents: 900,  cost_cents: 200,  dailyMin: 3,  dailyMax: 6,  trend: 'down' },
  { name: 'Tiramisu',             category: 'Desserts',   price_cents: 1000, cost_cents: 250,  dailyMin: 4,  dailyMax: 7,  trend: 'flat' },
];

function dailyQty(min: number, max: number, trend: string, dayIndex: number): number {
  const base = Math.floor(Math.random() * (max - min + 1)) + min;
  if (trend === 'up')   return Math.round(base * (1 + dayIndex * 0.01));
  if (trend === 'down') return Math.max(1, Math.round(base * (1 - dayIndex * 0.01)));
  return base;
}

async function seed() {
  console.error('Seeding RestaurantIQ...');

  // restaurants.user_id is NOT NULL (migration 004). Pick up the owner from
  // env so this script keeps working post-multi-tenant. Create an auth user in
  // Supabase first and copy its id into SEED_USER_ID.
  const seedUserId = process.env.SEED_USER_ID;
  if (!seedUserId) {
    console.error('Missing SEED_USER_ID env var — set it to the auth.users.id that should own this seeded restaurant.');
    process.exit(1);
  }

  const { data: restaurant, error: rErr } = await supabase
    .from('restaurants')
    .insert({
      user_id: seedUserId,
      name: 'The Rustic Fork',
      location: 'Austin, TX',
      pos_connected: true,
      delivery_connected: true,
    })
    .select()
    .single();

  if (rErr) { console.error('Restaurant insert failed:', rErr.message); process.exit(1); }
  console.error('Restaurant:', restaurant.id);

  const { data: items, error: iErr } = await supabase
    .from('menu_items')
    .insert(MENU_ITEMS.map(({ name, category, price_cents, cost_cents }) => ({
      restaurant_id: restaurant.id, name, category, price_cents, cost_cents, source: 'manual',
    })))
    .select();

  if (iErr) { console.error('Menu items insert failed:', iErr.message); process.exit(1); }
  console.error(`Inserted ${items.length} menu items`);

  const summaries: object[] = [];
  const today = new Date();

  for (let d = 29; d >= 0; d--) {
    const date = new Date(today);
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().split('T')[0];
    const dayIndex = 29 - d;

    for (let i = 0; i < items.length; i++) {
      const meta = MENU_ITEMS[i];
      const qty = dailyQty(meta.dailyMin, meta.dailyMax, meta.trend, dayIndex);
      summaries.push({
        restaurant_id: restaurant.id,
        menu_item_id: items[i].id,
        date: dateStr,
        total_quantity: qty,
        total_revenue_cents: qty * items[i].price_cents,
        total_orders: Math.ceil(qty / 1.5),
      });
    }
  }

  const { error: sErr } = await supabase.from('daily_summaries').insert(summaries);
  if (sErr) { console.error('Summaries insert failed:', sErr.message); process.exit(1); }
  console.error(`Inserted ${summaries.length} daily summary rows`);
  console.error('Done! Restaurant ID:', restaurant.id);
}

seed();