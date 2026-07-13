import { Router } from 'express';
import { getFile, putFile, deleteFile, getBinary, putBinary, deleteBinary } from '../services/github.js';
import { tenantBase, tenantOf } from '../services/tenancy.js';
import { logEvent } from '../services/rt.js';

const router = Router();

const pdfIndexPath      = (base) => `${base}/files/index.json`;
const pdfArchivePath    = (base) => `${base}/files/archive.json`;
const pdfFilePathFiles  = (base, id) => `${base}/files/pdf/pdf-${id}.pdf`;
const pdfFilePathLegacy  = (base, id) => `${base}/pdfs/files/pdf-${id}.pdf`;
const pdfFilePathLegacy2 = (base, id) => `${base}/files/files/pdf-${id}.pdf`;

function logAction(req, action, detail, target, targetName) {
  logEvent(tenantOf(req), {
    type: 'admin', action, actor: req.user?.username, role: req.user?.role,
    target: target != null ? String(target) : null, targetName: targetName || null, detail: detail || null
  }).catch(() => {});
}

async function readArchive(base) {
  const file = await getFile(pdfArchivePath(base));
  const c = file ? file.content : null;
  return (c && Array.isArray(c.items)) ? c : { items: [] };
}
async function writeArchive(base, content, message) {
  return putFile(pdfArchivePath(base), content, { message });
}

function ensureGroups(idx) {
  let changed = false;
  if (!idx || typeof idx !== 'object') idx = {};
  if (!Array.isArray(idx.pdfs)) { idx.pdfs = []; changed = true; }
  if (!Array.isArray(idx.groups)) { idx.groups = []; changed = true; }

  const orphans = idx.pdfs.filter(p => !p.groupId);
  if (orphans.length && idx.groups.length === 0) {
    idx.groups.push({ id: 1, name: 'Ümumi' });
    changed = true;
  }
  if (orphans.length && idx.groups.length) {
    const gid = idx.groups[0].id;
    idx.pdfs.forEach(p => { if (!p.groupId) { p.groupId = gid; changed = true; } });
  }
  return { idx, changed };
}

async function readIndex(base) {
  const file = await getFile(pdfIndexPath(base));
  const { idx } = ensureGroups(file ? file.content : null);
  return idx;
}
async function writeIndex(base, content, message) {
  return putFile(pdfIndexPath(base), content, { message });
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
    const file = await getFile(pdfIndexPath(base));
    const { idx, changed } = ensureGroups(file ? file.content : null);
    if (changed) await writeIndex(base, idx, 'Migrate pdfs to groups').catch(() => {});
    const archive = await readArchive(base);
    res.json({ groups: idx.groups || [], pdfs: idx.pdfs || [], archived: archive.items || [] });
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
    await writeIndex(base, idx, `Create pdf group ${group.id}`);
    logAction(req, 'pdfgroup.create', `PDF qovluğu yaradıldı: ${name}`, group.id, name);
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
    await writeIndex(base, idx, `Rename pdf group ${gid}`);
    logAction(req, 'pdfgroup.rename', `PDF qovluğu adı dəyişdi: ${name}`, gid, name);
    res.json(g);
  } catch (e) { next(e); }
});

router.delete('/group/:gid', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const gid = Number(req.params.gid);
    const idx = await readIndex(base);
    const inGroup = idx.pdfs.filter(p => Number(p.groupId) === gid);
    for (const p of inGroup) {
      await deleteBinary(pdfFilePathFiles(base, p.id), { message: `Delete pdf ${p.id} (group ${gid})` }).catch(() => {});
      await deleteBinary(pdfFilePathLegacy(base, p.id)).catch(() => {});
      await deleteBinary(pdfFilePathLegacy2(base, p.id)).catch(() => {});
    }
    idx.pdfs = idx.pdfs.filter(p => Number(p.groupId) !== gid);
    idx.groups = idx.groups.filter(g => Number(g.id) !== gid);
    await writeIndex(base, idx, `Delete pdf group ${gid}`);
    logAction(req, 'pdfgroup.delete', `PDF qovluğu silindi (${inGroup.length} sənəd)`, gid);
    res.json({ ok: true, deletedPdfs: inGroup.length });
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
    await writeIndex(base, idx, 'Reorder pdf groups');
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
    const groupItems = idx.pdfs.filter(p => Number(p.groupId) === groupId);
    const byId = new Map(groupItems.map(p => [Number(p.id), p]));
    const seq = [];
    for (const id of order) if (byId.has(id)) { seq.push(byId.get(id)); byId.delete(id); }
    for (const p of byId.values()) seq.push(p);
    let k = 0;
    idx.pdfs = idx.pdfs.map(p => Number(p.groupId) === groupId ? seq[k++] : p);
    await writeIndex(base, idx, `Reorder pdfs in group ${groupId}`);
    res.json({ pdfs: idx.pdfs });
  } catch (e) { next(e); }
});

/* =========================== ARCHIVE =========================== */
router.post('/:id/archive', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const id = Number(req.params.id);
    const idx = await readIndex(base);
    const entry = idx.pdfs.find(p => Number(p.id) === id);
    if (!entry) return res.status(404).json({ error: 'PDF not found' });

    idx.pdfs = idx.pdfs.filter(p => Number(p.id) !== id);
    const archive = await readArchive(base);
    const group = idx.groups.find(g => Number(g.id) === Number(entry.groupId));
    archive.items = [
      ...archive.items.filter(a => Number(a.id) !== id),
      { ...entry, groupName: group?.name || '', archivedAt: new Date().toISOString() }
    ];
    await writeArchive(base, archive, `Archive pdf ${id}`);
    await writeIndex(base, idx, `Remove pdf ${id} from index (archived)`);
    logAction(req, 'pdf.archive', `Sənəd arxivləndi: ${entry.title}`, id, entry.title);
    res.json({ ok: true, archived: archive.items });
  } catch (e) { next(e); }
});

router.post('/:id/unarchive', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const id = Number(req.params.id);
    const archive = await readArchive(base);
    const entry = archive.items.find(a => Number(a.id) === id);
    if (!entry) return res.status(404).json({ error: 'Archived PDF not found' });

    const idx = await readIndex(base);
    let gid = Number(entry.groupId);
    if (!idx.groups.some(g => Number(g.id) === gid)) {
      if (!idx.groups.length) idx.groups.push({ id: 1, name: 'Ümumi' });
      gid = Number(idx.groups[0].id);
    }
    const { groupName, archivedAt, ...meta } = entry;
    idx.pdfs = [...idx.pdfs, { ...meta, groupId: gid }];
    archive.items = archive.items.filter(a => Number(a.id) !== id);
    await writeIndex(base, idx, `Restore pdf ${id} from archive`);
    await writeArchive(base, archive, `Unarchive pdf ${id}`);
    logAction(req, 'pdf.unarchive', `Sənəd arxivdən qaytarıldı: ${meta.title}`, id, meta.title);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* =========================== PDF FILE STREAM =========================== */
router.get('/:id/file', async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const id = req.params.id;
    const idx = await readIndex(base);
    let meta = (idx.pdfs || []).find(p => Number(p.id) === Number(id));
    if (!meta) {
      const archive = await readArchive(base);
      meta = archive.items.find(a => Number(a.id) === Number(id));
    }
    if (!meta) return res.status(404).json({ error: 'PDF not found' });

    let bin = await getBinary(pdfFilePathFiles(base, id));
    if (!bin) bin = await getBinary(pdfFilePathLegacy(base, id));
    if (!bin) bin = await getBinary(pdfFilePathLegacy2(base, id));
    if (!bin) return res.status(404).json({ error: 'PDF file missing' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(meta.filename || `pdf-${id}.pdf`)}"`);
    res.setHeader('Content-Length', bin.length);
    res.send(bin);
  } catch (e) { next(e); }
});

/* =========================== PDF CRUD =========================== */
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const { title, subtitle, filename, dataBase64, groupId } = req.body || {};
    if (!title || !dataBase64) return res.status(400).json({ error: 'title and dataBase64 are required' });
    const idx = await readIndex(base);
    const gid = Number(groupId);
    if (!gid || !idx.groups.some(g => Number(g.id) === gid)) {
      return res.status(400).json({ error: 'PDF bir qrupa aid olmalidir' });
    }
    const newId = nextId(idx.pdfs);
    const buf = Buffer.from(dataBase64, 'base64');
    await putBinary(pdfFilePathFiles(base, newId), buf, { message: `Add pdf ${newId}` });

    const entry = {
      id: newId, title: String(title),
      subtitle: subtitle ? String(subtitle) : '',
      filename: filename || `pdf-${newId}.pdf`,
      size: buf.length, groupId: gid,
      uploadedAt: new Date().toISOString()
    };
    idx.pdfs = [...idx.pdfs, entry];
    await writeIndex(base, idx, `Add pdf ${newId} to index`);
    logAction(req, 'pdf.create', `Sənəd əlavə olundu: ${entry.title}`, newId, entry.title);
    res.status(201).json(entry);
  } catch (e) { next(e); }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const id = Number(req.params.id);
    const { title, subtitle, filename, dataBase64, groupId } = req.body || {};
    const idx = await readIndex(base);
    const i = idx.pdfs.findIndex(p => Number(p.id) === id);
    if (i < 0) return res.status(404).json({ error: 'PDF not found' });

    const updated = { ...idx.pdfs[i] };
    if (typeof title === 'string') updated.title = title;
    if (typeof subtitle === 'string') updated.subtitle = subtitle;
    if (typeof filename === 'string' && filename) updated.filename = filename;
    if (groupId !== undefined) {
      const gid = Number(groupId);
      if (idx.groups.some(g => Number(g.id) === gid)) updated.groupId = gid;
    }
    if (dataBase64) {
      const buf = Buffer.from(dataBase64, 'base64');
      await putBinary(pdfFilePathFiles(base, id), buf, { message: `Replace pdf ${id}` });
      updated.size = buf.length;
      updated.uploadedAt = new Date().toISOString();
    }
    idx.pdfs[i] = updated;
    await writeIndex(base, idx, `Update pdf ${id}`);
    logAction(req, 'pdf.update', `Sənəd yeniləndi: ${updated.title}`, id, updated.title);
    res.json(updated);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const base = tenantBase(tenantOf(req));
    const id = Number(req.params.id);
    const idx = await readIndex(base);
    const entry = idx.pdfs.find(p => Number(p.id) === id);
    idx.pdfs = (idx.pdfs || []).filter(p => Number(p.id) !== id);
    await deleteBinary(pdfFilePathFiles(base, id), { message: `Delete pdf ${id}` }).catch(() => {});
    await deleteBinary(pdfFilePathLegacy(base, id)).catch(() => {});
    await deleteBinary(pdfFilePathLegacy2(base, id)).catch(() => {});
    await writeIndex(base, idx, `Remove pdf ${id} from index`);
    const archive = await readArchive(base);
    if (archive.items.some(a => Number(a.id) === id)) {
      archive.items = archive.items.filter(a => Number(a.id) !== id);
      await writeArchive(base, archive, `Remove pdf ${id} from archive`);
    }
    logAction(req, 'pdf.delete', `Sənəd silindi: ${entry?.title || id}`, id, entry?.title);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
