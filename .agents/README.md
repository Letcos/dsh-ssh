# .agents — 项目协作资料

本目录存放给 AI 主代理与子代理使用的长期记忆与协作规范。根目录的 `AGENTS.md` 是总入口(精简的操作手册,DSH 会自动加载它并显示为 AGENTS.md 项目指令),本目录存放细节。

## 结构

- `notes/README.md` — Agent Notes 组织规范(一条 note = 一个主题;类别/命名/格式/归档)
- `notes/AGENTS.md` — notes 层操作规则(写什么/放哪/怎么写)
- `notes/requirements-and-design.md` — 需求+设计权威笔记(只留稳定规范:背景/硬约束/总体架构/模块/风险)
- `notes/implemented/` — 已落地/已决策的 note(工具路由/后台任务/settings/TOFU/SFTP 降级/能力面/UI/UX/测试体系等)
- `notes/proposed/` — 提案中(待决策提案,空时以 README 占位)
- `notes/rejected/` — 被否定的方案(保留否决理由)
- `notes/research/` — 外部调研笔记(DSH 官方文档、协议、竞品等)
- `notes/design/` — 设计规格(如 2026-08-20-ui-ux-spec.md)
- `notes/archived/` — 冻结的历史流水与旧 note(如 a-series-log.md,只读)

> 注:历史 `decisions/` 目录内容已并入 `implemented/` 对应类别,不再单独存在。

## 约定

1. 开始任何任务前:先读根目录 `AGENTS.md` + 相关 notes(见 notes/AGENTS.md),再动手。
2. 任务完成后:把关键结论/已验证事实/踩坑回写成一条 note(implemented/ 或 proposed/),保持笔记与代码同步。
3. 笔记用简体中文撰写;外部引用保留原始 URL。
4. 笔记里的「已验证」必须注明出处(文档 URL 或本地源码路径),未验证的猜测标注「待验证」。
5. `archived/` 冻结不改;新结论一律写进 implemented/。
