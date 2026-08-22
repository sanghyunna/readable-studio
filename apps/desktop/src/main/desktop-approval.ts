import type { BrowserWindow, MessageBoxOptions } from "electron";

import type {
  DesktopRollbackApprovalDecisionRequest,
  DesktopRollbackApprovalDecisionResponse,
  DesktopRollbackApprovalNextResponse,
} from "@readable-studio/contracts";
import { SIDECAR_ENV } from "@readable-studio/sidecar-proto";

const NEXT_APPROVAL_PATH = "/api/desktop/rollback-approvals/next";
const RETRY_DELAY_MS = 1_000;
const APPROVE_BUTTON_ID = 1;

const DESKTOP_ROLLBACK_SAFETY_WARNING =
  "Approving can overwrite current files. Readable Studio creates a safety checkpoint before the rollback.";

type DesktopRollbackApproval = Readonly<
  NonNullable<DesktopRollbackApprovalNextResponse["approval"]>
>;

export type DesktopApprovalLoop = {
  abort(): void;
  done: Promise<void>;
};

export type DesktopApprovalLoopOptions = {
  discoverDaemonUrl(): Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  getParentWindow(): BrowserWindow | null;
  retryDelayMs?: number;
  showMessageBox(parent: BrowserWindow, options: MessageBoxOptions): Promise<{ response: number }>;
  token: string;
};

/** Consume the desktop-only bearer before Chromium or any child can inherit it. */
export function consumeDesktopApprovalToken(env: NodeJS.ProcessEnv): string | null {
  let token: string | null = null;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN) continue;
    const value = env[key]?.trim();
    if (token == null && value) token = value;
    delete env[key];
  }
  return token;
}

function desktopRollbackApprovalDialogOptions(
  approval: DesktopRollbackApproval,
): MessageBoxOptions {
  return {
    buttons: ["Cancel", "Approve rollback"],
    cancelId: 0,
    defaultId: 0,
    detail: [
      `Actor: ${approval.actor}`,
      `Project: ${approval.projectId}`,
      `Conversation: ${approval.conversationId}`,
      `Message: ${approval.targetMessageId}`,
      `Checkpoint: ${approval.targetCheckpointId}`,
      `Mode: ${approval.mode}`,
      `Conflict policy: ${approval.conflictPolicy}`,
      `Run: ${approval.runId}`,
      `Revision: ${approval.revision.slice(0, 12)}`,
      `Files: ${approval.fileChanges.added} added, ${approval.fileChanges.modified} modified, ${approval.fileChanges.deleted} deleted, ${approval.fileChanges.unchanged} unchanged`,
      `Conflicts: ${approval.conflictCount}`,
      `Reason: ${JSON.stringify(approval.reason)}`,
      `Expiry: ${approval.expiresAt} (${new Date(approval.expiresAt).toISOString()})`,
      `Safety warning: ${DESKTOP_ROLLBACK_SAFETY_WARNING}`,
    ].join("\n"),
    message: "Approve this rollback request?",
    noLink: true,
    title: "Approve rollback",
    type: "warning",
  };
}

export function startDesktopApprovalLoop(
  options: DesktopApprovalLoopOptions,
): DesktopApprovalLoop {
  const abortController = new AbortController();
  const done = runDesktopApprovalLoop(options, abortController.signal);
  return { abort: () => abortController.abort(), done };
}

async function runDesktopApprovalLoop(
  options: DesktopApprovalLoopOptions,
  signal: AbortSignal,
): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  while (!signal.aborted) {
    try {
      const daemonUrl = await options.discoverDaemonUrl();
      if (!daemonUrl) {
        await abortableDelay(options.retryDelayMs ?? RETRY_DELAY_MS, signal);
        continue;
      }
      const response = await fetchImpl(privateDaemonUrl(daemonUrl, NEXT_APPROVAL_PATH), {
        headers: { Authorization: `Bearer ${options.token}` },
        signal,
      });
      if (!response.ok) {
        await abortableDelay(options.retryDelayMs ?? RETRY_DELAY_MS, signal);
        continue;
      }
      const approval = parseDesktopApprovalResponse(await response.json());
      if (!approval) continue;
      if (signal.aborted) break;

      const parent = options.getParentWindow();
      let approved = false;
      if (parent) {
        try {
          const result = await options.showMessageBox(
            parent,
            desktopRollbackApprovalDialogOptions(approval),
          );
          approved = result.response === APPROVE_BUTTON_ID;
        } catch {
          // A failed native prompt is a denial, never an implicit approval.
        }
      }
      await postApprovalDecision(
        fetchImpl,
        daemonUrl,
        approval,
        approved,
        options.token,
        options.retryDelayMs ?? RETRY_DELAY_MS,
        signal,
      );
    } catch {
      if (!signal.aborted) {
        await abortableDelay(options.retryDelayMs ?? RETRY_DELAY_MS, signal);
      }
    }
  }
}

async function postApprovalDecision(
  fetchImpl: typeof globalThis.fetch,
  daemonUrl: string,
  approval: DesktopRollbackApproval,
  approved: boolean,
  token: string,
  retryDelayMs: number,
  signal: AbortSignal,
): Promise<void> {
  const url = privateDaemonUrl(
    daemonUrl,
    `/api/desktop/rollback-approvals/${encodeURIComponent(approval.approvalRequestId)}/decision`,
  );
  const decision: DesktopRollbackApprovalDecisionRequest = {
    approved,
    decisionToken: approval.decisionToken,
  };
  while (!signal.aborted) {
    try {
      const response = await fetchImpl(url, {
        body: JSON.stringify(decision),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal,
      });
      const body = await response.json().catch(() => null);
      if (isAcceptedDecision(body)) return;
      if (!isTransientDecisionFailure(response.status)) return;
    } catch {
      if (signal.aborted) return;
    }
    await abortableDelay(retryDelayMs, signal);
  }
}

function isAcceptedDecision(value: unknown): value is DesktopRollbackApprovalDecisionResponse {
  return record(value)?.accepted === true;
}

function isTransientDecisionFailure(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseDesktopApprovalResponse(value: unknown): DesktopRollbackApproval | null {
  const response = record(value);
  if (!response || !("approval" in response)) throw new Error("invalid desktop approval response");
  if (response.approval === null) return null;
  const approval = record(response.approval);
  if (!approval) throw new Error("invalid desktop approval plan");

  const actor = oneOf(approval.actor, ["agent"] as const);
  const conflictPolicy = oneOf(approval.conflictPolicy, ["fail", "keep_current", "overwrite"] as const);
  const mode = oneOf(approval.mode, ["files_only"] as const);
  const expiresAt = approval.expiresAt;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("invalid desktop approval expiry");

  return Object.freeze({
    actor,
    approvalRequestId: requiredString(approval.approvalRequestId),
    conflictPolicy,
    conversationId: requiredString(approval.conversationId),
    decisionToken: requiredString(approval.decisionToken),
    expiresAt: expiresAt as number,
    fileChanges: fileChangeCounts(approval.fileChanges),
    conflictCount: nonNegativeInteger(approval.conflictCount),
    mode,
    projectId: requiredString(approval.projectId),
    revision: sha256(approval.revision),
    reason: stringValue(approval.reason),
    runId: requiredString(approval.runId),
    targetCheckpointId: requiredString(approval.targetCheckpointId),
    targetMessageId: requiredString(approval.targetMessageId),
  });
}

function privateDaemonUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("desktop approval endpoint must be loopback HTTP");
  }
  return url.toString();
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid desktop approval string");
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid desktop approval string");
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("invalid desktop approval count");
  return value as number;
}

function fileChangeCounts(value: unknown) {
  const counts = record(value);
  if (!counts) throw new Error("invalid desktop approval file changes");
  return Object.freeze({
    added: nonNegativeInteger(counts.added),
    modified: nonNegativeInteger(counts.modified),
    deleted: nonNegativeInteger(counts.deleted),
    unchanged: nonNegativeInteger(counts.unchanged),
  });
}

function sha256(value: unknown): string {
  const revision = requiredString(value);
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("invalid desktop approval revision");
  return revision;
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error("invalid desktop approval enum");
  }
  return value as T[number];
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, delayMs));
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}
