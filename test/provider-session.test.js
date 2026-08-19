import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentSession } from "../src/session/agent-session.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-provider-session-"));
  const sessionsDir = path.join(root, "sessions");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { sessionsDir, projectRoot };
}

test("new sessions persist the selected web provider", async (t) => {
  const { sessionsDir, projectRoot } = await fixture(t);
  const session = await AgentSession.create({
    sessionsDir,
    task: "inspect",
    projectRoot,
    mode: "Current",
    provider: "chatgpt",
  });

  assert.equal(session.state.provider, "chatgpt");
  const saved = JSON.parse(
    await fs.readFile(path.join(session.directory, "session.json"), "utf8"),
  );
  assert.equal(saved.provider, "chatgpt");

  const transcript = await session.readTranscript();
  assert.equal(transcript.meta.provider, "chatgpt");
});

test("legacy sessions without provider metadata resume as ChatGPT", async (t) => {
  const { sessionsDir, projectRoot } = await fixture(t);
  const session = await AgentSession.create({
    sessionsDir,
    task: "legacy",
    projectRoot,
    mode: "Current",
  });
  const statePath = path.join(session.directory, "session.json");
  const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
  delete saved.provider;
  await fs.writeFile(statePath, `${JSON.stringify(saved, null, 2)}\n`, "utf8");

  const loaded = await AgentSession.load({
    sessionsDir,
    sessionId: session.sessionId,
  });
  assert.equal(loaded.state.provider, "chatgpt");
});
