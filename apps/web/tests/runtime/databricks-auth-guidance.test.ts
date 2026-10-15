import { expect, test } from 'vitest';
import { resolveRunFailureUi } from '../../src/runtime/amr-guidance';
import { getKo } from '../../src/i18n/locales/ko';

test('Databricks permission denial selects endpoint permission guidance in the shipped Korean dictionary', () => {
  for (const agent of ['databricks', 'pi']) {
    const ui = resolveRunFailureUi('AGENT_EXECUTION_FAILED', agent, 'Databricks [permission-denied; HTTP 403]: Access denied.');
    expect(ui.messageKey).toBe('chat.databricksError.permissionMessage');
    expect(getKo()[ui.messageKey!]).toBe(getKo()['chat.databricksError.permissionMessage']);
    expect(getKo()[ui.messageKey!]).toMatch(/[가-힣]/);
    expect(ui.secondaryRetry).toBe(false);
  }
});

test('Databricks expired login selects Korean re-login guidance rather than generic HTTP guidance', () => {
  for (const detail of ['Databricks [auth; HTTP 401]: rejected', 'Databricks [auth; no upstream response]: rejected']) {
    const ui = resolveRunFailureUi('AGENT_EXECUTION_FAILED', 'pi', detail);
    expect(ui.messageKey).toBe('chat.databricksError.authMessage');
    expect(getKo()[ui.messageKey!]).toBe(getKo()['chat.databricksError.authMessage']);
    expect(getKo()[ui.messageKey!]).toMatch(/[가-힣]/);
  }
  expect(resolveRunFailureUi('DATABRICKS_AUTH_REQUIRED', 'databricks').messageKey).toBe('chat.databricksError.authMessage');
});
