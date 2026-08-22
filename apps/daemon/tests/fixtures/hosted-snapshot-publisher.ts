import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  insertConversation,
  insertProject,
  upsertAgentSession,
} from '../../src/db.js';
import { createHostedRuntimeStorage } from '../../src/hosted-runtime-storage.js';
import {
  createHostedSnapshotStore,
  type HostedSnapshotFailpoint,
} from '../../src/hosted-snapshots.js';

const [runtimeRoot, userKey, storageKey, targetFailpoint] = process.argv.slice(2);
if (runtimeRoot == null || userKey == null || storageKey == null || targetFailpoint == null) {
  throw new Error(
    'usage: hosted-snapshot-publisher <runtimeRoot> <userKey> <storageKey> <failpoint>',
  );
}

const storage = createHostedRuntimeStorage({
  identity: { storageKey, userKey },
  runtimeRoot,
});
const now = Date.now();
insertProject(storage.database, {
  createdAt: now,
  id: 'snapshot-project',
  name: 'candidate',
  updatedAt: now,
});
insertConversation(storage.database, {
  createdAt: now,
  id: 'snapshot-conversation',
  projectId: 'snapshot-project',
  updatedAt: now,
});
const projectRoot = path.join(storage.roots.projectsRoot, 'snapshot-project');
const sessionPath = path.join(storage.roots.sessionsRoot, 'session.jsonl');
mkdirSync(projectRoot);
writeFileSync(path.join(projectRoot, 'state.txt'), 'candidate', 'utf8');
writeFileSync(
  sessionPath,
  `${JSON.stringify({ cwd: projectRoot, type: 'session' })}\n`,
  'utf8',
);
upsertAgentSession(storage.database, {
  agentId: 'pi',
  conversationId: 'snapshot-conversation',
  sessionId: sessionPath,
});

const snapshots = createHostedSnapshotStore({
  failpoint(name: HostedSnapshotFailpoint) {
    if (name === targetFailpoint) {
      writeFileSync(path.join(runtimeRoot, '.failpoint-hit'), name, 'utf8');
      process.kill(process.pid, 'SIGKILL');
    }
  },
  identity: { storageKey, userKey },
  runtimeRoot,
});

await snapshots.publish({
  quiesce: async () => {},
  storage,
});

writeFileSync(path.join(runtimeRoot, '.publisher-completed'), targetFailpoint, 'utf8');
throw new Error(`snapshot publisher did not reach failpoint: ${targetFailpoint}`);
