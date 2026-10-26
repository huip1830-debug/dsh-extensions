# dispatch-protocol 0.4.1 补丁方案（契约冻结）

> 日期：2026-10-26
> 依据：评审主文档 §10.3（三样本实证）、接续手册 §5 候选清单。
> 范围：I3（两档拆分+git 匹配+文案）、I4（观测行去重）、I5（重定向正则误报）、P1-②（安装核验脚本）、只读 label 约定进 footer。**不做**：I1 角色表本身（profile 侧派发方手改）、I2/I6/I7/I8（划归 0.5.0 或记录）。

## 1. I5 + git 匹配：改 `DEFAULT_PWSH_MUTATION_PATTERN`（nudge.mjs:36）

冻结为：

```js
export const DEFAULT_PWSH_MUTATION_PATTERN = /\b(Remove-Item|Set-Content|Out-File|Add-Content|Clear-Content|New-Item|Copy-Item|Move-Item|Rename-Item|ri|del|erase|ren|rename|move|copy|mkdir|rmdir|rd|tee)\b|(?<![\d&=\-?])>{1,2}(?![&=\d])|\bgit\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?(apply|checkout|restore|commit|merge|rebase|cherry-pick|rm|mv|clean)\b/i
```

两处变化：
- **重定向分支 lookbehind 加 `=`/`-`/`?`**：排除 `=>`（箭头，`>` 后随字符非 `&=\d` 所以只能靠 lookbehind 排 `=`）、`->`、泛型 `<string?>`。已知残留：裸 `<T>`（`>` 前是字母）仍命中——接受，三样本未出现，注释记为 accepted limit。
- **git 分支支持 `-C <path>`**：`git -C <path> commit` 此前漏计（S6 t6）。路径支持裸词与单/双引号。

必须保持不命中：`git status --short`、`dotnet build 2>&1`（lookbehind 的 `\d`/`&`）、`git log`、字符串 `"$rev => $($x)"`。
必须命中：`echo hi > out.txt`、`git add -A; git commit -m x`、`git -C G:\path commit -m x`、`Remove-Item x`。

## 2. I3 两档拆分：新增 `DEFAULT_PWSH_NUDGE_SHELL_PATTERN`

- 新导出：与 mutation 全量同构，但 git 动词去掉 `commit`（`(apply|checkout|restore|merge|rebase|cherry-pick|rm|mv|clean)`）。注释写明依据：**提交权归派发方**——主控自己的 commit 不应把回合推过 nudge 阈值（实证 4 例：样本四 T3、S5 t34、S6 t13、S7 t2）；checkpoint 的只读判定仍用全量（子代理做 commit = 执行类，不豁免）。
- `summarizeTurn(events, turn, config)` 的 shellWrites 改用 nudge 档（函数签名加可选第 4 参 `shellPattern = DEFAULT_PWSH_NUDGE_SHELL_PATTERN`，内部 205 行处改用它）。`callTouchesFile` 不变（仍全量）。
- **接受代价并写注释**：纯 `git commit` 回合不再产生观测行（shellWrites=0 → observeTurn 早退）；提交证据由 git 历史承担，观测行只管工作区内容变更。`git checkout -- <file>` 仍计入（还原工作区文件是内容变更）。

## 3. I3 文案：renderNudge/formatFiles 口径分离

- `{fileCount}` = `summary.files.length`（不再加 shellWrites）；`{writes}` = `summary.writes`（不再加 shellWrites）。
- `DEFAULT_NUDGE_TEXT` 改为：
  `'[dispatch-protocol] 本回合写入 {fileCount} 个文件（{writes} 次）：{files}。派发 0 次，也没有说明理由。要么一行给出不派发的理由，要么改为派发。'`
- `formatFiles` 不变（shell 仍以「另有 N 条 shell 变更命令」附在文件清单后；files 空时整句就是 shell 说明）。
- 效果：S7 t2 形态渲染为「写入 1 个文件（1 次）：<spec>，另有 1 条 shell 变更命令」；S5 t34 形态为「写入 0 个文件（0 次）：另有 2 条 shell 变更命令」（且按 §2，commit 不再计入后该回合不触发）。
- 阈值语义不变：`shouldNudge` 的 touched = files.length + shellWrites（nudge 档）。

## 4. I4：观测行按 (session, turn) 去重（plugin.mjs）

- `registerReminders` 内新增 `const lastObservedTurn = new Map()`（parentId → turn）。
- `observeTurn` 开头：`if (lastObservedTurn.get(parentId) === turn) return`；成功 append 后 `lastObservedTurn.set(parentId, turn)`。
- **保留首行**（自然回合收尾时的快照）；steer 后的第二行丢弃。注释写明依据：三样本 7 对重复行与 steer 一一对应（§10.3-I4）；steer 后的额外 step 是模型回应提醒，不是新证据；若该 step 真产生新写/派发，属于下一回合口径的已知取舍。

## 5. footer 加只读 label 约定（config.mjs DEFAULT_FOOTER）

末尾追加一句：

```
只读类子代理（评审/复审/勘察）的 label 一律以「只读」或「勘察」开头（如「只读评审：…」）——角色表按此前缀收窄沙箱与路由，执行类批次的 label 不得以这两个词开头。
```

依据：subagent-model-pin 是 label 字面前缀匹配；「评审」前缀不可配（S7「评审修复批」是执行批）；S6 已自然使用「只读评审：…」。**这条不改不生效沙箱**：profile 角色表由派发方另改（不在本批次）。

## 6. P1-② 安装核验脚本（Batch B）

- 新文件 `plugins/dispatch-protocol/scripts/verify-install.mjs`，命令：`node plugins/dispatch-protocol/scripts/verify-install.mjs [--profile desktop]`。
- 检查项（每项输出 `[PASS] name — detail` 或 `[FAIL] name — detail`）：
  1. `installed-dir`：`~/.dsh/profiles/<profile>/node_modules/dispatch-protocol/` 存在；
  2. `version`：installed package.json.version === 仓库 plugins/dispatch-protocol/package.json.version（仓库根相对脚本 `../../..` 解析）；
  3. `files`：仓库插件目录（排除 node_modules）每个文件与 installed 逐字节一致；缺失/不一致逐个列；
  4. `profile-roles`：`~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `roles:` 段内存在 `- match: 只读` 与 `- match: 勘察`，且各自块内（到下一个 `- match:` 为止）含 `sandbox: read-only`。行级解析即可，不引 YAML 依赖。
- 退出码：全 PASS → 0；任一 FAIL → 1。只读脚本，不写任何文件。
- 当前（修复前）预期输出：version FAIL（0.4.1 vs 0.4.0）、files 若干 FAIL → exit 1——**检测到漂移即正确**；profile-roles 视 profile 状态而定：roles 未修时报 FAIL ×2，已修（2026-10-26 起本机已加只读/勘察）时 PASS ×2。

## 7. 版本与文档

- package.json → `0.4.1`。
- README.md 加 0.4.1 变更段（I3/I4/I5/footer 约定/verify-install）。

## 8. 批次与验收

| 批次 | 白名单（互斥） | 窄验证 |
|---|---|---|
| A 插件本体 | `plugins/dispatch-protocol/lib/nudge.mjs`、`plugins/dispatch-protocol/plugin.mjs`、`plugins/dispatch-protocol/lib/config.mjs`、`plugins/dispatch-protocol/test.mjs`、`plugins/dispatch-protocol/package.json`、`plugins/dispatch-protocol/README.md` | `node plugins/dispatch-protocol/test.mjs` |
| B 核验脚本 | `plugins/dispatch-protocol/scripts/verify-install.mjs`（新建） | `node plugins/dispatch-protocol/scripts/verify-install.mjs; exit code ∈ {0,1} 且每行匹配 [PASS]/[FAIL]` |

集成验收（派发方复跑）：`node plugins/dispatch-protocol/test.mjs` + `node plugins/dispatch-protocol/scripts/verify-install.mjs`（当前应 FAIL 检测出版本与 roles 漂移）+ 只读评审 diff。
