# Agent Note: SFTP 禁用降级为 exec 通道 + base64 传输
Status: implemented

## Problem
- 远端 sshd 若禁用 SFTP 子系统,所有 ssh2 SFTP 文件操作(read/write/edit/read_image/目录浏览/remote-jobs 日志与 status)全部失败。需在「远端零安装」硬约束下恢复文件语义。

## Decision
- **统一访问入口 `SshConn.fs()`**(src/ssh-core.js):SFTP 可用 → 返回 SftpWrapper(逐字节不变);首次调用做能力探测 `sftp()`——成功即缓存,失败置 `_sftpUnavailable=true` 并返回 `ExecFs` 降级;不缓存失败的 sftp 承诺;重连(invalidate 新建 SshConn)自动重置探测;`cfg.forceExecFs` 供真机 no-sftp 模拟(不改真实 sshd)。
- **ExecFs 降级层**(src/exec-fs.js):与 SftpWrapper 对齐的最小方法集 readBytes/readText/writeFileAtomic/stat/exists/listDir/unlink/mkdir/rename/rmdir;解析一律 locale 无关(`test -d/-f` + `stat -c %s/%Y`,不 parse 人类可读输出;readdir 用 `find -printf`);二进制统一 base64;原子写 = 同目录随机临时文件 base64 写 + `mv -f` 发布;错误 stage 前缀 `execfs-`。
- **上层调用点全部改走 `conn.fs()`**而非直接 `conn.sftp()`(tools.js 四工具、remote.js、remote-jobs.js);SFTP 可用时 fs() 返回 SftpWrapper → 原路径不动。SftpWrapper.stat 补返回 mtime(statRemote 统一走 fs.stat)。
- **实测约束(务必遵守)**:exec 命令串有硬上限(~131KB 命令远端已失败、~256KB exec-open、~350KB 断连)→「写」的 base64 走命令行参数下发,写分块必须小(DEFAULT_WRITE_CHUNK_BYTES=48KB 源→64KB base64);「读」的 base64 从 stdout 回传,读分块可取大(256KB)。tmp 路径禁用 node:path(Windows 宿主 path.join 产反斜杠 → 远端当单文件名落错目录),手写 POSIX dirname/basename。

## Alternatives considered
- A. SFTP 不可用直接报错:不满足降级诉求。
- B. sshfs/FUSE:需本地内核扩展,违背纯附加/零本地依赖,已否决。
- C. 复用 node-ssh/ssh2-sftp-client 包内降级:藏掉流式读/并发/原子 rename,且不解决 SFTP 被禁的根本问题。

## Consequences
- 降级 stage 前缀 execfs-,保持 hostId/stage 供 toolErrorText/能力面;上层只依赖 SftpWrapper 与 ExecFs 共有方法面(fs() 换实现不换逻辑)。
- 真机 forceExecFs 全链路 18/18 PASS(与 SFTP 交叉互读一致;600KB 大文件分块写读往返;后台任务日志经 execfs 增拉取+清理)。

## 出处
- archived/a-series-log.md A.36(SFTP 降级);decisions/D-36-execfs-fallback.md。
- ssh-core.js(SshConn.fs + 能力探测)、src/exec-fs.js;官方 filesystem 文档(rem sha device)。
