// WebSocket protocol between apps/web and apps/server. JSON text frames.

import type { Command } from './commands.js';
import type { Vec2 } from './geometry.js';
import type { CityDoc } from './model.js';

/**
 * Bumped when clients of different versions must not edit together: v2 = rounded volumes (a v1 client
 * would ignore `round` and judge collisions on other outlines). The server refuses other versions.
 */
export const PROTOCOL_VERSION = 2;
/** Shown when the server refuses the client's protocol version (sent as `error` with code 'protocol'). */
export const PROTOCOL_MISMATCH = '앱을 새로고침하세요 — 버전이 다릅니다';
export const MAX_MESSAGE_BYTES = 512 * 1024;
export const ROOM_ID_RE = /^[a-z0-9-]{1,32}$/;
/** Longest invite password a `hello` may carry. */
export const MAX_INVITE_LENGTH = 128;

export const MAX_GHOST_POINTS = 64;
/** Longest request text the AI building assistant accepts. */
export const MAX_AI_TEXT = 1000;
/** Pictures that can accompany an AI request, and the largest decoded size of one (bytes). */
export const MAX_AI_IMAGES = 2;
export const MAX_AI_IMAGE_BYTES = 300_000;
export const AI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export interface AiImage {
  mediaType: (typeof AI_IMAGE_TYPES)[number];
  /** Base64 (no data: prefix). */
  data: string;
}

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
  /** `invite`: the server's invite password, required only when the server sets one (SC_INVITE_CODE). */
  | { t: 'hello'; protocol: number; room: string; name: string; invite?: string }
  /** `ref` is chosen by the client and echoed back in `applied`/`rejected`. */
  | { t: 'cmd'; ref: number; cmd: Command }
  | { t: 'presence'; presence: Presence }
  | { t: 'ping'; at: number }
  /** Ask the AI building assistant (ADR 0009 §5). `focus` = the point the user looks at or selected. */
  | { t: 'ai.ask'; reqId: number; text: string; focus: Vec2 | null; images?: AiImage[] }
  | { t: 'ai.cancel'; reqId: number };

export type ServerMessage =
  | { t: 'welcome'; clientId: string; tag: string; color: string; room: string; seq: number; doc: CityDoc; peers: Peer[] }
  | { t: 'applied'; seq: number; cmd: Command; by: string; ref?: number }
  | { t: 'rejected'; ref: number; error: string }
  | { t: 'peers'; peers: Peer[] }
  | { t: 'presence'; clientId: string; presence: Presence }
  /**
   * `code: 'protocol'` = refused hello of another protocol version: retrying cannot help, reload the app.
   * `code: 'auth'` = refused hello without the right invite password (or after too many wrong ones): ask the user.
   */
  | { t: 'error'; error: string; code?: 'protocol' | 'auth' }
  | { t: 'pong'; at: number }
  /** Sent on join: whether the assistant is available (server has an API key) and which model it uses. */
  | { t: 'ai.status'; enabled: boolean; model: string | null }
  | { t: 'ai.progress'; reqId: number; note: string }
  /** Only to the asker. Commands only add things; the client applies them as its own `cmd` batch after approval. */
  | { t: 'ai.proposal'; reqId: number; commands: Command[]; summary: string }
  | { t: 'ai.error'; reqId: number; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded size of a base64 string, or null when it is not canonical base64. */
function base64Bytes(data: string): number | null {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) return null;
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - pad;
}

function parseImages(v: unknown): AiImage[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_AI_IMAGES) return null;
  const out: AiImage[] = [];
  for (const raw of v) {
    if (!isObj(raw) || typeof raw.data !== 'string' || !(AI_IMAGE_TYPES as readonly unknown[]).includes(raw.mediaType)) return null;
    const bytes = base64Bytes(raw.data);
    if (bytes === null || bytes > MAX_AI_IMAGE_BYTES) return null;
    out.push({ mediaType: raw.mediaType as AiImage['mediaType'], data: raw.data });
  }
  return out;
}

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
      if (m.invite === undefined) return { t: 'hello', protocol: m.protocol, room: m.room, name: m.name.slice(0, 32) };
      if (typeof m.invite !== 'string' || m.invite.length > MAX_INVITE_LENGTH) return null;
      return { t: 'hello', protocol: m.protocol, room: m.room, name: m.name.slice(0, 32), invite: m.invite };
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
    case 'ai.ask': {
      if (!Number.isInteger(m.reqId) || typeof m.text !== 'string') return null;
      const text = m.text.trim();
      if (text.length === 0 || text.length > MAX_AI_TEXT) return null;
      let focus: Vec2 | null = null;
      if (m.focus !== null && m.focus !== undefined) {
        if (!isObj(m.focus) || !isFiniteNum(m.focus.x) || !isFiniteNum(m.focus.z)) return null;
        focus = { x: m.focus.x, z: m.focus.z };
      }
      if (m.images === undefined) return { t: 'ai.ask', reqId: m.reqId as number, text, focus };
      const images = parseImages(m.images);
      return images ? { t: 'ai.ask', reqId: m.reqId as number, text, focus, images } : null;
    }
    case 'ai.cancel':
      return Number.isInteger(m.reqId) ? { t: 'ai.cancel', reqId: m.reqId as number } : null;
    default:
      return null;
  }
}
