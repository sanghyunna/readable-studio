# Readable Studio plugin specification

**Parent:** [`spec.md`](spec.md) · **Related:** [`skills-protocol.md`](skills-protocol.md) · [`architecture.md`](architecture.md) · [`../plugins/spec/SPEC.md`](../plugins/spec/SPEC.md)

## Product role

Plugins remain an integrated part of the Readable Studio company-document workflow:

```text
Source Text -> AI Generation -> Direct Editing -> Standalone HTML
```

A plugin binds portable agent instructions to typed inputs, capabilities, project context, optional pipeline stages, examples, and design resources. The same applied plugin is available through the Windows portable app and the `readable` CLI. It does not replace direct editing or export; it shapes the AI-generation portion of a project whose files remain editable and AI-readable.

Readable Studio presents installed plugins and configured registry catalogs inside the local application. Plugin operations are also available through the CLI and daemon API. There is no browser-only product, Linux product, public product website, website installation flow, or deep-link installation contract.

## Folder contract

A plugin is an Agent Skills-compatible folder:

```text
my-plugin/
├── SKILL.md
├── readable-studio.json       # optional typed sidecar
├── assets/                    # optional prompt/runtime assets
└── examples/                  # optional preview examples
```

`SKILL.md` is the portable, agent-readable instruction source. A plugin can consist only of that file. The optional `readable-studio.json` sidecar adds Readable Studio metadata and behavior; it must not duplicate the skill body.

The canonical JSON schema is [`docs/schemas/readable-studio.plugin.v1.json`](schemas/readable-studio.plugin.v1.json). Runtime parsing is owned by [`packages/plugin-runtime`](../packages/plugin-runtime/src/parsers/manifest.ts), and shared types are owned by [`packages/contracts`](../packages/contracts/src/plugins/manifest.ts).

## Minimal sidecar

```json
{
  "$schema": "../../docs/schemas/readable-studio.plugin.v1.json",
  "specVersion": "1.0.0",
  "name": "quarterly-review",
  "version": "1.0.0",
  "title": "Quarterly review",
  "description": "Turn approved quarterly source into an executive review document.",
  "compat": {
    "agentSkills": [
      { "path": "./SKILL.md" }
    ]
  },
  "readable": {
    "kind": "scenario",
    "taskKind": "new-generation",
    "mode": "prototype",
    "capabilities": ["prompt:inject"],
    "inputs": [
      {
        "name": "audience",
        "type": "string",
        "required": true,
        "title": "Audience"
      }
    ]
  }
}
```

The checked-in schema and parser are authoritative when this summary differs.

## Identity and compatibility

- `specVersion` selects the sidecar contract. It is independent from plugin `version`.
- `name` is the stable plugin ID within an installed catalog.
- `version` uses semantic versioning.
- `compat.agentSkills[].path` points to an Agent Skills entry such as `./SKILL.md`.
- Paths are relative to the plugin root and must remain inside it.
- Unknown or malformed required values fail validation; they are not silently converted into another plugin shape.
- Legacy plugin frontmatter can fill supported compatibility fields, but explicit sidecar values win.

## Readable Studio extension fields

The `readable` object describes how the local product applies the plugin.

### Kind and task

`readable.kind` identifies the plugin role, such as a skill, scenario, atom, or bundle. `readable.taskKind` identifies the workflow family. These values drive filtering and defaults; they do not grant capabilities.

### Mode

`readable.mode` describes the intended artifact surface. It helps the project and plugin pickers choose compatible workflows. The artifact manifest, not the plugin mode alone, determines available exports.

### Inputs

`readable.inputs[]` declares typed apply-time values. Input names are stable machine keys; titles and descriptions are display metadata. Required values must be supplied before a run starts. The resolved input map is frozen into the applied snapshot so replay and audit use the same values.

### Capabilities

`readable.capabilities[]` declares the minimum access the plugin needs. A restricted install receives only the default prompt-injection capability until the user grants more. Capability checks occur when the plugin is applied and again at the operation boundary; manifest text is not authorization by itself.

Examples include prompt injection, constrained filesystem access, and named MCP access. The schema and runtime capability registry define the accepted strings.

### Context and references

A plugin can reference skills, design systems, craft rules, examples, and assets using root-contained relative paths or supported resource IDs. The daemon resolves those references before composing the run. Missing required references are validation errors.

### Pipeline stages

A scenario may declare ordered stages and atoms. Applying the plugin creates an immutable snapshot of the resolved contract. The daemon uses that snapshot to compose stage instructions and emit stage events while the selected agent remains the worker.

## Apply and snapshot model

Plugin application is deterministic:

1. Resolve the installed plugin and parse `readable-studio.json` plus `SKILL.md`.
2. Validate required inputs, references, and requested capabilities.
3. Resolve project context and selected design resources.
4. Create an immutable applied-plugin snapshot.
5. Return the hydrated query/context to the UI or CLI.
6. Start a run against the snapshot ID.

Runs consume snapshots rather than mutable installed folders. Updating or uninstalling a plugin does not rewrite the contract already attached to an existing run.

## UI, CLI, and HTTP parity

The Plugin page, project composer, and CLI use the same daemon `/api/plugins*` contracts. A plugin capability must not exist only in the desktop interface.

Common CLI operations:

```powershell
readable plugin list --json
readable plugin search "quarterly review" --json
readable plugin info quarterly-review --json
readable plugin validate .\quarterly-review --json
readable plugin install .\quarterly-review --json
readable plugin apply quarterly-review --project <project-id> --input audience="Department leads"
readable plugin uninstall quarterly-review --json
```

Additional maintained commands expose manifests, snapshots, trust, diagnostics, simulation, verification, events, diffs, packing, and configured-registry operations. `readable plugin --help` is the source of truth for the installed command set.

Machine consumers use `--json`. Commands that accept long prompt content must accept `--prompt-file <path|->` rather than requiring shell-escaped prose.

## Installation sources

The local plugin runtime supports sources accepted by `readable plugin install`, including a local folder and supported GitHub, HTTPS archive, or configured catalog references. Every fetched plugin is staged, path-checked, parsed, and validated before it becomes installed.

A configured catalog is data, not a product website. Its `readable-studio-marketplace.json` entries locate plugin sources and metadata. The local app remains the presentation and consent surface.

## Authoring workflow

1. Create `SKILL.md` with focused, source-grounded instructions.
2. Add `readable-studio.json` only when typed metadata or integrated behavior is needed.
3. Declare the minimum capabilities.
4. Keep every path relative and root-contained.
5. Include a hand-built example when the plugin promises visual output.
6. Validate locally.

```powershell
readable plugin validate .\my-plugin --json
pnpm guard
pnpm --filter @readable-studio/plugin-runtime typecheck
```

Follow [`plugins/AGENTS.md`](../plugins/AGENTS.md), [`plugins/spec/CONTRIBUTING.md`](../plugins/spec/CONTRIBUTING.md), and [`plugins/spec/AGENT-DEVELOPMENT.md`](../plugins/spec/AGENT-DEVELOPMENT.md).

## Security and trust

- Plugin folders are untrusted input until validated.
- Archive extraction rejects traversal, absolute paths, and unsafe links.
- Capability declarations are explicit and least-privilege.
- User-provided values enter prompts or validated fields, never free-form daemon command structure.
- Installed plugin files do not receive credentials merely because a manifest asks for them.
- Project and runtime paths remain daemon-owned.
- Plugin examples render under the same preview sandbox rules as project artifacts.

## Distribution boundary

The supported product is a Windows 10/11 x64 portable ZIP manually downloaded from GitHub Releases. Plugin discovery and management happen in that local app or through `readable` commands. This specification does not define a public website, browser-only edition, operating-system package, updater, installer, or URL-scheme installation flow.

## Verification contract

A plugin change is ready when:

- the folder validates against the checked-in schema and parser;
- `SKILL.md` remains usable as a portable Agent Skill;
- the sidecar does not duplicate the skill body;
- paths and assets resolve inside the plugin root;
- capability grants are sufficient and minimal;
- applying through UI and CLI resolves the same snapshot contract;
- relevant plugin-runtime and daemon tests pass;
- `pnpm guard` and `pnpm typecheck` pass.
