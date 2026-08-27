# Codex × WTAgent: Architect → Executor → Verifier

This document turns WTAgent into an external high-reasoning planning/review channel for Codex while keeping Codex as the implementation agent.

## Goal

Use expensive/high-reasoning passes only where they add the most value:

```text
User task
   |
   v
WTAgent + ChatGPT Web (Architect, High/Pro, read-only intent)
   |
   | plan + invariants + acceptance criteria
   v
Codex (Executor, repository writer)
   |
   | implementation + tests + git diff
   v
WTAgent + ChatGPT Web (Verifier, High/Pro, independent read-only intent)
   |
   +--> PASS ----> finish
   |
   `--> BLOCKERS -> Codex fixes -> tests -> one more review
```

The important separation is **role**, not simply model size:

- **Architect:** spends reasoning budget deciding what should be done and how success is measured.
- **Executor:** spends most tool calls on actual repository work.
- **Verifier:** independently checks whether the resulting worktree really satisfies the task.

## Why this fits Codex

Codex already has the capabilities needed for the Executor role: shell access, repository edits, tests, diffs, and persistent repository instructions through `AGENTS.md`.

WTAgent already exposes a machine-friendly one-shot interface:

```powershell
wtagent --once --json --mode Pro -C . "<task>"
```

So Codex does not need a TypeScript custom-tool adapter. It can invoke WTAgent directly through the shell.

This fork adds:

```text
AGENTS.md
scripts/codex-wtagent.ps1
docs/codex-wtagent-workflow.md
```

## 1. Persistent orchestration through AGENTS.md

Codex reads repository-level `AGENTS.md`, making it the correct place to define when the workflow should trigger.

The file in this fork tells Codex:

1. classify whether the task is non-trivial;
2. call WTAgent as Architect before implementation;
3. independently verify the plan against local evidence;
4. implement and test with Codex;
5. call WTAgent as an independent Verifier;
6. fix confirmed blockers and review once more if needed.

This means a user can normally just ask Codex to do the actual engineering task. The orchestration rule lives in the repository instead of being pasted into every prompt.

## 2. PowerShell wrapper

The wrapper is:

```text
scripts/codex-wtagent.ps1
```

It has two phases:

```powershell
-Phase plan
-Phase review
```

### Architect call

```powershell
pwsh -File ./scripts/codex-wtagent.ps1 `
  -Phase plan `
  -Mode Pro `
  -Task "Fix the temperature compensation discontinuity"
```

Expected JSON returned to Codex:

```json
{
  "phase": "plan",
  "mode": "Pro",
  "status": "completed",
  "sessionId": "session_...",
  "projectRoot": "D:\\project",
  "worktreeUnchanged": true,
  "result": "...architect plan..."
}
```

The Architect prompt asks WTAgent to return:

- confirmed current state;
- relevant files/functions/subsystems;
- root-cause hypotheses and uncertainties;
- ordered implementation plan;
- invariants / must-not-change items;
- test plan;
- explicit acceptance criteria;
- risks/open questions.

The Architect is explicitly told **not to implement the change**.

## 3. Codex Executor phase

After receiving the plan, Codex should not blindly execute it.

Codex should:

1. inspect the same repository itself;
2. verify important Architect claims;
3. resolve contradictions against local source evidence;
4. modify the smallest necessary set of files;
5. run relevant tests/builds/checks;
6. inspect `git diff` and `git status`;
7. remove unrelated changes;
8. retain the original user task and acceptance criteria for final review.

The plan is advisory evidence, not authority.

## 4. Independent Verifier call

After implementation:

```powershell
pwsh -File ./scripts/codex-wtagent.ps1 `
  -Phase review `
  -Mode Pro `
  -Task "Fix the temperature compensation discontinuity" `
  -Acceptance "No boundary jump; raw path unchanged; existing tests pass"
```

The Verifier prompt deliberately does **not** include Codex's explanation of why its code is correct.

Instead it receives:

- original task;
- acceptance criteria;
- current local worktree.

It is instructed to inspect:

- actual source;
- `git diff` / `git status`;
- tests;
- available build/test evidence;
- regressions and edge cases.

The top-level result should be either:

```text
PASS
```

or:

```text
BLOCKERS
1. ...
2. ...
```

This reduces confirmation bias between the implementation agent and the reviewing agent.

## 5. Review loop policy

Recommended default:

```text
Architect
   ↓
Codex implementation
   ↓
Tests
   ↓
Verifier #1
   ├── PASS -> done
   └── BLOCKERS
          ↓
       Codex fixes
          ↓
       affected tests
          ↓
       Verifier #2
```

Do not create an unlimited reviewer loop. If the second verifier still disagrees with Codex and the evidence is ambiguous, surface the disagreement and concrete evidence rather than burning repeated high-tier calls.

## 6. Model/mode policy

Recommended WTAgent policy:

| Task | WTAgent mode |
|---|---|
| architecture / difficult planning | `Pro` |
| independent final review | `Pro` |
| Pro unavailable | `High` |
| ordinary secondary analysis | `High` or `Medium` |
| trivial checks | usually do not invoke WTAgent |

Codex itself remains free to use the execution model/reasoning level appropriate for the repository work.

The purpose is not literally "smart model writes instructions for dumb model". The purpose is to spend frontier reasoning on **decision quality and verification**, while using Codex's coding harness for the high-volume execution phase.

## 7. Read-only detection

Important: WTAgent currently has real local write-capable tools such as `fs.write` and `fs.edit`. The Architect/Verifier role is therefore a prompt-level read-only contract rather than a hard filesystem sandbox.

The PowerShell wrapper adds a guard:

1. fingerprint Git status + diff before the WTAgent call;
2. run WTAgent;
3. fingerprint Git status + diff again;
4. fail if the fingerprints differ.

If the worktree changed, the wrapper reports a workflow violation and tells Codex to inspect `git status` / `git diff` before proceeding.

This is **detection, not prevention**. A future stronger implementation should add a real WTAgent read-only policy/mode that rejects write/process side effects before execution.

## 8. Failure paths

### WTAgent missing

```text
wtagent was not found on PATH
```

Install and authenticate:

```powershell
npm install -g wtagent
wtagent login
```

### Authentication missing

WTAgent JSON mode may return `AUTH_REQUIRED`. Run:

```powershell
wtagent login
```

Then retry.

### Pro unavailable

Retry the same call with:

```powershell
-Mode High
```

### Approval required

JSON/one-shot mode is intentionally non-interactive. If WTAgent requests a tool requiring manual approval, it may return `APPROVAL_REQUIRED` rather than wait for input.

For Architect/Verifier use, approval-requiring operations are suspicious anyway: the role should normally remain read-oriented.

### WTAgent changed files

Stop and inspect:

```powershell
git status --short
git diff
```

Do not silently accept or automatically revert the mutation because it may overlap with pre-existing Codex changes.

## 9. Example Codex task

User asks Codex:

```text
Investigate and fix the calibration discontinuity. Preserve raw-mode behavior and add regression coverage.
```

With this repo's `AGENTS.md`, Codex should approximately do:

```powershell
# 1. Independent architecture pass
pwsh -File ./scripts/codex-wtagent.ps1 `
  -Phase plan `
  -Mode Pro `
  -Task "Investigate and fix the calibration discontinuity. Preserve raw-mode behavior and add regression coverage."

# 2. Codex independently inspects and edits repository
# ... read/search/edit/build/test ...

# 3. Independent verification
pwsh -File ./scripts/codex-wtagent.ps1 `
  -Phase review `
  -Mode Pro `
  -Task "Investigate and fix the calibration discontinuity. Preserve raw-mode behavior and add regression coverage." `
  -Acceptance "Calibration transition is continuous; raw-mode behavior is unchanged; regression tests cover the boundary; existing tests pass."
```

If the Verifier reports confirmed blockers, Codex fixes only those supported by evidence, reruns affected tests, and performs one final review.

## 10. Relationship to the OpenCode adapter

OpenCode integration:

```text
OpenCode custom Tool -> examples/opencode/wtagent.ts -> WTAgent
```

Codex integration:

```text
Codex shell -> scripts/codex-wtagent.ps1 -> WTAgent
```

Both routes reach the same WTAgent machine interface:

```text
wtagent --once --json --mode <MODE> -C <PROJECT> <TASK>
```

The difference is only the host agent's extension mechanism.

## 11. Future hardening

High-value next steps for this fork:

1. add a WTAgent-native `--read-only` / `--policy read-only` mode;
2. reject `fs.write`, `fs.edit`, write-capable terminal commands, and persistent processes before execution;
3. optionally emit a structured verdict schema for `plan` / `review` consumers;
4. optionally package the orchestration as a reusable Codex Skill after the workflow stabilizes;
5. add automated tests proving reviewer mode cannot mutate the project.
