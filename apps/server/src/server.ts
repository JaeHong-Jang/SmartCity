import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, ROOM_ID_RE, parseClientMessage } from '@smartcity/shared';
import type { ServerMessage } from '@smartcity/shared';
import { createHttpHandler } from './http.js';
import { Client, MAX_CLIENTS_PER_ROOM } from './room.js';
import type { Room } from './room.js';
import { RoomManager } from './roomManager.js';

export interface ServerOptions {
  port: number;
  dataDir: string;
  /** Time allowed for the first `hello` (default 5000). */
  helloTimeoutMs?: number;
  /** Idle time before an empty room is unloaded (default 60000). */
  unloadMs?: number;
  /** Static web root (default apps/web/dist next to this package). */
  webDist?: string;
}

const MAX_CONSECUTIVE_BAD = 20;

export function startServer(opts: ServerOptions): Promise<{ port: number; close(): Promise<void> }> {
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const webDist = opts.webDist ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  const rooms = new RoomManager(opts.dataDir, opts.unloadMs);
  const http = createServer(createHttpHandler(() => rooms.stats(), webDist));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  http.on('upgrade', (req, socket, head) => {
    let path = '';
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      /* fallthrough */
    }
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  function onConnection(ws: WebSocket): void {
    let room: Room | null = null;
    let client: Client | null = null;
    let bad = 0;

    const helloTimer = setTimeout(() => {
      console.log('[ws] closing connection: hello timeout');
      ws.close(4000, 'hello timeout');
    }, helloTimeoutMs);

    const fail = (error: string) => {
      send(ws, { t: 'error', error });
      if (++bad >= MAX_CONSECUTIVE_BAD) ws.close(1008, 'too many bad messages');
    };

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) return fail('binary frames not supported');
        const msg = parseClientMessage(data.toString());
        if (!msg) return fail('malformed message');
        bad = 0;

        if (!client || !room) {
          if (msg.t !== 'hello') return fail('expected hello');
          clearTimeout(helloTimer);
          if (msg.protocol !== PROTOCOL_VERSION) {
            send(ws, { t: 'error', error: `unsupported protocol ${msg.protocol}` });
            ws.close(1002, 'protocol');
            return;
          }
          if (!ROOM_ID_RE.test(msg.room)) {
            send(ws, { t: 'error', error: 'invalid room id' });
            ws.close(1008, 'invalid room');
            return;
          }
          const r = rooms.get(msg.room);
          if (r.clients.size >= MAX_CLIENTS_PER_ROOM) {
            send(ws, { t: 'error', error: 'room full' });
            ws.close(1013, 'room full');
            rooms.scheduleUnload(r);
            return;
          }
          room = r;
          client = new Client(ws, msg.name);
          r.join(client);
          return;
        }

        switch (msg.t) {
          case 'hello':
            return fail('already joined');
          case 'cmd':
            room.command(client, msg.ref, msg.cmd);
            return;
          case 'presence':
            room.presence(client, msg.presence);
            return;
          case 'ping':
            send(ws, { t: 'pong', at: msg.at });
            return;
        }
      } catch (e) {
        console.error(`[ws] handler error: ${(e as Error).message}`);
        send(ws, { t: 'error', error: 'internal error' });
      }
    });

    ws.on('error', (e) => console.error(`[ws] socket error: ${e.message}`));
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (room && client) {
        room.leave(client);
        rooms.scheduleUnload(room);
      }
    });
  }

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, () => {
      const port = (http.address() as AddressInfo).port;
      console.log(`[server] listening on :${port}, data=${opts.dataDir}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const c of wss.clients) c.terminate();
            rooms.shutdown();
            wss.close();
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}
