# Original WTAgent vs OpenCode demo vs Codex orchestration

This document compares three execution models:

1. upstream WTAgent as a standalone local coding agent;
2. the upstream OpenCode custom-tool demo;
3. this fork's Codex Architect -> Executor -> Verifier workflow.

The fork does **not** replace WTAgent's core Runtime. It adds an orchestration layer that changes role assignment, when WTAgent is called, and who is expected to modify the repository.

## 1. High-level execution models

### 1.1 Upstream WTAgent

```text
User
  -> WTAgent + ChatGPT Web
  -> reason about task
  -> request local tools when needed
  -> WTAgent Runtime executes local operations
     - filesystem reads
     - filesystem writes/edits
     - searches
     - terminal/process commands
  -> tool results return to ChatGPT Web
  -> ChatGPT continues reasoning
  -> final answer
```

The key property is that **one Web model can own the task end-to-end**. It can reason, inspect local files, modify the worktree, run commands, verify results, and finish the task through the same WTAgent session.

Conceptually:

```text
High reasoning model -> High reasoning model -> High reasoning model
        plan                 execute                 verify
```

The planning/execution/verification roles may exist internally, but they are not separated into independent agents.

---

### 1.2 Upstream OpenCode demo

The upstream `opencode-call-wtagent-demo.ts` turns WTAgent into a custom OpenCode tool.

```text
OpenCode main agent
   |
   +-- normal OpenCode work
   |
   +-- call WTAgent when an independent second opinion is useful
          |
          v
     ChatGPT Web reviewer
          |
          v
     findings returned to OpenCode
```

The demo already establishes several important principles:

- WTAgent acts as an independent reviewer;
- WTAgent should inspect the project itself rather than trust conclusions from the calling agent;
- the local worktree is the source of truth for uncommitted changes and runtime behavior;
- remote GitHub content is supplementary;
- the reviewer is instructed not to modify the repository.

However, the demo does **not** define a mandatory three-stage lifecycle. OpenCode decides when to call the reviewer and what to do with the result.

Conceptually:

```text
Executor / main agent -> High-reasoning reviewer
```

---

### 1.3 Codex workflow in this fork

This fork makes the role separation explicit:

```text
                    USER TASK
                        |
                        v
             WTAgent Pro / High
                  ARCHITECT
                        |
             plan + invariants +
             acceptance criteria
                        |
                        v
                      CODEX
                   EXECUTOR
                        |
          edit + build + test + diff
                        |
                        v
             WTAgent Pro / High
                  VERIFIER
                        |
                 PASS / BLOCKERS
                  |          |
                PASS      BLOCKERS
                  |          |
                  v          +--> Codex fixes
                 DONE              |
                                   +--> verify again
```

Conceptually:

```text
High Architect -> Codex Executor -> High Verifier
```

The expensive/high-reasoning stages are used for deciding **what should be done** and **whether it is actually complete**, while Codex owns the mechanical implementation loop.

## 2. Comparison matrix

| Dimension | Upstream WTAgent | Upstream OpenCode demo | Codex workflow in this fork |
|---|---|---|---|
| Core WTAgent Runtime | WTAgent | WTAgent | Same WTAgent Runtime |
| Primary controller | WTAgent session | OpenCode | Codex |
| Web model role | full agent | independent reviewer / analyst | Architect and Verifier |
| Who is expected to write code | WTAgent | OpenCode main agent | Codex |
| Explicit planning phase | no separate agent | not required | yes, independent Architect |
| Explicit acceptance criteria | optional / implicit | not standardized | Architect must define them |
| Explicit final verification | same agent may verify itself | optional reviewer call | independent Verifier required for non-trivial tasks |
| Reviewer independence | none by default | yes | yes, stronger separation |
| Local worktree source of truth | yes | yes | yes |
| Machine interface | `--once --json` available | used by custom tool | used by PowerShell wrapper |
| Pro mode | WTAgent CLI can request it | upstream demo schema omits it | wrapper accepts Pro, High fallback |
| Failure loop | same session continues | caller decides | BLOCKERS -> Codex fix -> verify again |
| Role policy entrypoint | none | OpenCode tool description | repository `AGENTS.md` |
| Read-only reviewer enforcement | none | prompt only | prompt + worktree-change detection |
| Hard read-only sandbox | no | no | no, still future work |

## 3. The largest architectural difference: who owns control

### Upstream WTAgent owns control

For a task such as "fix this bug", WTAgent may perform the whole sequence itself:

```text
inspect
  -> reason
  -> edit
  -> test
  -> debug
  -> edit again
  -> finish
```

It is therefore a complete local coding agent.

### The fork makes Codex the controller

WTAgent is deliberately narrowed into two advisory/audit roles:

```text
Architect = decides what evidence, constraints, plan, and acceptance criteria matter
Verifier  = independently decides whether the current worktree satisfies them
```

Codex remains the implementation authority:

```text
Architect advice
      |
      v
Codex independently verifies the advice
      |
      v
Codex modifies / builds / tests
      |
      v
Verifier independently audits the resulting worktree
```

This reduces the chance that one model's initial assumption contaminates both implementation and final review.

## 4. What is inherited from the upstream OpenCode demo

The Codex workflow intentionally preserves several strong ideas from the upstream OpenCode adapter.

### 4.1 Independent inspection

The reviewer should inspect the repository/worktree itself instead of relying on a summary from the calling agent.

The Codex workflow strengthens this by explicitly telling the final Verifier not to rely on Codex's self-justification.

### 4.2 Local worktree is authoritative

Committed GitHub content may be useful background, but the current local worktree is authoritative for:

- uncommitted changes;
- generated files;
- local `git diff`;
- build/test state;
- runtime behavior.

This is essential when Codex is actively editing code that has not been committed yet.

### 4.3 Machine-readable WTAgent interface

The fork does not invent another transport protocol. It reuses:

```text
wtagent --once --json --mode <MODE> -C <project> <task>
```

WTAgent returns its normal machine envelope, and the Codex wrapper converts that into a stable PowerShell JSON result.

## 5. What the Codex workflow adds

### 5.1 Independent Architect phase

Before implementation, the Architect is asked to produce:

1. confirmed current state;
2. relevant files/functions/subsystems;
3. root-cause hypotheses and uncertainties;
4. ordered implementation plan;
5. invariants / must-not-change behavior;
6. test / verification plan;
7. acceptance criteria;
8. risks / open questions.

The Architect is advisory. Codex must still verify repository claims before changing code.

### 5.2 Explicit acceptance contract

The workflow turns "looks fixed" into an explicit contract:

```text
Original task
    +
Architect acceptance criteria
    +
current local worktree
    +
build/test evidence
    -> Verifier verdict
```

The final result is expected to be either:

```text
PASS
```

or:

```text
BLOCKERS
1. concrete defect ...
2. concrete defect ...
```

### 5.3 Controlled remediation loop

A blocker does not automatically restart the whole task from scratch:

```text
BLOCKERS
   -> Codex fixes confirmed blockers
   -> rerun affected tests
   -> one more independent verification pass
```

The workflow explicitly discourages an unbounded reviewer loop. Persistent disagreement should be surfaced with evidence instead of burning repeated high-reasoning calls.

### 5.4 Selective escalation

The full workflow is intended for non-trivial work, not every edit.

Typical triggers include:

- multiple files/subsystems;
- uncertain root cause;
- meaningful regression risk;
- architecture/protocol/security/concurrency/data-integrity work;
- reverse engineering or evidence closure;
- explicit request for independent review.

Trivial typo/formatting/mechanical edits can remain Codex-only.

### 5.5 Worktree mutation detection

The current wrapper computes a Git worktree fingerprint before and after WTAgent Architect/Verifier calls.

```text
fingerprint(before)
        |
        v
     WTAgent
        |
        v
fingerprint(after)
        |
   equal?
   /   \
 yes    no
  |      |
accept  fail workflow
```

The fingerprint uses `git status --porcelain` plus a binary-capable `git diff` and hashes the resulting state.

This does **not** make WTAgent read-only. It makes a violation detectable so Codex does not silently accept a reviewer that modified the worktree.

## 6. Security boundary: current state

The most important limitation remains unchanged at the WTAgent Runtime level.

The Architect/Verifier prompts say not to modify the project, but WTAgent's normal ToolRegistry still contains write/exec-capable operations such as filesystem writes/edits and command execution.

Therefore the current fork provides:

```text
prompt-level read-only intent
        +
post-call mutation detection
```

It does **not** yet provide:

```text
hard runtime read-only enforcement
```

A future stronger design would add a reviewer-specific Runtime policy, for example:

```text
wtagent --read-only
```

or:

```text
wtagent --policy reviewer
```

with a restricted registry such as:

```text
allowed:
  fs.list
  fs.read
  fs.search
  repo.inspect
  safe git/status/diff/log inspection

denied/not registered:
  fs.write
  fs.edit
  process.start
  destructive or mutating terminal operations
```

That future change would close the permission boundary rather than merely detect violations afterward.

## 7. Why keep WTAgent core mostly upstream-compatible

This fork currently favors an external orchestration layer instead of deep Runtime changes.

Fork-specific behavior mainly lives in:

```text
AGENTS.md
scripts/codex-wtagent.ps1
docs/codex-wtagent-workflow.md
docs/opencode-integration.md
docs/original-vs-codex-workflow.md
examples/opencode/wtagent.ts
FORK_NOTES.md
```

The upstream WTAgent implementation remains mostly intact.

Benefits:

- easier upstream synchronization;
- fewer merge/rebase conflicts;
- orchestration can evolve independently;
- OpenCode and Codex integrations can share the same WTAgent Runtime;
- future hard read-only work can be isolated as a deliberate Runtime change instead of being mixed with orchestration changes.

## 8. Summary

The three models can be summarized as:

```text
Upstream WTAgent
  one strong agent owns planning + execution + verification

Upstream OpenCode demo
  main agent + optional independent high-reasoning reviewer

Codex workflow in this fork
  independent high-reasoning Architect
      -> Codex Executor
      -> independent high-reasoning Verifier
      -> blocker repair loop when needed
```

The next major research item is **hard reviewer read-only enforcement** inside WTAgent itself. Until that is implemented, Architect/Verifier read-only behavior remains a workflow contract plus worktree mutation detection, not a true sandbox.
