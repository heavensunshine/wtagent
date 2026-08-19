import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_REQUEST_GUARD,
  RequestGuard,
} from "../src/runtime/request-guard.js";

async function fixture(t, requestGuard = null) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-request-guard-"));
  const profileDir = path.join(base, "chrome-profile");
  await fs.mkdir(profileDir, { recursive: true });
  if (requestGuard) {
    await fs.writeFile(
      path.join(base, "config.json"),
      `${JSON.stringify({ requestGuard })}\n`,
      "utf8",
    );
  }
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, profileDir };
}

function fakeClock(start = 1_000_000) {
  let current = start;
  const waits = [];
  return {
    now: () => current,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      current += milliseconds;
    },
    advance(milliseconds) {
      current += milliseconds;
    },
    waits,
  };
}

test("uses conservative local defaults and spaces physical model requests", async (t) => {
  const { profileDir } = await fixture(t);
  const clock = fakeClock();
  const guard = new RequestGuard({
    profileDir,
    providerId: "chatgpt",
    now: clock.now,
    sleep: clock.sleep,
  });

  guard.beginRun();
  const first = await guard.beforeRequest();
  const second = await guard.beforeRequest();

  assert.equal(first.runRequests, 1);
  assert.equal(second.runRequests, 2);
  assert.deepEqual(clock.waits, [DEFAULT_REQUEST_GUARD.minIntervalMs]);
  const status = await guard.status();
  assert.equal(status.requestsInWindow, 2);
  assert.equal(status.config.maxRequestsPerRun, 20);
  assert.equal(status.config.maxRequestsPerHour, 30);
});

test("per-run budget resets without erasing the rolling-hour history", async (t) => {
  const { profileDir } = await fixture(t, {
    minIntervalMs: 0,
    maxRequestsPerRun: 2,
    maxRequestsPerHour: 10,
    circuitOpenMs: 60_000,
  });
  const guard = new RequestGuard({ profileDir, providerId: "chatgpt" });

  guard.beginRun();
  await guard.beforeRequest();
  await guard.beforeRequest();
  await assert.rejects(
    guard.beforeRequest(),
    (error) => error.code === "REQUEST_GUARD_RUN_LIMIT",
  );

  guard.beginRun();
  await guard.beforeRequest();
  const status = await guard.status();
  assert.equal(status.runRequests, 1);
  assert.equal(status.requestsInWindow, 3);
});

test("rolling-hour budget is shared by separate guard instances", async (t) => {
  const { profileDir } = await fixture(t, {
    minIntervalMs: 0,
    maxRequestsPerRun: 10,
    maxRequestsPerHour: 2,
    circuitOpenMs: 60_000,
  });
  const first = new RequestGuard({ profileDir, providerId: "chatgpt" });
  first.beginRun();
  await first.beforeRequest();
  await first.beforeRequest();

  const second = new RequestGuard({ profileDir, providerId: "chatgpt" });
  second.beginRun();
  await assert.rejects(
    second.beforeRequest(),
    (error) => {
      assert.equal(error.code, "REQUEST_GUARD_HOURLY_LIMIT");
      assert.equal(error.machineDetails.requestsInWindow, 2);
      return true;
    },
  );
});

test("state lock prevents concurrent guard instances from both taking the last hourly slot", async (t) => {
  const { profileDir } = await fixture(t, {
    minIntervalMs: 0,
    maxRequestsPerRun: 10,
    maxRequestsPerHour: 1,
    circuitOpenMs: 60_000,
  });
  const left = new RequestGuard({ profileDir, providerId: "chatgpt" });
  const right = new RequestGuard({ profileDir, providerId: "chatgpt" });
  left.beginRun();
  right.beginRun();

  const settled = await Promise.allSettled([
    left.beforeRequest(),
    right.beforeRequest(),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = settled.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "REQUEST_GUARD_HOURLY_LIMIT");
});

test("same-run concurrency cannot oversubscribe the per-run budget", async (t) => {
  const { profileDir } = await fixture(t, {
    minIntervalMs: 0,
    maxRequestsPerRun: 1,
    maxRequestsPerHour: 10,
    circuitOpenMs: 60_000,
  });
  const guard = new RequestGuard({ profileDir, providerId: "chatgpt" });
  guard.beginRun();

  const settled = await Promise.allSettled([
    guard.beforeRequest(),
    guard.beforeRequest(),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = settled.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "REQUEST_GUARD_RUN_LIMIT");
});

test("provider usage limit opens a circuit and permits a probe after cooldown", async (t) => {
  const { profileDir } = await fixture(t, {
    minIntervalMs: 0,
    maxRequestsPerRun: 10,
    maxRequestsPerHour: 10,
    circuitOpenMs: 60_000,
  });
  const clock = fakeClock();
  const guard = new RequestGuard({
    profileDir,
    providerId: "chatgpt",
    now: clock.now,
    sleep: clock.sleep,
  });

  guard.beginRun();
  await guard.beforeRequest();
  await guard.openCircuit({
    reason: "provider_usage_limit",
    detail: "usage limit",
  });
  await assert.rejects(
    guard.beforeRequest(),
    (error) => {
      assert.equal(error.code, "PROVIDER_CIRCUIT_OPEN");
      assert.equal(error.machineDetails.retryAfterMs, 60_000);
      return true;
    },
  );

  clock.advance(60_000);
  await guard.beforeRequest();
  const status = await guard.status();
  assert.equal(status.circuit, null);
  assert.equal(status.requestsInWindow, 2);
});

test("malformed config and state fail closed before another model request", async (t) => {
  const { base, profileDir } = await fixture(t);
  await fs.writeFile(
    path.join(base, "config.json"),
    `${JSON.stringify({ requestGuard: { maxRequestsPerHour: 0 } })}\n`,
  );
  let guard = new RequestGuard({ profileDir, providerId: "chatgpt" });
  guard.beginRun();
  await assert.rejects(
    guard.beforeRequest(),
    (error) => error.code === "REQUEST_GUARD_CONFIG_INVALID",
  );

  await fs.writeFile(path.join(base, "config.json"), "{}\n");
  await fs.writeFile(
    path.join(profileDir, ".wtagent-request-guard.json"),
    "{ nope\n",
  );
  guard = new RequestGuard({ profileDir, providerId: "chatgpt" });
  guard.beginRun();
  await assert.rejects(
    guard.beforeRequest(),
    (error) => error.code === "REQUEST_GUARD_STATE_INVALID",
  );
});
