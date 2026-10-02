import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['', 'example.com', 'localhost,127.0.0.1,[::1]'])('keeps web readiness and internal forwarding direct with dead proxies and NO_PROXY=%s', async (noProxy) => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(name)) delete env[name];
  Object.assign(env, { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: noProxy, NODE_USE_ENV_PROXY: '1' });
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./update-loopback-web.fixture.ts', import.meta.url))], { env, windowsHide: true, timeout: 25000 });
  const result = stdout.split(/\r?\n/).find(line => line.startsWith('{'));
  expect(JSON.parse(result!)).toMatchObject({ passed: true, readiness: true, webForwarding: true, daemonForwarding: true });
}, 30000);
