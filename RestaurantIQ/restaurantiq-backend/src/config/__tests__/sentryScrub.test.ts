import { randomBytes } from 'crypto';
import { scrubString, scrubDeep, sanitizeEvent } from '../sentryScrub';

/**
 * These tests guard the one thing that must not regress: no credential this
 * backend handles may leave the process inside a Sentry event. Everything else
 * about the integration is optional; this is not.
 */

describe('scrubString', () => {
  it('redacts Authorization bearer values', () => {
    const out = scrubString('failed with Authorization: Bearer abc123.def-456_x');
    expect(out).not.toContain('abc123');
    expect(out).toContain('[redacted]');
  });

  it('redacts Supabase JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(scrubString(`token=${jwt}`)).not.toContain('eyJzdWIi');
  });

  it('redacts Square access tokens', () => {
    expect(scrubString('sq0atp-abcdefghijklmnop')).toBe('[redacted]');
    expect(scrubString('EAAAl' + 'x'.repeat(30))).toBe('[redacted]');
  });

  it('redacts Anthropic API keys', () => {
    expect(scrubString('sk-ant-api03-' + 'a'.repeat(24))).toBe('[redacted]');
  });

  it('redacts a 32-byte hex encryption key', () => {
    const key = randomBytes(32).toString('hex');
    expect(scrubString(`key ${key} failed`)).not.toContain(key);
  });

  it('leaves ordinary text alone', () => {
    const msg = 'Restaurant not found for id 42';
    expect(scrubString(msg)).toBe(msg);
  });

  it('is not stateful across calls (global regex lastIndex reset)', () => {
    const token = 'sq0atp-aaaaaaaaaaaaaaaa';
    // The same pattern applied repeatedly must match every time. Without an
    // explicit lastIndex reset, a /g regex reused across calls skips matches.
    for (let i = 0; i < 5; i++) {
      expect(scrubString(token)).toBe('[redacted]');
    }
  });
});

describe('scrubDeep', () => {
  it('scrubs nested strings in objects and arrays', () => {
    const out = scrubDeep({
      a: { b: ['sq0atp-abcdefghijklmnop', 'safe'] },
      c: 5,
      d: null,
    });
    expect(out).toEqual({ a: { b: ['[redacted]', 'safe'] }, c: 5, d: null });
  });

  it('does not infinitely recurse on cyclic structures', () => {
    const cyclic: Record<string, unknown> = { name: 'safe' };
    cyclic.self = cyclic;
    expect(() => scrubDeep(cyclic)).not.toThrow();
  });

  it('does not leak secrets back through a circular reference', () => {
    // Returning the original object on cycle detection would smuggle every
    // secret inside it past the scrubber.
    const cyclic: Record<string, unknown> = { token: 'sq0atp-abcdefghijklmnop' };
    cyclic.self = cyclic;
    const out = scrubDeep(cyclic);
    expect(JSON.stringify(out)).not.toContain('sq0atp-abcdefghijklmnop');
  });
});

describe('sanitizeEvent', () => {
  it('drops the request body entirely', () => {
    const event = {
      request: {
        method: 'POST',
        data: { squareAccessToken: 'EAAAl' + 'x'.repeat(30) },
      },
    };
    const out = sanitizeEvent(event) as { request: Record<string, unknown> };
    expect(out.request.data).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('EAAAl');
  });

  it('drops cookies', () => {
    const out = sanitizeEvent({
      request: { cookies: { session: 'secret' } },
    }) as { request: Record<string, unknown> };
    expect(out.request.cookies).toBeUndefined();
  });

  it('keeps only allowlisted headers', () => {
    const out = sanitizeEvent({
      request: {
        headers: {
          authorization: 'Bearer supersecrettoken',
          'x-api-key': 'sk-ant-api03-' + 'a'.repeat(24),
          'content-type': 'application/json',
          'user-agent': 'jest',
        },
      },
    }) as { request: { headers: Record<string, unknown> } };

    expect(out.request.headers).toEqual({
      'content-type': 'application/json',
      'user-agent': 'jest',
    });
    expect(JSON.stringify(out)).not.toContain('supersecrettoken');
  });

  it('scrubs secrets that leaked into an exception message', () => {
    const out = sanitizeEvent({
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Square rejected token sq0atp-abcdefghijklmnop',
          },
        ],
      },
    });
    expect(JSON.stringify(out)).not.toContain('sq0atp-abcdefghijklmnop');
  });

  it('handles an event with no request section', () => {
    expect(() => sanitizeEvent({ message: 'boom' })).not.toThrow();
  });
});
