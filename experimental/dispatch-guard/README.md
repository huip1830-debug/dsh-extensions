# dispatch-guard（已归档）

> **归档状态（2026-10-22）**：未安装进任何 profile，`stall.exempt` 从未配置，已移出 `plugins/` 与 CI 矩阵。相邻需求（漏派发提醒）由 `dispatch-protocol` 的 `nudge` 承担。
>
> 恢复方式：`git mv experimental/dispatch-guard plugins/dispatch-guard`，把 `dispatch-guard` 加回 `.github/workflows/test.yml` 的 matrix 和根 README 插件清单，再 `dsh plugin --profile <p> add "github:huip1830-debug/dsh-extensions#path:/plugins/dispatch-guard"` 并配置 `stall.exempt`（否则它的只读豁免永远不生效）。

子代理的运行时护栏。两条规则都由宿主强制，不依赖提示词：

1. **失败早停**：子代理的模型请求按 `failure.codes` 连续失败达到 `failure.maxAttempts` 次时，抢在 `llm-retry` 之前短路（不再重试到 5 次），让这一轮直接以失败结束。
2. **无产出停滞检测**：子代理连续 `stall.nudgeAfterSteps` 步没有写操作 → 注入一次提醒；连续 `stall.blockAfterSteps` 步仍无写操作 → 拒绝下一步，硬停。

两种终止都会给**父代理**发一条 `[dispatch-guard]` 通知：失败码与原文、已跑步数、写操作次数、有无副作用、建议动作，并明确「不要再用 send_message 追这个子代理」。

**刻意不做**：

- **不自动回落路由**。子代理失败就阻断并报告，不静默换模型；换路由的决定留给主代理。
- **不设固定步数预算**。DSH 的 agent 循环本身没有 step 上限，这里只用「连续无写」这一产出信号，避免误杀正常的长任务。
- 不改 `subagent-model-pin` 的路由注入。

## 配置

默认值见 `cordis.patch.yml`，在 profile 的 `cordis.patch.yml` 用同 id 覆盖（`config` 整体替换，不深合并）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `failure.maxAttempts` | `2` | 命中 `failure.codes` 的失败达到第几次时阻断（含 `llm-retry` 已尝试的次数） |
| `failure.codes` | `[RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` | 计入失败预算的失败码 |
| `failure.notifyParent` | `true` | 失败阻断后是否给父代理发通知 |
| `stall.enabled` | `true` | 是否启用无写停滞检测 |
| `stall.nudgeAfterSteps` | `12` | 连续无写多少步后提醒一次 |
| `stall.blockAfterSteps` | `20` | 连续无写多少步后拒绝下一步（必须大于提醒阈值） |
| `stall.writeTools` | `[write, edit, str_replace_editor]` | 视为「有产出」的写工具 |
| `stall.writeCommandPatterns` | `[New-Item, Set-Content, Out-File, Remove-Item, git commit, git add]` | `pwsh`/`bash` 命令中命中即视为写操作 |
| `stall.exempt.labels` | `[]` | 描述标签命中即豁免停滞检测（勘察/调研类子代理） |
| `stall.exempt.promptPatterns` | `['【只读】', 'read-only', '不要写', '不得写', '禁止写', 'do not write', 'mode: explore']` | 派发提示词命中即豁免；`不要修改` 刻意不算，因为写任务也常用它表示「别碰无关代码」 |

只读豁免靠派发提示词里的标记识别：想让某个子代理不被停滞检测误杀，在 prompt 里写 `【只读】`（或 `只读`/`不要写任何文件`），或把 `description` 加进 `stall.exempt.labels`。

配置非法（`maxAttempts < 1`、提醒阈值 ≥ 阻断阈值、`enabled` 非布尔、`exempt` 非数组）会在插件加载时直接报错，不会静默降级。

## 依赖的宿主接口

在 DSH `0.2.1-rc.2` 上核对过：

- `agent/created({ agent })`：只处理 `agent.session.header.origin === 'subagent'`。
- `agent/request-error(payload, next)`：waterfall；不调 `next()` 直接返回即短路，后续监听者（`llm-retry`）不会再跑。
- `tools/post-execute(exec, result, next)`：观察写操作。
- `agent/pre-step(payload, next)`：返回 `{ kind: 'reject' }` 即拒绝该步，本轮以 `blocked` 结束。
- `subagent/end(info)`：结算时给父代理发通知（按 childId 去重）。
- `ctx.agents.get(parentSessionId)`：父代理句柄，`followup()` 投递到下一轮。

宿主版本变化后先跑 `node test.mjs`，再用临时 profile 做一次真实冒烟（见下）。

## 验证

离线回归（零依赖）：

```powershell
node test.mjs
```

真实冒烟（临时 profile，不动桌面 profile）：

```powershell
dsh plugin --profile probe add "file:G:/www/ziyou/dsh-extensions/plugins/dispatch-guard"
dsh --profile probe headless "起一个只读子代理，连续做 3 步读取，不要写文件"
```

预期：子代理在 `blockAfterSteps` 处被拒，父代理收到一条 `[dispatch-guard]` 通知；把提示词改成「只读统计…不要写文件」后，同一子代理不再被阻断。

## 已知坑

- **只读豁免靠关键词**：只读子代理必须在派发提示词里带 `【只读】`/`只读`/`不要写` 之类标记，或把 `description` 加入 `stall.exempt.labels`；否则仍会按无写停滞被阻断（豁免加入前的真实冒烟已复现：只读统计 .md 的子代理在第 3 步被拒；加入豁免后同任务正常跑完）。
- **通知来在结算通知之后**：运行时先发「Background subagent … failed before it finished.」，本插件的通知随后到达，是第二条消息，不是替换。
- **`reject` 的子代理没有收尾结论**：本轮以 `blocked` 结束，父代理只能从本插件通知里拿到原因，不要指望子代理自己汇报。
- **写操作是启发式判定**：`pwsh` 只认配置里的命令模式；用别的方式写文件（如脚本内部写）会漏判，需要时把模式补进 `writeCommandPatterns`。
- **注入消息必须是完整 UserMessage**：`{ content }` 裸对象会被 provider 拒绝（`missing field role`），必须带 `role: 'user'`、`id` 和 `source`；插件已按此构造。
- **profile 插件不支持热加载**：装完必须重启 DSH，且新开会话才生效。
