import { RequestGuard } from "../runtime/request-guard.js";

export function createRequestGuardedAdapter(BaseAdapter, {
  providerId,
  isLimitNotice = () => false,
} = {}) {
  if (typeof BaseAdapter !== "function") {
    throw new TypeError("BaseAdapter must be a constructor.");
  }
  if (!providerId) {
    throw new TypeError("providerId is required for a request-guarded adapter.");
  }

  return class RequestGuardedWebAdapter extends BaseAdapter {
    constructor(options = {}) {
      super(options);
      this.requestGuard = new RequestGuard({
        profileDir: this.profileDir ?? options.profileDir,
        providerId,
        onWait: options.debug
          ? async ({ waitMs }) => {
              process.stderr.write(
                `[request guard] waiting ${waitMs}ms before the next ${providerId} model request\n`,
              );
            }
          : null,
      });
      this.requestGuardReconnectRestorePending = false;
    }

    async startConversation(...args) {
      if (this.requestGuardReconnectRestorePending) {
        // AgentRuntime calls startConversation() after reconnect() to restore the
        // same in-flight request. Do not reset the per-run counter in that path.
        this.requestGuardReconnectRestorePending = false;
      } else {
        this.requestGuard.beginRun();
      }
      return await super.startConversation(...args);
    }

    async reconnect(...args) {
      this.requestGuardReconnectRestorePending = true;
      try {
        return await super.reconnect(...args);
      } catch (error) {
        this.requestGuardReconnectRestorePending = false;
        throw error;
      }
    }

    async sendMessage(...args) {
      // Reserve before every physical adapter send. Runtime-level reconnect and
      // SEND_NOT_DETECTED retries call adapter.sendMessage again, so they also
      // consume the local request budget instead of being hidden retries.
      await this.requestGuard.beforeRequest();
      return await super.sendMessage(...args);
    }

    async waitForTurnComplete(...args) {
      try {
        const text = await super.waitForTurnComplete(...args);
        if (isLimitNotice(text)) {
          await this.requestGuard.openCircuit({
            reason: "provider_usage_limit",
            detail: String(text).slice(0, 500),
          });
        }
        return text;
      } catch (error) {
        if (error?.code === "USAGE_LIMIT_REACHED") {
          await this.requestGuard.openCircuit({
            reason: "provider_usage_limit",
            detail: error.message,
          });
        }
        throw error;
      }
    }
  };
}
