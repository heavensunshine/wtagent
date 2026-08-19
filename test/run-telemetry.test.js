import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRunTelemetry,
  RunTelemetry,
} from "../src/cli/run-telemetry.js";

function event(type, ms, payload = {}) {
  return {
    type,
    timestamp: new Date(ms).toISOString(),
    payload,
  };
}

test("counts batched calls as one tool round and measures model/tool time", () => {
  const telemetry = new RunTelemetry();
  telemetry.handle(event("runtime.initializing", 0));
  telemetry.handle(event("model.message_sent", 100));
  telemetry.handle(event("model.message_complete", 1_100));
  telemetry.handle(event("tool.proposed", 1_120, { id: "a" }));
  telemetry.handle(event("tool.proposed", 1_130, { id: "b" }));
  telemetry.handle(event("tool.started", 1_200, { id: "a" }));
  telemetry.handle(event("tool.completed", 1_500, {
    result: { callId: "a" },
  }));
  telemetry.handle(event("tool.started", 1_520, { id: "b" }));
  telemetry.handle(event("tool.completed", 1_720, {
    result: { callId: "b" },
  }));
  telemetry.handle(event("tool.result_sent", 1_800, { id: "a" }));
  telemetry.handle(event("tool.result_sent", 1_810, { id: "b" }));
  telemetry.handle(event("model.message_complete", 3_810));

  assert.deepEqual(telemetry.snapshot(4_000), {
    modelTurns: 2,
    toolRounds: 1,
    toolCalls: 2,
    batchedToolRounds: 1,
    batchedToolCalls: 2,
    protocolRetries: 0,
    modelWaitMs: 3_010,
    toolExecutionMs: 500,
    otherMs: 490,
    totalElapsedMs: 4_000,
    modelWaitPercent: 75,
  });
});

test("deduplicates invalid events for already proposed calls", () => {
  const telemetry = new RunTelemetry();
  telemetry.handle(event("runtime.initializing", 0));
  telemetry.handle(event("model.message_complete", 100));
  telemetry.handle(event("tool.proposed", 110, { id: "same" }));
  telemetry.handle(event("tool.invalid", 120, { id: "same" }));
  telemetry.handle(event("tool.invalid", 130, { id: "validation-only" }));

  const metrics = telemetry.snapshot(200);
  assert.equal(metrics.toolRounds, 1);
  assert.equal(metrics.toolCalls, 2);
  assert.equal(metrics.batchedToolRounds, 1);
  assert.equal(metrics.batchedToolCalls, 2);
});

test("counts protocol retries as additional observed model wait", () => {
  const telemetry = new RunTelemetry();
  telemetry.handle(event("runtime.initializing", 0));
  telemetry.handle(event("model.message_sent", 0));
  telemetry.handle(event("model.message_complete", 2_000));
  telemetry.handle(event("protocol.invalid", 2_050));
  telemetry.handle(event("model.message_complete", 5_050));

  const metrics = telemetry.snapshot(5_100);
  assert.equal(metrics.modelTurns, 2);
  assert.equal(metrics.protocolRetries, 1);
  assert.equal(metrics.modelWaitMs, 5_000);
  assert.equal(metrics.totalElapsedMs, 5_100);
});

test("resets metrics for each runtime initialization", () => {
  const telemetry = new RunTelemetry();
  telemetry.handle(event("runtime.initializing", 0));
  telemetry.handle(event("model.message_sent", 0));
  telemetry.handle(event("model.message_complete", 1_000));
  telemetry.handle(event("runtime.initializing", 2_000));
  telemetry.handle(event("model.message_sent", 2_100));
  telemetry.handle(event("model.message_complete", 2_600));

  const metrics = telemetry.snapshot(3_000);
  assert.equal(metrics.modelTurns, 1);
  assert.equal(metrics.modelWaitMs, 500);
  assert.equal(metrics.totalElapsedMs, 1_000);
});

test("formats a compact human-readable run summary", () => {
  const line = formatRunTelemetry({
    modelTurns: 3,
    toolRounds: 2,
    toolCalls: 7,
    batchedToolRounds: 1,
    batchedToolCalls: 6,
    protocolRetries: 1,
    modelWaitMs: 58_400,
    toolExecutionMs: 800,
    totalElapsedMs: 60_100,
    modelWaitPercent: 97,
  });

  assert.match(line, /3 model turns/);
  assert.match(line, /2 tool rounds\/7 calls/);
  assert.match(line, /1 batched round\/6 calls/);
  assert.match(line, /1 format retry/);
  assert.match(line, /model wait 58\.4s \(97%\)/);
  assert.match(line, /tools 0\.8s/);
  assert.match(line, /total 60\.1s/);
});
