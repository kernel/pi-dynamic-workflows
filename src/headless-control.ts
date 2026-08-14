import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HeadlessNavigatorModel, HeadlessWorkflowAction, HeadlessWorkflowControlResult } from "./headless.js";
import { workflowProjectPaths } from "./workflow-paths.js";

export const HYPESHIP_WORKFLOW_CONTROL_COMMAND = "hypeship-workflow-control";
export const HYPESHIP_WORKFLOW_CONTROL_RESULT_TYPE = "hypeship-workflow-control-result";

export interface HeadlessWorkflowControlRequest {
  requestId: string;
  runId: string;
  action: HeadlessWorkflowAction;
}

export interface HeadlessWorkflowControlResponse extends HeadlessWorkflowControlResult {
  requestId: string;
}

type StoredControlReceipt = HeadlessWorkflowControlResponse | { requestId: string; status: "executing" };

function receiptStore(cwd: string) {
  const directory = join(workflowProjectPaths(cwd).rootDir, "control-receipts");
  const pathFor = (requestId: string) => join(directory, `${requestId}.json`);
  const read = (requestId: string): StoredControlReceipt | undefined => {
    const path = pathFor(requestId);
    if (!existsSync(path)) return undefined;
    try {
      const receipt = JSON.parse(readFileSync(path, "utf8")) as StoredControlReceipt;
      if (receipt.requestId === requestId && ["executing", "completed", "failed"].includes(receipt.status)) {
        return receipt;
      }
    } catch {
      // A damaged receipt is indeterminate. Fail closed rather than executing
      // a possibly completed restart-as-new for a second time.
    }
    return { requestId, status: "executing" };
  };
  const write = (receipt: StoredControlReceipt): void => {
    mkdirSync(directory, { recursive: true });
    const path = pathFor(receipt.requestId);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  };
  return { read, write };
}

export function installHeadlessWorkflowControls(
  pi: ExtensionAPI,
  navigator: HeadlessNavigatorModel,
  options: { cwd?: string | (() => string) } = {},
): void {
  const configuredCwd = options.cwd;
  const getCwd: () => string =
    typeof configuredCwd === "function" ? configuredCwd : () => configuredCwd ?? process.cwd();
  const inFlight = new Set<string>();
  pi.registerCommand(HYPESHIP_WORKFLOW_CONTROL_COMMAND, {
    description: "Hypeship internal workflow control bridge",
    async handler(args: string) {
      let request: HeadlessWorkflowControlRequest | undefined;
      try {
        request = JSON.parse(Buffer.from(args.trim(), "base64url").toString("utf8")) as HeadlessWorkflowControlRequest;
      } catch {
        return;
      }
      if (
        typeof request?.requestId !== "string" ||
        !/^pwctl_[A-Za-z0-9_-]+$/.test(request.requestId) ||
        typeof request.runId !== "string" ||
        !["pause", "resume", "stop", "restart"].includes(request.action)
      ) {
        return;
      }
      const receipts = receiptStore(getCwd());
      const stored = receipts.read(request.requestId);
      let response: HeadlessWorkflowControlResponse;
      if (stored?.status === "executing") {
        // A duplicate delivered while this process still owns the attempt must
        // not race its eventual terminal result. An executing receipt with no
        // local owner survived a crash and remains indeterminate, so fail closed.
        if (inFlight.has(request.requestId)) return;
        response = { requestId: request.requestId, status: "failed", errorCode: "CONTROL_FAILED" };
      } else if (stored) {
        response = stored;
      } else {
        inFlight.add(request.requestId);
        try {
          receipts.write({ requestId: request.requestId, status: "executing" });
          response = {
            requestId: request.requestId,
            ...(await navigator.executeControl(request.runId, request.action)),
          };
          receipts.write(response);
        } finally {
          inFlight.delete(request.requestId);
        }
      }
      pi.appendEntry(HYPESHIP_WORKFLOW_CONTROL_RESULT_TYPE, response);
    },
  });
}
