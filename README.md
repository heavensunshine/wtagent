# WTAgent

Use GPT Web as a local CLI agent.

WTAgent connects GPT Web to your local project: GPT reasons in the browser while WTAgent reads and writes local files and runs commands on your machine.

[中文](#中文)

## Quick start

Requires Node.js 20.17+ and Chrome/Chromium. WTAgent supports macOS, Linux, native Windows, and WSL with WSLg or another Linux graphical display.

On WSL, install the Linux Chrome/Chromium package inside the distribution and launch WTAgent from WSL. WTAgent keeps file and command execution in the WSL environment and connects to that Linux browser over local CDP. Windows-host Chrome is not supported from WSL yet.

```bash
npm install -g wtagent
```

Open a working directory and start WTAgent:

```bash
mkdir wtagent-demo
cd wtagent-demo
wtagent
```

Choose `Instant`, `Medium`, `High`, or `Current`, then type a task. `Current` keeps the mode already selected in ChatGPT Web.

```text
$ wtagent
you › Create hello.js that writes "Hello from WTAgent" to hello.txt. Run it with Node.js and verify the result.
```

WTAgent creates the files in the current directory, runs the script locally, and checks its output. You can continue chatting in the same terminal after the task finishes.

If ChatGPT is not signed in, WTAgent opens its dedicated Chrome profile and asks you to sign in. Your task continues automatically after login.

No OpenAI API key or ChatGPT Pro subscription is required. WTAgent uses your own ChatGPT Web account, available models, and quota. The interactive picker exposes the reasoning levels available to ChatGPT Plus users; existing Pro users can still request `--mode Pro` explicitly when that option is available on their account.

You can also provide the first task directly:

```bash
wtagent "create hello.js, run it, and verify the output"
```

Select a mode explicitly for non-interactive runs:

```bash
wtagent --once --mode High -C ./project "review this implementation"
```

For scripts and other agents, combine `--once` with `--json` to emit exactly one machine-readable JSON object on stdout:

```bash
wtagent --once --json --mode High -C ./project "review this implementation without changing files"
```

Successful runs return a stable envelope:

```json
{"schemaVersion":1,"status":"completed","sessionId":"session_...","result":"...","projectRoot":"/path/to/project"}
```

Human-readable progress is written to stderr in JSON mode. The mode is intentionally non-interactive: run `wtagent login` first. If authentication is missing, WTAgent returns `AUTH_REQUIRED`; if a tool requires manual approval, it returns `APPROVAL_REQUIRED` instead of waiting for input.

Multiline paste and `↑` / `↓` input history are supported. Press `Ctrl+C` or `Ctrl+D` to exit.

## Agent integrations in this fork

This fork includes ready-to-use integration patterns for external coding agents.

### Codex: Architect → Executor → Verifier

Codex remains the repository-writing Executor. WTAgent + ChatGPT Web can be used as an independent high-reasoning Architect before implementation and Verifier after tests.

```text
WTAgent High/Pro planning
        ↓
Codex implementation + tests
        ↓
WTAgent High/Pro independent review
```

Files:

- [`AGENTS.md`](./AGENTS.md) — persistent Codex orchestration rules.
- [`scripts/codex-wtagent.ps1`](./scripts/codex-wtagent.ps1) — PowerShell `plan` / `review` machine wrapper.
- [`docs/codex-wtagent-workflow.md`](./docs/codex-wtagent-workflow.md) — full workflow, failure handling, review loop, and safety notes.
- [`docs/original-vs-codex-workflow.md`](./docs/original-vs-codex-workflow.md) — comparison of upstream WTAgent, the upstream OpenCode demo, and this fork's Codex orchestration.

Example:

```powershell
pwsh -File ./scripts/codex-wtagent.ps1 -Phase plan -Mode Pro -Task "<task>"
# Codex implements and tests
pwsh -File ./scripts/codex-wtagent.ps1 -Phase review -Mode Pro -Task "<task>" -Acceptance "<criteria>"
```

The wrapper checks the Git worktree before and after the Architect/Verifier call and fails if WTAgent unexpectedly changes it. This detects a read-only contract violation but is not a hard filesystem sandbox.

### OpenCode custom tool

- [`docs/opencode-integration.md`](./docs/opencode-integration.md) — detailed OpenCode call chain.
- [`examples/opencode/wtagent.ts`](./examples/opencode/wtagent.ts) — OpenCode custom tool example with `Pro` mode support.

## 中文

WTAgent 将 GPT 网页聊天连接到本地项目：GPT 在浏览器中思考，WTAgent 在你的电脑上读写本地文件并运行命令。

### 快速开始

需要 Node.js 20.17+ 和 Chrome/Chromium。支持 macOS、Linux、原生 Windows，以及带 WSLg 或其他 Linux 图形显示环境的 WSL。

在 WSL 中使用时，需要在 WSL 发行版内部安装 Linux 版 Chrome/Chromium，并从 WSL 启动 WTAgent。文件读写和命令执行仍然发生在 WSL 环境中，WTAgent 通过本地 CDP 连接这个 Linux 浏览器。当前还不支持从 WSL 直接控制 Windows 主机上的 Chrome。

```bash
npm install -g wtagent
```

进入工作目录并启动：

```bash
mkdir wtagent-demo
cd wtagent-demo
wtagent
```

选择 `Instant`、`Medium`、`High` 或 `Current`，然后直接输入任务。`Current` 表示保持 ChatGPT Web 当前已选择的档位。

```text
$ wtagent
you › 创建 hello.js，将“Hello from WTAgent”写入 hello.txt。用 Node.js 运行并验证输出。
```

WTAgent 会在当前目录创建文件、运行本地脚本并检查输出。任务完成后，可以继续在同一个终端中对话。

如果尚未登录 ChatGPT，WTAgent 会打开专用 Chrome 并提示登录；登录成功后任务会自动继续。

无需 OpenAI API Key，也不要求 ChatGPT Pro。WTAgent 使用你自己的 ChatGPT 网页账号、可用模型和额度。默认交互选择器提供 ChatGPT Plus 可用的推理档位；已有 Pro 用户在账号可用时仍可以通过 `--mode Pro` 显式请求 Pro。

也可以在启动时直接附带第一个任务：

```bash
wtagent "创建 hello.js，运行并验证输出"
```

非交互运行可以显式指定档位：

```bash
wtagent --once --mode High -C ./project "审查当前实现"
```

脚本或其他 Agent 调用时，可以组合 `--once` 和 `--json`，让 stdout 只输出一个机器可解析的 JSON 对象：

```bash
wtagent --once --json --mode High -C ./project "审查当前实现，不要修改文件"
```

成功结果格式如下：

```json
{"schemaVersion":1,"status":"completed","sessionId":"session_...","result":"...","projectRoot":"/path/to/project"}
```

JSON 模式下，人类可读的进度信息写入 stderr。该模式刻意保持非交互：请先运行 `wtagent login`。如果登录状态缺失，WTAgent 返回 `AUTH_REQUIRED`；如果工具需要人工授权，则返回 `APPROVAL_REQUIRED`，而不是停下来等待输入。

支持多行粘贴和 `↑` / `↓` 输入历史。使用 `Ctrl+C` 或 `Ctrl+D` 退出。

### 本 fork 的 Codex / OpenCode 集成

Codex 三段式工作流：[`docs/codex-wtagent-workflow.md`](./docs/codex-wtagent-workflow.md)。

原版 WTAgent / OpenCode demo / Codex 三段式对比：[`docs/original-vs-codex-workflow.md`](./docs/original-vs-codex-workflow.md)。

Codex 持久规则：[`AGENTS.md`](./AGENTS.md)。

PowerShell 调用包装器：[`scripts/codex-wtagent.ps1`](./scripts/codex-wtagent.ps1)。

OpenCode 集成：[`docs/opencode-integration.md`](./docs/opencode-integration.md)。

## License

[MIT](./LICENSE)
