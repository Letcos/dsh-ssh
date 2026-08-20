// @dsh-ssh/dsh-ssh — M3b local-delegation tests (node --test, no network/IO).
// 验证本地分支把调用转发给宿主全局同名工具(逐字节一致的硬约束 4), 参数/exec 原样传递。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../tools.js';

process.env.DSH_SSH_REMOTE_ROOT = '/tmp/dsh-ssh-test-remote-root';

function makeCtx(officialTools) {
  const registered = new Map();
  const calls = [];
  const ctx = {
    tools: {
      register(def) { registered.set(def.name, def); return () => registered.delete(def.name); },
      get(name) {
        const official = officialTools[name];
        if (!official) return undefined;
        return {
          name,
          execute: async (args, exec) => { calls.push({ name, args, exec }); return official.result; },
        };
      },
    },
    shell: { sandboxMode: undefined },
    fs: { sandboxMode: undefined },
    get(key) {
      if (key === 'shell') return ctx.shell;
      if (key === 'fs') return ctx.fs;
      return undefined;
    },
    logger: { info: () => {} },
    _registered: registered,
    _calls: calls,
  };
  return ctx;
}

function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: undefined };
}

const LOCAL_CWD = '/Users/haowu/project';

test('local bash delegates to official tool-bash (same args + exec)', async () => {
  const ctx = makeCtx({ bash: { result: { kind: 'foreground', delegated: 'bash' } } });
  apply(ctx);
  const args = { command: 'echo hi', description: 'say hi' };
  const exec = makeExec(LOCAL_CWD);
  const out = await ctx._registered.get('bash').execute(args, exec);
  assert.deepEqual(out, { kind: 'foreground', delegated: 'bash' });
  assert.equal(ctx._calls.length, 1);
  assert.equal(ctx._calls[0].name, 'bash');
  assert.equal(ctx._calls[0].args, args, 'args passed by identity');
  assert.equal(ctx._calls[0].exec, exec, 'exec passed by identity');
});

test('local read delegates to official tool-fs read', async () => {
  const ctx = makeCtx({ read: { result: { path: '/p', offset: 1, lines: [], totalLines: 0 } } });
  apply(ctx);
  const args = { file_path: 'a.txt', offset: 1, limit: 10 };
  const out = await ctx._registered.get('read').execute(args, makeExec(LOCAL_CWD));
  assert.equal(out.path, '/p');
  assert.equal(ctx._calls[0].name, 'read');
  assert.equal(ctx._calls[0].args, args);
});

test('local write delegates to official tool-fs write', async () => {
  const ctx = makeCtx({ write: { result: { path: '/p', operation: 'update', before: 'x', after: 'y' } } });
  apply(ctx);
  const args = { file_path: 'a.txt', content: 'y' };
  const out = await ctx._registered.get('write').execute(args, makeExec(LOCAL_CWD));
  assert.equal(out.operation, 'update');
  assert.equal(ctx._calls[0].name, 'write');
});

test('local edit delegates to official tool-fs edit', async () => {
  const ctx = makeCtx({ edit: { result: { path: '/p', before: 'a', after: 'b' } } });
  apply(ctx);
  const args = { file_path: 'a.txt', old_string: 'a', new_string: 'b' };
  const out = await ctx._registered.get('edit').execute(args, makeExec(LOCAL_CWD));
  assert.equal(out.after, 'b');
  assert.equal(ctx._calls[0].name, 'edit');
});

test('local read_image delegates to official tool-fs read_image', async () => {
  const ctx = makeCtx({ read_image: { result: { path: '/p', image: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } } });
  apply(ctx);
  const args = { file_path: 'img.png' };
  const out = await ctx._registered.get('read_image').execute(args, makeExec(LOCAL_CWD));
  assert.equal(out.image.attachmentId, 'a');
  assert.equal(ctx._calls[0].name, 'read_image');
});

test('local route never touches sshPool', async () => {
  let acquired = false;
  const ctx = makeCtx({ bash: { result: { kind: 'foreground' } } });
  ctx.get = (key) => {
    if (key === 'sshPool') { acquired = true; return { acquire: async () => { throw new Error('should not acquire'); } }; }
    return undefined;
  };
  apply(ctx);
  await ctx._registered.get('bash').execute({ command: 'echo hi', description: 'x' }, makeExec(LOCAL_CWD));
  assert.equal(acquired, false, 'sshPool must not be accessed for local route');
});

test('missing official tool → clear error (e.g. win32 tool-bash disabled)', async () => {
  const ctx = makeCtx({}); // no bash official
  apply(ctx);
  await assert.rejects(
    ctx._registered.get('bash').execute({ command: 'echo hi', description: 'x' }, makeExec(LOCAL_CWD)),
    (e) => /unavailable locally/.test(e.message) && /bash/.test(e.message),
  );
});

test('registered tool set = exactly the seven M3 tools (bash/read/write/edit/read_image/glob/grep)', () => {
  const ctx = makeCtx({});
  apply(ctx);
  assert.deepEqual([...ctx._registered.keys()].sort(), ['bash', 'edit', 'glob', 'grep', 'read', 'read_image', 'write']);
});

test('sandbox escalation fields advertised only when a confining backend is mounted', () => {
  const plain = makeCtx({});
  apply(plain);
  assert.equal(plain._registered.get('bash').parameters.properties.sandbox_permissions, undefined, 'no sandbox → no escalation field');
  assert.equal(plain._registered.get('write').parameters.properties.sandbox_permissions, undefined);

  const sandboxed = makeCtx({});
  sandboxed.shell = { sandboxMode: 'workspace-write' };
  sandboxed.fs = { sandboxMode: 'workspace-write' };
  apply(sandboxed);
  assert.ok(sandboxed._registered.get('bash').parameters.properties.sandbox_permissions, 'bash advertises sandbox_permissions');
  assert.ok(sandboxed._registered.get('write').parameters.properties.sandbox_permissions, 'write advertises sandbox_permissions');
  assert.ok(sandboxed._registered.get('edit').parameters.properties.sandbox_permissions, 'edit advertises sandbox_permissions');
  assert.equal(sandboxed._registered.get('read').parameters.properties.sandbox_permissions, undefined, 'read (non-mutating) has no escalation');
});
