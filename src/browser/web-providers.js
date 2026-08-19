import { ChatGPTWebAdapter } from "./chatgpt-web-adapter.js";
import { createRequestGuardedAdapter } from "./request-guarded-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export const DEFAULT_WEB_PROVIDER = "chatgpt";

function isChatGPTLimitTransportNotice(text) {
  const value = String(text ?? "");
  const hasCompleteEnvelope = value.includes("<agent_response")
    && value.includes("</agent_response>");
  return !hasCompleteEnvelope && isUsageLimitNotice(value);
}

const GuardedChatGPTWebAdapter = createRequestGuardedAdapter(
  ChatGPTWebAdapter,
  {
    providerId: "chatgpt",
    isLimitNotice: isChatGPTLimitTransportNotice,
  },
);

const PROVIDERS = Object.freeze({
  chatgpt: Object.freeze({
    id: "chatgpt",
    label: "ChatGPT",
    baseUrl: "https://chatgpt.com/",
    Adapter: GuardedChatGPTWebAdapter,
    supportsModeSelection: true,
  }),
});

export function normalizeWebProviderName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || DEFAULT_WEB_PROVIDER;
}

export function listWebProviders() {
  return Object.values(PROVIDERS).map((provider) => ({
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    supportsModeSelection: provider.supportsModeSelection,
  }));
}

export function getWebProvider(value = DEFAULT_WEB_PROVIDER) {
  const id = normalizeWebProviderName(value);
  const provider = PROVIDERS[id];
  if (provider) {
    return provider;
  }

  throw new Error(
    `Unknown web provider "${String(value)}". Available providers: ${Object.keys(PROVIDERS).join(", ")}.`,
  );
}
