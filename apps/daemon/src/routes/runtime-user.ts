import type { RuntimeUserResponse } from '@readable-studio/contracts';
import type { Express } from 'express';
import os from 'node:os';

interface RuntimeUserRouteOptions {
  readonly readUsername?: () => string;
}

export function resolveRuntimeUser(
  readUsername: (() => string) | undefined = undefined,
): RuntimeUserResponse {
  try {
    const username = (readUsername ?? (() => os.userInfo().username))().trim();
    return { username: username.length > 0 ? username : null };
  } catch {
    return { username: null };
  }
}

export function registerRuntimeUserRoute(
  app: Express,
  options: RuntimeUserRouteOptions = {},
): void {
  app.get('/api/runtime/user', (_request, response) => {
    response.json(resolveRuntimeUser(options.readUsername));
  });
}
