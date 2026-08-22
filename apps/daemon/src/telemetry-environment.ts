const DISABLED_TELEMETRY_ENV = 'disabled';

export function readTelemetryEnvironment(
  _env: NodeJS.ProcessEnv = process.env,
): string {
  return DISABLED_TELEMETRY_ENV;
}
