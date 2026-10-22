# subagent-model-pin 插件页配置卡片 · 设计

- 日期：2026-10-22
- 状态：已获用户批准（方案 A）
- 目标读者：实施者（本仓库 maintainer / agent）

## 背景与目标

`plugins/subagent-model-pin` 目前只能改 YAML（bundle/profile 的 `cordis.patch.yml`）调配置，字段多、`config` 整体替换容易漏行丢配置。目标：在 DSH 插件页给本包加一张配置卡片，覆盖 4 个高频字段（`provider` / `model` / `reasoningEffort` / `debug`），其余字段（`roles` / `force` / `depth` / `injectDelegationDefaults`）继续只走 YAML。

已确认的契约事实（2026-10-22 对 DSH desktop 0.2.1-rc.2 app.asar 解包勘察，证据链见勘察报告与台账）：

1. 第三方 bundle 的浏览器半区在生产模式可加载（无官方白名单）。硬约束：
   - client 入口必须是手写/已构建的 lazy-CJS 注册脚本 `window.__ModuleLoader__.load({id, factory})`，不能 ESM/JSX/TS，Host 按字节直读、不做转译；
   - 模块 `id` 必须等于 npm 包名（`subagent-model-pin`）；
   - 入口文件必须已存在（`exports["./client"]` 指向真实文件），缺失会让 Host 启动失败（MissingClientBundleError）；
   - 运行时 `require` 只允许平台种子模块（react / react-dom / react/jsx-runtime / dsh-client-ui-primitives 等）+ 在 `dsh.client.external` 声明且由已加载 row 提供的模块；
   - bundle 激活时快照进内存，改 client.js 后需重启 DSH。
2. 配置卡片 slot：`plugins.bundle.config`，key = bundle 的 npm 包名；`configLedger` 只收集注册项 `options.key`。官方先例：cot-translation、voice-input（均自绑数据源，不用页面 `form` prop——该 prop 零官方消费者）。
3. settings 写读链路：命名空间 = profile entry id（即 patch 行 id `subagent-model-pin`）；Host 只投影 `Config` schema 里标 `.volatile()` 的字段；写操作（`remote.settings.mutate`，ops = `{op:'set'|'unset', path, value}`，带 expectedRevision）落盘到 profile 的 `cordis.patch.yml` 覆盖行；冲突报 `settings/conflict`，校验失败报 `settings/rejected`。官方先例：`subagent-model-selection-settings`（`dsh-tool-subagent/lib/model-selection-settings.js`），运行期 `config.<field>.get()` 现取。
4. 模型目录：`remote.session.modelCatalog()` → `{ default, routableProviders, groups[], failures[] }`；`groups[].models[].reasoning = { efforts[{id,name,description?}], defaultEffort? }`（无 efforts 即不支持档位）；失败按 provider 隔离。官方客户端在 `llm/adapters-updated` / `settings/document-updated` / `connection/reset` 时重拉。

## 用户已拍板的决策

- **方案 A**：同包升级 + `plugins.bundle.config` 卡片（不选 row.config——零官方先例；不选独立设置页——入口更深）。
- **合并语义**：界面只覆盖它管的 4 个字段（= schemastery `.volatile()`），roles 等其余字段界面碰不到。
- **重置**：卡片提供「恢复 YAML 配置」按钮（对 4 个 volatile 字段发 `unset`）。

## 总体架构

一个包同时是 bundle + Host 行 + 浏览器半区（与官方 `templates/decoration` 同构）。不改包名、不新增包、不新增构建步骤（client.js 手写纯 JS）。

```
plugins/subagent-model-pin/
├── package.json        # 加 exports["./client"]、dsh.client 声明、schemastery 依赖
├── cordis.patch.yml    # 不变（行 id subagent-model-pin = settings 命名空间）
├── plugin.mjs          # 改造：schemastery Config + volatile 现取
├── lib/routes.mjs      # 小改：resolveRoute 解包 volatile
├── client.js           # 新增：手写 lazy-CJS 配置卡片（~300 行）
├── locale/{zh,en}.json # 扩充卡片文案
└── test.mjs            # 扩展：volatile 优先级 / 回落 / debug 热切换
```

## Host 侧改造（plugin.mjs / lib/routes.mjs）

```js
export const Config = z.object({
  provider:        z.string().default('').volatile(),    // 界面可写
  model:           z.string().default('').volatile(),    // 界面可写
  reasoningEffort: z.string().default('').volatile(),    // 界面可写（'' = 跟随 YAML/模型默认）
  debug:           z.boolean().default(false).volatile(),// 界面可写
  roles:           z.array(roleSchema),                  // 非 volatile：界面不可写
  force:           z.boolean(),
  depth:           z.number(),
  injectDelegationDefaults: z.boolean(),
})
```

- 运行期取值：所有读 config 路由字段的地方每次调用时经 `readVolatile()`（`.get?.() ?? 原值`）现取，不缓存 → **界面保存后无需重启 DSH 即作用于后续委派**。
- debug 顺带升级为热切换：`log()` 每次写前查 `config.debug.get()`，不再 apply 时固化。
- 必填校验保留：apply 时解包后 provider/model 仍为空（YAML 没写且界面没存过）→ 照旧抛错。
- 三个扩展点、显式升级放行、roles 匹配、sandbox 收窄逻辑全部不变，仅取值多一层解包。
- schemastery 的确切 import 说明在实现期照 `dsh-tool-subagent` 核对，不自创。
- 行为警告（写进卡片与 README）：新 pin 路由必须在「允许 Agent 为子智能体选择模型」白名单内，否则注入式委派被拒；白名单按会话冻结，需新开会话。

## 客户端卡片（client.js）

外壳：

```js
window.__ModuleLoader__.load({
  id: 'subagent-model-pin',
  factory(require) {
    const React = require('react')
    return { inject: ['slots', 'locale', 'remote', 'configForms'], apply(ctx) { ... } }
  },
})
```

注册（官方 4 个设置页同款模式，自绑 configForms，不依赖 `form` prop）：

```js
const scope = ctx.configForms.get('subagent-model-pin')
ctx.configForms.whileServed(['subagent-model-pin'], () =>
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      { name: 'plugins.bundle.config', key: 'subagent-model-pin', locale: NS, inject: () => cardFace },
      PinConfigCard)))
```

`whileServed` 保证 Host 未 serve 该命名空间时（旧版插件未升级）卡片不出现。

视图与控件：

| 视图 | 内容 |
|------|------|
| `summary` | 一行 `provider / model · effort X`；存在界面覆盖时加「界面覆盖」徽标 |
| `page` | 生效提示条 + provider 下拉 + model 下拉（按 provider 过滤）+ effort 下拉（选中模型的 `reasoning.efforts`，首项「跟随模型默认」= unset；模型无 `reasoning` 时禁用并标注）+ debug 开关 + 保存/放弃/重置 |

- 顶部常驻提示：「保存立即写入；debug 立即生效。pin 路由改动作用于此后的委派，但需新开会话且新路由须在子智能体模型白名单内。」
- 保存：`scope.mutate([{op:'set',path:[field],value}…], snapshot.revision)`；`settings/conflict` → 自动刷新快照、草稿保留、提示重试；`settings/rejected` → 显示错误原文。
- 重置：仅当快照显示存在界面覆盖（`user` 非空）时可点，二次确认后对 4 字段发 `unset`。
- catalog：进 page 视图拉取，监听三个刷新事件重拉；`failures[]` 显示降级提示条；拉取失败不清空草稿。
- provider/model 只能从下拉选（不可手输），保证保存的组合在 catalog 内；保存后 provider 被停用的行为与 YAML 写错一致（README 说明）。
- 文案全部走 `locale/{zh,en}.json`；locale 进浏览器的机制实现期照官方 client 包核对。

## 错误兜底

| 风险 | 后果 | 对策 |
|------|------|------|
| client.js 缺失 / exports 指错 | Host 启动失败 | 发布验收第一步验证 Host 启动；`files` 与 exports 一致性纳入检查 |
| 模块 id ≠ 包名 | not-registered，卡片不出现 | id 与 package.json name 同字面值；验收时 DevTools 查 row |
| require 非种子模块 | 工厂抛错 | 只用 react / react/jsx-runtime / dsh-client-ui-primitives |
| client.js 改动不热生效 | 界面不更新 | 开发期改后重启 DSH；文档注明 |
| volatile 解包异常 | 插件崩 | `readVolatile()` 容错，异常回落 YAML 值并写 debug 日志 |

## 测试与验收

1. `node test.mjs`（零依赖离线回归）扩展：
   - harness 的 config 构造与 cordis 的 volatile 包装同形（实现期先验证 schemastery schema 直接调用是否产出 `.get()` 形状；不能则 harness 自包 `{ get() }`，以核到的事实为准）；
   - 新用例：volatile 覆盖优先并即时反映、unset 回落 YAML、debug 热切换；
   - 现有 20 用例适配新 config 形状，行为矩阵不变。
2. probe profile：`dsh --profile probe-tmp --dump-config` 确认组合期无校验报错，`--dump-config-schema` 可见 4 个 volatile 字段。
3. 客户端人工验收清单：插件页出现卡片 → summary 正确 → 改 4 字段保存 → profile `cordis.patch.yml` 出现覆盖行 → 新会话委派 pin 到新路由（逐帧解压会话日志看 `request/context`）→ 重置 → 覆盖行消失回落 YAML → 制造 revision 冲突验证提示。

## 发布步骤

```
node test.mjs 全绿 → commit → push
→ 关闭 DSH（profile 更新在 DSH 运行时 EPERM）
→ dsh plugin --profile desktop update subagent-model-pin
→ 启动 DSH → 过人工验收清单
```

README 同步重写「GUI 配置」一节（改为使用说明 + 机制摘要），配置项表标注 4 个可界面编辑字段，时间线加本轮记录。

## 明确不做（YAGNI）

roles 可视化编辑；force / depth / injectDelegationDefaults 进界面；icon.svg；plugins.row.config；独立设置页。

## 不确定项（实施期核对）

1. schemastery import 说明符与 `.volatile()` 运行期形状（照 dsh-tool-subagent 核）。
2. `Config(raw)` 直接调用能否在测试里产出 volatile 包装。
3. locale JSON 进浏览器的官方机制。
4. `dsh.client.inject` 排序清单的最小集（照官方模板核）。
5. volatile 字段在 settings 文档缺席时回落 patch 值的确切行为（dump-config 验证）。
