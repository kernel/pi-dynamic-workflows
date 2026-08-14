import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HeadlessNavigatorModel,
  type HeadlessWorkflowInvalidation,
  type HeadlessWorkflowSource,
  installHeadlessWorkflowInvalidations,
} from "../src/headless.js";
import { installHeadlessWorkflowControls } from "../src/headless-control.js";
import type { PersistedRunState } from "../src/run-persistence.js";

function persisted(status: PersistedRunState["status"] = "running"): PersistedRunState {
  return {
    runId: "wf_1",
    workflowName: "audit",
    sessionId: "session-1",
    script: "agent('check')",
    args: { depth: 2 },
    status,
    phases: [],
    agents: [],
    logs: [],
    startedAt: "2026-08-03T10:00:00Z",
    updatedAt: "2026-08-03T10:00:01Z",
  };
}

test("headless controls expose manager-owned actions and restart as a new run", async () => {
  const run = persisted("paused");
  let resumed = "";
  let restarted: { script: string; args: unknown } | undefined;
  const source: HeadlessWorkflowSource = {
    listRuns: () => [run],
    getRun: () => undefined,
    resume: async (runId) => {
      resumed = runId;
      return true;
    },
    startInBackground: (script, args) => {
      restarted = { script, args };
      return { runId: "wf_2" };
    },
  };
  const model = new HeadlessNavigatorModel(source);

  assert.deepEqual(model.availableActions("wf_1"), ["stop", "resume", "restart"]);
  assert.deepEqual(await model.executeControl("wf_1", "resume"), { status: "completed" });
  assert.equal(resumed, "wf_1");
  assert.deepEqual(await model.executeControl("wf_1", "restart"), {
    status: "completed",
    resultRunId: "wf_2",
  });
  assert.deepEqual(restarted, { script: "agent('check')", args: { depth: 2 } });
});

test("headless projections retain pause semantics and provider cost", () => {
  const run = persisted("paused");
  run.pauseReason = "usage_limit";
  run.resetHint = "resets in 3m";
  run.tokenUsage = { input: 8, output: 2, total: 10, cost: 0.01 };
  const model = new HeadlessNavigatorModel({
    listRuns: () => [run],
    getRun: () => undefined,
  });

  assert.equal(model.runs()[0]?.cost, 0.01);
  const topology = model.runTopology("wf_1");
  assert.equal(topology?.pauseReason, "usage_limit");
  assert.equal(topology?.resetHint, "resets in 3m");
});

test("headless control ignores malformed request envelopes", async () => {
  let handler: ((args: string) => Promise<void>) | undefined;
  let sent = 0;
  const pi = {
    registerCommand(_name: string, command: { handler(args: string): Promise<void> }) {
      handler = command.handler;
    },
    appendEntry() {
      sent += 1;
    },
  };
  const model = new HeadlessNavigatorModel({
    listRuns: () => [persisted("running")],
    getRun: () => undefined,
  });

  installHeadlessWorkflowControls(pi as never, model);
  const malformed = Buffer.from(JSON.stringify({ runId: "wf_1", action: "pause" }), "utf8").toString("base64url");
  await assert.doesNotReject(handler?.(malformed) ?? Promise.reject(new Error("missing control handler")));
  assert.equal(sent, 0);
});

test("headless control suppresses a duplicate while its original attempt is in flight", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "headless-control-"));
  let handler: ((args: string) => Promise<void>) | undefined;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: unknown[] = [];
  const pi = {
    registerCommand(_name: string, command: { handler(args: string): Promise<void> }) {
      handler = command.handler;
    },
    appendEntry(customType: string, data: unknown) {
      sent.push({ customType, data });
    },
  };
  let resumed = 0;
  const model = new HeadlessNavigatorModel({
    listRuns: () => [persisted("paused")],
    getRun: () => undefined,
    resume: async () => {
      resumed += 1;
      await blocked;
      return true;
    },
  });
  installHeadlessWorkflowControls(pi as never, model, { cwd });
  const request = Buffer.from(
    JSON.stringify({ requestId: "pwctl_inflight", runId: "wf_1", action: "resume" }),
    "utf8",
  ).toString("base64url");

  const original = handler?.(request) ?? Promise.reject(new Error("missing control handler"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.doesNotReject(handler?.(request) ?? Promise.reject(new Error("missing control handler")));
  assert.equal(resumed, 1);
  assert.equal(sent.length, 0);
  release?.();
  await original;
  assert.equal(sent.length, 1);
});

test("headless projections tolerate corrupt persisted agent and phase arrays", () => {
  const run = persisted("running") as PersistedRunState & { agents: unknown; phases: unknown };
  run.agents = { invalid: true };
  run.phases = { invalid: true };
  const model = new HeadlessNavigatorModel({
    listRuns: () => [run],
    getRun: () => undefined,
  });

  assert.equal(model.agentDetail("wf_1", 1), undefined);
  assert.deepEqual(model.runTopology("wf_1")?.phases, []);
});

test("headless invalidations coalesce and terminal transitions flush", async () => {
  const manager = new EventEmitter();
  const sent: HeadlessWorkflowInvalidation[] = [];
  const pi = {
    appendEntry(_customType: string, data: HeadlessWorkflowInvalidation) {
      sent.push(data);
    },
  };
  const bridge = installHeadlessWorkflowInvalidations(pi as never, manager as never);

  manager.emit("agentHistory", { runId: "wf_1", agentId: 1 });
  manager.emit("tokenUsage", { runId: "wf_1" });
  await new Promise((resolve) => setTimeout(resolve, 275));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.scopes, ["agent", "run", "topology"]);

  manager.emit("paused", { runId: "wf_1" });
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.terminal, undefined);
  assert.ok((sent[1]?.revision ?? 0) > (sent[0]?.revision ?? 0));

  manager.emit("complete", { runId: "wf_1" });
  assert.equal(sent.length, 3);
  assert.equal(sent[2]?.terminal, true);
  assert.ok((sent[2]?.revision ?? 0) > (sent[1]?.revision ?? 0));
  bridge.dispose();
});

test("headless invalidation bridge swallows append failures", () => {
  const manager = new EventEmitter();
  const pi = {
    appendEntry() {
      throw new Error("failed");
    },
  };
  const bridge = installHeadlessWorkflowInvalidations(pi as never, manager as never);

  assert.doesNotThrow(() => manager.emit("complete", { runId: "wf_1" }));
  bridge.dispose();
});
