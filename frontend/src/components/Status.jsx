import { useState, useRef, useEffect } from 'react';
import { Clock, CheckCircle2, AlertCircle, ChevronDown } from './icons.jsx';

// Single source of truth for the three item statuses used across the
// diagrams (İş Axışları) and PDF (Normativ Sənədlər) sections.
//   progress → in progress   done → finished   notdone → not finished
export const STATUS_META = {
  progress: { label: 'Davam edir', Icon: Clock,        cls: 'progress' },
  done:     { label: 'Bitib',      Icon: CheckCircle2, cls: 'done' },
  notdone:  { label: 'Bitməyib',   Icon: AlertCircle,  cls: 'notdone' },
};

export const STATUS_ORDER = ['progress', 'done', 'notdone'];

function norm(value) {
  return STATUS_META[value] ? value : null;
}

// Read-only coloured pill with icon + label. Renders nothing when no status.
export function StatusBadge({ value, size = 14 }) {
  const v = norm(value);
  if (!v) return null;
  const { label, Icon, cls } = STATUS_META[v];
  return (
    <span className={`status-badge ${cls}`} title={label}>
      <Icon size={size} />
      <span>{label}</span>
    </span>
  );
}

// Interactive control for admins. Shows the current status and, on click,
// a small menu to pick a status or clear it. Viewers get <StatusBadge> instead.
export function StatusControl({ value, editable, onChange, size = 14 }) {
  const v = norm(value);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!editable) return <StatusBadge value={v} size={size} />;

  const meta = v ? STATUS_META[v] : null;

  function pick(next) {
    setOpen(false);
    if (next !== v) onChange(next);
  }

  return (
    <span className="status-control" ref={ref} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className={`status-trigger ${meta ? meta.cls : 'none'}`}
        title="Statusu dəyiş"
        onClick={() => setOpen(o => !o)}
      >
        {meta ? <meta.Icon size={size} /> : <Clock size={size} />}
        <span>{meta ? meta.label : 'Status'}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="status-menu">
          {STATUS_ORDER.map(k => {
            const m = STATUS_META[k];
            return (
              <button
                type="button"
                key={k}
                className={`status-opt ${m.cls} ${v === k ? 'active' : ''}`}
                onClick={() => pick(k)}
              >
                <m.Icon size={14} /><span>{m.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            className={`status-opt none ${!v ? 'active' : ''}`}
            onClick={() => pick(null)}
          >
            <span>Statussuz</span>
          </button>
        </div>
      )}
    </span>
  );
}
