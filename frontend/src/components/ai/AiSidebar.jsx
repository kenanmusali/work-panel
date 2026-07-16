// AiSidebar.jsx
// The chatbot panel that slides in from the right. It is deliberately dumb
// about the app: the parent (Home / Diagram) supplies a live `context`
// snapshot and a `runActions` executor, so the same panel works on both
// screens without knowing how either of them stores state.

import { useState, useEffect, useRef } from 'react';
import { X, Loader2, AlertCircle, Trash2 } from '../icons.jsx';
import { Sparkles, SendHorizonal, Gauge } from 'lucide-react';
import { aiApi } from '../../api/aiClient.js';
import AiActionPopup from './AiActionPopup.jsx';

const HELLO = {
  role: 'assistant',
  content: 'Salam! ALM-AI köməkçisiyəm. Diaqramlar qurmağa, node-lar yaratmağa və layihələrinizi təşkil etməyə kömək edirəm. Nə etmək istəyirsiniz?'
};

export default function AiSidebar({ open, onClose, context, runActions, suggestions = [] }) {
  const [messages, setMessages] = useState([HELLO]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [limits, setLimits] = useState(null);
  const [showLimits, setShowLimits] = useState(false);
  const [pending, setPending] = useState(null);   // actions awaiting the popup
  const [ctxSnapshot, setCtxSnapshot] = useState(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    aiApi.limits().then(setLimits).catch(() => setLimits(null));
    setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, open]);

  async function send(text) {
    const content = String(text ?? input).trim();
    if (!content || busy) return;
    setInput('');
    setError('');
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setBusy(true);
    try {
      // The context is rebuilt on every turn so the model always sees the
      // current ids — stale ids are the #1 way this kind of thing goes wrong.
      const ctx = context();
      const res = await aiApi.chat(
        next.filter(m => m !== HELLO).map(m => ({ role: m.role, content: m.content })),
        ctx
      );

      const reply = {
        role: 'assistant',
        content: res.reply || (res.actions?.length ? 'Aşağıdakı əməliyyatları təklif edirəm.' : '...'),
        ask: res.ask || null,
        actionCount: res.actions?.length || 0
      };
      setMessages(m => [...m, reply]);
      if (res.meta?.usage) {
        setLimits(l => (l ? { ...l, usage: res.meta.usage } : l));
      }
      if (res.actions?.length) {
        setCtxSnapshot(ctx);
        setPending(res.actions);
      }
    } catch (e) {
      setError(e.message || 'AI cavab vermədi');
    } finally {
      setBusy(false);
    }
  }

  async function confirmActions(actions) {
    setPending(null);
    setBusy(true);
    try {
      const results = await runActions(actions);
      const lines = (Array.isArray(results) ? results : [results]).filter(Boolean);
      setMessages(m => [...m, {
        role: 'system',
        content: lines.length ? lines.join('\n') : 'Əməliyyat tamamlandı.'
      }]);
    } catch (e) {
      setMessages(m => [...m, { role: 'system', error: true, content: 'Xəta: ' + (e.message || e) }]);
    } finally {
      setBusy(false);
    }
  }

  function clearChat() {
    setMessages([HELLO]);
    setError('');
    setPending(null);
  }

  if (!open) return null;

  const u = limits?.usage;
  const lim = limits?.active?.limits;

  return (
    <>
      <div className="ai-sidebar">
        <div className="ai-head">
          <span className="ai-head-icon"><Sparkles size={16} /></span>
          <div className="ai-head-text">
            <strong>ALM-AI (Beta)</strong>
            <span>{limits?.active ? limits.active.model : 'konfiqurasiya edilməyib'}</span>
          </div>
          <button className="ai-icon-btn" title="Limitlər" onClick={() => setShowLimits(v => !v)}>
            <Gauge size={16} />
          </button>
          <button className="ai-icon-btn" title="Söhbəti təmizlə" onClick={clearChat}>
            <Trash2 size={15} />
          </button>
          <button className="ai-icon-btn" title="Bağla" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {showLimits && (
          <div className="ai-limits">
            {!limits?.enabled ? (
              <div className="ai-limits-off">
                <AlertCircle size={14} />
                <span>AI açarı yoxdur. Vercel-də <code>GEMINI_API_KEY</code> əlavə edin.</span>
              </div>
            ) : (
              <>
                <div className="ai-limits-title">{limits.active.label}</div>
                <div className="ai-limit-row">
                  <span>Dəqiqədə</span>
                  <span>{u?.requestsThisMinute ?? 0} / {lim?.rpm ?? '—'}</span>
                </div>
                <div className="ai-limit-bar">
                  <i style={{ width: `${pct(u?.requestsThisMinute, lim?.rpm)}%` }} />
                </div>
                <div className="ai-limit-row">
                  <span>Gündə</span>
                  <span>{u?.requestsToday ?? 0} / {lim?.rpd ?? '—'}</span>
                </div>
                <div className="ai-limit-bar">
                  <i style={{ width: `${pct(u?.requestsToday, lim?.rpd)}%` }} />
                </div>
                <div className="ai-limit-row">
                  <span>Token (giriş / çıxış)</span>
                  <span>{u?.tokensIn ?? 0} / {u?.tokensOut ?? 0}</span>
                </div>
                {lim?.tpm ? (
                  <div className="ai-limit-row muted">
                    <span>Token limiti (dəqiqədə)</span>
                    <span>{lim.tpm.toLocaleString()}</span>
                  </div>
                ) : null}
                <div className="ai-limits-note">{limits.usageNote}</div>
                <div className="ai-limits-providers">
                  {limits.providers.map(p => (
                    <span key={p.name} className={`ai-prov ${p.configured ? 'on' : ''}`}>
                      {p.label.split(' ')[0]}
                      {p.limits?.rpd ? ` · ${p.limits.rpd}/gün` : ''}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <div className="ai-messages" ref={listRef}>
          {messages.map((m, i) => (
            <div key={i} className={`ai-msg ${m.role} ${m.error ? 'error' : ''}`}>
              <div className="ai-msg-body">{m.content}</div>
              {m.actionCount > 0 && (
                <div className="ai-msg-tag">{m.actionCount} əməliyyat təklif edildi</div>
              )}
              {m.ask && (
                <div className="ai-ask">
                  <div className="ai-ask-text">{m.ask.text}</div>
                  {m.ask.options?.length > 0 && (
                    <div className="ai-ask-options">
                      {m.ask.options.map((opt, k) => (
                        <button key={k} className="ai-chip" disabled={busy} onClick={() => send(opt)}>
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="ai-msg assistant">
              <div className="ai-msg-body ai-typing">
                <Loader2 size={14} className="spin" /> Düşünürəm...
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="ai-error">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        {messages.length <= 1 && suggestions.length > 0 && (
          <div className="ai-suggestions">
            {suggestions.map((s, i) => (
              <button key={i} className="ai-chip" onClick={() => send(s)} disabled={busy}>{s}</button>
            ))}
          </div>
        )}

        <div className="ai-input">
          <textarea
            ref={inputRef}
            rows={2}
            placeholder="Məsələn: SSO mövzusunda proses diaqramı qur"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              if (e.key === 'Escape') onClose();
            }}
            disabled={busy}
          />
          <button className="ai-send" onClick={() => send()} disabled={busy || !input.trim()}>
            {busy ? <Loader2 size={16} className="spin" /> : <SendHorizonal size={16} />}
          </button>
        </div>
      </div>

      {pending && (
        <AiActionPopup
          actions={pending}
          context={ctxSnapshot}
          onCancel={() => {
            setPending(null);
            setMessages(m => [...m, { role: 'system', content: 'Əməliyyatlar ləğv edildi.' }]);
          }}
          onConfirm={confirmActions}
        />
      )}
    </>
  );
}

function pct(used, max) {
  if (!max || !used) return 0;
  return Math.min(100, Math.round((used / max) * 100));
}
