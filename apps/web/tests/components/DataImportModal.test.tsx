// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataImportModal } from '../../src/components/DataImportModal';
const candidate={sourceRoot:'D:\\Old',sourceData:'D:\\Old\\ReadableStudioData\\namespaces\\rg\\data',projectCount:2,modifiedAt:'2026-09-28T00:00:00Z'};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
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
it('records decline before allowing welcome',async()=>{
  const resolved=vi.fn();const fetcher=vi.fn(async(_url:string,options?:RequestInit)=>reply(options?.method==='POST'?{state:'declined',restartRequired:false}:{state:'offered',candidates:[candidate]}));vi.stubGlobal('fetch',fetcher);
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  await act(async()=>{fireEvent.click(screen.getAllByRole('button')[1]!);});
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({action:'decline'});expect(resolved).toHaveBeenCalledOnce();
});
it('does not show a modal or re-offer after import is done',async()=>{
  const resolved=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>reply({state:'done',candidates:[]})));
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.queryByRole('dialog')).toBeNull();expect(resolved).toHaveBeenCalledOnce();
});
it('resolves instead of trapping the user when the body has no recognized state or candidates',async()=>{
  const resolved=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>reply({})));
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();expect(resolved).toHaveBeenCalledOnce();
});
it('keeps discovery failure distinct from an empty workspace',async()=>{
  const resolved=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('unavailable');}));
  await act(async()=>{render(<DataImportModal onResolved={resolved}/>);});
  expect(screen.getByRole('alert')).toBeTruthy();expect(resolved).not.toHaveBeenCalled();
});
