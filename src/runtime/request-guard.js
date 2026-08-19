import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { replaceFileAtomic } from "../shared/atomic-write.js";

const HOUR_MS = 60 * 60 * 1000;
const STATE_SCHEMA_VERSION = 1;
const CONFIG_FILE = "config.json";
const STATE_FILE = ".wtagent-request-guard.json";
const LOCK_DIRECTORY = ".wtagent-request-guard.lock";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export const DEFAULT_REQUEST_GUARD = Object.freeze({
  // These are local safety defaults, not published provider limits.
  minIntervalMs: 15_000,
  maxRequestsPerRun: 20,
  maxRequestsPerHour: 30,
  circuitOpenMs: 60 * 60 * 1000,
});

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class RequestGuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RequestGuardError";
    this.code = code;
    this.machineDetails = details;
  }
}

function assertObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestGuardError(
      "REQUEST_GUARD_CONFIG_INVALID",
      `${label} must be a JSON object.`,
    );
  }
  return value;
}

function readInteger(value, fallback, { label, minimum }) {
  if (value == null) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RequestGuardError(
      "REQUEST_GUARD_CONFIG_INVALID",
      `${label} must be an integer >= ${minimum}.`,
      { field: label, value },
    );
  }
  return value;
}

async function readGuardConfig(configPath) {
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...DEFAULT_REQUEST_GUARD };
    }
    throw error;
  }

  let root;
  try {
    root = JSON.parse(raw);
  } catch (error) {
    throw new RequestGuardError(
      "REQUEST_GUARD_CONFIG_INVALID",
      `Could not parse WTAgent config ${configPath}: ${error.message}`,
      { configPath },
    );
  }
  assertObject(root, `WTAgent config ${configPath}`);

  if (root.requestGuard == null) {
    return { ...DEFAULT_REQUEST_GUARD };
  }
  const configured = assertObject(
    root.requestGuard,
    `requestGuard in ${configPath}`,
  );

  return {
    minIntervalMs: readInteger(
      configured.minIntervalMs,
      DEFAULT_REQUEST_GUARD.minIntervalMs,
      { label: "requestGuard.minIntervalMs", minimum: 0 },
    ),
    maxRequestsPerRun: readInteger(
      configured.maxRequestsPerRun,
      DEFAULT_REQUEST_GUARD.maxRequestsPerRun,
      { label: "requestGuard.maxRequestsPerRun", minimum: 1 },
    ),
    maxRequestsPerHour: readInteger(
      configured.maxRequestsPerHour,
      DEFAULT_REQUEST_GUARD.maxRequestsPerHour,
      { label: "requestGuard.maxRequestsPerHour", minimum: 1 },
    ),
    circuitOpenMs: readInteger(
      configured.circuitOpenMs,
      DEFAULT_REQUEST_GUARD.circuitOpenMs,
      { label: "requestGuard.circuitOpenMs", minimum: 60_000 },
    ),
  };
}

function emptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    providers: {},
  };
}

function validateState(value, statePath) {
  if (
    value == null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== STATE_SCHEMA_VERSION
    || value.providers == null
    || typeof value.providers !== "object"
    || Array.isArray(value.providers)
  ) {
    throw new RequestGuardError(
      "REQUEST_GUARD_STATE_INVALID",
      `Request guard state is invalid: ${statePath}. Refusing to send while accounting is uncertain.`,
      { statePath },
    );
  }
  return value;
}

function providerState(state, providerId) {
  const existing = state.providers[providerId];
  if (existing == null) {
    const created = { requests: [], circuit: null };
    state.providers[providerId] = created;
    return created;
  }
  if (
    typeof existing !== "object"
    || Array.isArray(existing)
    || !Array.isArray(existing.requests)
    || existing.requests.some(
      (timestamp) => !Number.isSafeInteger(timestamp) || timestamp < 0,
    )
    || (
      existing.circuit != null
      && (
        typeof existing.circuit !== "object"
        || Array.isArray(existing.circuit)
        || !Number.isSafeInteger(existing.circuit.openedAt)
        || existing.circuit.openedAt < 0
      )
    )
  ) {
    throw new RequestGuardError(
      "REQUEST_GUARD_STATE_INVALID",
      `Request guard state for provider ${providerId} is invalid. Refusing to send while accounting is uncertain.`,
      { providerId },
    );
  }
  return existing;
}

async function assertSafeStatePath(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new RequestGuardError(
        "REQUEST_GUARD_STATE_INVALID",
        `Request guard state path must be a regular file: ${filePath}`,
        { path: filePath },
      );
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function readState(statePath) {
  await assertSafeStatePath(statePath);
  let raw;
  try {
    raw = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }

  try {
    return validateState(JSON.parse(raw), statePath);
  } catch (error) {
    if (error instanceof RequestGuardError) {
      throw error;
    }
    throw new RequestGuardError(
      "REQUEST_GUARD_STATE_INVALID",
      `Could not parse request guard state ${statePath}: ${error.message}. Refusing to send while accounting is uncertain.`,
      { statePath },
    );
  }
}

async function writeState(statePath, state) {
  await assertSafeStatePath(statePath);
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") {
      await handle.chmod(0o600);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await replaceFileAtomic(temporary, statePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function acquireLock(lockDirectory, {
  timeoutMs = LOCK_TIMEOUT_MS,
  staleMs = LOCK_STALE_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      return async () => {
        await fs.rm(lockDirectory, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }

    const stats = await fs.lstat(lockDirectory).catch(() => null);
    if (stats && !stats.isDirectory()) {
      throw new RequestGuardError(
        "REQUEST_GUARD_STATE_INVALID",
        `Request guard lock path is not a directory: ${lockDirectory}`,
        { lockDirectory },
      );
    }
    if (stats && Date.now() - stats.mtimeMs > staleMs) {
      await fs.rm(lockDirectory, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new RequestGuardError(
        "REQUEST_GUARD_LOCK_TIMEOUT",
        "Could not reserve the request guard state safely. No model request was sent.",
        { lockDirectory },
      );
    }
    await wait(50);
  }
}

export class RequestGuard {
  constructor({
    profileDir,
    providerId,
    now = () => Date.now(),
    sleep = wait,
    onWait = null,
  }) {
    if (!profileDir) {
      throw new TypeError("profileDir is required for RequestGuard.");
    }
    if (!providerId) {
      throw new TypeError("providerId is required for RequestGuard.");
    }
    this.profileDir = path.resolve(profileDir);
    this.providerId = String(providerId);
    this.configPath = path.join(path.dirname(this.profileDir), CONFIG_FILE);
    this.statePath = path.join(this.profileDir, STATE_FILE);
    this.lockDirectory = path.join(this.profileDir, LOCK_DIRECTORY);
    this.now = now;
    this.sleep = sleep;
    this.onWait = onWait;
    this.runRequestCount = 0;
    this.configPromise = null;
  }

  beginRun() {
    this.runRequestCount = 0;
    // Re-read config once per run so deliberate local edits take effect without
    // restarting a long-lived interactive conversation.
    this.configPromise = null;
  }

  async #config() {
    this.configPromise ??= readGuardConfig(this.configPath);
    return await this.configPromise;
  }

  async #withState(callback) {
    await fs.mkdir(this.profileDir, { recursive: true, mode: 0o700 });
    const release = await acquireLock(this.lockDirectory);
    try {
      const state = await readState(this.statePath);
      const result = await callback(state);
      if (result?.write !== false) {
        await writeState(this.statePath, state);
      }
      return result;
    } finally {
      await release();
    }
  }

  async beforeRequest() {
    const config = await this.#config();
    if (this.runRequestCount >= config.maxRequestsPerRun) {
      throw new RequestGuardError(
        "REQUEST_GUARD_RUN_LIMIT",
        `Local request guard stopped this run after ${config.maxRequestsPerRun} model request attempts.`,
        {
          provider: this.providerId,
          maxRequestsPerRun: config.maxRequestsPerRun,
          runRequests: this.runRequestCount,
        },
      );
    }

    for (;;) {
      const nowMs = this.now();
      const decision = await this.#withState(async (state) => {
        if (this.runRequestCount >= config.maxRequestsPerRun) {
          throw new RequestGuardError(
            "REQUEST_GUARD_RUN_LIMIT",
            `Local request guard stopped this run after ${config.maxRequestsPerRun} model request attempts.`,
            {
              provider: this.providerId,
              maxRequestsPerRun: config.maxRequestsPerRun,
              runRequests: this.runRequestCount,
            },
          );
        }
        const current = providerState(state, this.providerId);
        current.requests = current.requests
          .filter((timestamp) => timestamp > nowMs - HOUR_MS)
          .sort((left, right) => left - right);

        if (current.circuit) {
          const retryAt = current.circuit.openedAt + config.circuitOpenMs;
          if (retryAt > nowMs) {
            throw new RequestGuardError(
              "PROVIDER_CIRCUIT_OPEN",
              `Provider circuit for ${this.providerId} is open after a usage-limit response. No model request was sent.`,
              {
                provider: this.providerId,
                openedAt: new Date(current.circuit.openedAt).toISOString(),
                reason: current.circuit.reason ?? "provider_usage_limit",
                retryAfterMs: retryAt - nowMs,
              },
            );
          }
          // Expired breakers permit one normal probe. If the provider still
          // reports a limit, the guarded adapter opens a fresh circuit.
          current.circuit = null;
        }

        if (current.requests.length >= config.maxRequestsPerHour) {
          const retryAt = current.requests[0] + HOUR_MS;
          throw new RequestGuardError(
            "REQUEST_GUARD_HOURLY_LIMIT",
            `Local request guard reached ${config.maxRequestsPerHour} model request attempts in the rolling hour for ${this.providerId}. No model request was sent.`,
            {
              provider: this.providerId,
              maxRequestsPerHour: config.maxRequestsPerHour,
              requestsInWindow: current.requests.length,
              retryAfterMs: Math.max(0, retryAt - nowMs),
            },
          );
        }

        const lastRequest = current.requests.at(-1) ?? null;
        const waitMs = lastRequest == null
          ? 0
          : Math.max(0, lastRequest + config.minIntervalMs - nowMs);
        if (waitMs > 0) {
          return {
            waitMs,
            requestsInWindow: current.requests.length,
          };
        }

        current.requests.push(nowMs);
        this.runRequestCount += 1;
        return {
          waitMs: 0,
          runRequests: this.runRequestCount,
          requestsInWindow: current.requests.length,
        };
      });

      if (decision.waitMs > 0) {
        await this.onWait?.({
          provider: this.providerId,
          waitMs: decision.waitMs,
          minIntervalMs: config.minIntervalMs,
        });
        await this.sleep(decision.waitMs);
        continue;
      }

      return {
        provider: this.providerId,
        runRequests: decision.runRequests,
        requestsInWindow: decision.requestsInWindow,
        config,
      };
    }
  }

  async openCircuit({
    reason = "provider_usage_limit",
    detail = null,
  } = {}) {
    const nowMs = this.now();
    const config = await this.#config();
    await this.#withState(async (state) => {
      const current = providerState(state, this.providerId);
      current.requests = current.requests
        .filter((timestamp) => timestamp > nowMs - HOUR_MS)
        .sort((left, right) => left - right);
      current.circuit = {
        openedAt: nowMs,
        reason,
        detail: detail == null ? null : String(detail).slice(0, 500),
      };
      return {};
    });
    return {
      provider: this.providerId,
      openedAt: nowMs,
      retryAfterMs: config.circuitOpenMs,
    };
  }

  async status() {
    const config = await this.#config();
    const nowMs = this.now();
    return await this.#withState(async (state) => {
      const current = providerState(state, this.providerId);
      current.requests = current.requests
        .filter((timestamp) => timestamp > nowMs - HOUR_MS)
        .sort((left, right) => left - right);
      const circuit = current.circuit
        && current.circuit.openedAt + config.circuitOpenMs > nowMs
        ? {
            ...current.circuit,
            retryAfterMs:
              current.circuit.openedAt + config.circuitOpenMs - nowMs,
          }
        : null;
      if (!circuit) {
        current.circuit = null;
      }
      return {
        provider: this.providerId,
        runRequests: this.runRequestCount,
        requestsInWindow: current.requests.length,
        circuit,
        config,
        statePath: this.statePath,
      };
    });
  }
}
