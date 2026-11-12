// 配置键清单（0.12.0）：DOC005 的唯一事实源。清单是**输入面**——用户能写进
// profile patch 的键；`resolveGates({})` / `resolveWritePolicy({})` 解析结果里
// 的派生/镜像字段不算（见下方「不在清单的 4 个字段」）。
//
// 清单 = 对 `resolveGates({})` / `resolveWritePolicy({})` 的返回对象做递归叶子
// 推导（普通对象递归，数组与 RegExp 等非普通对象视为叶子），再减去显式镜像集
// `MIRRORED`。前缀分别是 `gates.` / `writePolicy.`；顺序 = 对象属性的书写顺序，
// 便于人工逐条核对。
//
// 为什么字面写死、不在运行时调 resolve*：`scripts/docs-check.mjs` 是零依赖只读
// 脚本，只该比较字符串；引入闸门/守卫的解析会把它变成「配置是否合法」的检查，
// 而加载期校验抛错时文档检查不该跟着红。
//
// 正确性由测试保证（不靠人工维护）：`test.mjs` 用同一口径推导叶子路径，断言
// `推导 − MIRRORED === CONFIG_KEYS`，并断言 MIRRORED 每一项都仍在推导集合里
// （镜像集自身漂移也会红）。代码新增输入键而未同步清单 → 红；新增镜像字段而
// 未进 MIRRORED → 红（强制分类）。
//
// 不在清单的 4 个派生/镜像字段（出现在解析结果里，但**不是可接受的输入键**；
// 文档把它们写成配置键时 DOC005 必须 FAIL）：
//   - `gates.verify.commitRegExp`：由 `gates.verify.commitPattern` 编译而来；
//   - `gates.verify.controlPlanePatterns`：顶层 `gates.controlPlanePatterns` 的镜像；
//   - `gates.review.controlPlanePatterns`：同上；
//   - `gates.review.docPatterns`：`gates.verify.docPatterns` 的镜像副本
//     （0.10.0 README 曾把它写成配置键——内部字段冒充输入键的真实漂移样本）。
//
// 0.12.0：DOC005 曾按「完整点分键 → 末段属性名」两级兜底。末段兜底会让
// `gates.review.textDocOnly`（0.10.0 已删除）这类只在注释/错误串里出现的名字
// 蒙混过关；现在逐字命中本清单，不再兜底。
export const CONFIG_KEYS = [
  // gates：顶层层级（controlPlanePatterns 解析后同时挂到 verify/review，但只有
  // 顶层这一份是输入键）
  'gates.enabled',
  'gates.controlPlanePatterns',
  // gates.wait
  'gates.wait.enabled',
  'gates.wait.threshold',
  'gates.wait.tools',
  'gates.wait.text',
  // gates.verify（commitRegExp 是 commitPattern 的编译产物，controlPlanePatterns
  // 是顶层镜像，都不是输入键 → 不在清单）
  'gates.verify.enabled',
  'gates.verify.commands',
  'gates.verify.commitPattern',
  'gates.verify.docPatterns',
  'gates.verify.text',
  // gates.contract
  'gates.contract.enabled',
  'gates.contract.patterns',
  'gates.contract.text',
  // gates.review（controlPlanePatterns / docPatterns 都是镜像，不是输入键）
  'gates.review.enabled',
  'gates.review.labelPrefixes',
  'gates.review.text',
  // gates.handoff
  'gates.handoff.enabled',
  'gates.handoff.emptyTurns',
  'gates.handoff.text',
  // writePolicy
  'writePolicy.enabled',
  'writePolicy.mode',
  'writePolicy.allowlist',
  'writePolicy.overridePath',
  'writePolicy.tools',
  'writePolicy.delegationTools',
]
