import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_LIMITS } from "../shared/limits.js";
import { runProgram } from "./terminal-exec.js";
import { DEFAULT_SEARCH_EXCLUDED_DIRS } from "./search-fallback.js";

const MAX_TREE_ENTRIES = 60;
const MAX_GIT_CHANGES = 30;
const MAX_PATH_CHARS = 200;
const MAX_DIFF_STAT_CHARS = 3_000;
const MAX_PACKAGE_SCRIPTS = 30;
const MAX_PACKAGE_WORKSPACES = 20;
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_GIT_STATUS_BYTES = 32 * 1024;
const MAX_GIT_COMMAND_BYTES = 4 * 1024;

const TREE_EXCLUDED_DIRS = new Set([
  ...DEFAULT_SEARCH_EXCLUDED_DIRS,
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "out",
  "target",
  "vendor",
  "venv",
]);

const VISIBLE_HIDDEN_DIRS = new Set([".github"]);

const MANIFEST_FILES = new Set([
  "Cargo.toml",
  "Gemfile",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "go.mod",
  "mix.exs",
  "package.json",
  "pom.xml",
  "pubspec.yaml",
  "pyproject.toml",
  "requirements.txt",
]);

const LOCK_FILES = new Set([
  "Cargo.lock",
  "Gemfile.lock",
  "Pipfile.lock",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

const EXACT_CONFIG_FILES = new Set([
  ".editorconfig",
  ".eslintrc",
  ".prettierrc",
  "biome.json",
  "biome.jsonc",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  "nx.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
]);

const CONFIG_PATTERNS = [
  /^\.eslintrc\./u,
  /^\.prettierrc\./u,
  /^astro\.config\./u,
  /^eslint\.config\./u,
  /^jest\.config\./u,
  /^next\.config\./u,
  /^nuxt\.config\./u,
  /^playwright\.config\./u,
  /^postcss\.config\./u,
  /^rollup\.config\./u,
  /^svelte\.config\./u,
  /^tailwind\.config\./u,
  /^tsconfig(?:\..+)?\.json$/u,
  /^vite\.config\./u,
  /^vitest\.config\./u,
  /^webpack\.config\./u,
];

function portablePath(value) {
  return value.split(path.sep).join("/");
}

function boundedText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function boundedPath(value) {
  return boundedText(portablePath(value), MAX_PATH_CHARS);
}

async function collectTree(projectRoot) {
  const entries = [];
  let truncated = false;

  async function walk(directory, depth) {
    if (entries.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      return;
    }

    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const child of children) {
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      if (TREE_EXCLUDED_DIRS.has(child.name)) {
        continue;
      }
      if (
        child.name.startsWith(".")
        && child.isDirectory()
        && !VISIBLE_HIDDEN_DIRS.has(child.name)
      ) {
        continue;
      }

      const absolute = path.join(directory, child.name);
      const relative = path.relative(projectRoot, absolute);
      entries.push({
        path: boundedPath(relative || "."),
        type: child.isDirectory()
          ? "directory"
          : child.isSymbolicLink()
            ? "symlink"
            : "file",
      });

      if (child.isDirectory() && depth < 2) {
        await walk(absolute, depth + 1);
      }
    }
  }

  await walk(projectRoot, 0);
  return { entries, truncated };
}

function isConfigFile(name) {
  return EXACT_CONFIG_FILES.has(name)
    || CONFIG_PATTERNS.some((pattern) => pattern.test(name));
}

async function inspectRootFiles(projectRoot) {
  const children = await fs.readdir(projectRoot, { withFileTypes: true });
  const fileNames = children
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));

  return {
    manifests: fileNames.filter((name) => MANIFEST_FILES.has(name)),
    lockfiles: fileNames.filter((name) => LOCK_FILES.has(name)),
    configs: fileNames.filter(isConfigFile),
  };
}

function summarizeWorkspaces(workspaces) {
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : Array.isArray(workspaces?.packages)
      ? workspaces.packages
      : [];
  if (patterns.length === 0) {
    return null;
  }
  return {
    patterns: patterns.slice(0, MAX_PACKAGE_WORKSPACES),
    truncated: patterns.length > MAX_PACKAGE_WORKSPACES,
  };
}

async function summarizePackageJson(projectRoot) {
  const packagePath = path.join(projectRoot, "package.json");
  let stat;
  try {
    stat = await fs.stat(packagePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  if (stat.size > MAX_PACKAGE_JSON_BYTES) {
    return {
      readable: false,
      reason: `package.json exceeds ${MAX_PACKAGE_JSON_BYTES} bytes`,
      size: stat.size,
    };
  }

  try {
    const parsed = JSON.parse(await fs.readFile(packagePath, "utf8"));
    const scriptEntries = Object.entries(parsed.scripts ?? {})
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    return {
      readable: true,
      name: parsed.name ?? null,
      version: parsed.version ?? null,
      private: parsed.private ?? null,
      type: parsed.type ?? null,
      packageManager: parsed.packageManager ?? null,
      engines: parsed.engines ?? null,
      scripts: Object.fromEntries(scriptEntries.slice(0, MAX_PACKAGE_SCRIPTS)),
      scriptsTruncated: scriptEntries.length > MAX_PACKAGE_SCRIPTS,
      workspaces: summarizeWorkspaces(parsed.workspaces),
      dependencyCounts: {
        dependencies: Object.keys(parsed.dependencies ?? {}).length,
        devDependencies: Object.keys(parsed.devDependencies ?? {}).length,
        optionalDependencies: Object.keys(parsed.optionalDependencies ?? {}).length,
        peerDependencies: Object.keys(parsed.peerDependencies ?? {}).length,
      },
    };
  } catch (error) {
    return {
      readable: false,
      reason: `Could not parse package.json: ${error.message}`,
      size: stat.size,
    };
  }
}

function gitTimeoutMs(limits) {
  const configured = Number(limits?.toolTimeoutMs);
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    return 10_000;
  }
  return Math.min(configured, 10_000);
}

async function runGit(projectRoot, argv, limits, maxOutputBytes = MAX_GIT_COMMAND_BYTES) {
  return await runProgram({
    program: "git",
    argv,
    cwd: projectRoot,
    timeoutMs: gitTimeoutMs(limits),
    maxOutputBytes,
    maxLogBytes: 0,
  });
}

function parseGitChanges(statusResult) {
  const lines = String(statusResult.stdout ?? "")
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => !line.includes("[WTAgent omitted "));
  return {
    changes: lines.slice(0, MAX_GIT_CHANGES).map((line) => ({
      status: line.slice(0, 2),
      path: boundedPath(line.length > 3 ? line.slice(3) : line),
    })),
    truncated: Boolean(statusResult.truncated || lines.length > MAX_GIT_CHANGES),
  };
}

async function inspectGit(projectRoot, limits) {
  const probe = await runGit(
    projectRoot,
    ["rev-parse", "--is-inside-work-tree"],
    limits,
  );
  if (!probe.ok || String(probe.stdout).trim() !== "true") {
    return {
      available: false,
      reason: probe.error?.code === "ENOENT"
        ? "git-unavailable"
        : "not-a-git-repository",
    };
  }

  const [branchResult, headResult, statusResult] = await Promise.all([
    runGit(projectRoot, ["branch", "--show-current"], limits),
    runGit(projectRoot, ["rev-parse", "--verify", "HEAD"], limits),
    runGit(
      projectRoot,
      ["status", "--short", "--untracked-files=all", "--", "."],
      limits,
      MAX_GIT_STATUS_BYTES,
    ),
  ]);

  const branch = branchResult.ok
    ? String(branchResult.stdout).trim() || null
    : null;
  const head = headResult.ok
    ? String(headResult.stdout).trim() || null
    : null;
  const parsedStatus = statusResult.ok
    ? parseGitChanges(statusResult)
    : { changes: [], truncated: false };

  let diffStat = "";
  const diffArgs = head
    ? ["diff", "--stat", "HEAD", "--", "."]
    : ["diff", "--stat", "--", "."];
  const diffResult = await runGit(projectRoot, diffArgs, limits);
  if (diffResult.ok) {
    diffStat = boundedText(String(diffResult.stdout).trim(), MAX_DIFF_STAT_CHARS);
  }

  return {
    available: true,
    branch,
    head,
    dirty: parsedStatus.changes.length > 0 || parsedStatus.truncated,
    changes: parsedStatus.changes,
    changesTruncated: parsedStatus.truncated,
    diffStat,
    diffStatTruncated: Boolean(
      diffResult.truncated
      || String(diffResult.stdout ?? "").trim().length > MAX_DIFF_STAT_CHARS
    ),
  };
}

export function createRepoInspectDefinition({ limits = DEFAULT_LIMITS } = {}) {
  return {
    name: "repo.inspect",
    description: [
      "Inspect the current project in one bounded read-only snapshot.",
      "Use this early in repository analysis instead of separately requesting fs.list,",
      "git status/diff --stat, package.json, and common config filenames.",
      "Returns a shallow tree, Git branch/HEAD/status/diff stat, root manifests/lockfiles/configs,",
      "and a compact package.json summary. It intentionally omits full diffs and source contents.",
    ].join(" "),
    inputDescription: "<args></args>",
    risk: "read",
    inputSchema: z.object({}),
    execute: async (_args, context) => {
      const projectRoot = path.resolve(context.projectRoot);
      const [tree, rootFiles, packageJson, git] = await Promise.all([
        collectTree(projectRoot),
        inspectRootFiles(projectRoot),
        summarizePackageJson(projectRoot),
        inspectGit(projectRoot, limits),
      ]);
      return {
        ok: true,
        message: git.available
          ? `Inspected project with ${tree.entries.length} tree entries and ${git.changes.length} Git changes.`
          : `Inspected project with ${tree.entries.length} tree entries; Git metadata is unavailable.`,
        data: {
          projectRoot,
          tree,
          git,
          ...rootFiles,
          packageJson,
        },
      };
    },
  };
}

export function registerRepoInspectTool(registry, options = {}) {
  registry.register(createRepoInspectDefinition(options));
  return registry;
}
