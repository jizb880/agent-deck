# Agent Deck

[English](./README.md) | **简体中文**

一个本地运行的 Web 控制台，用于**并排运行和调度多个 AI 编码 Agent CLI（`claude` / `opencode`）以及普通 shell 终端**：真实 PTY 终端、会话持久化（刷新/关闭浏览器后进程仍在后台运行并可重新附着）、角色 (Persona) 预设一键拉起、侧边栏 + 多标签/分屏界面。

---

## 功能一览

- **多 CLI 实例驱动** — `xterm.js`（前端）+ `node-pty`（后端）+ WebSocket 实时双向通信，完整支持 ANSI 颜色与交互式菜单。
- **进程持久化 / 重新附着** — 每个 PTY 会话由后端长驻进程托管，并保留最近 1 MiB 滚屏历史；浏览器刷新或断线后自动 `attach` 并重绘完整终端历史。
- **角色 / Persona 系统** — 在 UI 中配置并保存「重构专家 / 安全审计员 / 文档撰写员」等预设，含系统提示词、模型、工作目录、环境变量、额外参数；快捷启动区点角色名一键拉起。
- **普通终端** — 「+ 终端」按钮一键在右侧打开登录 shell 页签，与 Agent 会话并排使用。
- **多任务看板** — 侧边栏实时显示所有会话状态（启动中 / 运行中 / 处理中 / 空闲 / 已退出）与类型；主区域支持标签切换与分屏平铺，拖拽分隔条实时同步终端尺寸。
- **工作区切换** — 每个会话可关联不同本地项目路径。

---

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
   claude CLI / opencode CLI / 登录 shell  (真实交互式 TUI)
```

**关键设计**

1. **持久化模型** — PTY 是后端长驻进程的子进程，各自维护滚屏缓冲。浏览器刷新/关闭 → 子进程继续运行；重连时前端重新 `attach`，后端回放缓冲，xterm 重绘完整历史。**后端重启**会结束子进程（内存态注册表）；如需跨后端重启存活，见下方「进阶」。
2. **启动方式** — `bash -lc 'exec <cli> …'`。登录 shell 加载用户 PATH（保证全局安装的 `claude`/`opencode` 可用），`exec` 让 PTY 直接变成 CLI 本身，信号 / 尺寸 / Ctrl-C 原样透传。所有 persona 值经 POSIX 单引号转义，杜绝命令注入。普通终端则直接拉起你的 `$SHELL -l`。
3. **实时尺寸同步** — 前端 `ResizeObserver` + `xterm-addon-fit` 计算 cols/rows，经 WS `resize` 帧同步给 `node-pty`，多标签/分屏拖拽即时生效。

---

## 安装

### 前置条件

- **Node.js ≥ 18**。
- `node-pty` 原生模块需要 C/C++ 工具链（macOS：`xcode-select --install`；Linux：`build-essential` / `python3`）。
- 已安装并登录 `claude` 与/或 `opencode` CLI，且在 PATH 中（只需安装你打算启动的那种）。

### 一键安装

```bash
npm run setup
```

`setup` 会：安装 `server/` 与 `web/` 依赖 → **修正 node-pty 的 `spawn-helper` 可执行权限**（见下方「重要」）→ 构建前端到 `web/dist`。

### 启动

```bash
# 生产模式：后端在单一端口同时提供 UI 与 WebSocket
./scripts/start.sh
# 打开 http://127.0.0.1:4173

# 开发模式：Vite HMR + 后端热重载（Vite 代理 /api 与 /ws）
npm run dev
# 打开 http://127.0.0.1:5173
```

可用环境变量：`PORT`（默认 4173）、`HOST`（默认 127.0.0.1）、`SCROLLBACK_BYTES`、`IDLE_AFTER_MS`、`CONTROL_APP_DATA`（personas.json 存放目录）。

---

## ⚠️ 重要：node-pty 的坑（已自动修复）

在部分 macOS + 较新 npm 的组合下，`node-pty` 会安装预编译二进制，但把 `spawn-helper` 释放成**不可执行**（`-rw-r--r--`），导致 `pty.spawn()` 抛出 `Error: posix_spawnp failed`；较新的 npm 还可能默认跳过 node-pty 的 postinstall 脚本。

本项目已内置修复：`server/scripts/fix-node-pty.js`（作为 server 的 postinstall 运行，并在 `setup.sh` / `start.sh` 中幂等重跑），核心就是：

```bash
chmod +x server/node_modules/node-pty/prebuilds/<platform>/spawn-helper
# 例如 darwin-x64 或 darwin-arm64
```

若你在别处仍遇到 `posix_spawnp failed`，手动执行上面这行即可。

---

## 使用

1. 左侧 **快捷启动**：直接开裸 `claude` / `opencode` 会话；点某个**角色 chip** 以该预设启动；或点 **+ 终端** 一键打开 shell 页签。
2. 启动对话框可覆盖工作目录 / 模型 / 标签，再确认拉起。
3. 主区域用顶部「标签 / 分屏」切换布局；分屏下拖拽中间分隔条即可调整并实时同步终端尺寸。
4. 侧边栏 **会话** 列表实时显示状态。侧边栏的「**停止**」和页签上的「**×**」效果一致：终止 CLI 并关闭页签。已退出的会话短暂保留（可读最后输出），可手动「移除」，也会自动回收。
5. **刷新浏览器**：会话不中断，重新打开标签即恢复完整历史。

### Persona → CLI 参数映射

| 字段 | Claude Code | OpenCode |
|---|---|---|
| 工作目录 cwd | 进程 cwd | 进程 cwd（即 project 目录）|
| 模型 model | `--model` | `--model provider/model` |
| Agent | `--agent` | `--agent` |
| System Prompt | `--append-system-prompt` | 经 `--append-system-prompt`（若不支持则忽略）|
| 额外目录 addDirs | `--add-dir`（每项）| — |
| 环境变量 env | 注入进程环境 | 注入进程环境 |
| 额外参数 extraArgs | 原样追加 | 原样追加 |

> 角色数据保存在 `data/personas.json`（不入库），首次启动自动写入三个示例角色。

---

## 进阶：跨「后端重启」存活

当前会话在后端进程内存中，后端重启会结束所有子 CLI。若需要更强的持久化，可把启动命令包一层可复用的多路复用器：

```js
// launcher.js 中把 commandLine 改为：
// exec tmux new-session -A -s deck_<id> "<原命令>"
```

这样后端重启后仍可 `tmux attach` 回到会话（需安装 `tmux` 或 `dtach`）。属于可选增强，不在默认路径内。

---

## 目录结构

```
agent-deck/
├── package.json            # 顶层脚本 (setup / dev / build / start)
├── scripts/                # setup.sh / start.sh / dev.sh
├── data/personas.json      # 角色预设（首启自动生成，不入库）
├── server/                 # 后端 (Fastify + ws + node-pty)
│   ├── src/{index,config,launcher,personaStore,PtySession,SessionManager,wsBridge,httpRoutes}.js
│   └── scripts/fix-node-pty.js
└── web/                    # 前端 (React + Vite + xterm.js)
    └── src/{App,Sidebar,TerminalGrid,TerminalView,LaunchDialog,PersonaEditor,wsClient,api}.jsx|js
```

## 安全说明

- 默认仅绑定 `127.0.0.1`，**无鉴权** —— 这是一个本地开发者工具。若要绑定到 `0.0.0.0` 或经网络暴露，请自行在前面加反向代理 + 认证；任何能访问该端口的人都能在你机器上以你的身份运行 CLI 命令。
- persona 值全部经 POSIX 单引号转义后再拼进 `bash -lc`，防止命令注入。
- persona 的 `env` 会过滤掉能让非交互 `bash -lc` 提前执行代码的危险键（`BASH_ENV` / `ENV` / `BASH_FUNC_*` / `LD_PRELOAD` / `DYLD_*` / `PROMPT_COMMAND`），避免通过环境变量绕过「仅能启动 CLI」的边界。`extraArgs` 仍属「操作者可信输入」，请勿填入不受信内容。
- 已退出的会话在保留一段时间（默认 5 分钟，可用 `REAP_EXITED_AFTER_MS` 调整）供最后一次重连读取输出/退出码后自动回收，释放其滚屏缓冲，避免长时间运行 + 会话频繁进出导致内存无限增长。
- 慢客户端会触发背压：当 WebSocket 发送缓冲超过阈值时后端暂停对应 PTY 的读取（内核管道天然限流），而不是在 Node 里无限缓冲输出。
