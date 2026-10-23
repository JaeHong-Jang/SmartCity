// Game clock → sun, sky and lighting. Pure functions; the renderer applies the result to its lights.

import * as THREE from 'three';

const HOUR = 3600;
/** Sunrise and sunset (hours since midnight). */
const SUNRISE = 6;
const SUNSET = 18.5;
/** Day time used when the simulation does not report a clock. */
export const NOON = 12 * HOUR;

export interface DayNightState {
  /** Unit vector pointing from the scene toward the key light (sun by day, moon by night). */
  lightDir: THREE.Vector3;
  lightColor: THREE.Color;
  lightIntensity: number;
  sky: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  /** 0 = full daylight … 1 = night (windows light up). */
  night: number;
  /** Sun height in [-1, 1] (negative below the horizon). */
  sunElevation: number;
}

export function createDayNightState(): DayNightState {
  return {
    lightDir: new THREE.Vector3(0, 1, 0),
    lightColor: new THREE.Color(),
    lightIntensity: 0,
    sky: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 0,
    night: 0,
    sunElevation: 1,
  };
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const SKY_DAY = new THREE.Color('#aecbe0');
const SKY_NIGHT = new THREE.Color('#15234a');
const SKY_TWILIGHT = new THREE.Color('#d9936a');
const SUN_NOON = new THREE.Color('#fff3dd');
const SUN_LOW = new THREE.Color('#ffa968');
const MOON = new THREE.Color('#c2d0ff');
const HEMI_SKY_DAY = new THREE.Color('#dbeafe');
const HEMI_SKY_NIGHT = new THREE.Color('#aab9ec');
const HEMI_GROUND_DAY = new THREE.Color('#56603f');
const HEMI_GROUND_NIGHT = new THREE.Color('#6a7494');
const MOON_DIR = new THREE.Vector3(0.35, 0.8, -0.3).normalize();

/** Sun height in [-1, 1]: 0 at sunrise/sunset, 1 at solar noon, negative at night. */
export function sunElevation(dayTime: number): number {
  const h = (((dayTime / HOUR) % 24) + 24) % 24;
  if (h >= SUNRISE && h <= SUNSET) return Math.sin(((h - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI);
  const nightLen = 24 - (SUNSET - SUNRISE);
  const into = h > SUNSET ? h - SUNSET : h + 24 - SUNSET;
  return -Math.sin((into / nightLen) * Math.PI);
}

/** Fill `out` for the given seconds since midnight (no allocation). */
export function computeDayNight(dayTime: number, out: DayNightState): DayNightState {
  const h = (((dayTime / HOUR) % 24) + 24) % 24;
  const elev = sunElevation(dayTime);
  const night = 1 - smooth(-0.14, 0.14, elev);
  const day = 1 - night;
  out.night = night;
  out.sunElevation = elev;

  // Sun azimuth sweeps east → west with the hour; the direction is clamped above the horizon so
  // shadows never get absurdly long, then blended toward the fixed moon direction at night.
  const a = ((h - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI;
  const sx = -Math.cos(a) * 0.9 - 0.25;
  const sy = Math.max(Math.sin(a), 0.26);
  const sz = 0.35;
  const sl = Math.hypot(sx, sy, sz);
  out.lightDir.set((sx / sl) * day + MOON_DIR.x * night, (sy / sl) * day + MOON_DIR.y * night, (sz / sl) * day + MOON_DIR.z * night).normalize();

  const low = 1 - smooth(0.05, 0.5, elev);
  out.lightColor.copy(SUN_NOON).lerp(SUN_LOW, low).lerp(MOON, night);
  const sunPower = 0.35 + 1.85 * smooth(0, 0.6, elev);
  out.lightIntensity = 1.3 * night + sunPower * day;

  const twilight = Math.max(0, 1 - Math.abs(elev) / 0.22) * 0.6;
  out.sky.copy(SKY_NIGHT).lerp(SKY_DAY, day).lerp(SKY_TWILIGHT, twilight);
  out.hemiSky.copy(HEMI_SKY_NIGHT).lerp(HEMI_SKY_DAY, day);
  out.hemiGround.copy(HEMI_GROUND_NIGHT).lerp(HEMI_GROUND_DAY, day);
  // Stays well above zero so the city is still readable at night.
  out.hemiIntensity = 1.25;
  return out;
}

/** "07:32" for seconds since midnight. */
export function formatClock(dayTime: number): string {
  const mins = Math.floor((((dayTime % 86400) + 86400) % 86400) / 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
