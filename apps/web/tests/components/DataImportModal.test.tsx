// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataImportModal } from '../../src/components/DataImportModal';
import { getEn } from '../../src/i18n/locales/en';
import { I18nProvider } from '../../src/i18n';
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
  expect(resolved).not.toHaveBeenCalled();expect(screen.queryAllByRole('button')).toHaveLength(2);
});
it('offers one primary recovery action, shows the source once, and automatically queues import after termination',async()=>{
  const runningSource={sourceRoot:candidate.sourceRoot,sourceData:candidate.sourceData,processes:[{pid:123,executablePath:'D:\\Old\\Readable Studio.exe'}]};
  const fetcher=vi.fn(async(_url:string,options?:RequestInit)=>reply(options?.method==='POST'?{state:'pending',restartRequired:true}:{state:'failed',candidates:[candidate],error:`SOURCE_RUNNING: ${candidate.sourceRoot} PID 123 D:\\Old\\Readable Studio.exe`,runningSource}));
  vi.stubGlobal('fetch',fetcher);
  const resolved=vi.fn();
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.getAllByText(candidate.sourceRoot)).toHaveLength(1);
  expect(screen.getByText('PID 123')).toBeTruthy();
  expect(screen.getByText(runningSource.processes[0]!.executablePath)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  const primary=screen.getByRole('dialog').querySelectorAll('button.primary');
  expect(primary).toHaveLength(1);
  expect(primary[0]!.textContent).toBe(getEn()['dataImport.stopSource']);
  await act(async()=>{fireEvent.click(primary[0]!);});
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({action:'stop-source',from:candidate.sourceData});
  expect(screen.queryAllByRole('button')).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(2); // stop-source itself queues pending import; no second import POST.
  expect(resolved).not.toHaveBeenCalled();
});
it.each([409,503])('keeps a single retry action after termination fails (%s)',async(status)=>{
  const runningSource={sourceRoot:candidate.sourceRoot,sourceData:candidate.sourceData,processes:[{pid:123,executablePath:'D:\\Old\\Readable Studio.exe'}]};
  const fetcher=vi.fn().mockResolvedValueOnce(reply({state:'failed',candidates:[],error:'SOURCE_RUNNING',runningSource}))
    .mockResolvedValueOnce(new Response(JSON.stringify({error:'Access denied'}),{status}))
    .mockResolvedValueOnce(reply({state:'pending',restartRequired:true}));
  vi.stubGlobal('fetch',fetcher);const resolved=vi.fn();
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  const primary=screen.getByRole('dialog').querySelector('button.primary')!;
  await act(async()=>{fireEvent.click(primary);});
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(primary.hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('dialog').querySelectorAll('button.primary')).toHaveLength(1);
  expect(resolved).not.toHaveBeenCalled();
  await act(async()=>{fireEvent.click(primary);});
  expect(fetcher.mock.calls.slice(1).map(call=>JSON.parse(String(call[1]?.body)))).toEqual([
    {action:'stop-source',from:candidate.sourceData},{action:'stop-source',from:candidate.sourceData},
  ]);
  expect(screen.queryAllByRole('button')).toHaveLength(2);expect(resolved).not.toHaveBeenCalled();
});
it.each(['pending','offered','failed'] as const)('waits indefinitely for the restart choice after %s',async(state)=>{
  vi.useFakeTimers();
  const runningSource=state==='failed'?{sourceRoot:candidate.sourceRoot,sourceData:candidate.sourceData,processes:[]}:undefined;
  const fetcher=vi.fn(async(_url:string,options?:RequestInit)=>reply(options?.method==='POST'?{state:'pending',restartRequired:true}:{state,candidates:[candidate],runningSource}));
  vi.stubGlobal('fetch',fetcher);const resolved=vi.fn();
  await act(async()=>{render(<I18nProvider initial="ko"><DataImportModal onResolved={resolved}/></I18nProvider>);});
  if(state!=='pending') await act(async()=>{fireEvent.click(screen.getAllByRole('button').at(-1)!);});
  const calls=fetcher.mock.calls.length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect(screen.getByRole('button',{name:'가져오지 않기'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'다시 시작하기'})).toBeTruthy();
  expect(resolved).not.toHaveBeenCalled();
});
it('requests restart exactly once even for repeated clicks and timer advancement',async()=>{
  vi.useFakeTimers();
  const fetcher=vi.fn(async()=>reply({state:'pending',candidates:[],restartRequired:true}));
  vi.stubGlobal('fetch',fetcher);
  await act(async()=>{render(<I18nProvider initial="ko"><DataImportModal onResolved={vi.fn()}/></I18nProvider>);});
  const restart=screen.getByRole('button',{name:'다시 시작하기'});
  await act(async()=>{fireEvent.click(restart);fireEvent.click(restart);});
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);fireEvent.click(restart);});
  expect(fetcher.mock.calls.slice(1).map(call=>JSON.parse(String((call as unknown as [string,RequestInit])[1]?.body)))).toEqual([{action:'restart'}]);
});
it('cancels the pending import before resolving and never requests restart',async()=>{
  vi.useFakeTimers();
  let pending=true;
  const fetcher=vi.fn(async(_url:string,options?:RequestInit)=>{
    if(options?.method==='POST'){
      expect(JSON.parse(String(options.body))).toEqual({action:'decline'});
      pending=false;return reply({state:'declined',restartRequired:false});
    }
    return reply({state:pending?'pending':'unavailable',candidates:[]});
  });
  vi.stubGlobal('fetch',fetcher);const resolved=vi.fn();
  await act(async()=>{render(<I18nProvider initial="ko"><DataImportModal onResolved={resolved}/></I18nProvider>);});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'가져오지 않기'}));});
  expect(pending).toBe(false);expect(resolved).toHaveBeenCalledOnce();
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('keeps pending choices available after a failed cancellation',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(reply({state:'pending',candidates:[]}))
    .mockResolvedValueOnce(new Response(JSON.stringify({error:'Cannot cancel'}),{status:409}));
  vi.stubGlobal('fetch',fetcher);const resolved=vi.fn();
  await act(async()=>{render(<I18nProvider initial="ko"><DataImportModal onResolved={resolved}/></I18nProvider>);});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'가져오지 않기'}));});
  expect(screen.getByRole('alert').textContent).toContain('Cannot cancel');
  expect(screen.getByRole('button',{name:'다시 시작하기'}).hasAttribute('disabled')).toBe(false);
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
