#!/usr/bin/env node
// @dsh-ssh/dsh-ssh live smoke: real SSH against the test remote, exercising the
// exact SSH primitives the remote tools use — exec (bash), SFTP writeFileAtomic
// (atomic temp+rename), stat/readText (read), a read->replace->write round-trip
// (edit), and the search commands (remote find / grep -rn via
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

// Host/private-key config comes from live-config; defaults to id_ed25519, overridable via DSH_SSH_TEST_KEY_PATH.
const cfg = {
  ...liveHostConfig({ id: 'tools-live-smoke' }),
  name: 'tools live smoke',
  knownHostsPath: '/tmp/dsh-ssh-test-known_hosts',
  acceptNew: true, // fallback for this script only
  connectTimeoutMs: 10_000,
};

const remoteDir = liveConfig.remoteRoot + '-smoke-' + process.pid;
const remoteFile = remoteDir + '/hello.txt';

function fail(msg) { throw new Error(msg); }

const pool = new SshPool({ maxConnections: 1 });
let conn = null;
let failed = false;
try {
  conn = await pool.acquire(cfg);

  // 1. bash: exec 'echo hi'
  const r = await conn.exec('echo hi; hostname');
  console.log('exec exit code:', r.code, 'stdout:', r.stdout.trim());
  if (r.code !== 0 || !/hi/.test(r.stdout)) fail('exec echo hi');

  const sftp = await conn.sftp();

  // 1.5 mkdir: remote parent dir must exist first (matches real file write semantics)
  const mk = await conn.exec('mkdir -p ' + shellQuoteSingle(remoteDir));
  if (mk.code !== 0) fail('mkdir remote dir: ' + mk.stderr.trim());

  // 2. write -> atomic write (temp file + rename)
  await sftp.writeFileAtomic(remoteFile, Buffer.from('hello\nworld\n', 'utf8'));
  console.log('writeFileAtomic ->', remoteFile);

  // 3. read → stat + readBytes
  const st = await sftp.stat(remoteFile);
  if (!st || st.type !== 'file') fail('stat after write');
  const bytes = await sftp.readBytes(remoteFile);
  const text1 = bytes.toString('utf8');
  console.log('read:', JSON.stringify(text1));
  if (text1 !== 'hello\nworld\n') fail('read back mismatch: ' + JSON.stringify(text1));

  // 4. edit -> read->modify->write->read again (matches tools.js read-modify-write round-trip)
  const edited = text1.replace('hello', 'goodbye');
  await sftp.writeFileAtomic(remoteFile, Buffer.from(edited, 'utf8'));
  const text2 = (await sftp.readBytes(remoteFile)).toString('utf8');
  console.log('edit round-trip:', JSON.stringify(text2));
  if (text2 !== 'goodbye\nworld\n') fail('edit round-trip mismatch: ' + JSON.stringify(text2));

  // ── glob / grep remote search (live smoke; same commands as tool remote branches) ──
  // Test tree: a.txt(hello world) / b.log(hello log) / src/c.txt(hello again)
  //         / src/sub/d.txt(hello deep) / .hidden/h.txt(hello hidden) / .git/config(hello git)
  // Expected: glob includes hidden but excludes .git; grep skips hidden and .git by default, include matches basename only.
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

  // 6. glob '*.txt': find enumeration + local rg semantic filtering; should match 4 (a.txt created earliest -> mtime-ordered head)
  const globCmd = buildRemoteGlobCommand(remoteDir, '*.txt');
  const g = await conn.exec(globCmd, { cwd: remoteDir, timeoutMs: 30000 });
  if (g.code !== 0) fail('glob exec: ' + g.stderr.trim());
  const globPaths = [];
  for (const entry of parseGlobOutput(g.stdout)) {
    const display = toWorkdirRelative(entry.path, remoteDir);
    if (rgGlobToRegExp('*.txt').test(display)) globPaths.push(display);
  }
  console.log('glob *.txt ->', globPaths.join(', '));
  const expectGlob = ['hello.txt', 'a.txt', '.hidden/h.txt', 'src/c.txt', 'src/sub/d.txt']; // hello.txt was created earlier, should also match
  for (const p of expectGlob) if (!globPaths.includes(p)) fail('glob missing ' + p);
  if (globPaths.some((p) => p.includes('.git'))) fail('glob must exclude .git');
  if (globPaths.length !== expectGlob.length) fail('glob extra paths: ' + globPaths.join(','));
  if (globPaths[0] !== 'hello.txt') fail('glob mtime head should be hello.txt (created first), got ' + globPaths[0]);

  // 7. glob 'src/**/*.txt': relative cwd semantics + zero-segment **; matches only two under src
  const g2 = await conn.exec(buildRemoteGlobCommand(remoteDir, 'src/**/*.txt'), { cwd: remoteDir, timeoutMs: 30000 });
  if (g2.code !== 0) fail('glob src exec: ' + g2.stderr.trim());
  const globPaths2 = [];
  for (const entry of parseGlobOutput(g2.stdout)) {
    const display = toWorkdirRelative(entry.path, remoteDir);
    if (rgGlobToRegExp('src/**/*.txt').test(display)) globPaths2.push(display);
  }
  console.log('glob src/**/*.txt ->', globPaths2.join(', '));
  if (globPaths2.length !== 2 || !globPaths2.includes('src/sub/d.txt')) fail('glob src/**/*.txt wrong: ' + globPaths2.join(','));

  // 8. grep 'hello': 4 matches (b.log contains hello; .hidden/.git excluded), paths relative to cwd
  const grepCmd = buildRemoteGrepCommand(remoteDir, 'hello', undefined);
  const gr = await conn.exec(grepCmd, { cwd: remoteDir, timeoutMs: 30000 });
  if (gr.code !== 0 && gr.code !== 1) fail('grep exec: ' + gr.stderr.trim());
  const matches = parseGrepOutput(gr.stdout).map((m) => ({
    path: toWorkdirRelative(m.path, remoteDir), lineNumber: m.lineNumber, line: m.line,
  }));
  console.log('grep hello ->', JSON.stringify(matches));
  const matchPaths = matches.map((m) => m.path).sort();
  // hello.txt was changed to 'goodbye\nworld\n' earlier, no longer contains hello — correctly excluded by grep
  if (matchPaths.join('|') !== 'a.txt|b.log|src/c.txt|src/sub/d.txt') fail('grep paths wrong: ' + matchPaths.join('|'));
  if (matches.some((m) => m.path.includes('.hidden') || m.path.includes('.git'))) fail('grep must skip hidden/VCS');
  if (matches.some((m) => m.lineNumber !== 1)) fail('grep line numbers wrong');

  // 9. grep include filter: only search *.txt -> b.log excluded
  const gri = await conn.exec(buildRemoteGrepCommand(remoteDir, 'hello', '*.txt'), { cwd: remoteDir, timeoutMs: 30000 });
  if (gri.code !== 0 && gri.code !== 1) fail('grep include exec: ' + gri.stderr.trim());
  const mi = parseGrepOutput(gri.stdout).map((m) => toWorkdirRelative(m.path, remoteDir)).sort();
  console.log('grep hello --include=*.txt ->', mi.join(', '));
  if (mi.join('|') !== 'a.txt|src/c.txt|src/sub/d.txt') fail('grep include wrong: ' + mi.join('|'));

  // 10. grep no match -> exit 1 (tool maps to empty matches, not an error)
  const grz = await conn.exec(buildRemoteGrepCommand(remoteDir, 'zzzz-not-found', undefined), { cwd: remoteDir, timeoutMs: 30000 });
  if (grz.code !== 1) fail('grep no-match expected exit 1, got ' + grz.code);

  console.log('TOOLS-LIVE-SMOKE-OK');
} catch (err) {
  failed = true;
  console.error('TOOLS-LIVE-SMOKE-FAILED:', err?.message ?? err);
  if (err?.stage) console.error('stage:', err.stage, 'hostId:', err.hostId);
} finally {
  // Remove the whole tree (including hello.txt and search tree) on both success and failure paths.
  if (conn) {
    try { await conn.exec('rm -rf ' + shellQuoteSingle(remoteDir)); } catch { /* best effort */ }
    console.log('cleaned up', remoteDir);
  }
  await pool.dispose().catch(() => {});
}
if (failed) process.exit(1);
process.exit(0);
