import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env before any validation runs. Importing this module is the single
// place the process reads its environment, so every other module can rely on
// the variables being present once startup has passed validation.
dotenv.config();

/**
 * Environment schema.
 *
 * Required vars cause a fail-fast startup error (see the eager block below).
 * Optional vars are documented here so the shape of the environment lives in
 * one place.
 *
 * Note on auth: this project verifies Supabase JWTs via JWKS, which only needs
 * SUPABASE_URL. SUPABASE_JWT_SECRET is the HS256 fallback and is therefore
 * optional. There is no separate app-level "JWT_SECRET" — Supabase issues and
 * signs the tokens.
 */
// 64 hex chars = 32 bytes, the AES-256 key length lib/tokenCrypto.ts requires.
const hex64 = /^[0-9a-fA-F]{64}$/;
const encryptionKey = z.string().refine((v) => hex64.test(v.trim()), {
  message: 'must be 64 hex characters (32 bytes)',
});

const envSchema = z.object({
  // --- Core (required) ------------------------------------------------------
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, 'SUPABASE_SERVICE_ROLE_KEY must not be empty'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY must not be empty'),

  // --- Server ---------------------------------------------------------------
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Comma-separated list of allowed browser origins for CORS. Localhost dev
  // origins are always allowed (see cors config); this adds production origins.
  FRONTEND_URL: z.string().optional(),
  // Version string surfaced by GET /health. Falls back to the npm package
  // version (set automatically by `npm start`/`npm run`) then 'unknown'.
  APP_VERSION: z.string().optional(),

  // --- Rate limiting (Claude-powered endpoints) -----------------------------
  // Window length and per-user request cap for /api/insights and /api/marketing.
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(50),

  // --- Auth (optional: HS256 fallback when not using JWKS) ------------------
  SUPABASE_JWT_SECRET: z.string().optional(),

  // --- Integration token encryption (AES-256-GCM at rest) -------------------
  // Storing or reading Square/DoorDash credentials fails at runtime without a
  // key, so production requires one (enforced in superRefine below) instead of
  // booting fine and failing on the first token operation.
  // ACTIVE_TOKEN_ENCRYPTION_KEY is preferred; TOKEN_ENCRYPTION_KEY is the
  // historical fallback. LEGACY_TOKEN_ENCRYPTION_KEYS are decrypt-only keys
  // kept through a rotation. See lib/tokenCrypto.ts.
  ACTIVE_TOKEN_ENCRYPTION_KEY: encryptionKey.optional(),
  TOKEN_ENCRYPTION_KEY: encryptionKey.optional(),
  LEGACY_TOKEN_ENCRYPTION_KEYS: z
    .string()
    .refine(
      (v) =>
        v
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
          .every((k) => hex64.test(k)),
      { message: 'every comma-separated key must be 64 hex characters (32 bytes)' },
    )
    .optional(),

  // --- Distributed scheduler (optional: single-instance fallback) -----------
  // Recommended in production when running >1 backend instance so leader
  // election can use a Postgres advisory lock. Unset → this instance is the
  // sole leader (fine for single-instance / dev).
  DATABASE_URL: z.string().optional(),
}).superRefine((env, ctx) => {
  if (
    env.NODE_ENV === 'production' &&
    !env.ACTIVE_TOKEN_ENCRYPTION_KEY &&
    !env.TOKEN_ENCRYPTION_KEY
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TOKEN_ENCRYPTION_KEY'],
      message:
        'required in production (or set ACTIVE_TOKEN_ENCRYPTION_KEY) — ' +
        'integration tokens cannot be stored or read without it',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Validate `process.env` against the schema. Throws a readable, aggregated
 * error listing every missing/invalid variable instead of failing later with
 * an opaque `undefined` at the point of use. Result is cached after the first
 * successful call.
 */
export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `  - ${name}: ${issue.message}`;
    });
    const message = [
      'Missing or invalid environment variables:',
      ...lines,
      '',
      'See docs/deployment.md for the full list of required variables.',
    ].join('\n');
    throw new Error(message);
  }

  cached = parsed.data;
  return cached;
}

// Eager fail-fast on import. server.ts imports this module first, so validation
// runs before any other module touches `process.env` (e.g. db.ts creating the
// Supabase client). Skipped under test, where jest manages the environment and
// a process.exit would abort the runner.
if (process.env.NODE_ENV !== 'test') {
  try {
    loadEnv();
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`);
    process.exit(1);
  }
}
