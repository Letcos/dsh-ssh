// @dsh-ssh/dsh-ssh — M5 remote background jobs (A.22/A.30) 单测 (node --test, no network).
// 覆盖: 命令组装纯函数(setsid/cd 内嵌/转义/唯一 token)、parseSpawnPid、
//       createRemoteBashJobHooks 的 jobs.start 控制器契约形状({cancel,done,readOutput} 严格三键)。
//       A.30: readOutput 必须**同步**返回 string(官方 registry.read() 不 await, 见 dsh-jobs-local L190),
//       返回 Promise 会让 job_output 报 "value is not lossless JSON"。同步读走本地 buffered 缓冲,
//       缓冲由 done 轮询 + _refresh 测试钩子(不可枚举内窥)异步填充。
// 用内存 fake conn 模拟 exec/sftp, 不触碰真实网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpawnCommand, buildKillTreeCommand, buildAliveProbeCommand,
  buildForegroundTreeKillCommand, parseSpawnPid, createRemoteBashJobHooks,
  defaultRemoteJobDir,
} from '../src/remote-jobs.js';

// ── fake conn: exec 按命令内容分路; sftp 提供 readBytes/unlink(内存文件表) ──
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

// ── 命令组装纯函数 ─────────────────────────────────────────────────────────
test('buildSpawnCommand: setsid + cd 内嵌 bash -c + 日志/status 重定向 + echo $!', () => {
  const cmd = buildSpawnCommand({ cmd: 'echo hi', cwd: '/tmp/w', logPath: '/tmp/w/x.log', statusPath: '/tmp/w/x.status' });
  assert.ok(cmd.startsWith('setsid bash -c '));
  assert.ok(cmd.includes('( echo hi )'));            // cd 内嵌进 bash -c, 非外层链
  assert.ok(cmd.includes('/tmp/w/x.status'));        // status 文件重定向
  assert.ok(cmd.includes('/tmp/w/x.log'));           // 日志重定向
  assert.ok(cmd.includes('2>&1 </dev/null'));        // 脱离通道存活
  assert.ok(cmd.endsWith('echo $!'));                // 回显后台 pid
  // 单条命令(无外层中继), setsid 使其独立进程组 → 可整组杀
  assert.equal((cmd.match(/setsid/g) || []).length, 1);
});

test('buildSpawnCommand: cwd 用单引号转义(防注入)', () => {
  const cmd = buildSpawnCommand({ cmd: 'pwd', cwd: "/tmp/it's dir", logPath: '/tmp/a.log', statusPath: '/tmp/a.status' });
  // 单引号串内的裸单引号必须转义为闭包-转义-开包序列, 否则会截断字符串注入
  assert.ok(cmd.includes("'\\''") || cmd.includes("'\''"));
  assert.ok(cmd.includes('/tmp/it')); // 原路径仍完整保留
});

test('buildSpawnCommand: 唯一 token 区分多次调用(同 host 文件不冲突)', () => {
  const a = buildSpawnCommand({ cmd: 'x', cwd: '/tmp', logPath: '/tmp/a.log', statusPath: '/tmp/a.status' });
  const b = buildSpawnCommand({ cmd: 'x', cwd: '/tmp', logPath: '/tmp/b.log', statusPath: '/tmp/b.status' });
  assert.notEqual(a, b);
});

test('buildKillTreeCommand: 杀进程组 + 补杀孙进程', () => {
  const cmd = buildKillTreeCommand(4242);
  assert.ok(cmd.includes('-TERM -- -4242'));
  assert.ok(cmd.includes('pkill -TERM -P 4242'));
  assert.ok(cmd.endsWith('; true'));
});

test('buildAliveProbeCommand: kill -0 探活', () => {
  const cmd = buildAliveProbeCommand(7);
  assert.ok(cmd.includes('kill -0 7'));
  assert.ok(cmd.includes('echo ALIVE'));
});

test('buildForegroundTreeKillCommand: 精确匹配 cmdline + 正则转义特殊字符', () => {
  const cmd = buildForegroundTreeKillCommand('sleep 4 && echo (x).*', '/tmp/w');
  assert.ok(cmd.includes('pkill -TERM -f '));
  assert.ok(cmd.includes('\('));  // 元字符被转义
  assert.ok(cmd.includes('\.'));
  const cmd2 = buildForegroundTreeKillCommand('sleep 5', '');
  assert.match(cmd2, /cd sleep 5/); // 无 cwd 时不带 'cd <cwd> && ' 前缀
});

test('defaultRemoteJobDir: 每 host 独立目录', () => {
  assert.equal(defaultRemoteJobDir('u1'), '/tmp/dsh-ssh-jobs-u1');
  assert.equal(defaultRemoteJobDir(undefined), '/tmp/dsh-ssh-jobs-host');
});

test('parseSpawnPid: 解析 $! 输出', () => {
  assert.equal(parseSpawnPid('1234\n'), 1234);
  assert.equal(parseSpawnPid('  999  \n'), 999);
  assert.equal(parseSpawnPid(''), null);
  assert.equal(parseSpawnPid('abc'), null);
  assert.equal(parseSpawnPid('12 34'), null);
});

// ── hooks 契约形状(jobs.start 的 run() 返回值) ─────────────────────────────
test('createRemoteBashJobHooks: 返回 {cancel, done, readOutput} 严格契约', async () => {
  const conn = makeFakeConn();
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'echo hi', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  assert.equal(typeof hooks.cancel, 'function');
  assert.equal(typeof hooks.done.then, 'function'); // done 是 Promise
  assert.equal(typeof hooks.readOutput, 'function');
  // A.30: 可枚举键严格 = {cancel, done, readOutput}(不多不少, 对齐官方 dsh-tool-bash L418-425)。
  // _meta/_state/_spawned/_refresh 是**不可枚举**内窥字段, 永不进入 registry 记录/序列化。
  assert.deepEqual(Object.keys(hooks), ['cancel', 'done', 'readOutput']);
  // 元信息(不可枚举但仍可访问): jobDir 内唯一的 log/status 路径
  assert.match(hooks._meta.logPath, /^\/tmp\/dsh-ssh-jobs-u1\/[0-9a-z-]+\.log$/);
  assert.match(hooks._meta.statusPath, /^\/tmp\/dsh-ssh-jobs-u1\/[0-9a-z-]+\.status$/);
  assert.notEqual(hooks._meta.logPath, hooks._meta.statusPath);
  // readOutput 必须同步返回 string(A.30; Promise 会使 job_output 非 lossless JSON)
  assert.equal(typeof hooks.readOutput(), 'string');
  // 收尾: 终止 done 轮询(写 status 使其 completed), 避免后台定时器挂住测试子进程
  conn.setFile(hooks._meta.statusPath, '0');
  await hooks.done;
});

test('createRemoteBashJobHooks: done → completed(exit code 来自 status 文件)', async () => {
  const conn = makeFakeConn({ aliveCount: 1 });
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'x', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  // 进程已 DEAD + status 文件可读 → 视为 completed
  conn.setFile(hooks._meta.statusPath, '7');
  conn.setFile(hooks._meta.logPath, 'out\n');
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'completed');
  assert.match(outcome.detail, /exit code: 7/);
  // 终止后清理 log/status 文件
  assert.equal(conn._sftp._files.size, 0);
});

test('createRemoteBashJobHooks: cancel → killed + 下发杀树命令 + 无残留', async () => {
  // aliveCount=1: 首探 ALIVE, 次探 DEAD → 杀树后进程消亡, done 以 killed 收敛
  const conn = makeFakeConn({ aliveCount: 1 });
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'sleep 20', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;            // 等 spawn 完成拿到 pid
  conn.setFile(hooks._meta.logPath, 'x');
  hooks.cancel();
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'killed');
  assert.ok(conn._killCalls.length > 0);
  assert.ok(conn._killCalls[0].includes('-- -4242')); // 杀进程组(负 pid)
  assert.equal(conn._sftp._files.size, 0);            // 清理 status/log
});

test('createRemoteBashJobHooks: readOutput 同步增量读(游标推进, A.30 契约)', async () => {
  const conn = makeFakeConn();
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'x', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  const logPath = hooks._meta.logPath;
  conn.setFile(logPath, 'alpha\n');
  await hooks._refresh();                            // 同步契约: 缓冲由 _refresh/done 轮询异步填充
  assert.equal(hooks.readOutput(), 'alpha\n');      // readOutput 同步返回 string
  conn.setFile(logPath, 'alpha\nbeta\n');
  await hooks._refresh();
  assert.equal(hooks.readOutput(), 'beta\n');       // 增量
  assert.equal(hooks.readOutput(), '');              // 无新增
  // 让 done 轮询终止(写 status 文件使其 completed), 避免后台定时器挂住测试进程
  conn.setFile(hooks._meta.statusPath, '0');
  await hooks.done;
});


test('createRemoteBashJobHooks: 长任务不假完成 —— 进程存活+无 status 文件时 done 保持 pending(A.33 回归守卫)', async () => {
  // 回归守卫: 通道 close ≠ 进程退出。老的假完成实现一旦 spawn exec 通道关闭就上报 completed;
  // 修复后必须靠 alive probe(kill -0)轮询判定, 进程 ALIVE + 无 status 文件 → 持续 pending。
  const conn = makeFakeConn({ aliveCount: Infinity }); // 永远 ALIVE, 不写 status 文件
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'sleep 600', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  const raced = await Promise.race([
    hooks.done.then((o) => ({ settled: true, o })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 250)),
  ]);
  assert.equal(raced.settled, false, 'done 不得在进程仍存活且无 status 文件时提前 completed(假完成回归)');
  // 收尾: 写 status 文件使轮询收敛为 completed, 避免后台定时器挂住测试进程
  conn.setFile(hooks._meta.statusPath, '0');
  const o = await hooks.done;
  assert.equal(o.status, 'completed');
  assert.match(o.detail, /exit code: 0/);
});

test('createRemoteBashJobHooks: 运行中读增量输出不会使任务 settle(A.33)', async () => {
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
  assert.equal(raced.settled, false, '运行中读输出不得 settle 任务');
  conn.setFile(hooks._meta.logPath, 'a\nb\n');
  await hooks._refresh();
  assert.equal(hooks.readOutput(), 'b\n'); // 增量读正常
  conn.setFile(hooks._meta.statusPath, '0');
  await hooks.done;
});

test('createRemoteBashJobHooks: cancel 后即使进程短暂仍存活也会收敛到 killed(A.33), 进程树无残留', async () => {
  // aliveCount=3: 先 ALIVE×3(模拟 kill 信号到进程真正退出有延迟), 再 DEAD → canceled 收敛 killed
  const conn = makeFakeConn({ aliveCount: 3 });
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'sleep 60', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  hooks.cancel();                       // 下发杀树命令
  const o = await hooks.done;
  assert.equal(o.status, 'killed');
  assert.match(o.detail, /signal: TERM/);
  assert.ok(conn._killCalls.length > 0);
  assert.ok(conn._killCalls[0].includes('-- -4242')); // 杀进程组
  assert.equal(conn._sftp._files.size, 0);            // status/log 无残留
});

test('createRemoteBashJobHooks: parse 失败(spawn 输出无 pid)→ done 兜底 reject', async () => {
  const conn = makeFakeConn({ spawnStdout: 'no pid here\n' });
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'x', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await assert.rejects(hooks.done, /could not parse background pid/);
});

test('createRemoteBashJobHooks: 先 mkdir -p jobDir 再 spawn(A.35 根因修复)', async () => {
  // 真实服务 startRemoteBackground 用 defaultRemoteJobDir(hostId) 作 jobDir 但从不建目录;
  // 目录缺失时 spawn 的 >log 重定向失败, 后台进程秒死且 status 从不写入。修复: spawn 前先幂等建目录。
  const calls = [];
  const conn = makeFakeConn();
  conn.exec = async (cmd) => { calls.push(cmd); if (/^mkdir -p /.test(cmd)) return { code: 0, stdout: '', stderr: '' }; return { code: 0, stdout: '4242\n', stderr: '' }; };
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'x', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  await hooks._spawned;
  assert.ok(/^mkdir -p '\/tmp\/dsh-ssh-jobs-u1'$/.test(calls[0]), '首个 exec 必须是幂等 mkdir -p jobDir, got: ' + JSON.stringify(calls[0]));
  assert.ok(/^setsid bash -c /.test(calls[1]), 'mkdir 之后才是 spawn, got: ' + JSON.stringify(calls[1]));
  // 收尾: 写 status 使 done 收敛, 避免后台定时器挂住测试进程
  conn.setFile(hooks._meta.statusPath, '0');
  await hooks.done;
});

test('createRemoteBashJobHooks: 进程退出但从未写 status(ec=null)→ failed 而非 completed exit 0(A.35 掩蔽修复)', async () => {
  // A.35 回归守卫: 秒完成零副作用的假象 = 后台进程秒死且 status 文件从未写入(!alive && ec===null),
  // 旧逻辑压成 'completed exit code: 0'。修复后必须报 failed, 绝不冒充成功。
  const conn = makeFakeConn({ aliveCount: 0 }); // 首探即 DEAD, 且无 status 文件
  const hooks = createRemoteBashJobHooks({ conn, cmd: 'x', cwd: '/tmp/w', hostId: 'u1', jobDir: '/tmp/dsh-ssh-jobs-u1', pollMs: 5 });
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail, /before reporting an exit status/);
  assert.equal(conn._sftp._files.size, 0); // 清理无残留
});
