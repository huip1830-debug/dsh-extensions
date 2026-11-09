# dispatch-protocol 0.9.1 — 多会话台账（按需求分文件）

> 状态：**冻结，待实现**。派发方：主控。
> 依据：用户 2026-11-09 报告「一个工作区同时开多个会话时，台账混乱、没法维护」，并确认这是真实用法（不是假设）。
> 现状证据：`dispatch/state.md` 是全项目唯一一份单文件台账（本仓库 `dispatch/state.md:1-27`）；观测行已按会话隔离（`plugins/dispatch-protocol/plugin.mjs:555-556` 写 `dispatch/runs/<sessionId>.jsonl`），是现成先例；写入守卫白名单是整棵 `dispatch/`（`lib/write-policy.mjs:28`），不区分会话。

## 1. 问题

| 冲突点 | 现状 | 并行会话后果 |
|---|---|---|
| `dispatch/state.md` | 单文件、所有会话共写 | 后写会话覆盖先写会话的任务清单/冻结契约，交接文档丢失 |
| `dispatch/ledger/<批次>.md` | 文件名按批次 | 不同需求不冲突；同一需求被两个会话接手时互相追加，归属说不清 |
| `dispatch/override.json` | 单文件、只按 mtime 判新鲜度 | A 会话的直改豁免可被 B 会话复用（跨会话越权） |
| `dispatch/runs/<sessionId>.jsonl` | 已按会话隔离 | 无问题 |

本批只解决第一、二行的**不同需求**场景；同一需求并行、override 隔离列为非目标与已知限制（§5）。

## 2. 契约（冻结）

### 2.1 路径

- **新台账**：`dispatch/state/<需求>.md`，一个需求一份；`<需求>` 与 `dispatch/ledger/<需求>.md` 使用同一个 slug（小写 kebab，如 `dispatch-0.9.1-multi-session`）。
- **遗留**：`dispatch/state.md` 保留可读，视为单需求旧台账；**新会话不再覆盖它**（只读）。需要接续时把内容抄进自己需求的 `dispatch/state/<需求>.md`，并在头部注明 `resumedFrom: dispatch/state.md`。
- **观察行**：`dispatch/runs/<sessionId>.jsonl` 不变。

### 2.2 注入文本（`lib/config.mjs` 规则 1）

1. 「只写 dispatch/state.md、dispatch/ledger/*」→「只写 dispatch/state/<需求>.md、dispatch/ledger/<需求>.md」。
2. 规则 1 段末追加一句（逐字冻结）：
   > 同一工作区可能并行多个会话：台账按需求分文件（dispatch/state/<需求>.md、dispatch/ledger/<需求>.md），只写自己需求那份；开工先看 dispatch/state/，同一需求已有进行中的文件时先问用户是否接手，不覆盖别人的。遗留的 dispatch/state.md 只读。

### 2.3 控制面片段（`lib/tool-calls.mjs`）

`DEFAULT_CONTROL_PLANE_PATTERNS` 改为：

```js
['dispatch/state.md', 'dispatch/state/', 'dispatch/ledger/', 'docs/superpowers/specs/']
```

口径不变：大小写不敏感子串、反斜杠归一为正斜杠。`dispatch/state/` 只匹配新目录，不引入 `src/**/dispatch/state.ts` 这类更宽的误豁免。

### 2.4 HandoffGate 文案（`lib/gates.mjs`）

`DEFAULT_HANDOFF_TEXT` 里「先把进度写到 dispatch/state.md」→「先把进度写到 dispatch/state/<需求>.md」。

### 2.5 README

- 交接模板标题 `# dispatch/state.md` → `# dispatch/state/<需求>.md`，正文同步。
- 新增「多会话（0.9.1）」小节：台账按需求分文件；开工先列 `dispatch/state/`；同一需求已有进行中文件先问用户；同需求两会话不仅台账冲突，白名单也会交叉；`dispatch/override.json` 仍是单文件（已知限制，并行时手动删除）。
- 配置表 `gates.controlPlanePatterns` 默认值与闸门豁免段落同步。
- 变更历史新增 0.9.1 一行（依据写本次用户报告）。

### 2.6 版本

`plugins/dispatch-protocol/package.json`：0.9.0 → **0.9.1**。

## 3. 非目标

- 不注入会话 id、不建 `dispatch/sessions/<sessionId>/`：宿主只注册一份静态 `systemPrompt.section`，没有按会话渲染文本的 API，模型拿不到自己的会话 id。
- 不加跨会话总览命令。
- 不把 `override.json` 绑到需求或会话（见 §5）。

## 4. 实现批

- 白名单（只这六个文件）：
  - `plugins/dispatch-protocol/lib/config.mjs`
  - `plugins/dispatch-protocol/lib/tool-calls.mjs`
  - `plugins/dispatch-protocol/lib/gates.mjs`
  - `plugins/dispatch-protocol/test.mjs`
  - `plugins/dispatch-protocol/README.md`
  - `plugins/dispatch-protocol/package.json`
- 测试断言：
  - 默认控制面片段等于 §2.3 的四项；`isControlPlanePath('dispatch/state/x.md')` 为 true，`dispatch/state.md` 仍为 true。
  - 注入文本含 `dispatch/state/<需求>.md`、`dispatch/ledger/<需求>.md` 与「同一工作区可能并行多个会话」。
  - VerifyGate/ReviewGate 对 `dispatch/state/x.md` 的写入免检（不产生脏改动/评审失效）。
  - 既有 97 例不回归（基线实测 `test.mjs` 为 97 个 `test(`，此前写的 107 是勘察口径错误）。
- 窄命令（子代理跑）：`Set-Location plugins\dispatch-protocol; node test.mjs`，exit 0、fail 0。
- 集成命令（主控跑，唯一）：同窄命令 + `node -e "import('./plugin.mjs').then(()=>console.log('PLUGIN_IMPORT_OK'))"`。

## 5. 风险与已知限制

1. **同一需求两个会话并行**：台账分文件后仍会撞（同一 `state/<需求>.md`），且白名单交叉。约定为「先问用户」，不由机制兜底。
2. **`dispatch/override.json` 未隔离**：并行会话里 A 的直改豁免可被 B 复用；mtime 只能挡住「上一个会话的旧文件」。本批不改（需要会话身份，超出宿主 API）。
3. **遗留 `dispatch/state.md` 不自动迁移**：新会话读它、写自己的新文件；旧文件长期留在原地。
4. **`dispatch/state/` 的创建**：由 `write` 工具按需建目录；不放宽任何守卫。

## 6. 发布

提交推送 → 完全退出 DSH（托盘也退）→ `dsh plugin --profile desktop update dispatch-protocol` → 重启 → `node plugins/dispatch-protocol/scripts/verify-install.mjs` 四项 PASS → **新开会话**才生效。

## 7. 验收

- `node plugins/dispatch-protocol/test.mjs` exit 0、fail 0（含新增断言）。
- `node plugins/dispatch-protocol/scripts/verify-install.mjs` exit 0。
- 两处新路径在 diff 中可逐一指认；`dispatch/state.md` 未出现在新增的「可写」文案里。
- 本仓库台账迁移：`dispatch/state.md` → `dispatch/state/pending-sessions-0.4.0.md`；本批写 `dispatch/state/dispatch-0.9.1-multi-session.md`。
