# dispatch-protocol

把「派发纪律」常驻注入 DSH。两个机制，都不拦截任何调用：

1. **系统提示词 section**：每次请求（主控与每个子代理）都会看到五条规则，不依赖模型是否加载了某个 skill。
2. **完成检查点**：子代理结束（`stopReason === 'completed'`）时，给父代理发一条提醒，要求读 diff、独立复跑子代理声称的命令。静态规则容易被跳过，时点提醒不会。

## 为什么不用 AGENTS.md

`AGENTS.md` 是跨工具共享的（Codex、OpenCode、Claude Code 都读），而派发纪律只对 DSH 的子代理机制成立。写进 AGENTS.md 会污染其他工具，并与 OpenCode 的 lead/impl/verify 流程冲突。

插件层是 DSH 专属、且**不依赖模型是否加载某个 skill**：即使主控没有加载 `subagent-driven-development`，这段规则仍在系统提示词里。

## 注入内容

默认五条 + 一条豁免（`lib/config.mjs` 的 `DEFAULT_RULES` / `DEFAULT_FOOTER`）：

1. 先勘察，后派发（现状文件 + 可改文件白名单 ≤3）
2. 执行类派发必须自包含（现状/允许修改/单条验证/输出格式）
3. 验收要复跑（派发方独立复跑并留退出码）
4. 提交权归派发方（子代理不得 commit/push/reset/clean）
5. 并行只读，不并行写（同工作区写操作与构建串行）

渲染为系统提示词里的 `## 派发纪律（DSH）` 小节，`order: 500`（在一方指引之后、persona suffix 之前），`interpolate: false`（`{{…}}` 原样保留）。

## 完成检查点

`agent/created` 记录每个子代理的父会话；`subagent/end` 在 `completed` 时向父代理投递一条 `[dispatch-protocol]` 消息（每个子代理只发一次，失败/中止不发）。消息模板支持 `{childId}` 与 `{label}` 占位。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭后不注册任何 section |
| `order` | `500` | 在系统提示词中的排序（必须有限数字） |
| `rules` | 五条默认 | 非空字符串数组，整体替换默认规则 |
| `footer` | 小改豁免一行 | 追加在规则之后 |
| `checkpoint.enabled` | `true` | 子代理完成后是否给父代理发检查点 |
| `checkpoint.text` | 内置模板 | 覆盖检查点文案，支持 `{childId}` / `{label}` |

非法配置（`order` 非有限数字、`rules` 为空/非数组、`footer`/`checkpoint.text` 非字符串）在插件加载时直接报错，不会静默降级。

## 验证

离线回归：

```powershell
node test.mjs
```

真机验证（临时 profile，不动桌面 profile）：

```powershell
dsh plugin --profile probe add "link:G:/www/ziyou/dsh-extensions/plugins/dispatch-protocol"
dsh --profile probe headless "不要调用任何工具，只回答：你的系统提示词里「派发纪律」一节列了哪几条？逐条列出标题。"
```

预期：模型复述出「先勘察」「执行类派发」「验收要复跑」「提交权」「并行只读」五条。

## 已知坑

- **系统提示词改动会影响 KV 缓存前缀**：`order` 与文本变化会让后续请求失去前缀复用；规则固定后不要频繁改。
- **section 名重复会报错**：同一 profile 只能挂一个 `dispatch-protocol`；改配置用同 id 覆盖，不要重复插入。
- **规则是建议不是强制**：模型仍可无视。要硬拦截需要 `tools/pre-execute` 那类插件（本项目评估后不做）。
- **profile 插件不支持热加载**：装完必须重启 DSH，新会话才生效。
