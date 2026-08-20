# .agents/notes — AGENTS.md(notes 层操作规则)

> 本文件讲在 notes 层**怎么干活**;目录「怎么组织」见 `README.md`。开头前先读根 `AGENTS.md` 与本目录组织规范。

## 1. 写什么

1. 每个任务的**结论/已验证事实/踩坑**在结束时回写成一条 note(implemented/, or proposed/)——不要只留在聊天里。
2. 复用主题而非新增流水:新发现若属于既有主题,并入该 note(合并同类);确是新主题才开新文件并命名即主题。
3. 只记长期成立的「为什么」与最终形态(Decision 现在时);一行行的操作过程/临时探针交回 `archived/` 或直接丢弃。

## 2. 放哪

- 已实现/已决策 → `implemented/{class}/yyyy-mm-dd-topic.md`;提案 → `proposed/`;否决 → `rejected/`。
- 外部调研事实 → `research/`(不改实现影响,保留出处 URL/源码行号)。
- 稳定规范(硬约束/总体架构/风险)追加到 `requirements-and-design.md` 对应小节,不重复建 note。
- **绝不改 `archived/`**:那里已冻结,历史流水(如 `a-series-log.md`)只读。

## 3. 怎么写

- 骨架:`# Agent Note: 主题` + `Status:` + `Problem/Decision/Alternatives/Consequences` + `出处`。
- 简体中文;一个文件一个主题,目标 100–400 行,别写成流水账。
- 出处必须能回溯:标 `archived/a-series-log.md A.x` 与源码路径/官方契约行号;未验证的标「待验证」。
- 并发回写冲突:以追加/并入为主,保留双方条目并标注,不覆盖他人结论。

## 4. 判例

- 新工具/新能力落地 → `feature/`;修复既有缺陷 → `bug-fix/`;删除冗余/简化 → `simplification/`;改名/规范/工程债 → `process/`;测试体系/基线 → `testing/`;跨模块架构 → `architecture/`。

## 5. 违规清单(红色)

- 往 `archived/` 追加或改写任何内容;
- 在代码注释里引用 note 条目号(A.xx)/里程碑/方案编号(见根 AGENTS.md §4.1);
- 为单一流水事件开一个 note 而不并入同类主题。
