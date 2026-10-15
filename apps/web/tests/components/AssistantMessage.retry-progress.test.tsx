// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { getEn } from '../../src/i18n/locales/en';
import type { ChatMessage } from '../../src/types';

afterEach(cleanup);

const retry = (attempt: number) => ({
  kind: 'status' as const, label: 'retrying',
  detail: JSON.stringify({ provider: 'databricks', attempt, maxRetries: 10, delayMs: 5000 }),
});

it.each(['ko', 'en'] as const)('renders localized %s retry progress and clears when the request succeeds', (locale) => {
  const message: ChatMessage = {
    id: 'retry-message', role: 'assistant', content: '', events: [retry(1), retry(3)],
  };
  const view = (events: ChatMessage['events'], streaming = true) => (
    <I18nProvider initial={locale}>
      <AssistantMessage message={{ ...message, events }} streaming={streaming} projectId="retry-project" />
    </I18nProvider>
  );
  const { container, rerender } = render(view(message.events));
  const expected = (locale === 'ko' ? getKo() : getEn())['chat.databricksError.retryMessage']
    .replace('{attempt}', '3').replace('{maxRetries}', '10');
  expect(container.querySelectorAll('[data-status="retrying"]')).toHaveLength(1);
  expect(container.querySelector('[data-status="retrying"]')?.textContent).toBe(expected);
  rerender(view([...message.events!, { kind: 'status', label: 'retry_complete' }]));
  expect(container.querySelector('[data-status="retrying"]')).toBeNull();
});

it.each(['succeeded', 'failed', 'canceled'] as const)('removes stale retry progress when the run is %s', (runStatus) => {
  const { container } = render(
    <I18nProvider initial="ko">
      <AssistantMessage
        message={{ id: 'ended-retry', role: 'assistant', content: '', events: [retry(3)], runStatus, endedAt: 2000 }}
        streaming={false} projectId="retry-project"
      />
    </I18nProvider>,
  );
  expect(container.querySelector('[data-status="retrying"]')).toBeNull();
});
