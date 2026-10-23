import type { Vec2 } from '@smartcity/shared';

/** The polygon's outline as a closed polyline (first point repeated at the end). */
export const closedRing = (poly: readonly Vec2[]): Vec2[] => [...poly, poly[0]!];
