// Fields of one volume (매스): plan, height, use, facade, colors, roof.

import { partArea, type BuildingPart, type Facade, type FacadeStyle, type GroundFloor, type RoofShape, type Zone } from '@smartcity/shared';
import { ColorPicker } from '../ColorPicker';
import { clampInt, clampNum } from '../RoadTypeEditor';
import { ZONE_KO } from '../Toolbar';
import { maxRound, partTop, toRectangle, withRound } from './designDraft';

const ROOF_KO: Record<RoofShape, string> = { flat: '평지붕', gable: '박공', pyramid: '모임' };
const STYLE_KO: Record<FacadeStyle, string> = { grid: '격자창', ribbon: '띠창', curtain: '커튼월', none: '무창' };
const GROUND_KO: Record<GroundFloor, string> = { none: '일반', shop: '상점', lobby: '로비', pilotis: '필로티' };
const DEFAULT_FACADE: Facade = { style: 'grid', windowRatio: 0.45, ground: 'none' };

interface Props {
  part: BuildingPart;
  /** The building type's zone (default use of a volume). */
  zone: Zone;
  onChange(p: BuildingPart): void;
}

export function VolumeFields({ part: p, zone, onChange }: Props) {
  // A smaller plan keeps the corner radius within half its shorter side.
  const set = (patch: Partial<BuildingPart>) => {
    const next = { ...p, ...patch };
    onChange(next.round ? withRound(next, next.round) : next);
  };
  const facade = p.facade ?? DEFAULT_FACADE;
  const setFacade = (patch: Partial<Facade>) => set({ facade: { ...facade, ...patch } });
  const drawn = !!p.footprint && p.footprint.length >= 3;
  const round = p.round ?? 0;
  const rounded = round > 0;
  const roundMax = maxRound(p);
  return (
    <div className="part-card bp-volume">
      {drawn ? (
        <div className="bp-wide row">
          <span className="muted" style={{ flex: 1 }}>
            그린 평면 · 꼭짓점 {p.footprint!.length}개 · {Math.round(partArea(p)).toLocaleString()}㎡ · {round1(p.width)}×{round1(p.depth)}m
          </span>
          <button onClick={() => onChange(toRectangle(p))} title="외곽 사각형(폭×깊이)으로 되돌립니다">
            직사각형으로
          </button>
        </div>
      ) : (
        <>
          <label>
            X 위치
            <input type="number" step={1} value={p.offset.x} onChange={(e) => set({ offset: { ...p.offset, x: clampNum(e.target.value, -200, 200) } })} />
          </label>
          <label>
            Z 위치
            <input type="number" step={1} value={p.offset.z} onChange={(e) => set({ offset: { ...p.offset, z: clampNum(e.target.value, -200, 200) } })} />
          </label>
          <label>
            폭(m)
            <input type="number" min={1} step={1} value={p.width} onChange={(e) => set({ width: clampNum(e.target.value, 1, 300) })} />
          </label>
          <label>
            깊이(m)
            <input type="number" min={1} step={1} value={p.depth} onChange={(e) => set({ depth: clampNum(e.target.value, 1, 300) })} />
          </label>
        </>
      )}
      <label>
        층수
        <input type="number" min={1} max={200} value={p.floors} onChange={(e) => set({ floors: clampInt(e.target.value, 1, 200) })} />
      </label>
      <label>
        층고(m)
        <input type="number" min={2} max={12} step={0.1} value={p.floorHeight} onChange={(e) => set({ floorHeight: clampNum(e.target.value, 2, 12) })} />
      </label>
      <label>
        시작 높이
        <input type="number" min={0} step={0.5} value={p.baseHeight} onChange={(e) => set({ baseHeight: clampNum(e.target.value, 0, 1000) })} />
      </label>
      <label title={drawn ? '직접 그린 평면은 평지붕만 가능합니다' : rounded ? '모서리가 둥근 볼륨은 평지붕만 가능합니다' : undefined}>
        지붕
        <select value={drawn || rounded ? 'flat' : p.roof} disabled={drawn || rounded} onChange={(e) => set({ roof: e.target.value as RoofShape })}>
          {Object.entries(ROOF_KO).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <div className="bp-wide row" title={drawn ? '직접 그린 평면은 모서리를 둥글게 할 수 없습니다' : '0 = 직각 · 최대(짧은 변의 절반) = 원형(정사각형) 또는 캡슐형'}>
        <label className="row" style={{ flex: 1 }}>
          모서리 둥글기(m)
          <input
            type="number"
            data-round
            min={0}
            max={roundMax}
            step={0.5}
            value={round}
            disabled={drawn}
            onChange={(e) => onChange(withRound(p, clampNum(e.target.value, 0, roundMax)))}
          />
          <span className="muted">최대 {round1(roundMax)}</span>
        </label>
        <button data-round-circle disabled={drawn} onClick={() => onChange(withRound(p, roundMax))} title="짧은 변의 절반: 정사각형은 원형, 직사각형은 캡슐형">
          {p.width === p.depth ? '원형' : '캡슐형'}
        </button>
      </div>
      <label className="bp-span2">
        용도
        <select value={p.use ?? ''} onChange={(e) => onChange(withUse(p, e.target.value as Zone | ''))}>
          <option value="">기본({ZONE_KO[zone]})</option>
          {Object.entries(ZONE_KO).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="bp-span2">
        외관
        <select value={facade.style} onChange={(e) => setFacade({ style: e.target.value as FacadeStyle })}>
          {Object.entries(STYLE_KO).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="bp-span2">
        창 비율 {Math.round(facade.windowRatio * 100)}%
        <input
          type="range"
          min={10}
          max={95}
          step={5}
          value={Math.round(facade.windowRatio * 100)}
          disabled={facade.style === 'none'}
          onChange={(e) => setFacade({ windowRatio: Number(e.target.value) / 100 })}
        />
      </label>
      <label className="bp-span2" title={p.baseHeight >= 0.5 ? '지면에 닿은 볼륨에만 적용됩니다' : undefined}>
        1층
        <select value={facade.ground} disabled={p.baseHeight >= 0.5} onChange={(e) => setFacade({ ground: e.target.value as GroundFloor })}>
          {Object.entries(GROUND_KO).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="bp-span2">
        벽 색
        <ColorPicker label="벽 색" value={p.color} onChange={(c) => set({ color: c })} />
      </label>
      <label className="bp-span2">
        지붕 색
        <ColorPicker label="지붕 색" value={p.roofColor} onChange={(c) => set({ roofColor: c })} />
      </label>
      <span className="muted bp-wide">
        높이 {round1(p.baseHeight)}m → {round1(partTop(p))}m
      </span>
    </div>
  );
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

function withUse(p: BuildingPart, use: Zone | ''): BuildingPart {
  const next = { ...p };
  if (use) next.use = use;
  else delete next.use;
  return next;
}
