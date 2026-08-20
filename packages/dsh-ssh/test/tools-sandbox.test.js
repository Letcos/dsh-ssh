// @dsh-ssh/dsh-ssh — P0 远端 sandbox 权限集成单测 (node --test, 无网络; 内存 sftp + mock 审批)。
// 验证 write/edit/bash 远端分支在 workspace-write/read-only/danger-full-access 下的拦截路径,
// 以及 escalation(sandbox_permissions/justification)的"条件暴露"语义(A.40):
//   - remoteRouting=true(方案⑤ agent/created 钩子, 只服务 remote cwd 会话/subagent)→ escalationModes=[]
//     → bash/write/edit schema 不暴露这两个字段(与官方逐字节对齐: 官方仅在 escalationModes.length>0 时
//       才写字段, dsh-tool-fs/lib/index.js L617/L771 / dsh-tool-bash/lib/index.js L285);
//     模型硬传 → 官方同形"不可用"报错; 三模式拦截(policy.js)原样保留。
//   - 本地委托模式(无 remoteRouting, backend 挂载)→ escalationModes=ESCALATION_TARGETS → 字段暴露 + 升级可用
//     (本地委托升级语义与官方一致)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../tools.js';
import { mapRemoteToLocal } from '../src/router.js';
import { SftpWrapper } from '../src/ssh-core.js';

process.env.DSH_SSH_REMOTE_ROOT = '/tmp/dsh-ssh-test-remote-root';

const HOSTS = { h1: { id: 'h1', host: '1.2.3.4', port: 22, user: 'u', auth: { type: 'key' } } };

// 内存 sftp(与 tools-remote.test.js 同构)
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

// 带 sandbox 语义的 mock ctx: fs/shell.sandboxMode + sandboxPolicy.resolve({session}) + approval。
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

// 真实远端注册形态: 方案⑤ agent/created 钩子用 remoteRouting=true(index.js)。
function applyRemote(ctx, config = {}) { return apply(ctx, { remoteRouting: true, ...config }); }

// ═══ 条件暴露(对齐官方: 只在 escalationModes.length>0 时写字段) ═══
test('remoteRouting: bash/write/edit schema 不含 sandbox_permissions/justification (字段隐藏)', () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}) });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'danger-full-access' });
  applyRemote(ctx);
  for (const name of ['bash', 'write', 'edit']) {
    const props = (getTool(ctx, name).parameters ?? {}).properties ?? {};
    assert.ok(!('sandbox_permissions' in props), name + ' 不得暴露 sandbox_permissions');
    assert.ok(!('justification' in props), name + ' 不得暴露 justification');
  }
});

test('本地委托模式(无 remoteRouting, backend 挂载): bash/write/edit schema 含 sandbox_permissions/justification', () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}) });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  apply(ctx); // remoteRouting=false → 保留升级广告(本地委托升级语义与官方一致)
  for (const name of ['bash', 'write', 'edit']) {
    const props = (getTool(ctx, name).parameters ?? {}).properties ?? {};
    assert.ok('sandbox_permissions' in props, name + ' 应暴露 sandbox_permissions');
    assert.ok('justification' in props, name + ' 应暴露 justification');
  }
});

test('无 sandbox backend(无 remoteRouting): bash/write/edit schema 不含升级字段', () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}) });
  const ctx = makeSandboxCtx({ sshPool: pool });
  ctx.get = (key) => (key === 'sshPool' || key === 'settings') ? (key === 'sshPool' ? pool : { get: () => ({ hosts: HOSTS }) }) : undefined;
  apply(ctx);
  for (const name of ['bash', 'write', 'edit']) {
    const props = (getTool(ctx, name).parameters ?? {}).properties ?? {};
    assert.ok(!('sandbox_permissions' in props), name + ' 不得暴露 sandbox_permissions');
    assert.ok(!('justification' in props), name + ' 不得暴露 justification');
  }
});

// ═══ write ═══
test('workspace-write: 区内写放行', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  applyRemote(ctx);
  const out = await getTool(ctx, 'write').execute({ file_path: 'new.txt', content: 'hello\n' }, makeExec('h1', '/data/work'));
  assert.equal(out.path, '/data/work/new.txt');
  assert.equal(sftp._files.get('/data/work/new.txt').data.toString('utf8'), 'hello\n');
});

test('workspace-write: 区外绝对路径写拒绝 (FS_SANDBOX_DENIED + marker)', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute({ file_path: '/etc/foo', content: 'x' }, makeExec('h1', '/data/work')),
    (e) => e.code === 'FS_SANDBOX_DENIED' && e.message.startsWith('[sandbox: file access denied under workspace-write mode]'),
  );
  assert.equal(sftp._files.has('/etc/foo'), false, '区外文件不得被写入');
});

test('workspace-write: ../ 逃逸路径拒绝', async () => {
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

test('read-only: 区内写也拒绝', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'read-only' });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute({ file_path: 'new.txt', content: 'x' }, makeExec('h1', '/data/work')),
    (e) => e.code === 'FS_SANDBOX_DENIED' && e.message.startsWith('[sandbox: file access denied under read-only mode]'),
  );
});

test('danger-full-access: 区外写放行 (现状行为)', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'danger-full-access' });
  applyRemote(ctx);
  const out = await getTool(ctx, 'write').execute({ file_path: '/etc/foo', content: 'x' }, makeExec('h1', '/data/work'));
  assert.equal(out.path, '/etc/foo');
  assert.equal(sftp._files.get('/etc/foo').data.toString('utf8'), 'x');
});

// ═══ edit ═══
test('workspace-write: 区外 edit 拒绝; 区内 edit 放行', async () => {
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

// ═══ remoteRouting 下升级不可用(防御性兜底, 对标官方"不可用"报错) ═══
test('remoteRouting: workspace-write + sandbox_permissions=wider → 报"不可用", 不触发审批不写入', async () => {
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
  assert.equal(approval._calls.length, 0, '远端升级不可用, 不得触发审批');
  assert.equal(sftp._files.has('/etc/foo'), false, '不得写入');
});

test('remoteRouting: 非严格更宽升级(danger-full-access → workspace-write) 同样报"不可用"', async () => {
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

test('升级参数校验: sandbox_permissions 无 justification → 报错(先于不可用判定)', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  applyRemote(ctx);
  await assert.rejects(
    getTool(ctx, 'write').execute({ file_path: '/etc/foo', content: 'x', sandbox_permissions: 'danger-full-access' }, makeExec('h1', '/data/work')),
    (e) => /requires a justification/.test(e.message),
  );
});

// ═══ 本地委托模式(无 remoteRouting)下升级仍可用(保留本地委托升级语义, 与官方一致) ═══
test('本地委托模式: workspace-write 区外写 + sandbox_permissions=danger-full-access → 审批放行', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const approval = makeApproval('allowed-once');
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write', approval });
  apply(ctx); // remoteRouting=false → 远端升级仍可用(本地委托模式)
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

test('本地委托模式: 升级被用户拒绝 → 报错且不写入', async () => {
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

test('本地委托模式: 非严格更宽升级 (danger-full-access → workspace-write) → 拒绝', async () => {
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
test('bash: read-only → 官方同形 denial 结果 (sandbox.denied)', async () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}) });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'read-only' });
  applyRemote(ctx);
  const out = await getTool(ctx, 'bash').execute({ command: 'echo hi', description: 'x' }, makeExec('h1', '/data/work'));
  assert.equal(out.kind, 'foreground');
  assert.equal(out.sandbox.mode, 'read-only');
  assert.equal(out.sandbox.denied, true);
  assert.equal(out.stdout.text, '');
});

test('bash: workspace-write → 放行 (无 runner, 文档化差异)', async () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}), execImpl: async () => ({ code: 0, signal: null, stdout: 'hi\n', stderr: '' }) });
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'workspace-write' });
  applyRemote(ctx);
  const out = await getTool(ctx, 'bash').execute({ command: 'echo hi', description: 'x' }, makeExec('h1', '/data/work'));
  assert.equal(out.kind, 'foreground');
  assert.equal(out.stdout.text, 'hi\n');
});

test('remoteRouting: bash read-only + sandbox_permissions → 报"不可用"(executor), 不触发审批', async () => {
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

test('本地委托模式: bash read-only + sandbox_permissions=workspace-write → 审批放行', async () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}), execImpl: async () => ({ code: 0, signal: null, stdout: 'hi\n', stderr: '' }) });
  const approval = makeApproval('allowed-once');
  const ctx = makeSandboxCtx({ sshPool: pool, mode: 'read-only', approval });
  apply(ctx); // 无 remoteRouting → 远端升级可用
  const out = await getTool(ctx, 'bash').execute(
    { command: 'echo hi', description: 'x', sandbox_permissions: 'workspace-write', justification: 'need to run a command' },
    makeExec('h1', '/data/work'),
  );
  assert.equal(out.stdout.text, 'hi\n');
  assert.equal(approval._calls.length, 1);
  assert.equal(approval._calls[0].toolName, 'bash');
});