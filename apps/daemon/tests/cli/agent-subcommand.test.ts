// RED spec: `readable agent ...` is a planned UI/CLI dual-track subcommand
// (Optimization_plan.md §1, "readable agent list|enable|disable|reset
// --json"). Per AGENTS.md "Capability exposure (UI/CLI dual-track)",
// every capability the web UI exposes (agent picker filtering by
// enabledAgentIds) must also be reachable through `readable`.
//
// We assert this at the source level rather than booting the CLI
// because `apps/daemon/src/cli.ts` runs `runDaemonCliStartup(argv)` at
// top-level await, so importing the module from a test would spin up
// the real daemon. The intent is structural: the CLI must register a
// runAgent handler and wire it into SUBCOMMAND_MAP under the `agent`
// key. A follow-up GREEN PR will land an executable test that drives
// the handler.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const cliPath = path.resolve(__dirname, '../../src/cli.ts');
const cliSource = readFileSync(cliPath, 'utf8');

describe('readable agent subcommand (source-level RED spec)', () => {
  test('cli.ts declares a runAgent handler', () => {
    const declared =
      /\bfunction\s+runAgent\b/.test(cliSource) ||
      /\b(?:const|let)\s+runAgent\s*=/.test(cliSource);
    expect(
      declared,
      'expected apps/daemon/src/cli.ts to declare runAgent',
    ).toBe(true);
  });

  test('cli.ts registers `agent` in SUBCOMMAND_MAP', () => {
    const mapMatch = cliSource.match(
      /const\s+SUBCOMMAND_MAP\s*=\s*\{([\s\S]*?)\};/,
    );
    expect(mapMatch, 'SUBCOMMAND_MAP literal not found in cli.ts').not.toBeNull();
    const body = mapMatch?.[1] ?? '';
    expect(
      /(^|[\s,{])agent\s*:/m.test(body),
      'expected SUBCOMMAND_MAP to bind the `agent` key to runAgent',
    ).toBe(true);
  });

  test('cli.ts whitelists `agent list` verbs and supports --json', () => {
    expect(
      /['"]list['"]/.test(cliSource) && /['"]enable['"]/.test(cliSource),
      'expected `list` and `enable` verbs to appear in cli.ts for `readable agent`',
    ).toBe(true);
    expect(/--json/.test(cliSource)).toBe(true);
  });
});
