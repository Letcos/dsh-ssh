#!/usr/bin/env node
// @dsh-ssh/dsh-ssh M3b+M3c live smoke: real SSH against the test remote, exercising the
// exact SSH primitives the remote tools use — exec (bash), SFTP writeFileAtomic
// (atomic temp+rename), stat/readText (read), a read→replace→write round-trip
// (edit), and the M3c search commands (remote find / grep -rn via
// buildRemoteGlobCommand/buildRemoteGrepCommand, parsed exactly like the tools).
// In-memory config ONLY — never writes ~/.dsh/settings.yaml and never
// touches the user's ~/.ssh/known_hosts (verification file is
// /tmp/dsh-ssh-test-known_hosts; acceptNew is a script-only fallback).
// PREREQ: reachable test remote (defaults + DSH_SSH_TEST_* overrides in test/live-config.mjs).
// Switch machines by exporting the DSH_SSH_TEST_* vars; touches only /tmp/dsh-ssh-* on the remote.
import os from 'node:os';
import path from 'node:path';
import { SshPool, shellQuoteSingle } from '../src/ssh-core.js';
import { buildRemoteGlobCommand, buildRemoteGrepCommand, parseGlobOutput, parseGrepOutput, rgGlobToRegExp, toWorkdirRelative } from '../src/search.js';
import { liveConfig, liveHostConfig, requireRealHost } from '../test/live-config.mjs';
requireRealHost('scripts/tools-live-smoke');

// 主机/私钥统一来自 live-config(A.38); 私钥默认 id_ed25519, DSH_SSH_TEST_KEY_PATH 可覆盖。
const cfg = {
  ...liveHostConfig({ id: 'tools-live-smoke' }),
  name: 'tools live smoke',
  knownHostsPath: '/tmp/dsh-ssh-test-known_hosts',
  acceptNew: true, // 仅本脚本兜底
  connectTimeoutMs: 10_000,
};

const remoteDir = liveConfig.remoteRoot + '-m3b-' + process.pid;
const remoteFile = remoteDir + '/hello.txt';

function fail(msg) { console.error('TOOLS-LIVE-SMOKE-FAILED:', msg); process.exit(1); }

const pool = new SshPool({ maxConnections: 1 });
try {
  const conn = await pool.acquire(cfg);

  // 1. bash: exec 'echo hi'
  const r = await conn.exec('echo hi; hostname');
  console.log('exec exit code:', r.code, 'stdout:', r.stdout.trim());
  if (r.code !== 0 || !/hi/.test(r.stdout)) fail('exec echo hi');

  const sftp = await conn.sftp();

  // 1.5 mkdir: 远端父目录必须先存在(与真实文件写入语义一致)
  const mk = await conn.exec('mkdir -p ' + shellQuoteSingle(remoteDir));
  if (mk.code !== 0) fail('mkdir remote dir: ' + mk.stderr.trim());

  // 2. write → 原子写(临时文件 + rename)
  await sftp.writeFileAtomic(remoteFile, Buffer.from('hello\nworld\n', 'utf8'));
  console.log('writeFileAtomic ->', remoteFile);

  // 3. read → stat + readBytes
  const st = await sftp.stat(remoteFile);
  if (!st || st.type !== 'file') fail('stat after write');
  const bytes = await sftp.readBytes(remoteFile);
  const text1 = bytes.toString('utf8');
  console.log('read:', JSON.stringify(text1));
  if (text1 !== 'hello\nworld\n') fail('read back mismatch: ' + JSON.stringify(text1));

  // 4. edit → 读→改→写回→再读(与 tools.js 的 read-modify-write 往返一致)
  const edited = text1.replace('hello', 'goodbye');
  await sftp.writeFileAtomic(remoteFile, Buffer.from(edited, 'utf8'));
  const text2 = (await sftp.readBytes(remoteFile)).toString('utf8');
  console.log('edit round-trip:', JSON.stringify(text2));
  if (text2 !== 'goodbye\nworld\n') fail('edit round-trip mismatch: ' + JSON.stringify(text2));

  // ── M3c: glob / grep 远端搜索(live smoke; 命令与工具远端分支同款)──
  // 测试树: a.txt(hello world) / b.log(hello log) / src/c.txt(hello again)
  //         / src/sub/d.txt(hello deep) / .hidden/h.txt(hello hidden) / .git/config(hello git)
  // 预期: glob 含隐藏不含 .git; grep 默认跳过隐藏与 .git, include 只搜 basename 匹配。
  const mkSearch = await conn.exec(
    'mkdir -p ' + shellQuoteSingle(remoteDir + '/src/sub') + ' ' + shellQuoteSingle(remoteDir + '/.hidden') + ' ' + shellQuoteSingle(remoteDir + '/.git'),
  );
  if (mkSearch.code !== 0) fail('mkdir search tree: ' + mkSearch.stderr.trim());
  const writeText = async (rel, content) => {
    await sftp.writeFileAtomic(remoteDir + '/' + rel, Buffer.from(content, 'utf8'));
  };
  await writeText('a.txt', 'hello world\n');
  await writeText('b.log', 'hello log\n');
  await writeText('src/c.txt', 'hello again\n');
  await writeText('src/sub/d.txt', 'hello deep\n');
  await writeText('.hidden/h.txt', 'hello hidden\n');
  await writeText('.git/config', 'hello git\n');

  // 6. glob '*.txt': find 枚举 + 本地 rg 语义过滤; 应命中 4 个(a.txt 最先创建 → mtime 序首条)
  const globCmd = buildRemoteGlobCommand(remoteDir, '*.txt');
  const g = await conn.exec(globCmd, { cwd: remoteDir, timeoutMs: 30000 });
  if (g.code !== 0) fail('glob exec: ' + g.stderr.trim());
  const globPaths = [];
  for (const entry of parseGlobOutput(g.stdout)) {
    const display = toWorkdirRelative(entry.path, remoteDir);
    if (rgGlobToRegExp('*.txt').test(display)) globPaths.push(display);
  }
  console.log('glob *.txt ->', globPaths.join(', '));
  const expectGlob = ['hello.txt', 'a.txt', '.hidden/h.txt', 'src/c.txt', 'src/sub/d.txt']; // hello.txt 是 M3b 阶段写下的文件, 同样应命中
  for (const p of expectGlob) if (!globPaths.includes(p)) fail('glob missing ' + p);
  if (globPaths.some((p) => p.includes('.git'))) fail('glob must exclude .git');
  if (globPaths.length !== expectGlob.length) fail('glob extra paths: ' + globPaths.join(','));
  if (globPaths[0] !== 'hello.txt') fail('glob mtime head should be hello.txt (created first), got ' + globPaths[0]);

  // 7. glob 'src/**/*.txt': 相对 cwd 语义 + 零段 **; 只命中 src 下两个
  const g2 = await conn.exec(buildRemoteGlobCommand(remoteDir, 'src/**/*.txt'), { cwd: remoteDir, timeoutMs: 30000 });
  if (g2.code !== 0) fail('glob src exec: ' + g2.stderr.trim());
  const globPaths2 = [];
  for (const entry of parseGlobOutput(g2.stdout)) {
    const display = toWorkdirRelative(entry.path, remoteDir);
    if (rgGlobToRegExp('src/**/*.txt').test(display)) globPaths2.push(display);
  }
  console.log('glob src/**/*.txt ->', globPaths2.join(', '));
  if (globPaths2.length !== 2 || !globPaths2.includes('src/sub/d.txt')) fail('glob src/**/*.txt wrong: ' + globPaths2.join(','));

  // 8. grep 'hello': 命中 4 个(b.log 含 hello; .hidden/.git 被排除), 路径为 cwd 相对
  const grepCmd = buildRemoteGrepCommand(remoteDir, 'hello', undefined);
  const gr = await conn.exec(grepCmd, { cwd: remoteDir, timeoutMs: 30000 });
  if (gr.code !== 0 && gr.code !== 1) fail('grep exec: ' + gr.stderr.trim());
  const matches = parseGrepOutput(gr.stdout).map((m) => ({
    path: toWorkdirRelative(m.path, remoteDir), lineNumber: m.lineNumber, line: m.line,
  }));
  console.log('grep hello ->', JSON.stringify(matches));
  const matchPaths = matches.map((m) => m.path).sort();
  // hello.txt 在 M3b edit 往返中已改为 'goodbye\nworld\n', 不再含 hello —— grep 正确排除
  if (matchPaths.join('|') !== 'a.txt|b.log|src/c.txt|src/sub/d.txt') fail('grep paths wrong: ' + matchPaths.join('|'));
  if (matches.some((m) => m.path.includes('.hidden') || m.path.includes('.git'))) fail('grep must skip hidden/VCS');
  if (matches.some((m) => m.lineNumber !== 1)) fail('grep line numbers wrong');

  // 9. grep include 过滤: 只搜 *.txt → b.log 被排除
  const gri = await conn.exec(buildRemoteGrepCommand(remoteDir, 'hello', '*.txt'), { cwd: remoteDir, timeoutMs: 30000 });
  if (gri.code !== 0 && gri.code !== 1) fail('grep include exec: ' + gri.stderr.trim());
  const mi = parseGrepOutput(gri.stdout).map((m) => toWorkdirRelative(m.path, remoteDir)).sort();
  console.log('grep hello --include=*.txt ->', mi.join(', '));
  if (mi.join('|') !== 'a.txt|src/c.txt|src/sub/d.txt') fail('grep include wrong: ' + mi.join('|'));

  // 10. grep 无命中 → exit 1(工具映射为空 matches, 非错误)
  const grz = await conn.exec(buildRemoteGrepCommand(remoteDir, 'zzzz-not-found', undefined), { cwd: remoteDir, timeoutMs: 30000 });
  if (grz.code !== 1) fail('grep no-match expected exit 1, got ' + grz.code);

  // cleanup: 整树删除(含 hello.txt 与搜索树)
  const rm = await conn.exec('rm -rf ' + shellQuoteSingle(remoteDir));
  if (rm.code !== 0) fail('rm -rf cleanup: ' + rm.stderr.trim());
  console.log('cleaned up', remoteDir);

  console.log('TOOLS-LIVE-SMOKE-OK');
  process.exit(0);
} catch (err) {
  console.error('TOOLS-LIVE-SMOKE-FAILED:', err?.message ?? err);
  if (err?.stage) console.error('stage:', err.stage, 'hostId:', err.hostId);
  process.exit(1);
} finally {
  await pool.dispose();
}
