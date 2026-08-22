import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  setResponder: (
    fn: (req: CapturedRequest) => { status: number; body: unknown } | null,
  ) => void;
  close: () => Promise<void>;
}

async function startStubServer(): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let responder:
    | ((req: CapturedRequest) => { status: number; body: unknown } | null)
    | null = null;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw,
      };
      requests.push(captured);
      const response = responder?.(captured) ?? { status: 200, body: { ok: true } };
      res.statusCode = response.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response.body));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub server has no address');

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    setResponder: (fn) => {
      responder = fn;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function runCli(
  args: string[],
  input = '',
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  return await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [TSX_CLI, CLI_SRC, ...args],
      {
        cwd: DAEMON_ROOT,
        env,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({ stdout, stderr, code });
      },
    );
    child.stdin?.end(input);
  });
}

describe('readable chat checkpoint CLI', () => {
  let stub: StubServer;

  beforeAll(async () => {
    stub = await startStubServer();
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    stub.requests.length = 0;
    stub.setResponder(() => ({ status: 200, body: { ok: true } }));
  });

  it('prints checkpoint list API JSON under --json', async () => {
    const payload = {
      checkpoints: [
        {
          id: 'cp-1',
          projectId: 'proj-1',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          runId: 'run-1',
          kind: 'after_message',
          createdAt: 1_700_000_000_000,
          rootPathHash: 'root',
          fileCount: 2,
          totalBytes: 120,
          manifestHash: 'manifest',
          restoreModes: ['files_only', 'chat_only', 'files_and_chat'],
        },
      ],
    };
    stub.setResponder((req) => {
      if (
        req.method === 'GET'
        && req.url === '/api/projects/proj-1/checkpoints?conversationId=conv-1'
      ) {
        return { status: 200, body: payload };
      }
      return { status: 404, body: { error: 'unexpected' } };
    });

    const result = await runCli([
      'chat',
      'checkpoints',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--daemon-url',
      stub.baseUrl,
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  it('prints checkpoint diff API JSON under --json', async () => {
    const payload = {
      checkpoint: { id: 'cp-1', projectId: 'proj-1', kind: 'after_message' },
      files: [{ path: 'src/app.ts', status: 'modified' }],
      conflicts: [],
    };
    stub.setResponder((req) => {
      if (
        req.method === 'GET'
        && req.url === '/api/projects/proj-1/checkpoints/cp-1/diff?base=current'
      ) {
        return { status: 200, body: payload };
      }
      return { status: 404, body: { error: 'unexpected' } };
    });

    const result = await runCli([
      'chat',
      'checkpoint',
      'diff',
      '--project',
      'proj-1',
      '--checkpoint',
      'cp-1',
      '--daemon-url',
      stub.baseUrl,
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  it('POSTs manual rollback without spoofable actor metadata', async () => {
    const payload = {
      projectId: 'proj-1',
      conversationId: 'conv-1',
      mode: 'files_and_chat',
      targetMessageId: 'msg-1',
      restoredCheckpointId: 'cp-1',
      safetyCheckpointId: 'cp-safe',
      deletedMessageIds: ['msg-2'],
      clearedAgentSessions: true,
      fileChanges: { added: 0, modified: 1, deleted: 1, unchanged: 2 },
      conflicts: [],
    };
    stub.setResponder((req) => {
      if (
        req.method === 'POST'
        && req.url === '/api/projects/proj-1/conversations/conv-1/rollback'
      ) {
        return { status: 200, body: payload };
      }
      return { status: 404, body: { error: 'unexpected' } };
    });

    const result = await runCli([
      'chat',
      'rollback',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--message',
      'msg-1',
      '--checkpoint',
      'cp-1',
      '--mode',
      'files-and-chat',
      '--conflict-policy',
      'keep-current',
      '--daemon-url',
      stub.baseUrl,
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({
      targetMessageId: 'msg-1',
      targetCheckpointId: 'cp-1',
      mode: 'files_and_chat',
      conflictPolicy: 'keep_current',
      createSafetyCheckpoint: true,
    });
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  it('prints a human rollback summary with the safety checkpoint recovery command', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        projectId: 'proj-1',
        conversationId: 'conv-1',
        mode: 'files_only',
        targetMessageId: 'msg-1',
        restoredCheckpointId: 'cp-1',
        safetyCheckpointId: 'cp-safe',
        deletedMessageIds: [],
        clearedAgentSessions: false,
        fileChanges: { added: 1, modified: 2, deleted: 3, unchanged: 4 },
        conflicts: [],
      },
    }));

    const result = await runCli([
      'chat',
      'rollback',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--message',
      'msg-1',
      '--checkpoint',
      'cp-1',
      '--mode',
      'files-only',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[chat rollback] restored cp-1 (actor: user)');
    expect(result.stdout).toContain('safetyCheckpoint\tcp-safe');
    expect(result.stdout).toContain('files\t1 added, 2 modified, 3 deleted, 4 unchanged');
    expect(result.stdout).toContain('recovery\tod chat rollback --project proj-1 --conversation conv-1 --message msg-1 --checkpoint cp-safe --mode files-only');
  });

  it('maps rollback conflicts to a non-zero structured JSON error', async () => {
    stub.setResponder(() => ({
      status: 409,
      body: {
        error: {
          code: 'ROLLBACK_CONFLICT',
          message: 'Rollback has file conflicts.',
          conflicts: [
            { path: 'src/app.ts', reason: 'current_changed_since_checkpoint' },
          ],
        },
      },
    }));

    const result = await runCli([
      'chat',
      'rollback',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--message',
      'msg-1',
      '--mode',
      'files-and-chat',
      '--daemon-url',
      stub.baseUrl,
      '--json',
    ]);

    expect(result.code).toBe(76);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.error.code).toBe('rollback-conflict');
    expect(envelope.error.message).toBe('Rollback has file conflicts.');
    expect(envelope.error.data.conflicts).toEqual([
      { path: 'src/app.ts', reason: 'current_changed_since_checkpoint' },
    ]);
  });

  it('requires an explicit rollback mode before calling the daemon', async () => {
    const result = await runCli([
      'chat',
      'rollback',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--message',
      'msg-1',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
    expect(result.stderr).toContain('--mode is required');
  });

  it('executes an agent rollback using only the opaque request handle', async () => {
    stub.setResponder((req) => {
      if (
        req.method === 'POST'
        && req.url === '/api/projects/proj-1/conversations/conv-1/agent-rollback-execute'
      ) {
        return {
          status: 200,
          body: {
            projectId: 'proj-1',
            conversationId: 'conv-1',
            mode: 'files_only',
            targetMessageId: 'msg-1',
            restoredCheckpointId: 'cp-1',
            safetyCheckpointId: 'cp-safe',
            deletedMessageIds: [],
            clearedAgentSessions: false,
            fileChanges: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
            conflicts: [],
            actor: 'agent',
          },
        };
      }
      return { status: 404, body: { error: 'unexpected' } };
    });

    const result = await runCli([
      'chat',
      'rollback-execute',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--request',
      'request-1',
      '--conflict-policy',
      'keep-current',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({
      requestId: 'request-1',
      conflictPolicy: 'keep_current',
    });
    expect(result.stdout).toContain('[chat rollback] restored cp-1 (actor: agent)');
  });

  it('rejects legacy actor spoofing before manual rollback reaches the daemon', async () => {
    const result = await runCli([
      'chat',
      'rollback',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--message',
      'msg-1',
      '--mode',
      'files-only',
      '--actor',
      'agent',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
    expect(result.stderr).toContain('--actor');
  });

  it('rejects a run id on manual rollback instead of silently ignoring it', async () => {
    const result = await runCli([
      'chat',
      'rollback',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--message',
      'msg-1',
      '--mode',
      'files-only',
      '--run',
      'run-1',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
    expect(result.stderr).toContain('--run is not supported for manual rollback');
  });

  it('POSTs an agent rollback request and prints its opaque id and expiry', async () => {
    const payload = {
      kind: 'agent_rollback_request',
      requestId: 'request-1',
      expiresAt: 1_700_000_300_000,
      runId: 'run-1',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      targetMessageId: 'msg-1',
      targetCheckpointId: 'cp-1',
      mode: 'files_only',
      reason: 'I accidentally removed the hero section',
    };
    stub.setResponder((req) => {
      if (
        req.method === 'POST'
        && req.url === '/api/projects/proj-1/conversations/conv-1/agent-rollback-request'
      ) {
        return { status: 200, body: payload };
      }
      return { status: 404, body: { error: 'unexpected' } };
    });

    const result = await runCli([
      'chat',
      'rollback-request',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--run',
      'run-1',
      '--mode',
      'files-only',
      '--reason',
      'I accidentally removed the hero section',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({
      runId: 'run-1',
      mode: 'files_only',
      reason: 'I accidentally removed the hero section',
    });
    expect(result.stdout).toContain('[chat rollback-request] target msg msg-1, checkpoint cp-1, mode files-only');
    expect(result.stdout).toContain('request\trequest-1');
    expect(result.stdout).toContain('expiresAt\t2023-11-14T22:18:20.000Z');
    expect(result.stdout).toContain('reason\tI accidentally removed the hero section');
  });

  it('passes agent rollback request JSON through unchanged', async () => {
    const payload = {
      kind: 'agent_rollback_request',
      requestId: 'request-1',
      expiresAt: 1_700_000_300_000,
      runId: 'run-1',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      targetMessageId: 'msg-1',
      targetCheckpointId: 'cp-1',
      mode: 'files_only',
      reason: '',
    };
    stub.setResponder((req) => {
      if (
        req.method === 'POST'
        && req.url === '/api/projects/proj-1/conversations/conv-1/agent-rollback-request'
      ) {
        return { status: 200, body: payload };
      }
      return { status: 404, body: { error: 'unexpected' } };
    });

    const result = await runCli([
      'chat',
      'rollback-request',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--run',
      'run-1',
      '--mode',
      'files-only',
      '--daemon-url',
      stub.baseUrl,
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  it('reads rollback reason from a prompt file while preserving JSON output', async () => {
    const reason = 'The generated layout removed the navigation hierarchy.\nRestore the prior files.';
    const dir = await mkdtemp(join(tmpdir(), 'readable-rollback-reason-'));
    const promptFile = join(dir, 'reason.txt');
    await writeFile(promptFile, reason, 'utf8');
    const payload = {
      kind: 'agent_rollback_request',
      requestId: 'request-file',
      expiresAt: 1_700_000_300_000,
      runId: 'run-1',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      targetMessageId: 'msg-1',
      targetCheckpointId: 'cp-1',
      mode: 'files_only',
      reason,
    };
    stub.setResponder(() => ({ status: 200, body: payload }));

    try {
      const result = await runCli([
        'chat', 'rollback-request',
        '--project', 'proj-1',
        '--conversation', 'conv-1',
        '--run', 'run-1',
        '--mode', 'files-only',
        '--prompt-file', promptFile,
        '--daemon-url', stub.baseUrl,
        '--json',
      ]);

      expect(result.code).toBe(0);
      expect(JSON.parse(stub.requests[0]!.body)).toMatchObject({ reason });
      expect(JSON.parse(result.stdout)).toEqual(payload);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads rollback reason from stdin with --prompt-file -', async () => {
    const reason = 'Restore the stable implementation from before this edit.';
    stub.setResponder(() => ({
      status: 200,
      body: {
        kind: 'agent_rollback_request',
        requestId: 'request-stdin',
        expiresAt: 1_700_000_300_000,
        runId: 'run-1',
        projectId: 'proj-1',
        conversationId: 'conv-1',
        targetMessageId: 'msg-1',
        targetCheckpointId: 'cp-1',
        mode: 'files_only',
        reason,
      },
    }));

    const result = await runCli([
      'chat', 'rollback-request',
      '--project', 'proj-1',
      '--conversation', 'conv-1',
      '--run', 'run-1',
      '--mode', 'files-only',
      '--prompt-file', '-',
      '--daemon-url', stub.baseUrl,
    ], reason);

    expect(result.code).toBe(0);
    expect(JSON.parse(stub.requests[0]!.body)).toMatchObject({ reason });
  });

  it('rejects ambiguous rollback reason inputs before calling the daemon', async () => {
    const result = await runCli([
      'chat', 'rollback-request',
      '--project', 'proj-1',
      '--conversation', 'conv-1',
      '--run', 'run-1',
      '--mode', 'files-only',
      '--reason', 'inline',
      '--prompt-file', '-',
      '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
    expect(result.stderr).toContain('--reason and --prompt-file cannot be used together');
  });

  it.each(['chat-only', 'files-and-chat'])(
    'rejects %s rollback-request before calling the daemon',
    async (mode) => {
      const result = await runCli([
        'chat',
        'rollback-request',
        '--project',
        'proj-1',
        '--conversation',
        'conv-1',
        '--run',
        'run-1',
        '--mode',
        mode,
        '--daemon-url',
        stub.baseUrl,
      ]);

      expect(result.code).toBe(2);
      expect(stub.requests).toHaveLength(0);
      expect(result.stderr).toContain('--mode must be files-only for rollback-request');
    },
  );

  it.each([
    ['ROLLBACK_APPROVAL_UNAVAILABLE', 503, 'rollback-approval-unavailable', 79],
    ['ROLLBACK_APPROVAL_DENIED', 403, 'rollback-approval-denied', 80],
    ['ROLLBACK_APPROVAL_TIMEOUT', 408, 'rollback-approval-timeout', 81],
    ['ROLLBACK_REQUEST_EXPIRED', 410, 'rollback-request-expired', 82],
    ['ROLLBACK_REQUEST_CONSUMED', 409, 'rollback-request-consumed', 83],
    ['ROLLBACK_PLAN_CHANGED', 409, 'rollback-plan-changed', 84],
  ])('maps %s to a stable structured exit', async (daemonCode, status, cliCode, exitCode) => {
    stub.setResponder(() => ({
      status,
      body: { error: { code: daemonCode, message: `failure: ${daemonCode}` } },
    }));

    const result = await runCli([
      'chat',
      'rollback-execute',
      '--project',
      'proj-1',
      '--conversation',
      'conv-1',
      '--request',
      'request-1',
      '--daemon-url',
      stub.baseUrl,
      '--json',
    ]);

    expect(result.code).toBe(exitCode);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: cliCode,
      message: `failure: ${daemonCode}`,
    });
  });
});
