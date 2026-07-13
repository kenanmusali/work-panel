import { Router } from 'express';
import { getFile, putFile, deleteFile } from '../services/github.js';
import { tenantBase, tenantOf } from '../services/tenancy.js';
import { logEvent, bumpRev, lockStatus } from '../services/rt.js';

const router = Router();

/* ---------- tenant-scoped paths (each department has its own tree) ---------- */
const indexPath   = (base) => `${base}/diagrams/index.json`;
const archivePath = (base) => `${base}/diagrams/archive.json`;
const processPath = (base, id) => `${base}/diagrams/processes/process-${id}.json`;

/* ---------- analytics helper ---------- */
function logAction(req, action, detail, target, targetName) {
  logEvent(tenantOf(req), {
    type: 'admin', action, actor: req.user?.username, role: req.user?.role,
    target: target != null ? String(target) : null, targetName: targetName || null, detail: detail || null
  }).catch(() => {});
}

/* ---------- archive helpers ---------- */
async function readArchive(base) {
  const file = await getFile(archivePath(base));
  const c = file ? file.content : null;
  return (c && Array.isArray(c.items)) ? c : { items: [] };
}
async function writeArchive(base, content, message) {
  return putFile(archivePath(base), content, { message });
}

/* ---------- index helpers + one-time migration to groups ---------- */
function ensureGroups(idx) {
  let changed = false;
  if (!idx || typeof idx !== 'object') idx = {};
  if (!Array.isArray(idx.processes)) { idx.processes = []; changed = true; }
  if (!Array.isArray(idx.groups)) { idx.groups = []; changed = true; }

  const orphans = idx.processes.filter(p => !p.groupId);
  if (orphans.length && idx.groups.length === 0) {
    idx.groups.push({ id: 1, name: 'Ümumi' });
    changed = true;
  }
  if (orphans.length && idx.groups.length) {
    const gid = idx.groups[0].id;
    idx.processes.forEach(p => { if (!p.groupId) { p.groupId = gid; changed = true; } });
  }
  return { idx, changed };
}

async function readIndex(base) {
  const file = await getFile(indexPath(base));
  const { idx } = ensureGroups(file ? file.content : null);
  return idx;
}
async function writeIndex(base, content, message) {
  return putFile(indexPath(base), content, { message });
}

function nextId(list) {
  const ids = (list || []).map(x => Number(x.id)).filter(Number.isFinite);
  return ids.length ? Math.max(...ids) + 1 : 1;
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' });
  next();
}

/* =========================== LIST + GROUPS =========================== */
router.get('/', async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const file = await getFile(indexPath(base));
    const { idx, changed } = ensureGroups(file ? file.content : null);
    if (changed) await writeIndex(base, idx, 'Migrate diagrams to groups').catch(() => {});
    const archive = await readArchive(base);
    res.json({ groups: idx.groups || [], processes: idx.processes || [], archived: archive.items || [] });
  } catch (e) { next(e); }
});

router.post('/group', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Qrup adi teleb olunur' });
    const idx = await readIndex(base);
    const group = { id: nextId(idx.groups), name };
    idx.groups = [...idx.groups, group];
    await writeIndex(base, idx, `Create group ${group.id}`);
    logAction(req, 'group.create', `Qovluq yaradıldı: ${name}`, group.id, name);
    res.status(201).json(group);
  } catch (e) { next(e); }
});

router.put('/group/:gid', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const gid = Number(req.params.gid);
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Qrup adi teleb olunur' });
    const idx = await readIndex(base);
    const g = idx.groups.find(x => Number(x.id) === gid);
    if (!g) return res.status(404).json({ error: 'Qrup tapilmadi' });
    g.name = name;
    await writeIndex(base, idx, `Rename group ${gid}`);
    logAction(req, 'group.rename', `Qovluq adı dəyişdi: ${name}`, gid, name);
    res.json(g);
  } catch (e) { next(e); }
});

router.delete('/group/:gid', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const gid = Number(req.params.gid);
    const idx = await readIndex(base);
    const inGroup = idx.processes.filter(p => Number(p.groupId) === gid);
    for (const p of inGroup) {
      await deleteFile(processPath(base, p.id), { message: `Delete process ${p.id} (group ${gid})` }).catch(() => {});
    }
    idx.processes = idx.processes.filter(p => Number(p.groupId) !== gid);
    idx.groups = idx.groups.filter(g => Number(g.id) !== gid);
    await writeIndex(base, idx, `Delete group ${gid}`);
    logAction(req, 'group.delete', `Qovluq silindi (${inGroup.length} diaqram)`, gid);
    res.json({ ok: true, deletedDiagrams: inGroup.length });
  } catch (e) { next(e); }
});

/* =========================== REORDER =========================== */
router.put('/groups/reorder', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
    if (!order) return res.status(400).json({ error: 'order array required' });
    const idx = await readIndex(base);
    const byId = new Map(idx.groups.map(g => [Number(g.id), g]));
    const reordered = [];
    for (const id of order) if (byId.has(id)) { reordered.push(byId.get(id)); byId.delete(id); }
    for (const g of byId.values()) reordered.push(g);
    idx.groups = reordered;
    await writeIndex(base, idx, 'Reorder groups');
    res.json({ groups: idx.groups });
  } catch (e) { next(e); }
});

router.put('/reorder', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const groupId = Number(req.body?.groupId);
    const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
    if (!groupId || !order) return res.status(400).json({ error: 'groupId and order required' });
    const idx = await readIndex(base);
    const groupItems = idx.processes.filter(p => Number(p.groupId) === groupId);
    const byId = new Map(groupItems.map(p => [Number(p.id), p]));
    const seq = [];
    for (const id of order) if (byId.has(id)) { seq.push(byId.get(id)); byId.delete(id); }
    for (const p of byId.values()) seq.push(p);
    let k = 0;
    idx.processes = idx.processes.map(p => Number(p.groupId) === groupId ? seq[k++] : p);
    await writeIndex(base, idx, `Reorder diagrams in group ${groupId}`);
    res.json({ processes: idx.processes });
  } catch (e) { next(e); }
});

/* =========================== ARCHIVE =========================== */
router.post('/:id/archive', async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const id = Number(req.params.id);
    const idx = await readIndex(base);
    const entry = idx.processes.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'Process not found' });

    idx.processes = idx.processes.filter(p => Number(p.id) !== id);
    const archive = await readArchive(base);
    const group = idx.groups.find(g => Number(g.id) === Number(entry.groupId));
    archive.items = [
      ...archive.items.filter(a => Number(a.id) !== id),
      { ...entry, groupName: group?.name || '', archivedAt: new Date().toISOString() }
    ];
    await writeArchive(base, archive, `Archive process ${id}`);
    await writeIndex(base, idx, `Remove process ${id} from index (archived)`);
    logAction(req, 'diagram.archive', `Diaqram arxivləndi: ${entry.title}`, id, entry.title);
    res.json({ ok: true, archived: archive.items });
  } catch (e) { next(e); }
});

router.post('/:id/unarchive', async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const id = Number(req.params.id);
    const archive = await readArchive(base);
    const entry = archive.items.find(a => Number(a.id) === id);
    if (!entry) return res.status(404).json({ error: 'Archived process not found' });

    const idx = await readIndex(base);
    let gid = Number(entry.groupId);
    if (!idx.groups.some(g => Number(g.id) === gid)) {
      if (!idx.groups.length) idx.groups.push({ id: 1, name: 'Ümumi' });
      gid = Number(idx.groups[0].id);
    }
    const { groupName, archivedAt, ...meta } = entry;
    idx.processes = [...idx.processes, { ...meta, groupId: gid }];
    archive.items = archive.items.filter(a => Number(a.id) !== id);
    await writeIndex(base, idx, `Restore process ${id} from archive`);
    await writeArchive(base, archive, `Unarchive process ${id}`);
    logAction(req, 'diagram.unarchive', `Diaqram arxivdən qaytarıldı: ${meta.title}`, id, meta.title);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* =========================== PROCESSES =========================== */
router.get('/:id', async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const file = await getFile(processPath(base, req.params.id));
    if (!file) return res.status(404).json({ error: 'Process not found' });
    res.json(file.content);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const idx = await readIndex(base);
    const groupId = Number(req.body.groupId);
    if (!groupId || !idx.groups.some(g => Number(g.id) === groupId)) {
      return res.status(400).json({ error: 'Diaqram bir qrupa aid olmalidir' });
    }
    const newId = req.body.id || nextId(idx.processes);
    const title = req.body.title || `Yeni proses ${newId}`;
    const subtitle = req.body.subtitle ? String(req.body.subtitle) : '';

    const process = {
      id: newId, title, subtitle,
      width: req.body.width || 1600,
      height: req.body.height || 600,
      lanes: req.body.lanes || [],
      nodes: req.body.nodes || [],
      edges: req.body.edges || []
    };
    if (req.body.theme && typeof req.body.theme === 'object') process.theme = req.body.theme;
    await putFile(processPath(base, newId), process, { message: `Create process ${newId}` });
    idx.processes = [...idx.processes, { id: newId, title, subtitle, groupId }];
    await writeIndex(base, idx, `Add process ${newId} to index`);
    await bumpRev(tenantOf(req), newId).catch(() => {});
    logAction(req, 'diagram.create', `Diaqram yaradıldı: ${title}`, newId, title);
    res.status(201).json(process);
  } catch (e) { next(e); }
});

router.put('/:id/meta', async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const id = Number(req.params.id);
    const idx = await readIndex(base);
    const entry = idx.processes.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'Process not found' });

    if (typeof req.body.title === 'string') entry.title = req.body.title;
    if (typeof req.body.subtitle === 'string') entry.subtitle = req.body.subtitle;
    if (req.body.groupId !== undefined) {
      const gid = Number(req.body.groupId);
      if (idx.groups.some(g => Number(g.id) === gid)) entry.groupId = gid;
    }
    await writeIndex(base, idx, `Update meta for process ${id}`);

    const file = await getFile(processPath(base, id));
    if (file) {
      const body = { ...file.content, title: entry.title, subtitle: entry.subtitle };
      await putFile(processPath(base, id), body, { message: `Sync meta for process ${id}` });
    }
    logAction(req, 'diagram.meta', `Diaqram məlumatı yeniləndi: ${entry.title}`, id, entry.title);
    res.json(entry);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const id = req.params.id;
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Process body required' });
    }

    // Edit-lock guard: block saves when another admin holds the live lock.
    const lock = await lockStatus(tenantOf(req), id).catch(() => null);
    if (lock && lock.owner !== req.user?.username) {
      return res.status(423).json({ error: `Bu diaqramı hazırda ${lock.owner} redaktə edir`, lock });
    }

    body.id = Number(id);
    await putFile(processPath(base, id), body, { message: `Update process ${id}` });

    const idx = await readIndex(base);
    const i = idx.processes.findIndex(p => Number(p.id) === Number(id));
    if (i >= 0) {
      let changed = false;
      if (typeof body.title === 'string' && idx.processes[i].title !== body.title) {
        idx.processes[i].title = body.title; changed = true;
      }
      if (typeof body.subtitle === 'string' && idx.processes[i].subtitle !== body.subtitle) {
        idx.processes[i].subtitle = body.subtitle; changed = true;
      }
      if (changed) await writeIndex(base, idx, `Sync title for process ${id}`);
    }
    const rev = await bumpRev(tenantOf(req), id).catch(() => 0);
    logAction(req, 'diagram.update', `Diaqram redaktə edildi: ${body.title || id}`, id, body.title);
    res.json({ ...body, _rev: rev });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const id = req.params.id;
    await deleteFile(processPath(base, id), { message: `Delete process ${id}` });
    const idx = await readIndex(base);
    const entry = idx.processes.find(p => Number(p.id) === Number(id));
    idx.processes = idx.processes.filter(p => Number(p.id) !== Number(id));
    await writeIndex(base, idx, `Remove process ${id} from index`);
    const archive = await readArchive(base);
    if (archive.items.some(a => Number(a.id) === Number(id))) {
      archive.items = archive.items.filter(a => Number(a.id) !== Number(id));
      await writeArchive(base, archive, `Remove process ${id} from archive`);
    }
    logAction(req, 'diagram.delete', `Diaqram silindi: ${entry?.title || id}`, id, entry?.title);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
