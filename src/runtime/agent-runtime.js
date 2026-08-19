import { createHash } from "node:crypto";
import {
  cdata,
  parseAgentResponse,
  serializeProtocolError,
  serializeToolResult,
  serializeToolResults,
} from "../protocol/xml-protocol.js";
import { appendSystemReminder } from "../protocol/markers.js";
import {
  buildBootstrapPrompt,
  buildResumePrompt,
} from "../protocol/prompt-builder.js";
import {
  assistantMessage,
  functionCall,
  functionCallOutput,
  toolResultOutput,
  userMessage,
} from "../session/canonical-transcript.js";
import { DEFAULT_LIMITS } from "../shared/limits.js";
import { utf8ByteLength } from "../shared/text-budget.js";
import {
  BrowserAdapterError,
  ProtocolError,
  ToolValidationError,
} from "../shared/errors.js";
import { isConnectionLostError } from "../browser/chatgpt-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

const EMPTY_ASSISTANT_CONTINUE_MESSAGE =
  "The previous assistant response was empty. Continue the immediately preceding task "
  + "from the existing conversation context. Do not repeat any local tool operation "
  + "whose result is already present. Reply using the required <agent_response> XML protocol.";

const DEAD_REQUEST_CONTINUE_MESSAGE =
  "The previous request received no reply. Continue the immediately preceding task "
  + "from the existing conversation context. Do not repeat any local tool operation "
  + "whose result is already present. Reply using the required <agent_response> XML protocol.";

function buildToolRoundBudgetWarning({ round, budget }) {
  return `\n<tool_round_budget_warning round="${round}" budget="${budget}">`
    + "The soft tool-round budget has been reached. Prefer finishing from existing evidence. "
    + "If more local information is genuinely needed, batch all independent reads or searches "
    + "into one request and do not reread information already returned. "
    + "This is advisory; additional tool rounds remain allowed when necessary."
    + "</tool_round_budget_warning>";
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalArgs(args) {
  return JSON.stringify(canonicalize(args));
}

function deriveToolIdentity({
  sessionId,
  assistantMessageId,
  turn,
  toolCall,
  turnNumber,
  toolIndex = 0,
  toolCount = 1,
}) {
  const args = canonicalArgs(toolCall.args);
  const messageIdentity = assistantMessageId
    ? `message:${assistantMessageId}`
    : `turn:${turnNumber}:${createHash("sha256").update(turn.raw).digest("hex")}`;
  const operationIdentity = toolCount > 1
    ? `${messageIdentity}:batch:${toolIndex}`
    : messageIdentity;
  const operationKey = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(operationIdentity)
    .digest("hex");
  const fingerprint = createHash("sha256")
    .update(operationKey)
    .update("\0")
    .update(toolCall.name)
    .update("\0")
    .update(args)
    .digest("hex");
  const requestSignature = createHash("sha256")
    .update(toolCall.name)
    .update("\0")
    .update(args)
    .digest("hex");
  return {
    operationKey,
    callId: `call_${fingerprint.slice(0, 16)}`,
    name: toolCall.name,
    args,
    fingerprint,
    requestSignature,
  };
}

function unknownCompletionResult(toolCall, message = null) {
  return {
    callId: toolCall.id,
    requestId: toolCall.requestId,
    name: toolCall.name,
    ok: false,
    message: message ?? (
      "This tool call may have started, but its completion is unknown. "
      + "It will not be replayed automatically; inspect local state and use "
      + "a deliberate follow-up operation if needed."
    ),
    meta: {
      completionUnknown: true,
      recoverable: true,
    },
  };
}

function deniedResult(toolCall, reasons) {
  return {
    callId: toolCall.id,
    requestId: toolCall.requestId,
    name: toolCall.name,
    ok: false,
    message: `User denied this tool call: ${reasons.join("; ")}`,
  };
}

function policyRejectedResult(toolCall, message) {
  return {
    callId: toolCall.id,
    requestId: toolCall.requestId,
    name: toolCall.name,
    ok: false,
    message: `Tool request rejected before execution: ${message}`,
  };
}

function pendingResults(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeResultForCall(result, toolCall) {
  return {
    ...result,
    callId: toolCall.id,
    requestId: toolCall.requestId,
    name: toolCall.name,
  };
}

export class AgentRuntime {
  constructor({
    adapter,
    registry,
    policy,
    session,
    approval,
    onEvent,
    limits = DEFAULT_LIMITS,
  }) {
    this.adapter = adapter;
    this.registry = registry;
    this.policy = policy;
    this.session = session;
    this.approval = approval;
    this.onEvent = onEvent;
    this.limits = limits;
  }

  async emit(type, payload = {}) {
    const event = await this.session.appendEvent(type, payload);
    await this.onEvent?.(event);
    return event;
  }

  async sendMessage(text, { files = [], maxBytes = null } = {}) {
    const message = appendSystemReminder(text);
    try {
      await this.#sendMessageWithReconnect(message, { files, maxBytes });
    } finally {
      const conversationUrl = await this.adapter.getConversationUrl()
        .catch(() => null);
      if (
        conversationUrl
        && conversationUrl !== this.session.state.conversationUrl
      ) {
        await this.session.update({ conversationUrl });
      }
    }
  }

  // Sends once; if the browser connection died in between (e.g. the Mac slept
  // while a tool was running), reconnects to the still-alive Chrome, restores
  // the conversation, and retries once. A send that never rendered (ChatGPT
  // did not register the message) is also retried once — the deterministic
  // message is simply sent again. Anything else propagates.
  async #sendMessageWithReconnect(message, { files, maxBytes }) {
    try {
      await this.adapter.sendMessage(message, { files, maxBytes });
    } catch (error) {
      if (isConnectionLostError(error)) {
        await this.#reconnectAndRestore();
        await this.adapter.sendMessage(message, { files, maxBytes });
        return;
      }
      if (error?.code === "SEND_NOT_DETECTED") {
        await this.adapter.sendMessage(message, { files, maxBytes });
        return;
      }
      throw error;
    }
  }

  // Reconnects to the still-alive Chrome and navigates back to the session's
  // conversation, so the DOM state needed by the adapter is restored.
  async #reconnectAndRestore() {
    await this.adapter.reconnect?.(this.session.state.conversationUrl);
    await this.adapter.startConversation(
      this.session.state.conversationUrl,
      {
        expectedAssistantMessageId: this.session.state.lastAssistantMessageId
          ?? null,
      },
    );
  }

  buildToolResultMessage(result, { suffix = "" } = {}) {
    const limit = this.limits.maxBrowserToolResultBytes;
    const nonResultBytes = utf8ByteLength(appendSystemReminder(suffix));
    const resultBudget = limit - nonResultBytes;
    if (resultBudget < 512) {
      throw new RangeError(
        `Tool result metadata leaves fewer than 512 bytes within the ${limit}-byte browser limit.`,
      );
    }
    const xml = Array.isArray(result)
      ? serializeToolResults(result, { maxBytes: resultBudget })
      : serializeToolResult(result, { maxBytes: resultBudget });
    return `${xml}${suffix}`;
  }

  async sendToolResult(result, { suffix = "" } = {}) {
    await this.sendMessage(this.buildToolResultMessage(result, { suffix }), {
      maxBytes: this.limits.maxBrowserToolResultBytes,
    });
  }

  async #prepareToolPlan({
    toolCall,
    toolIndex,
    toolCount,
    assistantMessageId,
    parsed,
    turnNumber,
    projectRoot,
    replayGuards,
  }) {
    const identity = deriveToolIdentity({
      sessionId: this.session.sessionId,
      assistantMessageId,
      turn: parsed,
      toolCall,
      turnNumber,
      toolIndex,
      toolCount,
    });
    const normalizedCall = {
      ...toolCall,
      id: identity.callId,
      requestId: toolCall.id ?? identity.callId,
    };
    let preparedCall;
    try {
      preparedCall = this.registry.validate(normalizedCall);
    } catch (error) {
      if (!(error instanceof ToolValidationError)) {
        throw error;
      }

      const result = {
        callId: normalizedCall.id,
        requestId: normalizedCall.requestId,
        name: normalizedCall.name,
        ok: false,
        message: error.message,
      };
      await this.emit("tool.invalid", {
        id: normalizedCall.id,
        name: normalizedCall.name,
        message: error.message,
      });
      await this.session.appendTranscriptItem(functionCall({
        name: normalizedCall.name,
        args: normalizedCall.args,
        callId: normalizedCall.id,
      }));
      return {
        call: normalizedCall,
        identity,
        fingerprint: identity.fingerprint,
        sideEffect: null,
        result,
        shouldRecord: true,
        shouldClaimSideEffect: false,
        decision: null,
      };
    }

    await this.emit("tool.proposed", {
      id: preparedCall.id,
      name: preparedCall.name,
      args: preparedCall.args,
    });
    await this.session.appendTranscriptItem(functionCall({
      name: preparedCall.name,
      args: preparedCall.args,
      callId: preparedCall.id,
    }));

    const isReadTool = preparedCall.definition.risk === "read";
    const sideEffect = isReadTool
      ? null
      : { ...identity, requestId: preparedCall.requestId };
    const fingerprint = identity.fingerprint;
    let result;
    let shouldRecord = false;
    let shouldClaimSideEffect = false;

    if (sideEffect) {
      const replayIndex = replayGuards.findIndex(
        (guard) => guard.signature === identity.requestSignature,
      );
      if (replayIndex >= 0) {
        const [guard] = replayGuards.splice(replayIndex, 1);
        result = normalizeResultForCall(guard.result, preparedCall);
        await this.emit("tool.reused", {
          fingerprint,
          id: preparedCall.id,
          name: preparedCall.name,
          reason: "repeated-after-result",
        });
      }
    }

    if (!result && sideEffect) {
      const existing = this.session.getSideEffectTool(
        sideEffect.operationKey,
      );
      if (existing && existing.fingerprint !== identity.fingerprint) {
        result = {
          callId: preparedCall.id,
          requestId: preparedCall.requestId,
          name: preparedCall.name,
          ok: false,
          message:
            "The same assistant message changed its tool request after it "
            + `was already recorded for ${existing.name}. The operation was not replayed.`,
        };
        await this.emit("tool.conflict", {
          id: preparedCall.id,
          name: preparedCall.name,
          existingName: existing.name,
        });
      } else if (existing?.status === "completed") {
        result = normalizeResultForCall(existing.result, preparedCall);
        await this.emit("tool.reused", {
          fingerprint,
          id: preparedCall.id,
          name: preparedCall.name,
        });
      } else if (existing) {
        result = normalizeResultForCall(
          existing.result ?? unknownCompletionResult(preparedCall),
          preparedCall,
        );
        if (existing.status !== "unknown") {
          const unknownEvent = await this.session.markSideEffectToolUnknown(
            identity,
            result,
          );
          await this.onEvent?.(unknownEvent);
        }
        await this.emit("tool.reused_unknown", {
          fingerprint,
          id: preparedCall.id,
          name: preparedCall.name,
        });
      }
    } else if (!result) {
      const cached = this.session.getToolResult(fingerprint);
      if (cached) {
        result = normalizeResultForCall(cached, preparedCall);
      }
    }

    let decision = null;
    if (!result) {
      try {
        decision = await this.policy.evaluate(preparedCall, {
          projectRoot,
        });
      } catch (error) {
        result = policyRejectedResult(preparedCall, error.message);
        shouldRecord = true;
        shouldClaimSideEffect = Boolean(sideEffect);
        await this.emit("tool.invalid", {
          id: preparedCall.id,
          name: preparedCall.name,
          message: result.message,
        });
      }

      if (!result && decision.action === "deny") {
        result = policyRejectedResult(
          preparedCall,
          decision.reasons.join("; "),
        );
        shouldRecord = true;
        shouldClaimSideEffect = Boolean(sideEffect);
        await this.emit("tool.invalid", {
          id: preparedCall.id,
          name: preparedCall.name,
          message: result.message,
        });
      }
    }

    return {
      call: preparedCall,
      identity,
      fingerprint,
      sideEffect,
      result,
      shouldRecord,
      shouldClaimSideEffect,
      decision,
    };
  }

  async #executeToolPlans(plans, { projectRoot }) {
    // Resolve every confirmation before any tool begins. This makes a batch
    // atomic with respect to approval availability: machine mode can fail with
    // APPROVAL_REQUIRED without an earlier write in the same batch running.
    for (const plan of plans) {
      if (plan.result || plan.decision?.action !== "confirm") {
        continue;
      }
      await this.emit("approval.required", {
        id: plan.call.id,
        name: plan.call.name,
        args: plan.call.args,
        reasons: plan.decision.reasons,
      });
      const approved = await this.approval({
        toolCall: plan.call,
        reasons: plan.decision.reasons,
      });
      if (!approved) {
        plan.result = deniedResult(plan.call, plan.decision.reasons);
        plan.shouldRecord = true;
        plan.shouldClaimSideEffect = Boolean(plan.sideEffect);
      }
    }

    const results = [];
    for (const plan of plans) {
      let { result } = plan;
      const grants = plan.decision?.grants;

      if (!result) {
        if (plan.sideEffect) {
          const claimEvent = await this.session.claimSideEffectTool(
            plan.sideEffect,
          );
          await this.onEvent?.(claimEvent);
        }

        await this.emit("tool.started", {
          id: plan.call.id,
          name: plan.call.name,
        });
        result = await this.registry.execute(plan.call, {
          projectRoot,
          allowOutside: grants?.allowOutside ?? false,
          toolTimeoutMs: this.limits.toolTimeoutMs,
          onToolOutput: async (output) => {
            await this.session.appendToolOutput({
              id: plan.call.id,
              name: plan.call.name,
              ...output,
            });
            await this.onEvent?.({
              type: "tool.output",
              sessionId: this.session.sessionId,
              timestamp: new Date().toISOString(),
              payload: {
                id: plan.call.id,
                name: plan.call.name,
                ...output,
              },
            });
          },
        });
        result = normalizeResultForCall(result, plan.call);

        if (plan.sideEffect) {
          result.operationSignature = plan.identity.requestSignature;
        }

        if (plan.sideEffect && result.meta?.completionUnknown) {
          const unknownEvent = await this.session.markSideEffectToolUnknown(
            plan.sideEffect,
            result,
          );
          await this.onEvent?.(unknownEvent);
        } else {
          const completionEvent = await this.session.recordToolResult(
            plan.fingerprint,
            result,
            { identity: plan.sideEffect },
          );
          await this.onEvent?.(completionEvent);
        }
      } else if (plan.shouldRecord) {
        if (plan.shouldClaimSideEffect) {
          const claimEvent = await this.session.claimSideEffectTool(
            plan.sideEffect,
          );
          await this.onEvent?.(claimEvent);
          result.operationSignature = plan.identity.requestSignature;
        }
        const completionEvent = await this.session.recordToolResult(
          plan.fingerprint,
          result,
          { identity: plan.shouldClaimSideEffect ? plan.sideEffect : null },
        );
        await this.onEvent?.(completionEvent);
      }

      await this.session.appendTranscriptItem(functionCallOutput({
        callId: result.callId,
        output: toolResultOutput(result),
      }));
      results.push(result);

      // Persist the aggregate incrementally. If the runtime stops between calls,
      // resume can resend every completed result and replay-guard every completed
      // side effect instead of remembering only the last call in the batch.
      await this.session.setPendingToolResult(
        results.length === 1 ? results[0] : [...results],
      );
    }

    return results;
  }

  async run({
    resume = false,
    instruction = null,
    files = [],
    inPlaceRecovery = false,
    mode = null,
  } = {}) {
    const {
      task,
      projectRoot,
      mode: sessionMode,
    } = this.session.state;
    const previousConversationUrl = this.session.state.conversationUrl;
    const interruptedOperationKeys = Object.entries(
      this.session.state.sideEffectTools ?? {},
    )
      .filter(([, entry]) => entry?.status === "running")
      .map(([operationKey]) => operationKey);
    await this.session.recoverInterruptedSideEffects();
    let pendingToolResult = this.session.state.pendingToolResult;
    if (interruptedOperationKeys.length > 0) {
      const combined = pendingResults(pendingToolResult);
      for (const operationKey of interruptedOperationKeys) {
        const entry = this.session.state.sideEffectTools?.[operationKey];
        if (!entry?.result) {
          continue;
        }
        const recoveredResult = {
          ...entry.result,
          requestId: entry.requestId ?? entry.result.requestId,
        };
        if (!combined.some((result) => result?.callId === recoveredResult.callId)) {
          combined.push(recoveredResult);
        }
      }
      pendingToolResult = combined.length === 1 ? combined[0] : combined;
      await this.session.setPendingToolResult(pendingToolResult);
    }

    await this.session.update({
      phase: "initializing",
      runCount: Number(this.session.state.runCount || 0) + 1,
      lastError: null,
    });
    await this.emit("runtime.initializing");

    // On resume, prefer an existing tab already showing the conversation so
    // repeated resumes reuse the same tab instead of piling up new ones.
    await this.adapter.launch(
      resume ? this.session.state.conversationUrl : null,
    );
    await this.emit("browser.started", {
      profileDir: this.adapter.profileDir,
    });

    let authState = await this.adapter.getAuthState();
    if (authState !== "authenticated") {
      try {
        await this.adapter.waitForManualLogin({ timeoutMs: 8_000 });
        authState = "authenticated";
      } catch {
        // A signed-in ChatGPT page can briefly render its guest shell. Only
        // prompt the user after a short grace period fails.
      }
    }
    if (authState !== "authenticated") {
      await this.session.update({ phase: "auth_required" });
      await this.emit("browser.auth_required");
      // The window may be minimized; bring it forward so the user can log in,
      // then send it back once login is detected.
      await this.adapter.restoreWindow?.();
      try {
        await this.adapter.waitForManualLogin({
          timeoutMs: this.limits.loginTimeoutMs,
        });
      } finally {
        await this.adapter.minimizeWindow?.();
      }
      await this.emit("browser.authenticated");
    }

    await this.adapter.startConversation(
      resume ? previousConversationUrl : null,
      {
        expectedAssistantMessageId: resume
          ? this.session.state.lastAssistantMessageId
          : null,
      },
    );
    // A fresh run uses the mode stored at session creation; a resume applies
    // an explicit mode override (--mode or the interactive choice) when given,
    // and otherwise keeps the mode the conversation is already on.
    const requestedMode = mode ?? sessionMode;
    // The actual mode may differ from the requested one (Pro limited, fallback,
    // or switcher not found), so report what was really selected.
    let activeMode = resume
      ? (this.session.state.activeMode ?? null)
      : null;
    const selectRequested = Boolean(
      requestedMode && (!resume || mode != null),
    );
    if (selectRequested) {
      const modeResult = await this.adapter.selectMode(requestedMode);
      if (modeResult) {
        await this.emit("conversation.mode_selected", {
          requested: requestedMode,
          status: modeResult.status,
          selectedLabel: modeResult.selectedLabel ?? null,
          attempts: modeResult.attempts ?? 0,
          reason: modeResult.reason ?? null,
        });
        if (modeResult.status === "select" || modeResult.status === "already") {
          activeMode = modeResult.selectedLabel ?? requestedMode;
        } else if (modeResult.status === "fallback") {
          activeMode = modeResult.selectedLabel ?? requestedMode;
        } else {
          // Pro not selected and no known fallback label — the real mode is
          // whatever ChatGPT already had, which we cannot name reliably.
          activeMode = null;
        }
      }
    }
    await this.session.update({
      phase: "running",
      conversationUrl: await this.adapter.getConversationUrl(),
      activeMode,
    });
    await this.emit("conversation.started", {
      url: this.session.state.conversationUrl,
      mode: activeMode,
      requestedMode,
    });

    let initialMessage;
    let initialKind;
    // The web transport gets `.web` (XML/marked text). The portable rollout
    // records only the real user message; WTAgent scaffolding stays transport-only.
    let initialTranscript = [];
    // @file attachments (if any) accompany the first user message of this run.
    const attachments = (files ?? []).map((file) => ({
      name: file.name ?? null,
      path: file.path ?? null,
    }));
    const messageOptions = attachments.length > 0 ? { attachments } : {};
    if (resume && pendingToolResult && !inPlaceRecovery) {
      let suffix = "";
      if (instruction?.trim()) {
        suffix = `\n<resume_instruction>${cdata(instruction)}</resume_instruction>`;
        initialTranscript = [userMessage(instruction, messageOptions)];
      }
      initialMessage = this.buildToolResultMessage(pendingToolResult, { suffix });
      initialKind = "pending_tool_result";
    } else if (resume && instruction?.trim()) {
      // The live ChatGPT conversation already contains the bootstrap protocol
      // and tool catalog. A normal follow-up should be the user's message, not
      // another several-thousand-character protocol bootstrap. sendMessage()
      // still appends the short format reminder.
      initialMessage = instruction.trim();
      initialTranscript = [userMessage(instruction.trim(), messageOptions)];
      initialKind = "follow_up";
    } else if (resume && inPlaceRecovery) {
      // The original request/tool result is already visible in this live web
      // conversation. Ask ChatGPT to continue without duplicating transport
      // payloads, attachments, or canonical transcript entries.
      initialMessage = EMPTY_ASSISTANT_CONTINUE_MESSAGE;
      initialKind = "empty_response_recovery";
    } else if (resume) {
      const prompt = buildResumePrompt({
        instruction,
        state: this.session.state,
        tools: this.registry.list(),
      });
      initialMessage = prompt.web;
      initialTranscript = [userMessage(prompt.user, messageOptions)];
      initialKind = "resume";
    } else {
      const prompt = buildBootstrapPrompt({
        task,
        projectRoot,
        tools: this.registry.list(),
      });
      initialMessage = prompt.web;
      initialTranscript = [userMessage(prompt.user, messageOptions)];
      initialKind = "bootstrap";
    }

    for (const item of initialTranscript) {
      await this.session.appendTranscriptItem(item);
    }
    await this.sendMessage(initialMessage, {
      files,
      maxBytes: initialKind === "pending_tool_result"
        ? this.limits.maxBrowserToolResultBytes
        : null,
    });
    let awaitingPendingAcknowledgement = Boolean(pendingToolResult);
    let replayGuards = pendingResults(pendingToolResult)
      .filter((result) => result?.operationSignature)
      .map((result) => ({
        signature: result.operationSignature,
        result,
      }));
    await this.emit("model.message_sent", { kind: initialKind });

    let protocolErrors = 0;
    let toolRounds = 0;
    const toolRoundWarningThreshold = this.limits.toolRoundWarningThreshold
      ?? DEFAULT_LIMITS.toolRoundWarningThreshold;
    const baseTurn = resume ? Number(this.session.state.turn || 0) : 0;

    for (let step = 1; ; step += 1) {
      const turnNumber = baseTurn + step;
      await this.session.update({ turn: turnNumber, phase: "waiting_model" });
      let raw;
      let emptyAssistantRetries = 0;
      let connectionRetries = 0;
      for (;;) {
        try {
          raw = await this.adapter.waitForTurnComplete({
            timeoutMs: this.limits.modelTurnTimeoutMs,
            stableWindowMs: this.limits.modelStableWindowMs,
            emptyResponseWindowMs: this.limits.emptyAssistantWindowMs,
            deadRequestGraceMs: this.limits.deadRequestGraceMs,
            onDelta: async (delta) => {
              await this.onEvent?.({
                type: "model.streaming",
                sessionId: this.session.sessionId,
                timestamp: new Date().toISOString(),
                payload: { delta },
              });
            },
          });
          break;
        } catch (error) {
          if (isConnectionLostError(error)) {
            if (connectionRetries >= 1) {
              throw error;
            }
            connectionRetries += 1;
            await this.#reconnectAndRestore();
            // The message was already sent before the connection died; resume
            // waiting for the reply on the restored page.
            continue;
          }

          if (error?.code === "USAGE_LIMIT_REACHED") {
            // Detected by the adapter from the message's DOM (text + retry
            // button); surface the same event the text-based path emits.
            await this.emit("model.limit_reached", {
              snippet: error.message,
            });
            throw error;
          }

          const deadRequest = error?.code === "DEAD_ASSISTANT_REQUEST";
          if (
            error?.code !== "EMPTY_ASSISTANT_RESPONSE"
            && !deadRequest
          ) {
            throw error;
          }

          const emptyAssistantMessageId = await this.adapter
            .getLastAssistantMessageId?.() ?? null;
          await this.session.update({
            conversationUrl: await this.adapter.getConversationUrl(),
            lastAssistantMessageId: emptyAssistantMessageId
              ?? this.session.state.lastAssistantMessageId,
          });

          if (
            emptyAssistantRetries
            >= this.limits.maxEmptyAssistantRetries
          ) {
            await this.emit("model.empty_response_exhausted", {
              retries: emptyAssistantRetries,
              assistantMessageId: emptyAssistantMessageId,
              deadRequest,
            });
            throw new BrowserAdapterError(
              deadRequest
                ? `ChatGPT did not respond after ${emptyAssistantRetries} continuation attempts.`
                : `ChatGPT returned empty responses after ${emptyAssistantRetries} continuation attempts.`,
              {
                code: "EMPTY_ASSISTANT_RETRIES_EXHAUSTED",
                cause: error,
                details: { retries: emptyAssistantRetries },
              },
            );
          }

          emptyAssistantRetries += 1;
          await this.emit("model.empty_response", {
            retry: emptyAssistantRetries,
            maxRetries: this.limits.maxEmptyAssistantRetries,
            assistantMessageId: emptyAssistantMessageId,
            deadRequest,
          });
          // Do not resend the original request or tool result: both are already
          // present in ChatGPT's conversation. This transport-only continuation
          // also cannot re-execute a local tool by itself.
          await this.sendMessage(
            deadRequest
              ? DEAD_REQUEST_CONTINUE_MESSAGE
              : EMPTY_ASSISTANT_CONTINUE_MESSAGE,
          );
          await this.emit("model.message_sent", {
            kind: deadRequest
              ? "dead_request_recovery"
              : "empty_response_recovery",
            retry: emptyAssistantRetries,
          });
        }
      }
      const assistantMessageId = await this.adapter
        .getLastAssistantMessageId?.() ?? null;
      if (awaitingPendingAcknowledgement) {
        await this.session.clearPendingToolResult();
        awaitingPendingAcknowledgement = false;
      }
      await this.session.update({
        conversationUrl: await this.adapter.getConversationUrl(),
        // Null is meaningful: retaining an older ID would falsely prove only
        // that stale history had hydrated on the next resume.
        lastAssistantMessageId: assistantMessageId,
      });
      await this.emit("model.message_complete", {
        turn: turnNumber,
        raw,
        assistantMessageId,
      });

      let parsed;
      try {
        parsed = parseAgentResponse(raw);
        protocolErrors = 0;
      } catch (error) {
        if (!(error instanceof ProtocolError)) {
          throw error;
        }
        if (isUsageLimitNotice(raw)) {
          // ChatGPT renders its plan/usage limit as a normal assistant message
          // (localized). A failed parse whose text matches is a limit notice,
          // not a format slip: retrying is futile, so stop the run with a
          // clear error instead of burning retries and the model timeout.
          await this.emit("model.limit_reached", {
            snippet: raw.slice(0, 200),
          });
          throw new BrowserAdapterError(
            "ChatGPT reported a usage limit. Try a different thinking level "
              + "(e.g. wtagent resume with --mode Pro or --mode Current), wait "
              + "for the limit to reset, or change plans, then resume.",
            { code: "USAGE_LIMIT_REACHED" },
          );
        }
        protocolErrors += 1;
        await this.emit("protocol.invalid", {
          message: error.message,
          count: protocolErrors,
        });
        if (protocolErrors >= this.limits.maxProtocolErrors) {
          throw new ProtocolError(
            `Protocol failed ${protocolErrors} consecutive times: ${error.message}`,
          );
        }
        await this.sendMessage(serializeProtocolError(error));
        continue;
      }

      // Record the assistant's turn in the canonical transcript. The raw XML is
      // the web rendering; the transcript keeps the plain progress message.
      if (parsed.message?.trim()) {
        await this.session.appendTranscriptItem(
          assistantMessage(parsed.message),
        );
      }

      if (parsed.done) {
        if (!parsed.message.trim()) {
          const error = new ProtocolError(
            "done=true requires a non-empty final message.",
          );
          await this.emit("protocol.invalid", { message: error.message });
          await this.sendMessage(serializeProtocolError(error));
          continue;
        }
        // done=true completes the run. A request may be answered directly
        // (no tool call) or after any number of tools; the runtime does not
        // second-guess whether "enough" work happened — that is the model's
        // and the user's call, not a keyword heuristic.
        await this.session.update({
          phase: "idle",
          lastMessage: parsed.message,
          pendingToolResult: null,
        });
        await this.emit("run.completed", { message: parsed.message });
        return {
          sessionId: this.session.sessionId,
          message: parsed.message,
        };
      }

      if (parsed.message) {
        await this.emit("model.progress", {
          turn: turnNumber,
          message: parsed.message,
        });
      }

      const toolCalls = parsed.toolCalls ?? (parsed.toolCall ? [parsed.toolCall] : []);
      if (toolCalls.length === 0) {
        // done=false without a tool call means the model is just talking
        // (e.g. asking a clarifying question, explaining its reasoning, or
        // giving a partial answer). The message was already emitted as
        // model.progress above; nudge the model to either finish with
        // done=true or invoke local tools to make progress.
        await this.sendMessage(
          "If the current request is deliverable, reply with <done>true</done> and the result. "
            + "If you need to take action on the user's machine, request one local tool or batch independent tools with <tool_calls>. "
            + "If you need information from the user, ask one specific question in <message> "
            + "and set <done>true</done> so control returns to the user.",
        );
        continue;
      }

      toolRounds += 1;
      const plans = [];
      for (const [toolIndex, toolCall] of toolCalls.entries()) {
        plans.push(await this.#prepareToolPlan({
          toolCall,
          toolIndex,
          toolCount: toolCalls.length,
          assistantMessageId,
          parsed,
          turnNumber,
          projectRoot,
          replayGuards,
        }));
      }
      // Replay guards apply only to the first tool-bearing assistant turn after
      // a persisted result is resent. Later identical requests are deliberate.
      replayGuards = [];

      const results = await this.#executeToolPlans(plans, { projectRoot });
      let toolRoundSuffix = "";
      if (toolRounds === toolRoundWarningThreshold) {
        await this.emit("runtime.tool_round_budget_warning", {
          round: toolRounds,
          budget: toolRoundWarningThreshold,
        });
        toolRoundSuffix = buildToolRoundBudgetWarning({
          round: toolRounds,
          budget: toolRoundWarningThreshold,
        });
      }
      await this.sendToolResult(
        results.length === 1 ? results[0] : results,
        { suffix: toolRoundSuffix },
      );
      awaitingPendingAcknowledgement = true;
      for (const result of results) {
        await this.emit("tool.result_sent", {
          id: result.callId,
          requestId: result.requestId ?? null,
          name: result.name,
          ok: result.ok,
        });
      }
    }
  }
}
