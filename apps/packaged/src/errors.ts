export class PackagedNewerSchemaError extends Error {
  readonly code = 'SCHEMA_VERSION_NEWER';

  constructor(readonly databaseVersion: number, readonly supportedVersion: number, options?: { cause?: unknown }) {
    super(`Data schema ${databaseVersion} is newer than supported schema ${supportedVersion}`, options);
    this.name = 'PackagedNewerSchemaError';
  }
}

/** Decode only the explicit refusal record from this launch's daemon. */
export function parsePackagedDatabaseRefusal(log: string, pid: number | undefined): PackagedNewerSchemaError | null {
  if (pid == null) return null;
  for (const line of log.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; } // Other log lines are not protocol records.
    if (record == null || typeof record !== 'object') continue;
    const databaseVersion = Reflect.get(record, 'databaseVersion');
    const supportedVersion = Reflect.get(record, 'supportedVersion');
    if (Reflect.get(record, 'type') === 'readable-studio:database-open-refusal' &&
        Reflect.get(record, 'code') === 'SCHEMA_VERSION_NEWER' && Reflect.get(record, 'pid') === pid &&
        Number.isInteger(databaseVersion) && Number.isInteger(supportedVersion) &&
        supportedVersion >= 0 && databaseVersion > supportedVersion) {
      return new PackagedNewerSchemaError(databaseVersion, supportedVersion);
    }
  }
  return null;
}

export function resolvePackagedStartupFailureDialog(error: unknown, korean: boolean, logsRoot: string) {
  const newer = error instanceof PackagedNewerSchemaError;
  return {
    type: 'error' as const,
    title: 'Readable Studio',
    message: newer
      ? (korean ? '이 데이터는 더 새로운 버전의 Readable Studio에서 생성되었습니다.' : 'This data was created by a newer version of Readable Studio.')
      : (korean ? '데이터를 여는 중 문제가 발생했습니다. 데이터는 안전합니다.' : 'There was a problem opening your data. Your data is safe.'),
    detail: newer
      ? (korean
        ? `데이터 스키마 버전: ${error.databaseVersion}\n이 앱이 지원하는 버전: ${error.supportedVersion}\n\n데이터는 변경되지 않았습니다.\n종료한 뒤 최신 버전의 Readable Studio를 실행하세요.`
        : `Data schema version: ${error.databaseVersion}\nSupported version: ${error.supportedVersion}\n\nYour data has not been changed.\nQuit and run the latest version of Readable Studio.`)
      : (korean ? `데몬을 시작하지 못했습니다. 다시 시도하거나 로그를 확인하세요: ${logsRoot}` : `The daemon could not start. Retry or check the logs: ${logsRoot}`),
    buttons: korean ? ['다시 시도', '종료'] : ['Retry', 'Quit'],
    defaultId: newer ? 1 : 0,
    cancelId: 1,
    noLink: true,
  };
}

export class PackagedNetworkingRestoreError extends Error {
  readonly title = "Readable Studio could not restore networking";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PackagedNetworkingRestoreError";
  }
}

export class PackagedPathAccessError extends Error {
  readonly title: string;

  constructor(message: string, options?: { cause?: unknown; title?: string }) {
    super(message, options);
    this.name = "PackagedPathAccessError";
    this.title = options?.title ?? "Readable Studio cannot access its data folder";
  }
}
