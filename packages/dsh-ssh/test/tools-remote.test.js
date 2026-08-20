// @dsh-ssh/dsh-ssh — M3b remote-branch tests (node --test, no network; in-memory sftp).
// 注入 mock SshPool/SshConn(内存 sftp 仿真)验证五个工具的远端分支, 含错误文案字段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../tools.js';
import { mapRemoteToLocal } from '../src/router.js';
import { SshError, SftpWrapper } from '../src/ssh-core.js';

process.env.DSH_SSH_REMOTE_ROOT = '/tmp/dsh-ssh-test-remote-root';

// ── 内存 sftp 仿真(ssh2 回调风格: readFile/stat/writeFile/rename/unlink/readdir) ──
function makeMemorySftp(initial = {}) {
  const files = new Map();
  for (const [p, c] of Object.entries(initial)) {
    files.set(p, { type: 'file', data: Buffer.from(c, 'utf8'), size: Buffer.byteLength(c) });
  }
  const attrs = (e) => ({
    size: e.size,
    isDirectory: () => e.type === 'dir',
    isFile: () => e.type === 'file',
    isSymbolicLink: () => false,
  });
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
    // ssh2 裸 read 契约: open/read(handle, buf, off, len, position, cb)/close; EOF → cb(null, 0)
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

function makeCtx({ hosts = {}, sshPool, attachments, jobs } = {}) {
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
      if (key === 'jobs') return jobs;
      return undefined;
    },
    logger: { info: () => {} },
    _registered: registered,
  };
}

function makeExec(hostId, remotePath) {
  const cwd = mapRemoteToLocal(hostId, remotePath);
  return { agent: { session: { header: { cwd } } }, signal: undefined };
}

function makePool({ sftp, execImpl }) {
  const conn = {
    hostId: 'h1',
    exec: execImpl ?? (async (cmd, opts) => ({ code: 0, signal: null, stdout: 'hi\n', stderr: '' })),
    sftp: async () => new SftpWrapper({ hostId: 'h1' }, sftp),
    fs: async () => new SftpWrapper({ hostId: 'h1' }, sftp),
  };
  const pool = { acquire: async () => conn, release: () => {} };
  return { pool, conn };
}

function getTool(ctx, name) { return ctx._registered.get(name); }

// ═══ bash ═══
test('remote bash → official-shaped ShellRunResult (echo hi)', async () => {
  const { pool } = makePool({ execImpl: async (cmd, opts) => ({ code: 0, signal: null, stdout: 'hi\n', stderr: '' }) });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', port: 22, user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  const out = await getTool(ctx, 'bash').execute({ command: 'echo hi', description: 'say hi' }, makeExec('h1', '/data/work'));
  assert.equal(out.kind, 'foreground');
  assert.equal(out.exitCode, 0);
  assert.equal(out.signal, null);
  assert.equal(out.timedOut, false);
  assert.equal(out.stdout.text, 'hi\n');
  assert.equal(out.stderr.text, '');
});

test('remote bash exec error carries hostId + command (N7/F9)', async () => {
  const { pool } = makePool({ execImpl: async () => { throw new SshError({ hostId: 'h1', stage: 'connect', message: 'connection refused' }); } });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    getTool(ctx, 'bash').execute({ command: 'echo hi', description: 'say hi' }, makeExec('h1', '/data/work')),
    (e) => /host h1/.test(e.message) && /connection refused/.test(e.message) && /echo hi/.test(e.message),
  );
});

test('remote bash unknown hostId → clear config error (not silent local)', async () => {
  const { pool } = makePool({});
  const ctx = makeCtx({ hosts: {}, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    getTool(ctx, 'bash').execute({ command: 'echo hi', description: 'x' }, makeExec('ghost', '/data/work')),
    (e) => /not configured/.test(e.message) && /ghost/.test(e.message),
  );
});

test('remote bash run_in_background → clear error when jobs service unavailable', async () => {
  const { pool } = makePool({});
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    getTool(ctx, 'bash').execute({ command: 'sleep 10', description: 'x', run_in_background: true }, makeExec('h1', '/data/work')),
    (e) => /background jobs unavailable/.test(e.message) && /dsh-jobs/.test(e.message),
  );
});

test('remote bash run_in_background → {kind:background, jobId} via jobs.start; run() 返回控制器契约', async () => {
  const { pool } = makePool({}); // execImpl 默认返回 hi\n(spawn 解析 pid 失败, 但 jobs.start 同步返回 id)
  const jobs = {
    calls: [],
    start(spec) { this.calls.push(spec); return 'bash-1'; },
  };
  const ctx = makeCtx({
    hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } },
    sshPool: pool,
    jobs,
  });
  apply(ctx);
  const out = await getTool(ctx, 'bash').execute({ command: 'sleep 10', description: 'x', run_in_background: true }, makeExec('h1', '/data/work'));
  assert.equal(out.kind, 'background');
  assert.equal(out.jobId, 'bash-1');
  assert.equal(jobs.calls.length, 1);
  assert.equal(jobs.calls[0].kind, 'bash');
  assert.equal(jobs.calls[0].label, 'sleep 10'); // 与官方 tool-bash 一致: label=命令
  assert.equal(typeof jobs.calls[0].run, 'function');
  assert.ok(jobs.calls[0].owner); // exec.agent 作为 owner 传入
  const hooks = jobs.calls[0].run();
  assert.equal(typeof hooks.cancel, 'function');
  assert.equal(typeof hooks.done.then, 'function');
  assert.equal(typeof hooks.readOutput, 'function');
});

// ═══ read ═══
test('remote read → line-numbered window (relative path → remoteCwd)', async () => {
  const sftp = makeMemorySftp({ '/data/work/hello.txt': 'line1\nline2\nline3\n' });
  const { pool } = makePool({ sftp });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  const out = await getTool(ctx, 'read').execute({ file_path: 'hello.txt', offset: 1, limit: 10 }, makeExec('h1', '/data/work'));
  assert.equal(out.path, '/data/work/hello.txt');
  assert.equal(out.offset, 1);
  assert.deepEqual(out.lines, [{ number: 1, text: 'line1' }, { number: 2, text: 'line2' }, { number: 3, text: 'line3' }]);
  assert.equal(out.totalLines, 3);
});

test('remote read missing file → FS_NOT_FOUND', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    getTool(ctx, 'read').execute({ file_path: 'nope.txt' }, makeExec('h1', '/data/work')),
    (e) => e.code === 'FS_NOT_FOUND',
  );
});

test('remote read binary (NUL) → FS_NOT_TEXT', async () => {
  const sftp = makeMemorySftp({ '/data/work/bin.dat': 'a' + String.fromCharCode(0) + 'b' });
  const { pool } = makePool({ sftp });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    getTool(ctx, 'read').execute({ file_path: 'bin.dat' }, makeExec('h1', '/data/work')),
    (e) => e.code === 'FS_NOT_TEXT',
  );
});

// ═══ write ═══
test('remote write create → atomic, operation=create, before=null', async () => {
  const sftp = makeMemorySftp({});
  const { pool } = makePool({ sftp });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  const out = await getTool(ctx, 'write').execute({ file_path: 'new.txt', content: 'hello\n' }, makeExec('h1', '/data/work'));
  assert.equal(out.path, '/data/work/new.txt');
  assert.equal(out.operation, 'create');
  assert.equal(out.before, null);
  assert.equal(out.after, 'hello\n');
  assert.equal(sftp._files.get('/data/work/new.txt').data.toString('utf8'), 'hello\n');
});

test('remote write overwrite → operation=update, before=old text', async () => {
  const sftp = makeMemorySftp({ '/data/work/f.txt': 'old' });
  const { pool } = makePool({ sftp });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  const out = await getTool(ctx, 'write').execute({ file_path: 'f.txt', content: 'new' }, makeExec('h1', '/data/work'));
  assert.equal(out.operation, 'update');
  assert.equal(out.before, 'old');
  assert.equal(out.after, 'new');
});

// ═══ edit ═══
test('remote edit unique match → before/after + sftp write-back', async () => {
  const sftp = makeMemorySftp({ '/data/work/f.txt': 'abc\ndef\n' });
  const { pool } = makePool({ sftp });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  const out = await getTool(ctx, 'edit').execute({ file_path: 'f.txt', old_string: 'abc', new_string: 'xyz' }, makeExec('h1', '/data/work'));
  assert.equal(out.path, '/data/work/f.txt');
  assert.equal(out.before, 'abc\ndef\n');
  assert.equal(out.after, 'xyz\ndef\n');
  assert.equal(sftp._files.get('/data/work/f.txt').data.toString('utf8'), 'xyz\ndef\n');
});

test('remote edit ambiguous (no replace_all) → FS_AMBIGUOUS_EDIT', async () => {
  const sftp = makeMemorySftp({ '/data/work/f.txt': 'x\ny\nx\n' });
  const { pool } = makePool({ sftp });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    getTool(ctx, 'edit').execute({ file_path: 'f.txt', old_string: 'x', new_string: 'z' }, makeExec('h1', '/data/work')),
    (e) => e.code === 'FS_AMBIGUOUS_EDIT',
  );
});

test('remote edit replace_all → all occurrences', async () => {
  const sftp = makeMemorySftp({ '/data/work/f.txt': 'x\ny\nx\n' });
  const { pool } = makePool({ sftp });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  const out = await getTool(ctx, 'edit').execute({ file_path: 'f.txt', old_string: 'x', new_string: 'z', replace_all: true }, makeExec('h1', '/data/work'));
  assert.equal(out.after, 'z\ny\nz\n');
});

// ═══ read_image ═══
test('remote read_image → official-shaped image output (saveImage)', async () => {
  const sftp = makeMemorySftp({ '/data/work/img.png': 'FAKEPNGDATA' });
  const { pool } = makePool({ sftp });
  const attachments = {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1024, maxMessageImageBytes: 1024 },
    saveImage: async ({ data, mediaType, name }) => ({ attachmentId: 'att-1', mediaType, bytes: data.length, width: 1, height: 1, name }),
  };
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool, attachments });
  apply(ctx);
  const out = await getTool(ctx, 'read_image').execute({ file_path: 'img.png' }, makeExec('h1', '/data/work'));
  assert.equal(out.path, '/data/work/img.png');
  assert.equal(out.image.attachmentId, 'att-1');
  assert.equal(out.image.mediaType, 'image/png');
  assert.equal(out.image.bytes, 11); // 'FAKEPNGDATA'.length
});

test('remote read_image wrong extension → clear error', async () => {
  const { pool } = makePool({ sftp: makeMemorySftp({}) });
  const ctx = makeCtx({ hosts: { h1: { id: 'h1', host: '1.2.3.4', user: 'u', auth: { type: 'key' } } }, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    getTool(ctx, 'read_image').execute({ file_path: 'notes.txt' }, makeExec('h1', '/data/work')),
    (e) => /only accepts PNG/.test(e.message),
  );
});
