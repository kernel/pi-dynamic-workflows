import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";
import {
  _getStealMapForTests,
  _registerHostSessionForTests,
  _resetDeliveryRegistriesForTests,
  _setStreamingAckTimeoutForTests,
  suspendSessionDelivery,
} from "../src/task-panel.js";

const temporaryRoots: string[] = [];
afterEach(() => {
  _resetDeliveryRegistriesForTests();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function host() {
  type Message = { customType: string; content: string; display: boolean; details?: { deliveryId?: string } };
  type Event = { type: string; message?: Message & { role: string }; followUp?: unknown[] };
  const listeners = new Set<(event: Event) => void>();
  type BranchEntry = { id: string; type: string; customType: string; details?: unknown };
  const branch: BranchEntry[] = [];
  const abandonedEntries: BranchEntry[] = [];
  const root = mkdtempSync(join(tmpdir(), "pi-delivery-history-"));
  temporaryRoots.push(root);
  const sessionFile = join(root, "session.jsonl");
  // The production scan searches for a full newline-delimited JSONL record.
  writeFileSync(sessionFile, "\n");
  const appendPersistedEntry = (message: Message) => {
    const entry: BranchEntry = {
      id: `entry-${branch.length}`,
      type: "custom_message",
      customType: message.customType,
      details: message.details,
    };
    branch.push(entry);
    appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
  };
  const sent: Message[] = [];
  let resolveTurn = () => {};
  let resolveIdle = () => {};
  const session = {
    isStreaming: true,
    isIdle: false,
    waitForIdle: () =>
      new Promise<void>((resolve) => {
        resolveIdle = resolve;
      }),
    sessionManager: {
      persist: true,
      getSessionId: () => "idle-host",
      getBranch: () => branch,
      getEntries: () => [...branch, ...abandonedEntries],
      getSessionFile: () => sessionFile,
    },
    subscribe(listener: (event: Event) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendCustomMessage(message: Message) {
      assert.equal(session.isStreaming, false, "never enqueue a custom follow-up while streaming");
      sent.push(message);
      session.isStreaming = true;
      session.isIdle = false;
      return new Promise<void>((resolve) => {
        resolveTurn = resolve;
      });
    },
  };
  const emit = (event: Event) => {
    for (const listener of listeners) listener(event);
  };
  _registerHostSessionForTests(session);
  const send = _getStealMapForTests().get("idle-host");
  assert.ok(send);
  return {
    session,
    sent,
    listeners,
    emit,
    send: () =>
      Promise.resolve(
        send(
          { customType: "workflow-result", content: "done", display: true, details: { deliveryId: "delivery-one" } },
          { triggerTurn: true, deliverAs: "followUp" },
        ),
      ),
    async idle() {
      session.isStreaming = false;
      session.isIdle = true;
      resolveIdle();
      emit({ type: "agent_settled" });
      await tick();
    },
    persist() {
      const message = sent[0];
      assert.ok(message);
      emit({ type: "message_end", message: { ...message, role: "custom" } });
      // Match Pi: listeners run just before the session entry is appended.
      appendPersistedEntry(message);
    },
    rememberOnly(message = sent[0]) {
      assert.ok(message);
      branch.push({
        id: `entry-${branch.length}`,
        type: "custom_message",
        customType: message.customType,
        details: message.details,
      });
    },
    rememberAbandoned(message: Message) {
      abandonedEntries.push({
        id: `abandoned-${abandonedEntries.length}`,
        type: "custom_message",
        customType: message.customType,
        details: message.details,
      });
    },
    finishTurn: () => resolveTurn(),
  };
}

test("unrelated queue updates cannot cause duplicate custom enqueues", async () => {
  const h = host();
  const pending = h.send();
  h.emit({ type: "queue_update", followUp: [] });
  h.emit({ type: "agent_end" });
  await tick();
  assert.equal(h.sent.length, 0);
  await h.idle();
  assert.equal(h.sent.length, 1);
  h.persist();
  await pending;
  assert.equal(h.listeners.size, 0);
  h.finishTurn();
});

test("timeout before idle owns no queued message and can safely retry", async () => {
  _setStreamingAckTimeoutForTests(15);
  const h = host();
  const rejected = assert.rejects(h.send(), /idle host/);
  await delay(25);
  await rejected;
  assert.equal(h.sent.length, 0);
  const retry = h.send();
  await h.idle();
  h.persist();
  await retry;
  assert.equal(h.sent.length, 1);
  h.finishTurn();
});

test("persisted input ACK does not wait for the model response or resend on elapsed time", async () => {
  _setStreamingAckTimeoutForTests(15);
  const h = host();
  await h.idle();
  const pending = h.send();
  await delay(25);
  assert.equal(h.sent.length, 1);
  h.persist();
  await pending;
  await h.send();
  assert.equal(h.sent.length, 1, "history deduplicates an already accepted delivery");
  h.finishTurn();
});

test("a memory-only branch entry is not an ACK and does not deduplicate a new send", async () => {
  const h = host();
  h.rememberOnly({
    customType: "workflow-result",
    content: "old",
    display: true,
    details: { deliveryId: "delivery-one" },
  });
  await h.idle();
  const pending = h.send();
  assert.equal(h.sent.length, 1, "an unpersisted branch entry must not suppress delivery");
  h.rememberOnly();
  h.finishTurn();
  await assert.rejects(pending, /without persisting/);
});

test("a later persisted entry with the same delivery id ACKs despite an earlier memory-only entry", async () => {
  const h = host();
  h.rememberOnly({
    customType: "workflow-result",
    content: "first attempt",
    display: true,
    details: { deliveryId: "delivery-one" },
  });
  await h.idle();
  const pending = h.send();
  assert.equal(h.sent.length, 1, "memory-only history does not suppress the retry");
  h.persist();
  await pending;
  h.finishTurn();
});

test("an abandoned branch entry is not durable delivery history", async () => {
  const h = host();
  h.rememberAbandoned({
    customType: "workflow-result",
    content: "abandoned",
    display: true,
    details: { deliveryId: "delivery-one" },
  });
  await h.idle();
  const pending = h.send();
  assert.equal(h.sent.length, 1, "an abandoned branch cannot deduplicate a live delivery");
  h.persist();
  await pending;
  h.finishTurn();
});

test("suspension cancels the unsent idle waiter without leaving an old queue item", async () => {
  const h = host();
  const rejected = assert.rejects(h.send(), /suspended/);
  suspendSessionDelivery("idle-host");
  await rejected;
  await h.idle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.listeners.size, 0);
});

test("waitForIdle is the only idle boundary; auto_compaction_end is not faked", async () => {
  const h = host();
  h.session.isStreaming = false;
  const pending = h.send();
  await tick();
  assert.equal(h.sent.length, 0);
  await h.idle();
  assert.equal(h.sent.length, 1);
  h.persist();
  await pending;
  h.finishTurn();
});

test("suspending a started send retains its ownership until persistence settles", async () => {
  const h = host();
  await h.idle();
  const pending = h.send();
  assert.equal(h.sent.length, 1);
  suspendSessionDelivery("idle-host");
  h.persist();
  await pending;
  assert.equal(h.sent.length, 1, "suspend must not cancel or resend a started host send");
  h.finishTurn();
});
