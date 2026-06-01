/**
 * DoorDash Sandbox Seeder
 * -----------------------
 * The DoorDash counterpart to seedSquareSandbox.ts. After it runs, the
 * dashboard lights up with DoorDash-sourced orders alongside Square.
 *
 * Why this differs from the Square seeder:
 *   The Square seeder PUSHES data into the Square sandbox via the Square SDK,
 *   and a separate /sync PULLS it back. DoorDash's Marketplace order/menu
 *   endpoints are partner-gated — there's no public sandbox to push into. So
 *   instead of faking an external account, this seeder drives the REAL
 *   ingestion pipeline (ingestDoorDash) in mock mode, which generates the same
 *   deterministic sandbox catalog + orders the /sync route would and writes
 *   them through the shared persistence layer. That means it exercises the
 *   genuine normalizers → upsert → daily_summaries → alerts path, not a shortcut.
 *
 * What it does:
 *   1. Picks a target restaurant (RESTAURANT_ID env, else the first one).
 *   2. Marks it DoorDash-connected (doordash_store_id + encrypted placeholder
 *      token + delivery_connected) so the Integrations UI shows "Connected" and
 *      the Run-sync button is enabled.
 *   3. Runs ingestDoorDash in mock mode → 5 catalog items + 12 orders across the
 *      last 6 days, tagged source=doordash.
 *
 * Idempotent: the mock data uses stable external ids, so re-running it dedupes
 * rather than duplicating (the same guarantee a re-sync gives).
 *
 * Usage:
 *   cd restaurantiq-backend
 *   npm run seed:doordash
 *   # or target a specific restaurant:
 *   RESTAURANT_ID=<uuid> npm run seed:doordash
 *
 * Reads from .env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  – DB access
 *   TOKEN_ENCRYPTION_KEY                      – to encrypt the placeholder token
 *   DOORDASH_ENVIRONMENT                      – defaults to "sandbox"; refuses production
 */

import dotenv from 'dotenv';

dotenv.config();

// Force mock mode for this process so getDoorDashClient() serves the
// deterministic sandbox data instead of trying to reach the live API.
// isMockMode() reads USE_MOCK at call time, so setting it here is sufficient.
process.env.USE_MOCK = 'true';

// Imported AFTER USE_MOCK is set (these read env lazily, but this keeps intent clear).
import { supabase } from '../db';
import { encryptToken } from '../lib/tokenCrypto';
import { ingestDoorDash } from '../services/doordash/ingestDoorDash';

const SANDBOX_STORE_ID = process.env.DOORDASH_STORE_ID ?? 'st_sandbox_demo';
const SANDBOX_TOKEN = process.env.DOORDASH_ACCESS_TOKEN ?? 'ddx_sandbox_demo_token';

async function resolveRestaurantId(): Promise<string> {
  const explicit = process.env.RESTAURANT_ID;
  if (explicit) return explicit;

  const { data, error } = await supabase
    .from('restaurants')
    .select('id, name')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Restaurant lookup failed: ${error.message}`);
  if (!data) {
    throw new Error(
      'No restaurants found. Create one via the app (or set RESTAURANT_ID) before seeding.',
    );
  }
  console.error(`Targeting restaurant "${data.name}" (${data.id})`);
  return data.id as string;
}

async function main() {
  const envName = (process.env.DOORDASH_ENVIRONMENT ?? 'sandbox').toLowerCase();
  if (envName === 'production') {
    throw new Error(`Refusing to seed against DOORDASH_ENVIRONMENT=${envName}. Set to 'sandbox'.`);
  }

  console.error('USE_MOCK forced to true for this run — serving deterministic DoorDash data.');

  const restaurantId = await resolveRestaurantId();

  // 1. Mark the restaurant DoorDash-connected (mirrors the /connect route).
  console.error('Marking restaurant as DoorDash-connected…');
  const { error: connErr } = await supabase
    .from('restaurants')
    .update({
      doordash_store_id: SANDBOX_STORE_ID,
      doordash_access_token: encryptToken(SANDBOX_TOKEN),
      delivery_connected: true,
    })
    .eq('id', restaurantId);
  if (connErr) throw new Error(`Failed to mark connected: ${connErr.message}`);
  console.error(`  ✓ connected (store ${SANDBOX_STORE_ID})`);

  // 2. Run the real ingestion pipeline in mock mode.
  console.error('Running DoorDash ingestion…');
  const result = await ingestDoorDash(restaurantId);

  console.error(
    `  ✓ ingested ${result.catalogCount} catalog item(s), ${result.orderCount} new order(s)`,
  );
  console.error('\nDone. DoorDash orders now flow into daily_summaries, margins, and alerts.');
}

main().catch((err) => {
  console.error('Seeder failed:', err);
  process.exit(1);
});
