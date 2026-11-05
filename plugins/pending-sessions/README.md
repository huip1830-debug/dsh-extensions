# pending-sessions

> 部署状态以 profile 安装为准（`dsh plugin --profile desktop list`）。改动后：提交推送 → 关闭 DSH → `dsh plugin --profile desktop update pending-sessions` → 启动。

DSH GUI 插件：**全局右下角悬浮条，列出等你处理的会话**——阻塞等待（等批准 / 等回答 / 计划复核）与回合结束未读回复两类都算。点条目跳转，处理后自动消失（无手动已读）；窗口失焦时尽力弹系统通知。

- 权威设计：[`docs/superpowers/specs/2026-11-05-pending-sessions-design.md`](../../docs/superpowers/specs/2026-11-05-pending-sessions-design.md)
- 实施计划：[`docs/superpowers/plans/2026-11-05-pending-sessions-plan.md`](../../docs/superpowers/plans/2026-11-05-pending-sessions-plan.md)

## 行为

| 场景 | 行为 |
|------|------|
| 会话等批准 / 等回答 / 计划复核（`pendingInteraction`） | 算待处理，归「阻塞类」，药丸显示警示色 |
| 回合跑完但回复未读（`completionUnread`） | 算待处理，归「未读类」 |
| 两类混合 | 阻塞类整体在前，未读类在后；两类内部各自按会话更新时间倒序（最新在前） |
| 当前主视图会话 | 不进列表（已经在眼前） |
| 列表为空 | 整个悬浮条隐藏 |
| 收起态 | 药丸 `● N`；有阻塞类时警示色 |
| 展开态 | 列表项 = 状态点 + 类型标签（等批准 / 等回答 / 计划复核 / 未读回复）+ 工作区名 + 会话标题 |
| 点击条目 | `ctx.uiWorkspace.openSession(sessionId)`，等价侧边栏点击 |
| 处理完 | 全自动消失：跳转使会话成为主视图 → 未读清除；完成交互 → 领域撤销待处理。**不写任何已读表** |
| 窗口失焦 + 会话新进入待处理 | 弹一条系统通知；多条同时出现合并为一条摘要（「N 个会话待处理」） |
| 窗口聚焦 | 不弹通知（人已经在看） |
| 页面首次加载时已在待处理的会话 | 只进列表，不补发通知（通知只认「新进入」的边沿） |
| 通知权限被拒 / 环境不支持 | 静默降级为仅悬浮条，药丸 tooltip 注明「系统通知未授权」 |
| 会话持续待处理 | 同一 episode 只通知一次；处理掉之后再次进入才算新 episode |

## 安装

包已声明 `dsh.bundle.patch`，所以 DSH 插件页可以直接装。桌面版或 Web 侧栏 **插件** → **添加插件** → **安装第三方插件**，填：

```
https://github.com/huip1830-debug/dsh-extensions.git#path:/plugins/pending-sessions
```

CLI 等价：

```powershell
dsh plugin --profile desktop add "https://github.com/huip1830-debug/dsh-extensions.git#path:/plugins/pending-sessions"
```

装完在插件页启用，重启 DSH。升级 = 同地址重装（插件页会提供"更新"）。卸载 = 插件页移除（或 `dsh plugin --profile desktop remove pending-sessions`）。

profile 层插件不支持热加载，**改完必须重启 DSH**；`client.js` 的改动同样要重启才生效。

## 配置

**无配置项**：插件不写盘、不读设置、不提供配置卡片。`cordis.patch.yml` 只插入一行 Host 空插件（见下节），不接收 `config`。要停用就在插件页关掉该组合包，或给该行加 `disabled: true`。

## 实现要点（为什么会有空的 plugin.mjs）

功能全部在浏览器半区 `client.js`，Host 侧没有任何逻辑；`plugin.mjs` 是 `apply(){}` 空实现，只为让 Loader 行存在。依据（2026-11-05 只读取证，DSH 桌面版 `app.asar`）：

| 事实 | 依据（asar 内路径:行号） |
|------|--------------------------|
| 客户端 bundle 按**激活的 Loader 条目**逐条发现：`processOne` 遍历 `ctx.loader.entries()`，跳过 `fiber === undefined` 或 `disabled` 的行 | `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:852-858` |
| 条目被挂载后，从该行的包清单读 `dsh.client.platform` / `exports["./client"]`；`platform !== 'web'` 直接不进 Web graph | `…/dsh-client-modules/lib/index.js:720-750`、`877-889` |
| 同理，声明了 `dsh.client` 却没有 `exports["./client"]` 会直接抛错（激活期聚合报错） | `…/dsh-client-modules/lib/index.js:737-738` |
| 因此只带 `client.js`、没有 Host 入口的包永远扫描不到；bundle patch 插入的 Loader 行必须能 import 到包根 | 同上（`ctx.loader.entries()` 为唯一发现入口） |
| 浏览器半区是手写的 `window.__ModuleLoader__.load({id, factory})` 纯 JS，Host 按字节直读、不转译；`id` 必须等于包名 | `…/dsh-client-modules/lib/index.js:460-505`（boot 协议） |
| 待处理信号：`uiSession.sessionStatus` 是 `Map<sessionId,{running,pendingInteraction,completionUnread}>` | `dsh-client-ui-session/lib/client.js:782-992` |
| `pendingInteraction.kind` ∈ `approval` / `question` / `plan-review` | `dsh-client-ui-approval/lib/client.js:180`；`dsh-client-ui-user-questions/lib/client.js:185` |
| 工作区归属用 `workspaces.items[].sessionIds` 反查（官方侧边栏同款） | `dsh-client-ui-workspace/lib/client.js:1027-1046` |
| 当前主视图会话 id：`uiWorkspace.selection` 快照存储的 `sessionId`（由 `replaceMain` 写入）；回退 `retainedBy.mainView > 0` | `dsh-client-ui-workspace/lib/client.js:1369`、`1652-1675`、`3544`；`dsh-client-ui-session/lib/client.js:973-975` |
| 悬浮条落点 `shell.overlay`（list/root）；overlay 容器 `absolute; inset:0; pointer-events:none`，子元素 `pointer-events:auto` | `dsh-client-ui-workspace/lib/client.js:5306`（注册先例）；`dsh-client-ui-layout/lib/client.js:73`（容器 CSS） |

决策逻辑（过滤 / 排序 / 工作区映射 / 主视图排除 / 通知边沿、节流、合并）全部是 `client.js` 导出的纯函数（`exports.pure`），可在 node 下零依赖回归。

## 离线回归

```powershell
node test.mjs          # 在插件目录内执行；或在仓库根 node plugins/pending-sessions/test.mjs
```

23 个用例，覆盖：三类阻塞信号、未读信号、混合排序（阻塞在前、组内按更新时间倒序）、无归属工作区、`default-workspace` 名称回退、只在状态里出现的会话、当前主视图排除、主视图 id 的两种取法、空列表、通知边沿 / 同 episode 只一次 / 批量合并摘要 / 聚焦不弹 / 权限被拒静默、服务缺失时 `apply` 只告警不激活，以及清单字段与 `locale/*.json`（含与 `client.js` 内置字典的逐键同步）。

## 人工验收

1. 装到 desktop profile → 重启 DSH。
2. 开两个工作区各跑一个会话：A 会话触发 agent 提问（出现「等回答」或「等批准」），B 会话回合跑完（出现「未读回复」）→ 右下角悬浮条计数 = 2。
3. 点开悬浮条：逐项检查状态点 / 类型标签 / 工作区名 / 会话标题；逐项点击跳转并处理 → 对应条目逐个消失；当前主视图那个会话不出现在列表里。
4. **通知验收**：切到别的窗口让 DSH 失焦 → 在某个会话制造一次新的待处理（例如提问）→ 收到系统通知；首次触发应出现浏览器授权请求；两条同时出现时应只收到一条「N 个会话待处理」摘要，而不是两条；点通知尝试跳转到该会话（Electron 下窗口激活与否以实测为准）。
5. 拒绝通知权限 → 不再弹通知，悬浮条 tooltip 显示「系统通知未授权」。
6. 把所有会话处理完 → 悬浮条整体隐藏。

## 已知限制

1. `completionUnread` 是纯客户端内存，刷新页面即丢——本插件是「本次打开 DSH 以来的提示板」，**不是**跨重启的待办清单。
2. 打开页面前就已完成的冷会话不会出现在列表（从未观察到它的 `running → false` 转换）。
3. `pendingInteraction` 较耐久（Remote waterfall 重连重放），但 Host 重启后仍会丢。
4. 系统通知依赖浏览器授权与 OS 通知中心设置；DSH 窗口聚焦时不弹是防打扰设计，不是缺陷。
