# Codex workflow for this repository

Use Codex as the **Executor** and WTAgent + ChatGPT Web as an independent high-reasoning **Architect / Verifier** for non-trivial work.

Detailed workflow: `docs/codex-wtagent-workflow.md`.

## When to use the full workflow

Use Architect -> Executor -> Verifier when the task is non-trivial, including any of:

- multiple files or subsystems may change;
- the root cause is uncertain;
- regression risk is meaningful;
- architecture, security, concurrency, compatibility, protocol, or data integrity is involved;
- reverse engineering or evidence closure is involved;
- the user explicitly asks for independent planning/review;
- a change is difficult enough that a second independent reasoning pass is valuable.

Do not invoke WTAgent for trivial typo, formatting, or obviously local mechanical edits unless requested.

## Phase 1: Architect

Before implementation, call:

```powershell
pwsh -File ./scripts/codex-wtagent.ps1 -Phase plan -Mode Pro -Task "<original user task>"
```

If Pro is unavailable, retry with `-Mode High`.

Use the returned plan as independent advice, not unquestionable truth. Verify claims against the repository before modifying code.

The Architect must define:

- confirmed current behavior/evidence;
- relevant files/functions/subsystems;
- likely root causes or uncertainties;
- implementation sequence;
- invariants / things that must not change;
- tests and explicit acceptance criteria.

## Phase 2: Executor

Codex is the only intended writer in this workflow.

- Inspect the repository yourself.
- Reconcile the Architect plan with local evidence.
- Make the smallest correct implementation.
- Run relevant tests/builds/checks.
- Inspect `git diff` and remove unrelated changes.
- Do not claim completion from the plan alone.

## Phase 3: Verifier

After implementation and local tests, call:

```powershell
pwsh -File ./scripts/codex-wtagent.ps1 -Phase review -Mode Pro -Task "<original user task>" -Acceptance "<acceptance criteria>"
```

If Pro is unavailable, retry with `-Mode High`.

The Verifier must independently inspect the current local worktree. Do not feed it Codex's self-justification or tell it that the implementation is correct.

Expected verdict:

- `PASS` when no confirmed blocker remains; or
- `BLOCKERS` with concrete, evidence-backed defects.

If confirmed blockers are returned, fix them, rerun affected tests, then run one more verifier pass. Avoid unbounded review loops; after repeated disagreement, surface the evidence and unresolved point to the user.

## Failure handling

If `wtagent` is unavailable, authentication is missing, Pro/High is unavailable, or the wrapper reports that WTAgent changed the worktree:

- do not pretend the independent pass succeeded;
- continue with Codex only when useful;
- report that the external Architect/Verifier step could not be completed.

## Safety boundary

WTAgent's reviewer role is currently a prompt-level read-only contract, not an OS-enforced read-only sandbox. The wrapper fingerprints the Git worktree before and after the call and fails if it detects a change. Treat any such change as a workflow violation and inspect/revert it deliberately rather than silently continuing.
