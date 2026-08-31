import express from 'express';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  registerRuntimeUserRoute,
  resolveRuntimeUser,
} from '../src/routes/runtime-user.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function requestRuntimeUser(readUsername: () => string): Promise<unknown> {
  const app = express();
  registerRuntimeUserRoute(app, { readUsername });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') return null;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime/user`);
  return response.json();
}

describe('local runtime user', () => {
  it('normalizes an injected Windows username', () => {
    // Given: the operating-system lookup includes incidental whitespace.
    const readUsername = () => '  winuser  ';

    // When: local runtime identity is resolved.
    const result = resolveRuntimeUser(readUsername);

    // Then: the shared response contains the normalized username.
    expect(result).toEqual({ username: 'winuser' });
  });

  it('returns null when operating-system lookup fails', () => {
    // Given: the operating-system lookup throws.
    const readUsername = (): string => {
      throw new TypeError('lookup failed');
    };

    // When: local runtime identity is resolved.
    const result = resolveRuntimeUser(readUsername);

    // Then: startup-safe unavailable identity is returned.
    expect(result).toEqual({ username: null });
  });

  it('serves the resolved identity from the bootstrap endpoint', async () => {
    // Given: a normal daemon route registration with an injected OS lookup.
    const readUsername = () => 'daemon-user';

    // When: the web bootstrap endpoint is requested.
    const result = await requestRuntimeUser(readUsername);

    // Then: the endpoint returns the shared DTO shape.
    expect(result).toEqual({ username: 'daemon-user' });
  });
});
