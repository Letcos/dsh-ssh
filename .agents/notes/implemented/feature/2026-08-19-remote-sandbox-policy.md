# Agent Note: 远端 sandbox 权限语义(工具层 fence)与 escalation 条件暴露
Status: implemented

## Problem
- 路由工具 schema 广告了 sandbox_permissions/justification 与完整升级话术,但 execute 远端分支不消费——无 resolvePolicy、无审批、无拒绝,写远端工作区外路径不拦截,广告了不存在的语义。
- 远端路由语境下 schema 无条件写死 escalation 字段,导致 danger-full-access 会话里模型反复传升场参数、每次硬报错死循环。

## Decision
- **远端工作区边界 = route.remoteCwd**(会话占位 cwd 解码出的远端绝对路径);三模式远端语义:`danger-full-access` 全放行;`workspace-write` 解析后路径在 remoteCwd 内放行、区外拒绝并返回官方 denial + 支持 `sandbox_permissions` 升级重试;`read-only` write/edit 一律拒绝、bash 整条拒绝(fail-closed)。
- 工作区内外判定 `isPathInsideWorkspace(target, root)` = target===root 或 startsWith(root + '/'),两端先 `posix.normalize` 折叠 ./../;`resolveRemotePath` 绝对路径分支新增 normalize 关闭绝对 `../` 词法逃逸(write/edit/read/glob/grep 全链路归一化)。
- 升级通道与官方一致:复用 `@deepseek-ai/dsh-sandbox` 的 `validateEscalationArgs` + `approveEscalation`(审批在一切执行前);denial 错误与官方 mapError 同形(`FsError(code=FS_SANDBOX_DENIED, message=[sandbox: file access denied under <mode> mode]...)`)。有效模式经 `ctx.get('sandboxPolicy').resolve({session}).mode` 读取,回退 fs/shell sandboxMode。
- **escalation 条件暴露**(A.40):字段只在 `escalationModes.length>0` 时入 schema(官方同款);对 remote cwd 路由注册的工具 `escalationModes=[]`(远端升级即便审批过也只是放宽本地 executor,对远端零作用 → 语义上不可升级);三模式拦截与升级彻底解耦。危险模式下 approval 同样报「is not strictly wider」(与官方一致,不实现忽略继续);escalationModes=[] 时带升级参数 → 官方同形「sandbox_permissions is not available in this composition (no sandboxing filesystem/executor)」。

## Alternatives considered
- 远端 bash 由沙箱 runner 强制文件边界:远端无 runner,只能工具层按 policy 粗粒度放行/拒绝整条命令;workspace-write 下 bash「不 enforce」以描述明示(非自行放宽,是任务书明确建议的收敛)。

## Consequences
- 本地委托分支与 preset/standard-ssh 回退路径零改动;read-only 的 fail-closed 不因无法静态区分读写而放行任意命令。
- 词法归一化不解符号链接(与官方 dsh-fs-sandbox「containment 非安全边界」威胁模型一致);远端 /tmp 未复制本地 writableRoots 语义(从严只放行 remoteCwd,留待确认)。
- route.jit 全局:scheme 隐藏由 `remoteRouting:true` 配置控制(preset 挂载 local 委托的升级语义与官方逐字一致)。

## 出处
- archived/a-series-log.md A.20(审计交叉方向)、A.21(P0 fence 实施)、A.40(escalation 条件暴露)。
- dsh-tool-fs@lib/index.js L617/655-660/1082-1083、dsh-tool-bash L285;@deepseek-ai/dsh-sandbox approveEscalation/validateEscalationArgs;本仓库 src/policy.js、src/router.js:89、tools.js。
