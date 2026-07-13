import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import authRouter, { requireAuth, requireSuperadmin } from './routes/auth.js';
import processesRouter from './routes/processes.js';
import pdfsRouter from './routes/pdfs.js';
import settingsRouter from './routes/settings.js';
import liveRouter from './routes/live.js';
import superadminRouter from './routes/superadmin.js';
import { diagnose } from './services/github.js';
import { rtBackend } from './services/rt.js';

const app = express();
const PORT = process.env.PORT || 4000;

// CORS
const allowed = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: false
}));

// JSON
app.use(express.json({ limit: '25mb' }));

console.log('SERVER LOADED — rt backend:', rtBackend());

// HEALTH
app.get(['/api/health', '/health'], (_req, res) => {
  res.json({ ok: true, ts: Date.now(), rt: rtBackend() });
});

// DEBUG — public, no secrets.
app.get(['/api/debug', '/debug'], async (_req, res) => {
  try { res.json({ ...(await diagnose()), rt: rtBackend() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC ROUTES (login, me)
app.use(['/api', '/'], authRouter);

// PROTECTED ROUTES
app.use(['/api/processes', '/processes'], requireAuth, processesRouter);
app.use(['/api/pdfs', '/pdfs'], requireAuth, pdfsRouter);
app.use(['/api/settings', '/settings'], requireAuth, settingsRouter);
app.use(['/api/live', '/live'], requireAuth, liveRouter);
app.use(['/api/superadmin', '/superadmin'], requireAuth, requireSuperadmin, superadminRouter);

// 404
app.use((req, res) => {
  console.warn('[404]', req.method, req.url);
  res.status(404).json({ error: 'Route not found', method: req.method, url: req.url });
});

// ERROR HANDLER
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// LOCAL ONLY
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
}

export default app;

