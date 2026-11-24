# 子代理墙钟看门狗（subagent-watchdog 0.1.0）

> 日期：2026-11-24。派发方：主控。状态：**暂缓实施**（2026-11-24 用户决定）。
> 路由侧已先按「profile 覆盖 + README 指引 + verify-install `route-alignment`
> 检查」收口；看门狗作为兜底方案保留，需要时按本稿实施。
> 动机是一次实测事故：子代理因上游路由劣化跑了 52.5 分钟，
> 主控与用户全程无感知（见 §1）。看门狗只补「完成前失控」这一个空缺，
> 不改变正常路径的任何行为。

## 1. 背景与问题

实测证据（`session-fc4c5f19`，项目 `D:\www\scale-03`，2026-11-24 晚）：

- 子代理 `fix-purchase-dawn-alerts` 墙钟 52.5 分钟（33 步、43 次工具调用）。
  逐事件分析：全部 pwsh 后台任务合计约 1 分钟（每个 0–14 秒），
  **51.5 分钟（98%）消耗在 step/start → assistant/message 的模型等待上**，
  平均每步 94 秒、最慢单步 2.7 分钟；
- 同一路由（`opencode-go/deepseek-v4.1-flash`，effort=high）前一个半小时的
  兄弟子代理平均每步 28 秒——同一 provider 在晚高峰劣化约 3.4 倍，
  不是任务变重；
- 走官方路由的评审子代理同时段每步 15 秒，9.3 分钟收工。

现有机制在这个场景下全部失效，且各自的原因是结构性的：

| 机制 | 为什么没看见这次失控 |
|---|---|
| 纪律第 2 条「预算过半发一句话进度」 | 提示词软约束，无运行时强制；且子代理最慢的时刻在等模型响应，没有回合可发消息 |
| 纪律第 3 条「派发后不要守着」 | 主控被要求结束回合等完成事件，中途不主动检查 |
| dispatch-protocol checkpoint | 只在 `subagent/end` 之后判定投递——管「完成后验收」，管不到「完成前失控」 |

**收益定义**：把「子代理墙钟失控」从用户人肉发现
（本次是用户在第 10 回合主动问「这个子智能体是不是有问题」）
变成宿主主动通知，给主控一个决策点：
继续等 / `send_message` 问进度 / 停掉换路由重派。正常完成的子代理不受任何
影响——不注入提示词、不加工具，零 token 成本，每个子代理只有一个计时器。

## 2. 范围

**做**（新插件 `subagent-watchdog`，独立目录、独立开关）：

- `agent/created` 登记 + `ctx.timeout` 单次计时；`subagent/end` 清除；
- 超时未 settle → 给父代理 `followup` 一条通知（含可能原因与三个出路）；
- 配置段（`enabled` / `thresholdMinutes` / `maxNotices` / `text` / `log` / `debug`）、
  决定日志、`locale/en.json` + `zh.json`、`test.mjs` 离线回归；
- 同步根 README 插件清单与 CI matrix（新增插件的两处必改）。

**不做**（边界）：

- **不自动 interrupt / 杀子代理**：决策归主控与用户。看门狗无法区分
  「provider 慢但该等」与「卡死该杀」，误杀的代价大于晚发现的代价；
- **不做 per-step 延迟检测**：只看墙钟。LLM 慢与长命令慢对主控是同一个
  决策点，细分病因写进通知文本让主控自己查；
- 不并入 dispatch-protocol：它的 checkpoint 管「完成后」，且 auto/off 项目
  不投递；墙钟失控在任何项目、任何档位都会发生，独立插件才能服务不装
  纪律的用户。两个插件互不依赖、可单独开关；
- 不改 model-pin / dispatch-protocol 的既有行为
  （路由评估是另一件事，见 §6）；
- 不重派、不换路由、不评估子代理在做什么——那是主控拿到通知后的判断。

## 3. 机制

### 3.1 跟踪与计时

宿主事实（均已读码验证）：

- 计时器：`@deepseek-ai/cordis-plugin-timer` 提供 `timer` 服务，插件声明
  `inject: ['timer']` 后用 `ctx.timeout(cb, delay)` / `ctx.interval(cb, delay)`，
  随插件 fiber 自动 dispose（`cordis-plugin-timer/src/index.ts` L29–67）。
  宿主沙箱**禁止 Node 原生计时器**，timer 服务是唯一合法路径
  （`dsh-cordis-host-runner/src/sandbox.ts` L57 的重定向报错）。`ctx.get('timer')`
  不可得时 fail-open：记一条日志、整个机制不注册，插件其余部分不受影响；
- 子代理登记：`agent/created`，`session.header.origin === 'subagent'`；
  父会话 id 是 `header.parentSession`；label 读 `snapshotEvents()` 里最后一条
  `subagent/descriptor`（与 model-pin / dispatch-protocol 同款读法）；
- settle：`subagent/end`，任何 `stopReason`（`completed` / `error` / 中断）
  都算结束（`dsh-subagent/lib/types/manager.js` L1008 发出）；
- 投递：`ctx.agents.get(parentId)?.followup(userMessage(text))`——
  dispatch-protocol checkpoint 的 fallback 路径（`plugin.mjs` L1058）已验证；
  父代理空闲时 followup 会开一个新回合。

状态机（每个子代理一条记录）：

```
agent/created(subagent)  →  登记 { parentId, label, notices: 0, dispose }
                              dispose = ctx.timeout(() => fire(id), thresholdMs)
subagent/end(任意 reason) →  dispose() + 删除记录
fire(id)                  →  记录仍在（未 settle）→ 投递通知 + 写决定日志
                              notices += 1；notices < maxNotices 时按同间隔 re-arm
                              父代理解析失败 → suppressed(parent-gone)，只记日志
```

- 嵌套子代理：父是子代理时 `ctx.agents.get` 可能解析不到 hook 作用域——
  与 checkpoint 同口径，`suppressed(parent-gone)` 静默记录，不降级为报错；
- `maxNotices` 默认 1：一个子代理最多提醒一次。父代理选择「继续等待」后
  不再打扰；想持续跟踪的 profile 可调大；
- 全部判定 try/catch 包裹：看门狗是保险丝，永远不允许弄坏一次派发。

### 3.2 通知文本

默认文本（`config.text` 可覆盖，占位符 `{label}` / `{childId}` / `{minutes}`）：

```
[subagent-watchdog] 子代理 {label}（{childId}）已运行 {minutes} 分钟未结束。
常见原因：上游模型路由延迟劣化 / 单条长命令阻塞 / 任务量超预估。
由你决策：send_message 问进度；停止并（换路由）重派；或继续等待。
```

文本刻意不指认病因：看门狗只有墙钟一个信号，归因是主控读子代理事件后
的判断。决定日志口径：`kind: 'watchdog'`，`decision: 'fired' | 'suppressed'`，
`reason` 区分 `parent-gone`；默认落 `%TEMP%/subagent-watchdog-decisions.jsonl`，
`log: false` 全关。

### 3.3 配置段

```yaml
- insert:
    - id: subagent-watchdog
      name: subagent-watchdog
      config:
        enabled: true
        thresholdMinutes: 20   # volatile，配置卡可改；>0 的有限数
        maxNotices: 1          # volatile；每个子代理的提醒上限
        # text: ''             # 覆盖默认通知文本
        # log: false           # 关闭决定日志；默认 %TEMP%/subagent-watchdog-decisions.jsonl
        debug: false           # volatile
```

加载期校验与兄弟插件同口径（非法即抛错、不静默降级）：`thresholdMinutes`
非正有限数、`maxNotices` 非负整数以外、`text` 非字符串或空白，均抛错。
`thresholdMinutes` 默认 20 的依据：纪律批次的预算上限是 15 分钟
（DEFAULT_FOOTER「子代理单批 15 分钟/30 次编辑」），看门狗在预算上限
之外再留 5 分钟余量；不装纪律的项目里 20 分钟也是「该看一眼」的合理水位。

### 3.4 可测试性拆分

- `lib/tracker.mjs`：纯状态机（`register` / `settle` / `shouldFire` / 配置校验），
  注入时钟与调度函数，不触宿主；
- `plugin.mjs`：只做事件接线与 followup 投递；
- `test.mjs`：`node:test` 离线跑，覆盖 §4 用例表。

## 4. 验证

| 检查 | 期望 |
|---|---|
| `node plugins/subagent-watchdog/test.mjs` | 全绿：created→计时→end 清除不触发；超时触发一次且带 label/minutes；`maxNotices: 2` 触发两次后停；parent 缺失记 `suppressed(parent-gone)`；非法配置加载期抛错；timer 服务缺失 fail-open 不注册 |
| `node plugins/dispatch-protocol/scripts/docs-check.mjs` | `fail=0` |
| `node plugins/dispatch-protocol/scripts/check-anchors.mjs` | `fail=0` |
| 真机（发布后） | profile 覆盖 `thresholdMinutes: 1`，新会话派一个带 2 分钟 `Start-Sleep` 的子代理：约 1 分钟时主控收到 watchdog followup，决定日志有 `fired` 行；子代理正常 settle 后不再触发；恢复默认配置 |

## 5. 回滚

- 插件页禁用 subagent-watchdog，或 profile 覆盖 `enabled: false`
  （配置整体替换，抄全字段）；
- 卸载 bundle 即完全移除：无提示词注入、无文件写入、无残留状态
  （计时器随插件 fiber dispose）。

## 6. 关联发现（不在本插件范围）

同一次实测还暴露了本机 profile 的路由配置问题：model-pin 的 roles 表
覆盖了 `dispatch-readonly` preset 的创建时钉路、全局 effort=high 放在
晚高峰会劣化的转发路由上。这属于 profile 配置调整，不需要代码改动，
结论与建议已另行汇报给用户；看门狗是这类问题的**兜底**而非修复。
