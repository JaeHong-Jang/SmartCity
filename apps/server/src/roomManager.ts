import { loadRoom } from './persistence.js';
import { Room } from './room.js';

export class RoomManager {
  private rooms = new Map<string, Room>();

  constructor(
    private readonly dataDir: string,
    private readonly unloadMs = 60_000,
  ) {}

  get(id: string): Room {
    let room = this.rooms.get(id);
    if (!room) {
      const { doc, seq, stale, migrated } = loadRoom(this.dataDir, id);
      room = new Room(id, this.dataDir, doc, seq);
      room.stale = stale;
      // A migrated city is written at the current version right away (atomically, with the usual backup
      // of the old file), so an older server refuses it rather than replaying newer commands. If that
      // fails, the room still opens but refuses commands until the write succeeds (Room.commit retries).
      // A room without any checkpoint yet writes one before its first command, not on a mere visit.
      if (migrated) room.stampVersion();
      this.rooms.set(id, room);
    }
    return room;
  }

  /** Call after a client leaves; unloads the room unloadMs after it becomes empty. */
  scheduleUnload(room: Room): void {
    if (room.clients.size > 0 || room.unloadTimer) return;
    room.unloadTimer = setTimeout(() => {
      room.unloadTimer = null;
      if (room.clients.size > 0) return;
      room.dispose();
      room.checkpoint();
      this.rooms.delete(room.id);
    }, this.unloadMs);
    room.unloadTimer.unref();
  }

  stats(): { rooms: number; clients: number } {
    let clients = 0;
    for (const r of this.rooms.values()) clients += r.clients.size;
    return { rooms: this.rooms.size, clients };
  }

  shutdown(): void {
    for (const room of this.rooms.values()) {
      room.dispose();
      room.checkpoint();
    }
    this.rooms.clear();
  }
}
