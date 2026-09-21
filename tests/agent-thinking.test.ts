import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";
import { agentDefinitionKey } from "../src/agent-registry.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

test("separate thinking, suffix, and policy precedence reach actual SDK provider options", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-thinking-options-"));
  const provider = "fauxtest-thinking-options";
  const modelId = "literal:high";
  const core = createFauxCore({
    provider,
    models: [{ id: modelId, name: "Thinking", reasoning: true, contextWindow: 128000, maxTokens: 4096 }],
  });
  const requests: Array<{ model: string; reasoning: unknown }> = [];
  try {
    await withFakeHomeAsync(root, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
      runtime.registerProvider(provider, {
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-unused",
        api: core.api,
        streamSimple: (model, context, options) => {
          requests.push({ model: model.id, reasoning: options?.reasoning });
          return core.streamSimple(model, context, options);
        },
        models: [
          {
            id: modelId,
            name: "Thinking",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      });
      core.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("ok", { stopReason: "stop" })));
      const agent = new WorkflowAgent({ cwd: root, modelRegistry: new ModelRegistry(runtime) });
      const selected: string[] = [];
      await agent.run("task", {
        model: `${provider}/${modelId}`,
        thinking: "low",
        onModelResolved: (value) => selected.push(value),
      });
      await agent.run("task", {
        model: `${provider}/${modelId}:high`,
        thinking: "low",
        onModelResolved: (value) => selected.push(value),
      });
      await agent.run("task", {
        model: `${provider}/${modelId}`,
        thinking: "high",
        onModelResolved: (value) => selected.push(value),
        preSpawnModel: (ctx) => {
          assert.equal(ctx.requestedThinking, "high");
          return { action: "use", model: `${provider}/${modelId}:low` };
        },
      });
      assert.deepEqual(requests, [
        { model: modelId, reasoning: "low" },
        { model: modelId, reasoning: "high" },
        { model: modelId, reasoning: "low" },
      ]);
      assert.deepEqual(selected, [
        `${provider}/${modelId}:low`,
        `${provider}/${modelId}:high`,
        `${provider}/${modelId}:low`,
      ]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("omitted agent-type thinking preserves the previous definition identity exactly", () => {
  assert.equal(
    agentDefinitionKey({ name: "old", prompt: "p", source: "project" }),
    JSON.stringify({ tools: null, disallowedTools: null, model: null, isolation: null, prompt: "p" }),
  );
});
