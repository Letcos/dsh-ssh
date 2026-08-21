// @dsh-ssh/dsh-ssh — remote background jobs tests (node --test, no network).
// Covers: command assembly pure functions (setsid/cd embedding/escaping/unique token), parseSpawnPid,
//       and createRemoteBashJobHooks controller shape for jobs.start ({cancel,done,readOutput} exactly).
//       readOutput must return string synchronously (registry.read() is not awaited),
//       returning Promise breaks job_output with "value is not lossless JSON". Data is read synchronously
//       from local buffered cache, populated asynchronously by done polling + _refresh test hook.
// Uses in-memory fake conn for exec/sftp, no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpawnCommand, buildKillTreeCommand, buildAliveProbeCommand,
  buildForegroundTreeKillCommand, parseSpawnPid, createRemoteBashJobHooks,
  defaultRemoteJobDir,
} from '../src/remote-jobs.js';

// ── fake conn: exec routes by command; sftp provides readBytes/unlink (in-memory file table) ──
function makeFakeConn({ pid = 4242, spawnStdout = pid + '\n', aliveCount = Infinity } = {}) {
  const files = new Map(); // path -> Buffer
  let aliveProbes = 0;
  const killCalls = [];
  const setFile = (p, v) => files.set(p, Buffer.from(v, 'utf8'));
  const sftp = {
    _files: files,
    async readBytes(p) { const b = files.get(p); if (b === undefined) throw new Error('ENOENT ' + p); return b; },
    async unlink(p) { files.delete(p); },
  };
  const conn = {
    _sftp: sftp,
    _killCalls: killCalls,
    setFile,
    async exec(cmd) {
      if (/^setsid\s/.test(cmd)) return { code: 0, stdout: spawnStdout, stderr: '' };
      if (/^kill -TERM/.test(cmd)) { killCalls.push(cmd); return { code: 0, stdout: '', stderr: '' }; }
      if (/^kill -0/.test(cmd)) {
        aliveProbes += 1;
        return { code: 0, stdout: aliveProbes <= aliveCount ? 'ALIVE' : 'DEAD', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async sftp() { return sftp; },
    async fs() { return sftp; },
  };
  return conn;
}

// ── Command assembly pure functions ─────────────────────────────────────────
test('buildSpawnCommand: setsid + cd embedded bash -c + log/status redirect + echo $!', () => {
  const cmd = buildSpawnCommand({ cmd: 'echo hi', cwd: '/tmp/w', logPath: '/tmp/w/x.log', statusPath: '/tmp/w/x.status' });
  assert.ok(cmd.startsWith('setsid bash -c '));
  assert.ok(cmd.includes('( echo hi )'));            // cd embedded inside bash -c, not outer chain
  assert.ok(cmd.includes('/tmp/w/x.status'));        // status file redirect
  assert.ok(cmd.includes('/tmp/w/x.log'));           // log redirect
  assert.ok(cmd.includes('2>&1 </dev/null'));        // detached from channel
  assert.ok(cmd.endsWith('echo $!'));                // echo background pid
  // Single command, setsid makes independent process group for group kill
  assert.equal((cmd.match(/setsid/g) || []).length, 1);
});

test('buildSpawnCommand: cwd escaped with single quotes', () => {
  const cmd = buildSpawnCommand({ cmd: 'pwd', cwd: "/tmp/it's dir", logPath: '/tmp/a.log', statusPath: '/tmp/a.status' });
  // Single quotes inside must be escaped as close-escape-open sequence to avoid injection
  assert.ok(cmd.includes("'\\''") || cmd.includes("'\''"));
  assert.ok(cmd.includes('/tmp/it')); // original path preserved
});

test('buildSpawnCommand: unique token per call (no file clash for same host)', () => {
  const a = buildSpawnCommand({ cmd: 'x', cwd: '/tmp', logPath: '/tmp/a.log', statusPath: '/tmp/a.status' });
  const b = buildSpawnCommand({ cmd: 'x', cwd: '/tmp', logPath: '/tmp/b.log', statusPath: '/tmp/b.status' });
  assert.notEqual(a, b);
});

test('buildKillTreeCommand: kills process group and orphan grandchildren', () => {
  const cmd = buildKillTreeCommand(4242);
  assert.ok(cmd.includes('-TERM -- -4242'));
  assert.ok(cmd.includes('pkill -TERM -P 4242'));
  assert.ok(cmd.endsWith('; true'));
});

test('buildAliveProbeCommand: kill -0 liveness probe', () => {
  const cmd = buildAliveProbeCommand(7);
  assert.ok(cmd.includes('kill -0 7'));
  assert.ok(cmd.includes('echo ALIVE'));
});

test('buildForegroundTreeKillCommand: exact cmdline match with regex escaping', () => {
  const cmd = buildForegroundTreeKillCommand('sleep 4 && echo (x).*', '/tmp/w');
  assert.ok(cmd.includes('pkill -TERM -f '));
  assert.ok(cmd.includes('\('));  // meta chars escaped
  assert.ok(cmd.includes('\.'));
  const cmd2 = buildForegroundTreeKillCommand('sleep 5', '');
  assert.match(cmd2, /cd sleep 5/); // without cwd no 'cd <cwd> && ' prefix
});

test('defaultRemoteJobDir: per-host isolated directory', () => {
  assert.equal(defaultRemoteJobDir('u1'), '/tmp/dsh-ssh-jobs-u1');
  assert.equal(defaultRemoteJobDir(undefined), '/tmp/dsh-ssh-jobs-host');
});

test('parseSpawnPid: parses $! output', () => {
  assert.equal(parseSpawnPid('1234\n'), 1234);
  assert.equal(parseSpawnPid('  999  \n'), 999);
  assert.equal(parseSpawnPid(''), null);
  assert.equal(parseSpawnPid('abc'), null);
  assert.equal(parseSpawnPid('12 34'), null);
});

// ── hooks contract shape (jobs.start run() return) ─────────────────────────────
test('createRemoteBashJobHooks: returns {cancel, done, readOutput} strict contract', async () => {
  const conn = makeFakeConn();
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'echo hi', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  assert.equal(typeof hooks.cancel, 'function');
  assert.equal(typeof hooks.done.then, 'function'); // done is Promise
  assert.equal(typeof hooks.readOutput, 'function');
  // Enumerable keys strictly {cancel, done, readOutput} (aligns with official implementation).
  // _meta/_state/_spawned/_refresh are non-enumerable internals, never serialized.
  assert.deepEqual(Object.keys(hooks), ['cancel', 'done', 'readOutput']);
  // Meta (non-enumerable): unique log/status paths inside jobDir
  assert.match(hooks._meta.logPath, /^\/tmp\/dsh-ssh-jobs-u1\/[0-9a-z-]+\.log$/);
  assert.match(hooks._meta.statusPath, /^\/tmp\/dsh-ssh-jobs-u1\/[0-9a-z-]+\.status$/);
  assert.notEqual(hooks._meta.logPath, hooks._meta.statusPath);
  // readOutput must return string synchronously (Promise breaks job_output)
  assert.equal(typeof hooks.readOutput(), 'string');
  // Cleanup: terminate done polling (write status to complete) to avoid hanging timers
  conn.setFile(hooks._meta.statusPath, '0');
  await hooks.done;
});

test('createRemoteBashJobHooks: done -> completed (exit code from status file)', async () => {
  const conn = makeFakeConn({ aliveCount: 1 });
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'x', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  // Process dead + status file readable -> completed
  conn.setFile(hooks._meta.statusPath, '7');
  conn.setFile(hooks._meta.logPath, 'out\n');
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'completed');
  assert.match(outcome.detail, /exit code: 7/);
  // Cleanup log/status after termination
  assert.equal(conn._sftp._files.size, 0);
});

test('createRemoteBashJobHooks: cancel -> killed with no leftover files', async () => {
  // aliveCount=1: first probe ALIVE, second DEAD -> process gone after kill, done converges to killed
  const conn = makeFakeConn({ aliveCount: 1 });
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'sleep 20', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;            // wait for spawn to get pid
  conn.setFile(hooks._meta.logPath, 'x');
  hooks.cancel();
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'killed');
  assert.ok(conn._killCalls.length > 0);
  assert.ok(conn._killCalls[0].includes('-- -4242')); // kill process group (negative pid)
  assert.equal(conn._sftp._files.size, 0);            // cleanup status/log
});

test('createRemoteBashJobHooks: readOutput incremental read (cursor advances)', async () => {
  const conn = makeFakeConn();
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'x', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  const logPath = hooks._meta.logPath;
  conn.setFile(logPath, 'alpha\n');
  await hooks._refresh();                            // sync contract: buffer filled async by _refresh/done polling
  assert.equal(hooks.readOutput(), 'alpha\n');      // readOutput returns string synchronously
  conn.setFile(logPath, 'alpha\nbeta\n');
  await hooks._refresh();
  assert.equal(hooks.readOutput(), 'beta\n');       // incremental
  assert.equal(hooks.readOutput(), '');              // no new data
  // Terminate done polling (write status to complete) to avoid hanging timers
  conn.setFile(hooks._meta.statusPath, '0');
  await hooks.done;
});


test('createRemoteBashJobHooks: long task does not falsely complete when process alive and no status file, done stays pending', async () => {
  // Guard: channel close does not mean process exit; the job must poll via alive probe,
  // so alive + no status file -> remain pending.
  const conn = makeFakeConn({ aliveCount: Infinity }); // always ALIVE, no status file
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'sleep 600', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  const raced = await Promise.race([
    hooks.done.then((o) => ({ settled: true, o })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 250)),
  ]);
  assert.equal(raced.settled, false, 'done must not complete while process is alive and no status file');
  // Cleanup: write status to converge polling to completed to avoid hanging timers
  conn.setFile(hooks._meta.statusPath, '0');
  const o = await hooks.done;
  assert.equal(o.status, 'completed');
  assert.match(o.detail, /exit code: 0/);
});

test('createRemoteBashJobHooks: reading incremental output while running does not settle task', async () => {
  const conn = makeFakeConn({ aliveCount: Infinity });
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'echo a; sleep 600; echo b', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  conn.setFile(hooks._meta.logPath, 'a\n');
  await hooks._refresh();
  assert.equal(hooks.readOutput(), 'a\n');
  const raced = await Promise.race([
    hooks.done.then((o) => ({ settled: true, o })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 150)),
  ]);
  assert.equal(raced.settled, false, 'reading output while running must not settle task');
  conn.setFile(hooks._meta.logPath, 'a\nb\n');
  await hooks._refresh();
  assert.equal(hooks.readOutput(), 'b\n'); // incremental read ok
  conn.setFile(hooks._meta.statusPath, '0');
  await hooks.done;
});

test('createRemoteBashJobHooks: cancel converges to killed even if process lingers, no leftover tree', async () => {
  // aliveCount=3: ALIVE x3 (kill signal delay), then DEAD -> converges to killed
  const conn = makeFakeConn({ aliveCount: 3 });
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'sleep 60', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  hooks.cancel();                       // send kill tree command
  const o = await hooks.done;
  assert.equal(o.status, 'killed');
  assert.match(o.detail, /signal: TERM/);
  assert.ok(conn._killCalls.length > 0);
  assert.ok(conn._killCalls[0].includes('-- -4242')); // kill process group
  assert.equal(conn._sftp._files.size, 0);            // no leftover files
});

test('createRemoteBashJobHooks: parse failure (spawn output without pid) -> done rejects', async () => {
  const conn = makeFakeConn({ spawnStdout: 'no pid here\n' });
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'x', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await assert.rejects(hooks.done, /could not parse background pid/);
});

test('createRemoteBashJobHooks: mkdir -p jobDir before spawn', async () => {
  // The jobDir is created idempotently before spawn so log/status redirects land on disk.
  const calls = [];
  const conn = makeFakeConn();
  conn.exec = async (cmd) => { calls.push(cmd); if (/^mkdir -p /.test(cmd)) return { code: 0, stdout: '', stderr: '' }; return { code: 0, stdout: '4242\n', stderr: '' }; };
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'x', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  assert.ok(/^mkdir -p '\/tmp\/dsh-ssh-jobs-u1'$/.test(calls[0]), 'first exec must be idempotent mkdir -p jobDir, got: ' + JSON.stringify(calls[0]));
  assert.ok(/^setsid bash -c /.test(calls[1]), 'mkdir must be before spawn, got: ' + JSON.stringify(calls[1]));
  // Cleanup: write status to converge done to avoid hanging timers
  conn.setFile(hooks._meta.statusPath, '0');
  await hooks.done;
});

test('createRemoteBashJobHooks: process exits without writing status (ec=null) -> failed not completed exit 0', async () => {
  // Guard: a process that dies quickly without ever writing a status file must report failed,
  // not a fabricated 'completed exit code: 0'.
  const conn = makeFakeConn({ aliveCount: 0 }); // first probe DEAD, no status file
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'x', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail, /before reporting an exit status/);
  assert.equal(conn._sftp._files.size, 0); // no leftover
});
