// Browser analytics compatibility shim.
//
// PostHog is not loaded in this fork. These exports remain so existing event
// helpers and tests compile, but every network-facing path is a no-op.

import type {
  AnalyticsClientType,
  AnalyticsConfigureGlobals,
} from '@readable-studio/contracts/analytics';

type AnalyticsClient = {
  capture?: (event: string, properties?: Record<string, unknown>) => void;
};

interface AnalyticsContext {
  anonymousId: string;
  sessionId: string;
  clientType: AnalyticsClientType;
  locale: string;
  appVersion: string;
}

let configureGlobals: AnalyticsConfigureGlobals = {
  has_available_configure_cli: false,
  configure_type: 'unknown',
  configure_availability: 'unknown',
};

export function getResolvedAnonymousId(): string | null {
  return null;
}

export function getResolvedDeviceId(): string | null {
  return null;
}

export function getConfigureGlobals(): AnalyticsConfigureGlobals {
  return configureGlobals;
}

export function setConfigureGlobals(next: AnalyticsConfigureGlobals): void {
  configureGlobals = { ...next };
}

export function setAnalyticsUserId(userId: string | null): void {
  void userId;
}

export function bootstrapExceptionTracking(context: AnalyticsContext): Promise<void> {
  void context;
  return Promise.resolve();
}

export async function getAnalyticsClient(
  context: AnalyticsContext,
): Promise<AnalyticsClient | null> {
  void context;
  return null;
}

export function applyConsent(consentGranted: boolean): void {
  void consentGranted;
}

export function applyIdentity(installationId: string | null): void {
  void installationId;
}

export function capture(
  client: AnalyticsClient | null,
  args: {
    event: string;
    properties: Record<string, unknown>;
    insertId: string;
    requestId?: string | null;
  },
): void {
  void client;
  void args;
}
