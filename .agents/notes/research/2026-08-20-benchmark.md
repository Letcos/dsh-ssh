# 实测基准数据(README 真实数据来源)

> 日期: 2026-08-16(本机时钟); 脚本: packages/dsh-ssh/scripts/bench.mjs(可重跑, 参数内联)。
> 测试远端: ubuntu@203.0.113.10[^1](Ubuntu x86_64, 公网 IP); 本机: 本地主机 (darwin/arm64)。

| 指标 | 结果 | 备注 |
|---|---|---|
| 建连 + 首条命令(冷连接) | 286 ms | ssh2 全新建连 |
| exec 往返延迟(20 次 true) | avg 72.0 / median 72.0 / p95 77.3 ms | 每命令独立 exec 通道 |
| SFTP 读(1 MiB 单次 readBytes) | 992 ms | 1.0 MiB/s |
| SFTP 写(1 MiB 原子写: 临时文件+rename) | 218 ms | 4.6 MiB/s |
| 远端 glob(200 文件树 *.txt, find) | 24 ms | 命中 200 个 |
| 远端 grep(200 文件树 needle, grep -rnE) | 79 ms | 命中 28 行 |

## 说明

- 所有数字含完整 ssh2 调用链(SshPool/SshConn/SftpWrapper), 即插件实际行为而非底层裸测。
- SFTP 读明显慢于写(992ms vs 218ms @1MiB), 疑似 ssh2 默认读窗口/chunk 保守; 若 README 需要更漂亮数字, 可在 ssh-core 调 SFTP 窗口参数后重测(待办, 记录于后)。
- 远端 glob/grep 是远端单命令批量完成(设计决策 D2/R8), 200 文件树内 24/79ms, 无逐文件往返。
- 复跑: cd packages/dsh-ssh && node scripts/bench.mjs(远端只碰 /tmp, 自动清理)。

[^1]: RFC 5737 示例地址，非真实主机
