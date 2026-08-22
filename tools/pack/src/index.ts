import { cac } from "cac";
import type { CAC } from "cac";

import { resolveToolPackConfig, type ToolPackCliOptions } from "./config.js";
import {
  cleanupPackedWinNamespace,
  inspectPackedWinApp,
  packWin,
  readPackedWinLogs,
  startPackedWinApp,
  stopPackedWinApp,
} from "./win/index.js";

type CliOptions = ToolPackCliOptions;
type CacCommand = ReturnType<CAC["command"]>;

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printLogs(result: { logs: Record<string, { lines: string[]; logPath: string }>; namespace: string }, options: CliOptions): void {
  if (options.json === true) {
    printJson(result);
    return;
  }
  for (const [app, entry] of Object.entries(result.logs)) {
    process.stdout.write(`[${app}] ${entry.logPath}\n`);
    process.stdout.write(entry.lines.length > 0 ? `${entry.lines.join("\n")}\n` : "(no log lines)\n");
  }
}

function addOptions(command: CacCommand): CacCommand {
  return command
    .option("--app-version <version>", "override packaged app version")
    .option("--cache-dir <path>", "tools-pack cache directory")
    .option("--dir <path>", "tools-pack root directory")
    .option("--expr <expression>", "desktop inspect eval expression")
    .option("--json", "print JSON")
    .option("--namespace <name>", "runtime namespace")
    .option("--path <path>", "desktop inspect screenshot path")
    .option("--signed", "sign the executable in the portable ZIP");
}

const cli = cac("tools-pack");

addOptions(
  cli.command(
    "win <action>",
    "Windows x64 portable ZIP: build|start|stop|logs|inspect|cleanup",
  ),
).action(async (action: string, options: CliOptions) => {
  const config = resolveToolPackConfig("win", options);
  switch (action) {
    case "build":
      printJson(await packWin(config));
      return;
    case "start":
      printJson(await startPackedWinApp(config));
      return;
    case "stop":
      printJson(await stopPackedWinApp(config));
      return;
    case "logs":
      printLogs(await readPackedWinLogs(config), options);
      return;
    case "inspect":
      printJson(await inspectPackedWinApp(config, options));
      return;
    case "cleanup":
      printJson(await cleanupPackedWinNamespace(config));
      return;
    default:
      throw new Error(`unsupported tools-pack command: win ${action}`);
  }
});

cli.on("command:*", () => {
  const command = process.argv.slice(2).join(" ") || "unknown";
  process.stderr.write(`unsupported tools-pack command: ${command}\n`);
  process.exitCode = 1;
});

cli.help();
cli.parse();
