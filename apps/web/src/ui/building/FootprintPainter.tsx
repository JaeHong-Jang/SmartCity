// Top-view grid painter for one volume's plan. Cells are only an editing representation: every
// change is turned into an orthogonal outline by the parent (cellsToOutline) and stored as `footprint`.

import { useEffect, useRef, useState } from 'react';
import { cellKey, parseCell, partBaseOutline, partOutline, pointInPolygon, type BuildingPart, type CellKey, type Vec2 } from '@smartcity/shared';
import { partCells } from './designDraft';

const CSS = 300;
const PAD = 10;
const FOOT = 24;
const SIZES = [1, 2, 4] as const;

type Mode = 'brush' | 'rect';

interface Props {
  part: BuildingPart;
  others: BuildingPart[];
  /** Side of the square plot, metres (centered on the building origin). */
  plot: number;
  /** Changes when the painter must reload its cells from the volume (other volume, other design, undo). */
  resetKey: string;
  onPaint(cells: Set<CellKey>, size: number): void;
}

export function FootprintPainter({ part, others, plot, resetKey, onPaint }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<number>(2);
  const [mode, setMode] = useState<Mode>('brush');
  const [cells, setCells] = useState<Set<CellKey>>(() => partCells(part, 2));
  const [rect, setRect] = useState<{ a: [number, number]; b: [number, number]; erase: boolean } | null>(null);
  const drag = useRef<{ erase: boolean; last: [number, number] } | null>(null);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  useEffect(() => {
    setCells(partCells(part, size));
    // Reload only on an explicit reset or cell-size change, not on our own paint results.
  }, [resetKey, size]);

  const scale = (CSS - PAD * 2) / plot;
  const toPx = (v: Vec2): [number, number] => [PAD + (v.x + plot / 2) * scale, PAD + (v.z + plot / 2) * scale];
  const half = Math.floor(plot / 2 / size);
  const inPlot = (i: number, j: number): boolean => i >= -half && i < half && j >= -half && j < half;

  const cellAt = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * CSS;
    const y = ((e.clientY - r.top) / r.height) * (CSS + FOOT);
    return [Math.floor(((x - PAD) / scale - plot / 2) / size), Math.floor(((y - PAD) / scale - plot / 2) / size)];
  };

  const commit = (next: Set<CellKey>) => {
    setCells(next);
    onPaint(next, size);
  };

  const paintLine = (from: [number, number], to: [number, number], erase: boolean) => {
    const next = new Set(cellsRef.current);
    const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]), 1);
    let changed = false;
    for (let s = 0; s <= steps; s++) {
      const i = Math.round(from[0] + ((to[0] - from[0]) * s) / steps);
      const j = Math.round(from[1] + ((to[1] - from[1]) * s) / steps);
      if (!inPlot(i, j)) continue;
      const k = cellKey(i, j);
      if (erase) {
        if (next.delete(k)) changed = true;
      } else if (!next.has(k)) {
        next.add(k);
        changed = true;
      }
    }
    if (changed) commit(next);
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const c = cellAt(e);
    const erase = e.shiftKey || e.button === 2;
    if (mode === 'rect') {
      setRect({ a: c, b: c, erase });
      return;
    }
    drag.current = { erase, last: c };
    paintLine(c, c, erase);
  };

  const onMove = (e: React.PointerEvent) => {
    const c = cellAt(e);
    if (rect) {
      if (c[0] !== rect.b[0] || c[1] !== rect.b[1]) setRect({ ...rect, b: c });
      return;
    }
    const d = drag.current;
    if (!d || (c[0] === d.last[0] && c[1] === d.last[1])) return;
    paintLine(d.last, c, d.erase);
    d.last = c;
  };

  const onUp = () => {
    drag.current = null;
    if (!rect) return;
    const next = new Set(cellsRef.current);
    for (let i = Math.min(rect.a[0], rect.b[0]); i <= Math.max(rect.a[0], rect.b[0]); i++) {
      for (let j = Math.min(rect.a[1], rect.b[1]); j <= Math.max(rect.a[1], rect.b[1]); j++) {
        if (!inPlot(i, j)) continue;
        if (rect.erase) next.delete(cellKey(i, j));
        else next.add(cellKey(i, j));
      }
    }
    setRect(null);
    commit(next);
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = CSS * dpr;
    canvas.height = (CSS + FOOT) * dpr;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, CSS, CSS + FOOT);
    const poly = (pts: Vec2[]) => {
      g.beginPath();
      pts.forEach((v, n) => (n ? g.lineTo(...toPx(v)) : g.moveTo(...toPx(v))));
      g.closePath();
    };

    // Plot and grid.
    const p0 = toPx({ x: -plot / 2, z: -plot / 2 });
    const side = plot * scale;
    g.fillStyle = '#1b2633';
    g.fillRect(p0[0], p0[1], side, side);
    if (size * scale >= 4) {
      g.strokeStyle = 'rgba(148,163,184,0.12)';
      g.lineWidth = 1;
      g.beginPath();
      for (let k = -half; k <= half; k++) {
        const t = PAD + (k * size + plot / 2) * scale;
        g.moveTo(t, p0[1]);
        g.lineTo(t, p0[1] + side);
        g.moveTo(p0[0], t);
        g.lineTo(p0[0] + side, t);
      }
      g.stroke();
    }
    g.strokeStyle = 'rgba(148,163,184,0.35)';
    g.beginPath();
    const [ox, oz] = toPx({ x: 0, z: 0 });
    g.moveTo(ox, p0[1]);
    g.lineTo(ox, p0[1] + side);
    g.moveTo(p0[0], oz);
    g.lineTo(p0[0] + side, oz);
    g.stroke();

    // Other volumes, faintly.
    for (const o of others) {
      poly(partOutline(o));
      g.fillStyle = 'rgba(203,213,225,0.10)';
      g.fill();
    }

    // This volume: the stored outline, then the painted cells (red = left out, not connected).
    const outline = partOutline(part);
    // Cells of a rounded volume cover its rectangle: corner cells are not "left out".
    const cellArea = partBaseOutline(part);
    poly(outline);
    g.fillStyle = 'rgba(56,189,248,0.22)';
    g.fill();
    for (const k of cells) {
      const [i, j] = parseCell(k);
      const c = { x: (i + 0.5) * size, z: (j + 0.5) * size };
      const inside = pointInPolygon(c, cellArea);
      g.fillStyle = inside ? 'rgba(56,189,248,0.75)' : 'rgba(248,113,113,0.8)';
      const [x, y] = toPx({ x: i * size, z: j * size });
      g.fillRect(x + 0.5, y + 0.5, size * scale - 1, size * scale - 1);
    }
    poly(outline);
    g.strokeStyle = '#f8fafc';
    g.lineWidth = 2;
    g.stroke();
    g.lineWidth = 1;

    // Other volumes' outlines stay visible above the painted cells (for alignment).
    g.strokeStyle = 'rgba(226,232,240,0.85)';
    g.setLineDash([4, 3]);
    for (const o of others) {
      poly(partOutline(o));
      g.stroke();
    }
    g.setLineDash([]);

    if (rect) {
      const a = toPx({ x: Math.min(rect.a[0], rect.b[0]) * size, z: Math.min(rect.a[1], rect.b[1]) * size });
      const b = toPx({ x: (Math.max(rect.a[0], rect.b[0]) + 1) * size, z: (Math.max(rect.a[1], rect.b[1]) + 1) * size });
      g.fillStyle = rect.erase ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.3)';
      g.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      g.strokeStyle = rect.erase ? '#f87171' : '#4ade80';
      g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    }

    // Plot boundary and the front (+Z, road side).
    g.strokeStyle = '#fbbf24';
    g.lineWidth = 1.5;
    g.strokeRect(p0[0], p0[1], side, side);
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(p0[0], p0[1] + side);
    g.lineTo(p0[0] + side, p0[1] + side);
    g.stroke();
    g.lineWidth = 1;
    g.fillStyle = '#fbbf24';
    g.font = '600 12px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`▼ 정면 · 도로 쪽 (대지 ${plot}m)`, CSS / 2, CSS + FOOT / 2 - 2);
  });

  return (
    <div className="bp-painter">
      <div className="row wrap">
        <span className="muted">칸</span>
        <div className="chips">
          {SIZES.map((s) => (
            <button key={s} className={size === s ? 'active' : ''} onClick={() => setSize(s)}>
              {s}m
            </button>
          ))}
        </div>
        <div className="spacer" />
        <div className="chips">
          <button className={mode === 'brush' ? 'active' : ''} onClick={() => setMode('brush')}>
            브러시
          </button>
          <button className={mode === 'rect' ? 'active' : ''} onClick={() => setMode('rect')}>
            사각형
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="bp-canvas"
        style={{ width: CSS, height: CSS + FOOT }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="평면 그리기 격자"
      />
      <div className="muted">좌클릭 칠하기 · Shift 또는 우클릭 지우기 · 점선 = 다른 볼륨</div>
    </div>
  );
}
