/**
 * Repeatable SQL migration runner (Sprint N).
 *
 * Replaces the previous "paste SQL into the Supabase SQL editor" workflow with a
 * deterministic, tracked process. Reads the numbered `.sql` files in
 * `migrations/`, applies the ones that haven't run yet (in filename order), and
 * records each in a `schema_migrations` table so it never runs twice.
 *
 * Connection: uses DATABASE_URL (the same direct/session connection the sync
 * scheduler uses — see leaderElection.ts). It must be a real Postgres
 * connection string, NOT the Supabase REST URL.
 *
 * Commands (see `npm run migrate`, `migrate:status`, `migrate:baseline`):
 *   up                 apply all pending migrations (default)
 *   status             list applied vs pending; flag checksum drift
 *   baseline           mark ALL current files as applied WITHOUT executing them
 *                      — use once when adopting this runner on a database whose
 *                      migrations were already applied by hand, so they are not
 *                      re-run (many are not idempotent, e.g. RENAME COLUMN).
 *
 * Flags:
 *   --dry-run          print what WOULD happen; make no changes
 *
 * Atomicity: each migration runs inside a single transaction together with its
 * tracking-row insert. The migration files wrap themselves in BEGIN;/COMMIT;,
 * which would conflict with that outer transaction, so the runner strips
 * standalone BEGIN;/COMMIT; statements before executing. Either the migration
 * AND its tracking row commit together, or neither does.
 */
import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

interface Args {
  command: 'up' | 'status' | 'baseline';
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const command = (positional[0] ?? 'up') as Args['command'];
  if (!['up', 'status', 'baseline'].includes(command)) {
    throw new Error(`Unknown command "${command}". Use: up | status | baseline`);
  }
  return { command, dryRun: flags.has('--dry-run') };
}

/** All migration filenames, sorted lexically (the canonical apply order). */
function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function checksum(contents: string): string {
  return createHash('sha256').update(contents).digest('hex').slice(0, 16);
}

/** Remove the files' own transaction control so the runner can wrap each
 * migration + its tracking insert in one atomic transaction. Only standalone
 * BEGIN;/COMMIT; statements are stripped. */
function stripTxControl(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/i.test(line))
    .join('\n');
}

async function ensureTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getApplied(
  client: Client,
): Promise<Map<string, string>> {
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migrations',
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function runStatus(client: Client): Promise<void> {
  const applied = await getApplied(client);
  const files = listMigrationFiles();
  let pending = 0;
  let drift = 0;
  for (const f of files) {
    const sum = checksum(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    const appliedSum = applied.get(f);
    if (appliedSum === undefined) {
      pending++;
      console.error(`  pending   ${f}`);
    } else if (appliedSum !== sum) {
      drift++;
      console.error(`  DRIFT!    ${f} (applied ${appliedSum}, file ${sum})`);
    } else {
      console.error(`  applied   ${f}`);
    }
  }
  console.error(
    `\n${files.length} migrations · ${
      files.length - pending
    } applied · ${pending} pending${drift ? ` · ${drift} CHECKSUM DRIFT` : ''}`,
  );
  if (drift) {
    console.error(
      'Checksum drift means an already-applied file was edited. Never edit an ' +
        'applied migration — add a new one instead.',
    );
  }
}

async function runUp(client: Client, dryRun: boolean): Promise<void> {
  await ensureTable(client);
  const applied = await getApplied(client);
  const pending = listMigrationFiles().filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.error('No pending migrations. Up to date.');
    return;
  }
  console.error(`${pending.length} pending migration(s):`);
  for (const f of pending) console.error(`  - ${f}`);

  if (dryRun) {
    console.error('\n--dry-run: nothing applied.');
    return;
  }

  for (const f of pending) {
    const raw = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const sql = stripTxControl(raw);
    console.error(`\nApplying ${f} ...`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [f, checksum(raw)],
      );
      await client.query('COMMIT');
      console.error(`  ✓ ${f}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(
        `  ✗ ${f} failed — rolled back. No further migrations applied.`,
      );
      throw err;
    }
  }
  console.error(`\nDone. Applied ${pending.length} migration(s).`);
}

async function runBaseline(client: Client, dryRun: boolean): Promise<void> {
  await ensureTable(client);
  const applied = await getApplied(client);
  const toMark = listMigrationFiles().filter((f) => !applied.has(f));

  if (toMark.length === 0) {
    console.error('Nothing to baseline — all files already recorded.');
    return;
  }
  console.error(
    `Will mark ${toMark.length} file(s) as applied WITHOUT executing them:`,
  );
  for (const f of toMark) console.error(`  - ${f}`);

  if (dryRun) {
    console.error('\n--dry-run: nothing recorded.');
    return;
  }

  for (const f of toMark) {
    const raw = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    await client.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING',
      [f, checksum(raw)],
    );
  }
  console.error(`\nBaselined ${toMark.length} migration(s).`);
}

async function main(): Promise<void> {
  const { command, dryRun } = parseArgs(process.argv.slice(2));

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required to run migrations. Set it to the Postgres ' +
        'connection string (Supabase: Settings → Database → Connection string).',
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (command === 'status') {
      await ensureTable(client);
      await runStatus(client);
    } else if (command === 'baseline') {
      await runBaseline(client, dryRun);
    } else {
      await runUp(client, dryRun);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`\nMigration error: ${(err as Error).message}`);
  process.exit(1);
});
