import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchRail } from '../../src/state/rail';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('treats a 200 body of {} as a failed rail read', async () => {
  vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({}));

  await expect(fetchRail()).resolves.toEqual({ ok: false, aborted: false });
});

it('treats a folder without a sessions array as a failed rail read', async () => {
  vi.mocked(globalThis.fetch).mockResolvedValue(
    jsonResponse({
      folders: [{ id: 'f', name: 'F', createdAt: 1, updatedAt: 1 }],
      recents: [],
    }),
  );

  await expect(fetchRail()).resolves.toEqual({ ok: false, aborted: false });
});

it('still returns ok:true with the same object for a valid rail body', async () => {
  const body = {
    folders: [{ id: 'f', name: 'F', createdAt: 1, updatedAt: 1, sessions: [] }],
    recents: [],
    generatedAt: 1,
  };
  vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(body));

  const result = await fetchRail();

  expect(result).toEqual({ ok: true, rail: body });
  expect(result.ok && result.rail).toBe(body);
});
