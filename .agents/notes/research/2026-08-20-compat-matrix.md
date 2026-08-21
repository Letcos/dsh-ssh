# dsh-ssh 兼容性矩阵与真实远端实测报告

> 生成: 2026-08-16 · 实测套件: packages/dsh-ssh/scripts/functional-live-test.mjs(41 用例)
> 数据来源: 套件 RESULT-JSON 输出(可复跑复现)。两远端地址已脱敏为 RFC 5737 示例占位(见文末脚注), 环境指纹为实测记录; 公钥认证, 全程 ssh2 v1.17.0。
> 约束遵守: 纯内存配置(不写 ~/.dsh/settings.yaml); known_hosts 用 /tmp/dsh-ssh-test-known_hosts(不碰用户文件,
> acceptNew 仅套件兜底); 远端只碰 /tmp 下自建目录并已清理(实测无残留); 未启动任何 DSH 服务; 未改任何现有代码。

## 1. 实测环境信息

| 项 | ubuntu-22(主) | macOS(次) |
|---|---|---|
| 主机 | ubuntu@203.0.113.10:22[^1] | user@203.0.113.10:<ssh-port>[^1] |
| OpenSSH 版本 | 8.9p1 Ubuntu-3ubuntu0.6 / OpenSSL 3.0.2 | 10.2p1 / LibreSSL 3.3.6 |
| 内核 | Linux 5.15.0-106-generic x86_64 | Darwin 25.5.0 arm64 |
| 默认 shell | /bin/bash | /bin/zsh |
| SFTP 可用性 | 可用(sshd_config:115 Subsystem sftp /usr/lib/openssh/sftp-server) | 可用(sshd_config.d/100-macos.conf:4 Subsystem sftp /usr/libexec/sftp-server)⚠ 见问题 P7 |
| ssh2 版本 | 1.17.0(本地依赖, 两主机同一客户端) | 同左 |

认证方式: 密钥路径 ~/.ssh/id_ed25519 ✅(全部用例); agent 认证未测(本机 SSH_AUTH_SOCK 已设置但未走 agent); 口令认证未测。
known_hosts 校验: 两主机 key 均在 /tmp/dsh-ssh-test-known_hosts(实测 host:port 与 [host]:port 两种 pattern 均可匹配)。

## 2. 用例清单(41 用例: 39 ✅ / 2 ❌ 均带 [KNOWN-BUG] 标记)

| 用例 | 结果 | 关键数据 |
|---|---|---|
| A1-1 exec 退出码 0 | ✅ | code=0 stdout="ok" |
| A1-2 exec 非零退出码 + stdout/stderr 分离 | ✅ | code=7 / "out" / "err"(stderr) |
| A1-3 exec 大输出 seq 1 20000 | ✅ | 108894B / 20000 行完整 |
| A1-4 exec 超时 1200ms + sleep 3 | ✅ | SshError stage=exec-timeout |
| A1-5 shellQuoteSingle 转义往返(含 "$ 中文) | ✅ | 原样往返; cwd 含空格/引号/中文可 cd |
| A1-6 命令注入防御($() 与 ;) | ✅ | 字面输出, 未创建注入文件 |
| A1-7 macOS exec 退出码 + stderr(zsh) | ✅ | code=5; zsh 下 exec 通道正常 |
| A1-8 macOS exec 超时 | ✅ | stage=exec-timeout |
| A2-1 writeFileAtomic 新建 + readText/stat/listDir | ✅ | size=12; listDir 条目齐全 |
| A2-2 覆盖写(OpenSSH rename 回退) + 无残留 | ✅ | 内容替换; 无 .dsh-tmp-*; extensions=undefined |
| A2-3 深层目录写 | ✅ | /a/b/c/deep.txt 往返一致 |
| A2-4 特殊文件名(空格/中文/单引号) | ✅ | 4 个名字读写往返一致 |
| A2-5 readBytes 二进制 4096 随机 | ✅ | 4096 字节精确一致 |
| A2-5b readBytes 300KB+1MiB 随机 | ❌ | 300KB 等长但内容错位(见 P1) |
| A2-6 不存在文件/目录错误 | ✅ | stat→undefined; read*→SshError(name/hostId/stage/message/cause 齐备) |
| A2-7 macOS SFTP 特殊名+覆盖写+二进制 | ✅ | 均往返一致(SFTP 在 macOS 实测可用) |
| A3-1 invalidate → 重建连接 | ✅ | 新 SshConn, exec 正常 |
| A3-2 dispose 后再用 | ✅ | SshError not-connected |
| A3-3 远端 kill 连接 | ✅ | kill→code=-1; 之后报裸 Error "Not connected"(见 P4); rebuild 可用 |
| A4-1 同连接并发 5× exec | ✅ | 5/5 成功 |
| A4-2 maxConnections=1 并发 8 hostId | ✅ | 8/8 成功, 2.2s; conns.size=8(见 P6) |
| B5-1 bash 成功 | ✅ | foreground/exitCode=0 |
| B5-2 bash 失败 exit 3 + 渲染 | ✅ | render 含 "[exit code: 3]" + [stderr] |
| B5-3 bash 大输出 | ✅ | 20000 行不截断 |
| B5-4 bash 超时映射 | ✅ | timedOut=true, exitCode=null |
| B6-1 read 小文件窗口 | ✅ | totalLines=3, 行号窗口正确 |
| B6-1b read 300KB 文本 | ❌ | totalLines=4728 ≠ 4727(见 P1) |
| B6-2 read 12MiB > 10MiB 上界 | ✅ | FS_TOO_LARGE(stat 前置拦截) |
| B6-3 read 不存在 | ✅ | FS_NOT_FOUND |
| B7-1 write 新建 | ✅ | create/before=null/读回一致 |
| B7-2 write 覆盖写 | ✅ | update/before=旧文/原子替换读回一致 |
| B8-1 edit 唯一替换 | ✅ | 替换+读回校验 |
| B8-2 edit replace_all | ✅ | 2 处替换正确 |
| B8-3 edit 未找到 | ✅ | FS_EDIT_NOT_FOUND |
| B9-1 read_image 1x1 PNG | ✅ | magic=89504e47, 1x1, bytes=70 |
| B9-2 read_image 非图片扩展 | ✅ | 明确报错 only accepts PNG/JPEG/WebP/GIF |
| B9-3 read_image 不存在 | ✅ | FS_NOT_FOUND |
| B10-1 未配置 hostId | ✅ | "not configured" 明确文案 |
| B10-2 主机不可达 127.0.0.1:1 | ✅ | SshError stage=connect ECONNREFUSED(见 P3) |
| B10-3 SFTP 不可用降级(模拟) | ✅ | "[dsh-ssh] host macos-live (sftp-open): ..." 文案完整 |
| B10-4 真实 macOS 文件工具 | ✅ | write create + read 2 行(SFTP 可用) |

## 3. 兼容性矩阵(能力 × 环境)

| 能力 | ubuntu-22 | macOS(次) |
|---|---|---|
| exec 退出码/stdout/stderr | 实测✅ A1-1/2 | 实测✅ A1-7 |
| exec 大输出 | 实测✅ A1-3 | 未测(同 exec 通道, 依赖度低) |
| exec 超时 | 实测✅ A1-4 | 实测✅ A1-8 |
| exec 引号转义/注入防御 | 实测✅ A1-5/6 | 未测 |
| SFTP 读写/stat/listDir | 实测✅ A2-1 | 实测✅ A2-7/B10-4 |
| SFTP 覆盖写(rename 回退) | 实测✅ A2-2 | 实测✅ A2-7 |
| SFTP 特殊文件名 | 实测✅ A2-4 | 实测✅ A2-7 |
| SFTP readBytes ≤256KB | 实测✅ A2-5 | 实测✅ A2-7 |
| SFTP readBytes >256KB 非整倍 | 实测❌ A2-5b(乱序) | 未测(同实现, 风险同左) |
| SFTP 错误 SshError 字段 | 实测✅ A2-6 | 未测 |
| invalidate 重建 | 实测✅ A3-1 | 未测 |
| dispose 后报错 | 实测✅ A3-2 | 未测 |
| 远端断开后报错 | 实测✅ A3-3 | 未测 |
| 同连接并发 exec | 实测✅ A4-1 | 未测 |
| maxConnections=1 排队 | 实测✅ A4-2 | 未测 |
| 工具 bash | 实测✅ B5-1..4 | 未测(底层同 exec) |
| 工具 read 小文件/上界/缺失 | 实测✅ B6-1/2/3 | 实测✅ B10-4 |
| 工具 read 300KB 文本 | 实测❌ B6-1b(乱序) | 同实现未复测 |
| 工具 write | 实测✅ B7-1/2 | 实测✅ B10-4 |
| 工具 edit | 实测✅ B8-1..3 | 未测 |
| 工具 read_image | 实测✅ B9-1..3 | 未测 |
| 错误文案(hostId/不可达/SFTP禁用) | 实测✅ B10-1..3 | 实测✅ B10-3(模拟) |
| 认证: 密钥路径 | 实测✅ 全部 | 实测✅ 全部 |
| 认证: agent / 口令 | 未测 | 未测 |
| OpenSSH 版本记录 | 8.9p1 ✅ C 节 | 10.2p1 ✅ C 节 |
| 默认 shell 记录 | /bin/bash ✅ C 节 | /bin/zsh ✅ C 节 |
| SFTP 可用性 | 可用 ✅ A2 全部 | 可用 ✅ A2-7/B10-4(前提纠正) |

## 4. 发现的问题清单(给主编)

- P1(严重, 当前代码实测复现) readBytes 流水线 chunk 乱序 → 内容错位。
  现象: 文件 >256KB 且大小非 256KB 整倍时, readBytes 返回等长但内容错位的字节(300KB 文件实测返回"末 44KB + 前 256KB"的旋转); 1MiB/4MiB 整倍文件实测正常。
  工具层影响: read 工具 300KB 文本 totalLines=4728 ≠ 4727(B6-1b); write 的 before 与 edit/read_image 同受 readBytes 影响。
  根因: ssh2 内部以 _maxReadLen(=OPENSSH_MAX_PKT_LEN 256KB−开销≈261888)把每次 read 拆成多个子请求; 近 EOF 的短读(剩余<261888)只需一轮往返, 先于完整块完成 → 外层回调按完成顺序 push chunk, 与请求顺序不一致 → 拼接错位。
  复现: A2-5b / B6-1b(套件带 [KNOWN-BUG] 标记, 修好后自动转绿)。
  建议: 按请求槽位(issued 顺序)组装 chunk 再拼接, 或按 position 排序后 concat, 而非按回调完成顺序 push。
- P2(已修复, 留证) 实测窗口期曾存在 readBytes 16× 重复(9B→144B, 100KB→1.6MB, 两主机均复现): 旧版流水线在回调里才递增 offset, 16 个并发请求全落在同一位置。当前源码已修复并注释(ssh-core.js readBytes), 套件 A2-5(4096B)已绿, 不再触发。
- P3(轻微) 工具 acquire 阶段错误未归一化: 主机不可达时 bash/read 等抛裸 SshError(stage=connect), 无 "[dsh-ssh] host ..." 文案前缀(acquireRemote 在 try 之外)。B10-2 记录。
- P4(轻微) 远端断开后 exec 报裸 Error "Not connected"(ssh2 对已断开 client 同步抛错), 未转 SshError。A3-3 记录。
- P5(观察) ssh2 v1.17 sftp.extensions 实测为 undefined → writeFileAtomic 覆盖写恒走 rename+unlink 回退(存在极小非原子窗口), posix-rename 分支实际不可达。A2-2 记录。
- P6(观察) maxConnections 只限制并发建立连接(排队), 不淘汰已缓存连接: 8 个不同 hostId 全排队成功后 conns.size=8。A4-2 记录。
- P7(前提纠正) macOS(次) 主机 SFTP 实测可用(sshd_config.d/100-macos.conf 显式启用了 Subsystem sftp),"SFTP 被禁"前提不成立; SFTP 不可用降级路径改用 mock conn.sftp 抛错验证(B10-3), 文案完整。
- P8(说明) 套件当前 2 项红均为 P1 的 [KNOWN-BUG] 标记; P1 修复后应全绿输出 FUNCTIONAL-LIVE-TEST-OK。

## 5. 复跑方式

cd packages/dsh-ssh && node scripts/functional-live-test.mjs
环境: DSH_SSH_TEST_KEY_PATH 可覆盖密钥路径; 输出含每用例 PASS/FAIL、汇总表、RESULT-JSON; 任一 FAIL 退出码 1。

[^1]: RFC 5737 示例地址，非真实主机；端口为占位符。
