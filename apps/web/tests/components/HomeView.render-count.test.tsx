// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { $getSelection, $isRangeSelection } from 'lexical';
import { HomeView } from '../../src/components/HomeView';
import { I18nProvider } from '../../src/i18n';
import { getHomeHeroEditor, homeHeroPromptText } from '../helpers/home-hero-lexical';

const counts = vi.hoisted(() => {
  type Fiber = {
    readonly tag: number;
    readonly flags: number;
    readonly type?: { readonly name?: string; readonly render?: { readonly name?: string } };
    readonly child: Fiber | null;
    readonly sibling: Fiber | null;
  };
  const commits: string[][] = [];
  let previous = new WeakSet<Fiber>();
  Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
    configurable: true,
    value: {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberUnmount: () => undefined,
      onCommitFiberRoot: (_id: number, root: { readonly current: Fiber }) => {
        const rendered: string[] = [];
        const current = new WeakSet<Fiber>();
        function visit(fiber: Fiber | null): void {
          if (!fiber) return;
          current.add(fiber);
          // Bailed-out subtrees retain old PerformedWork flags on reused fibers.
          if (!previous.has(fiber) && (fiber.flags & 1) !== 0 && [0, 1, 11, 14, 15].includes(fiber.tag)) {
            rendered.push(fiber.type?.name ?? fiber.type?.render?.name ?? `tag:${fiber.tag}`);
          }
          visit(fiber.child);
          visit(fiber.sibling);
        }
        visit(root.current);
        previous = current;
        commits.push(rendered);
      },
    },
  });
  return { commits };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  counts.commits.length = 0;
});

it('keeps first-character rendering local without adding Hub mount commits', async () => {
  // Given: the real owner and real Lexical composer, with settled catalogue IO.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/plugins') return Response.json({ plugins: [] });
    if (url === '/api/mcp') return Response.json({ servers: [], templates: [] });
    throw new Error(`Unexpected request: ${url}`);
  }));
  await act(async () => {
    render(<I18nProvider initial="en"><HomeView surface="hub" projects={[]}
      projectsLoading onSubmit={() => undefined} onOpenProject={() => undefined}
      onViewAllProjects={() => undefined} /></I18nProvider>);
  });
  const mountCommits = counts.commits.length;
  const editor = getHomeHeroEditor();
  await act(async () => {
    editor.focus();
  });
  counts.commits.length = 0;

  // When: the first character is inserted through Lexical's live selection.
  await act(async () => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error('Expected editor selection');
      selection.insertText('x');
    }, { discrete: true });
  });

  // Then: text is immediate, owner work is absent, and mount work has not grown.
  const renders = counts.commits.flat();
  console.info(JSON.stringify({ mountCommits, keyCommits: counts.commits.length,
    renderedComponents: renders.length, renders }));
  expect(homeHeroPromptText()).toBe('x');
  expect(mountCommits).toBeLessThanOrEqual(3);
  expect(counts.commits).toHaveLength(1);
  expect(renders).not.toContain('HomeView');
  expect(renders.length).toBeLessThan(30);
});
