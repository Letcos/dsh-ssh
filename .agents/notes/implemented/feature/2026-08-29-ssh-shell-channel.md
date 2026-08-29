# Agent Note: SshConn.shell() 交互式 PTY 通道
Status: implemented

## Problem
- 消费者(dsh-better-sidebar 的终端页)需要一个真实的远端交互终端; dsh-ssh 只暴露 `exec`(非交互)与 `fs`(SFTP), 无法承载交互 shell。requirements-and-design.md §2.3 曾将「交互式远端终端」列为不在范围、只保证非交互命令。

## Decision
- 新增 `SshConn.shell(opts = {})` → ssh2 `Client.shell(wndopts)` 开 PTY 通道, 返回原始 stream; 窗口默认 `term=xterm-256color, cols=80, rows=24`, 可被 opts 覆盖。
- 复用 `_execChannel`/`sftp` 的**单次透明重试**契约: `_doShellChannel` 开通道(ssh2 同步抛 "Not connected" 时包成 `SshError stage='shell-open'`); `shell()` 先 `connect()`, 遇 `isNotConnectedError` 置 `_dead` → `_resetDeadState()` → 重连重试一次; 二次失败抛 `SshError{hostId, stage:'shell-open', message:'reconnect failed after disconnect: …'}`。
- 纯附加: 只加方法, 不改任何既有工具路径; dsh-ssh 自身工具(bash/read/write/glob/grep/后台任务)仍走 `exec`+`fs`, 保持非交互。

## Alternatives considered
- A. 不暴露 shell、维持「终端不在范围」: 消费者无法实现远端终端, 阻断跨插件组合。
- B. 用 `exec` + `script`/`tty` 伪造交互: 非标准、非真 PTY、窗口/信号语义不可靠, 否决。

## Consequences
- 满足硬约束: DSH core 零修改、远端零安装(sshd 自带 PTY)、纯附加可插拔、本地路径行为不变。
- 交互语义(窗口 resize/信号/全屏)由消费者(dsh-better-sidebar 的 PtyManager/RemoteShell)负责; dsh-ssh 只提供通道。
- 单测新增 3 条(ssh-reconnect.test.js): 窗口默认值、shell 单次重试成功、重连失败抛 SshError; 全套 `node --test test/*.test.js` fail=0。

## 出处
- `packages/dsh-ssh/src/ssh-core.js`（`SshConn._doShellChannel` / `SshConn.shell`，紧邻 `_execChannel`/`sftp`）。
- `packages/dsh-ssh/test/ssh-reconnect.test.js`（shell 相关 3 用例）。
- `requirements-and-design.md` §2.3（原「交互式远端终端不在范围」条目已更新）。
