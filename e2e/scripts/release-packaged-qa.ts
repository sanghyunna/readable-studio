import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, type Page, type Request } from '@playwright/test';
import { HiddenLaunchError, launchHiddenDesktop, type HiddenDesktop } from '../lib/packaged-hidden-desktop.ts';
import { resolvePackagedAppRoot } from './direct-edit-delete-packaged.ts';
import { captureProcesses, daemonUrlFromProcesses, runCli } from './portable-qa-runtime.ts';
import { runCommand, validateEvidenceRoot, workspaceRoot } from './portable-qa-support.ts';

const names = ['template-import', 'standalone-large', 'databricks-fake', 'neutral-modern'] as const;
type Options = { zipPath: string; namespace: string; evidenceRoot: string; journeys: string[] };
type Result = { name: string; status: 'PASSED' | 'FAILED' | 'SKIPPED'; boundary: string;
  error?: string; elapsedMs: number; screenshots: string[]; details: Record<string, unknown> };

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
    'PROMPT.md': '---\nname: Release QA Deck\ncover: slide-1.html\ndescription: Fixed-size QA slides\npages:\n  - file: slide-1.html\n    use: cover\n---\nUse these layouts with the supplied content.\n',
    'assets/deck.css': 'html,body{margin:0;width:1280px;height:720px;background:#163a66;color:#fff;font:48px Arial}h1{padding:100px}p{padding:0 100px;color:#ffcc55}',
    ...Object.fromEntries([1, 2, 3].map(n => [`slide-${n}.html`,
      `<!doctype html><html><head><link rel="stylesheet" href="assets/deck.css"></head><body><h1>Release QA ${n}</h1><p>Visible golden slide content</p></body></html>`])),
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
    const windowsAfter = await runtime.inspectWindows();
    assert.deepEqual(windowsAfter.activeOwnedWindowPids, []);
    assert.equal(windowsAfter.inputDesktop, runtime.inputDesktopBefore);
    lifecycle = { ...lifecycle as object, windowsAfter, requestCaptureInstalled: true,
      uiNavigation: true, capturedRequests: captured.length };
  } catch (error) {
    if (error instanceof HiddenLaunchError) cleanup = error.cleanup;
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
    await writeFile(join(options.evidenceRoot, 'runtime.log'), runtime?.logs.join('\n') ?? String(fatal ?? ''));
    const command = `pnpm --filter @readable-studio/e2e exec tsx scripts/release-packaged-qa.ts --zip "${options.zipPath}" --namespace ${options.namespace} --evidence "${options.evidenceRoot}"`;
    await writeFile(join(options.evidenceRoot, 'receipt.md'), `# Packaged release QA\n\nCommand (replace ZIP after integrated build):\n\n\`\`\`powershell\n${command}\n\`\`\`\n\n${results.map(r => `- ${r.name}: ${r.status}; boundary: ${r.boundary}; ${r.elapsedMs} ms. ${r.error ?? ''}`).join('\n')}\n\nLifecycle: ${JSON.stringify(lifecycle)}\n\nCleanup: ${JSON.stringify(cleanup)}\n\nFatal: ${String(fatal ?? 'none')}\n`);
    // Our extraction only; the supplied root ZIP and owner's app are read-only.
    await rm(scratch, { recursive: true, force: true }).catch(error => console.error(`Scratch cleanup: ${String(error)}`));
    console.log(JSON.stringify({ status: receipt.status, counts: receipt.counts, cleanup }));
    return receipt;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  parseOptions(process.argv.slice(2)).then(runReleaseQa)
    .then(receipt => { process.exitCode = receipt.status === 'PASSED' ? 0 : 1; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
