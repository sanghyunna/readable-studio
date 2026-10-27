import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createReadToolDefinition, discoverAndLoadExtensions, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { databricksChildEnv } from '../../src/runtimes/env.js';

const originalCwd = process.cwd();
const extension = fileURLToPath(new URL('../../src/runtimes/pi-powershell-extension.ts', import.meta.url));
const context = { sessionManager: { getSessionId: () => 'encoding-fixture', getSessionFile: () => undefined } } as ExtensionContext;
let root: string;
let env: NodeJS.ProcessEnv;
let tools: Map<string, Pick<ToolDefinition, 'execute'>>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pi-shell-encoding-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  env = { ...databricksChildEnv(process.env), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home };
  process.chdir(root);
  const loaded = await discoverAndLoadExtensions([extension], root, home);
  expect(loaded.errors).toEqual([]);
  tools = new Map([['read', createReadToolDefinition(root)]]);
  for (const registered of loaded.extensions[0]!.tools.values()) tools.set(registered.definition.name, registered.definition);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
});

function tool(name: string): Pick<ToolDefinition, 'execute'> {
  const definition = tools.get(name);
  assert.ok(definition, `missing registered ${name} tool`);
  return definition;
}

function text(result: Awaited<ReturnType<ToolDefinition['execute']>>): string {
  return result.content.flatMap(content => content.type === 'text' ? [content.text] : []).join('\n');
}

async function execute(name: string, args: unknown): Promise<Awaited<ReturnType<ToolDefinition['execute']>>> {
  const originalEnv = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await tool(name).execute('encoding-fixture', args, undefined, undefined, context);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}

async function shell(command: string): Promise<string> {
  return text(await execute('powershell', { command }));
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

test('registered PowerShell preserves UTF-8 BOM/no-BOM and explicit UTF8 across separate calls', async () => {
  const expected = '# 템플릿\n한글 본문: 읽기 검증';
  await writeFile(path.join(root, 'no-bom.md'), expected, 'utf8');
  await writeFile(path.join(root, 'bom.md'), '\uFEFF' + expected, 'utf8');
  for (const command of [
    "Get-Content -LiteralPath 'no-bom.md' -Raw",
    "Get-Content -LiteralPath 'bom.md' -Raw",
    "Get-Content -LiteralPath 'no-bom.md' -Raw -Encoding UTF8",
    "Get-Content -LiteralPath 'no-bom.md' -Raw",
  ]) {
    expect((await shell(command)).trimEnd()).toBe(expected);
  }
  expect(await readFile(path.join(root, 'no-bom.md'), 'utf8')).toBe(expected);
});

test('explicit ASCII and UTF-16 file encodings override the UTF-8 default', async () => {
  // Invalid UTF-8 bytes distinguish the caller's explicit encoding on any Windows locale.
  await writeFile(path.join(root, 'ascii.md'), Buffer.from([0x41, 0xff, 0x42]));
  await writeFile(path.join(root, 'utf16.md'), Buffer.from('한글', 'utf16le'));
  expect((await shell("Get-Content -LiteralPath 'ascii.md' -Raw -Encoding ASCII")).trimEnd()).toBe('A?B');
  expect((await shell("Get-Content -LiteralPath 'utf16.md' -Raw -Encoding Unicode")).trimEnd()).toBe('한글');
});

test('native command stdout, stderr and piped input keep Korean and failure status', async () => {
  await writeFile(path.join(root, 'native-output.ts'), "process.stdout.write('표준출력'); process.stderr.write('표준오류');", 'utf8');
  await writeFile(path.join(root, 'native-pipe.ts'), "process.stdin.on('data', chunk => process.stdout.write(chunk));", 'utf8');
  await writeFile(path.join(root, 'native-failure.ts'), "process.stderr.write('실패본문'); process.exit(7);", 'utf8');
  const output = await shell(`& ${literal(process.execPath)} './native-output.ts'`);
  expect(output).toContain('표준출력');
  expect(output).toContain('표준오류');
  expect(output).not.toContain('\uFFFD');
  const pipeline = `'파이프입력' | & ${literal(process.execPath)} './native-pipe.ts'`;
  expect((await shell(pipeline)).trimEnd()).toBe('파이프입력');
  await expect(shell(`& ${literal(process.execPath)} './native-failure.ts'; exit $LASTEXITCODE`))
    .rejects.toThrow(/실패본문[\s\S]*Command exited with code 7/);
});

test('read retains UTF-8 line and byte caps with usable continuation offsets', async () => {
  for (const [name, input, truncatedBy] of [
    ['lines.md', Array.from({ length: 2100 }, (_, index) => `line ${index + 1} 한글`).join('\n'), 'lines'],
    ['bytes.md', Array.from({ length: 600 }, (_, index) => `line ${index + 1} ${'가'.repeat(80)}`).join('\n'), 'bytes'],
  ] as const) {
    await writeFile(path.join(root, name), input, 'utf8');
    const result = await execute('read', { path: name });
    const output = text(result);
    const offset = Number(output.match(/Use offset=(\d+)/)?.[1]);
    expect(offset).toBeGreaterThan(1);
    if (truncatedBy === 'lines') expect(offset).toBe(2001);
    expect(result.details).toMatchObject({ truncation: { truncated: true, truncatedBy, maxLines: 2000, maxBytes: 51200 } });
    expect(input.startsWith(output.split('\n\n[')[0]!)).toBe(true);
    expect(output).not.toContain('\uFFFD');
    const continued = text(await execute('read', { path: name, offset }));
    expect(continued.startsWith(input.split('\n')[offset - 1]!)).toBe(true);
  }
});

test.each(['relative', 'at-prefix', 'home', 'unicode-space'] as const)('long-line %s read provides executable UTF-8 chunks and a safe next character offset', async variant => {
  // Place a surrogate pair at the first chunk boundary, and quote the fixture path.
  const line = '가'.repeat(12799) + '😀' + '나'.repeat(6000);
  const fixture = "long 'line.md";
  await writeFile(path.join(variant === 'home' ? env.HOME! : root, fixture), `header\n${line}\nfooter`, 'utf8');
  const readPath = variant === 'at-prefix' ? '@' + fixture : variant === 'home' ? '~/' + fixture
    : variant === 'unicode-space' ? fixture.replaceAll(' ', '\u2000') : fixture;
  const result = await execute('read', { path: readPath, offset: 2 });
  const hint = text(result);
  expect(hint).not.toContain('Use bash:');
  const command = hint.match(/```powershell\n([\s\S]*?)\n```/)?.[1];
  assert.ok(command, 'read must provide a bounded Windows command');
  let actual = '';
  let start = 0;
  for (let chunk = 0; chunk < 3; chunk++) {
    const output = (await shell(command.replace('$start = 0', `$start = ${start}`))).replaceAll('\r\n', '\n');
    const footer = output.match(/\n\[(?:Next character offset: (\d+)|End of line)\]\n?$/);
    assert.ok(footer, 'chunk must identify continuation or end of line');
    actual += output.slice(0, footer.index);
    expect(output).not.toContain('\uFFFD');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(50 * 1024);
    if (!footer[1]) break;
    expect(Number(footer[1])).toBeGreaterThan(start);
    start = Number(footer[1]);
  }
  expect(actual.length).toBe(line.length);
  expect(actual === line, 'continued UTF-8 content must exactly match the fixture').toBe(true);
});
