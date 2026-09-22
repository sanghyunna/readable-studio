import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

it('forwards only native geometry event names through the actual sandbox preload', () => {
  // Given the compiled production preload and the Electron IPC boundary.
  const ipcRenderer = new EventEmitter();
  const window = new EventTarget();
  const received: unknown[] = [];
  window.addEventListener('readable:layout-geometry', event => {
    if (event instanceof CustomEvent) received.push(event.detail);
  });
  const source = readFileSync(new URL('../../src/main/preload.cts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  runInNewContext(compiled.outputText, {
    exports: {}, process: { argv: [], platform: 'win32' }, window, CustomEvent,
    require: (name: string) => {
      expect(name).toBe('electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld: vi.fn() } };
    },
  });
  // When the real channel receives a batch, plus malformed/untrusted content.
  const events = ['resize', 'maximize', 'unmaximize', 'restore', 'display-metrics-changed'];
  ipcRenderer.emit('layout:geometry', {}, [...events, 'private-content', { width: 300 }]);
  ipcRenderer.emit('layout:geometry', {}, 'private-content');
  // Then only the fixed geometry reasons reach the renderer.
  expect(received).toEqual(events);
});
