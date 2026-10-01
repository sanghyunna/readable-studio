import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { runPendingDataImport } from '../src/data-import.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const hash = (s: string | Buffer) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
async function treeHashes(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.filter(e => e.isFile() && e.name !== 'imported.json').map(async e => {
    const file = path.join(e.parentPath, e.name);
    return [path.relative(root,file), hash(await readFile(file))];
  })));
}
async function fixture() {
  const base = path.resolve('../../.tmp/data-import-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'case-')); roots.push(root);
  const sourceRoot = path.join(root, 'old');
  const sourceData = path.join(sourceRoot, 'ReadableStudioData/namespaces/rg/data');
  const dataRoot = path.join(root, 'new/ReadableStudioData/namespaces/rg/data');
  await mkdir(path.join(sourceData, 'projects/p'), { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  const db = new DatabaseSync(path.join(sourceData, 'app.sqlite'));
  // Schema-only fixture from the real 1.1.5 backup; no customer row values.
  db.exec(await readFile(new URL('./fixtures/data-import-schema.sql', import.meta.url), 'utf8'));
  db.exec(`PRAGMA application_id=1381192772; PRAGMA user_version=0;
    INSERT INTO projects(id,name,metadata_json,created_at,updated_at) VALUES('p','Project','{}',1,1);
    INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES('conv','p','Conversation',1,1);
    INSERT INTO preview_comments(id,project_id,conversation_id,file_path,element_id,selector,label,text,position_json,html_hint,note,status,created_at,updated_at) VALUES('c','p','conv','index.html','el','body','Comment','Keep this comment','{}','','Keep this note','open',1,1);`);
  const manifestPath = path.join(sourceData, 'checkpoints/projects/p/cp/manifest.json');
  const rootHash = hash(path.join(sourceData, 'projects/p'));
  const manifest = JSON.stringify({ schemaVersion: 1, projectId: 'p', checkpointId: 'cp', rootPathHash: rootHash, files: [] }, null, 2);
  await mkdir(path.dirname(manifestPath), { recursive: true }); await writeFile(manifestPath, manifest);
  db.prepare('INSERT INTO project_checkpoints(id,project_id,kind,manifest_path,root_path_hash,manifest_hash,file_count,total_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('cp','p','after_message',manifestPath,rootHash,hash(manifest),0,0,1);
  const sessionHash = createHash('sha256').update(JSON.stringify(['p','conv'])).digest('hex');
  const sessionPath = path.join(sourceData, 'databricks/sessions',sessionHash,'s.jsonl');
  await mkdir(path.dirname(sessionPath), { recursive: true }); await writeFile(sessionPath, JSON.stringify({type:'session',cwd:path.join(sourceData,'projects/p')})+'\n');
  db.prepare('INSERT INTO agent_sessions(conversation_id,agent_id,session_id,updated_at) VALUES(?,?,?,?)').run('conv','databricks',sessionPath,1);
  const bundled = path.join(sourceRoot, 'resources/readable-studio/plugins/example');
  db.prepare('INSERT INTO installed_plugins(id,title,version,source_kind,source,trust,capabilities_granted,manifest_json,fs_path,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('example','Example','1','bundled',bundled,'bundled','[]','{}',bundled,1,1);
  db.close();
  await writeFile(path.join(sourceData, 'projects/p/index.html'), 'saved work');
  await writeFile(path.join(dataRoot, 'fresh.txt'), 'fresh');
  const request = { state:'pending', sourceRoot, sourceData, requestedAt:new Date().toISOString() };
  await writeFile(path.join(dataRoot,'data-import.json'),JSON.stringify(request));
  return {root,sourceRoot,sourceData,dataRoot,sessionHash};
}
it('copies all rows, rebinds legacy checkpoints and sessions, leaves source bytes intact and runs once', async () => {
  const f = await fixture(); const before = await treeHashes(f.sourceRoot);
  const resourceRoot = path.join(f.root, 'new/.app/current/resources/readable-studio');
  const result = await runPendingDataImport({...f, resourceRoot, listProcessImages:async()=>[]});
  expect(result.status).toBe('done');
  const db = new DatabaseSync(path.join(f.dataRoot,'app.sqlite'));
  expect(db.prepare('SELECT COUNT(*) AS n FROM preview_comments').get()?.n).toBe(1);
  expect(db.prepare('SELECT fs_path FROM installed_plugins').get()?.fs_path).toBe(path.join(resourceRoot,'plugins/example'));
  const cp = db.prepare('SELECT * FROM project_checkpoints').get()!;
  const manifest = JSON.parse(await readFile(path.join(f.dataRoot,String(cp.manifest_path)), 'utf8'));
  expect(manifest.schemaVersion).toBe(2); expect(manifest.rootPathHash).toBe(hash('project:p'));
  const session = db.prepare('SELECT session_id FROM agent_sessions').get()!;
  expect(path.isAbsolute(String(session.session_id))).toBe(false);
  expect(await readFile(path.join(f.dataRoot,'databricks/sessions',f.sessionHash,String(session.session_id)), 'utf8')).toContain(f.dataRoot.replaceAll('\\','\\\\'));
  const counts = Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>[String(row.name),Number(db.prepare(`SELECT COUNT(*) AS n FROM "${row.name}"`).get()!.n)]));
  expect(result.rowCounts).toEqual(counts);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
  db.close(); expect(await treeHashes(f.sourceRoot)).toEqual(before);
  expect((await runPendingDataImport({...f,listProcessImages:async()=>[]})).status).toBe('none');
});
it('keeps fresh data and source untouched on mid-copy failure', async () => {
  const f = await fixture(); const before = await readFile(path.join(f.sourceData,'app.sqlite'));
  const result = await runPendingDataImport({...f,listProcessImages:async()=>[],afterCopyFile:()=>{throw new Error('injected copy failure');}});
  expect(result.status).toBe('failed'); expect(await readFile(path.join(f.dataRoot,'fresh.txt'),'utf8')).toBe('fresh');
  expect(await readFile(path.join(f.sourceData,'app.sqlite'))).toEqual(before);
  await expect(readFile(path.join(f.dataRoot,'app.sqlite'))).rejects.toMatchObject({code:'ENOENT'});
});
it('includes committed WAL rows without mutating source sidecars', async () => {
  const f = await fixture();
  const writer = new DatabaseSync(path.join(f.sourceData,'app.sqlite'));
  try {
    writer.exec("PRAGMA journal_mode=WAL; UPDATE preview_comments SET note='committed in WAL';");
    const before = await treeHashes(f.sourceRoot);
    expect((await runPendingDataImport({...f,listProcessImages:async()=>[]})).status).toBe('done');
    expect(await treeHashes(f.sourceRoot)).toEqual(before);
    const copy = new DatabaseSync(path.join(f.dataRoot,'app.sqlite'));
    try { expect(copy.prepare('SELECT note FROM preview_comments').get()?.note).toBe('committed in WAL'); } finally { copy.close(); }
  } finally { writer.close(); }
});
it('never cleans a source that aliases a staging directory', async () => {
  const f=await fixture(); const collision=`${f.dataRoot}.import-staging`;
  await rename(f.sourceData,collision);
  const before=await readFile(path.join(collision,'app.sqlite'));
  await writeFile(path.join(f.dataRoot,'data-import.json'),JSON.stringify({state:'pending',sourceRoot:path.dirname(f.dataRoot),sourceData:collision}));
  expect((await runPendingDataImport({...f,listProcessImages:async()=>[]})).status).toBe('failed');
  expect(await readFile(path.join(collision,'app.sqlite'))).toEqual(before);
});
it('never runs a declined request', async () => {
  const f = await fixture();
  await writeFile(path.join(f.dataRoot,'data-import.json'),JSON.stringify({state:'declined'}));
  expect((await runPendingDataImport({...f,listProcessImages:async()=>{throw new Error('must not inspect');}})).status).toBe('none');
});
it('recovers a crash between the two publication renames', async () => {
  const f=await fixture(); await rename(f.dataRoot,`${f.dataRoot}.import-empty`);
  expect((await runPendingDataImport({...f,listProcessImages:async()=>[]})).status).toBe('done');
});
it('requests a graceful host restart on an atomic pending marker write', async () => {
  const f=await fixture(); await writeFile(path.join(f.dataRoot,'data-import.json'),JSON.stringify({state:'declined'}));
  let signal!:()=>void;
  const restarted = new Promise<void>(resolve=>{signal=resolve;});
  const result=await runPendingDataImport({...f,onRestartRequested:signal});
  try {
    await writeFile(path.join(f.dataRoot,'request.tmp'),JSON.stringify({state:'pending'}));
    await rename(path.join(f.dataRoot,'request.tmp'),path.join(f.dataRoot,'data-import.json'));
    await restarted;
  } finally { result.stopWatching(); }
}, 5000);
it('detects an actual legacy process image under the source folder', async () => {
  const f=await fixture();const executable=path.join(f.sourceRoot,'legacy.exe');await copyFile(process.execPath,executable);
  const child=spawn(executable,['-e',"process.stdout.write('ready');process.stdin.resume()"],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exited=once(child,'exit');
  try {
    await once(child.stdout,'data');
    const result=await runPendingDataImport(f);
    expect(result.status).toBe('failed');expect(result.error?.startsWith('SOURCE_RUNNING:')).toBe(true);
  } finally { child.stdin.end();await exited; }
},20000);
it('refuses a legacy running image without relying on data.lock', async () => {
  const f=await fixture();
  expect((await runPendingDataImport({...f,listProcessImages:async()=>[path.join(f.sourceRoot,'Readable Studio.exe')]})).status).toBe('failed');
  expect(await readFile(path.join(f.dataRoot,'fresh.txt'),'utf8')).toBe('fresh');
});
