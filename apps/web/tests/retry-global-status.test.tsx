// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AssistantMessage } from '../src/components/AssistantMessage';
import { I18nProvider } from '../src/i18n';
import { getEn } from '../src/i18n/locales/en';
import { getKo } from '../src/i18n/locales/ko';
import { resolveRunFailureUi } from '../src/runtime/amr-guidance';
import type { AgentEvent, ChatMessage } from '../src/types';

afterEach(cleanup);

function retry(agentId: string, attempt = 1): AgentEvent {
  return {
    kind: 'status', label: 'retrying',
    detail: JSON.stringify({ agentId, attempt, maxRetries: 10, delayMs: 5000 }),
  };
}

function view(events: AgentEvent[], locale: 'ko' | 'en' = 'ko', runStatus?: ChatMessage['runStatus']) {
  return (
    <I18nProvider initial={locale}>
      <AssistantMessage
        message={{ id: 'global-retry', role: 'assistant', content: '', events, runStatus }}
        streaming={!runStatus} projectId="retry-project"
      />
    </I18nProvider>
  );
}

it.each(['codex', 'claude', 'kimi'])('renders one latest retry pill for %s in both locales', (agentId) => {
  for (const locale of ['ko', 'en'] as const) {
    const { container, unmount } = render(view([retry(agentId), retry(agentId, 3)], locale));
    const dict = locale === 'ko' ? getKo() : getEn();
    const template = dict['chat.retryMessage'];
    expect(template).toBeTruthy();
    const pills = container.querySelectorAll('[data-status="retrying"]');
    expect(pills).toHaveLength(1);
    expect(pills[0]?.textContent).toBe(template?.replace('{attempt}', '3').replace('{maxRetries}', '10'));
    expect(pills[0]?.getAttribute('role')).toBe('status');
    unmount();
  }
});

it('accepts retry details without a provider or agent identity', () => {
  const { container } = render(view([{
    kind: 'status', label: 'retrying', detail: JSON.stringify({ attempt: 1, maxRetries: 10 }),
  }]));
  expect(container.querySelector('[data-status="retrying"]')).not.toBeNull();
});

it.each(['ko', 'en'] as const)('preserves the Databricks %s retry copy', (locale) => {
  const { container } = render(view([{
    kind: 'status', label: 'retrying',
    detail: JSON.stringify({ provider: 'databricks', attempt: 3, maxRetries: 10 }),
  }], locale));
  const template = (locale === 'ko' ? getKo() : getEn())['chat.databricksError.retryMessage'];
  expect(container.querySelector('[data-status="retrying"]')?.textContent)
    .toBe(template.replace('{attempt}', '3').replace('{maxRetries}', '10'));
});

it.each<AgentEvent>([
  { kind: 'text', text: 'Recovered response' },
  { kind: 'thinking', text: 'Recovered thinking' },
  { kind: 'tool_use', id: 'read-1', name: 'Read', input: { path: 'index.html' } },
  { kind: 'status', label: 'retry_complete' },
])('clears retry progress on $kind', (event) => {
  const { container, rerender } = render(view([retry('codex')]));
  expect(container.querySelector('[data-status="retrying"]')).not.toBeNull();
  rerender(view([retry('codex'), event]));
  expect(container.querySelector('[data-status="retrying"]')).toBeNull();
});

it.each(['succeeded', 'failed', 'canceled'] as const)('clears retry progress when %s', (status) => {
  const { container, rerender } = render(view([retry('kimi')]));
  expect(container.querySelector('[data-status="retrying"]')).not.toBeNull();
  rerender(view([retry('kimi')], 'ko', status));
  expect(container.querySelector('[data-status="retrying"]')).toBeNull();
});

it.each(['{', 'null', '{"attempt":"1","maxRetries":10}', '{"attempt":1}'])('ignores invalid progress %s', (detail) => {
  const { container } = render(view([{ kind: 'status', label: 'retrying', detail }]));
  expect(container.querySelector('[data-status="retrying"]')).toBeNull();
});

it.each([
  'Too many requests (HTTP 429), after 10 retries.',
  'Rate limit reached (HTTP 429), after 10 retries.',
])('distinguishes a Kimi weekly quota from exhausted transient rate limits: %s', (detail) => {
  const quota = resolveRunFailureUi('RATE_LIMITED', 'kimi',
    'The Kimi account usage limit is reached (HTTP 403). It resets when the current 7-day window ends. Retry after the limit resets.');
  expect(quota.messageKey).toBe('chat.kimiError.usageLimitWindowMessage');
  const rate = resolveRunFailureUi('RATE_LIMITED', 'kimi', detail);
  expect(rate.messageKey).toBe('chat.rateLimitMessage');
  expect(getKo()[rate.messageKey!]).not.toBe(getKo()[quota.messageKey!]);
});

it('keeps legacy persisted Kimi quota and reset details localized', () => {
  expect(resolveRunFailureUi('RATE_LIMITED', 'kimi',
    'The Kimi account usage limit is reached (HTTP 403). Retry after the limit resets.').messageKey)
    .toBe('chat.kimiError.usageLimitMessage');
  const reset = resolveRunFailureUi('RATE_LIMITED', 'kimi',
    'The Kimi account usage limit is reached (HTTP 403). Reset: 2026-10-25T00:00:00Z. Retry after the limit resets.');
  expect(reset.messageKey).toBe('chat.kimiError.usageLimitResetMessage');
  expect(reset.messageVars).toEqual({ reset: '2026-10-25T00:00:00Z' });
});

it.each(['codex', 'claude', 'kimi', 'amr', 'antigravity'])('localizes terminal quota and invalid model failures for %s', (agentId) => {
  const quota = resolveRunFailureUi('RATE_LIMITED', agentId, 'Weekly usage limit reached');
  expect(quota.messageKey).toBe(agentId === 'kimi' ? 'chat.kimiError.usageLimitMessage' : 'chat.quotaExhaustedMessage');
  const invalid = resolveRunFailureUi('AGENT_EXECUTION_FAILED', agentId, 'Unknown model: nonexistent');
  expect(invalid.messageKey).toBe('chat.invalidModelMessage');
  expect(getKo()[invalid.messageKey!]).toBeTruthy();
});

it.each(['unknown model', 'invalid model', 'model nonexistent not found', 'model_not_found: nonexistent', 'model "nonexistent" does not exist'])('localizes legacy model errors: %s', (detail) => {
  expect(resolveRunFailureUi('AGENT_EXECUTION_FAILED', 'kimi', detail).messageKey)
    .toBe('chat.invalidModelMessage');
});

it.each(['codex', 'claude', 'kimi', 'amr', 'antigravity'])('localizes daemon hard-quota details for %s', (agentId) => {
  expect(resolveRunFailureUi('RATE_LIMITED', agentId, 'HTTP 429 quota exceeded').messageKey)
    .toBe(agentId === 'kimi' ? 'chat.kimiError.usageLimitMessage' : 'chat.quotaExhaustedMessage');
});

it('preserves AMR balance recovery with provider detail', () => {
  expect(resolveRunFailureUi('AMR_INSUFFICIENT_BALANCE', 'amr', 'Insufficient funds')).toMatchObject({
    primaryAction: 'recharge', messageKey: 'chat.amrError.balanceMessage', secondaryRetry: true,
  });
});

it('preserves Antigravity model switching while localizing confirmed quota', () => {
  expect(resolveRunFailureUi('RATE_LIMITED', 'antigravity', 'Individual quota reached')).toMatchObject({
    primaryAction: 'launch-terminal-switch-model', messageKey: 'chat.quotaExhaustedMessage', secondaryRetry: true,
  });
});

it.each(['claude', 'kimi', 'pi'])('uses the structured quota cause in the final Korean %s payload', (agentId) => {
  const ui = resolveRunFailureUi('AGENT_QUOTA_EXHAUSTED', agentId,
    'AI 서비스 사용량 또는 크레딧이 소진되었습니다. 한도 초기화나 충전 후 다시 시도해 주세요.');
  expect(ui.messageKey).toBe(agentId === 'kimi' ? 'chat.kimiError.usageLimitMessage' : 'chat.quotaExhaustedMessage');
  expect(getKo()[ui.messageKey!]).not.toBe(getKo()['chat.rateLimitMessage']);
});

it.each(['claude', 'kimi', 'pi'])('uses the structured model cause in the final Korean %s payload', (agentId) => {
  const ui = resolveRunFailureUi('AGENT_MODEL_UNAVAILABLE', agentId,
    '선택한 모델을 사용할 수 없습니다. 모델 이름을 확인하고 다른 모델을 선택해 주세요.');
  expect(ui.messageKey).toBe('chat.invalidModelMessage');
  expect(getKo()[ui.messageKey!]).not.toBe(getKo()['chat.upstreamUnavailableMessage']);
});

it('preserves Antigravity model switching for a structured hard-quota failure', () => {
  expect(resolveRunFailureUi('AGENT_QUOTA_EXHAUSTED', 'antigravity', '사용량 소진')).toMatchObject({
    primaryAction: 'launch-terminal-switch-model', messageKey: 'chat.quotaExhaustedMessage', secondaryRetry: true,
  });
});

it.each(['ko', 'en'] as const)('localizes machine causes without depending on %s provider prose', locale => {
  const dict = locale === 'ko' ? getKo() : getEn();
  const quota = resolveRunFailureUi('AGENT_QUOTA_EXHAUSTED', 'claude', 'opaque provider detail');
  const model = resolveRunFailureUi('AGENT_MODEL_UNAVAILABLE', 'pi', 'HTTP 503 / 429');
  expect(quota.messageKey).toBe('chat.quotaExhaustedMessage');
  expect(model.messageKey).toBe('chat.invalidModelMessage');
  expect(dict[quota.messageKey!]).toBeTruthy();
  expect(dict[model.messageKey!]).toBeTruthy();
});
