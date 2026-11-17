# dispatch-protocol 0.14.0 — 会话区档位控件 + `/dispatch` 命令

- 状态：**契约冻结**（2026-11-17），用户已确认设计（三态、`/dispatch` 命令、输入框上方 dock）
- 上游：`dispatch/state/project-switch.md`（0.13.0 项目级开关已发布）、勘察 `recon-dispatch-ui`（会话区 slot 全表与客户端调用面）
- 版本：`0.13.0` → **`0.14.0`**
- 非目标：不改 DSH 本体；不给「模型选择那一行」硬塞控件（已证实无空位）；不做 agent 工具（本批只做命令 + UI）

## 1. 目标

1. **宿主命令 `/dispatch`**：无参查询当前项目档位；带参（`off`/`shadow`/`full`）写标记文件。注册后自动出现在 `/` 菜单（证据：宿主 `ctx.commands.register` → `list(agent)` 发现面 → 客户端目录）。
2. **输入框上方 dock 控件**：显示当前项目档位与三态切换，与命令读写同一个标记文件。

## 2. 事实基础（勘察结论，带出处）

| 事实 | 出处 |
|---|---|
| 宿主命令注册 API `ctx.commands.register({name, description, input, handler})`，handler 拿 `{agent, rawInput}`，不进模型消息 | `@deepseek-ai/dsh-commands` README「Registering a command」 |
| 第三方命令自动进 `/` 菜单；执行后本浏览器发 `command/executed` | `dsh-client-ui-commands` README:42、:58 |
| 客户端执行宿主命令走 `command.execute` RPC（客户端精确方法名未证实） | `dsh-client-ui-commands` README:82 |
| `conversation.input.model/permission/activity` 是已被占用的单座；`model.label` 是禁止交互的 `single` | `recon-dispatch-ui` Q1（`dsh-client-ui-model-selection`/`permission-presets` README） |
| `conversation.composer.dock` 存在（Goal/Todo 停靠输入框上方），owner props 未证实 | `dsh-client-ui-conversation` README:119 |
| `remote.workspaceFiles.read(sessionId, path)` 按 **workspace root 相对**解析，无需先拿 cwd；错误码 `workspace-file/not-found` 等；`changes()` 可 watch | `dsh-api-workspace-files` README:28/33/41/88/68 |
| 客户端插件骨架：`window.__ModuleLoader__.load({id, factory})`、只 `require('react')`、`package.json` 的 `dsh.client` + `./client` 导出 | `plugins/pending-sessions/client.js:42-48`、`package.json:22-37` |
| 未证实项：dock 的 owner props；客户端执行命令的精确 API；workspace root 是否等于会话 cwd | `recon-dispatch-ui` 不确定项 2/3 |

## 3. 契约

### 3.1 宿主命令（批 A）

- 名称 `dispatch`；`input: { hint: '[off|shadow|full]' }`；描述「查看/切换当前项目的派发纪律档位」。
- handler：
  1. `cwd = agent.session.cwd ?? agent.session.header.cwd`；取不到 → `{ kind:'error', text:'无法确定会话工作目录' }`。
  2. 无参 → `readProjectMode(cwd, config.projectSwitch)` → `{ kind:'success', text:'当前项目档位：<mode>' }`。
  3. 参数 `trim().toLowerCase()`，必须 ∈ `off|shadow|full`，否则 `{ kind:'error', text:'用法：/dispatch [off|shadow|full]（无参=查询）' }`。
  4. 写 `<cwd>/<projectSwitch.path>`：内容 `{"mode":"<mode>"}\n`；父目录递归创建；**原子写**（同目录 `<file>.tmp-<pid>` 写完后 `rename`）；`resolveMarkerFile` 失败（逃出 cwd 等）→ error。
  5. 成功文本：`已切换为 <mode>（<cwd 相对路径>）`；若 `projectSwitch.enabled === false` 追加 `；注意：项目开关已关闭，本文件当前不生效`。
- 注册：`ctx.inject(['commands'], (cctx) => cctx.effect(() => cctx.commands.register({...})))`；宿主无 `commands` 服务时静默跳过（headless/ACP 不崩）。
- 命令不写决定日志（日志只记守卫/闸门/检查点）。

### 3.2 客户端控件（批 B）

- 落点：`conversation.composer.dock`；组件**不依赖 owner props**（未证实），会话 id 自取（`ctx.uiSession` / `ctx.uiWorkspace.selection` / `ctx.sessions.list` 中现取当前会话，具体取法以实现时实测到的可用面为准）。
- 显示：`派发纪律` + 当前档位（off/shadow/full/未知）+ 三个窄按钮；窄屏只显示当前档位按钮。
- 读：`remote.workspaceFiles.read(sessionId, 'dispatch/protocol.json')`（默认路径；见下方已知限制）；`not-found` → `full`；其它错误 → `未知` + title 提示。
  - **已知限制（2026-11-17 复审追加）**：客户端拿不到 profile 的插件配置，因此控件固定读默认路径 `dispatch/protocol.json`；把 `projectSwitch.path` 配成别的文件名时，`/dispatch` 照常写自定义文件，但控件显示会停在 `full`。该限制必须写进 README「已知坑」，自定义 path 用户以 `/dispatch` 为准。
- 刷新：监听 `command/executed` 与窗口 focus 重读；会话切换重读。
- 写：点击按钮执行宿主命令 `/dispatch <mode>`。**实现时二选一，实测决定，不得两套并存**：
  - 首选：客户端命令执行面（`command.execute` 的公开入口）；
  - 降级：把 `/dispatch <mode>` 填进输入框草稿，由用户回车（控件仍显示档位）。
- locale：`locale/zh.json`、`locale/en.json` 各加键；不得硬编码中文。
- 无客户端运行时的宿主（headless/sdk）不受影响。

### 3.3 兼容

- 默认零行为变化；`enabled:false`、无 `commands` 服务、无 client 运行时都照常。
- 文件仍是唯一真相：UI、命令、手改文件三者等价；无标记 = `full`。（**默认 `projectSwitch.path` 下**等价；自定义 path 时控件只读默认文件，见 §3.2 已知限制，命令仍等价。）

## 4. 白名单

| 批 | 文件 |
|---|---|
| A 宿主 | `plugins/dispatch-protocol/lib/project.mjs`（新增 `writeProjectMode`）、`plugin.mjs`、`test.mjs` |
| B 客户端 | `plugins/dispatch-protocol/client.js`（新建）、`locale/zh.json`、`locale/en.json`、`package.json`（`dsh.client` + `./client` + 版本 `0.14.0`） |
| B 文档 | `plugins/dispatch-protocol/README.md`（新节「会话区控件与 /dispatch」+ 版本历史） |

不得改：`lib/config.mjs`、`lib/gates.mjs`、`lib/write-policy.mjs`、`lib/tool-calls.mjs`、`scripts/**`、其它插件。

## 5. 验收

- 批 A：`node plugins/dispatch-protocol/test.mjs` 新增断言——`writeProjectMode` 创建父目录/原子覆盖/坏路径返回失败；命令 handler 三档写入、无参查询、非法参数、cwd 缺失、`commands` 服务缺失不抛；既有 153 条不改。
- 批 B：同一命令 + `node plugins/dispatch-protocol/scripts/docs-check.mjs`（fail=0）；UI 人工清单：
  1. 刷新页面后 dock 显示当前档位（无文件 = `full`）；
  2. 点 `off` → 文件变 `{"mode":"off"}`、dock 更新、下一轮请求无「派发纪律」节；
  3. 点 `full` → 恢复；坏 JSON → 显示未知/回落 full 且不崩；
  4. 切换会话 → 档位随项目变化。
- 集成（派发方唯一一次）：`node plugins/dispatch-protocol/test.mjs` + `node plugins/dispatch-protocol/scripts/docs-check.mjs`。

## 6. 发布

提交推送 → 完全退出 DSH → `dsh plugin --profile desktop update dispatch-protocol` → 重启 → `verify-install.mjs` 四项 PASS → **刷新页面**（客户端产物无热更）→ 新会话验收。
