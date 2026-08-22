// Phase 5 / spec §15.6 — DaemonDb adapter tests.

import { describe, expect, it } from 'vitest';
import {
  DaemonDbConfigError,
  resolveDaemonDbConfig,
} from '../src/storage/daemon-db.js';

describe('resolveDaemonDbConfig', () => {
  it('defaults to sqlite', () => {
    expect(resolveDaemonDbConfig({})).toEqual({ kind: 'sqlite' });
  });

  it('parses postgres env vars when READABLE_DAEMON_DB=postgres', () => {
    const cfg = resolveDaemonDbConfig({
      READABLE_DAEMON_DB: 'postgres',
      READABLE_PG_HOST:   'pg.local',
      READABLE_PG_PORT:   '6543',
      READABLE_PG_DATABASE: 'readable_studio',
      READABLE_PG_USER:   'readable',
      READABLE_PG_SSL_MODE: 'disable',
    });
    expect(cfg.kind).toBe('postgres');
    expect(cfg.postgres).toEqual({
      host:     'pg.local',
      port:     6543,
      database: 'readable_studio',
      user:     'readable',
      sslMode:  'disable',
    });
  });

  it('throws when postgres env vars are incomplete', () => {
    expect(() =>
      resolveDaemonDbConfig({ READABLE_DAEMON_DB: 'postgres', READABLE_PG_HOST: 'pg.local' }),
    ).toThrow(DaemonDbConfigError);
  });

  it('throws on an unknown READABLE_DAEMON_DB value', () => {
    expect(() => resolveDaemonDbConfig({ READABLE_DAEMON_DB: 'mongo' })).toThrow(DaemonDbConfigError);
  });
});
