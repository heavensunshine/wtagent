import test from "node:test";
import assert from "node:assert/strict";
import {
  CHATGPT_MODE_CHOICES,
  modeFromPromptChoice,
  normalizeConfiguredMode,
} from "../src/cli/mode-choice.js";

test("interactive mode choices offer Plus levels and the current web setting", () => {
  assert.deepEqual(
    CHATGPT_MODE_CHOICES.map(({ value }) => value),
    ["instant", "medium", "high", "current"],
  );
  assert.equal(modeFromPromptChoice("instant"), "Instant");
  assert.equal(modeFromPromptChoice("medium"), "Medium");
  assert.equal(modeFromPromptChoice("high"), "High");
  assert.equal(modeFromPromptChoice("current"), null);
});

test("configured mode accepts Plus levels and preserves Pro compatibility", () => {
  assert.equal(normalizeConfiguredMode("instant"), "Instant");
  assert.equal(normalizeConfiguredMode("MEDIUM"), "Medium");
  assert.equal(normalizeConfiguredMode("High"), "High");
  assert.equal(normalizeConfiguredMode("CURRENT"), null);
  assert.equal(normalizeConfiguredMode("pro"), "Pro");
  assert.throws(
    () => normalizeConfiguredMode("Extra High"),
    /Instant.*Medium.*High.*Current.*Pro/,
  );
});
