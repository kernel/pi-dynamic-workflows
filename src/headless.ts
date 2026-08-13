import type { AgentUsage } from "./agent.js";
import { aggregateAgentUsage, tokenFigures, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import { createRunPersistence, type PersistedAgentState, type PersistedRunState } from "./run-persistence.js";

export {
  type HeadlessWorkflowInvalidation,
  HYPESHIP_WORKFLOW_INVALIDATION_TYPE,
  installHeadlessWorkflowInvalidations,
} from "./headless-invalidation.js";
export type { PersistedAgentState, PersistedRunState };
export { createRunPersistence };

export interface HeadlessRunRow {
  runId: string;
  name: string;
  status: string;
  done: number;
  total: number;
  fresh: number;
  cacheRead: number;
  cost: number;
}

export interface HeadlessPhaseRow {
  title: string;
  done: number;
  total: number;
  fresh: number;
  cacheRead: number;
}

export interface HeadlessAgentRow {
  id: number;
  label: string;
  status: string;
  phase?: string;
  tokens?: number;
  tokenUsage?: AgentUsage;
  model?: string;
}

export interface HeadlessAgentDetail {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  resultPreview?: string;
  error?: string;
  errorCode?: string;
  recoverable?: boolean;
  history?: WorkflowAgentSnapshot["history"];
  tokens?: number;
  tokenUsage?: AgentUsage;
  model?: string;
}

export type HeadlessWorkflowAction = "pause" | "resume" | "stop" | "restart";

export interface HeadlessRunTopology {
  runId: string;
  name: string;
  status: string;
  pauseReason?: string;
  resetHint?: string;
  autoResume?: boolean;
  autoResumeAttempts?: number;
  currentPhase?: string;
  durationMs?: number;
  tokenUsage?: WorkflowSnapshot["tokenUsage"];
  availableActions: HeadlessWorkflowAction[];
  phases: Array<HeadlessPhaseRow & { agents: HeadlessAgentRow[] }>;
}

export interface HeadlessWorkflowSource {
  listRuns(): PersistedRunState[];
  getRun(runId: string): { snapshot: WorkflowSnapshot; status: string } | undefined;
  pause?(runId: string): boolean;
  resume?(runId: string): Promise<boolean>;
  stop?(runId: string): boolean;
  startInBackground?(script: string, args?: unknown): { runId: string };
}

export interface HeadlessWorkflowControlResult {
  status: "completed" | "failed";
  resultRunId?: string;
  errorCode?: "ACTION_UNAVAILABLE" | "CONTROL_FAILED";
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function phaseKey(agent: Pick<WorkflowAgentSnapshot, "phase">): string {
  return agent.phase == null ? "(no phase)" : asText(agent.phase);
}

function toAgentRow(agent: WorkflowAgentSnapshot | PersistedAgentState): HeadlessAgentRow {
  return {
    id: agent.id,
    label: asText(agent.label),
    status: agent.status,
    phase: agent.phase == null ? agent.phase : asText(agent.phase),
    tokens: agent.tokens,
    tokenUsage: agent.tokenUsage,
    model: agent.model,
  };
}

/**
 * Read-only workflow projection service. The Pi extension binds this to its
 * owning WorkflowManager; out-of-process consumers can bind the same contract
 * to the package persistence API without importing TUI code.
 */
export class HeadlessNavigatorModel {
  constructor(private readonly source: HeadlessWorkflowSource) {}

  private state(
    runId: string,
  ): { persisted: PersistedRunState; snapshot?: WorkflowSnapshot; status: string } | undefined {
    const persisted = this.source.listRuns().find((run) => run.runId === runId);
    if (!persisted) return undefined;
    const live = this.source.getRun(runId);
    return { persisted, snapshot: live?.snapshot, status: live?.status ?? persisted.status };
  }

  runs(): HeadlessRunRow[] {
    return this.source.listRuns().map((persisted) => {
      const live = this.source.getRun(persisted.runId);
      const rawAgents = live?.snapshot.agents ?? persisted.agents;
      const agents = Array.isArray(rawAgents) ? rawAgents : [];
      const usage = live?.snapshot.tokenUsage ?? persisted.tokenUsage;
      const fromUsage = tokenFigures(usage);
      const fromAgents = aggregateAgentUsage(agents);
      const figures =
        fromAgents.fresh + fromAgents.cacheRead > fromUsage.fresh + fromUsage.cacheRead ? fromAgents : fromUsage;
      return {
        runId: persisted.runId,
        name: asText(live?.snapshot.name ?? persisted.workflowName),
        status: live?.status ?? persisted.status,
        done: agents.filter((agent) => agent.status === "done").length,
        total: agents.length,
        fresh: figures.fresh,
        cacheRead: figures.cacheRead,
        cost: usage?.cost ?? 0,
      };
    });
  }

  agentDetail(runId: string, agentId: number): HeadlessAgentDetail | undefined {
    const state = this.state(runId);
    if (!state) return undefined;
    const liveAgents = Array.isArray(state.snapshot?.agents) ? state.snapshot.agents : undefined;
    const persistedAgents = Array.isArray(state.persisted.agents) ? state.persisted.agents : [];
    const live = liveAgents?.find((agent) => agent.id === agentId);
    const persisted = persistedAgents.find((agent) => agent.id === agentId);
    const agent = live ?? persisted;
    if (!agent) return undefined;

    let result = agent.result;
    if (result === undefined && agent.status === "done" && persisted) {
      const index = persistedAgents.indexOf(persisted);
      const journal = state.persisted.journal?.find((entry) =>
        persisted.callId
          ? `${entry.runId ?? state.persisted.runId}:${entry.index}` === persisted.callId
          : entry.index === index,
      );
      result = journal?.result;
    }
    return {
      id: agent.id,
      label: asText(agent.label),
      phase: agent.phase == null ? agent.phase : asText(agent.phase),
      prompt: agent.prompt,
      status: agent.status,
      result,
      resultPreview: agent.resultPreview,
      error: agent.error,
      errorCode: agent.errorCode,
      recoverable: agent.recoverable,
      history: agent.history,
      tokens: agent.tokens,
      tokenUsage: agent.tokenUsage,
      model: agent.model,
    };
  }

  availableActions(runId: string): HeadlessWorkflowAction[] {
    const state = this.state(runId);
    if (!state) return [];
    const actions: HeadlessWorkflowAction[] = [];
    if (state.status === "running" && this.source.getRun(runId)) actions.push("pause");
    if (state.status === "running" || state.status === "paused") actions.push("stop");
    if ((state.status === "paused" || state.status === "failed") && state.persisted.script) actions.push("resume");
    if (state.persisted.script) actions.push("restart");
    return actions;
  }

  async executeControl(runId: string, action: HeadlessWorkflowAction): Promise<HeadlessWorkflowControlResult> {
    if (!this.availableActions(runId).includes(action)) {
      return { status: "failed", errorCode: "ACTION_UNAVAILABLE" };
    }
    try {
      if (action === "pause")
        return this.source.pause?.(runId)
          ? { status: "completed" }
          : { status: "failed", errorCode: "ACTION_UNAVAILABLE" };
      if (action === "resume")
        return (await this.source.resume?.(runId))
          ? { status: "completed" }
          : { status: "failed", errorCode: "ACTION_UNAVAILABLE" };
      if (action === "stop")
        return this.source.stop?.(runId)
          ? { status: "completed" }
          : { status: "failed", errorCode: "ACTION_UNAVAILABLE" };
      const persisted = this.source.listRuns().find((run) => run.runId === runId);
      if (!persisted?.script || !this.source.startInBackground)
        return { status: "failed", errorCode: "ACTION_UNAVAILABLE" };
      const restarted = this.source.startInBackground(persisted.script, persisted.args);
      return { status: "completed", resultRunId: restarted.runId };
    } catch {
      return { status: "failed", errorCode: "CONTROL_FAILED" };
    }
  }

  runTopology(runId: string): HeadlessRunTopology | undefined {
    const state = this.state(runId);
    if (!state) return undefined;
    const rawAgents = state.snapshot?.agents ?? state.persisted.agents;
    const agents = (Array.isArray(rawAgents) ? rawAgents : []).map(toAgentRow);
    const rawPhases = state.snapshot?.phases;
    const persistedPhases = Array.isArray(state.persisted.phases) ? state.persisted.phases : [];
    const order = (Array.isArray(rawPhases) ? rawPhases : persistedPhases).map(asText);
    const byPhase = new Map<string, HeadlessAgentRow[]>();
    for (const agent of agents) {
      const key = phaseKey(agent);
      const phaseAgents = byPhase.get(key) ?? [];
      phaseAgents.push(agent);
      byPhase.set(key, phaseAgents);
      if (!order.includes(key)) order.push(key);
    }
    const pauseReason = state.status === "paused" ? (state.persisted.pauseReason ?? "manual") : undefined;
    const usageLimitPaused = pauseReason === "usage_limit";
    return {
      runId,
      name: asText(state.snapshot?.name ?? state.persisted.workflowName),
      status: state.status,
      pauseReason,
      resetHint: usageLimitPaused ? state.persisted.resetHint : undefined,
      autoResume: usageLimitPaused ? state.persisted.autoResume : undefined,
      autoResumeAttempts: usageLimitPaused ? state.persisted.autoResumeAttempts : undefined,
      currentPhase: state.snapshot?.currentPhase ?? state.persisted.currentPhase,
      durationMs: state.snapshot?.durationMs ?? state.persisted.durationMs,
      tokenUsage: state.snapshot?.tokenUsage ?? state.persisted.tokenUsage,
      availableActions: this.availableActions(runId),
      phases: order.map((title) => {
        const phaseAgents = byPhase.get(title) ?? [];
        const usage = aggregateAgentUsage(phaseAgents);
        return {
          title,
          done: phaseAgents.filter((agent) => agent.status === "done").length,
          total: phaseAgents.length,
          fresh: usage.fresh,
          cacheRead: usage.cacheRead,
          agents: phaseAgents,
        };
      }),
    };
  }
}
