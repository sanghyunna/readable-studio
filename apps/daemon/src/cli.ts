#!/usr/bin/env node
// @ts-nocheck
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runDaemonCliStartup, startDaemonRuntime } from './daemon-startup.js';
import { splitResearchSubcommand } from './research/cli-args.js';
import { resolveDaemonUrl } from './daemon-url.js';
import { DESIGN_SYSTEMS_USAGE, isDesignSystemsHelpArg } from './design-systems-cli-help.js';
import { parseDesignSystemRenameArgs } from './design-system-rename-args.js';
import { runProviderCli } from './provider-cli.js';
import { SIDECAR_ENV, SIDECAR_MESSAGES } from '@readable-studio/sidecar-proto';
import { STANDALONE_HTML_EXPORT_HEADERS } from '@readable-studio/contracts';
import {
  AGENT_SLUGS,
  isAgentSlug,
  planAgentInstall,
  applyJsonInstall,
  removeJsonInstall,
} from './mcp-agent-install.js';

const argv = process.argv.slice(2);

// ---- Subcommand router ----------------------------------------------------
//
// `readable` starts the daemon + opens the web UI by default.
//
// We dispatch on the first positional argument so flags like --port keep
// working unchanged. Subcommand routing is keyword-based; flags are
// parsed inside each handler.


const MCP_STRING_FLAGS = new Set([
  'daemon-url',
]);
const MCP_BOOLEAN_FLAGS = new Set([
  'help',
  'h',
]);

// Hoisted before SUBCOMMAND_MAP: `readable mcp install <agent>` dispatches through
// top-level module evaluation, and runMcpInstall references these `const` Sets.
const MCP_INSTALL_STRING_FLAGS = new Set([
  'daemon-url',
  'name',
]);
const MCP_INSTALL_BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'json',
  'print',
  'dry-run',
  'uninstall',
  'remove',
]);

const RESEARCH_SEARCH_STRING_FLAGS = new Set([
  'query',
  'max-sources',
  'daemon-url',
]);
const RESEARCH_SEARCH_BOOLEAN_FLAGS = new Set([
  'help',
  'h',
]);

const PLUGIN_STRING_FLAGS = new Set([
  'daemon-url',
  'source',
  'inputs',
  'project',
  'conversation',
  'message',
  'agent',
  'model',
  'snapshot-id',
  'capabilities',
  'grant-caps',
  'before',
  'trust',
  'tag',
  'policy',
  'version',
  'reason',
  'catalog',
  'host',
]);
const PLUGIN_BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'json',
  'revoke',
  'follow',
  'strict',
]);

const UI_STRING_FLAGS = new Set([
  'daemon-url',
  'run',
  'project',
  'value',
  'value-json',
  'plugin',
  'snapshot-id',
  'persist',
  'kind',
]);
const UI_BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'json',
  'skip',
  // Plan §6 Phase 2A.5 — `readable ui show --schema` returns just the
  // surface's JSON Schema (or `null` when the surface declares
  // none). Lets a code agent inspect the contract before piping a
  // value back through `readable ui respond --value-json`.
  'schema',
]);

// Hoist flag set bindings consumed by handlers reachable through
// the top-of-file dispatcher. The dispatch block runs synchronously
// during module load; any const declared further down the file is
// still in TDZ when the handler executes, so `readable status` /
// `readable atoms list` / etc. would crash with `Cannot access X before
// initialization`.
const DAEMON_STRING_FLAGS = new Set([
  'daemon-url', 'port', 'host',
]);
const DAEMON_BOOLEAN_FLAGS = new Set([
  'help', 'h', 'json', 'headless', 'serve-web', 'no-open',
]);
const LIBRARY_STRING_FLAGS = new Set(['daemon-url', 'query', 'tag']);
const LIBRARY_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
const DIAGNOSTICS_STRING_FLAGS = new Set(['daemon-url', 'output']);
const DIAGNOSTICS_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
const CONFIG_STRING_FLAGS = new Set(['daemon-url', 'value', 'value-json']);
const CONFIG_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
const AGENT_STRING_FLAGS = new Set(['daemon-url']);
const AGENT_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
const PROJECT_STRING_FLAGS = new Set([
  'daemon-url', 'name', 'skill', 'design-system', 'plugin', 'metadata-json',
  'pending-prompt', 'project', 'conversation', 'message', 'prompt',
  'prompt-file', 'path', 'dir', 'as',
  'identity-token-file', 'since', 'query', 'pattern', 'max', 'root',
  'agent', 'model', 'snapshot-id', 'inputs', 'grant-caps',
  'title', 'against', 'seed-from', 'fork-after', 'mode',
]);
const PROJECT_BOOLEAN_FLAGS = new Set(['help', 'h', 'json', 'follow']);
const HOSTED_ARTIFACT_STRING_FLAGS = new Set([
  'daemon-url', 'identity-token-file', 'html-file', 'identifier', 'title',
]);
const HOSTED_ARTIFACT_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
const CHAT_STRING_FLAGS = new Set([
  'daemon-url',
  'identity-token-file',
  'project',
  'conversation',
  'checkpoint',
  'message',
  'mode',
  'conflict-policy',
  'request',
  'run',
  'reason',
  'prompt-file',
  'title',
  'seed-from',
  'fork-after',
]);
const CHAT_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
// `readable templates …` mirrors NewProjectPanel / ExamplesTab. Same surface,
// same /api/templates store. The CLI form is the embeddability contract:
// external agents (hermes-agent, openclaw, ...) can snapshot, list, or
// remove user-saved project templates without going through the web UI.
const TEMPLATES_STRING_FLAGS = new Set([
  'daemon-url', 'name', 'description',
]);
const TEMPLATES_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
// `readable automation …` mirrors the Automations tab. Same surface, same
// /api/routines store. The CLI form is the embeddability contract:
// external agents (hermes-agent, openclaw, etc.) can drive Readable Studio
// automations headlessly without going through the web UI.
const AUTOMATION_STRING_FLAGS = new Set([
  'daemon-url', 'name', 'prompt', 'prompt-file', 'schedule', 'target',
  'project', 'skill', 'agent', 'limit', 'plugin', 'mcp',
  'status', 'reason', 'template', 'source-kind', 'source-ref', 'title',
  'body', 'body-file', 'compression', 'sensitivity', 'account',
  'candidate-sinks', 'memory-type',
]);
const AUTOMATION_BOOLEAN_FLAGS = new Set([
  'help', 'h', 'json', 'disabled', 'enabled',
]);
const MEMORY_STRING_FLAGS = new Set([
  'daemon-url', 'name', 'description', 'type', 'body', 'body-file',
]);
const MEMORY_BOOLEAN_FLAGS = new Set([
  'help', 'h', 'json',
]);
const SHARE_STRING_FLAGS = new Set([
  'daemon-url', 'url', 'title', 'text', 'copy-text', 'locale', 'platform',
]);
const SHARE_BOOLEAN_FLAGS = new Set([
  'help', 'h', 'json',
]);
const EXPORT_STRING_FLAGS = new Set([
  'daemon-url', 'project', 'file', 'plugin', 'example', 'design-system', 'view', 'input', 'output',
]);
const EXPORT_BOOLEAN_FLAGS = new Set(['help', 'h', 'json', 'force']);
// Hoisted because `runAutomation` is reachable through the top-of-file
// SUBCOMMAND_MAP dispatch, which runs during module evaluation —
// any `const` declared further down would still be in TDZ when
// `parseScheduleFlag` reads this map. Same reason the other dispatch-
// touched constants live near the top.
const AUTOMATION_WEEKDAY_TOKENS = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const RECOVERABLE_EXIT_CODES = {
  'daemon-not-running':       64,
  'plugin-not-found':         65,
  'snapshot-not-found':       65,
  'capabilities-required':    66,
  'missing-input':            67,
  'project-not-found':        68,
  'run-not-found':            69,
  'provider-not-configured':  70,
  'plugin-requires-daemon':   71,
  'snapshot-stale':           72,
  'genui-surface-awaiting':   73,
  'desktop-auth-pending':     74,
  'desktop-import-token-rejected': 75,
  'rollback-conflict':        76,
  'rollback-run-mismatch':    77,
  'rollback-loop-prevented':  78,
  'rollback-approval-unavailable': 79,
  'rollback-approval-denied': 80,
  'rollback-approval-timeout': 81,
  'rollback-request-expired': 82,
  'rollback-request-consumed': 83,
  'rollback-plan-changed':     84,
};
const PLUGIN_LIST_FILTER_FLAGS = new Set([
  ...PLUGIN_STRING_FLAGS,
  'task-kind', 'mode', 'tag', 'trust',
]);
const PLUGIN_LIST_BOOLEAN_FLAGS = new Set([
  ...PLUGIN_BOOLEAN_FLAGS,
  'bundled', 'no-bundled',
]);

const SUBCOMMAND_MAP = {
  export: runExport,
  artifacts: runArtifacts,
  mcp: runMcp,
  research: runResearch,
  plugin: runPlugin,
  ui: runUi,
  marketplace: runMarketplace,
  share: runShare,
  project: runProject,
  automation: runAutomation,
  automations: runAutomation,
  memory: runMemory,
  run: runRun,
  files: runFiles,
  templates: runTemplates,
  conversation: runConversation,
  chat: runChat,
  daemon: runDaemon,
  atoms: runAtoms,
  skills: runSkills,
  'design-systems': runDesignSystems,
  craft: runCraft,
  fonts: runFonts,
  diagnostics: runDiagnostics,
  status: runStatus,
  version: runVersion,
  doctor: runDoctor,
  config: runConfig,
  agent: runAgent,
  provider: runProvider,
};

const first = argv.find((a) => !a.startsWith('-'));
await (async () => {
  if (first && SUBCOMMAND_MAP[first]) {
    const idx = argv.indexOf(first);
    const rest = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
    await SUBCOMMAND_MAP[first](rest);
    // Allow stdout/stderr to drain; hard process.exit(0) crashed libuv on Windows.
    process.exitCode ??= 0;
    return;
  }

  if (argv[0] === 'tools' && argv[1] === 'design-systems') {
    import('./tools-design-systems-cli.js')
      .then(({ runDesignSystemsToolCli }) => runDesignSystemsToolCli(argv.slice(2)))
      .then(({ exitCode }) => {
        process.exitCode = exitCode;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${JSON.stringify({ ok: false, error: { message } })}\n`);
        process.exitCode = 1;
      });
    return;
  }

  if (argv[0] === 'tools' && argv[1] === 'design-system-package-audit') {
    import('./design-system-package-audit.js')
      .then(({ runDesignSystemPackageAuditCli }) => runDesignSystemPackageAuditCli(argv.slice(2)))
      .then(({ exitCode }) => {
        process.exitCode = exitCode;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${JSON.stringify({ ok: false, error: { message } })}\n`);
        process.exitCode = 1;
      });
    return;
  }

  await runDaemonCliStartup(argv, { printHelp: printRootHelp });
})();

function printRootHelp() {
  console.log(`Usage:
  readable [--port <n>] [--host <addr>] [--no-open]
      Start the local daemon and open the web UI.

  readable artifacts create --name <path> --input <file> [--project <id-or-name>]
      Create a normal project artifact through the local daemon.
  readable artifacts <save|lint|download> [options]
      Save, lint, or download an artifact through the protected hosted routes.

  readable files <list|read|write|rename|delete|search|upload|folders|preview|preview-url|archive|export-manifest>
      Drive project content through the same protected routes as the web UI.

  readable provider <status|set|test|clear> [options]
      Configure and verify an ephemeral hosted provider credential. Secrets are
      read only from identity/key files or stdin; use --json for automation.

  readable export html --project <id> --file <path> [--output <path>] [--force] [--json]
      Save a self-contained HTML artifact through the local daemon.


  readable tools design-systems read --path <manifest-declared-path>
      Read active design-system pull-layer files through daemon wrapper commands.

  readable tools design-system-package-audit --path <dir> [--fail-on-warnings] [--reference-package] [--json]
      Audit a design-system package locally for required files, manifest quality,
      and gallery preview completeness. Use --project-id <id> to call the daemon
      API instead (requires READABLE_DAEMON_URL and READABLE_TOOL_TOKEN).

  readable research search --query <text> [--max-sources 5] [--daemon-url <url>]
      Run agent-callable Tavily research through the local daemon.

  readable plugin <list|info|install|uninstall|apply|doctor|replay|trust> [args]
      Discover, install, and apply plugins through the local daemon.
  readable plugin publish-repo <folder>
      Create/update the author's GitHub repo for a local plugin folder.
  readable plugin readable-studio-pr <folder>
      Push a community-catalog branch and open the Readable Studio PR form.

  readable automation <list|get|create|update|run|runs|pause|resume|delete> [args]
      Drive the Automations surface headlessly. Same store as the UI's
      Automations tab, so an external agent (hermes, openclaw, ...) can
      schedule, trigger, or harvest results from a routine without
      opening the web UI.

  readable memory tree <list|view|edit|move> [args]
      Inspect and edit the memory tree that is injected into agent prompts.

  readable share <readable-studio|url> [options]
      Build localized social-share targets for the Readable Studio repo or a
      deployed project URL. Use --json for scripted integrations.

  readable ui <list|show|respond|revoke|prefill> [args]
      Read and answer GenUI surfaces (form / choice / confirmation / oauth-prompt) headlessly.

  readable chat new --project <id> [--seed-from <cid>] [--fork-after <mid>] [--title "<t>"] [--json]
      Create a Side Chat: a new conversation that inherits another
      conversation's context by copying its messages (--seed-from), optionally
      stopping at one message (--fork-after). Mirrors the web chat fork action.

  readable diagnostics export [<path>] [--json]
      Bundle daemon/web/desktop logs, machine info, and recent crash reports
      into a zip for support tickets. Same output as Settings → About →
      Export diagnostics.

  "$READABLE_NODE_BIN" "$READABLE_BIN" tools ...
      Recommended agent-runtime form; avoids relying on user PATH for readable or node.

  readable mcp [--daemon-url <url>]
      Run a stdio MCP server that proxies project tool calls to a
      running Readable Studio daemon. Wire it into a coding agent
      (Claude Code, Cursor, VS Code, Zed, Windsurf) in another repo
      to pull files from a local Readable Studio project and create
      project-scoped artifacts without exporting a zip.

Options:
  --port <n>       Port to listen on (default: 7456, env: READABLE_PORT).
  --host <addr>    Interface address to bind to (default: 127.0.0.1, env: READABLE_BIND_HOST).
                   Set to a specific IP (e.g. a Tailscale address) to restrict access
                   to that interface only.
  --no-open        Do not open the browser after start.

What the daemon does:
  * scans PATH for installed code-agent CLIs (claude, codex, devin, gemini, opencode, cursor-agent, ...)
  * serves the chat UI at http://<host>:<port>
  * proxies messages (text + images) to the selected agent via child-process spawn`);
}

// ---------------------------------------------------------------------------
// Subcommand: readable research …
// ---------------------------------------------------------------------------

async function runResearch(args) {
  const { sub, subArgs } = splitResearchSubcommand(args);
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    printResearchHelp();
    process.exit(sub === 'help' || args.includes('--help') || args.includes('-h') ? 0 : 2);
  }
  if (sub !== 'search') {
    console.error(`unknown subcommand: readable research ${sub}`);
    printResearchHelp();
    process.exit(2);
  }
  return runResearchSearch(subArgs);
}

async function runResearchSearch(rawArgs) {
  let flags;
  try {
    flags = parseFlags(rawArgs, {
      string: RESEARCH_SEARCH_STRING_FLAGS,
      boolean: RESEARCH_SEARCH_BOOLEAN_FLAGS,
    });
  } catch (err) {
    console.error(err.message);
    printResearchHelp();
    process.exit(2);
  }
  const query = typeof flags.query === 'string' ? flags.query.trim() : '';
  if (!query) {
    console.error('--query required');
    process.exit(2);
  }
  const daemonUrl = await cliDaemonUrl(flags);
  const maxSources =
    flags['max-sources'] == null ? undefined : Number(flags['max-sources']);
  const url = `${daemonUrl.replace(/\/$/, '')}/api/research/search`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        ...(Number.isFinite(maxSources) ? { maxSources } : {}),
      }),
    });
  } catch (err) {
    surfaceFetchError(err, daemonUrl);
    process.exit(3);
  }
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`daemon ${resp.status}: ${text}`);
    process.exit(4);
  }
  process.stdout.write(`${await resp.text()}\n`);
}

async function runArtifacts(args) {
  if (args[0] === 'save' || args[0] === 'lint' || args[0] === 'download') {
    return runHostedArtifacts(args);
  }
  const { runArtifactsCli } = await import('./artifacts-cli.js');
  const { exitCode } = await runArtifactsCli(args);
  process.exit(exitCode);
}

async function runProvider(args) {
  const { exitCode } = await runProviderCli(args);
  process.exitCode = exitCode;
}

function printResearchHelp() {
  console.log(`Usage:
  readable research search --query <text> [--max-sources 5] [--daemon-url <url>]

Runs Tavily-backed shallow research through the local Readable Studio daemon.
Output is JSON only on stdout:
  { "query": "...", "summary": "...", "sources": [...], "provider": "tavily", "depth": "shallow", "fetchedAt": 0 }

Flags:
  --query        Required search query.
  --max-sources  Optional source cap. Defaults to 5, clamped to Tavily's max.
  --daemon-url   Local daemon URL. Defaults to READABLE_DAEMON_URL, READABLE_SIDECAR_IPC_PATH discovery, or http://127.0.0.1:7456.`);
}

function surfaceFetchError(err, daemonUrl) {
  const cause = err && typeof err === 'object' ? err.cause : null;
  const code =
    cause && typeof cause === 'object' && typeof cause.code === 'string'
      ? cause.code
      : null;
  const causeMsg =
    cause && typeof cause === 'object' && typeof cause.message === 'string'
      ? cause.message
      : '';
  let detail = err && err.message ? err.message : String(err);
  if (code) detail = `${code}${causeMsg ? ` — ${causeMsg}` : ''}`;
  else if (causeMsg) detail = causeMsg;
  console.error(`failed to reach daemon at ${daemonUrl}: ${detail}`);
  if (code === 'EPERM' || code === 'ENETUNREACH') {
    console.error(
      'hint: outbound connect was denied by a sandbox. If you launched ' +
        'this command from a code agent, check the agent\'s sandbox / ' +
        'network policy. The Readable Studio daemon itself is unaffected - it can be ' +
        'reached from a regular shell.',
    );
  }
}

function parseFlags(argv, opts = {}) {
  const stringFlags = opts.string instanceof Set ? opts.string : new Set();
  const booleanFlags = opts.boolean instanceof Set ? opts.boolean : new Set();
  const knownFlags = new Set([...stringFlags, ...booleanFlags]);
  // Positionals collected silently; callers that take `<id>` style
  // positional args (e.g. `readable plugin info <id>`) re-scan `argv`
  // themselves to pick them up. Strict positional rejection here
  // would break those commands, so we only enforce strict-flag
  // semantics for things that *are* prefixed with `--`.
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) {
      // Positional — let the caller decide what to do with it.
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (knownFlags.size > 0 && !knownFlags.has(key)) {
      throw new Error(
        `unknown flag: --${key}. Run with --help for the list of accepted flags.`,
      );
    }
    if (eq >= 0) {
      out[key] = a.slice(eq + 1);
      continue;
    }
    if (booleanFlags.has(key)) {
      out[key] = true;
      continue;
    }
    if (stringFlags.has(key)) {
      const next = argv[i + 1];
      if (next == null) {
        throw new Error(`flag --${key} requires a value`);
      }
      out[key] = next;
      i++;
      continue;
    }
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function positionalArgs(argv, stringFlags = new Set()) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (!a.startsWith('--')) {
      out.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (eq < 0 && stringFlags.has(key)) i++;
  }
  return out;
}

async function cliDaemonUrl(flags) {
  return resolveDaemonUrl({ flagUrl: flags?.['daemon-url'] });
}

async function cliDaemonBaseUrl(flags) {
  return (await cliDaemonUrl(flags)).replace(/\/$/, '');
}


// ---------------------------------------------------------------------------
// Subcommand: readable mcp
// ---------------------------------------------------------------------------

async function runMcp(args) {
  if (args[0] === 'install') {
    return runMcpInstall(args.slice(1));
  }
  let flags;
  try {
    flags = parseFlags(args, {
      string: MCP_STRING_FLAGS,
      boolean: MCP_BOOLEAN_FLAGS,
    });
  } catch (err) {
    console.error(err.message);
    printMcpHelp();
    process.exit(2);
  }
  if (flags.help || flags.h) {
    printMcpHelp();
    return;
  }

  const daemonUrl = await cliDaemonUrl(flags);

  const { runMcpStdio } = await import('./mcp.js');
  await runMcpStdio({ daemonUrl });
}

function printMcpHelp() {
  console.log(`Usage: readable mcp [--daemon-url <url>]

Run a stdio MCP (Model Context Protocol) server that proxies project
tool calls to a running Readable Studio daemon. Wire it into a coding agent
in another repo so the agent can pull files from a local Readable Studio
project and create project-scoped artifacts without exporting a zip
every iteration.

Options:
  --daemon-url <url>   Readable Studio daemon HTTP base URL. Resolution
                       order: this flag, READABLE_DAEMON_URL, READABLE_SIDECAR_IPC_PATH,
                       then http://127.0.0.1:7456. Each new MCP spawn
                       discovers the live daemon URL at startup, so
                       MCP client configs stay valid across daemon
                       restarts even when the port is ephemeral. A
                       running MCP server caches the URL; restart the
                       MCP client after a daemon restart to pick up a
                       new port.

Tools exposed:
  list_projects                  list every Readable Studio project
  get_active_context             what project/file the user has open right now
  get_artifact([project, entry]) bundle: entry file + every referenced sibling
  get_project([project])         single project metadata
  get_file([project, path])      file contents (textual mimes only for now)
  search_files(query[, project]) literal substring search across textual files
  list_files([project])          project files + artifactManifest sidecars
  create_artifact(name, content) create one normal artifact entry file

When project is omitted, get_artifact / get_project / get_file /
search_files / list_files / create_artifact default to the project the
user has open in Readable Studio; get_artifact and get_file additionally
default to the active file. The response stamps usedActiveContext so
callers can see which project/file got resolved.

For the copy-paste, per-client snippet (with absolute paths resolved
for your machine, plus a one-click deeplink for Cursor), open Settings
→ MCP server in the Readable Studio app. The daemon must be running locally
for tool calls to succeed.

To register this server into a coding agent's own config automatically:
  readable mcp install <agent> [--uninstall] [--print] [--json] [--daemon-url <url>]
  Agents: ${AGENT_SLUGS.join(' ')}`);
}

// ---------------------------------------------------------------------------
// Subcommand: readable mcp install <agent>
//
// Wires this daemon's stdio MCP server into a coding agent's own config.
// The pure planner (mcp-agent-install.ts) maps a resolved launch spec onto
// one of three strategies — drive the agent's own `mcp add/remove` CLI,
// deep-merge a JSON config file, or (for unverified formats) print a
// ready-to-paste snippet. This executor performs the IO the planner avoids.
// ---------------------------------------------------------------------------

// Resolve the canonical launch spec from the running daemon's
// /api/mcp/install-info (the same payload the Settings → MCP panel and the
// Codex one-click install use), so every install path configures byte-for-
// byte the same command. Falls back to a minimal `readable mcp --daemon-url`
// spec when the daemon is unreachable.
async function resolveMcpLaunchSpec(flags) {
  const base = await cliDaemonBaseUrl(flags);
  try {
    const resp = await fetch(`${base}/api/mcp/install-info`);
    if (resp.ok) {
      const info = await resp.json();
      if (info && typeof info.command === 'string' && Array.isArray(info.args)) {
        return {
          command: info.command,
          args: info.args,
          env: info.env && typeof info.env === 'object' ? info.env : {},
        };
      }
    }
  } catch {
    // daemon not running / unreachable — fall through to the minimal spec
  }
  return {
    command: 'readable',
    args: ['mcp', '--daemon-url', base],
    env: {},
  };
}

function emitInstallResult(useJson, result) {
  if (useJson) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.ok) {
    console.log(`✓ ${result.message}`);
  } else {
    console.error(`✗ ${result.message}`);
  }
}

async function runMcpInstall(args) {
  let flags;
  try {
    flags = parseFlags(args, {
      string: MCP_INSTALL_STRING_FLAGS,
      boolean: MCP_INSTALL_BOOLEAN_FLAGS,
    });
  } catch (err) {
    console.error(err.message);
    printMcpInstallHelp();
    process.exit(2);
  }
  if (flags.help || flags.h) {
    printMcpInstallHelp();
    return;
  }

  const slug = positionalArgs(args, MCP_INSTALL_STRING_FLAGS)[0];
  const useJson = Boolean(flags.json);
  if (!slug) {
    console.error('missing agent slug');
    printMcpInstallHelp();
    process.exit(2);
  }
  if (!isAgentSlug(slug)) {
    const msg = `unknown agent: ${slug} (expected one of: ${AGENT_SLUGS.join(' ')})`;
    emitInstallResult(useJson, { ok: false, agent: slug, message: msg });
    process.exit(2);
  }

  const uninstall = Boolean(flags.uninstall || flags.remove);
  const dryRun = Boolean(flags.print || flags['dry-run']);
  const serverName = flags.name || 'readable-studio';

  const os = await import('node:os');
  const spec = await resolveMcpLaunchSpec(flags);
  const plan = planAgentInstall(slug, spec, {
    home: os.homedir(),
    platform: process.platform,
    serverName,
  });

  if (plan.kind === 'manual') {
    const result = {
      ok: false,
      agent: slug,
      kind: 'manual',
      configPath: plan.configPath,
      format: plan.format,
      snippet: plan.snippet,
      message: `${slug}: manual setup required. ${plan.reason}`,
    };
    if (useJson) {
      console.log(JSON.stringify(result));
    } else {
      console.error(`› ${result.message}`);
      if (plan.configPath) console.error(`  Config: ${plan.configPath}`);
      console.error(`  Add this ${plan.format} block:\n`);
      console.log(plan.snippet);
    }
    return;
  }

  if (plan.kind === 'cli') {
    const argv = uninstall ? plan.removeArgv : plan.addArgv;
    if (dryRun) {
      emitInstallResult(useJson, {
        ok: true,
        agent: slug,
        kind: 'cli',
        command: `${plan.bin} ${argv.join(' ')}`,
        message: `would run: ${plan.bin} ${argv.join(' ')}`,
      });
      return;
    }
    const { spawn } = await import('node:child_process');
    const code = await new Promise((resolve) => {
      const child = spawn(plan.bin, argv, { stdio: 'inherit' });
      child.on('error', (err) => {
        console.error(`✗ failed to run ${plan.bin}: ${err.message}`);
        resolve(127);
      });
      child.on('exit', (c) => resolve(c ?? 0));
    });
    if (code !== 0) {
      emitInstallResult(useJson, {
        ok: false,
        agent: slug,
        kind: 'cli',
        message: `${plan.bin} exited with code ${code}`,
      });
      process.exit(code || 1);
    }
    emitInstallResult(useJson, {
      ok: true,
      agent: slug,
      kind: 'cli',
      message: uninstall
        ? `removed ${serverName} from ${slug}`
        : `installed ${serverName} into ${slug}`,
    });
    return;
  }

  // plan.kind === 'json'
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  let existing = null;
  try {
    existing = await fs.readFile(plan.configPath, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  if (uninstall) {
    const next = removeJsonInstall(existing, plan);
    if (next == null) {
      emitInstallResult(useJson, {
        ok: true,
        agent: slug,
        kind: 'json',
        configPath: plan.configPath,
        message: `${serverName} not present in ${plan.configPath} — nothing to remove`,
      });
      return;
    }
    if (dryRun) {
      emitInstallResult(useJson, {
        ok: true,
        agent: slug,
        kind: 'json',
        configPath: plan.configPath,
        preview: next,
        message: `would update ${plan.configPath}`,
      });
      return;
    }
    await fs.writeFile(plan.configPath, next, 'utf8');
    emitInstallResult(useJson, {
      ok: true,
      agent: slug,
      kind: 'json',
      configPath: plan.configPath,
      message: `removed ${serverName} from ${plan.configPath}`,
    });
    return;
  }

  const next = applyJsonInstall(existing, plan);
  if (dryRun) {
    emitInstallResult(useJson, {
      ok: true,
      agent: slug,
      kind: 'json',
      configPath: plan.configPath,
      preview: next,
      message: `would write ${plan.configPath}`,
    });
    return;
  }
  await fs.mkdir(path.dirname(plan.configPath), { recursive: true });
  await fs.writeFile(plan.configPath, next, 'utf8');
  emitInstallResult(useJson, {
    ok: true,
    agent: slug,
    kind: 'json',
    configPath: plan.configPath,
    message: `installed ${serverName} into ${plan.configPath}`,
  });
}

function printMcpInstallHelp() {
  console.log(`Usage: readable mcp install <agent> [options]

Register Readable Studio's stdio MCP server into a coding agent's own config.

Agents:
  ${AGENT_SLUGS.join(' ')}

Options:
  --uninstall, --remove   Remove the Readable Studio MCP server instead.
  --print, --dry-run      Show what would change; write nothing.
  --json                  Machine-readable result.
  --name <name>           MCP server name in the agent config (default: readable-studio).
  --daemon-url <url>      Daemon URL used to resolve the launch command.

The launch command is resolved from the running daemon's
/api/mcp/install-info, so the installed entry matches the Settings → MCP
panel snippet byte-for-byte. Start the daemon first for an exact match;
otherwise a minimal \`readable mcp --daemon-url <url>\` command is used.`);
}

// ---------------------------------------------------------------------------
// Subcommand: readable plugin …
// ---------------------------------------------------------------------------

// Plan §3.B1 / spec §12.4: CLI structured error helper. Maps a daemon
// HTTP error envelope (or a synthetic local error) to a stable exit
// code + a JSON envelope on stderr. Code agents read these to decide
// whether the failure is recoverable (re-grant capabilities, prompt
// the user, retry with --grant-caps, etc.).
function exitWithStructuredError({ code, message, data }) {
  const exit = RECOVERABLE_EXIT_CODES[code] ?? 1;
  const envelope = { error: { code, message, data: data ?? {} } };
  process.stderr.write(JSON.stringify(envelope) + '\n');
  process.exit(exit);
}

// Map a daemon HTTP response into the exit-code envelope. Returns the
// parsed body (so the caller can keep going if it doesn't want to exit).
//
// Daemon error envelopes come in two shapes in practice:
//   { error: { code, message, ... } }  — newer routes using sendApiError
//   { error: '<message>' }             — older flat-string routes
//                                         (e.g. POST /api/templates at
//                                         project-routes.ts:667-680)
// Normalize so a flat-string body still surfaces its message to the
// structured envelope instead of collapsing to `HTTP <status>: `, which
// would drop the only diagnostic the daemon actually returned to a
// headless caller.
async function structuredHttpFailure(resp, fallbackCode = 'daemon-not-running') {
  let parsed;
  try { parsed = await resp.json(); } catch { parsed = {}; }
  const errorObj =
    typeof parsed?.error === 'string'
      ? { message: parsed.error }
      : parsed?.error;
  const errCode = normalizeRecoverableErrorCode(errorObj?.code, errorObj?.message);
  if (errCode && errCode in RECOVERABLE_EXIT_CODES) {
    exitWithStructuredError({
      code:    errCode,
      message: errorObj?.message ?? `HTTP ${resp.status}`,
      data:    structuredErrorData(errorObj),
    });
  }
  exitWithStructuredError({
    code:    fallbackCode,
    message: errorObj?.message ?? `HTTP ${resp.status}: ${await resp.text().catch(() => '')}`,
    data:    structuredErrorData(errorObj),
  });
}

function normalizeRecoverableErrorCode(code, message) {
  if (code === 'ROLLBACK_CONFLICT') return 'rollback-conflict';
  if (code === 'ROLLBACK_PLAN_CHANGED') return 'rollback-plan-changed';
  if (code === 'ROLLBACK_RUN_MISMATCH') return 'rollback-run-mismatch';
  if (code === 'ROLLBACK_LOOP_PREVENTED') return 'rollback-loop-prevented';
  if (code === 'ROLLBACK_APPROVAL_UNAVAILABLE') return 'rollback-approval-unavailable';
  if (code === 'ROLLBACK_APPROVAL_DENIED') return 'rollback-approval-denied';
  if (code === 'ROLLBACK_APPROVAL_TIMEOUT') return 'rollback-approval-timeout';
  if (code === 'ROLLBACK_REQUEST_EXPIRED') return 'rollback-request-expired';
  if (code === 'ROLLBACK_REQUEST_CONSUMED') return 'rollback-request-consumed';
  if (code === 'DESKTOP_AUTH_PENDING') return 'desktop-auth-pending';
  if (code === 'FORBIDDEN' && /desktop import token rejected/i.test(String(message ?? ''))) {
    return 'desktop-import-token-rejected';
  }
  return code;
}

function structuredErrorData(error) {
  if (!error || typeof error !== 'object') return undefined;
  const data = {};
  if ('data' in error && error.data !== undefined) Object.assign(data, error.data);
  if ('details' in error && error.details !== undefined) data.details = error.details;
  if ('conflicts' in error && error.conflicts !== undefined) data.conflicts = error.conflicts;
  if (typeof error.retryable === 'boolean') data.retryable = error.retryable;
  return Object.keys(data).length > 0 ? data : undefined;
}

async function runPlugin(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printPluginHelp();
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list':      return runPluginList(rest);
    case 'search':    return runPluginSearch(rest);
    case 'stats':     return runPluginStats(rest);
    case 'sources':   return runPluginSources(rest);
    case 'info':      return runPluginInfo(rest);
    case 'manifest':  return runPluginManifest(rest);
    case 'install':   return runPluginInstall(rest);
    case 'upgrade':   return runPluginUpgrade(rest);
    case 'uninstall': return runPluginUninstall(rest);
    case 'apply':     return runPluginApply(rest);
    case 'canon':     return runPluginCanon(rest);
    case 'diff':      return runPluginDiff(rest);
    case 'doctor':    return runPluginDoctor(rest);
    case 'replay':    return runPluginReplay(rest);
    case 'trust':     return runPluginTrust(rest);
    case 'snapshots': return runPluginSnapshots(rest);
    case 'simulate':  return runPluginSimulate(rest);
    case 'verify':    return runPluginVerify(rest);
    case 'events':    return runPluginEvents(rest);
    case 'run':       return runPluginRun(rest);
    case 'scaffold': return runPluginScaffold(rest);
    case 'validate': return runPluginValidate(rest);
    case 'pack':     return runPluginPack(rest);
    case 'login':    return runPluginLogin(rest);
    case 'whoami':   return runPluginWhoami(rest);
    case 'export':   return runPluginExport(rest);
    case 'publish':  return runPluginPublish(rest);
    case 'publish-repo': return runPluginPublishRepo(rest);
    case 'readable-studio-pr': return runPluginReadableStudioPr(rest);
    case 'yank':     return runPluginYank(rest);
    default:
      console.error(`unknown subcommand: readable plugin ${sub}`);
      printPluginHelp();
      process.exit(2);
  }
}

// Phase 4 / spec §14.1 — `readable plugin scaffold` interactive starter.
//
// Side-effect: writes a SKILL.md + readable-studio.json starter under
// `<targetDir>/<id>/`. Default targetDir is process.cwd() so a code
// agent can drop the scaffold into the current repo root.
async function runPluginScaffold(rest) {
  const flags = parseFlags(rest, {
    string: new Set([
      'id', 'title', 'description', 'task-kind', 'mode', 'scenario', 'out',
    ]),
    boolean: new Set(['help', 'h', 'json', 'with-claude-plugin']),
  });
  if (rest.length === 0 || flags.help || flags.h) {
    console.log(`Usage:
  readable plugin scaffold --id <id> [--title "<title>"] [--description "<text>"]
                     [--task-kind new-generation|code-migration|figma-migration|tune-collab]
                     [--mode <mode>] [--scenario <scenario>]
                     [--out <dir>] [--with-claude-plugin]

Writes <out|cwd>/<id>/{SKILL.md,readable-studio.json,README.md}.`);
    process.exit(rest.length === 0 ? 2 : 0);
  }
  const id = typeof flags.id === 'string' && flags.id.length > 0
    ? flags.id
    : rest.find((a) => !a.startsWith('-'));
  if (!id) {
    console.error('Usage: readable plugin scaffold --id <id>');
    process.exit(2);
  }
  const targetDir = typeof flags.out === 'string' && flags.out.length > 0
    ? flags.out
    : process.cwd();
  const { scaffoldPlugin, ScaffoldError } = await import('./plugins/scaffold.js');
  try {
    const input = {
      targetDir,
      id,
      ...(flags.title       ? { title: flags.title }             : {}),
      ...(flags.description ? { description: flags.description } : {}),
      ...(flags['task-kind']
        ? { taskKind: flags['task-kind'] }
        : {}),
      ...(flags.mode        ? { mode: flags.mode }               : {}),
      ...(flags.scenario    ? { scenario: flags.scenario }       : {}),
      withClaudePlugin: Boolean(flags['with-claude-plugin']),
    };
    const result = await scaffoldPlugin(input);
    if (flags.json) return process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    console.log(`[scaffold] ${result.folder}`);
    for (const file of result.files) console.log(`  ${file}`);
    console.log(`\nNext: readable plugin install ${result.folder}`);
  } catch (err) {
    if (err instanceof ScaffoldError) {
      console.error(`[scaffold] ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

// Phase 4 / spec §11.5 / plan §3.W1 — `readable plugin validate <folder>`.
//
// Pre-install lint pass against an author's working dir. Optionally
// fetches the daemon's registry view so skill / DS / atom refs in
// the manifest can be checked too; falls back to an empty registry
// when --no-daemon is set or the daemon is unreachable.
async function runPluginValidate(rest) {
  const flags = parseFlags(rest, {
    string:  new Set(['daemon-url']),
    boolean: new Set(['help', 'h', 'json', 'no-daemon']),
  });
  if (flags.help || flags.h || rest.length === 0 || rest[0]?.startsWith('-')) {
    console.log(`Usage:
  readable plugin validate <folder> [--json] [--no-daemon] [--daemon-url <url>]

Runs the plugin doctor against an unfinished plugin folder before
install. Validates manifest shape, atom ids, until expressions, and
context refs against the live daemon registry (skip with --no-daemon).

Exit codes:
  0  doctor.ok = true
  4  doctor.ok = false (errors present)
  2  CLI usage error / folder unreadable`);
    process.exit(rest.length === 0 ? 2 : 0);
  }
  const folder = rest[0];

  // Try to load the daemon's registry view; the validator works
  // offline too — emits warnings instead of errors for refs we
  // can't resolve.
  let registry;
  if (!flags['no-daemon']) {
    const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
    try {
      const [skillsResp, dsResp, atomsResp] = await Promise.all([
        fetch(`${base}/api/skills`).catch(() => null),
        fetch(`${base}/api/design-systems`).catch(() => null),
        fetch(`${base}/api/atoms`).catch(() => null),
      ]);
      const skills = (skillsResp?.ok ? (await skillsResp.json())?.skills : []) ?? [];
      const designSystems = (dsResp?.ok ? (await dsResp.json())?.designSystems : []) ?? [];
      const atoms = (atomsResp?.ok ? (await atomsResp.json())?.atoms : []) ?? [];
      registry = {
        skills:        skills.map((s) => ({ id: s.id, title: s.name ?? s.title, description: s.description })),
        designSystems: designSystems.map((d) => ({ id: d.id, title: d.title })),
        craft:         [],
        atoms:         atoms.map((a) => ({ id: a.id, label: a.label })),
      };
    } catch {
      registry = undefined;
    }
  }

  let result;
  try {
    const { validatePluginFolder, flattenValidationDiagnostics } = await import('./plugins/validate.js');
    result = await validatePluginFolder({ folder, ...(registry ? { registry } : {}) });
    if (flags.json) {
      const flat = flattenValidationDiagnostics(result);
      process.stdout.write(JSON.stringify({
        ok:      result.ok,
        folder:  result.folder,
        ...(result.doctor ? { freshDigest: result.doctor.freshDigest, pluginId: result.doctor.pluginId } : {}),
        diagnostics: flat,
      }, null, 2) + '\n');
    } else {
      console.log(`[validate] folder: ${result.folder}`);
      if (result.doctor) {
        console.log(`[validate] pluginId: ${result.doctor.pluginId}`);
        console.log(`[validate] freshDigest: ${result.doctor.freshDigest.slice(0, 12)}\u2026`);
      }
      const diagnostics = (await import('./plugins/validate.js')).flattenValidationDiagnostics(result);
      const errors = diagnostics.filter((d) => d.severity === 'error');
      const warnings = diagnostics.filter((d) => d.severity === 'warning');
      const infos = diagnostics.filter((d) => d.severity === 'info');
      for (const d of errors)   console.error(`  [error]   ${d.code}: ${d.message}`);
      for (const d of warnings) console.warn (`  [warning] ${d.code}: ${d.message}`);
      for (const d of infos)    console.log  (`  [info]    ${d.code}: ${d.message}`);
      if (errors.length === 0 && warnings.length === 0 && infos.length === 0) {
        console.log('[validate] no issues');
      }
      console.log(`[validate] ok=${result.ok}`);
    }
  } catch (err) {
    console.error(`[validate] failed: ${err?.message ?? err}`);
    process.exit(2);
  }
  process.exit(result.ok ? 0 : 4);
}

// Phase 4 / spec §14 / plan §3.X1 — `readable plugin pack <folder>`.
//
// Produces a gzip-compressed tar archive ready to install via the
// installer's HTTPS-tarball path. The output path is folder-base +
// version when the manifest exposes a version, otherwise folder-base.
async function runPluginPack(rest) {
  const flags = parseFlags(rest, {
    string:  new Set(['out']),
    boolean: new Set(['help', 'h', 'json']),
  });
  if (flags.help || flags.h || rest.length === 0 || rest[0]?.startsWith('-')) {
    console.log(`Usage:
  readable plugin pack <folder> [--out <path>] [--json]

Builds a gzip-compressed tar archive of <folder> at --out (default
'<folder>/../<basename>-<manifest.version>.tgz'). The archive is the
exact shape \`readable plugin install --source <https://...>\` consumes.

Skipped when packing:
  node_modules / .git / .next / dist / build / out / coverage /
  .turbo / .cache / .pnpm-store / .parcel-cache / .svelte-kit /
  .nuxt / .astro / .vercel / .vscode / .DS_Store / Thumbs.db
  (matches the installer's tarball-extract skiplist).
Symlinks are rejected at pack time (consistent with extract-time
rejection at install).

Exit codes:
  0  archive written
  2  CLI usage error
  4  pack-time error (missing readable-studio.json, invalid JSON, etc)`);
    process.exit(rest.length === 0 ? 2 : 0);
  }
  const folder = rest[0];
  try {
    const { packPlugin, PackPluginError } = await import('./plugins/pack.js');
    let result;
    try {
      result = await packPlugin({
        folder,
        ...(typeof flags.out === 'string' ? { out: flags.out } : {}),
      });
    } catch (err) {
      if (err instanceof PackPluginError) {
        if (flags.json) {
          process.stdout.write(JSON.stringify({ ok: false, error: err.message }, null, 2) + '\n');
        } else {
          console.error(`[pack] ${err.message}`);
        }
        process.exit(4);
      }
      throw err;
    }
    if (flags.json) {
      process.stdout.write(JSON.stringify({
        ok:            true,
        outPath:       result.outPath,
        bytes:         result.bytes,
        fileCount:     result.files.length,
        pluginId:      result.pluginId,
        pluginVersion: result.pluginVersion,
      }, null, 2) + '\n');
    } else {
      const idStr = result.pluginVersion
        ? `${result.pluginId ?? 'plugin'}@${result.pluginVersion}`
        : result.pluginId ?? 'plugin';
      console.log(`[pack] packed ${idStr}`);
      console.log(`[pack] out:    ${result.outPath}`);
      console.log(`[pack] files:  ${result.files.length}`);
      console.log(`[pack] bytes:  ${result.bytes}`);
      console.log(`\nNext: readable plugin install --source ${result.outPath}`);
    }
  } catch (err) {
    console.error(`[pack] failed: ${err?.message ?? err}`);
    process.exit(2);
  }
}

async function runPluginLogin(rest) {
  const flags = parseFlags(rest, {
    string: new Set(['host']),
    boolean: new Set(['help', 'h']),
  });
  if (flags.help || flags.h) {
    console.log(`Usage:
  readable plugin login [--host github.com]

Wraps GitHub CLI auth for Readable Studio registry publishing. The token stays in gh.`);
    return;
  }
  const host = typeof flags.host === 'string' ? flags.host : 'github.com';
  const version = await execGhBuffered(['--version'], { timeout: 10_000 });
  if (!version.ok) {
    console.error('[plugin login] GitHub CLI is required. Install gh from https://cli.github.com/ and retry.');
    process.exit(1);
  }
  const result = await spawnGhPassthrough(['auth', 'login', '--hostname', host, '--web']);
  process.exit(result.code ?? 0);
}

async function runPluginWhoami(rest) {
  const flags = parseFlags(rest, {
    string: new Set(['host']),
    boolean: new Set(['help', 'h', 'json']),
  });
  if (flags.help || flags.h) {
    console.log(`Usage:
  readable plugin whoami [--host github.com] [--json]

Shows the GitHub account gh will use for Readable Studio registry publishing.`);
    return;
  }
  const host = typeof flags.host === 'string' ? flags.host : 'github.com';
  const auth = await execGhBuffered(['auth', 'status', '--hostname', host], { timeout: 10_000 });
  if (!auth.ok) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({
        ok: false,
        host,
        message: 'GitHub CLI is not authenticated for this host.',
        log: auth.stderr || auth.stdout,
      }, null, 2) + '\n');
      return;
    }
    console.error(`[plugin whoami] gh is not authenticated for ${host}. Run: readable plugin login --host ${host}`);
    if (auth.stderr || auth.stdout) console.error(auth.stderr || auth.stdout);
    process.exit(1);
  }
  const user = await execGhBuffered(['api', 'user', '--hostname', host], { timeout: 10_000 });
  let login = '';
  let name = '';
  try {
    const parsed = JSON.parse(user.stdout || '{}');
    login = typeof parsed.login === 'string' ? parsed.login : '';
    name = typeof parsed.name === 'string' ? parsed.name : '';
  } catch {
    // Keep the auth status useful even if gh api output is unavailable.
  }
  const payload = {
    ok: true,
    host,
    login,
    name,
    auth: auth.stderr || auth.stdout,
  };
  if (flags.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    console.log(`[plugin whoami] ${login || 'authenticated'}${name ? ` (${name})` : ''} @ ${host}`);
  }
}

async function execFileBuffered(command, args, opts = {}) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      ...opts,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
        error,
      });
    });
  });
}

function quotePosixShellArg(value) {
  const text = String(value ?? '');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function buildGhShellCommand(args) {
  return ['gh', ...args].map(quotePosixShellArg).join(' ');
}

function buildLoginShellCommand(innerCommand) {
  return `export PATH=${quotePosixShellArg(process.env.PATH ?? '')}; ${innerCommand}`;
}

async function execGhBuffered(args, opts = {}) {
  if (process.platform === 'win32') {
    // Use the shell so test .cmd shims and the real gh.exe are both reachable
    // on PATH; a bare execFile cannot execute .cmd files.
    return execFileBuffered('gh', args, { shell: true, ...opts });
  }
  const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL.trim() : '/bin/zsh';
  return execFileBuffered(shell, ['-c', buildLoginShellCommand(buildGhShellCommand(args))], {
    env: process.env,
    ...opts,
  });
}

async function spawnPassthrough(command, args, opts = {}) {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', ...opts });
    child.on('error', (error) => resolve({ code: 1, error }));
    child.on('close', (code) => resolve({ code }));
  });
}

async function spawnGhPassthrough(args) {
  if (process.platform === 'win32') {
    // Use the shell so test .cmd shims and the real gh.exe are both reachable
    // on PATH; a bare spawn cannot execute .cmd files.
    return spawnPassthrough('gh', args, { shell: true });
  }
  const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL.trim() : '/bin/zsh';
  return spawnPassthrough(shell, ['-c', buildLoginShellCommand(buildGhShellCommand(args))], {
    env: process.env,
  });
}

function inferGithubHost(target) {
  if (!target || target === 'github.com') return 'github.com';
  try {
    const parsed = new URL(target);
    return parsed.hostname || 'github.com';
  } catch {
    // Marketplace ids are not URLs; v1 GitHub-backed auth defaults to github.com.
    return 'github.com';
  }
}

// Phase 4 / spec §14 — `readable plugin export <projectId> --as <target>`.
//
// Produces a publish-ready folder from the AppliedPluginSnapshot
// behind a given project (or directly from a snapshot id). Three
// targets: 'readable', 'claude-plugin', 'agent-skill'.
async function runPluginExport(rest) {
  const flags = parseFlags(rest, {
    string: new Set(['daemon-url', 'as', 'out', 'snapshot-id', 'project']),
    boolean: new Set(['help', 'h', 'json']),
  });
  if (rest.length === 0 || flags.help || flags.h) {
    console.log(`Usage:
  readable plugin export <projectId> --as readable-studio|claude-plugin|agent-skill --out <dir>
  readable plugin export --snapshot-id <id> --as readable-studio|claude-plugin|agent-skill --out <dir>

The export resolves through the daemon HTTP \`POST /api/applied-plugins/export\`
endpoint so the running daemon's installed_plugins / applied_plugin_snapshots
view is the single source of truth.`);
    process.exit(rest.length === 0 ? 2 : 0);
  }
  const positional = rest.find((a) => !a.startsWith('-'));
  const projectId = flags.project ?? positional ?? null;
  const snapshotId = typeof flags['snapshot-id'] === 'string' ? flags['snapshot-id'] : null;
  if (!projectId && !snapshotId) {
    console.error('Usage: readable plugin export <projectId> --as <target> --out <dir>');
    process.exit(2);
  }
  const target = String(flags.as ?? 'readable');
  if (target !== 'readable-studio' && target !== 'claude-plugin' && target !== 'agent-skill') {
    console.error(`--as must be one of: readable-studio, claude-plugin, agent-skill (got "${target}")`);
    process.exit(2);
  }
  const out = typeof flags.out === 'string' && flags.out.length > 0
    ? flags.out
    : process.cwd();
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  const resp = await fetch(`${base}/api/applied-plugins/export`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({
      ...(snapshotId ? { snapshotId } : { projectId }),
      target,
      outDir: out,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(`POST /api/applied-plugins/export failed: ${resp.status} ${JSON.stringify(data)}`);
    process.exit(1);
  }
  if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  console.log(`[export] ${data.folder} (snapshot ${data.snapshotId})`);
  for (const f of data.files ?? []) console.log(`  ${f}`);
}

// Plan §3.B4 / spec §6: `readable marketplace …` minimum verbs. Add / list /
// refresh / remove / trust. The Phase 3 follow-up wires
// `readable plugin install <name>` resolution through these catalogs.
async function runMarketplace(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable marketplace add     <url> [--trust trusted|restricted]   Register a federated catalog.
  readable marketplace list                                         List registered marketplaces.
  readable marketplace info    <id>                                 Inspect one marketplace + cached manifest.
  readable marketplace plugins <id> [--json]                        List cached plugin entries for one marketplace.
  readable marketplace search  <query> [--json]                     Search cached marketplace entries.
  readable marketplace doctor  [id] [--strict] [--json]             Validate cached marketplace entries.
  readable marketplace login   <id|url> [--host github.com]         Authenticate gh for private GitHub catalogs.
  readable marketplace refresh <id>                                 Re-fetch the manifest.
  readable marketplace remove  <id>                                 Forget a marketplace.
  readable marketplace trust   <id> [--trust trusted|restricted|official]
                                                              Update the marketplace trust tier.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base (default READABLE_DAEMON_URL, READABLE_SIDECAR_IPC_PATH discovery, or http://127.0.0.1:7456).
  --json               Emit raw JSON (suitable for scripts).`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  switch (sub) {
    case 'list': {
      const resp = await fetch(`${base}/api/marketplaces`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return structuredHttpFailure(resp);
      if (flags.json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }
      const rows = data?.marketplaces ?? [];
      if (rows.length === 0) {
        console.log('No marketplaces registered. Run `readable marketplace add <url>`.');
        return;
      }
      for (const m of rows) {
        console.log(`${m.id}  version=${m.version ?? 'unknown'}  spec=${m.specVersion ?? 'unknown'}  trust=${m.trust}  url=${m.url}`);
      }
      return;
    }
    case 'search': {
      // Plan §3.H4 / spec §12 — marketplace catalog query. Walks
      // every configured marketplace's plugins[] entry and matches
      // by substring on name + description + tags.
      const query = (rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
      if (!query) {
        console.error('Usage: readable marketplace search "<query>" [--tag <tag>]');
        process.exit(2);
      }
      const tag = typeof flags.tag === 'string' ? flags.tag.toLowerCase() : null;
      const resp = await fetch(`${base}/api/marketplaces`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      const matches = [];
      for (const mp of data?.marketplaces ?? []) {
        const plugins = mp.manifest?.plugins ?? [];
        for (const p of plugins) {
          const haystack = [
            p.name ?? '',
            p.description ?? '',
            ...(Array.isArray(p.tags) ? p.tags : []),
          ].join(' ').toLowerCase();
          if (!haystack.includes(query)) continue;
          if (tag && !(Array.isArray(p.tags) && p.tags.map((t) => t.toLowerCase()).includes(tag))) continue;
          matches.push({
            marketplaceId:  mp.id,
            marketplaceUrl: mp.url,
            marketplaceVersion: mp.version,
            name:           p.name,
            version:        p.version,
            source:         p.source,
            description:    p.description ?? '',
            tags:           p.tags ?? [],
          });
        }
      }
      if (flags.json) {
        process.stdout.write(JSON.stringify({ matches }, null, 2) + '\n');
        return;
      }
      if (matches.length === 0) {
        console.log(`No matches for "${query}"`);
        return;
      }
      for (const m of matches) {
        console.log(`${m.name}@${m.version}\t${m.source}\t${m.marketplaceId}@${m.marketplaceVersion}\t${m.description}`);
      }
      return;
    }
    case 'plugins': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: readable marketplace plugins <id> [--json]');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/marketplaces/${encodeURIComponent(id)}/plugins`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`plugins failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
      if (flags.json) {
        process.stdout.write(JSON.stringify({ marketplaceId: id, plugins }, null, 2) + '\n');
        return;
      }
      if (plugins.length === 0) {
        console.log(`No plugins in marketplace ${id}.`);
        return;
      }
      for (const p of plugins) {
        console.log(`${p.name}@${p.version}\t${p.source}\t${p.description ?? ''}`);
      }
      return;
    }
    case 'doctor': {
      const strict = flags.strict === true;
      const id = rest.find((a) => !a.startsWith('-'));
      const resp = id
        ? await fetch(`${base}/api/marketplaces/${encodeURIComponent(id)}`)
        : await fetch(`${base}/api/marketplaces`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`doctor failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      const rows = id ? [data] : (data?.marketplaces ?? []);
      const { doctorMarketplace } = await import('./plugins/marketplace-doctor.js');
      const reports = [];
      for (const row of rows) {
        reports.push(await doctorMarketplace({
          id: row.id,
          trust: row.trust,
          manifest: row.manifest,
          strict,
        }));
      }
      const ok = reports.every((report) => report.ok);
      if (flags.json) {
        process.stdout.write(JSON.stringify({ ok, reports }, null, 2) + '\n');
      } else {
        for (const report of reports) {
          console.log(`[marketplace doctor] ${report.backendId}: ${report.ok ? 'ok' : 'issues'} (${report.entriesChecked} entries)`);
          for (const issue of report.issues) {
            console.log(`  [${issue.severity}] ${issue.code}${issue.pluginName ? ` ${issue.pluginName}` : ''}: ${issue.message}`);
          }
        }
      }
      process.exit(ok ? 0 : 1);
    }
    case 'login': {
      const target = rest.find((a) => !a.startsWith('-'));
      const host = typeof flags.host === 'string'
        ? flags.host
        : inferGithubHost(target ?? 'github.com');
      const version = await execFileBuffered('gh', ['--version'], { timeout: 10_000 });
      if (!version.ok) {
        console.error('[marketplace login] GitHub CLI is required. Install gh from https://cli.github.com/ and retry.');
        process.exit(1);
      }
      console.log(`[marketplace login] authenticating gh for ${host}. Tokens stay in gh, not Readable Studio.`);
      const result = await spawnPassthrough('gh', ['auth', 'login', '--hostname', host, '--web']);
      process.exit(result.code ?? 0);
    }
    case 'add': {
      const url = rest.find((a) => !a.startsWith('-'));
      if (!url) {
        console.error('Usage: readable marketplace add <url> [--trust trusted|restricted]');
        process.exit(2);
      }
      const trust = flags.trust ?? 'restricted';
      const resp = await fetch(`${base}/api/marketplaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, trust }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`add failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      console.log(`[marketplace] added ${data.id} (${data.url}) trust=${data.trust}`);
      return;
    }
    case 'info':
    case 'refresh':
    case 'remove':
    case 'trust': {
      const id = rest.find((a) => !a.startsWith('-')
        && a !== flags.trust);
      if (!id) {
        console.error(`Usage: readable marketplace ${sub} <id>`);
        process.exit(2);
      }
      let url;
      let method = 'GET';
      let body;
      if (sub === 'info')         url = `${base}/api/marketplaces/${encodeURIComponent(id)}`;
      else if (sub === 'refresh') { url = `${base}/api/marketplaces/${encodeURIComponent(id)}/refresh`; method = 'POST'; }
      else if (sub === 'remove')  { url = `${base}/api/marketplaces/${encodeURIComponent(id)}`; method = 'DELETE'; }
      else if (sub === 'trust') {
        const trust = flags.trust ?? 'trusted';
        url = `${base}/api/marketplaces/${encodeURIComponent(id)}/trust`;
        method = 'POST';
        body = JSON.stringify({ trust });
      }
      const resp = await fetch(url, {
        method,
        ...(body ? { headers: { 'content-type': 'application/json' }, body } : {}),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`${sub} failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    default:
      console.error(`unknown subcommand: readable marketplace ${sub}`);
      process.exit(2);
  }
}

// Plan §3.A5 / spec §16 Phase 5: operator escape hatch for snapshot GC.
// Two subcommands:
//   - `readable plugin snapshots list [--project <id>]` — list snapshots
//   - `readable plugin snapshots prune [--before <ts>]` — force-delete expired
//     (and optionally older-than-cutoff unreferenced) rows.
async function runPluginSnapshots(args) {
  const sub = args[0];
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable plugin snapshots list  [--project <id>]               List applied plugin snapshots.
  readable plugin snapshots show  <snapshotId> [--json]          Print one snapshot's full contents.
  readable plugin snapshots diff  <id-a> <id-b> [--json]         Compare two snapshots field-by-field.
  readable plugin snapshots prune [--before <unix-ms>]           Delete expired (or older-than-cutoff) snapshots.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const flags = parseFlags(args.slice(1), { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  if (sub === 'show') {
    const positional = args.slice(1).filter((a) => !a.startsWith('-'));
    const id = positional[0];
    if (!id) {
      console.error('Usage: readable plugin snapshots show <snapshotId>');
      process.exit(2);
    }
    const url = `${base}/api/applied-plugins/${encodeURIComponent(id)}`;
    const resp = await fetch(url);
    if (resp.status === 404) {
      console.error(`snapshot ${id} not found`);
      process.exit(72);
    }
    if (!resp.ok) {
      console.error(`GET ${url} failed: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
    const data = await resp.json();
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (sub === 'diff') {
    const positional = args.slice(1).filter((a) => !a.startsWith('-'));
    if (positional.length < 2) {
      console.error('Usage: readable plugin snapshots diff <id-a> <id-b>');
      process.exit(2);
    }
    const [idA, idB] = positional;
    const [respA, respB] = await Promise.all([
      fetch(`${base}/api/applied-plugins/${encodeURIComponent(idA)}`),
      fetch(`${base}/api/applied-plugins/${encodeURIComponent(idB)}`),
    ]);
    if (respA.status === 404) { console.error(`snapshot ${idA} not found`); process.exit(72); }
    if (respB.status === 404) { console.error(`snapshot ${idB} not found`); process.exit(72); }
    if (!respA.ok || !respB.ok) {
      console.error(`fetch failed: ${respA.status} / ${respB.status}`);
      process.exit(1);
    }
    const a = await respA.json();
    const b = await respB.json();
    const { diffSnapshots } = await import('./plugins/snapshot-diff.js');
    const report = diffSnapshots({ a, b });
    if (flags.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }
    const digestNote = report.digestEqual
      ? '\u2713 manifestSourceDigest equal (e2e-2 invariant holds)'
      : '\u2717 manifestSourceDigest DIFFERS (replay would diverge)';
    console.log(`[snapshots diff] ${idA} \u2194 ${idB}`);
    console.log(`  ${digestNote}`);
    console.log(`  ${report.added} added, ${report.removed} removed, ${report.changed} changed`);
    if (report.entries.length === 0) {
      console.log('  (no field-level differences)');
      return;
    }
    for (const e of report.entries) {
      const tag = e.kind === 'added' ? '+' : e.kind === 'removed' ? '-' : '~';
      if (e.summary) {
        console.log(`  ${tag} ${e.field}  (${e.summary})`);
      } else if (e.kind === 'changed') {
        console.log(`  ${tag} ${e.field}: ${e.before ?? ''} \u2192 ${e.after ?? ''}`);
      } else if (e.kind === 'added') {
        console.log(`  ${tag} ${e.field}: ${e.after ?? ''}`);
      } else {
        console.log(`  ${tag} ${e.field}: ${e.before ?? ''}`);
      }
    }
    return;
  }
  if (sub === 'list') {
    const url = flags.project
      ? `${base}/api/projects/${encodeURIComponent(flags.project)}/applied-plugins`
      : `${base}/api/applied-plugins`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`GET ${url} failed: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
    const data = await resp.json();
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (sub === 'prune') {
    const url = `${base}/api/applied-plugins/prune`;
    const before = flags.before ? Number(flags.before) : undefined;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(before ? { before } : {}),
    });
    if (!resp.ok) {
      console.error(`POST ${url} failed: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
    const data = await resp.json();
    if (flags.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    console.log(`[snapshots] pruned ${data.removed ?? 0} snapshot(s)`);
    return;
  }
  console.error(`unknown subcommand: readable plugin snapshots ${sub}`);
  process.exit(2);
}

// Plan §3.B3: `readable plugin run <id>` shorthand. Today this is a thin
// wrapper around `readable plugin apply` + `POST /api/runs` so a code agent
// can drive the apply→start→follow loop without two hops.
async function runPluginRun(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const id = rest.find((a) => !a.startsWith('-')
    && a !== flags['daemon-url']
    && a !== flags.source
    && a !== flags.inputs
    && a !== flags.project
    && a !== flags.conversation
    && a !== flags.message
    && a !== flags.agent
    && a !== flags.model
    && a !== flags['snapshot-id']
    && a !== flags.capabilities
    && a !== flags['grant-caps']);
  if (!id) {
    console.error('Usage: readable plugin run <id> --project <projectId> [--inputs <json>] [--agent <id>] [--message "<text>"] [--grant-caps a,b] [--follow]');
    process.exit(2);
  }
  if (!flags.project) {
    console.error('--project <projectId> is required (Phase 1.5 will add the auto-create wrapper)');
    process.exit(2);
  }
  const inputs = flags.inputs ? safeParseJson(flags.inputs) ?? {} : {};
  const grantCaps = typeof flags['grant-caps'] === 'string' && flags['grant-caps'].length > 0
    ? flags['grant-caps'].split(',').map((c) => c.trim()).filter(Boolean)
    : [];
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  // 1. Apply (returns ApplyResult + manifestSourceDigest).
  const applyResp = await fetch(`${base}/api/plugins/${encodeURIComponent(id)}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs, grantCaps, projectId: flags.project }),
  });
  const applyData = await applyResp.json().catch(() => ({}));
  if (!applyResp.ok) {
    console.error(`apply failed: ${applyResp.status} ${JSON.stringify(applyData)}`);
    process.exit(applyResp.status === 422 ? 67 : 1);
  }
  // 2. Start the run with pluginId so the daemon resolver pins the
  //    snapshot to the run object.
  const runResp = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId:        flags.project,
      pluginId:         id,
      pluginInputs:     inputs,
      grantCaps,
      ...(flags.conversation ? { conversationId: flags.conversation } : {}),
      ...(flags.message ? { message: flags.message } : {}),
      ...(flags.agent ? { agentId: flags.agent } : {}),
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags['snapshot-id'] ? { appliedPluginSnapshotId: flags['snapshot-id'] } : {}),
    }),
  });
  const runData = await runResp.json().catch(() => ({}));
  if (!runResp.ok) {
    if (runResp.status === 409 && runData?.error?.code === 'capabilities-required') {
      const missing = (runData.error.data?.missing ?? []).join(',');
      console.error(`[run] capabilities required: ${missing}`);
      console.error(`[run] retry with --grant-caps ${missing} or run \`readable plugin trust ${id} --capabilities ${missing}\``);
      process.exit(66);
    }
    console.error(`run failed: ${runResp.status} ${JSON.stringify(runData)}`);
    process.exit(1);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ apply: applyData, run: runData }, null, 2) + '\n');
    if (flags.follow) await streamRunEvents(base, runData.runId);
    return;
  }
  console.log(`[run] started run ${runData.runId} (snapshot ${runData.appliedPluginSnapshotId ?? applyData?.appliedPlugin?.snapshotId ?? 'n/a'})`);
  if (flags.follow) {
    await streamRunEvents(base, runData.runId);
  }
}

async function pluginDaemonUrl(flags) {
  return cliDaemonUrl(flags);
}

// Plan §3.Y1 — filter knobs on `readable plugin list` (and feeds
// `readable plugin search` below). Recognising these as string flags
// keeps the parseFlags() argv consumer happy.
async function runPluginList(rest) {
  const flags = parseFlags(rest, {
    string:  PLUGIN_LIST_FILTER_FLAGS,
    boolean: PLUGIN_LIST_BOOLEAN_FLAGS,
  });
  if (flags.help || flags.h) {
    console.log(`Usage:
  readable plugin list [--task-kind <kind>] [--mode <mode>] [--tag <tag>] \\
                 [--trust <tier>] [--bundled | --no-bundled] [--json]

Lists installed plugins. Filters AND together: --task-kind=code-migration
+ --tag=phase-7 returns only code-migration plugins tagged 'phase-7'.

  --task-kind   Match readable.taskKind (new-generation / figma-migration /
                code-migration / tune-collab).
  --mode        Match readable.mode.
  --tag         Match an entry in tags[].
  --trust       Match trust tier (trusted / restricted / bundled).
  --bundled     Restrict to bundled plugins (sourceKind='bundled' OR
                trust='bundled').
  --no-bundled  Exclude bundled plugins.`);
    process.exit(0);
  }
  const data = await fetchPluginList(flags);
  const filtered = await applyPluginFilters(data?.plugins ?? [], flags);
  emitPluginList({ entries: filtered, json: !!flags.json, emptyMessage: 'No plugins matched the filter.' });
}

// Plan §3.Y1 — `readable plugin search <query>`.
async function runPluginSearch(rest) {
  const flags = parseFlags(rest, {
    string:  PLUGIN_LIST_FILTER_FLAGS,
    boolean: PLUGIN_LIST_BOOLEAN_FLAGS,
  });
  const positional = rest.filter((a) => !a.startsWith('-'));
  const query = positional[0];
  if (flags.help || flags.h || !query) {
    console.log(`Usage:
  readable plugin search <query> [--task-kind <kind>] [--mode <mode>] \\
                           [--tag <tag>] [--trust <tier>] \\
                           [--bundled | --no-bundled] [--json]

Free-text search across installed plugins. Matches case-insensitively
on id / title / description / tags. Combines with the same filter
flags as 'readable plugin list'.`);
    process.exit(query ? 0 : 2);
  }
  const data = await fetchPluginList(flags);
  const filtered = await applyPluginFilters(data?.plugins ?? [], flags, query);
  emitPluginList({
    entries: filtered,
    json:    !!flags.json,
    emptyMessage: `No installed plugins matched "${query}".`,
    showRank: true,
  });
}

// Plan §3.DD1 — `readable plugin stats`. Pretty-prints the
// pluginInventoryStats + snapshotInventoryStats aggregation. The
// daemon-side route owns the SQLite reads; the CLI is a thin
// formatter.
async function runPluginStats(rest) {
  const flags = parseFlags(rest, {
    string:  PLUGIN_STRING_FLAGS,
    boolean: PLUGIN_BOOLEAN_FLAGS,
  });
  if (flags.help || flags.h) {
    console.log(`Usage:
  readable plugin stats [--json]

Prints an at-a-glance plugin + snapshot inventory:
  - Plugin counts by sourceKind, trust, taskKind.
  - Bundled vs. third-party split.
  - Plugins with elevated capabilities (fs:write, subprocess,
    bash, network).
  - Snapshot total, status breakdown, project / run linkage.
  - Oldest / newest applied snapshot timestamps.`);
    process.exit(0);
  }
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  const url = `${base}/api/plugins/stats`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`GET ${url} failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  const p = data?.plugins ?? {};
  const s = data?.snapshots ?? {};
  const lastInstalled = formatTimestamp(p.lastInstalledAt);
  const lastUpdated   = formatTimestamp(p.lastUpdatedAt);
  const oldestApplied = formatTimestamp(s.oldestAppliedAt);
  const newestApplied = formatTimestamp(s.newestAppliedAt);
  console.log('# Plugins');
  console.log(`  total:            ${p.total ?? 0}`);
  console.log(`  bundled:          ${p.bundled ?? 0}`);
  console.log(`  third-party:      ${p.thirdParty ?? 0}`);
  console.log(`  with elevated:    ${p.withElevatedCapabilities ?? 0}`);
  console.log(`  by sourceKind:    ${formatCounts(p.bySourceKind)}`);
  console.log(`  by trust:         ${formatCounts(p.byTrust)}`);
  console.log(`  by taskKind:      ${formatCounts(p.byTaskKind)}`);
  console.log(`  last installed:   ${lastInstalled}`);
  console.log(`  last updated:     ${lastUpdated}`);
  console.log('');
  console.log('# Snapshots');
  console.log(`  total:            ${s.total ?? 0}`);
  console.log(`  by status:        ${formatCounts(s.byStatus)}`);
  console.log(`  with project:     ${s.withProject ?? 0}`);
  console.log(`  with run:         ${s.withRun ?? 0}`);
  console.log(`  oldest applied:   ${oldestApplied}`);
  console.log(`  newest applied:   ${newestApplied}`);
}

function formatCounts(counts) {
  if (!counts || typeof counts !== 'object') return '(none)';
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '(none)';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

function formatTimestamp(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '(none)';
  try { return new Date(ts).toISOString(); } catch { return String(ts); }
}

async function fetchPluginList(flags) {
  const url = `${(await pluginDaemonUrl(flags)).replace(/\/$/, '')}/api/plugins`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`GET /api/plugins failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  return data;
}

async function applyPluginFilters(plugins, flags, query) {
  if (!Array.isArray(plugins) || plugins.length === 0) return [];
  const { searchInstalledPlugins } = await import('./plugins/search.js');
  const trustFlag = typeof flags.trust === 'string' ? flags.trust : undefined;
  const taskKind  = typeof flags['task-kind'] === 'string' ? flags['task-kind'] : undefined;
  const mode      = typeof flags.mode === 'string' ? flags.mode : undefined;
  const tag       = typeof flags.tag === 'string'  ? flags.tag  : undefined;
  let bundled;
  if (flags.bundled === true)         bundled = true;
  if (flags['no-bundled'] === true)   bundled = false;
  const result = searchInstalledPlugins({
    plugins,
    ...(typeof query === 'string' && query.trim() ? { query } : {}),
    ...(taskKind ? { taskKind } : {}),
    ...(mode     ? { mode } : {}),
    ...(tag      ? { tag } : {}),
    ...(trustFlag === 'trusted' || trustFlag === 'restricted' || trustFlag === 'bundled' ? { trust: trustFlag } : {}),
    ...(typeof bundled === 'boolean' ? { bundled } : {}),
  });
  return result.entries;
}

function emitPluginList({ entries, json, emptyMessage, showRank }) {
  if (json) {
    process.stdout.write(JSON.stringify({
      total: entries.length,
      plugins: entries.map((e) => ({
        ...e.plugin,
        ...(showRank ? { matched: e.matched, rank: e.rank } : {}),
      })),
    }, null, 2) + '\n');
    return;
  }
  if (entries.length === 0) {
    console.log(emptyMessage ?? 'No plugins matched.');
    return;
  }
  for (const entry of entries) {
    const p = entry.plugin;
    const tail = showRank && entry.matched.length > 0
      ? `  matched=[${entry.matched.join(',')}]`
      : '';
    console.log(`${p.id}@${p.version}  trust=${p.trust}  source=${p.sourceKind}  title="${p.title}"${tail}`);
  }
}

async function runPluginInfo(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const id = rest.find((a) => !a.startsWith('--')
    && a !== flags['daemon-url']
    && a !== flags.source
    && a !== flags.version);
  if (!id) {
    console.error('Usage: readable plugin info <id-or-marketplace-name> [--version <version|tag|range>] [--json]');
    process.exit(2);
  }
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  const url = `${base}/api/plugins/${encodeURIComponent(id)}`;
  const resp = await fetch(url);
  if (resp.ok && !flags.version) {
    const data = await resp.json();
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  const mpResp = await fetch(`${base}/api/marketplaces`);
  if (mpResp.ok) {
    const mpData = await mpResp.json().catch(() => ({}));
    const resolved = resolveMarketplacePluginFromList(
      mpData?.marketplaces ?? [],
      flags.version ? `${id}@${flags.version}` : id,
    );
    if (resolved) {
      process.stdout.write(JSON.stringify({ marketplace: resolved }, null, 2) + '\n');
      return;
    }
  }
  if (!resp.ok) {
    console.error(`GET /api/plugins/${id} failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function resolveMarketplacePluginFromList(marketplaces, specifier) {
  const parsed = parseCliPluginSpecifier(specifier);
  const target = parsed.name.toLowerCase();
  for (const marketplace of marketplaces) {
    for (const entry of marketplace?.manifest?.plugins ?? []) {
      if (String(entry.name ?? '').toLowerCase() !== target) continue;
      const version = resolveCliEntryVersion(entry, parsed.range);
      if (!version) return null;
      return {
        marketplaceId: marketplace.id,
        marketplaceTrust: marketplace.trust,
        name: entry.name,
        version: version.version,
        source: version.source,
        ref: version.ref,
        integrity: version.integrity,
        manifestDigest: version.manifestDigest,
        entry,
      };
    }
  }
  return null;
}

function parseCliPluginSpecifier(input) {
  const trimmed = String(input ?? '').trim();
  const slash = trimmed.indexOf('/');
  const at = trimmed.lastIndexOf('@');
  if (slash > 0 && at > slash + 1) {
    return { name: trimmed.slice(0, at), range: trimmed.slice(at + 1) };
  }
  return { name: trimmed, range: undefined };
}

function resolveCliEntryVersion(entry, range) {
  if (entry?.yanked) return null;
  const versions = Array.isArray(entry?.versions) ? entry.versions : [];
  const target = range && range !== 'latest'
    ? (entry?.distTags?.[range] ?? range)
    : (entry?.distTags?.latest ?? entry?.version);
  const version = versions.find((item) => item.version === target) ?? null;
  if (version?.yanked) return null;
  return {
    version: target,
    source: version?.source ?? entry?.source,
    ref: version?.ref ?? entry?.ref,
    integrity: version?.integrity ?? version?.dist?.integrity ?? entry?.integrity ?? entry?.dist?.integrity,
    manifestDigest: version?.manifestDigest ?? version?.dist?.manifestDigest ?? entry?.manifestDigest ?? entry?.dist?.manifestDigest,
  };
}

// Plan §3.MM1 — `readable plugin manifest <id>`. Prints just the parsed
// manifest JSON, no wrapper. Useful for plugin authors who want to
// compare the daemon's view to their on-disk readable-studio.json
// without scrolling past the registry record fields (sourceKind /
// fsPath / installedAt etc).
async function runPluginManifest(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const id = rest.find((a) => !a.startsWith('--') && a !== flags['daemon-url'] && a !== flags.source);
  if (!id) {
    console.error('Usage: readable plugin manifest <id>');
    process.exit(2);
  }
  const url = `${(await pluginDaemonUrl(flags)).replace(/\/$/, '')}/api/plugins/${encodeURIComponent(id)}`;
  const resp = await fetch(url);
  if (resp.status === 404) {
    console.error(`plugin ${id} not found`);
    process.exit(65);
  }
  if (!resp.ok) {
    console.error(`GET /api/plugins/${id} failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  if (!data?.manifest) {
    console.error(`plugin ${id} has no recorded manifest (registry row is incomplete)`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(data.manifest, null, 2) + '\n');
}

// Plan §3.MM2 — `readable plugin sources`. Lists every distinct install
// source string + count of plugins installed from it, ordered by
// count descending then source ascending. Useful for ops audits
// ('which github repos do my plugins come from') + for plugin
// authors comparing their fork to its upstream installs.
async function runPluginSources(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const url = `${(await pluginDaemonUrl(flags)).replace(/\/$/, '')}/api/plugins`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`GET /api/plugins failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
  const buckets = new Map();
  for (const p of plugins) {
    const key = `${p.sourceKind ?? 'unknown'}\t${p.source ?? '(none)'}`;
    const entry = buckets.get(key) ?? { sourceKind: p.sourceKind ?? 'unknown', source: p.source ?? '(none)', count: 0, plugins: [] };
    entry.count += 1;
    entry.plugins.push({ id: p.id, version: p.version });
    buckets.set(key, entry);
  }
  const rows = [...buckets.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.sourceKind !== b.sourceKind) return a.sourceKind.localeCompare(b.sourceKind);
    return a.source.localeCompare(b.source);
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ total: plugins.length, sources: rows }, null, 2) + '\n');
    return;
  }
  if (rows.length === 0) {
    console.log('No plugins installed.');
    return;
  }
  console.log(`# Plugin install sources (total: ${plugins.length})`);
  for (const row of rows) {
    console.log(`  ${row.sourceKind.padEnd(11)}  ${String(row.count).padStart(3)}  ${row.source}`);
    for (const plug of row.plugins) {
      console.log(`               \u2514\u2500 ${plug.id}@${plug.version}`);
    }
  }
}

async function runPluginInstall(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const source = typeof flags.source === 'string' ? flags.source : rest.find((a) => !a.startsWith('-'));
  if (!source) {
    console.error('Usage: readable plugin install <source-or-name>\n' +
      '       readable plugin install ./local-folder\n' +
      '       readable plugin install github:owner/repo[@ref][/subpath]\n' +
      '       readable plugin install https://example.com/plugin.tar.gz\n' +
      '       readable plugin install <name>[@version|tag|range]  # resolves through configured marketplaces');
    process.exit(2);
  }
  const url = `${(await pluginDaemonUrl(flags)).replace(/\/$/, '')}/api/plugins/install`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ source }),
  });
  if (!resp.ok || !resp.body) {
    console.error(`POST /api/plugins/install failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let exitCode = 0;
  const events = [];
  let finalEvent = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine  = lines.find((l) => l.startsWith('data: '));
      const event = eventLine ? eventLine.slice('event: '.length) : 'message';
      const data = dataLine ? safeParseJson(dataLine.slice('data: '.length)) : null;
      events.push({ event, data });
      if (event === 'progress') {
        if (!flags.json) console.log(`[install] ${data?.phase ?? '...'}: ${data?.message ?? ''}`);
      } else if (event === 'success') {
        finalEvent = data;
        if (!flags.json) console.log(`[install] ok — ${data?.plugin?.id}@${data?.plugin?.version} (trust=${data?.plugin?.trust})`);
        if (!flags.json && Array.isArray(data?.warnings) && data.warnings.length > 0) {
          for (const w of data.warnings) console.log(`[install] warn: ${w}`);
        }
      } else if (event === 'error') {
        finalEvent = data;
        if (!flags.json) console.error(`[install] error: ${data?.message ?? 'unknown'}`);
        exitCode = 1;
      }
    }
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      ok: exitCode === 0,
      result: finalEvent,
      events,
    }, null, 2) + '\n');
  }
  process.exit(exitCode);
}

// Plan §3.Z2 — `readable plugin upgrade <id>`. Re-installs the plugin
// from its recorded source. Streams the same SSE event shape as
// install, so 'progress' / 'success' / 'error' arrive verbatim.
// Plan §3.II1 — `readable plugin events tail`. Tails the daemon's
// in-memory plugin event ring buffer via SSE. -f keeps the
// connection open and prints live events; otherwise prints the
// backlog and exits when the daemon closes the stream.
async function runPluginEvents(rest) {
  const sub = rest[0];
  if (!sub || sub === 'help' || rest.includes('--help') || rest.includes('-h')) {
    console.log(`Usage:
  readable plugin events tail     [-f] [--since <id>] [--kind <k>] [--plugin-id <id>] [--json]
  readable plugin events snapshot [--since <id>] [--kind <k>] [--plugin-id <id>] [--json]
  readable plugin events stats    [--json]
  readable plugin events purge    [--confirm] [--json]    (loopback-only)

Tail / snapshot / stats / purge over the daemon's in-memory
plugin event ring buffer (capped at 1000 entries; resets on
daemon restart).
Lifecycle vocabulary:
  plugin.installed | plugin.upgraded | plugin.uninstalled
  plugin.trust-changed | plugin.snapshot-pruned
  plugin.marketplace-refreshed | plugin.applied

  --since <id>       Trim backlog to events strictly after id.
  --kind <k>         Filter to a single kind.
  --plugin-id <id>   Filter to events touching one plugin id.
  -f / --follow      tail-only: keep the SSE stream open.
  --json             Emit raw JSON (one event per line on tail,
                     full report on snapshot/stats).`);
    process.exit(sub ? 0 : 2);
  }
  const flags = parseFlags(rest.slice(1), {
    string:  new Set([...PLUGIN_STRING_FLAGS, 'since', 'kind', 'plugin-id']),
    boolean: new Set([...PLUGIN_BOOLEAN_FLAGS, 'f', 'follow']),
  });
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  const since = typeof flags.since === 'string' ? Number(flags.since) : 0;
  const kindFilter = typeof flags.kind === 'string' && flags.kind.length > 0 ? flags.kind : null;
  const pluginIdFilter = typeof flags['plugin-id'] === 'string' && flags['plugin-id'].length > 0
    ? flags['plugin-id']
    : null;
  const matches = (ev) => {
    if (!ev) return false;
    if (kindFilter && ev.kind !== kindFilter) return false;
    if (pluginIdFilter && ev.pluginId !== pluginIdFilter) return false;
    return true;
  };

  if (sub === 'snapshot') {
    const url = `${base}/api/plugins/events/snapshot${Number.isFinite(since) && since > 0 ? `?since=${since}` : ''}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`GET ${url} failed: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
    const data = await resp.json();
    const events = (Array.isArray(data?.events) ? data.events : []).filter(matches);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ events, count: events.length, generatedAt: data?.generatedAt }, null, 2) + '\n');
      return;
    }
    if (events.length === 0) {
      console.log('[events snapshot] no events match filter');
      return;
    }
    for (const ev of events) {
      const ts = ev.at ? new Date(ev.at).toISOString() : '?';
      const detailKeys = ev.details ? Object.keys(ev.details).slice(0, 3).join(',') : '';
      console.log(`#${ev.id}  ${ts}  ${ev.kind}  pluginId=${ev.pluginId || '-'}` +
        (detailKeys ? `  details=${detailKeys}` : ''));
    }
    return;
  }

  if (sub === 'purge') {
    // Refuse to run without an explicit --confirm so 'readable plugin
    // events purge' alone never drops audit data accidentally.
    const purgeFlags = parseFlags(rest.slice(1), {
      string:  new Set(['daemon-url']),
      boolean: new Set(['help', 'h', 'json', 'confirm']),
    });
    if (!purgeFlags.confirm) {
      console.error('[events purge] refusing without --confirm. This drops every event in the in-memory buffer.');
      process.exit(2);
    }
    const resp = await fetch(`${base}/api/plugins/events/purge`, { method: 'POST' });
    if (!resp.ok) {
      console.error(`POST /api/plugins/events/purge failed: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
    const data = await resp.json();
    if (purgeFlags.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      console.log(`[events purge] dropped ${data.purged ?? 0} event${(data.purged ?? 0) === 1 ? '' : 's'} (id range: ${data.firstId ?? '(none)'} \u2192 ${data.lastId ?? '(none)'}; preNextId=${data.preNextId})`);
    }
    return;
  }

  if (sub === 'stats') {
    const resp = await fetch(`${base}/api/plugins/events/stats`);
    if (!resp.ok) {
      console.error(`GET /api/plugins/events/stats failed: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
    const data = await resp.json();
    if (flags.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    const s = data?.stats ?? {};
    console.log('# Plugin events');
    console.log(`  total:           ${s.total ?? 0}`);
    console.log(`  by kind:         ${formatCounts(s.byKind)}`);
    console.log(`  by pluginId:     ${formatCounts(s.byPluginId)}`);
    console.log(`  oldest at:       ${formatTimestamp(s.oldestAt)}`);
    console.log(`  newest at:       ${formatTimestamp(s.newestAt)}`);
    console.log(`  id range:        ${s.firstId ?? '(none)'} \u2192 ${s.lastId ?? '(none)'}`);
    return;
  }

  if (sub !== 'tail') {
    console.error(`unknown subcommand: readable plugin events ${sub}`);
    process.exit(2);
  }
  const follow = flags.f === true || flags.follow === true;
  const url = `${base}/api/plugins/events${Number.isFinite(since) && since > 0 ? `?since=${since}` : ''}`;
  const resp = await fetch(url, { headers: { accept: 'text/event-stream' } });
  if (!resp.ok || !resp.body) {
    console.error(`GET ${url} failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const renderEvent = (channel, data) => {
    if (!matches(data)) return;
    if (flags.json) {
      process.stdout.write(JSON.stringify({ channel, ...data }) + '\n');
      return;
    }
    const ts = data?.at ? new Date(data.at).toISOString() : '?';
    const id = data?.id ?? '?';
    const tag = channel === 'backlog' ? '[bk]' : '[ev]';
    const detailKeys = data?.details ? Object.keys(data.details).slice(0, 3).join(',') : '';
    console.log(`${tag} #${id}  ${ts}  ${data?.kind ?? '?'}  pluginId=${data?.pluginId ?? '-'}` +
      (detailKeys ? `  details=${detailKeys}` : ''));
  };
  // Read until the daemon closes the stream OR --follow keeps it open
  // forever. Without --follow we still let the daemon drain the
  // backlog naturally; the route emits all backlog entries first,
  // and our reader exits when the connection closes (which the
  // daemon never does on its own, so we add a small idle timer).
  if (!follow) {
    // Non-follow: drain backlog, then exit after a short idle period
    // (the route never naturally closes; the SSE backlog is a one-shot
    // stream of event entries).
    let lastChunkAt = Date.now();
    const idleMs = 200;
    const idleTimer = setInterval(() => {
      if (Date.now() - lastChunkAt > idleMs) {
        clearInterval(idleTimer);
        try { reader.cancel(); } catch { /* ignore */ }
      }
    }, 100);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        lastChunkAt = Date.now();
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const lines = block.split('\n');
          const ev = lines.find((l) => l.startsWith('event: '))?.slice('event: '.length) ?? 'message';
          const dat = lines.find((l) => l.startsWith('data: '))?.slice('data: '.length);
          if (!dat) continue;
          try { renderEvent(ev, JSON.parse(dat)); } catch { /* ignore */ }
        }
      }
    } finally {
      clearInterval(idleTimer);
    }
    return;
  }
  // Follow mode: read forever.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const lines = block.split('\n');
      const ev = lines.find((l) => l.startsWith('event: '))?.slice('event: '.length) ?? 'message';
      const dat = lines.find((l) => l.startsWith('data: '))?.slice('data: '.length);
      if (!dat) continue;
      try { renderEvent(ev, JSON.parse(dat)); } catch { /* ignore */ }
    }
  }
}

// Plan §3.FF1 — `readable plugin verify <pluginId>` CI meta-command.
//
// Reads an optional .readable-studio-verify.json config from the plugin folder
// or --config <path> and runs the enabled subset of:
//
//   doctor   — calls /api/plugins/<id>/doctor
//   simulate — calls /api/plugins/<id> + simulatePipeline()
//   canon    — fetches /api/applied-plugins/<snapshotId>/canon and
//              compares against the on-disk fixture
//
// Aggregates into a unified pass/fail report. Exit 4 on any failed
// check; useful as a one-liner CI check for a plugin's repo.
async function runPluginVerify(rest) {
  const flags = parseFlags(rest, {
    string:  new Set([...PLUGIN_STRING_FLAGS, 'config']),
    boolean: PLUGIN_BOOLEAN_FLAGS,
  });
  const positional = rest.filter((a) => !a.startsWith('-'));
  const id = positional[0];
  if (flags.help || flags.h || !id) {
    console.log(`Usage:
  readable plugin verify <pluginId> [--config <path>] [--json]

CI meta-command. Reads an optional config from
'<plugin-folder>/.readable-studio-verify.json' (or --config <path>) and runs:

  doctor    — manifest + atom + ref lint
  simulate  — convergence dry-run for every until expression,
              with per-stage signals from config.simulate.signals
  canon     — byte-equality check against
              config.canon.fixturePath using the snapshot at
              config.canon.snapshotId

Sample .readable-studio-verify.json:

  {
    "enabled": ["doctor", "simulate"],
    "simulate": {
      "signals": { "critique.score": 5, "build.passing": true },
      "iterationCap": 5
    },
    "canon": {
      "snapshotId": "snap-abc",
      "fixturePath": "tests/expected-block.md"
    }
  }

Exit codes:
  0  every enabled check passed
  4  one or more enabled checks failed
  2  CLI usage error / plugin not found / config malformed`);
    process.exit(id ? 0 : 2);
  }
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');

  // 1. Resolve the plugin record (fsPath + manifest).
  const pluginResp = await fetch(`${base}/api/plugins/${encodeURIComponent(id)}`);
  if (pluginResp.status === 404) {
    console.error(`plugin ${id} not found`);
    process.exit(65);
  }
  if (!pluginResp.ok) {
    console.error(`GET /api/plugins/${id} failed: ${pluginResp.status} ${await pluginResp.text()}`);
    process.exit(1);
  }
  const plugin = await pluginResp.json();

  // 2. Load .readable-studio-verify.json from --config or <fsPath>/.readable-studio-verify.json.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const configPath = typeof flags.config === 'string'
    ? path.resolve(flags.config)
    : (typeof plugin?.fsPath === 'string' ? path.join(plugin.fsPath, '.readable-studio-verify.json') : null);
  let config = { enabled: ['doctor', 'simulate', 'canon'] };
  if (configPath) {
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      config = JSON.parse(raw);
    } catch (err) {
      const e = err;
      if (e?.code !== 'ENOENT') {
        console.error(`[verify] cannot read config ${configPath}: ${e?.message ?? e}`);
        process.exit(2);
      }
      // ENOENT → run with defaults. canon will skip cleanly because no
      // config.canon entry was supplied.
    }
  }

  // 3. doctor (when enabled)
  const enabledSet = new Set((config.enabled ?? ['doctor', 'simulate', 'canon']).filter((c) =>
    c === 'doctor' || c === 'simulate' || c === 'canon'));
  let doctorReport = null;
  if (enabledSet.has('doctor')) {
    const doctorResp = await fetch(`${base}/api/plugins/${encodeURIComponent(id)}/doctor`);
    if (doctorResp.ok) {
      doctorReport = await doctorResp.json();
    }
  }

  // 4. simulate (when enabled)
  let simulateReport = null;
  if (enabledSet.has('simulate')) {
    const pipeline = plugin?.manifest?.readable?.pipeline;
    if (pipeline && Array.isArray(pipeline.stages) && pipeline.stages.length > 0) {
      const { simulatePipeline } = await import('./plugins/simulate.js');
      simulateReport = simulatePipeline({
        pipeline,
        signals: config.simulate?.signals ?? {},
        ...(typeof config.simulate?.iterationCap === 'number' && config.simulate.iterationCap > 0
          ? { iterationCap: config.simulate.iterationCap }
          : {}),
      });
    }
  }

  // 5. canon (when enabled + fixture supplied)
  let canonActual = null;
  let canonExpected = null;
  if (enabledSet.has('canon') && config.canon?.snapshotId && config.canon?.fixturePath) {
    const fixturePath = path.resolve(
      typeof flags.config === 'string'
        ? path.dirname(path.resolve(flags.config))
        : (typeof plugin?.fsPath === 'string' ? plugin.fsPath : process.cwd()),
      config.canon.fixturePath,
    );
    try {
      canonExpected = await fs.readFile(fixturePath, 'utf8');
    } catch {
      canonExpected = null;
    }
    if (canonExpected !== null) {
      const canonResp = await fetch(
        `${base}/api/applied-plugins/${encodeURIComponent(config.canon.snapshotId)}/canon`,
        { headers: { accept: 'text/plain' } },
      );
      if (canonResp.ok) {
        canonActual = await canonResp.text();
      }
    }
  }

  // 6. Aggregate.
  const { verifyPlugin } = await import('./plugins/verify.js');
  const report = verifyPlugin({
    config: {
      enabled: [...enabledSet],
      ...(config.strict   === true     ? { strict:   true }      : {}),
      ...(config.simulate              ? { simulate: config.simulate } : {}),
      ...(config.canon                 ? { canon:    config.canon    } : {}),
    },
    ...(doctorReport   ? { doctor:        doctorReport } : {}),
    ...(simulateReport ? { simulate:      simulateReport } : {}),
    ...(canonActual    ? { canon:         canonActual } : {}),
    ...(canonExpected  ? { canonExpected: canonExpected } : {}),
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ pluginId: id, ...report }, null, 2) + '\n');
  } else {
    console.log(`[verify] plugin ${id} \u2014 ${report.passed ? 'PASSED' : 'FAILED'}`);
    for (const o of report.outcomes) {
      const tag = o.status === 'passed' ? '\u2713'
                : o.status === 'failed' ? '\u2717'
                : o.status === 'skipped' ? '-'
                : '!';
      console.log(`  ${tag} ${o.summary}`);
    }
  }
  process.exit(report.passed ? 0 : 4);
}

// Plan §3.EE1 — `readable plugin simulate <pluginId> [-s key=value ...]`.
//
// Walks the plugin's pipeline against caller-supplied signals and
// reports per-stage convergence (iterations + outcome). No LLM is
// invoked — this is a pure devloop dry-run for testing 'until'
// expressions.
//
// Signals are supplied via repeatable -s key=value flags. The
// closed UntilSignals vocabulary applies (critique.score /
// iterations / user.confirmed / preview.ok / build.passing /
// tests.passing); unknown keys surface as warnings.
async function runPluginSimulate(rest) {
  const flags = parseFlags(rest, {
    string:  new Set([...PLUGIN_STRING_FLAGS, 's', 'cap']),
    boolean: PLUGIN_BOOLEAN_FLAGS,
  });
  const positional = rest.filter((a) => !a.startsWith('-'));
  const id = positional[0];
  if (flags.help || flags.h || !id) {
    console.log(`Usage:
  readable plugin simulate <pluginId> [-s key=value ...] [--cap <n>] [--json]

Walks the plugin's pipeline against caller-supplied signals and
reports per-stage convergence. No LLM is invoked.

Examples:
  # critique-theater stage that exits when score >= 4
  readable plugin simulate my-plugin -s critique.score=5

  # build-test devloop where both signals must hold
  readable plugin simulate code-migration \\
      -s build.passing=true -s tests.passing=true

  # raise the per-stage iteration cap (default 10)
  readable plugin simulate my-plugin -s critique.score=2 --cap 20

Closed signal vocabulary:
  critique.score (number)
  iterations     (number)
  user.confirmed (boolean)
  preview.ok     (boolean)
  build.passing  (boolean)
  tests.passing  (boolean)`);
    process.exit(id ? 0 : 2);
  }
  // Collect every -s value (parseFlags returns the last only).
  const sValues = [];
  for (let i = 0; i < rest.length; i++) {
    if ((rest[i] === '-s' || rest[i] === '--signal') && typeof rest[i + 1] === 'string') {
      sValues.push(rest[i + 1]);
    }
  }
  // Fetch the plugin from the daemon so we get the resolved
  // manifest (including pipeline).
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  const resp = await fetch(`${base}/api/plugins/${encodeURIComponent(id)}`);
  if (resp.status === 404) {
    console.error(`plugin ${id} not found`);
    process.exit(65);
  }
  if (!resp.ok) {
    console.error(`GET /api/plugins/${id} failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const plugin = await resp.json();
  const pipeline = plugin?.manifest?.readable?.pipeline;
  if (!pipeline || !Array.isArray(pipeline.stages) || pipeline.stages.length === 0) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({ outcome: 'no-pipeline', stages: [] }, null, 2) + '\n');
    } else {
      console.log(`[simulate] plugin ${id} has no readable.pipeline (or it is empty); nothing to walk.`);
    }
    return;
  }
  const { simulatePipeline, parseSignalKv } = await import('./plugins/simulate.js');
  const parsedSignals = parseSignalKv(sValues);
  for (const w of parsedSignals.warnings) console.warn(`[simulate] warn: ${w}`);
  const cap = typeof flags.cap === 'string' ? Number(flags.cap) : undefined;
  const result = simulatePipeline({
    pipeline,
    signals: parsedSignals.signals,
    ...(Number.isFinite(cap) && cap > 0 ? { iterationCap: cap } : {}),
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  console.log(`[simulate] plugin ${id} \u2014 outcome: ${result.outcome}, totalIterations: ${result.totalIterations}`);
  for (const stage of result.stages) {
    const tag = stage.outcome === 'converged' ? '\u2713'
              : stage.outcome === 'cap'         ? '\u2717'
              : stage.outcome === 'unparsable'  ? '!'
              :                                   '\u2014';
    const reason = stage.reason ? `  (${stage.reason})` : '';
    const matched = stage.matched && stage.matched.length > 0
      ? `  matched=[${stage.matched.map((c) => `${c.signal}${c.op}${c.value}`).join(' && ')}]`
      : '';
    console.log(`  ${tag} ${stage.stageId}: ${stage.outcome} (${stage.iterations} iter)${reason}${matched}`);
  }
  // Exit non-zero on cap-hit / unparsable so CI can wire this
  // into a pipeline check easily.
  if (result.outcome === 'cap-hit' || result.outcome === 'unparsable') process.exit(4);
}

// Plan §3.CC1 / §3.DD2 — `readable plugin canon <snapshotId>`. Prints the
// canonical `## Active plugin` block a snapshot will splice into
// the system prompt. Useful for understanding what the agent
// reads + locking byte-equality regression tests against the
// daemon's renderPluginBlock() output.
//
// --check <file> mode: compares the canon output against an
// on-disk fixture (typically committed under tests/fixtures/) and
// exits 4 on byte-mismatch. Lets a plugin author lock byte-
// equality without writing a new test harness.
async function runPluginCanon(rest) {
  const flags = parseFlags(rest, {
    string:  new Set([...PLUGIN_STRING_FLAGS, 'check']),
    boolean: PLUGIN_BOOLEAN_FLAGS,
  });
  const positional = rest.filter((a) => !a.startsWith('-'));
  const id = positional[0];
  if (flags.help || flags.h || !id) {
    console.log(`Usage:
  readable plugin canon <snapshotId> [--json]
  readable plugin canon <snapshotId> --check <expected-file>

Prints the canonical '## Active plugin' / '## Plugin inputs' /
'## Plugin atoms' block this snapshot would splice into the
system prompt. Default output is plain text; --json wraps the
block in { snapshotId, pluginId, block }.

--check <file> compares the canon output to the file's bytes and
exits 4 on mismatch. Useful for committing renderPluginBlock()
fixtures into a plugin's own tests/.`);
    process.exit(id ? 0 : 2);
  }
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  const url = `${base}/api/applied-plugins/${encodeURIComponent(id)}/canon`;
  const checkPath = typeof flags.check === 'string' ? flags.check : null;
  // --check always wants the raw text output; force text/plain.
  const wantsText = !flags.json || checkPath !== null;
  const headers = { accept: wantsText ? 'text/plain' : 'application/json' };
  const resp = await fetch(url, { headers });
  if (resp.status === 404) {
    console.error(`snapshot ${id} not found`);
    process.exit(72);
  }
  if (!resp.ok) {
    console.error(`GET ${url} failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  if (checkPath) {
    const fs = await import('node:fs/promises');
    let expected;
    try {
      expected = await fs.readFile(checkPath, 'utf8');
    } catch (err) {
      console.error(`[canon --check] cannot read ${checkPath}: ${err?.message ?? err}`);
      process.exit(2);
    }
    const actual = await resp.text();
    if (actual === expected) {
      console.log(`[canon] \u2713 byte-equal to ${checkPath}`);
      return;
    }
    // Surface a small unified-diff preview so the author sees what
    // drifted. Full diff is left to the user's preferred tool.
    console.error(`[canon --check] \u2717 mismatch with ${checkPath}`);
    console.error(`  expected length: ${expected.length} bytes`);
    console.error(`  actual length:   ${actual.length} bytes`);
    const expectedLines = expected.split('\n');
    const actualLines   = actual.split('\n');
    const limit = Math.min(Math.max(expectedLines.length, actualLines.length), 40);
    for (let i = 0; i < limit; i++) {
      if (expectedLines[i] !== actualLines[i]) {
        console.error(`  line ${i + 1}:`);
        if (expectedLines[i] !== undefined) console.error(`    - ${expectedLines[i]}`);
        if (actualLines[i]   !== undefined) console.error(`    + ${actualLines[i]}`);
      }
    }
    process.exit(4);
  }
  if (flags.json) {
    const data = await resp.json();
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  const body = await resp.text();
  process.stdout.write(body);
  if (!body.endsWith('\n')) process.stdout.write('\n');
}

// Plan §3.AA1 — `readable plugin diff <a> <b>`. Compares two installed
// plugins (by id) and prints a structured report. Useful for
// debugging replay invariance + reviewing version bumps.
async function runPluginDiff(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (flags.help || flags.h || positional.length < 2) {
    console.log(`Usage:
  readable plugin diff <id-a> <id-b> [--json]

Compares two installed plugins (or two installs of the same id at
different versions) and prints every changed field. Output groups
into 'added' / 'removed' / 'changed' with one line per field.`);
    process.exit(positional.length < 2 ? 2 : 0);
  }
  const [idA, idB] = positional;
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  const [respA, respB] = await Promise.all([
    fetch(`${base}/api/plugins/${encodeURIComponent(idA)}`),
    fetch(`${base}/api/plugins/${encodeURIComponent(idB)}`),
  ]);
  if (!respA.ok) {
    console.error(`GET /api/plugins/${idA} failed: ${respA.status}`);
    process.exit(1);
  }
  if (!respB.ok) {
    console.error(`GET /api/plugins/${idB} failed: ${respB.status}`);
    process.exit(1);
  }
  const a = await respA.json();
  const b = await respB.json();
  const { diffPlugins } = await import('./plugins/diff.js');
  const report = diffPlugins({ a, b });
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  if (report.entries.length === 0) {
    console.log(`[diff] ${idA} and ${idB} are equivalent on every recorded field.`);
    return;
  }
  console.log(`[diff] ${idA} \u2194 ${idB} — ${report.added} added, ${report.removed} removed, ${report.changed} changed`);
  for (const e of report.entries) {
    const tag = e.kind === 'added'   ? '+'
              : e.kind === 'removed' ? '-'
              : '~';
    if (e.summary) {
      console.log(`  ${tag} ${e.field}  (${e.summary})`);
    } else if (e.kind === 'changed') {
      console.log(`  ${tag} ${e.field}: ${e.before ?? ''} \u2192 ${e.after ?? ''}`);
    } else if (e.kind === 'added') {
      console.log(`  ${tag} ${e.field}: ${e.after ?? ''}`);
    } else {
      console.log(`  ${tag} ${e.field}: ${e.before ?? ''}`);
    }
  }
}

async function runPluginUpgrade(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const id = rest.find((a) => !a.startsWith('-') && a !== flags['daemon-url'] && a !== flags.source);
  if (!id) {
    console.error('Usage: readable plugin upgrade <id> [--policy latest|pinned] [--json]');
    process.exit(2);
  }
  const url = `${(await pluginDaemonUrl(flags)).replace(/\/$/, '')}/api/plugins/${encodeURIComponent(id)}/upgrade`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      policy: flags.policy === 'pinned' ? 'pinned' : 'latest',
    }),
  });
  if (!resp.ok || !resp.body) {
    let msg = '';
    try { msg = await resp.text(); } catch { msg = ''; }
    console.error(`POST /api/plugins/${id}/upgrade failed: ${resp.status} ${msg}`);
    process.exit(1);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let exitCode = 0;
  const events = [];
  let finalEvent = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine  = lines.find((l) => l.startsWith('data: '));
      const event = eventLine ? eventLine.slice('event: '.length) : 'message';
      const data = dataLine ? safeParseJson(dataLine.slice('data: '.length)) : null;
      events.push({ event, data });
      if (event === 'progress') {
        if (!flags.json) console.log(`[upgrade] ${data?.phase ?? '...'}: ${data?.message ?? ''}`);
      } else if (event === 'success') {
        finalEvent = data;
        if (!flags.json) console.log(`[upgrade] ok — ${data?.plugin?.id}@${data?.plugin?.version} (trust=${data?.plugin?.trust})`);
        if (!flags.json && Array.isArray(data?.warnings) && data.warnings.length > 0) {
          for (const w of data.warnings) console.log(`[upgrade] warn: ${w}`);
        }
      } else if (event === 'error') {
        finalEvent = data;
        if (!flags.json) console.error(`[upgrade] error: ${data?.message ?? 'unknown'}`);
        exitCode = 1;
      }
    }
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      ok: exitCode === 0,
      policy: flags.policy === 'pinned' ? 'pinned' : 'latest',
      result: finalEvent,
      events,
    }, null, 2) + '\n');
  }
  process.exit(exitCode);
}

async function runPluginUninstall(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const id = rest.find((a) => !a.startsWith('-') && a !== flags['daemon-url'] && a !== flags.source);
  if (!id) {
    console.error('Usage: readable plugin uninstall <id>');
    process.exit(2);
  }
  const url = `${(await pluginDaemonUrl(flags)).replace(/\/$/, '')}/api/plugins/${encodeURIComponent(id)}/uninstall`;
  const resp = await fetch(url, { method: 'POST' });
  if (!resp.ok) {
    console.error(`POST /api/plugins/${id}/uninstall failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  console.log(`[uninstall] ${data?.removedFolder ? 'ok' : 'no-op'}${data?.warning ? ` (warning: ${data.warning})` : ''}`);
}

async function runPluginApply(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const id = rest.find((a) => !a.startsWith('-')
    && a !== flags['daemon-url']
    && a !== flags.source
    && a !== flags.inputs
    && a !== flags.project
    && a !== flags['grant-caps']);
  if (!id) {
    console.error('Usage: readable plugin apply <id> [--inputs <json>] [--input k=v ...] [--project <id>] [--grant-caps a,b]');
    process.exit(2);
  }
  // Plan §3.B2: support both --inputs <json> and repeated --input k=v
  // forms so a code agent can build the inputs map without a JSON
  // shell-escape dance.
  let inputs = {};
  if (typeof flags.inputs === 'string' && flags.inputs.trim().length > 0) {
    try { inputs = JSON.parse(flags.inputs); } catch (err) {
      console.error(`--inputs must be valid JSON: ${err.message}`);
      process.exit(2);
    }
  }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--input' && typeof rest[i + 1] === 'string') {
      const kv = rest[i + 1];
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const k = kv.slice(0, eq);
        const v = kv.slice(eq + 1);
        inputs[k] = coerceCliValue(v);
      }
      i += 1;
    }
  }
  const grantCaps = typeof flags['grant-caps'] === 'string' && flags['grant-caps'].length > 0
    ? flags['grant-caps'].split(',').map((c) => c.trim()).filter(Boolean)
    : [];
  const url = `${(await pluginDaemonUrl(flags)).replace(/\/$/, '')}/api/plugins/${encodeURIComponent(id)}/apply`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs, projectId: flags.project, grantCaps }),
    });
  } catch (err) {
    return exitWithStructuredError({
      code: 'daemon-not-running',
      message: `Cannot reach daemon at ${await pluginDaemonUrl(flags)}: ${err?.message ?? err}`,
    });
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 422 && Array.isArray(data?.fields)) {
      return exitWithStructuredError({
        code: 'missing-input',
        message: `Plugin "${id}" is missing required inputs: ${data.fields.join(', ')}`,
        data: { pluginId: id, missing: data.fields },
      });
    }
    return structuredHttpFailure(resp);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  const snap = data?.appliedPlugin;
  if (snap) {
    console.log(`[apply] ${snap.pluginId}@${snap.pluginVersion} digest=${snap.manifestSourceDigest.slice(0, 12)}…`);
    console.log(`[apply] context: ${(data.contextItems ?? []).map((c) => `${c.kind}:${c.id ?? c.name ?? c.path}`).join(', ')}`);
    if (Array.isArray(data.warnings) && data.warnings.length > 0) {
      for (const w of data.warnings) console.log(`[apply] warn: ${w}`);
    }
  } else {
    console.log(JSON.stringify(data));
  }
}

function coerceCliValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

// Phase 4 / spec §14.1 — `readable plugin publish --to <catalog>`.
//
// Reads the installed plugin's manifest metadata (or the snapshot's
// frozen view via --snapshot-id) and prints the catalog submission URL
// + PR body. With `--open` the CLI auto-launches the system browser
// against the URL so the author lands on the catalog's submission form
// in one step. We never POST anywhere — the upstream review flow is
// always under the author's control.
async function runPluginPublish(rest) {
  const flags = parseFlags(rest, {
    string: new Set(['daemon-url', 'to', 'snapshot-id', 'repo', 'catalog']),
    boolean: new Set(['help', 'h', 'json', 'open']),
  });
  if (rest.length === 0 || flags.help || flags.h) {
    console.log(`Usage:
  readable plugin publish <pluginId> --to readable-studio|anthropics-skills|awesome-agent-skills|clawhub|skills-sh
                    [--repo <github-url>] [--snapshot-id <id>] [--open] [--json]
  readable plugin publish <pluginId> --to marketplace-json --catalog ./readable-studio-marketplace.json --repo <github-url>

The CLI prints the catalog's submission URL + a pre-filled PR body.
Pass --open to auto-launch the system browser. Use --snapshot-id to
publish from a frozen run snapshot rather than the live installed copy.`);
    process.exit(rest.length === 0 ? 2 : 0);
  }
  const id = rest.find((a) => !a.startsWith('-')
    && a !== flags.to
    && a !== flags.repo
    && a !== flags['snapshot-id']);
  const target = String(flags.to ?? '');
  if (!id) {
    console.error('Usage: readable plugin publish <pluginId> --to <catalog>');
    process.exit(2);
  }
  if (!target) {
    console.error('--to <catalog> is required (one of: readable-studio, anthropics-skills, awesome-agent-skills, clawhub, skills-sh)');
    process.exit(2);
  }
  const base = (await pluginDaemonUrl(flags)).replace(/\/$/, '');
  // Pull the plugin metadata from the daemon. We do this through the
  // existing /api/plugins/:id endpoint so the CLI never needs a direct
  // SQLite handle; everything stays loopback-mediated.
  let meta = { pluginId: id, pluginVersion: '0.0.0' };
  try {
    const resp = await fetch(`${base}/api/plugins/${encodeURIComponent(id)}`);
    if (resp.ok) {
      const row = await resp.json();
      // The daemon's plugin row carries a stored `version` plus the full
      // manifest. For project-local plugins (`generated-plugin/`, snapshots,
      // freshly imported folders) the stored `version` is `'0.0.0'` until
      // the registry handshake runs, but the manifest's `version` is the
      // real value the author wrote. Mirror `plugins/marketplaces.ts:298,328`
      // and prefer the manifest version when the stored row reads as the
      // pre-handshake sentinel. Closes #1765.
      const storedVersion = typeof row.version === 'string' && row.version.length > 0
        ? row.version
        : null;
      const manifestVersion = typeof row.manifest?.version === 'string' && row.manifest.version.length > 0
        ? row.manifest.version
        : null;
      const resolvedVersion = (storedVersion && storedVersion !== '0.0.0')
        ? storedVersion
        : (manifestVersion ?? storedVersion ?? '0.0.0');
      meta = {
        pluginId:          row.id ?? id,
        pluginVersion:     resolvedVersion,
        ...(row.title              ? { pluginTitle: row.title }                       : {}),
        ...(row.manifest?.description ? { pluginDescription: row.manifest.description } : {}),
      };
    }
  } catch {
    // Best-effort; if the daemon isn't reachable we still try to build
    // a link from the user's flags so the author doesn't need a daemon
    // to publish.
  }
  if (typeof flags.repo === 'string' && flags.repo.length > 0) {
    meta.repoUrl = flags.repo;
  }
  if (target === 'marketplace-json') {
    if (typeof flags.catalog !== 'string' || flags.catalog.length === 0) {
      console.error('--catalog <path> is required for --to marketplace-json');
      process.exit(2);
    }
    if (!meta.repoUrl) {
      console.error('--repo <github-url> is required for --to marketplace-json so the source can be reproduced');
      process.exit(2);
    }
    const outcome = await publishToMarketplaceJson({
      catalogPath: flags.catalog,
      meta,
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');
    } else {
      console.log(`[publish] updated ${outcome.catalogPath}`);
      console.log(`[publish] ${outcome.entry.name}@${outcome.entry.version} -> ${outcome.entry.source}`);
    }
    return;
  }
  const { buildPublishLink, PublishError } = await import('./plugins/publish.js');
  let link;
  try {
    link = buildPublishLink({ catalog: target, meta });
  } catch (err) {
    if (err instanceof PublishError) {
      console.error(`[publish] ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(link, null, 2) + '\n');
  } else {
    console.log(`[publish] ${link.catalogLabel}`);
    console.log(link.url);
    console.log('---');
    console.log(link.prBody);
  }
  if (flags.open) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    const { spawn } = await import('node:child_process');
    spawn(opener, [link.url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function runPluginPublishRepo(rest) {
  const flags = parseFlags(rest, {
    string: new Set(['host', 'owner']),
    boolean: new Set(['help', 'h', 'json', 'dry-run']),
  });
  if (rest.length === 0 || flags.help || flags.h) {
    console.log(`Usage:
  readable plugin publish-repo <folder> [--host github.com] [--owner github-login-or-org] [--dry-run] [--json]

Creates or updates the public GitHub repository named by the plugin manifest.
If plugin.repo is missing or uses a placeholder owner, the CLI resolves the
target from --owner, a trusted manifest owner, local gh auth status, then the
GitHub API as a last resort. It never publishes to placeholder owners.`);
    process.exit(rest.length === 0 ? 2 : 0);
  }
  const folder = rest.find((a) => !a.startsWith('-') && a !== flags.host && a !== flags.owner);
  if (!folder) {
    console.error('Usage: readable plugin publish-repo <folder>');
    process.exit(2);
  }

  const [{ resolve, join }, { readFile, writeFile, stat, mkdtemp, readdir, rm, mkdir, cp }, { pathToFileURL }, os] = await Promise.all([
    import('node:path'),
    import('node:fs/promises'),
    import('node:url'),
    import('node:os'),
  ]);
  const absFolder = resolve(process.cwd(), folder);
  const manifestPath = resolve(absFolder, 'readable-studio.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const host = typeof flags.host === 'string' ? flags.host : 'github.com';
  const target = await resolvePluginGithubTarget({ host, owner: flags.owner, manifest, purpose: 'publish-repo' });
  const normalized = normalizeManifestRepoForOwner(manifest, target.owner);
  if (normalized.changed && !flags['dry-run']) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await pluginCliValidateFolder(absFolder);
  }

  const repo = parseGithubRepoUrl(normalized.repoUrl);
  if (!repo) {
    console.error(`[publish-repo] invalid plugin.repo after normalization: ${normalized.repoUrl}`);
    process.exit(2);
  }
  const steps = [];
  const run = async (label, command, args, opts = {}) => {
    steps.push({ label, command: [command, ...args].join(' ') });
    if (flags['dry-run']) return { ok: true, stdout: '', stderr: '' };
    const result = await (command === 'gh'
      ? execGhBuffered(args, { cwd: opts.cwd ?? absFolder, timeout: opts.timeout ?? 120_000 })
      : execFileBuffered(command, args, { cwd: opts.cwd ?? absFolder, timeout: opts.timeout ?? 120_000 }));
    steps[steps.length - 1].ok = result.ok;
    steps[steps.length - 1].stdout = result.stdout;
    steps[steps.length - 1].stderr = result.stderr;
    if (!result.ok) {
      emitPluginWorkflowResult(flags, {
        ok: false,
        action: 'publish-repo',
        folder: absFolder,
        repoUrl: normalized.repoUrl,
        login: target.login,
        owner: target.owner,
        ownerSource: target.ownerSource,
        apiRateLimited: target.apiRateLimited,
        steps,
        error: { label, stdout: result.stdout, stderr: result.stderr, code: result.code },
      });
      process.exit(1);
    }
    return result;
  };

  let exists = false;
  const view = flags['dry-run']
    ? { ok: false, stderr: 'dry-run' }
    : await execGhBuffered(['repo', 'view', repo.fullName], { cwd: absFolder, timeout: 30_000 });
  steps.push({ label: 'check repo', command: `gh repo view ${repo.fullName}`, ok: view.ok, stdout: view.stdout, stderr: view.stderr });
  if (view.ok) {
    exists = true;
  } else if (!flags['dry-run'] && !isRepoNotFound(view)) {
    emitPluginWorkflowResult(flags, {
      ok: false,
      action: 'publish-repo',
      folder: absFolder,
      repoUrl: normalized.repoUrl,
      login: target.login,
      owner: target.owner,
      ownerSource: target.ownerSource,
      apiRateLimited: target.apiRateLimited,
      steps,
      error: { label: 'check repo', stdout: view.stdout, stderr: view.stderr, code: view.code },
    });
    process.exit(1);
  }

  let workdir = absFolder;
  let cleanupDir = null;
  if (exists && !flags['dry-run']) {
    cleanupDir = await mkdtemp(join(os.tmpdir(), 'readable-plugin-publish-sync-'));
    workdir = join(cleanupDir, repo.name);
    await run('clone repo', 'gh', ['repo', 'clone', repo.fullName, workdir], { cwd: cleanupDir, timeout: 240_000 });
    for (const entry of await readdir(workdir)) {
      if (entry === '.git') continue;
      await rm(join(workdir, entry), { recursive: true, force: true });
    }
    await mkdir(workdir, { recursive: true });
    for (const entry of await readdir(absFolder)) {
      if (entry === '.git') continue;
      await cp(join(absFolder, entry), join(workdir, entry), { recursive: true, force: true });
    }
  } else if (!flags['dry-run']) {
    let hasGit = false;
    try { await stat(resolve(absFolder, '.git')); hasGit = true; } catch {}
    if (!hasGit) await run('git init', 'git', ['init']);
  }

  await run('git add', 'git', ['add', '-A'], { cwd: workdir });
  const status = flags['dry-run']
    ? { stdout: 'dry-run' }
    : await execFileBuffered('git', ['status', '--porcelain'], { cwd: workdir });
  if (status.stdout.trim().length > 0 || !exists) {
    const commitMessage = exists
      ? `Update: ${manifest.name} v${manifest.version ?? '0.0.0'}`
      : `Initial commit: ${manifest.name} v${manifest.version ?? '0.0.0'}`;
    await run('git commit', 'git', ['commit', '-m', commitMessage], { cwd: workdir });
  }
  const tag = `v${manifest.version ?? '0.0.0'}`;
  if (!flags['dry-run']) {
    const localTag = await execFileBuffered('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: workdir });
    if (!localTag.ok) await run('git tag', 'git', ['tag', tag], { cwd: workdir });
  }

  if (exists) {
    await run('git push', 'git', ['push', 'origin', 'HEAD'], { cwd: workdir });
  } else {
    await run('gh repo create', 'gh', [
      'repo', 'create', repo.fullName, '--public', '--source', '.', '--push',
      '--description', String(manifest.description ?? ''),
    ], { cwd: workdir });
  }
  await run('git push tags', 'git', ['push', '--tags'], { cwd: workdir });
  const verify = flags['dry-run']
    ? { ok: true, stdout: JSON.stringify({ nameWithOwner: repo.fullName, url: normalized.repoUrl }) }
    : await run('verify repo', 'gh', ['repo', 'view', repo.fullName, '--json', 'url,nameWithOwner'], { cwd: workdir });
  const parsedVerify = safeJson(verify.stdout);
  if (cleanupDir && !flags['dry-run']) {
    await rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined);
  }
  emitPluginWorkflowResult(flags, {
    ok: true,
    action: 'publish-repo',
    folder: absFolder,
    login: target.login,
    owner: target.owner,
    ownerSource: target.ownerSource,
    apiRateLimited: target.apiRateLimited,
    repoUrl: parsedVerify?.url ?? normalized.repoUrl,
    manifestRewritten: normalized.changed,
    manifestPath: pathToFileURL(manifestPath).pathname,
    steps,
  });
}

async function runPluginReadableStudioPr(rest) {
  const flags = parseFlags(rest, {
    string: new Set(['host', 'owner']),
    boolean: new Set(['help', 'h', 'json', 'dry-run']),
  });
  if (rest.length === 0 || flags.help || flags.h) {
    console.log(`Usage:
  readable plugin readable-studio-pr <folder> [--host github.com] [--owner github-login-or-fork-owner] [--dry-run] [--json]

Copies a local plugin folder into plugins/community/<name>/ on the author's
fork of sanghyunna/readable-studio, pushes a branch, and opens the PR form with --web.`);
    process.exit(rest.length === 0 ? 2 : 0);
  }
  const folder = rest.find((a) => !a.startsWith('-') && a !== flags.host && a !== flags.owner);
  if (!folder) {
    console.error('Usage: readable plugin readable-studio-pr <folder>');
    process.exit(2);
  }
  const [{ resolve, join }, fsp, os] = await Promise.all([
    import('node:path'),
    import('node:fs/promises'),
    import('node:os'),
  ]);
  const absFolder = resolve(process.cwd(), folder);
  const manifestPath = resolve(absFolder, 'readable-studio.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const host = typeof flags.host === 'string' ? flags.host : 'github.com';
  const target = await resolvePluginGithubTarget({ host, owner: flags.owner, manifest, purpose: 'readable-studio-pr' });
  const name = String(manifest.name ?? '').trim();
  if (!name) {
    console.error('[readable-studio-pr] manifest.name is required');
    process.exit(2);
  }
  const title = String(manifest.title ?? name).trim();
  const branch = `plugin/${name}-${Math.floor(Date.now() / 1000)}`;
  const tmpRoot = await fsp.mkdtemp(join(os.tmpdir(), 'readable-readable-studio-pr-'));
  const checkout = join(tmpRoot, 'readable-studio');
  const steps = [];
  const run = async (label, command, args, opts = {}) => {
    steps.push({ label, command: [command, ...args].join(' ') });
    if (flags['dry-run']) return { ok: true, stdout: '', stderr: '' };
    const result = await (command === 'gh'
      ? execGhBuffered(args, { cwd: opts.cwd ?? process.cwd(), timeout: opts.timeout ?? 180_000 })
      : execFileBuffered(command, args, { cwd: opts.cwd ?? process.cwd(), timeout: opts.timeout ?? 180_000 }));
    steps[steps.length - 1].ok = result.ok;
    steps[steps.length - 1].stdout = result.stdout;
    steps[steps.length - 1].stderr = result.stderr;
    if (!result.ok && !opts.tolerate?.(result)) {
      emitPluginWorkflowResult(flags, {
        ok: false,
        action: 'readable-studio-pr',
        folder: absFolder,
        login: target.login,
        owner: target.owner,
        ownerSource: target.ownerSource,
        apiRateLimited: target.apiRateLimited,
        branch,
        steps,
        error: { label, stdout: result.stdout, stderr: result.stderr, code: result.code },
      });
      process.exit(1);
    }
    return result;
  };

  await run('fork', 'gh', ['repo', 'fork', 'sanghyunna/readable-studio'], {
    tolerate: (r) => /already exists|existing fork/i.test(`${r.stdout}\n${r.stderr}`),
  });
  await run('clone fork', 'git', [
    'clone',
    '--depth', '1',
    '--single-branch',
    '--branch', 'main',
    '--filter=blob:none',
    '--sparse',
    `https://github.com/${target.owner}/readable-studio.git`,
    checkout,
  ], { timeout: 240_000 });
  await run('sparse checkout', 'git', ['sparse-checkout', 'set', 'plugins/community'], { cwd: checkout });
  await run('checkout branch', 'git', ['checkout', '-b', branch], { cwd: checkout });
  const dest = join(checkout, 'plugins', 'community', name);
  if (!flags['dry-run']) {
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(dest, { recursive: true });
    await fsp.cp(absFolder, dest, { recursive: true, force: true, filter: (src) => !src.includes(`${absFolder}/.git`) });
  }
  await run('git add', 'git', ['add', `plugins/community/${name}`], { cwd: checkout });
  await run('git commit', 'git', ['commit', '-m', `Add ${title} plugin`], { cwd: checkout });
  await run('git push branch', 'git', ['push', '-u', 'origin', branch], { cwd: checkout });
  const body = [
    `Add ${title} (${name}) plugin.`,
    '',
    `Version: ${manifest.version ?? '0.0.0'}`,
    manifest.description ? `Description: ${manifest.description}` : '',
  ].filter(Boolean).join('\n');
  const pr = await run('open PR form', 'gh', [
    'pr', 'create',
    '--repo', 'sanghyunna/readable-studio',
    '--head', `${target.owner}:${branch}`,
    '--base', 'main',
    '--title', `Add ${title} plugin`,
    '--body', body,
    '--web',
  ], { cwd: checkout });
  const prUrl = extractFirstUrl(pr.stdout || pr.stderr) ?? `https://github.com/${target.owner}/readable-studio/pull/new/${branch}`;
  emitPluginWorkflowResult(flags, {
    ok: true,
    action: 'readable-studio-pr',
    folder: absFolder,
    login: target.login,
    owner: target.owner,
    ownerSource: target.ownerSource,
    apiRateLimited: target.apiRateLimited,
    branch,
    prUrl,
    checkout,
    steps,
  });
}

async function publishToMarketplaceJson({ catalogPath, meta }) {
  const [{ dirname, resolve }, { mkdir, readFile, writeFile }, { PublishError, upsertMarketplaceJsonEntry }] = await Promise.all([
    import('node:path'),
    import('node:fs/promises'),
    import('./plugins/publish.js'),
  ]);
  const resolvedPath = resolve(process.cwd(), catalogPath);
  let existing = null;
  try {
    existing = JSON.parse(await readFile(resolvedPath, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }
  let outcome;
  try {
    outcome = upsertMarketplaceJsonEntry({ manifest: existing, meta });
  } catch (err) {
    if (err instanceof PublishError) {
      console.error(`[publish] ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(outcome.manifest, null, 2)}\n`, 'utf8');
  return {
    catalogPath: resolvedPath,
    inserted: outcome.inserted,
    entry: outcome.entry,
    manifest: {
      name: outcome.manifest.name,
      version: outcome.manifest.version,
      plugins: outcome.manifest.plugins.length,
    },
  };
}

async function resolvePluginGithubTarget({ host = 'github.com', owner, manifest, purpose }) {
  const version = await execGhBuffered(['--version'], { timeout: 10_000 });
  if (!version.ok) {
    console.error('[plugin github] GitHub CLI is required. Install gh from https://cli.github.com/ and retry.');
    process.exit(1);
  }
  let status = await execGhBuffered(['auth', 'status', '--hostname', host, '--active'], { timeout: 10_000 });
  if (!status.ok && /unknown flag: --active/i.test(`${status.stdout}\n${status.stderr}`)) {
    status = await execGhBuffered(['auth', 'status', '--hostname', host], { timeout: 10_000 });
  }
  if (!status.ok) {
    console.error(`[plugin github] gh is not authenticated for ${host}.`);
    if (status.stderr || status.stdout) console.error(status.stderr || status.stdout);
    console.error('Run: gh auth login -h github.com -s repo,workflow');
    process.exit(1);
  }
  const manifestRepo = parseGithubRepoUrl(typeof manifest?.plugin?.repo === 'string' ? manifest.plugin.repo.trim() : '');
  const trustedManifestOwner = purpose === 'publish-repo' && manifestRepo && !isPlaceholderRepoOwner(manifestRepo.owner) ? manifestRepo.owner : '';
  const explicitOwner = typeof owner === 'string' ? owner.trim() : '';
  if (explicitOwner && isPlaceholderRepoOwner(explicitOwner)) {
    console.error(`[plugin github] refusing placeholder owner "${explicitOwner}". Pass a real GitHub login or org.`);
    process.exit(2);
  }
  const statusLogin = parseGhAuthStatusLogin(status.stderr || status.stdout);
  let login = statusLogin;
  let resolvedOwner = explicitOwner || trustedManifestOwner || statusLogin;
  let source = explicitOwner ? '--owner' : trustedManifestOwner ? 'plugin.repo' : statusLogin ? 'gh auth status' : '';
  let apiError = null;
  if (!resolvedOwner || !login) {
    const user = await execGhBuffered(['api', 'user', '--hostname', host, '--jq', '.login'], { timeout: 20_000 });
    if (user.ok && user.stdout.trim()) {
      login = user.stdout.trim();
      if (!resolvedOwner) {
        resolvedOwner = login;
        source = 'gh api user';
      }
    } else {
      apiError = user;
    }
  }
  if (!resolvedOwner) {
    console.error(`[plugin github] could not resolve the GitHub owner for ${purpose}.`);
    if (apiError?.stderr || apiError?.stdout) console.error(apiError.stderr || apiError.stdout);
    if (apiError && isGhApiRateLimit(apiError)) {
      const ownerHint = purpose === 'readable-studio-pr' ? '<github-login-or-fork-owner>' : '<github-login-or-org>';
      console.error(`GitHub API is rate limited. Re-run with --owner ${ownerHint}, or authenticate/refresh gh and retry.`);
    } else {
      console.error('Run: gh auth refresh -h github.com -s repo,workflow');
      console.error('Or:  gh auth login -h github.com -s repo,workflow');
      console.error(purpose === 'readable-studio-pr'
        ? 'If the fork owner differs from your auth login, pass --owner <github-login-or-fork-owner>.'
        : 'If this is an org-owned plugin, pass --owner <github-org>.');
    }
    process.exit(1);
  }
  if (apiError && isGhApiRateLimit(apiError)) {
    console.warn('[plugin github] GitHub API is rate limited; continuing with the owner resolved locally.');
  }
  if (isPlaceholderRepoOwner(resolvedOwner)) {
    console.error(`[plugin github] refusing placeholder owner "${resolvedOwner}". Pass --owner <github-login-or-org>.`);
    process.exit(2);
  }
  return {
    host,
    login: login || resolvedOwner,
    owner: resolvedOwner,
    ownerSource: source,
    apiRateLimited: Boolean(apiError && isGhApiRateLimit(apiError)),
    version: version.stdout,
    status: status.stderr || status.stdout,
  };
}

function parseGhAuthStatusLogin(output) {
  const text = String(output ?? '');
  const activeAccount = /Logged in to [^\s]+ account ([^\s()]+)/i.exec(text);
  if (activeAccount?.[1]) return activeAccount[1].trim();
  const tokenAccount = /Token account:\s*([^\s()]+)/i.exec(text);
  if (tokenAccount?.[1]) return tokenAccount[1].trim();
  return '';
}

function isGhApiRateLimit(result) {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  return /rate limit exceeded|authenticated requests get a higher rate limit/i.test(text);
}

function normalizeManifestRepoForOwner(manifest, owner) {
  const name = String(manifest?.name ?? '').trim();
  if (!name) {
    console.error('[plugin repo] manifest.name is required');
    process.exit(2);
  }
  const rawRepo = typeof manifest?.plugin?.repo === 'string' ? manifest.plugin.repo.trim() : '';
  const parsed = parseGithubRepoUrl(rawRepo);
  const placeholder = parsed ? isPlaceholderRepoOwner(parsed.owner) : false;
  const shouldRewrite = !parsed || placeholder || parsed.name.toLowerCase() !== name.toLowerCase() || parsed.owner.toLowerCase() !== owner.toLowerCase();
  const repoUrl = shouldRewrite ? `https://github.com/${owner}/${name}` : parsed.url;
  if (shouldRewrite) {
    if (!manifest.plugin || typeof manifest.plugin !== 'object') manifest.plugin = {};
    manifest.plugin.repo = repoUrl;
    manifest.homepage = repoUrl;
    if (!manifest.author || typeof manifest.author !== 'object') manifest.author = {};
    manifest.author.url = `https://github.com/${owner}`;
  }
  return {
    changed: shouldRewrite,
    repoUrl,
    previousRepoUrl: rawRepo || null,
  };
}

function parseGithubRepoUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\.git$/i, '');
  let owner = '';
  let name = '';
  try {
    const url = new URL(trimmed);
    if (!/^github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    owner = parts[0] ?? '';
    name = parts[1] ?? '';
  } catch {
    const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
    if (!match) return null;
    owner = match[1];
    name = match[2];
  }
  if (!owner || !name) return null;
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  };
}

function isPlaceholderRepoOwner(owner) {
  return /^(readable-studio-user|<vendor>|vendor|example-user|your-org|your-username|owner|user|username)$/i.test(String(owner ?? '').trim());
}

function isRepoNotFound(result) {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  return /could not resolve to a repository|not found|repository not found/i.test(text);
}

async function pluginCliValidateFolder(folder) {
  const result = await execFileBuffered(process.execPath, [process.argv[1], 'plugin', 'validate', folder], {
    timeout: 120_000,
  });
  if (!result.ok) {
    console.error('[plugin validate] failed after manifest normalization');
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }
  return result;
}

function emitPluginWorkflowResult(flags, payload) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  if (!payload.ok) {
    console.error(`[${payload.action}] failed${payload.error?.label ? ` at ${payload.error.label}` : ''}`);
    if (payload.error?.stderr) console.error(payload.error.stderr);
    if (payload.error?.stdout) console.error(payload.error.stdout);
    return;
  }
  if (payload.action === 'publish-repo') {
    console.log(`Plugin published: ${payload.repoUrl}`);
    if (payload.ownerSource) console.log(`[publish-repo] owner resolved from ${payload.ownerSource}: ${payload.owner}`);
    if (payload.apiRateLimited) console.log('[publish-repo] GitHub API was rate limited; continued with the locally resolved owner.');
    if (payload.manifestRewritten) console.log('[publish-repo] manifest repo fields were normalized before publishing.');
    return;
  }
  if (payload.action === 'readable-studio-pr') {
    if (payload.ownerSource) console.log(`[readable-studio-pr] owner resolved from ${payload.ownerSource}: ${payload.owner}`);
    if (payload.apiRateLimited) console.log('[readable-studio-pr] GitHub API was rate limited; continued with the locally resolved owner.');
    console.log(`Open this URL and click Create to file the PR: ${payload.prUrl}`);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function extractFirstUrl(text) {
  const match = /https?:\/\/\S+/i.exec(String(text ?? ''));
  return match ? match[0].replace(/[)\].,]+$/, '') : null;
}

async function runPluginYank(rest) {
  const flags = parseFlags(rest, {
    string: new Set(['daemon-url', 'reason', 'to']),
    boolean: new Set(['help', 'h', 'json', 'open']),
  });
  if (rest.length === 0 || flags.help || flags.h) {
    console.log(`Usage:
  readable plugin yank <vendor/plugin-name>@<version> --reason "<why>" [--to readable-studio] [--json]

Yanking never deletes metadata or bytes. It opens the registry review flow that
marks a version unresolvable for new installs while preserving lockfile replay.`);
    process.exit(rest.length === 0 ? 2 : 0);
  }
  const spec = rest.find((a) => !a.startsWith('-') && a !== flags.reason && a !== flags.to);
  const reason = typeof flags.reason === 'string' ? flags.reason.trim() : '';
  const parsed = parseCliPluginSpecifier(spec);
  if (!parsed.name || !parsed.range) {
    console.error('Usage: readable plugin yank <vendor/plugin-name>@<version> --reason "<why>"');
    process.exit(2);
  }
  if (!reason) {
    console.error('--reason is required for yanking');
    process.exit(2);
  }
  const target = flags.to ?? 'readable-studio';
  if (target !== 'readable-studio') {
    console.error('Only --to readable-studio is supported in this v1 GitHub-backed yank flow.');
    process.exit(2);
  }
  const title = `Yank ${parsed.name}@${parsed.range}`;
  const body = [
    `## Yank ${parsed.name}@${parsed.range}`,
    '',
    `Reason: ${reason}`,
    '',
    'Expected registry patch:',
    '',
    '```json',
    JSON.stringify({
      name: parsed.name,
      version: parsed.range,
      yanked: true,
      yankReason: reason,
    }, null, 2),
    '```',
    '',
    'Generated by `readable plugin yank`.',
  ].join('\n');
  const params = new URLSearchParams({ title, body });
  const payload = {
    catalog: 'readable-studio',
    name: parsed.name,
    version: parsed.range,
    reason,
    url: `https://github.com/sanghyunna/readable-studio/issues/new?${params.toString()}`,
    body,
  };
  if (flags.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    console.log(`[yank] ${payload.url}`);
    console.log('---');
    console.log(body);
  }
  if (flags.open) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    const { spawn } = await import('node:child_process');
    spawn(opener, [payload.url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function runPluginDoctor(rest) {
  // Plan §3.HH1 — --strict promotes warnings to errors so CI can
  // opt into 'no warnings allowed' mode without parsing the issue
  // list manually.
  const flags = parseFlags(rest, {
    string:  PLUGIN_STRING_FLAGS,
    boolean: new Set([...PLUGIN_BOOLEAN_FLAGS, 'strict']),
  });
  const id = rest.find((a) => !a.startsWith('-') && a !== flags['daemon-url'] && a !== flags.source);
  if (!id) {
    console.error('Usage: readable plugin doctor <id> [--strict] [--json]');
    process.exit(2);
  }
  const url = `${(await pluginDaemonUrl(flags)).replace(/\/$/, '')}/api/plugins/${encodeURIComponent(id)}/doctor`;
  const resp = await fetch(url, { method: 'POST' });
  if (!resp.ok) {
    console.error(`POST /api/plugins/${id}/doctor failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  const warnings = issues.filter((i) => i?.severity === 'warning');
  const strict = flags.strict === true;
  // Strict mode: a clean issue list is still required, but the
  // pass/fail bit also fails on any warning.
  const passed = data.ok && (!strict || warnings.length === 0);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...data, strict, passed }, null, 2) + '\n');
  } else {
    if (passed && issues.length === 0) {
      console.log(`[doctor] ${data.pluginId} ok (digest ${data.freshDigest.slice(0, 12)}…)`);
    } else {
      const tier = !data.ok ? 'errors' : (strict && warnings.length > 0) ? 'warnings (--strict)' : 'warnings';
      console.log(`[doctor] ${data.pluginId} ${tier}:`);
      for (const issue of issues) {
        console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
      }
    }
  }
  process.exit(passed ? 0 : (data.ok ? 4 : 1));
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// `readable plugin replay <runId> --snapshot-id <id>` — re-emit the immutable
// snapshot the original run was launched against, so the caller (or
// another agent) can re-apply the same plugin against fresh state. Phase
// 2A keeps replay headless: the CLI prints the snapshot + rerun bundle;
// the agent restarts the run via `readable plugin apply` followed by a normal
// `readable run start`. Future Phase 2C `readable plugin run` will collapse this
// into a one-shot wrapper.
async function runPluginReplay(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const runId = rest.find((a) => !a.startsWith('-')
    && a !== flags['daemon-url']
    && a !== flags.source
    && a !== flags.inputs
    && a !== flags.project
    && a !== flags['snapshot-id']
    && a !== flags.capabilities);
  if (!runId) {
    console.error('Usage: readable plugin replay <runId> --snapshot-id <id>');
    process.exit(2);
  }
  const snapshotId = flags['snapshot-id'];
  if (!snapshotId) {
    console.error('--snapshot-id is required (runs are in-memory in Phase 2A; pass the snapshot id returned by readable plugin apply)');
    process.exit(2);
  }
  const url = `${(await pluginDaemonUrl(flags)).replace(/\/$/, '')}/api/runs/${encodeURIComponent(runId)}/replay`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshotId }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(`POST /api/runs/${runId}/replay failed: ${resp.status} ${JSON.stringify(data)}`);
    process.exit(1);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  console.log(`[replay] ${data.rerun?.pluginId}@${data.rerun?.pluginVersion} digest=${(data.rerun?.manifestSourceDigest ?? '').slice(0, 12)}…`);
  console.log(`[replay] inputs: ${JSON.stringify(data.rerun?.inputs ?? {})}`);
  console.log('[replay] re-apply via: readable plugin apply ' + data.rerun?.pluginId + ' --inputs ' + JSON.stringify(JSON.stringify(data.rerun?.inputs ?? {})));
}

// `readable plugin trust <id> --capabilities <comma-sep>` — flip a plugin's
// capabilities_granted set. Plan §3.A2 / spec §9.1: the CLI is the
// canonical write surface (invariant I4). The daemon validates the
// capability vocabulary; unknown / malformed entries surface as
// exit-2 usage failures.
async function runPluginTrust(rest) {
  const flags = parseFlags(rest, { string: PLUGIN_STRING_FLAGS, boolean: PLUGIN_BOOLEAN_FLAGS });
  const id = rest.find((a) => !a.startsWith('-')
    && a !== flags['daemon-url']
    && a !== flags.source
    && a !== flags.inputs
    && a !== flags.project
    && a !== flags['snapshot-id']
    && a !== flags.capabilities);
  if (!id) {
    console.error('Usage: readable plugin trust <id> --capabilities fs:write,mcp:name [--revoke]');
    process.exit(2);
  }
  const capsCsv = typeof flags.capabilities === 'string' ? flags.capabilities : '';
  const caps = capsCsv.split(',').map((c) => c.trim()).filter(Boolean);
  if (caps.length === 0) {
    console.error('--capabilities is required (comma-separated, e.g. fs:write,mcp:name)');
    process.exit(2);
  }
  const action = flags.revoke ? 'revoke' : 'grant';
  const url = `${(await pluginDaemonUrl(flags)).replace(/\/$/, '')}/api/plugins/${encodeURIComponent(id)}/trust`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capabilities: caps, action }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 400 && data?.error?.code === 'invalid-capability') {
      const rej = (data.error.data?.rejected ?? [])
        .map((r) => `${r.capability} (${r.reason})`)
        .join(', ');
      console.error(`[trust] invalid capabilities: ${rej}`);
      process.exit(2);
    }
    console.error(`POST ${url} failed: ${resp.status} ${JSON.stringify(data)}`);
    process.exit(1);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  console.log(`[trust] ${action === 'grant' ? 'granted' : 'revoked'} on ${id}: ${caps.join(', ')}`);
  console.log(`[trust] now: ${(data.capabilitiesGranted ?? []).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Subcommand: readable ui …  (spec §10.3.4 headless GenUI surface inbox)
// ---------------------------------------------------------------------------

async function runUi(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printUiHelp();
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list':    return runUiList(rest);
    case 'show':    return runUiShow(rest);
    case 'respond': return runUiRespond(rest);
    case 'revoke':  return runUiRevoke(rest);
    case 'prefill': return runUiPrefill(rest);
    default:
      console.error(`unknown subcommand: readable ui ${sub}`);
      printUiHelp();
      process.exit(2);
  }
}

async function uiDaemonUrl(flags) {
  return cliDaemonUrl(flags);
}

async function runUiList(rest) {
  const flags = parseFlags(rest, { string: UI_STRING_FLAGS, boolean: UI_BOOLEAN_FLAGS });
  const base = (await uiDaemonUrl(flags)).replace(/\/$/, '');
  let url;
  if (flags.run) url = `${base}/api/runs/${encodeURIComponent(flags.run)}/genui`;
  else if (flags.project) url = `${base}/api/projects/${encodeURIComponent(flags.project)}/genui`;
  else {
    console.error('Usage: readable ui list --run <runId> | --project <projectId>');
    process.exit(2);
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`GET ${url} failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  const surfaces = Array.isArray(data?.surfaces) ? data.surfaces : [];
  if (surfaces.length === 0) {
    console.log('No GenUI surfaces.');
    return;
  }
  for (const s of surfaces) {
    console.log(`${s.surfaceId}  kind=${s.kind}  persist=${s.persist}  status=${s.status}  rowId=${s.id}`);
  }
}

async function runUiShow(rest) {
  const flags = parseFlags(rest, { string: UI_STRING_FLAGS, boolean: UI_BOOLEAN_FLAGS });
  const positional = rest.filter((a) => !a.startsWith('-')
    && a !== flags['daemon-url']
    && a !== flags.run
    && a !== flags.project
    && a !== flags.value
    && a !== flags['value-json']
    && a !== flags.plugin
    && a !== flags['snapshot-id']
    && a !== flags.persist
    && a !== flags.kind);
  const runId = flags.run ?? positional[0];
  const surfaceId = flags['snapshot-id'] ? null : positional[flags.run ? 0 : 1];
  if (!runId || !surfaceId) {
    console.error('Usage: readable ui show --run <runId> <surfaceId>');
    process.exit(2);
  }
  const url = `${(await uiDaemonUrl(flags)).replace(/\/$/, '')}/api/runs/${encodeURIComponent(runId)}/genui/${encodeURIComponent(surfaceId)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`GET ${url} failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  // Plan §6 Phase 2A.5 — `--schema` prints the spec's JSON Schema
  // only (null if the surface declares none). Designed to feed
  // `readable ui respond --value-json "$(...)"` in headless / agent flows.
  if (flags.schema) {
    const schema = data?.spec?.schema ?? null;
    process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

async function runUiRespond(rest) {
  const flags = parseFlags(rest, { string: UI_STRING_FLAGS, boolean: UI_BOOLEAN_FLAGS });
  const positional = rest.filter((a) => !a.startsWith('-')
    && a !== flags['daemon-url']
    && a !== flags.run
    && a !== flags.project
    && a !== flags.value
    && a !== flags['value-json']
    && a !== flags.plugin
    && a !== flags['snapshot-id']
    && a !== flags.persist
    && a !== flags.kind);
  const runId = flags.run ?? positional[0];
  const surfaceId = positional[flags.run ? 0 : 1];
  if (!runId || !surfaceId) {
    console.error('Usage: readable ui respond --run <runId> <surfaceId> [--value <text> | --value-json <json> | --skip]');
    process.exit(2);
  }
  let value = null;
  if (flags.skip) {
    // Skip translates to a null answer; daemon resolves the surface in
    // `resolved` state with `respondedBy: 'auto'`. Phase 2A keeps the
    // semantics simple; spec §10.3.4 onTimeout='skip' lands in Phase 4.
    value = null;
  } else if (typeof flags['value-json'] === 'string') {
    try { value = JSON.parse(flags['value-json']); } catch (err) {
      console.error(`--value-json must be valid JSON: ${err.message}`);
      process.exit(2);
    }
  } else if (typeof flags.value === 'string') {
    value = flags.value;
  }
  const url = `${(await uiDaemonUrl(flags)).replace(/\/$/, '')}/api/runs/${encodeURIComponent(runId)}/genui/${encodeURIComponent(surfaceId)}/respond`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value, respondedBy: 'user' }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(`POST ${url} failed: ${resp.status} ${JSON.stringify(data)}`);
    process.exit(1);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    console.log(`[ui] ${surfaceId} resolved (rowId=${data?.surface?.id})`);
  }
}

async function runUiRevoke(rest) {
  const flags = parseFlags(rest, { string: UI_STRING_FLAGS, boolean: UI_BOOLEAN_FLAGS });
  const positional = rest.filter((a) => !a.startsWith('-')
    && a !== flags['daemon-url']
    && a !== flags.run
    && a !== flags.project
    && a !== flags.value
    && a !== flags['value-json']
    && a !== flags.plugin
    && a !== flags['snapshot-id']
    && a !== flags.persist
    && a !== flags.kind);
  const projectId = flags.project ?? positional[0];
  const surfaceId = positional[flags.project ? 0 : 1];
  if (!projectId || !surfaceId) {
    console.error('Usage: readable ui revoke --project <projectId> <surfaceId>');
    process.exit(2);
  }
  const url = `${(await uiDaemonUrl(flags)).replace(/\/$/, '')}/api/projects/${encodeURIComponent(projectId)}/genui/${encodeURIComponent(surfaceId)}/revoke`;
  const resp = await fetch(url, { method: 'POST' });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(`POST ${url} failed: ${resp.status} ${JSON.stringify(data)}`);
    process.exit(1);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    console.log(`[ui] revoked ${data.invalidated} row(s)`);
  }
}

async function runUiPrefill(rest) {
  const flags = parseFlags(rest, { string: UI_STRING_FLAGS, boolean: UI_BOOLEAN_FLAGS });
  const positional = rest.filter((a) => !a.startsWith('-')
    && a !== flags['daemon-url']
    && a !== flags.run
    && a !== flags.project
    && a !== flags.value
    && a !== flags['value-json']
    && a !== flags.plugin
    && a !== flags['snapshot-id']
    && a !== flags.persist
    && a !== flags.kind);
  const projectId = flags.project ?? positional[0];
  const surfaceId = positional[flags.project ? 0 : 1];
  const snapshotId = flags['snapshot-id'];
  if (!projectId || !surfaceId || !snapshotId) {
    console.error('Usage: readable ui prefill --project <projectId> --snapshot-id <id> <surfaceId> [--value <text> | --value-json <json>] [--persist run|conversation|project] [--kind form|choice|confirmation|oauth-prompt]');
    process.exit(2);
  }
  let value = null;
  if (typeof flags['value-json'] === 'string') {
    try { value = JSON.parse(flags['value-json']); } catch (err) {
      console.error(`--value-json must be valid JSON: ${err.message}`);
      process.exit(2);
    }
  } else if (typeof flags.value === 'string') {
    value = flags.value;
  }
  const url = `${(await uiDaemonUrl(flags)).replace(/\/$/, '')}/api/projects/${encodeURIComponent(projectId)}/genui/prefill`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      snapshotId,
      surfaceId,
      kind:    flags.kind ?? 'confirmation',
      persist: flags.persist ?? 'project',
      value,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(`POST ${url} failed: ${resp.status} ${JSON.stringify(data)}`);
    process.exit(1);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    console.log(`[ui] prefilled ${surfaceId} (rowId=${data?.surface?.id})`);
  }
}

function printUiHelp() {
  console.log(`Usage:
  readable ui list  --run <runId>                          List GenUI surfaces for a run.
  readable ui list  --project <projectId>                  List GenUI surfaces for a project.
  readable ui show  --run <runId> <surfaceId> [--schema]   Read a single surface (kind / schema / value). --schema prints just the JSON Schema.
  readable ui respond --run <runId> <surfaceId> [--value <txt> | --value-json <json> | --skip]
                                                     Answer a pending surface from any process.
  readable ui revoke --project <projectId> <surfaceId>     Invalidate a project-tier cached answer.
  readable ui prefill --project <projectId> --snapshot-id <id> <surfaceId>
                [--value <text> | --value-json <json>] [--persist run|conversation|project]
                                                     Pre-answer a surface so the run never broadcasts it.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base (default READABLE_DAEMON_URL, READABLE_SIDECAR_IPC_PATH discovery, or http://127.0.0.1:7456).
  --json               Emit raw JSON (suitable for scripts) instead of human-readable output.`);
}

function printPluginHelp() {
  console.log(`Usage:
  readable plugin list [--task-kind <kind>]     List installed plugins (filterable).
  readable plugin search <query> [--tag <t>]    Search installed plugins by id/title/desc/tag.
  readable plugin stats [--json]                Inventory + snapshot health report.
  readable plugin info <id>                     Print a plugin's manifest + trust state as JSON.
  readable plugin manifest <id>                 Print only the parsed manifest JSON (no wrapper).
  readable plugin sources                       List distinct install sources + counts.
  readable plugin install --source <path>       Install a plugin from a local folder (Phase 1).
  readable plugin upgrade <id>                  Re-install a plugin from its recorded source.
  readable plugin uninstall <id>                Remove a plugin from the registry + on-disk staging.
  readable plugin apply <id> [--inputs <json>]  Compute an ApplyResult (preview) for a plugin.
  readable plugin doctor <id>                   Lint a plugin's manifest, atoms and resolved refs.
  readable plugin canon <snapshotId>            Print the canonical system-prompt block for a snapshot.
                                          (--check <file> for byte-equality fixtures.)
  readable plugin simulate <pluginId> [-s k=v]  Walk the plugin's pipeline against caller-supplied
                                          signals; report stage convergence + iterations
                                          (no LLM in the loop).
  readable plugin verify <pluginId>             CI meta-command: doctor + simulate + canon --check
                                          driven by an .readable-studio-verify.json config in the plugin folder.
  readable plugin events tail [-f] [--kind k]   Tail the in-memory plugin event ring buffer.
  readable plugin events snapshot               One-shot read (filterable, no SSE).
  readable plugin events stats                  Roll-up: counts by kind / pluginId / time range.
  readable plugin events purge                  Drop every event in the buffer (loopback-only).
  readable plugin diff <a> <b> [--json]         Compare two installed plugins by id.
  readable plugin replay <runId> --snapshot-id <id>
                                          Re-emit the immutable snapshot a run launched against.
  readable plugin trust <id> --capabilities a,b
                                          Stage a capability grant (full mutation lands Phase 3).
  readable plugin validate <folder> [--json]    Lint a plugin folder before installing
                                          (manifest parse + atom + ref checks).
  readable plugin pack <folder> [--out <path>]  Build a .tgz archive of a plugin
                                          folder for distribution.
  readable plugin publish-repo <folder>         Create/update the author's public
                                          GitHub repo for a plugin folder.
  readable plugin readable-studio-pr <folder>       Push a community-catalog branch and
                                          open the sanghyunna/readable-studio PR form.
  readable plugin publish <folder> --to readable-studio|anthropics-skills|awesome-agent-skills|clawhub|skills-sh
                                          Prepare a registry submission link.
  readable plugin login [--host github.com]      Authenticate registry publishing via gh.
  readable plugin whoami [--host github.com]     Show the gh account used for publishing.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base (default READABLE_DAEMON_URL, READABLE_SIDECAR_IPC_PATH discovery, or http://127.0.0.1:7456).
  --json               Emit raw JSON (suitable for scripts) instead of human-readable output.

Installs support local folders, github:owner/repo refs, HTTPS .tgz archives,
and bare marketplace names resolved through configured registry sources.`);
}

// ---------------------------------------------------------------------------
// Subcommand: readable project / readable run / readable files / readable conversation
//
// Plan §6 Phase 1 follow-up + Phase 2C: thin CLI wrappers over the
// existing daemon HTTP endpoints (POST /api/projects, POST /api/runs,
// GET /api/projects/:id/files, …). The §12.5 walkthrough relies on
// these so a code agent can drive Readable Studio end-to-end without
// hitting `/api/*` directly. Spec §11.7 invariant: every UI feature is
// reachable via the CLI; we wrap rather than duplicate.
// ---------------------------------------------------------------------------

async function projectDaemonUrl(flags) {
  return cliDaemonUrl(flags);
}

function printShareUsage() {
  console.log(`Usage:
  readable share readable-studio [--locale <locale>] [--platform <id>] [--json]
  readable share url --url <https-url> [--title <title>] [--text <text>]
               [--copy-text <text>] [--locale <locale>] [--platform <id>] [--json]

Platforms:
  x, linkedin, facebook, reddit, telegram, whatsapp, weibo, line, instagram, xiaohongshu

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --json               Emit raw JSON.`);
}

async function runShare(args) {
  const wantsHelp = args.length === 0
    || args[0] === 'help'
    || args.includes('--help')
    || args.includes('-h');
  if (wantsHelp) {
    printShareUsage();
    process.exit(args.length === 0 ? 2 : 0);
  }

  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'readable-studio';
  const rest = sub === args[0] ? args.slice(1) : args;
  const flags = parseFlags(rest, {
    string: SHARE_STRING_FLAGS,
    boolean: SHARE_BOOLEAN_FLAGS,
  });
  const base = (await cliDaemonUrl(flags)).replace(/\/$/, '');
  const positional = positionalArgs(rest, SHARE_STRING_FLAGS);
  const url = flags.url ?? positional[0];
  const body = sub === 'url'
    ? {
        kind: 'project-html',
        url,
        title: flags.title,
        text: flags.text,
        copyText: flags['copy-text'],
        locale: flags.locale,
      }
    : {
        kind: 'readable-studio-repo',
        title: flags.title,
        text: flags.text,
        copyText: flags['copy-text'],
        locale: flags.locale,
      };

  if (sub !== 'readable-studio' && sub !== 'url') {
    console.error(`unknown share target: ${sub}`);
    printShareUsage();
    process.exit(2);
  }
  if (body.kind === 'project-html' && !body.url) {
    console.error('Usage: readable share url --url <https-url>');
    process.exit(2);
  }

  const resp = await fetch(`${base}/api/social-share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return structuredHttpFailure(resp);
  const data = await resp.json();
  if (flags.platform) {
    const target = (data.platforms ?? []).find((item) => item.platform === flags.platform);
    if (!target) {
      console.error(`unknown platform: ${flags.platform}`);
      process.exit(2);
    }
    if (flags.json) return process.stdout.write(JSON.stringify(target, null, 2) + '\n');
    if (target.shareUrl) {
      console.log(target.shareUrl);
      return;
    }
    console.log(data.copyText);
    if (target.entryUrl) console.log(target.entryUrl);
    return;
  }
  if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  console.log(data.copyText);
  for (const target of data.platforms ?? []) {
    console.log(`${target.platform}\t${target.shareUrl ?? target.entryUrl ?? '-'}`);
  }
}

function printExportUsage() {
  console.log(`Usage:
  readable export html --project <id> --file <path> [--output <path>] [--force] [--json]
  readable export html --plugin <id> [--example <name>] [--output <path>] [--force] [--json]
  readable export html --design-system <id> --view showcase|preview [--output <path>] [--force] [--json]
  readable export html --input <path|-> --output <path> [--force] [--json]`);
}

async function runExport(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printExportUsage();
    process.exit(args.length === 0 ? 2 : 0);
  }
  if (args[0] !== 'html') {
    console.error('only `readable export html` is supported');
    process.exit(2);
  }
  let flags;
  try {
    flags = parseFlags(args.slice(1), { string: EXPORT_STRING_FLAGS, boolean: EXPORT_BOOLEAN_FLAGS });
  } catch (error) {
    console.error(error.message);
    printExportUsage();
    process.exit(2);
  }

  for (const selector of ['project', 'plugin', 'design-system', 'input']) {
    if (args.slice(1).filter((arg) => arg === `--${selector}` || arg.startsWith(`--${selector}=`)).length > 1) {
      console.error(`--${selector} may only be specified once`);
      process.exit(2);
    }
  }
  const selectors = ['project', 'plugin', 'design-system', 'input'].filter((key) => typeof flags[key] === 'string');
  const invalid = (message) => {
    console.error(message);
    printExportUsage();
    process.exit(2);
  };
  for (const selector of selectors) {
    if (!flags[selector].trim()) invalid(`--${selector} must not be empty`);
  }
  if (selectors.length !== 1) invalid('choose exactly one of --project, --plugin, --design-system, or --input');
  if (flags.project && !flags.file) invalid('--file is required with --project');
  if (flags.file && !flags.project) invalid('--file is only valid with --project');
  if (flags.example && !flags.plugin) invalid('--example is only valid with --plugin');
  if (flags['design-system'] && !['showcase', 'preview'].includes(flags.view)) invalid('--view showcase|preview is required with --design-system');
  if (flags.view && !flags['design-system']) invalid('--view is only valid with --design-system');
  if (flags.input === '-' && !flags.output) invalid('--output is required with --input -');

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const source = flags.project
    ? { kind: 'project', projectId: flags.project, filePath: flags.file }
    : flags.plugin
      ? { kind: 'plugin', pluginId: flags.plugin, ...(flags.example ? { exampleName: flags.example } : {}) }
      : flags['design-system']
        ? { kind: 'design-system', designSystemId: flags['design-system'], view: flags.view }
        : { kind: 'inline', html: flags.input === '-' ? await readStdinUtf8() : await fs.readFile(flags.input, 'utf8') };
  const stem = flags.project
    ? path.basename(flags.file, path.extname(flags.file))
    : flags.plugin ?? flags['design-system'] ?? path.basename(flags.input, path.extname(flags.input));
  const safeStem = String(stem).replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/[. ]+$/g, '').slice(0, 100) || 'standalone';
  const outputPath = path.resolve(flags.output ?? `${safeStem}-standalone.html`);
  if (!flags.force) {
    try {
      await fs.access(outputPath);
      console.error(`output already exists: ${outputPath} (use --force to replace it)`);
      process.exit(2);
    } catch {
      // Missing is the expected case.
    }
  }

  const base = (await cliDaemonUrl(flags)).replace(/\/$/, '');
  let response;
  try {
    response = await fetch(`${base}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
  } catch (error) {
    surfaceFetchError(error, base);
    process.exit(3);
  }
  if (!response.ok) {
    const body = await response.text();
    console.error(`standalone HTML export failed: ${response.status} ${body}`);
    process.exit(1);
  }

  const count = (name) => {
    const raw = response.headers.get(name);
    const value = raw == null ? NaN : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid response header: ${name}`);
    return value;
  };
  const bytes = Buffer.from(await response.arrayBuffer());
  const summary = {
    path: outputPath,
    sizeBytes: bytes.length,
    externalReferenceCount: count(STANDALONE_HTML_EXPORT_HEADERS.externalReferenceCount),
    missingLocalReferenceCount: count(STANDALONE_HTML_EXPORT_HEADERS.missingLocalReferenceCount),
    skippedSystemFontCount: count(STANDALONE_HTML_EXPORT_HEADERS.skippedSystemFontCount),
  };
  const { randomUUID } = await import('node:crypto');
  const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  let tempCreated = false;
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(tempPath, bytes, { flag: 'wx' });
    tempCreated = true;
    if (flags.force) {
      await fs.rename(tempPath, outputPath);
    } else {
      await fs.link(tempPath, outputPath);
      await fs.rm(tempPath);
    }
    tempCreated = false;
  } catch (error) {
    if (tempCreated) await fs.rm(tempPath, { force: true }).catch(() => {});
    console.error(`failed to write ${outputPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (flags.json) return process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Saved ${outputPath} (${bytes.length} bytes)`);
  if (summary.externalReferenceCount || summary.missingLocalReferenceCount || summary.skippedSystemFontCount) {
    console.warn(`Warnings: ${summary.externalReferenceCount} external, ${summary.missingLocalReferenceCount} missing local, ${summary.skippedSystemFontCount} skipped system fonts`);
  }
}

function normalizeChatSessionModeFlag(value) {
  if (value == null) return undefined;
  const mode = String(value).trim().toLowerCase();
  if (mode === 'design' || mode === 'chat') return mode;
  console.error('--mode must be one of: design, chat');
  process.exit(2);
}

function safeReadJsonFile(p) {
  try {
    if (p === '-') return JSON.parse(readFileSync(0, 'utf8'));
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function collectCliPositionals(argv, stringFlags = new Set()) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--') {
      out.push(...argv.slice(i + 1));
      break;
    }
    if (typeof value === 'string' && value.startsWith('--')) {
      const eq = value.indexOf('=');
      const key = eq >= 0 ? value.slice(2, eq) : value.slice(2);
      if (eq < 0 && stringFlags.has(key)) i++;
      continue;
    }
    out.push(value);
  }
  return out;
}

async function resolveFolderPathForCli(rawPath) {
  const path = await import('node:path');
  const os = await import('node:os');
  const raw = typeof rawPath === 'string' && rawPath.trim().length > 0
    ? rawPath.trim()
    : (process.env.INIT_CWD || process.cwd());
  const expanded = raw === '~'
    ? os.homedir()
    : raw.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), raw.slice(2))
      : raw;
  return path.resolve(expanded);
}

async function basenameForCli(folderPath) {
  const path = await import('node:path');
  return path.basename(folderPath) || 'Imported project';
}

async function readRunMessageFromFlags(flags, fallback = null) {
  if (typeof flags.message === 'string' && flags.message.length > 0) {
    return flags.message;
  }
  const prompt = await readPromptFromFlags(flags);
  if (typeof prompt === 'string' && prompt.length > 0) return prompt;
  return fallback;
}

async function postJsonToDaemon(base, route, body, headers = {}) {
  let resp;
  try {
    resp = await fetch(`${base}${route}`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    surfaceFetchError(err, base);
    process.exit(3);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const errCode = data?.error?.code;
    if (errCode && errCode in RECOVERABLE_EXIT_CODES) {
      return exitWithStructuredError({
        code:    errCode,
        message: data.error.message ?? `HTTP ${resp.status}`,
        data:    data.error.data,
      });
    }
    console.error(`POST ${route} failed: ${resp.status} ${JSON.stringify(data)}`);
    process.exit(1);
  }
  return data;
}

async function postImportFolderToDaemon(base, body, baseDir) {
  const headers = {};
  const importToken = await mintCliImportToken(baseDir);
  if (importToken != null) {
    headers['x-readable-studio-desktop-import-token'] = importToken;
  }
  return postJsonToDaemon(base, '/api/import/folder', body, headers);
}

async function runProject(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable project create [--name "<title>"] [--skill <id>] [--design-system <id>]
                    [--plugin <id>] [--inputs <json>] [--metadata-json <path|->]
                    [--mode design|chat]
  readable project import <baseDir> [--name "<title>"]
  readable project import-folder <path> [--name "<title>"] [--skill <id>]
                    [--design-system <id>] [--json]
  readable project list                         List projects.
  readable project info <id>                    Print one project.
  readable project delete <id>                  Delete a project.
  readable project handoff <id> --conversation <id> --api-key <key> --model <model>
                    [--base-url <url>] [--max-tokens <n>]
                    Synthesize a resume-conversation handoff prompt.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --identity-token-file <path|->
                       Hosted identity (or READABLE_HOSTED_IDENTITY_TOKEN_FILE).
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  // Handoff owns its own flag parsing, daemon-URL resolution, and
  // structured fail() output. Dispatch it before the generic project
  // parser below so a malformed `readable project handoff` invocation
  // (`--unknown`, `--max-tokens` with no value) hits handoff-cli's
  // machine-readable fail() path instead of throwing out of parseFlags.
  if (sub === 'handoff') {
    const { runProjectHandoff } = await import('./handoff-cli.js');
    const { exitCode } = await runProjectHandoff(rest);
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }
  const flags = parseFlags(rest, { string: PROJECT_STRING_FLAGS, boolean: PROJECT_BOOLEAN_FLAGS });
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  const client = await createContentCliClient(flags);
  switch (sub) {
    case 'list': {
      const resp = await client.request('/api/projects');
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const projects = data?.projects ?? [];
      if (projects.length === 0) {
        console.log('No projects. Create one with `readable project create --name "..."`.');
        return;
      }
      for (const p of projects) console.log(`${p.id}\t${p.name}\t${p.skillId ?? '-'}`);
      return;
    }
    case 'info': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: readable project info <id>');
        process.exit(2);
      }
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}`);
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    case 'create': {
      const unsupportedHostedFlag = client.hosted
        ? ['skill', 'design-system', 'plugin', 'metadata-json', 'pending-prompt', 'inputs', 'grant-caps', 'mode']
          .find((name) => flags[name] !== undefined)
        : undefined;
      if (unsupportedHostedFlag) {
        console.error(`--${unsupportedHostedFlag} is not supported by hosted project creation`);
        process.exit(2);
      }
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
      const name = typeof flags.name === 'string' && flags.name.length > 0
        ? flags.name
        : 'Untitled project';
      const body = client.hosted ? { title: name } : {
        id,
        name,
        skillId:        flags.skill ?? null,
        designSystemId: flags['design-system'] ?? null,
      };
      const conversationMode = normalizeChatSessionModeFlag(flags.mode);
      if (!client.hosted && conversationMode) body.conversationMode = conversationMode;
      if (!client.hosted && flags['pending-prompt']) body.pendingPrompt = flags['pending-prompt'];
      if (!client.hosted && flags['metadata-json']) {
        const mj = safeReadJsonFile(flags['metadata-json']);
        if (mj && typeof mj === 'object') body.metadata = mj;
      }
      if (!client.hosted && flags.plugin) body.pluginId = flags.plugin;
      if (!client.hosted && flags.inputs) {
        try { body.pluginInputs = JSON.parse(flags.inputs); } catch (err) {
          console.error(`--inputs must be valid JSON: ${err.message}`);
          process.exit(2);
        }
      }
      if (!client.hosted && flags['grant-caps']) {
        body.grantCaps = String(flags['grant-caps']).split(',').map((c) => c.trim()).filter(Boolean);
      }
      const resp = await client.request('/api/projects', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      }, true);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (resp.status === 409 && data?.error?.code === 'capabilities-required') {
          return exitWithStructuredError({
            code:    'capabilities-required',
            message: data.error.message,
            data:    data.error.data,
          });
        }
        console.error(`POST /api/projects failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[project] created ${data.project?.id ?? id}${data.conversationId ? ` (conversation ${data.conversationId})` : ''}`);
      return;
    }
    case 'import': {
      if (client.hosted) {
        console.error('readable project import is local-only');
        process.exit(2);
      }
      const [baseDir] = positionalArgs(rest, PROJECT_STRING_FLAGS);
      const importBaseDir = typeof baseDir === 'string' ? baseDir.trim() : '';
      if (!importBaseDir) {
        console.error('Usage: readable project import <baseDir> [--name "<title>"]');
        process.exit(2);
      }
      const body = { baseDir: importBaseDir };
      if (typeof flags.name === 'string' && flags.name.length > 0) body.name = flags.name;
      if (typeof flags.skill === 'string' && flags.skill.length > 0) body.skillId = flags.skill;
      if (typeof flags['design-system'] === 'string' && flags['design-system'].length > 0) {
        body.designSystemId = flags['design-system'];
      }
      const headers = { 'content-type': 'application/json' };
      const importToken = await mintCliImportToken(importBaseDir);
      if (importToken != null) {
        headers['x-readable-studio-desktop-import-token'] = importToken;
      }
      const resp = await fetch(`${base}/api/import/folder`, {
        method:  'POST',
        headers,
        body:    JSON.stringify(body),
      });
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[project] imported ${data.project?.id ?? '-'} (conversation ${data.conversationId ?? '-'})`);
      return;
    }
    case 'import-folder': {
      if (client.hosted) {
        console.error('readable project import-folder is local-only');
        process.exit(2);
      }
      const parts = collectCliPositionals(rest, PROJECT_STRING_FLAGS);
      const folderArg = flags.path ?? flags.dir ?? parts[0];
      if (!folderArg) {
        console.error('Usage: readable project import-folder <path> [--skill <id>] [--design-system <id>]');
        process.exit(2);
      }
      const folderPath = await resolveFolderPathForCli(folderArg);
      const body = {
        baseDir:        folderPath,
        name:           typeof flags.name === 'string' && flags.name.length > 0
          ? flags.name
          : await basenameForCli(folderPath),
        skillId:        flags.skill ?? null,
        designSystemId: flags['design-system'] ?? null,
      };
      const data = await postImportFolderToDaemon(base, body, folderPath);
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[project] imported ${data.project?.id ?? '-'} from ${folderPath} (conversation ${data.conversationId ?? '-'})`);
      return;
    }
    case 'delete': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: readable project delete <id>');
        process.exit(2);
      }
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }, true);
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      if (flags.json) return process.stdout.write(`${JSON.stringify(await resp.json())}\n`);
      console.log(`[project] deleted ${id}`);
      return;
    }
    default:
      console.error(`unknown subcommand: readable project ${sub}`);
      process.exit(2);
  }
}

async function runRun(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable run start --project <projectId> [--conversation <id>] [--message "<text>"]
               [--plugin <id>] [--inputs <json>] [--grant-caps a,b]
               [--agent claude|codex|gemini] [--model <id>] [--follow] [--json]
  readable run redesign [--path <folder>] [--message "<text>" | --prompt-file <path|->]
               [--agent claude] [--model <id>] [--follow] [--json]
  readable run watch  <runId>                     ND-JSON event stream on stdout.
  readable run cancel <runId>                     Request cancellation.
  readable run list   [--project <id>]            List recent runs.
  readable run info   <runId>                     One run's status.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --identity-token-file <path|->
                       Hosted identity (or READABLE_HOSTED_IDENTITY_TOKEN_FILE).
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: PROJECT_STRING_FLAGS, boolean: PROJECT_BOOLEAN_FLAGS });
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  const client = await createContentCliClient(flags);
  switch (sub) {
    case 'list': {
      const url = flags.project
        ? `${base}/api/runs?projectId=${encodeURIComponent(flags.project)}`
        : `${base}/api/runs`;
      const resp = await client.request(url.slice(base.length));
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const runs = data?.runs ?? [];
      for (const r of runs) {
        console.log(`${r.id}\t${r.status}\tproject=${r.projectId ?? '-'}\tplugin=${r.pluginId ?? '-'}`);
      }
      return;
    }
    case 'info': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: readable run info <runId>');
        process.exit(2);
      }
      const resp = await client.request(`/api/runs/${encodeURIComponent(id)}`);
      if (!resp.ok) return structuredHttpFailure(resp, 'run-not-found');
      const data = await resp.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    case 'cancel': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: readable run cancel <runId>');
        process.exit(2);
      }
      const resp = await client.request(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, true);
      if (!resp.ok) return structuredHttpFailure(resp, 'run-not-found');
      if (flags.json) return process.stdout.write(`${JSON.stringify(await resp.json())}\n`);
      console.log(`[run] cancelled ${id}`);
      return;
    }
    case 'watch': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: readable run watch <runId>');
        process.exit(2);
      }
      await streamRunEvents(client, id);
      return;
    }
    case 'redesign': {
      if (client.hosted) {
        console.error('readable run redesign is local-only; use readable run start for hosted projects');
        process.exit(2);
      }
      const parts = collectCliPositionals(rest, PROJECT_STRING_FLAGS);
      const promptFromArgs = parts.join(' ').trim();
      const defaultMessage =
        'Use the redesign-existing-projects skill. Audit the current UI first, then redesign it to premium quality without breaking functionality. Preserve the existing product structure, routes, and behavior.';
      const message = await readRunMessageFromFlags(
        flags,
        promptFromArgs || defaultMessage,
      );
      const skillId = flags.skill ?? 'redesign-existing-projects';
      const designSystemId = flags['design-system'] ?? 'default';
      let projectId = flags.project;
      let conversationId = flags.conversation;
      let imported = null;

      if (!projectId) {
        const folderPath = await resolveFolderPathForCli(flags.path ?? flags.dir);
        imported = await postImportFolderToDaemon(base, {
          baseDir:        folderPath,
          name:           typeof flags.name === 'string' && flags.name.length > 0
            ? flags.name
            : await basenameForCli(folderPath),
          skillId,
          designSystemId,
        }, folderPath);
        projectId = imported.project?.id;
        conversationId = conversationId ?? imported.conversationId;
        if (!projectId) {
          console.error('POST /api/import/folder did not return project.id');
          process.exit(1);
        }
        if (!flags.json || flags.follow) {
          console.log(`[project] imported ${projectId} from ${folderPath} (conversation ${conversationId ?? '-'})`);
        }
      }

      const body = {
        projectId,
        ...(conversationId ? { conversationId } : {}),
        ...(message ? { message } : {}),
        skillId,
        designSystemId,
        ...(flags.agent ? { agentId: flags.agent } : {}),
        ...(flags.model ? { model: flags.model } : {}),
      };
      const data = await postJsonToDaemon(base, '/api/runs', body);
      if (flags.json && !flags.follow) {
        return process.stdout.write(JSON.stringify({
          ...data,
          project: imported?.project ?? null,
          conversationId: conversationId ?? null,
        }, null, 2) + '\n');
      }
      console.log(`[run] started ${data.runId}`);
      if (flags.follow) await streamRunEvents(client, data.runId);
      return;
    }
    case 'start': {
      if (!flags.project) {
        console.error('--project <projectId> is required');
        process.exit(2);
      }
      const message = await readRunMessageFromFlags(flags);
      if (client.hosted) {
        const unsupportedHostedFlag = ['plugin', 'inputs', 'grant-caps', 'snapshot-id']
          .find((name) => flags[name] !== undefined);
        if (unsupportedHostedFlag) {
          console.error(`--${unsupportedHostedFlag} is not supported by hosted runs`);
          process.exit(2);
        }
        if (!flags.conversation) {
          console.error('--conversation <id> is required for hosted runs');
          process.exit(2);
        }
        if (!message) {
          console.error('--message or --prompt-file is required for hosted runs');
          process.exit(2);
        }
        const userMessageId = crypto.randomUUID();
        const assistantMessageId = crypto.randomUUID();
        const body = JSON.stringify({
          projectId: flags.project,
          conversationId: flags.conversation,
          assistantMessageId,
          agentId: flags.agent ?? 'pi',
          message,
          clientRequestId: crypto.randomUUID(),
          ...(flags.skill ? { skillIds: [flags.skill] } : {}),
          ...(flags['design-system'] ? { designSystemId: flags['design-system'] } : {}),
          ...(flags.model ? { model: flags.model } : {}),
        });
        const messagesPath = `/api/projects/${encodeURIComponent(flags.project)}/conversations/${encodeURIComponent(flags.conversation)}/messages`;
        const userMessage = await client.request(`${messagesPath}/${encodeURIComponent(userMessageId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'user', content: message }),
        }, true);
        if (!userMessage.ok) return structuredHttpFailure(userMessage);
        const placeholder = await client.request(`${messagesPath}/${encodeURIComponent(assistantMessageId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'assistant', content: '' }),
        }, true);
        if (!placeholder.ok) return structuredHttpFailure(placeholder);
        const sendRun = () => client.request('/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }, true);
        let data;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const resp = await sendRun();
            if (!resp.ok) return structuredHttpFailure(resp);
            data = await resp.json();
            if (typeof data?.runId !== 'string' || data.runId.length === 0) {
              throw new Error('hosted run response did not include a run id');
            }
            break;
          } catch (error) {
            if (attempt === 1) throw error;
          }
        }
        if (flags.json && !flags.follow) return process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        if (!flags.json) console.log(`[run] started ${data.runId}`);
        if (flags.follow) await streamRunEvents(client, data.runId);
        return;
      }
      const body = { projectId: flags.project };
      if (flags.conversation) body.conversationId = flags.conversation;
      if (message) body.message = message;
      if (flags.plugin) body.pluginId = flags.plugin;
      if (flags.skill) body.skillId = flags.skill;
      if (flags['design-system']) body.designSystemId = flags['design-system'];
      if (flags.agent) body.agentId = flags.agent;
      if (flags.model) body.model = flags.model;
      if (flags.inputs) {
        try { body.pluginInputs = JSON.parse(flags.inputs); } catch (err) {
          console.error(`--inputs must be valid JSON: ${err.message}`);
          process.exit(2);
        }
      }
      if (flags['grant-caps']) {
        body.grantCaps = String(flags['grant-caps']).split(',').map((c) => c.trim()).filter(Boolean);
      }
      if (flags['snapshot-id']) body.appliedPluginSnapshotId = flags['snapshot-id'];
      const resp = await fetch(`${base}/api/runs`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (resp.status === 409 && data?.error?.code === 'capabilities-required') {
          return exitWithStructuredError({
            code:    'capabilities-required',
            message: data.error.message,
            data:    data.error.data,
          });
        }
        if (resp.status === 422 && data?.error?.code === 'missing-input') {
          return exitWithStructuredError({
            code:    'missing-input',
            message: data.error.message,
            data:    data.error.data,
          });
        }
        console.error(`POST /api/runs failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json && !flags.follow) {
        return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      }
      console.log(`[run] started ${data.runId}`);
      if (flags.follow) await streamRunEvents(client, data.runId);
      return;
    }
    default:
      console.error(`unknown subcommand: readable run ${sub}`);
      process.exit(2);
  }
}

// Stream the SSE events at /api/runs/:id/events as ND-JSON on stdout.
// Each line is one event: { event, data } so a code agent can parse it
// without needing an SSE library.
async function streamRunEvents(client, runId) {
  const pathname = `/api/runs/${encodeURIComponent(runId)}/events`;
  const resp = typeof client === 'string'
    ? await fetch(`${client}${pathname}`, { headers: { accept: 'text/event-stream' } })
    : await client.request(pathname, {
    headers: { accept: 'text/event-stream' },
    });
  if (!resp.ok || !resp.body) {
    console.error(`run watch failed: ${resp.status}`);
    process.exit(1);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine  = lines.find((l) => l.startsWith('data: '));
      const event = eventLine ? eventLine.slice('event: '.length) : 'message';
      const dataRaw = dataLine ? dataLine.slice('data: '.length) : '';
      let parsed;
      try { parsed = JSON.parse(dataRaw); } catch { parsed = dataRaw; }
      process.stdout.write(JSON.stringify({ event, data: parsed }) + '\n');
      if (event === 'end') {
        return;
      }
    }
  }
}

// `readable shell --project <id>` opens an interactive PTY rooted at the project's
// working directory and attaches to it. This is the CLI parity for the web
// Terminal tab — both surfaces drive `/api/projects/:id/terminals`. Output
// streams down over SSE; local keystrokes are POSTed back up to /stdin. When
// stdin is a TTY we flip it into raw mode so the remote shell sees per-key
// bytes (ctrl-c, arrows, tab) instead of line-buffered input.
async function runShell(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable shell --project <projectId> [--shell <path>] [--json]
                                  Open an interactive shell in the project's
                                  working directory and attach to it.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --json               Print the created terminal session as JSON and exit
                       (does not attach).`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const flags = parseFlags(args, { string: PROJECT_STRING_FLAGS, boolean: PROJECT_BOOLEAN_FLAGS });
  if (!flags.project) {
    console.error('--project <projectId> is required');
    process.exit(2);
  }
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  const body = {};
  if (flags.shell) body.shell = flags.shell;
  if (process.stdout.columns) body.cols = process.stdout.columns;
  if (process.stdout.rows) body.rows = process.stdout.rows;
  const createResp = await fetch(
    `${base}/api/projects/${encodeURIComponent(flags.project)}/terminals`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!createResp.ok) return structuredHttpFailure(createResp, 'project-not-found');
  const created = await createResp.json();
  if (flags.json) {
    return process.stdout.write(JSON.stringify(created, null, 2) + '\n');
  }
  const terminalId = created?.terminal?.id;
  if (!terminalId) {
    console.error('terminal create returned no id');
    process.exit(1);
  }
  await attachTerminal(base, flags.project, terminalId);
}

// Bridge a local TTY to a remote PTY session: SSE `data` events → stdout,
// local stdin bytes → POST /stdin, terminal resize → POST /resize. Resolves
// when the remote shell emits its `exit` event.
async function attachTerminal(base, projectId, terminalId) {
  const termPath = `${base}/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}`;
  const isRawTty = Boolean(process.stdin.isTTY && process.stdin.setRawMode);
  if (isRawTty) process.stdin.setRawMode(true);
  process.stdin.resume();

  const onInput = (chunk) => {
    fetch(`${termPath}/stdin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: chunk.toString('utf8') }),
    }).catch(() => {});
  };
  process.stdin.on('data', onInput);

  const onResize = () => {
    fetch(`${termPath}/resize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: process.stdout.columns, rows: process.stdout.rows }),
    }).catch(() => {});
  };
  process.stdout.on('resize', onResize);

  const restore = () => {
    process.stdin.off('data', onInput);
    process.stdout.off('resize', onResize);
    if (isRawTty) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    process.stdin.pause();
  };

  try {
    const resp = await fetch(`${termPath}/stream`, { headers: { accept: 'text/event-stream' } });
    if (!resp.ok || !resp.body) {
      console.error(`shell attach failed: ${resp.status}`);
      process.exit(1);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const lines = block.split('\n');
        const eventLine = lines.find((l) => l.startsWith('event: '));
        const dataLine = lines.find((l) => l.startsWith('data: '));
        const event = eventLine ? eventLine.slice('event: '.length) : 'message';
        const dataRaw = dataLine ? dataLine.slice('data: '.length) : '';
        let parsed;
        try { parsed = JSON.parse(dataRaw); } catch { parsed = dataRaw; }
        if (event === 'data' && parsed && typeof parsed.data === 'string') {
          process.stdout.write(parsed.data);
        } else if (event === 'exit') {
          restore();
          process.exit(typeof parsed?.code === 'number' ? parsed.code : 0);
        }
      }
    }
  } finally {
    restore();
  }
}

function canonicalCliRelativePath(value, label = 'path') {
  const candidate = String(value ?? '');
  const bytes = Buffer.from(candidate, 'utf8');
  if (
    bytes.length < 1
    || bytes.length > 1_024
    || bytes.toString('utf8') !== candidate
    || candidate.startsWith('/')
    || candidate.includes('\\')
    || /^[A-Za-z]:/u.test(candidate)
    || /%(?:00|2e|2f|5c|25(?:00|2e|2f|5c))/iu.test(candidate)
    || /[\u0000-\u001f\u007f]/u.test(candidate)
    || candidate.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    console.error(`${label} must be a canonical relative path of at most 1,024 bytes`);
    process.exit(2);
  }
  return candidate;
}

function encodeProjectRelpath(rel) {
  return canonicalCliRelativePath(rel).split('/').map(encodeURIComponent).join('/');
}

function exactCliOrigin(value) {
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (
    url == null
    || (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.origin !== value
  ) {
    console.error('--daemon-url must be an absolute HTTP(S) origin without a path');
    process.exit(2);
  }
  return url.origin;
}

function hostedCliSecret(filePath, label) {
  let bytes;
  try { bytes = filePath === '-' ? readFileSync(0) : readFileSync(filePath); } catch {
    console.error(`unable to read ${label}`);
    process.exit(2);
  }
  if (bytes.length > 16 * 1_024 + 2) {
    console.error(`${label} exceeds 16 KiB`);
    process.exit(2);
  }
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    console.error(`${label} must be UTF-8`);
    process.exit(2);
  }
  if (value.endsWith('\r\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  if (!value || /[\r\n\0]/u.test(value) || Buffer.byteLength(value, 'utf8') > 16 * 1_024) {
    console.error(`${label} must be one line of at most 16 KiB`);
    process.exit(2);
  }
  return value;
}

async function safeHostedCliFetch(baseOrigin, input, init) {
  let url = input;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (location == null) return response;
    const target = new URL(location, url);
    if (target.origin !== baseOrigin) {
      console.error('hosted daemon attempted a cross-origin redirect');
      process.exit(1);
    }
    url = target.href;
  }
  console.error('hosted daemon redirected too many times');
  process.exit(1);
}

async function createContentCliClient(flags, { stdinInUse = false } = {}) {
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  const identityFile = flags['identity-token-file'] ?? process.env.READABLE_HOSTED_IDENTITY_TOKEN_FILE;
  if (typeof identityFile !== 'string' || identityFile.length === 0) {
    return {
      hosted: false,
      request: (pathname, init = {}) => fetch(`${base}${pathname}`, init),
    };
  }
  if (identityFile === '-' && stdinInUse) {
    console.error('stdin cannot supply both hosted identity and command content');
    process.exit(2);
  }
  const baseOrigin = exactCliOrigin(base);
  const identityToken = hostedCliSecret(identityFile, 'identity token');
  const authorization = `Bearer ${identityToken}`;
  let session = null;

  const loadSession = async () => {
    const response = await safeHostedCliFetch(
      baseOrigin,
      `${baseOrigin}/api/hosted/session`,
      { method: 'GET', headers: { accept: 'application/json', authorization } },
    );
    if (!response.ok) return structuredHttpFailure(response);
    const payload = await response.json().catch(() => null);
    if (
      payload == null
      || typeof payload !== 'object'
      || typeof payload.publicOrigin !== 'string'
      || exactCliOrigin(payload.publicOrigin) !== baseOrigin
      || typeof payload.csrfToken !== 'string'
      || payload.csrfToken.length === 0
    ) {
      console.error('hosted daemon returned an invalid session');
      process.exit(1);
    }
    session = payload;
    return session;
  };

  const request = async (pathname, init = {}, mutation = false) => {
    const send = async () => {
      const headers = new Headers(init.headers);
      headers.set('authorization', authorization);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      if (mutation) {
        const current = session ?? await loadSession();
        headers.set('origin', current.publicOrigin);
        headers.set('X-Readable-Studio-CSRF', current.csrfToken);
      }
      return safeHostedCliFetch(baseOrigin, `${baseOrigin}${pathname}`, { ...init, headers });
    };
    let response = await send();
    if (response.status === 401 || response.status === 419) {
      session = null;
      await loadSession();
      response = await send();
    }
    return response;
  };
  return { hosted: true, request };
}

function printContentResult(flags, data, message) {
  if (flags.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else if (message) console.log(message);
}

async function responseJsonOrExit(response, fallbackCode) {
  if (!response.ok) return structuredHttpFailure(response, fallbackCode);
  return response.json();
}

async function runHostedArtifacts(args) {
  const command = args[0];
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`Usage:
  readable artifacts save --html-file <path|-> [--identifier <id>] [--title <title>] [--json]
  readable artifacts lint --html-file <path|-> [--json]
  readable artifacts download <artifactId>

Common options:
  --daemon-url <url>
  --identity-token-file <path|->
                       Hosted identity (or READABLE_HOSTED_IDENTITY_TOKEN_FILE).`);
    process.exit(0);
  }
  const flags = parseFlags(rest, {
    string: HOSTED_ARTIFACT_STRING_FLAGS,
    boolean: HOSTED_ARTIFACT_BOOLEAN_FLAGS,
  });
  const htmlFile = flags['html-file'];
  const client = await createContentCliClient(flags, {
    stdinInUse: (command === 'save' || command === 'lint') && htmlFile === '-',
  });
  if (command === 'download') {
    const [artifactId] = positionalArgs(rest, HOSTED_ARTIFACT_STRING_FLAGS);
    if (!artifactId || !/^oda_[A-Za-z0-9_-]{43}$/u.test(artifactId)) {
      console.error('Usage: readable artifacts download <artifactId>');
      process.exit(2);
    }
    const response = await client.request(`/api/artifacts/${encodeURIComponent(artifactId)}/download`);
    if (!response.ok) return structuredHttpFailure(response, 'daemon-not-running');
    process.stdout.write(Buffer.from(await response.arrayBuffer()));
    return;
  }
  if (typeof htmlFile !== 'string' || htmlFile.length === 0) {
    console.error(`Usage: readable artifacts ${command} --html-file <path|-> [--json]`);
    process.exit(2);
  }
  let html;
  try { html = (htmlFile === '-' ? readFileSync(0) : readFileSync(htmlFile)).toString('utf8'); } catch {
    console.error('unable to read artifact HTML');
    process.exit(2);
  }
  const body = command === 'save'
    ? {
        html,
        ...(typeof flags.identifier === 'string' ? { identifier: flags.identifier } : {}),
        ...(typeof flags.title === 'string' ? { title: flags.title } : {}),
      }
    : { html };
  const response = await client.request(`/api/artifacts/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, true);
  const data = await responseJsonOrExit(response);
  printContentResult(
    flags,
    data,
    command === 'save'
      ? data.url ?? `[artifacts] saved ${data.artifactId}`
      : data.agentMessage ?? JSON.stringify(data.findings ?? []),
  );
}

async function runFiles(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable files list   <projectId>                  List files in a project.
  readable files read   <projectId> <relpath>        Stream file bytes to stdout.
  readable files write  <projectId> <relpath> [< stdin]
                                               Write content from stdin.
  readable files upload <projectId> <localpath> [--as <relpath>]
                                               Upload a local file.
  readable files rename <projectId> <from> <to>       Rename a project file.
  readable files delete <projectId> <relpath>         Delete a project file.
  readable files search <projectId> --query <text> [--pattern <glob>] [--max <n>]
  readable files folders <list|create|delete> <projectId> [<relpath>]
  readable files preview <projectId> <relpath>        Mint a scoped file preview.
  readable files preview-url <projectId> <relpath>    Mint an opaque preview URL.
  readable files archive <projectId> [--root <relpath>]
                                               Stream a bounded project archive.
  readable files export-manifest <projectId>          Print the hosted export manifest.
  readable files diff   <projectId> <relpathA> [<relpathB> | --against -]
                                               Print a unified diff.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --identity-token-file <path|->
                       Hosted identity (or READABLE_HOSTED_IDENTITY_TOKEN_FILE).
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: PROJECT_STRING_FLAGS, boolean: PROJECT_BOOLEAN_FLAGS });
  const stdinInUse = sub === 'write'
    || (sub === 'diff' && flags.against === '-');
  const client = await createContentCliClient(flags, { stdinInUse });
  const positional = positionalArgs(rest, PROJECT_STRING_FLAGS);
  switch (sub) {
    case 'list': {
      const [id] = positional;
      if (!id) {
        console.error('Usage: readable files list <projectId>');
        process.exit(2);
      }
      const query = typeof flags.since === 'string' ? `?since=${encodeURIComponent(flags.since)}` : '';
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/files${query}`);
      const data = await responseJsonOrExit(resp, 'project-not-found');
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const files = Array.isArray(data?.files) ? data.files : [];
      for (const f of files) console.log(`${f.size}\t${f.name ?? f.path}`);
      return;
    }
    case 'read': {
      const [id, rel] = positional;
      if (!id || !rel) {
        console.error('Usage: readable files read <projectId> <relpath>');
        process.exit(2);
      }
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/files/${encodeProjectRelpath(rel)}`);
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const buf = Buffer.from(await resp.arrayBuffer());
      process.stdout.write(buf);
      return;
    }
    case 'upload': {
      const [id, localPath] = positional;
      if (!id || !localPath) {
        console.error('Usage: readable files upload <projectId> <localpath> [--as <relpath>]');
        process.exit(2);
      }
      const buf = readFileSync(localPath);
      const desiredName = typeof flags.as === 'string' && flags.as.length > 0
        ? canonicalCliRelativePath(flags.as, '--as')
        : path.basename(localPath);
      let resp;
      if (client.hosted) {
        const form = new FormData();
        const directory = path.posix.dirname(desiredName);
        if (directory !== '.') form.append('dir', directory);
        form.append('files', new Blob([buf]), path.posix.basename(desiredName));
        resp = await client.request(
          `/api/projects/${encodeURIComponent(id)}/upload`,
          { method: 'POST', body: form },
          true,
        );
      } else {
        resp = await client.request(`/api/projects/${encodeURIComponent(id)}/files`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: desiredName, content: buf.toString('base64'), encoding: 'base64' }),
        }, true);
      }
      const data = await responseJsonOrExit(resp);
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[files] uploaded ${data?.file?.name ?? data?.files?.[0]?.name ?? desiredName}`);
      return;
    }
    case 'write': {
      const [id, rel] = positional;
      if (!id || !rel) {
        console.error('Usage: readable files write <projectId> <relpath> [< stdin]');
        process.exit(2);
      }
      let body;
      try {
        body = readFileSync(0);
      } catch (err) {
        console.error(`stdin read failed: ${err.message ?? err}`);
        process.exit(1);
      }
      const name = canonicalCliRelativePath(rel);
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          content: body.toString('utf8'),
          encoding: 'utf8',
        }),
      }, true);
      const data = await responseJsonOrExit(resp);
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[files] wrote ${data?.file?.name ?? name}`);
      return;
    }
    case 'rename': {
      const [id, from, to] = positional;
      if (!id || !from || !to) {
        console.error('Usage: readable files rename <projectId> <from> <to>');
        process.exit(2);
      }
      const body = {
        from: canonicalCliRelativePath(from, 'from'),
        to: canonicalCliRelativePath(to, 'to'),
      };
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/files/rename`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }, true);
      const data = await responseJsonOrExit(resp);
      printContentResult(flags, data, `[files] renamed ${body.from} to ${body.to}`);
      return;
    }
    case 'delete': {
      const [id, name] = positional;
      if (!id || !name) {
        console.error('Usage: readable files delete <projectId> <name>');
        process.exit(2);
      }
      const canonical = canonicalCliRelativePath(name);
      const resp = await client.request(
        `/api/projects/${encodeURIComponent(id)}/files/${encodeProjectRelpath(canonical)}`,
        { method: 'DELETE' },
        true,
      );
      const data = await responseJsonOrExit(resp);
      printContentResult(flags, data, `[files] deleted ${canonical}`);
      return;
    }
    case 'search': {
      const [id] = positional;
      if (!id || typeof flags.query !== 'string' || flags.query.length === 0) {
        console.error('Usage: readable files search <projectId> --query <text> [--pattern <glob>] [--max <n>]');
        process.exit(2);
      }
      const query = new URLSearchParams({ q: flags.query });
      if (typeof flags.pattern === 'string') query.set('pattern', flags.pattern);
      if (typeof flags.max === 'string') query.set('max', flags.max);
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/search?${query}`);
      const data = await responseJsonOrExit(resp, 'project-not-found');
      printContentResult(flags, data, (data.matches ?? []).map((match) => (
        `${match.file}:${match.line}\t${match.snippet}`
      )).join('\n'));
      return;
    }
    case 'folders': {
      const [action, id, relative] = positional;
      if (!['list', 'create', 'delete'].includes(action) || !id || (action !== 'list' && !relative)) {
        console.error('Usage: readable files folders <list|create|delete> <projectId> [<relpath>]');
        process.exit(2);
      }
      const mutation = action !== 'list';
      const body = mutation ? JSON.stringify({ path: canonicalCliRelativePath(relative) }) : undefined;
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/folders`, {
        method: action === 'list' ? 'GET' : action === 'create' ? 'POST' : 'DELETE',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
      }, mutation);
      const data = await responseJsonOrExit(resp, 'project-not-found');
      printContentResult(flags, data, action === 'list'
        ? (data.folders ?? []).map((folder) => folder.path ?? folder.name).join('\n')
        : `[folders] ${action === 'create' ? 'created' : 'deleted'} ${relative}`);
      return;
    }
    case 'preview':
    case 'preview-url': {
      const [id, relative] = positional;
      if (!id || !relative) {
        console.error(`Usage: readable files ${sub} <projectId> <relpath>`);
        process.exit(2);
      }
      const canonical = canonicalCliRelativePath(relative);
      const pathname = sub === 'preview'
        ? `/api/projects/${encodeURIComponent(id)}/files/preview`
        : `/api/projects/${encodeURIComponent(id)}/preview-url`;
      const body = sub === 'preview' ? { path: canonical } : { file: canonical };
      const resp = await client.request(pathname, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }, true);
      const data = await responseJsonOrExit(resp, 'project-not-found');
      printContentResult(flags, data, data.url ?? data.previewUrl ?? JSON.stringify(data));
      return;
    }
    case 'archive': {
      const [id] = positional;
      if (!id) {
        console.error('Usage: readable files archive <projectId> [--root <relpath>]');
        process.exit(2);
      }
      const suffix = typeof flags.root === 'string'
        ? `?root=${encodeURIComponent(canonicalCliRelativePath(flags.root, '--root'))}`
        : '';
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/archive${suffix}`);
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      process.stdout.write(Buffer.from(await resp.arrayBuffer()));
      return;
    }
    case 'export-manifest': {
      const [id] = positional;
      if (!id) {
        console.error('Usage: readable files export-manifest <projectId>');
        process.exit(2);
      }
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/export/manifest`);
      const data = await responseJsonOrExit(resp, 'project-not-found');
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return;
    }
    case 'diff': {
      const [id, relA, relB] = positional;
      const against = typeof flags.against === 'string' ? flags.against : null;
      if (!id || !relA || (!relB && !against) || (relB && against)) {
        console.error('Usage: readable files diff <projectId> <relpathA> [<relpathB> | --against -]');
        process.exit(2);
      }
      const left = await fetchProjectFileText(client, id, relA);
      const rightLabel = against ?? relB;
      const right = against === '-'
        ? await readStdinUtf8()
        : await fetchProjectFileText(client, id, rightLabel);
      const diff = createUnifiedDiff(`a/${relA}`, `b/${rightLabel}`, left, right);
      if (flags.json) return process.stdout.write(JSON.stringify({ diff }, null, 2) + '\n');
      process.stdout.write(diff);
      return;
    }
    default:
      console.error(`unknown subcommand: readable files ${sub}`);
      process.exit(2);
  }
}

async function fetchProjectFileText(client, id, rel) {
  const resp = await client.request(
    `/api/projects/${encodeURIComponent(id)}/files/${encodeProjectRelpath(rel)}`,
  );
  if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString('utf8');
}

async function readStdinUtf8() {
  const fs = await import('node:fs');
  return fs.readFileSync(0, 'utf8');
}

async function mintCliImportToken(baseDir) {
  const socketPath = process.env[SIDECAR_ENV.IPC_PATH];
  if (typeof socketPath !== 'string' || socketPath.length === 0) return null;
  let result;
  try {
    const { requestJsonIpc } = await import('@readable-studio/sidecar');
    result = await requestJsonIpc(
      socketPath,
      { type: SIDECAR_MESSAGES.MINT_IMPORT_TOKEN, input: { baseDir } },
      { timeoutMs: 800 },
    );
  } catch {
    return null;
  }
  if (result?.ok === true && typeof result.token === 'string' && result.token.length > 0) {
    return result.token;
  }
  if (result?.ok === false && result.code === 'DESKTOP_AUTH_PENDING') {
    exitWithStructuredError({
      code: 'desktop-auth-pending',
      message: result.message ?? 'desktop auth required but secret not yet registered',
      data: { retryable: result.retryable === true },
    });
  }
  return null;
}

function createUnifiedDiff(leftLabel, rightLabel, leftText, rightText) {
  if (leftText === rightText) return '';
  const leftLines = splitDiffLines(leftText);
  const rightLines = splitDiffLines(rightText);
  let prefix = 0;
  while (
    prefix < leftLines.length
    && prefix < rightLines.length
    && leftLines[prefix] === rightLines[prefix]
  ) {
    prefix++;
  }
  let leftEnd = leftLines.length;
  let rightEnd = rightLines.length;
  while (
    leftEnd > prefix
    && rightEnd > prefix
    && leftLines[leftEnd - 1] === rightLines[rightEnd - 1]
  ) {
    leftEnd--;
    rightEnd--;
  }
  const oldMid = leftLines.slice(prefix, leftEnd);
  const newMid = rightLines.slice(prefix, rightEnd);
  const body = diffLineBody(oldMid, newMid);
  if (body.length === 0) {
    body.push(...oldMid.map((line) => diffLine('-', line)), ...newMid.map((line) => diffLine('+', line)));
  }
  const oldStart = oldMid.length === 0 ? prefix : prefix + 1;
  const newStart = newMid.length === 0 ? prefix : prefix + 1;
  return [
    `--- ${leftLabel}`,
    `+++ ${rightLabel}`,
    `@@ -${formatDiffRange(oldStart, oldMid.length)} +${formatDiffRange(newStart, newMid.length)} @@`,
    ...body,
  ].join('\n') + '\n';
}

function splitDiffLines(text) {
  const value = String(text);
  if (value.length === 0) return [];
  return value.match(/.*?(?:\r\n|\n|\r|$)/gs).filter((line) => line.length > 0);
}

function formatDiffRange(start, length) {
  return length === 1 ? String(start) : `${start},${length}`;
}

function diffLineBody(oldLines, newLines) {
  if (oldLines.length === 0) return newLines.map((line) => diffLine('+', line));
  if (newLines.length === 0) return oldLines.map((line) => diffLine('-', line));
  if (oldLines.length * newLines.length > 1_000_000) {
    return [...oldLines.map((line) => diffLine('-', line)), ...newLines.map((line) => diffLine('+', line))];
  }
  const width = newLines.length + 1;
  const lcs = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(width),
  );
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push(diffLine(' ', oldLines[i]));
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(diffLine('-', oldLines[i]));
      i++;
    } else {
      out.push(diffLine('+', newLines[j]));
      j++;
    }
  }
  while (i < oldLines.length) out.push(diffLine('-', oldLines[i++]));
  while (j < newLines.length) out.push(diffLine('+', newLines[j++]));
  return out;
}

function diffLine(prefix, line) {
  const value = String(line);
  if (value.endsWith('\r\n')) return `${prefix}${renderDiffLineContent(value.slice(0, -1))}`;
  if (value.endsWith('\n')) return `${prefix}${renderDiffLineContent(value.slice(0, -1))}`;
  if (value.endsWith('\r')) return `${prefix}${renderDiffLineContent(value)}`;
  return `${prefix}${renderDiffLineContent(value)}\n\\ No newline at end of file`;
}

function renderDiffLineContent(value) {
  return String(value).replace(/\r/g, '\\r');
}

// `readable templates …` is the headless face of NewProjectPanel /
// ExamplesTab — same /api/templates store, same DTO shapes. External
// agents (hermes-agent, openclaw, custom bots) use these to snapshot a
// project as a reusable starting point, list everything the user has
// saved, or drop one that is no longer needed. The web UI and the CLI
// share the daemon HTTP layer so neither can drift out of step.
async function runTemplates(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable templates list                                  List user-saved templates.
  readable templates save  <projectId> --name <name>      Snapshot a project's current
                                                    files as a new template.
                     [--description <text>]
  readable templates delete <id>                          Delete a saved template by id.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  let flags;
  try {
    flags = parseFlags(rest, { string: TEMPLATES_STRING_FLAGS, boolean: TEMPLATES_BOOLEAN_FLAGS });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const base = (await cliDaemonBaseUrl(flags));
  // Extract positional arguments while stepping past `--flag value`
  // pairs for any string-valued template flag. Without this the id has
  // to be the very first token after the sub-verb, so a headless caller
  // that prefixes shared options (`readable templates save --daemon-url ...
  // proj-1 --name Cards`) would hit the missing-id usage path before
  // ever reaching the daemon. Mirrors the `positionalArgs` helper in
  // `runAutomation`.
  const positionalArgs = (values) => {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!value) continue;
      if (value.startsWith('--')) {
        const eq = value.indexOf('=');
        const key = eq >= 0 ? value.slice(2, eq) : value.slice(2);
        if (eq < 0 && TEMPLATES_STRING_FLAGS.has(key)) i++;
        continue;
      }
      if (value.startsWith('-')) continue;
      out.push(value);
    }
    return out;
  };
  switch (sub) {
    case 'list': {
      // Wrap every fetch in try/catch so the user sees a clean
      // "failed to reach daemon at <url>: <code>" error from
      // surfaceFetchError when the daemon isn't running. Without
      // this Node throws a raw `TypeError: fetch failed`, which
      // matches the pattern the rest of the CLI uses
      // (runAutomation, the project verbs, runResearch).
      let resp;
      try {
        resp = await fetch(`${base}/api/templates`);
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const templates = Array.isArray(data?.templates) ? data.templates : [];
      if (templates.length === 0) {
        console.log('No templates. Save one with `readable templates save <projectId> --name "..."`.');
        return;
      }
      for (const t of templates) console.log(`${t.id}\t${t.name}`);
      return;
    }
    case 'save': {
      // Pull <projectId> from anywhere among the positional args
      // (`positionalArgs` already skipped past `--flag value` pairs)
      // so callers can put shared options before or after the id.
      const projectId = positionalArgs(rest)[0] ?? '';
      if (!projectId) {
        console.error('Usage: readable templates save <projectId> --name <name> [--description <text>]');
        process.exit(2);
      }
      const name = typeof flags.name === 'string' ? flags.name.trim() : '';
      if (!name) {
        console.error('--name required');
        process.exit(2);
      }
      const body = { name, sourceProjectId: projectId };
      if (typeof flags.description === 'string' && flags.description.length > 0) {
        body.description = flags.description;
      }
      let resp;
      try {
        resp = await fetch(`${base}/api/templates`, {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(body),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      // Templates POST returns 404 when sourceProjectId is unknown,
      // and 400 for body validation failures (missing name, too-long
      // fields). Both are reachable user errors with the daemon
      // already running, so default-classifying them as
      // `daemon-not-running` would send agents down the wrong recovery
      // branch. Map 404 → project-not-found and 400 → missing-input,
      // keep the default for 5xx so genuine daemon trouble still
      // surfaces as `daemon-not-running`.
      if (!resp.ok) {
        if (resp.status === 404) return structuredHttpFailure(resp, 'project-not-found');
        if (resp.status === 400) return structuredHttpFailure(resp, 'missing-input');
        return structuredHttpFailure(resp);
      }
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const id = data?.template?.id ?? '';
      const savedName = data?.template?.name ?? name;
      console.log(`[templates] saved ${savedName}${id ? ` (${id})` : ''}`);
      return;
    }
    case 'delete': {
      const id = positionalArgs(rest)[0] ?? '';
      if (!id) {
        console.error('Usage: readable templates delete <id>');
        process.exit(2);
      }
      let resp;
      try {
        resp = await fetch(`${base}/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      // The daemon route `DELETE /api/templates/:id` is intentionally
      // idempotent (returns `{ ok: true }` for unknown ids), so this
      // CLI verb mirrors that contract instead of inventing a
      // template-not-found exit code the production route never emits.
      // Any unexpected non-2xx still falls through to the generic
      // structured-failure envelope.
      if (!resp.ok) return structuredHttpFailure(resp);
      if (flags.json) {
        const data = await resp.json().catch(() => ({ ok: true }));
        return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      }
      console.log(`[templates] deleted ${id}`);
      return;
    }
    default:
      console.error(`unknown subcommand: readable templates ${sub}`);
      process.exit(2);
  }
}

async function runConversation(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable conversation new  <projectId> [--title "<title>"] [--seed-from <cid>] [--fork-after <mid>] [--mode design|chat]
                                           Create a conversation in a project.
                                           --seed-from copies another
                                           conversation's messages in (Side Chat).
                                           --fork-after stops the copy at one
                                           source message.
  readable conversation list <projectId>           List conversations in a project.
  readable conversation info <conversationId>      Print one conversation.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --identity-token-file <path|->
                       Hosted identity (or READABLE_HOSTED_IDENTITY_TOKEN_FILE).
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: PROJECT_STRING_FLAGS, boolean: PROJECT_BOOLEAN_FLAGS });
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  const client = await createContentCliClient(flags);
  switch (sub) {
    case 'new': {
      const [id] = positionalArgs(rest, PROJECT_STRING_FLAGS);
      if (!id) {
        console.error('Usage: readable conversation new <projectId> [--title "<title>"] [--seed-from <cid>] [--fork-after <mid>]');
        process.exit(2);
      }
      const body = {};
      if (typeof flags.title === 'string') body.title = flags.title;
      const sessionMode = normalizeChatSessionModeFlag(flags.mode);
      if (sessionMode) body.sessionMode = sessionMode;
      if (typeof flags['seed-from'] === 'string' && flags['seed-from']) {
        body.seedFromConversationId = flags['seed-from'];
      }
      if (typeof flags['fork-after'] === 'string' && flags['fork-after']) {
        if (!body.seedFromConversationId) {
          console.error('--fork-after requires --seed-from');
          process.exit(2);
        }
        body.forkAfterMessageId = flags['fork-after'];
      }
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/conversations`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      }, true);
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const conv = data.conversation;
      console.log(`[conversation] created ${conv?.id ?? '-'} (mode ${conv?.sessionMode ?? sessionMode ?? 'design'})`);
      return;
    }
    case 'list': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: readable conversation list <projectId>');
        process.exit(2);
      }
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/conversations`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    case 'info': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: readable conversation info <conversationId>');
        process.exit(2);
      }
      if (client.hosted) {
        console.error('hosted conversation info requires a project-scoped route; use conversation list');
        process.exit(2);
      }
      const resp = await client.request(`/api/conversations/${encodeURIComponent(id)}`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    default:
      console.error(`unknown subcommand: readable conversation ${sub}`);
      process.exit(2);
  }
}

function requireChatFlag(flags, name, usage) {
  const value = flags?.[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  console.error(usage);
  process.exit(2);
}

function normalizeRollbackMode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/-/g, '_');
  if (normalized === 'files_only' || normalized === 'chat_only' || normalized === 'files_and_chat') {
    return normalized;
  }
  return null;
}

function normalizeRollbackConflictPolicy(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/-/g, '_');
  if (normalized === 'fail' || normalized === 'overwrite' || normalized === 'keep_current') {
    return normalized;
  }
  return null;
}

function formatRollbackCliValue(value) {
  return String(value ?? '').replace(/_/g, '-');
}

function printChatCheckpoints(data) {
  const checkpoints = Array.isArray(data?.checkpoints) ? data.checkpoints : [];
  if (checkpoints.length === 0) {
    console.log('No chat checkpoints found.');
    return;
  }
  console.log('# id\tkind\tcreatedAt\tmessageId\trunId\tfiles\tbytes');
  for (const checkpoint of checkpoints) {
    console.log([
      checkpoint.id ?? '',
      checkpoint.kind ?? '',
      formatCheckpointTime(checkpoint.createdAt),
      checkpoint.messageId ?? '',
      checkpoint.runId ?? '',
      checkpoint.fileCount ?? 0,
      checkpoint.totalBytes ?? 0,
    ].join('\t'));
  }
}

function printChatCheckpointDiff(data) {
  const checkpoint = data?.checkpoint ?? {};
  const files = Array.isArray(data?.files) ? data.files : [];
  const conflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
  const counts = countCheckpointFileStatuses(files);
  console.log(`[chat checkpoint diff] ${checkpoint.id ?? '-'}`);
  if (checkpoint.messageId) console.log(`message\t${checkpoint.messageId}`);
  console.log(`files\t${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted, ${counts.unchanged} unchanged`);
  console.log(`conflicts\t${conflicts.length}`);
  if (files.length > 0) {
    console.log('# status\tpath');
    for (const file of files) {
      console.log(`${file.status ?? 'unknown'}\t${file.path ?? ''}`);
    }
  }
  if (conflicts.length > 0) {
    console.log('# conflict\treason\tpath');
    for (const conflict of conflicts) {
      console.log(`conflict\t${conflict.reason ?? ''}\t${conflict.path ?? ''}`);
    }
  }
}

function printChatRollbackResult(data, context) {
  const fileChanges = data?.fileChanges ?? {};
  const deletedMessageIds = Array.isArray(data?.deletedMessageIds) ? data.deletedMessageIds : [];
  const conflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
  const actor = data?.actor ?? 'user';
  console.log(`[chat rollback] restored ${data?.restoredCheckpointId ?? data?.targetMessageId ?? '-'} (actor: ${actor})`);
  console.log(`mode\t${formatRollbackCliValue(data?.mode)}`);
  console.log(`targetMessage\t${data?.targetMessageId ?? ''}`);
  console.log(`safetyCheckpoint\t${data?.safetyCheckpointId ?? ''}`);
  console.log(`files\t${fileChanges.added ?? 0} added, ${fileChanges.modified ?? 0} modified, ${fileChanges.deleted ?? 0} deleted, ${fileChanges.unchanged ?? 0} unchanged`);
  console.log(`deletedMessages\t${deletedMessageIds.length}`);
  console.log(`clearedAgentSessions\t${data?.clearedAgentSessions === true ? 'yes' : 'no'}`);
  console.log(`conflicts\t${conflicts.length}`);
  if (conflicts.length > 0) {
    console.log('# conflict\treason\tpath');
    for (const conflict of conflicts) {
      console.log(`conflict\t${conflict.reason ?? ''}\t${conflict.path ?? ''}`);
    }
  }
  if (data?.safetyCheckpointId && data?.mode !== 'chat_only') {
    // Recovery is always a fresh manual restore; opaque agent requests are
    // single-use. chat_only rollbacks have no file recovery path.
    console.log(`recovery\tod chat rollback --project ${context.projectId} --conversation ${context.conversationId} --message ${data.targetMessageId ?? '<messageId>'} --checkpoint ${data.safetyCheckpointId} --mode files-only`);
  }
}

function countCheckpointFileStatuses(files) {
  const counts = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
  for (const file of files) {
    const status = file?.status;
    if (status && status in counts) counts[status]++;
  }
  return counts;
}

function formatCheckpointTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value ?? '';
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

// ---------------------------------------------------------------------------
// Subcommand: readable chat  (Side Chat — context-seeded conversations)
//
// `readable chat new --project <id> [--seed-from <cid>] [--fork-after <mid>] [--title "<t>"] [--json]`
//   Creates a new conversation that inherits another conversation's context
//   by copying its messages, optionally truncating at one source message.
//   Mirrors the web chat fork action and POSTs to the same
//   /api/projects/:id/conversations endpoint the UI uses. This is the CLI half
//   of the dual-track surface for context-seeded conversations.
// ---------------------------------------------------------------------------

async function runChat(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable chat new --project <id> [--seed-from <cid>] [--fork-after <mid>] [--title "<title>"] [--mode design|chat] [--json]
                                           Create a Side Chat — a new conversation
                                           that copies in another conversation's
                                           context (--seed-from). Use
                                           --fork-after to stop at one source
                                           message.
  readable chat checkpoints --project <id> --conversation <id> [--json]
                                           List rollback checkpoints for one
                                           conversation.
  readable chat checkpoint diff --project <id> --checkpoint <id> [--json]
                                           Show file changes for one checkpoint.
  readable chat rollback --project <id> --conversation <id> --message <id>
                   --mode files-only|chat-only|files-and-chat
                   [--checkpoint <id>]
                   [--conflict-policy fail|overwrite|keep-current]
                   [--json]
                                           Restore files, chat history, or both
                                           through the daemon rollback API.
  readable chat rollback-request --project <id> --conversation <id> --run <runId>
                           --mode files-only
                           [--reason "..." | --prompt-file <path|->]
                           [--json]
                                           Request a files-only agent rollback
                                           for a run, returning an opaque
                                           request id and expiry.
  readable chat rollback-execute --project <id> --conversation <id>
                           --request <id>
                           [--conflict-policy fail|overwrite|keep-current]
                           [--json]
                                           Execute an opaque agent request after
                                           trusted desktop approval.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --identity-token-file <path|->
                       Hosted identity (or READABLE_HOSTED_IDENTITY_TOKEN_FILE).
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  let flags;
  try {
    flags = parseFlags(rest, { string: CHAT_STRING_FLAGS, boolean: CHAT_BOOLEAN_FLAGS });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  const client = await createContentCliClient(flags);
  switch (sub) {
    case 'new': {
      // Accept --project for parity with the rest of the project-scoped CLI,
      // or a bare positional id for convenience.
      const id = typeof flags.project === 'string' && flags.project
        ? flags.project
        : positionalArgs(rest, CHAT_STRING_FLAGS)[0];
      if (!id) {
        console.error('Usage: readable chat new --project <id> [--seed-from <cid>] [--fork-after <mid>] [--title "<title>"]');
        process.exit(2);
      }
      const body = {};
      if (typeof flags.title === 'string') body.title = flags.title;
      const sessionMode = normalizeChatSessionModeFlag(flags.mode);
      if (sessionMode) body.sessionMode = sessionMode;
      if (typeof flags['seed-from'] === 'string' && flags['seed-from']) {
        body.seedFromConversationId = flags['seed-from'];
      }
      if (typeof flags['fork-after'] === 'string' && flags['fork-after']) {
        if (!body.seedFromConversationId) {
          console.error('--fork-after requires --seed-from');
          process.exit(2);
        }
        body.forkAfterMessageId = flags['fork-after'];
      }
      const resp = await client.request(`/api/projects/${encodeURIComponent(id)}/conversations`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      }, true);
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const conv = data.conversation;
      const seeded = body.seedFromConversationId
        ? ` (seeded from ${body.seedFromConversationId})`
        : '';
      const forked = body.forkAfterMessageId
        ? ` through ${body.forkAfterMessageId}`
        : '';
      console.log(`[chat] created ${conv?.id ?? '-'}${conv?.title ? ` "${conv.title}"` : ''}${seeded}${forked} (mode ${conv?.sessionMode ?? sessionMode ?? 'design'})`);
      return;
    }
    case 'checkpoints': {
      const projectId = requireChatFlag(flags, 'project', 'Usage: readable chat checkpoints --project <id> --conversation <id> [--json]');
      const conversationId = requireChatFlag(flags, 'conversation', 'Usage: readable chat checkpoints --project <id> --conversation <id> [--json]');
      const query = new URLSearchParams({ conversationId }).toString();
      let resp;
      try {
        resp = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/checkpoints?${query}`);
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      printChatCheckpoints(data);
      return;
    }
    case 'checkpoint': {
      const action = positionalArgs(rest, CHAT_STRING_FLAGS)[0];
      if (action !== 'diff') {
        console.error('Usage: readable chat checkpoint diff --project <id> --checkpoint <id> [--json]');
        process.exit(2);
      }
      const projectId = requireChatFlag(flags, 'project', 'Usage: readable chat checkpoint diff --project <id> --checkpoint <id> [--json]');
      const checkpointId = requireChatFlag(flags, 'checkpoint', 'Usage: readable chat checkpoint diff --project <id> --checkpoint <id> [--json]');
      let resp;
      try {
        resp = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/diff?base=current`);
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      printChatCheckpointDiff(data);
      return;
    }
    case 'rollback': {
      const projectId = requireChatFlag(flags, 'project', 'Usage: readable chat rollback --project <id> --conversation <id> --message <id> --mode files-only|chat-only|files-and-chat [--checkpoint <id>] [--json]');
      const conversationId = requireChatFlag(flags, 'conversation', 'Usage: readable chat rollback --project <id> --conversation <id> --message <id> --mode files-only|chat-only|files-and-chat [--checkpoint <id>] [--json]');
      const targetMessageId = requireChatFlag(flags, 'message', 'Usage: readable chat rollback --project <id> --conversation <id> --message <id> --mode files-only|chat-only|files-and-chat [--checkpoint <id>] [--json]');
      const mode = normalizeRollbackMode(flags.mode);
      if (!mode) {
        console.error('--mode is required and must be one of: files-only | chat-only | files-and-chat');
        process.exit(2);
      }
      const conflictPolicy = normalizeRollbackConflictPolicy(flags['conflict-policy']);
      if (flags['conflict-policy'] && !conflictPolicy) {
        console.error('--conflict-policy must be one of: fail | overwrite | keep-current');
        process.exit(2);
      }
      if (flags.run) {
        console.error('--run is not supported for manual rollback; use rollback-execute --request <id>');
        process.exit(2);
      }
      const body = {
        targetMessageId,
        mode,
        conflictPolicy: conflictPolicy ?? 'fail',
        createSafetyCheckpoint: true,
      };
      if (typeof flags.checkpoint === 'string' && flags.checkpoint) {
        body.targetCheckpointId = flags.checkpoint;
      }
      let resp;
      try {
        resp = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      printChatRollbackResult(data, { projectId, conversationId });
      return;
    }
    case 'rollback-execute': {
      const usage = 'Usage: readable chat rollback-execute --project <id> --conversation <id> --request <id> [--conflict-policy fail|overwrite|keep-current] [--json]';
      const projectId = requireChatFlag(flags, 'project', usage);
      const conversationId = requireChatFlag(flags, 'conversation', usage);
      const requestId = requireChatFlag(flags, 'request', usage);
      const conflictPolicy = normalizeRollbackConflictPolicy(flags['conflict-policy']);
      if (flags['conflict-policy'] && !conflictPolicy) {
        console.error('--conflict-policy must be one of: fail | overwrite | keep-current');
        process.exit(2);
      }
      let resp;
      try {
        resp = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/agent-rollback-execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId, conflictPolicy: conflictPolicy ?? 'fail' }),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      printChatRollbackResult(data, { projectId, conversationId });
      return;
    }
    case 'rollback-request': {
      const usage = 'Usage: readable chat rollback-request --project <id> --conversation <id> --run <runId> --mode files-only [--reason "..." | --prompt-file <path|->] [--json]';
      const projectId = requireChatFlag(flags, 'project', usage);
      const conversationId = requireChatFlag(flags, 'conversation', usage);
      const runId = requireChatFlag(flags, 'run', usage);
      const mode = normalizeRollbackMode(flags.mode);
      if (!mode) {
        console.error('--mode is required and must be files-only');
        process.exit(2);
      }
      if (mode !== 'files_only') {
        console.error('--mode must be files-only for rollback-request');
        process.exit(2);
      }
      if (typeof flags.reason === 'string' && typeof flags['prompt-file'] === 'string') {
        console.error('--reason and --prompt-file cannot be used together');
        process.exit(2);
      }
      const reason = await readPromptFromFlags({
        prompt: flags.reason,
        'prompt-file': flags['prompt-file'],
      });
      const body = { runId, mode };
      if (reason) {
        body.reason = reason;
      }
      let resp;
      try {
        resp = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/agent-rollback-request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[chat rollback-request] target msg ${data?.targetMessageId ?? '-'}, checkpoint ${data?.targetCheckpointId ?? '-'}, mode ${formatRollbackCliValue(data?.mode)}`);
      console.log(`request\t${data?.requestId ?? ''}`);
      console.log(`expiresAt\t${formatCheckpointTime(data?.expiresAt)}`);
      if (data?.reason) {
        console.log(`reason\t${data.reason}`);
      }
      return;
    }
    default:
      console.error(`unknown subcommand: readable chat ${sub}`);
      process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: readable daemon  (Phase 1.5 lifecycle, plan §6 / §3.F2)
//
// `readable daemon start [--headless] [--serve-web] [--port <n>] [--host <addr>]`
//   - --headless: implies --no-open, never tries to launch a browser.
//                 The default `readable` (no subcommand) keeps its
//                 desktop-friendly behaviour for back-compat.
//   - --serve-web: same as --headless but allows the Next.js bundle to
//                  serve over the existing port. v1 doesn't bundle a
//                  separate web port; the flag is reserved so downstream
//                  packaged callers can branch on it.
//
// `readable daemon status [--json] [--daemon-url <url>]` calls /api/daemon/status.
// `readable daemon stop   [--daemon-url <url>]`         calls POST /api/daemon/shutdown.
// ---------------------------------------------------------------------------

async function runDaemon(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable daemon start [--headless] [--serve-web] [--port <n>] [--host <addr>] [--no-open]
                                          Start the daemon (Phase 1.5 headless mode).
  readable daemon status [--json] [--daemon-url <url>]
                                          Print the daemon's runtime snapshot.
  readable daemon stop   [--daemon-url <url>]   Send a graceful shutdown signal.
  readable daemon db     status                 Print SQLite path + size + table row counts.
  readable daemon db     verify [--quick]       Run integrity_check + foreign_key_check.
  readable daemon db     vacuum                 Run SQLite VACUUM to reclaim space after deletes.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --headless           No browser auto-open; aliased --no-open.
  --serve-web          Serve the web UI over the existing port (no electron).
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: DAEMON_STRING_FLAGS, boolean: DAEMON_BOOLEAN_FLAGS });
  switch (sub) {
    case 'start':   return runDaemonStart(flags);
    case 'status':  return runDaemonStatus(flags);
    case 'stop':    return runDaemonStop(flags);
    case 'db':      return runDaemonDb(rest, flags);
    default:
      console.error(`unknown subcommand: readable daemon ${sub}`);
      process.exit(2);
  }
}

// Plan §3.GG1 — `readable daemon db status`. Prints a SQLite inventory
// (file path, size on disk, schema version, per-table row counts).
async function runDaemonDb(rest, flags) {
  const sub = rest[0];
  if (!sub || sub === 'help' || rest.includes('--help') || rest.includes('-h')) {
    console.log(`Usage:
  readable daemon db status [--json] [--daemon-url <url>]
  readable daemon db verify [--quick] [--json] [--daemon-url <url>]
  readable daemon db vacuum [--json] [--daemon-url <url>]

status:
  Prints a structured inventory of the daemon's SQLite backend:
    - file path (under .readable-studio/ by default; READABLE_DATA_DIR overrides)
    - size on disk (primary + WAL + SHM)
    - schema version (user_version PRAGMA)
    - per-table row counts (system tables excluded)

verify:
  Runs SQLite PRAGMA integrity_check (or quick_check with --quick)
  + foreign_key_check, returns a structured issues[] report.
  Exit 0 when ok=true, 4 when any issue is found.

vacuum:
  Runs SQLite VACUUM to reclaim space after large delete batches
  (snapshot prune, plugin uninstall, etc.). Reports before/after
  sizes + elapsed ms.`);
    process.exit(sub ? 0 : 2);
  }
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  if (sub === 'vacuum') {
    const resp = await fetch(`${base}/api/daemon/db/vacuum`, { method: 'POST' });
    if (!resp.ok) {
      console.error(`POST /api/daemon/db/vacuum failed: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
    const data = await resp.json();
    if (flags.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    console.log(`[db vacuum] reclaimed ${formatBytes(data.reclaimedBytes ?? 0)} (`
      + `${formatBytes(data.beforeBytes ?? 0)} \u2192 ${formatBytes(data.afterBytes ?? 0)}, `
      + `${data.elapsedMs ?? 0}ms)`);
    return;
  }
  if (sub === 'verify') {
    const verifyFlags = parseFlags(rest.slice(1), {
      string:  new Set(['daemon-url']),
      boolean: new Set(['help', 'h', 'json', 'quick']),
    });
    const url = `${base}/api/daemon/db/verify${verifyFlags.quick ? '?quick=1' : ''}`;
    const resp = await fetch(url, { method: 'POST' });
    if (!resp.ok) {
      console.error(`POST ${url} failed: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
    const data = await resp.json();
    if (flags.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      const issueCount = Array.isArray(data.issues) ? data.issues.length : 0;
      console.log(`[db verify] mode=${data.mode}  ok=${data.ok}  issues=${issueCount}  ${data.elapsedMs ?? 0}ms`);
      if (issueCount > 0) {
        for (const issue of data.issues) {
          console.error(`  [${issue.kind}] ${issue.message}`);
        }
      }
    }
    process.exit(data.ok ? 0 : 4);
  }
  if (sub !== 'status') {
    console.error(`unknown subcommand: readable daemon db ${sub}`);
    process.exit(2);
  }
  const resp = await fetch(`${base}/api/daemon/db`);
  if (!resp.ok) {
    console.error(`GET /api/daemon/db failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  console.log(`# Daemon DB`);
  console.log(`  kind:           ${data.kind ?? 'unknown'}`);
  console.log(`  location:       ${data.location ?? '?'}`);
  console.log(`  size on disk:   ${formatBytes(data.sizeBytes ?? 0)}`);
  console.log(`  schema version: ${data.schemaVersion ?? '(none)'}`);
  console.log(`  tables:`);
  const tables = Array.isArray(data.tables) ? data.tables : [];
  if (tables.length === 0) {
    console.log('    (none)');
  } else {
    const longest = Math.max(...tables.map((t) => t.name.length));
    for (const t of tables) {
      console.log(`    ${t.name.padEnd(longest)}  ${t.rowCount}`);
    }
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

async function runDaemonStart(flags) {
  const port = Number(flags.port ?? process.env[SIDECAR_ENV.DAEMON_PORT] ?? 7456);
  const host = String(flags.host ?? process.env.READABLE_BIND_HOST ?? '127.0.0.1');
  const headless = Boolean(flags.headless || flags['no-open'] || flags['serve-web']);
  const runtime = await startDaemonRuntime({
    host,
    logListening: false,
    openBrowser: !headless,
    port,
  });
  console.log(`[readable] listening on ${runtime.url} (${headless ? 'headless' : 'desktop'})`);

  await new Promise((resolve) => {
    let shuttingDown = false;
    const stop = () => {
      if (shuttingDown) process.exit(0);
      shuttingDown = true;
      void runtime.stop().finally(() => {
        cleanup();
        resolve();
      });
    };
    const cleanup = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

async function runDaemonStatus(flags) {
  const base = await cliDaemonBaseUrl(flags);
  let resp;
  try {
    resp = await fetch(`${base}/api/daemon/status`);
  } catch (err) {
    return exitWithStructuredError({
      code:    'daemon-not-running',
      message: `Cannot reach daemon at ${base}: ${err?.message ?? err}`,
    });
  }
  if (!resp.ok) return structuredHttpFailure(resp);
  const data = await resp.json();
  if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  console.log(`[daemon] ${data.bindHost}:${data.port} v${data.version} pid=${data.pid} plugins=${data.installedPlugins}`);
}

async function runDaemonStop(flags) {
  const base = await cliDaemonBaseUrl(flags);
  let resp;
  try {
    resp = await fetch(`${base}/api/daemon/shutdown`, { method: 'POST' });
  } catch (err) {
    return exitWithStructuredError({
      code:    'daemon-not-running',
      message: `Cannot reach daemon at ${base}: ${err?.message ?? err}`,
    });
  }
  if (!resp.ok) return structuredHttpFailure(resp);
  console.log(`[daemon] shutdown scheduled`);
}

// ---------------------------------------------------------------------------
// Subcommand: readable atoms / readable skills / readable design-systems / readable craft / readable status
//
// Plan §3.H2 / §3.H3 / spec §12.2 — design-library + status introspection
// CLI parity. Every UI feature reachable via /api/* gets a CLI mirror
// (the §11.7 "headless = canonical" invariant).
// ---------------------------------------------------------------------------

async function libraryDaemonUrl(flags) {
  return cliDaemonUrl(flags);
}

async function runAtoms(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable atoms list             List first-party atoms (implemented + planned).
  readable atoms show <id>        Print one atom's metadata.
  readable atoms info <id>        Print metadata + the bundled SKILL.md body.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: LIBRARY_STRING_FLAGS, boolean: LIBRARY_BOOLEAN_FLAGS });
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  switch (sub) {
    case 'list': {
      const resp = await fetch(`${base}/api/atoms`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const atoms = data?.atoms ?? [];
      for (const a of atoms) {
        console.log(`${a.id}\t${a.status}\t[${(a.taskKinds ?? []).join(', ')}]\t${a.label}`);
      }
      return;
    }
    case 'show': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: readable atoms show <id>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/atoms`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      const atom = (data?.atoms ?? []).find((a) => a.id === id);
      if (!atom) {
        console.error(`atom ${id} not found`);
        process.exit(65);
      }
      process.stdout.write(JSON.stringify(atom, null, 2) + '\n');
      return;
    }
    case 'info': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: readable atoms info <id>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/atoms/${encodeURIComponent(id)}`);
      if (resp.status === 404) {
        console.error(`atom ${id} not found`);
        process.exit(65);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const atom = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(atom, null, 2) + '\n');
      console.log(`# ${atom.label} (${atom.id})`);
      console.log(`status:    ${atom.status}`);
      console.log(`taskKinds: ${(atom.taskKinds ?? []).join(', ')}`);
      console.log(`summary:   ${atom.description}`);
      if (typeof atom.skillBody === 'string' && atom.skillBody.length > 0) {
        console.log('');
        console.log('--- SKILL.md ---');
        console.log(atom.skillBody.trimEnd());
      } else {
        console.log('');
        console.log('(no bundled SKILL.md body found for this atom)');
      }
      return;
    }
    default:
      console.error(`unknown subcommand: readable atoms ${sub}`);
      process.exit(2);
  }
}

async function runLibraryList(name, args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable ${name} list           List ${name}.
  readable ${name} show <id>      Print one entry.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: LIBRARY_STRING_FLAGS, boolean: LIBRARY_BOOLEAN_FLAGS });
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  const apiPath = name === 'design-systems' ? '/api/design-systems' : `/api/${name}`;
  switch (sub) {
    case 'list': {
      const resp = await fetch(`${base}${apiPath}`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const rows = data?.[name === 'design-systems' ? 'designSystems' : name] ?? [];
      for (const row of rows) {
        const label = row.title ?? row.name ?? row.id ?? row.label;
        console.log(`${row.id}\t${label}`);
      }
      return;
    }
    case 'show': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error(`Usage: readable ${name} show <id>`);
        process.exit(2);
      }
      const resp = await fetch(`${base}${apiPath}/${encodeURIComponent(id)}`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    default:
      console.error(`unknown subcommand: readable ${name} ${sub}`);
      process.exit(2);
  }
}

async function runSkills(args)        { return runLibraryList('skills', args); }
async function runCraft(args)         { return runLibraryList('craft', args); }

async function runFonts(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable fonts list            List fonts installed on this machine.

Options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --refresh            Rescan installed fonts (bypass the daemon cache).
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, {
    string: LIBRARY_STRING_FLAGS,
    boolean: new Set([...LIBRARY_BOOLEAN_FLAGS, 'refresh']),
  });
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  switch (sub) {
    case 'list': {
      const resp = await fetch(`${base}/api/system/fonts${flags.refresh ? '?refresh=1' : ''}`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const fonts = data?.fonts ?? [];
      if (fonts.length === 0) {
        console.log(`(no system fonts enumerated; platform: ${data?.platform ?? 'unknown'})`);
        return;
      }
      for (const fam of fonts) {
        const faces = fam.faces ?? [];
        const weights = [
          ...new Set(faces.map((f) => `${f.weight}${f.style === 'italic' ? 'i' : ''}`)),
        ].join(',');
        console.log(`${fam.family}\t${faces.length} face(s)\t${weights}`);
      }
      return;
    }
    default:
      console.error(`unknown subcommand: readable fonts ${sub}`);
      process.exit(2);
  }
}

async function runDesignSystems(args) {
  if (args[0] === 'rename') return runDesignSystemRename(args.slice(1));
  if (args[0] === 'import-local') return runDesignSystemImportLocal(args.slice(1));
  if (args[0] === 'import-github') return runDesignSystemImportGithub(args.slice(1));
  if (args[0] === 'import-shadcn') return runDesignSystemImportShadcn(args.slice(1));
  if (args[0] === 'rebuild-token-contract') return runDesignSystemTokenContractRebuild(args.slice(1));
  if (!args[0] || isDesignSystemsHelpArg(args[0])) {
    console.log(DESIGN_SYSTEMS_USAGE);
    process.exit(isDesignSystemsHelpArg(args[0]) ? 0 : 2);
  }
  return runLibraryList('design-systems', args);
}

// readable design-systems import-local <path> [--name <name>]
//   [--import-mode <mode>] [--craft <slug,slug>] [--json] [--daemon-url <url>]
//
// Imports a local app/design-system project through the same daemon endpoint as
// the Settings UI. The CLI resolves relative paths before sending the request
// because the daemon intentionally accepts only absolute host paths.
async function runDesignSystemImportLocal(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable design-systems import-local <path> [--name <name>] [--import-mode <mode>] [--craft <slugs>] [--json] [--daemon-url <url>]
  readable design-systems import-local --path <path> [--name <name>] [--json]

Imports a local project directory as an editable Readable Studio design system.

  <path>                 Local project directory to scan.
  --path <path>          Path alternative for scripts that prefer named flags.
  --name <name>          Display name override for the imported system.
  --import-mode <mode>   normalized | hybrid | verbatim (default hybrid).
  --craft <slugs>        Comma-separated craft sections to apply (e.g. color,type).`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const stringFlags = new Set([...LIBRARY_STRING_FLAGS, 'path', 'name', 'import-mode', 'craft']);
  const flags = parseFlags(args, { string: stringFlags, boolean: LIBRARY_BOOLEAN_FLAGS });
  const localPath = typeof flags.path === 'string' ? flags.path : positionalArgs(args, stringFlags)[0];
  if (!localPath) {
    console.error('Usage: readable design-systems import-local <path>');
    process.exit(2);
  }
  const pathModule = await import('node:path');
  const body = designSystemImportRequestBody(flags, {
    baseDir: pathModule.resolve(localPath),
  });
  return postDesignSystemImport(flags, '/api/design-systems/import/local', body);
}

// readable design-systems import-github <url> [--branch <branch>] [--name <name>]
//   [--import-mode <mode>] [--craft <slug,slug>] [--json] [--daemon-url <url>]
async function runDesignSystemImportGithub(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable design-systems import-github <url> [--branch <branch>] [--name <name>] [--import-mode <mode>] [--craft <slugs>] [--json] [--daemon-url <url>]
  readable design-systems import-github --url <url> [--branch <branch>] [--json]

Imports a public GitHub repository as an editable Readable Studio design system.

  <url>                  Repository root URL, e.g. https://github.com/acme/design-kit.
  --url <url>            URL alternative for scripts that prefer named flags.
  --branch <branch>      Branch, tag, or ref to clone.
  --name <name>          Display name override for the imported system.
  --import-mode <mode>   normalized | hybrid | verbatim (default hybrid).
  --craft <slugs>        Comma-separated craft sections to apply (e.g. color,type).`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const stringFlags = new Set([...LIBRARY_STRING_FLAGS, 'url', 'branch', 'name', 'import-mode', 'craft']);
  const flags = parseFlags(args, { string: stringFlags, boolean: LIBRARY_BOOLEAN_FLAGS });
  const url = typeof flags.url === 'string' ? flags.url : positionalArgs(args, stringFlags)[0];
  if (!url) {
    console.error('Usage: readable design-systems import-github <url>');
    process.exit(2);
  }
  const body = designSystemImportRequestBody(flags, {
    url,
    ...(typeof flags.branch === 'string' ? { branch: flags.branch } : {}),
  });
  return postDesignSystemImport(flags, '/api/design-systems/import/github', body);
}

function designSystemImportRequestBody(flags, baseBody) {
  const craftApplies =
    typeof flags.craft === 'string'
      ? flags.craft.split(',').map((slug) => slug.trim().toLowerCase()).filter(Boolean)
      : undefined;
  return {
    ...baseBody,
    ...(typeof flags.name === 'string' ? { name: flags.name } : {}),
    ...(typeof flags['import-mode'] === 'string' ? { importMode: flags['import-mode'] } : {}),
    ...(craftApplies && craftApplies.length > 0 ? { craftApplies } : {}),
  };
}

async function postDesignSystemImport(flags, endpoint, body) {
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  const resp = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return structuredHttpFailure(resp);
  const data = await resp.json();
  if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  const imported = data.designSystem ?? data;
  console.log(`Imported ${imported.id ?? '(unknown id)'}${imported.title ? ` -> ${imported.title}` : ''}`);
  if (data.tokenContractRebuild?.job) {
    console.log(`Token contract rebuild queued: ${data.tokenContractRebuild.job.id}`);
  } else if (data.tokenContractRebuild?.decision?.reason) {
    console.log(`Token contract rebuild: ${data.tokenContractRebuild.decision.reason}`);
  }
}

// readable design-systems rebuild-token-contract <id> [--force] [--json]
//
// Starts the same review-gated token contract rebuild job exposed in the web
// design-system detail view. Without --force the daemon only queues a job when
// source/token-contract.report.json recommends it.
async function runDesignSystemTokenContractRebuild(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable design-systems rebuild-token-contract <id> [--force] [--json] [--daemon-url <url>]

Starts a review-gated TOKEN_SCHEMA token contract rebuild for an editable imported design system.

  <id>       Editable design-system id, e.g. user:acme-product.
  --force    Queue the review even when the quality report is already usable.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const flags = parseFlags(args, {
    string: LIBRARY_STRING_FLAGS,
    boolean: new Set([...LIBRARY_BOOLEAN_FLAGS, 'force']),
  });
  const id = positionalArgs(args, LIBRARY_STRING_FLAGS)[0];
  if (!id) {
    console.error('Usage: readable design-systems rebuild-token-contract <id>');
    process.exit(2);
  }
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  const resp = await fetch(`${base}/api/design-systems/${encodeURIComponent(id)}/token-contract/rebuild-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: flags.force === true }),
  });
  if (!resp.ok) return structuredHttpFailure(resp);
  const data = await resp.json();
  if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  if (data.job) {
    console.log(`Token contract rebuild queued for ${id}: ${data.job.id}`);
    return;
  }
  const decision = data.decision;
  console.log(`Token contract rebuild not queued for ${id}: ${decision?.reason ?? 'no rebuild needed'}`);
}

// readable design-systems import-shadcn <reference> [--name <name>]
//   [--import-mode <mode>] [--craft <slug,slug>] [--json] [--daemon-url <url>]
//
// Imports a shadcn registry item as an editable user design system via
// POST /api/design-systems/import/shadcn — the CLI mirror of the Settings →
// Design systems "shadcn" import source. <reference> is the shadcn CLI
// shorthand "<owner>/<repo>/<item>" (e.g. shadcn/ui/theme-zinc) or a direct
// https URL to a registry-item JSON document.
async function runDesignSystemImportShadcn(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable design-systems import-shadcn <reference> [--name <name>] [--import-mode <mode>] [--craft <slugs>] [--json] [--daemon-url <url>]

Imports a shadcn registry item as a Readable Studio design system.

  <reference>            "<owner>/<repo>/<item>" (e.g. shadcn/ui/theme-zinc)
                         or an https URL to a registry-item JSON document.
  --name <name>          Display name override for the imported system.
  --import-mode <mode>   normalized | hybrid | verbatim (default hybrid).
  --craft <slugs>        Comma-separated craft sections to apply (e.g. color,type).`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const stringFlags = new Set([...LIBRARY_STRING_FLAGS, 'name', 'import-mode', 'craft']);
  const flags = parseFlags(args, { string: stringFlags, boolean: LIBRARY_BOOLEAN_FLAGS });
  const reference = positionalArgs(args, stringFlags)[0];
  if (!reference) {
    console.error('Usage: readable design-systems import-shadcn <reference>');
    process.exit(2);
  }
  const body = designSystemImportRequestBody(flags, { reference });
  return postDesignSystemImport(flags, '/api/design-systems/import/shadcn', body);
}

// readable design-systems rename <id> --title <new-title> [--json]
// Renames an editable (user-created) design system via PATCH
// /api/design-systems/:id. Built-in systems are read-only and the daemon
// returns 404, surfaced here as a structured failure. Arg parsing lives in
// design-system-rename-args.ts so it can be unit-tested.
async function runDesignSystemRename(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable design-systems rename <id> --title <new-title> [--json] [--daemon-url <url>]
  readable design-systems rename <id> "<new title>" [--json]

Renames an editable (user-created) design system. Built-in systems are read-only.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const parsed = parseDesignSystemRenameArgs(args);
  if (!parsed) {
    console.error('Usage: readable design-systems rename <id> --title <new-title>');
    process.exit(2);
  }
  const flags = parseFlags(args, {
    string: new Set([...LIBRARY_STRING_FLAGS, 'title']),
    boolean: LIBRARY_BOOLEAN_FLAGS,
  });
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  const resp = await fetch(`${base}/api/design-systems/${encodeURIComponent(parsed.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: parsed.title }),
  });
  if (!resp.ok) return structuredHttpFailure(resp);
  const data = await resp.json();
  if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  const renamed = data.designSystem ?? data;
  console.log(`Renamed ${parsed.id} -> ${renamed.title ?? parsed.title}`);
}

async function runStatus(args) {
  // Alias of `readable daemon status`.
  return runDaemon(['status', ...args]);
}

// ---------------------------------------------------------------------------
// Subcommand: readable diagnostics export <path> [--json]
//
// CLI surface for the Settings → About “Export diagnostics” feature. The
// daemon already exposes the bundle behind a local-loopback HTTP endpoint;
// this command is a thin shell over that endpoint so headless callers (CI,
// `readable doctor` follow-ups, shell scripts) can collect a support bundle
// without driving the web UI.
// ---------------------------------------------------------------------------

async function runDiagnostics(args) {
  const sub = args[0];
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable diagnostics export [<path>] [--output <path>] [--json] [--daemon-url <url>]

Bundles daemon/web/desktop logs, machine info, and recent crash reports
into a zip. The bundle is the same one Settings → About → Export
diagnostics produces.

  <path>                 Where to write the zip. Defaults to
                         ./readable-studio-diagnostics-<timestamp>.zip in the
                         current working directory. Alias: --output <path>.
  --json                 Print {path, sizeBytes} on stdout instead of a
                         human-readable summary. The file is still written
                         to <path>.
  --daemon-url <url>     Override the daemon HTTP base URL.`);
    process.exit(0);
  }
  if (sub !== 'export') {
    console.error(`unknown subcommand: readable diagnostics ${sub}`);
    process.exit(2);
  }

  const flags = parseFlags(args.slice(1), {
    string: DIAGNOSTICS_STRING_FLAGS,
    boolean: DIAGNOSTICS_BOOLEAN_FLAGS,
  });
  const positional = args.slice(1).filter((a) => !a.startsWith('-'));
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');

  const { DIAGNOSTICS_EXPORT_PATH, DIAGNOSTICS_FILENAME_PREFIX, diagnosticsFileName } =
    await import('@readable-studio/diagnostics');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const explicitOutput = typeof flags.output === 'string' && flags.output.length > 0
    ? flags.output
    : positional[0];
  const targetPath = path.resolve(explicitOutput ?? diagnosticsFileName(DIAGNOSTICS_FILENAME_PREFIX));

  let resp;
  try {
    resp = await fetch(`${base}${DIAGNOSTICS_EXPORT_PATH}`);
  } catch (err) {
    return exitWithStructuredError({
      code:    'daemon-not-running',
      message: `Cannot reach daemon at ${base}: ${err?.message ?? err}`,
    });
  }
  if (!resp.ok) return structuredHttpFailure(resp);

  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, buf);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ path: targetPath, sizeBytes: buf.length }) + '\n');
    return;
  }
  console.log(`Wrote diagnostics bundle to ${targetPath} (${buf.length} bytes).`);
}

async function runVersion(args) {
  const flags = parseFlags(args, { string: LIBRARY_STRING_FLAGS, boolean: LIBRARY_BOOLEAN_FLAGS });
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  let resp;
  try {
    resp = await fetch(`${base}/api/version`);
  } catch (err) {
    return exitWithStructuredError({
      code:    'daemon-not-running',
      message: `Cannot reach daemon at ${base}: ${err?.message ?? err}`,
    });
  }
  if (!resp.ok) return structuredHttpFailure(resp);
  const data = await resp.json();
  if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  const version = typeof data?.version === 'string'
    ? data.version
    : (data?.version?.version ?? JSON.stringify(data));
  console.log(version);
}

// ---------------------------------------------------------------------------
// Subcommand: readable doctor / readable config (Phase 4 CLI parity tail).
//
// Plan §3.I2 / spec §12.2.
//
// `readable doctor` — repo-wide diagnostics. Hits /api/daemon/status, lists
// installed plugins + runs the per-plugin doctor, lists skills /
// design-systems / craft / atoms. Exits non-zero when any plugin
// doctor returns ok=false. Useful in CI: a failed exit causes the
// pipeline to surface plugin-system regressions.
//
// `readable config get/set/list/unset` — wraps GET/PUT /api/app-config so a
// code agent can flip provider keys / agent settings / pet config
// without leaving the terminal. JSON values pass through unchanged;
// scalar strings/numbers/booleans are coerced.
// ---------------------------------------------------------------------------

async function runDoctor(args) {
  const flags = parseFlags(args, { string: CONFIG_STRING_FLAGS, boolean: CONFIG_BOOLEAN_FLAGS });
  if (flags.help || flags.h) {
    console.log(`Usage:
  readable doctor [--json]   Print a daemon + plugin + design-library health summary.

Exit code is non-zero when any installed plugin's doctor returns ok=false
or the daemon cannot be reached.`);
    process.exit(0);
  }
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  const report = {
    daemon:        null,
    plugins:       [],
    skills:        [],
    designSystems: [],
    atoms:         [],
    issues:        [],
  };

  // Daemon status
  try {
    const resp = await fetch(`${base}/api/daemon/status`);
    if (!resp.ok) {
      report.issues.push({ severity: 'error', code: 'daemon-status', message: `HTTP ${resp.status}` });
    } else {
      report.daemon = await resp.json();
    }
  } catch (err) {
    report.issues.push({ severity: 'error', code: 'daemon-not-running', message: String(err?.message ?? err) });
    if (flags.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      console.error('[doctor] daemon unreachable:', String(err?.message ?? err));
    }
    process.exit(64);
  }

  // Library inventory
  try {
    const [skillsResp, dsResp, atomsResp] = await Promise.all([
      fetch(`${base}/api/skills`),
      fetch(`${base}/api/design-systems`),
      fetch(`${base}/api/atoms`),
    ]);
    if (skillsResp.ok) {
      const data = await skillsResp.json();
      report.skills = data?.skills ?? [];
    }
    if (dsResp.ok) {
      const data = await dsResp.json();
      report.designSystems = data?.designSystems ?? [];
    }
    if (atomsResp.ok) {
      const data = await atomsResp.json();
      report.atoms = data?.atoms ?? [];
    }
  } catch (err) {
    report.issues.push({ severity: 'warn', code: 'library-list-failed', message: String(err?.message ?? err) });
  }

  // Plugin doctor — runs the daemon's per-plugin check on every install.
  try {
    const listResp = await fetch(`${base}/api/plugins`);
    if (listResp.ok) {
      const list = await listResp.json();
      const plugins = list?.plugins ?? [];
      for (const p of plugins) {
        try {
          const doctorResp = await fetch(`${base}/api/plugins/${encodeURIComponent(p.id)}/doctor`, { method: 'POST' });
          const data = await doctorResp.json().catch(() => ({}));
          report.plugins.push({ id: p.id, version: p.version, ok: !!data?.ok, issues: data?.issues ?? [] });
          if (!data?.ok) {
            report.issues.push({
              severity: 'error',
              code:     'plugin-doctor-failed',
              message:  `${p.id}@${p.version}: ${(data?.issues ?? []).map((i) => i.code).join(', ')}`,
            });
          }
        } catch (err) {
          report.issues.push({
            severity: 'warn',
            code:     'plugin-doctor-error',
            message:  `${p.id}: ${err?.message ?? err}`,
          });
        }
      }
    }
  } catch (err) {
    report.issues.push({ severity: 'warn', code: 'plugin-list-failed', message: String(err?.message ?? err) });
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(`[doctor] daemon ${report.daemon?.bindHost ?? '?'}:${report.daemon?.port ?? '?'} pid=${report.daemon?.pid ?? '?'}`);
    console.log(`[doctor] plugins: ${report.plugins.length} (skills ${report.skills.length}, design-systems ${report.designSystems.length}, atoms ${report.atoms.length})`);
    if (report.issues.length === 0) {
      console.log('[doctor] no issues');
    } else {
      for (const i of report.issues) {
        console.log(`  [${i.severity}] ${i.code}: ${i.message}`);
      }
    }
  }
  const hasError = report.issues.some((i) => i.severity === 'error');
  process.exit(hasError ? 1 : 0);
}

async function runConfig(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  readable config list                      Print the full app config as JSON.
  readable config get <key>                 Print one top-level key.
  readable config set <key> <value>         Set a top-level key (string / number / boolean).
  readable config set <key> --value-json '<json>'
                                       Set a key to a JSON value.
  readable config unset <key>               Remove a top-level key.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: CONFIG_STRING_FLAGS, boolean: CONFIG_BOOLEAN_FLAGS });
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');

  const fetchConfig = async () => {
    const resp = await fetch(`${base}/api/app-config`);
    if (!resp.ok) return structuredHttpFailure(resp);
    const data = await resp.json();
    return data?.config ?? {};
  };
  const writeConfig = async (next) => {
    const resp = await fetch(`${base}/api/app-config`, {
      method:  'PUT',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(next),
    });
    if (!resp.ok) return structuredHttpFailure(resp);
    return (await resp.json())?.config ?? next;
  };

  switch (sub) {
    case 'list': {
      const cfg = await fetchConfig();
      process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
      return;
    }
    case 'get': {
      const key = rest.find((a) => !a.startsWith('-'));
      if (!key) {
        console.error('Usage: readable config get <key>');
        process.exit(2);
      }
      const cfg = await fetchConfig();
      const value = cfg?.[key];
      if (flags.json) {
        process.stdout.write(JSON.stringify(value ?? null, null, 2) + '\n');
      } else {
        console.log(value === undefined ? '' : (typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
      }
      return;
    }
    case 'set': {
      const positional = rest.filter((a) => !a.startsWith('-')
        && a !== flags.value
        && a !== flags['value-json']);
      const [key, scalarValue] = positional;
      if (!key) {
        console.error('Usage: readable config set <key> <value> | readable config set <key> --value-json <json>');
        process.exit(2);
      }
      let parsed;
      if (typeof flags['value-json'] === 'string') {
        try { parsed = JSON.parse(flags['value-json']); } catch (err) {
          console.error(`--value-json must be valid JSON: ${err.message}`);
          process.exit(2);
        }
      } else if (typeof flags.value === 'string') {
        parsed = coerceCliValue(flags.value);
      } else if (scalarValue !== undefined) {
        parsed = coerceCliValue(scalarValue);
      } else {
        console.error('Provide a value (positional, --value, or --value-json).');
        process.exit(2);
      }
      const cfg = await fetchConfig();
      const next = { ...cfg, [key]: parsed };
      const written = await writeConfig(next);
      if (flags.json) {
        process.stdout.write(JSON.stringify(written, null, 2) + '\n');
      } else {
        console.log(`[config] set ${key}`);
      }
      return;
    }
    case 'unset': {
      const key = rest.find((a) => !a.startsWith('-'));
      if (!key) {
        console.error('Usage: readable config unset <key>');
        process.exit(2);
      }
      const cfg = await fetchConfig();
      const next = { ...cfg };
      delete next[key];
      const written = await writeConfig(next);
      if (flags.json) {
        process.stdout.write(JSON.stringify(written, null, 2) + '\n');
      } else {
        console.log(`[config] unset ${key}`);
      }
      return;
    }
    default:
      console.error(`unknown subcommand: readable config ${sub}`);
      process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: readable agent …
// ---------------------------------------------------------------------------

async function runAgent(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printAgentHelp();
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: AGENT_STRING_FLAGS, boolean: AGENT_BOOLEAN_FLAGS });
  const base = await cliDaemonBaseUrl(flags);
  const useJson = Boolean(flags.json);

  const fetchConfig = async () => {
    const resp = await fetch(`${base}/api/app-config`);
    if (!resp.ok) return structuredHttpFailure(resp);
    const data = await resp.json();
    return data?.config ?? {};
  };
  const writeConfig = async (next) => {
    const resp = await fetch(`${base}/api/app-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (!resp.ok) return structuredHttpFailure(resp);
    return (await resp.json())?.config ?? next;
  };

  switch (sub) {
    case 'list': {
      const resp = await fetch(`${base}/api/agents`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (useJson) {
        process.stdout.write(JSON.stringify(data ?? { agents: [] }, null, 2) + '\n');
      } else {
        const agents = Array.isArray(data?.agents) ? data.agents : [];
        for (const agent of agents) {
          console.log(`${agent.id}\t${agent.available ? 'available' : 'unavailable'}\t${agent.name ?? ''}`);
        }
      }
      return;
    }
    case 'enable':
    case 'disable': {
      const ids = positionalArgs(rest, AGENT_STRING_FLAGS);
      if (ids.length === 0) {
        console.error(`Usage: readable agent ${sub} <id> [<id>...]`);
        process.exit(2);
      }
      const cfg = await fetchConfig();
      const { validateEnabledAgentIds } = await import('./app-config.js');
      const normalized = validateEnabledAgentIds(ids) ?? [];
      const current = new Set(Array.isArray(cfg.enabledAgentIds) ? cfg.enabledAgentIds : []);
      for (const id of normalized) {
        if (sub === 'enable') current.add(id);
        else current.delete(id);
      }
      const written = await writeConfig({ enabledAgentIds: Array.from(current) });
      if (useJson) {
        process.stdout.write(JSON.stringify(written, null, 2) + '\n');
      } else {
        console.log(`[agent] ${sub}d ${normalized.join(', ')}`);
      }
      return;
    }
    case 'reset': {
      const written = await writeConfig({ enabledAgentIds: null });
      if (useJson) {
        process.stdout.write(JSON.stringify(written, null, 2) + '\n');
      } else {
        console.log('[agent] reset enabled agents to defaults');
      }
      return;
    }
    default:
      console.error(`unknown subcommand: readable agent ${sub}`);
      process.exit(2);
  }
}

function printAgentHelp() {
  console.log(`Usage:
  readable agent list [--json]
      List enabled agents and their install status.

  readable agent enable <id> [<id>...] [--json]
      Add agents to the enabled scan set.

  readable agent disable <id> [<id>...] [--json]
      Remove agents from the enabled scan set.

  readable agent reset [--json]
      Clear the enabled set and fall back to defaults (codex + cursor-agent).

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --json               Emit raw JSON.`);
}

// ---------------------------------------------------------------------------
// Subcommand: readable memory …
//
// Headless surface for the same editable markdown memory tree shown in
// Settings. Agents can inspect what will be injected into future prompts,
// edit a node, or move a node between memory buckets without scraping the UI.
// ---------------------------------------------------------------------------

function printMemoryHelp() {
  console.log(`Usage:
  readable memory tree list [--json]
      List derived memory-tree folders and entry nodes.

  readable memory tree view <id> [--json]
      Print one folder node or entry body.

  readable memory tree edit <id> [--name <title>] [--description <text>]
                       [--type user|feedback|project|reference]
                       [--body <markdown> | --body-file <path|->] [--json]
      Patch an editable entry node. Folder nodes are derived from entry types.

  readable memory tree move <id> --type user|feedback|project|reference [--json]
      Move an entry node to a different memory bucket while preserving its id.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.`);
}

function memoryPositionals(values) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!value) continue;
    if (value.startsWith('--')) {
      const eq = value.indexOf('=');
      const key = eq >= 0 ? value.slice(2, eq) : value.slice(2);
      if (eq < 0 && MEMORY_STRING_FLAGS.has(key)) i++;
      continue;
    }
    out.push(value);
  }
  return out;
}

async function readMemoryBodyFromFlags(flags) {
  if (typeof flags.body === 'string') return flags.body;
  if (typeof flags['body-file'] !== 'string') return undefined;
  const path = flags['body-file'];
  if (path === '-') {
    let body = '';
    for await (const chunk of process.stdin) body += chunk;
    return body;
  }
  const { readFile } = await import('node:fs/promises');
  return await readFile(path, 'utf8');
}

function formatMemoryTreeRow(node) {
  return [
    node.id,
    node.parentId ?? '-',
    node.path,
    node.kind,
    node.type ?? '-',
    node.scope,
    node.name,
  ].join('\t');
}

function printMemoryEntry(entry) {
  console.log(`# ${entry.name}`);
  console.log(`id: ${entry.id}`);
  console.log(`type: ${entry.type}`);
  console.log(`description: ${entry.description || '-'}`);
  console.log('');
  process.stdout.write(`${entry.body ?? ''}\n`);
}

async function fetchMemoryTree(base) {
  let resp;
  try {
    resp = await fetch(`${base}/api/memory/tree`);
  } catch (err) {
    surfaceFetchError(err, base);
    process.exit(3);
  }
  if (!resp.ok) return structuredHttpFailure(resp);
  return await resp.json();
}

async function patchMemoryTreeNode(base, id, body) {
  let resp;
  try {
    resp = await fetch(`${base}/api/memory/tree/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    surfaceFetchError(err, base);
    process.exit(3);
  }
  if (!resp.ok) return structuredHttpFailure(resp);
  return await resp.json();
}

async function runMemory(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printMemoryHelp();
    process.exit(args.length === 0 ? 2 : 0);
  }
  const topic = args[0];
  if (topic !== 'tree') {
    console.error(`unknown subcommand: readable memory ${topic}`);
    printMemoryHelp();
    process.exit(2);
  }
  const rest = args.slice(1);
  let flags;
  try {
    flags = parseFlags(rest, {
      string: MEMORY_STRING_FLAGS,
      boolean: MEMORY_BOOLEAN_FLAGS,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const base = await cliDaemonBaseUrl(flags);
  const writeJson = (data) =>
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  const parts = memoryPositionals(rest);
  const action = parts[0] ?? 'list';

  if (action === 'list') {
    const data = await fetchMemoryTree(base);
    if (flags.json) return writeJson(data);
    const tree = data.tree ?? [];
    if (tree.length === 0) {
      console.log('No memory tree nodes.');
      return;
    }
    console.log('# id\tparent\tpath\tkind\ttype\tscope\tname');
    for (const node of tree) console.log(formatMemoryTreeRow(node));
    return;
  }

  if (action === 'view') {
    const id = parts[1];
    if (!id) {
      console.error('Usage: readable memory tree view <id>');
      process.exit(2);
    }
    const treeData = await fetchMemoryTree(base);
    const node = (treeData.tree ?? []).find((item) => item.id === id);
    if (!node) {
      console.error(`memory tree node not found: ${id}`);
      process.exit(4);
    }
    if (node.kind === 'folder') {
      if (flags.json) return writeJson({ node });
      console.log(`${node.path}\t${node.name}\t${node.childrenCount ?? 0} children`);
      return;
    }
    let resp;
    try {
      resp = await fetch(`${base}/api/memory/${encodeURIComponent(id)}`);
    } catch (err) {
      surfaceFetchError(err, base);
      process.exit(3);
    }
    if (!resp.ok) return structuredHttpFailure(resp);
    const data = await resp.json();
    if (flags.json) return writeJson(data);
    printMemoryEntry(data.entry ?? data);
    return;
  }

  if (action === 'edit') {
    const id = parts[1];
    if (!id) {
      console.error('Usage: readable memory tree edit <id> [--name ...] [--description ...] [--type ...] [--body ...|--body-file ...]');
      process.exit(2);
    }
    const body = {};
    if (typeof flags.name === 'string') body.name = flags.name;
    if (typeof flags.description === 'string') body.description = flags.description;
    if (typeof flags.type === 'string') body.type = flags.type;
    const nextBody = await readMemoryBodyFromFlags(flags);
    if (typeof nextBody === 'string') body.body = nextBody;
    if (Object.keys(body).length === 0) {
      console.error('nothing to edit; pass --name, --description, --type, --body, or --body-file');
      process.exit(2);
    }
    const data = await patchMemoryTreeNode(base, id, body);
    if (flags.json) return writeJson(data);
    console.log(`[memory] updated ${data.entry?.id ?? id}`);
    return;
  }

  if (action === 'move') {
    const id = parts[1];
    const type = flags.type ?? parts[2];
    if (!id || !type) {
      console.error('Usage: readable memory tree move <id> --type user|feedback|project|reference');
      process.exit(2);
    }
    const data = await patchMemoryTreeNode(base, id, { type });
    if (flags.json) return writeJson(data);
    console.log(`[memory] moved ${data.entry?.id ?? id} to ${data.entry?.type ?? type}`);
    return;
  }

  console.error(`unknown subcommand: readable memory tree ${action}`);
  printMemoryHelp();
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Subcommand: readable automation …
//
// Headless surface for the Automations tab. This is the dual-track contract:
// every capability the Automations UI exposes is reachable here so an
// external agent (hermes-agent, openclaw, custom Slackbot, etc.) can run
// the full lifecycle — list, create, fire, harvest, retire — without
// rendering a page. Storage is /api/routines on the local daemon; the
// "routine" name is the implementation detail, "automation" is the user-
// facing surface.
// ---------------------------------------------------------------------------

function parseScheduleFlag(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error(
      '--schedule is required. Forms: hourly:<minute> | daily:HH:MM[:TZ] | weekdays:HH:MM[:TZ] | weekly:DAY:HH:MM[:TZ]',
    );
  }
  const parts = raw.split(':');
  const kind = parts[0];
  if (kind === 'hourly') {
    const minute = Number(parts[1]);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error('--schedule hourly requires :<minute>, 0-59');
    }
    return { kind: 'hourly', minute };
  }
  if (kind === 'daily' || kind === 'weekdays') {
    if (parts.length < 3) {
      throw new Error(`--schedule ${kind} requires :HH:MM[:TZ]`);
    }
    const hh = parts[1];
    const mm = parts[2];
    const time = `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`;
    if (!/^[0-2]\d:[0-5]\d$/.test(time)) {
      throw new Error(`--schedule ${kind} time must be HH:MM (24h)`);
    }
    const timezone = parts.slice(3).join(':') || 'UTC';
    return { kind, time, timezone };
  }
  if (kind === 'weekly') {
    if (parts.length < 4) {
      throw new Error('--schedule weekly requires :DAY:HH:MM[:TZ] (DAY is 0-6 or sun/mon/...)');
    }
    const dayToken = String(parts[1]).toLowerCase();
    let weekday;
    if (/^[0-6]$/.test(dayToken)) {
      weekday = Number(dayToken);
    } else if (AUTOMATION_WEEKDAY_TOKENS[dayToken] !== undefined) {
      weekday = AUTOMATION_WEEKDAY_TOKENS[dayToken];
    } else {
      throw new Error(`--schedule weekly day must be 0-6 or sun..sat (got "${parts[1]}")`);
    }
    const time = `${parts[2].padStart(2, '0')}:${parts[3].padStart(2, '0')}`;
    if (!/^[0-2]\d:[0-5]\d$/.test(time)) {
      throw new Error('--schedule weekly time must be HH:MM (24h)');
    }
    const timezone = parts.slice(4).join(':') || 'UTC';
    return { kind: 'weekly', weekday, time, timezone };
  }
  throw new Error(`--schedule kind must be hourly|daily|weekdays|weekly (got "${kind}")`);
}

function parseAutomationTarget(flags) {
  const raw = flags.target;
  if (raw == null) {
    if (flags.project) return { mode: 'reuse', projectId: String(flags.project) };
    return { mode: 'create_each_run' };
  }
  const value = String(raw);
  if (
    value === 'worktree' ||
    value === 'new-project' ||
    value === 'create-each-run' ||
    value === 'create_each_run'
  ) {
    return { mode: 'create_each_run' };
  }
  if (value === 'reuse') {
    if (!flags.project) {
      throw new Error('--target reuse needs --project <id>');
    }
    return { mode: 'reuse', projectId: String(flags.project) };
  }
  const eq = value.indexOf('=');
  if ((value.startsWith('reuse=') || value.startsWith('reuse:')) && eq > 0) {
    const projectId = value.slice(eq + 1).trim();
    if (!projectId) throw new Error('--target reuse=<projectId> needs a non-empty id');
    return { mode: 'reuse', projectId };
  }
  throw new Error(
    `--target must be "new-project" or "reuse=<projectId>" (got "${value}")`,
  );
}

function describeAutomationScheduleForCli(schedule) {
  if (!schedule) return '-';
  if (schedule.kind === 'hourly') {
    return `hourly:${String(schedule.minute).padStart(2, '0')}`;
  }
  if (schedule.kind === 'weekly') {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    return `weekly:${days[schedule.weekday] ?? schedule.weekday}:${schedule.time}:${schedule.timezone}`;
  }
  return `${schedule.kind}:${schedule.time}:${schedule.timezone}`;
}

function describeAutomationTargetForCli(target) {
  if (!target) return '-';
  if (target.mode === 'reuse') return `reuse=${target.projectId}`;
  return 'new-project';
}

function splitAutomationIds(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const part of value.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function automationContextFromFlags(flags) {
  const skillIds = splitAutomationIds(flags.skill);
  const pluginIds = splitAutomationIds(flags.plugin);
  const mcpServerIds = splitAutomationIds(flags.mcp);
  const context = {
    ...(skillIds.length > 0 ? { skillIds } : {}),
    ...(pluginIds.length > 0 ? { pluginIds } : {}),
    ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
  };
  return Object.keys(context).length > 0 ? context : null;
}

function formatAutomationRow(r) {
  const next = r.nextRunAt
    ? new Date(r.nextRunAt).toISOString()
    : (r.enabled ? '-' : 'paused');
  return [
    r.id,
    r.name,
    describeAutomationScheduleForCli(r.schedule),
    describeAutomationTargetForCli(r.target),
    r.enabled ? 'enabled' : 'paused',
    next,
  ].join('\t');
}

async function readPromptFromFlags(flags) {
  if (typeof flags.prompt === 'string' && flags.prompt.length > 0) {
    return flags.prompt;
  }
  if (typeof flags['prompt-file'] === 'string' && flags['prompt-file'].length > 0) {
    const path = flags['prompt-file'];
    if (path === '-') {
      return await new Promise((resolve, reject) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { buf += chunk; });
        process.stdin.on('end', () => resolve(buf));
        process.stdin.on('error', reject);
      });
    }
    const { readFile } = await import('node:fs/promises');
    return await readFile(path, 'utf8');
  }
  return null;
}

function printAutomationHelp() {
  console.log(`Usage:
  readable automation template list                                List built-in automation templates.
  readable automation template get <id>                            Print one built-in automation template.
  readable automation source ingest --source-kind <kind> --title <title>
                              [--source-ref <ref>] [--template <id>]
                              [--body <markdown> | --body-file <path|->]
                              [--compression off|balanced|aggressive]
                              [--json]
  readable automation source list [--limit 20] [--json]             List ingested source packets.
  readable automation source get <id> [--json]                      Print one source packet.
  readable automation proposal list [--status pending-review]       List self-evolution proposals.
  readable automation proposal get <id>                             Print one proposal.
  readable automation proposal apply <id>                           Apply a reviewable proposal.
  readable automation proposal reject <id> [--reason "<why>"]       Reject a reviewable proposal.
  readable automation list                                         List automations.
  readable automation get <id>                                     Print one automation.
  readable automation create --name "<title>" --prompt "<text>"
                       --schedule <spec>
                       [--target new-project|reuse=<projectId>]
                       [--disabled] [--json]
                       [--prompt-file <path|->] (alternative to --prompt)
                       [--skill <id>[,<id>]] [--plugin <id>[,<id>]]
                       [--mcp <id>[,<id>]]
                       [--agent <id>]
  readable automation update <id> [--name ...] [--prompt ...]
                            [--schedule ...] [--target ...]
                            [--skill ...] [--plugin ...] [--mcp ...]
                            [--enabled|--disabled]
                            Patch fields.
  readable automation run <id>                                       Trigger a manual run; prints projectId/conversationId.
  readable automation runs <id> [--limit 10]                         Print run history.
  readable automation crystallize-run <routineId> <runId> [--json]    Turn a succeeded run into skill/memory proposals.
  readable automation pause <id>                                     Mark disabled.
  readable automation resume <id>                                    Mark enabled.
  readable automation delete <id>                                    Remove the automation (history retained).

Schedule formats:
  hourly:<minute>                    Every hour at :MM.
  daily:HH:MM[:TZ]                   Daily at HH:MM in TZ (default UTC).
  weekdays:HH:MM[:TZ]                Mon-Fri at HH:MM.
  weekly:DAY:HH:MM[:TZ]              DAY = 0-6 or sun|mon|...|sat.

Output:
  Plain text: tab-separated rows for list, human-readable lines for get / runs.
  --json     Raw JSON for any subcommand.
  Designed so external agents (hermes-agent, openclaw, scripted jobs)
  can drive the full automation lifecycle headlessly.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.`);
}

async function runAutomation(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printAutomationHelp();
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  let flags;
  try {
    flags = parseFlags(rest, {
      string: AUTOMATION_STRING_FLAGS,
      boolean: AUTOMATION_BOOLEAN_FLAGS,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const base = await cliDaemonBaseUrl(flags);

  const writeJson = (data) =>
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');

  const positionalArgs = (values) => {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!value) continue;
      if (value.startsWith('--')) {
        const eq = value.indexOf('=');
        const key = eq >= 0 ? value.slice(2, eq) : value.slice(2);
        if (eq < 0 && AUTOMATION_STRING_FLAGS.has(key)) i++;
        continue;
      }
      out.push(value);
    }
    return out;
  };

  const requireId = (label) => {
    const id = positionalArgs(rest)[0];
    if (!id) {
      console.error(`Usage: readable automation ${label} <id>`);
      process.exit(2);
    }
    return id;
  };

  const readAutomationIngestBody = async () => {
    const direct = await readMemoryBodyFromFlags(flags);
    if (typeof direct === 'string') return direct;
    return await readPromptFromFlags(flags);
  };

  switch (sub) {
    case 'template':
    case 'templates': {
      const parts = positionalArgs(rest);
      const action = parts[0] ?? 'list';
      if (action === 'list') {
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-templates`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        if (flags.json) return writeJson(data);
        const templates = data.templates ?? [];
        if (templates.length === 0) {
          console.log('No automation templates available.');
          return;
        }
        console.log('# id\ttitle\ttriggers\tsources\toutputs\tcompression\treview');
        for (const template of templates) {
          console.log([
            template.id,
            template.title,
            (template.triggerKinds ?? []).join(','),
            (template.sourceKinds ?? []).join(','),
            (template.outputSinks ?? []).join(','),
            template.tokenCompression,
            template.reviewPolicy,
          ].join('\t'));
        }
        return;
      }
      if (action === 'get') {
        const id = parts[1];
        if (!id) {
          console.error('Usage: readable automation template get <id>');
          process.exit(2);
        }
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-templates/${encodeURIComponent(id)}`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        return writeJson(flags.json ? data : (data.template ?? data));
      }
      console.error(`unknown subcommand: readable automation template ${action}`);
      printAutomationHelp();
      process.exit(2);
    }
    case 'ingest':
    case 'source':
    case 'sources': {
      const parts = positionalArgs(rest);
      const action = sub === 'ingest' ? 'ingest' : (parts[0] ?? 'list');
      if (action === 'ingest') {
        const sourceKind = flags['source-kind'] ?? (sub === 'ingest' ? parts[0] : parts[1]);
        if (!sourceKind) {
          console.error('Usage: readable automation source ingest --source-kind <kind> --body-file <path|->');
          process.exit(2);
        }
        const bodyMarkdown = await readAutomationIngestBody();
        if (!bodyMarkdown) {
          console.error('--body, --body-file, --prompt, or --prompt-file is required');
          process.exit(2);
        }
        const candidateSinks = typeof flags['candidate-sinks'] === 'string'
          ? flags['candidate-sinks'].split(',').map((item) => item.trim()).filter(Boolean)
          : undefined;
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-ingestions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              templateId: flags.template,
              sourceKind,
              sourceRef: flags['source-ref'],
              title: flags.title ?? flags.name,
              bodyMarkdown,
              projectId: flags.project,
              accountLabel: flags.account,
              sensitivity: flags.sensitivity,
              tokenCompression: flags.compression,
              candidateSinks,
              memoryType: flags['memory-type'],
            }),
          });
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        if (flags.json) return writeJson(data);
        console.log(`[automation source] ingested ${data.packet?.id}`);
        console.log(`compression: ${data.compressionReport?.status ?? 'unknown'} (${data.compressionReport?.beforeTokens ?? 0} -> ${data.compressionReport?.afterTokens ?? 0} tokens)`);
        const proposals = data.proposals ?? [];
        if (proposals.length > 0) {
          console.log('# proposals');
          for (const proposal of proposals) {
            console.log([
              proposal.id,
              proposal.targetKind,
              proposal.action,
              proposal.status,
              proposal.title,
            ].join('\t'));
          }
        }
        return;
      }
      if (action === 'list') {
        const query = flags.limit ? `?limit=${encodeURIComponent(String(flags.limit))}` : '';
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-source-packets${query}`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        if (flags.json) return writeJson(data);
        const packets = data.packets ?? [];
        if (packets.length === 0) {
          console.log('No automation source packets.');
          return;
        }
        console.log('# id\tkind\tcapturedAt\ttokens\ttitle');
        for (const packet of packets) {
          console.log([
            packet.id,
            packet.sourceKind,
            packet.capturedAt,
            packet.tokenStats?.originalTokens ?? 0,
            packet.title,
          ].join('\t'));
        }
        return;
      }
      if (action === 'get') {
        const id = parts[1];
        if (!id) {
          console.error('Usage: readable automation source get <id>');
          process.exit(2);
        }
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-source-packets/${encodeURIComponent(id)}`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        return writeJson(await resp.json());
      }
      console.error(`unknown subcommand: readable automation source ${action}`);
      printAutomationHelp();
      process.exit(2);
    }
    case 'proposal':
    case 'proposals': {
      const parts = positionalArgs(rest);
      const action = parts[0] ?? 'list';
      if (action === 'list') {
        const query = flags.status ? `?status=${encodeURIComponent(String(flags.status))}` : '';
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-proposals${query}`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        if (flags.json) return writeJson(data);
        const proposals = data.proposals ?? [];
        if (proposals.length === 0) {
          console.log('No automation proposals.');
          return;
        }
        console.log('# id\tstatus\ttarget\taction\tupdatedAt\ttitle');
        for (const proposal of proposals) {
          console.log([
            proposal.id,
            proposal.status,
            proposal.targetKind,
            proposal.action,
            proposal.updatedAt,
            proposal.title,
          ].join('\t'));
        }
        return;
      }
      if (action === 'get') {
        const id = parts[1];
        if (!id) {
          console.error('Usage: readable automation proposal get <id>');
          process.exit(2);
        }
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-proposals/${encodeURIComponent(id)}`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        return writeJson(await resp.json());
      }
      if (action === 'apply' || action === 'reject') {
        const id = parts[1];
        if (!id) {
          console.error(`Usage: readable automation proposal ${action} <id>`);
          process.exit(2);
        }
        let resp;
        try {
          resp = await fetch(
            `${base}/api/automation-proposals/${encodeURIComponent(id)}/${action}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: action === 'reject'
                ? JSON.stringify({ reason: flags.reason ?? '' })
                : '{}',
            },
          );
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        if (flags.json) return writeJson(data);
        console.log(`[automation proposal] ${action === 'apply' ? 'applied' : 'rejected'} ${data.proposal?.id ?? id}`);
        return;
      }
      console.error(`unknown subcommand: readable automation proposal ${action}`);
      printAutomationHelp();
      process.exit(2);
    }
    case 'list': {
      let resp;
      try {
        resp = await fetch(`${base}/api/routines`);
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return writeJson(data);
      const routines = data.routines ?? [];
      if (routines.length === 0) {
        console.log('No automations. Create one with `readable automation create --name "..." --prompt "..." --schedule daily:09:00`.');
        return;
      }
      console.log('# id\tname\tschedule\ttarget\tstatus\tnextRun');
      for (const r of routines) console.log(formatAutomationRow(r));
      return;
    }
    case 'get': {
      const id = requireId('get');
      let resp;
      try {
        resp = await fetch(`${base}/api/routines/${encodeURIComponent(id)}`);
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return writeJson(data);
      writeJson(data.routine ?? data);
      return;
    }
    case 'runs': {
      const id = requireId('runs');
      const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 20;
      let resp;
      try {
        resp = await fetch(
          `${base}/api/routines/${encodeURIComponent(id)}/runs?limit=${limit}`,
        );
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return writeJson(data);
      const runs = data.runs ?? [];
      if (runs.length === 0) {
        console.log(`No runs yet for ${id}.`);
        return;
      }
      console.log('# runId\tstatus\ttrigger\tstartedAt\tprojectId\tconversationId');
      for (const r of runs) {
        console.log([
          r.id,
          r.status,
          r.trigger,
          new Date(r.startedAt).toISOString(),
          r.projectId,
          r.conversationId,
        ].join('\t'));
      }
      return;
    }
    case 'crystallize-run': {
      const parts = positionalArgs(rest);
      const routineId = parts[0];
      const runId = parts[1];
      if (!routineId || !runId) {
        console.error('Usage: readable automation crystallize-run <routineId> <runId> [--json]');
        process.exit(2);
      }
      let resp;
      try {
        resp = await fetch(
          `${base}/api/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}/crystallize`,
          { method: 'POST' },
        );
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return writeJson(data);
      console.log(`[automation] crystallized ${runId}`);
      console.log(`sourcePacket\t${data.packet?.id ?? ''}`);
      console.log(`compression\t${data.compressionReport?.status ?? 'unknown'}\t${data.compressionReport?.beforeTokens ?? 0}->${data.compressionReport?.afterTokens ?? 0}`);
      const proposals = data.proposals ?? [];
      if (proposals.length > 0) {
        console.log('# proposals');
        for (const proposal of proposals) {
          console.log([
            proposal.id,
            proposal.targetKind,
            proposal.action,
            proposal.status,
            proposal.title,
          ].join('\t'));
        }
      }
      return;
    }
    case 'create': {
      const name = typeof flags.name === 'string' ? flags.name.trim() : '';
      if (!name) {
        console.error('--name is required');
        process.exit(2);
      }
      const prompt = (await readPromptFromFlags(flags)) || '';
      if (!prompt.trim()) {
        console.error('--prompt or --prompt-file is required');
        process.exit(2);
      }
      let schedule;
      let target;
      try {
        schedule = parseScheduleFlag(flags.schedule);
        target = parseAutomationTarget(flags);
      } catch (err) {
        console.error(err.message);
        process.exit(2);
      }
      const body = {
        name,
        prompt: prompt.trim(),
        schedule,
        target,
        enabled: !flags.disabled,
      };
      const context = automationContextFromFlags(flags);
      const skillIds = splitAutomationIds(flags.skill);
      if (skillIds.length > 0) body.skillId = skillIds[0];
      if (context) body.context = context;
      if (flags.agent) body.agentId = String(flags.agent);
      let resp;
      try {
        resp = await fetch(`${base}/api/routines`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`POST /api/routines failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return writeJson(data);
      console.log(`[automation] created ${data.routine?.id}`);
      console.log(formatAutomationRow(data.routine));
      return;
    }
    case 'update': {
      const id = requireId('update');
      const patch = {};
      if (typeof flags.name === 'string') patch.name = flags.name.trim();
      const promptPatch = await readPromptFromFlags(flags);
      if (promptPatch != null) patch.prompt = promptPatch.trim();
      if (flags.schedule) {
        try {
          patch.schedule = parseScheduleFlag(flags.schedule);
        } catch (err) {
          console.error(err.message);
          process.exit(2);
        }
      }
      if (flags.target || flags.project) {
        try {
          patch.target = parseAutomationTarget(flags);
        } catch (err) {
          console.error(err.message);
          process.exit(2);
        }
      }
      if (flags.disabled) patch.enabled = false;
      if (flags.enabled) patch.enabled = true;
      const context = automationContextFromFlags(flags);
      if (context) {
        const skillIds = splitAutomationIds(flags.skill);
        if (skillIds.length > 0) patch.skillId = skillIds[0];
        patch.context = context;
      }
      if (Object.keys(patch).length === 0) {
        console.error('update needs at least one of --name --prompt(--prompt-file) --schedule --target --skill --plugin --mcp --enabled --disabled');
        process.exit(2);
      }
      let resp;
      try {
        resp = await fetch(`${base}/api/routines/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`PATCH /api/routines/${id} failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return writeJson(data);
      console.log(`[automation] updated ${id}`);
      console.log(formatAutomationRow(data.routine));
      return;
    }
    case 'pause':
    case 'resume': {
      const id = requireId(sub);
      const enabled = sub === 'resume';
      let resp;
      try {
        resp = await fetch(`${base}/api/routines/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`PATCH /api/routines/${id} failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return writeJson(data);
      console.log(`[automation] ${sub}d ${id}`);
      return;
    }
    case 'run': {
      const id = requireId('run');
      let resp;
      try {
        resp = await fetch(`${base}/api/routines/${encodeURIComponent(id)}/run`, {
          method: 'POST',
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok && resp.status !== 202) {
        console.error(`POST /api/routines/${id}/run failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return writeJson(data);
      console.log(`[automation] triggered ${id}`);
      if (data.projectId) console.log(`projectId\t${data.projectId}`);
      if (data.conversationId) console.log(`conversationId\t${data.conversationId}`);
      if (data.agentRunId) console.log(`agentRunId\t${data.agentRunId}`);
      return;
    }
    case 'delete': {
      const id = requireId('delete');
      let resp;
      try {
        resp = await fetch(`${base}/api/routines/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      if (flags.json) return writeJson({ ok: true, id });
      console.log(`[automation] deleted ${id}`);
      return;
    }
    default:
      console.error(`unknown subcommand: readable automation ${sub}`);
      printAutomationHelp();
      process.exit(2);
  }
}
