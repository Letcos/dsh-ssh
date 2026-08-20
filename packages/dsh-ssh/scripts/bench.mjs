#!/usr/bin/env node
// @dsh-ssh/dsh-ssh benchmark: real numbers against the test remote (README 真实数据来源).
// 测量: 建连耗时 / exec 往返延迟 / SFTP 读写吞吐 / 远端 glob / 远端 grep。
// 仅使用远端 /tmp(dsh-ssh-bench-<pid>), 结束后清理; 不碰 settings.yaml 与用户 known_hosts。
// PREREQ: reachable test remote (defaults + DSH_SSH_TEST_* overrides in test/live-config.mjs).
// Switch machines by exporting the DSH_SSH_TEST_* vars; touches only /tmp/dsh-ssh-* on the remote.
import os from 'node:os';
import { SshPool, shellQuoteSingle, buildRemoteCommand } from '../src/ssh-core.js';
import { liveConfig, liveHostConfig, requireRealHost } from '../test/live-config.mjs';
requireRealHost('scripts/bench');

// 主机/私钥统一来自 live-config(A.38): 默认 ubuntu@203.0.113.10 / id_ed25519, 全支持环境变量覆盖。
const cfg = {
  ...liveHostConfig({ id: 'bench' }),
  name: 'bench',
  knownHostsPath: '/tmp/dsh-ssh-test-known_hosts',
  acceptNew: true,
  connectTimeoutMs: 15_000,
};

const remoteRoot = liveConfig.remoteRoot + '-bench-' + process.pid;

function median(arr) { const s = [...arr].sort((a, b) => a - b); return s.length % 2 ? s[Math.floor(s.length / 2)] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; }
function p95(arr) { return [...arr].sort((a, b) => a - b)[Math.floor(arr.length * 0.95)]; }
function stats(ms) { return { n: ms.length, avg: (ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1), median: median(ms).toFixed(1), p95: p95(ms).toFixed(1) }; }
function mbps(bytes, ms) { return ((bytes / (1024 * 1024)) / (ms / 1000)).toFixed(1); }

const pool = new SshPool({ maxConnections: 1 });
const out = [];
try {
  // 1. 建连耗时(冷连接)
  const t0 = performance.now();
  const conn = await pool.acquire(cfg);
  await conn.exec('true');
  const connectMs = performance.now() - t0;
  out.push(['建连 + 首条命令(冷连接)', `${connectMs.toFixed(0)} ms`, '']);

  // 2. exec 往返延迟(20 次 'true')
  const execMs = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const r = await conn.exec('true');
    if (r.code !== 0) throw new Error('exec true failed');
    execMs.push(performance.now() - t);
  }
  const es = stats(execMs);
  out.push(['exec 往返延迟(20 次 true)', `avg ${es.avg} / median ${es.median} / p95 ${es.p95} ms`, '']);

  // 3. 准备: 远端测试树(10 目录 × 20 文件, 含少量可 grep 内容)
  await conn.exec(`mkdir -p ${shellQuoteSingle(remoteRoot)}`);
  await conn.exec(buildRemoteCommand(
    `i=0; for d in $(seq 1 10); do mkdir -p bench-d$d; for f in $(seq 1 20); do i=$((i+1)); if [ $((i % 7)) -eq 0 ]; then echo "needle-$i" > bench-d$d/file$f.txt; else echo "content-$i" > bench-d$d/file$f.txt; fi; done; done; echo "files=$i"`,
    remoteRoot));
  const sftp = await conn.sftp();

  // 4. SFTP 读吞吐(1 MiB)
  await conn.exec(`rm -f bench-1m.bin`); // 清理上次可能的残留(修复前写到 HOME 的版本)
  await conn.exec(buildRemoteCommand(`dd if=/dev/urandom of=bench-1m.bin bs=1M count=1 2>/dev/null`, remoteRoot));
  {
    const t = performance.now();
    const bytes = await sftp.readBytes(remoteRoot + '/bench-1m.bin');
    const ms = performance.now() - t;
    out.push(['SFTP 读(1 MiB 单次 readBytes)', `${ms.toFixed(0)} ms`, `${mbps(bytes.length, ms)} MiB/s`]);
  }
  // 5. SFTP 写吞吐(1 MiB, 原子写)
  const oneMiB = Buffer.alloc(1024 * 1024, 0x61);
  {
    const t = performance.now();
    await sftp.writeFileAtomic(remoteRoot + '/bench-write-1m.bin', oneMiB);
    const ms = performance.now() - t;
    out.push(['SFTP 写(1 MiB 原子写: 临时文件+rename)', `${ms.toFixed(0)} ms`, `${mbps(oneMiB.length, ms)} MiB/s`]);
  }
  // 6. 远端 glob(find 实现, 200 文件树)
  {
    const t = performance.now();
    const r = await conn.exec(buildRemoteCommand(`find . -type f -name '*.txt' | wc -l`, remoteRoot));
    const ms = performance.now() - t;
    out.push([`远端 glob(200 文件树 *.txt, find)`, `${ms.toFixed(0)} ms`, `命中 ${r.stdout.trim()} 个`]);
  }
  // 7. 远端 grep(grep -rnE needle)
  {
    const t = performance.now();
    const r = await conn.exec(buildRemoteCommand(`grep -rnE 'needle' . | wc -l`, remoteRoot));
    const ms = performance.now() - t;
    out.push([`远端 grep(200 文件树 needle, grep -rnE)`, `${ms.toFixed(0)} ms`, `命中 ${r.stdout.trim()} 行`]);
  }
  // 8. 清理
  await conn.exec(`rm -rf ${shellQuoteSingle(remoteRoot)}`);

  console.log('| 指标 | 结果 | 备注 |');
  console.log('|---|---|---|');
  for (const [k, v, note] of out) console.log(`| ${k} | ${v} | ${note} |`);
  console.log(`\n远端: ubuntu@203.0.113.10 (Ubuntu x86_64, 公网 IP), 本机: ${os.hostname()} (${os.platform()}/${os.arch()})`);
} finally {
  await pool.dispose();
}
