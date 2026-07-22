/*
  MongoDB-backed JSON store for DIAGRAM data.

  Exposes the exact same JSON interface as the JSON side of services/github.js
  (getFile / putFile / deleteFile / attribution), so routes swap a single import
  line and nothing else changes.

  Why: every diagram save used to be a GitHub Contents-API commit = a git push =
  a Vercel redeploy. Frequent edits burned through Vercel's deployment rate
  limit. Diagram documents are light JSON, so they move to MongoDB — writes hit
  the DB at runtime, no commit, no redeploy. PDFs (heavy binaries) stay on
  services/github.js so they keep living in the repo and deploy the normal way.

  Keys are the same path strings used before (e.g. "data/diagrams/index.json",
  "data/diagrams/processes/process-3.json"); we store them as the Mongo _id, so
  the layout maps 1:1 to the old data/ folder.
*/

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// …/backend/services -> project root, where the local data/ folder lives.
const REPO_ROOT = path.resolve(__dirname, '../..');

const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGODB_DB || 'mappanel';
const COLLECTION = process.env.MONGODB_COLLECTION || 'diagrams';

const isVercel = !!(process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.NOW_REGION);

function hasMongo() {
  return !!MONGODB_URI;
}

/* ---------- connection (cached across warm serverless invocations) ---------- */
// Vercel keeps the module warm between requests, so we cache the connect()
// promise on globalThis and reuse it instead of opening a socket per request.
async function collection() {
  if (!globalThis.__mpMongo) {
    const client = new MongoClient(MONGODB_URI, { maxPoolSize: 5 });
    globalThis.__mpMongo = client.connect();
  }
  const client = await globalThis.__mpMongo;
  return client.db(DB_NAME).collection(COLLECTION);
}

/* ---------- local fallback (same behaviour as github.js when unconfigured) --- */
async function localGet(p) {
  try {
    const text = await fs.readFile(path.join(REPO_ROOT, p), 'utf8');
    return { content: JSON.parse(text), sha: 'local' };
  } catch {
    return null;
  }
}
async function localPut(p, obj) {
  const full = path.join(REPO_ROOT, p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(obj, null, 2));
  return { ok: true };
}
async function localDelete(p) {
  try {
    await fs.unlink(path.join(REPO_ROOT, p));
    return true;
  } catch {
    return false;
  }
}

// Kept identical to github.js so the diagrams route imports it from one place.
// The store ignores author/commit metadata; it's harmless to still build it.
export function attribution(user, message) {
  const username = user?.username;
  if (!username) return { message };
  return {
    message: `${message} (by ${username})`,
    author: { name: username, email: `${username}@map-panel.local` }
  };
}

/* =============================== JSON INTERFACE =============================== */

export async function getFile(p) {
  if (!hasMongo()) return localGet(p);
  try {
    const col = await collection();
    const doc = await col.findOne({ _id: p });
    if (!doc) return null;
    return { content: doc.content, sha: 'mongo' };
  } catch (e) {
    console.error('[store.getFile] mongo read failed:', e.message);
    return localGet(p);
  }
}

export async function putFile(p, contentObject /* , { message, sha, author } — ignored */) {
  // No Mongo configured. Locally that's fine (write to data/). On Vercel /tmp is
  // wiped between cold starts, so a "local" write would silently vanish — the
  // exact silent-loss failure mode to avoid. Fail loud instead.
  if (!hasMongo()) {
    if (isVercel) {
      const err = new Error('MONGODB_URI is not set — diagram write would be lost');
      err.status = 500;
      throw err;
    }
    return localPut(p, contentObject);
  }
  try {
    const col = await collection();
    await col.updateOne(
      { _id: p },
      { $set: { content: contentObject, updatedAt: new Date() } },
      { upsert: true }
    );
    return { ok: true };
  } catch (e) {
    console.error('[store.putFile] mongo write failed:', e.message);
    const err = new Error(`Mongo write failed: ${e.message}`);
    err.status = 502;
    throw err;
  }
}

export async function deleteFile(p /* , { message, author } — ignored */) {
  if (!hasMongo()) {
    if (isVercel) return { ok: true }; // nothing persistent to remove
    await localDelete(p);
    return { ok: true };
  }
  try {
    const col = await collection();
    await col.deleteOne({ _id: p });
    return { ok: true };
  } catch (e) {
    console.error('[store.deleteFile] mongo delete failed:', e.message);
    const err = new Error(`Mongo delete failed: ${e.message}`);
    err.status = 502;
    throw err;
  }
}
