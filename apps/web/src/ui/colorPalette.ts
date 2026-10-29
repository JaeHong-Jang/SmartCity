// Shared color palette for the color pickers (building walls/roofs, vehicles, bus lines): the studio's
// curated wall/roof/accent colors plus vivid vehicle and line colors, HEX validation, recent colors.

import { ACCENT_COLORS, ROOF_COLORS, WALL_COLORS, type Swatch } from '../studio/palette';

export const PALETTE: Swatch[] = [
  ...WALL_COLORS,
  ...ROOF_COLORS,
  ...ACCENT_COLORS,
  { color: '#1f2937', name: '검정' },
  { color: '#c0c6cc', name: '은색' },
  { color: '#1e3a8a', name: '남색' },
  { color: '#d62828', name: '빨강' },
  { color: '#0f9d8f', name: '청록' },
  { color: '#84cc16', name: '연두' },
  { color: '#0ea5e9', name: '하늘' },
  { color: '#7c2d12', name: '고동' },
];

export const RECENT_MAX = 8;
export const RECENT_KEY = 'smartcity:recentColors';

/** "#abc", "abc", "#AABBCC" → "#aabbcc"; anything else → null. */
export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  return null;
}

/** Most recent first, no duplicates, at most RECENT_MAX. */
export function pushRecent(list: readonly string[], color: string): string[] {
  return [color, ...list.filter((c) => c !== color)].slice(0, RECENT_MAX);
}

/** localStorage can throw or be missing (private mode, blocked data): no recent colors then. */
export function loadRecent(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(v)) return [];
    return v.map((c) => (typeof c === 'string' ? normalizeHex(c) : null)).filter((c): c is string => !!c).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function saveRecent(storage: Pick<Storage, 'setItem'> | undefined, list: readonly string[]): void {
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Not remembered: the recent row starts empty next time.
  }
}
