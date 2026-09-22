import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { spawnIsolatedAgent } from "../src/index.js";

const helper = fileURLToPath(new URL("../dist/native/win32/agent-isolator.exe", import.meta.url));

it.skipIf(process.platform !== "win32" || !existsSync(helper))(
  "reports unavailable DOS canonicalization while preserving home access and ancestor isolation",
  { timeout: 20_000 },
  async () => {
    // Given a private home below ungranted ancestors, like the daemon's CODEX_HOME.
    // Native measurements: CreateFileW(home, GENERIC_READ) succeeds; the same
    // handle's GetFinalPathNameByHandleW(VOLUME_NAME_DOS) and QueryDosDeviceW(C:)
    // fail with error 5, while VOLUME_NAME_NT succeeds. Ancestor ACL grants do
    // not change this AppContainer limitation. Do not assert DOS success here.
    // Product recovery belongs in apps/daemon/tests/isolation-fallback.test.ts:
    // its real-AppContainer case requires a completed run and recorded rollback.
    const root = mkdtempSync(join(tmpdir(), "readable-home-"));
    const sandbox = join(root, "run");
    const home = join(sandbox, "home", ".codex");
    mkdirSync(home, { recursive: true });
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "protected");
    const node = join(sandbox, "node.exe");
    copyFileSync(process.execPath, node);
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      process.stdin.once('data', () => {
        const home = process.env.CODEX_HOME;
        let canonicalizationError = null;
        try { fs.realpathSync.native(home); }
        catch (error) { canonicalizationError = { code: error.code, syscall: error.syscall }; }
        fs.writeFileSync(path.join(home, 'state.json'), '{}');
        const denied = (operation) => {
          try { operation(); return false; }
          catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') return true; throw error; }
        };
        process.stdout.write(JSON.stringify({
          home,
          canonicalizationError,
          state: fs.readFileSync(path.join(home, 'state.json'), 'utf8'),
          ancestorListingDenied: denied(() => fs.readdirSync(${JSON.stringify(root)})),
          siblingReadDenied: denied(() => fs.readFileSync(${JSON.stringify(secret)})),
          ancestorWriteDenied: denied(() => fs.writeFileSync(${JSON.stringify(join(root, "escape.txt"))}, 'escape')),
        }));
      });
    `;
    try {
      // When the real AppContainer child probes DOS resolution and uses its home.
      const child = await spawnIsolatedAgent({
        command: node,
        args: ["-e", script],
        cwd: sandbox,
        env: { ...process.env, CODEX_HOME: home, TEMP: sandbox, TMP: sandbox },
        readExecutePaths: [],
        writablePaths: [sandbox],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      child.stdin.end("go");
      // Then DOS canonicalization is unavailable, not home access or containment.
      expect(await closed, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        home,
        canonicalizationError: { code: "EPERM", syscall: "realpath" },
        state: "{}",
        ancestorListingDenied: true,
        siblingReadDenied: true,
        ancestorWriteDenied: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
