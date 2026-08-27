# Fork notes

This fork keeps the upstream WTAgent implementation intact while adding a clearer OpenCode integration layer and documentation.

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

The document now includes:

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

### Security clarification

A key correction is now documented explicitly:

> The OpenCode adapter asks WTAgent to behave as a read-only reviewer, but that is a prompt-level restriction, not a hard read-only Runtime policy.

The default WTAgent registry still contains write/exec-capable tools. The current `PolicyEngine` does not require confirmation merely because an in-project operation is a normal `fs.write` or `fs.edit`. Therefore hard read-only review requires an external filesystem/container boundary or a stricter reviewer-specific registry/policy.

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
docs/
examples/
FORK_NOTES.md
```

This reduces merge/rebase conflict when synchronizing from `luojiyin1987/wtagent`.
