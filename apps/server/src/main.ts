import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startServer } from './server.js';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 8780);
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(serverDir, 'data');

const server = await startServer({ port, dataDir });

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.close(); // checkpoints all rooms
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
