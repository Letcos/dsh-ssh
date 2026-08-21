# Agent Note: SSH 断线自动重连修复
Status: implemented

## Problem
SSH 连接在网络抖动、keepalive 超时或远端 sshd 主动关闭后，`SshConn` 永久缓存已 resolve 的 `_ready` Promise（`connect()` L263-275），且未监听 `close`/`end`/`error`，导致断线无人察觉。随后所有 `exec`/`sftp` 均在 `_execChannel` 的 `connect()` 快回后经 `_ensureOpen()` 误放行，ssh2 同步抛 `Not connected` 被包装为 `stage='exec-open'` 的 `SshError` 并永不恢复。`SshPool.invalidate` 存在但生产代码无人调用。

## Decision
- **连接死亡检测**：`_connectInner` 成功后为 `ssh2` client 注册 `close`/`end`/`error` 监听，触发时置 `SshConn._dead=true` 并清理 `client/_ready/_sftpPromise/_sftpUnavailable`。`dispose()` / `_close()` 在主动关闭前先 `removeListener` 并以 `_isClosing` 标志避免将主动 `end()` 误判为异常断开。
- **惰性重连（SshConn 侧）**：`SshConn` 新增 `_dead/_isClosing/_onClose/_resetDeadState()`，`connect()` 入口若 `_dead` 则重置状态后重建；捕获到 `Not connected` 时亦清理并允许下次 `connect()` 重建。语义等价于 pool 重建：原地重置即“下次 acquire 拿新连接”的可用替代，无需让 `SshConn` 持有 pool 回调。
- **惰性重连（SshPool 侧）**：`acquire()` 复用前检查 `existing._dead || !existing.client`，命中则 `await invalidate(id)` 后新建 `SshConn`，保证池内不再复用已死连接，注释中“reconnects (pool.invalidate creates a fresh SshConn) reset it”语义成立。
- **一次透明重试**：`_execChannel`/`sftp` 拆分为 `_doExecChannel`/`_doSftpOpen` + 外层包装：`try { connect + do } catch (Not connected) { _resetDeadState(); reconnect; retry once }`；重试仍失败则抛带 `hostId` 且 `stage='exec-open'|'sftp-open'`、`message` 含 `reconnect failed after disconnect` 的 `SshError`。已在流式/已开始执行的命令不做额外重试，仍按 `R6` 返回明确错误（`exec`/`execStream` 的流内错误保持原有 `SshError` 语义）。
- **单一错误判别**：新增 `isNotConnectedError(err)` 以 `message.includes('Not connected')` 为判据，覆盖 ssh2 同步抛错与 `SshError` 包装后两种形态。

## Alternatives considered
- **SshConn 持有 `onDead` 回调由 pool 注入 `invalidate`**：更贴合“池侧重建”文字表述，但引入双向依赖且增加测试心智负担；原地重置已满足“下个操作重连成功”且保持 `SshPool.invalidate` 的可观测语义（`acquire` 的 `invalidate` 仍会替换 map 条目），故选用更简单稳妥的原地重置。

## Consequences
- 长时间运行后的网络断开不再导致永久 `Not connected`；下一次工具调用自动重连并对 `exec`/`sftp` 的“未开始”阶段做一次透明重试。
- 主动 `dispose/invalidate` 不会误触发重连；`fs()` 的 SFTP 降级探测仍按连接粒度缓存，重连后重新探测。
- 新增单测覆盖闭环，基线 `fail=0` 不变：`node --test packages/dsh-ssh/test/*.test.js` — `tests 295, pass 295, fail 0`（含新增 `packages/dsh-ssh/test/ssh-reconnect.test.js` 9 项：close 标记 dead/下次 connect 重建/pool acquire 失效重建/Not connected 单次重试成功(exec/sftp)/重连失败抛带 hostId 的 SshError(exec/sftp)/正常 dispose 不触发重连/非 Not connected 不重试）；`node packages/dsh-ssh/scripts/client-selfcheck.mjs` — `client.js static self-check OK`。

## 出处
- `packages/dsh-ssh/src/ssh-core.js`：`SshConn` `_dead/_isClosing/_onClose/_resetDeadState/connect/_connectInner/_close/_ensureOpen/_doExecChannel/_execChannel/_doSftpOpen/sftp`、`SshPool.acquire`、`isNotConnectedError`。
- `packages/dsh-ssh/test/ssh-reconnect.test.js`（mock client 以 `close` 事件驱动）。
- `.agents/notes/requirements-and-design.md` §F9/R6。
