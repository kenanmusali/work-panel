// superadmin.js — global control panel API. Super admin only.
// It NEVER creates or edits diagrams/PDFs — only departments, users,
// live presence and analytics.
import { Router } from 'express';
import {
  listDepartments, createDepartment, renameDepartment, deleteDepartment,
  listUsers, createUser, updateUser, deleteUser
} from '../services/authstore.js';
import {
  presenceListAll, lockList, readEventsMany, logEvent, rtBackend
} from '../services/rt.js';

const router = Router();
const SUPER_BUCKET = '_super';

async function allTenantIds() {
  const depts = await listDepartments();
  return [...depts.map(d => d.id), SUPER_BUCKET];
}
function audit(actor, action, detail, tenantId = SUPER_BUCKET) {
  logEvent(tenantId, { type: 'superadmin', action, actor, role: 'superadmin', detail }).catch(() => {});
}

/* ------------------------------------------------------------ overview */
router.get('/overview', async (req, res, next) => {
  try {
    const depts = await listDepartments();
    const users = await listUsers();
    const online = await presenceListAll(await allTenantIds());
    res.json({
      backend: rtBackend(),
      departments: depts.length,
      users: users.length,
      admins: users.filter(u => u.role === 'admin').length,
      viewers: users.filter(u => u.role === 'viewer').length,
      onlineNow: online.length
    });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------- departments */
router.get('/departments', async (_req, res, next) => {
  try {
    const depts = await listDepartments();
    const users = await listUsers();
    res.json(depts.map(d => ({
      ...d,
      userCount: users.filter(u => u.tenantId === d.id).length,
      adminCount: users.filter(u => u.tenantId === d.id && u.role === 'admin').length
    })));
  } catch (e) { next(e); }
});

router.post('/departments', async (req, res, next) => {
  try {
    const dept = await createDepartment(req.body?.name);
    audit(req.user.username, 'department.create', `Şöbə yaradıldı: ${dept.name}`);
    res.status(201).json(dept);
  } catch (e) { next(e); }
});

router.put('/departments/:id', async (req, res, next) => {
  try {
    const dept = await renameDepartment(req.params.id, req.body?.name);
    audit(req.user.username, 'department.rename', `Şöbə adı dəyişdi: ${dept.name}`);
    res.json(dept);
  } catch (e) { next(e); }
});

router.delete('/departments/:id', async (req, res, next) => {
  try {
    await deleteDepartment(req.params.id);
    audit(req.user.username, 'department.delete', `Şöbə silindi: ${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------------- users */
router.get('/users', async (req, res, next) => {
  try { res.json(await listUsers(req.query.tenantId || undefined)); }
  catch (e) { next(e); }
});

router.post('/users', async (req, res, next) => {
  try {
    const user = await createUser({ ...req.body, createdBy: req.user.username });
    audit(req.user.username, 'user.create', `${user.role === 'admin' ? 'Admin' : 'İstifadəçi'} yaradıldı: ${user.username}`, user.tenantId);
    res.status(201).json(user);
  } catch (e) { next(e); }
});

router.put('/users/:username', async (req, res, next) => {
  try {
    const user = await updateUser(req.params.username, req.body || {});
    const what = [];
    if (req.body?.password) what.push('şifrə');
    if (req.body?.role) what.push('rol=' + req.body.role);
    if (typeof req.body?.disabled === 'boolean') what.push(req.body.disabled ? 'deaktiv' : 'aktiv');
    if (req.body?.tenantId !== undefined) what.push('şöbə');
    audit(req.user.username, 'user.update', `${user.username} yeniləndi (${what.join(', ') || 'məlumat'})`, user.tenantId);
    res.json(user);
  } catch (e) { next(e); }
});

router.delete('/users/:username', async (req, res, next) => {
  try {
    await deleteUser(req.params.username);
    audit(req.user.username, 'user.delete', `İstifadəçi silindi: ${req.params.username}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ----------------------------------------------------------- live view */
// Who is online right now, across every department, and what they're doing.
router.get('/live', async (_req, res, next) => {
  try {
    const ids = await allTenantIds();
    const [people, depts] = await Promise.all([presenceListAll(ids), listDepartments()]);
    const nameOf = Object.fromEntries(depts.map(d => [d.id, d.name]));
    // attach active edit locks per tenant
    const lockLists = await Promise.all(depts.map(d => lockList(d.id).catch(() => [])));
    const locks = [];
    depts.forEach((d, i) => lockLists[i].forEach(l => locks.push({ ...l, tenantId: d.id, departmentName: d.name })));
    res.json({
      people: people.map(p => ({ ...p, departmentName: p.tenantId === SUPER_BUCKET ? '—' : (nameOf[p.tenantId] || p.tenantId) })),
      locks
    });
  } catch (e) { next(e); }
});

/* ----------------------------------------------------------- analytics */
// History of admin actions + user views/clicks, filterable.
router.get('/analytics', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const ids = req.query.tenantId ? [req.query.tenantId] : await allTenantIds();
    let events = await readEventsMany(ids, { limit: 2000 });
    const { actor, type, action, since } = req.query;
    if (actor) events = events.filter(e => e.actor === actor);
    if (type) events = events.filter(e => e.type === type);
    if (action) events = events.filter(e => (e.action || '').startsWith(action));
    if (since) { const t = Number(since); events = events.filter(e => e.ts >= t); }
    res.json({ events: events.slice(0, limit) });
  } catch (e) { next(e); }
});

export default router;
