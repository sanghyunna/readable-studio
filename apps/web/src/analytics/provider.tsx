'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AnalyticsConfigureGlobals } from '@readable-studio/contracts/analytics';
import {
  detectClientType,
  getAnonymousId,
  getSessionId,
} from './identity';
import { randomUUID } from '../utils/uuid';

interface AnalyticsContextValue {
  track: (
    event: string,
    properties: Record<string, unknown>,
    options?: { requestId?: string; insertId?: string },
  ) => void;
  setConsent: (granted: boolean) => void;
  setIdentity: (installationId: string | null) => void;
  setConfigureGlobals: (next: AnalyticsConfigureGlobals) => void;
  setUserId: (userId: string | null) => void;
  anonymousId: string;
  sessionId: string;
  newRequestId: () => string;
}

const Ctx = createContext<AnalyticsContextValue | null>(null);

const APP_VERSION_PLACEHOLDER = '0.0.0';
let runtimeAppVersion: string | null = null;
let runtimeAppVersionPromise: Promise<string | null> | null = null;

async function loadRuntimeAppVersion(): Promise<string | null> {
  if (runtimeAppVersion) return runtimeAppVersion;
  if (!runtimeAppVersionPromise) {
    runtimeAppVersionPromise = (async () => {
      try {
        const res = await fetch('/api/version');
        if (!res.ok) return null;
        const body = (await res.json()) as { version?: { version?: string } };
        const next = body?.version?.version;
        if (!next) return null;
        runtimeAppVersion = next;
        return next;
      } catch {
        return null;
      } finally {
        if (!runtimeAppVersion) runtimeAppVersionPromise = null;
      }
    })();
  }
  return runtimeAppVersionPromise;
}

export async function resolveAppVersionForCapture(current: string): Promise<string> {
  if (current && current !== APP_VERSION_PLACEHOLDER) return current;
  return (await loadRuntimeAppVersion()) ?? current;
}

export function useAppVersion(): string {
  const [version, setVersion] = useState(APP_VERSION_PLACEHOLDER);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await loadRuntimeAppVersion();
      if (!cancelled && next) setVersion(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const identity = useMemo(
    () => ({
      anonymousId: getAnonymousId(),
      sessionId: getSessionId(),
      clientType: detectClientType(),
    }),
    [],
  );

  const track = useCallback<AnalyticsContextValue['track']>(
    (event, properties, options) => {
      void event;
      void properties;
      void options;
    },
    [],
  );

  const value = useMemo<AnalyticsContextValue>(
    () => ({
      track,
      setConsent: (granted: boolean) => {
        void granted;
      },
      setIdentity: (installationId: string | null) => {
        void installationId;
      },
      setConfigureGlobals: (next: AnalyticsConfigureGlobals) => {
        void next;
      },
      setUserId: (userId: string | null) => {
        void userId;
      },
      anonymousId: identity.anonymousId,
      sessionId: identity.sessionId,
      newRequestId: () => randomUUID(),
    }),
    [track, identity],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAnalytics(): AnalyticsContextValue {
  const value = useContext(Ctx);
  if (!value) {
    return {
      track: () => undefined,
      setConsent: () => undefined,
      setIdentity: () => undefined,
      setConfigureGlobals: () => undefined,
      setUserId: () => undefined,
      anonymousId: 'unmounted',
      sessionId: 'unmounted',
      newRequestId: () => randomUUID(),
    };
  }
  return value;
}
