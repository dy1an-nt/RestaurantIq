import morgan from 'morgan';
import { RequestHandler } from 'express';

/**
 * Structured HTTP request logging (Sprint N).
 *
 * Uses morgan. In production we emit one JSON line per request (method, route,
 * status, response time) so log aggregators can parse fields without regex —
 * consistent with the scheduler's JSON logging. In development we use morgan's
 * concise, colorized `dev` format for readability.
 *
 * Deliberately NOT logged: the Authorization header, cookies, request/response
 * bodies, API keys, or any token. morgan's tokens below only ever reference the
 * method, URL path, status, and timing — none of which carry secrets in this
 * API (auth travels in the Authorization header, never the query string).
 *
 * The /health endpoint is skipped to keep platform health-check noise out of
 * the logs.
 */

const jsonFormat: morgan.FormatFn = (tokens, req, res) =>
  JSON.stringify({
    event: 'HTTP_REQUEST',
    ts: new Date().toISOString(),
    method: tokens.method(req, res),
    route: tokens.url(req, res),
    status: Number(tokens.status(req, res)) || undefined,
    responseTimeMs: Number(tokens['response-time'](req, res)) || undefined,
  });

export function requestLogger(): RequestHandler {
  const isProd = process.env.NODE_ENV === 'production';

  const options: morgan.Options<import('http').IncomingMessage, import('http').ServerResponse> = {
    // Health checks fire constantly from the platform; don't log them. Use
    // originalUrl — Express mutates req.url to the mount-relative path while
    // routing, so by the time morgan evaluates skip it would no longer match.
    skip: (req) => {
      const url = (req as { originalUrl?: string }).originalUrl ?? req.url;
      return url === '/health' || url === '/api/health';
    },
    // morgan defaults to stdout; route to stderr so request logs sit alongside
    // the scheduler/error JSON logs and stay off stdout per project convention.
    stream: { write: (line: string) => process.stderr.write(line) },
  };

  // Branch (rather than a union format arg) so morgan's overloads resolve: the
  // string-format and FormatFn-format signatures are distinct.
  return isProd ? morgan(jsonFormat, options) : morgan('dev', options);
}
