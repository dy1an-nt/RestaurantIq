import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny, z } from 'zod';

/**
 * Request-validation middleware (Sprint R, review H2).
 *
 * `zod` was already a dependency but was used only in config/env.ts — request
 * bodies were either hand-validated (thoroughly in one route, inconsistently or
 * not at all in others) so the service layer could never assume what was
 * guaranteed. This centralizes the pattern: declare a schema per write route,
 * and the handler is reached only with input that already parsed.
 *
 * On success, `req.body` is REPLACED with the parsed result, so coercion,
 * trimming, defaulting, and unknown-key stripping defined in the schema are what
 * the handler sees — there is no path to the handler with raw, untrusted input.
 *
 * On failure it returns the project's standard 400 envelope with a readable,
 * field-scoped message (no stack traces, no internals).
 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

export function validateBody(schema: ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ data: null, error: formatIssues(result.error) });
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Same contract as validateBody, for query strings. Express parses every
 * query value as a string (or an array, for repeated keys), so schemas passed
 * here should use z.coerce for numeric/boolean fields and `.strict()` to
 * reject unknown keys rather than silently ignoring a typo'd param.
 *
 * On success, `req.query` is REPLACED with the parsed result so the handler
 * only ever sees validated, coerced values.
 */
export function validateQuery(schema: ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({ data: null, error: formatIssues(result.error) });
      return;
    }
    req.query = result.data;
    next();
  };
}
