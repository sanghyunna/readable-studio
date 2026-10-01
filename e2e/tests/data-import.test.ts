import { afterEach, expect, it } from 'vitest';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeDatabase, insertConversation, insertProject, openDatabase, upsertMessage } from '../../apps/daemon/src/db.js';
import { createProjectCheckpointService } from '../../apps/daemon/src/project-checkpoints.js';
import { resolvePortablePiSessionPath, validatePiSessionPath } from '../../apps/daemon/src/pi-rpc.js';
const roots:string[]=[];
afterEach(async()=>{closeDatabase();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const hash=(text:string)=>`sha256:${createHash('sha256').update(text).digest('hex')}`;
it('imports a v0 real-schema workspace, restores a legacy absolute checkpoint and validates Pi resume after the source moves away',async()=>{
  const base=path.resolve('../.tmp/data-import-integration');await mkdir(base,{recursive:true});
  const root=await mkdtemp(path.join(base,'가져오기-'));roots.push(root);
  const sourceRoot=path.join(root,'old');const sourceData=path.join(sourceRoot,'ReadableStudioData/namespaces/test/data');
  const dataRoot=path.join(root,'new/ReadableStudioData/namespaces/test/data');
  const projectsRoot=path.join(sourceData,'projects');const projectDir=path.join(projectsRoot,'p');
  await mkdir(projectDir,{recursive:true});await mkdir(dataRoot,{recursive:true});
  let db=openDatabase(sourceData,{dataDir:sourceData});
  insertProject(db,{id:'p',name:'Saved project',createdAt:1,updatedAt:1});
  insertConversation(db,{id:'conv',projectId:'p',title:'Conversation',createdAt:1,updatedAt:1});
  upsertMessage(db,'conv',{id:'m',role:'assistant',content:'Saved answer'});
  db.exec("INSERT INTO preview_comments(id,project_id,conversation_id,file_path,element_id,selector,label,text,position_json,html_hint,note,status,created_at,updated_at) VALUES('comment','p','conv','index.html','el','body','Comment','Preserved comment','{}','','Preserved note','open',1,1)");
  await writeFile(path.join(projectDir,'index.html'),'checkpoint content');
  const service=createProjectCheckpointService({db,dataDir:sourceData,projectsRoot});
  const checkpoint=await service.captureCheckpoint({projectId:'p',conversationId:'conv',messageId:'m',kind:'after_message'});
  const manifestPath=path.join(sourceData,'checkpoints/projects/p',checkpoint.id,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.schemaVersion=1;manifest.rootPathHash=hash(projectDir);
  const text=JSON.stringify(manifest,null,2);await writeFile(manifestPath,text);
  db.prepare('UPDATE project_checkpoints SET manifest_path=?,root_path_hash=?,manifest_hash=? WHERE id=?').run(manifestPath,manifest.rootPathHash,hash(text),checkpoint.id);
  const sessionHash=createHash('sha256').update(JSON.stringify(['p','conv'])).digest('hex');
  const sessionPath=path.join(sourceData,'databricks/sessions',sessionHash,'session.jsonl');await mkdir(path.dirname(sessionPath),{recursive:true});
  await writeFile(sessionPath,JSON.stringify({type:'session',cwd:projectDir})+'\n');
  db.prepare('INSERT INTO agent_sessions(conversation_id,agent_id,session_id,updated_at) VALUES(?,?,?,?)').run('conv','databricks',sessionPath,1);
  db.pragma('user_version=0');closeDatabase();
  await writeFile(path.join(dataRoot,'data-import.json'),JSON.stringify({state:'pending',sourceRoot,sourceData}));
  // Execute the pre-sidecar entry in its own Node 24 process, as startup does.
  // The e2e package's older Node type declarations do not define node:sqlite.
  const runnerUrl = new URL('../../apps/packaged/src/data-import.ts', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
    `import {runPendingDataImport} from ${JSON.stringify(runnerUrl)}; console.log(JSON.stringify(await runPendingDataImport({dataRoot:${JSON.stringify(dataRoot)},listProcessImages:async()=>[]})));`], { timeout: 10000 });
  const imported = JSON.parse(stdout) as { status: string };
  expect(imported.status).toBe('done');
  // Leaving the old directory available can hide stale-path defects.
  await rename(sourceRoot,`${sourceRoot}-retained`);
  db=openDatabase(dataRoot,{dataDir:dataRoot});expect(db.prepare('SELECT note FROM preview_comments').get()).toEqual({note:'Preserved note'});
  const newProjects=path.join(dataRoot,'projects');await writeFile(path.join(newProjects,'p/index.html'),'changed after import');
  const restored=await createProjectCheckpointService({db,dataDir:dataRoot,projectsRoot:newProjects}).rollback({projectId:'p',conversationId:'conv',targetMessageId:'m',targetCheckpointId:checkpoint.id,mode:'files_only',conflictPolicy:'overwrite'});
  expect(restored.fileChanges.modified).toBe(1);expect(await readFile(path.join(newProjects,'p/index.html'),'utf8')).toBe('checkpoint content');
  const session=db.prepare('SELECT session_id FROM agent_sessions').get() as {session_id:string};
  const sessionRoot=path.join(dataRoot,'databricks/sessions',sessionHash);
  const resolved=resolvePortablePiSessionPath(session.session_id,sessionRoot);
  expect(validatePiSessionPath(resolved,sessionRoot,path.join(newProjects,'p'),true)).toBe(resolved);
},20000);
