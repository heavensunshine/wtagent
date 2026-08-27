// OpenCode custom tool example for WTAgent.
// Install globally as: ~/.config/opencode/tools/wtagent.ts
// Or project-scoped as: <project>/.opencode/tools/wtagent.ts

import { tool } from "@opencode-ai/plugin"

type WTAgentMode =
  | "Instant"
  | "Medium"
  | "High"
  | "Pro"
  | "Current"

type WTAgentSuccess = {
  schemaVersion: number
  status: "completed"
  sessionId: string
  result: string
  projectRoot: string
}

type WTAgentFailure = {
  schemaVersion: number
  status: "error"
  error: {
    code: string
    message: string
    details?: unknown
  }
}

type WTAgentResponse = WTAgentSuccess | WTAgentFailure

type RepositoryContext = {
  remote: string | null
  repositoryUrl: string | null
  branch: string | null
  head: string | null
  dirty: boolean
}

const TIMEOUT_MS = 30 * 60 * 1000

async function runGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, _stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode !== 0) return null

    const value = stdout.trim()
    return value || null
  } catch {
    return null
  }
}

function normalizeGitHubRemote(remote: string | null): string | null {
  if (!remote) return null

  const ssh = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/)
  if (ssh) return `https://github.com/${ssh[1]}`

  const sshUrl = remote.match(/^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/)
  if (sshUrl) return `https://github.com/${sshUrl[1]}`

  if (remote.startsWith("https://github.com/")) {
    return remote.replace(/\.git$/, "")
  }

  if (remote.startsWith("http://github.com/")) {
    return remote
      .replace(/^http:\/\/github\.com\//, "https://github.com/")
      .replace(/\.git$/, "")
  }

  return remote.replace(/\.git$/, "")
}

async function collectRepositoryContext(cwd: string): Promise<RepositoryContext> {
  const [remote, branch, head, status] = await Promise.all([
    runGit(["remote", "get-url", "origin"], cwd),
    runGit(["branch", "--show-current"], cwd),
    runGit(["rev-parse", "HEAD"], cwd),
    runGit(["status", "--porcelain"], cwd),
  ])

  return {
    remote,
    repositoryUrl: normalizeGitHubRemote(remote),
    branch,
    head,
    dirty: Boolean(status),
  }
}

function buildRepositoryPrompt(repo: RepositoryContext) {
  const lines = ["Repository context:"]

  lines.push(
    repo.repositoryUrl
      ? `- Repository: ${repo.repositoryUrl}`
      : "- Repository: not detected",
  )

  lines.push(
    repo.branch
      ? `- Local branch: ${repo.branch}`
      : "- Local branch: detached or unknown",
  )

  if (repo.head) lines.push(`- Local HEAD: ${repo.head}`)

  lines.push(
    `- Local worktree has uncommitted changes: ${repo.dirty ? "yes" : "no"}`,
  )

  return lines.join("\n")
}

function formatProcessError(
  message: string,
  {
    exitCode,
    stderr,
    stdout,
  }: {
    exitCode?: number
    stderr?: string
    stdout?: string
  } = {},
) {
  const parts = [message]

  if (exitCode !== undefined) parts.push(`exitCode=${exitCode}`)
  if (stderr?.trim()) parts.push(`stderr:\n${stderr.trim()}`)
  if (stdout?.trim()) parts.push(`stdout:\n${stdout.trim()}`)

  return parts.join("\n\n")
}

export default tool({
  description:
    "Delegate an independent code review or analysis task to ChatGPT Web through WTAgent. " +
    "WTAgent can inspect the current project itself, so normally call this tool directly " +
    "without pre-reading or summarizing the project first. " +
    "Use it for independent code review, debugging, regression analysis, architecture review, " +
    "security analysis, test failure investigation, and second opinions. " +
    "WTAgent acts as a read-only reviewer and must not modify the project.",

  args: {
    task: tool.schema
      .string()
      .min(1)
      .describe(
        "The independent review, debugging, architecture, security, or analysis task to delegate to WTAgent.",
      ),

    mode: tool.schema
      .enum(["Instant", "Medium", "High", "Pro", "Current"])
      .default("High")
      .describe(
        "ChatGPT reasoning mode. " +
        "Use High/Pro for difficult review and debugging when available; " +
        "Medium for normal analysis; Instant for quick checks; " +
        "Current to preserve the current ChatGPT Web setting.",
      ),
  },

  async execute(args, context) {
    const mode = args.mode as WTAgentMode
    const repo = await collectRepositoryContext(context.directory)
    const repositoryContext = buildRepositoryPrompt(repo)

    const delegatedTask = [
      args.task.trim(),
      "",
      repositoryContext,
      "",
      "Review strategy:",
      "- Act as an independent reviewer.",
      "- Inspect the project yourself instead of relying on conclusions from the calling agent.",
      repo.repositoryUrl
        ? "- If ChatGPT's connected GitHub integration can access the repository above, use it to efficiently understand committed source code, documentation, repository structure, and related implementations."
        : "- No GitHub repository was detected; inspect the local project through WTAgent tools.",
      "- Treat the local WTAgent worktree as the source of truth for uncommitted changes and runtime behavior.",
      "- Use local tools for git diff, uncommitted files, generated files, tests, commands, and anything that may differ from the remote repository.",
      "- If remote GitHub content and the local worktree differ, prefer the local worktree for the current review.",
      "",
      "Safety constraints:",
      "- Do not modify files.",
      "- Do not create files.",
      "- Do not delete files.",
      "- Do not run destructive commands.",
      "- Do not commit.",
      "- Do not push.",
      "- Do not merge.",
      "- Do not publish.",
      "",
      "Review quality:",
      "- Focus on concrete findings rather than generic advice.",
      "- Prefer correctness, regressions, error handling, edge cases, security, concurrency, compatibility, and test coverage issues.",
      "- Cite relevant file paths and code locations when useful.",
      "- Distinguish confirmed findings from hypotheses.",
      "- Avoid inventing issues merely to produce findings.",
      "- Return the final findings to the calling OpenCode agent.",
    ].join("\n")

    const command = [
      "wtagent",
      "--once",
      "--json",
      "--mode",
      mode,
      "-C",
      context.directory,
      delegatedTask,
    ]

    const proc = Bun.spawn(command, {
      cwd: context.directory,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    })

    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      try {
        proc.kill()
      } catch {
        // Process may already have exited.
      }
    }, TIMEOUT_MS)

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      if (timedOut) {
        throw new Error(
          formatProcessError(
            `WTAgent timed out after ${Math.round(TIMEOUT_MS / 60_000)} minutes.`,
            { exitCode, stderr, stdout },
          ),
        )
      }

      const json = stdout.trim()

      if (!json) {
        throw new Error(
          formatProcessError("WTAgent returned no JSON result.", {
            exitCode,
            stderr,
          }),
        )
      }

      let payload: WTAgentResponse
      try {
        payload = JSON.parse(json) as WTAgentResponse
      } catch {
        throw new Error(
          formatProcessError("WTAgent returned invalid JSON.", {
            exitCode,
            stderr,
            stdout,
          }),
        )
      }

      if (payload.status === "error") {
        const parts = [`WTAgent ${payload.error.code}: ${payload.error.message}`]

        if (payload.error.details !== undefined) {
          parts.push(`Details: ${JSON.stringify(payload.error.details, null, 2)}`)
        }

        if (stderr.trim()) {
          parts.push(`WTAgent progress:\n${stderr.trim()}`)
        }

        throw new Error(parts.join("\n\n"))
      }

      if (exitCode !== 0) {
        throw new Error(
          formatProcessError(
            "WTAgent returned a completed result but exited unsuccessfully.",
            { exitCode, stderr, stdout },
          ),
        )
      }

      return [
        "WTAgent independent review",
        `Mode: ${mode}`,
        repo.repositoryUrl
          ? `Repository: ${repo.repositoryUrl}`
          : "Repository: not detected",
        repo.branch ? `Branch: ${repo.branch}` : "Branch: unknown",
        repo.head ? `HEAD: ${repo.head}` : "HEAD: unknown",
        `Local changes: ${repo.dirty ? "yes" : "no"}`,
        `WTAgent session: ${payload.sessionId}`,
        `Project: ${payload.projectRoot}`,
        "",
        payload.result,
      ].join("\n")
    } finally {
      clearTimeout(timeout)
    }
  },
})
