import { useState, useEffect, useRef } from 'react';
import { LogoFull } from './Logo.jsx';
import {
  Search, LogOut, Plus, Loader2, Trash2, ChevronLeft,
  ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown,
  Folder, FolderOpen, FolderPlus, Pencil, Edit3, GripVertical, Save, Check, Undo2
} from './icons.jsx';
import { Archive, ArchiveRestore } from 'lucide-react';
import { api, setToken } from '../api/client.js';
import NameModal from './NameModal.jsx';
import TitleEditButton from './TitleEditButton.jsx';
import { importDiagramFromExcel, downloadTemplate } from './excel.js';
import { importDiagramFromJson } from './diagramExport.js';

function fmtTime(d) {
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = (h % 12 || 12).toString().padStart(2, '0');
  return `${hh}:${m} ${period}`;
}
function fmtDate(d) {
  const dd = d.getDate().toString().padStart(2, '0');
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

// normalize a group's parentId to either null or a Number
function normPid(g) {
  return (g.parentId === undefined || g.parentId === null || g.parentId === 0)
    ? null
    : Number(g.parentId);
}

export default function Home({ onOpen, onLogout, onBack }) {
  const [now, setNow] = useState(new Date());
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [groups, setGroups] = useState([]);
  const [processes, setProcesses] = useState([]);
  const [archived, setArchived] = useState([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState({});   // groupId -> bool
  const [modal, setModal] = useState(null);        // see types below
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(null);
  const [pendingArchive, setPendingArchive] = useState(null); // process id awaiting confirm
  const searchInputRef = useRef(null);

  // ---- staged (unsaved) folder edits ----
  // Folder create/rename/move/delete/reorder are applied to local state only.
  // pristineGroupsRef holds the last-saved-from-server snapshot so "Save All"
  // can diff against it and send only what actually changed.
  const pristineGroupsRef = useRef([]);
  const pristineProcessesRef = useRef([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const tempIdRef = useRef(-1);
  function nextTempId() { return tempIdRef.current--; }
  function isTempId(id) { return typeof id === 'number' && id < 0; }

  // warn before leaving the tab with unsaved folder changes
  useEffect(() => {
    function onBeforeUnload(e) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // ---- drag & drop ordering ----
  const groupDrag = useRef(null);          // gid being dragged
  const [groupOver, setGroupOver] = useState(null);
  const itemDrag = useRef(null);           // { gid, id }
  const [itemOver, setItemOver] = useState(null); // { gid, id }

  const role = localStorage.getItem('role');
  const isViewer = role === 'viewer';
  const isAdmin = role === 'admin';

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { load(); }, []);
  useEffect(() => { api.getSettings().then(setSettings).catch(() => setSettings({})); }, []);
  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);

  async function saveSettings(patch) {
    const next = await api.updateSettings(patch);
    setSettings(next);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api.listProcesses();
      const gs = data.groups || [];
      setGroups(gs);
      setProcesses(data.processes || []);
      setArchived(data.archived || []);
      // all groups start CLOSED the first time we see them
      setExpanded(prev => {
        const o = { ...prev };
        gs.forEach(g => { if (!(g.id in o)) o[g.id] = false; });
        return o;
      });
      pristineGroupsRef.current = gs.map(g => ({ id: g.id, name: g.name, parentId: normPid(g) }));
      pristineProcessesRef.current = data.processes || [];
      setDirty(false);
      setSaveError('');
    } catch (e) {
      setError(e.message);
      if (e.status === 401) onLogout();
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setToken(null);
    localStorage.removeItem('role');
    localStorage.removeItem('username');
    onLogout();
  }

  function toggleGroup(gid) {
    setExpanded(prev => ({ ...prev, [gid]: !prev[gid] }));
  }

  /* ---------- collapse / expand all (any depth) ---------- */
  const allGroupIds = groups.map(g => g.id);
  const allOpen = allGroupIds.length > 0 && allGroupIds.every(id => expanded[id]);
  function toggleCollapseAll() {
    setExpanded(() => {
      const o = {};
      allGroupIds.forEach(id => { o[id] = !allOpen; });
      return o;
    });
  }

  /* ---------- nested-group helpers ---------- */
  function childGroupsOf(parentId) {
    const p = parentId == null ? null : Number(parentId);
    return groups.filter(g => normPid(g) === p);
  }
  function itemsOfGroup(gid) {
    return processes.filter(p => p && Number(p.groupId) === Number(gid));
  }
  function groupNumber(g) {
    const parts = [];
    let cur = g;
    while (cur) {
      const pid = normPid(cur);
      const siblings = childGroupsOf(pid);
      const idx = siblings.findIndex(s => s.id === cur.id);
      parts.unshift(idx + 1);
      cur = pid ? groups.find(x => Number(x.id) === pid) : null;
    }
    return parts.join('.');
  }
  function groupHasAnyItemsDeep(g) {
    if (itemsOfGroup(g.id).length > 0) return true;
    return childGroupsOf(g.id).some(cg => groupHasAnyItemsDeep(cg));
  }
  function groupHasMatchDeep(g) {
    if (itemsOfGroup(g.id).some(matches)) return true;
    return childGroupsOf(g.id).some(cg => groupHasMatchDeep(cg));
  }

  /* ---------- drag & drop: folders ---------- */
  const [draggingGroupId, setDraggingGroupId] = useState(null);

  function collectDescendantGroupIds(gid, groupList) {
    const ids = [gid];
    let frontier = [gid];
    while (frontier.length) {
      const kids = groupList.filter(x => frontier.includes(normPid(x)));
      const kidIds = kids.map(x => x.id);
      ids.push(...kidIds);
      frontier = kidIds;
    }
    return ids;
  }

  function onGroupDragStart(e, gid) {
    if (isViewer) return;
    groupDrag.current = gid;
    setDraggingGroupId(gid);
    e.dataTransfer.effectAllowed = 'move';
  }
  function onGroupDragOver(e, gid) {
    if (groupDrag.current == null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (groupOver !== gid) setGroupOver(gid);
  }
  function onGroupDrop(e, gid) {
    e.preventDefault();
    e.stopPropagation();
    const from = groupDrag.current;
    groupDrag.current = null;
    setDraggingGroupId(null);
    setGroupOver(null);
    if (from == null || from === gid) return;
    const fromG = groups.find(g => g.id === from);
    const toG = groups.find(g => g.id === gid);
    if (!fromG || !toG) return;

    if (normPid(fromG) === normPid(toG)) {
      // same parent -> just reorder these siblings
      const order = groups.map(g => g.id);
      const fi = order.indexOf(from);
      const ti = order.indexOf(gid);
      if (fi < 0 || ti < 0) return;
      order.splice(ti, 0, order.splice(fi, 1)[0]);
      const next = order.map(id => groups.find(g => g.id === id));
      setGroups(next);
      setDirty(true);
      return;
    }

    // different parent -> dragging this folder onto another folder nests it
    // inside that folder. Anything already inside `fromG` (subgroups and
    // diagrams) stays linked to it by id, so it all moves along together.
    const descendantIds = collectDescendantGroupIds(from, groups);
    if (descendantIds.includes(toG.id)) {
      alert('Qrupu öz alt qrupunun içinə köçürmək olmaz.');
      return;
    }
    setGroups(prev => prev.map(g => g.id === from ? { ...g, parentId: toG.id } : g));
    setExpanded(prev => ({ ...prev, [toG.id]: true }));
    setDirty(true);
  }
  function onGroupDragEnd() { groupDrag.current = null; setDraggingGroupId(null); setGroupOver(null); }

  // Dropping a dragged folder on this zone (shown only while dragging a
  // nested folder) moves it back out to the top level.
  function onRootDragOver(e) {
    if (groupDrag.current == null) return;
    const fromG = groups.find(g => g.id === groupDrag.current);
    if (!fromG || normPid(fromG) === null) return; // already top-level
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (groupOver !== '__root__') setGroupOver('__root__');
  }
  function onRootDrop(e) {
    e.preventDefault();
    const from = groupDrag.current;
    groupDrag.current = null;
    setDraggingGroupId(null);
    setGroupOver(null);
    if (from == null) return;
    const fromG = groups.find(g => g.id === from);
    if (!fromG || normPid(fromG) === null) return;
    setGroups(prev => prev.map(g => g.id === from ? { ...g, parentId: null } : g));
    setDirty(true);
  }

  /* ---------- drag & drop: items inside a folder ---------- */
  function onItemDragStart(e, gid, id) {
    if (isViewer) return;
    e.stopPropagation();
    itemDrag.current = { gid, id };
    e.dataTransfer.effectAllowed = 'move';
  }
  function onItemDragOver(e, gid, id) {
    const d = itemDrag.current;
    if (!d || Number(d.gid) !== Number(gid)) return; // only within the same folder
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!itemOver || itemOver.id !== id) setItemOver({ gid, id });
  }
  async function onItemDrop(e, gid, id) {
    const d = itemDrag.current;
    itemDrag.current = null;
    setItemOver(null);
    if (!d || Number(d.gid) !== Number(gid) || d.id === id) return;
    e.preventDefault();
    e.stopPropagation();

    const groupIds = processes.filter(p => Number(p.groupId) === Number(gid)).map(p => p.id);
    const fi = groupIds.indexOf(d.id);
    const ti = groupIds.indexOf(id);
    if (fi < 0 || ti < 0) return;
    groupIds.splice(ti, 0, groupIds.splice(fi, 1)[0]);

    const byId = new Map(processes.map(p => [p.id, p]));
    let k = 0;
    const reordered = processes.map(p => {
      if (Number(p.groupId) !== Number(gid)) return p;
      const nid = groupIds[k++];
      return byId.get(nid) || p;
    }).filter(Boolean);

    setProcesses(reordered); // optimistic
    try { await api.reorderProcesses(Number(gid), groupIds); } catch { load(); }
  }
  function onItemDragEnd() { itemDrag.current = null; setItemOver(null); }

  /* ---------- group actions (staged locally, sent on Save All) ---------- */
  function saveGroupCreate({ name }) {
    const parentId = modal?.parentId ?? null;
    const tempId = nextTempId();
    setGroups(prev => [...prev, { id: tempId, name, parentId: parentId || null }]);
    setExpanded(prev => ({ ...prev, [tempId]: true }));
    setModal(null);
    setDirty(true);
  }
  function saveGroupRename({ name }) {
    const gid = modal.group.id;
    setGroups(prev => prev.map(g => g.id === gid ? { ...g, name } : g));
    setModal(null);
    setDirty(true);
  }
  function deleteGroup(g) {
    const count = itemsOfGroup(g.id).length;
    const subCount = childGroupsOf(g.id).length;
    let msg = `"${g.name}" qrupunu silmək istəyirsiniz?`;
    if (count || subCount) {
      msg = `"${g.name}" qrupunu`
        + (subCount ? ` və ${subCount} alt qrupunu` : '')
        + (count ? ` və içindəki ${count} diaqramı` : '')
        + ` silmək istəyirsiniz? "Yadda saxla"ya basana qədər tətbiq olunmayacaq.`;
    }
    if (!confirm(msg)) return;
    const allIds = collectDescendantGroupIds(g.id, groups);
    setGroups(prev => prev.filter(x => !allIds.includes(x.id)));
    setProcesses(prev => prev.filter(p => !allIds.includes(Number(p.groupId))));
    setDirty(true);
  }

  /* ---------- flush every staged folder change to the backend ---------- */
  async function doFlush() {
    const idMap = new Map(); // tempId -> real id
    const resolve = (id) => (isTempId(id) && idMap.has(id)) ? idMap.get(id) : id;

    // 1) create brand-new groups, parents before children, so a new
    //    subgroup's parentId (possibly itself a temp id) can be resolved.
    let remaining = groups.filter(g => isTempId(g.id));
    let guard = 0;
    while (remaining.length && guard++ < 50) {
      const ready = remaining.filter(g => g.parentId == null || !isTempId(g.parentId) || idMap.has(g.parentId));
      if (!ready.length) break; // shouldn't happen, safety valve
      for (const g of ready) {
        const parentId = g.parentId == null ? null : resolve(g.parentId);
        const created = await api.createGroup(g.name, parentId);
        idMap.set(g.id, created.id);
      }
      remaining = remaining.filter(g => !idMap.has(g.id));
    }

    // 2) existing groups: rename / move as needed
    const pristineById = new Map(pristineGroupsRef.current.map(g => [g.id, g]));
    for (const g of groups) {
      if (isTempId(g.id)) continue;
      const before = pristineById.get(g.id);
      if (!before) continue;
      if (before.name !== g.name) {
        await api.renameGroup(g.id, g.name);
      }
      const newParentId = g.parentId == null ? null : resolve(g.parentId);
      if (before.parentId !== newParentId) {
        await api.moveGroup(g.id, newParentId);
      }
    }

    // 3) deleted groups — only call delete on the topmost deleted group in
    //    each removed subtree (backend cascades to subgroups + diagrams).
    const currentIds = new Set(groups.filter(g => !isTempId(g.id)).map(g => g.id));
    const deletedIds = pristineGroupsRef.current.filter(g => !currentIds.has(g.id)).map(g => g.id);
    const deletedSet = new Set(deletedIds);
    const deletedRoots = deletedIds.filter(id => {
      const g = pristineById.get(id);
      return !g.parentId || !deletedSet.has(g.parentId);
    });
    for (const gid of deletedRoots) {
      await api.deleteGroup(gid);
    }

    // 4) final sibling order — send the fully-resolved current order so
    //    display order matches exactly what was arranged locally.
    const finalOrder = groups.filter(g => !isTempId(g.id) || idMap.has(g.id)).map(g => resolve(g.id));
    await api.reorderGroups(finalOrder);

    return idMap;
  }

  async function saveAll() {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      await doFlush();
      await load();
    } catch (e) {
      setSaveError(e.message || 'Yadda saxlanmadı');
    } finally {
      setSaving(false);
    }
  }

  // Discard every staged (unsaved) folder create/rename/move/delete and go
  // back to what's actually on the server.
  function cancelAll() {
    if (!dirty || saving) return;
    if (!confirm('Yadda saxlanmamış qovluq dəyişikliklərini ləğv etmək istəyirsiniz?')) return;
    setGroups(pristineGroupsRef.current.map(g => ({ ...g })));
    setProcesses(pristineProcessesRef.current.map(p => ({ ...p })));
    setExpanded(prev => {
      const o = { ...prev };
      pristineGroupsRef.current.forEach(g => { if (!(g.id in o)) o[g.id] = false; });
      return o;
    });
    setDirty(false);
    setSaveError('');
  }

  // A brand-new (unsaved) folder only exists locally — the backend needs a
  // real id before a diagram can be created inside it. Rather than leaving
  // the "add diagram" button disabled and confusing, silently save the
  // pending folder structure first, then continue with the real id.
  async function ensureGroupSaved(gid) {
    if (!isTempId(gid)) return gid;
    setSaving(true);
    setSaveError('');
    try {
      const idMap = await doFlush();
      await load();
      return idMap.get(gid) ?? null;
    } catch (e) {
      setSaveError(e.message || 'Yadda saxlanmadı');
      return null;
    } finally {
      setSaving(false);
    }
  }

  /* ---------- diagram actions ---------- */
  async function saveDiagramCreate({ name, subtitle, groupId }) {
    setBusy(true);
    try {
      const p = await api.createProcess({
        title: name, subtitle, groupId: groupId || modal.groupId,
        width: 2200, height: 900, lanes: [], nodes: [], edges: []
      });
      setModal(null);
      await load();
      onOpen(p.id);
    } catch (e) {
      alert('Xəta: ' + e.message);
    } finally { setBusy(false); }
  }
  async function importDiagramExcel(file, { groupId } = {}) {
    const data = await importDiagramFromExcel(file);
    const p = await api.createProcess({
      title: data.title,
      subtitle: data.subtitle || '',
      groupId: groupId || modal?.groupId,
      width: data.width || 2200,
      height: data.height || 900,
      lanes: data.lanes || [],
      nodes: data.nodes || [],
      edges: data.edges || [],
      ...(data.theme ? { theme: data.theme } : {})
    });
    setModal(null);
    await load();
    onOpen(p.id);
  }
  async function importDiagramJson(file, { groupId } = {}) {
    const data = await importDiagramFromJson(file);
    const p = await api.createProcess({
      title: data.title,
      subtitle: data.subtitle || '',
      groupId: groupId || modal?.groupId,
      width: data.width || 2200,
      height: data.height || 900,
      lanes: data.lanes || [],
      nodes: data.nodes || [],
      edges: data.edges || [],
      ...(data.theme ? { theme: data.theme } : {})
    });
    setModal(null);
    await load();
    onOpen(p.id);
  }
  async function saveDiagramEdit({ name, subtitle, groupId }) {
    await api.updateProcessMeta(modal.proc.id, { title: name, subtitle, groupId });
    setModal(null);
    await load();
  }
  async function deleteProcess(e, p) {
    e.stopPropagation();
    if (!confirm(`"${p.title}" diaqramını silmək istəyirsiniz? Geri alına bilməz.`)) return;
    try {
      await api.deleteProcess(p.id);
      setProcesses(prev => prev.filter(x => x.id !== p.id));
    } catch (err) { alert('Silinə bilmədi: ' + err.message); }
  }

  /* ---------- archive (two-step: ask, then confirm) ---------- */
  function requestArchive(e, p) {
    e.stopPropagation();
    setPendingArchive(p.id);
  }
  function cancelArchive(e) {
    e.stopPropagation();
    setPendingArchive(null);
  }
  async function confirmArchive(e, p) {
    e.stopPropagation();
    try {
      await api.archiveProcess(p.id);
      setPendingArchive(null);
      await load();
      setArchiveOpen(true);
    } catch (err) { alert('Arxivə köçürülə bilmədi: ' + err.message); }
  }
  async function unarchiveProcess(e, p) {
    e.stopPropagation();
    try {
      await api.unarchiveProcess(p.id);
      await load();
    } catch (err) { alert('Bərpa edilə bilmədi: ' + err.message); }
  }
  async function deleteArchived(e, p) {
    e.stopPropagation();
    if (!confirm(`"${p.title}" diaqramını tamamilə silmək istəyirsiniz? Geri alına bilməz.`)) return;
    try {
      await api.deleteProcess(p.id);
      setArchived(prev => prev.filter(x => x.id !== p.id));
    } catch (err) { alert('Silinə bilmədi: ' + err.message); }
  }

  const q = query.trim().toLowerCase();
  function matches(p) {
    if (!q) return true;
    return (p.title || '').toLowerCase().includes(q)
      || (p.subtitle || '').toLowerCase().includes(q)
      || String(p.id).includes(q);
  }

  const noResults = !loading && !error && groups.length === 0 && processes.length === 0;

  /* ---------- recursive group render ---------- */
  function renderGroup(g, depth) {
    const fullItems = itemsOfGroup(g.id);
    const items = fullItems.filter(matches);
    const children = childGroupsOf(g.id);
    const total = fullItems.length;

    if (q && !groupHasMatchDeep(g)) return null;
    if (isViewer && !groupHasAnyItemsDeep(g)) return null;

    const isOpen = q ? true : !!expanded[g.id];
    const dndOn = !isViewer && !q;
    const folderNo = groupNumber(g);
    const isGroupOver = groupOver === g.id && groupDrag.current !== g.id;
    const draggingG = draggingGroupId != null ? groups.find(x => x.id === draggingGroupId) : null;
    const isNestTarget = isGroupOver && draggingG && normPid(draggingG) !== normPid(g);

    return (
      <div
        key={g.id}
        className={`group-card ${isOpen ? 'open' : ''} ${isNestTarget ? 'drag-nest' : (isGroupOver ? 'drag-over' : '')} ${depth > 0 ? 'nested' : ''}`}
        style={depth > 0 ? { marginLeft: 0, borderRadius: '12px' } : undefined}
        title={isNestTarget ? `"${draggingG.name}" bura köçürüləcək` : undefined}
      >
        <div
          className="group-head"
          onClick={() => toggleGroup(g.id)}
          draggable={dndOn}
          onDragStart={e => onGroupDragStart(e, g.id)}
          onDragOver={e => onGroupDragOver(e, g.id)}
          onDrop={e => onGroupDrop(e, g.id)}
          onDragEnd={onGroupDragEnd}
        >
          {dndOn && (
            <span className="order-grip group-grip" title="Sürüklə" onClick={e => e.stopPropagation()}>
              <GripVertical size={15} />
            </span>
          )}
          <span className="folder-no">{folderNo}</span>
          <span className="group-chevron">
            {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </span>
          <span className="group-folder">
            {isOpen ? <FolderOpen size={18} /> : <Folder size={18} />}
          </span>
          <span className="group-name">{g.name}</span>
          <span className="group-count">{total}</span>

          {!isViewer && (
            <span className="group-actions" onClick={e => e.stopPropagation()}>
              <button className="group-act-btn" title="Diaqram əlavə et"
                disabled={saving}
                onClick={async () => {
                  const gid = await ensureGroupSaved(g.id);
                  if (gid == null) return;
                  setModal({ type: 'diagram-create', groupId: gid });
                }}>
                <Plus size={16} />
              </button>
              <button className="group-act-btn" title="Alt qrup əlavə et"
                onClick={() => setModal({ type: 'group-create', parentId: g.id })}>
                <FolderPlus size={15} />
              </button>
              <button className="group-act-btn" title="Adı dəyiş"
                onClick={() => setModal({ type: 'group-rename', group: g })}>
                <Pencil size={15} />
              </button>
              <button className="group-act-btn danger" title="Qrupu sil"
                onClick={() => deleteGroup(g)}>
                <Trash2 size={15} />
              </button>
            </span>
          )}
        </div>

        {isOpen && (
          <div className="group-body">
            {children.length === 0 && items.length === 0 && (
              <div className="child-empty">Bu qrupda diaqram yoxdur.</div>
            )}

            {children.map(cg => renderGroup(cg, depth + 1))}

            {items.map((p) => {
              const itemNo = fullItems.indexOf(p) + 1;
              const isItemOver = itemOver && itemOver.id === p.id
                && (!itemDrag.current || itemDrag.current.id !== p.id);
              return (
                <div
                  key={p.id}
                  className={`process-item diagram-row ${isItemOver ? 'drag-over' : ''}`}
                  onClick={() => onOpen(p.id)}
                  draggable={dndOn}
                  onDragStart={e => onItemDragStart(e, g.id, p.id)}
                  onDragOver={e => onItemDragOver(e, g.id, p.id)}
                  onDrop={e => onItemDrop(e, g.id, p.id)}
                  onDragEnd={onItemDragEnd}
                >
                  {dndOn && (
                    <span className="order-grip item-grip" title="Sürüklə" onClick={e => e.stopPropagation()}>
                      <GripVertical size={14} />
                    </span>
                  )}
                  <div className="num">{folderNo}.{itemNo}</div>
                  <div className="label">
                    <span className="row-title">{p.title}</span>
                    {p.subtitle ? <span className="row-subtitle">{p.subtitle}</span> : null}
                  </div>
                  {!isViewer && (
                    <div className="row-actions" onClick={e => e.stopPropagation()}>
                      {pendingArchive === p.id ? (
                        <div className="archive-confirm">
                          <span className="archive-confirm-q"> </span>
                          <button className="action-btn confirm-yes" title="Təsdiq et"
                            onClick={(e) => confirmArchive(e, p)}>
                            <Archive size={15} /><span>Təsdiq</span>
                          </button>
                          <button className="action-btn" title="Ləğv et"
                            onClick={cancelArchive}>
                            <span>Ləğv</span>
                          </button>
                        </div>
                      ) : (
                        <>
                          <button className="action-btn" title="Redaktə et"
                            onClick={() => setModal({ type: 'diagram-edit', proc: p })}>
                            <Edit3 size={16} />
                          </button>
                          <button className="action-btn" title="Arxivə köçür"
                            onClick={(e) => requestArchive(e, p)}>
                            <Archive size={16} />
                          </button>
                          <button className="action-btn" title="Sil"
                            onClick={(e) => deleteProcess(e, p)}>
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <div className="top-left">
          {onBack && (
            <button className="pill-chip back-chip" onClick={onBack}>
              <ChevronLeft size={16} /><span>Geri</span>
            </button>
          )}
          <div className="pill-chip">{fmtTime(now)}</div>
          <div className="pill-chip">{fmtDate(now)}</div>
        </div>
        <div className="top-right">
          <div className={`topbar-search ${searchOpen ? 'open' : ''}`}>
            {searchOpen && (
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Ad və ya nömrə ilə axtar"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); } }}
              />
            )}
            <button
              className="icon-btn"
              title={searchOpen ? 'Axtarışı bağla' : 'Axtar'}
              onClick={() => setSearchOpen(v => {
                const next = !v;
                if (!next) setQuery('');
                return next;
              })}
            >
              <Search size={17} />
            </button>
          </div>
          {groups.length > 0 && (
            <button
              className="icon-btn"
              title={allOpen ? 'Hamısını bağla' : 'Hamısını aç'}
              onClick={toggleCollapseAll}
            >
              {allOpen ? <ChevronsDownUp size={17} /> : <ChevronsUpDown size={17} />}
            </button>
          )}
          {!isViewer && dirty && (
            <button
              className="icon-btn cancel-all-btn"
              title="Yadda saxlanmamış dəyişiklikləri ləğv et"
              onClick={cancelAll}
              disabled={saving}
            >
              <Undo2 size={17} />
              <span>Ləğv et</span>
            </button>
          )}
          {!isViewer && (
            <button
              className={`icon-btn save-all-btn ${dirty ? 'dirty' : ''}`}
              title={dirty ? 'Yadda saxlanmamış dəyişikliklər var' : 'Bütün dəyişikliklər saxlanılıb'}
              onClick={saveAll}
              disabled={!dirty || saving}
            >
              {saving ? <Loader2 size={17} className="spin" /> : (dirty ? <Save size={17} /> : <Check size={17} />)}
              <span>{saving ? 'Saxlanılır...' : (dirty ? 'Hamısını yadda saxla' : 'Saxlanılıb')}</span>
            </button>
          )}
          <button className="logout-btn" onClick={logout}>
            <LogOut size={16} /><span>Çıxış</span>
          </button>
        </div>
      </div>
      {saveError && (
        <div className="empty-state error" style={{ margin: '8px 24px 0' }}>
          Yadda saxlanmadı: {saveError}
        </div>
      )}
      <br />
      <div className="home-wrap">
        <LogoFull size="large" />
        <h2 className="home-title">
          {(settings?.org_title) || 'ABŞERON LOGİSTİKA MƏRKƏZİ'}<br />
          {(settings?.diagrams_page_title) || 'İş Axışları'}
          {isAdmin && settings && (
            <TitleEditButton
              heading="Başlığı dəyiş"
              nameLabel="Səhifə başlığı"
              name0={(settings?.diagrams_page_title) || 'İş Axışları'}
              onSave={({ name }) => saveSettings({ diagrams_page_title: name })}
            />
          )}
        </h2>

        <div className="process-list">
          {loading && <div className="empty-state"><Loader2 size={20} className="spin" />Yüklənir...</div>}
          {error && !loading && <div className="empty-state error">{error}</div>}
          {noResults && <div className="empty-state">Heç bir qrup yoxdur</div>}
        {!isViewer && !loading && (
            <button className="process-item create-btn" onClick={() => setModal({ type: 'group-create', parentId: null })} disabled={busy}>
              <div className="num"><FolderPlus size={20} /></div>
              <div className="label">Yeni qrup yarat</div>
            </button>
          )}

          {!isViewer && draggingGroupId != null && normPid(groups.find(g => g.id === draggingGroupId) || {}) !== null && (
            <div
              className={`root-drop-zone ${groupOver === '__root__' ? 'drag-over' : ''}`}
              onDragOver={onRootDragOver}
              onDrop={onRootDrop}
            >
              Bura burax — kök səviyyəyə (əsas siyahıya) köçür
            </div>
          )}

          {!loading && !error && childGroupsOf(null).map((g) => renderGroup(g, 0))}

          {!isViewer && !loading && !error && archived.length > 0 && (() => {
            const items = archived.filter(matches);
            if (q && items.length === 0) return null;
            const isOpen = q ? true : archiveOpen;
            return (
              <div className={`group-card archive-card ${isOpen ? 'open' : ''}`}>
                <div className="group-head" onClick={() => setArchiveOpen(v => !v)}>
                  <span className="group-chevron">
                    {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  </span>
                  <span className="group-folder"><Archive size={17} /></span>
                  <span className="group-name">Arxiv</span>
                  <span className="group-count">{archived.length}</span>
                </div>
                {isOpen && (
                  <div className="group-body">
                    {items.map((p) => (
                      <div key={p.id} className="process-item diagram-row archived-row" onClick={() => onOpen(p.id)}>
                        <div className="num"><Archive size={14} /></div>
                        <div className="label">
                          <span className="row-title">{p.title}</span>
                          {p.subtitle ? <span className="row-subtitle">{p.subtitle}</span> : null}
                        </div>
                        {!isViewer && (
                          <div className="row-actions" onClick={e => e.stopPropagation()}>
                            <button className="action-btn" title="Arxivdən çıxar"
                              onClick={(e) => unarchiveProcess(e, p)}>
                              <ArchiveRestore size={16} />
                            </button>
                            <button className="action-btn" title="Tamamilə sil"
                              onClick={(e) => deleteArchived(e, p)}>
                              <Trash2 size={16} />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {modal?.type === 'group-create' && (
        <NameModal heading={modal.parentId ? 'Yeni alt qrup' : 'Yeni qrup'} nameLabel="Qrup adı" namePlaceholder="Qrupun adı"
          saveLabel="Yarat" onClose={() => setModal(null)} onSave={saveGroupCreate} />
      )}
      {modal?.type === 'group-rename' && (
        <NameModal heading="Qrupu adlandır" nameLabel="Qrup adı" name0={modal.group.name}
          onClose={() => setModal(null)} onSave={saveGroupRename} />
      )}
      {modal?.type === 'diagram-create' && (
        <NameModal heading="Yeni diaqram" nameLabel="Diaqram adı" withSubtitle
          withGroup groups={groups.filter(g => !isTempId(g.id))} groupId0={modal.groupId}
          namePlaceholder="Əsas ad" subtitlePlaceholder="Qısa ikinci ad (məcburi deyil)"
          saveLabel="Yarat və aç"
          withImport onImport={importDiagramExcel} onImportJson={importDiagramJson} onTemplate={downloadTemplate}
          onClose={() => setModal(null)} onSave={saveDiagramCreate} />
      )}
      {modal?.type === 'diagram-edit' && (
        <NameModal heading="Diaqramı redaktə et" nameLabel="Diaqram adı" withSubtitle
          withGroup groups={groups.filter(g => !isTempId(g.id))} groupId0={modal.proc.groupId}
          name0={modal.proc.title || ''} subtitle0={modal.proc.subtitle || ''}
          onClose={() => setModal(null)} onSave={saveDiagramEdit} />
      )}
    </>
  );
}
