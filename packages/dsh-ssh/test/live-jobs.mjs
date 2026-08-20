// 直连实测(A.22 / A.30): 用真实 SshPool+SshConn 在 ubuntu 上跑远端后台任务, 校验:
//   - readOutput 同步契约(A.30: 官方 registry.read() 不 await; 返回 Promise 会让 job_output 报非 lossless JSON)
//   - 增量读 / done 的 completed(exit code) / cancel → killed(进程树无残留)
//   - done resolve 形状逐字段对齐官方 ProcessOutcome({status, detail})
// 前提: 仅 /tmp/dsh-ssh-jobs-* 与 /tmp/dsh-ssh-verify-jobs2 可写; 测完清理。
// 运行: node test/live-jobs.mjs  (位于 packages/dsh-ssh 下)
//
// 注: 经真实 LocalJobRegistry 的 start→job_output→JSON 往返 E2E 见 scripts/ 或临时 driver
//     (需从 DSH core 绝对路径 import dsh-jobs-local/dsh-session, 本文件自包含不引入 core 依赖)。
import { SshPool } from '../src/ssh-core.js';
import { createRemoteBashJobHooks, defaultRemoteJobDir } from '../src/remote-jobs.js';
import { liveConfig, liveHostConfig, requireRealHost } from './live-config.mjs';

// 主机 / hostId / 私钥 统一来自 live-config(A.38); 私钥默认 id_ed25519, 全支持环境变量覆盖。
const HOST_ID = liveConfig.hostId;
const HOST_CFG = { ...liveHostConfig(), id: HOST_ID };
const JOB_DIR = liveConfig.remoteRoot + '/jobs'; // 可写(红线 /tmp/dsh-ssh-*); 也可用 defaultRemoteJobDir(HOST_ID)
const log = (m) => console.log('[live]', m);

async function main() {
  const pool = new SshPool();
  const conn = await pool.acquire(HOST_CFG);
  try {
    await conn.exec('mkdir -p ' + JOB_DIR, { timeoutMs: 10_000 });

    // ── Job A: sleep 4 后写文件(验证 readOutput 增量 + done exit code + 输出文件)
    const a = createRemoteBashJobHooks({
      conn, cmd: 'echo START-A; sleep 4; echo DONE-A | tee ' + JOB_DIR + '/a.out; exit 3',
      cwd: JOB_DIR, hostId: HOST_ID, jobDir: JOB_DIR, pollMs: 200,
    });
    await a._spawned;
    log('Job A pid=' + a._state.pid + ' log=' + a._meta.logPath);
    await new Promise((r) => setTimeout(r, 1200));
    await a._refresh(); // A.30: readOutput 同步契约, 先刷新远端日志到本地缓冲
    log('A readOutput#1 type=' + typeof a.readOutput() + ' text=' + JSON.stringify(a.readOutput()));

    // ── Job B: sleep 20(将被 cancel)
    const b = createRemoteBashJobHooks({
      conn, cmd: 'echo B-START; sleep 20; echo B-END',
      cwd: JOB_DIR, hostId: HOST_ID, jobDir: JOB_DIR, pollMs: 200,
    });
    await b._spawned;
    const bPid = b._state.pid;
    log('Job B pid=' + bPid);
    await new Promise((r) => setTimeout(r, 700));
    await b._refresh();
    log('B readOutput#1=' + JSON.stringify(b.readOutput()));

    // A 进一步增量(应看到 sleep 结束后的 DONE-A)
    await new Promise((r) => setTimeout(r, 1200));
    await a._refresh();
    log('A readOutput#2=' + JSON.stringify(a.readOutput()));

    // ── cancel Job B + ps 确认进程树无残留
    b.cancel();
    const doneB = await b.done;
    log('Job B done=' + JSON.stringify(doneB));
    const probe = await conn.exec('kill -0 ' + bPid + ' 2>/dev/null && echo ALIVE || echo DEAD', { timeoutMs: 10_000 });
    log('B pid ' + bPid + ' probe=' + JSON.stringify(probe.stdout.trim()));
    const psB = await conn.exec('ps -eo pid,ppid,pgid,args | grep -E "sleep 20|' + bPid + '" | grep -v grep || echo NONE', { timeoutMs: 10_000 });
    log('ps after cancel B:\n' + psB.stdout.trim() + (psB.code === 0 ? '' : ' (exit ' + psB.code + ')'));

    // ── 等 Job A done(exit code 3)
    const doneA = await a.done;
    log('Job A done=' + JSON.stringify(doneA));
    await a._refresh(); // 收官读完整输出(日志文件可能已被 done 清理, buffered 仍有最后内容)
    const outA = a.readOutput();
    log('A readOutput(final) type=' + typeof outA + ' text=' + JSON.stringify(outA));
    const catA = await conn.exec('cat ' + JOB_DIR + '/a.out 2>&1 || echo NOFILE', { timeoutMs: 10_000 });
    log('a.out content=' + JSON.stringify(catA.stdout.trim()));

    // ── 清理
    await conn.exec('rm -rf ' + JOB_DIR, { timeoutMs: 10_000 }).catch((e) => log('cleanup warn ' + e.message));
    const leftover = await conn.exec('ls -la ' + JOB_DIR + ' 2>&1 || echo REMOVED', { timeoutMs: 10_000 });
    log('jobdir after cleanup=' + JSON.stringify(leftover.stdout.trim()));

    const psLeft = await conn.exec('ps -eo args | grep -E "dsh-ssh-verify|START-A|DONE-A|B-START|sleep 20" | grep -v grep || echo NONE', { timeoutMs: 10_000 });
    log('leftover process scan:\n' + psLeft.stdout.trim());

    if (doneA.status !== 'completed' || doneB.status !== 'killed') {
      throw new Error('unexpected statuses A=' + doneA.status + ' B=' + doneB.status);
    }
    if (typeof outA !== 'string') throw new Error('readOutput not a string (A.30 contract violated): ' + typeof outA);
    log('RESULT: PASS');
  } finally {
    await pool.dispose().catch(() => {});
  }
}

main().then(() => {}, (e) => { console.error('RESULT: FAIL', e); process.exit(1); });
