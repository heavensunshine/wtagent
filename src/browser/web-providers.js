import { ChatGPTWebAdapter } from "./chatgpt-web-adapter.js";

export const DEFAULT_WEB_PROVIDER = "chatgpt";

const PROVIDERS = Object.freeze({
  chatgpt: Object.freeze({
    id: "chatgpt",
    label: "ChatGPT",
    baseUrl: "https://chatgpt.com/",
    Adapter: ChatGPTWebAdapter,
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
