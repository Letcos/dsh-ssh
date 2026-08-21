// @dsh-ssh/dsh-ssh — remote sandbox permission integration tests (node --test, no network; in-memory sftp + mock approval).
// Verifies write/edit/bash remote branches under workspace-write/read-only/danger-full-access,
// and conditional exposure of escalation (sandbox_permissions/justification):
//   - remoteRouting=true (agent/created hook, only serves remote cwd sessions/subagents) -> escalationModes=[]
//     -> bash/write/edit schema does not expose those fields (aligns with official: only when escalationModes.length>0
//       are fields written, dsh-tool-fs/lib/index.js L617/L771 / dsh-tool-bash/lib/index.js L285);
//     model hard escalation -> same "not available" error as official; three-mode interception (policy.js) preserved.
//   - Local delegation mode (no remoteRouting, backend mounted) -> escalationModes=ESCALATION_TARGETS -> fields exposed and escalation available
//     (same escalation semantics as official).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../tools.js';
import { mapRemoteToLocal } from '../src/router.js';
import { SftpWrapper } from '../src/ssh-core.js';

process.env.DSH_SSH_REMOTE_ROOT = '/tmp/dsh-ssh-test-remote-root';

const HOSTS = { h1: { id: 'h1', host: '203.0.113.10', port: 22, user: 'u', auth: { type: 'key' } } };

// In-memory sftp (same as tools-remote.test.js)
function makeMemorySftp(initial = {}) {
  const files = new Map();
  for (const [p, c] of Object.entries(initial)) files.set(p, { type: 'file', data: Buffer.from(c, 'utf8'), size: Buffer.byteLength(c) });
  const attrs = (e) => ({ size: e.size, isDirectory: () => e.type === 'dir', isFile: () => e.type === 'file', isSymbolicLink: () => false });
  return {
    _files: files,
    stat(p, cb) { const e = files.get(p); return e ? cb(null, attrs(e)) : cb({ code: 2, message: 'no such file' }); },
    readFile(p, ...rest) {
      const cb = rest.pop();
      const e = files.get(p);
      if (!e) return cb({ code: 2, message: 'no such file' });
      return (rest.length >= 1 && rest[0] === 'utf8') ? cb(null, e.data.toString('utf8')) : cb(null, e.data);
    },
    writeFile(p, data, cb) { files.set(p, { type: 'file', data: Buffer.from(data), size: Buffer.byteLength(data) }); cb(null); },
    rename(from, to, cb) { const e = files.get(from); if (!e) return cb({ code: 2, message: 'no such file' }); files.delete(from); files.set(to, e); cb(null); },
    unlink(p, cb) { files.delete(p); cb(null); },
    readdir(p, cb) { cb(null, []); },
    open(p, flags, cb) { const e = files.get(p); if (!e) return cb({ code: 2, message: 'no such file' }); cb(null, { p }); },
    read(handle, buf, off, len, position, cb) {
      const e = files.get(handle.p);
      if (!e) return cb({ code: 2, message: 'no such file' });
      const n = Math.max(0, Math.min(len, e.data.length - position));
      if (n > 0) e.data.copy(buf, off, position, position + n);
      cb(null, n, buf, position + n);
    },
    close(handle, cb) { cb(null); },
  };
}

function makePool({ sftp, execImpl } = {}) {
  const conn = {
    hostId: 'h1',
    exec: execImpl ?? (async () => ({ code: 0, signal: null, stdout: 'hi\n', stderr: '' })),
    sftp: async () => new SftpWrapper({ hostId: 'h1' }, sftp),
    fs: async () => new SftpWrapper({ hostId: 'h1' }, sftp),
  };
  const pool = { acquire: async () => conn, release: () => {} };
  return { pool, conn };
}

function makeApproval(outcome = 'allowed-once') {
  const calls = [];
  return { _calls: calls, request: async (req) => { calls.push(req); return outcome; } };
}

// Mock ctx with sandbox semantics: fs/shell.sandboxMode + sandboxPolicy.resolve({session}) + approval.
function makeSandboxCtx({ hosts = HOSTS, sshPool, mode = 'workspace-write', approval } = {}) {
  const registered = new Map();
  const fs = { sandboxMode: mode };
  const shell = { sandboxMode: mode };
  const sandboxPolicy = { resolve: ({ session } = {}) => ({ mode, workspaceRoot: '/data/work', ...(session ? { sessionId: session.id } : {}) }) };
  return {
    tools: { register(def) { registered.set(def.name, def); return () => registered.delete(def.name); }, get() { return undefined; } },
    shell, fs,
    get(key) {
      if (key === 'sshPool') return sshPool;
      if (key === 'settings') return { get: () => ({ hosts }) };
      if (key === 'attachments') return undefined;
      if (key === 'sandboxPolicy') return sandboxPolicy;
      if (key === 'approval') return approval;
      if (key === 'fs') return fs;
      if (key === 'shell') return shell;
      return undefined;
    },
    logger: { info: () => {} },
    _registered: registered,
  };
}

function makeExec(hostId, remotePath, extra = {}) {
  const cwd = mapRemoteToLocal(hostId, remotePath);
  return { agent: { session: { header: { cwd }, id: 'sess-1' } }, signal: undefined, callId: 'call-1', ...extra };
}

function getTool(ctx, name) { return ctx._registered.get(name); }

// Real remote registration: agent/created hook uses remoteRouting=true (index.js).
function applyRemote(ctx, config = {}) { return apply(ctx, { remoteRouting: true, ...config }); }

// === Conditional exposure (matches official: only when escalationModes.length>0 are fields written) ===
test('remoteRouting: bash/write/edit schema excludes sandbox_permissions/justification (fields hidden)', () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}) });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'danger-full-access' });
  applyRemote(ctx);
  for (const name of ['bash', 'write', 'edit']) {
    const props = (getTool(ctx, name).parameters ?? {}).properties ?? {};
    assert.ok(!('sandbox_permissions' in props), name + ' must not expose sandbox_permissions');
    assert.ok(!('justification' in props), name + ' must not expose justification');
  }
});

test('local delegation mode (no remoteRouting, backend mounted): bash/write/edit schema includes sandbox_permissions/justification', () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}) });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  apply(ctx); // remoteRouting=false -> keep escalation exposure (local delegation semantics match official)
  for (const name of ['bash', 'write', 'edit']) {
    const props = (getTool(ctx, name).parameters ?? {}).properties ?? {};
    assert.ok('sandbox_permissions' in props, name + ' should expose sandbox_permissions');
    assert.ok('justification' in props, name + ' should expose justification');
  }
});

test('no sandbox backend (no remoteRouting): bash/write/edit schema excludes escalation fields', () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}) });
  const ctx = makeSandboxCtx({ sshPool: pool });
  ctx.get = (key) => (key === 'sshPool' || key === 'settings') ? (key === 'sshPool' ? pool : { get: () => ({ hosts: HOSTS }) }) : undefined;
  apply(ctx);
  for (const name of ['bash', 'write', 'edit']) {
    const props = (getTool(ctx, name).parameters ?? {}).properties ?? {};
    assert.ok(!('sandbox_permissions' in props), name + ' must not expose sandbox_permissions');
    assert.ok(!('justification' in props), name + ' must not expose justification');
  }
});

// === write ===
test('workspace-write: write inside workspace allowed', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  applyRemote(ctx);
  const out = await getTool(ctx, 'write').execute({ file_path: 'new.txt', content: 'hello\n' }, makeExec('h1', '/data/work'));
  assert.equal(out.path, '/data/work/new.txt');
  assert.equal(sftp._files.get('/data/work/new.txt').data.toString('utf8'), 'hello\n');
});

test('workspace-write: write outside workspace with absolute path denied (FS_SANDBOX_DENIED + marker)', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute({ file_path: '/etc/foo', content: 'x' }, makeExec('h1', '/data/work')),
    (e) => e.code === 'FS_SANDBOX_DENIED' && e.message.startsWith('[sandbox: file access denied under workspace-write mode]'),
  );
  assert.equal(sftp._files.has('/etc/foo'), false, 'outside file must not be written');
});

test('workspace-write: ../ escape path denied', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute({ file_path: '/data/work/../../etc/foo', content: 'x' }, makeExec('h1', '/data/work')),
    (e) => e.code === 'FS_SANDBOX_DENIED',
  );
  assert.equal(sftp._files.has('/etc/foo'), false);
});

test('read-only: write inside workspace also denied', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'read-only' });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute({ file_path: 'new.txt', content: 'x' }, makeExec('h1', '/data/work')),
    (e) => e.code === 'FS_SANDBOX_DENIED' && e.message.startsWith('[sandbox: file access denied under read-only mode]'),
  );
});

test('danger-full-access: write outside workspace allowed (current behavior)', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'danger-full-access' });
  applyRemote(ctx);
  const out = await getTool(ctx, 'write').execute({ file_path: '/etc/foo', content: 'x' }, makeExec('h1', '/data/work'));
  assert.equal(out.path, '/etc/foo');
  assert.equal(sftp._files.get('/etc/foo').data.toString('utf8'), 'x');
});

// ═══ edit ═══
test('workspace-write: edit outside workspace denied; inside allowed', async () => {
  const sftp = makeMemorySftp({ '/data/work/f.txt': 'abc' });
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'edit').execute({ file_path: '/etc/foo', old_string: 'a', new_string: 'b' }, makeExec('h1', '/data/work')),
    (e) => e.code === 'FS_SANDBOX_DENIED',
  );
  const ok = await getTool(ctx, 'edit').execute({ file_path: 'f.txt', old_string: 'abc', new_string: 'xyz' }, makeExec('h1', '/data/work'));
  assert.equal(ok.after, 'xyz');
});

// === remoteRouting escalation unavailable (defensive fallback, matches official not-available) ===
test('remoteRouting: workspace-write + sandbox_permissions=wider reports not available, no approval and no write', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const approval = makeApproval('allowed-once');
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write', approval });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute(
      { file_path: '/etc/foo', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'need to write outside workspace' },
      makeExec('h1', '/data/work'),
    ),
    (e) => /not available in this composition \(no sandboxing filesystem to escalate\)/.test(e.message),
  );
  assert.equal(approval._calls.length, 0, 'remote escalation unavailable, must not trigger approval');
  assert.equal(sftp._files.has('/etc/foo'), false, 'must not write');
});

test('remoteRouting: non-strictly-wider escalation (danger-full-access -> workspace-write) also reports not available', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'danger-full-access', approval: makeApproval('allowed-once') });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute(
      { file_path: '/etc/foo', content: 'x', sandbox_permissions: 'workspace-write', justification: 'x' },
      makeExec('h1', '/data/work'),
    ),
    (e) => /not available in this composition/.test(e.message),
  );
  assert.equal(sftp._files.has('/etc/foo'), false);
});

test('escalation param validation: sandbox_permissions without justification reports error (before not-available check)', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute({ file_path: '/etc/foo', content: 'x', sandbox_permissions: 'danger-full-access' }, makeExec('h1', '/data/work')),
    (e) => /requires a justification/.test(e.message),
  );
});

// === Local delegation mode (no remoteRouting) escalation still available (preserves local delegation semantics, matches official) ===
test('local delegation mode: workspace-write write outside + sandbox_permissions=danger-full-access -> approval allowed', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const approval = makeApproval('allowed-once');
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write', approval });
  apply(ctx); // remoteRouting=false -> remote escalation still available (local delegation)
  const out = await getTool(ctx, 'write').execute(
    { file_path: '/etc/foo', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'need to write outside workspace' },
    makeExec('h1', '/data/work'),
  );
  assert.equal(out.path, '/etc/foo');
  assert.equal(approval._calls.length, 1);
  assert.equal(approval._calls[0].toolName, 'write');
  assert.equal(approval._calls[0].callId, 'call-1');
  assert.equal(approval._calls[0].agent.session.id, 'sess-1');
});

test('local delegation mode: escalation rejected by user -> error and no write', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const approval = makeApproval('rejected');
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write', approval });
  apply(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute(
      { file_path: '/etc/foo', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'nope' },
      makeExec('h1', '/data/work'),
    ),
    (e) => /user rejected escalating/.test(e.message),
  );
  assert.equal(sftp._files.has('/etc/foo'), false);
});

test('local delegation mode: non-strictly-wider escalation (danger-full-access -> workspace-write) -> denied', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'danger-full-access', approval: makeApproval('allowed-once') });
  apply(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute(
      { file_path: '/etc/foo', content: 'x', sandbox_permissions: 'workspace-write', justification: 'x' },
      makeExec('h1', '/data/work'),
    ),
    (e) => /not strictly wider/.test(e.message),
  );
  assert.equal(sftp._files.has('/etc/foo'), false);
});

// ═══ bash ═══
test('bash: read-only -> official-shaped denial result (sandbox.denied)', async () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}) });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'read-only' });
  applyRemote(ctx);
  const out = await getTool(ctx, 'bash').execute({ command: 'echo hi', description: 'x' }, makeExec('h1', '/data/work'));
  assert.equal(out.kind, 'foreground');
  assert.equal(out.sandbox.mode, 'read-only');
  assert.equal(out.sandbox.denied, true);
  assert.equal(out.stdout.text, '');
});

test('bash: workspace-write -> allowed (no runner, documented difference)', async () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}), execImpl: async () => ({ code: 0, signal: null, stdout: 'hi\n', stderr: '' }) });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  applyRemote(ctx);
  const out = await getTool(ctx, 'bash').execute({ command: 'echo hi', description: 'x' }, makeExec('h1', '/data/work'));
  assert.equal(out.kind, 'foreground');
  assert.equal(out.stdout.text, 'hi\n');
});

test('remoteRouting: bash read-only + sandbox_permissions reports not available (executor), no approval', async () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}), execImpl: async () => ({ code: 0, signal: null, stdout: 'hi\n', stderr: '' }) });
  const approval = makeApproval('allowed-once');
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'read-only', approval });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'bash').execute(
      { command: 'echo hi', description: 'x', sandbox_permissions: 'workspace-write', justification: 'need to run a command' },
      makeExec('h1', '/data/work'),
    ),
    (e) => /not available in this composition \(no sandboxing executor to escalate\)/.test(e.message),
  );
  assert.equal(approval._calls.length, 0);
});

test('local delegation mode: bash read-only + sandbox_permissions=workspace-write -> approval allowed', async () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}), execImpl: async () => ({ code: 0, signal: null, stdout: 'hi\n', stderr: '' }) });
  const approval = makeApproval('allowed-once');
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'read-only', approval });
  apply(ctx); // no remoteRouting -> remote escalation available
  const out = await getTool(ctx, 'bash').execute(
    { command: 'echo hi', description: 'x', sandbox_permissions: 'workspace-write', justification: 'need to run a command' },
    makeExec('h1', '/data/work'),
  );
  assert.equal(out.stdout.text, 'hi\n');
  assert.equal(approval._calls.length, 1);
  assert.equal(approval._calls[0].toolName, 'bash');
});