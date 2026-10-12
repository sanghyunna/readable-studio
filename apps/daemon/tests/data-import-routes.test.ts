import { afterEach, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import type { DataImportCandidatesResponse } from '@readable-studio/contracts';
import express from 'express';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { openDatabase, closeDatabase, insertProject } from '../src/db.js';
import { registerDataImportRoutes, type DataImportRouteOptions } from '../src/data-import-routes.js';
const roots: string[]=[]; const servers: Server[]=[];
afterEach(async()=>{closeDatabase();await Promise.all(servers.splice(0).map(server=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(processOptions: Pick<DataImportRouteOptions, 'listProcesses' | 'terminateProcess'> = {}) {
  const base=path.resolve('../../.tmp/data-import-route-tests'); await mkdir(base,{recursive:true});
  const root=await mkdtemp(path.join(base,'case-'));roots.push(root);
  const sourceRoot=path.join(root,'old');const sourceData=path.join(sourceRoot,'ReadableStudioData/namespaces/test/data');
  const appRoot=path.join(root,'new');const dataRoot=path.join(appRoot,'ReadableStudioData/namespaces/test/data');
  await mkdir(sourceData,{recursive:true});await mkdir(dataRoot,{recursive:true});
  const db=openDatabase(sourceData,{dataDir:sourceData});insertProject(db,{id:'p',name:'Old work',createdAt:1,updatedAt:1});db.pragma('user_version=0');closeDatabase();
  const app=express();app.use(express.json());registerDataImportRoutes(app,{dataRoot,appRoot,namespace:'test',...processOptions});
  const server=app.listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');
  const address=server.address();if(!address||typeof address==='string')throw new Error('no address');
  const url=`http://127.0.0.1:${address.port}/api/data-import`;
  return {root,sourceRoot,sourceData,dataRoot,url};
}
it('reports the failed source and lets the CLI stop only that source and request a retry',async()=>{
  let rows: Array<{pid:number;executablePath:string}>=[];
  const terminateProcess=vi.fn(async(target:{pid:number;executablePath:string})=>{rows=rows.filter(row=>row.pid!==target.pid);});
  const f=await fixture({listProcesses:async()=>rows,terminateProcess});
  rows=[{pid:100,executablePath:path.join(f.sourceRoot,'app','Readable Studio.exe')},{pid:200,executablePath:path.join(f.root,'old-other','app.exe')},{pid:process.pid,executablePath:path.join(f.sourceRoot,'self.exe')}];
  await writeFile(path.join(f.dataRoot,'data-import.json'),JSON.stringify({state:'failed',error:'SOURCE_RUNNING: blocked',sourceRoot:f.sourceRoot,sourceData:f.sourceData}));
  const status=await(await fetch(`${f.url}/candidates`)).json() as DataImportCandidatesResponse;
  expect(status.runningSource).toEqual({sourceRoot:f.sourceRoot,sourceData:f.sourceData,processes:[rows[0]]});
  const post=(from:string)=>fetch(`${f.url}/request`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'stop-source',from})});
  expect((await post(path.join(f.root,'old-other'))).status).toBe(409);
  expect(terminateProcess).not.toHaveBeenCalled();
  // Execute the actual CLI command against the real endpoint, not a mock route.
  const source=readFileSync(new URL('../src/cli.ts',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function runDataImport('),source.indexOf('\nasync function runVersion('));
  const output=vi.fn();
  const cliFetch=vi.fn(fetch);
  const context=vm.createContext({fetch:cliFetch,console,process:{stdout:{write:output}},
    parseFlags:(_args:unknown,options:{boolean:Set<string>})=>{expect(options.boolean.has('stop-source')).toBe(true);return {from:f.sourceRoot,json:true,'stop-source':true};},
    positionalArgs:()=>['import'],cliDaemonBaseUrl:async()=>f.url.replace('/api/data-import',''),
    structuredHttpFailure:()=>{throw new Error('CLI request failed');},
  });
  await vm.runInContext(code+'\nrunDataImport([])',context);
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual({state:'pending',restartRequired:true});
  expect(terminateProcess.mock.calls.map(([row])=>row.pid)).toEqual([100]);
  expect(rows.map(row=>row.pid)).toEqual([200,process.pid]);
  expect(JSON.parse(await readFile(path.join(f.dataRoot,'data-import.json'),'utf8'))).toMatchObject({state:'pending',sourceRoot:f.sourceRoot,sourceData:f.sourceData});
  expect(JSON.parse(await readFile(path.join(f.dataRoot,'data-import.json'),'utf8'))).not.toHaveProperty('restartRequested');
  expect(cliFetch.mock.calls.map(([url])=>String(url))).toEqual([`${f.url}/candidates`,`${f.url}/request`]);
});
it('refuses to stop a source containing the current application',async()=>{
  const terminateProcess=vi.fn();const f=await fixture({listProcesses:async()=>[],terminateProcess});
  await writeFile(path.join(f.dataRoot,'data-import.json'),JSON.stringify({state:'failed',error:'SOURCE_RUNNING',sourceRoot:f.root,sourceData:f.sourceData}));
  expect((await fetch(`${f.url}/request`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'stop-source',from:f.sourceData})})).status).toBe(409);
  expect(terminateProcess).not.toHaveBeenCalled();
});
it('blocks the import request while its source runs, then queues only after stopping it',async()=>{
  let rows: Array<{pid:number;executablePath:string}>=[];
  const terminateProcess=vi.fn(async()=>{rows=[];});
  const f=await fixture({listProcesses:async()=>rows,terminateProcess});
  rows=[{pid:100,executablePath:path.join(f.sourceRoot,'Readable Studio.exe')}];
  const post=(action:string)=>fetch(`${f.url}/request`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,from:f.sourceRoot})});
  const blocked=await post('import');
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({code:'SOURCE_RUNNING',runningSource:{sourceRoot:f.sourceRoot,sourceData:f.sourceData,processes:rows}});
  const marker=JSON.parse(await readFile(path.join(f.dataRoot,'data-import.json'),'utf8'));
  expect(marker).toMatchObject({state:'failed',sourceRoot:f.sourceRoot});
  expect(marker).not.toHaveProperty('restartRequested');
  expect((await post('restart')).status).toBe(409);
  expect(await(await post('stop-source')).json()).toEqual({state:'pending',restartRequired:true});
  expect(terminateProcess).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(path.join(f.dataRoot,'data-import.json'),'utf8'))).not.toHaveProperty('restartRequested');
});
it('returns the running source as structured CLI JSON without requesting restart',async()=>{
  let rows: Array<{pid:number;executablePath:string}>=[];
  const f=await fixture({listProcesses:async()=>rows});
  rows=[{pid:100,executablePath:path.join(f.sourceRoot,'Readable Studio.exe')}];
  const source=readFileSync(new URL('../src/cli.ts',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function runDataImport('),source.indexOf('\nasync function runVersion('));
  const output=vi.fn(); const errors=vi.fn(); const cliFetch=vi.fn(fetch);
  const cliProcess={stdout:{write:output},stderr:{write:errors},exitCode:0};
  const context=vm.createContext({fetch:cliFetch,console,process:cliProcess,
    parseFlags:()=>({from:f.sourceRoot,json:true}),positionalArgs:()=>['import'],
    cliDaemonBaseUrl:async()=>f.url.replace('/api/data-import',''),
    structuredHttpFailure:()=>{throw new Error('Unstructured CLI failure');},
  });
  await vm.runInContext(code+'\nrunDataImport([])',context);
  expect(JSON.parse(errors.mock.calls[0]![0])).toMatchObject({error:{code:'SOURCE_RUNNING',data:{runningSource:{sourceRoot:f.sourceRoot,sourceData:f.sourceData,processes:rows}}}});
  expect(cliProcess.exitCode).toBe(1);
  expect(output).not.toHaveBeenCalled();
  expect(cliFetch.mock.calls.map(([url])=>String(url))).toEqual([`${f.url}/candidates`,`${f.url}/request`]);
  expect(JSON.parse(await readFile(path.join(f.dataRoot,'data-import.json'),'utf8'))).not.toHaveProperty('restartRequested');
});
it('lets the CLI cancel pending imports without requesting restart',async()=>{
  const f=await fixture();
  await writeFile(path.join(f.dataRoot,'data-import.json'),JSON.stringify({state:'pending',sourceRoot:f.sourceRoot,sourceData:f.sourceData,restartRequested:true}));
  const source=readFileSync(new URL('../src/cli.ts',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function runDataImport('),source.indexOf('\nasync function runVersion('));
  const output=vi.fn();const cliFetch=vi.fn(fetch);
  const context=vm.createContext({fetch:cliFetch,console,process:{stdout:{write:output}},
    parseFlags:(_args:unknown,options:{boolean:Set<string>})=>{expect(options.boolean.has('cancel')).toBe(true);return {cancel:true,json:true};},
    positionalArgs:()=>['import'],cliDaemonBaseUrl:async()=>f.url.replace('/api/data-import',''),
    structuredHttpFailure:()=>{throw new Error('CLI request failed');},
  });
  await vm.runInContext(code+'\nrunDataImport([])',context);
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual({state:'declined',restartRequired:false});
  expect(cliFetch.mock.calls.map(([url])=>String(url))).toEqual([`${f.url}/request`]);
  await expect(readFile(path.join(f.dataRoot,'data-import.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it('discovers bounded siblings from copies, records decline, and never offers again',async()=>{
  const f=await fixture();const digest=async()=>createHash('sha256').update(await readFile(path.join(f.sourceData,'app.sqlite'))).digest('hex');const before=await digest();
  const offer=await (await fetch(`${f.url}/candidates`)).json() as DataImportCandidatesResponse;expect(offer.state).toBe('offered');expect(offer.candidates).toHaveLength(1);expect(offer.candidates[0]?.projectCount).toBe(1);expect(await digest()).toBe(before);
  const response=await fetch(`${f.url}/request`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'decline'})});expect(response.status).toBe(200);
  expect(await (await fetch(`${f.url}/candidates`)).json()).toEqual({state:'declined',candidates:[]});
});
it('records the exact selected source, then refuses a concurrent replacement',async()=>{
  const f=await fixture();await fetch(`${f.url}/candidates`);
  const post=(body:unknown)=>fetch(`${f.url}/request`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  expect(await (await post({action:'import',from:f.sourceRoot})).json()).toEqual({state:'pending',restartRequired:true});
  expect(JSON.parse(await readFile(path.join(f.dataRoot,'data-import.json'),'utf8'))).toMatchObject({state:'pending',sourceData:f.sourceData});
  expect((await post({action:'import',from:f.sourceRoot})).status).toBe(409);
  expect(await (await post({action:'decline'})).json()).toEqual({state:'declined',restartRequired:false});
  await expect(readFile(path.join(f.dataRoot,'data-import.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect((await (await fetch(`${f.url}/candidates`)).json() as DataImportCandidatesResponse).state).toBe('offered');
  expect(await readFile(path.join(f.sourceData,'app.sqlite'))).toBeDefined();
  await expect(readFile(path.join(f.dataRoot,'app.sqlite'))).rejects.toMatchObject({code:'ENOENT'});
});
it('requires a pending marker for restart and preserves the selected source when confirming',async()=>{
  const f=await fixture();
  const post=(body:unknown)=>fetch(`${f.url}/request`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  expect((await post({action:'restart'})).status).toBe(409);
  await post({action:'import',from:f.sourceRoot});
  const queued=JSON.parse(await readFile(path.join(f.dataRoot,'data-import.json'),'utf8'));
  expect(queued).not.toHaveProperty('restartRequested');
  expect(await (await post({action:'restart'})).json()).toEqual({state:'pending',restartRequired:true});
  expect(JSON.parse(await readFile(path.join(f.dataRoot,'data-import.json'),'utf8'))).toEqual({...queued,restartRequested:true});
  await writeFile(path.join(f.dataRoot,'data-import.json'),JSON.stringify({state:'done'}));
  for(const action of ['decline','restart','import']) expect((await post({action,from:f.sourceRoot})).status).toBe(409);
});
it('never reoffers after done or an earlier process offered',async()=>{
  const f=await fixture();
  for(const marker of [{state:'done'},{state:'offered',offeredBy:'old-process'}]){
    await writeFile(path.join(f.dataRoot,'data-import.json'),JSON.stringify(marker));
    const response=await(await fetch(`${f.url}/candidates`)).json() as DataImportCandidatesResponse;expect(response.candidates).toEqual([]);expect(response.state).not.toBe('offered');
  }
});
it('does not overwrite a destination with projects',async()=>{
  const f=await fixture();const db=openDatabase(f.dataRoot,{dataDir:f.dataRoot});insertProject(db,{id:'new',name:'New work',createdAt:1,updatedAt:1});closeDatabase();
  expect((await(await fetch(`${f.url}/candidates`)).json() as DataImportCandidatesResponse).state).toBe('unavailable');
  expect((await fetch(`${f.url}/request`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'import',from:f.sourceRoot})})).status).toBe(409);
});
