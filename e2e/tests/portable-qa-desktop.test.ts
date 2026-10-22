import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runPortableQaHidden } from '../scripts/portable-qa-runtime.js';

it('contains the QA driver on a private desktop and preserves its exit code', async () => {
  const scratch = resolve('../.tmp/build-verify-speed/run1/st_01a1559b');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'hidden-'));
  const evidence = join(root, 'probe');
  try {
    const code = await runPortableQaHidden([], evidence, process.execPath, ['-e',
      'console.log("PRIVATE "+process.env.READABLE_PORTABLE_QA_PRIVATE_DESKTOP);'
      + 'const child=require("node:child_process").spawn(process.execPath,["-e",'
      + '"process.on(\\"message\\",()=>{});process.send(process.pid)"],'
      + '{windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]});'
      + 'child.once("message",pid=>{console.log("DESCENDANT "+pid);process.exit(7)})']);
    expect(code).toBe(7);
    const lines = (await readFile(`${evidence}.hidden-desktop.log`, 'utf8')).trim().split(/\r?\n/);
    const started = JSON.parse(lines.find((line) => line.startsWith('QA_DESKTOP_STARTED '))!.slice(19));
    const closed = JSON.parse(lines.find((line) => line.startsWith('QA_DESKTOP_CLOSED '))!.slice(18));
    expect(started.desktop).toMatch(/^readable-qa-/);
    expect(lines).toContain(`PRIVATE ${started.desktop}`);
    expect(closed).toMatchObject({
      handlesClosed: true, activeProcesses: 0, exitCode: 7,
      inputDesktopBefore: started.inputDesktop, inputDesktopAfter: started.inputDesktop,
    });
    const samples = lines.filter((line) => line.startsWith('QA_WINDOWS ')).map((line) => JSON.parse(line.slice(11)));
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples.every((sample) => sample.visible.length === 0)).toBe(true);
    const descendant = Number(lines.find((line) => line.startsWith('DESCENDANT '))!.slice(11));
    expect(descendant).toBeGreaterThan(0);
    expect(() => process.kill(descendant, 0)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
