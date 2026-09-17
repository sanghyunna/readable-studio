import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDatabricksCli } from '../../src/databricks/client.js';
import { createDatabricksService } from '../../src/databricks/service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'databricks-refresh-'));
  roots.push(root);
  const bundled = join(root, 'resources', 'app', 'vendor', 'databricks', 'databricks.exe');
  await mkdir(dirname(bundled), { recursive: true });
  await writeFile(bundled, 'fixture');
  const runner = vi.fn(async (_executable: string, args: readonly string[]) => ({
    stdout: args[0] === '--version' ? 'Databricks CLI v1.10.0' : '{"profiles":[]}', stderr: '', exitCode: 0,
  }));
  const resolveExecutable = vi.fn(() => resolveDatabricksCli(null, {
    env: { PATH: join(root, 'absent-local-tools'), READABLE_RESOURCE_ROOT: join(root, 'resources', 'readable-studio') },
    userToolchainBins: [], runner,
  }));
  const clock = { now: 1_000 };
  const service = createDatabricksService({ dataRoot: join(root, 'data'), now: () => clock.now,
    clientOptions: { resolveExecutable, runner } });
  return { service, resolveExecutable, runner, clock };
}

describe('Databricks inspection refresh', () => {
  it('recovers the bundled CLI when refresh follows a failed first inspection', async () => {
    // Given a transient first-boot resolver failure cached by a status read.
    const { service, resolveExecutable } = await fixture();
    resolveExecutable.mockResolvedValueOnce(null);
    expect((await service.status()).cli).toBe('missing');
    // When detection explicitly refreshes.
    const status = await service.status({ refresh: true });
    // Then it re-inspects and selects the ready bundle without any local executable.
    expect(status).toMatchObject({ cli: 'ready', cliSource: 'bundled', enabledCount: 0 });
    expect(resolveExecutable).toHaveBeenCalledTimes(2);
  });

  it('reuses inspection when ordinary status reads repeat concurrently', async () => {
    // Given one service with no local executable.
    const { service, resolveExecutable } = await fixture();
    // When callers read status concurrently and then read it again.
    const statuses = await Promise.all([service.status(), service.status(), service.status()]);
    statuses.push(await service.status());
    // Then all reads share one bundled inspection.
    expect(statuses.map((status) => status.cliSource)).toEqual(['bundled', 'bundled', 'bundled', 'bundled']);
    expect(resolveExecutable).toHaveBeenCalledTimes(1);
  });

  it('re-inspects when the short-lived status cache expires', async () => {
    // Given a previously failed inspection and an advanced injected clock.
    const { service, resolveExecutable, clock } = await fixture();
    resolveExecutable.mockResolvedValueOnce(null);
    await service.status();
    clock.now += 5_000;
    // When an ordinary read arrives at expiry.
    const status = await service.status();
    // Then first-boot failure cannot survive for the process lifetime.
    expect(status).toMatchObject({ cli: 'ready', cliSource: 'bundled' });
    expect(resolveExecutable).toHaveBeenCalledTimes(2);
  });

  it('refreshes inspection when the profile rescan endpoint probes', async () => {
    // Given a failed first status inspection.
    const { service, resolveExecutable } = await fixture();
    resolveExecutable.mockResolvedValueOnce(null);
    await service.status();
    // When the profile rescan runs.
    await service.probe();
    // Then a subsequent ordinary status uses its recovered result.
    expect(await service.status()).toMatchObject({ cli: 'ready', cliSource: 'bundled' });
    expect(resolveExecutable).toHaveBeenCalledTimes(2);
  });
});
