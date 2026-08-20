#!/usr/bin/env node
// @dsh-ssh/dsh-ssh — A.36 SFTP 禁用降级(ExecFs)真机验证 (2026-08-19+).
// 用 forceExecFs 开关(连接层测试开关, 不改远端 sshd/不触碰真实配置)模拟“SFTP 不可用”,
// 对 /tmp/dsh-ssh-sftp-fallback 走 ExecFs(exec+base64)全链路: read/write/stat/readdir/
// rename/unlink/mkdir + 大文件分块, 并与同主机 SFTP 路径结果对比; 另用降级 conn 起一个
// 后台任务, 验证日志/status 经 ExecFs 拉取与清理。测完清理 /tmp/dsh-ssh-sftp-fallback
// 与 /tmp/dsh-ssh-jobs-fb。
// PREREQ: reachable test remote (defaults + DSH_SSH_TEST_* overrides in test/live-config.mjs).
// Switch machines by exporting the DSH_SSH_TEST_* vars; touches only /tmp/dsh-ssh-* on the remote.
import { SshPool, shellQuoteSingle } from '../src/ssh-core.js';
import { createRemoteBashJobHooks, defaultRemoteJobDir } from '../src/remote-jobs.js';
import { liveConfig, liveHostConfig, requireRealHost } from '../test/live-config.mjs';
requireRealHost('scripts/verify-execfs-fallback');

// 主机/私钥统一来自 live-config(A.38); 私钥默认 id_ed25519, DSH_SSH_TEST_KEY_PATH 可覆盖。
const REMOTE = liveConfig.remoteRoot + '-sftp-fallback';
const JOB_DIR = defaultRemoteJobDir('fb'); // /tmp/dsh-ssh-jobs-fb
const cfgBase = {
  ...liveHostConfig({}),
  knownHostsPath: '/tmp/dsh-ssh-test-known_hosts', acceptNew: true, connectTimeoutMs: 10_000,
};

// watchdog: 防任何卡死(连接/轮询)导致脚本悬挂无输出。
setTimeout(() => { console.error('EXECFS-LIVE-RESULT: TIMEOUT'); process.exit(3); }, 100_000).unref();

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS', name);
  else { console.log('FAIL', name, detail ?? ''); fails++; }
}
const eqBuf = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);

const pool = new SshPool({ maxConnections: 8 });
const clean = async (c) => {
  await c.exec('rm -rf ' + shellQuoteSingle(REMOTE) + ' ' + shellQuoteSingle(JOB_DIR)).catch(() => {});
  await c.exec('mkdir -p ' + shellQuoteSingle(REMOTE)).catch(() => {});
};

const connS = await pool.acquire({ ...cfgBase, id: 'sf', forceExecFs: false }); // SFTP 正常
const connF = await pool.acquire({ ...cfgBase, id: 'fb', forceExecFs: true });  // 强制降级
await clean(connS);

try {
  const fsS = await connS.fs();
  const fsF = await connF.fs();
  check('fallback fs is ExecFs (forceExecFs)', fsF && fsF.kind === 'exec');
  check('sftp path fs is SftpWrapper (not exec)', !(fsS && fsS.kind === 'exec'));

  const bin = Buffer.from([0,1,2,3,255,254,65,0,66,200,150,12,13,10]);
  const text = 'hello\n世界\nfallback 降级\n';
  const pBin = REMOTE + '/bin.dat';
  const pText = REMOTE + '/t.txt';
  const pBinF = REMOTE + '/bin-f.dat';

  await fsS.writeFileAtomic(pBin, bin);            // SFTP 写二进制
  await fsF.writeFileAtomic(pText, Buffer.from(text, 'utf8')); // 降级写文本
  await fsF.writeFileAtomic(pBinF, bin);           // 降级写二进制

  check('fallback reads SFTP-written binary (base64 roundtrip)', eqBuf(await fsF.readBytes(pBin), bin));
  check('SFTP reads fallback-written binary', eqBuf(await fsS.readBytes(pBinF), bin));
  check('fallback readText matches written text', (await fsF.readText(pText)) === text);
  const readMissingThrew = await (async () => { try { await fsF.readBytes(REMOTE + '/nope'); return false; } catch (e) { return !!(e && e.stage === 'execfs-read'); } })();
  check('fallback readBytes missing -> threw execfs-read', readMissingThrew);

  const stBin = await fsF.stat(pBin);
  check('fallback stat file type/size', stBin && stBin.type === 'file' && stBin.size === bin.length, JSON.stringify(stBin));
  check('fallback stat missing -> undefined', (await fsF.stat(REMOTE + '/nope')) === undefined);
  check('fallback stat dir type', (await fsF.stat(REMOTE))?.type === 'directory');

  const namesF = (await fsF.listDir(REMOTE)).map((e) => e.name).sort();
  const namesS = (await fsS.listDir(REMOTE)).map((e) => e.name).sort();
  check('fallback+sftp readdir agree', JSON.stringify(namesF) === JSON.stringify(namesS), JSON.stringify(namesF) + ' vs ' + JSON.stringify(namesS));

  await fsF.rename(pText, REMOTE + '/renamed.txt');
  const rSt = await fsF.stat(REMOTE + '/renamed.txt');
  check('fallback rename moved file', rSt && rSt.type === 'file' && rSt.size === Buffer.byteLength(text));
  await fsF.unlink(REMOTE + '/renamed.txt');
  check('fallback unlink removed file', (await fsF.stat(REMOTE + '/renamed.txt')) === undefined);
  await fsF.mkdir(REMOTE + '/subdir');
  check('fallback mkdir creates dir', (await fsF.stat(REMOTE + '/subdir'))?.type === 'directory');

  const big = Buffer.alloc(600 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 13) & 0xff;
  await fsF.writeFileAtomic(REMOTE + '/big.bin', big);
  check('fallback big-file write+read chunked roundtrip (600KB)', eqBuf(await fsF.readBytes(REMOTE + '/big.bin'), big));

  const marker = REMOTE + '/job-marker.txt';
  const hooks = createRemoteBashJobHooks({
    conn: connF,
    cmd: 'echo TICK-1; echo TICK-2; sleep 0.8; echo DONE; printf "MARKER-OK\\n" > ' + shellQuoteSingle(marker),
    cwd: REMOTE, hostId: 'fb', jobDir: JOB_DIR, pollMs: 150,
  });
  await hooks._spawned;
  await new Promise((r) => setTimeout(r, 400)); // 进程仍存活, log 已含 TICK-* → 验证“运行中增量拉取”
  await hooks._refresh();
  const liveOut = hooks.readOutput();
  const doneRes = await hooks.done;
  check('fallback background job completed', doneRes && doneRes.status === 'completed', JSON.stringify(doneRes));
  check('fallback live output pulled via execfs (mid-run)', /TICK-1/.test(liveOut) && /TICK-2/.test(liveOut), JSON.stringify(liveOut));
  // 终态持久数据经 execfs 读回(作业写出的 marker), 证明降级读在作业存活期内/后都可用
  const markerText = await fsF.readText(marker).catch(() => '');
  check('fallback post-job persistent read (marker)', markerText.trim() === 'MARKER-OK', JSON.stringify(markerText));
  const leftoverNames = (await fsF.listDir(JOB_DIR).catch(() => [])).map((e) => e.name);
  const jobLeftover = leftoverNames.filter((n) => /^[a-z0-9-]+\.(log|status)$/.test(n));
  check('fallback job cleanup removed status/log', jobLeftover.length === 0, JSON.stringify(jobLeftover));

  console.log(fails === 0 ? 'EXECFS-LIVE-RESULT: PASS' : 'EXECFS-LIVE-RESULT: FAIL ' + fails);
} catch (err) {
  console.error('EXECFS-LIVE-RESULT: THREW', (err && err.message) || err, 'stage=', err && err.stage);
  fails++;
} finally {
  await clean(connS);
  await connF.dispose().catch(() => {});
  await connS.dispose().catch(() => {});
  await pool.dispose().catch(() => {});
}
process.exit(fails === 0 ? 0 : 1);
