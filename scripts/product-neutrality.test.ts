import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  collectDaemonWindowsFootgunViolations,
  collectProductNeutralityViolationsFromSource,
  isProductNeutralityCheckedPath,
} from "./guard.ts";

test("product-neutrality check rejects named orchestrator examples on public surfaces", () => {
  const violations = collectProductNeutralityViolationsFromSource(
    "packages/contracts/src/api/chat.ts",
    "Run-scoped tool bundle supplied by an orchestrator such as Acme.",
    [],
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.lineNumber, 1);
});

test("product-neutrality check covers web App Router public copy", () => {
  assert.equal(isProductNeutralityCheckedPath("apps/web/app/page.tsx"), true);

  const violations = collectProductNeutralityViolationsFromSource(
    "apps/web/app/page.tsx",
    "This page mentions an orchestrator such as Acme.",
    [],
  );

  assert.equal(violations.length, 1);
});

test("product-neutrality check supports local forbidden terms without committing them", () => {
  const violations = collectProductNeutralityViolationsFromSource(
    "docs/example.md",
    "This private deployment name should not ship.",
    ["private deployment"],
  );

  assert.equal(violations.length, 1);
});

test("product-neutrality check ignores out-of-scope paths", () => {
  assert.equal(isProductNeutralityCheckedPath("tmp/scratch.md"), false);
  assert.deepEqual(
    collectProductNeutralityViolationsFromSource(
      "tmp/scratch.md",
      "A scratch note can mention an orchestrator such as Acme.",
      [],
    ),
    [],
  );
});

describe("daemon windows footgun collector", () => {
  test("flags daemon tests that create real /tmp filesystem paths", () => {
    const violations = collectDaemonWindowsFootgunViolations(
      "apps/daemon/tests/daemon-footgun.test.ts",
      [
        "import { mkdtemp } from 'node:fs/promises';",
        "await mkdtemp('/tmp/readable-foo');",
      ].join("\n"),
    );

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.lineNumber, 2);
  });

  test("flags daemon source that exits immediately after awaiting filesystem cleanup", () => {
    const violations = collectDaemonWindowsFootgunViolations(
      "apps/daemon/src/server.ts",
      [
        "import { rm } from 'node:fs/promises';",
        "await rm('/tmp/readable-foo', { recursive: true, force: true });",
        "process.exit(0);",
      ].join("\n"),
    );

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.lineNumber, 3);
  });

  test("does not flag semantic fixture strings that are not filesystem paths", () => {
    const violations = collectDaemonWindowsFootgunViolations(
      "apps/daemon/tests/daemon-footgun.test.ts",
      "const fixture = { cwd: '/tmp/readable-project' };",
    );

    assert.deepEqual(violations, []);
  });

  test("does not flag process.exit(0) in help text that is not after await", () => {
    const violations = collectDaemonWindowsFootgunViolations(
      "apps/daemon/src/cli.ts",
      [
        "const help = 'Use process.exit(0) only for actual termination.';",
        "console.log(help);",
      ].join("\n"),
    );

    assert.deepEqual(violations, []);
  });
});
