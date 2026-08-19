import test from "node:test";
import assert from "node:assert/strict";
import {
  createMachineError,
  createMachineModeError,
  createMachineSuccess,
  writeMachineOutput,
} from "../src/cli/machine-output.js";

test("machine success output has a stable schema", () => {
  assert.deepEqual(
    createMachineSuccess({
      sessionId: "session_123",
      message: "review complete",
      projectRoot: "/workspace/project",
    }),
    {
      schemaVersion: 1,
      status: "completed",
      sessionId: "session_123",
      result: "review complete",
      projectRoot: "/workspace/project",
    },
  );
});

test("machine errors expose a stable code and optional safe details", () => {
  const error = createMachineModeError(
    "APPROVAL_REQUIRED",
    "Approval required for terminal.exec.",
    {
      tool: "terminal.exec",
      reasons: ["command requires confirmation"],
    },
  );

  assert.deepEqual(createMachineError(error), {
    schemaVersion: 1,
    status: "error",
    error: {
      code: "APPROVAL_REQUIRED",
      message: "Approval required for terminal.exec.",
      details: {
        tool: "terminal.exec",
        reasons: ["command requires confirmation"],
      },
    },
  });
});

test("machine errors fall back to WTAGENT_ERROR", () => {
  assert.deepEqual(createMachineError(new Error("boom")), {
    schemaVersion: 1,
    status: "error",
    error: {
      code: "WTAGENT_ERROR",
      message: "boom",
    },
  });
});

test("machine output is one compact JSON line", () => {
  let output = "";
  const stream = {
    write(chunk) {
      output += chunk;
    },
  };

  writeMachineOutput({ status: "completed", result: "ok" }, { stream });
  assert.equal(output, '{"status":"completed","result":"ok"}\n');
  assert.deepEqual(JSON.parse(output), {
    status: "completed",
    result: "ok",
  });
});
