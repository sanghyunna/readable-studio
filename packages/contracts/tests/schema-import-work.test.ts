import { afterEach, expect, it, vi } from 'vitest';

const { objectConstruction } = vi.hoisted(() => ({ objectConstruction: vi.fn() }));
vi.mock('zod', async (importOriginal) => {
  const original = await importOriginal<typeof import('zod')>();
  return {
    ...original,
    z: {
      ...original.z,
      object: (...args: Parameters<typeof original.z.object>) => {
        objectConstruction();
        return original.z.object(...args);
      },
    },
  };
});

afterEach(() => {
  vi.resetModules();
  objectConstruction.mockClear();
});

it.each([
  { name: 'manifest', load: () => import('../src/plugins/manifest.js'), eagerObjects: 0 },
  { name: 'marketplace', load: () => import('../src/plugins/marketplace.js'), eagerObjects: 0 },
  { name: 'installed', load: () => import('../src/plugins/installed.js'), eagerObjects: 0 },
  { name: 'apply', load: () => import('../src/plugins/apply.js'), eagerObjects: 8 },
  { name: 'context', load: () => import('../src/plugins/context.js'), eagerObjects: 8 },
])('defers $name field construction when only importing the module', async ({ load, eagerObjects }) => {
  // Given a fresh module graph and an observer of real Zod construction.
  vi.resetModules();
  // When a consumer imports manifest exports without parsing.
  await load();
  // Then only the context union's eight required discriminator objects are eager.
  expect(objectConstruction).toHaveBeenCalledTimes(eagerObjects);
});

it('defers storage field construction when only importing the module', async () => {
  // Given a fresh module graph.
  vi.resetModules();
  // When a consumer imports the persisted scan contract without parsing.
  await import('../src/api/agent-scan-storage.js');
  // Then models, diagnostics and fix actions remain unconstructed.
  expect(objectConstruction).not.toHaveBeenCalled();
});
