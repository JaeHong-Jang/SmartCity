// @smartcity/sim public API (see packages/sim/AGENTS.md).
export * from './types.js';
export * from './scenario/types.js';
export { compileNetwork } from './network/compile.js';
export { crossingSignature } from './network/crossings.js';
export { Simulation } from './simulation.js';
export { CONGESTION_SPEED_SHARE, KPI_GAME_SECONDS, KpiSeries, kpiEveryTicks } from './scenario/kpi.js';
export { COMPARISON_PRESETS, simulationFromRecord, type ReplayOptions } from './scenario/record.js';
export { compileSensorCoverage, laneBoxes, SENSOR_DETECTS, sensorCoverage, type LaneInterval, type SensorCoverage } from './scenario/coverage.js';
export { REPORT_DELAY, SENSOR_MODEL } from './scenario/detection.js';
