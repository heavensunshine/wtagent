import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_WEB_PROVIDER,
  getWebProvider,
  listWebProviders,
} from "../src/browser/web-providers.js";
import { resolveWebProviderConfig } from "../src/config/web-provider-config.js";

async function withTempHome(run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-provider-"));
  try {
    return await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("provider registry exposes ChatGPT as the backward-compatible default", () => {
  assert.equal(DEFAULT_WEB_PROVIDER, "chatgpt");
  assert.deepEqual(listWebProviders(), [{
    id: "chatgpt",
    label: "ChatGPT",
    baseUrl: "https://chatgpt.com/",
    supportsModeSelection: true,
  }]);

  const provider = getWebProvider();
  assert.equal(provider.id, "chatgpt");
  assert.equal(provider.label, "ChatGPT");
  assert.equal(typeof provider.Adapter, "function");
});

test("missing config keeps ChatGPT as the default provider", async () => {
  await withTempHome(async (home) => {
    const resolved = await resolveWebProviderConfig({
      appDataDir: home,
      env: {},
    });

    assert.equal(resolved.id, "chatgpt");
    assert.equal(resolved.source, "default");
    assert.equal(resolved.configPath, path.join(home, "config.json"));
  });
});

test("config.json can select the registered provider", async () => {
  await withTempHome(async (home) => {
    await fs.writeFile(
      path.join(home, "config.json"),
      `${JSON.stringify({ provider: "CHATGPT" })}\n`,
    );

    const resolved = await resolveWebProviderConfig({
      appDataDir: home,
      env: {},
    });

    assert.equal(resolved.id, "chatgpt");
    assert.equal(resolved.source, "config");
  });
});

test("provider precedence is CLI over environment over config", async () => {
  await withTempHome(async (home) => {
    await fs.writeFile(
      path.join(home, "config.json"),
      `${JSON.stringify({ provider: "unknown-from-config" })}\n`,
    );

    const explicit = await resolveWebProviderConfig({
      appDataDir: home,
      explicitProvider: "chatgpt",
      env: { WTAGENT_PROVIDER: "unknown-from-env" },
    });
    assert.equal(explicit.id, "chatgpt");
    assert.equal(explicit.source, "cli");

    await fs.writeFile(
      path.join(home, "config.json"),
      `${JSON.stringify({ provider: "unknown-from-config" })}\n`,
    );
    const fromEnv = await resolveWebProviderConfig({
      appDataDir: home,
      env: { WTAGENT_PROVIDER: "chatgpt" },
    });
    assert.equal(fromEnv.id, "chatgpt");
    assert.equal(fromEnv.source, "env");
  });
});

test("unknown providers fail before a browser is launched", async () => {
  await withTempHome(async (home) => {
    await fs.writeFile(
      path.join(home, "config.json"),
      `${JSON.stringify({ provider: "deepseek" })}\n`,
    );

    await assert.rejects(
      resolveWebProviderConfig({ appDataDir: home, env: {} }),
      /Unknown web provider "deepseek"\. Available providers: chatgpt\./,
    );
  });
});

test("malformed provider config reports its file", async () => {
  await withTempHome(async (home) => {
    const configPath = path.join(home, "config.json");
    await fs.writeFile(configPath, "{ nope\n");

    await assert.rejects(
      resolveWebProviderConfig({ appDataDir: home, env: {} }),
      (error) => {
        assert.match(error.message, /Could not parse WTAgent config/);
        assert.match(error.message, /config\.json/);
        return true;
      },
    );
  });
});
