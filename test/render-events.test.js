import assert from "node:assert/strict";
import test from "node:test";

import { Renderer } from "../src/cli/render-events.js";

function captureStream() {
  let output = "";
  return {
    isTTY: false,
    write(chunk) {
      output += String(chunk);
    },
    output() {
      return output;
    },
  };
}

function event(type, ms, payload = {}) {
  return {
    type,
    timestamp: new Date(ms).toISOString(),
    payload,
  };
}

test("prints browser and conversation lifecycle status only once per CLI session", () => {
  const stream = captureStream();
  const renderer = new Renderer({ stream });

  renderer.handle({ type: "browser.started" });
  renderer.handle({
    type: "conversation.started",
    payload: { mode: "Pro" },
  });
  renderer.handle({ type: "browser.started" });
  renderer.handle({
    type: "conversation.started",
    payload: { mode: "Pro" },
  });

  const output = stream.output();
  assert.equal(output.match(/Chrome started\./g)?.length, 1);
  assert.equal(output.match(/Conversation ready \(Pro\)\./g)?.length, 1);
});

test("keeps non-lifecycle events visible on later turns", () => {
  const stream = captureStream();
  const renderer = new Renderer({ stream });

  renderer.handle({ type: "browser.started" });
  renderer.handle({ type: "browser.started" });
  renderer.handle({
    type: "conversation.mode_selected",
    payload: {
      requested: "Pro",
      status: "unavailable",
      selectedLabel: null,
    },
  });

  assert.match(
    stream.output(),
    /Mode: could not select Pro; continuing on current mode\./,
  );
});

test("renders bounded empty-response recovery and preserved-session guidance", () => {
  const stream = captureStream();
  const renderer = new Renderer({ stream });

  renderer.handle({
    type: "model.empty_response",
    payload: { retry: 2, maxRetries: 3 },
  });
  renderer.handle({
    type: "run.recovery_required",
    payload: {
      message: "ChatGPT returned empty responses after 3 continuation attempts.",
    },
  });

  assert.match(stream.output(), /asking it to continue \(2\/3\)/);
  assert.match(stream.output(), /session and Chrome window remain open/i);
});

test("prints a compact efficiency summary after a completed run", () => {
  const stream = captureStream();
  const renderer = new Renderer({ stream });

  renderer.handle(event("runtime.initializing", 0));
  renderer.handle(event("model.message_sent", 100));
  renderer.handle(event("model.message_complete", 2_100));
  renderer.handle(event("tool.proposed", 2_120, { id: "a", name: "fs.read" }));
  renderer.handle(event("tool.proposed", 2_130, { id: "b", name: "fs.read" }));
  renderer.handle(event("tool.started", 2_200, { id: "a", name: "fs.read" }));
  renderer.handle(event("tool.completed", 2_500, {
    result: { callId: "a", name: "fs.read", ok: true },
  }));
  renderer.handle(event("tool.started", 2_520, { id: "b", name: "fs.read" }));
  renderer.handle(event("tool.completed", 2_720, {
    result: { callId: "b", name: "fs.read", ok: true },
  }));
  renderer.handle(event("tool.result_sent", 2_800, { id: "a" }));
  renderer.handle(event("model.message_complete", 5_800));
  renderer.handle(event("run.completed", 6_000, { message: "Done." }));

  const output = stream.output();
  assert.match(output, /⏺ assistant/);
  assert.match(output, /Run metrics: 2 model turns/);
  assert.match(output, /1 tool round\/2 calls/);
  assert.match(output, /1 batched round\/2 calls/);
  assert.match(output, /model wait 5\.0s \(83%\)/);
  assert.match(output, /tools 0\.5s/);
  assert.match(output, /total 6\.0s/);
});
