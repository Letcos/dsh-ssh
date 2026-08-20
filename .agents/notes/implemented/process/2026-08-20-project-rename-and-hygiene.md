# Agent Note: 项目改名 dsh-ssh 与代码注释去过程化
Status: implemented

## Problem
- 项目原名 dssh,npm scope @aaravarr;用户决定完全改名 dsh-ssh(GitHub org/repo 已改 dsh-ssh/dsh-ssh,scope → @dsh-ssh)。
- 代码注释混入大量过程化引用(M1–M5 / 方案⑤ / A.xx / D-xx / F-xx /「修复/补充/曾经」等),不了解历史的人无法读懂。

## Decision
- **改名(两批)**:① dssh → dsh-ssh:代码标识 `dsh-ssh:capability-surface`、settings 命名空间 `dssh-hosts` → `dsh-ssh-hosts`(带迁移:LEGACY_HOSTS_NAMESPACE 只读回退;saveHost/deleteHost 首次编辑整体迁入新命名空间防孤儿化)、环境变量 DSSH_* → DSH_SSH_*、远端默认目录 /tmp/dssh-* → /tmp/dsh-ssh-*;② @aaravarr → @dsh-ssh:package.json name/repository.url、cordis.patch.yml bundle id、代码日志前缀、根 package.json、LICENSE 版权、删除重复旧 publish.yml(保留带测试门禁的 release.yml)。
- **注释去过程化 + 英文化(A.44)**:全部代码注释清理为「当前行为 + 不变 why」的英文说明,只保留两类——① 当前行为必要说明;② 不随代码自明、长期成立的 why(外部契约、参数来源、官方源码行号出处)。运行时字符串一律不动(i18n 语言包/schema description/错误与日志文案)。
- 涉及 packages/dsh-ssh 全部代码文件(不含 test/ scripts/):index.js/tools.js/client.js + src/9 个 + lib/2 个。

## Alternatives considered
- npm 包名维持旧 scope @aaravarr:用户已改 org/repo,须一并对齐 → 全量改名。

## Consequences
- 单测 287/287 fail=0(含迁移 7 例;改后基线 286);client-selfcheck OK(id=@dsh-ssh/dsh-ssh)。
- 改名/注释清理后,代码不再引用里程碑/note 条目号(agents.md §4.1);这类信息只活在 notes 与 git log。

## 出处
- archived/a-series-log.md A.41(改名)、A.44(注释去过程化)。
- 本仓库 packages/dsh-ssh/ 全部代码文件;agents.md §4.1 注释规则。
