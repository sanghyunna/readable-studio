import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabricksClient, resolveDatabricksCli, resolveDatabricksExecutable } from '../../src/databricks/client.js';
import { createDatabricksService } from '../../src/databricks/service.js';
import { databricksPublic } from '../../src/databricks-routes.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'databricks-resolution-')); roots.push(root);
  const bundled = join(root, 'resources', 'app', 'vendor', 'databricks', 'databricks.exe');
  const installed = join(root, 'user tools', 'databricks.exe');
  const override = join(root, 'custom tools', 'databricks.exe');
  for (const file of [bundled, installed, override]) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, 'fixture'); }
  const options = { env: { PATH: [dirname(installed)].join(delimiter), READABLE_RESOURCE_ROOT: join(root, 'resources', 'readable-studio') }, userToolchainBins: [],
    runner: async () => ({ stdout: 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 }) };
  return { root, bundled, installed, override, options };
}

describe('portable Databricks CLI selection', () => {
  it('prefers an explicit override, then user PATH, then the bundled CLI on a machine without a CLI', async () => {
    const { override, installed, bundled, options } = await layout();
    expect(await resolveDatabricksCli(override, options)).toEqual({ path: override, source: 'override' });
    expect(await resolveDatabricksCli(null, options)).toEqual({ path: installed, source: 'path' });
    options.env.PATH = '';
    expect(await resolveDatabricksCli(null, options)).toEqual({ path: bundled, source: 'bundled' });
    expect(await resolveDatabricksExecutable(null, options)).toBe(bundled);
    await rm(bundled);
    expect(await resolveDatabricksCli(null, options)).toBeNull();
  });

  it('does not silently replace an invalid explicit override', async () => {
    const { options } = await layout();
    await expect(resolveDatabricksCli('relative.cmd', options)).rejects.toMatchObject({ code: 'DATABRICKS_CLI_UNSUPPORTED' });
  });

  it.each(['override', 'path', 'bundled'] as const)('reports %s through the service and public status without exposing paths', async (source) => {
    const { root, override, installed, bundled, options } = await layout();
    if (source === 'bundled') options.env.PATH = '';
    const chosen = source === 'override' ? override : source === 'path' ? installed : bundled;
    const client = new DatabricksClient({
      executablePath: source === 'override' ? override : null,
      resolveExecutable: (value) => resolveDatabricksCli(value, options),
      runner: async (executable, args) => {
        expect(executable).toBe(chosen);
        return { stdout: args[0] === '--version' ? 'Databricks CLI v1.10.0' : '{"profiles":[]}', stderr: '', exitCode: 0 };
      },
    });
    const service = createDatabricksService({ dataRoot: join(root, 'data'), client });
    const status = databricksPublic.status(await service.status());
    expect(status).toMatchObject({ cli: 'ready', version: '1.10.0', cliSource: source });
    expect(JSON.stringify(status)).not.toContain(chosen);
  });
});
