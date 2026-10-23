// 2D geometry on the XZ plane. `x` maps to world X, `z` to world Z.

export interface Vec2 {
  x: number;
  z: number;
}

export const vec = (x: number, z: number): Vec2 => ({ x, z });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, z: a.z * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.z - a.z * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.z);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  z: a.z + (b.z - a.z) * t,
});

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, z: a.z / l } : { x: 0, z: 0 };
}

/** Right-hand normal of a direction when viewed from above with +Y up (X right, Z down-screen). */
export const rightNormal = (d: Vec2): Vec2 => ({ x: -d.z, z: d.x });

/** Heading angle (radians) of a direction, atan2(z, x). Equals -rotation.y of a Three.js object facing +X. */
export const heading = (d: Vec2): number => Math.atan2(d.z, d.x);

/** Rotate like Three.js `rotation.y = r` (counter-clockwise when viewed from above). */
export function rotateY(v: Vec2, r: number): Vec2 {
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c + v.z * s, z: -v.x * s + v.z * c };
}

export function quadBezier(p0: Vec2, c: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    z: u * u * p0.z + 2 * u * t * c.z + t * t * p1.z,
  };
}

export function cubicBezier(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
    z: a * p0.z + b * c0.z + c * c1.z + d * p1.z,
  };
}

/** Sample a straight or quadratic segment into a polyline with roughly `step` meter spacing. */
export function sampleSegmentCurve(a: Vec2, b: Vec2, control: Vec2 | undefined, step = 2): Vec2[] {
  if (!control) return [a, b];
  const approx = dist(a, control) + dist(control, b);
  const n = Math.max(2, Math.ceil(approx / step));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) pts.push(quadBezier(a, control, b, i / n));
  return pts;
}

export function polylineLength(pts: readonly Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1]!, pts[i]!);
  return l;
}

/** Cumulative arc length at each vertex; first entry is 0. */
export function cumulativeLengths(pts: readonly Vec2[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  return out;
}

/** Offset a polyline sideways; positive offset = to the right of travel direction. */
export function offsetPolyline(pts: readonly Vec2[], offset: number): Vec2[] {
  if (pts.length < 2) return pts.slice();
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(pts.length - 1, i + 1)]!;
    const n = rightNormal(normalize(sub(next, prev)));
    out.push(add(pts[i]!, scale(n, offset)));
  }
  return out;
}

/** Cut a polyline to the arc-length interval [from, to]. */
export function slicePolyline(pts: readonly Vec2[], from: number, to: number): Vec2[] {
  const cum = cumulativeLengths(pts);
  const total = cum[cum.length - 1]!;
  const s0 = Math.max(0, Math.min(from, total));
  const s1 = Math.max(s0, Math.min(to, total));
  const out: Vec2[] = [pointAtLength(pts, cum, s0)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i]! > s0 && cum[i]! < s1) out.push(pts[i]!);
  out.push(pointAtLength(pts, cum, s1));
  return out;
}

/** Point at arc length `s`, given precomputed cumulative lengths. */
export function pointAtLength(pts: readonly Vec2[], cum: readonly number[], s: number): Vec2 {
  if (s <= 0) return pts[0]!;
  const total = cum[cum.length - 1]!;
  if (s >= total) return pts[pts.length - 1]!;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const segLen = cum[hi]! - cum[lo]!;
  return lerp(pts[lo]!, pts[hi]!, segLen > 0 ? (s - cum[lo]!) / segLen : 0);
}

/** Unit tangent at arc length `s`. */
export function tangentAtLength(pts: readonly Vec2[], cum: readonly number[], s: number): Vec2 {
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < s) i++;
  return normalize(sub(pts[i]!, pts[i - 1]!));
}

export interface ClosestPoint {
  point: Vec2;
  /** Arc length along the polyline. */
  s: number;
  distance: number;
}

export function closestPointOnPolyline(pts: readonly Vec2[], p: Vec2): ClosestPoint {
  let best: ClosestPoint = { point: pts[0]!, s: 0, distance: dist(pts[0]!, p) };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
    const q = lerp(a, b, t);
    const d = dist(q, p);
    const segLen = Math.sqrt(l2);
    if (d < best.distance) best = { point: q, s: acc + t * segLen, distance: d };
    acc += segLen;
  }
  return best;
}

/** Proper intersection of segments p1-p2 and q1-q2. Returns params (t on p, u on q) or null. */
export function segmentIntersection(
  p1: Vec2,
  p2: Vec2,
  q1: Vec2,
  q2: Vec2,
): { t: number; u: number; point: Vec2 } | null {
  const r = sub(p2, p1);
  const s = sub(q2, q1);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-9) return null;
  const qp = sub(q1, p1);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, point: add(p1, scale(r, t)) };
}

/** All intersections between two polylines, with arc-length positions on each. */
export function polylineIntersections(
  a: readonly Vec2[],
  b: readonly Vec2[],
): { sa: number; sb: number; point: Vec2 }[] {
  const ca = cumulativeLengths(a);
  const cb = cumulativeLengths(b);
  const out: { sa: number; sb: number; point: Vec2 }[] = [];
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const hit = segmentIntersection(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!);
      if (!hit) continue;
      const sa = ca[i - 1]! + hit.t * (ca[i]! - ca[i - 1]!);
      const sb = cb[j - 1]! + hit.u * (cb[j]! - cb[j - 1]!);
      out.push({ sa, sb, point: hit.point });
    }
  }
  return out;
}

/** Signed smallest angle from direction a to direction b, in (-π, π]. Positive = a right turn (towards rightNormal). */
export function angleBetween(a: Vec2, b: Vec2): number {
  return Math.atan2(cross(a, b), dot(a, b));
}

/**
 * Split a quadratic Bezier at parameter t (de Casteljau).
 * Returns control points for both halves; the shared point is `mid`.
 */
export function splitQuadBezier(
  p0: Vec2,
  c: Vec2,
  p1: Vec2,
  t: number,
): { mid: Vec2; c0: Vec2; c1: Vec2 } {
  const c0 = lerp(p0, c, t);
  const c1 = lerp(c, p1, t);
  return { mid: lerp(c0, c1, t), c0, c1 };
}

/** Parameter t of a quadratic Bezier whose point is closest to p (sampled then refined). */
export function closestTOnQuadBezier(p0: Vec2, c: Vec2, p1: Vec2, p: Vec2): number {
  const n = 64;
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const d = dist(quadBezier(p0, c, p1, t), p);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  let lo = Math.max(0, bestT - 1 / n);
  let hi = Math.min(1, bestT + 1 / n);
  for (let k = 0; k < 30; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (dist(quadBezier(p0, c, p1, m1), p) < dist(quadBezier(p0, c, p1, m2), p)) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}

/** Point-in-convex/concave polygon test (ray casting). */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Convex hull (monotone chain). */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = points.slice().sort((p, q) => p.x - q.x || p.z - q.z);
  if (pts.length < 3) return pts;
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(sub(lower[lower.length - 1]!, lower[lower.length - 2]!), sub(p, lower[lower.length - 2]!)) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(sub(upper[upper.length - 1]!, upper[upper.length - 2]!), sub(p, upper[upper.length - 2]!)) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Signed area (shoelace); positive when the vertices run counter-clockwise in (x, z). */
export function signedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

export const polygonArea = (poly: readonly Vec2[]): number => Math.abs(signedArea(poly));

/** True when edges meet only at shared corners (no crossings, touching or folded-back edges). */
export function isSimplePolygon(poly: readonly Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    if (dist(a, b) < 1e-9) return false;
    // Adjacent edge folding straight back onto this one.
    const c = poly[(i + 2) % n]!;
    if (Math.abs(cross(sub(b, a), sub(c, b))) < 1e-9 && dot(sub(b, a), sub(c, b)) < 0) return false;
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentDistance(a, b, poly[j]!, poly[(j + 1) % n]!) < 1e-9) return false;
    }
  }
  return polygonArea(poly) > 1e-6;
}

/** Shortest distance from p to the polygon's boundary. */
export function distanceToPolygonEdge(p: Vec2, poly: readonly Vec2[]): number {
  return closestPointOnPolyline([...poly, poly[0]!], p).distance;
}

/** Distance between point p and segment a-b. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return dist(p, lerp(a, b, t));
}

/** Shortest distance between segments p1-p2 and q1-q2 (0 when they cross). */
export function segmentDistance(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): number {
  if (segmentIntersection(p1, p2, q1, q2)) return 0;
  return Math.min(
    pointSegmentDistance(p1, q1, q2),
    pointSegmentDistance(p2, q1, q2),
    pointSegmentDistance(q1, p1, p2),
    pointSegmentDistance(q2, p1, p2),
  );
}

/** Length over which two segments lie on the same line (0 when not collinear). */
export function collinearOverlap(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2, eps = 1e-6): number {
  const d = sub(p2, p1);
  const l = len(d);
  if (l < eps) return 0;
  const u = scale(d, 1 / l);
  // Both ends of q must lie on p's line.
  if (Math.abs(cross(u, sub(q1, p1))) > eps || Math.abs(cross(u, sub(q2, p1))) > eps) return 0;
  const a = dot(sub(q1, p1), u);
  const b = dot(sub(q2, p1), u);
  return Math.max(0, Math.min(l, Math.max(a, b)) - Math.max(0, Math.min(a, b)));
}

/** Every edge is parallel to the x or z axis. */
export function isOrthogonal(poly: readonly Vec2[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.z - b.z) > 1e-6) return false;
  }
  return true;
}

/** Axis-aligned bounds. */
export interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function bounds(pts: readonly Vec2[]): Bounds {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, minZ, maxX, maxZ };
}

export const boundsOverlap = (a: Bounds, b: Bounds, margin = 0): boolean =>
  a.minX - margin <= b.maxX && b.minX - margin <= a.maxX && a.minZ - margin <= b.maxZ && b.minZ - margin <= a.maxZ;

/** Ear-clipping triangulation of a simple polygon (either orientation). O(n²); inputs are ≤ 128 vertices. */
export function triangulate(poly: readonly Vec2[]): [Vec2, Vec2, Vec2][] {
  const pts = signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
  const idx = pts.map((_, i) => i);
  const out: [Vec2, Vec2, Vec2][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10_000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = pts[idx[(k - 1 + idx.length) % idx.length]!]!;
      const b = pts[idx[k]!]!;
      const c = pts[idx[(k + 1) % idx.length]!]!;
      const turn = cross(sub(b, a), sub(c, b));
      if (turn < -1e-12) continue; // reflex
      if (turn <= 1e-12) {
        // Collinear vertex: drop it without emitting a degenerate triangle.
        idx.splice(k, 1);
        clipped = true;
        break;
      }
      const blocked = idx.some((j) => {
        const p = pts[j]!;
        return p !== a && p !== b && p !== c && pointInTriangle(p, a, b, c);
      });
      if (blocked) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // not simple; give up rather than loop
  }
  if (idx.length === 3) out.push([pts[idx[0]!]!, pts[idx[1]!]!, pts[idx[2]!]!]);
  return out;
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(p, a));
  const d2 = cross(sub(c, b), sub(p, b));
  const d3 = cross(sub(a, c), sub(p, c));
  return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
}

/** Sutherland–Hodgman: intersection of a polygon with a counter-clockwise convex polygon. */
function clipConvex(subject: readonly Vec2[], clip: readonly Vec2[]): Vec2[] {
  let out = subject.slice();
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const inside = (p: Vec2): boolean => cross(sub(b, a), sub(p, a)) >= 0;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j]!;
      const q = input[(j + 1) % input.length]!;
      const pin = inside(p);
      const qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const d = cross(sub(b, a), sub(q, p));
        if (Math.abs(d) > 1e-15) out.push(add(p, scale(sub(q, p), cross(sub(b, a), sub(a, p)) / d)));
      }
    }
  }
  return out;
}

/** Exact area shared by two simple polygons (triangulate both, clip triangle pairs). */
export function intersectionArea(a: readonly Vec2[], b: readonly Vec2[]): number {
  if (!boundsOverlap(bounds(a), bounds(b))) return 0;
  const ta = triangulate(a);
  const tb = triangulate(b);
  const bb = tb.map((t) => bounds(t));
  let area = 0;
  for (const t of ta) {
    const bt = bounds(t);
    for (let k = 0; k < tb.length; k++) {
      if (!boundsOverlap(bt, bb[k]!)) continue;
      const piece = clipConvex(t, tb[k]!);
      if (piece.length >= 3) area += polygonArea(piece);
    }
  }
  return area;
}

/** True when two simple polygons share interior area (touching edges or corners do not count). */
export function polygonsOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  return intersectionArea(a, b) > 1e-6;
}

/** True when `inner` lies entirely inside (or on the boundary of) the simple polygon `outer`. */
export function polygonInside(inner: readonly Vec2[], outer: readonly Vec2[]): boolean {
  const area = polygonArea(inner);
  return area > 0 && Math.abs(intersectionArea(inner, outer) - area) <= 1e-6 * Math.max(1, area);
}

/** Smallest distance between the boundaries of two polygons. */
export function polygonBoundaryDistance(a: readonly Vec2[], b: readonly Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      d = Math.min(d, segmentDistance(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!));
    }
  }
  return d;
}
