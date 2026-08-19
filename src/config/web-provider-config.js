import fs from "node:fs/promises";
import path from "node:path";
import { getEnvCaseInsensitive } from "../platform/command-launcher.js";
import {
  DEFAULT_WEB_PROVIDER,
  getWebProvider,
} from "../browser/web-providers.js";

export const WEB_PROVIDER_CONFIG_FILE = "config.json";

function assertConfigObject(value, configPath) {
  if (
    value == null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    throw new Error(`WTAgent config must be a JSON object: ${configPath}`);
  }
  return value;
}

async function readConfig(configPath) {
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }

  try {
    return assertConfigObject(JSON.parse(raw), configPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Could not parse WTAgent config ${configPath}: ${error.message}`);
    }
    throw error;
  }
}

export async function resolveWebProviderConfig({
  appDataDir,
  explicitProvider = null,
  env = process.env,
} = {}) {
  if (!appDataDir) {
    throw new Error("appDataDir is required to resolve the web provider.");
  }

  const configPath = path.join(path.resolve(appDataDir), WEB_PROVIDER_CONFIG_FILE);
  const config = await readConfig(configPath);
  if (config.provider != null && typeof config.provider !== "string") {
    throw new Error(`WTAgent config provider must be a string: ${configPath}`);
  }

  const envProvider = getEnvCaseInsensitive(env, "WTAGENT_PROVIDER");
  const requested = explicitProvider
    ?? envProvider
    ?? config.provider
    ?? DEFAULT_WEB_PROVIDER;
  const provider = getWebProvider(requested);
  const source = explicitProvider != null
    ? "cli"
    : envProvider != null
      ? "env"
      : config.provider != null
        ? "config"
        : "default";

  return {
    ...provider,
    source,
    configPath,
  };
}
