import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonCliDist = path.join(daemonRoot, 'dist', 'cli.js');

if (process.platform === 'win32') {
  const canonicalTemp = realpathSync.native(tmpdir());
  process.env.TEMP = canonicalTemp;
  process.env.TMP = canonicalTemp;
}

const TEST_ROOT_SYMBOL = Symbol.for('readable-studio.daemon.vitestRoot');

const globalState = globalThis as typeof globalThis & {
  [TEST_ROOT_SYMBOL]?: string;
};

if (!globalState[TEST_ROOT_SYMBOL]) {
  // SQLite's Windows journal paths need a short temporary-directory prefix.
  globalState[TEST_ROOT_SYMBOL] = mkdtempSync(path.join(tmpdir(), 'rdv-'));
  mkdirSync(path.join(globalState[TEST_ROOT_SYMBOL], 'data'));

  process.once('exit', () => {
    rmSync(globalState[TEST_ROOT_SYMBOL]!, { force: true, recursive: true });
  });
}

// Server paths are resolved at module import time. Force every daemon test
// process to use one isolated data directory before any test imports server.ts,
// so tests can never read or overwrite the developer's real repo `.readable-studio` data.
process.env.READABLE_DATA_DIR = path.join(globalState[TEST_ROOT_SYMBOL]!, 'data');
// Import fixtures must stay outside runtime data. Keep uploads isolated beneath
// the per-fork temp root without making that root the runtime data directory.
process.env.TEMP = globalState[TEST_ROOT_SYMBOL];
process.env.TMP = globalState[TEST_ROOT_SYMBOL];
process.env.TMPDIR = globalState[TEST_ROOT_SYMBOL];

// Publish/share endpoints shell out through READABLE_NODE_BIN + READABLE_BIN (dist/cli.js).
// The run-level global setup verifies the producer's source stamp before forks start.
process.env.READABLE_DAEMON_CLI_PATH = daemonCliDist;
