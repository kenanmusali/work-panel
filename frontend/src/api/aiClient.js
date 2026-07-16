// aiClient.js
// Same fetch/token conventions as api/client.js — kept separate so the AI
// feature can be dropped in or out without touching the core client.

import { getToken, setToken } from './client.js';

const API_URL = import.meta.env.VITE_API_URL || '';

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 401) {
    setToken(null);
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const msg = (data && data.error) || `Request failed: ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const aiApi = {
  // { messages:[{role,content}], context:{...} } -> { reply, ask, actions, meta }
  chat: (messages, context) => request('POST', '/api/ai/chat', { messages, context }),
  limits: () => request('GET', '/api/ai/limits')
};
