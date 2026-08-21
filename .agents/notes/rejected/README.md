# rejected — 被否定的方案

> 本目录存放**已否决**的方案 note，保留否决理由以防重复踩坑。对应 `notes/README.md` §2 与 `notes/AGENTS.md` §2「否决 → `rejected/`」规则。

## 用途
- 记录曾被认真考虑但最终否决的路线：否决原因、已验证的阻塞事实、替代方案指向。
- 供后续提案者快速判断“此路不通”，避免重复调研。

## 规则
- 文件名：`yyyy-mm-dd-topic.md`（kebab-case，一题一文件）。
- 骨架：`# Agent Note: <主题>` + `Status: rejected` + `Problem / Decision（否决结论）/ Alternatives considered / Consequences / 出处`，并在 `Decision` 中明确写出“否决”与理由。
- 语言：简体中文；100–400 行为主，简短可检索。
- 状态：`rejected` 为终态，原则上不再复活；若后续推翻否决，需新建 `proposed/` 或 `implemented/` note 并在本文首部标注 superseded 指向新 note。
