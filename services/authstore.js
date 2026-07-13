// authstore.js — departments ("groups") + users, persisted as JSON.
// Passwords are bcrypt-hashed. Seeds itself on first run so existing logins
// (admin/admin123, user/user123) keep working and a super admin exists.

import bcrypt from 'bcryptjs';
import { getFile, putFile } from './github.js';
import { DEFAULT_TENANT } from './tenancy.js';

const DIR = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '') + '/auth';
const DEPTS_PATH = () => `${DIR()}/departments.json`;
const USERS_PATH = () => `${DIR()}/users.json`;

export const ROLES = ['superadmin', 'admin', 'viewer'];

/* ------------------------------------------------------------- seeding */
function seedDepartments() {
  return { items: [{ id: DEFAULT_TENANT, name: 'Baş ofis', createdAt: new Date().toISOString() }] };
}
function seedUsers() {
  const h = (p) => bcrypt.hashSync(p, 8);
  const now = new Date().toISOString();
  return {
    items: [
      { username: 'superadmin', displayName: 'Super Admin', passwordHash: h('super123'), role: 'superadmin', tenantId: null, disabled: false, createdAt: now, createdBy: 'system' },
      { username: 'admin', displayName: 'Admin', passwordHash: h('admin123'), role: 'admin', tenantId: DEFAULT_TENANT, disabled: false, createdAt: now, createdBy: 'system' },
      { username: 'user', displayName: 'İstifadəçi', passwordHash: h('user123'), role: 'viewer', tenantId: DEFAULT_TENANT, disabled: false, createdAt: now, createdBy: 'system' }
    ]
  };
}

async function loadDepartments() {
  const f = await getFile(DEPTS_PATH()).catch(() => null);
  if (f && Array.isArray(f.content?.items) && f.content.items.length) return f.content;
  const seeded = seedDepartments();
  await putFile(DEPTS_PATH(), seeded, { message: 'Seed departments' }).catch(() => {});
  return seeded;
}
async function saveDepartments(content) {
  await putFile(DEPTS_PATH(), content, { message: 'Update departments' });
}

async function loadUsers() {
  const f = await getFile(USERS_PATH()).catch(() => null);
  if (f && Array.isArray(f.content?.items) && f.content.items.length) return f.content;
  const seeded = seedUsers();
  await putFile(USERS_PATH(), seeded, { message: 'Seed users' }).catch(() => {});
  return seeded;
}
async function saveUsers(content) {
  await putFile(USERS_PATH(), content, { message: 'Update users' });
}

const publicUser = (u) => ({
  username: u.username,
  displayName: u.displayName || u.username,
  role: u.role,
  tenantId: u.tenantId,
  disabled: !!u.disabled,
  createdAt: u.createdAt,
  createdBy: u.createdBy
});

/* --------------------------------------------------------- departments */
export async function listDepartments() {
  const d = await loadDepartments();
  return d.items;
}

export async function createDepartment(name) {
  const clean = String(name || '').trim();
  if (!clean) throw httpErr(400, 'Şöbə adı tələb olunur');
  const d = await loadDepartments();
  const id = 'd' + Date.now().toString(36);
  const dept = { id, name: clean, createdAt: new Date().toISOString() };
  d.items = [...d.items, dept];
  await saveDepartments(d);
  return dept;
}

export async function renameDepartment(id, name) {
  const clean = String(name || '').trim();
  if (!clean) throw httpErr(400, 'Şöbə adı tələb olunur');
  const d = await loadDepartments();
  const dep = d.items.find(x => x.id === id);
  if (!dep) throw httpErr(404, 'Şöbə tapılmadı');
  dep.name = clean;
  await saveDepartments(d);
  return dep;
}

export async function deleteDepartment(id) {
  if (id === DEFAULT_TENANT) throw httpErr(400, 'Baş ofis silinə bilməz');
  const d = await loadDepartments();
  d.items = d.items.filter(x => x.id !== id);
  await saveDepartments(d);
  // remove that department's users too
  const u = await loadUsers();
  const before = u.items.length;
  u.items = u.items.filter(x => x.tenantId !== id);
  if (u.items.length !== before) await saveUsers(u);
  return { ok: true };
}

/* --------------------------------------------------------------- users */
export async function listUsers(tenantId) {
  const u = await loadUsers();
  const items = tenantId ? u.items.filter(x => x.tenantId === tenantId) : u.items;
  return items.map(publicUser);
}

export async function findUserRaw(username) {
  const u = await loadUsers();
  return u.items.find(x => x.username.toLowerCase() === String(username || '').toLowerCase()) || null;
}

export async function createUser({ username, password, role, tenantId, displayName, createdBy }) {
  const uname = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(uname)) throw httpErr(400, 'İstifadəçi adı 3-32 simvol (hərf/rəqəm) olmalıdır');
  if (!password || String(password).length < 4) throw httpErr(400, 'Şifrə ən az 4 simvol olmalıdır');
  if (!['admin', 'viewer'].includes(role)) throw httpErr(400, 'Yanlış rol');
  const u = await loadUsers();
  if (u.items.some(x => x.username.toLowerCase() === uname.toLowerCase())) throw httpErr(409, 'Bu istifadəçi adı artıq mövcuddur');

  const depts = await listDepartments();
  if (!depts.some(dp => dp.id === tenantId)) throw httpErr(400, 'Şöbə tapılmadı');

  const user = {
    username: uname,
    displayName: String(displayName || '').trim() || uname,
    passwordHash: bcrypt.hashSync(String(password), 8),
    role,
    tenantId,
    disabled: false,
    createdAt: new Date().toISOString(),
    createdBy: createdBy || 'superadmin'
  };
  u.items = [...u.items, user];
  await saveUsers(u);
  return publicUser(user);
}

export async function updateUser(username, patch) {
  const u = await loadUsers();
  const user = u.items.find(x => x.username.toLowerCase() === String(username).toLowerCase());
  if (!user) throw httpErr(404, 'İstifadəçi tapılmadı');
  if (user.role === 'superadmin' && (patch.role || patch.tenantId !== undefined)) {
    throw httpErr(400, 'Super admin rolu/şöbəsi dəyişdirilə bilməz');
  }
  if (typeof patch.displayName === 'string') user.displayName = patch.displayName.trim() || user.username;
  if (patch.role && ['admin', 'viewer'].includes(patch.role)) user.role = patch.role;
  if (patch.tenantId !== undefined) {
    const depts = await listDepartments();
    if (!depts.some(dp => dp.id === patch.tenantId)) throw httpErr(400, 'Şöbə tapılmadı');
    user.tenantId = patch.tenantId;
  }
  if (typeof patch.disabled === 'boolean') user.disabled = patch.disabled;
  if (patch.password) {
    if (String(patch.password).length < 4) throw httpErr(400, 'Şifrə ən az 4 simvol olmalıdır');
    user.passwordHash = bcrypt.hashSync(String(patch.password), 8);
  }
  await saveUsers(u);
  return publicUser(user);
}

export async function deleteUser(username) {
  const u = await loadUsers();
  const user = u.items.find(x => x.username.toLowerCase() === String(username).toLowerCase());
  if (!user) throw httpErr(404, 'İstifadəçi tapılmadı');
  if (user.role === 'superadmin') {
    const supers = u.items.filter(x => x.role === 'superadmin');
    if (supers.length <= 1) throw httpErr(400, 'Sonuncu super admin silinə bilməz');
  }
  u.items = u.items.filter(x => x !== user);
  await saveUsers(u);
  return { ok: true };
}

export async function verifyLogin(username, password) {
  const user = await findUserRaw(username);
  if (!user || user.disabled) return null;
  const ok = bcrypt.compareSync(String(password || ''), user.passwordHash || '');
  return ok ? user : null;
}

/* --------------------------------------------------------------- utils */
function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
