/**
 * Prompt composer. The base is the Readable Studio-adapted "expert designer" system
 * prompt (see ./official-system.ts) — a full identity, workflow, and
 * content-philosophy charter. Stacked on top:
 *
 *   1. The discovery + planning + huashu-philosophy layer (./discovery.ts)
 *      — interactive question-form syntax, direction-picker fork,
 *      brand-spec extraction, TodoWrite reinforcement, 5-dim critique,
 *      and the embedded `directions.ts` library.
 *   2. The active design system's DESIGN.md (if any) — palette, typography,
 *      spacing rules treated as authoritative tokens.
 *   3. The active skill's SKILL.md (if any) — workflow specific to the
 *      kind of artifact being built. When the skill ships a seed
 *      (`assets/template.html`) and references (`references/layouts.md`,
 *      `references/checklist.md`), we inject a hard pre-flight rule above
 *      the skill body so the agent reads them BEFORE writing any code.
 *   4. For decks (skillMode === 'deck' OR metadata.kind === 'deck'), the
 *      deck framework directive (./deck-framework.ts) is pinned LAST so it
 *      overrides any softer slide-handling wording earlier in the stack —
 *      this is the load-bearing nav / counter / scroll JS / print
 *      stylesheet contract that PDF stitching depends on. We also fire on
 *      the metadata path so deck-kind projects without a bound skill
 *      (skill_id null) still get a framework, instead of having the agent
 *      re-author scaling / nav / print logic from scratch each turn. When
 *      the active skill ships its own seed (skill body references
 *      `assets/template.html`), we defer to that seed and skip the generic
 *      skeleton — the skill's framework wins to avoid double-injection.
 *
 * The composed string is what the daemon sees as `systemPrompt` and what
 * the Anthropic path sends as `system`.
 */
import type { ChatSessionMode } from '../api/chat.js';
import type { ProjectMetadata, ProjectTemplate } from '../api/projects.js';
import { OFFICIAL_DESIGNER_PROMPT } from './official-system.js';
import { DISCOVERY_AND_PHILOSOPHY } from './discovery.js';
import { DECK_FRAMEWORK_DIRECTIVE } from './deck-framework.js';

// @dsp func-3681689d
export const BASE_SYSTEM_PROMPT = OFFICIAL_DESIGNER_PROMPT;

function renderUiLocalePrompt(locale: string | undefined): string {
  const normalized = locale?.trim();
  if (!normalized || normalized.toLowerCase() === 'en') return '';
  const languageName = normalized === 'zh-CN'
    ? 'Simplified Chinese'
    : normalized === 'zh-TW'
      ? 'Traditional Chinese'
      : normalized;
  const lines = [
    '# UI locale override',
    '',
    `The Readable Studio UI locale for this run is \`${normalized}\` (${languageName}). All user-visible chat prose and generated UI controls must follow this locale, especially \`<question-form>\` titles, descriptions, labels, placeholders, helper text, and option labels. Keep machine-readable ids and object option \`value\` fields exact and unlocalized.`,
    'Exception: for the default task-type form, keep the `taskType` option labels as the canonical routing choices: `Prototype`, `Slide deck`, `Other`. Do not translate, reorder, or rewrite those option labels.',
  ];
  if (normalized === 'zh-CN') {
    lines.push(
      '',
      'For the default quick brief in Simplified Chinese, use copy like:',
      '- title: `快速简报 — 30 秒`',
      '- description: `开始生成前我会先确认这些信息。不适用的可以跳过，我会补上默认值。`',
      '- output label/options: `我们要做什么？` / `幻灯片 / 路演稿`, `单页网页原型 / 落地页`, `多屏应用原型`, `数据看板 / 工具界面`, `编辑式 / 营销页面`, `其他 — 我来描述`',
      '- platform label/options: `目标平台` / `响应式网页`, `桌面网页`, `iOS 应用`, `Android 应用`, `平板应用`, `桌面应用`, `固定画布 (1920×1080)`',
      '- audience label/placeholder: `目标用户` / `例如：早期投资人、开发者工具采购者、内部高管评审`',
      '- tone label/options: `视觉调性` / `编辑 / 杂志感`, `现代极简`, `活泼 / 插画感`, `科技 / 工具型`, `奢华 / 精致`, `粗野 / 实验性`, `人性化 / 亲切`',
      '- brand label/options: `品牌背景` / `帮我选一个方向`, `我有品牌规范 — 稍后分享`, `参考网站 / 截图 — 稍后附上`',
      '- scale label/placeholder: `大概需要多少内容？` / `例如：8 页幻灯片、1 个落地页 + 3 个子页面、4 个移动端界面`',
      '- constraints label/placeholder: `还有什么需要知道的吗？` / `真实文案、必须使用的字体、需要避免的内容、截止时间…`',
    );
  }
  return lines.join('\n');
}

// Always-on readability rule + a Korean-gated CJK line-breaking clause.
// The base block applies to every HTML/page/deck/prototype generation so
// "div box" layouts get comfortable horizontal padding and a capped
// reading measure instead of edge-to-edge cramped text. The Korean clause
// is gated to the `ko` UI-locale signal ONLY (not zh/ja, not universal):
// `word-break: keep-all` wraps Korean at eojeol (word) boundaries instead
// of mid-word, and pairing it with `overflow-wrap: anywhere` keeps long
// English tokens / URLs from overflowing. Keep this byte-identical to the
// daemon mirror in apps/daemon/src/prompts/system.ts.
const READABILITY_RULE_BASE = `## Readability & CJK wrapping

These apply to every HTML / page / deck / prototype artifact you generate, on every run:

- **Horizontal breathing room (always).** Content containers, cards, and panels get generous left/right padding — comfortable inner gutters, never text crammed against the edge. Use padding for that breathing room, not narrow boxes with edge-to-edge prose; as a baseline, card/section inner padding is at least ~24–32px on each side at desktop scale.
- **Reading measure (always).** Cap long body-text columns to a comfortable measure (~65ch, or a sensible \`max-width\`) so lines are neither sprawling nor a single word wide. Headings and full-bleed layout elements are exempt — this is for paragraph / reading text.`;

const READABILITY_RULE_KOREAN = `
- **Korean (한국어) line breaking.** This run's output language is Korean, so apply CJK-aware wrapping to Korean body text: \`word-break: keep-all; overflow-wrap: anywhere; line-break: strict;\`. \`keep-all\` makes Korean wrap at word (eojeol) boundaries instead of breaking mid-word, and pairing it with \`overflow-wrap: anywhere\` keeps long English words / URLs from overflowing their box. Apply it to paragraph, heading, and label text — not to code blocks.`;

function renderReadabilityPrompt(locale: string | undefined): string {
  const normalized = locale?.trim().toLowerCase();
  // Gate the keep-all clause to Korean ONLY — locked product decision.
  return normalized === 'ko'
    ? `${READABILITY_RULE_BASE}\n${READABILITY_RULE_KOREAN}`
    : READABILITY_RULE_BASE;
}

// @dsp func-2b10ae20
export const SKIP_DISCOVERY_BRIEF_OVERRIDE = `# Automated project mode — skip discovery form

This project was created through the daemon API with \`skipDiscoveryBrief: true\`. Override the discovery rules below: do NOT emit \`<question-form id="discovery">\`, do NOT show "Quick brief — 30 seconds", and do NOT ask a first-turn clarification form. Do not emit any question form or choice card, and do not wait for user input. Treat the user's first message and project metadata as the brief, choose reasonable defaults for any missing details, then proceed directly to planning/building under the normal artifact workflow.`;

// @dsp func-abeefff1
export function buildExamplePromptOverride(
  title?: string | null,
  brief?: Record<string, string> | null,
): string {
  let text = `# Example prompt mode — full-quality direct generation

The user selected a curated example prompt from the gallery and sent it without modification. This prompt is a complete, self-contained creative brief that has been carefully designed to produce a showcase-quality artifact.`;

  if (title) {
    text += `\n\nSelected example: "${title}"`;
  }

  if (brief && Object.keys(brief).length > 0) {
    text += `\n\nPre-filled creative brief (treat as if the user already answered all discovery questions):`;
    for (const [key, value] of Object.entries(brief)) {
      text += `\n- ${key.replace(/_/g, ' ')}: ${value}`;
    }
  }

  text += `\n\nRules:
1. Do NOT emit \`<question-form id="discovery">\`, do NOT show "Quick brief — 30 seconds", and do NOT ask any clarifying questions.
2. Treat the user's message as the FULL specification — it contains all visual direction, content themes, and structural intent needed.
3. Generate the artifact at your absolute highest quality. This is a showcase piece — match or exceed the standard of a hand-crafted design.
4. Infer any unspecified details (copy, layout choices, imagery descriptions) in a way that is maximally coherent with the stated creative direction.
5. Proceed directly to planning and building. Output your TodoWrite plan and then the artifact immediately.`;

  return text;
}

const ACTIVE_DESIGN_SYSTEM_VISUAL_DIRECTION_OVERRIDE = `

---

## Active design system visual direction

Active design system exception: the active design system is the visual direction for this project. Use its DESIGN.md palette, typography, spacing, component rules, and theme tokens as the source of truth for color and mood.

- Do not ask the user to pick a separate theme color, visual direction, palette, typography mood, or direction card.
- Do not emit a direction question-form, a \`direction-cards\` picker, or any visual-direction card while an active design system is present.
- If an earlier discovery answer asks to "Pick a direction for me", treat that as already satisfied by the active design system and continue with the plan.
- When a downstream framework mentions "active direction" or "theme tokens", bind those fields from the active design system instead of the built-in direction library.
`;

export interface ComposeInput {
  skillBody?: string | undefined;
  skillName?: string | undefined;
  skillMode?:
    | 'prototype'
    | 'deck'
    | 'template'
    | 'design-system'
    | undefined;
  designSystemBody?: string | undefined;
  designSystemTitle?: string | undefined;
  // Personal-memory block (auto-extracted facts + the hand-edited
  // MEMORY.md index). The daemon side composes this on disk and the
  // BYOK side fetches it from `GET /api/memory/system-prompt`; either
  // way the string is folded in right after the base charter so the
  // model treats it as preferences/context rather than hard rules.
  memoryBody?: string | undefined;
  // Project-level metadata captured by the new-project panel. Drives the
  // agent's understanding of artifact kind, fidelity, speaker-notes intent
  // and animation intent. Missing fields here are exactly what the
  // discovery form should re-ask the user about on turn 1.
  metadata?: ProjectMetadata | undefined;
  // The template the user picked in the From-template tab, when present.
  // Snapshot of HTML files that the agent should treat as a starting
  // reference rather than a fixed deliverable.
  template?: ProjectTemplate | undefined;
  // Optional `## Active plugin` / `## Plugin inputs` / `## Plugin atoms`
  // block (PB1). Daemon callers feed in `renderPluginBlock(snapshot)`;
  // contracts-side callers running the API fallback may still pass the
  // block through. v1 spec §11.8 routes plugin runs through the daemon
  // (web returns 409 when a plugin is bound), so contracts callers only
  // see this on a daemon-bound run that uses the contracts composer.
  pluginBlock?: string | undefined;
  // Plan §3.L2 / spec §23.4 — pre-rendered `## Active stage` blocks
  // produced by `renderActiveStageBlock(stageId, atomBodies)`. The
  // contracts composer simply splices them in after the plugin block;
  // every block is already self-contained markdown.
  activeStageBlocks?: ReadonlyArray<string> | undefined;
  // When set to 'plain', suppresses tool_calls so API/BYOK-mode models
  // only emit <artifact> blocks (they cannot execute tools).
  streamFormat?: string | undefined;
  // Per-conversation mode. Design mode keeps the artifact-first agent
  // workflow; chat mode keeps the same context/tools but answers like a
  // standard multi-turn assistant unless the user explicitly asks to build.
  sessionMode?: ChatSessionMode | undefined;
  // UI locale selected by the client. User-visible generated form copy
  // must follow this locale even when the user's initial prompt is brief.
  locale?: string | undefined;
  // Free-form instructions the user set at the global (user-level)
  // settings panel. Injected after personal memory.
  userInstructions?: string | undefined;
  // Free-form instructions the user set on this specific project.
  // Injected after user-level instructions and before the design system.
  projectInstructions?: string | undefined;
}

// @dsp func-cb0c5cc7
export function composeSystemPrompt({
  skillBody,
  skillName,
  skillMode,
  designSystemBody,
  designSystemTitle,
  memoryBody,
  metadata,
  template,
  pluginBlock,
  activeStageBlocks,
  streamFormat,
  sessionMode,
  locale,
  userInstructions,
  projectInstructions,
}: ComposeInput): string {
  // Discovery + philosophy goes FIRST so its hard rules ("emit a form on
  // turn 1", "branch on brand on turn 2", "TodoWrite on turn 3", run
  // checklist + critique before <artifact>) win precedence over softer
  // wording later in the official base prompt.
  const parts: string[] = [];
  const activeDesignSystemBody = designSystemBody?.trim();
  // API/BYOK mode (streamFormat === 'plain'): no tools are wired through
  // to the model, but the discovery layer + base prompt below still tell
  // it to call TodoWrite/Read/Write/Edit/Bash/WebFetch. Without an
  // explicit top-anchored override, the model invents pseudo-tool markup
  // (`<todo-list>`, `[读取 X]`) instead of producing real progress
  // events — see #313. Pin this preamble ABOVE DISCOVERY_AND_PHILOSOPHY
  // so it beats the discovery layer's own "these override anything
  // later" header.
  if (streamFormat === 'plain') {
    parts.push(API_MODE_OVERRIDE);
    parts.push('\n\n---\n\n');
  }

  if (sessionMode === 'chat') {
    parts.push(CHAT_MODE_OVERRIDE);
    parts.push('\n\n---\n\n');
  }

  if (metadata?.examplePrompt === true) {
    parts.push(buildExamplePromptOverride(metadata.examplePromptTitle, metadata.examplePromptBrief));
    parts.push('\n\n---\n\n');
  } else if (metadata?.skipDiscoveryBrief === true) {
    parts.push(SKIP_DISCOVERY_BRIEF_OVERRIDE);
    parts.push('\n\n---\n\n');
  }

  const localePrompt = renderUiLocalePrompt(locale);
  if (localePrompt) {
    parts.push(localePrompt);
    parts.push('\n\n---\n\n');
  }

  // Always-on readability rule (comfortable horizontal padding + capped
  // reading measure) plus the Korean-gated keep-all wrapping clause. Pushed
  // for every surface so generated layouts stop shipping cramped "div box"
  // text; the Korean clause only appears when `locale` is `ko`. Mirrors the
  // daemon-side composer in apps/daemon/src/prompts/system.ts.
  parts.push(renderReadabilityPrompt(locale));
  parts.push('\n\n---\n\n');

  parts.push(DISCOVERY_AND_PHILOSOPHY, '\n\n---\n\n');

  parts.push('# Identity and workflow charter (background)\n\n', BASE_SYSTEM_PROMPT);

  // Mid-conversation clarification reuses the same `<question-form>` flow as
  // turn-1 discovery (DISCOVERY_AND_PHILOSOPHY) so the host keeps ONE unified
  // questions surface: a chat banner, the form in the right-hand Questions
  // tab, and answers returned as the next user message. Mirrors the
  // daemon-side composer's "## Clarifying questions mid-conversation" section
  // in apps/daemon/src/prompts/system.ts — keep both in sync so a daemon chat
  // and a BYOK/API chat route follow-up choices through the same surface
  // instead of drifting back to plain markdown option lists.
  parts.push(
    "\n\n---\n\n## Clarifying questions mid-conversation\n\nWhen you need a clarification AFTER turn 1 and the natural answer is one of a small finite set of choices (2-4 options per question), emit a `<question-form>` block — the same markup turn-1 discovery uses — instead of writing a bulleted list of options in markdown. The host renders it as a Questions banner the user opens in the side tab; a markdown list renders as plain text and forces the user to type a reply. Use free-form prose questions only when the answer is naturally open-ended, needs more than ~4 options, or is a single yes/no. Do NOT also duplicate the form's questions as markdown text alongside it.",
  );

  // Mirrors the daemon-side composer in apps/daemon/src/prompts/system.ts —
  // keep both copies of this preamble in sync so a CLI chat and a BYOK
  // chat with the same memory both see the same wording. The "brand
  // wins on conflict / skill workflow wins on conflict / preferences
  // are still authoritative for tone+terminology" framing is what
  // stops the model from treating remembered preferences as harder
  // than the active design system.
  if (memoryBody && memoryBody.trim().length > 0) {
    parts.push(
      `\n\n## Personal memory (auto-extracted from past chats)\n\nThe following facts have been sedimented from this user's previous conversations and edited in the settings panel. Treat them as preferences and context, NOT hard rules: when they collide with the active design system tokens, the brand wins; when they collide with the active skill's workflow, the skill wins. They are still authoritative for tone, voice, terminology, and what the user already told you about themselves and their goals — never re-ask the user about something already captured here.\n\n${memoryBody.trim()}`,
    );
  }

  if (userInstructions && userInstructions.trim().length > 0) {
    parts.push(
      `\n\n## Custom instructions (user-level)\n\nThe user has set the following persistent instructions. Apply them as defaults to every project. When a project-level instruction below contradicts a point here, the project-level version wins.\n\n${userInstructions.trim()}`,
    );
  }

  if (projectInstructions && projectInstructions.trim().length > 0) {
    parts.push(
      `\n\n## Custom instructions (project-level)\n\nThe user has set the following instructions for this specific project. They take precedence over user-level custom instructions whenever both address the same topic (e.g. if user-level says "use spaces" but project-level says "use tabs", use tabs).\n\n${projectInstructions.trim()}`,
    );
  }

  if (activeDesignSystemBody && activeDesignSystemBody.length > 0) {
    parts.push(
      `\n\n## Active design system${designSystemTitle ? ` — ${designSystemTitle}` : ''}\n\nTreat the following DESIGN.md as authoritative for color, typography, spacing, and component rules. Do not invent tokens outside this palette. When you copy the active skill's seed template, bind these tokens into its \`:root\` block before generating any layout.\n\n${activeDesignSystemBody}`,
    );
  }

  if (skillBody && skillBody.trim().length > 0) {
    const preflight = derivePreflight(skillBody);
    parts.push(
      `\n\n## Active skill${skillName ? ` — ${skillName}` : ''}\n\nFollow this skill's workflow exactly.${preflight}\n\n${skillBody.trim()}`,
    );
  }

  if (pluginBlock && pluginBlock.trim().length > 0) {
    parts.push(pluginBlock);
  }

  if (Array.isArray(activeStageBlocks) && activeStageBlocks.length > 0) {
    for (const block of activeStageBlocks) {
      if (typeof block === 'string' && block.trim().length > 0) {
        parts.push(block);
      }
    }
  }

  const metaBlock = renderMetadataBlock(metadata, template);
  if (metaBlock) parts.push(metaBlock);

  // Decks have a load-bearing framework (nav, counter, scroll JS, print
  // stylesheet for PDF stitching). Pin it last so it overrides any softer
  // wording earlier in the stack ("write a script that handles arrows…").
  //
  // We fire on either (a) the active skill is a deck skill OR (b) the
  // project metadata declares kind=deck. Case (b) catches projects created
  // without a skill (skill_id null) — without this, a deck-kind project
  // with no bound skill gets neither a skill seed nor the framework
  // skeleton, and the agent writes scaling / nav / print logic from scratch
  // with the same buggy `place-items: center` + transform pattern we keep
  // having to fix at runtime. Skill seeds (when present) win — they
  // already define their own opinionated framework (simple-deck's
  // scroll-snap, guizang-ppt's magazine layout) and re-pinning the generic
  // skeleton would conflict. The skill-seed path takes over via
  // `derivePreflight` above, so we only fire the generic skeleton when no
  // skill seed is on offer.
  const isDeckProject = skillMode === 'deck' || metadata?.kind === 'deck';
  const isFreeformProject = !skillMode && (!metadata || metadata.kind === 'other');
  const hasSkillSeed =
    !!skillBody && /assets\/template\.html/.test(skillBody);
  if (isDeckProject && !hasSkillSeed) {
    parts.push(`\n\n---\n\n${DECK_FRAMEWORK_DIRECTIVE}`);
  } else if (isFreeformProject && !hasSkillSeed) {
    // Freeform / kind=other projects skip the kind picker entirely and
    // land here. If the user's brief is a deck/keynote/slides ("讲解",
    // "presentation", "make a deck"), the agent used to invent its own
    // scale-to-fit + slide visibility + nav script from scratch and
    // shipped subtle CSS specificity bugs (per-slide layout classes
    // overriding `.slide { display:none }`). Inject the same framework
    // here, prefixed with a one-line conditional so the agent only
    // adopts it when the brief actually is a deck — otherwise the
    // directive is read as background reference and ignored.
    parts.push(
      `\n\n---\n\n## If this brief is a slide deck / keynote / presentation\n\nThe user did not pre-select a "Slide deck" surface, but their request may still call for one. **If — and only if — the brief reads as slides, keynote, presentation, deck, PPT, or 讲解, follow the framework below.** Otherwise ignore everything in this section and continue with the freeform output you would have written anyway.\n\n${DECK_FRAMEWORK_DIRECTIVE}`,
    );
  }

  if (activeDesignSystemBody && activeDesignSystemBody.length > 0) {
    parts.push(ACTIVE_DESIGN_SYSTEM_VISUAL_DIRECTION_OVERRIDE);
  }

  return parts.join('');
}

/**
 * Top-anchored override for API/BYOK mode (streamFormat === 'plain').
 *
 * Why it sits ABOVE DISCOVERY_AND_PHILOSOPHY: that layer starts with
 * "these override anything later in this prompt" and then mandates
 * TodoWrite / Bash / Read / WebFetch on turns 2–3. In daemon mode those
 * tools exist; in API mode they don't, so the agent narrates pseudo-tool
 * markup (`<todo-list>...`, `[读取 X]`) instead of producing structured
 * `tool_use` events the UI can render — bug #313. Pinning the override
 * at the absolute top is the cleanest way to beat the discovery layer's
 * precedence without restructuring its rules.
 *
 * The override does NOT block `<artifact>` blocks — those are how the
 * web UI receives finished HTML in API mode.
 */
const API_MODE_OVERRIDE = `# API mode — no tools available (read first — overrides every rule below)

You are running through a plain Messages API. **No tools are wired through to you.** \`TodoWrite\`, \`Read\`, \`Write\`, \`Edit\`, \`Bash\`, and \`WebFetch\` are unavailable — calls to them will not execute and will not render in the UI.

Every later instruction in this prompt that tells you to "call TodoWrite", "run Bash", "read via Read", or otherwise invoke a tool is describing the daemon-mode workflow. In this API run those instructions are **overridden** — do not attempt them and do not pretend you did.

**Forbidden output:**
- Pseudo-tool markup such as \`<todo-list>...</todo-list>\`, \`<tool-call>\`, or invented XML wrappers around a plan.
- Fake-protocol prose such as \`[读取 template.html ...]\`, \`[读取 layouts.md ...]\`, \`[正在调用 TodoWrite ...]\`, or any \`[doing X]\` placeholder narrating a tool you cannot run.
- Statements like "I'll call TodoWrite to track this" or "let me read the skill file first" — there is no TodoWrite and no Read in this run.

**Allowed output:**
- Plain chat prose to the user (in their language). State your plan as prose — a short numbered list in markdown is fine; it just must not be wrapped in \`<todo-list>\` or claim to be a tool call.
- A final \`<artifact type="text/html">...</artifact>\` block containing a complete \`<!doctype html>\` document when the brief is ready to deliver.
- \`<question-form>\` blocks for discovery (turn 1) and for mid-conversation clarification, exactly as the rules below describe — question-form is markup the UI parses, not a tool call.

If the rules below tell you to plan with TodoWrite, write the plan as prose instead. If they tell you to read skill side files before writing, describe in one sentence which patterns/conventions you're going to apply and proceed. If they tell you to run brand-spec extraction via Bash + Read + WebFetch, ask the user the missing brand questions in the discovery form instead.`;

const CHAT_MODE_OVERRIDE = `# Chat mode — standard conversation (read first — overrides every rule below)

This conversation is in Readable Studio Chat mode. Readable Studio's document workflow is Source Text -> AI Generation -> Direct Editing -> Standalone HTML, helping office workers produce business documents with PowerPoint-like control during enterprise AI transformation.

Use the same available context, files, attachments, MCP servers, project memory, and model capabilities as Design mode. The difference is behavior: answer like a fast, direct, multi-turn desktop chat assistant. Prefer concise prose, explanations, comparisons, debugging help, and follow-up questions only when needed.

Override artifact-first discovery rules below: do not emit a default discovery \`<question-form>\`, do not call TodoWrite just to plan a chat answer, and do not create or edit project files, HTML, PPT, slide decks, images, video, or audio unless the user explicitly asks you to generate/build/design/export/modify something. When the user does ask for a design artifact or file change, you may use the normal Readable Studio agent workflow and the same tools/capabilities available in Design mode.`;

function renderMetadataBlock(
  metadata: ProjectMetadata | undefined,
  template: ProjectTemplate | undefined,
): string {
  if (!metadata) return '';
  const lines: string[] = [];
  lines.push('\n\n## Project metadata');
  lines.push(
    'These are the structured choices the user made (or skipped) when creating this project. Treat known fields as authoritative; for any field marked "(unknown — ask)" you MUST include a matching question in your turn-1 discovery form.',
  );
  lines.push('');
  lines.push(`- **kind**: ${metadata.kind}`);
  if (metadata.platform) {
    lines.push(`- **platform**: ${metadata.platform}`);
  } else if (metadata.kind === 'prototype' || metadata.kind === 'template' || metadata.kind === 'other') {
    lines.push('- **platform**: (unknown — ask: responsive web, desktop web, iOS app, Android app, tablet app, or desktop app?)');
  }
  if (metadata.platformTargets && metadata.platformTargets.length > 0) {
    lines.push(`- **platformTargets**: ${metadata.platformTargets.join(', ')}`);
  }
  if (metadata.platform === 'responsive' || metadata.platformTargets?.includes('responsive')) {
    lines.push(
      '- **responsive web contract**: `responsive` means one web product experience that adapts across modern browser/device ranges, not only legacy desktop/tablet/mobile buckets. It is not an iOS app, Android app, or native tablet app target. Show responsive behavior through real product layout changes; do not render viewport labels as user-facing product content. Cover 2025–2026 breakpoints: mobile compact 360px, mobile standard 390–430px, foldable/small tablet 600–744px, tablet portrait 768–834px, tablet landscape/large tablet 1024–1180px, laptop 1280–1366px, desktop 1440–1536px, and wide 1920px. Use fluid `clamp()` scales, container queries where useful, and explicit layout changes at semantic thresholds. Verify no horizontal scroll at 360px, 390px, 430px, 768px, 820px, 1024px, 1366px, 1440px, and 1920px unless the brief explicitly asks for a pan/board canvas.',
    );
  }
  if ((metadata.platformTargets?.length ?? 0) > 1) {
    lines.push(
      '- **cross-platform deliverable rule**: each selected target keeps the same product goal but MUST be delivered as its own product screen/file when more than one concrete target is selected. Use clear files such as `landing.html` (if enabled), `mobile-ios.html`, `mobile-android.html`, `tablet.html`, `desktop.html`, plus shared `css/` and `js/` when useful. `index.html` may be a launcher/overview that links to these files, but it must not be the only place where mobile/tablet/desktop designs live. Do not collapse cross-platform work into a single tabbed demo, selector UI, comparison board, platform map, or labelled documentation section inside one mock product page.',
    );
  }
  if (metadata.kind === 'prototype' || metadata.kind === 'template' || metadata.kind === 'other') {
    lines.push(
      '- **screen-file-first rule**: each distinct user-facing screen or surface MUST be delivered as its own HTML file unless the user explicitly asks for a single-page scroll or single-file artifact. Do not combine landing pages, product app screens, dashboards, history, pricing, settings, mobile app, tablet app, desktop app, or OS widget surfaces into one long page. Use `index.html` as a launcher/overview that links to screen files when more than one screen exists; it may summarize the product and show screen cards, but it must not contain the full design for every screen.',
    );
    lines.push(
      '- **product-realism rule**: final artifacts must look like real end-user product UI. Do not render project metadata, screen counts, target counts, state counts, "demo only" labels, "settings" panels for choosing platforms, "full design target" badges, viewport/device selector controls, theme/style knobs, platform output maps, behavior-spec sections, or design-process cards inside the product unless the user explicitly asks for a design spec/dashboard. Any navigation/tabs inside the artifact must be real product navigation, not designer controls for switching generated mockups.',
    );
    lines.push(
      '- **visual-system rule**: when the user does not specify colors, layout, or visual direction, you must still make an intentional product-appropriate visual system. Infer a palette from the product category and audience with at least: neutral surface tokens, a primary action color, a secondary/domain accent, and status colors. Avoid plain monochrome/unstyled greyscale outputs. Use tasteful gradients, illustrations, iconography, device/product mockups, and colored state moments where they clarify the product, while still avoiding generic beige/peach/pink/brown AI washes.',
    );
    lines.push(
      '- **app-specific modules rule**: include domain-specific in-app modules/components by default (cards, panels, controls, charts, lists, quick actions, status modules, mini players, checkout/cart summaries, etc. as appropriate). These are product UI modules, not OS home-screen widgets. Give each major module a clear purpose, states, and responsive behavior instead of generic card grids.',
    );
    lines.push(
      '- **CJX-ready UX rule**: the artifact must be implementation-ready, not a static screenshot. Structure CSS tokens/components/responsive sections clearly; include real JavaScript behavior for meaningful UX such as tabs, dialogs, drawers, filters, generation/copy actions, validation, playback controls, or state transitions. If keeping a self-contained `index.html`, put the CSS/JS in clearly labelled blocks; for complex UX, generate `css/` and `js/` files when useful.',
    );
    lines.push(
      '- **interaction-fidelity rule**: when the requested screen includes user input, generation, copying, validation, login, checkout, filtering, or any action verb, build real interactive controls for that screen. Do not substitute static text rows, prefilled-only mockups, screenshot-like device frames, or decorative state cards for editable inputs and working actions.',
    );
  }
  if (metadata.includeLandingPage) {
    lines.push(
      '- **includeLandingPage**: true — create `landing.html` as a separate responsive marketing companion surface in addition to the selected product/app screens. Do not implement the landing page only as a section inside `index.html`, even for responsive-web-only projects. If there is a working product/app screen, create it as a separate file such as `app.html`, `dashboard.html`, or a domain-specific screen name. `index.html` should be a lightweight launcher/overview when multiple files exist. Include hero, value props, product screenshots/device mockups, proof/features, and an appropriate CTA such as waitlist, download, or contact sales.',
    );
  }
  if (metadata.includeOsWidgets) {
    lines.push(
      '- **includeOsWidgets**: true — add platform-native OS home-screen / lock-screen / quick-access widget surfaces where relevant. These are outside-the-app widgets (for example iOS WidgetKit, Android home screen widget, Live Activity/lock screen, tablet glance panel), not in-app cards. Include realistic widget sizes and direct quick actions for the domain.',
    );
  }

  if (metadata.kind === 'prototype') {
    lines.push(
      `- **fidelity**: ${metadata.fidelity ?? '(unknown — ask: wireframe vs high-fidelity)'}`,
    );
  }
  if (metadata.kind === 'deck') {
    lines.push(
      `- **slideCount**: ${metadata.slideCount ?? '(unknown — ask only if the Active plugin / Plugin inputs block does not already include slideCount)'}`,
    );
    lines.push(
      `- **speakerNotes**: ${typeof metadata.speakerNotes === 'boolean' ? metadata.speakerNotes : '(unknown — ask: include speaker notes?)'}`,
    );
  }
  if (metadata.kind === 'template') {
    lines.push(
      `- **animations**: ${typeof metadata.animations === 'boolean' ? metadata.animations : '(unknown — ask: include motion/animations?)'}`,
    );
    if (metadata.templateLabel) {
      lines.push(`- **template**: ${metadata.templateLabel}`);
    }
  }
  if (metadata.inspirationDesignSystemIds && metadata.inspirationDesignSystemIds.length > 0) {
    lines.push(
      `- **inspirationDesignSystemIds**: ${metadata.inspirationDesignSystemIds.join(', ')} — the user picked these systems as *additional* inspiration alongside the primary one. Borrow palette accents, typographic personality, or component patterns from them; don't replace the primary system's tokens.`,
    );
  }

  if (Array.isArray(metadata.contextPlugins) && metadata.contextPlugins.length > 0) {
    lines.push('');
    lines.push('### @ plugin context');
    lines.push(
      'The user selected these plugins as additive context via @ mentions. Treat them as requested references to combine with the brief; only the explicit active plugin block, if present, is the executable/pinned plugin snapshot.',
    );
    for (const plugin of metadata.contextPlugins) {
      const id = typeof plugin.id === 'string' ? plugin.id : '';
      const title = typeof plugin.title === 'string' && plugin.title.trim().length > 0
        ? plugin.title.trim()
        : id;
      if (!id && !title) continue;
      const description = typeof plugin.description === 'string' && plugin.description.trim().length > 0
        ? ` — ${plugin.description.trim()}`
        : '';
      lines.push(`- ${title}${id ? ` (\`${id}\`)` : ''}${description}`);
    }
  }

  if (metadata.kind === 'template' && template && template.files.length > 0) {
    lines.push('');
    lines.push(
      `### Template reference — "${template.name}"${template.description ? ` (${template.description})` : ''}`,
    );
    lines.push(
      'These HTML snapshots are what the user wants to start FROM. Read them as a stylistic + structural reference. You may copy structure, palette, typography, and component patterns; you may adapt them to the new brief; do NOT ship them verbatim. The agent should still produce its own artifact, just one that visibly inherits this template\'s design language.',
    );
    for (const f of template.files) {
      // Cap each file at ~12k chars so a giant template doesn't blow out
      // the system prompt budget. The agent gets enough to read structure.
      const truncated =
        f.content.length > 12000
          ? `${f.content.slice(0, 12000)}\n<!-- … truncated (${f.content.length - 12000} chars omitted) -->`
          : f.content;
      lines.push('');
      lines.push(`#### \`${f.name}\``);
      lines.push('```html');
      lines.push(truncated);
      lines.push('```');
    }
  }

  return lines.join('\n');
}

/**
 * Detect the seed/references pattern shipped by the upgraded
 * web-prototype / mobile-app / simple-deck / guizang-ppt skills, and
 * inject a hard pre-flight rule that lists which side files to Read
 * before doing anything else. The skill body's own workflow already says
 * this — but skills get truncated under context pressure and the agent
 * sometimes skips Step 0. A short up-front directive helps.
 *
 * Returns an empty string when the skill ships no side files (legacy
 * SKILL.md-only skills) so we don't add noise.
 */
function derivePreflight(skillBody: string): string {
  const refs: string[] = [];
  if (/assets\/template\.html/.test(skillBody)) refs.push('`assets/template.html`');
  if (/references\/layouts\.md/.test(skillBody)) refs.push('`references/layouts.md`');
  if (/references\/themes\.md/.test(skillBody)) refs.push('`references/themes.md`');
  if (/references\/components\.md/.test(skillBody)) refs.push('`references/components.md`');
  if (/references\/checklist\.md/.test(skillBody)) refs.push('`references/checklist.md`');
  if (/references\/artifact-schema\.md/.test(skillBody)) refs.push('`references/artifact-schema.md`');
  if (/references\/refresh-contract\.md|refresh-contract\.md/.test(skillBody)) {
    refs.push('`references/refresh-contract.md`');
  }
  if (/references\/html-in-canvas\.md|html-in-canvas\.md/.test(skillBody)) {
    refs.push('`references/html-in-canvas.md`');
  }
  if (refs.length === 0) return '';
  return ` **Pre-flight (do this before any other tool):** Read ${refs.join(', ')} via the path written in the skill-root preamble. If the skill asks for daemon wrapper commands, use the runtime tool environment documented below; it provides the daemon URL and whether a run-scoped tool token is available without exposing token internals. The seed template defines the class system you'll paste into; the layouts file is the only acceptable source of section/screen/slide skeletons; the checklist is your validation gate before emitting \`<artifact>\`. Skipping this step is the #1 reason output regresses to generic AI-slop.`;
}
