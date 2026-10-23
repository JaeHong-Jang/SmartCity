// Design-time city indicators computed from the document alone (pure, deterministic): what the plan
// provides, not live traffic (that comes from the sim per participant). Coefficients are
// game values chosen to be plausible for Korea, not calibrated measurements.

import { buildingMetrics } from './editing/buildings.js';
import { polygonArea } from './geometry.js';
import type { CityDoc, Zone } from './model.js';
import { parcelCompliance } from './planning.js';

/** m² of floor area per resident or job. */
export const AREA_PER_PERSON = 30;
export const AREA_PER_JOB: Record<Exclude<Zone, 'residential'>, number> = { commercial: 40, office: 20, industrial: 60, public: 50 };
/** kWh per m² of floor area per day, by use. */
export const ENERGY_INTENSITY: Record<Zone, number> = { residential: 0.09, commercial: 0.25, office: 0.2, industrial: 0.35, public: 0.15 };
/** kWh per m² of panel per day (≈ 3.6 peak sun hours × 20 % modules × 0.8 losses). */
export const SOLAR_YIELD = 0.58;
/** Cooling saved on the floor below a planted roof, as a share of that building's demand. */
export const GREEN_ROOF_SAVING = 0.05;
/** kg CO₂ per kWh bought from the grid. */
export const GRID_EMISSION = 0.46;
/** Share of residents who work. */
export const WORKFORCE_SHARE = 0.55;

export interface DesignStats {
  buildings: number;
  population: number;
  jobs: number;
  jobsByUse: Record<Exclude<Zone, 'residential'>, number>;
  /** Demand bars in [-1, 1]: positive = the city wants more of it. */
  demand: { residential: number; commercial: number; workplaces: number };
  grossFloorArea: number;
  /** kWh per day */
  energyDemand: number;
  solarProduction: number;
  /** kg CO₂ per day from buildings */
  co2: number;
  greenRoofArea: number;
  greenParcelArea: number;
  evChargers: number;
  sensorBuildings: number;
  dronePorts: number;
  parcels: number;
  violations: number;
}

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

export function designStats(doc: CityDoc): DesignStats {
  const jobsByUse = { commercial: 0, office: 0, industrial: 0, public: 0 };
  let population = 0;
  let gfa = 0;
  let energyDemand = 0;
  let solarProduction = 0;
  let greenRoofArea = 0;
  let evChargers = 0;
  let sensorBuildings = 0;
  let dronePorts = 0;
  const metrics = new Map<string, ReturnType<typeof buildingMetrics>>();
  for (const id of Object.keys(doc.buildings).sort()) {
    const type = doc.buildingTypes[doc.buildings[id]!.typeId];
    if (!type) continue;
    let m = metrics.get(type.id);
    if (!m) metrics.set(type.id, (m = buildingMetrics(type)));
    population += m.areaByUse.residential / AREA_PER_PERSON;
    for (const use of Object.keys(jobsByUse) as (keyof typeof jobsByUse)[]) jobsByUse[use] += m.areaByUse[use] / AREA_PER_JOB[use];
    gfa += m.grossFloorArea;
    let demand = 0;
    for (const use of Object.keys(m.areaByUse) as Zone[]) demand += m.areaByUse[use] * ENERGY_INTENSITY[use];
    const smart = type.smart;
    if (smart) {
      demand *= 1 - GREEN_ROOF_SAVING * smart.greenRoof;
      solarProduction += m.roofArea * smart.solarRoof * SOLAR_YIELD;
      greenRoofArea += m.roofArea * smart.greenRoof;
      evChargers += smart.evChargers;
      if (smart.sensors) sensorBuildings++;
      if (smart.dronePort) dronePorts++;
    }
    energyDemand += demand;
  }
  population = Math.round(population);
  const jobs = Math.round(jobsByUse.commercial + jobsByUse.office + jobsByUse.industrial + jobsByUse.public);
  const workforce = population * WORKFORCE_SHARE;
  const shopsWanted = population * 0.12;

  const demand =
    population === 0 && jobs === 0
      ? { residential: 0.6, commercial: 0.2, workplaces: 0.3 }
      : {
          residential: clamp1((jobs - workforce) / Math.max(100, jobs)),
          commercial: clamp1((shopsWanted - jobsByUse.commercial) / Math.max(50, shopsWanted)),
          workplaces: clamp1((workforce - jobs) / Math.max(100, workforce)),
        };

  let greenParcelArea = 0;
  let violations = 0;
  const parcels = Object.values(doc.parcels ?? {});
  for (const p of parcels) {
    if (p.zone === 'green') greenParcelArea += polygonArea(p.polygon);
    violations += parcelCompliance(doc, p).violations.length;
  }

  return {
    buildings: Object.keys(doc.buildings).length,
    population,
    jobs,
    jobsByUse: {
      commercial: Math.round(jobsByUse.commercial),
      office: Math.round(jobsByUse.office),
      industrial: Math.round(jobsByUse.industrial),
      public: Math.round(jobsByUse.public),
    },
    demand,
    grossFloorArea: gfa,
    energyDemand,
    solarProduction,
    co2: Math.max(0, energyDemand - solarProduction) * GRID_EMISSION,
    greenRoofArea,
    greenParcelArea,
    evChargers,
    sensorBuildings,
    dronePorts,
    parcels: parcels.length,
    violations,
  };
}
