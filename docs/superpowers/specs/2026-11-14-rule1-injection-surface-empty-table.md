# dispatch-protocol 0.12.3 — 规则 1「表空即收口」补注入面例外

- 日期：2026-11-14
- 状态：已冻结（用户指示「修复」，修复方案已在会话中确认：规则 1 空表收口加注入面例外）
- 版本：0.12.2 → **0.12.3**

## 0. 问题

规则 1（有界直改·文档批）写「表空即收口且台账写『本批无机制断言』」，未给注入面开例外；规则 4（文档切片）写「AGENTS.md 与 docs/agent/* 属注入面、断言表强制非空」。实际执行中规则 1 的空表收口吞掉了规则 4 的强制非空：注入面文档改动可以凭一句无验证的「本批无机制断言」零评审收口（实测案例：另一仓库 `docs/agent/tplus-integration.md` 评审后改动按表空收口）。D5 反规避三道防线中最关键的一条（注入面强制非空）在规则 1 路径上不可达。

## 1. 冻结契约（唯一改动点）

`lib/config.mjs` 规则 1 文本，精确替换一处：

- old：`表空即收口且台账写「本批无机制断言」，表非空派 1 次有界评审`
- new：`表空即收口且台账写「本批无机制断言」（AGENTS.md 与 docs/agent/* 注入面除外：断言表强制非空、不得空表收口），表非空派 1 次有界评审`

**其余一律不动**：
- `lib/gates.mjs` 的 `REVIEW_DOC_ACTION` 不改——闸门文案「按规则 1/4 交「断言 → 代码位置」表」与新规则不冲突，注入面不得空表由规则文本约束。
- 规则 4 文本不改（「强制非空」已在，缺的是规则 1 的可达性）。
- 0.12.0/0.12.1 的既有断言（`scripts/docs-check.mjs`、`本批无机制断言`、`跑 scripts/docs-check.mjs（无此脚本的仓库记一行台账、不新建脚本）`）必须继续通过——新文本是插入而非替换这些子串。

## 2. 白名单与验收

| 文件 | 改动 |
|---|---|
| `plugins/dispatch-protocol/lib/config.mjs` | 上述一处精确替换 |
| `plugins/dispatch-protocol/test.mjs` | 新增断言：注入文本含 `注入面除外：断言表强制非空、不得空表收口`（挂在 0.12.0 rule-1 测试内或新增一条 test，二选一） |
| `plugins/dispatch-protocol/package.json` | version `0.12.2` → `0.12.3` |
| `plugins/dispatch-protocol/README.md` | 版本历史加 `0.12.3` 一行（含规则 1 正文字符数实测前后值）；「与断言表的分工」一节同步一句：表空收口不适用于注入面 |

集成命令（派发方复跑，从仓库根，两段各跑一次）：
```
node plugins/dispatch-protocol/test.mjs
node plugins/dispatch-protocol/scripts/docs-check.mjs plugins/dispatch-protocol/README.md
```

## 3. 明确不在本次范围

- 不改 gates.mjs 闸门文案；不改规则 4；不动 docs-check.mjs。
- 不给「空表声明」加工具化核验（D5 已裁决：加检索引擎的成本高于它抓到的漏）。
