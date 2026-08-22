import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, test, vi } from 'vitest';
import {
  createHostedPiInvocation,
  resolveHostedPiEntrypoint,
} from '../src/runtimes/hosted-pi-runtime.js';
import type { HostedPiRuntimeRequest } from '../src/runtimes/hosted-pi-runtime.js';
import { createHostedPiBroker } from '../src/runtimes/hosted-pi-broker.js';
import { createHostedPiRuntimeAdapter } from '../src/runtimes/hosted-pi-adapter.js';
import hostedPiBrokerExtension from '../src/runtimes/hosted-pi-broker-extension.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fakePiPackage(): { root: string; entrypoint: string; project: string; sessionDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'readable-hosted-pi-'));
  roots.push(root);
  const entrypoint = join(root, 'dist', 'rpc-entry.js');
  const project = join(root, 'project');
  const sessionDir = join(root, 'sessions');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: '0.83.0',
  }));
  writeFileSync(entrypoint, '');
  return { root, entrypoint, project, sessionDir };
}

describe('hosted Pi runtime', () => {
  test('resolves the installed package through its ESM RPC export by default', () => {
    const resolved = resolveHostedPiEntrypoint();
    assert.match(resolved.entrypoint, /rpc-entry\.js$/i);
    assert.equal(resolved.packageRoot.endsWith('pi-coding-agent'), true);
  });

  test('resolves only the pinned package-local RPC entrypoint', () => {
    const fixture = fakePiPackage();
    const resolved = resolveHostedPiEntrypoint(fixture.root);
    assert.equal(resolved.packageRoot, fixture.root);
    assert.equal(resolved.entrypoint, fixture.entrypoint);
  });

  test('rejects an entrypoint that escapes the deployed package root', () => {
    const fixture = fakePiPackage();
    rmSync(fixture.entrypoint);
    writeFileSync(join(fixture.root, 'dist', 'rpc-entry.js'), '');
    const outside = join(fixture.root, '..', 'rpc-entry.js');
    rmSync(outside, { force: true });

    assert.throws(
      () => resolveHostedPiEntrypoint(join(fixture.root, 'dist', '..', 'rpc-entry.js')),
      /package|entrypoint|pinned/i,
    );
  });

  test('uses node and hardening flags without ambient CLI or package-manager authority', () => {
    const fixture = fakePiPackage();
    const invocation = createHostedPiInvocation({
      packageRoot: fixture.root,
      cwd: fixture.project,
      sessionDir: fixture.sessionDir,
      model: 'fixture/model',
      thinking: 'off',
      credential: { provider: 'anthropic', key: 'anthropic-secret' },
    });

    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[0], fixture.entrypoint);
    assert.ok(invocation.args.includes('--mode'));
    assert.ok(invocation.args.includes('rpc'));
    for (const flag of [
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-approve',
      '--offline',
    ]) assert.ok(invocation.args.includes(flag), `missing ${flag}`);
    assert.ok(invocation.args.includes('--session-dir'));
    assert.ok(invocation.args.includes(fixture.sessionDir));
    assert.ok(invocation.args.includes('--model'));
    assert.ok(invocation.args.includes('fixture/model'));
    assert.ok(invocation.args.includes('--thinking'));
    assert.ok(invocation.args.includes('off'));
    assert.equal(invocation.env.PATH, '');
    assert.equal(invocation.env.PI_OFFLINE, '1');
    assert.equal(invocation.env.PI_PACKAGE_DIR, undefined);
    assert.equal(invocation.env.PI_BIN, undefined);
    for (const key of ['npm_config_prefix', 'NPM_CONFIG_PREFIX', 'npm_execpath', 'npm_config_user_agent']) {
      assert.equal(invocation.env[key], undefined, `ambient package manager env leaked: ${key}`);
    }
    assert.equal(invocation.env.READABLE_TOOL_TOKEN, undefined);
    assert.equal(invocation.env.READABLE_HOSTED_DESIGN_SYSTEM_READ_URL, undefined);
    assert.equal(invocation.env.ANTHROPIC_API_KEY, 'anthropic-secret');
    assert.equal(invocation.env.AI_GATEWAY_API_KEY, undefined);
    assert.equal(invocation.args.includes('anthropic-secret'), false);
  });

  test('maps only the closed hosted provider credential into the child environment', () => {
    const fixture = fakePiPackage();
    const beforeAnthropic = process.env.ANTHROPIC_API_KEY;
    const beforeGateway = process.env.AI_GATEWAY_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'ambient-anthropic';
    process.env.AI_GATEWAY_API_KEY = 'ambient-gateway';
    try {
      const invocation = createHostedPiInvocation({
        packageRoot: fixture.root,
        cwd: fixture.project,
        sessionDir: fixture.sessionDir,
        credential: { provider: 'vercel-ai-gateway', key: 'gateway-secret' },
      });

      assert.equal(process.env.ANTHROPIC_API_KEY, 'ambient-anthropic');
      assert.equal(process.env.AI_GATEWAY_API_KEY, 'ambient-gateway');
      assert.equal(invocation.env.AI_GATEWAY_API_KEY, 'gateway-secret');
      assert.equal(invocation.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(invocation.args.includes('gateway-secret'), false);
      assert.throws(() => createHostedPiInvocation({
        packageRoot: fixture.root,
        cwd: fixture.project,
        sessionDir: fixture.sessionDir,
        credential: { provider: 'anthropic', key: 'line\nbreak' },
      }), /credential/u);
      assert.throws(() => createHostedPiInvocation({
        packageRoot: fixture.root,
        cwd: fixture.project,
        sessionDir: fixture.sessionDir,
        credential: { provider: 'other' as never, key: 'secret' },
      }), /credential/u);
    } finally {
      if (beforeAnthropic == null) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = beforeAnthropic;
      if (beforeGateway == null) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = beforeGateway;
    }
  });

  test('adds only the repository-owned broker extension when a server grant exists', async () => {
    const fixture = fakePiPackage();
    const broker = await createHostedPiBroker({
      runtimeRoot: fixture.root,
      binding: {
        userKey: 'user-a',
        runId: 'run-a',
        projectId: 'project-a',
        generation: 1,
        projectRoot: fixture.project,
      },
    });
    try {
      const invocation = createHostedPiInvocation({
        packageRoot: fixture.root,
        cwd: fixture.project,
        sessionDir: fixture.sessionDir,
        broker,
      });
      assert.ok(invocation.args.includes('--extension'));
      assert.ok(invocation.args.includes(broker.extensionPath));
      assert.ok(invocation.args.includes('--tools'));
      assert.ok(invocation.args.includes('readable_hosted_broker'));
      assert.equal(invocation.env.READABLE_HOSTED_PI_BROKER_SOCKET, broker.socketPath);
      assert.equal(invocation.env.READABLE_HOSTED_PI_BROKER_TOKEN, broker.grant.token);
      assert.equal(invocation.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(invocation.env.AI_GATEWAY_API_KEY, undefined);
    } finally {
      await broker.close();
    }
  });

  test('composes a server-owned broker with the package-local invocation', async () => {
    const fixture = fakePiPackage();
    const runtimeRoot = join(fixture.root, 'broker-runtime');
    const sessionRoot = join(fixture.root, 'broker-sessions');
    const request: HostedPiRuntimeRequest = {
      userKey: 'authenticated-user',
      runId: 'run-a',
      projectId: 'project-a',
      generation: 1,
      projectRoot: fixture.project,
      cwd: fixture.project,
      model: 'fixture/model',
      thinking: 'off',
      credential: { provider: 'vercel-ai-gateway', key: 'gateway-secret' },
    };
    const adapter = createHostedPiRuntimeAdapter({
      runtimeRoot,
      sessionRoot,
      packageRoot: fixture.root,
    });

    const handle = await adapter(request);
    try {
      assert.equal(handle.invocation.command, process.execPath);
      assert.equal(handle.invocation.env.READABLE_HOSTED_PI_BROKER_TOKEN?.startsWith('odpi_'), true);
      if (process.platform === 'win32') {
        assert.match(handle.invocation.env.READABLE_HOSTED_PI_BROKER_SOCKET ?? '', /ReadableStudio\.HostedPi\./);
      } else {
        assert.match(
          handle.invocation.env.READABLE_HOSTED_PI_BROKER_SOCKET ?? '',
          /\/tmp\/readable-studio\/ipc\/pi-[^/]+\/broker\.sock$/,
        );
      }
      assert.equal(handle.invocation.sessionDir, join(sessionRoot, request.runId));
      assert.ok(handle.invocation.args.includes('--extension'));
      assert.equal(handle.invocation.args.includes('readable_hosted_broker'), true);
      assert.equal(handle.invocation.env.AI_GATEWAY_API_KEY, 'gateway-secret');
    } finally {
      await handle.close?.();
    }
  });

  test('mints and revokes the selected design-system grant against the broker carrier', async () => {
    const fixture = fakePiPackage();
    const readUrl = 'http://127.0.0.1:7456/api/tools/design-systems/read';
    const bindings: unknown[] = [];
    let revoked = 0;
    let tokenSequence = 0;
    const adapter = createHostedPiRuntimeAdapter({
      runtimeRoot: join(fixture.root, 'broker-runtime'),
      sessionRoot: join(fixture.root, 'broker-sessions'),
      packageRoot: fixture.root,
      designSystemTool: {
        readUrl,
        mintGrant: (binding) => {
          bindings.push(binding);
          tokenSequence += 1;
          const token = `odds_${String(tokenSequence).repeat(43)}`;
          return { token, revoke: () => { revoked += 1; } };
        },
      },
    });
    const request: HostedPiRuntimeRequest = {
      userKey: 'authenticated-user',
      runId: 'run-a',
      projectId: 'project-a',
      projectRoot: fixture.project,
      cwd: fixture.project,
      generation: 7,
      designSystemId: 'calm-web',
    };

    const handle = await adapter(request);
    assert.deepEqual(bindings[0], {
      userKey: request.userKey,
      runId: request.runId,
      projectId: request.projectId,
      generation: request.generation,
      designSystemId: request.designSystemId,
      carrierToken: handle.invocation.env.READABLE_HOSTED_PI_BROKER_TOKEN,
    });
    assert.equal(handle.invocation.env.READABLE_HOSTED_DESIGN_SYSTEM_READ_URL, readUrl);
    assert.equal(handle.invocation.env.READABLE_TOOL_TOKEN, `odds_${'1'.repeat(43)}`);
    assert.equal(handle.invocation.env.READABLE_DAEMON_URL, undefined);
    await handle.close?.();
    await handle.close?.();
    assert.equal(revoked, 1);

    await assert.rejects(() => adapter({
      ...request,
      runId: 'run-b',
      cwd: join(fixture.root, 'missing-cwd'),
    }), /project cwd/u);
    assert.equal(revoked, 2);
  });

  test('posts only the fixed design-system read body and two bound credentials', async () => {
    let registered: {
      parameters: Record<string, unknown>;
      execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
      ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
    } | undefined;
    hostedPiBrokerExtension({
      registerTool: (tool) => { registered = tool as typeof registered; },
    });
    assert.ok(registered);
    vi.stubEnv('READABLE_HOSTED_DESIGN_SYSTEM_READ_URL', 'https://host.example/api/tools/design-systems/read');
    const toolToken = `odds_${'t'.repeat(43)}`;
    const carrierToken = `odpi_${'c'.repeat(43)}`;
    vi.stubEnv('READABLE_TOOL_TOKEN', toolToken);
    vi.stubEnv('READABLE_HOSTED_PI_BROKER_TOKEN', carrierToken);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), 'https://host.example/api/tools/design-systems/read');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), `Bearer ${toolToken}`);
      assert.equal(headers.get('x-readable-studio-tool-token'), carrierToken);
      assert.equal(headers.get('cookie'), null);
      assert.equal(headers.get('origin'), null);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        path: 'DESIGN.md',
        designSystemId: 'calm-web',
      });
      return new Response(JSON.stringify({ content: '# Calm\n' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await registered.execute('', {
      operation: 'design-system:read',
      path: 'DESIGN.md',
      designSystemId: 'calm-web',
    }, undefined);
    assert.deepEqual(result, { content: [{ type: 'text', text: '# Calm\n' }] });

    const denied = await registered.execute('', {
      operation: 'design-system:read',
      path: 'DESIGN.md',
      url: 'https://attacker.example',
    }, undefined);
    assert.equal(denied.isError, true);
    assert.equal(fetchMock.mock.calls.length, 1);
  });
});
