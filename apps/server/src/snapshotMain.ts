// CLI for deploy/backup.sh: node --import tsx apps/server/src/snapshotMain.ts <dataDir> <outDir>
// Exit 1 = no consistent copy of some room: the caller must not make or rotate an archive.
import { runSnapshot } from './snapshot.js';

const [dataDir, out] = process.argv.slice(2);
if (!dataDir || !out) {
  console.error('usage: snapshotMain.ts <dataDir> <outDir>');
  process.exit(64);
}
process.exitCode = runSnapshot(dataDir, out);
