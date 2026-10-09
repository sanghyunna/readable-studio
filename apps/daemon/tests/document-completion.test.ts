import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { expectedDocumentArtifact, missingDocumentArtifact } from '../src/document-completion.js';
import { finalGenReportEvents } from './helpers/final-gen-report-events.js';

const roots: string[] = [];
const root = () => { const cwd = mkdtempSync(path.join(tmpdir(), 'document-completion-')); roots.push(cwd); return cwd; };
afterEach(() => { for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true }); });

for (const report of ['report-1', 'report-2'] as const) {
  it(`rejects the exact ${report} SSE completion without a plugin snapshot`, () => {
    const events = finalGenReportEvents[report];
    expect(events.at(-1)).toMatchObject({ event: 'end', status: 'succeeded', code: 0 });
    const text = events.flatMap(event => 'type' in event && event.type === 'text_delta' ? [event.delta] : []).join('');
    const artifact = expectedDocumentArtifact({ cwd: root(), metadata: { kind: 'report' }, sessionMode: 'design', pluginAuthoring: false });
    expect(artifact).toBeDefined();
    expect(missingDocumentArtifact(artifact, text)).toBe(true);
  });
}

it.each(['deck', 'report', 'website', 'prototype', 'template'])('requires a file for a new %s document without a plugin', kind => {
  expect(expectedDocumentArtifact({ cwd: root(), metadata: { kind }, sessionMode: 'design', pluginAuthoring: false })).toBeDefined();
});
it('preserves existing files, chat, plugin authoring and unclassified question sessions', () => {
  const cwd = root();
  const options = { cwd, metadata: { kind: 'report' }, sessionMode: 'design', pluginAuthoring: false };
  expect(expectedDocumentArtifact({ ...options, sessionMode: 'chat' })).toBeUndefined();
  expect(expectedDocumentArtifact({ ...options, pluginAuthoring: true, appliedPluginSnapshotId: 'snapshot' })).toBeUndefined();
  expect(expectedDocumentArtifact({ ...options, metadata: { kind: 'other' } })).toBeUndefined();
  writeFileSync(path.join(cwd, 'index.html'), 'existing');
  expect(expectedDocumentArtifact(options)).toBeUndefined();
});
it.each(['read-only', 'no-file-changes', 'question'])('accepts an explicit artifact-free completion for %s', reason => {
  const artifact = path.join(root(), 'index.html');
  expect(missingDocumentArtifact(artifact, `Answer\n<!-- readable:no-document-required reason="${reason}" -->`)).toBe(false);
});
it('does not exempt malformed or non-terminal intent signals', () => {
  const artifact = path.join(root(), 'index.html');
  expect(missingDocumentArtifact(artifact, '<!-- readable:no-document-required reason="done" -->')).toBe(true);
  expect(missingDocumentArtifact(artifact, '<!-- readable:no-document-required reason="read-only" -->\nindex.html written')).toBe(true);
});
it('allows a renderable question form to substitute for the artifact', () => {
  const artifact = path.join(root(), 'index.html');
  expect(missingDocumentArtifact(artifact, 'Which date should I use?')).toBe(true);
  expect(missingDocumentArtifact(artifact, '<question-form>{"questions":[{"id":"date","question":"Date?","options":[{"label":"A","value":"a"},{"label":"B","value":"b"}]}]}</question-form>')).toBe(false);
  writeFileSync(artifact, '');
  expect(missingDocumentArtifact(artifact, '')).toBe(true);
  writeFileSync(artifact, '<html>delivered</html>');
  expect(missingDocumentArtifact(artifact, '')).toBe(false);
});
