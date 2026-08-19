const INTERACTIVE_MODES = Object.freeze([
  Object.freeze({ name: "Instant — fast responses", value: "instant" }),
  Object.freeze({ name: "Medium — standard reasoning", value: "medium" }),
  Object.freeze({ name: "High — extended reasoning", value: "high" }),
  Object.freeze({
    name: "Current — keep the current ChatGPT setting",
    value: "current",
  }),
]);

const CONFIGURED_MODES = new Map([
  ["instant", "Instant"],
  ["medium", "Medium"],
  ["high", "High"],
  // Preserve the existing CLI value for Pro users and scripts even though the
  // default interactive picker is aimed at the modes available to Plus users.
  ["pro", "Pro"],
]);

export const CHATGPT_MODE_CHOICES = INTERACTIVE_MODES;

export function normalizeConfiguredMode(value) {
  const configured = String(value ?? "").trim();
  if (/^current$/i.test(configured)) {
    return null;
  }

  const normalized = CONFIGURED_MODES.get(configured.toLowerCase());
  if (normalized) {
    return normalized;
  }

  throw new Error(
    'ChatGPT mode must be one of "Instant", "Medium", "High", "Current", or "Pro".',
  );
}

export function modeFromPromptChoice(choice) {
  return CONFIGURED_MODES.get(String(choice ?? "").toLowerCase()) ?? null;
}
