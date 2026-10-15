import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAppConfig, writeAppConfig } from '../src/app-config.js';

describe('design-system preference defaults', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'readable-ds-default-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns an explicit null design system for fresh data', async () => {
    expect((await readAppConfig(dataDir)).designSystemId).toBeNull();
  });

  it('returns null when a legacy config has no design-system preference', async () => {
    await writeFile(path.join(dataDir, 'app-config.json'), JSON.stringify({ onboardingCompleted: true }));
    expect((await readAppConfig(dataDir)).designSystemId).toBeNull();
  });

  it.each(['default', 'neutral-modern', 'user:chosen-brand', null])(
    'preserves the saved choice %s rather than guessing its provenance',
    async (designSystemId) => {
      await writeAppConfig(dataDir, { designSystemId });
      expect((await readAppConfig(dataDir)).designSystemId).toBe(designSystemId);
    },
  );
});
