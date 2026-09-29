import express from 'express';
import cors from 'cors';
import { requireAuth } from './auth.js';
import { errorHandler } from './errors.js';
import { authRouter } from './routes/auth.js';
import { groupsRouter } from './routes/groups.js';
import { sessionsRouter } from './routes/sessions.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api', authRouter);
  app.use('/api', requireAuth, groupsRouter, sessionsRouter);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errorHandler);
  return app;
}
