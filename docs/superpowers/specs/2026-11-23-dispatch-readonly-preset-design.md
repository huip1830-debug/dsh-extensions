# 只读评审 preset 设计（dispatch-protocol 0.21.0）

> 日期：2026-11-23。派发方：主控。状态：设计已获用户分节确认，待 spec 审阅。
> 预期收益口径（用户已确认）：这是一笔「便宜的结构性保险」，不是效率优化——
> 主要价值是把 P1 类漂移（label/角色表/沙箱三层全失效）下评审写文件的可能性
> 从「行为自觉」降为「组合层面无此能力」；日常使用中无感，不承诺提速省钱。

## 1. 背景与问题

派发纪律的评审/复审/勘察子代理当前靠两层约束保持只读：

1. **行为层**：纪律文本要求只读（实测合规，但无兜底）；
2. **机制层**：`subagent-model-pin` 的 `roles[].sandbox` 按 label 前缀
   （「只读」/「勘察」）把沙箱收窄为 read-only。

已知失效证据（`docs/reviews/evidence/2026-10-26-tri-sample-status.md` P1）：
角色表漂移导致 40/40 个评审/勘察子代理跑在 `danger-full-access`，
「只读只靠 prompt 自守（15 个只读意图子代理实测 0 仓库写入，行为合规但无兜底）」。
label 字面前缀匹配本身也是脆弱点（中文 label 不命中英文前缀的 G8 事故）。

同时，规则 4 的「评审禁止重跑构建/测试/集成命令」目前只是提示词约束；
评审组合里带着 shell，这条禁令在工具面不存在。

## 2. 范围

**做**（三项，同属 dispatch-protocol 0.21.0）：

- 声明 `dispatch-readonly` agent preset（无写工具、无 shell）；
- root 层注册 Host 全局委派工具 `subagent_readonly`（spawn + 该 preset）；
- 纪律文本把评审/复审/勘察绑定到该工具，footer 补 spike 例外。

**不做**（YAGNI 边界，用户已逐项确认）：

- 不做 Agent Teams 任务板（dispatch/state+ledger+runs 已持久可审计，重复浪费）；
- 不动 `subagent-model-pin`（角色表仍是路由/沙箱唯一真相源）；
- 不给 spike 造第二个 preset（spike 要跑命令实测，仍走普通 `subagent`）；
- auto/off 档不做动态卸载：方案 B 动态注册因复刻官方委派语义风险高而放弃，
  接受工具常驻所有会话的约数百 token/请求成本。

## 3. 机制面

在 `plugins/dispatch-protocol/cordis.patch.yml` 的 `- insert:` 列表追加两行
（与现有 `dispatch-protocol` 行同级；preset 在启动子级时才解析，行顺序无关）：

```yaml
- id: preset-dispatch-readonly
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: dispatch-readonly
    name: 只读评审/勘察
    order: 90
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: >-
            你是派发纪律的只读子代理（评审/复审/勘察）。你的组合里没有写入工具与
            shell：只能 read/grep/glob。输入材料（需求、冻结契约、diff、集成结果）
            由派发词与 dispatch/ 下的文件提供；材料不足或与代码不符时停报
            NEEDS_CONTEXT，不得扩大范围、不得尝试写文件。评审逐条给
            PASS|FAIL + 文件:行号；勘察给「文件:行号 + 相关代码 + 结论 +
            不确定项」。结论以 final message 回传。
      - id: tool-fs
        name: '@deepseek-ai/dsh-tool-fs'
        config: { write: false, edit: false }   # 只留 read / readImage
      - id: tool-fs-search
        name: '@deepseek-ai/dsh-tool-fs-search'
      - id: compaction
        name: cordis:group
        group: true
        isolate: { compaction: true }
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'

- id: tool-subagent-readonly
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent_readonly
    agentPreset: dispatch-readonly
    modelSelection: false
```

语义要点：

- `modelSelection: false`：子代理路由完全交给继承 + `subagent-model-pin`
  （「只读/勘察」label 前缀 → 低成本模型 + `sandbox: read-only`）。
  **工具面（无写工具）与沙箱面（只读）双保险**，两层独立失效不互伤。
- 官方 `dsh-tool-subagent` 的全部行为白拿：activation 管理、完成通知、
  `maxDepth` 深度限制、`list_agents` / `send_message` 可见性。
  Host 全局工具的官方先例：codex / claude-code 原生 bundle 即把委派工具
  注册为 Host 全局工具，所有 preset（含 minimal）可见。
- `lib/write-policy.mjs` 的 `delegationTools` 默认值追加 `'subagent_readonly'`，
  观测行与完成检查点把它计入「已派发」。

## 4. 纪律文本面（`lib/config.mjs`）

改动落在已有条款内部，不新增第 7 条；全文增量 ≤200 字，测试冻结实测字符数。

**规则 1（勘察句）**，旧：

> 勘察批一律只读：产出以 final message 回传，主控落盘到 `dispatch/recon/<需求>.<端>.md`（属控制面），不得要求勘察子代理写文件——「勘察/只读」前缀会把沙箱收窄为只读。

新：

> 勘察一律用 `subagent_readonly` 派发（该工具的子代理组合无写工具与 shell）：产出以 final message 回传，主控落盘到 `dispatch/recon/<需求>.<端>.md`（属控制面），不得要求勘察子代理写文件；label 仍以「勘察/只读」开头（前缀管路由与沙箱收窄）。

**规则 4（评审句）**，在「命中 gated 的需求另派只读评审子代理」处插入绑定：
「禁止重跑构建/测试/集成命令」原文保留——它现在同时是工具面强制，
文本仍约束 spike 等旧路径。

> 命中 gated 的需求另派只读评审子代理（一律用 `subagent_readonly` 派发；其组合无写工具与 shell，故本批白名单并集的 diff 与集成命令输出由主控先落盘到 `dispatch/` 再交评审读取）……

**footer（label 约定句后补分工与 spike 例外）**：

> ……前缀管路由与沙箱（model-pin），`subagent_readonly` 管工具面（评审/复审/勘察必走）；只读 spike 要跑命令实测环境，不得用 `subagent_readonly`，仍走普通 subagent + 沙箱收窄。

**`BUSINESS_RULES` 规则 4**：评审句同样绑定 `subagent_readonly` 一句
（diff 与集成输出由派发方落盘 `dispatch/` 后交其读取）；`BUSINESS_FOOTER` 不动。

**`AUTO_TEXT`**：不动（负断言进测试）。

## 5. 配套面

**测试（`test.mjs` 新增一组）**：

- patch 结构：两行 insert 存在；`preset-dispatch-readonly` 的 plugins 无
  `tool-pwsh`/`tool-bash`，tool-fs 为 `write:false edit:false`；
  `tool-subagent-readonly` 的 `provider/toolName/agentPreset/modelSelection` 逐值断言；
- 文本：规则 1 / 规则 4 / footer 含 `subagent_readonly` 绑定句；
  `BUSINESS_RULES` 规则 4 同步；`AUTO_TEXT` 不含 `subagent_readonly`（负断言）；
- 默认值：`resolveWritePolicy` 的 `delegationTools` 含 `subagent_readonly`；
- 字数：全文增量 ≤200 字的实测冻结断言。

**README**：新增「只读评审 preset（0.21.0）」一节——机制图（工具面+沙箱面双保险）、
spike 例外、安装后验证步骤；变更历史表加 `0.21.0` 行。

**`scripts/verify-install.mjs`**：扩展核验——profile dump 中应解析出
`preset-dispatch-readonly` 与 `tool-subagent-readonly` 两行，缺失列为
与 P1 角色表漂移同级的安装漂移。

**版本与发布**：0.20.0 → 0.21.0；沿用惯例：提交推送 → 关闭 DSH →
`dsh plugin --profile desktop update dispatch-protocol` → 重启 → 新开会话验证。

**真机验收（派发方复跑）**：新会话派一个「只读评审：…」任务，确认
① 子代理工具列表无 write/edit/pwsh；② `list_agents` 可见；③ 子代理尝试
写文件时报「工具不存在」而非沙箱拒绝；④ `node test.mjs` 全绿；
⑤ `verify-install.mjs` 检出两行新 insert。

**实施第一步（探针）**：先在临时 profile（probe）里只加两行 insert、
headless 验证 root 层 `dsh-tool-subagent` 实例能挂载并启动子代理
（`ctx.sessionProjections`/`ctx.llm` 在 root 的组合差异是最大未知点），
探针通过后再改文本与测试；探针失败则退回方案 B 重新评估。

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| root 层工具实例挂载失败（组合差异） | 探针先行（§5）；官方 codex bundle 先例支持该路径 |
| 工具常驻所有会话的 token 成本 | 已接受的显式取舍；日后敏感可演进为动态注册，工具名不变、文本透明 |
| 评审拿不到 shell 后向主控反复 NEEDS_CONTEXT | 规则 4 明确主控落盘职责；验收时观察真实评审批次的 NEEDS_CONTEXT 率 |
| 回滚 | 插件页禁用，或 profile patch 给两行加 `disabled: true`；纪律文本退回上一版 |

## 7. 决策记录

| 决策点 | 结论 | 依据 |
|---|---|---|
| Agent Teams 任务板 | 不做 | dispatch/state+ledger+runs 已持久可审计；team 工具进 preset 徒增每步 schema 成本（用户裁决 2026-11-23） |
| 评审组合给 shell | 不给 | 「禁止跑构建/测试」从提示词约束升级为工具面强制；diff 由主控落盘（用户裁决） |
| 实现路径 | 静态 insert（方案 A） | 零自研委派语义；动态注册（方案 B）复刻官方行为风险高（用户裁决） |
| 落点 | 折进 dispatch-protocol | 文本与机制同插件版本化，不会出现「文本引用未安装工具」（用户裁决） |
| 收益口径 | 结构性保险，非效率优化 | P1 前科 + 零实损的诚实评估（§题头） |
