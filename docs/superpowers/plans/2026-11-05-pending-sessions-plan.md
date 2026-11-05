# pending-sessions 待处理会话悬浮条 · 实施计划（2026-11-05）

权威设计：[`docs/superpowers/specs/2026-11-05-pending-sessions-design.md`](../specs/2026-11-05-pending-sessions-design.md)（唯一权威；与本文冲突时以 spec 为准）。
本计划由实现批落盘：批次清单 + 实现批要点。

## 批次清单

| 批次 | 内容 | 产出 / 判据 | 状态 |
|------|------|-------------|------|
| 0 只读勘察 | 桌面版 asar 内客户端契约（状态信号、工作区归属、跳转、悬浮条落点、slot 注册） | 台账 `dispatch/ledger/2026-11-05-pending-sessions-spike.md`；spec §4/§5 行号 | 已完成 |
| 1 实施前取证 | spec §8 两个遗留点：当前主视图会话 id 取值；纯客户端 bundle 的最小形态 | 结论写入插件 README「实现要点」表与交付报告 | 已完成 |
| 2 实现 | 新建 `plugins/pending-sessions/**`；根 `README.md` 插件清单加一行 | package.json、cordis.patch.yml、plugin.mjs、client.js、locale/{en,zh}.json、test.mjs、README.md | 已完成（本批） |
| 3 窄验证 | 仓库根跑唯一窄命令 | `node plugins/pending-sessions/test.mjs`：退出码 0，23 个用例全过 | 已完成 |
| 4 评审（只读） | 只审变更集：需求原文 + 冻结契约 + 白名单并集 diff + 集成命令结果 | 逐条 PASS/FAIL + 文件:行号；非 gated，可主控复跑 + diff 自查 | 待派发 |
| 5 验收（主控） | 主控复跑唯一集成命令并留存退出码；人工验收按 README | 集成命令：`node plugins/pending-sessions/test.mjs` | 待主控 |

## 实现批要点（spec 冻结，不得偏离）

- **插件形态**：`client.js` 手写 `window.__ModuleLoader__.load({id, factory})` 纯 JS + `createElement`，仅 `require('react')`；`id` = 包名 `pending-sessions`。
- **Host 空实现**：取证确认客户端 bundle 只按激活的 Loader 条目发现（`dsh-client-modules/lib/index.js:852-889`），故 `plugin.mjs` 为 `apply(){}`，`cordis.patch.yml` 只插入该行。
- **inject**：`['slots','locale','sessions','workspaces','uiSession','uiWorkspace']`；控制器照先例 `getSnapshot/subscribe` 模式。
- **判定**：待处理 = `pendingInteraction !== undefined || completionUnread === true`；`pendingInteraction.kind` ∈ approval / question / plan-review。
- **排序**：阻塞类整体在前，未读类在后；两类内部各自按 `updatedAt` 倒序。
- **排除**：当前主视图会话不进列表；主视图 id 取 `uiWorkspace.selection` 快照，回退 `retainedBy.mainView`。
- **UI**：注册 `shell.overlay`（list/root），右下角悬浮条；收起态药丸计数（含阻塞类时警示色），点击展开列表；列表项 = 状态点 + 类型标签（等批准/等回答/计划复核/未读回复）+ 工作区名 + 会话标题，点击 `ctx.uiWorkspace.openSession(sessionId)`；空列表整体隐藏；CSS 注入式 `<style>` + `--dsw-alias-*` 变量；i18n `ctx.locale.register`（zh/en）。
- **系统通知**：边沿触发；`document.hasFocus() === false` 才弹；同 episode 只弹一次；多条合并为一条汇总；首次触发 `Notification.requestPermission()`；被拒静默降级并用药丸 tooltip 提示；点击通知尽力 `openSession` + `window.focus()`。
- **纯函数**：过滤/排序/工作区映射/主视图排除/通知决策抽成 `exports.pure`，`test.mjs` 在 node 下零依赖覆盖 spec §7 全部用例。
- **防御**：任一 inject 服务缺失 → 不渲染、仅 `console.warn`；`connection/reset` 重置订阅并重新播种边沿基线。
- **README**：行为、安装（GUI/CLI）、配置（无）、人工验收（含通知验收）、已知限制（spec §6 四条逐条）。

## 验证

- 本批唯一窄命令，也是主控集成命令：在仓库根执行 `node plugins/pending-sessions/test.mjs`。
- 人工验收步骤见插件 README「人工验收」。

## 预算与红线

- 实现批：墙钟 20 分钟 / 30 次写操作，过半报进度，超预算报阻塞点。
- 不 commit / push；只改白名单内文件；与 spec 矛盾或出现清单外信息 → 停报 NEEDS_CONTEXT。
