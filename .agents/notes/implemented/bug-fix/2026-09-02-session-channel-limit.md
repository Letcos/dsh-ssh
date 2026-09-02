# Agent Note: 单连接会话通道上限（MaxSessions 并发爆炸修复）
Status: implemented

## Problem
远程 bash 执行必现 `(SSH) Channel open failure: open failed`（`SshError stage='exec-open'`）。根因：ssh2 每次 `exec` 都在**同一条**池化 TCP 连接上开一个新的 `session` 通道，而 OpenSSH sshd 的 `MaxSessions` 默认 **10/连接**（按并发 session 通道计数）。agent 对同一远端主机并发发起的多个工具调用（并行 bash/read/grep/glob + 后台任务的轮询 `exec`）共享 `SshPool` 中该 hostId 唯一的那条 `SshConn`，通道数一旦超过 sshd 上限，超出的 `SSH_MSG_CHANNEL_OPEN` 就被 sshd 以 `SSH_MSG_CHANNEL_OPEN_FAILURE`（reason=1 administratively prohibited、description "open failed"）拒绝。ssh2 把 description 拼进错误文案（`lib/utils.js` L16），插件原样透传 `err.message`，于是表现为难以定位的 "open failed"。

`requirements-and-design.md` §R7 早已把「通道排队」列为对策，但此前只落了 `maxConnections`（限制**连接条数**），同一主机的所有操作仍复用一条连接、通道无上限，排队从未实现。

## Decision
- **每连接 FIFO 会话通道信号量**：`SshConn` 新增 `_channelLimit/_channelActive/_channelWaiters` 与 `_acquireChannel()/_releaseChannel()`。`exec()`/`execStream()` 在整条命令期间持有一个 slot（通道从打开到 stream close 都占用），超出上限的并发 `exec` 按 FIFO 排队等待；释放时把 slot 直接交给下一个 waiter，`_channelActive` 精确等于「当前打开的 exec 通道数」。默认 `maxChannelsPerConnection = 6`，留足 sshd 默认 10 下的余量（6 exec + 1 SFTP + 1 shell ≤ 8）。
- **可配置**：`SshPool` 读 `options.maxChannelsPerConnection`（默认 6），`acquire()` 构造 `SshConn` 时下发（`cfg.maxChannelsPerConnection` 优先）；`cordis.patch.yml` 显式写入 6，`index.js` 启动日志带出该值。
- **错误可诊断**：新增 `describeChannelOpenError(err)`，把 ssh2 附带的数值 reason（`err.reason` 1–4）映射为人类可读提示；对 `open failed` + reason=1 追加「服务端拒绝会话通道，通常是每连接 MaxSessions 被并发命令打满」的提示。`_doExecChannel/_doShellChannel/_doSftpOpen` 统一使用。
- **范围**：只限 `exec`/`execStream`（本 bug 的热路径）。SFTP 本已每连接至多一条（`_sftpPromise` 缓存）；`shell()` 是长生命周期、由终端插件（dsh-better-sidebar）控制的通道，不纳入本次限制，避免跨插件耦合。

## Alternatives considered
- **对 channel-open 失败直接失效连接 + 重连重试**：新连接有新的会话预算，能救回个别调用，但并发爆炸时会造成连接抖动（反复握手/认证），且掩盖真实瓶颈；不采用（保留对 `Not connected` 的既有单次重试不动）。
- **要求远端调大 `MaxSessions`**：违反「远端零安装」精神且不在本插件控制面；客户端侧仍需自限，故只作为用户可选调优在 note/README 说明。

## Consequences
- 并发工具调用不再打满 sshd `MaxSessions`，超出部分排队而非报 "open failed"；错误文案附带 reason，便于定位低 `MaxSessions` 的远端（可下调 `maxChannelsPerConnection`）。
- 断线/主动 dispose 时通道槽位自然回收：ssh2 在 socket close 时 `_chanMgr.cleanup()` 会给所有已开通道发 `close`，`exec()` 的 `finally` 依序释放 slot；排队中的 `exec` 拿到 slot 后经 `connect()` 惰性重连，语义与既有「Not connected 单次重试」一致，无需额外重置信号量。
- 默认 6 的并行度对 agent 常规并发（并行读/搜/命令）足够；若远端刻意调低 `MaxSessions` 到 6 以下，仍需按远端值下调 `maxChannelsPerConnection`（错误提示会给出线索）。
- 单测新增 5 条（`test/channel-limit.test.js`：信号量边界/FIFO 交接、exec 成功与失败路径释放、并发排队、reason 上抛），全套 `node --test test/*.test.js` 303 pass / fail 0；`node scripts/client-selfcheck.mjs` OK。

## 出处
- `packages/dsh-ssh/src/ssh-core.js`：`SshConn` 构造器 `_channelLimit/_channelActive/_channelWaiters`、`_acquireChannel/_releaseChannel`、`exec/execStream` 的 try/finally、`describeChannelOpenError`、`_doExecChannel/_doShellChannel/_doSftpOpen`；`SshPool` `maxChannelsPerConnection` + `acquire` 下发。
- `packages/dsh-ssh/test/channel-limit.test.js`（新增 5 用例）。
- `packages/dsh-ssh/cordis.patch.yml`、`packages/dsh-ssh/index.js`（启动日志）。
- ssh2 `lib/utils.js` L16（`(SSH) Channel open failure: ${info.description}`）与 L17（`err.reason = info.reason`）；`lib/client.js` L829 `_chanMgr.cleanup(err)`（断连时关闭所有通道）。
- OpenSSH `sshd_config(5)` `MaxSessions` 默认 10/连接；`server_input_channel_open` 对 `session_open()` 返回 NULL 时回 `open failed`（reason 1）。
- mscdex/ssh2 issue #219 `Error: (SSH) Channel open failure: open failed`。
- `requirements-and-design.md` §R7（通道排队对策，本次补齐实现）。
