import type {
  AgentInfo,
  AgentDiagnostic,
  AgentFixIntent,
  AgentCliEnvPrefs,
  AgentModelPrefs,
  AgentTestRequest,
  AgentRollbackRequestEvent,
  AppVersionInfo,
  AppVersionResponse,
  ChatAttachment,
  ChatCommentAttachment,
  ChatCommentSelectionKind,
  ChatMessage,
  ConnectionTestKind,
  ConnectionTestProtocol,
  ConnectionTestRequest,
  ConnectionTestResponse,
  Conversation,
  DeployConfigResponse,
  DeployProjectFileResponse,
  DesignSystemDetail,
  DesignSystemFileDetail,
  DesignSystemFileSummary,
  DesignSystemGenerationJob,
  DesignSystemPackageAudit,
  DesignSystemPackageAuditIssue,
  DesignSystemProvenance,
  DesignSystemRevision,
  DesignSystemRevisionJobRequest,
  DesignSystemRevisionStatus,
  DesignSystemSummary,
  DesignSystemTokenContractRebuildDecision,
  DesignSystemTokenContractRebuildJobRequest,
  DesignSystemTokenContractRebuildJobResponse,
  ProjectDeploymentsResponse,
  ProviderTestRequest,
  PersistedAgentEvent,
  ProviderModelOption,
  ProviderModelsKind,
  ProviderModelsRequest,
  ProviderModelsResponse,
  Project,
  ProjectLocationPrefs,
  ProjectPlatform,
  ProjectBrowserWorkspaceTab,
  ProjectTabsState,
  PreviewCommentMember,
  PreviewAnnotationStyle,
  PreviewCommentSelectionKind,
  PreviewComment,
  PreviewCommentAttachment,
  PreviewCommentStatus,
  PreviewCommentTarget,
  PreviewCommentUpsertRequest,
  PreviewVisualMarkKind,
  ProjectDisplayStatus,
  ProjectFile,
  ProjectFolder,
  ProjectFileKind,
  ProjectKind,
  ProjectMetadata,
  ProjectTemplate,
  RenameProjectFileResponse,
  CodexPetSummary,
  CodexPetsResponse,
  SyncCommunityPetsRequest,
  SyncCommunityPetsResponse,
  SkillDetail,
  SkillSummary,
  InstallInput,
  InstallSkillResponse,
  InstallDesignSystemResponse,
  UninstallResponse,
  UpdateDeployConfigRequest,
} from '@readable-studio/contracts';

export type {
  CloudflarePagesDeploySelection,
  CloudflarePagesDeploymentInfo,
  CloudflarePagesZonesResponse,
  ChatCommentSelectionKind,
  ProjectLocation,
  PreviewCommentMember,
  PreviewAnnotationStyle,
  PreviewCommentSelectionKind,
  PreviewVisualMarkKind,
  AgentRollbackRequestEvent,
} from '@readable-studio/contracts';

export type ExecMode = 'daemon' | 'api';
export type ApiProtocol = 'anthropic' | 'openai' | 'azure' | 'google' | 'ollama' | 'senseaudio' | 'aihubmix';

// Tab ids are arbitrary strings; the template-literal members below are
// conventions FileWorkspace's `.ws-body` switch keys off (`live:` → live
// artifact viewer, `chat:` → Side Chat tab). See `SideChatTabId` below.
export type ProjectWorkspaceTabId =
  | string
  | SideChatTabId
  | TerminalTabId;

// Side Chat tab convention. A `chat:<conversationId>` tab mounts a secondary
// ChatPane bound to that conversation (Stage 2), mirroring the `live:` scheme
// above.
export type SideChatTabId = `chat:${string}`;

export function sideChatTabId(conversationId: string): SideChatTabId {
  return `chat:${conversationId}`;
}

export function isSideChatTabId(tabId: string): tabId is SideChatTabId {
  return tabId.startsWith('chat:') && tabId.length > 'chat:'.length;
}

export function conversationIdFromSideChatTabId(tabId: SideChatTabId): string {
  return tabId.slice('chat:'.length);
}

// Terminal tab convention. A `terminal:<terminalId>` tab mounts an xterm.js
// surface bound to a daemon PTY session (Stage 3), mirroring the `chat:` and
// `live:` schemes above. The terminal id is the session id returned by
// `POST /api/projects/:id/terminals`.
export type TerminalTabId = `terminal:${string}`;

export function terminalTabId(terminalId: string): TerminalTabId {
  return `terminal:${terminalId}`;
}

export function isTerminalTabId(tabId: string): tabId is TerminalTabId {
  return tabId.startsWith('terminal:') && tabId.length > 'terminal:'.length;
}

export function terminalIdFromTabId(tabId: TerminalTabId): string {
  return tabId.slice('terminal:'.length);
}

export interface ProjectFileWorkspaceEntry {
  kind: 'file';
  tabId: string;
  name: string;
  file: ProjectFile;
}

export type ProjectWorkspaceEntry = ProjectFileWorkspaceEntry;

export interface ApiProtocolConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  apiVersion?: string;
  apiProviderBaseUrl?: string | null;
}

// Per-CLI model + reasoning the user picked in the model menu. Each agent
// keeps its own slot so flipping between Codex and Gemini doesn't reset the
// other one's choice. Missing entries fall back to the agent's first
// declared model (`'default'` — let the CLI pick).
export type AgentModelChoice = AgentModelPrefs;
export type AgentCliEnvConfig = AgentCliEnvPrefs;

export type AppTheme =
  | 'system'
  | 'light'
  | 'dark'
  | 'monokai'
  | 'dracula'
  | 'catppuccin-latte'
  | 'catppuccin-frappe'
  | 'catppuccin-macchiato'
  | 'catppuccin-mocha'
  | 'nord'
  | 'gruvbox'
  | 'solarized-dark'
  | 'one-dark';
export type ThemeScheme = 'light' | 'dark';
export type AccentColorMode = 'theme' | 'custom';

// One animation row inside a pet's sprite atlas. Mirrors the Codex
// hatch-pet `animation-rows.md` reference — `id` lets the overlay map
// interaction states (idle / hover / drag direction / waiting) to the
// correct row regardless of how many rows a particular pet ships.
export interface PetAtlasRowDef {
  // Row index in the atlas, top to bottom.
  index: number;
  // Stable id used by the interaction state machine and i18n keys.
  // Matches the canonical Codex row ids: 'idle', 'running-right', etc.
  id: string;
  // Number of leading frames the row uses. The remaining cells in the
  // row are expected to be transparent / empty.
  frames: number;
  // Frames-per-second the row plays at. Per-row tuning lets idle stay
  // calm while running-* / jumping feel snappy.
  fps: number;
}

// Sprite atlas layout — when present on `PetCustom`, `imageUrl` is the
// full grid (cols × rows) instead of a single horizontal strip. The
// overlay then picks one row to render based on user interaction.
export interface PetAtlasLayout {
  cols: number;
  rows: number;
  // Per-row playback definitions. Order matches the row index.
  rowsDef: PetAtlasRowDef[];
}

// User-tunable companion that floats over the workspace. The full catalog
// lives in `components/pet/pets.ts`; this shape is what gets persisted to
// localStorage so we can roundtrip a customized pet across reloads.
export interface PetCustom {
  // Display name shown in the overlay tooltip and settings card.
  name: string;
  // Single emoji or 1–2 char glyph rendered as the sprite. We render text,
  // not an image, so any user keyboard input works without uploads.
  glyph: string;
  // Hex color used as the overlay halo accent.
  accent: string;
  // Short greeting line shown in the speech bubble on hover / first wake.
  greeting: string;
  // Optional uploaded sprite. Stored as a base64 data URL so it survives
  // localStorage roundtrips without depending on daemon storage. When
  // present, the overlay / rail / settings render the image instead of
  // the text glyph. Cleared when the user picks "Remove image".
  imageUrl?: string;
  // Legacy single-row spritesheet config — when `frames > 1` we treat
  // `imageUrl` as a horizontal strip of `frames` equally-sized cells and
  // step through them at `fps` frames per second using a CSS `steps()`
  // animation, matching the codex-pets-react sheet shape (e.g.
  // tater/spritesheet). `frames === 1` (default) renders the image as a
  // single static cell with the same gentle float animation as the
  // emoji glyph. Ignored when `atlas` is set.
  frames?: number;
  fps?: number;
  // Optional sprite atlas layout. When present, `imageUrl` is the full
  // atlas grid and the overlay renders the active row chosen by the
  // interaction state machine (idle / hover → wave / drag → run / etc.).
  atlas?: PetAtlasLayout;
}

export interface NotificationsConfig {
  // Master switch for the completion sound. Default false — first-run users
  // hear nothing until they opt in.
  soundEnabled: boolean;
  // Sound id played when a turn ends with `runStatus === 'succeeded'`.
  successSoundId: string;
  // Sound id played when a turn ends with `runStatus === 'failed'`.
  failureSoundId: string;
  // Master switch for the browser Notification API banner. Default false.
  desktopEnabled: boolean;
}

export interface PetConfig {
  // True once the user has explicitly picked a pet (built-in or custom).
  // Until then, the entry view shows an "adopt" callout to drive discovery.
  adopted: boolean;
  // Floating overlay visibility — the wake/tuck toggle lives in Settings
  // and on the overlay itself. Defaults to true after adoption.
  enabled: boolean;
  // 'custom' or a built-in id from `BUILT_IN_PETS`. We tolerate unknown ids
  // (e.g. older builds) and fall back to the first built-in.
  petId: string;
  // Free-form custom pet definition. Always present so the customize panel
  // has stable state to bind against, even when a built-in is active.
  custom: PetCustom;
}

export interface AppConfig {
  mode: ExecMode;
  apiKey: string;
  baseUrl: string;
  model: string;
  apiProtocol?: ApiProtocol;
  apiVersion?: string;
  apiProtocolConfigs?: Partial<Record<ApiProtocol, ApiProtocolConfig>>;
  /** Internal config schema/migration version for localStorage upgrades. */
  configMigrationVersion?: number;
  /** Base URL of the selected known provider; cleared once the user customizes provider fields. */
  apiProviderBaseUrl?: string | null;
  agentId: string | null;
  skillId: string | null;
  designSystemId: string | null;
  theme?: AppTheme;
  accentColorMode?: AccentColorMode;
  accentColor?: string;
  // True once the user has been through the welcome onboarding modal at
  // least once (saved or skipped). Bootstrap skips the auto-popup when
  // this is set so refreshing the page doesn't re-prompt.
  onboardingCompleted?: boolean;
  // Per-CLI model picker state, keyed by agent id (e.g. `gemini`, `codex`).
  // Pre-existing configs without this field fall through to the agent's
  // declared default.
  agentModels?: Record<string, AgentModelChoice>;
  // Per-agent non-secret CLI config locations injected into detection and runs.
  agentCliEnv?: AgentCliEnvConfig;
  // Caps the upstream completion length in API mode. Defaults to 8192 when
  // unset; raise it for providers (e.g. MiMo) that allow longer responses.
  maxTokens?: number;
  // Optional Codex-style animated companion. Older configs that pre-date
  // the feature land at `undefined`, which the loader normalizes to a
  // safe default (un-adopted, hidden until the user opts in).
  pet?: PetConfig;
  // Optional task-completion sound + browser notification settings. Older
  // configs that pre-date the feature land at `undefined`, which the loader
  // normalizes to a safe default (everything off).
  notifications?: NotificationsConfig;
  // IDs of skills/design-systems the user has explicitly disabled.
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  enabledAgentIds?: string[];
  // Legacy anonymous install identifier. Retained only so existing daemon
  // config files continue to hydrate; telemetry sinks are disabled in this
  // fork.
  installationId?: string | null;
  // Legacy Unix-millis timestamp for the removed privacy prompt.
  privacyDecisionAt?: number | null;
  // Legacy telemetry preferences. Fresh configs default to false, and runtime
  // telemetry sinks ignore these values in this fork.
  telemetry?: TelemetryConfig;
  customInstructions?: string;
  projectLocations?: ProjectLocationPrefs[];
  defaultProjectLocationId?: string | null;
}

export interface TelemetryConfig {
  metrics?: boolean;
  content?: boolean;
  artifactManifest?: boolean;
}

export type AgentEvent = PersistedAgentEvent | AgentRollbackRequestEvent;

export type {
  ChatAttachment,
  ChatCommentAttachment,
  ChatMessage,
};

export type {
  ProjectBrowserWorkspaceTab,
};

export interface Artifact {
  identifier: string;
  artifactType?: string;
  title: string;
  html: string;
  savedUrl?: string;
}

export interface ExamplePreview {
  source: 'skill' | 'design-system';
  id: string;
  title: string;
  html: string;
}

export interface AgentModelOption {
  id: string;
  label: string;
}

export type Surface = 'web' | 'image' | 'video' | 'audio';

export type {
  AgentInfo,
  AgentDiagnostic,
  AgentFixIntent,
  AgentTestRequest,
  AppVersionInfo,
  AppVersionResponse,
  ConnectionTestKind,
  ConnectionTestProtocol,
  ConnectionTestRequest,
  ConnectionTestResponse,
  Conversation,
  DeployConfigResponse,
  DeployProjectFileResponse,
  DesignSystemDetail,
  DesignSystemFileDetail,
  DesignSystemFileSummary,
  DesignSystemGenerationJob,
  DesignSystemPackageAudit,
  DesignSystemPackageAuditIssue,
  DesignSystemProvenance,
  DesignSystemRevision,
  DesignSystemRevisionJobRequest,
  DesignSystemRevisionStatus,
  DesignSystemSummary,
  DesignSystemTokenContractRebuildDecision,
  DesignSystemTokenContractRebuildJobRequest,
  DesignSystemTokenContractRebuildJobResponse,
  ProjectDeploymentsResponse,
  Project,
  ProjectPlatform,
  PreviewComment,
  PreviewCommentAttachment,
  PreviewCommentStatus,
  PreviewCommentTarget,
  PreviewCommentUpsertRequest,
  ProjectDisplayStatus,
  ProjectFile,
  ProjectFolder,
  ProjectFileKind,
  ProjectKind,
  ProjectMetadata,
  ProjectTemplate,
  RenameProjectFileResponse,
  ProviderTestRequest,
  ProviderModelOption,
  ProviderModelsKind,
  ProviderModelsRequest,
  ProviderModelsResponse,
  CodexPetSummary,
  CodexPetsResponse,
  SyncCommunityPetsRequest,
  SyncCommunityPetsResponse,
  SkillDetail,
  SkillSummary,
  InstallInput,
  InstallSkillResponse,
  InstallDesignSystemResponse,
  UninstallResponse,
  UpdateDeployConfigRequest,
};

export type OpenTabsState = ProjectTabsState;
