// live.js — endpoints every logged-in user hits for the real-time features:
// presence heartbeat, edit-locks, revision polling and activity tracking.
import { Router } from 'express';
import {
  presenceBeat, presenceLeave,
  lockAcquire, lockRelease, lockStatus,
  getAllRevs, logEvent
} from '../services/rt.js';

const router = Router();
const tid = (req) => req.user?.tenantId || '_super';

/* ----- presence: client beats every ~12s with what it's looking at ----- */
router.post('/presence', async (req, res, next) => {
  try {
    const { view, target, targetName } = req.body || {};
    await presenceBeat(tid(req), req.user.username, {
      role: req.user.role,
      view: String(view || '').slice(0, 40),
      target: target != null ? String(target).slice(0, 40) : null,
      targetName: targetName ? String(targetName).slice(0, 120) : null
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/presence/leave', async (req, res, next) => {
  try { await presenceLeave(tid(req), req.user.username); res.json({ ok: true }); }
  catch (e) { next(e); }
});

/* ----------------------------- edit locks ----------------------------- */
// Acquire OR refresh a diagram lock. Returns whether someone else holds it.
router.post('/lock/:id', async (req, res, next) => {
  try {
    const r = await lockAcquire(tid(req), req.params.id, req.user.username, req.user.role);
    res.status(r.ok ? 200 : 423).json(r); // 423 Locked
  } catch (e) { next(e); }
});

router.get('/lock/:id', async (req, res, next) => {
  try { res.json({ lock: await lockStatus(tid(req), req.params.id) }); }
  catch (e) { next(e); }
});

router.delete('/lock/:id', async (req, res, next) => {
  try { res.json(await lockRelease(tid(req), req.params.id, req.user.username)); }
  catch (e) { next(e); }
});

/* --------------------- revisions (live diagram sync) ------------------- */
// Map of diagramId -> rev marker. Viewers poll this to detect saves.
router.get('/revs', async (req, res, next) => {
  try { res.json({ revs: await getAllRevs(tid(req)) }); }
  catch (e) { next(e); }
});

/* --------------------------- activity tracking ------------------------- */
// Lightweight view/click events from the client (open diagram, click node…).
const ALLOWED = new Set(['view.hub', 'view.diagrams', 'view.pdfs', 'view.diagram', 'view.pdf', 'click.node', 'open.superadmin']);
router.post('/track', async (req, res, next) => {
  try {
    const { action, target, targetName, detail } = req.body || {};
    if (!ALLOWED.has(action)) return res.json({ ok: true, skipped: true });
    await logEvent(req.user.tenantId || '_super', {
      type: 'user',
      action,
      actor: req.user.username,
      role: req.user.role,
      target: target != null ? String(target).slice(0, 60) : null,
      targetName: targetName ? String(targetName).slice(0, 160) : null,
      detail: detail ? String(detail).slice(0, 200) : null
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
