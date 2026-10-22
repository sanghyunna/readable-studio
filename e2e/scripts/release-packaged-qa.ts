import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, type Page, type Request } from '@playwright/test';
import type { DesignTemplateUploadAnalysisResponse } from '@readable-studio/contracts';
import { HiddenLaunchError, launchHiddenDesktop, type HiddenDesktop } from '../lib/packaged-hidden-desktop.ts';
import { resolvePackagedAppRoot } from './direct-edit-delete-packaged.ts';
import { captureProcesses, daemonUrlFromProcesses, runCli } from './portable-qa-runtime.ts';
import { runCommand, validateEvidenceRoot, workspaceRoot } from './portable-qa-support.ts';
import { CODEX_FALLBACK_RETRY_RUN, createFakeAgentRuntimes, GLOBAL_RETRY_RUN } from '../lib/fake-agents.ts';

const names = ['template-import', 'standalone-large', 'databricks-fake', 'neutral-modern', 'global-retry'] as const;
type Options = { zipPath: string; namespace: string; evidenceRoot: string; journeys: string[] };
type Result = { name: string; status: 'PASSED' | 'FAILED' | 'SKIPPED'; boundary: string;
  error?: string; elapsedMs: number; screenshots: string[]; details: Record<string, unknown> };
type RetryScenario = keyof typeof GLOBAL_RETRY_RUN.prompts;
export type RetryCaseEvidence = {
  run: { id: string; conversationId: string | null; assistantMessageId: string | null; status: string; errorCode?: string | null };
  attempts: Array<{ attempt: number; startedAt: number; args: string[]; sessionId: string; isolated?: boolean; method?: string }>;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  messages: Array<{ id: string; role: string; content: string; runId?: string }>;
  conversations: Array<{ id: string }>;
  runs: Array<{ id: string }>;
};

export function verifyGlobalRetryCase(scenario: RetryScenario, value: RetryCaseEvidence): number[] {
  const succeeds = scenario === 'transient' || scenario === 'codex-fallback';
  const retryCount = succeeds ? 1 : scenario === 'exhausted' ? 10 : 0;
  const executions = retryCount + (scenario === 'codex-fallback' ? 2 : 1);
  assert.equal(value.attempts.length, executions, 'Unexpected CLI execution count');
  assert.deepEqual(value.attempts.map(attempt => attempt.attempt),
    Array.from({ length: executions }, (_, index) => index + 1));
  const retryStatuses = value.events.filter(event => event.event === 'agent'
    && event.data.type === 'status' && event.data.label === 'retrying')
    .map(event => JSON.parse(String(event.data.detail)));
  assert.deepEqual(retryStatuses.map(status => ({
    attempt: status.attempt, maxRetries: status.maxRetries, delayMs: status.delayMs,
  })), Array.from({ length: retryCount }, (_, index) => ({ attempt: index + 1, maxRetries: 10, delayMs: 5000 })));
  const providerAttempts = scenario === 'codex-fallback' ? value.attempts.slice(1) : value.attempts;
  const gaps = providerAttempts.slice(1).map((attempt, index) => attempt.startedAt - providerAttempts[index]!.startedAt);
  assert.ok(gaps.every(gap => gap >= 4900), 'A retry ran before the real five seconds elapsed');
  assert.equal(value.run.status, succeeds ? 'succeeded' : 'failed');
  assert.equal(value.events.filter(event => event.event === 'error').length, succeeds ? 0 : 1);
  assert.equal(value.events.filter(event => event.event === 'end').length, 1);
  if (scenario === 'quota' || scenario === 'invalid-model') {
    const code = scenario === 'quota' ? 'AGENT_QUOTA_EXHAUSTED' : 'AGENT_MODEL_UNAVAILABLE';
    assert.equal(value.run.errorCode, code, 'Run status lost its terminal cause');
    const error = value.events.find(event => event.event === 'error')?.data.error;
    assert.ok(error && typeof error === 'object' && 'code' in error && 'retryable' in error);
    assert.equal(error.code, code, 'CLI SSE error lost its terminal cause');
    assert.equal(error.retryable, false);
  }
  assert.deepEqual(value.runs.map(run => run.id), [value.run.id], 'Retries created another run');
  assert.deepEqual(value.conversations.map(conversation => conversation.id), [value.run.conversationId], 'Retries created another conversation');
  const users = value.messages.filter(message => message.role === 'user');
  const assistants = value.messages.filter(message => message.role === 'assistant');
  assert.equal(users.length, 1, 'Retries duplicated the user message');
  assert.equal(users[0]!.content, GLOBAL_RETRY_RUN.prompts[scenario]);
  assert.equal(assistants.length, 1, 'Retries duplicated the assistant message');
  assert.equal(assistants[0]!.id, value.run.assistantMessageId);
  assert.equal(assistants[0]!.runId, value.run.id);
  if (succeeds) {
    assert.equal(assistants[0]!.content.split(GLOBAL_RETRY_RUN.partial).length - 1, 1, 'Retry duplicated the partial output');
    assert.equal(assistants[0]!.content.split(GLOBAL_RETRY_RUN.continuation).length - 1, 1, 'Retry lost the continuation');
    if (scenario === 'transient') {
      const resumed = value.attempts[1]!;
      assert.ok(resumed.args.includes('--resume'), 'Partial output did not resume the Claude session');
      assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], value.attempts[0]!.sessionId);
    } else {
      assert.deepEqual(value.attempts.map(attempt => attempt.isolated), [true, false, false], 'Isolation recovery was replayed');
      assert.deepEqual(value.attempts.map(attempt => attempt.method), ['initialize', 'thread/start', 'thread/resume']);
      assert.deepEqual(value.attempts.slice(1).map(attempt => attempt.sessionId),
        [CODEX_FALLBACK_RETRY_RUN.threadId, CODEX_FALLBACK_RETRY_RUN.threadId], 'Committed Codex work changed native thread');
      assert.equal(value.events.filter(event => event.event === 'start').length, 3);
      for (const type of ['tool_use', 'tool_result']) {
        assert.equal(value.events.filter(event => event.event === 'agent' && event.data.type === type).length, 1,
          `Retry duplicated committed ${type}`);
      }
    }
  }
  return gaps;
}

export async function parseOptions(argv: readonly string[]): Promise<Options> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    assert.ok(key && ['--zip', '--namespace', '--evidence', '--journeys'].includes(key), `Unknown argument: ${key}`);
    assert.ok(value && !value.startsWith('--') && !values.has(key), `Invalid value for ${key}`);
    values.set(key, value);
  }
  assert.ok(values.has('--zip') && values.has('--namespace') && values.has('--evidence'),
    '--zip, --namespace and --evidence are required');
  const zipPath = resolve(values.get('--zip')!);
  assert.ok(zipPath.endsWith('.zip') && (await stat(zipPath)).isFile(), 'ZIP input must be a .zip file');
  const namespace = values.get('--namespace')!;
  assert.match(namespace, /^[a-zA-Z0-9][a-zA-Z0-9-]{0,70}$/);
  const evidenceRoot = resolve(values.get('--evidence')!);
  validateEvidenceRoot(evidenceRoot);
  const journeys = values.get('--journeys')?.split(',') ?? [...names];
  assert.ok(journeys.length && journeys.every(name => names.some(known => known === name)), 'Unknown journey');
  return { zipPath, namespace, evidenceRoot, journeys };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return address.port;
}

/** Stored ZIP entries keep this fixture independent of daemon-private ZIP code. */
function templateZip(): Buffer {
  const files: Record<string, string> = {
    'PROMPT.md': '---\nname: Release QA Deck\ncover: slide-1.html\ndescription: Fixed-size QA slides\npages:\n  - file: slide-1.html\n    use: cover\n  - file: slide-2.html\n  - file: slide-3.html\n  - file: responsive.html\n---\nUse these layouts with the supplied content.\n',
    'assets/deck.css': 'html,body{margin:0;width:1280px;height:720px;background:#163a66;color:#fff;font:48px Arial}h1{padding:100px}p{padding:0 100px;color:#ffcc55}',
    ...Object.fromEntries([1, 2, 3].map(n => [`slide-${n}.html`,
      `<!doctype html><html${n === 3 ? ' style="width:900px;height:1200px"' : ''}><head><link rel="stylesheet" href="assets/deck.css"></head><body${n === 3 ? ' style="width:900px;height:1200px"' : ''}><h1>Release QA ${n}</h1><p>Visible golden slide content</p></body></html>`])),
    'responsive.html': '<!doctype html><html><body><h1>Responsive QA default</h1></body></html>',
  };
  const bodies: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), content = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26);
    bodies.push(local, filename, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + content.length;
  }
  const end = Buffer.alloc(22), central = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, central, end]);
}

async function home(page: Page) {
  await page.evaluate(() => { history.pushState(null, '', '/'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.locator('[data-tab-id="deck"]').waitFor({ timeout: 30_000 });
}

async function fakeWorkspace(scratch: string) {
  const key = join(scratch, 'fake-key.pem'), cert = join(scratch, 'fake-cert.pem');
  const generated = await runCommand('C:/Program Files/Git/mingw64/bin/openssl.exe',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  assert.equal(generated.exitCode, 0, generated.stderr);
  const calls: Array<{ path: string; status: number; stream: boolean; bearer: string }> = [];
  let armed = false, attempts = 0;
  const server = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) : {};
    const path = req.url ?? '/';
    const status = armed && body.stream && path.endsWith('/messages')
      ? (++attempts <= 3 ? 503 : attempts === 4 ? 401 : 200) : 200;
    calls.push({ path, status, stream: body.stream === true, bearer: req.headers.authorization ?? '' });
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: status === 401 ? 'authentication_error' : 'overloaded_error',
        message: status === 401 ? 'Invalid access token' : 'Temporarily unavailable' } }));
    } else if (path.endsWith('/Me')) {
      res.setHeader('content-type', 'application/json'); res.end('{"id":"release-qa-user"}');
    } else if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: 'qa-claude', task: 'llm/v1/chat',
        config: { served_entities: [{ foundation_model: { name: 'databricks-claude-sonnet-5' } }] } }));
    } else if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }] }));
    } else if (path.endsWith('/invocations')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'qa', choices: [{ index: 0, delta: {
        role: 'assistant', tool_calls: [{ index: 0, id: 'probe_qa', type: 'function',
          function: { name: 'readable_probe', arguments: '{"ok":true}' } }],
      }, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ id: 'qa', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      event('message_start', { type: 'message_start', message: { id: 'msg_qa', type: 'message', role: 'assistant',
        model: 'qa-claude', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } });
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Release QA thinking proof.' } });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Release QA complete.' } });
      event('content_block_stop', { type: 'content_block_stop', index: 1 });
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } });
      event('message_stop', { type: 'message_stop' }); res.end();
    }
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const host = `https://127.0.0.1:${address.port}`;
  // Workspace tokens deliberately have no refresh provider. A tiny native fake
  // CLI exercises the real CLI-profile refresh path without real credentials.
  const counter = join(scratch, 'fake-token-counter.log');
  const source = `using System; using System.IO;
public class FakeDatabricks {
 public static void Main(string[] args) {
  if(args.Length>0 && args[0]=="--version") { Console.WriteLine("Databricks CLI v0.278.0"); return; }
  if(args.Length>1 && args[1]=="profiles") { Console.WriteLine(${JSON.stringify(JSON.stringify({
    profiles: [{ name: 'release-qa', host, is_default: true }],
  }))}); return; }
  if(args.Length>1 && args[1]=="token") {
   string path=${JSON.stringify(counter)};
   int n=File.Exists(path)?int.Parse(File.ReadAllText(path)):0; n++; File.WriteAllText(path,n.ToString());
   Console.WriteLine("{\\"access_token\\":\\"release-qa-token-"+n+"\\",\\"expiry\\":\\"2099-01-01T00:00:00Z\\"}"); return;
  }
  Environment.Exit(1);
 }
}`;
  const executable = join(scratch, 'databricks.exe');
  const compile = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`Add-Type -TypeDefinition '${source.replaceAll("'", "''")}' -OutputAssembly '${executable.replaceAll("'", "''")}' -OutputType ConsoleApplication`,
      'utf16le').toString('base64')]);
  if (compile.exitCode !== 0) {
    await new Promise<void>(done => server.close(() => done()));
    throw new Error(`Fake CLI compilation: ${compile.stderr}`);
  }
  return { host, calls, bin: scratch, counter, cert, arm: () => { armed = true; },
    close: () => new Promise<void>((done, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : done()); }) };
}

export async function runReleaseQa(options: Options) {
  await mkdir(options.evidenceRoot, { recursive: true });
  const scratchBase = join(workspaceRoot, '.tmp/release-qa');
  await mkdir(scratchBase, { recursive: true });
  const scratch = await mkdtemp(join(scratchBase, 'portable-'));
  const results: Result[] = [], captured: unknown[] = [];
  let runtime: HiddenDesktop | undefined, fake: Awaited<ReturnType<typeof fakeWorkspace>> | undefined;
  let launchLogs: readonly string[] | undefined;
  let lifecycle: unknown, cleanup: unknown, fatal: unknown, manifest: unknown;
  const priorCa = process.env.NODE_EXTRA_CA_CERTS;
  const priorPath = process.env.PATH;
  try {
    const sha256 = createHash('sha256').update(await readFile(options.zipPath)).digest('hex');
    const extraction = await runCommand(join(workspaceRoot, 'tools/pack/resources/win/7zip/7z.exe'),
      ['x', options.zipPath, `-o${scratch}`, '-y']);
    assert.equal(extraction.exitCode, 0, extraction.stderr);
    manifest = { zipPath: options.zipPath, sha256, scratch, namespace: options.namespace };
    if (options.journeys.includes('databricks-fake')) {
      fake = await fakeWorkspace(scratch);
      // Inherited only by our isolated packaged child; no real credentials or workspace traffic.
      process.env.NODE_EXTRA_CA_CERTS = fake.cert;
      process.env.PATH = `${fake.bin};${priorPath ?? ''}`;
    }
    runtime = await launchHiddenDesktop({ executablePath: join(scratch, 'Readable Studio.exe'),
      namespace: options.namespace, debugPort: await freePort() });
    if (priorCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = priorCa;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    const { page } = runtime;
    page.setDefaultTimeout(15_000);
    await page.locator('html[data-readable-app-mounted="1"]').waitFor({ state: 'attached', timeout: 60_000 });
    await page.locator('.readable-loading-shell').waitFor({ state: 'hidden', timeout: 60_000 });
    const processes = await captureProcesses(runtime.rootPid), windowsBefore = await runtime.inspectWindows();
    const daemon = daemonUrlFromProcesses(processes);
    assert.equal(runtime.inputDesktopBefore, runtime.inputDesktopAfter);
    assert.deepEqual(windowsBefore.activeOwnedWindowPids, []);
    assert.ok(windowsBefore.privateWindowPids.length);
    const health = await page.request.get(`${daemon}/api/health`);
    assert.ok(health.ok(), `Daemon health: ${health.status()}`);
    lifecycle = { rootPid: runtime.rootPid, hostPid: runtime.hostPid, desktop: runtime.desktopName,
      inputBefore: runtime.inputDesktopBefore, inputAfter: runtime.inputDesktopAfter, windowsBefore, daemon, apiReachable: true };
    const config = { onboardingCompleted: true, privacyDecisionAt: 1,
      telemetry: { metrics: false, content: false, artifactManifest: false } };
    assert.ok((await page.request.put(`${daemon}/api/app-config`, { data: config })).ok());
    await page.evaluate(config => {
      localStorage.setItem('readable-studio:welcome-modal-shown', '1');
      localStorage.setItem('readable-studio:locale', 'en');
      localStorage.setItem('readable-studio:locale-source', 'manual');
      localStorage.setItem('readable-studio:config', JSON.stringify(config));
    }, config);
    const observe = (request: Request) => {
      if (request.method() === 'POST' && /\/api\/(?:projects|sessions|chat|runs)(?:\/|$)/.test(request.url()))
        captured.push({ url: request.url(), body: request.postDataJSON() });
    };
    page.on('request', observe);
    await page.reload();
    await page.locator('.readable-loading-shell').waitFor({ state: 'hidden', timeout: 60_000 });
    await home(page);
    await page.screenshot({ path: join(options.evidenceRoot, 'hub-entry.png'), fullPage: true });
    // Prove the renderer request listener works even when the old ZIP stops
    // before template submission at the absent import endpoint.
    const capturedRequest = page.waitForRequest(request => request.method() === 'POST' && /\/api\/projects$/.test(request.url()));
    const captureProbe = await page.evaluate(async () => {
      const response = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: crypto.randomUUID(), name: 'Request capture proof' }) });
      return { status: response.status, body: await response.json() };
    });
    const probeBody = (await capturedRequest).postDataJSON();
    assert.equal(probeBody.name, 'Request capture proof');
    assert.ok(captureProbe.status >= 200 && captureProbe.status < 300, JSON.stringify(captureProbe));
    const created = await runCli(await resolvePackagedAppRoot(scratch),
      ['project', 'create', '--name', 'Release packaged QA', '--json'], daemon);
    const projectId: string = JSON.parse(created.stdout).project.id;
    const seed = async (name: string, content: string) => {
      const response = await page.request.post(`${daemon}/api/projects/${projectId}/files`, { data: { name, content } });
      assert.ok(response.ok(), `${name}: ${response.status()} ${await response.text()}`);
    };
    const journey = async (name: typeof names[number], action: (r: Result, shot: (state: string) => Promise<void>) => Promise<void>) => {
      if (!options.journeys.includes(name)) return;
      const r: Result = { name, status: 'FAILED', boundary: 'entry', elapsedMs: 0, screenshots: [], details: {} };
      const start = Date.now();
      const shot = async (state: string) => {
        const path = join(options.evidenceRoot, `${name}-${state}.png`);
        await page.screenshot({ path, fullPage: true, animations: 'disabled' }); r.screenshots.push(path);
      };
      try { await action(r, shot); r.status = 'PASSED'; }
      catch (error) { r.error = error instanceof Error ? error.stack ?? error.message : String(error); await shot('failure').catch(() => {}); }
      finally { r.elapsedMs = Date.now() - start; results.push(r); console.log(JSON.stringify(r)); }
    };
    await journey('neutral-modern', async (r, shot) => {
      r.boundary = 'retired design system config';
      const selection = { designSystemId: 'neutral-modern', mode: 'api',
        model: 'release-qa-capture', apiKey: 'fake-only', baseUrl: 'http://127.0.0.1:9' };
      assert.ok((await page.request.put(`${daemon}/api/app-config`, { data: selection })).ok());
      await page.evaluate(selection => {
        const current = JSON.parse(localStorage.getItem('readable-studio:config') ?? '{}');
        localStorage.setItem('readable-studio:config', JSON.stringify({ ...current, ...selection }));
      }, selection);
      await page.route('**/api/chat', route => route.fulfill({ status: 503,
        contentType: 'application/json', body: '{"error":"QA capture only; no inference"}' }));
      await page.reload(); await home(page);
      r.boundary = 'Hub composer has no design system';
      const composer = page.getByTestId('hub-composer');
      await expect(composer).toBeVisible();
      await expect(composer.getByText('Neutral Modern', { exact: false })).toHaveCount(0);
      await expect(composer.locator('.project-ds-picker-trigger.picked')).toHaveCount(0);
      r.details.composer = await composer.innerText();
      await shot('composer');
      r.boundary = 'created project designSystemId';
      const outgoing = page.waitForResponse(response => response.request().method() === 'POST'
        && /\/api\/sessions$/.test(response.url()), { timeout: 30_000 });
      await page.locator('[contenteditable="true"]').first().fill('Create a simple QA page.');
      await page.locator('[contenteditable="true"]').first().press('Enter');
      const response = await outgoing;
      assert.ok(response.ok(), `Create project: ${response.status()} ${await response.text()}`);
      r.details.createPayload = response.request().postDataJSON();
      assert.equal((r.details.createPayload as { designSystemId: string | null }).designSystemId, null);
      const created = await response.json();
      const id = created.workspace?.id;
      assert.ok(id, JSON.stringify(created));
      const storedResponse = await page.request.get(`${daemon}/api/projects/${id}`);
      assert.ok(storedResponse.ok());
      const stored = await storedResponse.json();
      r.details.project = stored.project ?? stored;
      assert.equal((r.details.project as { designSystemId: string | null }).designSystemId, null);
      await page.getByTestId('project-ds-picker-trigger').waitFor({ state: 'visible', timeout: 30_000 });
      await shot('created');
      await page.unroute('**/api/chat');
    });
    await journey('template-import', async (r, shot) => {
      r.boundary = 'multipart import';
      const response = await page.request.post(`${daemon}/api/design-templates/import`, {
        multipart: { file: { name: 'release-qa-deck.zip', mimeType: 'application/zip', buffer: templateZip() } } });
      r.details.importStatus = response.status();
      assert.ok(response.ok(), `Import: ${response.status()} ${await response.text()}`);
      const imported = await response.json(), id: string = imported.template.id;
      r.details.id = id; assert.match(id, /^user-/);
      r.boundary = 'Electron offscreen thumbnail';
      await expect.poll(async () => {
        const listing = await page.request.get(`${daemon}/api/design-templates`);
        const item = (await listing.json()).designTemplates.find((item: { id: string }) => item.id === id);
        r.details.thumbnail = item?.thumbnail;
        return item?.thumbnail.status;
      }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe('ready');
      const thumbnail = await page.request.get(`${daemon}/api/design-templates/${id}/thumbnail`);
      assert.ok(thumbnail.ok());
      const body = await thumbnail.body();
      // Decode in the real renderer and check pixel diversity, not just compressed file size.
      r.details.thumbnailPixels = await page.evaluate(async data => {
        const image = new Image(); image.src = data; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0, 64, 36);
        const pixels = context.getImageData(0, 0, 64, 36).data, colors = new Set<string>();
        for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        return { width: image.naturalWidth, height: image.naturalHeight, colors: colors.size };
      }, `data:${thumbnail.headers()['content-type']};base64,${body.toString('base64')}`);
      assert.ok((r.details.thumbnailPixels as { colors: number }).colors > 10, 'Thumbnail is blank');
      assert.deepEqual({
        width: (r.details.thumbnailPixels as { width: number }).width,
        height: (r.details.thumbnailPixels as { height: number }).height,
      }, { width: 480, height: 270 }, 'Cover thumbnail did not use the 1280 × 720 page');
      // PNG evidence is renderer-decoded even when the API serves WebP.
      await page.evaluate(async data => {
        const image = new Image(); image.src = data; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d')!.drawImage(image, 0, 0);
        return canvas.toDataURL('image/png');
      }, `data:${thumbnail.headers()['content-type']};base64,${body.toString('base64')}`).then(data =>
        writeFile(join(options.evidenceRoot, 'template-thumbnail.png'), Buffer.from(data.split(',')[1]!, 'base64')));
      // Capture the routing contract without calling a real model.
      const selection = { mode: 'api', model: 'release-qa-capture', apiKey: 'fake-only',
        baseUrl: fake?.host ?? 'http://127.0.0.1:9' };
      assert.ok((await page.request.put(`${daemon}/api/app-config`, { data: selection })).ok());
      await page.evaluate(selection => {
        const current = JSON.parse(localStorage.getItem('readable-studio:config') ?? '{}');
        localStorage.setItem('readable-studio:config', JSON.stringify({ ...current, ...selection }));
      }, selection);
      await page.route('**/api/chat', route => route.fulfill({ status: 503,
        contentType: 'application/json', body: '{"error":"QA capture only; no inference"}' }));
      await page.reload(); await home(page); await page.locator('[data-tab-id="deck"]').click();
      let card = page.locator('.is-user-template').filter({ hasText: 'Release QA Deck' });
      r.boundary = 'Hub badge and thumbnail';
      await expect(card.getByText('Added by you')).toBeVisible();
      await expect(card.locator('img')).toBeVisible(); await shot('card');
      r.boundary = 'upload wizard native page dimensions';
      await page.getByRole('button', { name: 'Upload a template', exact: true }).first().click();
      const upload = page.getByRole('dialog');
      await upload.getByRole('button', { name: 'Slide decks', exact: true }).click();
      await upload.getByRole('button', { name: 'Next', exact: true }).click();
      await upload.getByTestId('template-upload-file').setInputFiles({
        name: 'release-qa-dimensions.zip', mimeType: 'application/zip', buffer: templateZip(),
      });
      await page.evaluate(() => {
        const frames: Array<{ file: string; width: string | null; height: string | null }> = [];
        const observer = new MutationObserver(() => {
          for (const frame of document.querySelectorAll<HTMLIFrameElement>('[data-testid="template-upload-page"] iframe')) {
            frames.push({ file: frame.title, width: frame.getAttribute('width'), height: frame.getAttribute('height') });
          }
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        Object.assign(window, { releaseQaTemplateFrames: frames, releaseQaTemplateObserver: observer });
      });
      try {
        const analysed = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === '/api/design-template-uploads/analyse');
        await upload.getByRole('button', { name: 'Next', exact: true }).click();
        const analysisResponse = await analysed;
        assert.ok(analysisResponse.ok(), await analysisResponse.text());
        const analysis: DesignTemplateUploadAnalysisResponse = await analysisResponse.json();
        const dimensions = [
          { file: 'slide-1.html', width: 1280, height: 720, outWidth: 480, outHeight: 270 },
          { file: 'slide-3.html', width: 900, height: 1200, outWidth: 360, outHeight: 480 },
          { file: 'responsive.html', width: 1920, height: 1080, outWidth: 480, outHeight: 270 },
        ];
        for (const dimension of dimensions) {
          assert.deepEqual(analysis.pages.find(page => page.file === dimension.file)?.viewport,
            { width: dimension.width, height: dimension.height }, `Wrong uploaded viewport: ${dimension.file}`);
          const pageCard = upload.getByTestId('template-upload-page').filter({ hasText: dimension.file });
          await pageCard.scrollIntoViewIfNeeded();
          await expect(pageCard.locator(':scope > span[aria-hidden="true"]'))
            .toHaveCSS('aspect-ratio', `${dimension.width} / ${dimension.height}`);
        }
        await expect.poll(() => page.evaluate(() =>
          (window as unknown as { releaseQaTemplateFrames: unknown[] }).releaseQaTemplateFrames))
          .toEqual(expect.arrayContaining(dimensions.map(dimension => ({
            file: dimension.file, width: String(dimension.width), height: String(dimension.height),
          }))));
        r.details.uploadAnalysis = analysis;
        r.details.previewFrames = await page.evaluate(() =>
          (window as unknown as { releaseQaTemplateFrames: unknown[] }).releaseQaTemplateFrames);
        await shot('upload-native-dimensions');
        let rendered = analysis;
        await expect.poll(async () => {
          rendered = await (await page.request.get(`${daemon}/api/design-template-uploads/${analysis.sessionId}`)).json();
          return rendered.pages.every(page => page.thumbnail.status === 'ready');
        }, { timeout: 60_000 }).toBe(true);
        const thumbnailSizes = [];
        for (const dimension of dimensions) {
          const pageInfo = rendered.pages.find(page => page.file === dimension.file)!;
          const response = await page.request.get(new URL(pageInfo.thumbnailUrl, daemon).href);
          assert.ok(response.ok(), `${dimension.file}: thumbnail unavailable`);
          const pixels = await page.evaluate(async data => {
            const image = new Image(); image.src = data; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
            canvas.getContext('2d')!.drawImage(image, 0, 0);
            return { width: image.naturalWidth, height: image.naturalHeight, png: canvas.toDataURL('image/png') };
          }, `data:${response.headers()['content-type']};base64,${(await response.body()).toString('base64')}`);
          assert.deepEqual({ width: pixels.width, height: pixels.height },
            { width: dimension.outWidth, height: dimension.outHeight }, `Wrong native thumbnail: ${dimension.file}`);
          thumbnailSizes.push({ file: dimension.file, width: pixels.width, height: pixels.height });
          await writeFile(join(options.evidenceRoot, `template-${dimension.file}.png`), Buffer.from(pixels.png.split(',')[1]!, 'base64'));
        }
        r.details.thumbnailSizes = thumbnailSizes;
        await upload.getByTestId('template-upload-page').filter({ hasText: 'slide-3.html' }).click();
        await upload.getByRole('button', { name: 'Next', exact: true }).click();
        await expect(upload.locator('span[aria-hidden="true"][style*="900 / 1200"]')).toBeVisible();
        await shot('upload-custom-cover');
      } finally {
        await page.evaluate(() =>
          (window as unknown as { releaseQaTemplateObserver: MutationObserver }).releaseQaTemplateObserver.disconnect());
        await upload.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(upload).toHaveCount(0);
      }
      r.boundary = 'rename menu';
      await card.getByRole('button', { name: 'Manage template' }).click();
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
      await page.getByRole('dialog').getByRole('textbox').fill('Release QA Renamed');
      await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
      card = page.locator('.is-user-template').filter({ hasText: 'Release QA Renamed' });
      await expect(card).toBeVisible(); await shot('renamed');
      r.boundary = 'create-project payload';
      await card.locator('.home-hero__template-card').click();
      const outgoing = page.waitForRequest(request => request.method() === 'POST' && /\/api\/sessions$/.test(request.url()), { timeout: 30_000 });
      await page.locator('[contenteditable="true"]').first().fill('Make three slides about the QA release.');
      await page.locator('[contenteditable="true"]').first().press('Enter');
      const payload = (await outgoing).postDataJSON();
      r.details.createPayload = payload;
      assert.equal(payload.skillId, id); assert.equal(payload.metadata.templateRef.id, id);
      assert.equal(payload.metadata.kind, 'deck'); assert.ok(!payload.pluginId);
      await page.waitForURL(new RegExp(`/projects/${payload.id}(?:/|$)`), { timeout: 30_000 });
      await page.getByTestId('project-ds-picker-trigger').waitFor({ state: 'visible', timeout: 30_000 });
      await home(page); await page.locator('[data-tab-id="deck"]').click();
      r.boundary = 'delete menu';
      await card.getByRole('button', { name: 'Manage template' }).click();
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(card).toHaveCount(0); await shot('deleted');
    });
    await journey('standalone-large', async (r, shot) => {
      r.boundary = '120 MiB fixture';
      const projectDir = join(scratch, 'ReadableStudioData/namespaces', options.namespace, 'data/projects', projectId);
      await mkdir(join(projectDir, 'assets'), { recursive: true });
      const asset = Buffer.alloc(10 * 1024 * 1024, 65);
      for (let i = 0; i < 12; i++) await writeFile(join(projectDir, `assets/large-${i}.svg`),
        Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--'), asset, Buffer.from('--></svg>')]));
      await seed('large.html', `<!doctype html><html><body><h1>120 MiB standalone export</h1>${Array.from({ length: 12 }, (_, i) => `<img src="assets/large-${i}.svg">`).join('')}</body></html>`);
      await seed('download-proof.html', '<!doctype html><html><body><h1>Native download proof</h1></body></html>');
      for (const fileName of ['download-proof.html', 'large.html']) {
      const small = fileName === 'download-proof.html';
      await home(page);
      await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); },
        `/projects/${projectId}/files/${fileName}`);
      await page.getByRole('tab', { name: fileName, exact: false }).first().click();
      await shot(small ? 'download-proof-entry' : 'entry');
      r.boundary = small ? 'native download preflight' : 'standalone download';
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      const start = Date.now();
      const downloads = join(scratch, 'downloads');
      await mkdir(downloads, { recursive: true });
      const browser = page.context().browser(); assert.ok(browser);
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
      let guid: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      let finish: (value: string) => void, fail: (error: Error) => void;
      const completed = new Promise<string>((done, reject) => {
        finish = done; fail = reject;
        timer = setTimeout(() => reject(new Error('Native standalone download did not complete in 90 s')), 90_000);
      });
      void completed.catch(() => {});
      cdp.on('Browser.downloadWillBegin', event => { guid = event.guid; r.details.suggestedFilename = event.suggestedFilename; });
      cdp.on('Browser.downloadProgress', event => {
        if (event.guid !== guid) return;
        if (event.state === 'completed') finish(event.guid);
        if (event.state === 'canceled') fail(new Error('Native download was canceled'));
      });
      const response = page.waitForResponse(response => response.request().method() === 'POST'
        && response.url().endsWith('/api/exports/standalone-html'), { timeout: 90_000 });
      void response.catch(() => {});
      try {
        await page.getByRole('menuitem', { name: 'Export as standalone HTML', exact: true }).click();
        const exported = await response;
        r.details.exportStatus = exported.status();
        if (!exported.ok()) assert.fail(`Standalone export: ${exported.status()} ${await exported.text()}`);
        const path = join(downloads, await completed);
        r.details.bytes = (await stat(path)).size; r.details.exportMs = Date.now() - start;
        if (small) r.details.nativeDownloadPreflight = { bytes: r.details.bytes, exportMs: r.details.exportMs };
        assert.ok(Number(r.details.bytes) > (small ? 0 : 100 * 1024 * 1024));
        await expect(page.getByText(/너무 커서|too large to export/)).toHaveCount(0);
        await shot(small ? 'download-proof-completed' : 'completed');
      } finally {
        if (timer) clearTimeout(timer);
        await cdp.detach();
      }
      }
    });
    await journey('databricks-fake', async (r, shot) => {
      assert.ok(fake); r.details.upstream = fake.host;
      await page.unroute('**/api/chat');
      r.details.authenticationMode = 'cli-profile (workspace-token cannot refresh)';
      r.boundary = 'fake CLI profile setup';
      const setup = await page.request.post(`${daemon}/api/databricks/setup`,
        { data: { mode: 'cli-profile' } });
      assert.ok(setup.ok(), `Workspace setup: ${setup.status()} ${await setup.text()}`);
      const profileId = (await setup.json()).profile.id;
      const startScan = await page.request.post(`${daemon}/api/databricks/scans/named`,
        { data: { profileId, names: 'qa-claude', allowInference: true } });
      assert.ok(startScan.ok(), await startScan.text());
      const scanId = (await startScan.json()).scanId;
      let scan: { state: string; revision: number; endpoints: Array<{ id: string }> } | undefined;
      await expect.poll(async () => {
        scan = await (await page.request.get(`${daemon}/api/databricks/scans/${scanId}`)).json();
        return scan?.state;
      }, { timeout: 45_000 }).toMatch(/complete|partial/);
      assert.ok(scan?.endpoints[0]);
      const enabled = await page.request.put(`${daemon}/api/databricks/models/${scan.endpoints[0].id}`,
        { data: { scanId, expectedRevision: scan.revision } });
      assert.ok(enabled.ok(), await enabled.text());
      const modelId = (await enabled.json()).appModelId;
      r.details.modelId = modelId; r.boundary = 'thinking picker';
      const selection = { mode: 'daemon', agentId: 'databricks', enabledAgentIds: ['databricks'] };
      assert.ok((await page.request.put(`${daemon}/api/app-config`, { data: selection })).ok());
      await page.evaluate(selection => {
        const current = JSON.parse(localStorage.getItem('readable-studio:config') ?? '{}');
        localStorage.setItem('readable-studio:config', JSON.stringify({ ...current, ...selection }));
      }, selection);
      await page.reload(); await home(page);
      await page.getByTestId('inline-model-switcher-model-label').first().click();
      await page.getByTestId(`inline-model-switcher-model-option-${modelId}`).click();
      await expect(page.getByTestId('inline-model-switcher-reasoning-label').first()).toBeVisible();
      await shot('picker'); fake.arm(); r.boundary = 'thinking and retry stream';
      await page.evaluate(() => {
        const observations: string[] = [];
        Object.assign(window, { releaseQaRetryObservations: observations });
        const observer = new MutationObserver(() => {
          for (const match of document.body.innerText.matchAll(/\(\d+\/10\)/g)) observations.push(match[0]);
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        Object.assign(window, { releaseQaRetryObserver: observer });
      });
      await page.locator('[contenteditable="true"]').first().fill('Reply with the QA proof.');
      await page.locator('[contenteditable="true"]').first().press('Enter');
      await expect(page.getByText('Release QA complete.', { exact: false })).toBeVisible({ timeout: 90_000 });
      await page.locator('.thinking-block .thinking-toggle').last().click();
      await expect(page.getByText('Release QA thinking proof.', { exact: false })).toBeVisible();
      const retries = await page.evaluate(() => {
        const state = window as unknown as { releaseQaRetryObservations: string[]; releaseQaRetryObserver: MutationObserver };
        state.releaseQaRetryObserver.disconnect(); return state.releaseQaRetryObservations;
      });
      r.details.retryObservations = retries;
      assert.ok(retries.length, 'No (n/10) retry status observed');
      await expect(page.getByText(/\(\d+\/10\)/)).toHaveCount(0);
      assert.deepEqual(fake.calls.filter(call => call.status !== 200).map(call => call.status), [503, 503, 503, 401]);
      const rejected = fake.calls.find(call => call.status === 401);
      const successful = fake.calls.filter(call => call.status === 200 && call.stream && call.path.endsWith('/messages')).at(-1);
      assert.ok(rejected && successful && rejected.bearer !== successful.bearer, '401 did not refresh the CLI token');
      r.details.tokenAcquisitions = await readFile(fake.counter, 'utf8');
      await shot('complete');
    });
    await journey('global-retry', async (r, shot) => {
      r.boundary = 'isolated fake agent setup';
      const fakeRoot = join(scratch, 'global-retry-agents');
      const { claude, codex } = await createFakeAgentRuntimes({ root: fakeRoot, runtimeIds: ['claude', 'codex'] });
      const codexHome = join(fakeRoot, 'codex-home');
      await mkdir(codexHome);
      codex.env.CODEX_HOME = codexHome;
      const selection = { mode: 'daemon', agentId: 'claude', model: 'sonnet', enabledAgentIds: ['claude'],
        agentModels: { claude: { model: 'sonnet', reasoning: 'default' } }, agentCliEnv: { claude: claude.env, codex: codex.env } };
      assert.ok((await page.request.put(`${daemon}/api/app-config`, { data: selection })).ok());
      await page.evaluate(selection => {
        localStorage.setItem('readable-studio:locale', 'ko');
        localStorage.setItem('readable-studio:locale-source', 'manual');
        const current = JSON.parse(localStorage.getItem('readable-studio:config') ?? '{}');
        localStorage.setItem('readable-studio:config', JSON.stringify({ ...current, ...selection }));
      }, selection);
      await page.reload();
      await page.locator('.readable-loading-shell').waitFor({ state: 'hidden', timeout: 60_000 });
      const appRoot = await resolvePackagedAppRoot(scratch);
      const json = async (path: string) => {
        const response = await page.request.get(`${daemon}${path}`);
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      for (const scenario of Object.keys(GLOBAL_RETRY_RUN.prompts) as RetryScenario[]) {
        const succeeds = scenario === 'transient' || scenario === 'codex-fallback';
        if (scenario === 'codex-fallback') {
          const codexSelection = { ...selection, agentId: 'codex', model: 'gpt-5.4-mini', enabledAgentIds: ['codex'],
            agentModels: { codex: { model: 'gpt-5.4-mini', reasoning: 'default' } } };
          assert.ok((await page.request.put(`${daemon}/api/app-config`, { data: codexSelection })).ok());
          await page.evaluate(selection => {
            const current = JSON.parse(localStorage.getItem('readable-studio:config') ?? '{}');
            localStorage.setItem('readable-studio:config', JSON.stringify({ ...current, ...selection }));
          }, codexSelection);
          await page.reload();
          await page.locator('.readable-loading-shell').waitFor({ state: 'hidden', timeout: 60_000 });
        }
        r.boundary = `${scenario}: workspace entry`;
        const project = await page.request.post(`${daemon}/api/projects`, { data: {
          id: randomUUID(), name: `Global retry ${scenario}`, metadata: { kind: 'prototype' }, skipDiscoveryBrief: true,
        } });
        assert.ok(project.ok(), await project.text());
        const created = await project.json();
        const caseProjectId: string = created.project.id, conversationId: string = created.conversationId;
        assert.ok(caseProjectId && conversationId, JSON.stringify(created));
        const caseProjectDir = join(scratch, 'ReadableStudioData', 'namespaces', options.namespace, 'data', 'projects', caseProjectId);
        const ledgerPath = scenario === 'codex-fallback' ? join(caseProjectDir, CODEX_FALLBACK_RETRY_RUN.ledgerFile)
          : join(fakeRoot, `${GLOBAL_RETRY_RUN.ledgerPrefix}${scenario}.jsonl`);
        if (scenario === 'codex-fallback') {
          const armed = await page.request.post(`${daemon}/api/projects/${caseProjectId}/files`, {
            data: { name: CODEX_FALLBACK_RETRY_RUN.armFile, content: CODEX_FALLBACK_RETRY_RUN.armToken },
          });
          assert.ok(armed.ok(), await armed.text());
        }
        await page.evaluate(path => {
          history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate'));
        }, `/projects/${caseProjectId}/conversations/${conversationId}`);
        const input = page.getByTestId('chat-composer-input');
        await expect(input).toBeVisible({ timeout: 30_000 });
        await shot(`${scenario}-entry`);
        await input.fill(GLOBAL_RETRY_RUN.prompts[scenario]);
        const started = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === '/api/runs', { timeout: 30_000 });
        await page.getByTestId('chat-send').click();
        const response = await started;
        assert.ok(response.ok(), await response.text());
        const { runId } = await response.json();
        assert.ok(runId);
        let watchSettled = false;
        const watching = runCli(appRoot, ['run', 'watch', runId, '--json'], daemon)
          .then(async watched => {
            await writeFile(join(options.evidenceRoot, `global-retry-${scenario}-watch.jsonl`), watched.stdout);
            return watched;
          })
          .finally(() => { watchSettled = true; });
        void watching.catch(() => {});
        try {
          const progress = page.locator('[data-status="retrying"]');
          if (succeeds || scenario === 'exhausted') {
            r.boundary = `${scenario}: calm Korean retry progress`;
            await expect(progress).toHaveText('재시도 중 (1/10)', { timeout: 30_000 });
            await expect(page.locator('.chat-error-text')).toHaveCount(0);
            if (succeeds) {
              for (const line of GLOBAL_RETRY_RUN.partial.trim().split('\n')) await expect(page.locator('.chat-log')).toContainText(line);
            }
            await shot(`${scenario}-retrying`);
            if (scenario === 'exhausted') {
              await expect(progress).toHaveText('재시도 중 (10/10)', { timeout: 75_000 });
              await expect(page.locator('.chat-error-text')).toHaveCount(0);
              await shot('exhausted-tenth-retry');
            }
          }
          r.boundary = `${scenario}: packaged CLI watch and persisted outcome`;
          const watched = await watching;
          await writeFile(join(options.evidenceRoot, `global-retry-${scenario}-watch.jsonl`), watched.stdout);
          const events = watched.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
          const run = await json(`/api/runs/${runId}`);
          assert.equal(run.id, runId);
          assert.equal(run.conversationId, conversationId);
          await expect(progress).toHaveCount(0);
          if (succeeds) {
            for (const line of GLOBAL_RETRY_RUN.partial.trim().split('\n')) await expect(page.locator('.chat-log')).toContainText(line);
            await expect(page.locator('.chat-log')).toContainText(GLOBAL_RETRY_RUN.continuation.trim());
            await expect(page.locator('.chat-error-text')).toHaveCount(0);
          } else {
            const error = page.locator('.chat-error-text');
            await expect(error).toBeVisible();
            if (scenario === 'quota') await expect(error).toHaveText('계정의 사용량 한도 또는 이용 가능한 쿼터를 모두 소진했습니다. 요금제를 확인하거나 한도가 초기화된 뒤 다시 시도해 주세요.');
            if (scenario === 'invalid-model') await expect(error).toHaveText('모델 이름이 잘못되었거나 해당 모델을 찾을 수 없습니다. 모델 이름을 확인하거나 다른 모델을 선택해 주세요.');
          }
          await shot(`${scenario}-complete`);
          const messagesPath = `/api/projects/${caseProjectId}/conversations/${conversationId}/messages`;
          await expect.poll(async () => (await json(messagesPath)).messages
            .find((message: { role: string }) => message.role === 'assistant')?.runStatus,
          { timeout: 15_000 }).toBe(succeeds ? 'succeeded' : 'failed');
          const attempts = (await readFile(ledgerPath, 'utf8'))
            .trim().split('\n').map(line => JSON.parse(line));
          const evidence: RetryCaseEvidence = {
            run, events, attempts, messages: (await json(messagesPath)).messages,
            conversations: (await json(`/api/projects/${caseProjectId}/conversations`)).conversations,
            runs: (await json(`/api/runs?projectId=${caseProjectId}`)).runs,
          };
          const attemptGapsMs = verifyGlobalRetryCase(scenario, evidence);
          if (scenario === 'codex-fallback') {
            assert.equal(await readFile(join(caseProjectDir, CODEX_FALLBACK_RETRY_RUN.toolFile), 'utf8'), 'saved once\n',
              'Committed Codex file write was replayed');
          }
          r.details[scenario] = { projectId: caseProjectId, conversationId, runId, attemptGapsMs,
            executions: attempts.length, retryStatuses: events.filter((event: RetryCaseEvidence['events'][number]) =>
              event.event === 'agent' && event.data.label === 'retrying').length };
          await writeFile(join(options.evidenceRoot, `global-retry-${scenario}.json`), JSON.stringify(evidence, null, 2));
        } finally {
          if (!watchSettled) {
            await page.request.post(`${daemon}/api/runs/${runId}/cancel`).catch(() => {});
            await watching.catch(() => {});
          }
          if (!r.details[scenario]) {
            const diagnostics = {
              run: await json(`/api/runs/${runId}`).catch(() => null),
              ledger: await readFile(ledgerPath, 'utf8').catch(() => null),
              messages: await json(`/api/projects/${caseProjectId}/conversations/${conversationId}/messages`).catch(() => null),
            };
            r.details[scenario] = diagnostics;
            await writeFile(join(options.evidenceRoot, `global-retry-${scenario}-diagnostics.json`), JSON.stringify(diagnostics, null, 2));
          }
        }
      }
    });
    const windowsAfter = await runtime.inspectWindows();
    assert.deepEqual(windowsAfter.activeOwnedWindowPids, []);
    assert.equal(windowsAfter.inputDesktop, runtime.inputDesktopBefore);
    lifecycle = { ...lifecycle as object, windowsAfter, requestCaptureInstalled: true,
      uiNavigation: true, capturedRequests: captured.length };
  } catch (error) {
    if (error instanceof HiddenLaunchError) {
      cleanup = error.cleanup;
      launchLogs = error.logs;
    }
    fatal = error instanceof Error ? error.stack : String(error);
  }
  finally {
    if (priorCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = priorCa;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    try { if (runtime) cleanup = await runtime.close(); }
    catch (error) { fatal ??= String(error); }
    await fake?.close();
    const receipt = { status: fatal || results.some(r => r.status === 'FAILED') ? 'FAILED' : 'PASSED',
      manifest, lifecycle, cleanup, fatal, results, captured, upstreamCalls: fake?.calls,
      counts: { passed: results.filter(r => r.status === 'PASSED').length,
        failed: results.filter(r => r.status === 'FAILED').length + (fatal ? 1 : 0),
        skipped: results.filter(r => r.status === 'SKIPPED').length } };
    await writeFile(join(options.evidenceRoot, 'receipt.json'), JSON.stringify(receipt, null, 2));
    await writeFile(join(options.evidenceRoot, 'runtime.log'), (runtime?.logs ?? launchLogs)?.join('\n') ?? String(fatal ?? ''));
    const command = `pnpm --filter @readable-studio/e2e exec tsx scripts/release-packaged-qa.ts --zip "${options.zipPath}" --namespace ${options.namespace} --evidence "${options.evidenceRoot}"`;
    await writeFile(join(options.evidenceRoot, 'receipt.md'), `# Packaged release QA\n\nCommand (replace ZIP after integrated build):\n\n\`\`\`powershell\n${command}\n\`\`\`\n\n${results.map(r => `- ${r.name}: ${r.status}; boundary: ${r.boundary}; ${r.elapsedMs} ms. ${r.error ?? ''}`).join('\n')}\n\nLifecycle: ${JSON.stringify(lifecycle)}\n\nCleanup: ${JSON.stringify(cleanup)}\n\nFatal: ${String(fatal ?? 'none')}\n`);
    // Keep failed runtime logs and native launch evidence for diagnosis.
    if (receipt.status === 'PASSED') {
      await rm(scratch, { recursive: true, force: true }).catch(error => console.error(`Scratch cleanup: ${String(error)}`));
    } else console.error(`Failed runtime preserved: ${scratch}`);
    console.log(JSON.stringify({ status: receipt.status, counts: receipt.counts, cleanup }));
    return receipt;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  parseOptions(process.argv.slice(2)).then(runReleaseQa)
    .then(receipt => { process.exitCode = receipt.status === 'PASSED' ? 0 : 1; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
