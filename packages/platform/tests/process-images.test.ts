import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { processesInsideRoot, stopProcessesInsideRoot } from '../src/process-images.js';

it('terminates only source-contained executable images, never self or sibling folders', async () => {
  const root = path.resolve('old');
  const source = { pid: 100, executablePath: path.join(root, 'app', 'Readable Studio.exe') };
  let rows = [source, { pid: 101, executablePath: path.join(root, 'app', 'node.exe') },
    { pid: process.pid, executablePath: path.join(root, 'self.exe') },
    { pid: 200, executablePath: path.resolve('old-other', 'app.exe') },
    { pid: 201, executablePath: path.resolve('new', 'app.exe') }];
  expect(processesInsideRoot(root, rows).map(row => row.pid)).toEqual([100, 101]);
  const terminate = vi.fn(async (target: typeof source) => { rows = rows.filter(row => row.pid !== target.pid); });
  const stopped = await stopProcessesInsideRoot(root, { list: async () => rows, terminate });
  expect(stopped.map(row => row.pid)).toEqual([100, 101]);
  expect(terminate.mock.calls.map(([target]) => target.pid)).toEqual([100, 101]);
  expect(rows.map(row => row.pid)).toEqual([process.pid, 200, 201]);
});
it('refuses retry when a source process remains or enumeration fails', async () => {
  const row = { pid: 100, executablePath: path.resolve('old', 'app.exe') };
  await expect(stopProcessesInsideRoot(path.resolve('old'), { list: async () => [row], terminate: async () => {} })).rejects.toThrow('still running');
  const terminate = vi.fn();
  await expect(stopProcessesInsideRoot(path.resolve('old'), { list: async () => { throw new Error('inspection denied'); }, terminate })).rejects.toThrow('inspection denied');
  expect(terminate).not.toHaveBeenCalled();
});
