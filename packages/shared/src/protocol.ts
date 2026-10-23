// WebSocket protocol between apps/web and apps/server. JSON text frames.

import type { Command } from './commands.js';
import type { Vec2 } from './geometry.js';
import type { CityDoc } from './model.js';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 512 * 1024;
export const ROOM_ID_RE = /^[a-z0-9-]{1,32}$/;

export const MAX_GHOST_POINTS = 64;

/** Ephemeral per-user state shown to collaborators (not persisted, not part of the doc). */
export interface Presence {
  cursor: Vec2 | null;
  tool: string;
  /** Preview polyline of what the user is drawing right now. */
  ghost: Vec2[];
  /** Id of the selected entity, if any. */
  selection: string | null;
}

export interface Peer {
  clientId: string;
  name: string;
  color: string;
}

export type ClientMessage =
  | { t: 'hello'; protocol: number; room: string; name: string }
  /** `ref` is chosen by the client and echoed back in `applied`/`rejected`. */
  | { t: 'cmd'; ref: number; cmd: Command }
  | { t: 'presence'; presence: Presence }
  | { t: 'ping'; at: number };

export type ServerMessage =
  | { t: 'welcome'; clientId: string; tag: string; color: string; room: string; seq: number; doc: CityDoc; peers: Peer[] }
  | { t: 'applied'; seq: number; cmd: Command; by: string; ref?: number }
  | { t: 'rejected'; ref: number; error: string }
  | { t: 'peers'; peers: Peer[] }
  | { t: 'presence'; clientId: string; presence: Presence }
  | { t: 'error'; error: string }
  | { t: 'pong'; at: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Shape-check an untrusted client frame. Command contents are validated later by applyCommand.
 * Returns null for anything malformed.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'hello':
      if (!isFiniteNum(m.protocol) || typeof m.room !== 'string' || typeof m.name !== 'string') return null;
      return { t: 'hello', protocol: m.protocol, room: m.room, name: m.name.slice(0, 32) };
    case 'cmd':
      if (!Number.isInteger(m.ref) || !isObj(m.cmd) || typeof m.cmd.type !== 'string') return null;
      return { t: 'cmd', ref: m.ref as number, cmd: m.cmd as unknown as Command };
    case 'presence': {
      const p = m.presence;
      if (!isObj(p)) return null;
      const point = (v: unknown): Vec2 | null => (isObj(v) && isFiniteNum(v.x) && isFiniteNum(v.z) ? { x: v.x, z: v.z } : null);
      const cursor = p.cursor === null ? null : point(p.cursor);
      if (p.cursor !== null && !cursor) return null;
      if (typeof p.tool !== 'string' || !Array.isArray(p.ghost) || p.ghost.length > MAX_GHOST_POINTS) return null;
      const ghost: Vec2[] = [];
      for (const g of p.ghost) {
        const q = point(g);
        if (!q) return null;
        ghost.push(q);
      }
      if (p.selection !== null && typeof p.selection !== 'string') return null;
      const selection = typeof p.selection === 'string' ? p.selection.slice(0, 64) : null;
      return { t: 'presence', presence: { cursor, tool: p.tool.slice(0, 32), ghost, selection } };
    }
    case 'ping':
      return isFiniteNum(m.at) ? { t: 'ping', at: m.at } : null;
    default:
      return null;
  }
}
