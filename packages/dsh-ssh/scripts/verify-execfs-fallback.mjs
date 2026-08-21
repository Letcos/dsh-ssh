#!/usr/bin/env node
// @dsh-ssh/dsh-ssh — SFTP disabled fallback (ExecFs) live verification.
// Uses the forceExecFs switch (connection-layer test switch, does not change remote sshd or real config) to simulate "SFTP unavailable",
// and exercises the full ExecFs (exec+base64) path on /tmp/dsh-ssh-sftp-fallback: read/write/stat/readdir/
// rename/unlink/mkdir + large-file chunking, comparing results with the SFTP path on the same host; also starts a
// background job via the degraded connection to verify logs/status are fetched and cleaned via ExecFs. Cleans up /tmp/dsh-ssh-sftp-fallback
// and /tmp/dsh-ssh-jobs-fb afterwards.
// PREREQ: reachable test remote (defaults + DSH_SSH_TEST_* overrides in test/live-config.mjs).
// Switch machines by exporting the DSH_SSH_TEST_* vars; touches only /tmp/dsh-ssh-* on the remote.
import { SshPool, shellQuoteSingle } from '../src/ssh-core.js';
import { createRemoteBashJobHooks, defaultRemoteJobDir } from '../src/remote-jobs.js';
import { liveConfig, liveHostConfig, requireRealHost } from '../test/live-config.mjs';
requireRealHost('scripts/verify-execfs-fallback');

// Host/private-key config comes from live-config; defaults to id_ed25519, overridable via DSH_SSH_TEST_KEY_PATH.
const REMOTE = liveConfig.remoteRoot + '-sftp-fallback';
const JOB_DIR = defaultRemoteJobDir('fb'); // /tmp/dsh-ssh-jobs-fb
const cfgBase = {
  ...liveHostConfig({}),
  knownHostsPath: '/tmp/dsh-ssh-test-known_hosts', acceptNew: true, connectTimeoutMs: 10_000,
};

// watchdog: prevents the script from hanging with no output on any deadlock (connection/polling).
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

const connS = await pool.acquire({ ...cfgBase, id: 'sf', forceExecFs: false }); // SFTP normal
const connF = await pool.acquire({ ...cfgBase, id: 'fb', forceExecFs: true });  // forced fallback
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

  await fsS.writeFileAtomic(pBin, bin);            // SFTP write binary
  await fsF.writeFileAtomic(pText, Buffer.from(text, 'utf8')); // fallback write text
  await fsF.writeFileAtomic(pBinF, bin);           // fallback write binary

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
  await new Promise((r) => setTimeout(r, 400)); // process still alive, log already contains TICK-* -> verify mid-run incremental fetch
  await hooks._refresh();
  const liveOut = hooks.readOutput();
  const doneRes = await hooks.done;
  check('fallback background job completed', doneRes && doneRes.status === 'completed', JSON.stringify(doneRes));
  check('fallback live output pulled via execfs (mid-run)', /TICK-1/.test(liveOut) && /TICK-2/.test(liveOut), JSON.stringify(liveOut));
  // Final persistent data read back via execfs (marker written by the job), proving degraded reads work both during and after the job lifetime
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
