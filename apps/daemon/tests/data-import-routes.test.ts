import { afterEach, expect, it } from 'vitest';
import type { DataImportCandidatesResponse } from '@readable-studio/contracts';
import express from 'express';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { openDatabase, closeDatabase, insertProject } from '../src/db.js';
import { registerDataImportRoutes } from '../src/data-import-routes.js';
const roots: string[]=[]; const servers: Server[]=[];
afterEach(async()=>{closeDatabase();await Promise.all(servers.splice(0).map(server=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture() {
  const base=path.resolve('../../.tmp/data-import-route-tests'); await mkdir(base,{recursive:true});
  const root=await mkdtemp(path.join(base,'case-'));roots.push(root);
  const sourceRoot=path.join(root,'old');const sourceData=path.join(sourceRoot,'ReadableStudioData/namespaces/test/data');
  const appRoot=path.join(root,'new');const dataRoot=path.join(appRoot,'ReadableStudioData/namespaces/test/data');
  await mkdir(sourceData,{recursive:true});await mkdir(dataRoot,{recursive:true});
  const db=openDatabase(sourceData,{dataDir:sourceData});insertProject(db,{id:'p',name:'Old work',createdAt:1,updatedAt:1});db.pragma('user_version=0');closeDatabase();
  const app=express();app.use(express.json());registerDataImportRoutes(app,{dataRoot,appRoot,namespace:'test'});
  const server=app.listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');
  const address=server.address();if(!address||typeof address==='string')throw new Error('no address');
  const url=`http://127.0.0.1:${address.port}/api/data-import`;
  return {root,sourceRoot,sourceData,dataRoot,url};
}
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
  expect((await post({action:'decline'})).status).toBe(409);
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
