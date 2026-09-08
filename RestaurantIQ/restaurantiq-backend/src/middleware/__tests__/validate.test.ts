/**
 * Unit tests for the request-validation middleware.
 *
 * The load-bearing assertion here is that validateQuery does NOT write to
 * req.query. Express 5 makes req.query a getter-only property, so assigning to
 * it throws a TypeError. On Express 4 that assignment works fine, which is
 * exactly the problem: the hazard is invisible until the upgrade, at which
 * point every validated route 500s. These tests pin the behavior now so a
 * revert to `req.query = result.data` fails here rather than during an upgrade.
 */

import { z } from 'zod';
import { validateBody, validateQuery } from '../validate';

const schema = z
  .object({ days: z.coerce.number().int().refine((n) => [7, 30, 90].includes(n)) })
  .strict();

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('validateQuery', () => {
  it('puts the parsed result on req.validatedQuery', () => {
    const req: any = { query: { days: '90' } };
    const res = mockRes();
    const next = jest.fn();

    validateQuery(schema)(req, res, next);

    expect(next).toHaveBeenCalled();
    // Coerced from the raw string, so the handler gets a number.
    expect(req.validatedQuery).toEqual({ days: 90 });
  });

  it('leaves req.query untouched', () => {
    // Express 5 makes req.query getter-only. Writing to it would throw there,
    // and silently succeed here, so assert the absence of the write directly.
    const original = { days: '90' };
    const req: any = { query: original };

    validateQuery(schema)(req, mockRes(), jest.fn());

    expect(req.query).toBe(original);
    expect(req.query).toEqual({ days: '90' });
  });

  it('survives a getter-only req.query, as Express 5 provides', () => {
    // Reproduces the Express 5 shape. Against `req.query = result.data` this
    // test throws a TypeError instead of reaching the assertion.
    const req: any = {};
    Object.defineProperty(req, 'query', {
      get: () => ({ days: '7' }),
      configurable: true,
    });
    const next = jest.fn();

    expect(() => validateQuery(schema)(req, mockRes(), next)).not.toThrow();
    expect(next).toHaveBeenCalled();
    expect(req.validatedQuery).toEqual({ days: 7 });
  });

  it('rejects an invalid value with the standard 400 envelope', () => {
    const req: any = { query: { days: '45' } };
    const res = mockRes();
    const next = jest.fn();

    validateQuery(schema)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ data: null, error: expect.any(String) });
    expect(req.validatedQuery).toBeUndefined();
  });

  it('rejects an unknown query key rather than ignoring it', () => {
    const req: any = { query: { day: '90' } };
    const res = mockRes();
    const next = jest.fn();

    validateQuery(schema)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('validateBody', () => {
  it('still replaces req.body, which stays writable in Express 5', () => {
    // The asymmetry with validateQuery is deliberate, not an oversight.
    const req: any = { body: { days: '30' } };
    const next = jest.fn();

    validateBody(schema)(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ days: 30 });
  });
});
