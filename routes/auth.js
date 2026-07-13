import express from 'express';
import jwt from 'jsonwebtoken';
import { verifyLogin, listDepartments } from '../services/authstore.js';
import { logEvent } from '../services/rt.js';

const router = express.Router();
const SECRET = () => process.env.JWT_SECRET || 'absheron-secret';

/* --------------------------------------------------------------- guards */
export function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.slice(7);
    req.user = jwt.verify(token, SECRET());
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireAdmin(req, res, next) {
  // super admin can pass admin gates too (but normally uses its own panel)
  if (req.user?.role === 'admin' || req.user?.role === 'superadmin') return next();
  return res.status(403).json({ error: 'Admin only' });
}

export function requireSuperadmin(req, res, next) {
  if (req.user?.role === 'superadmin') return next();
  return res.status(403).json({ error: 'Super admin only' });
}

/* --------------------------------------------------------------- login */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = await verifyLogin(username, password);
    if (!user) return res.status(401).json({ error: 'İstifadəçi adı və ya şifrə yanlışdır' });

    let departmentName = null;
    if (user.tenantId) {
      const depts = await listDepartments().catch(() => []);
      departmentName = depts.find(d => d.id === user.tenantId)?.name || null;
    }

    const token = jwt.sign(
      { username: user.username, role: user.role, tenantId: user.tenantId },
      SECRET(),
      { expiresIn: '30d' }
    );

    logEvent(user.tenantId || '_super', {
      type: 'auth', action: 'login',
      actor: user.username, role: user.role,
      detail: 'Sistemə daxil oldu'
    }).catch(() => {});

    res.json({
      token,
      username: user.username,
      displayName: user.displayName || user.username,
      role: user.role,
      tenantId: user.tenantId,
      departmentName
    });
  } catch (e) { next(e); }
});

/* ----------------------------------------------------------------- /me */
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    let departmentName = null;
    if (req.user.tenantId) {
      const depts = await listDepartments().catch(() => []);
      departmentName = depts.find(d => d.id === req.user.tenantId)?.name || null;
    }
    res.json({
      username: req.user.username,
      role: req.user.role,
      tenantId: req.user.tenantId,
      departmentName
    });
  } catch (e) { next(e); }
});

export default router;
