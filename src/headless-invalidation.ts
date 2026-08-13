import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HeadlessWorkflowAction } from "./headless.js";
import type { WorkflowManager } from "./workflow-manager.js";

export const HYPESHIP_WORKFLOW_INVALIDATION_TYPE = "hypeship-workflow-invalidation";

export interface HeadlessWorkflowInvalidation {
  runId: string;
  revision: number;
  scopes: Array<"run" | "topology" | "agent">;
  agentIds?: number[];
  terminal?: boolean;
  availableActions?: HeadlessWorkflowAction[];
}

type PendingInvalidation = {
  scopes: Set<HeadlessWorkflowInvalidation["scopes"][number]>;
  agentIds: Set<number>;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Bridge the owning manager's structured events into hidden Pi custom messages.
 * The host process can consume these messages without constructing another
 * WorkflowManager or depending on the terminal UI.
 */
export function installHeadlessWorkflowInvalidations(
  pi: ExtensionAPI,
  manager: Pick<WorkflowManager, "on" | "off">,
  options: { availableActions?(runId: string): HeadlessWorkflowAction[] } = {},
): { dispose(): void } {
  const pending = new Map<string, PendingInvalidation>();
  const revisions = new Map<string, number>();
  const listeners: Array<{ event: string; listener: (payload: { runId?: string; agentId?: number }) => void }> = [];

  const nextRevision = (runId: string): number => {
    const revision = Math.max((revisions.get(runId) ?? 0) + 1, Date.now() * 1000);
    revisions.set(runId, revision);
    return revision;
  };

  const send = (
    runId: string,
    scopes: Set<HeadlessWorkflowInvalidation["scopes"][number]>,
    agentIds: Set<number>,
    terminal: boolean,
  ) => {
    const invalidation: HeadlessWorkflowInvalidation = {
      runId,
      revision: nextRevision(runId),
      scopes: [...scopes],
      agentIds: agentIds.size > 0 ? [...agentIds] : undefined,
      terminal: terminal || undefined,
      availableActions: options.availableActions?.(runId),
    };
    try {
      void Promise.resolve(
        pi.sendMessage(
          {
            customType: HYPESHIP_WORKFLOW_INVALIDATION_TYPE,
            content: JSON.stringify(invalidation),
            display: false,
          },
          { triggerTurn: false },
        ),
      ).catch(() => {
        // The durable VM publisher retries full records. A custom-message failure
        // is therefore a missed hint, healed by terminal gating and safety polls.
      });
    } catch {
      // The durable VM publisher retries full records. A custom-message failure
      // is therefore a missed hint, healed by terminal gating and safety polls.
    }
  };

  const flush = (runId: string, terminal = false) => {
    const entry = pending.get(runId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(runId);
    send(runId, entry.scopes, entry.agentIds, terminal);
  };

  const enqueue = (
    payload: { runId?: string; agentId?: number },
    scopes: HeadlessWorkflowInvalidation["scopes"],
    immediate: boolean,
    terminal = false,
  ) => {
    if (!payload?.runId) return;
    const runId = payload.runId;
    let entry = pending.get(runId);
    if (!entry) {
      entry = {
        scopes: new Set(),
        agentIds: new Set(),
        timer: setTimeout(() => flush(runId), 250),
      };
      entry.timer.unref?.();
      pending.set(runId, entry);
    }
    for (const scope of scopes) entry.scopes.add(scope);
    if (typeof payload.agentId === "number") entry.agentIds.add(payload.agentId);
    if (immediate) flush(runId, terminal);
  };

  const subscribe = (
    event: string,
    scopes: HeadlessWorkflowInvalidation["scopes"],
    immediate = false,
    terminal = false,
  ) => {
    const listener = (payload: { runId?: string; agentId?: number }) => enqueue(payload, scopes, immediate, terminal);
    manager.on(event, listener);
    listeners.push({ event, listener });
  };

  subscribe("agentStart", ["run", "topology", "agent"]);
  subscribe("agentEnd", ["run", "topology", "agent"]);
  subscribe("agentHistory", ["agent"]);
  subscribe("phase", ["run", "topology"]);
  subscribe("log", ["run", "topology"]);
  subscribe("tokenUsage", ["run", "topology"]);
  for (const event of ["paused", "resumed"]) {
    subscribe(event, ["run", "topology", "agent"], true);
  }
  for (const event of ["stopped", "complete", "error"]) {
    subscribe(event, ["run", "topology", "agent"], true, true);
  }

  return {
    dispose() {
      for (const { event, listener } of listeners) manager.off(event, listener);
      for (const runId of [...pending.keys()]) flush(runId);
    },
  };
}
