import type { RuntimeUserResponse } from '@readable-studio/contracts';
import { useEffect, useState } from 'react';

function runtimeUserResponse(value: unknown): RuntimeUserResponse {
  if (typeof value !== 'object' || value === null || !('username' in value)) {
    return { username: null };
  }
  const username = value.username;
  return { username: typeof username === 'string' && username.length > 0 ? username : null };
}

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 5000;

export function useRuntimeUsername(): string | null {
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function scheduleRetry(): void {
      if (controller.signal.aborted || attempts >= MAX_ATTEMPTS) return;
      retryTimer = setTimeout(requestUsername, RETRY_DELAY_MS);
    }

    function requestUsername(): void {
      retryTimer = undefined;
      attempts += 1;
      void fetch('/api/runtime/user', { signal: controller.signal }).then(
        (response) => {
          if (!response.ok) {
            scheduleRetry();
            return;
          }
          void response.json().then(
            (value: unknown) => {
              if (!controller.signal.aborted) setUsername(runtimeUserResponse(value).username);
            },
            () => {
              if (!controller.signal.aborted) setUsername(null);
            },
          );
        },
        scheduleRetry,
      );
    }

    requestUsername();
    return () => {
      controller.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, []);

  return username;
}
