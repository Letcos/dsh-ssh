# Agent Note: preset standard-ssh（已移除，归档）
Status: superseded

> **归档说明**：本 note 原为 `implemented/feature/2025-08-16-preset-and-namesake-tools.md` 中 preset standard-ssh 相关内容的独立条目。方案⑤（`agent/created` 钩子按 cwd 路由，preset 无关）落地后该 preset 完全冗余，于 2026-08-20 被 `implemented/simplification/2026-08-20-remove-standard-ssh-preset.md` 整体删除（代码中已无 `standard-ssh`）。按 `notes/README.md` §5「被取代 note 移入 `archived/`」流程归档，冻结不再更新。归档日期：2026-08-20。

## Problem
- 早期让远端工作区里的工具生效曾依赖独立的 `standard-ssh` preset（复制官方 `standard` preset 并替换工具行），以实现同名工具的按会话路由。

## Decision（历史形态，已 superseded）
- **preset = `agentPresets.copy('standard','standard-ssh')` 复制官方 preset + 工具行整体换成单行 `- id: tool-ssh / name: 'dsh-ssh/tools' / config: {}`**（`dsh-tool-fs` 一行注册 `read/write/edit/read_image` 是官方既有模式；同名工具在同一 scope 重复注册抛错，故收敛为单行；`import` 走包 `exports` 子路径 `./tools`）。preset 行要求服务行在 `isolate` 组，工具行不需要。
- 该 preset 的产物与构建脚本已全部删除，现路由统一走 `host` 插件 `agent/created` 钩子遮蔽（见 `implemented/feature/2026-08-19-preset-independent-tool-routing.md`），不再依赖任何 preset 副本，无上游 preset 同步维护点。

## Alternatives considered
- 保留 preset 作显式可选/回退：方案⑤已可覆盖官方 `standard` preset，无需额外 preset 副本，维护成本高且易漂移，故全量删除。

## Consequences
- `standard-ssh` preset 及其构建产物（`packages/preset-standard-ssh/`、`packages/dsh-ssh/preset/`、相关脚本）已不存在；现有一切远端路由均经 `agent/created` 钩子实现。
- 历史验证流水见 `archived/a-series-log.md` A.4，后续请查 `implemented/simplification/2026-08-20-remove-standard-ssh-preset.md`。

## 出处
- `archived/a-series-log.md` A.4（M3a preset 产物）。
- `implemented/simplification/2026-08-20-remove-standard-ssh-preset.md`（取代关系与删除清单）。
- 原实现：`dsh-agent-presets` copy/discovery、`preset/agent.cordis.yml` 生成物（已删除）。
