import { describe, expect, it } from 'vitest';
import { applyCommand, cloneJson, type CityDoc, type Command, type Sensor } from '@smartcity/shared';
import { compileNetwork, compileSensorCoverage, type RoadGraph } from '@smartcity/sim';
import { selectionExists, translateError } from '../app/store';
import { inputShapeError, toWorkerError } from '../sim/protocol';
import { detectionLabel, detectionNote, detectionSummaryText, responseBreakdownText } from '../simmode/detectionText';
import { crossDoc } from '../test/fixtures';
import { removeCommandFor } from '../tools/bulldozeTool';
import { highlightPreview } from '../tools/highlight';
import { PickIndex, pickAt } from '../tools/picking';
import { commandDomains, D_ROADS, D_SENSORS, touchesSelection } from './dirty';
import { CULL_RADIUS, SensorLayer } from './sensors';

function withSensors(): { doc: CityDoc; graph: RoadGraph; segId: string } {
  const { doc } = crossDoc();
  const segId = Object.keys(doc.segments).sort()[0]!;
  const place = (s: Sensor) => {
    const r = applyCommand(doc, { type: 'sensor.place', sensor: s });
    if (!r.ok) throw new Error(r.error);
  };
  place({ id: 'c1', kind: 'cctv', segmentId: segId, t: 0.5, side: 'right', heading: 0, fov: Math.PI / 2, range: 60 });
  place({ id: 'r1', kind: 'radar', segmentId: segId, t: 0.3, side: 'left', heading: Math.PI, fov: Math.PI / 9, range: 120 });
  place({ id: 'p1', kind: 'smartpole', segmentId: segId, t: 0.7, side: 'right', heading: 0, fov: Math.PI * 2, range: 30 });
  return { doc, graph: compileNetwork(doc), segId };
}

describe('sensor commands in the dirty table and selections', () => {
  it('sensor.* redraws the sensor layer; a road edit redraws sensors too (their pose follows the road)', () => {
    const upd: Command = { type: 'sensor.update', id: 'c1', heading: 1 };
    expect(commandDomains({ type: 'sensor.remove', id: 'c1' })).toBe(D_SENSORS);
    expect(commandDomains(upd)).toBe(D_SENSORS);
    expect(touchesSelection(upd, { kind: 'sensor', id: 'c1' })).toBe(true);
    expect(touchesSelection(upd, { kind: 'sensor', id: 'c2' })).toBe(false);
    expect(touchesSelection({ type: 'segment.remove', id: 's' }, { kind: 'sensor', id: 'c1' })).toBe(true);
    expect(commandDomains({ type: 'segment.remove', id: 's' }) & D_ROADS).toBeTruthy();
    const { doc } = withSensors();
    expect(selectionExists(doc, { kind: 'sensor', id: 'c1' })).toBe(true);
    expect(selectionExists(doc, { kind: 'sensor', id: 'zz' })).toBe(false);
  });
});

describe('picking sensors', () => {
  it('a sensor pole wins over the road it stands next to; bulldoze and Delete remove it', () => {
    const { doc } = withSensors();
    const idx = new PickIndex(doc);
    const at = idx.sensorPosition('c1')!;
    expect(pickAt(idx, at)).toEqual({ kind: 'sensor', id: 'c1' });
    expect(pickAt(idx, at, { sensors: false })?.kind).not.toBe('sensor');
    expect(removeCommandFor({ kind: 'sensor', id: 'c1' })).toEqual({ type: 'sensor.remove', id: 'c1' });
    expect(highlightPreview(doc, idx, { kind: 'sensor', id: 'c1' }, '#f00').points).toHaveLength(1);
  });
});

describe('SensorLayer', () => {
  it('one instance per placed sensor and kind; instances far from the camera are culled', () => {
    const { doc } = withSensors();
    const layer = new SensorLayer();
    layer.update(doc);
    layer.frame(0, 0);
    expect(layer.stats().drawn).toEqual({ cctv: 1, radar: 1, smartpole: 1 });
    layer.frame(CULL_RADIUS + 500, 0);
    expect(layer.stats().drawn).toEqual({ cctv: 0, radar: 0, smartpole: 0 });
    expect(layer.stats().total).toBe(3);
    layer.dispose();
  });

  it('view sectors: none by default, every sensor (all mode), or the selected one; lanes = the simulation coverage', () => {
    const { doc, graph } = withSensors();
    const layer = new SensorLayer();
    layer.update(doc);
    layer.setSectors(doc, graph, 'none');
    expect(layer.stats().sectors).toBe(0);
    layer.setSectors(doc, graph, 'all');
    const cov = compileSensorCoverage(doc, graph);
    expect(layer.stats().sectors).toBe(3);
    expect(layer.stats().coveredLanes).toBe(cov.reduce((n, c) => n + c.lanes.length, 0));
    layer.setSectors(doc, graph, 'one', 'r1');
    expect(layer.stats().sectors).toBe(1);
    expect(layer.stats().coveredLanes).toBe(cov.find((c) => c.sensorId === 'r1')!.lanes.length);
    // A removed sensor (after an update) disappears from the sectors.
    const after = cloneJson(doc);
    applyCommand(after, { type: 'sensor.remove', id: 'c1' });
    layer.update(after);
    layer.setSectors(after, graph, 'all');
    expect(layer.stats().sectors).toBe(2);
    layer.dispose();
  });
});

describe('Korean wording and worker messages for sensors / detection', () => {
  it('translates sensor refusals (fillet corner, ranges, ids)', () => {
    expect(translateError('cannot round the corner: a sensor is in the corner')).toBe('모서리 구간에 센서가 있습니다');
    expect(translateError('sensor.range out of range [5, 500]')).toBe('감시 범위는 5~500m여야 합니다');
    expect(translateError('sensor.fov out of range [1°, 2π]')).toBe('시야각은 1°~360°여야 합니다');
    expect(translateError('unknown sensor')).toBe('센서가 이미 바뀌었습니다. 다시 시도하세요');
    expect(translateError('sensor exists')).toBe('같은 이름의 센서가 이미 있습니다');
    expect(translateError('too many sensors')).toBe('센서가 너무 많습니다');
  });

  it('initRecord carries an optional detection mode; policy.set inputs carry an optional detection index', () => {
    const record = { doc: {} };
    expect(toWorkerError({ t: 'initRecord', record, detection: 'sensors' })).toBeNull();
    expect(toWorkerError({ t: 'initRecord', record, detection: 'sometimes' })).not.toBeNull();
    const policy = { eventId: 'p', tick: 0, order: 0, kind: 'policy.set', target: {}, params: { reroute: 1, informedShare: 0.5 } };
    expect(inputShapeError({ ...policy, params: { ...policy.params, detection: 2 } })).toBeNull();
    expect(inputShapeError({ ...policy, params: { ...policy.params, detection: 3 } })).toMatch(/detection/);
    expect(inputShapeError({ ...policy, params: { ...policy.params, detection: 0.5 } })).toMatch(/detection/);
  });

  it('detection outcomes become labels and row notes', () => {
    const { doc } = withSensors();
    const known = (reason: string) => ({ eventId: 'e', tick: 1, kind: 'detection.known', applied: true, reason });
    expect(detectionLabel(known('sensor r1, 0.5분'), doc)).toEqual({ text: '레이더 감지', bySensor: true });
    expect(detectionLabel(known('sensor c1, 0.5분'), doc)).toEqual({ text: 'CCTV 감지', bySensor: true });
    expect(detectionLabel(known('report, 2.0분'), doc)).toEqual({ text: '신고 접수', bySensor: false });
    expect(detectionNote(known('report, 2.0분'), doc)).toBe('신고 접수 · 발생 2.0분 후');
    expect(detectionNote({ eventId: 'e', tick: 1, kind: 'detection.missed', applied: true, reason: 'burned before detection' }, doc)).toBe('인지 전에 전소');
    expect(detectionNote({ eventId: 'e', tick: 1, kind: 'accident.start', applied: true }, doc)).toBeNull();
    const d = { tracked: 2, covered: 1, detected: 1, bySensor: 1, avgDelay: 0.5, maxDelay: 0.5, undetectedNow: 1, undetectedElapsedSum: 2, oldestUndetectedMinutes: 2, missed: 0, missedDamaged: 0, exposedVehicles: 4, onSiteRecoveries: 2 };
    expect(detectionSummaryText(d)).toContain('미인지 1건 (최장 2.0분)');
    expect(responseBreakdownText({ arrivals: 1, detect: 1, dispatchWait: 0.5, travel: 3, workDone: 0, work: 0 })).toBe('대응 4.5분 = 감지 1.0분 + 출동 대기 0.5분 + 이동 3.0분 (도착 1건)');
  });
});
