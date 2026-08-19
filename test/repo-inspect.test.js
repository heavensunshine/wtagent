import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";

function context(root) {
  return {
    projectRoot: root,
    allowOutside: false,
    toolTimeoutMs: 10_000,
  };
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error?.code === "ENOENT") {
    return null;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function inspect(root) {
  const registry = createDefaultToolRegistry();
  const call = registry.validate({
    id: "inspect",
    name: "repo.inspect",
    args: {},
  });
  return await registry.execute(call, context(root));
}

test("registers repo.inspect as a bounded read-only repository overview", () => {
  const tool = createDefaultToolRegistry().list()
    .find((entry) => entry.name === "repo.inspect");

  assert.equal(tool.risk, "read");
  assert.match(tool.description, /one bounded read-only snapshot/);
  assert.match(tool.description, /instead of separately requesting fs\.list/);
  assert.match(tool.description, /intentionally omits full diffs/);
});

test("inspects project structure and manifests without requiring Git", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-inspect-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export {};\n", "utf8");
  await fs.writeFile(path.join(root, "node_modules", "ignored", "x.js"), "ignored", "utf8");
  await fs.writeFile(path.join(root, "pyproject.toml"), "[project]\nname='demo'\n", "utf8");
  await fs.writeFile(path.join(root, "go.mod"), "module example.test/demo\n", "utf8");
  await fs.writeFile(path.join(root, "tsconfig.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(root, "vite.config.js"), "export default {};\n", "utf8");
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "demo",
    private: true,
    type: "module",
    packageManager: "pnpm@10.0.0",
    engines: { node: ">=20" },
    scripts: { build: "vite build", test: "node --test" },
    workspaces: ["packages/*"],
    dependencies: { a: "1.0.0" },
    devDependencies: { b: "1.0.0", c: "1.0.0" },
  }), "utf8");

  const result = await inspect(root);

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.manifests, ["go.mod", "package.json", "pyproject.toml"]);
  assert.deepEqual(result.data.lockfiles, ["pnpm-lock.yaml"]);
  assert.deepEqual(result.data.configs, ["tsconfig.json", "vite.config.js"]);
  assert.equal(result.data.packageJson.name, "demo");
  assert.deepEqual(result.data.packageJson.scripts, {
    build: "vite build",
    test: "node --test",
  });
  assert.deepEqual(result.data.packageJson.dependencyCounts, {
    dependencies: 1,
    devDependencies: 2,
    optionalDependencies: 0,
    peerDependencies: 0,
  });
  assert.ok(result.data.tree.entries.some((entry) => entry.path === "src/index.js"));
  assert.equal(
    result.data.tree.entries.some((entry) => entry.path.includes("node_modules")),
    false,
  );
  assert.equal(result.data.git.available, false);
});

test("returns Git status and diff stat without returning the full diff", async (t) => {
  const gitVersion = spawnSync("git", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (gitVersion.error?.code === "ENOENT") {
    t.skip("git is not installed");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-inspect-git-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  runGit(["init"], root);
  runGit(["config", "user.email", "wtagent@example.test"], root);
  runGit(["config", "user.name", "WTAgent Tests"], root);
  await fs.writeFile(path.join(root, "tracked.txt"), "before\n", "utf8");
  runGit(["add", "tracked.txt"], root);
  runGit(["commit", "-m", "initial"], root);
  runGit(["branch", "-M", "main"], root);

  await fs.writeFile(
    path.join(root, "tracked.txt"),
    "after-change-secret-that-must-not-appear-in-inspect-output\n",
    "utf8",
  );
  await fs.writeFile(path.join(root, "untracked.txt"), "new\n", "utf8");

  const result = await inspect(root);
  const serialized = JSON.stringify(result.data);

  assert.equal(result.ok, true);
  assert.equal(result.data.git.available, true);
  assert.equal(result.data.git.branch, "main");
  assert.match(result.data.git.head, /^[0-9a-f]{40}$/u);
  assert.equal(result.data.git.dirty, true);
  assert.ok(result.data.git.changes.some((change) => change.path === "tracked.txt"));
  assert.ok(result.data.git.changes.some((change) => change.path === "untracked.txt"));
  assert.match(result.data.git.diffStat, /tracked\.txt/u);
  assert.doesNotMatch(
    serialized,
    /after-change-secret-that-must-not-appear-in-inspect-output/u,
  );
});

test("bounds the repository tree snapshot", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-inspect-tree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (let index = 0; index < 80; index += 1) {
    await fs.writeFile(
      path.join(root, `file-${String(index).padStart(2, "0")}.txt`),
      `${index}\n`,
      "utf8",
    );
  }

  const result = await inspect(root);

  assert.equal(result.ok, true);
  assert.equal(result.data.tree.entries.length, 60);
  assert.equal(result.data.tree.truncated, true);
});
