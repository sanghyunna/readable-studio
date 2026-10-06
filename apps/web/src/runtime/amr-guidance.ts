// Shared logic that maps a failed run's error code + agent into the failure
// UI: which contextual button the gray error card shows and whether to override
// the error text. (`showSwitchCard` is retained in the shape for callers but is
// always false — the hosted-AMR promotion card has been removed.) Kept in its
// own module so ChatPane / ProjectView / AssistantMessage can import it without
// a circular dependency.

// AMR is a third-party Vela service. Keep account links on the vendor origin;
// Readable Studio does not own or ship a product website.
export const AMR_CONSOLE_URL =
  'https://vela.powerformer.net/wallet?source=readable_studio';
export const AMR_RECHARGE_URL = AMR_CONSOLE_URL;

const AMR_CONSOLE_URL_BY_PROFILE: Record<string, string> = {
  prod: AMR_CONSOLE_URL,
  test: AMR_CONSOLE_URL,
  local: 'http://localhost:5173/wallet?source=readable_studio',
};

export function amrConsoleUrlForProfile(profile: string | null | undefined): string {
  const normalized = profile?.trim() || 'prod';
  return AMR_CONSOLE_URL_BY_PROFILE[normalized] ?? AMR_CONSOLE_URL;
}

export function amrRechargeUrlForProfile(profile: string | null | undefined): string {
  return amrConsoleUrlForProfile(profile);
}

export function amrProfileBadgeLabel(profile: string | null | undefined): string | null {
  if (profile === 'test') return 'TEST';
  if (profile === 'local') return 'LOCAL';
  return null;
}

// Primary action offered in the gray error card.
//   - retry:                       re-run with the current agent.
//   - authorize:                   AMR sign-in/authorize flow, then auto-retry on success.
//   - recharge:                    open the AMR wallet (manual retry afterwards).
//   - launch-terminal-auth:        Antigravity-specific. agy's `-p`
//                                  print mode cannot complete Google
//                                  Sign-In on its own (no input field
//                                  for the auth code), so Readable Studio spawns a
//                                  system Terminal running `agy` and
//                                  the user finishes OAuth there.
//   - launch-terminal-switch-model: Antigravity-specific. agy has no
//                                  `--model` flag (upstream #35), so
//                                  switching to a model with available
//                                  quota means opening agy's TUI and
//                                  using its Switch Model picker. The
//                                  daemon spawns the same terminal as
//                                  launch-terminal-auth — the button
//                                  label is the only thing that changes.
// Both terminal-launch actions pair with `secondaryRetry: true` so the
// user has a Retry button after the external step completes (OAuth /
// switching models happens out-of-band; we can't auto-retry from the
// daemon side).
export type RunFailurePrimaryAction =
  | 'retry'
  | 'authorize'
  | 'recharge'
  | 'launch-terminal-auth'
  | 'launch-terminal-switch-model';

// i18n keys for the gray-card text override (null = show the raw error).
export type RunFailureMessageKey =
  | 'chat.amrError.authMessage'
  | 'chat.amrError.balanceMessage'
  | 'chat.connectionDropped'
  | 'chat.kimiError.usageLimitMessage'
  | 'chat.kimiError.usageLimitWindowMessage'
  | 'chat.kimiError.usageLimitResetMessage'
  | 'chat.kimiError.authMessage'
  | 'chat.kimiError.providerMessage'
  | null;

export interface RunFailureUi {
  primaryAction: RunFailurePrimaryAction;
  // Override the gray error card's text (e.g. AMR auth / balance get a clearer
  // explanation than the raw upstream string).
  messageKey: RunFailureMessageKey;
  // Interpolation values for `messageKey` (only the Kimi copy uses them).
  messageVars?: Record<string, string | number>;
  // Show a secondary plain "retry" button alongside the primary action (used
  // by the recharge case, where retry is manual after topping up).
  secondaryRetry: boolean;
  // Retained for callers; always false. The hosted-AMR promotion card that this
  // once gated has been removed, so no failure promotes a switch to AMR.
  showSwitchCard: boolean;
}

type KimiFailureCopy = Pick<RunFailureUi, 'messageKey' | 'messageVars'>;

// Kimi failures recovered from the ACP session log arrive as plain-English
// daemon messages (apps/daemon/src/kimi-session-failure.ts). The persisted run
// error event keeps only `code` + `detail`, so the reset/status facts are read
// back from that text; anything unrecognized keeps the raw message.
function resolveKimiFailureCopy(
  code: string | null | undefined,
  detail: string | null | undefined,
): KimiFailureCopy | null {
  if (code === 'RATE_LIMITED') {
    if (/resets when the current 7-day window ends/i.test(detail ?? '')) {
      return { messageKey: 'chat.kimiError.usageLimitWindowMessage' };
    }
    const reset = detail?.match(/\bReset: (.+?)\.(?: Retry|$)/)?.[1];
    if (reset) {
      return { messageKey: 'chat.kimiError.usageLimitResetMessage', messageVars: { reset } };
    }
    return { messageKey: 'chat.kimiError.usageLimitMessage' };
  }
  if (code === 'AGENT_AUTH_REQUIRED') {
    return { messageKey: 'chat.kimiError.authMessage' };
  }
  if (code === 'AGENT_EXECUTION_FAILED') {
    const match = detail?.match(/^Kimi provider error \(HTTP (\d{3})\): (.+?)\.?$/);
    if (match) {
      return {
        messageKey: 'chat.kimiError.providerMessage',
        messageVars: { status: match[1]!, reason: match[2]! },
      };
    }
  }
  return null;
}

// Resolve the failure UI for a failed run:
//   - AMR agent, auth required      → authorize-and-retry button, clearer copy
//   - AMR agent, insufficient funds → recharge button + manual retry, clearer copy
//   - AMR agent, anything else      → plain retry
//   - Kimi agent, provider failure  → plain retry, Korean-localizable copy
//   - non-AMR agent, any failure    → plain retry (no promotion card)
export function resolveRunFailureUi(
  code: string | null | undefined,
  agentId: string | null | undefined,
  detail?: string | null,
): RunFailureUi {
  if (agentId === 'amr') {
    if (code === 'AMR_AUTH_REQUIRED') {
      return {
        primaryAction: 'authorize',
        messageKey: 'chat.amrError.authMessage',
        secondaryRetry: false,
        showSwitchCard: false,
      };
    }
    if (code === 'AMR_INSUFFICIENT_BALANCE') {
      return {
        primaryAction: 'recharge',
        messageKey: 'chat.amrError.balanceMessage',
        secondaryRetry: true,
        showSwitchCard: false,
      };
    }
    return {
      primaryAction: 'retry',
      messageKey: null,
      secondaryRetry: false,
      showSwitchCard: false,
    };
  }
  // Antigravity's auth flow is terminal-only — see the
  // `launch-terminal-auth` action comment for why. Without this branch
  // the user sees the daemon-emitted guidance text and would have to
  // open a terminal themselves; with it they get a one-click button
  // that opens Terminal.app / x-terminal-emulator / cmd with `agy`
  // running, and a Retry button to redo the chat after OAuth completes.
  if (agentId === 'antigravity') {
    if (code === 'AGENT_AUTH_REQUIRED') {
      return {
        primaryAction: 'launch-terminal-auth',
        messageKey: null,
        secondaryRetry: true,
        showSwitchCard: false,
      };
    }
    // Quota: each Antigravity model has its own quota, so the action
    // is "open agy, switch model" rather than "sign in." Same handler
    // spawns the same terminal; only the label changes.
    if (code === 'RATE_LIMITED') {
      return {
        primaryAction: 'launch-terminal-switch-model',
        messageKey: null,
        secondaryRetry: true,
        showSwitchCard: false,
      };
    }
  }
  if (agentId === 'kimi') {
    const copy = resolveKimiFailureCopy(code, detail);
    if (copy) {
      return { primaryAction: 'retry', secondaryRetry: false, showSwitchCard: false, ...copy };
    }
  }
  // Agent-neutral: a mid-response connection drop (any agent) gets a clear,
  // localized "lost connection — retry" message instead of the raw SDK string.
  // Not an AMR-promotable case: the break is the user's own network path, which
  // switching model service wouldn't fix.
  if (code === 'AGENT_CONNECTION_DROPPED') {
    return {
      primaryAction: 'retry',
      messageKey: 'chat.connectionDropped',
      secondaryRetry: false,
      showSwitchCard: false,
    };
  }
  // The hosted-AMR "switch & retry" promotion card has been removed, so no
  // failure ever promotes AMR; the gray error card just offers a plain retry.
  return {
    primaryAction: 'retry',
    messageKey: null,
    secondaryRetry: false,
    showSwitchCard: false,
  };
}
