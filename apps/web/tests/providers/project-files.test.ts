import { afterEach, expect, it, vi } from 'vitest';
import { fetchProjectFiles, fetchProjectFilesResponse } from '../../src/providers/project-files';
import { deferred } from '../helpers/deferred';

afterEach(() => { vi.unstubAllGlobals(); });

it('shares one request but independently readable bodies when consumers overlap', async () => {
  // Given: both the file pane and DESIGN.md status need the same project list.
  const response = deferred<Response>();
  const fetchMock = vi.fn(() => response.promise);
  vi.stubGlobal('fetch', fetchMock);
  // When: their requests overlap.
  const pane = fetchProjectFilesResponse('shared');
  const status = fetchProjectFilesResponse('shared');
  response.resolve(Response.json({ files: [] }));
  const [left, right] = await Promise.all([pane, status]);
  // Then: both bodies can be consumed without another HTTP request.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await left.json()).toEqual({ files: [] });
  expect(await right.json()).toEqual({ files: [] });
});

it('reads again when a previous request settled instead of retaining stale project files', async () => {
  // Given: an earlier project read completed.
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ files: [] }))
    .mockResolvedValueOnce(Response.json({ files: [{ name: 'new.md' }] }));
  vi.stubGlobal('fetch', fetchMock);
  await fetchProjectFiles('refresh');
  // When: the project is revisited after disk content changes.
  const files = await fetchProjectFiles('refresh');
  // Then: the current list is fetched, not a settled cache entry.
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(files.map(file => file.name)).toEqual(['new.md']);
});

it('allows a new request when an earlier transport failed', async () => {
  // Given: a disconnected daemon failed the first read.
  const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(Response.json({ files: [] }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(fetchProjectFilesResponse('retry')).rejects.toThrow('offline');
  // When: the next read runs after reconnection.
  const response = await fetchProjectFilesResponse('retry');
  // Then: failure was not cached.
  expect(response.ok).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('keeps simultaneous requests to different projects isolated', async () => {
  // Given: overlapping project switches.
  const fetchMock = vi.fn(async (url: string) => Response.json({ url }));
  vi.stubGlobal('fetch', fetchMock);
  // When: both project reads run concurrently.
  const [left, right] = await Promise.all([fetchProjectFilesResponse('left'), fetchProjectFilesResponse('right')]);
  // Then: they have different response bodies and requests.
  expect(await left.json()).toEqual({ url: '/api/projects/left/files' });
  expect(await right.json()).toEqual({ url: '/api/projects/right/files' });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
