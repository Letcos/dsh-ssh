# proposed — 提案中

> 本目录存放**尚未决策、待评审**的提案 note。对应 `notes/README.md` §2 目录结构中的 `proposed/` 与 `notes/AGENTS.md` §2「提案 → `proposed/`」规则。

## 用途
- 记录 RFC 式提案：问题背景、拟选方案、权衡与待验证点，供主代理与评审者讨论。
- 提案不直接影响代码；一经决策，结论沉淀至 `implemented/` 对应类别，否决的保留至 `rejected/`，本目录下原提案可归档或删除。

## 规则
- 文件名：`yyyy-mm-dd-topic.md`（topic 用 kebab-case，一题一文件）。
- 骨架：`# Agent Note: <主题>` + `Status: proposed` + `Problem / Decision（拟）/ Alternatives considered / Consequences（预期）/ 出处`。
- 语言：简体中文；目标 100–400 行，保持可检索与简短。
- 状态：`proposed` 为待决策；决策后按 `notes/README.md` §5 迁移至 `implemented/` 或 `rejected/`。
