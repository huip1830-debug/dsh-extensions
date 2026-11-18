# dispatch-protocol 0.15.0 — 项目策略文件 + `business` 规则预设 + `/dispatch init`

- 状态：**契约冻结**（2026-11-17，用户回「好的」＝接受推荐项：先冻结 spec 并派批，默认值按本节）
- 背景：0.13/0.14 让「按项目开关」成为可能，但默认白名单/闸门模式/规则正文都是**本仓库**（DSH 插件仓）的量身值；别的项目用它要付「误拦 + 误报 + 固定 token 税 + 改配置要重启」这四笔成本，最终只能关掉。0.15.0 把「开关」升级成「项目自带纪律策略」。
- 版本：`0.14.3` → **`0.15.0`**
- 非目标：不改 DSH 本体；不改 0.13/0.14 已发布行为的默认值（无策略文件的会话逐字节不变）；不做业务项目专属规则库（只做 plugin / business 两个预设）

## 1. 目标

1. `dispatch/protocol.json` 从「一个 mode」扩成「项目策略文件」：模式 + 白名单 + 闸门模式 + 规则预设，缺省回落到 profile 配置。
2. 新增 `rules: "business"` 预设：实测 **900 字符**（六条骨架，删掉本仓库专属的 docs-check / spec 路径 / 断言表细节；派发前估计「约 1.5K」偏高，以实测为准），固定 token 约降到 1/4（对比 3.8K 正文）。
3. 新增 `/dispatch init`：扫项目（包管理器、test/typecheck 命令、文档目录、契约目录、是否 DSH 插件）并写出贴合的 `dispatch/protocol.json`。
4. 全部实时读文件，**不改 profile、不重启**。

## 2. 契约

### 2.1 策略文件 schema（向后兼容）

`<cwd>/<projectSwitch.path>`（默认 `dispatch/protocol.json`），JSON 对象：

```jsonc
{
  "mode": "full" | "shadow" | "off",   // 0.13 语义不变；与 enabled 的优先级不变
  "enabled": true,                     // 0.13 兼容写法：false → off
  "rules": "plugin" | "business",      // 规则预设，缺省沿用 profile 的 rules/footer
  "allowlist": ["dispatch/", "docs/design/"],          // 主控可直接写的 cwd 相对前缀
  "controlPlanePatterns": ["dispatch/", "docs/design/"], // 闸门「控制面豁免」用
  "verify": { "commands": ["pnpm -w test", "pnpm -w typecheck"] },
  "contract": { "patterns": ["src/types/", "prisma/schema.prisma"] },
  "docs": { "patterns": [".md", "docs/"] }
}
```

- 每个字段**缺省即回落**到 profile 解析值；字段出现但类型/内容非法 → **该字段忽略**（回落），不影响其它字段与 mode；整个文件坏 JSON → 全部回落（现状不变）。
- `allowlist` / `controlPlanePatterns`：非空字符串数组；`verify.commands`、`contract.patterns`、`docs.patterns` 同理。
- 路径匹配口径沿用 `classifyPath` / `isAllowedPath`（cwd 锚定、大小写不敏感、尾 `/` 前缀）；不得新增第三份归一化。
- `mode`/`enabled` 判定顺序与 0.13 完全一致（`mode` 命中三档优先，其次 `enabled:false → off`，其余 `full`）。

### 2.2 读取与合并（`lib/project.mjs`）

```js
export function readProjectPolicy(cwd, projectSwitch)
// → { mode, file?, rules?, allowlist?, controlPlanePatterns?,
//     verifyCommands?, contractPatterns?, docsPatterns? }
// 只返回「文件里有效出现的字段」；缺省字段不出现（由调用方回落 config）
```

- 复用 `readProjectMode` 的文件读取/记忆化/归一化；`readProjectMode` 保留为 `readProjectPolicy(...).mode` 的薄封装（导出不删，避免 0.13 调用面断裂）。
- 记忆化键不变 `(绝对路径, mtimeMs)`；非法字段不缓存脏值（缓存的是解析结果，字段级校验在返回前做）。
- 永不抛错。

### 2.3 各机制消费点（`plugin.mjs`）

| 机制 | 使用策略 | 回退 |
|---|---|---|
| 写入守卫 | `allowlist ?? config.writePolicy.allowlist` | 原值 |
| 五闸门 | `verify.commands` / `contract.patterns` / `docs.patterns` / `controlPlanePatterns` 逐字段覆盖 | 各自原值 |
| 提示词段 | `rules === 'business'` 时用 `BUSINESS_RULES` + `BUSINESS_FOOTER`；否则用 `config.rules`/`config.footer` | 原值 |
| `off` | 行为不变（不注入、不拦、静默、观测不写） | — |
| `/dispatch`（查询/切换） | 文案与行为不变；**新增子命令** `init`。**切换 mode 时必须保留文件里其它策略字段**（只替换 `mode`/`enabled`，不得整文件重写；文件不存在或坏 JSON 时仍只写 `{"mode":"…"}\n`） | — |

- 闸门覆盖的构造：`effectiveGates = applyPolicyToGates(gates, policy)`（纯函数，返回新对象，不改原配置对象）；`evaluateGates` 内一次性算好。
- 提示词段：`text` 是函数（0.14 已有），在函数内读策略并选择预设；异常回落 `config.text`。
- 预设正文**冻结在 `lib/config.mjs`**（`BUSINESS_RULES`、`BUSINESS_FOOTER` 导出），不得散落在 plugin.mjs。

### 2.4 `business` 预设正文（逐字冻结，实测 900 字符）

```text
1. 主控只做控制面：问用户、写需求/契约/台账、派发、裁决子代理证据、跑唯一一条集成命令、提交。执行面一律派发：src/**、tests/**、scripts/** 的写入、真实环境排错、构建与失败测试修复、文档正文、测试、评审与评审修复。用户显式要求主控亲做，或已闭合批次上的单文件 ≤10 行收尾修复，可以先写 dispatch/override.json 再动手。开工先勘察：派发前把「文件:行号 + 结论 + 现存调用方」写进派发；写不出这份现状就先派只读勘察。
2. 派发必须自包含：现状、允许修改/读取（逐条文件名）、唯一一条覆盖本批的窄验证命令、预算（墙钟与步数）、输出格式。同模式机械改动用一次多 hunk 或脚本完成。清单外信息或现状不符时停报 NEEDS_CONTEXT。派发即冻结：白名单外的契约面（schema/类型/接口/路由）在批运行期间只读。
3. 验收只付一次：子代理跑本模块窄验证并归因；集成命令由派发方在相关批全部结束后跑一次并留存退出码。同一条命令只跑一次；多包仓库按端各一条。派发后不守着：一批最多一次主动检查（预算过半时），其余时间结束回合等完成事件。
4. 评审只审变更集：输入是需求、冻结契约、本批白名单并集的 diff、派发方复跑的集成结果（退出码与输出）。逐条给 PASS|FAIL + 文件:行号；不采信实现者自述；可给建议但不得改文件。需求本身是全局不变量（「彻底统一」「所有调用方」）时加一栏全仓检索核查。一个变更集一个包，全部实现批落地且跑过集成后终评一次，禁止每批一评。
5. 提交权归派发方：子代理不得 commit / push / reset / clean，除非派发中显式授权；派发前记录目标文件的既有未提交改动，不得覆盖、不得计入成果。
6. 并行只读、互斥并行写：只读子问题互不依赖时同一条消息并行发出；实施批次白名单按文件/模块互斥，同文件串行；契约在派发前定死；不得并发跑共享产物（dist、缓存、端口）的全量构建。开工先判级：单文件 ≤20 行或同模式机械改写 ≤5 文件且 ≤8 分钟＝轻批，子代理直做、免独立评审；其余为全批（契约冻结 + 独立评审 + 集成）。
```

`BUSINESS_FOOTER`：

```text
交付通道按风险缩放：控制面主控直写；轻批免独立评审；其余全批。结果未知、需 ≥3 轮「跑→看→改」的活派成循环批：目标判定 + 环境 + 每轮证据（命令/退出码/错误原文）+ 预算 + 停止条件；外部未知先派只读 spike 测出契约再冻结。预算对称：子代理单批 15 分钟/30 次编辑；主控单回合 15 分钟/20 步，触顶即停。结论以项目自己的 CI 为准：纪律只保证过程，typecheck/test/lint 才是结果闸门。
```

### 2.5 `/dispatch init`

`/dispatch init`（无其它参数）：

1. 检测（全部 best-effort，失败即跳过该字段）：
   - 包管理器：`pnpm-lock.yaml` → pnpm；`yarn.lock` → yarn；`package-lock.json` → npm；`uv.lock`/`pyproject.toml` → python；`*.csproj`/`*.sln` → dotnet。
   - 命令：读 `package.json#scripts` 的 `test` / `typecheck` / `build`（有则组装成 `pnpm test`、`pnpm typecheck` 之类）；python 用 `uv run pytest`；dotnet 用 `dotnet test`。
   - 文档目录：存在 `docs/` → `["dispatch/", "docs/"]`；否则 `["dispatch/"]`。
   - 契约面：存在 `src/types` / `prisma/schema.prisma` / `openapi.{yaml,yml,json}` 时各加一条（只加存在的）。
   - 预设：`package.json` 含 `dsh.bundle` 或 `dsh.client` → `rules: "plugin"`；否则 `"business"`。
2. 写 `dispatch/protocol.json`：`{ mode: "full", rules: 预设, allowlist, controlPlanePatterns: allowlist, verify: { commands }, contract: { patterns }, docs: { patterns } }`；已存在则不覆盖，返回错误文案说明现状（要求先删或先看）。
3. 返回文案：一行摘要（写了哪个文件、识别到的 preset / 命令数 / 契约面数）+ 提示「随时 `/dispatch off|shadow|full` 切档」。
4. **可发现性（2026-11-17 批 B 裁决追加）**：命令 `input.hint` 与用法串更新为 `[off|shadow|full|init]`；0.14 的「命令形状冻结」断言（`input` 严格等于旧 hint）随本版更新——这是**有意的契约演进**，不是回归，需在测试里改为断言新 hint 且含 `init`。

## 3. 兼容与安全

- 无策略文件 / 只有 `{"mode":...}`：行为与 0.14.3 **逐字节一致**（既有 168 条断言必须原样通过）。
- 策略字段全部是「收紧或放宽本项目的判定参数」，不改变机制本身；`off` 仍全静默。
- 所有读取 fail-open；策略文件写坏不会让守卫/闸门/提示词崩。

## 4. 白名单

| 批 | 文件 |
|---|---|
| A 策略与预设 | `lib/project.mjs`、`lib/config.mjs`、`test.mjs` |
| B 接线与命令 | `plugin.mjs`、`test.mjs` |
| C 文档版本 | `README.md`、`cordis.patch.yml`、`package.json`（`0.15.0`） |

不得改：`lib/gates.mjs`、`lib/write-policy.mjs`、`lib/tool-calls.mjs`、`client.js`、`scripts/**`、`locale/**`、其它插件。

## 5. 验收

- A：`readProjectPolicy` 解析/回落/非法字段忽略/记忆化；`BUSINESS_RULES` 六条 + `BUSINESS_FOOTER` 长度与条款数断言；`readProjectMode` 仍等价。
- B：守卫用策略 allowlist（命中放行、未命中拦截、`override` 仍生效）；闸门用策略 `verify.commands`（命中才算验证）/`contract.patterns`/`docs.patterns`/`controlPlanePatterns`；提示词段按 `rules` 切预设（business 文本出现、plugin 文本不出现）；`/dispatch init` 在临时项目里生成预期 JSON（含 package.json scripts 检测、dsh.bundle → plugin、已有文件不覆盖）。
- 集成（派发方唯一一次）：`node plugins/dispatch-protocol/test.mjs` + `node --check plugins/dispatch-protocol/client.js` + `node plugins/dispatch-protocol/scripts/docs-check.mjs`。
- 真机：本仓库 `dispatch/protocol.json` 不建 → 行为不变；建一个 `{"rules":"business"}` → 新会话里规则段变成精简版且写入仍按默认白名单拦。

## 6. 发布

提交推送 → 完全退出 DSH → `dsh plugin --profile desktop update dispatch-protocol` → 重启 → `verify-install.mjs` 四项 PASS → 刷新页面。
