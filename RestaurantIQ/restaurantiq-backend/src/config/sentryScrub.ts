/**
 * Secret scrubbing for Sentry events — pure functions, no SDK import.
 *
 * Split from config/sentry.ts deliberately: this is the security-critical half
 * of the integration and must be cheap to test. Importing @sentry/node pulls in
 * OpenTelemetry and costs ~35s of ts-jest compilation per suite; these
 * functions have no dependencies and test in milliseconds.
 *
 * Context for WHY each pattern exists is in config/sentry.ts's header.
 */

/**
 * Secret shapes that must never reach a third party. Deliberately broad: a
 * false positive costs a redacted string in an error report, a false negative
 * costs a leaked credential.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, // Authorization header values
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWTs (Supabase)
  /sq0(?:atp|csp|idp)-[A-Za-z0-9_-]{8,}/g, // Square sandbox/app tokens
  /EAAA[A-Za-z0-9_-]{20,}/g, // Square OAuth access tokens
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic API keys
  /\b[0-9a-fA-F]{64}\b/g, // 32-byte hex - TOKEN_ENCRYPTION_KEY shape
];

/** Request headers safe to keep. Everything else is dropped, not redacted. */
const SAFE_HEADERS: readonly string[] = [
  'accept',
  'content-length',
  'content-type',
  'referer',
  'user-agent',
];

const REDACTED = '[redacted]';

/** Replace every known secret shape inside a single string. */
export function scrubString(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    // Patterns are module-level with /g, so reset lastIndex before each use -
    // a stateful regex reused across calls otherwise skips matches.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Walk an arbitrary structure and scrub every string in it. `seen` guards
 * against the cycles Sentry events can contain (e.g. linked errors).
 */
export function scrubDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return scrubString(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  const obj = value as unknown as object;
  // On a cycle, return a marker rather than the original object: handing back
  // the untouched value would reintroduce every secret inside it, unscrubbed,
  // behind the back-reference. Sentry normalizes cycles before beforeSend runs,
  // so this is a backstop rather than a path we expect to hit.
  if (seen.has(obj)) return '[circular]' as unknown as T;
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, seen)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = scrubDeep(val, seen);
  }
  return result as unknown as T;
}

/**
 * Strip the request envelope down to what is safe, then pattern-scrub the whole
 * event. Exported for tests - this is the security-critical path.
 */
export function sanitizeEvent<T extends Record<string, unknown>>(event: T): T {
  const request = event.request as Record<string, unknown> | undefined;

  if (request) {
    // The request body can carry a Square access token straight from the
    // onboarding form. There is no version of it worth keeping.
    delete request.data;
    delete request.cookies;

    const headers = request.headers as Record<string, unknown> | undefined;
    if (headers) {
      const safe: Record<string, unknown> = {};
      for (const name of SAFE_HEADERS) {
        if (headers[name] !== undefined) safe[name] = headers[name];
      }
      request.headers = safe;
    }
  }

  return scrubDeep(event);
}
