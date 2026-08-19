import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRequestGuardedAdapter } from "../src/browser/request-guarded-adapter.js";

class FakeAdapter {
  constructor({ profileDir }) {
    this.profileDir = profileDir;
    this.sent = [];
    this.reply = "ok";
    this.throwOnWait = null;
    this.reconnects = 0;
  }

  async startConversation() {}

  async reconnect() {
    this.reconnects += 1;
  }

  async sendMessage(text) {
    this.sent.push(text);
  }

  async waitForTurnComplete() {
    if (this.throwOnWait) {
      throw this.throwOnWait;
    }
    return this.reply;
  }
}

async function makeAdapter(t, config = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-guard-adapter-"));
  const profileDir = path.join(base, "chrome-profile");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(
    path.join(base, "config.json"),
    `${JSON.stringify({
      requestGuard: {
        minIntervalMs: 0,
        maxRequestsPerRun: 10,
        maxRequestsPerHour: 20,
        circuitOpenMs: 60_000,
        ...config,
      },
    })}\n`,
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const Guarded = createRequestGuardedAdapter(FakeAdapter, {
    providerId: "chatgpt",
    isLimitNotice: (text) => text === "LIMIT",
  });
  return new Guarded({ profileDir });
}

test("every physical adapter send consumes the per-run budget", async (t) => {
  const adapter = await makeAdapter(t, { maxRequestsPerRun: 2 });
  await adapter.startConversation();
  await adapter.sendMessage("one");
  await adapter.sendMessage("two");
  await assert.rejects(
    adapter.sendMessage("three"),
    (error) => error.code === "REQUEST_GUARD_RUN_LIMIT",
  );
  assert.deepEqual(adapter.sent, ["one", "two"]);
});

test("a new conversation run resets the run budget but reconnect restore does not", async (t) => {
  const adapter = await makeAdapter(t, { maxRequestsPerRun: 1 });
  await adapter.startConversation();
  await adapter.sendMessage("first");

  await adapter.reconnect();
  await adapter.startConversation();
  await assert.rejects(
    adapter.sendMessage("hidden retry"),
    (error) => error.code === "REQUEST_GUARD_RUN_LIMIT",
  );

  await adapter.startConversation();
  await adapter.sendMessage("new run");
  assert.deepEqual(adapter.sent, ["first", "new run"]);
});

test("usage-limit errors open the provider circuit before propagating", async (t) => {
  const adapter = await makeAdapter(t);
  await adapter.startConversation();
  await adapter.sendMessage("request");
  const error = new Error("provider says usage limit");
  error.code = "USAGE_LIMIT_REACHED";
  adapter.throwOnWait = error;

  await assert.rejects(
    adapter.waitForTurnComplete(),
    (caught) => caught === error,
  );

  await adapter.startConversation();
  await assert.rejects(
    adapter.sendMessage("should not send"),
    (caught) => caught.code === "PROVIDER_CIRCUIT_OPEN",
  );
  assert.deepEqual(adapter.sent, ["request"]);
});

test("text limit notices also open the circuit for the runtime fallback path", async (t) => {
  const adapter = await makeAdapter(t);
  await adapter.startConversation();
  await adapter.sendMessage("request");
  adapter.reply = "LIMIT";
  assert.equal(await adapter.waitForTurnComplete(), "LIMIT");

  await adapter.startConversation();
  await assert.rejects(
    adapter.sendMessage("should not send"),
    (error) => error.code === "PROVIDER_CIRCUIT_OPEN",
  );
});
