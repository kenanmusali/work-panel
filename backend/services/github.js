
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const API_BASE = 'https://api.github.com';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project root (…/backend/services -> …/)  — the real `data/` folder lives here.
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_DATA_DIR = REPO_ROOT;
const isVercel = !!(process.env.VERCEL === '1' || process.env.VERCEL_ENV || process.env.NOW_REGION);
const LOCAL_DATA_DIR = process.env.LOCAL_DATA_DIR ||
  (isVercel
    ? path.join(os.tmpdir(), 'mappanel-data')
    : REPO_ROOT);

function cfg() {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;
  return { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH };
}

function hasGithubConfig() {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = cfg();
  return !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
}

function headers() {
  const { GITHUB_TOKEN } = cfg();
  return {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

function urlFor(p) {
  const { GITHUB_OWNER, GITHUB_REPO } = cfg();
  const encodedPath = p.split('/').map(encodeURIComponent).join('/');
  return `${API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`;
}

async function localPath(p) {
  const full = path.join(LOCAL_DATA_DIR, p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  return full;
}

async function localGet(p) {
  try {
    const full = await localPath(p);
    const text = await fs.readFile(full, 'utf8');
    return {
      content: JSON.parse(text),
      sha: 'local'
    };
  } catch {
    try {
      const full = path.join(DEFAULT_DATA_DIR, p);
      const text = await fs.readFile(full, 'utf8');
      return {
        content: JSON.parse(text),
        sha: 'local'
      };
    } catch {
      return null;
    }
  }
}

async function localPut(p, contentObject) {
  const full = await localPath(p);
  await fs.writeFile(full, JSON.stringify(contentObject, null, 2));
  return { ok: true };
}

async function localDelete(p) {
  try {
    const full = await localPath(p);
    await fs.unlink(full);
    return true;
  } catch {
    return false;
  }
}

export async function getFile(p) {
  // Locally, the project `data/` folder is the source of truth.
  if (!isVercel) {
    const local = await localGet(p);
    if (local) return local;
  }

  if (!hasGithubConfig()) return localGet(p);

  try {
    const { GITHUB_BRANCH } = cfg();
    const res = await fetch(`${urlFor(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
      headers: headers()
    });

    if (res.status === 404) return localGet(p);
    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    const text = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');

    return {
      content: JSON.parse(text),
      sha: data.sha
    };
  } catch {
    return localGet(p);
  }
}

export async function putFile(p, contentObject, { message, sha } = {}) {
  // Always keep the local `data/` folder in sync
  await localPut(p, contentObject).catch(() => {});

  if (!hasGithubConfig()) return { ok: true };

  try {
    const { GITHUB_BRANCH } = cfg();

    if (sha === undefined) {
      sha = await ghGetBinarySha(p).catch(() => null);
    }

    const content = Buffer.from(
      JSON.stringify(contentObject, null, 2) + '\n',
      'utf8'
    ).toString('base64');

    const body = {
      message: message || `Update ${p}`,
      content,
      branch: GITHUB_BRANCH
    };

    if (sha && sha !== 'local') body.sha = sha;

    const res = await fetch(urlFor(p), {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(await res.text());

    return res.json();
  } catch (e) {
    console.error('[putFile] GitHub sync failed:', e.message);
    // On Vercel the local mirror lives in /tmp and is wiped between cold
    // starts, so a failed GitHub write means the edit is effectively lost —
    // pretending success here is what made writes silently vanish. Surface
    // it instead so the admin UI shows a real error.
    if (isVercel) {
      const err = new Error(`GitHub sync failed: ${e.message}`);
      err.status = 502;
      throw err;
    }
    return { ok: true, githubSynced: false };
  }
}

export async function deleteFile(p, { message } = {}) {
  // Always remove the local mirror first
  await localDelete(p);

  if (!hasGithubConfig()) return { ok: true };

  try {
    const sha = await ghGetBinarySha(p).catch(() => null);
    if (!sha) return { ok: true };

    const { GITHUB_BRANCH } = cfg();
    const res = await fetch(urlFor(p), {
      method: 'DELETE',
      headers: headers(),
      body: JSON.stringify({
        message: message || `Delete ${p}`,
        sha,
        branch: GITHUB_BRANCH
      })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } catch (e) {
    console.error('[deleteFile] GitHub sync failed:', e.message);
    if (isVercel) {
      const err = new Error(`GitHub sync failed: ${e.message}`);
      err.status = 502;
      throw err;
    }
    return { ok: true, githubSynced: false };
  }
}

/* ============================================================
   BINARY FILE HELPERS (for PDFs, images, etc.)
   Separate from the JSON helpers above so each path is clean.
   ============================================================ */

async function localGetBinary(p) {
  try {
    const full = path.join(LOCAL_DATA_DIR, p);
    return await fs.readFile(full);
  } catch {
    try {
      const full = path.join(DEFAULT_DATA_DIR, p);
      return await fs.readFile(full);
    } catch {
      return null;
    }
  }
}

async function localPutBinary(p, buffer) {
  const full = path.join(LOCAL_DATA_DIR, p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
  return { ok: true };
}

async function localDeleteBinary(p) {
  try {
    const full = path.join(LOCAL_DATA_DIR, p);
    await fs.unlink(full);
    return true;
  } catch {
    return false;
  }
}

async function ghGetBinarySha(p) {
  const { GITHUB_BRANCH } = cfg();
  const res = await fetch(`${urlFor(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
    headers: headers()
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.sha || null;
}

export async function getBinary(p) {
  if (!hasGithubConfig()) return localGetBinary(p);

  try {
    const { GITHUB_BRANCH } = cfg();
    const res = await fetch(`${urlFor(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
      headers: headers()
    });
    if (res.status === 404) return localGetBinary(p);
    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    // If file is large (>1MB) GitHub returns empty content + download_url
    if (data.content) {
      return Buffer.from(data.content.replace(/\n/g, ''), 'base64');
    }
    if (data.download_url) {
      const raw = await fetch(data.download_url, { headers: { Authorization: `Bearer ${cfg().GITHUB_TOKEN}` } });
      if (!raw.ok) throw new Error('download_url fetch failed');
      const ab = await raw.arrayBuffer();
      return Buffer.from(ab);
    }
    return null;
  } catch {
    return localGetBinary(p);
  }
}

export async function putBinary(p, buffer, { message } = {}) {
  // Always mirror to local store too — keeps things working offline / on token error
  await localPutBinary(p, buffer);

  if (!hasGithubConfig()) return { ok: true };

  try {
    const { GITHUB_BRANCH } = cfg();
    const sha = await ghGetBinarySha(p).catch(() => null);
    const body = {
      message: message || `Update ${p}`,
      content: buffer.toString('base64'),
      branch: GITHUB_BRANCH
    };
    if (sha) body.sha = sha;

    const res = await fetch(urlFor(p), {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } catch (e) {
    console.error('[putBinary] GitHub sync failed:', e.message);
    if (isVercel) {
      const err = new Error(`GitHub sync failed: ${e.message}`);
      err.status = 502;
      throw err;
    }
    return { ok: true, githubSynced: false };
  }
}

export async function deleteBinary(p, { message } = {}) {
  await localDeleteBinary(p);

  if (!hasGithubConfig()) return { ok: true };

  try {
    const sha = await ghGetBinarySha(p);
    if (!sha) return { ok: true };

    const { GITHUB_BRANCH } = cfg();
    const res = await fetch(urlFor(p), {
      method: 'DELETE',
      headers: headers(),
      body: JSON.stringify({
        message: message || `Delete ${p}`,
        sha,
        branch: GITHUB_BRANCH
      })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } catch (e) {
    console.error('[deleteBinary] GitHub sync failed:', e.message);
    if (isVercel) {
      const err = new Error(`GitHub sync failed: ${e.message}`);
      err.status = 502;
      throw err;
    }
    return { ok: true, githubSynced: false };
  }
}

/* ============================================================
   DIAGNOSTICS — safe to expose (no token, no secrets)
   ============================================================ */
export async function diagnose() {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = cfg();
  const out = {
    isVercel,
    githubConfigured: hasGithubConfig(),
    owner: GITHUB_OWNER || null,
    repo: GITHUB_REPO || null,
    branch: GITHUB_BRANCH || null
  };

  // Probe GitHub directly (surfaces the real HTTP status: 200 ok, 401 bad token, 404 wrong path/branch)
  if (hasGithubConfig()) {
    for (const p of ['data/diagrams/index.json', 'data/files/index.json']) {
      try {
        const res = await fetch(`${urlFor(p)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: headers() });
        out[p] = { githubStatus: res.status };
      } catch (e) {
        out[p] = { githubError: e.message };
      }
    }
  }

  // What the app actually resolves (after local + GitHub fallback)
  try {
    const d = await getFile('data/diagrams/index.json');
    out.diagramsResolved = d ? (d.content?.processes?.length ?? 0) : 'NOT FOUND';
  } catch (e) { out.diagramsResolved = 'ERR: ' + e.message; }
  try {
    const f = await getFile('data/files/index.json');
    out.pdfsResolved = f ? (f.content?.pdfs?.length ?? 0) : 'NOT FOUND';
  } catch (e) { out.pdfsResolved = 'ERR: ' + e.message; }

  // Read access alone isn't enough — a token can list/read a repo's contents
  // while still lacking write permission, which is exactly the failure mode
  // that made admin edits silently vanish. Actually attempt a write+delete
  // against a throwaway path so this shows up here instead of only failing
  // invisibly the next time someone edits something.
  if (hasGithubConfig()) {
    const probePath = 'data/.write-probe.json';
    try {
      const { GITHUB_BRANCH } = cfg();
      const putRes = await fetch(urlFor(probePath), {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({
          message: 'diagnostic write probe (auto-deleted)',
          content: Buffer.from(JSON.stringify({ probe: true, ts: Date.now() })).toString('base64'),
          branch: GITHUB_BRANCH
        })
      });
      if (!putRes.ok) {
        out.githubWriteAccess = { ok: false, status: putRes.status, error: await putRes.text() };
      } else {
        const putData = await putRes.json();
        out.githubWriteAccess = { ok: true };
        // clean up immediately
        await fetch(urlFor(probePath), {
          method: 'DELETE',
          headers: headers(),
          body: JSON.stringify({ message: 'cleanup write probe', sha: putData.content.sha, branch: GITHUB_BRANCH })
        }).catch(() => {});
      }
    } catch (e) {
      out.githubWriteAccess = { ok: false, error: e.message };
    }
  }

  return out;
}
