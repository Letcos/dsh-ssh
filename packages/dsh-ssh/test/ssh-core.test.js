// @dsh-ssh/dsh-ssh — M2a unit tests (node --test, no network).
// Covers: command assembly/escaping, known_hosts parsing+verification, SshError
// fields, and the connect failure path against 127.0.0.1:1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHmac, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  SshError,
  HOST_KEY_UNKNOWN_STAGE,
  sshKeyFingerprint,
  sshKeyTypeFromBlob,
  shellQuoteSingle,
  buildRemoteCommand,
  parseKnownHosts,
  knownHostsPatterns,
  knownHostsLine,
  checkHostKey,
  verifyHostKey,
  appendKnownHost,
  makeHostVerifier,
  defaultKnownHostsPath,
  SshConn,
  SshPool,
  SftpWrapper,
} from '../src/ssh-core.js';

// Deterministic keys: entry text is base64 of a known byte string, so
// Buffer.from(str,'base64') re-encodes to exactly the same text.
const KEY_A = Buffer.from('host-key-alpha-123').toString('base64');
const KEY_B = Buffer.from('host-key-beta-456').toString('base64');
const BYTES_A = Buffer.from('host-key-alpha-123');
const BYTES_B = Buffer.from('host-key-beta-456');
const BYTES_X = Buffer.from('host-key-gamma-789');

const KH_SAMPLE = [
  '203.0.113.10 ssh-ed25519 ' + KEY_A,
  '[203.0.113.10]:16611 ssh-ed25519 ' + KEY_B,
  '# comment line',
  '',
  '@cert-authority *.example.com ssh-ed25519 ' + KEY_A,
].join('\n');

test('shellQuoteSingle escapes single quotes and leaves plain text', () => {
  assert.equal(shellQuoteSingle("it's dir"), "'it'\\''s dir'");
  assert.equal(shellQuoteSingle('plain'), "'plain'");
  assert.equal(shellQuoteSingle(''), "''");
});

test('buildRemoteCommand prefixes cd for cwd and passes through otherwise', () => {
  assert.equal(buildRemoteCommand('echo hi', '/data/my dir'), "cd '/data/my dir' && echo hi");
  assert.equal(buildRemoteCommand('echo hi'), 'echo hi');
  assert.equal(buildRemoteCommand('ls -la', "/x/'y'"), "cd '/x/'\\''y'\\''' && ls -la");
});

test('parseKnownHosts parses hosts, ports, markers; skips comments/blank', () => {
  const entries = parseKnownHosts(KH_SAMPLE);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { marker: undefined, hostPat: '203.0.113.10', keyType: 'ssh-ed25519', key: KEY_A });
  assert.equal(entries[1].hostPat, '[203.0.113.10]:16611');
  assert.equal(entries[2].marker, '@cert-authority');
});

test('knownHostsPatterns covers default and non-default ports', () => {
  assert.deepEqual(knownHostsPatterns('h', 22), ['h']);
  assert.deepEqual(knownHostsPatterns('h', 16611), ['h', '[h]:16611']);
});

test('checkHostKey match/mismatch/unknown', () => {
  const entries = parseKnownHosts(KH_SAMPLE);
  assert.equal(checkHostKey('203.0.113.10', 22, BYTES_A, entries), 'match');
  assert.equal(checkHostKey('203.0.113.10', 16611, BYTES_B, entries), 'match');
  assert.equal(checkHostKey('203.0.113.10', 22, BYTES_X, entries), 'mismatch');
  assert.equal(checkHostKey('other.host', 22, BYTES_A, entries), 'unknown');
});

test('verifyHostKey throws SshError(verify-host-key) on mismatch, accepts acceptNew', () => {
  const entries = parseKnownHosts(KH_SAMPLE);
  assert.doesNotThrow(() => verifyHostKey('203.0.113.10', 22, BYTES_A, entries));
  assert.throws(
    () => verifyHostKey('203.0.113.10', 22, BYTES_X, entries),
    (e) => e instanceof SshError && e.stage === 'verify-host-key' && /mismatch/.test(e.message),
  );
  assert.throws(
    () => verifyHostKey('nope', 22, BYTES_A, entries),
    (e) => e instanceof SshError && /unknown host key/.test(e.message),
  );
  assert.doesNotThrow(() => verifyHostKey('nope', 22, BYTES_A, entries, { acceptNew: true }));
});

// --- M2a known_hosts 修复回归: hashed 条目 + 缺省路径 + 文件缺失语义 ---
const HASH_SALT = Buffer.from('0123456789abcdef0123'); // 20 bytes, OpenSSH 随机 salt 长度
const HASH_SALT_B64 = HASH_SALT.toString('base64');
const HASH_HOST = 'hash-me.example';
const HASH_DIGEST_B64 = createHmac('sha1', HASH_SALT).update(HASH_HOST).digest('base64');
const KH_HASHED_LINE = '|1|' + HASH_SALT_B64 + '|' + HASH_DIGEST_B64 + ' ssh-ed25519 ' + KEY_A;

test('parseKnownHosts marks OpenSSH hashed entries with salt/hash', () => {
  const entries = parseKnownHosts('# comment\n' + KH_HASHED_LINE + '\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hashed, true);
  assert.equal(entries[0].hashedSalt, HASH_SALT_B64);
  assert.equal(entries[0].hashedHash, HASH_DIGEST_B64);
  assert.equal(entries[0].keyType, 'ssh-ed25519');
});

test('checkHostKey matches OpenSSH hashed entries (HMAC-SHA1 host hash)', () => {
  const entries = parseKnownHosts(KH_HASHED_LINE);
  assert.equal(checkHostKey(HASH_HOST, 22, BYTES_A, entries), 'match');
  assert.equal(checkHostKey(HASH_HOST, 22, BYTES_X, entries), 'mismatch'); // host 命中, key 不符
  assert.equal(checkHostKey('other.example', 22, BYTES_A, entries), 'unknown'); // host 未命中
});

test('defaultKnownHostsPath resolves to ~/.ssh/known_hosts', () => {
  assert.equal(defaultKnownHostsPath(), path.join(os.homedir(), '.ssh', 'known_hosts'));
});

test('_readKnownHosts treats a missing file as empty (ENOENT), not a config error', async () => {
  const conn = new SshConn({ id: 'h', knownHostsPath: 'C:\\__no_such_known_hosts_dir__\\known_hosts' });
  const entries = await conn._readKnownHosts();
  assert.deepEqual(entries, []);
});

test('_readKnownHosts falls back to the default path when knownHostsPath is unset', async () => {
  const conn = new SshConn({ id: 'h' });
  const entries = await conn._readKnownHosts(); // 应读取 ~/.ssh/known_hosts（本机存在）或 ENOENT→[]
  assert.ok(Array.isArray(entries));
});

test('makeHostVerifier records SshError host-key-unknown when host unknown (A.34)', () => {
  const entries = parseKnownHosts(KH_SAMPLE);
  const conn = new SshConn({ id: 'h' });
  const vf = makeHostVerifier(conn, { host: 'nope.example', port: 22, entries, hostId: 'h' });
  let verdict = null;
  vf(BYTES_A, (ok) => { verdict = ok; });
  assert.equal(verdict, false);
  assert.ok(conn.verifyError instanceof SshError);
  assert.equal(conn.verifyError.stage, HOST_KEY_UNKNOWN_STAGE);
  assert.equal(conn.verifyError.isHostKeyUnknown, true);
  assert.equal(conn.verifyError.host, 'nope.example');
  assert.equal(conn.verifyError.rawKeyBase64, BYTES_A.toString('base64'));
  assert.equal(conn.verifyError.fingerprint, sshKeyFingerprint(BYTES_A));
  assert.match(conn.verifyError.message, /unknown host key/);
});

// ── A.34(TOFU): host-key-unknown 结构化错误面 + 幂等追加 known_hosts ──
test('verifyHostKey unknown → SshError(stage host-key-unknown) carries fingerprint/rawKey/keyType/host/port', () => {
  const key = Buffer.from('ssh-ed25519\u0000host-key-material-123');
  let caught = null;
  try { verifyHostKey('new.example', 2222, key, []); } catch (e) { caught = e; }
  assert.ok(caught instanceof SshError);
  assert.equal(caught.stage, HOST_KEY_UNKNOWN_STAGE);
  assert.equal(caught.isHostKeyUnknown, true);
  assert.equal(caught.hostId, '');
  assert.equal(caught.host, 'new.example');
  assert.equal(caught.port, 2222);
  assert.equal(caught.rawKeyBase64, key.toString('base64'));
  assert.equal(caught.fingerprint, sshKeyFingerprint(key));
  assert.equal(caught.keyType, sshKeyTypeFromBlob(key));
  assert.ok(/unknown host key/.test(caught.message));
});

test('verifyHostKey mismatch remains a hard reject WITHOUT trust/rawKey/fingerprint fields', () => {
  const entries = parseKnownHosts(KH_SAMPLE);
  let caught = null;
  try { verifyHostKey('203.0.113.10', 22, BYTES_X, entries); } catch (e) { caught = e; }
  assert.ok(caught instanceof SshError);
  assert.equal(caught.stage, 'verify-host-key');
  assert.equal(caught.isHostKeyUnknown, false);
  assert.ok(!('host' in caught));
  assert.ok(!('port' in caught));
  assert.ok(!('fingerprint' in caught));
  assert.ok(!('rawKeyBase64' in caught));
  assert.ok(!('keyType' in caught));
  assert.ok(/mismatch/.test(caught.message));
});

test('sshKeyFingerprint matches OpenSSH SHA256 (no padding, SHA256: prefix)', () => {
  assert.equal(sshKeyFingerprint(Buffer.alloc(0)), 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU'); // sha256('') 已知值(SHA256 指纹是标准 base64, 含 + /)
  assert.ok(/^SHA256:[A-Za-z0-9+/]+$/.test(sshKeyFingerprint(BYTES_A)));
  assert.equal(sshKeyFingerprint(BYTES_A), 'SHA256:' + createHash('sha256').update(BYTES_A).digest('base64').replace(/=+$/, ''));
});

test('sshKeyTypeFromBlob parses the leading algorithm string of an SSH pubkey blob', () => {
  const ed = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 0])]);
  assert.equal(sshKeyTypeFromBlob(ed), 'ssh-ed25519');
  assert.equal(sshKeyTypeFromBlob(BYTES_A), ''); // 无长度前缀 → 解析失败返回 ''
  assert.equal(sshKeyTypeFromBlob(Buffer.alloc(0)), '');
});

test('knownHostsLine picks the non-default-port hostpat ([host]:port) and plain host otherwise', () => {
  assert.equal(knownHostsLine('h', 22, 'ssh-ed25519', 'KEY'), 'h ssh-ed25519 KEY');
  assert.equal(knownHostsLine('h', 16611, 'ssh-ed25519', 'KEY'), '[h]:16611 ssh-ed25519 KEY');
});

test('appendKnownHost writes <host> <keytype> <base64>, is idempotent, and newline-safe (temp file)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-kh-'));
  const fp = path.join(dir, 'known_hosts');
  try {
    const host = 'kh.example'; const port = 2222;
    const keyType = 'ssh-ed25519';
    const keyB64 = Buffer.from('temp-host-key-material').toString('base64');
    const line = knownHostsLine(host, port, keyType, keyB64);
    // 1) 首次追加写盘
    const first = await appendKnownHost(fp, host, port, keyType, keyB64);
    assert.equal(first.appended, true);
    assert.equal(first.path, fp);
    assert.ok(readFileSync(fp, 'utf8').includes(line));
    // 2) 幂等: 同 host+keytype+key 不重复追加
    const second = await appendKnownHost(fp, host, port, keyType, keyB64);
    assert.equal(second.appended, false);
    const text2 = readFileSync(fp, 'utf8');
    assert.equal(text2.split(line).length - 1, 1);
    // 3) 换行幂等: 追加第二把 key 时文件已以 \n 结尾, 不产生空行
    const keyB64b = Buffer.from('another-host-key-material').toString('base64');
    const third = await appendKnownHost(fp, host, port, keyType, keyB64b);
    assert.equal(third.appended, true);
    const text3 = readFileSync(fp, 'utf8').replace(/\s+$/, '');
    const lines = text3.split(/\r?\n/);
    assert.equal(lines.length, 2);
    // 4) 不同 host 追加互不影响
    const fourth = await appendKnownHost(fp, 'other.example', 22, keyType, keyB64);
    assert.equal(fourth.appended, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SshError carries hostId/stage/message', () => {
  const e = new SshError({ hostId: 'h1', stage: 'connect', message: 'boom' });
  assert.equal(e.name, 'SshError');
  assert.equal(e.hostId, 'h1');
  assert.equal(e.stage, 'connect');
  assert.equal(e.message, 'boom');
  const e2 = new SshError({ stage: 'x', message: 'm' });
  assert.equal(e2.hostId, '');
});

test('connect to 127.0.0.1:1 fails with SshError stage connect (short timeout)', async () => {
  const cfg = {
    id: 'refused',
    host: '127.0.0.1',
    port: 1,
    user: 'nobody',
    auth: { type: 'password', password: 'x' },
    acceptNew: true,
    connectTimeoutMs: 1_500,
  };
  await assert.rejects(new SshConn(cfg).connect(), (e) => e instanceof SshError && e.stage === 'connect');
  const pool = new SshPool({ maxConnections: 2 });
  await assert.rejects(pool.acquire(cfg), (e) => e instanceof SshError && e.stage === 'connect');
  assert.equal(pool.conns.size, 0, 'failed conn must be evicted from pool');
  await pool.dispose();
});

// SshConn.exec with a fake channel stream: verifies the maxStdoutBytes guard (M3c 大目录保护).
function makeFakeExecStream(chunks) {
  const handlers = {};
  const stream = {
    stderr: { on: () => {} },
    on(ev, cb) {
      handlers[ev] = cb;
      if (ev === 'data') setImmediate(() => {
        for (const c of chunks) if (handlers.data) handlers.data(c);
        if (handlers.close) handlers.close(0, null); // 数据发完即 close, 否则事件循环空转 → 测试被 cancelled
      });
      return stream;
    },
    close() { setImmediate(() => { if (handlers.close) handlers.close(0, null); }); },
  };
  return stream;
}

test('SshConn.exec enforces maxStdoutBytes → SshError stage exec-output-overflow', async () => {
  const conn = new SshConn({ id: 'h' });
  conn._execChannel = async () => makeFakeExecStream([Buffer.from('abcdefghij')]);
  await assert.rejects(
    conn.exec('cat', { maxStdoutBytes: 8 }),
    (e) => e instanceof SshError && e.stage === 'exec-output-overflow' && /8 bytes/.test(e.message),
  );
});

test('SshConn.exec passes through when stdout is under cap', async () => {
  const conn = new SshConn({ id: 'h' });
  conn._execChannel = async () => makeFakeExecStream([Buffer.from('abc')]);
  const r = await conn.exec('cat', { maxStdoutBytes: 8 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'abc');
  assert.equal(r.signal, null);
});

// SftpWrapper.readBytes 流水线: 模拟 OpenSSH 乱序响应(位置超尾的 EOF 先回, 数据后回)——
// M3c 实测坑: 旧实现按"收到 EOF 即结束"会丢数据; 现按 stat size 判定完成。
test('SftpWrapper.readBytes handles out-of-order EOF responses (M3c regression)', async () => {
  const data = Buffer.from('0123456789abcdef'); // 16 bytes
  const fakeRaw = {
    stat: (p, cb) => cb(null, { size: data.length }),
    open: (p, f, a, cb) => { if (typeof a === 'function') cb = a; cb(null, Buffer.from('h')); },
    read: (handle, buf, off, len, position, cb) => {
      if (position >= data.length) {
        setImmediate(() => cb(null, 0)); // EOF 响应立即回
      } else {
        setTimeout(() => { // 数据响应延迟 → 模拟 EOF 先于数据到达
          const n = Math.min(len, data.length - position);
          data.copy(buf, off, position, position + n);
          cb(null, n);
        }, 5);
      }
    },
    close: (h, cb) => cb(null),
  };
  const wrapper = new SftpWrapper({ hostId: 'h' }, fakeRaw);
  const out = await wrapper.readBytes('/x', { pipeline: 4, chunk: 8 });
  assert.equal(out.toString('utf8'), '0123456789abcdef');
});

test('SftpWrapper.readBytes returns empty buffer for empty file', async () => {
  const fakeRaw = {
    stat: (p, cb) => cb(null, { size: 0 }),
    open: (p, f, a, cb) => { if (typeof a === 'function') cb = a; cb(null, Buffer.from('h')); },
    read: (h, b, o, l, pos, cb) => cb(null, 0),
    close: (h, cb) => cb(null),
  };
  const wrapper = new SftpWrapper({ hostId: 'h' }, fakeRaw);
  const out = await wrapper.readBytes('/x');
  assert.equal(out.length, 0);
});

test('pool evicts on failed acquire and refuses after dispose', async () => {
  const pool = new SshPool({ maxConnections: 1 });
  const bad = { id: 'a', host: '127.0.0.1', port: 1, user: 'u', auth: { type: 'password', password: 'x' }, acceptNew: true, connectTimeoutMs: 1_000 };
  await assert.rejects(pool.acquire(bad));
  // capacity freed after failure: a waiter queued under a full pool wakes on release
  const wake = new Promise((r) => pool.waiters.push(r));
  pool.release();
  await wake;
  await pool.dispose();
  await assert.rejects(pool.acquire(bad), (e) => e instanceof SshError && e.stage === 'pool-disposed');
});
