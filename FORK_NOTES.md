# Fork notes

This fork keeps the upstream WTAgent implementation intact while adding clearer OpenCode and Codex integration layers and documentation.

## Fork additions

### `docs/opencode-integration.md`

Expanded integration documentation covering the full call path:

```text
OpenCode custom tool
    -> Bun.spawn(wtagent ...)
    -> WTAgent CLI machine mode
    -> AgentSession / ConversationRunner / AgentRuntime
    -> Chrome + ChatGPT Web
    -> XML local-tool protocol
    -> WTAgent ToolRegistry / PolicyEngine
    -> machine JSON result
    -> OpenCode
```

The document includes:

- custom-tool discovery and argument flow;
- Git repository context collection;
- exact WTAgent child-process argv construction;
- stdout/stderr separation and outer timeout handling;
- `--once --json` CLI validation;
- session creation and browser authentication flow;
- ChatGPT mode selection and fallback behavior;
- WTAgent's XML application protocol rather than native API function calling;
- local tool validation, execution, result serialization, and browser round trips;
- replay/side-effect protection and recovery behavior;
- machine-mode errors such as `AUTH_REQUIRED` and `APPROVAL_REQUIRED`;
- the final machine JSON envelope consumed by OpenCode;
- an end-to-end Mermaid sequence diagram;
- a failure map and troubleshooting split between WTAgent and OpenCode layers;
- a source-file reading order for tracing the implementation.

### Codex: Architect -> Executor -> Verifier

The fork now contains a persistent Codex orchestration path:

```text
WTAgent High/Pro Architect
        -> Codex Executor
        -> WTAgent High/Pro Verifier
```

Added files:

- `AGENTS.md`
  - tells Codex when a task is complex enough to use the full workflow;
  - requires an independent WTAgent planning pass before non-trivial implementation;
  - keeps Codex as the intended repository writer;
  - requires an independent WTAgent verification pass after implementation/tests;
  - caps the normal blocker/fix/review loop instead of encouraging unlimited expensive reviews.

- `scripts/codex-wtagent.ps1`
  - exposes `-Phase plan` and `-Phase review`;
  - invokes `wtagent --once --json` directly from Codex;
  - supports `Instant`, `Medium`, `High`, `Pro`, and `Current`;
  - defaults to `Pro`;
  - returns structured JSON for Codex to consume;
  - fingerprints Git status/diff before and after Architect/Verifier calls and fails if WTAgent unexpectedly changes the worktree.

- `docs/codex-wtagent-workflow.md`
  - documents the full three-role workflow;
  - explains why Codex does not need the OpenCode TypeScript adapter;
  - documents plan/review command examples, model policy, review-loop policy, failure handling, and future hardening.

- `README.md`
  - now exposes both Codex and OpenCode integration entry points from the repository front page.

### Security clarification

A key correction is documented explicitly:

> The OpenCode/Codex reviewer prompts ask WTAgent to behave as read-only, but that is a prompt-level restriction, not a hard read-only Runtime policy.

The default WTAgent registry still contains write/exec-capable tools. The current `PolicyEngine` does not require confirmation merely because an in-project operation is a normal `fs.write` or `fs.edit`.

The Codex PowerShell wrapper adds **mutation detection** by fingerprinting the Git worktree before/after the WTAgent call. This detects a violation but does not prevent one. A future native `--read-only` / reviewer policy remains the preferred hardening direction.

### `examples/opencode/wtagent.ts`

A cleaned OpenCode custom-tool example derived from the upstream demo:

- keeps `High` as the default reasoning mode;
- adds `Pro` to the accepted WTAgent mode list;
- keeps repository-context collection;
- keeps the 30-minute outer timeout;
- keeps strict JSON parsing and WTAgent error propagation;
- keeps the independent-review prompt and local-worktree source-of-truth rule.

## Upstream preservation

The upstream file:

```text
opencode-call-wtagent-demo.ts
```

is intentionally left untouched.

Fork-specific additions stay primarily under:

```text
AGENTS.md
docs/
examples/
scripts/codex-wtagent.ps1
FORK_NOTES.md
```

This reduces merge/rebase conflict when synchronizing from `luojiyin1987/wtagent`.
