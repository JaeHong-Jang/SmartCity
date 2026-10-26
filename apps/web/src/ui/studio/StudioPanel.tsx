// Right-hand panel of the building studio: palette, materials, uses, the selected volume (roof,
// floors), props, dice, templates. All edits go through the StudioEditor (undoable).

import { useState } from 'react';
import { DEFAULT_BUILDING_TYPES, PROP_KINDS, SMART_CITY_PRESETS, type BuildingType, type PropKind, type Zone } from '@smartcity/shared';
import { fromBuildingType, TOO_LARGE_KO } from '../../studio/design';
import { DICE_SIZES, DICE_STYLES, rollDesign, type DiceSize, type DiceStyle } from '../../studio/dice';
import { ACCENT_COLORS, MATERIALS, PROP_INFO, ROOF_COLORS, USES, WALL_COLORS, type Swatch } from '../../studio/palette';
import type { StudioEditor } from '../../studio/StudioEditor';
import type { StudioDoc } from '../../studio/voxelEdit';
import { ZONE_KO } from '../Toolbar';

export interface LoadInfo {
  name: string;
  zone: Zone;
  lossy: boolean;
}

const CHANNEL_KO = { all: '스타일 전체', color: '벽 색', roofColor: '지붕 색', facade: '재질', use: '용도', roof: '지붕 형태', round: '모서리 둥글기' } as const;
const ROOF_KO = { flat: '평지붕', gable: '박공', pyramid: '피라미드' } as const;
const PROP_SIZES = [0.5, 0.75, 1, 1.5, 2, 3, 4];

function Swatches({ items, active, onPick, label }: { items: Swatch[]; active: string; onPick: (c: string) => void; label: string }) {
  return (
    <div className="st-swatches" role="group" aria-label={label}>
      {items.map((s) => (
        <button key={s.color} title={s.name} aria-label={`${label} ${s.name}`} className={active === s.color ? 'active' : ''} style={{ background: s.color }} onClick={() => onPick(s.color)} />
      ))}
    </div>
  );
}

export function StudioPanel({ editor, onLoad }: { editor: StudioEditor; onLoad: (doc: StudioDoc, info: LoadInfo) => void }) {
  const ed = editor;
  const [diceStyle, setDiceStyle] = useState<DiceStyle>('house');
  const [diceSize, setDiceSize] = useState<DiceSize>('M');
  const [seed, setSeed] = useState(1);

  /** Palette clicks set the brush; painting tools stay, other tools switch to painting. */
  const brush = (patch: Partial<typeof ed.style>, channel: typeof ed.channel) => {
    ed.style = { ...ed.style, ...patch };
    ed.channel = channel;
    if (ed.tool !== 'stack' && ed.tool !== 'paint') ed.tool = 'paint';
    ed.hint = '';
    ed.changed();
  };
  const sel = ed.tool === 'select' ? ed.selection() : null;
  const roofOk = ed.roofOptions();
  const roundOk = ed.roundOptions();
  const roll = (s: number) => {
    setSeed(s);
    const r = rollDesign(s, diceStyle, diceSize);
    onLoad(r.doc, { name: r.name, zone: r.zone, lossy: false });
  };
  const template = (t: BuildingType) => {
    const o = fromBuildingType(t);
    if (o.tooLarge) {
      ed.setHint(TOO_LARGE_KO);
      return;
    }
    onLoad(o.doc, { name: t.name, zone: t.zone, lossy: o.lossy });
  };

  return (
    <aside className="panel st-side" aria-label="스튜디오 패널">
      <section>
        <h3>
          팔레트 <span className="muted">· 칠하기: {CHANNEL_KO[ed.channel]}</span>
        </h3>
        <div className="st-label">벽</div>
        <Swatches label="벽 색" items={WALL_COLORS} active={ed.channel === 'color' || ed.channel === 'all' ? ed.style.color : ''} onPick={(c) => brush({ color: c }, 'color')} />
        <div className="st-label">지붕</div>
        <Swatches label="지붕 색" items={ROOF_COLORS} active={ed.channel === 'roofColor' ? ed.style.roofColor : ''} onPick={(c) => brush({ roofColor: c }, 'roofColor')} />
        <div className="st-label">포인트</div>
        <Swatches
          label="포인트 색"
          items={ACCENT_COLORS}
          active={ed.tool === 'prop' ? ed.propColor : ed.channel === 'color' ? ed.style.color : ''}
          onPick={(c) => (ed.tool === 'prop' ? ed.set('propColor', c) : brush({ color: c }, 'color'))}
        />
        <div className="row st-row">
          <span className="muted">칠하기 범위</span>
          <div className="row speed" role="group" aria-label="칠하기 범위">
            <button className={!ed.paintChunk ? 'active' : ''} onClick={() => ed.set('paintChunk', false)}>
              한 칸
            </button>
            <button className={ed.paintChunk ? 'active' : ''} title="같은 스타일로 이어진 덩어리 전체" onClick={() => ed.set('paintChunk', true)}>
              덩어리
            </button>
          </div>
        </div>
      </section>

      <section>
        <h3>재질 프리셋</h3>
        <div className="chips st-chips">
          {MATERIALS.map((m) => (
            <button
              key={m.id}
              className={ed.channel === 'facade' && ed.style.color === m.color && ed.style.facade?.style === m.facade.style ? 'active' : ''}
              onClick={() => brush({ color: m.color, roofColor: m.roofColor, facade: { ...m.facade } }, 'facade')}
            >
              <span className="swatch" style={{ background: m.color, borderColor: m.roofColor }} />
              {m.name}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>용도 칠하기</h3>
        <div className="chips st-chips">
          {USES.map((u) => (
            <button key={u} className={ed.channel === 'use' && ed.style.use === u ? 'active' : ''} onClick={() => brush({ use: u }, 'use')}>
              {ZONE_KO[u]}
            </button>
          ))}
        </div>
      </section>

      {ed.tool === 'select' && (
        <section data-studio-selection>
          <h3>선택한 덩어리</h3>
          {sel ? (
            <>
              <div className="muted">
                {sel.top - sel.bottom + 1}개 층 · {sel.cells.length}블록 · 위 화살표를 끌어 층 추가/제거
              </div>
              <div className="row st-row">
                <span className="muted">층</span>
                <button
                  onClick={() => {
                    if (ed.beginRaise()) {
                      ed.previewRaise(-1);
                      ed.endRaise();
                    }
                  }}
                >
                  − 1층
                </button>
                <button
                  onClick={() => {
                    if (ed.beginRaise()) {
                      ed.previewRaise(1);
                      ed.endRaise();
                    }
                  }}
                >
                  + 1층
                </button>
              </div>
              <div className="row st-row" role="group" aria-label="지붕 형태">
                <span className="muted">지붕</span>
                {(['flat', 'gable', 'pyramid'] as const).map((r) => (
                  <button key={r} disabled={r !== 'flat' && !roofOk.ok} title={r !== 'flat' && !roofOk.ok ? roofOk.reason : ROOF_KO[r]} onClick={() => ed.setRoof(r)}>
                    {ROOF_KO[r]}
                  </button>
                ))}
              </div>
              {!roofOk.ok && <div className="muted st-reason">{roofOk.reason}</div>}
              <div className="row st-row" role="group" aria-label="모서리 둥글기">
                <span className="muted">모서리</span>
                <input
                  type="range"
                  data-studio-round
                  min={0}
                  max={roundOk.max}
                  step={0.5}
                  value={roundOk.value}
                  disabled={!roundOk.ok}
                  title={roundOk.ok ? '0 = 직각 · 최대 = 원형(정사각형) 또는 캡슐형' : roundOk.reason}
                  onChange={(e) => ed.setRound(Number(e.target.value))}
                />
                <span data-studio-round-value>{roundOk.value}m</span>
                <button data-studio-round-max disabled={!roundOk.ok} title="짧은 변의 절반: 정사각형은 원형, 직사각형은 캡슐형" onClick={() => ed.setRound(roundOk.max)}>
                  최대
                </button>
              </div>
              {!roundOk.ok && <div className="muted st-reason">{roundOk.reason}</div>}
            </>
          ) : (
            <div className="muted">건물 덩어리를 클릭해 선택하세요</div>
          )}
        </section>
      )}

      <section>
        <h3>
          장식 <span className="muted">· {ed.doc.props.length}/64</span>
        </h3>
        <div className="st-props">
          {PROP_KINDS.map((k: PropKind) => (
            <button
              key={k}
              data-prop={k}
              className={ed.tool === 'prop' && ed.propKind === k ? 'active' : ''}
              title={PROP_INFO[k].mount === 'wall' ? '벽면에 붙입니다' : '옥상이나 바닥에 놓습니다'}
              onClick={() => {
                ed.propKind = k;
                ed.propColor = PROP_INFO[k].color;
                ed.set('tool', 'prop');
              }}
            >
              {PROP_INFO[k].label}
            </button>
          ))}
        </div>
        {ed.tool === 'prop' && (
          <div className="row st-row wrap">
            <button title="R 키" onClick={() => ed.set('propRot', (ed.propRot + 1) % 4)}>
              회전 {ed.propRot * 90}°
            </button>
            <label className="row">
              <span className="muted">크기</span>
              <select value={ed.propSize} onChange={(e) => ed.set('propSize', Number(e.target.value))}>
                {PROP_SIZES.map((s) => (
                  <option key={s} value={s}>
                    ×{s}
                  </option>
                ))}
              </select>
            </label>
            <span className="swatch" style={{ background: ed.propColor }} title="장식 색 (포인트 팔레트에서 바꾸기)" />
          </div>
        )}
      </section>

      <section>
        <h3>주사위 (자동 생성)</h3>
        <div className="row st-row wrap">
          <select value={diceStyle} aria-label="주사위 스타일" onChange={(e) => setDiceStyle(e.target.value as DiceStyle)}>
            {DICE_STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="row speed" role="group" aria-label="크기">
            {DICE_SIZES.map((s) => (
              <button key={s.id} className={diceSize === s.id ? 'active' : ''} onClick={() => setDiceSize(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        </div>
        <div className="row st-row">
          <button className="primary" data-dice onClick={() => roll(1 + Math.floor(Math.random() * 99999))}>
            주사위 굴리기
          </button>
          <label className="row">
            <span className="muted">시드</span>
            <input type="number" min={1} value={seed} style={{ width: 80 }} onChange={(e) => setSeed(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
          </label>
          <button title="이 시드로 다시 만들기" onClick={() => roll(seed)}>
            적용
          </button>
        </div>
      </section>

      <section>
        <h3>템플릿</h3>
        <div className="chips st-chips">
          {[...SMART_CITY_PRESETS, ...DEFAULT_BUILDING_TYPES].map((t) => (
            <button key={t.id} onClick={() => template(t)}>
              {t.name}
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
