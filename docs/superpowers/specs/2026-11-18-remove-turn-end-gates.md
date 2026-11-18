# 0.17.0 删除五个收尾状态闸门（设计记录）

> 派发方：主控（用户直接指令）。状态：已实现并验证（`0.17.0`）。
>
> 需求原文，2026-11-18：
>
> 「派发纪律，不要在会话结尾触发可核对的提醒，从这么多次真实会话中看，几乎没有价值，而且会多一次会话，浪费TOKEN不说，还会影响会话的可读性」

## 1 裁决

删除五个在 `agent/turn-stopping` 投递的状态闸门
（Wait / Verify / Contract / Review / Handoff），收尾只保留完成检查点。
写入守卫（动作之前）、完成检查点（子代理 settle 之后）、观测行与决定日志
（事实记录）全部保留。

## 2 为什么整体删，而不是关掉

- **同一判断已经有先例**：0.9.0 删 nudge 时的证据是 45/45 次投递发生在最终
  答复之后、0 次促成派发（spec `2026-11-04-dispatch-write-policy.md` §1）。
  五个闸门是同一形态：逐回合复述「刚发生了什么」，纠正点却已经过去了。
- **事实已有去处**：闸门照抄的计数与路径本来就在 `dispatch/runs/*.jsonl`
  观测行与决定日志里；模型真要回看，读文件比读提醒准确。
- **代价是真实的一步**：一次 `steer` 让同一回合再跑一步（`observeTurn` 去重注释记录过），
  每个触发回合都多一次模型步进、多一条用户要读的消息——与用户描述一致。
- **只关不删会留下误导**：`gates.*` 配置、闸门专用策略字段、`lib/gates.mjs`
  会成为「看起来还能开」的死面；按仓库口径，已删段出现即加载期报错。

## 3 改动面

| 位置 | 改动 |
|---|---|
| `lib/gates.mjs` | 整个删除（五个 `evaluate*` / `render*`、默认文案与命令表） |
| `plugin.mjs` | 删闸门 import、`applyPolicyToGates`、闸门状态（`activeChildren` / `reviewState` / `reviewSettled` / `lastGateTurn` / `lastDeliveredTurn`）、`evaluateGates`；`registerReminders` 收尾只判 checkpoint + 观测 |
| `lib/config.mjs` | 删 `gates.*` 默认值导出与解析；`gates` 段出现即抛错并给迁移提示 |
| `lib/project.mjs` | 策略字段只剩 `mode` / `rules` / `allowlist`；闸门专用 `controlPlanePatterns` / `verify.commands` / `contract.patterns` / `docs.patterns` 删除（旧文件里出现只忽略） |
| `lib/tool-calls.mjs` | 删只服务闸门的 `controlPlaneOnlyShellWrite`；`DEFAULT_DOC_PATTERNS` 从 `gates.mjs` 搬入 |
| `plugin.mjs` `/dispatch init` | 生成文件只剩 `mode` / `rules` / `allowlist` |
| `scripts/docs-check.mjs` | DOC005 输入键集合从 `resolveWritePolicy({})` 推导（6 个 `writePolicy.*`）；`gates.*` 键一律 FAIL |
| `test.mjs` | 删 80 条闸门用例；新增 2 条（`gates` 段加载期报错、收尾不 steer 而观测行照写）；策略/init 用例按新字段改写 |
| `README.md` / `cordis.patch.yml` / `package.json` | 文档、示例配置与版本号同步（0.17.0） |

## 4 不做的事

- 不动完成检查点、观测行、写入守卫、项目开关、`auto` 提级、升级工具。
- 不改规则正文与收口段（六条规则不进本版）。
- 不删历史 spec：`docs/superpowers/specs/**` 是冻结记录，仍可引用已删除的
  `gates.mjs`。

## 5 验收（派发方执行，各一次）

1. `node plugins/dispatch-protocol/test.mjs` → `ℹ tests 110` / `ℹ pass 110` / `ℹ fail 0`，exit 0。
2. `node plugins/dispatch-protocol/scripts/docs-check.mjs` → `docs-check: files=30 fail=0`，exit 0。
3. `node plugins/dispatch-protocol/scripts/check-anchors.mjs` → `anchors-check: files=4 fail=0`，exit 0。
4. 行为断言（测试内）：`resolveConfig({ gates: {} })` 抛错并含迁移提示；一个含 4 次状态轮询 + 写入 + `present` 的根代理回合在 `turn-stopping` 后 `messages.length === 0`，观测行照写。
