# Readable Studio Plugin Spec

Language: English | [简体中文](SPEC.zh-CN.md)

This spec is the compact contract for portable Readable Studio plugins. The canonical product spec remains `docs/plugins-spec.md`; this document is optimized for contributors and external coding agents.

## 1. Minimum Plugin

Every publishable plugin should be a directory with a `SKILL.md`:

```text
my-plugin/
  SKILL.md
```

`SKILL.md` is the portable agent contract. It must have YAML frontmatter with:

```yaml
---
name: my-plugin
description: Use this plugin when the user wants...
---
```

The folder name, `name`, and manifest `name` should match. Use lowercase letters, numbers, and hyphens.

## 2. Enriched Readable Studio Plugin

Add `readable-studio.json` when the plugin should appear in Readable Studio as a marketplace card or starter:

```text
my-plugin/
  SKILL.md
  readable-studio.json
  README.md
  preview/
  examples/
  assets/
  references/
  evals/
```

`readable-studio.json` points at the skill and declares the product surface:

```json
{
  "$schema": "urn:readable-studio:schema:plugin-manifest:v1",
  "specVersion": "1.0.0",
  "name": "my-plugin",
  "title": "My Plugin",
  "version": "0.1.0",
  "description": "One sentence marketplace description.",
  "license": "MIT",
  "tags": ["create", "prototype"],
  "compat": {
    "agentSkills": [{ "path": "./SKILL.md" }]
  },
  "readable": {
    "kind": "skill",
    "taskKind": "new-generation",
    "mode": "prototype",
    "scenario": "product",
    "useCase": {
      "query": "Create a prototype for {{audience}} about {{topic}}."
    },
    "pipeline": {
      "stages": [
        { "id": "discovery", "atoms": ["discovery-question-form"] },
        { "id": "plan", "atoms": ["direction-picker", "todo-write"] },
        { "id": "generate", "atoms": ["file-write"] },
        {
          "id": "critique",
          "atoms": ["critique-theater"],
          "repeat": true,
          "until": "critique.score>=4 || iterations>=3"
        }
      ]
    },
    "inputs": [
      { "name": "audience", "type": "string", "required": true },
      { "name": "topic", "type": "string", "required": true }
    ],
    "capabilities": ["prompt:inject", "fs:write"]
  }
}
```

### 2.1 Readable Studio v1 is unsupported

Readable Studio does not normalize the former `readable-studio.json`, `readable` metadata namespace, Readable Studio schema URLs, marketplace indexes, or `.readable-studio/project.json` files. Every boundary rejects those inputs with the machine-readable code `UNSUPPORTED_LEGACY_PRODUCT_V1`. Authors must publish `readable-studio.json` with the `readable` namespace; there is no dual parser.

## 3. Workflow Taxonomy

Use one primary lane. Put the lane in `tags`, `readable.scenario`, or `readable.mode` so search and facets can classify the plugin.

| Lane | Use when | Typical `taskKind` | Useful atoms |
| --- | --- | --- | --- |
| `import` | Bring external sources into Readable Studio | `figma-migration` or `code-migration` | `figma-extract`, `code-import`, `design-extract`, `token-map`, `rewrite-plan` |
| `create` | Generate a new artifact | `new-generation` | `discovery-question-form`, `direction-picker`, `todo-write`, `file-write`, `critique-theater` |
| `export` | Convert an accepted artifact to a downstream format | `tune-collab` or `code-migration` | `file-read`, `file-write`, `handoff`, `diff-review` |
| `share` | Publish or send an artifact to collaborators | `tune-collab` | `file-read`, `handoff` |
| `deploy` | Ship an artifact to hosted infrastructure | `code-migration` or `tune-collab` | `file-read`, `build-test`, `handoff` |
| `refine` | Improve an existing artifact | `tune-collab` | `file-read`, `patch-edit`, `critique-theater`, `diff-review` |
| `extend` | Help authors create more plugins | `new-generation` | `file-read`, `file-write`, `todo-write`, `critique-theater` |

## 4. Create Modes

Use `readable.mode` for the main output surface:

| Mode | Output |
| --- | --- |
| `prototype` | Interactive single-page web artifact |
| `deck` | Slide deck artifact |
| `report` | Evidence-backed analytical or research report |
| `document` | Structured Markdown or HTML document |
| `dashboard` | Data-backed monitoring or analysis dashboard |
| `design-system` | Reusable brand or interface system |
| `template` | Reusable starter, layout, or artifact template |
| `other` | Narrow custom output that does not fit the current modes |

## 5. `SKILL.md` Authoring Rules

- Write the description for activation: "Use this plugin when..."
- Keep `SKILL.md` under 500 lines when possible.
- Put long API notes, visual rules, or exporter details in `references/`.
- Reference support files by relative path from the plugin root.
- Include an explicit workflow with checkpoints and expected outputs.
- Describe what to ask the user only when the input is genuinely missing.
- Avoid Readable Studio-only marketplace data in `SKILL.md`; keep it portable.

## 6. Manifest Rules

- `name` is the stable plugin id.
- `specVersion` is the Readable Studio plugin spec version that this manifest follows. Use the current spec kit value (`1.0.0`) unless the schema moves.
- `version` is required. Use semver when possible.
- `version` is the plugin package version, independent from `specVersion`.
- `compat.agentSkills[0].path` should point to `./SKILL.md`.
- `readable.taskKind` must be one of `new-generation`, `figma-migration`, `code-migration`, or `tune-collab`.
- `readable.pipeline.stages[].atoms[]` should use known first-party atoms unless the plugin clearly targets a future Readable Studio release.
- A repeated stage must include `until`.
- `readable.capabilities` should start small. Restricted installs get `prompt:inject` by default.

Known v1 capabilities:

- `prompt:inject`
- `fs:read`
- `fs:write`
- `mcp`
- `subprocess`
- `bash`
- `network`

## 7. Inputs And GenUI

Use `readable.inputs` for simple apply-time values. Use `readable.genui.surfaces[]` when the agent needs controlled human input during a run.

Built-in GenUI surface kinds:

- `form`
- `choice`
- `confirmation`
- `oauth-prompt`

Persistence options:

- `run` - only this run.
- `conversation` - future turns in the same conversation.
- `project` - future runs in the same project.

## 8. Examples And Preview

Visual plugins should include one of:

- `preview/index.html`
- `preview/poster.png`
- `preview/demo.mp4`
- `examples/<case>/index.html`
- `examples/<case>/README.md`

The preview should show the real output shape, not a decorative splash screen.

## 9. Evals

Add `evals/evals.json` for repeatable quality checks:

```json
{
  "skill_name": "my-plugin",
  "evals": [
    {
      "id": "happy-path",
      "prompt": "Create a prototype for a B2B SaaS onboarding flow.",
      "expected_output": "A usable HTML artifact with states, polished layout, and no text overflow.",
      "assertions": [
        "The output includes a runnable artifact file",
        "The visual hierarchy is clear",
        "The workflow has meaningful empty/loading/success states"
      ]
    }
  ]
}
```

Also add `evals/trigger-queries.json` for activation testing when the description is easy to over-broaden.

## 10. Publish And PR

Before opening a PR:

1. Validate JSON syntax.
2. Confirm `readable-studio.json` includes `specVersion` and a bumped plugin `version` when behavior changed.
3. Run `pnpm guard`.
4. Run `pnpm --filter @readable-studio/plugin-runtime typecheck`.
5. If available, run `readable plugin validate ./path/to/plugin`.
6. Include one screenshot, rendered preview, or example output when the plugin is visual.
7. Explain trust and capabilities in the PR body.

For external registry distribution, follow [`PUBLISHING-REGISTRIES.md`](PUBLISHING-REGISTRIES.md). In short: keep GitHub or the Readable Studio PR as source of truth, make the folder installable as a generic `SKILL.md` skill, then publish or list it on skills.sh, ClawHub, or other registries only after local validation passes.
