import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { assertPiShutdownPatched, patchPiPackage, PI_CLI_LAUNCHER } from "../src/pi-package.js";
import piPackage from "../src/pi-package.json" with { type: "json" };

afterEach(() => vi.unstubAllEnvs());

it("applies the Pi patch when job TEMP is inside the workspace", async () => {
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const scratch = join(workspaceRoot, ".tmp", "build-verify-speed", "run1", "pifix");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "patch-"));
  const packageRoot = join(root, "app", "node_modules", piPackage.name);
  const rpc = join(packageRoot, "dist", "modes", "rpc", "rpc-mode.js");
  try {
    await mkdir(dirname(rpc), { recursive: true });
    // Registry bytes for both hunks, without downloading or executing Pi.
    await writeFile(rpc, `export async function runRpcMode(runtimeHost) {
    let detachInput = () => { };
    async function shutdown(exitCode = 0, signal) {
        if (shuttingDown) {
            process.exit(exitCode);
        }
        shuttingDown = true;
        for (const cleanup of signalCleanupHandlers) {
            cleanup();
        }
        unsubscribe?.();
        unsubscribeBackpressure?.();
        await runtimeHost.dispose();
        detachInput();
        process.stdin.pause();
        if (signal !== "SIGTERM") {
            await flushRawStdout();
        }
        process.exit(exitCode);
    }
    async function checkShutdownRequested() {
    }
}
`);
    await writeFile(join(root, "app", "package-lock.json"), JSON.stringify({
      packages: { [`node_modules/${piPackage.name}`]: piPackage },
    }));
    const temp = join(root, "temp");
    await mkdir(temp);
    vi.stubEnv("TEMP", temp);
    vi.stubEnv("TMP", temp);
    vi.stubEnv("TMPDIR", temp);
    expect(tmpdir()).toBe(temp);

    await patchPiPackage(join(root, "app"), workspaceRoot);

    expect(() => assertPiShutdownPatched(packageRoot)).not.toThrow();
    expect(await readFile(join(root, "app", PI_CLI_LAUNCHER), "utf8")).toContain("dist\\cli.js");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
