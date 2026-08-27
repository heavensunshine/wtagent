# OpenCode × WTAgent integration

This note documents the intended relationship between OpenCode and WTAgent and gives a clean install layout for the custom OpenCode tool.

## Architecture

```text
OpenCode
  -> custom tool: wtagent
  -> `wtagent --once --json --mode <MODE> -C <project> "<task>"`
  -> ChatGPT Web
  -> WTAgent local file / command bridge
  -> JSON result returned to OpenCode
```

WTAgent is best treated as an **independent second reviewer**, not as an OpenCode provider replacement.

Recommended workflow:

```text
OpenCode implements / investigates
        |
        +--> WTAgent + ChatGPT independently reviews the same worktree
        |
        +--> OpenCode reconciles findings and fixes
        |
        +--> optional WTAgent regression review
```

## Install

Requirements:

- Node.js 20.17+
- Chrome / Chromium
- OpenCode
- WTAgent
- a logged-in ChatGPT Web session

Install WTAgent:

```bash
npm install -g wtagent
wtagent login
```

### Global OpenCode tool

Copy the adapter to:

```text
~/.config/opencode/tools/wtagent.ts
```

On native Windows this normally resolves under:

```text
%USERPROFILE%\.config\opencode\tools\wtagent.ts
```

The OpenCode tool file is discovered from the `tools` directory; it is **not a model/provider configuration**.

### Project-scoped alternative

For one project only:

```text
<project>/.opencode/tools/wtagent.ts
```

## Minimal OpenCode config

WTAgent does not require an OpenAI provider entry in OpenCode.

A minimal global config may remain:

```json
{
  "$schema": "https://opencode.ai/config.json"
}
```

The integration itself lives in `tools/wtagent.ts`.

## WTAgent invocation

The adapter invokes WTAgent approximately as:

```bash
wtagent --once --json --mode High -C ./project "review this implementation"
```

Important behavior:

- `--once`: one delegated task, then exit.
- `--json`: one machine-readable result on stdout.
- progress / diagnostics go to stderr.
- `-C`: makes the current OpenCode project the WTAgent working directory.
- authentication should be completed beforehand with `wtagent login`.

Typical JSON success envelope:

```json
{
  "schemaVersion": 1,
  "status": "completed",
  "sessionId": "session_...",
  "result": "...",
  "projectRoot": "/path/to/project"
}
```

## Repository context supplied by the adapter

Before invoking WTAgent, the OpenCode adapter gathers:

- origin remote
- current branch
- HEAD commit
- whether the worktree is dirty

The delegated prompt tells the reviewer to treat the **local WTAgent worktree as the source of truth** for:

- uncommitted changes
- generated files
- git diff
- local test results
- runtime behavior

Remote GitHub content is only supplementary context.

## Reasoning modes

The upstream demo exposes:

- Instant
- Medium
- High
- Current

WTAgent itself also documents explicit `--mode Pro` use when the connected ChatGPT account supports it.

The fork example in `examples/opencode/wtagent.ts` adds `Pro` to the OpenCode tool schema while keeping `High` as the default.

## Safety boundary

The adapter tells WTAgent to act as a **read-only reviewer**:

- no file modifications
- no file creation/deletion
- no destructive commands
- no commit / push / merge / publish

This is a prompt-level policy. It should **not** be confused with an OS-enforced read-only sandbox.

For sensitive repositories, use an external sandbox / read-only filesystem boundary if hard enforcement is required.

## Recommended use

Good tasks:

- independent code review
- hard debugging
- regression analysis
- architecture review
- security review
- test failure investigation
- second opinions on uncertain findings

Avoid using it for every trivial edit. It is most useful as an independent reasoning pass at important checkpoints.
