// Windows-only hop in front of each tools-dev sidecar, run directly by node
// (native type stripping, no tsx). tools-dev starts this process detached, so
// it has no console. Starting the sidecar non-detached with windowsHide gives
// it CREATE_NO_WINDOW: a hidden console that every descendant (Next.js postcss
// workers, agent CLIs, git) inherits instead of allocating a visible one - a
// new conhost / Windows Terminal tab.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal == null ? 0 : 1));
});
