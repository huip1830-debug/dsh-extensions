# dispatch-protocol 0.9.0 — 写入守卫（write policy）替换漏派发 nudge

- 状态：冻结（2026-11-04）
- 上游证据：`%TEMP%/dispatch-protocol-decisions.jsonl` + 2026-11-04 本机会话 transcript
- 范围：`plugins/dispatch-protocol` 源码、配置、规则文本、测试、README、版本

## 1. 为什么换掉 nudge

nudge 在 `agent/turn-stopping` 评估「本回合 ≥2 个非豁免文件写入且 0 派发」，然后 steer 一条提醒。实测（2026-11-04）：

- 本地日 80 条决策：checkpoint 投递 10 / 抑制 64，gate 投递 4，**nudge 投递 2（0 抑制）**；
- 两次投递都是误报：一次是用户显式授权「不触发派发纪律，由主控直接完成」（判定只扫 assistant 文本，`lib/nudge.mjs:344`），一次是控制面文件 `dispatch/review/*.md` 不在默认豁免（`lib/nudge.mjs:31`）；
- 历史可定位的 45 次去重投递：**45/45 发生在该回合最终答复之后**（投递前最后一条 assistant 消息是纯文本、无工具调用），**0 次促成派发**，合计 9.45M cache-read token。

结构结论：纠正点晚于动作，且文本是系统提示规则 1 的复述，信息增量为 0。**修复方向不是调判据，而是把约束前移到工具调用边界**，并把「豁免」变成机器可读的记录。

## 2. 目标架构

1. **工具边界（新增，唯一能阻止的地方）**：DSH `ctx.tools.guard(fn)`（同步、单调；返回字符串即拒绝，模型看到 `Error: <reason>`，回合继续）。只拦根代理的 `write`/`edit`。
2. **override 一等对象**：`dispatch/override.json`，替代 `justifiedPatterns` 的散文判定；守卫只认这个文件。
3. **证据**：守卫决定写进共用 decision log，零模型成本；不再 steer。
4. **保留的提醒只做「还来得及纠正」的事**：checkpoint、VerifyGate 等判定语义不变；nudge 的评估/投递/延迟评估全部删除。

## 3. 配置契约（0.9.0）

```yaml
enabled: true             # 总开关：false = 不注入提示词、不注册守卫、不投递任何提醒（0.9.0 裁决，见 §10）
order: 500
rules: [...]              # 规则 1 文案更新，见 §5
footer: '...'
log: '<path>' | false     # 默认 %TEMP%/dispatch-protocol-decisions.jsonl；replaces nudge.log
writePolicy:
  enabled: true
  mode: enforce           # enforce | shadow；shadow 只记日志不拦
  allowlist: ['dispatch/', 'docs/superpowers/specs/']
  overridePath: 'dispatch/override.json'
  tools: ['write', 'edit']
  delegationTools: ['subagent', 'subagent_fork', 'workflow']   # 观测行与 WaitGate 复用
checkpoint: {...}         # 不变
observation: {...}        # 不变
gates: {...}              # 不变
```

- `nudge` 段出现即**加载期抛错**，消息含迁移指引（`nudge.log` → `log`，`nudge.delegationTools` → `writePolicy.delegationTools`，`nudge.justifiedPatterns` 废弃）。
- 所有默认值在加载期校验（同现有风格）。

## 4. 守卫语义

- 注册：`apply()` 中 `ctx.effect(() => ctx.tools.guard(guard))`；`inject` 增加 `'tools'`。
- 豁免：
  - `exec.agent` 缺失 → 放行（宿主无作用域）；
  - `exec.agent.session.header.origin === 'subagent'` → 放行（子代理是执行面）；
  - `exec.name` 不在 `writePolicy.tools` → 放行；
  - 参数里既无 `file_path` 也无 `path` → 放行。
- 路径判定：
  - `\` → `/`，去 `./` 前缀；
  - 相对路径相对 `session.cwd ?? session.header.cwd`；
  - 绝对路径先转成 cwd 相对；不在 cwd 内 → 视为不在名单；
  - 名单条目大小写不敏感；条目无尾 `/` 时按词边界匹配（`entry` 或 `entry + '/'`）。
- override：
  - 读取 `<cwd>/<overridePath>`（同步）；
  - 必须能 JSON 解析且 `reason` 为非空字符串；
  - 必须「本会话写下的」：`statSync().mtimeMs >= sessionStart`，`sessionStart = session.createdAt ?? session.header.createdAt`；取不到时间戳时跳过新鲜度判断（fail-open，仍记日志 `reason: override-unbounded`）。
- 决策与日志（`kind: 'write-policy'`，`turn: null`）：
  - 名单内 → allow，**不写日志**（控制面写入不制造噪音）；
  - override 有效 → allow + 日志 `reason: 'override'`；
  - 否则 → deny：记日志 `reason: 'no-override' | 'stale' | 'invalid'`；`mode: enforce` 返回拒绝串，`shadow` 返回 undefined 且日志带 `mode: 'shadow'`。
- 守卫整体 try/catch：任何异常按放行处理（fail-open），绝不影响宿主。
- 拒绝串模板（单条，模型可见）：

```
[dispatch-protocol] 拦截：{tool} 要写 {file}，不在主控白名单内（{allowlist}）。
两条出路：①把这项写入派给执行批；②若用户本轮明确要求主控亲自做，先写 {overridePath}（如 {"reason":"用户要求直接修这 4 行"}）再重试。
```

## 5. 规则文本（`DEFAULT_RULES[0]`）

- 「唯一例外是用户显式要求主控亲自做，记一行 override」→「唯一例外是用户显式要求主控亲自做：先在 `dispatch/override.json` 写 `{"reason":"…","source":"…"}` 再动手，守卫只认这个文件（每会话有效，新会话需重写）」；有界直改同样先写 override。
- 追加一句：「被 `dispatch-protocol` 守卫拦截时，按错误信息二选一（派发 / 写 override），不要重试同一个调用。」
- footer 与其余五条不动。

## 6. 代码变更

| 文件 | 动作 |
|---|---|
| `lib/write-policy.mjs` | 新增：`DEFAULT_ALLOWLIST`、`resolveWritePolicy`、`isAllowedPath`、`readOverride`、`evaluateWritePolicy`、`renderDenyText` |
| `lib/nudge.mjs` → `lib/tool-calls.mjs` | 重命名并裁剪：保留 `DEFAULT_WRITE_TOOLS`、`DEFAULT_DELEGATION_TOOLS`、`DEFAULT_PWSH_SHELL_PATTERN`（原 `DEFAULT_PWSH_NUDGE_SHELL_PATTERN`）、`DEFAULT_CONTROL_PLANE_PATTERNS`、`callTouchesFile`、`summarizeTurn`、`isControlPlanePath`、`readCommand`、`readPath`、`collectFailedCallIds`；删除 `DEFAULT_NUDGE_TEXT`、`DEFAULT_JUSTIFIED_PATTERNS`、`resolveNudge`、`shouldNudge`、`renderNudge`、`justifiedInTurn`、`formatFiles` |
| `lib/gates.mjs` | 仅改 import 路径与常量名（`DEFAULT_PWSH_NUDGE_SHELL_PATTERN` → `DEFAULT_PWSH_SHELL_PATTERN`）；判定不变 |
| `plugin.mjs` | 删除 nudge 评估/投递/延迟评估（`evaluateNudgeTurn`、`lastNudgedTurn`、`lastEvaluatedTurn`、deferred 分支）；`apply()` 注册守卫；`registerReminders(ctx, config)`；`decisionLog = config.log`；WaitGate 用 `config.writePolicy.delegationTools`；`observeTurn` 用 `writePolicy` 口径 |
| `cordis.patch.yml` | 新配置块（含 `log`、`writePolicy`），删除 `nudge` |
| `package.json` | 版本 0.9.0 |

## 7. 验收

集成命令（唯一）：`cd plugins/dispatch-protocol && node test.mjs`，退出码 0。

新增断言（test.mjs）：
1. 根代理写 `server/src/x.ts` → 拒绝串含路径/名单/override 提示；日志 `write-policy/denied/no-override`；
2. 控制面（`dispatch/state.md`、`docs/superpowers/specs/x.md`、绝对路径同前缀）→ 放行、无日志行；
3. 子代理写 `src` → 放行；
4. override 新鲜（mtime ≥ 会话开始，`reason` 非空）→ 放行 + 日志 `reason: override`；
5. override 过期 / JSON 非法 / 缺 `reason` → 拒绝，`reason` 分别为 `stale` / `invalid` / `invalid`；
6. `mode: shadow` → 放行 + 日志带 `mode: 'shadow'`；
7. 名单外工具（`read`）、缺路径参数、无 `agent` → 放行；
8. 绝对路径在 cwd 外 → 拒绝；
9. 守卫内部异常 → 放行（fail-open）；
10. `resolveConfig`：`nudge` 段抛错、`writePolicy` 默认值、`log` 默认路径；
11. 规则文本含 `dispatch/override.json`，不含 nudge 文案；
12. 既有 checkpoint / gates / observation / 规则文本断言回归（nudge 用例删除）。

## 8. 迁移与发布

- 新版插件需按 git URL 重装到 profile 并重启 DSH 才生效；本批**不重装、不提交**。
- README：行为说明、配置表、`nudge` → `writePolicy` 迁移、变更历史（0.9.0）。

## 9. 不做（本批边界）

- 不拦 `pwsh` 的写操作（只记日志，二期再议）；
- 不改 checkpoint / gates 的判定语义与投递时机；
- 不引入 `ask` 审批（本机 approval=never）；
- 不动 `subagent-model-pin`、`experimental/**`、`.github/**`。

## 10. 裁决记录（评审后）

2026-11-04 只读评审结论「有条件 PASS」，按下列裁决处理（实施后重跑集成命令并重开受影响评审切片）：

1. `lib/gates.mjs` 过期 JSDoc（`复用 nudge.delegationTools`）→ 改 `writePolicy.delegationTools`；同文件历史术语中性化（仅注释）。
2. `log: ''` 静默回落默认路径 → 改为加载期抛错（与错误文案、README 一致）。
3. 顶层 `enabled` 裁决为**总开关**：`false` = 不注入提示词、不注册写入守卫、不投递任何提醒（0.8.x 只关 section 的语义作废）。
4. 测试补 4 条断言：`override-unbounded`、`..` 折叠（正反）、`dispatch-notes.md` 词边界、`git -C … checkout` 的 mutation 计数。
5. 非阻断项一并处理：删除 `deferred` 死键；`summarizeTurn` 容忍 `null`；README 措辞与 override 审计边界说明。
