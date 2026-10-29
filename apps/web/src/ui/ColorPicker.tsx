// Color picker: a swatch button that opens a palette (named swatches, recent colors, the native
// picker and a HEX field). The value stays "#rrggbb" and every pick goes through onChange.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { loadRecent, normalizeHex, PALETTE, pushRecent, saveRecent } from './colorPalette';

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

const nameOf = (c: string): string | undefined => PALETTE.find((s) => s.color === c)?.name;

interface Props {
  value: string;
  onChange(color: string): void;
  /** What the color is for, e.g. "벽 색" (button and dialog labels). */
  label: string;
}

export function ColorPicker({ value, onChange, label }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = nameOf(value);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="color-trigger"
        data-color-trigger={label}
        aria-label={`${label} ${value}${name ? ` (${name})` : ''} — 팔레트 열기`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${label}: ${name ? `${name} ` : ''}${value}`}
        onClick={() => setOpen(!open)}
      >
        <span className="color-trigger-chip" style={{ background: value }} />
      </button>
      {open && (
        <Palette
          value={value}
          label={label}
          anchor={trigger.current}
          onChange={onChange}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}

function Palette({ value, label, anchor, onChange, onClose }: Props & { anchor: HTMLElement | null; onClose(refocus: boolean): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState<string[]>(() => loadRecent(storage()));
  const [hex, setHex] = useState(value);
  const [hexError, setHexError] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  /** Last value from the native picker (it fires on every move; remembered as recent on close). */
  const nativePick = useRef<string | null>(null);

  const remember = (c: string) => {
    const next = pushRecent(loadRecent(storage()), c);
    setRecent(next);
    saveRecent(storage(), next);
  };
  const pick = (c: string) => {
    nativePick.current = null;
    onChange(c);
    remember(c);
    onClose(true);
  };

  useEffect(
    () => () => {
      const c = nativePick.current;
      if (c) saveRecent(storage(), pushRecent(loadRecent(storage()), c));
    },
    [],
  );
  const commitHex = (): boolean => {
    const c = normalizeHex(hex);
    setHexError(!c);
    if (!c) return false;
    setHex(c);
    if (c !== value) {
      onChange(c);
      remember(c);
    }
    return true;
  };

  useEffect(() => setHex(value), [value]);

  // Below the button (above when there is no room), inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    setPos({ left, top });
  }, [anchor]);

  // Focus the palette once it is placed (a hidden element cannot take focus).
  const placed = pos !== null;
  useEffect(() => {
    if (placed) (box.current?.querySelector<HTMLElement>('.color-grid button.active') ?? box.current?.querySelector<HTMLElement>('.color-grid button'))?.focus();
  }, [placed]);

  // A press outside, a scroll of the panel under it or a resize closes it.
  useEffect(() => {
    const outside = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (box.current?.contains(t) || anchor?.contains(t))) return;
      onClose(false);
    };
    const resize = () => onClose(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', resize);
    };
  });

  const onKey = (e: KeyboardEvent) => {
    // Key presses stay in the dialog (no tool shortcuts or camera keys while picking). Key releases
    // are not stopped: a key held before the palette opened (W, Q, Shift) must still end its action.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose(true);
      return;
    }
    if (e.key === 'Tab') {
      // Tabbing past either end leaves the palette: close it, back on its button.
      const items = box.current ? Array.from(box.current.querySelectorAll<HTMLElement>('button, input')) : [];
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (edge && document.activeElement === edge) {
        e.preventDefault();
        onClose(true);
      }
    }
  };

  const swatch = (c: string, n?: string, key?: string) => (
    <button
      key={key ?? c}
      type="button"
      data-swatch={c}
      className={c === value ? 'active' : ''}
      style={{ background: c }}
      title={n ? `${n} ${c}` : c}
      aria-label={n ? `${n} ${c}` : c}
      aria-pressed={c === value}
      onClick={() => pick(c)}
    />
  );

  return createPortal(
    <div
      ref={box}
      className="panel color-pop"
      role="dialog"
      aria-label={`${label} 선택`}
      data-color-pop
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onKeyDown={onKey}
      onBlur={(e) => {
        // Focus moved to something outside (not the native picker, which keeps focus on its input).
        const to = e.relatedTarget;
        if (to && !box.current?.contains(to) && !anchor?.contains(to)) onClose(false);
      }}
    >
      <div className="color-head">
        <span className="color-current" style={{ background: value }} aria-hidden="true" />
        <div className="color-head-text">
          <b>{label}</b>
          <span className="muted">{nameOf(value) ?? '사용자 색'}</span>
        </div>
      </div>
      <div className="color-grid" role="group" aria-label="팔레트">
        {PALETTE.map((s) => swatch(s.color, s.name))}
      </div>
      {recent.length > 0 && (
        <>
          <div className="muted">최근 사용</div>
          <div className="color-grid" role="group" aria-label="최근 사용 색" data-recent>
            {recent.map((c) => swatch(c, nameOf(c), `r${c}`))}
          </div>
        </>
      )}
      <div className="row color-custom">
        <label className="row" title="브라우저 색 선택기">
          직접 선택
          <input
            type="color"
            value={value}
            aria-label={`${label} 직접 선택`}
            onChange={(e) => {
              nativePick.current = e.target.value;
              onChange(e.target.value);
            }}
          />
        </label>
        <input
          type="text"
          data-hex
          aria-label={`${label} HEX`}
          aria-invalid={hexError}
          className={hexError ? 'invalid' : ''}
          value={hex}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => {
            setHex(e.target.value);
            setHexError(false);
          }}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // No keypress: it would land on the refocused button and open the palette again.
            e.preventDefault();
            if (commitHex()) onClose(true);
          }}
        />
      </div>
      {hexError && <div className="color-error">#RRGGBB 형식으로 입력하세요 (예: #a5553f)</div>}
    </div>,
    document.body,
  );
}
