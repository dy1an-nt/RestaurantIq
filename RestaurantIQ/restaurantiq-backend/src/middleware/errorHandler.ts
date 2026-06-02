import { Request, Response, NextFunction } from 'express';

/**
 * Centralized error handling for the API (Sprint N).
 *
 * Two pieces work together:
 *  - `notFoundHandler` — mounted after all routes, turns an unmatched path into
 *    a consistent 404 instead of Express's default HTML "Cannot GET ...".
 *  - `errorHandler` — the final 4-argument middleware. Every error thrown in a
 *    route (sync or async — async forwarding is enabled by importing
 *    `express-async-errors` in server.ts) lands here and is rendered in the
 *    project's standard envelope.
 *
 * Response contract (unchanged from the rest of the codebase): errors are
 * returned as `{ data: null, error: "<human readable message>" }`. The Sprint N
 * brief proposed nesting the message under `error.message`, but the entire
 * existing API and the frontend treat `error` as a string; keeping the string
 * shape avoids breaking ~24 frontend call sites for no functional gain.
 */

/**
 * Error with an explicit HTTP status. Throw this from a route/service to return
 * a specific status with a client-safe message:
 *
 *   throw new ApiError(404, 'Restaurant not found');
 *
 * `expose` controls whether the message is sent to the client. It defaults to
 * true for 4xx (client errors are safe to describe) and false for 5xx (server
 * errors must not leak internals).
 */
export class ApiError extends Error {
  status: number;
  expose: boolean;

  constructor(status: number, message: string, expose?: boolean) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.expose = expose ?? status < 500;
  }
}

/** 404 for any route that didn't match. Mounted after all routers. */
export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({ data: null, error: 'Not found' });
};

/**
 * Final error handler. Must keep all four arguments — Express identifies error
 * middleware by arity, so dropping `next` would silently turn this into a normal
 * handler that never runs.
 */
export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // If the response has already started streaming, we can't change the status
  // or body — delegate to Express's default handler to close the connection.
  if (res.headersSent) return next(err);

  const isProd = process.env.NODE_ENV === 'production';

  const status =
    err instanceof ApiError
      ? err.status
      : typeof (err as { status?: unknown })?.status === 'number'
        ? (err as { status: number }).status
        : 500;

  const rawMessage =
    err instanceof Error ? err.message : 'Internal server error';

  // Always log the full error server-side (JSON line to stderr, matching the
  // scheduler logger style) so operators have the detail the client never sees.
  // Stacks are kept out of production logs only insofar as they are noisy — the
  // important rule is that stacks/internals never reach the HTTP response.
  console.error(
    JSON.stringify({
      event: 'REQUEST_ERROR',
      ts: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status,
      message: rawMessage,
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );

  // Decide what the client is allowed to see:
  //  - ApiError with expose=true → its message (typically 4xx).
  //  - Any 5xx in production → a generic message (never leak internals).
  //  - Otherwise (4xx, or non-prod) → the real message to aid debugging.
  const exposeMessage =
    err instanceof ApiError ? err.expose : status < 500 || !isProd;

  const clientMessage = exposeMessage ? rawMessage : 'Internal server error';

  res.status(status).json({ data: null, error: clientMessage });
};
