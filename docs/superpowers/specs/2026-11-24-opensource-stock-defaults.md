# 开源分发的 stock 默认值（dispatch-protocol 0.23.0 / subagent-model-pin 0.4.0）

> 日期：2026-11-24。派发方：主控。状态：设计已获用户确认（「按照完整方案实施」）。
> 目标：插件本来就是开源 DSH 插件，不是只在本机用——新机器装上后
> 「启用 → 重启 → 新会话」即可用，不需要先手改 profile 的 `cordis.patch.yml`。

## 1. 背景与问题

两个插件 0.22.0/0.3.1 的默认值按本机环境写死，开源用户新装后有三个摩擦点：

1. **默认 pin 路由是本机专属**：model-pin bundle 默认
   `opencode-go/deepseek-v4.1-flash`——本机 profile 手工定义的自定义
   provider。别的机器 provider 不存在，model-pin 静默跳过（fail-open），
   等于装了不生效。
2. **`agentOptions` 硬校验**：dispatch-protocol 0.22.0 给
   `tool-subagent-readonly` 钉的同一路由走 `llm.resolveCallConfig` 预检，
   provider 未注册时 `subagent_readonly` 委派**直接抛错**，不是降级。
3. **白名单 stock 默认关闭**：官方 web bundle 挂了
   `subagent-model-selection-settings` 但无 config（`enabled` 默认 false）。
   无策略时注入路径被当作「仅限父路由」的显式选择——model-pin 注入的
   路由 ≠ 父路由，普通 `subagent` 委派直接报错。

已验证的 stock 事实（DSH 0.2.2）：`dsh-llm-deepseek` 自带 provider
`deepseek-official`，默认模型目录含 `deepseek-flash`（DeepSeek-V4.1-Flash）
与 `deepseek-v4-pro`；两者均不声明 reasoning effort 档位，所以默认路由
**不 pin effort**。`tools/execute` 中间件的 exec 携带 `exec.agent`
（`dsh-tools/lib/pipeline.js`），可读调用会话的事件流。

## 2. 范围

**做**（四项）：

- ① 默认路由换 stock 可用：两个插件的 bundle 默认从
  `opencode-go/deepseek-v4.1-flash` 改为 `deepseek-official/deepseek-flash`，
  不 pin effort（stock 模型无 effort 档位）；
- ② model-pin 注入感知白名单：`tools/execute` 注入前检查调用会话是否有
  `subagent/model-selection-policy` 事件——没有就跳过注入，退回
  `agent/created` 的 `select()` 兜底（不查白名单）；
- ③ README 安装收敛为「装 → 启用 → 重启 → 新会话」；手改 YAML 降级为进阶
  （换路由 / roles 表 / 白名单）；
- ④ verify-install 新增 `whitelist-mode` 提示项：报告 profile 是注入式
  （白名单启用）还是兜底式（无策略），恒 PASS，只把语义差异变可见。

**不做**（边界）：

- 不在 bundle 里覆盖 `subagent-model-selection-settings` 强制启用白名单：
  策略一旦记录，显式选择只允许表内路由、连父路由都不放行，对别的用户是
  行为倒退；
- 不用 env 变量或 `!!js` 探测 provider：patch 求值期拿不到 LLM 注册表；
- 本机 profile 的 model-pin 覆盖不动——已显式 pin `opencode-go`，profile 层
  优先于 bundle 层；本机需要新增的只是 `tool-subagent-readonly` 的覆盖行
  （把评审角色路由钉回 `opencode-go`，见 §3.3）。

## 3. 机制

### 3.1 注入感知白名单（model-pin 0.4.0）

注入等于显式路由选择，显式选择受白名单闸门：无策略时 delegation 工具只
允许父路由。所以注入前检查：

```
hasModelSelectionPolicy(exec.agent)
  = exec.agent.session.snapshotEvents() 里存在 subagent/model-selection-policy
```

- 无策略 → 跳过注入（日志 `skip inject: no policy`），子代理在
  `agent/created` 时被 `select()` 兜底 pin——descriptor 回到继承路由的
  旧语义，但委派永远可用；
- 有策略 → 照旧注入（descriptor / 首请求 / 冷恢复一致）。

策略是否包含 pin 路由仍由用户负责（settings 插件的既有语义，不变）。

### 3.2 stock 默认路由

| 位置 | 旧默认 | 新默认 |
|---|---|---|
| model-pin `cordis.patch.yml` | `opencode-go` / `deepseek-v4.1-flash` / effort `high` | `deepseek-official` / `deepseek-flash` / 不 pin effort |
| dispatch-protocol `agentOptions` | 同上 | 同上 |

没配 DeepSeek API key / 未登录账号的机器：路由解析与委派都能过，首个请求
报明确的认证错误（可诊断），优于「provider 不存在」的静默失效或委派期
抛错。换便宜路由：model-pin 用插件页配置卡（volatile 四字段）；
dispatch-protocol 的 `agentOptions` 在 profile 按 id 整段覆盖。

### 3.3 本机 profile 追加（随本次实施落地）

```yaml
- id: tool-subagent-readonly
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent_readonly
    agentPreset: dispatch-readonly
    modelSelection: false
    agentOptions:
      provider: opencode-go
      model: deepseek-v4.1-flash
      reasoningEffort: high
```

profile 层覆盖 bundle 层（config 整体替换），本机评审角色路由不变。

## 4. 验证

| 检查 | 期望 |
|---|---|
| `node plugins/subagent-model-pin/test.mjs` | 全绿 + 新增「无策略跳过注入 / 有策略照旧注入」用例 |
| `node plugins/dispatch-protocol/test.mjs` | patch 结构断言更新为 stock 路由后全绿 |
| `node plugins/dispatch-protocol/scripts/docs-check.mjs` / `check-anchors.mjs` | `fail=0` |
| `node plugins/dispatch-protocol/scripts/verify-install.mjs` | 新增 `whitelist-mode` 项 PASS；本机报「注入式」 |
| 真机（发布后） | 本机行为不变（profile 覆盖优先）；新会话「只读评审：…」`descriptor.agentModel` 仍 = `opencode-go/deepseek-v4.1-flash` |

## 5. 回滚

- ② 是行为改动：`injectDelegationDefaults: false` 可整体关注入（既有开关），
  或退回 0.3.1；
- ① 是默认值改动：profile 覆盖即恢复任意旧值；
- ④ 只读提示项，删除单行检查调用即回滚。
