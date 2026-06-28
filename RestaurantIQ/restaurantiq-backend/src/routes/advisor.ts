import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireRestaurant } from '../middleware/requireRestaurant';
import { createAiRateLimiter } from '../middleware/rateLimit';
import { fetchForecastInputs, buildForecast } from '../services/forecastService';
import { generateForecastNarrative } from '../services/forecastNarrativeService';
import { getFreshForecast, saveForecast } from '../services/forecastCacheRepo';

const router = Router();
router.use(authMiddleware);
router.use(requireRestaurant());

// GET /api/advisor/forecast
router.get('/forecast', async (req: Request, res: Response) => {
  const ttlHours = Math.min(168, Math.max(1, parseInt(String(req.query.ttlHours ?? '24'), 10)));
  const ttlMs = ttlHours * 60 * 60 * 1000;

  try {
    const cached = await getFreshForecast(req.restaurantId!, ttlMs);
    if (cached) {
      return res.json({ data: { cached: true, ...cached.payload }, error: null });
    }
    return res.json({ data: { cached: false, items: [], narrative: null }, error: null });
  } catch {
    return res.status(500).json({ data: null, error: 'Failed to read forecast' });
  }
});

// POST /api/advisor/forecast/refresh
router.post('/forecast/refresh', createAiRateLimiter(), async (req: Request, res: Response) => {
  const trailingDays = Math.min(56, Math.max(14, parseInt(String(req.body.trailingDays ?? '28'), 10)));
  const projectionDays = Math.min(14, Math.max(1, parseInt(String(req.body.projectionDays ?? '7'), 10)));

  if (
    isNaN(trailingDays) || trailingDays < 14 || trailingDays > 56 ||
    isNaN(projectionDays) || projectionDays < 1 || projectionDays > 14
  ) {
    return res.status(400).json({ data: null, error: 'trailingDays must be 14-56, projectionDays must be 1-14' });
  }

  try {
    const inputs = await fetchForecastInputs(req.restaurantId!);
    const forecast = buildForecast(inputs, trailingDays, projectionDays);

    if (forecast.items.length === 0) {
      return res.status(422).json({
        data: null,
        error: 'Need at least 14 days of sales history to generate a forecast',
      });
    }

    const { narrative, inputTokens, outputTokens } = await generateForecastNarrative(forecast.items);

    const payload = {
      generated_at: new Date().toISOString(),
      trailing_days: trailingDays,
      projection_days: projectionDays,
      items: forecast.items,
      insufficient_history_items: forecast.insufficient_history_items,
      narrative,
    };

    await saveForecast(
      req.restaurantId!,
      payload as unknown as Record<string, unknown>,
      { input: inputTokens, output: outputTokens },
      trailingDays,
      projectionDays,
    );

    return res.json({ data: { cached: false, ...payload }, error: null });
  } catch (err) {
    console.error('[advisor] forecast refresh failed:', err);
    return res.status(502).json({ data: null, error: 'Forecast narrative unavailable — try again shortly' });
  }
});

export default router;
