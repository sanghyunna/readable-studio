import assert from 'node:assert/strict';

/** Only machine/observability sinks: never apply this to user-facing identity DTOs. */
export function assertNoDatabricksIdentityLeaks(artifacts: Record<string, unknown>, privateValues: readonly string[]): void {
  for (const [sink, value] of Object.entries(artifacts)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of privateValues) assert.equal(text.includes(secret), false, `Databricks identity leaked into ${sink}`);
  }
}
