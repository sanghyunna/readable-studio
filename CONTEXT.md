# Readable Studio language and context

This file defines canonical product language for current documentation and product copy.

## Product thesis

**Readable Studio turns source text into polished standalone HTML with AI generation and PowerPoint-like direct editing.** It is built for office workers creating AI-readable company documents without entering a prompt-and-wait cycle for every small revision. Its enterprise AI transformation thesis is practical: company source remains governed and inspectable while people and AI systems work from the same structured document.

Canonical workflow:

```text
Source Text -> AI Generation -> Direct Editing -> Standalone HTML
```

## Canonical terms

**Source Text**

The user-supplied business material that grounds the document: a brief, report, plan, notes, requirements, approved copy, tables, or imported project files.

_Avoid:_ empty prompt as the expected starting point; invented facts; design-only prompt.

**AI Generation**

The agent-assisted first draft and substantive revision path. The selected plugin, skill, design system, source material, and project context are composed into the run.

_Avoid:_ magic generation; automatic publishing; implying that AI replaces the user's editorial responsibility.

**Direct Editing**

PowerPoint-like editing in the rendered preview. The user selects content and changes text or presentation details directly, with source-backed persistence.

_Avoid:_ prompt-only iteration; regenerate for a typo; code editing as the only correction path.

**Standalone HTML**

The canonical finished document: a self-contained HTML file that opens independently. Statically discoverable local dependencies are inlined; unresolved external or missing references are reported.

_Avoid:_ hosted page; share URL; website; automatic upload; claim that every runtime network dependency is captured.

**AI-readable company document**

A structured artifact whose headings, text, tables, semantics, and source remain usable by people and downstream tools. It is not a screenshot-only canvas.

**Portable ZIP**

The only supported product artifact: a manually downloaded Windows 10/11 x64 ZIP containing `Readable Studio.exe`. It has no installer or updater.

**Plugin**

A portable workflow folder. `SKILL.md` carries agent-readable instructions; optional `readable-studio.json` carries Readable Studio metadata, inputs, capabilities, stages, and references.

**Studio**

The project workspace containing conversation, source files, rendered preview, direct editing, comments, tweaks, and export actions.

## Product boundaries

Say:

- Windows 10/11 x64 portable ZIP;
- manually download from GitHub Releases;
- extract and run `Readable Studio.exe`;
- local daemon, web UI, desktop shell, CLI, plugins, skills, design systems, direct editing, and exports;
- standalone HTML is canonical, with artifact-dependent PDF/PPTX/ZIP/Markdown support.

Do not claim:

- a product website or website download;
- an installer, updater, app store, or automatic release channel;
- macOS, Linux, WSL, or Nix product support;
- cloud publishing as part of the core workflow;
- that direct editing removes or replaces integrated agent and CLI capabilities.

Historical records, upstream issue citations, vendor names, and legal notices may use legacy terminology when accuracy requires it.

## Example dialogue

> **Office worker:** "The first draft is right, but the heading is too long and two cards need to move. Do I have to prompt the agent again?"
>
> **Readable Studio:** "No. Select those elements in Edit mode, change the text and layout directly, then export the updated document as standalone HTML. Use the agent again when the revision is substantive rather than mechanical."
