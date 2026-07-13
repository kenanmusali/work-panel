// rt.js — Real-time layer for presence, edit-locks and analytics.
//
// Two interchangeable backends, chosen automatically at runtime:
//   1. Redis (Vercel KV or Upstash) — used when the REST env vars are present.
//      Gives true low-latency presence / locking / live sync. RECOMMENDED.
//      In Vercel: add the free "KV" storage → it injects KV_REST_API_URL +
//      KV_REST_API_TOKEN automatically. Nothing else to configure.
//   2. GitHub-JSON fallback — used when no Redis is configured. Works out of
//      the box on the current stack, but is "near-live" (poll latency) and
//      best-effort under heavy concurrency. Fine for a small team.
//
// Higher-level helpers (presence*, lock*, logEvent, readEvents) are backend
// agnostic — routes never care which store is live.

import { getFile, putFile, deleteFile, listDir } from './github.js';

/* ---------------------------------------------------------------- config */
const PRESENCE_TTL = 25;   // seconds a heartbeat stays "online"
const LOCK_TTL     = 30;   // seconds an edit-lock stays valid without refresh
const EVENT_CAP    = 4000; // max analytics events kept per tenant (fallback)

const REDIS_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  '';
const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  '';

export function rtBackend() {
  return REDIS_URL && REDIS_TOKEN ? 'redis' : 'github-json';
}
const useRedis = () => !!(REDIS_URL && REDIS_TOKEN);

/* ---------------------------------------------------------------- redis */
// Minimal Upstash/Vercel-KV REST client (no extra npm dependency).
async function redis(cmd) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error(`redis ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.result;
}

/* ------------------------------------------------ github-json fallback */
const RT_DIR = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '') + '/rt';
const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
// Each hash lives as a DIRECTORY, one file per field. This is the key fix:
// two admins locking the same/different diagrams (or many users beating
// presence) each touch their OWN file, so there is no shared-file write
// conflict that could silently drop a lock.
const hashDir = (key) => `${RT_DIR()}/h_${safe(key)}`;
const fieldFile = (key, field) => `${hashDir(key)}/${safe(field)}.json`;
const listFile = (key) => `${RT_DIR()}/list__${safe(key)}.json`;

async function ghReadArr(path) {
  const f = await getFile(path).catch(() => null);
  return f && Array.isArray(f.content?.items) ? f.content.items : [];
}

/* ------------------------------------------------------- primitives */
// hash: field -> {value, exp}   (exp = unix seconds or 0 for none)
async function hset(key, field, value, ttl) {
  const str = JSON.stringify(value);
  if (useRedis()) {
    await redis(['HSET', key, field, str]);
    if (ttl) await redis(['EXPIRE', key, String(ttl)]);
    return;
  }
  // fallback: this field is its own file
  await putFile(fieldFile(key, field), { v: str, exp: ttl ? nowSec() + ttl : 0 }, { message: `rt ${safe(field)}` }).catch(() => {});
}

async function hgetall(key) {
  if (useRedis()) {
    const flat = await redis(['HGETALL', key]);
    const out = {};
    if (Array.isArray(flat)) {
      for (let i = 0; i < flat.length; i += 2) {
        try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch { /* skip */ }
      }
    }
    return out;
  }
  const files = await listDir(hashDir(key)).catch(() => []);
  const out = {};
  const t = nowSec();
  await Promise.all(files.filter(n => n.endsWith('.json')).map(async (name) => {
    const cell = await getFile(`${hashDir(key)}/${name}`).catch(() => null);
    const c = cell?.content;
    if (!c) return;
    if (c.exp && c.exp < t) return; // expired
    const field = name.replace(/\.json$/, '');
    try { out[field] = JSON.parse(c.v); } catch { /* skip */ }
  }));
  return out;
}

async function hget(key, field) {
  if (useRedis()) {
    const v = await redis(['HGET', key, field]);
    try { return v ? JSON.parse(v) : null; } catch { return null; }
  }
  const cell = await getFile(fieldFile(key, field)).catch(() => null);
  const c = cell?.content;
  if (!c) return null;
  if (c.exp && c.exp < nowSec()) return null;
  try { return JSON.parse(c.v); } catch { return null; }
}

async function hdel(key, field) {
  if (useRedis()) { await redis(['HDEL', key, field]); return; }
  await deleteFile(fieldFile(key, field)).catch(() => {});
}

async function listPush(key, value, cap) {
  if (useRedis()) {
    await redis(['LPUSH', key, JSON.stringify(value)]);
    if (cap) await redis(['LTRIM', key, '0', String(cap - 1)]);
    return;
  }
  const path = listFile(key);
  const arr = await ghReadArr(path);
  arr.unshift(value);
  const capped = cap ? arr.slice(0, cap) : arr;
  await putFile(path, { items: capped }, { message: `rt push ${key}` }).catch(() => {});
}

async function listRange(key, start, stop) {
  if (useRedis()) {
    const arr = await redis(['LRANGE', key, String(start), String(stop)]);
    return (Array.isArray(arr) ? arr : []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  }
  const arr = await ghReadArr(listFile(key));
  return arr.slice(start, stop === -1 ? undefined : stop + 1);
}

const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------- PRESENCE */
const presKey = (tenantId) => `rt:presence:${tenantId}`;

export async function presenceBeat(tenantId, username, data) {
  await hset(presKey(tenantId), username, { ...data, username, ts: Date.now() }, PRESENCE_TTL);
}

export async function presenceLeave(tenantId, username) {
  await hdel(presKey(tenantId), username);
}

export async function presenceList(tenantId) {
  const all = await hgetall(presKey(tenantId));
  const cutoff = Date.now() - PRESENCE_TTL * 1000;
  return Object.values(all)
    .filter(p => p && p.ts >= cutoff)
    .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
}

// Global presence across every tenant (super admin live view).
export async function presenceListAll(tenantIds) {
  const lists = await Promise.all((tenantIds || []).map(t => presenceList(t).catch(() => [])));
  const out = [];
  tenantIds.forEach((t, i) => lists[i].forEach(p => out.push({ ...p, tenantId: t })));
  return out;
}

/* ------------------------------------------------------- EDIT LOCKS */
const lockKey = (tenantId) => `rt:locks:${tenantId}`;

export async function lockStatus(tenantId, diagramId) {
  const l = await hget(lockKey(tenantId), String(diagramId));
  if (!l) return null;
  if (Date.now() - l.ts > LOCK_TTL * 1000) return null; // stale
  return l;
}

// Try to take/refresh the lock. Returns { ok, lock, byOther }.
export async function lockAcquire(tenantId, diagramId, username, role) {
  const current = await lockStatus(tenantId, diagramId);
  if (current && current.owner !== username) {
    return { ok: false, byOther: true, lock: current };
  }
  const lock = { diagramId: String(diagramId), owner: username, ownerRole: role, ts: Date.now() };
  await hset(lockKey(tenantId), String(diagramId), lock, LOCK_TTL);
  // Write-then-verify: if two admins raced, the store serialises writes and one
  // value wins. Re-read so the loser yields instead of both thinking they won.
  const after = await lockStatus(tenantId, diagramId);
  if (after && after.owner !== username) {
    return { ok: false, byOther: true, lock: after };
  }
  return { ok: true, byOther: false, lock: after || lock };
}

export async function lockRelease(tenantId, diagramId, username) {
  const current = await lockStatus(tenantId, diagramId);
  if (current && current.owner !== username) return { ok: false, byOther: true, lock: current };
  await hdel(lockKey(tenantId), String(diagramId));
  return { ok: true };
}

export async function lockList(tenantId) {
  const all = await hgetall(lockKey(tenantId));
  const t = Date.now();
  return Object.values(all).filter(l => l && t - l.ts <= LOCK_TTL * 1000);
}

/* ------------------------------------------------------- REVISIONS */
// A monotonically-increasing marker per diagram so viewers can detect that
// another editor saved and live-refresh.
const revKey = (tenantId) => `rt:rev:${tenantId}`;

export async function bumpRev(tenantId, diagramId) {
  const rev = Date.now();
  await hset(revKey(tenantId), String(diagramId), { rev }, 0);
  return rev;
}
export async function getRev(tenantId, diagramId) {
  const r = await hget(revKey(tenantId), String(diagramId));
  return r?.rev || 0;
}
export async function getAllRevs(tenantId) {
  const all = await hgetall(revKey(tenantId));
  const out = {};
  for (const [k, v] of Object.entries(all)) out[k] = v.rev || 0;
  return out;
}

/* ------------------------------------------------------- ANALYTICS */
const evKey = (tenantId) => `rt:events:${tenantId}`;
let _evSeq = 0;

export async function logEvent(tenantId, ev) {
  const entry = {
    id: `${Date.now().toString(36)}-${(_evSeq++).toString(36)}`,
    ts: Date.now(),
    tenantId,
    ...ev
  };
  await listPush(evKey(tenantId), entry, EVENT_CAP).catch(() => {});
  return entry;
}

export async function readEvents(tenantId, { limit = 500 } = {}) {
  return listRange(evKey(tenantId), 0, limit - 1);
}

export async function readEventsMany(tenantIds, { limit = 500 } = {}) {
  const lists = await Promise.all((tenantIds || []).map(t => readEvents(t, { limit }).catch(() => [])));
  const merged = [].concat(...lists).sort((a, b) => b.ts - a.ts);
  return merged.slice(0, limit);
}
