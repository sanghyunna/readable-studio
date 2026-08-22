import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const pickerPath = path.resolve(import.meta.dirname, 'recording-picker.mjs');

async function runPicker(recordingsDir, environment) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const { pickRecording } = await import(${JSON.stringify(new URL(`file:///${pickerPath.replaceAll('\\', '/')}`).href)}); process.stdout.write(JSON.stringify(await pickRecording({ prompt: 'fixture' })));`,
    ],
    {
      env: {
        ...process.env,
        READABLE_MOCKS_RECORDINGS_DIR: recordingsDir,
        ...environment,
      },
    },
  );
  return JSON.parse(stdout);
}

test('selects a fixed recording when the Readable Studio trace contract is set', async () => {
  // Given: two deterministic local recordings.
  const root = await mkdtemp(path.join(os.tmpdir(), 'readable-recording-picker-'));
  try {
    await writeFile(path.join(root, 'alpha.jsonl'), '{"type":"meta","agent":"claude"}\n');
    await writeFile(path.join(root, 'beta.jsonl'), '{"type":"meta","agent":"codex"}\n');

    // When: the current trace selector requests beta.
    const picked = await runPicker(root, { READABLE_MOCKS_TRACE: 'beta' });

    // Then: the exact recording is selected through the fixed path.
    assert.equal(picked.traceId, 'beta');
    assert.equal(picked.method, 'fixed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ignores the retired trace selector without a compatibility alias', async () => {
  // Given: one deterministic local recording and only the retired selector.
  const root = await mkdtemp(path.join(os.tmpdir(), 'readable-recording-picker-'));
  try {
    await writeFile(path.join(root, 'alpha.jsonl'), '{"type":"meta","agent":"claude"}\n');

    // When: the old selector requests a nonexistent trace.
    const picked = await runPicker(root, { READABLE_MOCKS_TRACE: 'missing' });

    // Then: the unsupported variable is ignored rather than interpreted.
    assert.equal(picked.traceId, 'alpha');
    assert.equal(picked.method, 'random');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
