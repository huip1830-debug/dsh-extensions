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
