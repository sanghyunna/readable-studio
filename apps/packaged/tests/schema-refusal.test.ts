import { describe, expect, it } from 'vitest';
import { parsePackagedDatabaseRefusal, resolvePackagedStartupFailureDialog } from '../src/errors.js';

const record = { type: 'readable-studio:database-open-refusal', code: 'SCHEMA_VERSION_NEWER', pid: 123, databaseVersion: 9, supportedVersion: 1 };
describe('schema refusal protocol', () => {
  it('accepts only an explicit record from the spawned PID', () => {
    expect(parsePackagedDatabaseRefusal(JSON.stringify(record), 123)).toMatchObject({ code: record.code, databaseVersion: 9, supportedVersion: 1 });
    expect(parsePackagedDatabaseRefusal(JSON.stringify(record), 124)).toBeNull();
    expect(parsePackagedDatabaseRefusal(JSON.stringify(record), undefined)).toBeNull();
  });
  it.each([
    'schema version 9 is newer than supported version 1', '{broken',
    JSON.stringify({ ...record, type: 'other' }),
    JSON.stringify({ ...record, code: 'OTHER' }),
    JSON.stringify({ ...record, databaseVersion: '9' }),
    JSON.stringify({ ...record, supportedVersion: -1 }),
    JSON.stringify({ ...record, databaseVersion: 1 }),
  ])('does not infer refusal from prose or invalid records', (log) => {
    expect(parsePackagedDatabaseRefusal(log, 123)).toBeNull();
  });
  it.each([true, false])('defaults to Quit for newer schema (Korean=%s)', (korean) => {
    const error = parsePackagedDatabaseRefusal(JSON.stringify(record), 123);
    expect(resolvePackagedStartupFailureDialog(error, korean, 'logs')).toMatchObject({ defaultId: 1, cancelId: 1 });
    expect(resolvePackagedStartupFailureDialog(new Error('failure'), korean, 'logs')).toMatchObject({ defaultId: 0, cancelId: 1 });
  });
});
