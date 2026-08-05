# Agent Deck

[English](./README.en.md) | **简体中文**

本地 Web 控制台，用于并排运行多个 AI 编码 Agent CLI（`claude`、`opencode`、`openclaw`、`hermes`、`codex`）和普通 shell 终端。真实 PTY 终端、刷新浏览器会话不丢、Persona 预设一键拉起、多标签 / 分屏布局。

## 安装

**环境要求**

- macOS、Linux 或 Windows 10 1809+ / Windows 11
- Node.js ≥ 18
- 至少安装并登录一个受支持的 Agent CLI，且在 PATH 中：`claude`、`opencode`、`openclaw`、`hermes` 或 `codex`。控制台会自动检测装了哪些，只显示实际存在的。
- **仅 Linux 需要：** `node-pty` 的 C/C++ 工具链（`build-essential` + `python3`）—— node-pty 为 macOS 和 Windows 提供预编译二进制，但不提供 Linux 的，因此 Linux 上需从源码编译。macOS 仅在触发编译时才需要 `xcode-select --install`。

**一键安装**

```bash
npm run setup
```

安装 `server/` 与 `web/` 依赖、按需修正 node-pty `spawn-helper` 可执行权限（macOS）、构建前端。

**启动**

```bash
# 生产模式：单端口同时提供 UI 与 WebSocket
npm start                   # http://127.0.0.1:4173

# 开发模式：Vite HMR + 后端热重载
npm run dev                 # http://127.0.0.1:5173
```

所有脚本都是纯 Node 实现，在 bash / zsh / cmd.exe / PowerShell 里行为一致。

环境变量：`PORT`（默认 4173）、`HOST`（默认 127.0.0.1）、`SCROLLBACK_BYTES`、`IDLE_AFTER_MS`、`CONTROL_APP_DATA`（personas.json 存放目录）、`REAP_EXITED_AFTER_MS`。

## 卸载

不写入任何全局位置，所有内容都在本目录内。

用 Ctrl-C 停掉服务，然后删掉整个目录即可。角色数据在 `data/personas.json`（若设置过 `CONTROL_APP_DATA` 则在该目录）。

如果还有残留进程占着端口：

```bash
# macOS / Linux
lsof -ti tcp:4173 -sTCP:LISTEN | xargs kill
```

```powershell
# Windows
netstat -ano | findstr :4173     # 最后一列是 PID
taskkill /PID <pid> /F
```

## 功能

- **多 CLI 实例** — `xterm.js` + `node-pty` + WebSocket，完整支持 ANSI 颜色与交互式 TUI。
- **会话持久化** — PTY 由后端长驻进程托管，保留 1 MiB 滚屏历史；刷新/断线后重新附着并回放完整历史。（后端重启会结束会话，见「进阶」。）
- **Persona 预设** — 保存系统提示词、模型、工作目录、环境变量、额外参数，快捷启动区一键拉起。
- **恢复历史会话** — 新建 Claude Code 会话时可从下拉列表挑一条该目录下的历史对话（按时间倒序，带首条提问摘要）继续；留空即新建空白会话。以 `--fork-session` 恢复，原记录不会被改写。
- **普通终端** — 「+ 终端」按钮打开 shell 页签（macOS/Linux 为登录 shell，Windows 为 PowerShell 或 `cmd.exe`），与 Agent 会话并排使用。
- **会话看板** — 侧边栏实时显示每个会话状态（启动中 / 运行中 / 处理中 / 空闲 / 已退出）；主区域支持标签或分屏，拖拽实时同步终端尺寸。
- **独立工作区** — 每个会话可指向不同项目目录。
- **自动检测 CLI** — 快捷启动只显示本机实际安装的 Agent CLI（`claude` / `opencode` / `openclaw` / `hermes` / `codex`），并通过登录 shell 的 PATH 解析，因此版本管理器和 `~/.local/bin` 下的安装也能找到。没装的不会出现。
- **Codex YOLO 模式** — 启动对话框中的可选勾选框，以 `--yolo` 启动 Codex。该参数是 `--dangerously-bypass-approvals-and-sandbox` 的未公开别名：跳过全部操作确认**并**关闭沙箱，Codex 可直接读写本机任意文件、执行命令、访问网络，全程不再询问。默认关闭，请仅在可信目录使用。常规启动的沙箱与审批策略仍由 `~/.codex/config.toml` 控制。
- **跨平台** — 支持 macOS、Linux 与 Windows。POSIX 上通过登录 shell 启动 CLI 以加载 PATH；Windows 上直接以 argv 数组启动（链路中没有 shell，也就不存在命令行引号转义问题）。

## 使用

1. 侧边栏**快捷启动**：每个检测到的 Agent CLI 一个按钮，加上各预设角色的 chip，以及 **+ 终端** 打开 shell 页签。未安装的 CLI 不会显示按钮，因此不会出现点了才在启动时失败的情况。
2. 启动对话框可覆盖工作目录 / 模型 / 标题，并可选择要恢复的历史会话（留空 = 新建空白会话）。
3. 主区域顶部切换「标签 / 分屏」；分屏下拖拽分隔条实时调整尺寸。
4. 侧边栏「**停止**」与页签「**×**」效果相同：终止 CLI 并关闭页签。已退出会话短暂保留后自动回收。
5. 刷新浏览器不会中断会话。

### Persona → CLI 参数映射

| 字段 | Claude Code | OpenCode | OpenClaw | Hermes | Codex |
|---|---|---|---|---|---|
| 工作目录 cwd | 进程 cwd | 进程 cwd（project 目录）| 进程 cwd | 进程 cwd | 进程 cwd |
| 模型 model | `--model` | `--model provider/model` | —（在 OpenClaw 配置里设置）| `-m` | `--model` |
| Agent | `--agent` | `--agent` | — | — | — |
| System Prompt | `--append-system-prompt` | `--append-system-prompt`（不支持则忽略）| — | — | — |
| 额外目录 addDirs | `--add-dir`（每项）| — | — | — | `--add-dir`（每项）|
| 环境变量 env | 注入进程环境 | 注入进程环境 | 注入 | 注入 | 注入 |
| 额外参数 extraArgs | 原样追加 | 原样追加 | 原样追加 | 原样追加 | 原样追加 |

只有 Claude Code 支持在控制台里**恢复历史会话**。Codex 自身有 `codex resume`，但那是读取 `~/.codex` 的子命令，与本控制台使用的 `--resume <id> --fork-session` 不是一回事，其存储格式控制台也不解析，因此恢复下拉框仍然只对 Claude Code 开放，不做无法兑现的承诺。

Codex 的沙箱与审批策略（`-s` / `--ask-for-approval`）交由你自己的 `~/.codex/config.toml` 决定；若要按会话覆盖，可在角色的**额外参数**里填写。唯一的例外是启动对话框里的 **YOLO** 勾选框，它会追加 `--yolo` 并同时覆盖这两项 —— 具体放弃了什么见上方功能列表。

角色数据保存在 `data/personas.json`，首次启动自动写入三个示例。

恢复会话**不是** Persona 字段：它指向某一次具体的历史对话，因此只在启动对话框里按次选择，对应 `--resume <session-id> --fork-session`（仅 Claude Code）。下拉列表直接读取 Claude Code 自己的记录目录 `~/.claude/projects/`（Windows 为 `%USERPROFILE%\.claude\projects`；可用 `CLAUDE_PROJECTS_DIR` 覆盖，或用 `CLAUDE_CONFIG_DIR` 整体迁移配置目录），按所选工作目录最多列出 `RESUME_LIST_LIMIT` 条（默认 30）。

## 排障：node-pty `posix_spawnp failed`

部分 macOS + 较新 npm 组合下，node-pty 的 `spawn-helper` 被安装为不可执行，导致 `pty.spawn()` 抛出 `Error: posix_spawnp failed`。`npm run setup` / `npm start` 已自动修复（`server/scripts/fix-node-pty.js`）。手动修复：

```bash
chmod +x server/node_modules/node-pty/prebuilds/<platform>/spawn-helper
```

Windows 与 Linux 不涉及此问题：Windows 用 ConPTY（`conpty.dll`，且没有可执行位概念），Linux 上 node-pty 直接调用 `forkpty(3)`，不生成该 helper。

### Windows：提示 `claude` 不在 PATH 中

Windows 上链路里没有 shell，无法靠它解析 `%PATHEXT%`，因此由 launcher 自己解析可执行文件。npm 安装出来的是 `claude.cmd`；若控制台报找不到，请先确认 `where claude` 能定位到，然后重启控制台以读取最新的 PATH。

## 架构

```
浏览器 (React + xterm.js)
  ├── REST  /api/*   ── 角色/会话的增删改查
  └── WS    /ws      ── attach / input / resize ↔ output / status / exit / sessions
        │
Node 后端 (Fastify + ws + node-pty)
  ├── httpRoutes ── personaStore (JSON 持久化) ── launcher (persona → argv/env/cwd)
  └── wsBridge ──── SessionManager ── PtySession { node-pty 子进程 + 1MiB 滚屏环形缓冲 }
        │
   claude / opencode / openclaw / hermes / codex CLI，或登录 shell
```

- **持久化** — PTY 是后端长驻进程的子进程，各自维护滚屏缓冲，重连时回放。后端重启会结束子进程（内存态注册表）。
- **启动方式（POSIX）** — `bash -lc 'exec <cli> …'`：登录 shell 加载用户 PATH，`exec` 让 PTY 直接变成 CLI 本身，信号 / 尺寸原样透传。所有 persona 值经 POSIX 单引号转义。普通终端直接拉起 `$SHELL -l`。
- **启动方式（Windows）** — 直接以 **argv 数组** 启动 CLI，链路中没有 shell，由 node-pty 按 Win32 `CommandLineToArgvW` 规则转义。POSIX 单引号在 Windows 上不只是"写错了"，而是完全不生效——若在那里拼命令行，这套转义反而会变成注入入口。可执行文件由 launcher 自行按 `PATH`/`PATHEXT` 解析，因为链路里没有别的环节会做这件事。
- **工作目录** — 工作目录是自由文本输入，且会直接作为 spawn 的 cwd，链路中没有 shell 帮忙做 `cd` 那样的归一化，因此先统一成磁盘上的真实写法。Windows 对同一路径的各种写法都照收（`d:\proj`、`D:/proj`、结尾多一个 `\`、大小写不符），但各家 agent CLI 是按路径**字符串**记录按项目的状态：以 `d:\proj` 启动时，Claude Code 会把早已信任的 `D:\proj` 当成新目录，会话一开始就卡在信任提示上，此时 `@文件` 引用无法解析。
- **信号** — Windows 没有 POSIX 信号，node-pty 传信号会直接抛异常，因此那里改为不带参数调用 `kill()`（关闭伪控制台），SIGTERM→SIGKILL 的升级逻辑仅在 POSIX 生效。
- **实时尺寸同步** — `ResizeObserver` + `xterm-addon-fit` 计算 cols/rows，经 WS `resize` 帧同步给 `node-pty`。

## 进阶：跨后端重启存活

把启动命令包一层可复用的多路复用器（需安装 `tmux` 或 `dtach`）：

```js
// launcher.js 中把 commandLine 改为：
// exec tmux new-session -A -s deck_<id> "<原命令>"
```

## 安全说明

- 仅绑定 `127.0.0.1`，**无鉴权** —— 这是本地开发者工具。任何能访问该端口的人都能以你的身份执行命令；如需网络暴露，请在前面加带认证的反向代理。
- POSIX 上 persona 值经单引号转义后再拼进 `bash -lc`；Windows 上根本不拼命令行（argv 数组），从源头消除了这一转义面。persona 的 `env` 会过滤能提前执行代码的危险键——`BASH_ENV` / `ENV` / `BASH_FUNC_*` / `LD_*` / `DYLD_*` / `PROMPT_COMMAND`，以及 Windows 的重定向键 `COMSPEC` / `PATHEXT` / `PSModulePath`——且按**大小写不敏感**匹配，因为 Windows 环境变量名本身不区分大小写，否则 `Bash_Env` 就能绕过。`extraArgs` 属操作者可信输入。
- 已退出会话在宽限期后自动回收（`REAP_EXITED_AFTER_MS`，默认 5 分钟）；慢 WebSocket 客户端触发背压（后端暂停读取对应 PTY），不做无限缓冲。

## 目录结构

```
agent-deck/
├── package.json            # 顶层脚本 (setup / dev / build / start)
├── scripts/                # setup.mjs / start.mjs / dev.mjs（跨平台 Node 脚本）
├── data/personas.json      # 角色预设（首启自动生成，不入库）
├── server/                 # 后端 (Fastify + ws + node-pty)
│   ├── src/{index,config,platform,launcher,claudeSessions,personaStore,PtySession,SessionManager,wsBridge,httpRoutes}.js
│   ├── test/                # 跨平台单测（伪造 process.platform）
│   └── scripts/fix-node-pty.js
└── web/                    # 前端 (React + Vite + xterm.js)
    └── src/{App,Sidebar,TerminalGrid,TerminalView,LaunchDialog,PersonaEditor,wsClient,api}.jsx|js
```
