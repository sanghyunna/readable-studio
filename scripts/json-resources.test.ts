import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const jsonResourceMaxDepth = 8;
const jsonResourceFdCommand = {
  executable: "fd",
  arguments: [
    "--type",
    "f",
    "--extension",
    "json",
    "--max-depth",
    String(jsonResourceMaxDepth),
    ".",
  ],
} as const;

test("JSON resource discovery is explicitly depth-bounded", () => {
  const maxDepthIndex = jsonResourceFdCommand.arguments.indexOf("--max-depth");
  assert.notEqual(maxDepthIndex, -1);
  assert.equal(jsonResourceFdCommand.arguments[maxDepthIndex + 1], String(jsonResourceMaxDepth));
  assert.ok(jsonResourceMaxDepth > 0);
});

test("every shipped JSON resource parses", () => {
  const output = execFileSync(
    jsonResourceFdCommand.executable,
    jsonResourceFdCommand.arguments,
    { cwd: repoRoot, encoding: "utf8" },
  );
  const resourcePaths = output.trim().split(/\r?\n/u).filter(Boolean);

  assert.equal(resourcePaths.length, 1_226, "shipped JSON resource inventory changed");
  for (const resourcePath of resourcePaths) {
    assert.doesNotThrow(
      () => JSON.parse(readFileSync(path.join(repoRoot, resourcePath), "utf8")),
      `${resourcePath} must contain valid JSON`,
    );
  }
});
