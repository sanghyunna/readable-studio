import { describe, expect, it } from 'vitest';
import { resolveRunFailureUi } from '../../src/runtime/amr-guidance';

const RATE_LIMIT = 'The Kimi account usage limit is reached (HTTP 403). Retry after the limit resets.';
const RATE_LIMIT_WINDOW =
  'The Kimi account usage limit is reached (HTTP 403). It resets when the current 7-day window ends. Retry after the limit resets.';
const RATE_LIMIT_AT =
  'The Kimi account usage limit is reached (HTTP 403). Reset: 2026-10-08T00:00:00Z. Retry after the limit resets.';
const AUTH = 'Kimi login failed (HTTP 401). Log in to Kimi again and retry.';
const PROVIDER = 'Kimi provider error (HTTP 502): bad gateway.';

describe('resolveRunFailureUi for Kimi provider failures', () => {
  it('localizes the usage-limit failure and only states a reset window the data carries', () => {
    expect(resolveRunFailureUi('RATE_LIMITED', 'kimi', RATE_LIMIT)).toMatchObject({
      primaryAction: 'retry',
      messageKey: 'chat.kimiError.usageLimitMessage',
      showSwitchCard: false,
    });
    expect(resolveRunFailureUi('RATE_LIMITED', 'kimi', RATE_LIMIT_WINDOW).messageKey).toBe(
      'chat.kimiError.usageLimitWindowMessage',
    );
    const at = resolveRunFailureUi('RATE_LIMITED', 'kimi', RATE_LIMIT_AT);
    expect(at.messageKey).toBe('chat.kimiError.usageLimitResetMessage');
    expect(at.messageVars).toEqual({ reset: '2026-10-08T00:00:00Z' });
  });

  it('asks for a Kimi re-login on auth failures', () => {
    expect(resolveRunFailureUi('AGENT_AUTH_REQUIRED', 'kimi', AUTH)).toMatchObject({
      primaryAction: 'retry',
      messageKey: 'chat.kimiError.authMessage',
    });
  });

  it('summarizes provider errors with the HTTP status and short reason', () => {
    const ui = resolveRunFailureUi('AGENT_EXECUTION_FAILED', 'kimi', PROVIDER);
    expect(ui.messageKey).toBe('chat.kimiError.providerMessage');
    expect(ui.messageVars).toEqual({ status: '502', reason: 'bad gateway' });
  });

  it('keeps the raw text for non-Kimi agents and unrecognized Kimi failures', () => {
    expect(resolveRunFailureUi('RATE_LIMITED', 'claude', RATE_LIMIT).messageKey).toBeNull();
    expect(resolveRunFailureUi('AGENT_AUTH_REQUIRED', 'codex', AUTH).messageKey).toBeNull();
    expect(
      resolveRunFailureUi('AGENT_EXECUTION_FAILED', 'kimi', 'Kimi exited unexpectedly').messageKey,
    ).toBeNull();
    expect(resolveRunFailureUi('RATE_LIMITED', 'kimi').messageKey).toBe(
      'chat.kimiError.usageLimitMessage',
    );
  });
});
