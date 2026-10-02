import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

it('concurrent normal-close callers wait for the packaged shutdown hook before exiting', async () => {
  // Execute the shipped coordinator bodies; only native surfaces are replaced.
  const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  let shut');
  const end = source.indexOf('\n  desktop = await', start);
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
  const hook = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const exit = vi.fn();
  const app = Object.assign(new EventEmitter(), { quit() {} });
  const context = vm.createContext({
    options: { beforeShutdown: () => { entered.resolve(); return hook.promise; } },
    approvalLoop: null, shortcutLoop: null, secretStorage: null, ipcServer: null, desktop: null,
    disposeMenu() {}, removeDiagnosticsIpc() {}, crashEvidence: { dispose() {} },
    app, console, process: { exit },
  });
  const listenerStart = source.lastIndexOf('  app.on("before-quit", (event) => {');
  const listenerEnd = source.indexOf('\n  });', listenerStart) + '\n  });'.length;
  const listeners = ts.transpile(source.slice(listenerStart, listenerEnd), { target: ts.ScriptTarget.ES2022 });
  vm.runInContext(code + listeners + '\nglobalThis.quit = shutdownAndExit; globalThis.stop = shutdown;', context);
  const quit = context.quit as () => void;
  quit();
  await entered.promise;
  quit();
  const event = { preventDefault: vi.fn() };
  app.emit('before-quit', event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(exit).not.toHaveBeenCalled();
  hook.resolve();
  await (context.stop as () => Promise<void>)();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(exit).toHaveBeenCalledWith(0);
  const finishedEvent = { preventDefault: vi.fn() };
  app.emit('before-quit', finishedEvent);
  expect(finishedEvent.preventDefault).not.toHaveBeenCalled();
});
