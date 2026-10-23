// RCI demand shown in the HUD and used to explain why a lot does not grow (ADR 0009 §4).

import { demand, GROWTH_THRESHOLD, type CityDoc, type Demand } from '@smartcity/shared';

/** Demand per grown use in [-1, 1]; industrial growth is not supported yet and is not shown as a bar. */
export type DemandBars = Pick<Demand, 'residential' | 'commercial' | 'office'>;

/** Growth only starts above this demand. */
export const GROWTH_DEMAND_MIN = GROWTH_THRESHOLD;

export function growthDemand(doc: CityDoc): DemandBars {
  return demand(doc);
}
