import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ data: { status: 'ok', timestamp: new Date().toISOString() }, error: null });
});

export default router;
