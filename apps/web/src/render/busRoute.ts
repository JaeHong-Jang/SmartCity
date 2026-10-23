// Approximate bus line path for the overlay: shortest path over the road graph between stops,
// respecting stop direction. Pure, uses only the doc.

import {
  cumulativeLengths,
  pointAtLength,
  sampleSegmentCurve,
  slicePolyline,
  type BusStop,
  type CityDoc,
  type Vec2,
} from '@smartcity/shared';

function curve(doc: CityDoc, segId: string): Vec2[] {
  const s = doc.segments[segId]!;
  return sampleSegmentCurve(doc.nodes[s.a]!.pos, doc.nodes[s.b]!.pos, s.control);
}

export function stopPosition(doc: CityDoc, stop: BusStop): Vec2 | null {
  if (!doc.segments[stop.segmentId]) return null;
  const pts = curve(doc, stop.segmentId);
  const cum = cumulativeLengths(pts);
  return pointAtLength(pts, cum, stop.t * cum[cum.length - 1]!);
}

/** Dijkstra over nodes, honoring one-way roads. Returns the node path or null. */
function nodePath(doc: CityDoc, from: string, to: string): { nodes: string[]; segs: string[] } | null {
  if (from === to) return { nodes: [from], segs: [] };
  const adj = new Map<string, { to: string; seg: string; w: number }[]>();
  for (const s of Object.values(doc.segments)) {
    const rt = doc.roadTypes[s.roadTypeId];
    if (!rt) continue;
    const pts = curve(doc, s.id);
    const w = cumulativeLengths(pts)[pts.length - 1]!;
    const push = (a: string, b: string): void => {
      let l = adj.get(a);
      if (!l) adj.set(a, (l = []));
      l.push({ to: b, seg: s.id, w });
    };
    push(s.a, s.b);
    if (rt.lanesBackward > 0) push(s.b, s.a);
  }
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; seg: string }>();
  const open = new Set<string>([from]);
  while (open.size) {
    let best: string | null = null;
    for (const n of open) if (best === null || dist.get(n)! < dist.get(best)!) best = n;
    const u = best!;
    open.delete(u);
    if (u === to) break;
    for (const e of adj.get(u) ?? []) {
      const d = dist.get(u)! + e.w;
      if (d < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, d);
        prev.set(e.to, { node: u, seg: e.seg });
        open.add(e.to);
      }
    }
  }
  if (!prev.has(to)) return null;
  const nodes = [to];
  const segs: string[] = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur)!;
    segs.push(p.seg);
    nodes.push(p.node);
    cur = p.node;
  }
  return { nodes: nodes.reverse(), segs: segs.reverse() };
}

/** Polyline for traveling stop → next stop. Falls back to a straight line if no path exists. */
export function routeBetween(doc: CityDoc, a: BusStop, b: BusStop): Vec2[] {
  const pa = stopPosition(doc, a);
  const pb = stopPosition(doc, b);
  if (!pa || !pb) return [];
  const sa = doc.segments[a.segmentId]!;
  const sb = doc.segments[b.segmentId]!;
  const ca = curve(doc, sa.id);
  const cb = curve(doc, sb.id);
  const la = cumulativeLengths(ca)[ca.length - 1]!;
  const lb = cumulativeLengths(cb)[cb.length - 1]!;
  if (a.segmentId === b.segmentId && a.dir === b.dir && (a.dir === 'forward' ? b.t >= a.t : b.t <= a.t)) {
    const piece = slicePolyline(ca, Math.min(a.t, b.t) * la, Math.max(a.t, b.t) * la);
    return a.dir === 'forward' ? piece : piece.reverse();
  }
  // Leave a's segment in its travel direction, enter b's segment against its travel direction.
  const exitNode = a.dir === 'forward' ? sa.b : sa.a;
  const entryNode = b.dir === 'forward' ? sb.a : sb.b;
  const head = a.dir === 'forward' ? slicePolyline(ca, a.t * la, la) : slicePolyline(ca, 0, a.t * la).reverse();
  const tail = b.dir === 'forward' ? slicePolyline(cb, 0, b.t * lb) : slicePolyline(cb, b.t * lb, lb).reverse();
  const path = nodePath(doc, exitNode, entryNode);
  if (!path) return [pa, pb];
  const out: Vec2[] = [...head];
  for (let i = 0; i < path.segs.length; i++) {
    const s = doc.segments[path.segs[i]!]!;
    const c = curve(doc, s.id);
    out.push(...(s.a === path.nodes[i] ? c : c.slice().reverse()));
  }
  out.push(...tail);
  return out;
}
