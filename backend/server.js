import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env can live at the project root (Map-Panel/.env, which is where yours is)
// or inside backend/ — load whichever exists so local dev picks it up either way.
loadEnv({ path: path.join(__dirname, '..', '.env') });
loadEnv({ path: path.join(__dirname, '.env') });
import express from 'express';
import cors from 'cors';

import authRouter, { requireAuth } from './routes/auth.js';
import processesRouter from './routes/processes.js';
import pdfsRouter from './routes/pdfs.js';
import templatesRouter from './routes/templates.js';
import settingsRouter from './routes/settings.js';
import labelsRouter from './routes/labels.js';
import aiRouter from './routes/ai.js';
import { diagnose } from './services/github.js';
import { diagnose as diagnoseMongo } from './services/store.js';

const app = express();
const PORT = process.env.PORT || 4000;
 
// CORS
// Origins are normalized (trailing slash + case) so a small mismatch like
// "https://maps-panel.vercel.app/" vs "https://maps-panel.vercel.app" doesn't
// silently fail — and any rejection is logged so it's visible in Vercel logs
// instead of just showing up as an unexplained CORS error in the browser.
function normalizeOrigin(o) {
  return String(o || '').trim().replace(/\/+$/, '').toLowerCase();
}
const allowed = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / server-to-server / curl
    if (allowed.includes('*')) return cb(null, true);

    const norm = normalizeOrigin(origin);
    if (allowed.includes(norm)) return cb(null, true);

    console.warn('[CORS] rejected origin:', origin, '| allowed:', allowed);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: false
}));

// JSON
app.use(express.json({
  limit: '25mb'
}));

// DEBUG
console.log('SERVER LOADED');

// HEALTH
app.get(['/api/health', '/health'], (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now()
  });
});

// DEBUG — public, no secrets. Tells you why data isn't loading on Vercel.
app.get(['/api/debug', '/debug'], async (_req, res) => {
  const out = {};
  try { out.github = await diagnose(); } catch (e) { out.github = { error: e.message }; }
  try { out.mongo = await diagnoseMongo(); } catch (e) { out.mongo = { error: e.message }; }
  res.json(out);
});

// PUBLIC ROUTES
app.use(['/api', '/'], authRouter);

// PROTECTED ROUTES
app.use(['/api/processes', '/processes'], requireAuth, processesRouter);
app.use(['/api/pdfs', '/pdfs'], requireAuth, pdfsRouter);
app.use(['/api/templates', '/templates'], requireAuth, templatesRouter);
app.use(['/api/settings', '/settings'], requireAuth, settingsRouter);
app.use(['/api/labels', '/labels'], requireAuth, labelsRouter);
app.use(['/api/ai', '/ai'], requireAuth, aiRouter);

// 404 — show the URL Express actually saw, so we can debug from Vercel logs
app.use((req, res) => {
  console.warn('[404]', req.method, req.url);
  res.status(404).json({
    error: 'Route not found',
    method: req.method,
    url: req.url
  });
});

// ERROR HANDLER
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);

  res.status(err.status || 500).json({
    error: err.message || 'Server error'
  });
});


// LOCAL ONLY
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(
      `Backend running on http://localhost:${PORT}`
    );
  });
}

// VERCEL EXPORT
export default app;