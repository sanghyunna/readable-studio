import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

// Execute the entry's actual pre-window gates; replace only their dependencies.
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const gates = source.slice(source.indexOf('  const existingDesktop ='), source.indexOf('  // One-time import'));
it.each(['existing-focused', 'focus-failed'])('quits Electron after %s instead of abandoning a windowless main', async reason => {
  const release = vi.fn(); const quit = vi.fn(); const flush = vi.fn();
  const context = vm.createContext({
    namespace: 'test', console, paths: {}, dataLock: { release }, startupTiming: { flush },
    flushStartupTimingOnFailure: flush, app: { quit },
    inspectExistingPackagedDesktop: async () => ({ action: 'exit', reason }),
  });
  await vm.runInContext(`(async () => { ${gates}\n throw new Error('must not start runtime'); })()`, context);
  expect(release).toHaveBeenCalledOnce();
  expect(flush).toHaveBeenCalledOnce();
  expect(quit).toHaveBeenCalledOnce();
  expect(context.flushStartupTimingOnFailure).toBeNull();
});
