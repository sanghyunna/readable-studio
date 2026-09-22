import { execAgentFile } from './invocation.js';
import type { AgentAuthProbeResult } from './auth.js';
import type { RuntimeAgentDef, RuntimeEnv } from './types.js';

function signedIn(stdout: string): boolean | undefined {
  try {
    const payload: unknown = JSON.parse(stdout);
    if (typeof payload === 'object' && payload !== null && 'loggedIn' in payload && typeof payload.loggedIn === 'boolean') {
      return payload.loggedIn;
    }
    return undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Auth JSON contains personal data. Only its boolean may leave this boundary. */
export async function probeClaudeAuthStatus(
  bin: string,
  env: RuntimeEnv,
  probe: NonNullable<RuntimeAgentDef['authProbe']>,
): Promise<AgentAuthProbeResult> {
  try {
    const { stdout } = await execAgentFile(bin, probe.args, {
      env, timeout: probe.timeoutMs ?? 5000, maxBuffer: 1024 * 1024,
    });
    switch (signedIn(String(stdout))) {
      case true: return { status: 'ok' };
      case false: return { status: 'missing' };
      case undefined: return { status: 'unknown' };
    }
  } catch (error) {
    // This subprocess boundary must never expose errors carrying stdout/stderr.
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && signedIn(error.stdout) === false) {
      return { status: 'missing' };
    }
    return { status: 'unknown' };
  }
}
