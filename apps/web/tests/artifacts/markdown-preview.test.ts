import { beforeEach, expect, it, vi } from 'vitest';
import { renderMarkdownToSafeHtml } from '../../src/artifacts/markdown';

vi.mock('../../src/artifacts/markdown', async original => {
  const actual = await original<typeof import('../../src/artifacts/markdown')>();
  return { ...actual, renderMarkdownToSafeHtml: vi.fn(actual.renderMarkdownToSafeHtml) };
});
beforeEach(() => { vi.resetModules(); vi.mocked(renderMarkdownToSafeHtml).mockClear(); });

it('reuses exact source output but reparses when any content changes', async () => {
  // Given: a rendered document.
  const { renderMarkdownPreview } = await import('../../src/artifacts/markdown-preview');
  const first = renderMarkdownPreview('# Original');
  // When: unchanged and changed revisions are rendered.
  const repeated = renderMarkdownPreview('# Original');
  const changed = renderMarkdownPreview('# Changed');
  // Then: exact content is reused; a new revision cannot receive old output.
  expect(repeated).toBe(first);
  expect(changed).not.toBe(first);
  expect(vi.mocked(renderMarkdownToSafeHtml).mock.calls.length).toBe(2);
});

it('evicts the least recently used source when the entry bound is exceeded', async () => {
  // Given: eight documents fill the cache, then the first is revisited.
  const { renderMarkdownPreview } = await import('../../src/artifacts/markdown-preview');
  for (let i = 0; i < 8; i += 1) renderMarkdownPreview(`# Doc ${i}`);
  renderMarkdownPreview('# Doc 0');
  // When: another document is rendered.
  renderMarkdownPreview('# Doc 8');
  // Then: the recently visited document remains; the older document is parsed again.
  vi.mocked(renderMarkdownToSafeHtml).mockClear();
  renderMarkdownPreview('# Doc 0');
  expect(vi.mocked(renderMarkdownToSafeHtml).mock.calls.length).toBe(0);
  renderMarkdownPreview('# Doc 1');
  expect(vi.mocked(renderMarkdownToSafeHtml).mock.calls.length).toBe(1);
});

it('does not retain a document larger than the character budget', async () => {
  // Given: one oversized document.
  const { renderMarkdownPreview } = await import('../../src/artifacts/markdown-preview');
  const source = 'x'.repeat(2_000_001);
  renderMarkdownPreview(source);
  vi.mocked(renderMarkdownToSafeHtml).mockClear();
  // When: it is rendered again.
  renderMarkdownPreview(source);
  // Then: it was not retained in memory.
  expect(vi.mocked(renderMarkdownToSafeHtml).mock.calls.length).toBe(1);
});
