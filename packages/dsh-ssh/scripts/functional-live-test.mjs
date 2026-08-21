#!/usr/bin/env node
// @dsh-ssh/dsh-ssh functional + compatibility live test suite (functional-live-test.mjs)
// ============================================================================
// Systematically exercises @dsh-ssh/dsh-ssh capabilities on a real remote:
//   A. ssh-core primitives (exec / SFTP / reconnect / concurrency)
//   B. tools.js remote branches (bash/read/write/edit/read_image with real SshPool + minimal mock ctx)
//   C. compatibility matrix data (environment collection)
// Output: this suite + .agents/notes/research/2026-08-20-compat-matrix.md (sourced from this suite's output).
//
// Hard constraints (consistent with agents.md):
//   * read-only on existing code (imports resolve to latest at runtime, no file modifications);
//   * do not write ~/.dsh/settings.yaml (in-memory config only);
//   * do not touch user ~/.ssh/known_hosts (verification file is fixed at /tmp/dsh-ssh-test-known_hosts;
//     acceptNew is a fallback for this script only, same as scripts/live-smoke.mjs);
//   * on the remote, only touch self-created dirs under /tmp and clean up on exit;
//   * do not start any DSH service processes; do not modify the DSH core checkout.
//
// Usage:   cd packages/dsh-ssh && node scripts/functional-live-test.mjs
// PREREQ: reachable test remote (defaults + DSH_SSH_TEST_* overrides in test/live-config.mjs).
// Switch machines by exporting the DSH_SSH_TEST_* vars; touches only /tmp/dsh-ssh-* on the remote.
// Env:   DSH_SSH_TEST_KEY_PATH (default ~/.ssh/id_ed25519)
//        DSH_SSH_TEST_MACOS_PORT (second host SSH port; when unset the macOS section is skipped),
//        DSH_SSH_TEST_MACOS_USER (second host login user, default testuser).
// Output:   per-case PASS/FAIL (with timing/key data) + summary; any FAIL -> exit 1;
//         all green -> print FUNCTIONAL-LIVE-TEST-OK.
// ============================================================================
import { SshPool, SshError, SftpWrapper, shellQuoteSingle, buildRemoteCommand } from '../src/ssh-core.js';
import { ExecFs } from '../src/exec-fs.js'; // SFTP disabled -> exec fallback layer
import { apply } from '../tools.js';
import { mapRemoteToLocal } from '../src/router.js';
import { readFile } from 'node:fs/promises';
import { liveConfig, requireRealHost } from '../test/live-config.mjs';
requireRealHost('scripts/functional-live-test');

// ── Environment/host config (in-memory, not persisted; host/key unified from live-config) ──
const KEY_PATH = liveConfig.keyPath;
const KNOWN_HOSTS = '/tmp/dsh-ssh-test-known_hosts';
process.env.DSH_SSH_REMOTE_ROOT = '/tmp/dsh-ssh-flt-placeholder-' + process.pid;

const mkCfg = (id, host, port, user) => ({
  id, name: id, host, port, user,
  auth: { type: 'key', privateKeyPath: KEY_PATH },
  knownHostsPath: KNOWN_HOSTS,
  acceptNew: true, // fallback for this script only (file already contains host key)
  connectTimeoutMs: 10_000,
});
const UBUNTU = mkCfg('ubuntu-live', liveConfig.host, liveConfig.port, liveConfig.user);
// macOS is an optional second host on the same address but a different SSH port.
// It is exercised only when DSH_SSH_TEST_MACOS_PORT is set; otherwise the macOS section is skipped.
const HAS_MACOS = process.env.DSH_SSH_TEST_MACOS_PORT !== undefined && process.env.DSH_SSH_TEST_MACOS_PORT !== '';
const MACOS = mkCfg('macos-live', liveConfig.host, Number(process.env.DSH_SSH_TEST_MACOS_PORT), process.env.DSH_SSH_TEST_MACOS_USER || 'testuser');
const UNREACH = { ...mkCfg('unreach', '127.0.0.1', 1, 'nobody'), connectTimeoutMs: 5_000 };

// ── Test harness ──────────────────────────────────────────────────────────────
const results = [];
let passed = 0, failed = 0;
const KNOWN_BUG_TAG = '[KNOWN-BUG: readBytes-pipeline-duplication]';

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(label + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
}

// Check whether buf is an exact N-times repeat of base (length n) — the duplicated-content shape this suite detects.
function isExactRepeat(buf, n) {
  if (n <= 0 || buf.length % n !== 0 || buf.length === n) return false;
  const base = buf.subarray(0, n);
  for (let i = n; i < buf.length; i += n) {
    if (!buf.subarray(i, i + n).equals(base)) return false;
  }
  return true;
}
// readBytes consistency assertion: on duplicated-content or same-length-misaligned shapes, throw the known-bug marker.
function assertBytesEqual(actual, expected, label) {
  const exp = Buffer.isBuffer(expected) ? expected : Buffer.from(expected);
  if (actual.length === exp.length && actual.equals(exp)) return;
  if (isExactRepeat(actual, exp.length)) {
    throw new Error(KNOWN_BUG_TAG + ' ' + label + ': readBytes 返回 ' + actual.length + ' 字节 = ' + (actual.length / exp.length) + '× ' + exp.length + '(检测到内容重复污染)');
  }
  if (actual.length === exp.length) {
    throw new Error(KNOWN_BUG_TAG + ' ' + label + ': readBytes 返回等长但内容错位 ' + actual.length + ' 字节(检测到内容错位污染)');
  }
  throw new Error(label + ': readBytes 返回 ' + actual.length + ' 字节, 期望 ' + exp.length);
}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    passed++;
    results.push({ name, pass: true, ms: Date.now() - t0, note: (info && info.note) || '', data: info && info.data });
    console.log('PASS  ' + name + '  (' + (Date.now() - t0) + 'ms)' + ((info && info.note) ? '  ' + info.note : ''));
  } catch (e) {
    failed++;
    const msg = (e && e.message) ? e.message : String(e);
    results.push({ name, pass: false, ms: Date.now() - t0, note: msg });
    console.log('FAIL  ' + name + '  (' + (Date.now() - t0) + 'ms)  ' + msg);
  }
}

// macOS cases run only when a second host is configured (DSH_SSH_TEST_MACOS_PORT set).
async function testMac(name, fn) {
  if (!HAS_MACOS) { console.log('[skip] ' + name + ': 未配置 macOS 第二主机(未设 DSH_SSH_TEST_MACOS_PORT)'); return; }
  await test(name, fn);
}

const cleanup = []; // { conn, dir }
function trackDir(conn, dir) { cleanup.push({ conn, dir }); }
async function ensureDir(conn, dir) {
  const r = await conn.exec('mkdir -p ' + shellQuoteSingle(dir));
  assert(r.code === 0, 'mkdir ' + dir + ' failed: ' + r.stderr);
}
async function rmrf(conn, dir) {
  try { await conn.exec('rm -rf ' + shellQuoteSingle(dir)); } catch { /* best effort */ }
}
// Best-effort teardown used on both success and failure paths: removes tracked
// remote dirs and disposes the pools. References poolA/poolB via module scope.
async function cleanupAll() {
  for (const { conn, dir } of cleanup) {
    try { await conn.exec('rm -rf ' + shellQuoteSingle(dir)); } catch { /* best effort */ }
  }
  await poolA.dispose().catch(() => {});
  if (poolB) await poolB.dispose().catch(() => {});
}

// ── tools.js reuse: same makeCtx/makeExec structure as test/tools-remote.test.js ──
function makeCtx({ hosts, sshPool, attachments }) {
  const registered = new Map();
  return {
    tools: {
      register(def) { registered.set(def.name, def); return () => registered.delete(def.name); },
      get() { return undefined; },
    },
    shell: { sandboxMode: undefined },
    fs: { sandboxMode: undefined },
    get(key) {
      if (key === 'sshPool') return sshPool;
      if (key === 'settings') return { get: () => ({ hosts }) };
      if (key === 'attachments') return attachments;
      return undefined;
    },
    logger: { info: () => {} },
    _registered: registered,
  };
}
const makeExec = (hostId, remotePath) => ({
  agent: { session: { header: { cwd: mapRemoteToLocal(hostId, remotePath) } } },
  signal: undefined,
});
const getTool = (ctx, name) => ctx._registered.get(name);

// read_image attachment mock: parse PNG IHDR to get real dimensions, save bytes for verification
function makeAttachments() {
  const saved = new Map();
  return {
    saved,
    imageLimits: {
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxImageBytes: 10 * 1024 * 1024,
      maxMessageImageBytes: 10 * 1024 * 1024,
    },
    saveImage: async ({ data, mediaType, name }) => {
      const width = data.readUInt32BE(16);
      const height = data.readUInt32BE(20);
      const attachmentId = 'att-' + saved.size;
      saved.set(attachmentId, { data, mediaType, name });
      return { attachmentId, mediaType, bytes: data.length, width, height, name };
    },
  };
}

// ── 1x1 PNG (base64, verified: 70 bytes, magic+IHDR size 1x1) ─────────────────
const PNG_1X1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ═══════════════════════════════════════════════════════════════════════════
// A. ssh-core primitives
// ═══════════════════════════════════════════════════════════════════════════
const poolA = new SshPool({ maxConnections: 2 });
let poolB = null;
let connU = null;
let connM = null;
const dirU = '/tmp/dsh-ssh-flt-ubuntu-' + process.pid + '-' + Date.now();
const dirM = '/tmp/dsh-ssh-flt-macos-' + process.pid + '-' + Date.now();
try {
  connU = await poolA.acquire(UBUNTU);
  trackDir(connU, dirU);
  await ensureDir(connU, dirU);
  if (HAS_MACOS) {
    connM = await poolA.acquire(MACOS);
    trackDir(connM, dirM);
    await ensureDir(connM, dirM);
  } else {
    console.log('[skip] macOS 第二主机未配置(未设 DSH_SSH_TEST_MACOS_PORT), 跳过 macOS 相关用例');
  }
} catch (err) {
  console.error('FUNCTIONAL-LIVE-TEST-SETUP-FAILED: ' + (err?.message ?? err));
  await cleanupAll();
  process.exit(1);
}

console.log('\n── A1 exec 原语 ───────────────────────────────────────────');

await test('A1-1 exec 退出码 0 + stdout', async () => {
  const r = await connU.exec('echo ok');
  assertEq(r.code, 0, 'exit code');
  assertEq(r.stdout, 'ok\n', 'stdout');
  assertEq(r.stderr, '', 'stderr');
  assertEq(r.signal, null, 'signal');
  return { data: 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) };
});

await test('A1-2 exec 非零退出码 + stdout/stderr 分离', async () => {
  const r = await connU.exec('echo out; echo err >&2; exit 7');
  assertEq(r.code, 7, 'exit code');
  assertEq(r.stdout, 'out\n', 'stdout');
  assertEq(r.stderr, 'err\n', 'stderr');
  return { data: 'code=' + r.code + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + JSON.stringify(r.stderr) };
});

await test('A1-3 exec 大输出收集完整性(seq 1 20000)', async () => {
  const r = await connU.exec('seq 1 20000');
  assertEq(r.code, 0, 'exit code');
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assertEq(lines.length, 20000, 'line count');
  assertEq(lines[0], '1', 'first line');
  assertEq(lines[19999], '20000', 'last line');
  return { data: 'stdoutBytes=' + r.stdout.length + ' lines=' + lines.length };
});

await test('A1-4 exec 超时(timeoutMs=1200 + sleep 3) → SshError exec-timeout', async () => {
  let caught = null;
  try { await connU.exec('sleep 3', { timeoutMs: 1200 }); } catch (e) { caught = e; }
  assert(caught !== null, 'expected SshError, got no error');
  assert(caught instanceof SshError, 'expected SshError, got ' + (caught && caught.constructor && caught.constructor.name));
  assertEq(caught.stage, 'exec-timeout', 'stage');
  assert(caught.message.includes('timed out after 1200ms'), 'message: ' + caught.message);
  return { data: 'stage=' + caught.stage + ' msg=' + caught.message.slice(0, 60) };
});

await test('A1-5 命令引号/特殊字符转义往返(shellQuoteSingle)', async () => {
  const tricky = 'it\'s a "double" $HOME $(id) 中文';
  const r = await connU.exec('printf %s ' + shellQuoteSingle(tricky));
  assertEq(r.code, 0, 'exit code');
  assertEq(r.stdout, tricky, 'roundtrip');
  // buildRemoteCommand: cwd contains spaces/quotes/unicode/$
  const wcwd = '/tmp/dsh-ssh-flt-spc \'q\' "d" 中文';
  await ensureDir(connU, wcwd);
  const r2 = await connU.exec('pwd', { cwd: wcwd });
  assertEq(r2.code, 0, 'pwd exit code');
  assertEq(r2.stdout.trim(), wcwd, 'pwd equals cwd');
  await rmrf(connU, wcwd);
  return { data: 'roundtripOK cwdOK' };
});

await test('A1-6 命令注入防御($( ) 与 ; 不逃逸引号)', async () => {
  const pwn = '/tmp/dsh-ssh-flt-pwned-' + process.pid;
  await rmrf(connU, pwn);
  const r1 = await connU.exec('echo ' + shellQuoteSingle('$(touch ' + pwn + ')'));
  assertEq(r1.code, 0, 'exit code');
  assertEq(r1.stdout, '$(touch ' + pwn + ')\n', 'literal echo');
  const r2 = await connU.exec('echo ' + shellQuoteSingle('a; echo PWNED'));
  assertEq(r2.stdout, 'a; echo PWNED\n', 'semicolon literal');
  const r3 = await connU.exec('test ! -e ' + shellQuoteSingle(pwn) + ' && echo safe');
  assertEq(r3.stdout, 'safe\n', 'no injection file created');
  await rmrf(connU, pwn);
  return { data: 'no file created, literals preserved' };
});

await testMac('A1-7 macOS exec 退出码 + stdout/stderr(zsh 默认 shell)', async () => {
  const r = await connM.exec('echo mac-ok; echo mac-err >&2; exit 5');
  assertEq(r.code, 5, 'exit code');
  assertEq(r.stdout, 'mac-ok\n', 'stdout');
  assertEq(r.stderr, 'mac-err\n', 'stderr');
  return { data: 'code=' + r.code + ' (zsh 下 exec 通道正常)' };
});

await testMac('A1-8 macOS exec 超时 → SshError exec-timeout', async () => {
  let caught = null;
  try { await connM.exec('sleep 3', { timeoutMs: 1200 }); } catch (e) { caught = e; }
  assert(caught !== null, 'expected SshError');
  assert(caught instanceof SshError, 'expected SshError, got ' + (caught && caught.constructor && caught.constructor.name));
  assertEq(caught.stage, 'exec-timeout', 'stage');
  return { data: 'stage=' + caught.stage };
});

console.log('\n── A2 SFTP 原语 ───────────────────────────────────────────');

await test('A2-1 writeFileAtomic 新建 + readText/stat/listDir', async () => {
  const f = dirU + '/hello.txt';
  await connU.sftp().then((s) => s.writeFileAtomic(f, Buffer.from('hello\nworld\n', 'utf8')));
  const s = await connU.sftp();
  const text = await s.readText(f);
  assertEq(text, 'hello\nworld\n', 'readText');
  const st = await s.stat(f);
  assertEq(st.type, 'file', 'type');
  assertEq(st.size, 12, 'size');
  const list = await s.listDir(dirU);
  assert(list.some((e) => e.name === 'hello.txt' && e.type === 'file'), 'listDir entry');
  return { data: 'size=' + st.size + ' listed=' + list.map((e) => e.name).join(',') };
});

await test('A2-2 writeFileAtomic 覆盖写(OpenSSH rename 回退路径) + 无临时文件残留', async () => {
  const s = await connU.sftp();
  const f = dirU + '/overwrite.txt';
  await s.writeFileAtomic(f, Buffer.from('v1', 'utf8'));
  await s.writeFileAtomic(f, Buffer.from('v2-longer-content', 'utf8'));
  const text = await s.readText(f);
  assertEq(text, 'v2-longer-content', 'content replaced');
  const list = await s.listDir(dirU);
  assert(!list.some((e) => e.name.startsWith('.dsh-tmp-')), 'no .dsh-tmp- leftovers');
  return { data: 'overwrite ok (extensions=' + JSON.stringify(s.sftp.extensions) + ')' };
});

await test('A2-3 writeFileAtomic 深层目录', async () => {
  const deep = dirU + '/a/b/c';
  await ensureDir(connU, deep);
  const f = deep + '/deep.txt';
  const s = await connU.sftp();
  await s.writeFileAtomic(f, Buffer.from('deep', 'utf8'));
  assertEq(await s.readText(f), 'deep', 'readText deep');
  return { data: f };
});

await test('A2-4 特殊文件名(空格/中文/单引号)读写往返', async () => {
  const s = await connU.sftp();
  const names = ['with space.txt', '中文-文件.txt', "it's.txt", "a 'b' c.txt"];
  for (const n of names) {
    const f = dirU + '/' + n;
    const content = 'content-' + n;
    await s.writeFileAtomic(f, Buffer.from(content, 'utf8'));
    assertEq(await s.readText(f), content, 'roundtrip ' + n);
    const st = await s.stat(f);
    assertEq(st.size, Buffer.byteLength(content), 'size ' + n);
  }
  return { data: names.join(' | ') };
});

await test('A2-5 readBytes 二进制一致性(4096 随机字节)', async () => {
  const s = await connU.sftp();
  const f = dirU + '/rand.bin';
  const buf = cryptoRandom(4096);
  await s.writeFileAtomic(f, buf);
  const rb = await s.readBytes(f);
  assertBytesEqual(rb, buf, 'random binary 4096');
  const st = await s.stat(f);
  assertEq(st.size, 4096, 'stat size');
  return { data: 'bytes=' + rb.length + ' statSize=' + st.size };
});

await test('A2-5b readBytes 跨 chunk 边界(300KB + 1MiB 随机字节)', async () => {
  const s = await connU.sftp();
  for (const size of [300 * 1024, 1024 * 1024]) {
    const f = dirU + '/rand-' + size + '.bin';
    const buf = cryptoRandom(size);
    await s.writeFileAtomic(f, buf);
    const rb = await s.readBytes(f);
    assertBytesEqual(rb, buf, 'random binary ' + size);
    const st = await s.stat(f);
    assertEq(st.size, size, 'stat size ' + size);
  }
  return { data: '300KB + 1MiB 精确一致 (chunk=256KB 流水线跨边界)' };
});

await test('A2-6 不存在文件/目录错误(SshError 字段完整性)', async () => {
  const s = await connU.sftp();
  const missing = dirU + '/does-not-exist.txt';
  const st = await s.stat(missing);
  assertEq(st, undefined, 'stat missing → undefined');
  for (const op of ['readText', 'readBytes', 'listDir']) {
    let err = null;
    try {
      if (op === 'readText') await s.readText(missing);
      else if (op === 'readBytes') await s.readBytes(missing);
      else await s.listDir(missing);
    } catch (e) { err = e; }
    assert(err !== null, op + ' missing should throw');
    assert(err instanceof SshError, op + ' error is SshError');
    assertEq(err.name, 'SshError', op + ' name');
    assertEq(err.hostId, 'ubuntu-live', op + ' hostId');
    assert(typeof err.stage === 'string' && err.stage.startsWith('sftp-'), op + ' stage: ' + err.stage);
    assert(err.message.includes(missing), op + ' message contains path');
    assert(err.cause instanceof Error, op + ' cause present');
  }
  return { data: 'stat→undefined; readText/readBytes/listDir → SshError(name/hostId/stage/message/cause 齐备)' };
});

await testMac('A2-7 macOS SFTP 特殊文件名+覆盖写+二进制(实测 SFTP 可用)', async () => {
  const s = await connM.sftp();
  const names = ['mac space.txt', 'mac中文.txt', "mac's.txt"];
  for (const n of names) {
    const f = dirM + '/' + n;
    const content = 'mac-content-' + n;
    await s.writeFileAtomic(f, Buffer.from(content, 'utf8'));
    assertEq(await s.readText(f), content, 'roundtrip ' + n);
  }
  // overwrite (APFS + OpenSSH rename fallback)
  const f2 = dirM + '/mac-overwrite.txt';
  await s.writeFileAtomic(f2, Buffer.from('v1', 'utf8'));
  await s.writeFileAtomic(f2, Buffer.from('v2-mac-longer', 'utf8'));
  assertEq(await s.readText(f2), 'v2-mac-longer', 'overwrite');
  // binary (2KB random, small file)
  const f3 = dirM + '/mac-rand.bin';
  const b3 = cryptoRandom(2048);
  await s.writeFileAtomic(f3, b3);
  const rb3 = await s.readBytes(f3);
  assertBytesEqual(rb3, b3, 'mac random binary 2048');
  return { data: '特殊文件名+覆盖写+二进制往返 ok' };
});

console.log('\n── A3 断线 / 重连 ─────────────────────────────────────────');

await test('A3-1 invalidate → 下次 acquire 重建连接并正常执行', async () => {
  const pool = new SshPool({ maxConnections: 1 });
  const c1 = await pool.acquire(UBUNTU);
  assertEq((await c1.exec('echo alive')).stdout, 'alive\n', 'first exec');
  await pool.invalidate('ubuntu-live');
  const c2 = await pool.acquire(UBUNTU);
  const r = await c2.exec('echo rebuilt');
  assertEq(r.stdout, 'rebuilt\n', 'exec after rebuild');
  assert(c1 !== c2, 'new SshConn instance');
  await pool.dispose();
  return { data: 'rebuilt exec ok' };
});

await test('A3-2 dispose 后再用 → SshError not-connected', async () => {
  const pool = new SshPool({ maxConnections: 1 });
  const c = await pool.acquire(UBUNTU);
  await c.dispose();
  let err = null;
  try { await c.exec('echo x'); } catch (e) { err = e; }
  assert(err !== null, 'expected error');
  assert(err instanceof SshError, 'SshError expected, got ' + (err && err.constructor && err.constructor.name));
  assertEq(err.stage, 'not-connected', 'stage');
  assert(err.message.includes('connection not open'), 'message: ' + err.message);
  await pool.dispose();
  return { data: 'stage=' + err.stage + ' msg=' + err.message };
});

await test('A3-3 远端人为断开(exec kill -9 $PPID) → 报错 + 重建可用', async () => {
  const pool = new SshPool({ maxConnections: 1 });
  const c = await pool.acquire(UBUNTU);
  // kill the command shell parent (sshd session) of this connection -> entire TCP connection drops
  const r0 = await c.exec('kill -9 $PPID');
  assertEq(r0.code, -1, 'killed channel exit code (-1)');
  let err = null;
  try { await c.exec('echo after-kill', { timeoutMs: 5000 }); } catch (e) { err = e; }
  assert(err !== null, 'exec after remote kill should error');
  assert(err.message.includes('Not connected'), 'message: ' + err.message);
  await pool.invalidate('ubuntu-live');
  const c2 = await pool.acquire(UBUNTU);
  const r = await c2.exec('echo recovered');
  assertEq(r.stdout, 'recovered\n', 'recovered');
  await pool.dispose();
  return { data: 'kill→code=' + r0.code + '; after→' + (err && err.constructor && err.constructor.name) + ' ' + JSON.stringify(err.message) + '; rebuild ok' };
});

console.log('\n── A4 并发 ───────────────────────────────────────────────');

await test('A4-1 同一连接并发 5 条 exec 全部成功', async () => {
  const pool = new SshPool({ maxConnections: 1 });
  const c = await pool.acquire(UBUNTU);
  const outs = await Promise.all(
    Array.from({ length: 5 }, (_, i) => c.exec('echo c' + i).then((r) => ({ i, r }))),
  );
  for (const { i, r } of outs) {
    assertEq(r.code, 0, 'exit c' + i);
    assertEq(r.stdout, 'c' + i + '\n', 'stdout c' + i);
  }
  await pool.dispose();
  return { data: '5/5 ok' };
});

await test('A4-2 maxConnections=1 池排队: 并发 8 个不同 hostId acquire+exec 全部成功', async () => {
  const pool = new SshPool({ maxConnections: 1 });
  const cfgs = Array.from({ length: 8 }, (_, i) => ({ ...UBUNTU, id: 'queue-' + i }));
  const t0 = Date.now();
  const outs = await Promise.all(cfgs.map(async (cfg) => {
    const c = await pool.acquire(cfg);
    const r = await c.exec('echo q-' + cfg.id);
    pool.release();
    return r;
  }));
  const ms = Date.now() - t0;
  for (const r of outs) assertEq(r.code, 0, 'exit');
  // observed: maxConnections limits concurrent connection establishment (queuing), but does not evict cached connections
  const sizes = pool.conns.size;
  await pool.dispose();
  return { data: '8/8 ok in ' + ms + 'ms; conns.size=' + sizes + ' (maxConnections 仅限并发 connect, 不淘汰缓存连接)' };
});

// ═══════════════════════════════════════════════════════════════════════════
// B. tools.js remote branches (real SshPool + minimal mock ctx)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B. tools.js 远端分支 ────────────────────────────────────');
poolB = new SshPool({ maxConnections: 2 });
const hostsB = { 'ubuntu-live': UBUNTU, 'macos-live': MACOS, 'unreach': UNREACH };
const attachmentsB = makeAttachments();
const ctxB = makeCtx({ hosts: hostsB, sshPool: poolB, attachments: attachmentsB });
apply(ctxB);

const REMOTE_MAX_FILE_BYTES = 10 * 1024 * 1024; // tools.js constant (remote read/edit per-file upper bound)

console.log('\n── B5 bash 工具 ──────────────────────────────────────────');

await test('B5-1 bash 成功命令 → 官方同形 foreground 结果', async () => {
  const out = await getTool(ctxB, 'bash').execute(
    { command: 'echo hi; hostname', description: 'say hi' }, makeExec('ubuntu-live', dirU));
  assertEq(out.kind, 'foreground', 'kind');
  assertEq(out.exitCode, 0, 'exitCode');
  assertEq(out.signal, null, 'signal');
  assertEq(out.timedOut, false, 'timedOut');
  assert(out.stdout.text.startsWith('hi\n'), 'stdout: ' + JSON.stringify(out.stdout.text));
  assertEq(out.stderr.text, '', 'stderr');
  return { data: 'stdout=' + JSON.stringify(out.stdout.text.trim()) };
});

await test('B5-2 bash 失败命令 → exitCode=3 + 渲染含 [exit code: 3]', async () => {
  const out = await getTool(ctxB, 'bash').execute(
    { command: 'echo out; echo err 1>&2; exit 3', description: 'fail' }, makeExec('ubuntu-live', dirU));
  assertEq(out.exitCode, 3, 'exitCode');
  assertEq(out.stdout.text, 'out\n', 'stdout');
  assertEq(out.stderr.text, 'err\n', 'stderr');
  const def = getTool(ctxB, 'bash');
  const rendered = def.output.render({ command: 'x', description: 'd' }, out);
  const text = rendered[0].text;
  assert(text.includes('[exit code: 3]'), 'render missing [exit code: 3]: ' + JSON.stringify(text));
  assert(text.includes('[stderr]') && text.includes('err'), 'render stderr section');
  return { data: 'render tail: ' + JSON.stringify(text.split('\n').slice(-2).join(' / ')) };
});

await test('B5-3 bash 大输出(seq 1 20000) → 不截断完整收集', async () => {
  const out = await getTool(ctxB, 'bash').execute(
    { command: 'seq 1 20000', description: 'big' }, makeExec('ubuntu-live', dirU));
  assertEq(out.exitCode, 0, 'exitCode');
  assertEq(out.stdout.truncated, false, 'truncated=false');
  const lines = out.stdout.text.split('\n').filter((l) => l.length > 0);
  assertEq(lines.length, 20000, 'line count');
  assertEq(lines[19999], '20000', 'last line');
  return { data: 'bytes=' + out.stdout.text.length + ' lines=' + lines.length };
});

await test('B5-4 bash 超时映射 → timedOut=true, exitCode=null', async () => {
  const out = await getTool(ctxB, 'bash').execute(
    { command: 'sleep 3; echo late', description: 'timeout', timeoutMs: 1200 }, makeExec('ubuntu-live', dirU));
  assertEq(out.kind, 'foreground', 'kind');
  assertEq(out.timedOut, true, 'timedOut');
  assertEq(out.exitCode, null, 'exitCode');
  assertEq(out.timeoutMs, 1200, 'timeoutMs');
  return { data: 'timedOut=' + out.timedOut + ' timeoutMs=' + out.timeoutMs };
});

console.log('\n── B6 read 工具 ──────────────────────────────────────────');

await test('B6-1 read 小文件 → 行号窗口 + totalLines', async () => {
  const s = await connU.sftp();
  const f = dirU + '/read-window.txt';
  await s.writeFileAtomic(f, Buffer.from('line1\nline2\nline3\n', 'utf8'));
  const out = await getTool(ctxB, 'read').execute({ file_path: f }, makeExec('ubuntu-live', dirU));
  assertEq(out.path, f, 'path');
  assertEq(out.offset, 1, 'offset');
  assertEq(out.totalLines, 3, 'totalLines');
  // readRemoteText fetches the whole file via readBytes; if polluted by the pipeline bug, totalLines doubles
  if (out.totalLines !== 3) {
    throw new Error(KNOWN_BUG_TAG + ' B6-1: read 工具经 readRemoteText(readBytes) 拉取, totalLines=' + out.totalLines + ' ≠ 3(文本被 ×' + (out.totalLines / 3) + ' 污染)');
  }
  assertEq(out.lines[0].text, 'line1', 'line1');
  assertEq(out.lines[2].text, 'line3', 'line3');
  return { data: 'totalLines=' + out.totalLines + ' lines=' + out.lines.map((l) => l.text).join('|') };
});

await test('B6-1b read 工具 300KB 文本(>256KB chunk, 非整倍)→ 行数完整', async () => {
  const s = await connU.sftp();
  const f = dirU + '/read-300k.txt';
  // 300KB = 256KB + 44KB, crosses the 256KB chunk boundary.
  const line = 'this is a longer test line 0123456789 abcdefghijklmnopqrstuvwxyz\n';
  const repeat = Math.ceil((300 * 1024) / line.length);
  const text = line.repeat(repeat);
  const expectLines = text.split('\n').filter((l) => l.length > 0).length;
  await s.writeFileAtomic(f, Buffer.from(text, 'utf8'));
  const out = await getTool(ctxB, 'read').execute({ file_path: f }, makeExec('ubuntu-live', dirU));
  if (out.totalLines !== expectLines) {
    throw new Error(KNOWN_BUG_TAG + ' B6-1b: read 工具经 readBytes 拉取 300KB 文本, totalLines=' + out.totalLines + ' ≠ ' + expectLines + '(chunk 乱序导致文本错位)');
  }
  assertEq(out.lines[0].text, line.trimEnd(), 'line1');
  return { data: 'totalLines=' + out.totalLines + ' == ' + expectLines };
});

await test('B6-2 read 大文件(12MiB > REMOTE_MAX_FILE_BYTES=10MiB) → FS_TOO_LARGE 上界保护', async () => {
  const big = dirU + '/big-12m.bin';
  const r = await connU.exec('head -c 12582912 /dev/zero > ' + shellQuoteSingle(big));
  assertEq(r.code, 0, 'create big file');
  let err = null;
  try {
    await getTool(ctxB, 'read').execute({ file_path: big }, makeExec('ubuntu-live', dirU));
  } catch (e) { err = e; }
  assert(err !== null, 'expected FS_TOO_LARGE');
  assertEq(err.code, 'FS_TOO_LARGE', 'FsError code');
  assert(err.message.includes('file too large'), 'message: ' + err.message);
  return { data: 'code=' + err.code + ' msg=' + err.message.slice(-80) };
});

await test('B6-3 read 不存在路径 → FS_NOT_FOUND', async () => {
  let err = null;
  try {
    await getTool(ctxB, 'read').execute({ file_path: dirU + '/nope.txt' }, makeExec('ubuntu-live', dirU));
  } catch (e) { err = e; }
  assert(err !== null, 'expected FS_NOT_FOUND');
  assertEq(err.code, 'FS_NOT_FOUND', 'FsError code');
  return { data: 'code=' + err.code };
});

console.log('\n── B7 write 工具 ─────────────────────────────────────────');

await test('B7-1 write 新建 → operation=create, before=null, 读回一致', async () => {
  const f = dirU + '/write-create.txt';
  const out = await getTool(ctxB, 'write').execute(
    { file_path: f, content: 'alpha\nbeta\n' }, makeExec('ubuntu-live', dirU));
  assertEq(out.path, f, 'path');
  assertEq(out.operation, 'create', 'operation');
  assertEq(out.before, null, 'before');
  assertEq(out.after, 'alpha\nbeta\n', 'after');
  const text = await connU.sftp().then((s) => s.readText(f));
  assertEq(text, 'alpha\nbeta\n', 'read-back');
  return { data: 'op=create read-back ok' };
});

await test('B7-2 write 覆盖写 → operation=update, 原子替换, 读回一致', async () => {
  const f = dirU + '/write-update.txt';
  const s = await connU.sftp();
  await s.writeFileAtomic(f, Buffer.from('old content', 'utf8'));
  const out = await getTool(ctxB, 'write').execute(
    { file_path: f, content: 'NEW CONTENT' }, makeExec('ubuntu-live', dirU));
  assertEq(out.operation, 'update', 'operation');
  assertEq(out.after, 'NEW CONTENT', 'after');
  // write's before is fetched via readBytes (current pipeline) -> if polluted it becomes duplicated text
  if (out.before !== 'old content') {
    throw new Error(KNOWN_BUG_TAG + ' B7-2: write before 经 readBytes 拉取, 期望 "old content" 得 ' + JSON.stringify(String(out.before).slice(0, 40)) + '(长度 ' + String(out.before).length + ')');
  }
  const text = await s.readText(f);
  assertEq(text, 'NEW CONTENT', 'read-back (文件本身原子替换成功)');
  return { data: 'op=update 文件替换成功, read-back ok' };
});

console.log('\n── B8 edit 工具 ──────────────────────────────────────────');

await test('B8-1 edit 精确替换 + 读回校验', async () => {
  const f = dirU + '/edit-1.txt';
  const s = await connU.sftp();
  await s.writeFileAtomic(f, Buffer.from('abc\ndef\n', 'utf8'));
  let out;
  let err = null;
  try {
    out = await getTool(ctxB, 'edit').execute(
      { file_path: f, old_string: 'abc', new_string: 'xyz' }, makeExec('ubuntu-live', dirU));
  } catch (e) { err = e; }
  if (err) {
    if (err.message.includes('appears') || err.message.includes('FS_AMBIGUOUS_EDIT')) {
      throw new Error(KNOWN_BUG_TAG + ' B8-1: edit 读到被污染的重复文本 → 本应唯一匹配变成歧义: ' + err.message);
    }
    throw err;
  }
  assertEq(out.before, 'abc\ndef\n', 'before');
  assertEq(out.after, 'xyz\ndef\n', 'after');
  const text = await s.readText(f);
  assertEq(text, 'xyz\ndef\n', 'read-back');
  return { data: 'unique replace + read-back ok' };
});

await test('B8-2 edit replace_all 多处替换', async () => {
  const f = dirU + '/edit-2.txt';
  const s = await connU.sftp();
  await s.writeFileAtomic(f, Buffer.from('x\ny\nx\n', 'utf8'));
  const out = await getTool(ctxB, 'edit').execute(
    { file_path: f, old_string: 'x', new_string: 'z', replace_all: true }, makeExec('ubuntu-live', dirU));
  assertEq(out.after, 'z\ny\nz\n', 'after replace_all');
  const text = await s.readText(f);
  assertEq(text, 'z\ny\nz\n', 'read-back');
  return { data: 'replace_all=2 处, read-back ok' };
});

await test('B8-3 edit 未找到 → FS_EDIT_NOT_FOUND', async () => {
  const f = dirU + '/edit-3.txt';
  const s = await connU.sftp();
  await s.writeFileAtomic(f, Buffer.from('abc\n', 'utf8'));
  let err = null;
  try {
    await getTool(ctxB, 'edit').execute(
      { file_path: f, old_string: 'zzz-not-here', new_string: 'x' }, makeExec('ubuntu-live', dirU));
  } catch (e) { err = e; }
  assert(err !== null, 'expected FS_EDIT_NOT_FOUND');
  assertEq(err.code, 'FS_EDIT_NOT_FOUND', 'code');
  return { data: 'code=' + err.code };
});

console.log('\n── B9 read_image 工具 ────────────────────────────────────');

await test('B9-1 read_image 真实 PNG → 字节/magic/尺寸一致', async () => {
  const f = dirU + '/img.png';
  const s = await connU.sftp();
  await s.writeFileAtomic(f, Buffer.from(PNG_1X1_B64, 'base64'));
  const out = await getTool(ctxB, 'read_image').execute({ file_path: f }, makeExec('ubuntu-live', dirU));
  assertEq(out.path, f, 'path');
  assertEq(out.image.mediaType, 'image/png', 'mediaType');
  const saved = attachmentsB.saved.get(out.image.attachmentId);
  assert(saved !== undefined, 'attachment saved');
  assertEq(saved.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG magic');
  const expectBytes = Buffer.from(PNG_1X1_B64, 'base64').length;
  if (saved.data.length !== expectBytes) {
    throw new Error(KNOWN_BUG_TAG + ' B9-1: read_image 经 readBytes 拉取, 字节数 ' + saved.data.length + ' ≠ ' + expectBytes + '(×' + (saved.data.length / expectBytes) + ')');
  }
  assertEq(out.image.bytes, expectBytes, 'bytes');
  assertEq(out.image.width, 1, 'width');
  assertEq(out.image.height, 1, 'height');
  return { data: 'bytes=' + out.image.bytes + ' ' + out.image.width + 'x' + out.image.height + ' magic=ok' };
});

await test('B9-2 read_image 非图片扩展名 → 明确错误', async () => {
  const f = dirU + '/notes.txt';
  let err = null;
  try {
    await getTool(ctxB, 'read_image').execute({ file_path: f }, makeExec('ubuntu-live', dirU));
  } catch (e) { err = e; }
  assert(err !== null, 'expected error');
  assert(err.message.includes('only accepts PNG/JPEG/WebP/GIF'), 'message: ' + err.message);
  return { data: err.message };
});

await test('B9-3 read_image 不存在 .png → FS_NOT_FOUND', async () => {
  let err = null;
  try {
    await getTool(ctxB, 'read_image').execute({ file_path: dirU + '/missing.png' }, makeExec('ubuntu-live', dirU));
  } catch (e) { err = e; }
  assert(err !== null, 'expected FS_NOT_FOUND');
  assertEq(err.code, 'FS_NOT_FOUND', 'code');
  return { data: 'code=' + err.code };
});

console.log('\n── B10 错误文案 ──────────────────────────────────────────');

await test('B10-1 未配置 hostId → "not configured" 明确报错', async () => {
  let err = null;
  try {
    await getTool(ctxB, 'bash').execute({ command: 'echo hi', description: 'x' }, makeExec('ghost', '/tmp'));
  } catch (e) { err = e; }
  assert(err !== null, 'expected error');
  assert(err.message.includes('ghost') && err.message.includes('not configured'), 'message: ' + err.message);
  return { data: err.message.slice(0, 90) };
});

await test('B10-2 主机不可达(127.0.0.1:1) → 连接错误(实测: acquire 阶段裸 SshError, 未经工具文案包装)', async () => {
  let err = null;
  try {
    await getTool(ctxB, 'bash').execute({ command: 'echo hi', description: 'x' }, makeExec('unreach', '/tmp'));
  } catch (e) { err = e; }
  assert(err !== null, 'expected error');
  assert(err instanceof SshError, 'SshError expected, got ' + (err && err.constructor && err.constructor.name));
  assertEq(err.stage, 'connect', 'stage');
  assert(err.message.includes('ECONNREFUSED'), 'message: ' + err.message);
  return { data: 'stage=' + err.stage + ' msg=' + err.message + ' (发现: acquire 错误未归一化为工具文案)' };
});

await test('B10-3 SFTP unavailable fallback -> read via exec fallback (no longer throws sftp-open)', async () => {
  // Inject in-memory exec fallback layer: conn.fs() directly returns ExecFs (mock represents "SFTP disabled -> already degraded" entry point).
  const memFiles = { '/tmp/x.txt': 'hello\nworld\n' };
  const fsConn = {
    hostId: 'macos-live',
    async exec(cmd) {
      let m = /^\( test -e ('[^']*') /.exec(cmd);
      if (m) {
        const p = m[1].slice(1, -1);
        if (!(p in memFiles)) return { code: 0, stdout: 'MISSING\n' };
        return { code: 0, stdout: 'FILE\n' + memFiles[p].length + '\n1700000000\n' };
      }
      m = /^dd if=('[^']*') /.exec(cmd);
      if (m) { const p = m[1].slice(1, -1); return { code: 0, stdout: Buffer.from(memFiles[p], 'utf8').toString('base64') }; }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const sftpFailPool = {
    acquire: async () => ({
      exec: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }),
      sftp: async () => { throw new SshError({ hostId: 'macos-live', stage: 'sftp-open', message: 'SFTP subsystem request failed (simulated)' }); },
      fs: async () => new ExecFs(fsConn),
    }),
    release: () => {},
  };
  const ctxSim = makeCtx({ hosts: hostsB, sshPool: sftpFailPool });
  apply(ctxSim);
  const out = await getTool(ctxSim, 'read').execute({ file_path: '/tmp/x.txt' }, makeExec('macos-live', '/tmp'));
  assert(out && Array.isArray(out.lines) && out.lines.length >= 2, 'degraded read returned a window: ' + JSON.stringify(out));
  const text = out.lines.map((l) => l.text).join('\n');
  assert(/hello/.test(text) && /world/.test(text), 'degraded content: ' + text);
  return { data: 'degraded; read via exec returned ' + out.lines.length + ' lines' };
});

await testMac('B10-4 真实 macOS 文件工具: 写+读(实测 SFTP 可用, 与"SFTP 被禁"前提相反)', async () => {
  const f = dirM + '/mac-write.txt';
  const w = await getTool(ctxB, 'write').execute(
    { file_path: f, content: 'mac line1\nmac line2\n' }, makeExec('macos-live', dirM));
  assertEq(w.operation, 'create', 'operation');
  const r = await getTool(ctxB, 'read').execute({ file_path: f }, makeExec('macos-live', dirM));
  if (r.totalLines !== 2) {
    throw new Error(KNOWN_BUG_TAG + ' B10-4: macOS read 工具 totalLines=' + r.totalLines + ' ≠ 2');
  }
  assertEq(r.lines[0].text, 'mac line1', 'line1');
  return { data: 'macOS SFTP 实测可用; write op=' + w.operation + ', read totalLines=' + r.totalLines };
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Environment collection (compatibility matrix data source)
// ═══════════════════════════════════════════════════════════════════════════
const envData = {};
try {
  console.log('\n── C 环境信息 ────────────────────────────────────────────');
  const envTargets = [['ubuntu', UBUNTU, connU]];
  if (HAS_MACOS) envTargets.push(['macos', MACOS, connM]);
  for (const [label, cfg, c] of envTargets) {
    const r = await c.exec('ssh -V 2>&1; echo SHELL=$SHELL; uname -srm');
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    envData[label] = {
      sshVersion: lines.find((l) => l.startsWith('OpenSSH')) || '(unknown)',
      shell: lines.find((l) => l.startsWith('SHELL=')) || '(unknown)',
      uname: lines.find((l) => !l.startsWith('SHELL=') && !l.startsWith('OpenSSH')) || '(unknown)',
    };
    const sftpLine = await c.exec('grep -in sftp /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* 2>/dev/null | head -3');
    envData[label].sftpSubsystem = sftpLine.stdout.trim() || '(未找到显式 Subsystem sftp 行)';
    console.log('DATA ' + label + ': sshVersion=' + envData[label].sshVersion + ' shell=' + envData[label].shell + ' uname=' + envData[label].uname);
    console.log('DATA ' + label + ': sftpSubsystem=' + envData[label].sftpSubsystem.split('\n').join(' / '));
  }
  const ssh2pkg = JSON.parse(await readFile(new URL('../node_modules/ssh2/package.json', import.meta.url), 'utf8'));
  envData.ssh2Version = ssh2pkg.version;
  envData.local = {
    keyPath: KEY_PATH,
    sshAgentSocket: process.env.SSH_AUTH_SOCK ? 'set(ssh-agent 运行中)' : 'unset(本机 agent 无身份 → agent 认证未测)',
    passwordAuth: '未测',
  };
  console.log('DATA ssh2Version=' + envData.ssh2Version);
  console.log('DATA local: keyPath=' + envData.local.keyPath + ' agent=' + envData.local.sshAgentSocket + ' password=未测');

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n── 汇总 ─────────────────────────────────────────────────');
  const rows = new Map();
  for (const r of results) {
    const section = r.name.split('-')[0];
    if (!rows.has(section)) rows.set(section, { pass: 0, fail: 0 });
    rows.get(section)[r.pass ? 'pass' : 'fail']++;
  }
  console.log('section | pass | fail');
  for (const [s, v] of rows) console.log('  ' + s.padEnd(6) + ' | ' + String(v.pass).padEnd(4) + ' | ' + v.fail);
  console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed, ' + results.length + ' cases');
} finally {
  // Clean up remotely created directories
  for (const { conn, dir } of cleanup) {
    try { await conn.exec('rm -rf ' + shellQuoteSingle(dir)); } catch { /* best effort */ }
  }
  await poolA.dispose().catch(() => {});
  await poolB.dispose().catch(() => {});
}
console.log('RESULT-JSON ' + JSON.stringify({ env: envData, results }));

if (failed > 0) {
  console.error('FUNCTIONAL-LIVE-TEST-FAILED: ' + failed + ' case(s) failed (see FAIL lines above; known-bug cases tagged ' + KNOWN_BUG_TAG + ')');
  process.exit(1);
}
console.log('FUNCTIONAL-LIVE-TEST-OK');
process.exit(0);

// ── Utility functions ──────────────────────────────────────────────────────────
function cryptoRandom(n) {
  const buf = Buffer.allocUnsafe(n);
  let x = 0x12345678;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    buf[i] = x & 0xff;
  }
  return buf;
}
