import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { probeAgentAuthStatus } from '../../src/runtimes/auth.js';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
import { configureDetectionStorage, detectAgents, _resetAgentDetectionCacheForTests } from '../../src/runtimes/detection.js';

let home: string;
let runner: string;
let bin: string;
const identity = { email: 'synthetic-user@example.invalid', orgId: 'synthetic-org-id', orgName: 'Synthetic Organization', projectsDirectory: '/synthetic/private-home', subscriptionType: 'synthetic-subscription' };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-auth-privacy-'));
  runner = join(home, 'probe.cjs');
  bin = join(home, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  writeFileSync(runner, `
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('synthetic-version'); process.exit(0); }
if (args[0] !== 'auth') process.exit(0);
const payload = { ...${JSON.stringify(identity)}, ...(process.env.SIGN_IN === 'unknown' ? {} : { loggedIn: process.env.SIGN_IN === 'true' }) };
console.log(JSON.stringify(payload));
if (process.env.AUTH_EXIT === '1') { console.error('Authentication required ' + JSON.stringify(payload)); process.exitCode = 1; }
`);
  writeFileSync(bin, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${runner}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${runner}' "$@"\n`);
  if (process.platform !== 'win32') chmodSync(bin, 0o755);
  _resetAgentDetectionCacheForTests();
});
afterEach(() => {
  _resetAgentDetectionCacheForTests();
  rmSync(home, { recursive: true, force: true });
});

test.each([
  ['true', '0', 'ok'], ['false', '0', 'missing'], ['false', '1', 'missing'], ['unknown', '0', 'unknown'], ['true', '1', 'unknown'],
])('retains only the boolean sign-in result for %s with exit %s', async (signedIn, exit, status) => {
  // Given a real auth subprocess returning synthetic personal fields.
  const def = { ...claudeAgentDef, authProbe: { args: [runner, 'auth'], timeoutMs: 3000 } };
  // When the auth boundary parses its output.
  const result = await probeAgentAuthStatus(def, process.execPath, { ...process.env, SIGN_IN: signedIn, AUTH_EXIT: exit });
  // Then no raw output, identity fields, or failure tails survive.
  expect(result).toEqual({ status });
});

test('excludes auth identity data from reported and persisted agent records', async () => {
  // Given a concrete route and a sign-in failure containing synthetic personal fields.
  const routes = join(home, 'routes.json');
  writeFileSync(routes, JSON.stringify({ routes: { 'synthetic-model': {} } }));
  configureDetectionStorage(home);
  // When real detection writes its completed scan.
  const agents = await detectAgents({ claude: {
    CLAUDE_BIN: bin, MMD_MODEL_ROUTES_FILE: routes, SIGN_IN: 'false', AUTH_EXIT: '1',
  } }, { enabledAgentIds: ['claude'], refresh: true });
  // Then neither API-facing results nor persisted records contain probe identity data.
  expect(agents[0]).toMatchObject({ available: false, authStatus: 'missing', version: 'synthetic-version', models: [] });
  const artifacts = [JSON.stringify(agents), readFileSync(join(home, 'agent-scan.json'), 'utf8')];
  for (const artifact of artifacts) {
    expect(artifact).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    for (const value of Object.values(identity)) expect(artifact).not.toContain(value);
  }
});
