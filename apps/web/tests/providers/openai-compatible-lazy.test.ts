import { expect, it, vi } from 'vitest';

const adapter = vi.hoisted(() => ({ loaded: vi.fn() }));
vi.mock('../../src/providers/api-proxy', () => {
  adapter.loaded();
  return { streamProxyEndpoint: vi.fn() };
});

it('leaves the streaming adapter unloaded when only protocol detection is needed', async () => {
  // Given a fresh protocol module and an observable adapter initialization.
  vi.resetModules();
  adapter.loaded.mockClear();

  // When the Hub resolves an existing model's protocol.
  const { isOpenAICompatible } = await import('../../src/providers/openai-compatible');
  const compatible = isOpenAICompatible('gpt-4o', 'https://api.openai.com/v1');

  // Then protocol detection works without initializing message streaming.
  expect(compatible).toBe(true);
  expect(adapter.loaded).not.toHaveBeenCalled();
});
