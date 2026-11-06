# subagent-model-pin 0.3.0：回退 pin 迁移到 agent.model

日期：2026-11-06 ｜ 判级：契约面变更（路由行为）→ 全批 gated ｜ 依据：只读 spike 实测契约表（8 条，证据为 0.2.2-rc.1 app.asar 内运行时源码）

## 1. 背景与问题

0.2.2-rc.1 起，Agent 在 preStep 开头固定本步模型（`dsh-agent-loop/lib/index.js:671` `this.model.current()`，早于 tools.resolve 与提示词组装），`agent/request` 中间件返回的 config 若改 provider/model/reasoningEffort 会在 `:1000-1001` **直接抛错**（不是静默忽略）。

当前插件（0.2.0）在 `agent/created` 里为每个子代理注册 `agent/request` 中间件改写路由。主路径（tools/execute 注入委派参数）下 resolved 已等于 pin 路由、不改写、不抛错——实测正常；但**回退路径覆盖的场景（workflow 子级、父会话 tool/call 未匹配等）在 0.2.2 下每步抛错，子代理回合失败**。迁移性质 = 修复现网 bug。

## 2. 冻结契约（来自 spike 实测）

- **C1 时序**：`agent/created` 经 `ctx.serial` 且被 await（dsh-agent/lib/index.js:703-714），早于子代理首个 preStep 的模型固定点；监听器内同步 `select()` 即对全部后续步骤生效。selection 是 step 局部常量，同一步重试复用（推断，低风险）。
- **C2 select 语义**：`agent.model.select({provider, model, reasoningEffort?})`（dsh-agent/lib/index.js:196-199）追加**持久** `model/selection` 事件，随会话冷恢复保留；投影 `state.pending ?? state.lastUsed`，无记录时 `current()` 回退构造期 options（:193-194、:200-203）。select **不校验白名单、不走 LLM preflight**，路由合法性由插件自担。
- **C3 created 时可见状态**：resume 时 setup 先用 descriptor 路由 `select`（dsh-agent-loop/lib/index.js:1370-1391）再 announce created，故 created 时 `current()` = descriptor 恢复路由 或 创建时解析路由（显式 > 继承父实时路由）。父实时路由沿用现有 `readParentRoute`（parent session requestHeader config）。
- **C4 删除**：`agent/request` 中间件整体删除，插件不再注册；如需保留 headers 类改写另案处理（本期无此需求）。

## 3. 行为矩阵（created 时按序判定，首个命中生效）

设 `target = resolveRoute(label, config)`，`cur = agent.model.current()`：

| # | 条件 | 动作 |
|---|---|---|
| R1 | `header.origin !== 'subagent'` 或 depth 不匹配 | 不动（现状保留） |
| R2 | `config.force === true` | `select(target)`（保留 force 语义） |
| R3 | `explicit === true`（委派调用带 provider/model，含与父相同路由的升级） | 不 select，显式优先 |
| R4 | `target.matched`（角色命中） | cur 路由 ≠ target → `select(target)`；相同 → 跳过 |
| R5 | `explicit === undefined` 且 cur 路由 ≠ 父路由 | 不 select（保留旧启发：有主选择） |
| R6 | 否则 | cur 路由 ≠ target → `select(target)`；相同 → 跳过 |

- 路由比较按 `(provider, model)` 二元；`select` 时 `target.reasoningEffort` 有定义则带上。
- select 不带 effort 字段时，pending 投影的 effort 为 undefined，请求即不带 effort——等同旧中间件「剔除继承 effort」的语义，行为不变。
- 沙箱收窄 `applyRoleSandbox` 位置与逻辑不变（仍在 created，维持现有调用顺序）。
- **有意的行为变化**：旧中间件每请求重 pin，会覆盖用户在子代理会话中途的手动改模型；新路径只在 created（含 resume 再激活）pin 一次，之后用户手动选择生效。认为更正确，接受。

## 4. 一致性要求

- descriptor / 首次请求 / 冷恢复三点一致仍由 tools/execute 注入保证（主路径不动）；created 时 cur 已等于 target 的场景**不产生**多余 `model/selection` 事件（R4/R6 的跳过分支）。
- 配置变更对「之后激活的」子代理生效（created 时 resolveRoute 一次），不再逐请求生效。

## 5. 路由合法性自证

pin 前若运行时存在同步可用的 provider/model 可解析查询（实现批先核对 llm 服务 API），校验 target，失败则跳过 select 并 debug log；若不存在该 API，降级为「配置需自证合法」的 README 说明 + log。实现批在汇报中说明实际落地哪种及证据。

## 6. 测试（plugins/subagent-model-pin/test.mjs 改造）

- 离线 harness 增加 AgentModel stub：`current()`/`select()` + `model/selection` 事件记录，支持模拟「resume 时已有 descriptor 路由入账」。
- 新用例：R2–R6 各 ≥1 条；workflow 场景（父会话无匹配 tool/call）pin 生效且不触 agent/request；resume 场景 cur==target 时零 select；显式升级（含等于父路由）保留；select 的 effort 透传/缺省各一条。
- 删除 agent/request pin 相关用例；tools/execute 注入用例全部保留。

## 7. 集成验证（派发方执行，各跑一次）

1. `node plugins/subagent-model-pin/test.mjs` 全绿（派发方复跑）。
2. 活体 workflow 探针（派发方跑）：workflow 内 `agent()` 不传 provider/model，子级回报系统提示词模型行 = pin 路由（opencode-go/deepseek-v4.1-flash），且全程无 agent/request 抛错。

## 8. 版本与文档

- 0.2.0 → 0.3.0。
- README 中 agent/request 相关段落（约 :141-147 钩子清单、:147 descriptor 一致性、:261、:269、:287、:326 对照表）改写为 agent.model 口径；明确写「0.3.0 起回退 pin 在 agent/created 时 select；agent/request 在 0.2.2 改路由会抛错」。
- cordis.patch.yml 注释「退回纯 request 层 pin」改为「退回 agent/created 时 select 兜底」。
