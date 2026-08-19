import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { FakeWebModelAdapter } from "../src/browser/fake-web-model-adapter.js";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { TaskSession } from "../src/session/task-session.js";
import { DEFAULT_LIMITS } from "../src/shared/limits.js";

async function createHarness(
  t,
  responses,
  {
    approval = async () => false,
    limits = DEFAULT_LIMITS,
    onEvent = null,
  } = {},
) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-batch-"));
  const projectRoot = path.join(base, "project");
  const tasksDir = path.join(base, "tasks");
  await fs.mkdir(projectRoot);
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const adapter = new FakeWebModelAdapter(responses);
  const session = await TaskSession.create({
    tasksDir,
    task: "Exercise batched tool calls",
    projectRoot,
    mode: null,
  });
  const runtime = new AgentRuntime({
    adapter,
    registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(),
    session,
    approval,
    limits,
    onEvent,
  });

  return { base, projectRoot, adapter, session, runtime };
}

test("executes a batch in declared order and sends one aggregated result", async (t) => {
  const { projectRoot, adapter, session, runtime } = await createHarness(t, [
    `<agent_response>
      <done>false</done>
      <message>Create both files.</message>
      <tool_calls>
        <tool_call id="first" name="fs.write">
          <args><path>a.txt</path><content>A</content></args>
        </tool_call>
        <tool_call id="second" name="fs.write">
          <args><path>b.txt</path><content>B</content></args>
        </tool_call>
      </tool_calls>
    </agent_response>`,
    `<agent_response><done>true</done><message>Created both files.</message></agent_response>`,
  ]);

  const result = await runtime.run();

  assert.equal(result.message, "Created both files.");
  assert.equal(await fs.readFile(path.join(projectRoot, "a.txt"), "utf8"), "A");
  assert.equal(await fs.readFile(path.join(projectRoot, "b.txt"), "utf8"), "B");
  assert.equal(adapter.sentMessages.length, 2);

  const toolResults = adapter.sentMessages[1];
  assert.match(toolResults, /<tool_results>/);
  assert.equal((toolResults.match(/<tool_result\b/g) ?? []).length, 2);
  assert.ok(toolResults.indexOf('id="first"') < toolResults.indexOf('id="second"'));
  assert.equal(Object.keys(session.state.sideEffectTools).length, 2);

  const transcript = await session.readTranscript();
  const functionCalls = transcript.items
    .map((entry) => entry.item)
    .filter((item) => item.type === "function_call");
  const functionOutputs = transcript.items
    .map((entry) => entry.item)
    .filter((item) => item.type === "function_call_output");
  assert.equal(functionCalls.length, 2);
  assert.equal(functionOutputs.length, 2);
  assert.notEqual(functionCalls[0].call_id, functionCalls[1].call_id);
  assert.equal(functionOutputs[0].call_id, functionCalls[0].call_id);
  assert.equal(functionOutputs[1].call_id, functionCalls[1].call_id);
});

test("preflights every approval before executing any batch member", async (t) => {
  const approvalRequired = Object.assign(new Error("approval required"), {
    code: "APPROVAL_REQUIRED",
  });
  const { base, projectRoot, runtime } = await createHarness(t, [
    `<agent_response>
      <done>false</done>
      <tool_calls>
        <tool_call id="inside" name="fs.write">
          <args><path>inside.txt</path><content>inside</content></args>
        </tool_call>
        <tool_call id="outside" name="fs.write">
          <args><path>../outside.txt</path><content>outside</content></args>
        </tool_call>
      </tool_calls>
    </agent_response>`,
  ], {
    approval: async () => {
      throw approvalRequired;
    },
  });

  await assert.rejects(runtime.run(), (error) => error === approvalRequired);
  await assert.rejects(fs.access(path.join(projectRoot, "inside.txt")));
  await assert.rejects(fs.access(path.join(base, "outside.txt")));
});

test("returns per-call failures while continuing independent valid batch members", async (t) => {
  const { projectRoot, adapter, runtime } = await createHarness(t, [
    `<agent_response>
      <done>false</done>
      <tool_calls>
        <tool_call id="bad" name="unknown.tool"><args/></tool_call>
        <tool_call id="good" name="fs.write">
          <args><path>good.txt</path><content>ok</content></args>
        </tool_call>
      </tool_calls>
    </agent_response>`,
    `<agent_response><done>true</done><message>Handled the batch.</message></agent_response>`,
  ]);

  const result = await runtime.run();

  assert.equal(result.message, "Handled the batch.");
  assert.equal(await fs.readFile(path.join(projectRoot, "good.txt"), "utf8"), "ok");
  const toolResults = adapter.sentMessages[1];
  const badStart = toolResults.indexOf('id="bad"');
  const goodStart = toolResults.indexOf('id="good"');
  assert.ok(badStart >= 0 && goodStart > badStart);
  assert.match(toolResults.slice(badStart, goodStart), /status="error"/);
  assert.match(toolResults.slice(goodStart), /status="ok"/);
  assert.match(toolResults, /Unknown tool: unknown\.tool/);
});

test("resume aggregates an interrupted side effect with earlier batch results", async (t) => {
  const { adapter, session, runtime } = await createHarness(t, [
    `<agent_response><done>true</done><message>Recovered safely.</message></agent_response>`,
  ]);

  await session.setPendingToolResult({
    callId: "call_first",
    requestId: "first",
    name: "fs.write",
    ok: true,
    message: "first completed",
    operationSignature: "sig-first",
  });
  await session.claimSideEffectTool({
    operationKey: "op-second",
    callId: "call_second",
    requestId: "second",
    name: "fs.write",
    args: '{"path":"second.txt"}',
    fingerprint: "fp-second",
    requestSignature: "sig-second",
  });

  const result = await runtime.run({ resume: true });

  assert.equal(result.message, "Recovered safely.");
  assert.equal(adapter.sentMessages.length, 1);
  const recoveryMessage = adapter.sentMessages[0];
  assert.match(recoveryMessage, /<tool_results>/);
  assert.ok(recoveryMessage.indexOf('id="first"') < recoveryMessage.indexOf('id="second"'));
  assert.match(recoveryMessage, /completion is unknown/);
});

test("counts a batch as one tool round and warns once at the soft budget", async (t) => {
  const events = [];
  const { adapter, runtime } = await createHarness(t, [
    `<agent_response>
      <done>false</done>
      <tool_calls>
        <tool_call id="list-a" name="fs.list">
          <args><path>.</path><depth>0</depth><include_hidden>false</include_hidden></args>
        </tool_call>
        <tool_call id="list-b" name="fs.list">
          <args><path>.</path><depth>0</depth><include_hidden>false</include_hidden></args>
        </tool_call>
      </tool_calls>
    </agent_response>`,
    `<agent_response>
      <done>false</done>
      <tool_call id="list-c" name="fs.list">
        <args><path>.</path><depth>0</depth><include_hidden>false</include_hidden></args>
      </tool_call>
    </agent_response>`,
    `<agent_response>
      <done>false</done>
      <tool_call id="list-d" name="fs.list">
        <args><path>.</path><depth>0</depth><include_hidden>false</include_hidden></args>
      </tool_call>
    </agent_response>`,
    `<agent_response><done>true</done><message>Finished after the warning.</message></agent_response>`,
  ], {
    limits: {
      ...DEFAULT_LIMITS,
      toolRoundWarningThreshold: 2,
    },
    onEvent: async (event) => {
      events.push(event);
    },
  });

  const result = await runtime.run();

  assert.equal(result.message, "Finished after the warning.");
  assert.equal(adapter.sentMessages.length, 4);
  assert.doesNotMatch(adapter.sentMessages[1], /<tool_round_budget_warning\b/);
  assert.match(
    adapter.sentMessages[2],
    /<tool_round_budget_warning round="2" budget="2">/,
  );
  assert.match(adapter.sentMessages[2], /additional tool rounds remain allowed/);
  assert.doesNotMatch(adapter.sentMessages[3], /<tool_round_budget_warning\b/);

  const warnings = events.filter(
    (event) => event.type === "runtime.tool_round_budget_warning",
  );
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].payload, { round: 2, budget: 2 });
});

test("resets the soft tool-round budget for each resumed run", async (t) => {
  const events = [];
  const listCall = `<agent_response>
    <done>false</done>
    <tool_call name="fs.list">
      <args><path>.</path><depth>0</depth><include_hidden>false</include_hidden></args>
    </tool_call>
  </agent_response>`;
  const { adapter, runtime } = await createHarness(t, [
    listCall,
    listCall,
    `<agent_response><done>true</done><message>First run done.</message></agent_response>`,
    listCall,
    listCall,
    `<agent_response><done>true</done><message>Second run done.</message></agent_response>`,
  ], {
    limits: {
      ...DEFAULT_LIMITS,
      toolRoundWarningThreshold: 2,
    },
    onEvent: async (event) => {
      events.push(event);
    },
  });

  await runtime.run();
  const resumed = await runtime.run({
    resume: true,
    instruction: "Continue the review.",
  });

  assert.equal(resumed.message, "Second run done.");
  assert.equal(adapter.sentMessages.length, 6);
  assert.match(adapter.sentMessages[2], /<tool_round_budget_warning round="2" budget="2">/);
  assert.doesNotMatch(adapter.sentMessages[4], /<tool_round_budget_warning\b/);
  assert.match(adapter.sentMessages[5], /<tool_round_budget_warning round="2" budget="2">/);

  const warnings = events.filter(
    (event) => event.type === "runtime.tool_round_budget_warning",
  );
  assert.equal(warnings.length, 2);
  assert.deepEqual(
    warnings.map((event) => event.payload),
    [{ round: 2, budget: 2 }, { round: 2, budget: 2 }],
  );
});
