function eventTime(event, fallback = Date.now()) {
  const parsed = Date.parse(event?.timestamp ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampDuration(value) {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

function seconds(milliseconds) {
  return `${(clampDuration(milliseconds) / 1000).toFixed(1)}s`;
}

export class RunTelemetry {
  constructor() {
    this.reset();
  }

  reset(startedAt = null) {
    this.startedAt = startedAt;
    this.modelTurns = 0;
    this.toolRounds = 0;
    this.toolCalls = 0;
    this.batchedToolRounds = 0;
    this.batchedToolCalls = 0;
    this.protocolRetries = 0;
    this.modelWaitMs = 0;
    this.toolExecutionMs = 0;
    this.modelWaitStartedAt = null;
    this.toolStartedAt = new Map();
    this.currentRoundCallIds = new Set();
    this.currentRoundCallCount = 0;
  }

  #startModelWait(at) {
    if (this.modelWaitStartedAt == null) {
      this.modelWaitStartedAt = at;
    }
  }

  #finishModelWait(at) {
    if (this.modelWaitStartedAt == null) {
      return;
    }
    this.modelWaitMs += clampDuration(at - this.modelWaitStartedAt);
    this.modelWaitStartedAt = null;
  }

  #recordToolCall(id) {
    const key = id ?? `anonymous-${this.currentRoundCallIds.size}`;
    if (this.currentRoundCallIds.has(key)) {
      return;
    }
    this.currentRoundCallIds.add(key);
    this.currentRoundCallCount += 1;
    this.toolCalls += 1;

    if (this.currentRoundCallCount === 1) {
      this.toolRounds += 1;
    } else if (this.currentRoundCallCount === 2) {
      this.batchedToolRounds += 1;
      this.batchedToolCalls += 2;
    } else {
      this.batchedToolCalls += 1;
    }
  }

  handle(event) {
    const at = eventTime(event);
    const { type, payload = {} } = event ?? {};

    switch (type) {
      case "runtime.initializing":
        this.reset(at);
        break;
      case "model.message_sent":
      case "tool.result_sent":
        this.#startModelWait(at);
        break;
      case "model.message_complete":
        this.#finishModelWait(at);
        this.modelTurns += 1;
        this.currentRoundCallIds = new Set();
        this.currentRoundCallCount = 0;
        break;
      case "protocol.invalid":
        this.protocolRetries += 1;
        // Runtime sends the protocol correction immediately after this event.
        this.#startModelWait(at);
        break;
      case "tool.proposed":
      case "tool.invalid":
        this.#recordToolCall(payload.id ?? null);
        break;
      case "tool.started":
        if (payload.id && !this.toolStartedAt.has(payload.id)) {
          this.toolStartedAt.set(payload.id, at);
        }
        break;
      case "tool.completed":
      case "tool.completion_unknown": {
        const id = payload.result?.callId ?? payload.identity?.callId ?? null;
        if (id && this.toolStartedAt.has(id)) {
          this.toolExecutionMs += clampDuration(at - this.toolStartedAt.get(id));
          this.toolStartedAt.delete(id);
        }
        break;
      }
      default:
        break;
    }
  }

  snapshot(at = Date.now()) {
    const now = typeof at === "number" ? at : eventTime({ timestamp: at });
    const activeModelWaitMs = this.modelWaitStartedAt == null
      ? 0
      : clampDuration(now - this.modelWaitStartedAt);
    const totalElapsedMs = this.startedAt == null
      ? 0
      : clampDuration(now - this.startedAt);
    const modelWaitMs = this.modelWaitMs + activeModelWaitMs;
    const accountedMs = Math.min(totalElapsedMs, modelWaitMs + this.toolExecutionMs);

    return {
      modelTurns: this.modelTurns,
      toolRounds: this.toolRounds,
      toolCalls: this.toolCalls,
      batchedToolRounds: this.batchedToolRounds,
      batchedToolCalls: this.batchedToolCalls,
      protocolRetries: this.protocolRetries,
      modelWaitMs,
      toolExecutionMs: this.toolExecutionMs,
      otherMs: Math.max(0, totalElapsedMs - accountedMs),
      totalElapsedMs,
      modelWaitPercent: totalElapsedMs > 0
        ? Math.round((modelWaitMs / totalElapsedMs) * 100)
        : 0,
    };
  }
}

export function formatRunTelemetry(metrics) {
  const batch = metrics.batchedToolRounds > 0
    ? ` · ${metrics.batchedToolRounds} batched round${metrics.batchedToolRounds === 1 ? "" : "s"}/${metrics.batchedToolCalls} calls`
    : "";
  const retries = metrics.protocolRetries > 0
    ? ` · ${metrics.protocolRetries} format retr${metrics.protocolRetries === 1 ? "y" : "ies"}`
    : "";
  return [
    `Run metrics: ${metrics.modelTurns} model turn${metrics.modelTurns === 1 ? "" : "s"}`,
    ` · ${metrics.toolRounds} tool round${metrics.toolRounds === 1 ? "" : "s"}/${metrics.toolCalls} calls`,
    batch,
    retries,
    ` · model wait ${seconds(metrics.modelWaitMs)} (${metrics.modelWaitPercent}%)`,
    ` · tools ${seconds(metrics.toolExecutionMs)}`,
    ` · total ${seconds(metrics.totalElapsedMs)}`,
  ].join("");
}
