// Intelligent Driver Model (Treiber), δ = 4.

export const MAX_DECEL = 9;

/**
 * @param gap bumper-to-bumper distance to the leader (Infinity = free road)
 * @param dv approach rate v − v_leader
 */
export function idmAccel(v: number, v0: number, gap: number, dv: number, a: number, b: number, s0: number, T: number): number {
  const r = v / v0;
  const r2 = r * r;
  let acc = 1 - r2 * r2;
  if (gap < Infinity) {
    const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
    const q = sStar / Math.max(gap, 0.01);
    acc -= q * q;
  }
  return Math.max(-MAX_DECEL, a * acc);
}
