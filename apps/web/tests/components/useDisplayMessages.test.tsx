// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDisplayMessages } from '../../src/components/useDisplayMessages';
import { projectMessageForDisplay } from '../../src/components/ProjectView';
import type { ChatMessage, ProjectFile } from '../../src/types';

afterEach(cleanup);
const files: ProjectFile[] = [];
const receipt = '<brief-receipt>{"assumptions":[]}</brief-receipt>';
const settled: ChatMessage = { id: 'complete', role: 'assistant', content: `Before${receipt}After`, events: [{ kind: 'text', text: `Before${receipt}After` }] };
const tail: ChatMessage = { id: 'tail', role: 'assistant', content: 'Live' };

it('projects only the changed message when a streaming snapshot replaces the tail', () => {
  // Given: a settled message requiring normalization, not an identity projection.
  const project = vi.fn(projectMessageForDisplay);
  const view = renderHook(({ messages }) => useDisplayMessages(messages, files, project), { initialProps: { messages: [settled, tail] } });
  const previous = view.result.current[0];
  project.mockClear();
  // When: immutable streaming state replaces only the tail.
  view.rerender({ messages: [settled, { ...tail, content: 'Live chunk' }] });
  // Then: the normalized completed message is reused without any projection work.
  expect(project).toHaveBeenCalledTimes(1);
  expect(view.result.current[0]).toBe(previous);
  expect(previous?.content).toBe('BeforeAfter');
  expect(view.result.current[1]?.content).toBe('Live chunk');
});

it('keeps existing display identities when an older history page is prepended', () => {
  // Given: the newest page is already projected.
  const view = renderHook(({ messages }) => useDisplayMessages(messages, files, projectMessageForDisplay), { initialProps: { messages: [settled, tail] } });
  const previous = view.result.current;
  // When: scroll-back prepends older data.
  view.rerender({ messages: [{ id: 'older', role: 'user', content: 'Earlier' }, settled, tail] });
  // Then: the existing rows keep their identity and position relative to each other.
  expect(view.result.current[1]).toBe(previous[0]);
  expect(view.result.current[2]).toBe(previous[1]);
});

it('invalidates the projection when the authoritative file snapshot changes', () => {
  // Given: a legacy filename that cannot resolve until project files arrive.
  const legacy: ChatMessage = { id: 'legacy', role: 'assistant', content: 'Done' };
  // Reproduce the historical storage shape at the normalization boundary.
  Reflect.set(legacy, 'producedFiles', ['index.html']);
  const messages: ChatMessage[] = [legacy];
  const view = renderHook(({ projectFiles }) => useDisplayMessages(messages, projectFiles, projectMessageForDisplay), { initialProps: { projectFiles: files } });
  const html: ProjectFile = { name: 'index.html', path: 'index.html', kind: 'html', mime: 'text/html', size: 20, mtime: 1 };
  // When: the authoritative file snapshot arrives.
  view.rerender({ projectFiles: [html] });
  // Then: normalization sees the new snapshot rather than a stale cache.
  expect(view.result.current[0]?.producedFiles).toEqual([html]);
});
