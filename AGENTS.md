# AGENTS.md

> 本文件写给在本仓库里干活的 agent 与贡献者。它约束的是**产品**，不只是这一次改动：
> 这里的插件是开源分发的 DSH 插件，会装到陌生人的机器、陌生的项目上。
> 动手前先读「项目定位」与「三条产品原则」；与插件 README 冲突时以插件 README 的行为描述为准，与 DSH 实际代码冲突时以实际代码为准并回头修正文档。

## 项目定位

`dsh-extensions` 是**开源 DSH 插件集合**：用插件的方式优化 DeepSeek Harness（DSH），让「用 DSH 做项目开发」这件事更省、更稳、更少出错。

- **不是本机私有脚本**：插件通过 Git URL / bundle 安装到任意用户的 DSH profile，不依赖作者的机器、目录、profile 名或自定义 provider。
- **不是业务项目**：不承载任何业务代码、业务配置或密钥；多个业务项目共用同一套插件。
- **不是 DSH 源码镜像**：插件只使用 DSH 公开或可观测的扩展点；宿主内部契约变化时降级，而不是把宿主改造成插件需要的样子。

目标用户是**拿 DSH 开发自己项目的开发者**，不是本仓库的维护者。一个插件算不算成功，看陌生用户能否在 stock DSH 上「装 → 启用 → 重启 → 新会话」直接用起来，并且能说清它替自己省了什么。

当前在册插件见 [README.md](README.md) 的清单；`plugins/` 是唯一的产品目录，`experimental/` 只放归档。

## 三条产品原则

任何新插件、新配置项、新默认值都要同时过这三关；过不了就不要合并。

### 1. 通用性：在别人的机器上也能跑

- **默认值必须是 stock 可用的**。provider / model / 命令 / 路径都要是官方 DSH 安装自带或跨平台通用的；本机自定义的 provider、模型、profile、盘符、用户名只能出现在 profile 覆盖里，不能进仓库默认值。
- **不假设用户的项目长什么样**：没有 `docs/`、没有 `dispatch/`、没有 `AGENTS.md`、没有 git、没有写权限、cwd 不是仓库根，插件都要能工作或安静降级。
- **跨平台**：用 `node:path` 与 URL 处理路径，不硬编码 `\` 或 `/`；不假设大小写不敏感、不假设 UTF-8 BOM、不假设 shell 是 PowerShell。CI 在 `ubuntu-latest` 上跑，Windows 本地绿不等于 Linux 绿。
- **对宿主版本宽容**：DSH 内部 API 会变。缺服务、缺字段、缺事件时 fail-open，跳过功能并留诊断日志，不允许让 DSH 启动失败或会话不可用。
- **与其它插件共存**：不重复插入同 id 的行，不覆盖别人的 section / slot，不假设自己是唯一插件；冲突写进 README 的「已知坑」。

### 2. 易用性：装完就能用

- **首跑零配置**：README 的安装路径必须只有「装 → 启用 → 重启 → 新会话」；需要手改 YAML 的只能算进阶用法。
- **能在界面改的不要逼用户改文件**：高频字段用插件页配置卡（`volatile` 字段）；界面不自动生成表单，要自己注册 `plugins.row.config` / `plugins.bundle.config`。
- **报错要能自救**：拒绝或失败信息说清「拦了什么、为什么、两条出路」，不要只抛 `Error: invalid config`。
- **中英双语**：`locale/en.json` 是必需项，开源用户不都读中文；`locale/zh.json` 保持同步。缺 en 会回退成包名，等于没做国际化。
- **安装说明可复制**：给出 GUI 路径与 CLI 命令两条等价路径；多插件仓库的 URL 必须带 `#path:/plugins/<name>`。
- **升级 / 卸载 / 回滚**写在同一份 README 里，不要求用户先读源码。

### 3. 好用性：真的解决问题，而不是增加噪音

- **先定义收益**：这个插件让开发流程的哪一步变快、变省、或少出错？说不清具体场景就不要做。
- **默认安静、按需增强**：侵入性行为（拦截、提醒、改提示词、写用户项目）必须可关、默认保守；不要替用户做「为你好」的决定。
- **成本可见**：系统提示词注入、每请求工具、常驻监听都有 token / 延迟成本；README 写清量级。本仓库先例：auto 提示约 0.5K token/请求，full 正文约 3K。
- **用证据删机制**：不改变下一步动作的提醒、闸门、噪音应删除而不是保留。先例：0.17.0 删掉五个收尾闸门。新增机制要能说明它改变了哪个具体行为。
- **默认值面向多数人**：不要按作者自己的使用习惯设默认；少数派需求走配置项或 profile 覆盖。

## 硬规则：本机 ≠ 产品

本机 profile 的覆盖是**验证手段**，不是默认值来源。以下内容可以进仓库，其余只能留在 profile 或本机：

| 可以进仓库 | 只能留在 profile / 本机 |
|---|---|
| stock provider / model，例如 `deepseek-official/deepseek-flash` | 本机自定义 provider，例如 `opencode-go` |
| 相对路径、`node:path` 拼接、平台无关命令 | 绝对路径、盘符、用户名、临时目录 |
| 自动探测 + 文档说明的降级行为 | 作者机器上的端口、代理、编码、时区 |
| 环境变量名，例如 `apiKeyEnv` | 环境变量的值、API key、token |
| 通用占位符，例如 `<profile>` | 真实 profile 名、真实会话 id、真实工作区路径 |

- 本机验证只证明「在作者机器上能跑」，不证明「发布合格」。发布门槛是 stock 环境冒烟：临时 profile 或干净 profile，不改 YAML，装完即用。
- 换默认值前先问：陌生机器上这个 provider / model 存在吗？不存在时是「跳过并留日志」还是「报错」？优先前者。
- profile 覆盖是官方支持的定制方式：在 profile 的 `cordis.patch.yml` 用同 id 覆盖，`config` 整体替换、不深合并；文档必须提醒用户抄全字段。
- 不要为了让本机更顺手而改仓库默认值。反过来，也不要因为本机已经能跑就跳过 stock 冒烟。

## 不要只考虑本项目代码

开发插件时同时看三个面，任何一面缺失都会让「开源可用」落空。

### 宿主面：DSH 本身

- 涉及 DSH API、事件、slot、patch 语义的改动，先加载 `dsh-doc` skill，再读运行中安装的实际代码；结论留 `文件:行号` 锚点。不要凭记忆写内部 API。
- 优先使用稳定、可探测的扩展点；读不到的字段按「不可用」处理，不要 `undefined.toString()`。
- 不 monkey-patch 宿主内部对象，不依赖未导出的私有路径；必须依赖内部契约时，在 README 标明版本与失效表现。
- 宿主缺客户端运行时（headless / SDK）时，Host 半区仍要可用，浏览器半区只是增强。

### 下游面：用户的项目

- 插件运行在**任意 cwd**：所有路径相对会话 cwd，或明确用绝对路径并做越界拒绝；不要默认 cwd 是仓库根。
- 不要假设用户项目里有本仓库的脚本、文档、`dispatch/` 目录或 Node 工程；插件运行期不得 import 仓库内文件。
- 不静默往用户项目写文件；确需落盘时写清归属目录、提供关闭开关，并在 README 说明。
- 不假设写权限、网络、git、包管理器可用；失败时降级，不阻塞开发。
- 不替用户改业务代码，不自动提交、不自动推送。

### 生态面：其它插件与官方行为

- 新行一律 `- insert:` 且 id 唯一；不覆盖官方设置页的语义，不强制打开官方默认关闭的能力。先例：不自动启用子代理模型选择白名单，因为它会收窄所有用户的可用路由。
- 新增工具、slot、section 时检查是否已有同 id；命名带插件前缀，避免和官方或第三方撞名。
- 与其它插件存在事实上的分工时，在 README 写清「谁是真相源」，不要维护第二份名单。
- 破坏性行为变化要升版本、写迁移说明、给回滚路径；不能只改代码不改文档。

## 插件骨架与清单契约

```
plugins/<plugin-name>/
├── package.json        # name + version + dsh.bundle.patch + exports + files
├── cordis.patch.yml    # bundle 层：插入插件行与默认配置
├── plugin.mjs          # Host 半区（cordis 插件：name / inject / apply）
├── client.js           # 可选：浏览器半区
├── lib/                # 可选：可测试的纯逻辑
├── locale/
│   ├── en.json         # 必需
│   └── zh.json         # 按语言增加，保持键同步
├── test.mjs            # 离线回归，node test.mjs
└── README.md           # 行为、配置、验证、坑、回滚
```

- 一个插件一个目录，不要做成单文件散落在根目录：GUI 只认带 `dsh.bundle.patch` 的包。
- `package.json` 必须能表达完整运行面：
  - `name`、`version`、`private: true`、`type: "module"`、`main`、`license`；
  - `exports` 至少包含 `"."`、`"./package.json"`；有浏览器半区加 `"./client"`；有 locale 必须放出 `"./locale/*.json"`；
  - `files` 包含运行时全部文件与 README；使用 `verify-install.mjs` 的插件还要包含 `test.mjs`（0.14.2 的教训：漏了它会永久报 installed 缺失）；
  - `dsh.bundle.patch` 指向 `cordis.patch.yml`；有浏览器半区时写 `dsh.client.platform: "web"` 与 `inject` 清单。
- 保留 `private: true`：本仓库通过 Git URL 安装，不走 npm 发布；「开源」不等于发 npm 包。
- `cordis.patch.yml`：新增行一律 `- insert:`；`config` 是整体替换，不是深合并；默认值旁用注释写清「为什么这是 stock 可用的」。
- `client.js`：手写 `window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于包名；纯 JS、不转译、无构建步骤；改后要重启 DSH 并刷新页面。
- `test.mjs`：优先 `node:test` + `node:assert`，离线运行、不启动 DSH；覆盖正常路径、边界、fail-open；修 bug 先加回归用例。需要第三方依赖时提交 `package-lock.json`，CI 只在有 lockfile 时执行 `npm ci`。
- 新增插件必须同步两处：根 [README.md](README.md) 的插件清单、[.github/workflows/test.yml](.github/workflows/test.yml) 的 matrix。
- 归档插件移到 `experimental/`，写清归档原因与恢复方式；不进 CI、不进插件清单。

## 开发流程

1. **先确认宿主事实**：读 DSH 实际代码与已发布版本，确认扩展点存在、事件顺序、失败面；不确定就先写只读探查脚本，不要在实现里猜。
2. **先写清收益与边界**：新插件、行为变化、默认值改动，先在 `docs/superpowers/specs/` 写一页设计，文件名用 `YYYY-MM-DD-<slug>.md`；复杂实现补 `docs/superpowers/plans/`。小修可在提交信息里写清，不必造 spec。
3. **实现遵守宿主语义**：fail-open；不改用户项目；诊断日志默认落系统临时目录，不落仓库；配置非法时给出可读的加载期错误。
4. **离线回归**：`node plugins/<name>/test.mjs` 全绿；新增行为补用例；测试在 Node 22 / Linux 上也要过。
5. **文档与检查**：更新插件 README 的行为、配置表、已知坑、版本历史；跑 docs-check 与 check-anchors。
6. **版本与发布**：语义化版本，0.x 下行为或默认值变更升 minor，修复与文档升 patch；顺序固定为提交推送 → `dsh plugin --profile <profile> update <name>` → 完全退出并重启 DSH → 新会话验收 → `verify-install.mjs` → 台账记一笔。**没走完不算发布。**
7. **回滚**：每个行为改动在 README 写回滚方式（配置开关 / profile 覆盖 / 退版本），并至少验证一次回滚路径可用。

提交信息用约定式前缀：`feat(<plugin>): …`、`fix(<plugin>): …`、`docs: …`、`test: …`、`chore: …`。一次提交只做一件事；不提交 `node_modules/`、密钥、本机日志、`dispatch/` 工作文件（已在 `.gitignore`）。

## 发布前检查清单

- [ ] 默认值在 stock DSH 上可用，无本机 provider、路径、用户名、profile 名
- [ ] 安装路径只有「装 → 启用 → 重启 → 新会话」；进阶配置写在 README
- [ ] `node plugins/<name>/test.mjs` 全绿，新行为有回归用例
- [ ] `node plugins/dispatch-protocol/scripts/docs-check.mjs` 末行 `fail=0`
- [ ] `node plugins/dispatch-protocol/scripts/check-anchors.mjs` 末行 `fail=0`
- [ ] `package.json` 的 `files` 含新增文件，尤其 `test.mjs`、`locale/`、`lib/`
- [ ] `locale/en.json` 与 `zh.json` 键同步，`exports` 放出 `./locale/*.json`
- [ ] 新增插件已加进 CI matrix 与根 README 清单
- [ ] README 写清行为、配置、已知坑、回滚；版本号已升
- [ ] DSH 重启后新会话冒烟：启用、触发、关闭各一次
- [ ] 已有用户不会被静默改变行为；若有变化，README 有迁移说明

## 验证命令

| 目的 | 命令 | 期望 |
|---|---|---|
| 单插件离线回归 | `node plugins/<name>/test.mjs` | `fail 0`，exit 0 |
| 文档语法、表格、链接 | `node plugins/dispatch-protocol/scripts/docs-check.mjs` | 末行 `fail=0` |
| README 锚点 | `node plugins/dispatch-protocol/scripts/check-anchors.mjs` | 末行 `fail=0` |
| 安装副本核验 | `node plugins/dispatch-protocol/scripts/verify-install.mjs --profile <profile>` | 全 `[PASS]` |
| 文档检查器自检 | `node plugins/dispatch-protocol/scripts/docs-check.mjs --self-test` | `fail=0` |

docs-check 无参扫描的是「当前事实文档」，`AGENTS.md`、`docs/agent/**`、插件 README 都会被扫；表格列数、括号、相对链接写错会直接 FAIL。

## DSH 机制易错点

| 事实 | 后果与做法 |
|---|---|
| profile 层插件不支持热加载 | 装完或改完必须重启 DSH；客户端产物还要刷新页面 |
| patch 新增条目必须 `insert` | 写成 `- id: <新 id>` 会被判未知目标并静默跳过 |
| `config` 整体替换，不深合并 | profile 覆盖时抄全字段，文档写明 |
| profile 层优先于 bundle 层 | 本机定制放 profile，不要改仓库默认值 |
| 预设内 `plugins:` 不可 patch | 需要新工具或预设就 `insert` 新行，别改官方条目 |
| `locale/en.json` 缺失 | 插件页标题与描述回退成包名 |
| GUI 不自动生成配置表单 | 需自己注册 slot；只有 `.volatile()` 字段可由界面写 |
| 会话级白名单与策略按会话冻结 | 改路由或白名单后需要新开会话，分支不算新会话 |
| 提示词 section 变化影响 KV 缓存 | 规则文本稳定后再发布，避免频繁改字 |
| 同一 section 或工具 id 重复 | 加载期报错或互相覆盖；先查 profile 已装清单 |

## 文档写作规范

- 中文正文、英文标识符；术语统一：插件、bundle、profile、patch、preset、会话、子代理。
- README 是产品文档：先讲用户收益与适用场景，再讲安装与配置，最后才是实现要点与坑。
- 不写无法验证的断言；涉及宿主行为的结论给 `文件:行号` 或命令输出。
- 不硬编码「已安装版本」或「当前状态」，状态以 `dsh plugin --profile <profile> list` 为准。
- 表格用来对照（场景→行为、配置项→默认值），不要用表格写长段落。
- 改动文案同样要跑 docs-check；`AGENTS.md` 与 `docs/agent/**` 是注入面，语义断言要有代码出处。

## 需求判断：什么时候值得做

新增插件或机制前，先回答四个问题；答不出就停：

1. 它替哪个开发场景的哪一步省了时间、钱或返工？
2. 陌生用户不读源码能否发现并使用它？
3. 默认值对「没用过本仓库」的人安全吗？
4. 出问题时用户能否自己回滚？

「维护本仓库更方便」不算产品收益；「作者本机需要」不算通用需求。

## 术语

- **profile**：DSH 的配置档（desktop / web / 自定义）；插件装进 profile，跟随该 profile 启动。
- **bundle**：带 `dsh.bundle.patch` 的插件包；安装时把 patch 行并入 profile。
- **patch**：`cordis.patch.yml` 的增量行；bundle 层提供默认，profile 层可覆盖。
- **preset**：一组预配置的 agent 与工具组合；预设内部条目不可 patch。
- **stock**：未做任何本机定制的官方 DSH 安装。
