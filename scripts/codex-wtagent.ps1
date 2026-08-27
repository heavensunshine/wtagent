[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('plan', 'review')]
    [string]$Phase,

    [Parameter(Mandatory = $true)]
    [string]$Task,

    [string]$Acceptance = '',

    [ValidateSet('Instant', 'Medium', 'High', 'Pro', 'Current')]
    [string]$Mode = 'Pro',

    [string]$Project = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-WorktreeFingerprint {
    param([Parameter(Mandatory = $true)][string]$Root)

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        return $null
    }

    $inside = & git -C $Root rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0 -or ($inside -join '').Trim() -ne 'true') {
        return $null
    }

    $status = & git -C $Root status --porcelain=v1 --untracked-files=all 2>$null
    $diff = & git -C $Root diff --no-ext-diff --binary HEAD -- . 2>$null

    $payload = @(
        '---STATUS---'
        ($status -join "`n")
        '---DIFF---'
        ($diff -join "`n")
    ) -join "`n"

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Build-Prompt {
    param(
        [Parameter(Mandatory = $true)][string]$RequestedPhase,
        [Parameter(Mandatory = $true)][string]$OriginalTask,
        [string]$AcceptanceCriteria
    )

    if ($RequestedPhase -eq 'plan') {
        return @"
Act as the independent high-reasoning ARCHITECT for a Codex implementation task.

Original task:
$OriginalTask

Inspect the current local repository/worktree yourself through WTAgent tools.
Do not modify, create, delete, rename, stage, commit, push, merge, publish, or otherwise mutate files or repository state.
Do not run destructive commands.

Return a concise but concrete implementation plan with these sections:
1. CONFIRMED CURRENT STATE
2. RELEVANT FILES / FUNCTIONS / SUBSYSTEMS
3. ROOT-CAUSE HYPOTHESES AND UNCERTAINTIES
4. IMPLEMENTATION PLAN (ordered)
5. INVARIANTS / MUST-NOT-CHANGE
6. TEST / VERIFICATION PLAN
7. ACCEPTANCE CRITERIA
8. RISKS / OPEN QUESTIONS

Rules:
- Separate confirmed evidence from hypotheses.
- Prefer repository evidence over assumptions.
- Do not implement the change.
- Do not claim a file was inspected unless you actually inspected it.
- Make the plan useful to a separate Codex executor that will independently verify it.
"@
    }

    $acceptanceBlock = if ([string]::IsNullOrWhiteSpace($AcceptanceCriteria)) {
        '(No explicit acceptance criteria supplied. Derive them conservatively from the original task and repository behavior.)'
    }
    else {
        $AcceptanceCriteria
    }

    return @"
Act as the independent high-reasoning VERIFIER for a Codex implementation task.

Original task:
$OriginalTask

Acceptance criteria:
$acceptanceBlock

Independently inspect the CURRENT LOCAL WORKTREE through WTAgent tools. Treat local uncommitted changes as the source of truth. Inspect relevant code, git diff/status, tests, and available build/test evidence yourself.

Do not modify, create, delete, rename, stage, commit, push, merge, publish, or otherwise mutate files or repository state.
Do not run destructive commands.

Review for:
- correctness against the original task;
- regressions and incomplete fixes;
- edge cases and error handling;
- architecture/protocol/API compatibility;
- concurrency/security/data-integrity issues when relevant;
- accidental unrelated changes;
- missing or weak tests;
- claims not supported by repository evidence.

Do NOT assume the implementation is correct because Codex produced it. Do not rely on Codex's self-summary; inspect the worktree independently.

Return exactly one top-level verdict:

PASS
- followed by a short evidence summary and any non-blocking observations;

or

BLOCKERS
- followed by numbered, concrete, evidence-backed blockers with file paths/locations where useful.

Clearly distinguish confirmed defects from hypotheses. Do not invent findings just to avoid PASS.
"@
}

$resolvedProject = (Resolve-Path -LiteralPath $Project).Path

$wtagentCommand = Get-Command wtagent -ErrorAction SilentlyContinue
if (-not $wtagentCommand) {
    throw 'wtagent was not found on PATH. Install it and run `wtagent login` first.'
}

$before = Get-WorktreeFingerprint -Root $resolvedProject
$prompt = Build-Prompt -RequestedPhase $Phase -OriginalTask $Task -AcceptanceCriteria $Acceptance
$stderrFile = [System.IO.Path]::GetTempFileName()

try {
    $stdout = & wtagent --once --json --mode $Mode -C $resolvedProject $prompt 2>$stderrFile
    $exitCode = $LASTEXITCODE
    $stderr = Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue

    if ($exitCode -ne 0 -and [string]::IsNullOrWhiteSpace(($stdout -join "`n"))) {
        throw "WTAgent exited with code $exitCode.`n$stderr"
    }

    $jsonText = ($stdout -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($jsonText)) {
        throw "WTAgent returned no JSON.`n$stderr"
    }

    try {
        $payload = $jsonText | ConvertFrom-Json -Depth 32
    }
    catch {
        throw "WTAgent returned invalid JSON.`nSTDOUT:`n$jsonText`nSTDERR:`n$stderr"
    }

    if ($payload.status -eq 'error') {
        $details = if ($null -ne $payload.error.details) {
            $payload.error.details | ConvertTo-Json -Depth 12
        }
        else {
            ''
        }
        throw "WTAgent $($payload.error.code): $($payload.error.message)`n$details`n$stderr"
    }

    if ($payload.status -ne 'completed') {
        throw "Unexpected WTAgent status: $($payload.status)"
    }

    $after = Get-WorktreeFingerprint -Root $resolvedProject
    $unchanged = ($null -eq $before -or $null -eq $after -or $before -eq $after)

    if (-not $unchanged) {
        throw @"
WTAgent violated the read-only Architect/Verifier contract: the Git worktree changed during the call.
Inspect `git status` and `git diff` before continuing. Do not silently accept or automatically revert the change.
"@
    }

    [pscustomobject]@{
        phase = $Phase
        mode = $Mode
        status = 'completed'
        sessionId = $payload.sessionId
        projectRoot = $payload.projectRoot
        worktreeUnchanged = $unchanged
        result = $payload.result
    } | ConvertTo-Json -Depth 16
}
finally {
    Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
}
