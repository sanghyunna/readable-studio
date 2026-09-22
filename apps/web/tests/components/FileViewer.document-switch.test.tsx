// @vitest-environment jsdom
import { Profiler, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { renderMarkdownToSafeHtml } from '../../src/artifacts/markdown';
import type { ProjectFile } from '../../src/types';
import { deferred } from '../helpers/deferred';

vi.mock('../../src/artifacts/markdown', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/artifacts/markdown')>();
  return { ...actual, renderMarkdownToSafeHtml: vi.fn(actual.renderMarkdownToSafeHtml) };
});

const files: ProjectFile[] = ['report.md', 'notes.md', 'plan.md'].map(name => ({
  name, path: name, type: 'file', kind: 'text', mime: 'text/markdown', size: 40_000, mtime: 1,
}));
const documentText = (name: string) => `# ${name}\n\n` + Array.from({ length: 180 }, (_, i) =>
  `## Section ${i}\n\nA realistic **project report** with [references](https://example.com).\n\n| Decision | Status |\n| --- | --- |\n| Item ${i} | Approved |\n\n\`\`\`ts\nconst item${i} = ${i};\n\`\`\`\n`).join('\n');

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reuses derived markdown when revisiting an unchanged document after fresh reads', async () => {
  // Given: several substantial documents. Fetch remains real at the provider seam.
  const parse = vi.mocked(renderMarkdownToSafeHtml);
  parse.mockClear();
  const fetchMock = vi.fn(async () => new Response(body));
  let body = documentText('report.md');
  vi.stubGlobal('fetch', fetchMock);
  const commits: string[] = [];
  function Workspace() {
    const [index, setIndex] = useState(0);
    const file = files[index];
    if (!file) throw new Error('missing fixture document');
    return <><button onClick={() => setIndex(1)}>notes</button><button onClick={() => setIndex(0)}>report</button>
      <Profiler id="document" onRender={() => commits.push(document.querySelector('article')?.textContent ?? '')}>
        <FileViewer projectId="switch-fixture" projectKind="prototype" file={file} isDeck={false} />
      </Profiler></>;
  }
  await act(async () => { render(<Workspace />); });
  body = documentText('notes.md');
  await act(async () => { fireEvent.click(screen.getByText('notes')); });
  parse.mockClear(); fetchMock.mockClear(); commits.length = 0;
  body = documentText('report.md');
  // When: return to the first document, using a fresh server response.
  const start = performance.now();
  await act(async () => { fireEvent.click(screen.getByText('report')); });
  const elapsed = performance.now() - start;
  console.info('DOCUMENT_SWITCH', JSON.stringify({ requests: fetchMock.mock.calls.length, parses: parse.mock.calls.length, commits: commits.length, clickToDomMs: elapsed }));
  // Then: fresh content is visible without repeated parsing or a stale intermediate commit.
  expect(document.querySelector('article')?.textContent).toContain('report.md');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(parse.mock.calls.length).toBe(0);
  expect(commits.every(text => text === '' || text.startsWith('report.md'))).toBe(true);
});

it('never commits the previous project document while the next project read is pending', async () => {
  // Given: the same file name exists in two projects with different contents.
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('# old project')).mockReturnValueOnce(pending.promise));
  const file = files[0];
  if (!file) throw new Error('missing fixture document');
  const commits: string[] = [];
  const view = (projectId: string) => <Profiler id="document" onRender={() => commits.push(document.querySelector('article')?.textContent ?? '')}>
    <FileViewer projectId={projectId} projectKind="prototype" file={file} isDeck={false} />
  </Profiler>;
  let mounted: ReturnType<typeof render>;
  await act(async () => { mounted = render(view('old')); });
  commits.length = 0;
  // When: switch projects before the new document read completes.
  await act(async () => { mounted.rerender(view('new')); });
  const pendingCommits = [...commits];
  await act(async () => { pending.resolve(new Response('# new project')); });
  // Then: no previous-project text was ever committed under the new project identity.
  expect(pendingCommits.every(text => text === '')).toBe(true);
  expect(document.querySelector('article')?.textContent).toBe('new project');
});
