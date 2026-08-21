# Agent Note: 已否决的远端接入路线汇总
Status: rejected

> 本文把散落在 `requirements-and-design.md` §3 与各 note Alternatives 中「认真考虑过但最终否决」的路线收敛为一篇，每条含否决理由与出处，供后续提案者快速判断"此路不通"。定案路线见 `implemented/feature/2026-08-19-preset-independent-tool-routing.md`（方案⑤ agent/created 钩子按 cwd 遮蔽）。

## Problem
让 DSH 把远端目录当工作区、bash/文件/glob/grep 全部在远端执行，可选接入路线很多。下列路线都曾被评估，最终因违反硬约束（§1：core 零修改 / 远端零安装 / 纯附加 / 本地行为完全不变）或副作用过大而被否决。

## Decision（否决结论）
- **FUSE 挂载（sshfs / macFUSE 本地内核扩展）**：否决。macFUSE 需安装 + 管理员权限、升级脆弱，违背"纯附加、可插拔"；挂载故障难诊断且拖垮本地文件系统路径。主路径改为 ssh2 SFTP（用户态，无内核依赖）。出处：requirements-and-design.md §3.3 / D3。
- **Emacs TRAMP 式纯 shell 解析**：否决作主路径。每个文件操作都靠 ssh host cat/echo/sed 拼 shell（转义面大、易注入），无标准 rename/stat/mkdir/读偏移语义，二进制与原子写难做、性能差。仅保留为 SFTP 被禁时的降级备选（P3 后评估）。出处：requirements-and-design.md §3.4 / D2。
- **透明替换 host 单例服务（ctx.fs / ctx.shell / ctx.subprocess / directoryPicker）**：否决。它们是 host 全局单例，替换须改主机组合 = 修改 core（违反硬约束 1）；且被 settings/持久化/attachment/workspace 等大量非工具消费者共享，全局替换必然改变本地路径行为（违反"本地行为完全不变"），glob/grep 走 ctx.subprocess + 本地 ripgrep 也盖不住。出处：requirements-and-design.md §3.2；research/2026-08-20-preset-independent-tool-routing.md Q5。
- **远端常驻服务层（remote agent / daemon / 内核模块）**：否决。要求远端额外安装服务，违反"远端零安装"。出处：requirements-and-design.md §1.2 / §2.3。
- **profile/home patch 替换工具行**：否决（被源码证伪）。preset 层（agent.cordis.yml）不在 host 组合栈内，profile/home patch 覆盖不到任意 preset 里的工具行；且 patch 的 name 字段是"守卫"而非"可覆盖字段"。出处：research/2026-08-20-preset-independent-tool-routing.md Q1/Q2。
- **动态 preset 变体（copy + 直接落盘改 name）**：否决。agentPresets 无 write API，copy 只能整目录复制；要为每个用户 preset 生成并维护变体，同步/漂移/清理成本高。出处：research/2026-08-20-preset-independent-tool-routing.md Q6 / 方案②。
- **固定 preset standard-ssh（方案①）**：否决（早期已实装，后被整体删除）。preset 无关的方案⑤落地后该 preset 完全冗余；只覆盖显式选 standard-ssh 的用户，维护成本高且易漂移。出处：implemented/simplification/2026-08-20-remove-standard-ssh-preset.md；archived/2025-08-16-preset-standard-ssh.md。
- **虚拟 URI（如 ssh://host/path 进 workspace 子系统）**：否决。需要改 core 的路径语义，违反硬约束 1。改为本地占位目录（普通 workspace 记录），sessions/workspaceRegistry/apiProxy 零改动。出处：requirements-and-design.md D6。
- **新工具名（ssh_bash 等）**：否决。同名工具让 agent/用户无感切换运行机器，新名需改 agent 行为与文档、不满足"方便切换"。出处：requirements-and-design.md D5。

## Alternatives considered
- 各否决路线的"当时备选与理由"已并入上方 Decision；最终采纳的路线 = 方案⑤（agent/created 钩子按会话 cwd 注册 7 个同名路由工具遮蔽官方实现），详见 `implemented/feature/2026-08-19-preset-independent-tool-routing.md` 与 `requirements-and-design.md` §3.2 结论。

## Consequences
- 以上路线一经否决不再作为主路径；SFTP 主路径 + exec 通道 + 工具层同名路由成为唯一实现面。
- 若未来出现新场景（如 Windows 远端、ProxyJump、远端后台任务），需在 `proposed/` 重新提案，不复活本文已否决路线（rejected 为终态，见 rejected/README.md）。

## 出处
- requirements-and-design.md §3（3.2/3.3/3.4）、D2/D3/D5/D6。
- research/2026-08-20-preset-independent-tool-routing.md（Q1/Q2/Q5/Q6、方案②）。
- implemented/simplification/2026-08-20-remove-standard-ssh-preset.md；archived/2025-08-16-preset-standard-ssh.md。
