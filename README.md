# dsh-extensions

本机 DeepSeek Harness（DSH）的工具链扩展集合。**与任何业务项目无关**：多个项目共用同一套扩展，插件按 DSH profile 安装，跟着开发机走。

## 目录约定

```
LICENSE                     # MIT
.github/workflows/test.yml  # push/PR 时跑 node test.mjs
plugins/
└── <plugin-name>/
    ├── package.json        # name + dsh.bundle.patch + exports（含 ./locale/*.json）
    ├── cordis.patch.yml    # bundle 层：插入插件行与默认配置
    ├── plugin.mjs          # 实现（cordis 插件：name / inject / apply）
    ├── locale/             # 插件页显示元信息：en.json 必需，zh.json 等按语言加
    ├── test.mjs            # 离线回归（node test.mjs，零依赖）
    └── README.md           # 行为、配置项、验证方法、已知坑
```

新增插件时复制这个骨架即可；**不要**把插件做成单文件散落在根目录——GUI 只认带 `dsh.bundle.patch` 的包。`locale/en.json` 是插件页标题/描述的最低要求（缺了会回退成包名），并且 `package.json` 的 `exports` 必须放出 `./locale/*.json`，否则读不到。

## 插件清单

| 插件 | 作用 |
|------|------|
| [`subagent-model-pin`](plugins/subagent-model-pin/README.md) | 子 agent 默认跑低成本模型，委派时显式传 `provider`/`model` 可升级 |

## 安装（bundle 为标准方式）

### 标准：GUI / CLI 装 bundle

桌面版或 Web 的侧栏 **插件** → **添加插件** → **安装第三方插件**，填 Git 地址（多插件仓库要带子目录）：

```
https://github.com/huip1830-debug/dsh-extensions.git#path:/plugins/subagent-model-pin
```

CLI 等价：

```powershell
dsh plugin --profile desktop add "https://github.com/huip1830-debug/dsh-extensions.git#path:/plugins/subagent-model-pin"
```

安装会写 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles` 末尾追加）并用 pnpm 装包；装完在插件页可见/可开关。**升级** = 同一条地址重新安装，或在插件页卸载后重装。

装完要**重启 DSH**（profile 层插件不支持热加载），并**新开会话**（`allowedModels` 白名单按会话冻结）。

## 约定

- 改插件只改仓库里的源码，改完跑 `node test.mjs`；bundle 方式安装的，profile 里是 pnpm 的副本，需要重装才生效。
- 插件参数写在各自的 `cordis.patch.yml` 里作默认值；不同机器要用不同值时，在 profile 的 `cordis.patch.yml` 用同 id 覆盖（`config` 整体替换，不深合并）。
- 不放业务代码、不放密钥；`apiKeyEnv` 之类只写变量名。
