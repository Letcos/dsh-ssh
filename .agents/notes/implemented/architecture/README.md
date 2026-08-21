# architecture — 跨模块架构决策

> 本目录存放**跨模块、影响全局的架构决策** note，对应 `notes/README.md` §2 中 `implemented/architecture/` 类别与 `notes/AGENTS.md` §4 判例“跨模块架构 → `architecture/`”。

## 用途
- 记录架构层决策：核心分层、模块边界、关键接口与扩展点选型、跨切面约束等。
- 同一主题的多轮修复与演进并入单条 note，保持“一个主题一个文件”。

## 规则
- 文件名：`yyyy-mm-dd-topic.md`（kebab-case，一题一文件）。
- 骨架：`# Agent Note: <主题>` + `Status: implemented` + `Problem / Decision（现在时，最终形态）/ Alternatives considered / Consequences / 出处`（`archived/a-series-log.md` A.x + 源码路径/官方契约）。
- 语言：简体中文；目标 100–400 行，不写流水账。
- 出处必须可回溯：标注 `archived/a-series-log.md` 条目与具体源码/文档行号；未验证标“待验证”。
