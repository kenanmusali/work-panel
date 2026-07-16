// aiBuild.js
// The model describes a process in plain terms (lanes, steps, arrows). It never
// writes coordinates — geometry is our job, not the LLM's. This module turns a
// SPEC into the exact { lanes, nodes, edges } shape that
// data/diagrams/processes/process-<id>.json expects.

import { SHAPES, STYLES, nodeDefaults } from '../nodeStyle.js';
import { autoNodeHeight } from '../nodeMeasure.js';
import { repackLanes } from '../laneRepack.js';

const START_X = 85;    // clears the 56px left rail, matches hand-made diagrams
const COL_GAP = 70;
const ROW_GAP = 20;
const LANE_TOP_PAD = 30;
const MIN_W = 2200;    // same defaults the "Yeni diaqram" flow uses
const MIN_H = 900;

export function safeShape(s) {
  const v = String(s || '').toLowerCase();
  if (SHAPES.includes(v)) return v;
  // tolerate a few names the model reaches for
  if (v === 'rectangle' || v === 'process' || v === 'step') return 'rect';
  if (v === 'decision' || v === 'romb') return 'diamond';
  if (v === 'start' || v === 'end' || v === 'terminator') return 'pill';
  if (v === 'data') return 'parallelogram';
  return 'rect';
}
export function safeStyle(s) {
  const v = String(s || '').toLowerCase();
  return STYLES.includes(v) ? v : 'solid';
}
function cleanList(v) {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x || '').trim()).filter(Boolean);
}

function buildInfo(specNode) {
  const general = cleanList(specNode.general ?? specNode.info?.general);
  const risks = cleanList(specNode.risks ?? specNode.info?.risks);
  const info = { general: general.length ? general : [''] };
  if (risks.length) info.risks = risks;
  return info;
}

/**
 * Column per node = longest path from any root, so branches fan out to the
 * right instead of piling on top of each other. Cycles are broken by the
 * iteration cap rather than hanging.
 */
function assignColumns(refs, edges) {
  const col = new Map(refs.map(r => [r, 0]));
  const incoming = new Map(refs.map(r => [r, []]));
  edges.forEach(e => {
    if (incoming.has(e.to) && col.has(e.from)) incoming.get(e.to).push(e.from);
  });

  for (let pass = 0; pass < refs.length + 2; pass++) {
    let moved = false;
    for (const r of refs) {
      const preds = incoming.get(r) || [];
      if (!preds.length) continue;
      const want = Math.max(...preds.map(p => col.get(p) ?? 0)) + 1;
      if (want > (col.get(r) ?? 0)) { col.set(r, want); moved = true; }
    }
    if (!moved) break;
  }
  return col;
}

/**
 * spec: {
 *   lanes: [{ label }],
 *   nodes: [{ ref, lane, shape, style, text, general[], risks[] }],
 *   edges: [{ from:ref, to:ref, dashed, label }]
 * }
 * Returns { lanes, nodes, edges, width, height } ready to drop into a process.
 */
export function buildFromSpec(spec) {
  const specLanes = Array.isArray(spec?.lanes) && spec.lanes.length
    ? spec.lanes
    : [{ label: 'Proses' }];
  const specNodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const specEdges = Array.isArray(spec?.edges) ? spec.edges : [];

  const base = Date.now();
  const lanes = specLanes.map((l, i) => ({
    id: `lane-${base}-${i}`,
    label: String((typeof l === 'string' ? l : l?.label) || `Panel ${i + 1}`),
    y: 20 + i * 160,
    h: 160
  }));

  if (!specNodes.length) {
    return { lanes, nodes: [], edges: [], width: MIN_W, height: MIN_H };
  }

  // ref -> numeric node id (1..n), the id scheme the canvas + Təqdimat expect
  const refOf = (n, i) => String(n?.ref ?? n?.id ?? `n${i + 1}`);
  const refs = specNodes.map(refOf);
  const idByRef = new Map(refs.map((r, i) => [r, i + 1]));

  const edgeRefs = specEdges
    .map(e => ({
      from: String(e?.from ?? ''),
      to: String(e?.to ?? ''),
      dashed: !!e?.dashed,
      label: e?.label ? String(e.label) : ''
    }))
    .filter(e => idByRef.has(e.from) && idByRef.has(e.to) && e.from !== e.to);

  const colByRef = assignColumns(refs, edgeRefs);

  // --- size each node first; column widths depend on it ---
  const draft = specNodes.map((n, i) => {
    const shape = safeShape(n.shape ?? n.type);
    const style = safeStyle(n.style);
    const def = nodeDefaults(shape);
    const text = String(n.text || '').trim() || 'Yeni addım';
    let h = def.h;
    try {
      h = autoNodeHeight({ type: shape, style, w: def.w }, text);
    } catch { /* no DOM (SSR/tests) — default height is fine */ }
    const laneIdx = Math.min(
      Math.max(parseInt(n.lane, 10) || 1, 1),
      lanes.length
    ) - 1;
    return {
      ref: refs[i], id: idByRef.get(refs[i]),
      shape, style, text, w: def.w, h,
      laneIdx, col: colByRef.get(refs[i]) ?? 0,
      info: buildInfo(n)
    };
  });

  // --- x per column ---
  const maxCol = Math.max(...draft.map(d => d.col));
  const colW = [];
  for (let c = 0; c <= maxCol; c++) {
    const inCol = draft.filter(d => d.col === c);
    colW[c] = inCol.length ? Math.max(...inCol.map(d => d.w)) : 200;
  }
  const colX = [];
  let cursor = START_X;
  for (let c = 0; c <= maxCol; c++) {
    colX[c] = cursor;
    cursor += colW[c] + COL_GAP;
  }

  // --- y inside the lane; several nodes in one lane+column stack down ---
  const stack = new Map(); // `${laneIdx}:${col}` -> count so far
  const nodes = draft.map(d => {
    const key = `${d.laneIdx}:${d.col}`;
    const slot = stack.get(key) || 0;
    stack.set(key, slot + 1);
    const lane = lanes[d.laneIdx];
    // centre the node in its column so mixed widths line up
    const x = Math.round(colX[d.col] + (colW[d.col] - d.w) / 2);
    const y = Math.round(lane.y + LANE_TOP_PAD + slot * (d.h + ROW_GAP));
    return {
      id: d.id,
      type: d.shape,
      style: d.style,
      x, y,
      laneId: lane.id,
      w: d.w,
      h: d.h,
      text: d.text,
      info: d.info
    };
  });

  // --- lanes grow to fit, nodes ride along ---
  const packed = repackLanes(lanes, nodes);

  // --- ports, decided from final geometry ---
  const byId = new Map(packed.nodes.map(n => [n.id, n]));
  const edges = edgeRefs.map(e => {
    const a = byId.get(idByRef.get(e.from));
    const b = byId.get(idByRef.get(e.to));
    const { s, t } = portsFor(a, b);
    const edge = { from: a.id, to: b.id, s, e: t, dashed: e.dashed };
    if (e.label) edge.label = e.label;
    return edge;
  });

  const right = Math.max(...packed.nodes.map(n => n.x + n.w));
  const bottom = Math.max(...packed.lanes.map(l => l.y + l.h));

  return {
    lanes: packed.lanes,
    nodes: packed.nodes,
    edges,
    width: Math.max(MIN_W, right + 200),
    height: Math.max(MIN_H, bottom + 40)
  };
}

/** Pick the pair of sides that gives the shortest, least-crossing arrow. */
export function portsFor(a, b) {
  if (!a || !b) return { s: 'right', t: 'left' };
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const dx = bcx - acx, dy = bcy - acy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { s: 'right', t: 'left' } : { s: 'left', t: 'right' };
  }
  return dy >= 0 ? { s: 'bottom', t: 'top' } : { s: 'top', t: 'bottom' };
}

/** Next free numeric node id — mirrors Diagram.jsx's nextNodeId. */
export function nextNodeId(nodes) {
  const used = new Set((nodes || []).map(n => String(n.id)));
  let n = 1;
  while (used.has(String(n))) n++;
  return n;
}

/** Resolve a lane by id, exact label, or fuzzy label; null if nothing matches. */
export function findLane(lanes, needle) {
  if (!lanes?.length) return null;
  if (needle == null || needle === '') return lanes[0];
  const s = String(needle).trim().toLowerCase();
  return lanes.find(l => String(l.id).toLowerCase() === s)
    || lanes.find(l => String(l.label || '').toLowerCase() === s)
    || lanes.find(l => String(l.label || '').toLowerCase().includes(s))
    || null;
}
