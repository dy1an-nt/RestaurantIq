/**
 * Square Sandbox Seeder
 * ---------------------
 * Populates a Square sandbox account with realistic restaurant data so
 * /api/integrations/square/sync has something to ingest. After this runs,
 * trigger a sync from the Integrations page (or via curl) and the dashboard
 * should light up.
 *
 * What it creates:
 *   - 5 catalog items (one variation each, with a price)
 *   - 12 COMPLETED orders today, paid with the sandbox test card nonce
 *
 * Usage:
 *   cd restaurantiq-backend
 *   npx ts-node src/scripts/seedSquareSandbox.ts
 *
 * Reads from .env:
 *   SQUARE_ACCESS_TOKEN  – your sandbox token (EAAA…)
 *   SQUARE_ENVIRONMENT   – defaults to "sandbox"; refuses to run in production
 *   SQUARE_LOCATION_ID   – the sandbox location ID (e.g. L1PME46WZHPZE)
 *
 * Notes / limitations:
 *   - Square sandbox stamps orders with the current time. There's no public
 *     way to backdate orders, so every order this script creates lives "today".
 *     Trend will read as "up" after first sync (recent 14d > prior 14d), which
 *     is fine for a demo. To fake history, hand-edit daily_summaries in SQL.
 *   - Re-running this script creates DUPLICATE catalog items (Square has no
 *     unique constraint on item names). Run it once per sandbox.
 */

import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { Client, Environment } from 'square';

dotenv.config();

interface SeedItem {
  name: string;
  category: string;
  priceCents: number;
  // weight = relative likelihood of appearing in a given order line
  weight: number;
}

const ITEMS: SeedItem[] = [
  { name: 'Wagyu Burger',        category: 'Mains',      priceCents: 2800, weight: 5 },
  { name: 'Grilled Salmon',      category: 'Mains',      priceCents: 3200, weight: 3 },
  { name: 'Truffle Fries',       category: 'Appetizers', priceCents: 1200, weight: 7 },
  { name: 'Caesar Salad',        category: 'Appetizers', priceCents: 1100, weight: 4 },
  { name: 'Chocolate Lava Cake', category: 'Desserts',   priceCents: 1100, weight: 3 },
];

const NUM_ORDERS = 12;

function pickWeighted<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let n = Math.random() * total;
  for (const item of items) {
    n -= item.weight;
    if (n <= 0) return item;
  }
  return items[items.length - 1];
}

async function main() {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  const envName = (process.env.SQUARE_ENVIRONMENT ?? 'sandbox').toLowerCase();

  if (!accessToken) throw new Error('Missing SQUARE_ACCESS_TOKEN in .env');
  if (!locationId) throw new Error('Missing SQUARE_LOCATION_ID in .env');
  if (envName !== 'sandbox') {
    throw new Error(`Refusing to seed against SQUARE_ENVIRONMENT=${envName}. Set to 'sandbox'.`);
  }

  const client = new Client({
    accessToken,
    environment: Environment.Sandbox,
    userAgentDetail: 'RestaurantIQ-Seeder/1.0',
  });

  // 1. Catalog
  console.error(`Creating ${ITEMS.length} catalog items…`);
  const objects = ITEMS.map((item) => {
    const tempItemId = `#${item.name.replace(/\W/g, '')}`;
    const tempVariationId = `${tempItemId}_var`;
    return {
      type: 'ITEM' as const,
      id: tempItemId,
      itemData: {
        name: item.name,
        descriptionHtml: `<p>${item.category}</p>`,
        variations: [
          {
            type: 'ITEM_VARIATION' as const,
            id: tempVariationId,
            itemVariationData: {
              itemId: tempItemId,
              name: 'Regular',
              pricingType: 'FIXED_PRICING' as const,
              priceMoney: { amount: BigInt(item.priceCents), currency: 'USD' },
            },
          },
        ],
      },
    };
  });

  const { result: upsertResult } = await client.catalogApi.batchUpsertCatalogObjects({
    idempotencyKey: randomUUID(),
    batches: [{ objects }],
  });

  const idMap = new Map<string, { itemId: string; variationId: string }>();
  for (const mapping of upsertResult.idMappings ?? []) {
    // mapping.clientObjectId is our temp "#Wagyu", mapping.objectId is Square's real ID
    const temp = mapping.clientObjectId ?? '';
    const real = mapping.objectId ?? '';
    for (const seed of ITEMS) {
      const tempItem = `#${seed.name.replace(/\W/g, '')}`;
      const tempVar = `${tempItem}_var`;
      if (temp === tempItem) {
        const existing = idMap.get(seed.name) ?? { itemId: '', variationId: '' };
        idMap.set(seed.name, { ...existing, itemId: real });
      } else if (temp === tempVar) {
        const existing = idMap.get(seed.name) ?? { itemId: '', variationId: '' };
        idMap.set(seed.name, { ...existing, variationId: real });
      }
    }
  }
  console.error('  ✓ catalog created');

  // 2. Orders + payments
  console.error(`Creating ${NUM_ORDERS} paid orders…`);
  let success = 0;
  for (let i = 0; i < NUM_ORDERS; i++) {
    // 1–3 line items per order
    const lineCount = 1 + Math.floor(Math.random() * 3);
    const picks = Array.from({ length: lineCount }, () => pickWeighted(ITEMS));

    const lineItems = picks.map((pick) => {
      const ids = idMap.get(pick.name);
      if (!ids?.variationId) throw new Error(`Missing variation id for ${pick.name}`);
      return {
        catalogObjectId: ids.variationId,
        quantity: '1',
      };
    });

    const totalCents = picks.reduce((s, p) => s + p.priceCents, 0);

    try {
      const { result: orderResult } = await client.ordersApi.createOrder({
        idempotencyKey: randomUUID(),
        order: {
          locationId,
          lineItems,
          state: 'OPEN',
        },
      });
      const orderId = orderResult.order?.id;
      if (!orderId) throw new Error('No orderId returned');

      await client.paymentsApi.createPayment({
        sourceId: 'cnon:card-nonce-ok',         // sandbox-only test card source
        idempotencyKey: randomUUID(),
        amountMoney: { amount: BigInt(totalCents), currency: 'USD' },
        orderId,
        locationId,
        autocomplete: true,                      // closes the order → state COMPLETED
      });

      success++;
      process.stderr.write('.');
    } catch (err: any) {
      process.stderr.write('x');
      console.error('\n  order failed:', err.message ?? err);
    }
  }
  console.error(`\n  ✓ ${success}/${NUM_ORDERS} orders completed`);

  console.error('\nDone. Now hit /api/integrations/square/sync to pull this into Supabase.');
}

main().catch((err) => {
  console.error('Seeder failed:', err);
  process.exit(1);
});
