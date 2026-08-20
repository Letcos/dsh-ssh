// @dsh-ssh/dsh-ssh — M3b router unit tests (node --test, no network/IO).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  remoteRoot,
  isValidHostId,
  encodeRemotePath,
  decodeRemotePath,
  mapRemoteToLocal,
  mapLocalToRemote,
  routeByCwd,
  resolveRemotePath,
} from '../src/router.js';

const ENV = { DSH_SSH_REMOTE_ROOT: '/tmp/dsh-ssh-test-remote-root' };

// Windows 下 path.resolve/join 对 POSIX 形态输入(测试自造 env 值)会产出带盘符 + 反斜杠的本地路径;
// 这些用例只关心"哪级根生效 + 拼接落点", 与盘符(cwd 决定)无关, 故统一归一化到 POSIX 形态再比较。
const toPosix = (p) => String(p).replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');

test('remoteRoot: DSH_SSH_REMOTE_ROOT > DSH_HOME > ~/.dsh/remote', () => {
  assert.equal(toPosix(remoteRoot({ DSH_SSH_REMOTE_ROOT: '/x' })), '/x');
  assert.equal(toPosix(remoteRoot({ DSH_SSH_REMOTE_ROOT: '/x/y/../z' })), '/x/z');
  assert.equal(toPosix(remoteRoot({ DSH_HOME: '/tmp/h' })), '/tmp/h/remote');
  assert.equal(remoteRoot({}), path.join(os.homedir(), '.dsh', 'remote'));
});

test('encode/decode round-trip: ascii, unicode, special chars, empty', () => {
  // 注意: 空串不是合法远端路径(远端路径必为绝对路径), 单独断言其被拒绝
  assert.equal(encodeRemotePath(''), '');
  assert.equal(decodeRemotePath(''), null);
  const samples = ['/data/work', '/data/my dir/with spaces', '/中文/路径/😀', "/has/single'quote", '/a	b'];
  for (const s of samples) {
    const enc = encodeRemotePath(s);
    assert.ok(!enc.includes('/'), 'encoded must be a single segment');
    assert.ok(!enc.includes('+'), 'base64url must not contain +');
    assert.ok(!enc.includes('='), 'base64url must be unpadded');
    assert.equal(decodeRemotePath(enc), s, 'round-trip ' + JSON.stringify(s));
  }
});

test('decodeRemotePath rejects garbage and non-canonical input', () => {
  assert.equal(decodeRemotePath(null), null);
  assert.equal(decodeRemotePath(''), null);
  assert.equal(decodeRemotePath('!!!not-base64url'), null);
  assert.equal(decodeRemotePath('a/b'), null);
  assert.equal(decodeRemotePath('YWJj='), null, 'padded input rejected');
});

test('isValidHostId rejects traversal and unsafe segments', () => {
  for (const ok of ['h1', 'abc-123', 'a.b_c', 'uuid-1234']) assert.equal(isValidHostId(ok), true, ok);
  const bad = ['', '.', '..', 'a/b', 'a\\b', 'a b', '-abc', 'a' + String.fromCharCode(10), 'a' + String.fromCharCode(0)];
  for (const b of bad) assert.equal(isValidHostId(b), false, JSON.stringify(b));
});

test('mapRemoteToLocal/mapLocalToRemote round-trip', () => {
  const local = mapRemoteToLocal('h1', '/data/work', ENV);
  assert.equal(toPosix(local), '/tmp/dsh-ssh-test-remote-root/h1/' + encodeRemotePath('/data/work'));
  assert.deepEqual(mapLocalToRemote(local, ENV), { hostId: 'h1', remotePath: '/data/work' });
});

test('mapLocalToRemote rejects wrong shape / non-absolute / traversal', () => {
  assert.equal(mapLocalToRemote('/tmp/dsh-ssh-test-remote-root', ENV), null);
  assert.equal(mapLocalToRemote('/tmp/dsh-ssh-test-remote-root/h1', ENV), null);
  assert.equal(mapLocalToRemote('/tmp/dsh-ssh-test-remote-root/h1/xx/deep', ENV), null);
  assert.equal(mapLocalToRemote('/Users/elsewhere/foo', ENV), null);
  assert.equal(mapLocalToRemote('/tmp/dsh-ssh-test-remote-root/h1/!!!', ENV), null);
  assert.equal(mapLocalToRemote('/tmp/dsh-ssh-test-remote-root/../h1/' + encodeRemotePath('/x'), ENV), null);
  assert.equal(mapLocalToRemote('/tmp/dsh-ssh-test-remote-root/..%2Fh1/' + encodeRemotePath('/x'), ENV), null);
  const relEnc = encodeRemotePath('relative/path');
  assert.equal(mapLocalToRemote('/tmp/dsh-ssh-test-remote-root/h1/' + relEnc, ENV), null);
});

test('routeByCwd: remote only for exact <root>/<hostId>/<encoded>', () => {
  const local = mapRemoteToLocal('h1', '/data/work', ENV);
  assert.deepEqual(routeByCwd(local, ENV), { kind: 'remote', hostId: 'h1', remoteCwd: '/data/work' });
  assert.deepEqual(routeByCwd('/tmp/dsh-ssh-test-remote-root/h1', ENV), { kind: 'local' });
  assert.deepEqual(routeByCwd(local + '/sub/file', ENV), { kind: 'local' });
  assert.deepEqual(routeByCwd('/Users/haowu/project', ENV), { kind: 'local' });
  assert.deepEqual(routeByCwd('', ENV), { kind: 'local' });
  assert.deepEqual(routeByCwd(undefined, ENV), { kind: 'local' });
});

test('resolveRemotePath: relative → remoteCwd, placeholder-prefixed → rebase, absolute → passthrough', () => {
  const cwd = mapRemoteToLocal('h1', '/data/work', ENV);
  assert.equal(resolveRemotePath('src/foo.js', '/data/work', cwd), '/data/work/src/foo.js');
  assert.equal(resolveRemotePath('a/b.txt', '/data/work', cwd), '/data/work/a/b.txt');
  assert.equal(resolveRemotePath(cwd + '/sub/file.txt', '/data/work', cwd), '/data/work/sub/file.txt');
  assert.equal(resolveRemotePath('/etc/hostname', '/data/work', cwd), '/etc/hostname');
});
