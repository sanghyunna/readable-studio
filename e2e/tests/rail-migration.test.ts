import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { RAIL_V2_PROJECTS, writeRailV2Fixture } from '../lib/fixtures/rail-v2.js';
import { createSmokeSuite } from '@/smoke-suite';

test('migrates a v2 fixture into folders and standalone recent sessions exposed by /api/rail', async () => {
  const suite = await createSmokeSuite('rail-migration');
  await writeRailV2Fixture(suite.dataDir);

  await suite.with.toolsDev(async ({ webUrl }) => {
    const response = await fetch(`${webUrl}/api/rail`);
    expect(response.ok).toBe(true);
    const rail = await response.json() as {
      folders: Array<{ id: string; name: string; sessions: Array<{ id: string; workspaceId: string; folderId: string | null }> }>;
      recents: Array<{ id: string; workspaceId: string; folderId: string | null; title: string | null }>;
    };

    expect(rail.folders).toHaveLength(1);
    expect(rail.folders[0]).toMatchObject({ name: 'Migrated folder' });
    expect(rail.folders[0]?.sessions.map((session) => session.id).sort()).toEqual([
      'rail-v2-multi-a',
      'rail-v2-multi-b',
    ]);
    expect(rail.folders[0]?.sessions.every((session) =>
      session.workspaceId === RAIL_V2_PROJECTS.multi && session.folderId === rail.folders[0]?.id,
    )).toBe(true);

    expect(rail.recents).toEqual([
      expect.objectContaining({
        id: 'rail-v2-single',
        workspaceId: RAIL_V2_PROJECTS.single,
        folderId: null,
        title: 'Migrated standalone',
      }),
    ]);
    expect(rail.folders.flatMap((folder) => folder.sessions).some((session) =>
      session.workspaceId === RAIL_V2_PROJECTS.empty,
    )).toBe(false);
    await expect(access(join(suite.dataDir, 'app.sqlite.pre-2'))).resolves.toBeUndefined();
  });
}, 240_000);
