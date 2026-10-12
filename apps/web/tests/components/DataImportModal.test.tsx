// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataImportModal } from '../../src/components/DataImportModal';
import { getEn } from '../../src/i18n/locales/en';
const candidate={sourceRoot:'D:\\Old',sourceData:'D:\\Old\\ReadableStudioData\\namespaces\\rg\\data',projectCount:2,modifiedAt:'2026-09-28T00:00:00Z'};
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
function reply(body:unknown){return {ok:true,json:async()=>body};}
it('gates welcome until a decision, posts selected source, and remains gated for restart',async()=>{
  const resolved=vi.fn(); const fetcher=vi.fn(async(_url:string,options?:RequestInit)=>reply(options?.method==='POST'?{state:'pending',restartRequired:true}:{state:'offered',candidates:[candidate]}));vi.stubGlobal('fetch',fetcher);
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.getByRole('dialog')).toBeTruthy();expect(resolved).not.toHaveBeenCalled();
  const actions=screen.getAllByRole('button');
  await act(async()=>{fireEvent.click(actions.at(-1)!);});
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({action:'import',from:candidate.sourceData});
  expect(resolved).not.toHaveBeenCalled();expect(screen.queryAllByRole('button')).toHaveLength(0);
});
it('shows the blocked source and processes, and terminates that source before retrying',async()=>{
  const runningSource={sourceRoot:candidate.sourceRoot,sourceData:candidate.sourceData,processes:[{pid:123,executablePath:'D:\\Old\\Readable Studio.exe'}]};
  const fetcher=vi.fn(async(_url:string,options?:RequestInit)=>reply(options?.method==='POST'?{state:'pending',restartRequired:true}:{state:'failed',candidates:[],error:'SOURCE_RUNNING',runningSource}));
  vi.stubGlobal('fetch',fetcher);
  const resolved=vi.fn();
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.getByText(candidate.sourceRoot)).toBeTruthy();
  expect(screen.getByText(/123.*Readable Studio\.exe/)).toBeTruthy();
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:getEn()['dataImport.stopSource']}));});
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({action:'stop-source',from:candidate.sourceData});
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(resolved).not.toHaveBeenCalled();
});
it('records decline before allowing welcome',async()=>{
  const resolved=vi.fn();const fetcher=vi.fn(async(_url:string,options?:RequestInit)=>reply(options?.method==='POST'?{state:'declined',restartRequired:false}:{state:'offered',candidates:[candidate]}));vi.stubGlobal('fetch',fetcher);
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  await act(async()=>{fireEvent.click(screen.getAllByRole('button')[1]!);});
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({action:'decline'});expect(resolved).toHaveBeenCalledOnce();
});
it.each([502,200])('localizes non-JSON request failures instead of exposing parser text (%s)',async(status)=>{
  const resolved=vi.fn();const fetcher=vi.fn().mockResolvedValueOnce(reply({state:'offered',candidates:[candidate]}))
    .mockResolvedValueOnce(new Response('connect ECONNREFUSED',{status}));vi.stubGlobal('fetch',fetcher);
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  await act(async()=>{fireEvent.click(screen.getAllByRole('button').at(-1)!);});
  expect(screen.getByRole('alert').textContent).toBe(getEn()['dataImport.safeFailure']+getEn()['connection.reconnecting']);
  expect(resolved).not.toHaveBeenCalled();
});
it('does not show a modal or re-offer after import is done',async()=>{
  const resolved=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>reply({state:'done',candidates:[]})));
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.queryByRole('dialog')).toBeNull();expect(resolved).toHaveBeenCalledOnce();
});
it('stays invisible while the check is still in flight',async()=>{
  const resolved=vi.fn();vi.stubGlobal('fetch',vi.fn(()=>new Promise(()=>undefined)));
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.queryByRole('dialog')).toBeNull();expect(resolved).not.toHaveBeenCalled();
});
it('resolves instead of trapping the user when the body has no recognized state or candidates',async()=>{
  const resolved=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>reply({})));
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();expect(resolved).toHaveBeenCalledOnce();
});
it('keeps unreachable discovery invisible and retries without recording a permanent choice',async()=>{
  vi.useFakeTimers();
  const resolved=vi.fn();const fetcher=vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(reply({state:'done',candidates:[]}));
  vi.stubGlobal('fetch',fetcher);
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.queryByRole('dialog')).toBeNull();expect(resolved).not.toHaveBeenCalled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1_000);});
  expect(resolved).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([502,503,504,200])('does not offer legacy import for a non-JSON proxy response (%s)',async(status)=>{
  vi.useFakeTimers();
  const resolved=vi.fn();const fetcher=vi.fn().mockResolvedValueOnce(new Response('connect ECONNREFUSED',{status})).mockResolvedValue(reply({state:'offered',candidates:[candidate]}));
  vi.stubGlobal('fetch',fetcher);
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();expect(resolved).not.toHaveBeenCalled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1_000);});
  expect(screen.getByRole('dialog')).toBeTruthy();expect(fetcher).toHaveBeenCalledTimes(2);expect(resolved).not.toHaveBeenCalled();
});
