import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HostedPiTurnError,
  startHostedPiTurn,
  type HostedPiTurnCapabilities,
  type HostedPiTurnInput,
} from '../src/runtimes/hosted-pi-turn.js';
import type { HostedPiDesignSystemGrantBinding } from '../src/runtimes/hosted-pi-runtime.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

type RpcCommand = Record<string, unknown> & { id: number; type: string };

class MockPiChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: RpcCommand[] = [];
  readonly signals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private inputBuffer = '';
  private closed = false;

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.inputBuffer += chunk;
      let newline = this.inputBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.inputBuffer.slice(0, newline);
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        if (line.length > 0) this.commands.push(JSON.parse(line) as RpcCommand);
        newline = this.inputBuffer.indexOf('\n');
      }
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }

  feed(...messages: Array<Record<string, unknown>>): void {
    for (const message of messages) this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

type SpawnRecord = {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
};

function fixture(): {
  root: string;
  packageRoot: string;
  projectA: string;
  projectB: string;
  brokerA: string;
  brokerB: string;
  sessionsA: string;
  sessionsB: string;
  uploadsA: string;
  uploadsB: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'readable-hosted-pi-turn-'));
  roots.push(root);
  const packageRoot = path.join(root, 'pi-package');
  const directories = {
    projectA: path.join(root, 'project-a'),
    projectB: path.join(root, 'project-b'),
    brokerA: path.join(root, 'broker-a'),
    brokerB: path.join(root, 'broker-b'),
    sessionsA: path.join(root, 'sessions-a'),
    sessionsB: path.join(root, 'sessions-b'),
    uploadsA: path.join(root, 'uploads-a'),
    uploadsB: path.join(root, 'uploads-b'),
  };
  mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: '0.83.0',
  }));
  writeFileSync(path.join(packageRoot, 'dist', 'rpc-entry.js'), '');
  return { root, packageRoot, ...directories };
}

function capabilities(
  f: ReturnType<typeof fixture>,
  owner: 'a' | 'b',
  runId = 'same-run',
): HostedPiTurnCapabilities {
  const upper = owner.toUpperCase();
  return {
    generation: 7,
    userKey: `user-${owner}`,
    runId,
    projectId: 'same-project',
    projectRoot: f[`project${upper}` as 'projectA' | 'projectB'],
    brokerRoot: f[`broker${upper}` as 'brokerA' | 'brokerB'],
    sessionRoot: f[`sessions${upper}` as 'sessionsA' | 'sessionsB'],
    uploadRoot: f[`uploads${upper}` as 'uploadsA' | 'uploadsB'],
    modelCatalogue: ['fixture/model'],
    thinkingCatalogue: ['off', 'low'],
  };
}

function input(
  caps: HostedPiTurnCapabilities,
  overrides: Partial<HostedPiTurnInput> = {},
): HostedPiTurnInput {
  return {
    capabilities: caps,
    credential: { provider: 'anthropic', key: 'lane-secret' },
    model: 'fixture/model',
    prompt: 'daemon-owned prompt',
    send: () => {},
    signal: new AbortController().signal,
    thinking: 'off',
    ...overrides,
  };
}

function spawnHarness(child: MockPiChild, records: SpawnRecord[]) {
  return (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    records.push({ command, args: [...args], options });
    return child as unknown as ChildProcess;
  };
}

function turnDependencies(
  f: ReturnType<typeof fixture>,
  child: MockPiChild,
  records: SpawnRecord[] = [],
) {
  return { packageRoot: f.packageRoot, spawnChild: spawnHarness(child, records) };
}

async function nextCommand(child: MockPiChild, type: string): Promise<RpcCommand> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const index = child.commands.findIndex((command) => command.type === type);
    if (index >= 0) return child.commands.splice(index, 1)[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Pi command did not arrive: ${type}`);
}

function sessionFile(caps: HostedPiTurnCapabilities, name = 'session.jsonl'): string {
  const directory = path.join(caps.sessionRoot, caps.runId);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, [
    JSON.stringify({ type: 'session', id: caps.runId, cwd: caps.projectRoot }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'settled' }),
    '',
  ].join('\n'));
  return file;
}

async function settle(
  child: MockPiChild,
  file: string,
  code: number | null = 0,
  signal: NodeJS.Signals | null = null,
): Promise<void> {
  child.feed({ type: 'agent_end' }, { type: 'agent_settled' });
  const getState = await nextCommand(child, 'get_state');
  child.feed({
    type: 'response',
    id: getState.id,
    command: 'get_state',
    success: true,
    data: { sessionFile: file },
  });
  child.close(code, signal);
}

function socketRequest(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('broker request timed out'));
    }, 2_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe('startHostedPiTurn', () => {
  it('accepts the full UTF-8 user-key boundary and rejects malformed or oversized identities', async () => {
    const f = fixture();
    const caps = capabilities(f, 'a');
    const boundaryChild = new MockPiChild();
    const boundaryTurn = startHostedPiTurn(input({
      ...caps,
      userKey: 'é'.repeat(512),
    }), turnDependencies(f, boundaryChild));
    await nextCommand(boundaryChild, 'prompt');
    await settle(boundaryChild, sessionFile(caps));
    await expect(boundaryTurn).resolves.toMatchObject({ value: { status: 'succeeded' } });

    const spawnInvalid = vi.fn();
    for (const userKey of ['é'.repeat(512) + 'x', '\ud800']) {
      await expect(startHostedPiTurn(input({ ...caps, userKey }), {
        packageRoot: f.packageRoot,
        spawnChild: spawnInvalid as never,
      })).rejects.toMatchObject({ code: 'HOSTED_PI_INPUT_INVALID' });
    }
    expect(spawnInvalid).not.toHaveBeenCalled();
  });

  it('returns only a terminal value and opaque verified session reference', async () => {
    const f = fixture();
    const caps = { ...capabilities(f, 'a'), designSystemId: 'calm-web' };
    const child = new MockPiChild();
    const spawns: SpawnRecord[] = [];
    const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const credential = { provider: 'anthropic' as const, key: 'lane-secret' };
    const readUrl = 'https://host.example/api/tools/design-systems/read';
    const designToolToken = `odds_${'t'.repeat(43)}`;
    const revoke = vi.fn();
    const mintGrant = vi.fn((_binding: HostedPiDesignSystemGrantBinding) => ({
      token: designToolToken,
      revoke,
    }));
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-secret');
    const turn = startHostedPiTurn(input(caps, {
      credential,
      prompt: 'prompt-not-in-argv',
      send: (channel, payload) => events.push({ channel, payload }),
    }), {
      ...turnDependencies(f, child, spawns),
      designSystemTool: { readUrl, mintGrant },
    });
    credential.key = 'mutated-after-start';

    await nextCommand(child, 'prompt');
    expect(spawns).toHaveLength(1);
    const spawned = spawns[0]!;
    const env = spawned.options.env as NodeJS.ProcessEnv;
    expect(env.ANTHROPIC_API_KEY).toBe('lane-secret');
    expect(env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(env.READABLE_HOSTED_DESIGN_SYSTEM_READ_URL).toBe(readUrl);
    expect(env.READABLE_TOOL_TOKEN).toBe(designToolToken);
    expect(env.READABLE_DAEMON_URL).toBeUndefined();
    expect(Object.values(env)).not.toContain('ambient-secret');
    expect(spawned.args).not.toContain('lane-secret');
    expect(spawned.args).not.toContain('prompt-not-in-argv');

    child.feed({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: `hidden ${caps.projectRoot} lane-secret ${env.READABLE_HOSTED_PI_BROKER_TOKEN} ${readUrl} ${designToolToken}`,
      },
    });
    const file = sessionFile(caps);
    await settle(child, file);
    const result = await turn;

    expect(result).toEqual({
      sessionReference: 'same-run/session.jsonl',
      value: { exitCode: 0, signal: null, status: 'succeeded' },
    });
    expect(mintGrant).toHaveBeenCalledWith({
      userKey: caps.userKey,
      runId: caps.runId,
      projectId: caps.projectId,
      generation: caps.generation,
      designSystemId: caps.designSystemId,
      carrierToken: env.READABLE_HOSTED_PI_BROKER_TOKEN,
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify({ events, result });
    for (const secret of [
      'lane-secret',
      caps.projectRoot,
      caps.sessionRoot,
      caps.brokerRoot,
      caps.uploadRoot,
      env.READABLE_HOSTED_PI_BROKER_TOKEN!,
      env.READABLE_HOSTED_PI_BROKER_SOCKET!,
      env.READABLE_HOSTED_DESIGN_SYSTEM_READ_URL!,
      env.READABLE_TOOL_TOKEN!,
    ]) expect(serialized).not.toContain(secret);
  });

  it('resumes only an owner-root-relative verified session', async () => {
    const f = fixture();
    const firstCaps = capabilities(f, 'a', 'turn-one');
    const firstChild = new MockPiChild();
    const first = startHostedPiTurn(input(firstCaps), turnDependencies(f, firstChild));
    await nextCommand(firstChild, 'prompt');
    const file = sessionFile(firstCaps);
    await settle(firstChild, file);
    const firstResult = await first;

    const resumedCaps = capabilities(f, 'a', 'turn-two');
    const resumedChild = new MockPiChild();
    const resumed = startHostedPiTurn(input(resumedCaps, {
      sessionReference: firstResult.sessionReference,
    }), turnDependencies(f, resumedChild));
    const switchSession = await nextCommand(resumedChild, 'switch_session');
    expect(switchSession.sessionPath).toBe(file);
    resumedChild.feed({
      type: 'response',
      id: switchSession.id,
      command: 'switch_session',
      success: true,
      data: { cancelled: false },
    });
    await nextCommand(resumedChild, 'prompt');
    appendFileSync(file, `${JSON.stringify({ type: 'message', role: 'assistant', content: 'resumed' })}\n`);
    await settle(resumedChild, file);
    await expect(resumed).resolves.toEqual({
      sessionReference: firstResult.sessionReference,
      value: { exitCode: 0, signal: null, status: 'succeeded' },
    });

    const copiedSpawn = vi.fn();
    await expect(startHostedPiTurn(input(capabilities(f, 'b'), {
      sessionReference: firstResult.sessionReference,
    }), {
      packageRoot: f.packageRoot,
      spawnChild: copiedSpawn as never,
    })).rejects.toMatchObject({
      code: 'HOSTED_PI_INPUT_INVALID',
    });
    expect(copiedSpawn).not.toHaveBeenCalled();
  });

  it('rejects a copied A token at B even when their public ids collide', async () => {
    const f = fixture();
    const capsA = capabilities(f, 'a');
    const capsB = capabilities(f, 'b');
    const childA = new MockPiChild();
    const childB = new MockPiChild();
    const spawnA: SpawnRecord[] = [];
    const spawnB: SpawnRecord[] = [];
    const turnA = startHostedPiTurn(input(capsA), turnDependencies(f, childA, spawnA));
    const turnB = startHostedPiTurn(input(capsB), turnDependencies(f, childB, spawnB));
    await Promise.all([nextCommand(childA, 'prompt'), nextCommand(childB, 'prompt')]);
    const envA = spawnA[0]!.options.env as NodeJS.ProcessEnv;
    const envB = spawnB[0]!.options.env as NodeJS.ProcessEnv;

    await expect(socketRequest(envB.READABLE_HOSTED_PI_BROKER_SOCKET!, {
      token: envA.READABLE_HOSTED_PI_BROKER_TOKEN,
      operation: 'project:file:list',
      path: '',
    })).resolves.toMatchObject({ ok: false, code: 'BROKER_TOKEN_INVALID' });

    await Promise.all([
      settle(childA, sessionFile(capsA)),
      settle(childB, sessionFile(capsB)),
    ]);
    await expect(Promise.all([turnA, turnB])).resolves.toMatchObject([
      { value: { status: 'succeeded' } },
      { value: { status: 'succeeded' } },
    ]);
    await expect(socketRequest(envB.READABLE_HOSTED_PI_BROKER_SOCKET!, {
      token: envB.READABLE_HOSTED_PI_BROKER_TOKEN,
      operation: 'project:file:list',
      path: '',
    })).rejects.toBeInstanceOf(Error);
  });

  it('revokes the grant after bounded cancel and verified exit fallback', async () => {
    const f = fixture();
    const caps = { ...capabilities(f, 'a'), designSystemId: 'calm-web' };
    const child = new MockPiChild();
    const spawns: SpawnRecord[] = [];
    const controller = new AbortController();
    const revoke = vi.fn();
    const turn = startHostedPiTurn(
      input(caps, { signal: controller.signal }),
      {
        ...turnDependencies(f, child, spawns),
        designSystemTool: {
          readUrl: 'https://host.example/api/tools/design-systems/read',
          mintGrant: () => ({ token: `odds_${'t'.repeat(43)}`, revoke }),
        },
      },
    );
    await nextCommand(child, 'prompt');
    const file = sessionFile(caps, 'canceled.jsonl');
    controller.abort();
    await nextCommand(child, 'abort');
    child.close(null, 'SIGTERM');

    await expect(turn).resolves.toEqual({
      sessionReference: 'same-run/canceled.jsonl',
      value: { exitCode: null, signal: 'SIGTERM', status: 'canceled' },
    });
    const env = spawns[0]!.options.env as NodeJS.ProcessEnv;
    await expect(socketRequest(env.READABLE_HOSTED_PI_BROKER_SOCKET!, {
      token: env.READABLE_HOSTED_PI_BROKER_TOKEN,
      operation: 'project:file:list',
      path: '',
    })).rejects.toBeInstanceOf(Error);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('returns a failed terminal value after safe crash reconciliation and rejects ambient input', async () => {
    const f = fixture();
    const caps = { ...capabilities(f, 'a'), designSystemId: 'calm-web' };
    const child = new MockPiChild();
    const spawns: SpawnRecord[] = [];
    const revoke = vi.fn();
    const turn = startHostedPiTurn(input(caps), {
      ...turnDependencies(f, child, spawns),
      designSystemTool: {
        readUrl: 'https://host.example/api/tools/design-systems/read',
        mintGrant: () => ({ token: `odds_${'t'.repeat(43)}`, revoke }),
      },
    });
    await nextCommand(child, 'prompt');
    const file = sessionFile(caps, 'crashed.jsonl');
    child.close(1, null);
    await expect(turn).resolves.toEqual({
      sessionReference: 'same-run/crashed.jsonl',
      value: { exitCode: 1, signal: null, status: 'failed' },
    });
    const crashedEnv = spawns[0]!.options.env as NodeJS.ProcessEnv;
    await expect(socketRequest(crashedEnv.READABLE_HOSTED_PI_BROKER_SOCKET!, {
      token: crashedEnv.READABLE_HOSTED_PI_BROKER_TOKEN,
      operation: 'project:file:list',
      path: '',
    })).rejects.toBeInstanceOf(Error);
    expect(revoke).toHaveBeenCalledTimes(1);

    const spawnInvalid = vi.fn();
    await expect(startHostedPiTurn(input(caps, { model: 'request-controlled/model' }), {
      packageRoot: f.packageRoot,
      spawnChild: spawnInvalid as never,
    })).rejects.toBeInstanceOf(HostedPiTurnError);
    expect(spawnInvalid).not.toHaveBeenCalled();
    await expect(startHostedPiTurn(input({ ...caps, uploadRoot: caps.projectRoot }), {
      packageRoot: f.packageRoot,
      spawnChild: spawnInvalid as never,
    })).rejects.toMatchObject({ code: 'HOSTED_PI_INPUT_INVALID' });
    const outsideImage = path.join(caps.projectRoot, 'outside.png');
    writeFileSync(outsideImage, 'not-an-upload');
    await expect(startHostedPiTurn(input(caps, { imagePaths: [outsideImage] }), {
      packageRoot: f.packageRoot,
      spawnChild: spawnInvalid as never,
    })).rejects.toMatchObject({ code: 'HOSTED_PI_INPUT_INVALID' });
    await expect(startHostedPiTurn(input(caps), {
      packageRoot: caps.projectRoot,
      spawnChild: spawnInvalid as never,
    })).rejects.toMatchObject({ code: 'HOSTED_PI_INPUT_INVALID' });
  });
});
