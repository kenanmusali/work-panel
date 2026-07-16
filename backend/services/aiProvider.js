// aiProvider.js
// Thin adapter over the FREE LLM APIs.
// Provider is picked automatically from whichever key is present in the env:
//   GEMINI_API_KEY      -> Google AI Studio (default, best free tier)
//   GROQ_API_KEY        -> Groq
//   OPENROUTER_API_KEY  -> OpenRouter (:free models)

const PROVIDERS = {
  gemini: {
    label: 'Google Gemini (AI Studio)',
    envKey: 'GEMINI_API_KEY',
    // gemini-1.5-flash is the current stable free-tier model.
    defaultModel: 'gemini-1.5-flash',
    limits: { rpm: 15, rpd: 1500, tpm: 1000000 },
    docs: 'https://ai.google.dev/gemini-api/docs/rate-limits'
  },
  groq: {
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    limits: { rpm: 30, rpd: 1000, tpm: 12000 },
    docs: 'https://console.groq.com/docs/rate-limits'
  },
  openrouter: {
    label: 'OpenRouter (free models)',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    limits: { rpm: 20, rpd: 50, tpm: null },
    docs: 'https://openrouter.ai/docs/api-reference/limits'
  }
};

export function pickProvider() {
  const forced = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (forced && PROVIDERS[forced]) return forced;
  for (const name of ['gemini', 'groq', 'openrouter']) {
    if (process.env[PROVIDERS[name].envKey]) return name;
  }
  return null;
}

export function providerInfo(name) {
  const p = PROVIDERS[name];
  if (!p) return null;
  // Clean the model name from ENV or use default
  const rawModel = process.env.AI_MODEL || p.defaultModel;
  const modelName = rawModel.trim();
  
  return {
    name,
    label: p.label,
    model: modelName,
    limits: p.limits,
    docs: p.docs
  };
}

export function allProviders() {
  return Object.keys(PROVIDERS).map(name => ({
    ...providerInfo(name),
    configured: !!process.env[PROVIDERS[name].envKey]
  }));
}

/* ------------------------------------------------------------------ *
 * Usage counters
 * ------------------------------------------------------------------ */
const usage = {
  day: new Date().toISOString().slice(0, 10),
  requests: 0,
  minuteBucket: 0,
  minuteCount: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: 0,
  lastAt: null,
  startedAt: Date.now()
};

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) {
    usage.day = today;
    usage.requests = 0;
    usage.tokensIn = 0;
    usage.tokensOut = 0;
    usage.errors = 0;
  }
}

function noteRequest() {
  rollDay();
  const bucket = Math.floor(Date.now() / 60000);
  if (usage.minuteBucket !== bucket) {
    usage.minuteBucket = bucket;
    usage.minuteCount = 0;
  }
  usage.minuteCount += 1;
  usage.requests += 1;
  usage.lastAt = Date.now();
}

export function getUsage() {
  rollDay();
  const bucket = Math.floor(Date.now() / 60000);
  return {
    day: usage.day,
    requestsToday: usage.requests,
    requestsThisMinute: usage.minuteBucket === bucket ? usage.minuteCount : 0,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    errors: usage.errors,
    lastAt: usage.lastAt,
    instanceStartedAt: usage.startedAt
  };
}

function guardLocalLimits(info) {
  const u = getUsage();
  if (info.limits.rpd && u.requestsToday >= info.limits.rpd) {
    const e = new Error(`Daily limit reached.`);
    e.status = 429;
    throw e;
  }
  if (info.limits.rpm && u.requestsThisMinute >= info.limits.rpm) {
    const e = new Error(`Minute limit reached.`);
    e.status = 429;
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * API Calls
 * ------------------------------------------------------------------ */

async function callGemini({ system, messages, model, apiKey }) {
  // We MUST use v1beta for 'systemInstruction' and 'responseMimeType' to work
  const cleanKey = apiKey.trim();
  const cleanModel = model.trim();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent?key=${cleanKey}`;
  
  const body = {
    // systemInstruction is supported in v1beta
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
      // responseMimeType is supported in v1beta
      responseMimeType: 'application/json'
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    // If it still says "Model not found", it's usually a regional issue or typo
    const msg = data?.error?.message || `Gemini Error ${res.status}`;
    throw new Error(msg);
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '').join('');

  return {
    text,
    tokensIn: data?.usageMetadata?.promptTokenCount || 0,
    tokensOut: data?.usageMetadata?.candidatesTokenCount || 0
  };
}

async function callOpenAICompatible({ system, messages, model, apiKey, baseUrl, extraHeaders }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey.trim()}`,
      ...(extraHeaders || {})
    },
    body: JSON.stringify({
      model: model.trim(),
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `${baseUrl} error: ${res.status}`);
  }

  return {
    text: data?.choices?.[0]?.message?.content || '',
    tokensIn: data?.usage?.prompt_tokens || 0,
    tokensOut: data?.usage?.completion_tokens || 0
  };
}

export async function askLLM({ system, messages }) {
  const name = pickProvider();
  if (!name) {
    const e = new Error('AI Key not set.');
    e.status = 503;
    throw e;
  }

  const info = providerInfo(name);
  const apiKey = process.env[PROVIDERS[name].envKey];

  guardLocalLimits(info);
  noteRequest();

  try {
    let out;
    if (name === 'gemini') {
      out = await callGemini({ system, messages, model: info.model, apiKey });
    } else if (name === 'groq') {
      out = await callOpenAICompatible({
        system, messages, model: info.model, apiKey,
        baseUrl: 'https://api.groq.com/openai/v1'
      });
    } else {
      out = await callOpenAICompatible({
        system, messages, model: info.model, apiKey,
        baseUrl: 'https://openrouter.ai/api/v1',
        extraHeaders: {
          'HTTP-Referer': process.env.CORS_ORIGIN || 'https://maps-panel.vercel.app',
          'X-Title': 'Map-Panel'
        }
      });
    }

    usage.tokensIn += out.tokensIn || 0;
    usage.tokensOut += out.tokensOut || 0;
    return { ...out, provider: name, model: info.model };
  } catch (e) {
    usage.errors += 1;
    throw e;
  }
}