# .agents/notes — Agent Notes 组织规范

> 本目录是项目 Agent Notes 的根:每个主题一条 note,沉淀项目的设计决策、已实现取舍与过程记录。本文件讲**怎么组织**;层内操作规则见同目录 `AGENTS.md`。

## 1. 为什么要有这套结构

- 长期记忆跟代码分离:代码注释只讲「当前行为 + 不变 why」(见根 AGENTS.md §4.1),带历史与权衡的结论下沉到 notes。
- 一条 note = 一个**主题**:聚合同类决策,简短、可检索,避免把流水账堆进一个文件。

## 2. 目录结构(树即索引)

```
.agents/notes/
├── README.md                # 本文件:组织规范
├── AGENTS.md                # notes 层操作规则
├── requirements-and-design.md  # 需求+设计权威笔记(稳定规范,不含流水)
├── research/                # 外部调研笔记(官方文档/协议/竞品, 只读事实)
├── design/                  # 设计规格(如 2026-08-20-ui-ux-spec.md)
├── implemented/             # 已落地/已决策 note(本目录主体)
│   ├── architecture/
│   ├── feature/
│   ├── bug-fix/
│   ├── simplification/
│   ├── process/
│   └── testing/
├── proposed/                # 提案中(待决策提案；空时以 README 占位)
├── rejected/                # 被否定的方案(保留否决理由)
└── archived/                # 冻结的历史流水与旧 note
    └── a-series-log.md      # 原 requirements 附录 A/B 流水, 冻结
```

类别 subdirectory 枚举:`architecture`(架构) / `feature`(功能) / `bug-fix`(修复) / `simplification`(简化/删除) / `process`(过程/改名/规范) / `testing`(测试体系)。
文件名约定:`yyyy-mm-dd-topic.md`(topic 用 kebab-case, 一提一文件)；`research/` 与 `design/` 下的文件同样遵循此命名约定。
空分类目录以 `README.md` 占位以便 git 追踪，待有首条 note 落地后占位与正文共存或按需移除。

## 3. 一条 note = 一个主题

- **一个主题一个文件**,合并同类的历史小改动(如某功能的多轮修复并成一条),不把一个文件写得过长(目标 100–400 行)。
- 命名即主题;树结构本身就是索引,**不设集中 INDEX 文件**(避免索引与内容漂移)。
- note 内部用「Problem → Decision → Alternatives considered → Consequences」骨架(见 §4),出处字段指向 archived 流水与源码路径。

## 4. implemented note 格式

已实现/已决策的 note 统一用:开头标题 `# Agent Note: <主题>` + 一行 `Status: implemented`,然后按以下小节:

```markdown
# Agent Note: <主题>
Status: implemented

## Problem      # 要解决的问题(现状痛点)
## Decision     # 现在的决定/做法(现在时, 最终形态)
## Alternatives considered   # 考虑过但未选的路线与理由
## Consequences # 影响/代价/后续(含已知边界)

## 出处   # 对应 archived 流水条目 A.x + 源码路径/官方契约行号
```

- Decision 用**现在时**描述当前实现的最终形态,不写成「曾经那样改过」的过程叙述。
- 出处必须能回溯:标注 `archived/a-series-log.md A.x` 与具体源码路径/官方文档,未验证的猜测标「待验证」。

## 5. 状态与归档

- 一条 note 写好后立即标 `Status: implemented`(已落地)或 `proposed`(提案)。被否定的路线放 `rejected/` 保留否决理由;仍待定的放 `proposed/`。
- **archived/ 里的一切冻结、不再编辑**:历史流水(`a-series-log.md`)整体迁入即视为最终记录;新内容不许再往 archived 追加,有结论就写 implemented/。
- 当 implemented/ 的某条不再反映现状(被新的实现取代),把它移到 `archived/` 冻结,并在新 note 里说明取代关系。

## 6. 与其它资料的分工

- 根 `AGENTS.md`:总入口,只放大到能用所需的最小操作信息。
- `requirements-and-design.md`:只留**稳定规范**(背景/硬约束/总体架构/模块/风险 R 系列);逐条取舍细节在 implemented/,原始验证流水在 archived/。
- `research/` :外部事实(官方文档页、源码行号、竞品),不改代码影响。
- `decisions/` 历史目录已并入 implemented/ 对应类别(旧引用可在 archived 流水里追溯)。

## 7. 语言

- 全仓库笔记用**简体中文**(含本目录所有 note);官方/外部引用保留原文与 URL。
- 每批任务结束,把关键结论/已验证事实/踩坑回写成一条 note(见 notes/AGENTS.md 操作规则)。
