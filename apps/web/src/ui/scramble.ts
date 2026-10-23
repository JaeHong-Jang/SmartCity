// Pedestrian-only phase (보행 전용 위상) helpers for the junction inspector. Validity mirrors
// shared validateControl; the cycle length mirrors ADR 0009 §3 (7 s WALK + 1 s per metre of the longest crossing).

import { carriagewayWidth, segmentsAtNode, type CityDoc, type IntersectionControl, type SignalPhase } from '@smartcity/shared';

export const SCRAMBLE_WALK_SECONDS = 7;

function walkedLegs(doc: CityDoc, c: Pick<IntersectionControl, 'nodeId' | 'crosswalkLegs'>) {
  return segmentsAtNode(doc, c.nodeId).filter((s) => doc.roadTypes[s.roadTypeId]?.sidewalk && (!c.crosswalkLegs || c.crosswalkLegs.includes(s.id)));
}

/** Why a pedestrian-only phase cannot be enabled for this control, or null when it can. */
export function scrambleBlockReason(doc: CityDoc, c: Pick<IntersectionControl, 'nodeId' | 'kind' | 'crosswalkLegs'>): string | null {
  if (c.kind !== 'signal') return '신호 교차로에서만 쓸 수 있습니다';
  const legs = segmentsAtNode(doc, c.nodeId).length;
  if (legs < 3 || legs > 4) return '도로가 3~4개 만나는 교차로에서만 쓸 수 있습니다';
  if (walkedLegs(doc, c).length < 2) return '횡단보도가 있는 방향이 2개 이상 필요합니다';
  return null;
}

/** Length of the pedestrian-only phase: 7 s WALK plus clearance for the longest crossing. */
export function scramblePhaseSeconds(doc: CityDoc, c: Pick<IntersectionControl, 'nodeId' | 'crosswalkLegs'>): number {
  let longest = 0;
  for (const s of walkedLegs(doc, c)) longest = Math.max(longest, carriagewayWidth(doc.roadTypes[s.roadTypeId]!));
  return SCRAMBLE_WALK_SECONDS + Math.ceil(longest);
}

/** Whole signal cycle in seconds for `phases` (the automatic plan when the control has none). */
export function cycleSeconds(doc: CityDoc, c: IntersectionControl, phases: readonly SignalPhase[]): number {
  let t = 0;
  for (const p of phases) t += p.green + c.yellow + c.allRed;
  if (c.scramble) t += scramblePhaseSeconds(doc, c);
  return t;
}
