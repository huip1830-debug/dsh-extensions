# dispatch-protocol 0.16.0 — `auto` 默认档、模型请示与单向升级工具

- 状态：**契约冻结**（2026-11-18，用户回「实现」＝接受推荐项；默认 auto、升级工具按 §2.4 落地。**2026-11-18 二次裁决**：用户指出「≥2 文件」条件过简，§2.2 改为判断式，不列硬条件）
- 需求原文（2026-11-18）：「派发纪律，默认 off，用户可以手动切换到 full，大模型也可以在收到需求后，评估需求是否需要开 full，如果需要，提示用户切换到 full，类似于提问」→ 讨论后用户裁决：默认改 `auto`（不是 off）；升级通道取「模型问」，**必须用户确认**；确认后由模型调用新增的切换工具执行。
- 版本：`0.15.1` → **`0.16.0`**
- 非目标：不改 DSH 本体；不改 `off` / `shadow` / `full` 的既有语义；不做自动切换（模型不得未经确认改档）；不做降档工具（`full → auto` 仍由用户命令或 dock 完成）；不新增 profile 配置键。

## 1. 目标

1. 新增 `auto` 档并设为默认：只注入一段提级提示，不拦截、不提醒、不写观测行。
2. 模型判断需求会不会从 `full` 的四个机制显著受益；会则一句话请示，用户明确确认后，调用 `dispatch_upgrade_full` 单向升级到 `full`。
3. `off` 保持全静默；`shadow` / `full` 行为不变；所有入口（读取器、`/dispatch`、dock）认识 `auto`。
4. 把「默认值从 full 改为 auto」的兼容与迁移路径写清楚。

## 2. 契约

### 2.1 档位与默认解析

`lib/project.mjs`：

```js
export const PROJECT_MODES = ['off', 'auto', 'shadow', 'full']
```

顺序即显示顺序。

`readProjectPolicy(cwd, projectSwitch)` 的判定顺序（替换 0.13/0.15 的 fail-open 表）：

| # | 条件 | 结果 |
|---|---|---|
| 1 | `projectSwitch.enabled === false` | `full`（显式关闭项目开关仍回到全文纪律） |
| 2 | `cwd` 不是非空字符串 | `full`（无法判定项目，保守回落；无 cwd 的宿主与测试维持原语义） |
| 3 | 标记路径归一化失败或逃出 cwd | `full`（配置错误，保守） |
| 4 | 标记文件不存在（`ENOENT`） | **`auto`**（变更） |
| 5 | `stat` 或读取失败（`EACCES` 等） | **`auto`**（按「没配」处理，不把成本抬到 full） |
| 6 | JSON 坏或顶层不是 plain object | **`auto`**（同上） |
| 7 | 对象含 `mode` 且为四档之一 | 该值 |
| 8 | `enabled === false` | `off`（0.13 兼容写法） |
| 9 | `enabled === true` | `full`（0.13 的显式开启仍等于全文纪律） |
| 10 | 其余（含 `{}`、只有 `rules` 等字段） | **`auto`**（变更） |

- 记忆化键仍是 `(绝对路径, mtimeMs)`；`stat` 或读取失败不缓存。
- `readProjectMode` 仍是 `readProjectPolicy(...).mode` 的薄封装。
- 说明：`auto` 仍注入提示段，不是全静默；坏文件按「没配」处理，保证手误不会把项目静默升级成 full 的高成本模式。

### 2.2 auto 提示段

- 正文 `AUTO_TEXT` 冻结在 `lib/config.mjs`（与 `BUSINESS_RULES` / `BUSINESS_FOOTER` 同处），由 `plugin.mjs` 的 section `text` 函数选择；不得散落到 `plugin.mjs`。
- 只对根代理注入：`context.agent.session.header.origin === 'subagent'` 时返回 `''`；取不到 context 或判定抛错时仍回落 `config.text`（full），与 0.13 的防御口径一致。
- `off` 返回 `''`；`shadow` / `full` 维持 `projectTextFor` 的现状。
- 逐字正文：

```text
## 派发纪律（自动档 auto）

本项目默认不启用派发纪律。full 只在这四件事上真正改变结果：契约面在动手前冻结、执行面一律派发（主控只做控制面，白名单互斥）、验收有独立评审、集成命令只跑一次。代价是派发/评审/复跑的轮次；规模越大越值，小改通常不值。

收到需求后判断：这项需求会不会从上面四件事中的至少一件显著受益？如果不会——哪怕文件不少、看起来很大——不要问，直接做。如果会，用一句话说明受益点与大致成本，问用户要不要开 full。每需求最多问一次；被拒后除非范围实质扩大，不再问。

用户明确确认后，调用 dispatch_upgrade_full（confirmed=true）完成切换；未确认前不得调用，也不得自行改档位文件。工具不可用时，请用户点输入框上方的 full 按钮或输入 /dispatch full。子代理不评估、不请示，按派发词执行。
```

正文不列文件数/行数门槛：文件数是事后指标，入口只能猜，误报率高（2026-11-18 二次裁决，用户指出「一个简单需求也会涉及两个文件」）。判断锚点是「`full` 的四个机制里有没有一件会改变这个需求的结果」，不是「看起来复杂」。

正文里的工具名必须与 §2.4 逐字一致。

### 2.3 各机制在 auto 下的行为

| 机制 | auto | 实现点 |
|---|---|---|
| 提示词段 | 根代理注入 `AUTO_TEXT`；子代理为空 | `plugin.mjs` 的 `text` 函数 |
| 写入守卫 | 直接放行；不写决定日志 | `plugin.mjs#makeGuard` |
| 完成检查点 | 不投递；不写 suppressed 行（与 off 不同） | `plugin.mjs#drain` |
| 五闸门 | 入口短路，返回 false | `plugin.mjs#evaluateGates` |
| 观测行 | 不写 jsonl、不建目录 | `plugin.mjs#observeTurn` |
| `/dispatch` | 可查询或切换到 auto | `plugin.mjs#registerCommand` |
| dock | 四按钮，当前档高亮 | `client.js` |

- `auto` 不写决定日志的理由：它是默认档，不是一次判定；标记文件本身是状态。`off` 保留每会话一条 `project-off` 的历史行为不变。
- 子代理在 auto 下不注入任何段落，也不评估、不请示；派发词就是它的全部约束。

### 2.4 升级工具 `dispatch_upgrade_full`

**可见性**：`ctx.effect(() => ctx.tools.register(definition, { when }))`。`when` 满足全部条件才返回 true：

1. `agent` 存在且 `agent.session.header.origin !== 'subagent'`（只给根代理）；
2. 当前 cwd 的 `readProjectPolicy(...).mode === 'auto'`。

`off` / `shadow` / `full` 下工具不出现在模型工具表里；`when` 内异常一律返回 false（fail-closed，不阻断步骤准备）。

**定义**：手写 `ToolDefinition`，不 import `@deepseek-ai/dsh-tools`，保持 `node test.mjs` 零依赖；`ctx.tools.register` 只校验 `output.render` 与 `output.schema`，手写形状合法：

```js
{
  name: 'dispatch_upgrade_full',
  description: 'Switch the current project from the auto dispatch mode to full. Call only after the user explicitly confirms; never call on your own.',
  parameters: {
    type: 'object',
    properties: {
      confirmed: { type: 'boolean', description: 'true only after the user explicitly agreed to switch to full' },
    },
    required: ['confirmed'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  async execute(args, exec) {
    if (args?.confirmed !== true) throw new Error('user confirmation is required')
    const agent = exec?.agent
    const cwd = agent?.session?.cwd ?? agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') throw new Error('cannot determine the session working directory')
    const current = readProjectPolicy(cwd, config.projectSwitch).mode
    if (current === 'full') return '已是 full，无需切换'
    if (current !== 'auto') throw new Error(`current mode is ${current}; only auto can be upgraded`)
    const written = mergeModeIntoPolicyFile(cwd, config.projectSwitch, 'full')
    if (!written.ok) throw new Error(`switch failed: ${written.reason}`)
    recordDecision(config.log, agent, { kind: 'project', decision: 'switched', reason: 'user-confirmed', mode: 'full', file: written.file })
    return `已切换为 full（${written.file}）；后续步骤按 full 执行。`
  },
}
```

**execute 契约**：

1. `args?.confirmed !== true` 时抛 `Error('user confirmation is required')`；模型看到 `Error: ...`，回合继续。
2. cwd 取 `exec.agent.session.cwd ?? exec.agent.session.header.cwd`；缺失时抛错。
3. 当前 mode 为 `full` 时返回 `已是 full，无需切换`（幂等，不写盘）；为 `off` / `shadow` 时抛错（工具本应不可见，这里是防御）；只有 `auto` 继续。
4. 调 `mergeModeIntoPolicyFile(cwd, config.projectSwitch, 'full')`，复用 0.15 的原子合并写，保留 `rules` / `allowlist` / `verify` 等字段；`ok:false` 时抛 `Error('switch failed: <reason>')`。
5. 成功时 `recordDecision(config.log, agent, { kind: 'project', decision: 'switched', reason: 'user-confirmed', mode: 'full', file })`（best-effort），返回 `已切换为 full（<file>）；后续步骤按 full 执行。`
6. 全程只写 `dispatch/protocol.json`；不自动降档。

**为什么单向**：升级是用户确认后的显式动作；降档仍由用户用 `/dispatch auto` 或 dock 完成，避免模型在任务中途自行卸掉纪律。

### 2.5 `/dispatch` 与 dock

- 命令：`input.hint` 改为 `[off|auto|shadow|full|init]`；无参查询返回当前档；无标记文件时返回 `auto`；`/dispatch auto` 走 `mergeModeIntoPolicyFile`。
- `runInit` 仍生成 `mode: "full"`（init 的语义是「这个项目要纪律」，不是「用默认」）；成功文案里的切档提示同步改为 `off|auto|shadow|full`。
- dock：`MODES = ['off', 'auto', 'shadow', 'full']`；`modeOfText` 的坏文件或非对象回落改为 `auto`；`readModeOf` 的 `workspace-file/not-found` 返回 `auto`；`modeLabelKey('auto')` 返回 `'modeAuto'`；`locale/zh.json` 与 `locale/en.json` 的 `ui` 增加 `modeAuto`，值分别是「自动」与 `Auto`。
- 窄屏规则不变，只显示当前档。

## 3. 兼容、迁移与风险

- **默认变化**：没有 `dispatch/protocol.json` 的项目从 `full` 变为 `auto`。发版说明必须写明；需要全文纪律的项目显式写 `{"mode":"full"}` 或 `/dispatch full`。
- **既有策略文件**：`{"mode":"off"}`、`{"mode":"shadow"}`、`{"mode":"full"}`、`{"enabled":false}`、`{"enabled":true}` 的语义不变。0.15 手写的、只有 `rules` / `allowlist` 等字段而没有 `mode` 的文件会从 full 变为 auto，需补 `"mode":"full"` 保持原行为，发布说明单列一条。
- **测试口径**：依赖「无标记 = full」且带 cwd 的既有用例改为显式写 `{"mode":"full"}`，只改夹具，不改断言语义；无 cwd 的用例按 §2.1 第 2 条仍是 full，不受影响。
- **本仓库**：`dispatch/` 在 `.gitignore` 中；发布后在本仓库执行一次 `/dispatch full` 保持维护体验，不提交标记文件。
- **风险：模型漏问**。auto 没有守卫兜底，漏问就等同无纪律；这是用户明确接受的取舍。缓解是提示段的「四件事是否有一件显著受益」与「每需求最多问一次」；插件侧信号（跨文件写入提醒）留作后续，不在本版范围。
- **风险：坏文件降级**。`{"mode":"full"}` 写坏会回落 auto；提示段仍在，用户可从 dock 或 `/dispatch` 看到并纠正。这是把「配置错误导致多花钱」改成「配置错误导致少纪律」的有意取舍。
- **风险：工具误调**。`confirmed` 是模型自证，不是安全边界；真正的门是请示文本与用户回复。工具只在 auto 可见、只做单向升级，误调的最大后果是多开 full，用户可用 `/dispatch auto` 收回。

## 4. 白名单

| 批 | 文件 | 说明 |
|---|---|---|
| A 核心 | `plugins/dispatch-protocol/lib/project.mjs` | 四档与默认解析表 |
| A 核心 | `plugins/dispatch-protocol/lib/config.mjs` | `AUTO_TEXT` 冻结正文 |
| A 核心 | `plugins/dispatch-protocol/plugin.mjs` | 提示分支、四处短路、工具注册与 execute |
| A 核心 | `plugins/dispatch-protocol/test.mjs` | 见 §5 |
| B 客户端 | `plugins/dispatch-protocol/client.js`、`locale/zh.json`、`locale/en.json` | 四按钮、默认 auto、`modeAuto` |
| C 文档 | `plugins/dispatch-protocol/README.md`、`cordis.patch.yml`、`package.json` | 四档、工具、版本历史、`0.16.0` |

不得改：`lib/gates.mjs`、`lib/write-policy.mjs`、`lib/tool-calls.mjs`、`scripts/**`、其它插件。

## 5. 验收

新增断言：

1. `PROJECT_MODES` 深比较 `['off', 'auto', 'shadow', 'full']`。
2. `readProjectPolicy`：缺文件返回 auto；坏 JSON 与 `[]` 返回 auto；`stat` 失败返回 auto；无 cwd 返回 full；`{"enabled":false}` 返回 off；`{"enabled":true}` 返回 full；`{"mode":"full"}` 返回 full；`projectSwitch.enabled:false` 返回 full。
3. 提示段：auto 项目的根代理文本逐字等于 `AUTO_TEXT`；auto 子代理为 `''`；off 为 `''`；shadow 与 full 等于 `config.text`；无 cwd 回落 `config.text`。
4. 机制：auto 下越界写入放行且无 `write-policy` 日志；auto 下子代理完成无 checkpoint 消息、无 `project-off` 行；auto 下会触发 WaitGate 的回合无消息；auto 下有写入的回合不生成 `dispatch/runs` 目录。
5. 工具：auto 根代理下 `when` 为 true；off、shadow、full 与子代理为 false；`execute({ confirmed: false })` 抛错；auto 下成功写 `{"mode":"full"}` 并保留 `rules` 等字段；写入后 `readProjectPolicy` 变 full；重复调用返回幂等文案；决定日志有 `kind:'project', decision:'switched'`。
6. 命令与 dock：`/dispatch auto` 成功；无文件查询返回 auto；`client.js` 的 `MODES`、坏文件回落、not-found 回落、`modeLabelKey` 与 locale 键均有断言。
7. 回归：显式 full、off、shadow 的既有断言原样通过；无 cwd 的既有断言原样通过。

集成（派发方唯一一次）：

```text
node plugins/dispatch-protocol/test.mjs
node plugins/dispatch-protocol/scripts/docs-check.mjs
node --check plugins/dispatch-protocol/client.js
```

真机：临时 profile 装 `link:`；新建无标记项目后，新会话出现 auto 段、工具表有 `dispatch_upgrade_full`；问「这个需求要开 full 吗」时模型请示；确认后工具调用，标记文件变 `{"mode":"full"}`，下一步出现全文规则；off 项目无段、无工具。

## 6. 发布

1. 提交推送 → 完全退出 DSH（含托盘）→ `dsh plugin --profile desktop update dispatch-protocol` → 重启 → `verify-install.mjs` 四项 PASS → 刷新页面。
2. 本仓库执行一次 `/dispatch full`；标记文件在 `.gitignore` 中，不提交。
3. 版本历史记 `0.16.0`。

## 7. 未决

- 无。默认档与升级通道已在 2026-11-18 讨论中裁决：默认 `auto`，`off` 保留给明确不需要的项目；升级由模型请示、用户确认、工具执行。
