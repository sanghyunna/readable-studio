import type { BrowserWindow, MessageBoxOptions } from "electron";

import type { DesktopRollbackApprovalNextResponse } from "@readable-studio/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  consumeDesktopApprovalToken,
  startDesktopApprovalLoop,
  type DesktopApprovalLoop,
} from "../../src/main/desktop-approval.js";

const TOKEN = "desktop-only-bearer";
const PARENT = {} as BrowserWindow;
const PLAN = {
  actor: "agent",
  approvalRequestId: "approval-1",
  conflictPolicy: "overwrite",
  conversationId: "conversation-1",
  decisionToken: "opaque-decision-token",
  expiresAt: Date.parse("2026-07-11T00:00:00.000Z"),
  fileChanges: { added: 1, modified: 2, deleted: 3, unchanged: 4 },
  conflictCount: 2,
  mode: "files_only",
  projectId: "project-1",
  reason: "Restore the last working implementation",
  revision: "a".repeat(64),
  runId: "run-1",
  targetCheckpointId: "checkpoint-1",
  targetMessageId: "message-1",
} as const satisfies NonNullable<DesktopRollbackApprovalNextResponse["approval"]>;
const SAFETY_WARNING =
  "Approving can overwrite current files. Readable Studio creates a safety checkpoint before the rollback.";

async function runApproval(buttonResponse: number, plan: Record<string, unknown> = PLAN) {
  const requests: Array<{ init?: RequestInit; url: string }> = [];
  let loop!: DesktopApprovalLoop;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ init, url });
    if (init?.method === "POST") {
      queueMicrotask(() => loop.abort());
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ approval: plan }), { status: 200 });
  }) as unknown as typeof fetch;
  const showMessageBox = vi.fn(async (_parent: BrowserWindow, _options: MessageBoxOptions) => ({
    response: buttonResponse,
  }));
  loop = startDesktopApprovalLoop({
    discoverDaemonUrl: async () => "http://127.0.0.1:4123",
    fetch: fetchImpl,
    getParentWindow: () => PARENT,
    retryDelayMs: 0,
    showMessageBox,
    token: TOKEN,
  });
  await loop.done;
  return { requests, showMessageBox };
}

async function expectRejectedPlan(plan: Record<string, unknown>) {
  let loop!: DesktopApprovalLoop;
  const showMessageBox = vi.fn();
  const fetchImpl = vi.fn(async () => {
    queueMicrotask(() => loop.abort());
    return new Response(JSON.stringify({ approval: plan }), { status: 200 });
  }) as unknown as typeof fetch;
  loop = startDesktopApprovalLoop({
    discoverDaemonUrl: async () => "http://127.0.0.1:4123",
    fetch: fetchImpl,
    getParentWindow: () => PARENT,
    retryDelayMs: 0,
    showMessageBox,
    token: TOKEN,
  });
  await loop.done;
  expect(showMessageBox).not.toHaveBeenCalled();
}
describe("desktop rollback approval", () => {
  it("consumes every case variant before a BrowserWindow can inherit it", () => {
    const env = {
      ReAdAbLe_DeSkToP_ApPrOvAl_ToKeN: ` ${TOKEN} `,
      PATH: "safe",
    };

    expect(consumeDesktopApprovalToken(env)).toBe(TOKEN);
    expect(env).toEqual({ PATH: "safe" });
  });

  it("renders the frozen plan verbatim with Cancel as the safe default", async () => {
    const { showMessageBox } = await runApproval(0);
    const options = showMessageBox.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      buttons: ["Cancel", "Approve rollback"],
      cancelId: 0,
      defaultId: 0,
      message: "Approve this rollback request?",
      noLink: true,
      type: "warning",
    });
    expect(options.detail).toBe([
      "Actor: agent",
      "Project: project-1",
      "Conversation: conversation-1",
      "Message: message-1",
      "Checkpoint: checkpoint-1",
      "Mode: files_only",
      "Conflict policy: overwrite",
      "Run: run-1",
      "Revision: aaaaaaaaaaaa",
      "Files: 1 added, 2 modified, 3 deleted, 4 unchanged",
      "Conflicts: 2",
      'Reason: "Restore the last working implementation"',
      `Expiry: ${PLAN.expiresAt} (2026-07-11T00:00:00.000Z)`,
      `Safety warning: ${SAFETY_WARNING}`,
    ].join("\n"));
    expect(JSON.stringify(options)).not.toContain(PLAN.decisionToken);
  });

  it("escapes reason line breaks so agent text cannot spoof native plan fields", async () => {
    const { showMessageBox } = await runApproval(0, {
      ...PLAN,
      reason: "looks safe\nSafety warning: fake",
    });
    const options = showMessageBox.mock.calls[0]?.[1];

    expect(options.detail).toContain('Reason: "looks safe\\nSafety warning: fake"');
    expect(options.detail?.split("\n").filter((line) => line.startsWith("Safety warning:"))).toEqual([
      `Safety warning: ${SAFETY_WARNING}`,
    ]);
  });

  it.each([
    [0, false],
    [1, true],
  ] as const)("posts the native button %s decision as approved=%s", async (response, approved) => {
    const { requests, showMessageBox } = await runApproval(response);

    expect(showMessageBox).toHaveBeenCalledWith(PARENT, expect.objectContaining({
      cancelId: 0,
      defaultId: 0,
    }));
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:4123/api/desktop/rollback-approvals/next",
    });
    expect(requests[0]?.init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(requests[1]).toMatchObject({
      url: "http://127.0.0.1:4123/api/desktop/rollback-approvals/approval-1/decision",
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      approved,
      decisionToken: PLAN.decisionToken,
    });
  });

  it("reconnects after a failed poll and continues to the decision", async () => {
    let pollCount = 0;
    let loop!: DesktopApprovalLoop;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        queueMicrotask(() => loop.abort());
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      pollCount += 1;
      if (pollCount === 1) throw new Error("daemon restarting");
      return new Response(JSON.stringify({ approval: PLAN }), { status: 200 });
    }) as unknown as typeof fetch;

    loop = startDesktopApprovalLoop({
      discoverDaemonUrl: async () => "http://127.0.0.1:4123",
      fetch: fetchImpl,
      getParentWindow: () => PARENT,
      retryDelayMs: 0,
      showMessageBox: async () => ({ response: 0 }),
      token: TOKEN,
    });
    await loop.done;

    expect(pollCount).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries one decision without re-prompting and accepts an idempotent response", async () => {
    let loop!: DesktopApprovalLoop;
    let pollCount = 0;
    let decisionCount = 0;
    const decisionBodies: string[] = [];
    const showMessageBox = vi.fn(async () => ({ response: 1 }));
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== "POST") {
        pollCount += 1;
        return new Response(JSON.stringify({ approval: PLAN }), { status: 200 });
      }
      decisionCount += 1;
      decisionBodies.push(String(init.body));
      if (decisionCount === 1) throw new Error("response lost after commit");
      queueMicrotask(() => loop.abort());
      return new Response(JSON.stringify({ accepted: true }), { status: 409 });
    }) as unknown as typeof fetch;

    loop = startDesktopApprovalLoop({
      discoverDaemonUrl: async () => "http://127.0.0.1:4123",
      fetch: fetchImpl,
      getParentWindow: () => PARENT,
      retryDelayMs: 0,
      showMessageBox,
      token: TOKEN,
    });
    await loop.done;

    expect(pollCount).toBe(1);
    expect(decisionCount).toBe(2);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(decisionBodies.map((body) => JSON.parse(body))).toEqual([
      { approved: true, decisionToken: PLAN.decisionToken },
      { approved: true, decisionToken: PLAN.decisionToken },
    ]);
    expect(JSON.stringify(showMessageBox.mock.calls)).not.toContain(PLAN.decisionToken);
  });

  it("cancels an active long poll on shutdown", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch;
    const loop = startDesktopApprovalLoop({
      discoverDaemonUrl: async () => "http://127.0.0.1:4123",
      fetch: fetchImpl,
      getParentWindow: () => PARENT,
      showMessageBox: async () => ({ response: 0 }),
      token: TOKEN,
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    loop.abort();
    await loop.done;

    expect(observedSignal?.aborted).toBe(true);
  });
  it.each([
    ["user actor", { ...PLAN, actor: "user" }],
    ["chat mode", { ...PLAN, mode: "chat_only" }],
    ["null checkpoint", { ...PLAN, targetCheckpointId: null }],
    ["null run", { ...PLAN, runId: null }],
    ["invalid revision", { ...PLAN, revision: "not-a-revision" }],
    ["invalid file counts", { ...PLAN, fileChanges: { ...PLAN.fileChanges, modified: -1 } }],
    ["invalid conflict count", { ...PLAN, conflictCount: -1 }],
  ])("rejects a %s plan before opening the native dialog", async (_label, plan) => {
    await expectRejectedPlan(plan);
  });
});
