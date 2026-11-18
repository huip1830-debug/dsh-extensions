# dispatch-protocol 0.18.0 — 会话区控件「未激活 / 激活」

- 状态：**契约冻结**（2026-11-18），用户已确认设计（保留控件、未初始化显示「未激活」+「激活」按钮，不整行隐藏）
- 上游：`2026-11-17-dispatch-ui-design.md`（0.14/0.15.1 控件与 `/dispatch`）、`2026-11-18-dispatch-auto-mode-design.md`（0.16 默认 `auto`）、用户反馈「未初始化实际没有作用，但控件全部显示」
- 版本：`0.17.1` → **`0.18.0`**
- 非目标：不改宿主读取口径（无标记仍按 `auto` 兜底）；不让控件读 profile 配置（自定义 `projectSwitch.path` 的限制延续）；不改 `/dispatch` 与 `/dispatch init` 的语义；不加二次确认弹窗

## 1. 目标

1. **未初始化项目说真话**：控件继续显示「派发纪律」（说明插件已启用），但档位位置显示「未激活」，并且**不显示四档按钮**——项目还没初始化时，切档按钮看起来能生效、实际项目策略并未建立。
2. **就地激活**：未激活态给一个「激活」按钮，点击执行宿主已有的 `/dispatch init`（写 `dispatch/protocol.json`：`mode:"full"` + 按项目检测的 preset + 白名单），成功后控件自然切成四档控件。
3. **已初始化与读取失败不变**：文件存在（含坏 JSON / `off` / `auto` / `shadow` / `full`）照旧显示档位与四档按钮；读取失败照旧显示「未知」+ title 错误详情。

## 2. 事实基础（带出处）

| 事实 | 出处 |
|---|---|
| 控件唯一数据源是 `remote.workspaceFiles.read(sessionId, 'dispatch/protocol.json', {})`；`workspace-file/not-found` 表示「没有标记」，宿主按 `auto` 兜底 | `client.js#readModeOf`、`lib/project.mjs#readProjectPolicy` |
| `/dispatch init` 已存在：扫项目写出 `{ mode:"full", rules, allowlist }`，文件已存在则拒绝且**不覆盖**，返回一行成功/错误文本 | `plugin.mjs#runInit` |
| 客户端执行宿主命令走 `remote.commands.execute(sessionId, line, [])`，与 `/` 菜单同一条 admission 路径；返回 `{ ok, value: { result } }`，`result.kind` 为 `success` 或 `error` | `client.js#switchModeOf` |
| 控件是 session 作用域 slot `conversation.input.dock`，`inject` 回调拿到 `sessionId`，读/写/刷新都以它为键 | `client.js#apply` |
| 客户端拿不到 profile 配置：`projectSwitch.path` 改为其它文件时，控件仍读默认路径（既有已知限制） | `README.md` 会话区控件一节、已知坑 |
| `command/executed` 只在已登记的宿主命令执行后触发；`apply` 已把它接到刷新链路上 | `client.js#apply` |

## 3. 契约

### 3.1 状态判定：`dockStateOf(result)`

新增纯函数（`client.js#dockStateOf`，经 `exports.pure.dockStateOf` 暴露给离线回归），把 `remote.workspaceFiles.read` 的 `RemoteResult` 投影成控件状态：

| 输入 | 输出 |
|---|---|
| `{ ok:true, value:{ text } }` | `{ initialized:true, mode: modeOfText(text) }`（坏 JSON / 无 `mode` 与宿主同口径回落 `auto`） |
| `{ ok:false, error:{ code:'workspace-file/not-found' } }` | `{ initialized:false }`（`mode` 不出现） |
| 其它错误（越界、非文本、RPC 失败） | `{ initialized:undefined, mode:undefined, detail:'<code>: <message>' }` |
| `null` / 非对象 / 抛错 | `{ initialized:undefined, mode:undefined, detail:'unknown' }` |

`readModeOf` 本身改为「读 + `dockStateOf`」；`no-remote`（`remote.workspaceFiles` 缺失）仍返回 `initialized:undefined` + `detail:'no-remote'`。

### 3.2 未激活态渲染

`initialized === false` 时，控件渲染：

```text
派发纪律  未激活  [激活]
```

- 「派发纪律」标签、`未激活` 值、`激活` 按钮同处现有 `.ddp-dock` 行内，宽度/对齐规则沿用 0.17.1（`.ddp-frame` 包 `.ddp-dock`）。
- **不渲染** `.ddp-mode` 四档按钮（也包括当前档位高亮按钮）；不渲染档位值。
- `激活` 按钮：`<button type="button" class="ddp-activate">`，`title` 说明「在项目里写入 `dispatch/protocol.json`（mode: full），激活后可用四档」；请求期间 `disabled`。
- `initialized === undefined`（读取失败）保持现行为：`未知` + title `读不到标记文件：<detail>`，**不**给激活按钮（状态判不出来时不做写动作）。
- `initialized === true` 保持 0.17.1 结构：值 + 四档按钮。

### 3.3 激活交互

- 点击「激活」→ `activateProjectOf(ctx, sessionId)` → `remote.commands.execute(sessionId, '/dispatch init', [])`。实现与 `switchModeOf` 共用同一个命令执行器（`commandOf`），只在拼接的命令行不同；两个服务各自导出，不合并成「传任意行」的公共 prop。
- 同一时刻只允许一次激活（`busyRef` 同步门 + `disabled` 视觉态）。
- 成功（`result.ok === true`）→ 重新读状态（`load()`）；文件出现后控件按 §3.2 切成四档控件，当前档位是 `init` 写入的 `full`。
- 失败 → **先重读一次状态**：若重读显示已初始化（并发下另一个会话先建了文件，宿主返回「已存在 … 未覆盖」），按已初始化展示，不显示错误；仍为未激活 / 判不出来 → 行内提示 `激活失败：<detail>`，`detail` 取命令错误文本，缺省用 `未知原因`。
- 命令面缺失（`remote.commands.execute` 不是函数）→ `激活失败：当前宿主没有客户端命令执行面`（复用 `unsupported` 文案）。
- 激活只调用宿主命令，不在客户端直接写文件；`/dispatch init` 的「已存在不覆盖」仍是唯一写入口的行为。

### 3.4 文案与字典

`locale/zh.json`、`locale/en.json` 的 `ui` 新增四个键，`client.js` 内置字典逐字同步（由离线用例断言）：

| 键 | zh | en |
|---|---|---|
| `inactive` | `未激活` | `Not activated` |
| `activate` | `激活` | `Activate` |
| `activateHint` | `在项目里写入 dispatch/protocol.json（mode: full），激活后可用四档` | `Write dispatch/protocol.json in this project (mode: full) to enable the four modes` |
| `activateFailed` | `激活失败：{detail}` | `Activation failed: {detail}` |

### 3.5 兼容与边界

- 默认 `projectSwitch.path` 下，控件、`/dispatch`、手改文件三者仍等价；未激活语义 = 默认路径文件不存在。
- 自定义 `path` 的项目：控件读默认路径 → 显示未激活；点激活写的是自定义文件，重读默认路径仍是未激活。该限制写进 README「已知坑」，这类项目以 `/dispatch` 为准。
- `off` 档（文件存在 `{"mode":"off"}`）算已初始化：显示「关闭」+ 四档按钮，不是未激活。
- 无客户端运行时的宿主（headless / SDK）零变化。
- 宿主插件代码零改动；`/dispatch init`、`/dispatch`、`dispatch_upgrade_full` 的可见性与行为都不变。

## 4. 白名单

| 类别 | 文件 |
|---|---|
| 客户端 | `plugins/dispatch-protocol/client.js` |
| 词条 | `plugins/dispatch-protocol/locale/zh.json`、`plugins/dispatch-protocol/locale/en.json` |
| 回归 | `plugins/dispatch-protocol/test.mjs` |
| 文档 | `plugins/dispatch-protocol/README.md`、`docs/superpowers/specs/2026-11-18-dispatch-dock-activation-design.md`（本文件） |
| 版本 | `plugins/dispatch-protocol/package.json`（`0.17.1` → `0.18.0`） |

不得改：`plugins/dispatch-protocol/plugin.mjs`、`lib/**`、`scripts/**`、其它插件、`cordis.patch.yml`。

## 5. 验收

### 5.1 离线回归（`node plugins/dispatch-protocol/test.mjs`）

在既有 111 条之外新增：

1. **状态映射**：`dockStateOf` 对「文件存在（正常 / 坏 JSON）→ 已初始化」、「`workspace-file/not-found` → 未初始化」、「其它错误 / null → 未知 + detail」逐例断言；坏 JSON 与宿主 `readProjectPolicy` 同口径（`auto`）。
2. **未激活渲染**：用带状态的桩 React 渲染组件，读结果为未初始化时元素树含「派发纪律」「未激活」「激活」按钮，且**不含** `.ddp-mode` 按钮；点击激活按钮后 `activate` 被调用且传当前 `sessionId`。
3. **激活接线**：`apply` 注入的 props 含 `activate`；调用它时 `remote.commands.execute` 收到 `(sessionId, '/dispatch init', [])`；`switchMode` 仍收到 `(sessionId, '/dispatch <mode>', [])`。
4. **失败面**：激活返回错误且重读仍为未初始化 → 行内 `激活失败：<detail>`；激活返回错误但重读已初始化（并发）→ 不显示失败提示。
5. **字典同步**：`exports.dictionaries` 的四个新键与 `locale/*.json` 的 `ui` 逐字相等。

### 5.2 文档与静态检查

- `node plugins/dispatch-protocol/scripts/docs-check.mjs` → `fail=0`
- `node plugins/dispatch-protocol/scripts/check-anchors.mjs` → `fail=0`（顺带修掉 README:208 既有的 `InputBar.module.css#row` 失效锚点）
- `node plugins/dispatch-protocol/scripts/docs-check.mjs --self-test` → `pass=20 fail=0`

### 5.3 人工清单（真机，刷新页面后）

1. 未初始化项目（如本仓库：无 `dispatch/protocol.json`）打开会话 → 控件显示「派发纪律 未激活 [激活]」，无四档按钮；
2. 点「激活」→ 仓库根出现 `dispatch/protocol.json`（`mode:"full"` + preset + 白名单），控件变为「派发纪律 全部 off auto shadow full」；
3. 已初始化项目（`{"mode":"shadow"}`）→ 直接显示四档控件、当前档 `只记`；
4. 删除 `dispatch/protocol.json` 后刷新 → 回到未激活；
5. 激活期间连点 → 只发出一次 `/dispatch init`。

### 5.4 集成（派发方唯一一次）

`node plugins/dispatch-protocol/test.mjs` + `node plugins/dispatch-protocol/scripts/docs-check.mjs` + `node plugins/dispatch-protocol/scripts/check-anchors.mjs`。

## 6. 发布

提交推送 → `dsh plugin --profile desktop update dispatch-protocol` → 重启 DSH → `scripts/verify-install.mjs` 四项 PASS → 刷新页面（客户端产物无热更）→ 按 §5.3 验收。发布后台账在 `dispatch/ledger/` 记一笔。
