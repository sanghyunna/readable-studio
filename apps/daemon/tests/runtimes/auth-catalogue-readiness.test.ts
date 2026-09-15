import { afterAll, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import { cursorAgentDef } from '../../src/runtimes/defs/cursor-agent.js';

const home = mkdtempSync(join(tmpdir(), 'auth-catalogue-'));
const runner = join(home, 'fixture.ts');
writeFileSync(runner, `
const command = process.argv[2];
if (command === '--version') console.log('fixture 1.0');
else if (command === 'models') {
  if (process.env.CATALOGUE === 'failed') process.exit(2);
  if (process.env.CATALOGUE === 'live') console.log('fixture-model - Fixture Model');
  if (process.env.CATALOGUE === 'default') console.log('default');
} else if (command === 'status') {
  if (process.env.AUTH === 'missing') { console.error('Not logged in'); process.exit(1); }
  if (process.env.AUTH === 'unknown') process.exit(2);
  console.log('Authenticated');
} else process.exit(2);
`);
afterAll(() => rmSync(home, { recursive: true, force: true }));

for (const [auth, catalogue, available, reason] of [
  ['ok', 'live', true, undefined],
  ['missing', 'live', false, 'auth-missing'],
  ['unknown', 'live', false, 'auth-unknown'],
  ['ok', 'empty', false, 'auth-unknown'],
  ['ok', 'failed', false, 'auth-unknown'],
  ['ok', 'default', false, 'auth-unknown'],
] as const) {
  test(`separate auth ${auth} and catalogue ${catalogue} produce available=${available}`, async () => {
    const result = await safeProbe({
      ...cursorAgentDef,
      versionArgs: [runner, '--version'],
      listModels: { ...cursorAgentDef.listModels, args: [runner, 'models'] },
      authProbe: { args: [runner, 'status'] },
    }, {
      CURSOR_AGENT_BIN: process.execPath, AUTH: auth, CATALOGUE: catalogue,
      READABLE_AGENT_DISCOVERY_OFFLINE: '0',
    });
    expect(result.path).toBe(process.execPath);
    expect(result.available).toBe(available);
    expect(result.authStatus).toBe(auth);
    expect(result.diagnostics?.[0]?.reason).toBe(reason);
    expect(result.models).toEqual(available ? [{ id: 'fixture-model', label: 'Fixture Model' }] : []);
    if (available) expect(result.modelsSource).toBe('live');
  });
}
