# pending-sessions 待处理会话悬浮条 · 设计（2026-11-05）

> 状态：设计已经用户确认（2026-11-05）。可行性依据：只读勘察批 6ab5e513 报告（本会话消息流）与台账 `dispatch/ledger/2026-11-05-pending-sessions-spike.md`。

## 1. 需求

用户在多个本地项目间并行开发，DSH 桌面版侧边栏的工作区/会话状态不显眼，别的工作区里 agent 回话了不能及时看到。需要一个 GUI 插件：

- 全局显示「待处理会话」列表（任何页面可见的悬浮条）；
- 待处理 = **阻塞等待用户操作**（等批准 / 等回答 / 计划复核）+ **回合结束未读回复**（两类都算，分开标识）；
- 点击条目跳转到该会话处理；**处理后自动消失**（无手动已读）；
- **系统通知**：会话新进入待处理时弹一条 OS 通知（浏览器 Notification API），覆盖「用户已切到别的窗口」的场景。

## 2. 方案选型（已定）

| 候选 | 结论 |
|---|---|
| A. 纯浏览器半区插件（client.js） | ✅ 采用：无 Host 逻辑、无配置项、改动面最小 |
| B. bundle 双半区（Host + client） | ❌ 砍掉（YAGNI）：持久化/系统通知本期不需要，需要时再补 |
| 落点：侧边栏区块 | ❌ 用户否掉：正是侧边栏不显眼才做本插件 |
| 落点：全局悬浮条（`shell.overlay`） | ✅ 用户选定 |
| 系统通知：浏览器 Notification API | ✅ 用户选定（唯一能够到 OS 层的通道；无官方通知服务，插件自建） |

## 3. 架构与文件

按仓库骨架新增 `plugins/pending-sessions/`：

```
plugins/pending-sessions/
├── package.json      # name + dsh.bundle.patch + dsh.client{platform:'web'} + exports(./client, ./locale/*.json)
├── cordis.patch.yml  # bundle 层声明（照 subagent-model-pin 骨架裁剪；最小形态在实施批验证）
├── client.js         # 唯一实现：手写 window.__ModuleLoader__.load({id, factory})，纯 JS + createElement，仅 require('react')
├── locale/en.json    # 插件页元信息（必需）
├── locale/zh.json
├── test.mjs          # 离线回归（node test.mjs，零依赖）
└── README.md         # 行为、安装、验证、已知限制
```

`client.js` 形态与 `plugins/subagent-model-pin/client.js` 一致：id = 包名；导出 `apply(ctx)` / `inject`；CSS 用注入式 `<style>` 标签 + `--dsw-alias-*` 主题变量；i18n 用 `ctx.locale.register`（zh/en 字典内置）。

## 4. 数据流（全部消费现成信号，零自造状态）

`inject: ['slots','locale','sessions','workspaces','uiSession','uiWorkspace']`。

控制器订阅三个 store（`getSnapshot/subscribe` 模式，同先例 PinCardController）：

| 来源 | 取什么 |
|---|---|
| `uiSession` 的 `sessionStatus`（Map<sessionId,{running, pendingInteraction, completionUnread}>） | `pendingInteraction ∈ 'approval'/'plan-review'/'question'`、`completionUnread` |
| `sessions.list`（{phase, ids, byId}） | 会话标题、`updatedAt` |
| `workspaces` 快照（{items[], …}） | `items[].sessionIds` 反查会话所属工作区 label（官方同款做法，dsh-client-ui-workspace/lib/client.js:1507） |

**判定**：待处理 = `pendingInteraction !== undefined` 或 `completionUnread === true`。
**排序**：阻塞类（pendingInteraction）整体在前，未读类在后；两类内部各自按 `updatedAt` 倒序（最新在前）。
**消失**：全自动——点击跳转使会话成为主视图 → `completionUnread` 清除（dsh-client-ui-session/lib/client.js:948-955 `isMain` 分支）；用户完成交互 → `pendingInteraction` 由 domain 撤销。**不写任何已读表。**

## 5. UI 行为

- 注册到 **`shell.overlay`** 槽位（列表座；ui-workspace 已在 dsh-client-ui-workspace/lib/client.js:5306 示范注册），渲染右下角固定悬浮条；**不占** `sidebar`/`sidebar.workspaces` 等单座。
- 收起态：药丸显示数量（如 `● 3`）；存在阻塞类时用药丸警示色。
- 展开列表项：状态点 + 类型标签（等批准/等回答/计划复核/未读回复）+ 工作区名 + 会话标题；点击 → `ctx.uiWorkspace.openSession(sessionId)`（dsh-client-ui-workspace/lib/client.js:1471，等价侧边栏点击）。
- 列表为空 → 整个悬浮条隐藏。
- 当前主视图会话不进列表（已在眼前）。

### 5.1 系统通知

- **触发**：某会话**新进入**待处理（`pendingInteraction` 出现或 `completionUnread` 置位的边沿转换）且**窗口未聚焦**（`document.hasFocus() === false`）时，弹一条通知；窗口已聚焦时不弹（人已经在看）。
- **节流**：同一会话的同一待处理 episode 只弹一次（进入→处理→再进入才算新 episode）；多条同时出现合并为一条汇总通知（「N 个会话待处理」），不轰炸。
- **内容**：类型标签 + 工作区名 + 会话标题（如「等回答 · scale-03 · 成本模块审查」）。
- **点击通知**：尽力而为——调 `openSession` 跳转 + `window.focus()`；Electron 下窗口激活是否生效以人工验收为准（preload 桥未取证，不保证）。
- **权限**：首次触发时 `Notification.requestPermission()`；被拒则静默降级为仅悬浮条，并在悬浮条 tooltip 注明「系统通知未授权」。
- 通知逻辑（边沿检测、节流、合并、聚焦判断）抽成纯函数，纳入 `test.mjs`。

## 6. 错误处理与边界

- 任一 inject 服务缺失（DSH 旧版本）→ 不渲染，仅 console 提示，不影响宿主；
- `connection/reset` 按先例重置控制器订阅；
- HMR 重挂丢 React 内部 state（展开/收起）可接受，会话状态由远端重建；
- **已知限制（写进 README 醒目位置）**：
  - `completionUnread` 纯客户端内存，刷新页面即丢——本插件是「本次打开 DSH 以来的提示板」，不是跨重启待办清单；
  - 打开页面前就已完成的冷会话不会出现在列表（从未观察到其 running→false 转换）；
  - `pendingInteraction` 较耐久（Remote waterfall 重连重放），Host 重启后仍丢；
  - 系统通知依赖浏览器授权与 OS 通知中心设置；DSH 窗口聚焦时不弹（防打扰设计，非缺陷）。

## 7. 测试与验收

- `client.js` 把过滤/排序/工作区映射/当前会话排除/通知边沿检测与节流抽成**纯函数导出**，`test.mjs` 在 node 下零依赖跑用例：两类信号各自命中、混合排序（阻塞在前）、无归属工作区的会话、当前主会话排除、空列表、通知「未聚焦才弹 / 同 episode 只弹一次 / 多条合并」。
- **冻结的集成命令（唯一一条）**：`node plugins/pending-sessions/test.mjs`（在仓库根执行，覆盖本批全部改动）。
- 人工验收（写进 README）：装到 desktop profile → 重启 DSH → 开两个工作区各跑一个会话；A 会话触发 agent 提问（出现「等回答」）、B 会话回合跑完（出现「未读」）→ 悬浮条计数=2 → 逐项点击跳转并处理 → 逐项消失。**通知验收**：切到别的窗口让 DSH 失焦 → 制造一次待处理 → 收到系统通知 → 首次触发时出现过授权请求。

## 8. 实施前遗留取证点（不阻塞设计）

1. `main` keyed 槽注册字段名（本设计用 `shell.overlay`，仅备忘，若改面板形态才需要）；
2. 「当前主视图会话 id」的读取方式（uiWorkspace 服务上应有 current，实施批开工先读 dsh-client-ui-workspace/lib/client.js 确认一处）；
3. `cordis.patch.yml` 纯客户端 bundle 的最小形态（照骨架裁剪后在实施批验证安装）。

## 9. 判级

- 风险轴：无契约面改动、无外部环境 → 非 gated；
- 规模轴：单文件 client.js 预计 400–600 行手写（超轻批上限）→ **全批**（spec 冻结 + 实现批 + 评审可因非 gated 简化为主控复跑 + diff 自查；若实施中改动面扩大须重新判级）。

## 10. 修订（2026-11-05 第二轮）：过滤子智能体

用户要求：悬浮条与系统通知**一律不列子智能体会话**，只呈现顶层会话。

- **判定信号（实测契约）**：`sessions.list` 的 `byId[id].origin === 'subagent'` 即子智能体。依据：官方侧边栏 `sessionVisible()` 用同一字段把子智能体隐藏（app.asar 内 `dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js:964-965`，注释「Subagent children use their parent header catalog」）。与 Host 侧 `session.header.origin === 'subagent'`（dispatch-protocol、subagent-model-pin 同款）同源。
- **过滤点**：
  1. `buildItems`：子智能体 id 直接跳过（不进列表、不计数）；
  2. `detectFresh`：增加排除集参数，子智能体不进入 `pendingIds`——既不触发系统通知，也不占用 episode 记录；
  3. `statuses` 里有而 `sessions.byId` 里没有的孤儿 id：无法证明是子智能体 → **保留**（宁可多列，不漏顶层会话）。
- **不变**：排序、消失、通知节流/合并、集成命令（`node plugins/pending-sessions/test.mjs`）。
- **判级**：非 gated（无契约面/外部环境）；改动约 client.js ≤20 行 + test.mjs 用例 + README 一行 + package.json patch 版本，3–4 文件非机械 → 全批，免独立评审，主控复跑集成命令 + diff 自查。

## 11. 修订（2026-11-05 第三轮）：三态状态指示 + 待处理临时收起

设计已经用户确认（两轮问答：空闲态常显低调呈现；收起恢复 = 新进入自动 + 手动，无定时）。

### 11.1 三态药丸（常显）

悬浮条不再「列表为空即隐藏」，改为常显三态（优先级从上到下）：

| 状态 | 条件 | 呈现 |
|---|---|---|
| 运行中 | `running > 0` | 药丸圆点**脉冲动画**（品牌色呼吸，纯 CSS keyframes + `prefers-reduced-motion` 降级静态），文字带「N 运行中」；与待处理数量可并存，展开列表照常 |
| 等你处理 | `running === 0` 且有待处理（未收起） | 维持现状：静态数量药丸，阻塞类警示色 |
| 全部空闲 | `running === 0` 且无可见待处理 | 低调药丸：三级灰小点 + 「全部空闲」文案，不警示不闪烁；存在即「可安排新工作」 |

- **运行计数信号**：`uiSession.sessionStatus` 每条 `running === true` 计数；**刻意包含子智能体**（与 §10 的过滤相反方向：过滤只作用于待处理列表/通知，运行计数是全量活动指示）。沿用已知限制：只统计本客户端观察到的会话。
- 展开面板头部加一行状态摘要（如 `2 运行中 · 1 待处理` / `全部空闲`）。
- 新纯函数 `runningCountOf(statuses)`，纳入离线回归。

### 11.2 待处理临时收起

- **入口**：展开面板头部「暂时收起」按钮，一键压下当前全部待处理项（记录收起 id 集）。
- **收起态**：药丸不显示待处理数量、不用警示色（运行中动画不受影响）；面板点开仍能看到全部条目。
- **恢复条件**（满足其一）：①任何不在收起集里的会话新进入待处理（含已收起会话处理后再次进入的新 episode）→ 整个列表自动恢复；②点击低调药丸 → 手动恢复并展开。
- **不影响系统通知**：新进入的通知边沿照常；已收起项不重复通知（episode 语义兜底）。
- **存储**：收起集纯内存，刷新即复位（写进 README 已知限制），不写盘。
- **判级**：与三态合并为一个全批（同文件、同一集成命令 `node plugins/pending-sessions/test.mjs`）；非 gated，免独立评审。版本 0.1.1 → 0.2.0（新功能 minor）；新增 i18n 键须同步 `locale/en.json` / `locale/zh.json`（既有同步用例兜底）。

## 12. 修订（2026-11-05 第四轮）：药丸长按拖动换位

设计已经用户确认（问答冻结：**自由放置**不吸附边缘；**localStorage 记住位置**跨刷新/重启）。

### 12.1 手势判定（纯函数，可离线测）

- 按下后满足任一条件即进入拖动：**按住 ≥400ms**（长按，药丸浮起/阴影加深作视觉反馈）或**指针移动 >10px**（直接拖也认）；两者都未满足就松手 = 原点击行为（展开/恢复），单击语义不受影响；
- 拖动中实时跟随指针；松手落点**钳制在窗口内**（四边留 8px 边距），自由放置；
- **拖动只在药丸（收起）态可用**；面板展开时位置锁定（不做面板拖头，YAGNI）。

### 12.2 位置与持久化

- 落点存 `{left, top}` → `localStorage["pending-sessions/pill-position"]`，松手时写入（try/catch 兜底，存储不可用时静默降级为内存）；
- 挂载时读取并**钳制到当前视口**（窗口改小不丢到屏外）；
- 持久化例外说明：位置是 UI 偏好、非会话状态，属「零自造持久状态」的显式例外，写进 README。

### 12.3 展开面板跟随

药丸在下半屏 → 面板向上展开；上半屏 → 向下展开（不再固定右下锚点）；水平贴药丸右缘并钳制在视口内。

### 12.4 实现约束

- 控制器 store 加 `position` + `moveTo(left, top)`；新增纯函数 `clampPosition` / `readPosition` / `panelPlacement` / 手势判定（如 `dragGestureOf`），全部纳入 `test.mjs`；
- i18n 加拖动提示键（client.js 内置字典与 locale/*.json 三处同步）；
- 版本 0.2.0 → 0.3.0；集成命令不变（`node plugins/pending-sessions/test.mjs`）；
- **判级**：非 gated 全批（client.js ~+120 行含手势处理 + 测试 + README + 字典），免独立评审，主控复跑 + diff 自查。

## 13. 修订（2026-11-05 第五轮）：位置改比例坐标（修复窗口缩放/最大化偏差）

用户实测：窗口缩小与最大化时药丸位置偏差大。根因（主控定位）：§12 存的是**绝对像素 `{left, top}`**，视口变化后无重新锚定语义——最大化时球停在旧小窗坐标（视觉上半屏中央）；缩小时靠 clamp 拉回，且 clamp 依赖 `hostViewportOf` 两级父容器猜测（R3 已知风险），测不准则更偏。修复方案经用户选定：**A. 比例坐标存储**。

- **存储格式迁移**：`localStorage["pending-sessions/pill-position"]` 改为 `{fx, fy}`——可动区间（视口 − 药丸尺寸 − 两侧 8px 边距）内的 0~1 比例；`fx=1, fy=1` = 右下角。旧格式 `{left, top}` 首次读取时按当时视口一次性换算为比例并写回（迁移失败/畸形 → 回落右下角默认，不丢窗口外）。
- **渲染**：store 存比例；每次渲染用当前视口 + 实测药丸尺寸换算回像素（`fractionToPosition`）——窗口缩放后同一比例自动落在同一相对位置，resize 监听只负责触发重算刷新，不再承担 clamp 语义。
- **拖动**：过程仍是像素（跟手），拖动中钳制沿用 `clampPosition`；**松手**换算成比例（`positionToFraction`）写盘。
- **面板跟随**：`panelPlacement` 接口不变，消费换算后的像素锚点。
- **不变**：手势阈值（400ms/10px）、自由放置不吸附、8px 边距、存储失败静默降级、集成命令。
- 新纯函数 `positionToFraction` / `fractionToPosition`（含区间宽度 ≤0 的防御）纳入 test.mjs；`readPosition` 增加旧格式迁移分支的用例；resize 不变量用例：同一比例在两个小视口下换算出的相对位置一致。
- 版本 0.3.0 → 0.3.1（bugfix patch）；README 行为表改一行（位置记忆语义），已知限制补「`hostViewportOf` 两级父容器猜测仍在，比例语义使缩放鲁棒」。
- **判级**：非 gated 全批（修复批，改动集中在 client.js 定位链路 + 测试），免独立评审，主控复跑 + diff 自查。

## 14. 修订（2026-11-06 第六轮）：等待子智能体的父会话不进入待处理

**问题**（用户实测）：主控派生子智能体后按 DSH 约定结束当前回合、挂起等完成事件。DSH 在任意会话 `running: true → false` 且不是主视图时置 `completionUnread`（`dsh-client-ui-session/lib/client.js:948-955`），这与「回合写完等你读」是同一条信号。插件把 `completionUnread` 一律算待处理（§4），而 §10 的子智能体过滤只排除 `origin === 'subagent'` 的子会话本身，没有识别「父会话为了等子会话而结束回合」。多子智能体时，每个子智能体完成都会唤醒主控跑一轮再结束，形成新的 unread episode 并重复通知；点击父会话也没有可执行动作。

**决策**（用户已确认，问答冻结）：等待子智能体期间，父会话**既不进入列表、也不弹系统通知、不计入待处理数量**；整批结束、父会话真正跑完最后一轮且没有活跃子智能体时，这一次 `completionUnread` 才按普通未读提醒一次。等待期间的活动指示由药丸的「N 运行中」承担（§11.1 运行计数刻意含子智能体，不变）。

### 14.1 判定信号与纯函数

新增纯函数 `waitingParentIdsOf({ statuses, sessions })`，返回等待中的顶层父会话 id 集合：

- **父会话候选**：`statuses` 中 `pendingKindOf(status) === 'unread'`，且 `sessions.byId[parent]` 存在、`summary.origin !== 'subagent'`。父会话自身有 `pendingInteraction` 时 `pendingKindOf` 返回交互类型，不进入候选（等批准/等回答必须照常提醒）。
- **子智能体后代**：从 `sessions.byId` 收集 `origin === 'subagent'` 且 `parentSessionId` 为字符串的行，建立 `parentId → childIds`。支持嵌套（父 → 子智能体 → 孙智能体）。`parentSessionId` 随 `sessions.list` 行下发（`dsh-api-session-controller/lib/types/list.js:319-325`；同包 `manager.js:100-107` 用同一字段解析子智能体地址）。
- **活跃节点**：`statuses.get(id).running === true` 或 `sessions.byId[id].running === true` 或 `statuses.get(id).pendingInteraction != null`。后代的活跃性递归向上传播：某子智能体自身不 running、但其后代有活跃节点，仍算活跃。
- 父会话的后代中存在活跃节点 → 加入等待集；递归需 memo + 环保护（被访问节点先假定不活跃）。
- 缺 `origin` / `parentSessionId` 的孤儿行无法证明关系 → 不抑制（保持现状：宁可多报，不误杀）。

新增纯 reducer `nextPendingState({ previousPending, previousWaiting, topPending, unreadTop, waitingNow })`：

- `waiting = (previousWaiting ∩ unreadTop) ∪ waitingNow`（只保留仍为 unread 的等待项；父会话转成 `pendingInteraction` 时立即移出等待集）。
- `pending = topPending − waiting`；`fresh = pending − previousPending`。
- 返回新的 `{ waiting, pending, fresh }`；实现约定 `waiting` / `pending` 为 Set，`fresh` 为数组（与既有 `detectFresh` 的返回风格一致，控制器按数组消费）。

### 14.2 控制器状态机

- 控制器新增内存字段 `waitingIds: Set<string>`（构造函数初始化，`reset()` / `dispose()` 清空；不写盘、不跨刷新）。
- 每次 `onStatus()`：
  1. `collect()` 后由 `detectFresh` 得到 `current`（顶层待处理，含等待中）；过滤 `pendingKindOf === 'unread'` 得到 `unreadTop`。
  2. `waitingNow = waitingParentIdsOf({ statuses, sessions })`。
  3. 调 `nextPendingState`，写回 `this.waitingIds` / `this.pendingIds`。
  4. `publish(collected)`；折叠/恢复用新的 `pending` 与 `fresh`；仅当 `fresh.length > 0` 时 `notify`（`fresh` 已不含等待项）。
- `publish()` 的 `visible` 在 `excludeMain` 之后再过滤 `this.waitingIds`（同时影响 `pending` / `blocking` / `collapsed` / `collapsedCount`）；`running` 仍用全量 `runningCountOf`。
- 非 `sessionStatus` 触发的 `publish()`（sessions.list / workspaces / selection）沿用当前 `waitingIds` 过滤，**不重算、不扩展**等待集：等待判定只在状态变化时更新，避免「最后一个子会话刚结束、父会话还没被唤醒」的间隙被重新当成待处理。父会话离开 pending 的事件（running→true、成为主视图清除 unread、交互被处理）会经 `onStatus` 把它移出等待集。
- 收起集（§11.2）只包含可操作项：`collapse()` 用 `this.pendingIds`（已排除等待项），`nextCollapsed` 的自动恢复只看 `fresh`。等待项不进入收起集；整批结束的最终未读作为 fresh 正常触发恢复与通知。

### 14.3 边界与已知限制

- 首帧基线（`primed === false`）不通知；等待中的父会话直接不进列表。
- 子智能体自己的会话仍按 §10 完全过滤；子智能体卡在等批准/等回答时不会单独列出——这是既有独立缺口，本次不修，但等待抑制会让它更安静（明确记录，避免误以为已覆盖）。
- 父会话若因异常一直不被唤醒且保持 unread，会一直隐藏；正常子智能体完成事件会唤醒父会话，本次不做超时兜底（YAGNI）。
- 快照时序风险：若父会话 `running → false` 的状态先于子会话 `running` 状态到达，首帧可能判不成等待而误弹一次。事件顺序离线不可造，先按快照实现；人工验收（§14.5）若复现，再补一个短暂 settle 延迟（例如 250ms 内重新确认等待集）。
- `completionUnread` 纯客户端内存、刷新即丢等既有已知限制不变。

### 14.4 测试

- `waitingParentIdsOf`：直接子会话 running；嵌套孙会话 running；子会话只有 unread 不算活跃；子会话 `pendingInteraction` 算活跃；父会话自身 `pendingInteraction` 不进入等待；父会话 running；缺 `parentSessionId` / 孤儿行；多父会话；环保护。
- `nextPendingState`：进入等待 → 子会话停止但父仍 unread 时保持 waiting；父离开 `topPending` 后移出；父转成 `pendingInteraction` 后立即移出并成为 actionable；最终 unread 产生 fresh。
- 控制器行为（通过纯函数 + 既有集成命令覆盖）：等待项不进 `buildItems` 结果（publish 过滤）、不产生 fresh、不进入收起集。
- 既有 `detectFresh` / `buildItems` / 子智能体过滤用例不回归。
- **冻结集成命令（唯一一条）**：`node plugins/pending-sessions/test.mjs`（仓库根执行，覆盖本批全部改动）。

### 14.5 人工验收

1. 主控派 2 个子智能体后切到别的窗口（DSH 失焦）。
2. 两个子智能体逐个完成时：**不**应收到主控会话的「未读回复」通知；悬浮条只显示「N 运行中」。
3. 主控最终跑完整个任务：收到**一条**「未读回复」通知；悬浮条出现父会话条目，点击可跳转。
4. 对照：普通会话（无子智能体）回合结束仍按原行为通知。
5. 嵌套场景：主控 → 子智能体 → 孙智能体，孙智能体运行期间主控不应通知。

### 14.6 实现与判级

- 改动文件：`plugins/pending-sessions/client.js`（新增两个纯函数 + 控制器 `waitingIds` / publish 过滤 / onStatus 接线）、`test.mjs`（新用例）、`README.md`（行为表 + 已知限制 + 人工验收一条）、本 spec。`package.json` 版本 0.3.1 → 0.3.2（bugfix patch）。
- i18n：无新键；locale/*.json 不改。
- **判级**：非 gated（无契约面、无外部环境）；单文件 `client.js` 约 +60 行、test.mjs 约 +100 行，非机械改写 → 全批；同文件/同测试文件，单批串行，无并行写。免独立评审，主控复跑冻结集成命令 + diff 自查。

## 15. 修订（2026-11-08 第七轮）：新待处理自动展开面板

**问题**（用户实测报告）：待处理到来时提醒只体现在药丸上（数字 / 警示色），面板不会自动展开；用户怀疑「启动时默认被设置成收起状态」。

**取证结论**（只读核对，不是收起状态 bug）：

| 疑点 | 事实 | 依据 |
|---|---|---|
| 启动默认收起 | 收起集是内存字段，构造即空集；`reset()` 也清空；首帧快照（`primed === false`）把 `fresh` 强制置空，不产生折叠边沿 | `client.js:862`、`client.js:1123`、`client.js:963` |
| 收起状态写盘 | 全插件唯一持久化 key 是药丸位置 `pending-sessions/pill-position` | `client.js:579` |
| 自动展开被实现过 | 全历史 `git log -S "setExpanded(true)"` 只命中初始提交，且唯一调用在药丸 `onClick` 里 | `client.js:1375` |

真实原因：**自动展开从未实现**。`expanded` 是渲染器局部 state、默认 `false`（`client.js:1197`），§5 原本只定义「点击药丸展开」。README 里「新待处理出现自动恢复」指的是**解除临时收起**（§11.2），不是弹出面板；系统通知只在窗口失焦时发（§5.1）。因此窗口聚焦且未点药丸时，提醒确实"只存在于药丸里"。

**决策**（用户已确认，三轮问答冻结）：

1. **任何**新待处理边沿（沿用 §5.1 的 `fresh` 判定口径）→ 自动展开面板，无需点击药丸；
2. **不看窗口焦点**：失焦时也把面板置为展开，切回 DSH 即可见（系统通知规则不变：仍只在失焦时发）；
3. 用户主动「暂时收起」后**不**自动展开：新待处理只恢复药丸计数 / 警示色（§11.2 语义不变），手动点药丸仍可展开；
4. 页面首次加载 / `connection/reset` 的基线快照**不**展开，只显示药丸计数（与通知同口径，避免每次启动弹面板）。

### 15.1 判定与纯函数

新增纯函数 `autoOpenOf({ primed, collapsedBefore, fresh, visibleIds })` → boolean：

- `primed !== true` → `false`（基线快照不是边沿）；
- `collapsedBefore === true`（折叠**前**收起集非空，即用户主动收起）→ `false`；
- `fresh` 必须是非空数组，且至少有一个 id 落在 `visibleIds`（Set 或数组，兼容畸形输入）里 → `true`；否则 `false`。这一条让被 `excludeMain` 剔除、被 `waitingIds` 抑制的 fresh 不会误开面板；
- 任何输入为 `null` / `undefined` / 畸形类型 → `false`，不抛错。

**时序要点**：控制器必须先取 `collapsedBefore = this.collapsedIds.size > 0`，再调用 `nextCollapsed`。§11.2 的「新进入自动恢复」会把收起集清空，判定放在折叠之后就永远看不到"用户收起着"这个事实。

### 15.2 控制器与渲染器接线

- 控制器新增内存字段 `autoOpenSeq: number`（构造为 `0`；`reset()` **不清零**，保持单调，避免重放已消费的序号）。初值也写进 `createStore` 的初始快照。
- `onStatus()` 顺序：取 `collapsedBefore` → `nextCollapsed` → 计算本次可见 id 集（`excludeMain(...)` 再过滤 `waitingIds`，与 `publish()` 同一份语义）→ `autoOpenOf(...)` 为真时 `this.autoOpenSeq += 1` → `publish(collected)`。
- `publish()` 快照增加 `autoOpenSeq` 字段。
- 允许（并建议）把「`excludeMain` + 过滤 `waitingIds`」抽成一个 `project(data)` 小函数，由 `publish()` 与 `onStatus()` 共用，避免两处过滤逻辑漂移。
- 渲染器新增 `openSeqRef` 与一个无依赖数组的 `useEffect`：读快照 `autoOpenSeq`（非有限数字按 `0`），首次渲染只记录不展开，之后序号变大则记录并 `setExpanded(true)`。
- 面板已展开时重复展开是无害 no-op：不抢焦点、不发声、不重置列表滚动、不改 `expanded` 的既有语义（仍是渲染器局部 state）。
- 不新增持久化、不写盘；i18n 无新键，`locale/*.json` 不动。

### 15.3 边界与已知限制

- **启动基线不展开**（决策 4）：页面打开时已存在的待处理只显示药丸计数，之后新发生的边沿才展开。
- **收起态不展开**（决策 3）：药丸计数 / 警示色照 §11.2 恢复，但面板保持关闭；用户点药丸手动展开。收起集清空后（手动恢复，或收起 id 全部处理完）再来新待处理即恢复自动展开。
- 失焦时展开的面板会一直开着，切回窗口即见——这是决策 2 的预期收益，不是残留状态。
- 自动展开不改变 HMR 重挂丢 `expanded` 的既有已知限制。
- fresh 条目全部被主视图排除或被等待抑制时不开面板（避免"弹了个空面板"）。
- 刷新后基线不展开 + 收起集纯内存（§11.2）不变。

### 15.4 测试

- `autoOpenOf`：边沿 + 未收起 + 有条目 → `true`；`primed === false` → `false`；`collapsedBefore === true` → `false`；`fresh` 为空 / 非数组 → `false`；fresh 全部不在 `visibleIds` → `false`；fresh 有一个在 `visibleIds`（分别用 Set 与数组两种形态）→ `true`；`visibleIds` 畸形、入参为 `null` → `false`。
- 既有 `nextCollapsed` / `shouldNotify` / §14 用例不回归。
- **冻结集成命令（唯一一条）**：`node plugins/pending-sessions/test.mjs`（仓库根执行，覆盖本批全部改动）。
- 纯函数覆盖不到的接线（`autoOpenSeq` 递增、渲染器 effect 消费）离线不可造，由 §15.5 人工验收覆盖。

### 15.5 人工验收

1. 开两个工作区：A 触发 agent 提问（等回答），B 跑完一个回合（未读）→ 面板**自动展开**（无需点药丸），条目正常显示。
2. 点面板「×」关掉 → 再制造一次新待处理 → 面板再次自动展开。
3. 点「暂时收起」→ 制造新待处理 → 药丸计数恢复但**不**弹面板 → 点药丸手动展开；收起集清空后再制造新待处理 → 自动展开恢复。
4. 切到别的窗口（DSH 失焦）→ 制造新待处理 → 收到系统通知；切回 DSH → 面板已展开可见。
5. 刷新 / 重启 DSH，若已有待处理 → 只显示药丸计数、不弹面板；之后新发生的待处理自动展开。
6. 子智能体场景：子智能体逐个完成时父会话被抑制（§14）→ 面板不应因这些中间状态自动展开。

### 15.6 实现与判级

- 改动文件：`plugins/pending-sessions/client.js`（纯函数 `autoOpenOf` + `autoOpenSeq` + `onStatus`/`publish` 接线 + 渲染器消费 effect）、`plugins/pending-sessions/test.mjs`（新用例，并把 `autoOpenOf` 加进 `plugin.pure` 解构）、`plugins/pending-sessions/README.md`（行为表 + 人工验收 + 已知限制）、本 spec、`plugins/pending-sessions/package.json`（0.3.2 → 0.4.0）。
- i18n：无新键；`locale/*.json` 不改。
- **判级**：非 gated（无契约面、无外部环境）；`client.js` 约 +35 行、`test.mjs` 约 +60 行，非机械改写 → 全批；与既有批次同文件，单批串行，无并行写。免独立评审（非 gated），主控复跑冻结集成命令 + diff 自查。
