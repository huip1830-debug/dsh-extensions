# dispatch-protocol 0.13.0 — 项目级开关（project switch）

- 状态：**契约冻结**（2026-11-17），实现未开始
- 需求原文：「dispatch-protocol 可以通过项目来设置不触发派发纪律吗？部分项目不需要这么严格的执行纪律，需要有比较简单的方法来操作」→ 用户选定：给插件加项目级开关，默认行为不变
- 上游台账：`dispatch/state/project-switch.md`；勘察结论见同文件「待勘察」三条的答案（本轮 subagent 回传，已摘录进 §2）
- 版本：`0.12.3` → **`0.13.0`**（新机制算 minor；`package.json` 在文档批改）
- 非目标：不改 DSH 本体、不改 profile 配置、不做「按项目改规则正文」、不引入 per-agent scoped 注册

## 1. 目标

同一 profile 内，**按项目（会话 cwd）**决定派发纪律的启用档位，默认与 0.12.3 逐字节一致：

| 标记 | 效果 |
|---|---|
| 没有标记文件 | `full`，行为完全不变（145 条既有断言必须原样通过） |
| `{"mode":"off"}` 或 `{"enabled":false}` | 该项目：不注入规则段、写入不拦、检查点/五闸门/观测行全部静默；每会话一条决定日志 |
| `{"mode":"shadow"}` | 该项目：规则段与提醒照旧，写入守卫只记不拦 |
| `{"mode":"full"}` 或 `{"enabled":true}` | 与无标记相同 |

操作：用户在新项目里建一个文件即可，**不需要重启 DSH、不需要改 profile**（判定在每个工具调用/回合收尾时实时读文件）。

## 2. 事实基础（勘察结论，带出处）

| 事实 | 出处 |
|---|---|
| `assemble()` 唯一调用方是 `ReactLoopAgent.preStep`，实参 `{ agent: this, scope: this, signal, modelSelection, toolSet }` | `dsh-agent-loop/lib/index.js:692-696`、`dsh-agent/lib/index.js:407-413` |
| section 的 `text` 为函数时，每次 assemble 以求值；实参即上述 context ⇒ 能取 `context.agent.session.cwd ?? context.agent.session.header.cwd` | `dsh-system-prompt/lib/index.js:386-394` |
| `text: ''` 的段会在渲染时被丢弃（filter `text.length > 0`） | `dsh-system-prompt/lib/index.js:120` |
| 守卫每次调用已有 cwd；闸门 `:475`、观测 `:551` 同源 | `plugin.mjs:233/475/551` |
| 闸门模块（`lib/gates.mjs`）是纯函数、只读事件、不读磁盘；五个 `evaluate*` 签名已列 | `gates.mjs:13-14`、勘察 Q3 表 |
| `readOverride` 的读取口径：`normalizePath(cwd)+normalizePath(rel)` → `join` → `readFileSync` → `missing`/`invalid` | `lib/write-policy.mjs:153-188`、`:208-213` |
| `normalizePath` / `toCwdRelative` 目前是 `write-policy.mjs` 私有（`:82-89`、`:102-115`） | 同上 |
| `session.header.cwd` 不可变；`session.cwd` 是当前值（目录变更事件驱动）⇒ 统一取 `session.cwd ?? session.header.cwd` | `dsh-session/lib/index.js:1903-1914`、事件清单 `:141` |
| 测试夹具 `harness()` 返回 `{ ctx, main(id, events, header?, sessionId?, cwd?), created, turnStopping, ended, guard, sections, guards, messages }`；十余处断言读 `h.sections[0].text` 当字符串 | `test.mjs:1037-1072`、`:1991-2021`、`:133/146/162/173/1966/2373` |
| 新增**顶层**配置段不会打断既有 `deepEqual`（只比 `writePolicy`/`gates` 子对象，且 `resolveConfig` 不校验未知键） | `test.mjs:2325`、`:1307-1314`、`lib/config.mjs:124-200` |
| `registerReminders` 早退只覆盖三者全关，`off` 必须分别短路 checkpoint/观测/闸门 | `plugin.mjs:305` |

## 3. 契约

### 3.1 配置段（顶层 `projectSwitch`）

```js
projectSwitch: {
  enabled: true,               // false 时整个项目开关关闭（等价 0.12.3）
  path: 'dispatch/protocol.json'  // 标记文件，只相对会话 cwd
}
```

- 校验（加载期抛错，前缀 `dispatch-protocol: projectSwitch`）：
  - `projectSwitch` 非 plain object（含 `null`、数组）→ `dispatch-protocol: projectSwitch must be an object`
  - `enabled` 非 boolean → `dispatch-protocol: projectSwitch.enabled must be a boolean`
  - `path` 非非空字符串 → `dispatch-protocol: projectSwitch.path must be a non-empty string`
  - 子字段写 `null` 与省略同义：`??` 取默认值，不抛错（与 `order`/`log`/`checkpoint.*` 等既有段落同款口径，0.13.0 复审确认）。
- `resolveConfig` 返回值新增 `projectSwitch`；默认值由 `lib/project.mjs` 导出 `DEFAULT_PROJECT_SWITCH`，`config.mjs` 只做校验与转发（沿用「默认值只有一个入口」的既有契约）。

### 3.2 模式解析（`lib/project.mjs`，纯判定模块）

```js
export const DEFAULT_PROJECT_SWITCH = { enabled: true, path: 'dispatch/protocol.json' }
export const PROJECT_MODES = ['full', 'shadow', 'off']
export function readProjectMode(cwd, projectSwitch) // → 'full' | 'shadow' | 'off'
```

判定顺序（固定，不得发明第四种）：

1. `projectSwitch.enabled === false`、`cwd` 不是非空字符串、路径归一化失败 → `'full'`（fail-open）
2. 文件不存在（`ENOENT`）→ `'full'`
3. JSON 解析失败 / 顶层不是 plain object → `'full'`（与 `readOverride` 的 `invalid` 同口径，但**不**把它当错：项目开关是可选便利，坏文件不得阻断工作）
4. 对象含 `mode` 且是 `'off'|'shadow'|'full'` → 该值
5. 否则 `enabled === false` → `'off'`；`enabled === true` 或其它 → `'full'`

- 路径口径复用 `write-policy.mjs` 的 `normalizePath` / `toCwdRelative`：本批把它们**加导出**（不改实现、不改行为），`project.mjs` 不得另写第三份归一化。
- 记忆化：按 `(归一化绝对路径, mtimeMs)` 缓存；`stat` 失败即不缓存、返回 `'full'`。不得跨 cwd 串味。
- 读取失败（`EACCES` 等）→ `'full'`，永不抛错（与守卫 fail-open 同口径）。

### 3.3 各机制行为

| 机制 | `full` | `shadow` | `off` |
|---|---|---|---|
| 系统提示词段 | 现状（`config.text`） | 现状 | `text` 函数返回 `''` → 该段被丢弃，规则不出现 |
| 写入守卫 | 现状 | 守卫照常判定，但**永不返回拒绝串**；拒绝改为记 `decision:'allowed', reason:'project-shadow', mode:'shadow'` | 直接放行；每 `(session, cwd)` 记**一条** `kind:'project', decision:'suppressed', reason:'project-off'` |
| 检查点 | 现状 | 现状 | 子代理 settle 时每个 child 记一条 `kind:'checkpoint', decision:'suppressed', reason:'project-off', childId, label`，不投递 |
| 五闸门 | 现状 | 现状 | `evaluateGates` 内 cwd 算出后 `return false` |
| 观测行 | 现状 | 现状 | 不写 jsonl、不建目录 |

- 提示词段实现：`plugin.mjs:272-277` 的 `text` 从 `config.text` 改为函数 `(context) => …`：取 `context?.agent?.session?.cwd ?? context?.agent?.session?.header?.cwd`，`readProjectMode` 为 `off` 时返回 `''`，否则返回 `config.text`；内部异常一律回落 `config.text`（不得因为拿不到 context 就让请求失败）。`interpolate: false` 不变。
- 守卫：`makeGuard` 的闭包内新增 `reported = new Set()`（键 `session.id + '\0' + cwd`）用于 `project-off` 去重；`shadow` 判定插在 `evaluateWritePolicy` 结果处理后、`renderDenyText` 之前。
- 检查点：`drain(parentId, scopedAgent, turn)` 在取到 `parent` 后算 cwd 并读模式；`off` 时走「逐 child 记一条 + 不投递」分支，返回 `{ delivered:false, handled:false, readOnly:false, empty:false }`（`empty` 保持语义：队列非空）。
- 闸门：`plugin.mjs:475` 的 `const cwd = …` 之后立即 `if (readProjectMode(cwd, config.projectSwitch) === 'off') return false`。
- 观测：`observeTurn` 在 `cwd` 校验之后、`snapshotEvents` 之前短路。
- 子代理：守卫/闸门/观测本就有「子代理不适用」的既有早退，不改；提示词段按 context 里的 cwd 自然生效（子代理 cwd 取不到时回落 `full`）。

### 3.4 日志与兼容

- 决策日志沿用 `recordDecision`，新 `kind:'project'` 只在守卫路径产生，且每 `(session, cwd)` 最多一条；`kind:'checkpoint'` 的 `reason:'project-off'` 复用既有 `reason` 字段，不新增解析器。
- `log: false` 时上述全部不记（`recordDecision` 既有行为）。
- **不得**改动规则正文、`DEFAULT_*` 文案、`gates.*` / `writePolicy.*` 任何默认值或校验；`resolveConfig({})` 除新增 `projectSwitch` 外其余字段逐字节不变。

## 4. 白名单

| 批 | 文件 | 说明 |
|---|---|---|
| A 核心 | `plugins/dispatch-protocol/lib/project.mjs`（新建） | `DEFAULT_PROJECT_SWITCH`、`PROJECT_MODES`、`readProjectMode` |
| A 核心 | `plugins/dispatch-protocol/lib/write-policy.mjs` | 仅把 `normalizePath`、`toCwdRelative` 加进 `export`（不改函数体） |
| A 核心 | `plugins/dispatch-protocol/lib/config.mjs` | `resolveConfig` 新增 `projectSwitch` 校验与返回；转出默认值 |
| A 核心 | `plugins/dispatch-protocol/plugin.mjs` | 提示词函数文本 + 守卫/检查点/闸门/观测四处短路 |
| A 核心 | `plugins/dispatch-protocol/test.mjs` | 见 §5；**既有 145 条断言一条都不许改**，只允许为兼容 `text` 变函数改动 `harness()` 的采集一处 |
| B 文档 | `plugins/dispatch-protocol/README.md` | 配置表两行 + 新节「项目级开关」+ 版本历史一行 |
| B 文档 | `plugins/dispatch-protocol/cordis.patch.yml` | 注释块加 `projectSwitch` |
| B 文档 | `plugins/dispatch-protocol/package.json` | `0.12.3` → `0.13.0` |

不得改：`lib/gates.mjs`、`lib/tool-calls.mjs`、`scripts/*`、`dispatch/**`（除派发方自己记台账）、仓库根其它插件。

## 5. 验收

新增断言（都进 `test.mjs`）：

1. `resolveConfig({}).projectSwitch` 深比较 `{ enabled:true, path:'dispatch/protocol.json' }`；`projectSwitch: 42`、`{enabled:'yes'}`、`{path:''}` 三条 throws，消息前缀 `dispatch-protocol: projectSwitch`。
2. `readProjectMode`：缺文件 → `full`；`{"enabled":false}` / `{"mode":"off"}` → `off`；`{"mode":"shadow"}` → `shadow`；坏 JSON / `[]` → `full`；`enabled:false` 时不论标记内容 → `full`；`cwd` 为空串 → `full`。
3. 守卫 + `off`：写入 `server/src/x.ts` 返回 `undefined`（不拦），决定日志恰好一条 `kind:'project'`、`reason:'project-off'`；同一会话第二次调用不再新增该行。
4. 守卫 + `shadow`：越界写入返回 `undefined`，日志 `decision:'allowed'`、`reason:'project-shadow'`、`mode:'shadow'`。
5. 闸门 + `off`：原本会触发 WaitGate 的回合，`parent.messages.length === 0`。
6. 检查点 + `off`：子代理 completed 后父代理收尾，`parent.messages.length === 0`，日志有 `kind:'checkpoint'`、`reason:'project-off'`、`childId`。
7. 观测 + `off`：有写入的回合不生成 `dispatch/runs/<session>.jsonl`（目录不存在）。
8. 提示词：`off` 的 cwd 下 section 文本求值为 `''`；`full` 下与 `config.text` 相等；`shadow` 下等于 `config.text`。
9. 回归：既有 145 条断言原样通过（`pass=145+新增 fail=0`）。

命令（子代理窄命令 = 派发方集成命令，主控复跑一次）：

```
node plugins/dispatch-protocol/test.mjs
```
文档批另加：`node plugins/dispatch-protocol/scripts/docs-check.mjs plugins/dispatch-protocol/README.md` → `fail=0`。

## 6. 发布

1. 提交 → 完全退出 DSH（托盘也退）→ `dsh plugin --profile desktop update dispatch-protocol` → 重启 → `node plugins/dispatch-protocol/scripts/verify-install.mjs` 四项 PASS → 新开会话生效。
2. 本仓（`dsh-extensions`）不放标记文件 → 发布后行为不变；在某个轻项目根建 `dispatch/protocol.json` 写 `{"mode":"off"}` 验证「该项目不再出现规则、写入不拦、无提醒」。
