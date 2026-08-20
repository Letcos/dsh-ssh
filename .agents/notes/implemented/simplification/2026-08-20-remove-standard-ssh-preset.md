# Agent Note: 删除 standard-ssh preset(方案⑤后冗余)
Status: implemented

## Problem
- 方案⑤(agent/created 钩子按 cwd 路由,preset 无关)落地后,standard-ssh preset 完全冗余,成为死代码与维护负担;用户确认「这块都删掉」。

## Decision
- 全量删除:packages/dsh-ssh/preset/(agent.cordis.yml, preset.yml);packages/preset-standard-ssh/ 整个包(上游快照/build/validate/install-preset);packages/@aaravarr/dsh-ssh/ 整个包(已确认为 preset 副本);scripts/install-preset.mjs;test/preset-auto-install.test.js。
- packages/dsh-ssh/index.js 移除全部 preset 自动同步逻辑(PRESET_ID/PRESET_FILES、installBundledPreset、autoInstallPreset 守卫与 apply() 内调用块、相关导入),apply() 日志去「preset auto-sync」。
- tools.js 的 `apply()` 保留(仍被 6 个测试/实机脚本 import 作「本地委托模式(remoteRouting=false)」注册助手),注释改为「随包 preset 已删,生产路由统一走 index.js 钩子」;package.json files 白名单去掉 preset 条目。
- 文档同步:agents.md(工具路由/方案⑤叙述、树去 preset 行、删除 preset 同步/验证命令)、packages/dsh-ssh/README.md 最小清理。

## Alternatives considered
- 保留 preset 作显式可选/回退:⑤也可覆盖官方 standard preset,无需维护额外 preset 副本 → 全删。

## Consequences
- 单测 286 tests fail=0(去掉 preset-auto-install 1 例);⑤路由能力无回退(e2e/路由测试保持绿)。
- 残留引用限于:agents.md §3 一句历史叙述、根 README.md(preset 相关文档待整体重写)、archived 历史条目(属历史事实不改)。磁盘 ~/.dsh/.agent-presets/standard-ssh 已同步副本由主代理另行清理。

## 出处
- archived/a-series-log.md A.42(standard-ssh preset 全量移除)。
- 本仓库 packages/dsh-ssh/(index.js/tools.js/package.json/preset 删除)、packages/preset-standard-ssh(删除)。
