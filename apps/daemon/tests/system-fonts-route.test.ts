import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

// Wiring smoke test for GET /api/system/fonts. Platform-agnostic: on
// non-Windows CI the daemon returns { fonts: [], platform } rather than
// erroring, so this asserts shape rather than concrete font data.
describe('/api/system/fonts', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns a well-formed system fonts payload', async () => {
    const res = await fetch(`${baseUrl}/api/system/fonts`);
    expect(res.ok).toBe(true);
    const json = (await res.json()) as {
      fonts: Array<{ family: string; faces: Array<{ path: string; weight: number; style: string; format: string }> }>;
      platform: string;
    };
    expect(Array.isArray(json.fonts)).toBe(true);
    expect(['win32', 'darwin', 'linux', 'unsupported']).toContain(json.platform);
    for (const fam of json.fonts) {
      expect(typeof fam.family).toBe('string');
      expect(Array.isArray(fam.faces)).toBe(true);
      for (const face of fam.faces) {
        expect(typeof face.path).toBe('string');
        expect(typeof face.weight).toBe('number');
        expect(['normal', 'italic']).toContain(face.style);
      }
    }
  });
});
