import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDatabricksCli } from '../src/databricks-cli.js';
import { DatabricksServiceError } from '../src/databricks/service.js';
import { bounded, ids, login, lookup, model, models, scan, secrets, status, surfaceHarness, verification } from './databricks-surface-fixtures.js';

let harness: Awaited<ReturnType<typeof surfaceHarness>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });
function cli(args: string[], signal?: AbortSignal) {
  let output = '';
  let progress = '';
  const finished = runDatabricksCli([...args, '--json'], {
    resolveDaemonUrl: async () => harness!.url,
    stdout: (text) => { output += text; }, stderr: (text) => { progress += text; },
    ...(signal ? { signal } : {}),
  });
  return { finished, output: () => output, progress: () => progress };
}
function noCredentials(text: string) {
  expect(text).not.toContain(secrets.access_token);
  for (const key of Object.keys(secrets)) expect(text).not.toContain(`"${key}"`);
}
function noSecrets(text: string) { for (const secret of Object.values(secrets)) expect(text).not.toContain(secret); }

const verbs = [
  [['status'], status, 0],
  [['login', '--host', secrets.host], login(), 0],
  [['login', 'status', ids.scan], login('authenticated'), 0],
  [['login', 'cancel', ids.scan], login('cancelled'), 130],
  [['setup', '--mode', 'cli-profile', '--profile', ids.profile], { profile: status.profiles[0]!, status }, 0],
  [['profiles'], { profiles: status.profiles, issues: [] }, 0],
  [['probe', '--profile', ids.profile], { profiles: status.profiles, issues: [] }, 0],
  [['scan', '--profile', ids.profile], scan(), 0],
  [['scan', 'status', ids.scan], scan(), 0],
  [['scan', 'cancel', ids.scan], scan('cancelled', 3), 130],
  [['lookup', ids.endpoint, '--profile', ids.profile, '--kind', 'uc-model-service'], lookup, 0],
  [['models', '--profile', ids.profile], models, 0],
  [['enable', ids.endpoint, '--scan', ids.scan, '--revision', '2'], model, 0],
  [['disable', ids.endpoint, '--revision', '2'], models, 0],
  [['remove', ids.endpoint, '--revision', '2'], models, 0],
  [['select', ids.endpoint], model, 0],
  [['verify', ids.endpoint, '--scan', ids.scan, '--revision', '2', '--allow-inference'], verification, 0],
  [['disconnect', ids.profile], status, 0],
  [['client', '--clear'], status, 0],
  [['client', '--executable', 'exe_private_reference'], status, 0],
] as const;

describe('readable databricks CLI', () => {
  for (const [args, expected, exitCode] of verbs) {
    it(`${args.join(' ')} allows real names in user-facing JSON, never credentials or identities in progress logs`, async () => {
      harness = await surfaceHarness();
      const invocation = cli([...args]);
      expect(await invocation.finished).toEqual({ exitCode });
      expect(JSON.parse(invocation.output())).toEqual(expected);
      noCredentials(invocation.output()); noSecrets(invocation.progress());
    });
  }

  it('reports a timed-out login as failure', async () => {
    harness = await surfaceHarness();
    harness.service.getLogin.mockResolvedValueOnce(login('timed-out'));
    const invocation = cli(['login', 'status', ids.scan]);
    expect(await invocation.finished).toEqual({ exitCode: 1 });
    expect(JSON.parse(invocation.output()).state).toBe('timed-out');
  });

  it('sends stdin credentials only to setup and succeeds without a CLI', async () => {
    harness = await surfaceHarness();
    const configured = { ...status, cli: 'missing' as const, version: null, setupRequired: false };
    harness.service.setup.mockResolvedValueOnce({ profile: configured.profiles[0]!, status: configured });
    let output = ''; let progress = '';
    const result = await runDatabricksCli(['setup', '--mode', 'workspace-token', '--host', secrets.host, '--token-stdin', '--json'], {
      resolveDaemonUrl: async () => harness!.url, readStdin: async () => secrets.access_token,
      stdout: (text) => { output += text; }, stderr: (text) => { progress += text; },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output)).toEqual({ profile: configured.profiles[0]!, status: configured });
    expect(harness.service.setup).toHaveBeenCalledWith({ mode: 'workspace-token', host: secrets.host, token: secrets.access_token });
    noCredentials(output); noSecrets(progress);
  });

  it('select changes only the Databricks preference and preserves direct Pi preferences', async () => {
    harness = await surfaceHarness();
    const invocation = cli(['select', ids.endpoint]);
    expect(await invocation.finished).toEqual({ exitCode: 0 });
    expect(harness.saveConfig).toHaveBeenCalledWith({
      agentId: 'databricks', agentModels: { pi: { model: 'direct-model', reasoning: 'high' }, databricks: { model: ids.model } },
    });
    expect(harness.service.enable).not.toHaveBeenCalled();
    noCredentials(invocation.output());
    noSecrets(JSON.stringify(harness.saveConfig.mock.calls));
  });

  it('select refuses unregistered models without saving a default', async () => {
    harness = await surfaceHarness();
    harness.service.listModels.mockResolvedValueOnce({ ...models, models: [] });
    const invocation = cli(['select', ids.endpoint]);
    expect(await invocation.finished).toEqual({ exitCode: 1 });
    expect(JSON.parse(invocation.output()).error.code).toBe('DATABRICKS_SCAN_EXPIRED');
    expect(harness.saveConfig).not.toHaveBeenCalled();
  });

  for (const [state, exitCode] of [['complete', 0], ['partial', 3], ['failed', 1], ['cancelled', 130]] as const) {
    it(`maps a completed ${state} scan to ${exitCode}`, async () => {
      harness = await surfaceHarness(scan(state));
      const invocation = cli(['scan', '--profile', ids.profile]);
      expect(await invocation.finished).toEqual({ exitCode });
      expect(JSON.parse(invocation.output()).state).toBe(state);
    });
  }

  for (const follow of [false, true]) {
    it(`waits for the exact terminal event with follow=${follow}`, async () => {
      harness = await surfaceHarness(scan('running', 1));
      const invocation = cli(['scan', '--profile', ids.profile, ...(follow ? ['--follow'] : [])]);
      await bounded(harness.subscribed);
      harness.emit({ type: 'progress', scanId: ids.scan, revision: 2, state: 'running', counters: scan().counters, completeness: scan().completeness, issues: [] });
      harness.emit({ type: 'endpoint', scanId: ids.scan, revision: 3, endpoint: model.endpoint });
      harness.complete(scan('partial', 4));
      expect(await invocation.finished).toEqual({ exitCode: 3 });
      const output = invocation.output(); noCredentials(output); noSecrets(invocation.progress());
      if (follow) {
        const events = output.trim().split('\n').map((line) => JSON.parse(line));
        expect(events.map((event) => event.type)).toEqual(['snapshot', 'progress', 'endpoint', 'done']);
        expect(events.at(-1).scan).toEqual(scan('partial', 4));
      } else expect(JSON.parse(output)).toEqual(scan('partial', 4));
      expect(harness.unsubscribe).toHaveBeenCalledOnce();
    });
  }

  it('follow replays an already-completed scan as a terminal NDJSON event', async () => {
    harness = await surfaceHarness();
    const invocation = cli(['scan', '--profile', ids.profile, '--follow']);
    expect(await invocation.finished).toEqual({ exitCode: 0 });
    expect(JSON.parse(invocation.output())).toEqual({ type: 'done', revision: 2, scan: scan() });
  });

  it('interrupt cancels the active scan and emits its terminal snapshot with exit 130', async () => {
    harness = await surfaceHarness(scan('running', 1));
    const controller = new AbortController();
    const invocation = cli(['scan', '--profile', ids.profile, '--follow'], controller.signal);
    await bounded(harness.subscribed);
    controller.abort();
    expect(await invocation.finished).toEqual({ exitCode: 130 });
    expect(harness.service.cancelScan).toHaveBeenCalledWith(ids.scan);
    const events = invocation.output().trim().split('\n').map((line) => JSON.parse(line));
    expect(events.at(-1)).toEqual({ type: 'done', revision: 2, scan: scan('cancelled', 2) });
    noCredentials(invocation.output());
  });

  it('reports auth-required even if a scan otherwise completed partially', async () => {
    harness = await surfaceHarness({ ...scan('partial'), issues: [{ code: 'DATABRICKS_AUTH_REQUIRED', action: 'sign-in', retryable: false }] });
    const invocation = cli(['scan', '--profile', ids.profile]);
    expect(await invocation.finished).toEqual({ exitCode: 1 });
    expect(JSON.parse(invocation.output()).issues[0].code).toBe('DATABRICKS_AUTH_REQUIRED');
  });

  it('maps status auth-required and CLI missing to exit 1', async () => {
    harness = await surfaceHarness();
    for (const next of [{ ...status, auth: 'auth-required' as const }, { ...status, cli: 'missing' as const }]) {
      harness.service.status.mockResolvedValueOnce(next);
      const invocation = cli(['status']);
      expect(await invocation.finished).toEqual({ exitCode: 1 });
      expect(JSON.parse(invocation.output()).cli).toBe(next.cli);
    }
  });

  it('maps inconclusive paid verification to failure, never success', async () => {
    harness = await surfaceHarness();
    harness.service.verify.mockResolvedValueOnce({ ...verification, result: 'inconclusive' });
    const invocation = cli(['verify', ids.endpoint, '--scan', ids.scan, '--revision', '2', '--allow-inference']);
    expect(await invocation.finished).toEqual({ exitCode: 1 });
    expect(JSON.parse(invocation.output()).result).toBe('inconclusive');
  });

  for (const error of [new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED'), new Error(Object.values(secrets).join(' '))]) {
    it(`sanitizes ${error.name} into one JSON failure with exit 1`, async () => {
      harness = await surfaceHarness();
      harness.service.status.mockRejectedValueOnce(error);
      const invocation = cli(['status']);
      expect(await invocation.finished).toEqual({ exitCode: 1 });
      expect(JSON.parse(invocation.output()).error.code).toMatch(/^DATABRICKS_/);
      noSecrets(invocation.output()); noSecrets(invocation.progress());
    });
  }

  for (const args of [
    ['login'], ['login', '--host', 'http://workspace.example'], ['login', 'cancel'],
    ['setup'], ['setup', '--mode', 'workspace-token', '--host', secrets.host],
    ['setup', '--mode', 'cli-profile', '--token-stdin'],
    ['setup', '--mode', 'workspace-token', '--host', secrets.host, '--token', secrets.access_token],
    [], ['unknown'], ['status', '--token'], ['status', '--json'], ['scan'], ['scan', '--profile'],
    ['scan', '--profile', secrets.host], ['scan', 'status'], ['models', '--follow'],
    ['client'], ['client', '--clear', '--executable', 'exe_id'], ['client', '--path', 'C:\\private.exe'],
    ['lookup', ids.endpoint, '--profile', ids.profile, '--kind', 'unknown'],
    ['enable', ids.endpoint, '--scan', ids.scan, '--revision', '-1'],
    ['verify', ids.endpoint, '--scan', ids.scan, '--revision', '2'], ['select'],
    ['scan', 'status', ids.scan, '--limit', '1001'], ['disconnect', secrets.full_name],
  ]) {
    it(`returns usage exit 2 before transport for ${JSON.stringify(args)}`, async () => {
      const transport = vi.fn<typeof fetch>();
      let output = '';
      const result = await runDatabricksCli([...args, '--json'], { fetch: transport, stdout: (text) => { output += text; }, stderr: () => {} });
      expect(result).toEqual({ exitCode: 2 });
      expect(JSON.parse(output).error.code).toBe('BAD_REQUEST');
      expect(transport).not.toHaveBeenCalled(); noSecrets(output);
    });
  }

  it('rejects remote daemon origins without sending any request', async () => {
    const transport = vi.fn<typeof fetch>();
    let output = '';
    expect(await runDatabricksCli(['status', '--json'], { fetch: transport, resolveDaemonUrl: async () => secrets.host,
      stdout: (text) => { output += text; }, stderr: () => {} })).toEqual({ exitCode: 2 });
    expect(transport).not.toHaveBeenCalled(); expect(JSON.parse(output).error.code).toBe('BAD_REQUEST'); noSecrets(output);
  });

  it('reports malformed HTTP JSON as one sanitized failure', async () => {
    let output = '';
    const result = await runDatabricksCli(['status', '--json'], {
      resolveDaemonUrl: async () => 'http://127.0.0.1:7456', fetch: async () => new Response(secrets.access_token),
      stdout: (text) => { output += text; }, stderr: () => {},
    });
    expect(result).toEqual({ exitCode: 1 }); expect(JSON.parse(output).error.code).toBe('DATABRICKS_UPSTREAM_UNAVAILABLE'); noSecrets(output);
  });

  it('rejects an event stream ending without a terminal snapshot', async () => {
    let output = '';
    const result = await runDatabricksCli(['scan', '--profile', ids.profile, '--json'], {
      resolveDaemonUrl: async () => 'http://127.0.0.1:7456',
      fetch: async (url) => String(url).endsWith('/events') ? new Response('') : Response.json(scan('running', 1)),
      stdout: (text) => { output += text; }, stderr: () => {},
    });
    expect(result).toEqual({ exitCode: 1 }); expect(JSON.parse(output).error.code).toBe('DATABRICKS_UPSTREAM_UNAVAILABLE');
  });
});
