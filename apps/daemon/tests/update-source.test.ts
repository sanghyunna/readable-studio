import { afterEach, expect, it, vi } from 'vitest';
import { acquireUpdateToken } from '../src/update-source.js';
import { DatabricksClient, DatabricksServiceError } from '../src/databricks/client.js';

afterEach(() => vi.restoreAllMocks());
it('distinguishes an authenticated workspace without the app from missing login', async () => {
  vi.spyOn(DatabricksClient.prototype, 'probe').mockResolvedValue({ cli: 'ready', version: '0.300.0', cliSource: 'bundled' });
  vi.spyOn(DatabricksClient.prototype, 'json').mockImplementation(async (args) => args[1] === 'profiles'
    ? { profiles: [{ name: 'DEFAULT', host: 'https://workspace.azuredatabricks.net' }] } : []);
  await expect(acquireUpdateToken('https://bogus-qa.invalid')).rejects.toMatchObject({ reason: 'app-not-accessible' });
});
it('finds the workspace by exact App URL across DEFAULT and configured CLI profiles', async () => {
  vi.spyOn(DatabricksClient.prototype, 'probe').mockResolvedValue({ cli: 'ready', version: '0.300.0', cliSource: 'bundled' });
  const calls: string[][] = [];
  const json = vi.spyOn(DatabricksClient.prototype, 'json').mockImplementation(async (args) => {
    calls.push([...args]);
    if (args[0] === 'auth' && args[1] === 'profiles') return { profiles: [
      { name: 'UPDATE', host: 'https://updates-workspace.azuredatabricks.net' },
      { name: 'DEFAULT', host: 'https://other-workspace.azuredatabricks.net' },
    ] };
    if (args[0] === 'apps') return args.includes('UPDATE') ? [{ url: 'https://updates.databricksapps.com/' }] : [];
    return { access_token: 'private-bearer', expiry: new Date(Date.now() + 3600000).toISOString() };
  });
  expect(await acquireUpdateToken('https://updates.databricksapps.com')).toEqual({ token: 'private-bearer', host: 'https://updates-workspace.azuredatabricks.net' });
  expect(calls.filter((args) => args[0] === 'apps').map((args) => args[3])).toEqual(['DEFAULT', 'UPDATE']);
  expect(json).toHaveBeenCalledWith(['auth', 'token', '--profile', 'UPDATE']);
});
it('returns the default workspace login target when no profile can authenticate', async () => {
  vi.spyOn(DatabricksClient.prototype, 'probe').mockResolvedValue({ cli: 'ready', version: '0.300.0', cliSource: 'bundled' });
  vi.spyOn(DatabricksClient.prototype, 'json').mockImplementation(async (args) => {
    if (args[1] === 'profiles') return { profiles: [{ name: 'DEFAULT', host: 'https://workspace.azuredatabricks.net' }] };
    throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
  });
  await expect(acquireUpdateToken('https://updates.databricksapps.com')).rejects.toMatchObject({ reason: 'not-logged-in', host: 'https://workspace.azuredatabricks.net' });
});
