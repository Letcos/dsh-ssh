# Agent Note: preset 无关的 SSH 工具路由(方案⑤)与远端 shell 跟随远端平台
Status: implemented

## Problem
- 早期路由依赖 `standard-ssh` preset(方案①):用自定义 preset 的用户无法受益。需要一个与 preset 无关、本地行为逐字节不变的路由机制。
- Windows 宿主上官方禁用 bash,策略(a)下远端会话 bash 不在视图不被遮蔽 → Windows 远端会话没有任何路由 shell 工具,shell 命令落到本地 Windows 执行,触发 subprocess-spawnTerminal 的 win32 不支持错误。

## Decision
- **主路线 = 方案⑤:host 插件监听 `agent/created` 钩子,仅当会话 cwd 为远端占位路径(`~/.dsh/remote/<hostId>/...`)时,在**该 agent scope** 注册 7 个同名路由工具(bash/read/write/edit/read_image/glob/grep)遮蔽 preset 官方工具**。本地路径调用经无 scope 的 `ctx.tools.get(name)` 委托 host 全局官方实现(dsh-base 全局注册),逐字节一致。`agent/created` 在 setup 之后、driver 启动前同步发出;scope key = agent 对象本身(`agent.ctx[kScope]=agent`);scoped registers shadow globals(dsh-tools)。全程 try/catch 吞错(agent/created 是 emit,同步抛错会 veto agent 发布)。
- **遮蔽策略 (a):只遮蔽会话中已存在的工具名**(不给 minimal/code preset 补全新能力);本地 cwd 会话零介入。
- **shell 例外(远端 shell 跟随远端平台):`bash` 在远端占位 cwd 会话中总是注册路由实现**,不经过策略(a)过滤——Windows 宿主 tool-bash 被 platform 禁用时补注册;macOS/Linux 宿主 bash 本在视图,走遮蔽殊途同归。**pwsh 不路由**(远端零安装约束下不保证远端有 pwsh;文档化「远端会话请用 bash」)。
- escalation 判定改走 `ctx.get('shell')?.sandboxMode` / `ctx.get('fs')`(在无 inject 的 agent.ctx 上,`ctx.shell` 直取抛「without inject」)。
- 方案① standard-ssh preset 保留为显式可选/回退,与⑤共存不冲突(后续因冗余被删,见 remove-standard-ssh-preset note)。

## Alternatives considered
- ② 动态 preset 变体(copy+直接落盘):变体同步/漂移/清理成本高,无 write API。
- ③ profile/home patch 换工具:被源码证伪——cordis patch 的 name 是守卫字段不可覆盖,preset 树不在 host 组合栈内,任何 patch 层触不到 preset 工具行。
- ④ 服务层替换(fs/shell/subprocess):全局单例,波及全部消费者,违反「本地行为完全不变」硬约束,且盖不住走 subprocess+rg 的 glob/grep。

## Consequences
- 覆盖所有 preset(standard/code/minimal)且代码/preset 模式的远端会话,子 agent 同(钩子注册在根 ctx,无 scope tag,接收所有 agent)。
- verify-agent-created.mjs 作为可复用脚本级验证保留(真实 cordis 组合 + agent/created 遮蔽断言,DSSH_VERIFY_SKIP_SSH=1 可跳 SSH)。
- 远端会话 scheme 描述与能力面注入(见 skill-mcp-capability-surface note)复用同一 agent/created 钩子,独立于工具遮蔽。

## 出处
- `archived/a-series-log.md` A.18（方案⑤实施）、A.27（bash 必注册修订）、A.31（会话 ID 审计）；`research/2026-08-20-preset-independent-tool-routing.md`（方案对比与可行性调研，Q1-Q6）。注：原决策目录已并入 `implemented/`，上述 A 条目即原决策归档位置。
- `dsh-tools@lib/index.js` scoped shadows global；`dsh-agent/README` `agent/created` 时序；`dsh-base/cordis.patch.yml`（:212 `tool-bash` `disabled: win32`）；`subprocess-local/lib/index.js:298` `spawnTerminal`。
