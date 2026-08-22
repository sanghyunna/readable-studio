import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  loadWorkspaceLocalEnv,
  parseDotEnvLocal,
} from "../src/local-env.js";

describe("tools-dev local env loading", () => {
  it("parses common .env.local assignment forms", () => {
    assert.deepEqual({ ...parseDotEnvLocal([
      "# comment",
      "API_KEY=local",
      "API_HOST=https://example.test # trailing comment",
      "export QUOTED_VALUE=\"value with spaces\"",
      "SECRET_VALUE='sk#local'",
      "BAD-KEY=ignored",
      "",
    ].join("\n")) }, {
      API_KEY: "local",
      API_HOST: "https://example.test",
      QUOTED_VALUE: "value with spaces",
      SECRET_VALUE: "sk#local",
    });
  });

  it("loads workspace .env.local over the parent environment", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "readable-local-env-"));
    await writeFile(path.join(workspaceRoot, ".env.local"), [
      "API_KEY=from_file",
      "QUOTED_VALUE=from_file",
    ].join("\n"));
    const env: NodeJS.ProcessEnv = { API_KEY: "from_parent" };

    const result = loadWorkspaceLocalEnv({ workspaceRoot, env });

    assert.equal(result.loaded, true);
    assert.equal(env.API_KEY, "from_file");
    assert.equal(env.QUOTED_VALUE, "from_file");
    assert.deepEqual(result.keys, ["API_KEY", "QUOTED_VALUE"]);
  });
});
