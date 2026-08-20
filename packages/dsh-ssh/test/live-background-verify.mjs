// 真机验证(A.33 验收标准): sleep 30 后台任务 —— 启动后 5s 必须仍 running(done pending)、
// job_output 能按增量读到输出、job_kill 后远端 ps 确认进程组已灭。
// 前置: 仅 /tmp/dsh-ssh-verify-jobs 可写; 测完清理。运行: node test/live-background-verify.mjs (packages/dsh-ssh 下)
import { SshPool } from '../src/ssh-core.js';
import { createRemoteBashJobHooks } from '../src/remote-jobs.js';
import { liveConfig, liveHostConfig, requireRealHost } from './live-config.mjs';

// 主机 / 私钥 统一来自 live-config(A.38): 默认 ubuntu@203.0.113.10 / id_ed25519, 全支持环境变量覆盖。
const HOST_CFG = { ...liveHostConfig({ id: 'verify' }) };
const JOB_DIR = liveConfig.remoteRoot + '/jobs';
const log = (m) => console.log('[verify]', m);
async function main() {
  const pool = new SshPool();
  const conn = await pool.acquire(HOST_CFG);
  try {
    await conn.exec('mkdir -p ' + JOB_DIR, { timeoutMs: 10_000 });

    // 1) 起 sleep 30 后台任务(带周期性 echo, 验证增量输出)
    const hooks = createRemoteBashJobHooks({
      conn, cmd: 'echo TICK-1; sleep 30; echo DONE', cwd: JOB_DIR, hostId: 'verify', jobDir: JOB_DIR, pollMs: 400,
    });
    await hooks._spawned;
    const pid = hooks._state.pid;
    log('pid=' + pid);

    // 2) 启动后 5s: status 必须 still running(done pending), job_output 能读到增量
    await new Promise((r) => setTimeout(r, 5000));
    await hooks._refresh();
    const out = hooks.readOutput();
    log('@5s readOutput=' + JSON.stringify(out));
    const raced = await Promise.race([
      hooks.done.then((o) => ({ settled: true, o })),
      new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 200)),
    ]);
    if (raced.settled) throw new Error('FAIL: job completed prematurely at 5s: ' + JSON.stringify(raced.o));
    log('@5s status=running(done pending)  ✓  (readOutput=' + JSON.stringify(out) + ')');
    if (!/TICK-1/.test(out)) throw new Error('FAIL: job_output did not read TICK-1, got ' + JSON.stringify(out));

    // 3) job_kill: cancel + 等 killed
    hooks.cancel();
    const doneO = await hooks.done;
    log('after kill done=' + JSON.stringify(doneO));
    if (doneO.status !== 'killed') throw new Error('FAIL: expected killed, got ' + doneO.status);

    // 4) 远端 ps 确认进程组已灭(pid 与 sleep 30 均不残留)
    const ps = await conn.exec('ps -eo pid,pgid,args | grep -E "sleep 30|' + pid + '" | grep -v grep; echo SCAN_DONE', { timeoutMs: 10_000 });
    if (/sleep 30/.test(ps.stdout)) throw new Error('FAIL: sleep 30 process still alive: ' + ps.stdout);
    log('process group gone: ' + JSON.stringify(ps.stdout.trim()));

    await conn.exec('rm -rf ' + JOB_DIR, { timeoutMs: 10_000 }).catch(() => {});
    log('RESULT: PASS');
  } finally {
    await pool.dispose().catch(() => {});
  }
}
main().then(() => {}, (e) => { console.error('RESULT: FAIL', e); process.exit(1); });