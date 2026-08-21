// @dsh-ssh/dsh-ssh — placeholder directory creation unit tests (pure functions, no network).
// Covers: encoding reuse (reversible mapRemoteToLocal, traversal blocked), idempotency, mock fs,
// DSH_HOME handling (DSH_SSH_REMOTE_ROOT > DSH_HOME > ~/.dsh), and real directory creation (tmp isolated, no writes to ~/.dsh/remote).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createPlaceholderDir, placeholderInvalidReason, placeholderDisplayName, hostDisplayName, placeholderWorkspaceTitle } from '../src/placeholder.js';
import { mapRemoteToLocal, mapLocalToRemote, encodeRemotePath } from '../src/router.js';

const ENV = { DSH_SSH_REMOTE_ROOT: '/tmp/dsh-ssh-m4-root' };

// On Windows mapRemoteToLocal produces native paths (drive letter/backslash); these tests only care about which root is effective,
// so normalize to POSIX before checking startsWith (drive letter depends only on cwd, not semantics).
const toPosix = (p) => String(p).replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');

/** Fake fs: promises.mkdir records calls without real IO. */
function mockFs() {
  const mkdirs = [];
  return {
    promises: {
      mkdir: async (p, opts) => { mkdirs.push({ p, opts }); },
    },
    mkdirs,
  };
}

test('createPlaceholderDir: generates localPath with reversible mapRemoteToLocal encoding', async () => {
  const fsImpl = mockFs();
  const result = await createPlaceholderDir({ hostId: 'h1', remotePath: '/data/work', env: ENV, fsImpl });
  const expected = mapRemoteToLocal('h1', '/data/work', ENV);
  assert.equal(result.localPath, expected);
  assert.equal(result.hostId, 'h1');
  assert.equal(result.remotePath, '/data/work');
  // Encoding reuse: localPath can be decoded back to the remote path (required for host tool routing reversibility)
  assert.deepEqual(mapLocalToRemote(result.localPath, ENV), { hostId: 'h1', remotePath: '/data/work' });
  // mkdir recursive succeeds even when parents are missing
  assert.equal(fsImpl.mkdirs.length, 1);
  assert.equal(fsImpl.mkdirs[0].p, expected);
  assert.deepEqual(fsImpl.mkdirs[0].opts, { recursive: true });
});

test('createPlaceholderDir: respects DSH_HOME (root = $DSH_HOME/remote); DSH_SSH_REMOTE_ROOT wins', async () => {
  const fsImpl = mockFs();
  await createPlaceholderDir({ hostId: 'h1', remotePath: '/a/b', env: { DSH_HOME: '/tmp/custom-dsh' }, fsImpl });
  assert.ok(toPosix(fsImpl.mkdirs[0].p).startsWith('/tmp/custom-dsh/remote/'), 'must live under $DSH_HOME/remote, got ' + fsImpl.mkdirs[0].p);
  // DSH_SSH_REMOTE_ROOT overrides DSH_HOME
  await createPlaceholderDir({ hostId: 'h1', remotePath: '/a/b', env: { DSH_HOME: '/tmp/ignored', DSH_SSH_REMOTE_ROOT: '/tmp/overridden' }, fsImpl });
  assert.ok(toPosix(fsImpl.mkdirs[1].p).startsWith('/tmp/overridden/'), 'DSH_SSH_REMOTE_ROOT must win, got ' + fsImpl.mkdirs[1].p);
});

test('createPlaceholderDir: idempotent (mkdir recursive succeeds on existing dir, two calls are consistent)', async () => {
  const fsImpl = mockFs();
  const first = await createPlaceholderDir({ hostId: 'h1', remotePath: '/data', env: ENV, fsImpl });
  const second = await createPlaceholderDir({ hostId: 'h1', remotePath: '/data', env: ENV, fsImpl });
  assert.deepEqual(second, first);
  assert.equal(fsImpl.mkdirs.length, 2);
});

test('createPlaceholderDir: rejects invalid hostId and relative remote path (no disk writes)', async () => {
  const fsImpl = mockFs();
  await assert.rejects(() => createPlaceholderDir({ hostId: '../evil', remotePath: '/x', env: ENV, fsImpl }), /unsafe segment|invalid host id/);
  await assert.rejects(() => createPlaceholderDir({ hostId: 'h1', remotePath: 'relative/path', env: ENV, fsImpl }), /must be absolute/);
  await assert.rejects(() => createPlaceholderDir({ hostId: '', remotePath: '/x', env: ENV, fsImpl }), /host id is required/);
  await assert.rejects(() => createPlaceholderDir({ hostId: 'h1', remotePath: '', env: ENV, fsImpl }), /remote path is required/);
  assert.equal(fsImpl.mkdirs.length, 0, 'no mkdir must happen on invalid input');
});

test('placeholderInvalidReason covers empty/relative/non-string', () => {
  assert.equal(placeholderInvalidReason('', '/x'), 'host id is required');
  assert.equal(placeholderInvalidReason('h1', ''), 'remote path is required');
  assert.equal(placeholderInvalidReason('h1', 'rel'), 'remote path must be absolute');
  assert.equal(placeholderInvalidReason('h1', '/ok'), null);
});

test('createPlaceholderDir: throws when fs.promises.mkdir is unavailable (injectability guard)', async () => {
  await assert.rejects(() => createPlaceholderDir({ hostId: 'h1', remotePath: '/x', env: ENV, fsImpl: {} }), /no promises.mkdir/);
});

test('placeholderDisplayName: placeholder workspace display name is the remote path basename', () => {
  // The placeholder directory name is the base64-encoded segment (e.g. L2hvbWUv...), so derive a human-readable name from the remote path.
  assert.equal(placeholderDisplayName('/home/devuser/workspace'), 'workspace');
  assert.equal(placeholderDisplayName('/data/work'), 'work');
  assert.equal(placeholderDisplayName('/中文/目录 😀'), '目录 😀');
  assert.equal(placeholderDisplayName('/a/b/'), 'b');            // trailing slash
  assert.equal(placeholderDisplayName('/'), 'root');             // root fallback
  assert.equal(placeholderDisplayName(''), 'root');              // empty input fallback
  assert.equal(placeholderDisplayName(undefined), 'root');       // non-string fallback
  assert.equal(placeholderDisplayName('/.hidden'), '.hidden');   // dotfiles keep their name
});

test('hostDisplayName: prefers name, falls back to hostId', () => {
  assert.equal(hostDisplayName({ h1: { name: 'ubuntu' } }, 'h1'), 'ubuntu');
  assert.equal(hostDisplayName({ h1: { name: '  ubuntu  ' } }, 'h1'), 'ubuntu'); // name is trimmed
  assert.equal(hostDisplayName({ h1: { name: '' } }, 'h1'), 'h1');               // empty name → fallback
  assert.equal(hostDisplayName({ h1: {} }, 'h1'), 'h1');                          // no name field → fallback
  assert.equal(hostDisplayName({}, 'h1'), 'h1');                                  // unknown host → fallback
  assert.equal(hostDisplayName(undefined, 'h1'), 'h1');
  assert.equal(hostDisplayName({}, ''), '?');                                     // empty hostId → '?'
});

test('placeholderWorkspaceTitle: host display name / basename', () => {
  assert.equal(placeholderWorkspaceTitle('/home/devuser/workspace', 'devuser'), 'devuser / workspace');
  assert.equal(placeholderWorkspaceTitle('/data/work', 'h1'), 'h1 / work');
  assert.equal(placeholderWorkspaceTitle('/a/b/', 'sv1'), 'sv1 / b');        // trailing slash
  assert.equal(placeholderWorkspaceTitle('/', 'sv1'), 'sv1 / root');         // root fallback
});

test('createPlaceholderDir: real directory on disk (tmp isolated, DSH_HOME=/tmp/xxx; no writes to ~/.dsh/remote)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-m4-'));
  const env = { DSH_HOME: tmp };
  const result = await createPlaceholderDir({ hostId: 'h1', remotePath: '/中文/目录 😀', env });
  assert.ok(result.localPath.startsWith(tmp + path.sep + 'remote' + path.sep), 'placeholder under DSH_HOME/remote');
  // Contract: workspaceRegistry.create calls fs.realpath before checking isDirectory, so placeholder must be a real directory.
  // Note macOS /var → /private symlink: compare canonical logical path to detect whether localPath itself is a symlink
  // (if localPath is a symlink, realpathSync resolves elsewhere and differs from canonical).
  const canonical = path.join(fs.realpathSync(tmp), 'remote', 'h1', encodeRemotePath('/中文/目录 😀'));
  assert.equal(fs.realpathSync(result.localPath), canonical, 'placeholder must be a real (non-symlink) directory');
  const st = fs.statSync(result.localPath);
  assert.equal(st.isDirectory(), true);
  assert.deepEqual(mapLocalToRemote(result.localPath, env), { hostId: 'h1', remotePath: '/中文/目录 😀' });
  // Idempotent (second run on real fs)
  const again = await createPlaceholderDir({ hostId: 'h1', remotePath: '/中文/目录 😀', env });
  assert.deepEqual(again, result);
  assert.equal(encodeRemotePath('/中文/目录 😀').includes('/'), false, 'encoded segment must stay single');
  fs.rmSync(tmp, { recursive: true, force: true });
});
