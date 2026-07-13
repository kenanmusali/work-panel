import { Router } from 'express';
import { getFile, putFile } from '../services/github.js';
import { tenantBase, tenantOf } from '../services/tenancy.js';

const router = Router();
const settingsPath = (base) => `${base}/settings.json`;

const DEFAULTS = {
  org_title: 'ABŞERON LOGİSTİKA MƏRKƏZİ',
  diagrams_page_title: 'İş Axışları',
  pdf_page_title: 'Normativ Sənədlər',
  hub_diagrams_title: 'İş Axışları',
  hub_diagrams_sub: 'Proses xəritələri',
  hub_pdf_title: 'Normativ Sənədlər',
  hub_pdf_sub: 'Prosedurlar, prosesler, əsəsnamələr'
};

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' });
  next();
}

async function readSettings(base) {
  const file = await getFile(settingsPath(base));
  return { ...DEFAULTS, ...(file?.content || {}) };
}

// GET /api/settings — anyone logged in (scoped to their department)
router.get('/', async (req, res, next) => {
  try {
    res.json(await readSettings(tenantBase(tenantOf(req))));
  } catch (e) { next(e); }
});

// PUT /api/settings — admin only; merges provided keys
router.put('/', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const current = await readSettings(base);
    const incoming = req.body || {};
    const nextSettings = { ...current };
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof incoming[k] === 'string') nextSettings[k] = incoming[k];
    }
    await putFile(settingsPath(base), nextSettings, { message: 'Update settings' });
    res.json(nextSettings);
  } catch (e) { next(e); }
});

export default router;
