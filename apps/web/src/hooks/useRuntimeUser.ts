import type { RuntimeUserResponse } from '@readable-studio/contracts';
import { useEffect, useState } from 'react';

function runtimeUserResponse(value: unknown): RuntimeUserResponse {
  if (typeof value !== 'object' || value === null || !('username' in value)) {
    return { username: null };
  }
  const username = value.username;
  return { username: typeof username === 'string' && username.length > 0 ? username : null };
}

export function useRuntimeUsername(): string | null {
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/runtime/user', { signal: controller.signal })
      .then(async (response) => response.ok ? runtimeUserResponse(await response.json()) : { username: null })
      .then((result) => {
        if (!controller.signal.aborted) setUsername(result.username);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return username;
}
