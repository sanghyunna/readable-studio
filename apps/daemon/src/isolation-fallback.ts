export const ISOLATION_FALLBACK_LABEL = 'sandbox_isolation_unavailable';

/** Only native helper readiness failures qualify; validation/policy rejections do not. */
export function isolationLaunchFailureReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (/^Windows AppContainer helper (?:did not become ready|exited before launch|is missing|control pipe was not created)/u.test(error.message)
    || /^(?:agent-isolator: )?(?:launch AppContainer process|create AppContainer profile|create isolated process job|set AppContainer security capabilities|write ACL for [^\r\n]+): /u.test(error.message)) {
    return 'Windows AppContainer could not initialize the isolated agent environment.';
  }
  return null;
}

/** No stdout is permitted: a home warning followed by real work is not a startup failure. */
export function isolationRuntimeFailureReason(input: {
  readonly agentId: string;
  readonly exitCode: number | null;
  readonly stdoutSeen: boolean;
  readonly stderr: string;
}): string | null {
  if (input.agentId !== 'codex' || input.exitCode === null || input.exitCode === 0 || input.stdoutSeen) return null;
  const lines = input.stderr.trim().split(/\r?\n/u);
  // Match the complete known startup diagnostic, not a substring of arbitrary
  // agent output, auth errors, or tool failures. OS code is locale-independent.
  if (lines.length !== 2) return null;
  const [warning, fatal] = lines;
  if (warning?.startsWith('WARNING: proceeding, even though we could not create PATH aliases: failed to canonicalize CODEX_HOME ')
    && warning.endsWith('(os error 5)')
    && (fatal?.startsWith('Error finding codex home: failed to canonicalize CODEX_HOME ')
      || fatal?.startsWith('Error: '))
    && fatal.endsWith('(os error 5)')) {
    return 'Codex cannot resolve CODEX_HOME DOS volume paths inside Windows AppContainer (os error 5).';
  }
  return null;
}
