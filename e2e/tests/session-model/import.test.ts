import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { closeDatabase, getConversation, openDatabase } from '../../../apps/daemon/src/db.js';
import { registerDataImportRoutes } from '../../../apps/daemon/src/data-import-routes.js';
// Exercise the daemon's actual router with its own declared dependencies.
const daemonRequire = createRequire(new URL('../../../apps/daemon/package.json', import.meta.url));
const express = daemonRequire('express');
const Sqlite = daemonRequire('better-sqlite3');

it('[P0] accepts a populated v1 legacy source through the import API, copies it once, and opens the imported database at v2', async () => {
  const base = path.resolve('../.tmp/session-model-import');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'case-'));
  const sourceRoot = path.join(root, 'old');
  const sourceData = path.join(sourceRoot, 'ReadableStudioData/namespaces/model/data');
  const appRoot = path.join(root, 'new');
  const dataRoot = path.join(appRoot, 'ReadableStudioData/namespaces/model/data');
  let server: Server | undefined;
  try {
    await mkdir(sourceData, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    const file = path.join(sourceData, 'app.sqlite');
    const source = new Sqlite(file);
    try {
      // Schema-only fixture taken from the real 1.1.5 database, with synthetic rows.
      source.exec(await readFile(new URL('../../../apps/packaged/tests/fixtures/data-import-schema.sql', import.meta.url), 'utf8'));
      source.exec(`PRAGMA application_id=1381192772; PRAGMA user_version=1;
        INSERT INTO projects(id,name,metadata_json,created_at,updated_at) VALUES('p','Preserved project','{}',1,1);
        INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES('c','p','Preserved session',1,1);
        INSERT INTO message_snapshots(id,conversation_id,role,content,position,created_at) VALUES('m','c','user','Preserved message',0,1);
        INSERT INTO agent_sessions(conversation_id,agent_id,session_id,updated_at) VALUES('c','codex','preserved-resume-id',1);`);
    } finally { source.close(); }
    const before = await readFile(file);
    const app = express();
    app.use(express.json());
    registerDataImportRoutes(app, { appRoot, dataRoot, namespace: 'model' });
    const listening = createServer(app);
    server = listening;
    const ready = once(listening, 'listening');
    listening.listen(0, '127.0.0.1');
    await ready;
    const address = listening.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const url = `http://127.0.0.1:${address.port}/api/data-import`;
    const candidates = await fetch(`${url}/candidates`);
    expect(candidates.status).toBe(200);
    expect(await candidates.json()).toMatchObject({ state: 'offered', candidates: [{ projectCount: 1 }] });
    const requested = await fetch(`${url}/request`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'import', from: sourceRoot }) });
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({ state: 'pending', restartRequired: true });
    const importData = async (): Promise<{ status: string; rowCounts?: Record<string, number> }> => {
      // Run the real packaged copier in Node 24, without importing its Node-24
      // SQLite declarations into the e2e package's Node-20 type environment.
      const module = new URL('../../../apps/packaged/src/data-import.ts', import.meta.url).href;
      const script = `const { runPendingDataImport } = await import(${JSON.stringify(module)});
        const result = await runPendingDataImport({ ...${JSON.stringify({ appRoot, dataRoot })}, listProcessImages: async () => [] });
        process.stdout.write(JSON.stringify({ status: result.status, rowCounts: result.rowCounts }));`;
      const { stdout } = await promisify(execFile)(process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 15_000 });
      return JSON.parse(stdout) as { status: string; rowCounts?: Record<string, number> };
    };
    const imported = await importData();
    expect(imported.status).toBe('done');
    expect(imported.rowCounts).toMatchObject({ projects: 1, conversations: 1, message_snapshots: 1, agent_sessions: 1 });
    const migrated = openDatabase(appRoot, { dataDir: dataRoot });
    expect(migrated.pragma('user_version', { simple: true })).toBe(2);
    expect(migrated.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(getConversation(migrated, 'c')).toMatchObject({ title: 'Preserved session', selection: null });
    expect(migrated.prepare('SELECT content FROM messages').pluck().get()).toBe('Preserved message');
    const snapshot = new Sqlite(path.join(dataRoot, 'app.sqlite.pre-1'), { readonly: true });
    try {
      expect(snapshot.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
      expect(snapshot.prepare('SELECT content FROM message_snapshots').get()?.content).toBe('Preserved message');
    } finally { snapshot.close(); }
    expect(await readFile(file)).toEqual(before);
    expect((await importData()).status).toBe('none');
  } finally {
    closeDatabase();
    if (server) await new Promise<void>((resolve, reject) => {
      server!.close(error => error ? reject(error) : resolve());
      server!.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
