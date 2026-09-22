import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyBakedPreviews, bakedPreviewBlock } from '../src/plugin-preview-bakes.js';

vi.mock('node:fs', { spy: true });

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(tmpdir(), 'preview-cost-')); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('checks the manifest once per listing when 315 previews use an explicit origin', () => {
  // Given: real files and 315 installed records; spies retain real filesystem behavior.
  const records = Array.from({ length: 315 }, (_, i) => ({ id: `p-${i}`, manifest: { readable: { preview: { html: 'live.html' } } } }));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ previews: Object.fromEntries(records.map(({ id }) => [id, { video: `${id}.webm`, poster: `${id}.jpg`, holdMs: 300 }])) }));
  vi.stubEnv('READABLE_PLUGIN_PREVIEWS_BASE_URL', 'https://preview.example///');
  const exists = vi.spyOn(fs, 'existsSync');
  const stat = vi.spyOn(fs, 'statSync');
  const read = vi.spyOn(fs, 'readFileSync');
  // When: a catalogue response attaches baked previews and serializes its payload.
  const start = performance.now();
  const result = applyBakedPreviews(records, dir);
  const bytes = Buffer.byteLength(JSON.stringify(result));
  const ms = performance.now() - start;
  // Then: no per-record manifest or irrelevant local-media checks.
  console.info(JSON.stringify({ fixture: '315 previews', exists: exists.mock.calls.length, stat: stat.mock.calls.length, read: read.mock.calls.length, sql: 0, bytes, ms }));
  expect(result).toHaveLength(315);
  expect(result[0]?.manifest).toEqual({ readable: { preview: { html: 'live.html' }, bakedPreview: { video: 'https://preview.example/p-0.webm', poster: 'https://preview.example/p-0.jpg', holdMs: 300 } } });
  expect(records[0]?.manifest).toEqual({ readable: { preview: { html: 'live.html' } } });
  expect({ exists: exists.mock.calls.length, stat: stat.mock.calls.length, read: read.mock.calls.length }).toEqual({ exists: 1, stat: 1, read: 1 });
});

it('uses local media when both files exist without an explicit origin', () => {
  // Given
  vi.stubEnv('READABLE_PLUGIN_PREVIEWS_BASE_URL', '');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ previews: { p: { video: 'p.webm', poster: 'p.jpg' } } }));
  fs.writeFileSync(path.join(dir, 'p.webm'), 'video');
  fs.writeFileSync(path.join(dir, 'p.jpg'), 'poster');
  // When
  const block = bakedPreviewBlock('p', dir);
  // Then
  expect(block).toEqual({ video: '/api/plugin-previews/p.webm', poster: '/api/plugin-previews/p.jpg' });
});

it('observes local-media deletion on the next request even with a cached manifest', () => {
  // Given
  vi.stubEnv('READABLE_PLUGIN_PREVIEWS_BASE_URL', '');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ previews: { p: { video: 'p.webm', poster: 'p.jpg' } } }));
  fs.writeFileSync(path.join(dir, 'p.webm'), 'video');
  fs.writeFileSync(path.join(dir, 'p.jpg'), 'poster');
  bakedPreviewBlock('p', dir);
  fs.unlinkSync(path.join(dir, 'p.jpg'));
  // When
  const block = bakedPreviewBlock('p', dir);
  // Then
  expect(block?.video).toBe('https://repo-assets.readable-studio.ai/plugin-previews/p.webm');
});

it('keeps unmatched records unchanged when the manifest disappears between requests', () => {
  // Given
  const records = [{ id: 'p', manifest: {} }];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ previews: { p: { video: 'p.webm', poster: 'p.jpg' } } }));
  applyBakedPreviews(records, dir);
  fs.unlinkSync(path.join(dir, 'manifest.json'));
  // When
  const result = applyBakedPreviews(records, dir);
  // Then
  expect(result).toBe(records);
});
