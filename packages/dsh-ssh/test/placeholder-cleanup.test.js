// installPlaceholderCleanup: 工作区记录删除 → 清理本地占位目录(M4 补充)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installPlaceholderCleanup } from '../index.js';

function makeCtx() {
  const handlers = [];
  return {
    handlers,
    on(evt, h) { handlers.push([evt, h]); return () => {}; },
    effect() { return () => {}; },
  };
}

test('put 记录 id→path; deleted 触发 rm(仅限占位根内)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-cleanup-'));
  const removed = [];
  const ctx = makeCtx();
  const inst = installPlaceholderCleanup(ctx, {
    placeholderRoot: root,
    rm: async (p, opts) => { removed.push({ p, opts }); },
  });
  const [evt, handler] = ctx.handlers[0];
  assert.equal(evt, 'domain/changed');
  const wsId = 'ws-1';
  const localPath = path.join(root, 'h1', 'YWJj');
  handler({ domain: 'workspace', table: 'workspaces', operation: 'put', key: wsId, value: { path: localPath } });
  assert.equal(inst.byWorkspace.get(wsId), localPath);
  handler({ domain: 'workspace', table: 'workspaces', operation: 'deleted', key: wsId });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(removed.length, 1);
  assert.equal(removed[0].p, localPath);
  assert.deepEqual(removed[0].opts, { recursive: true, force: true });
  assert.equal(inst.byWorkspace.has(wsId), false);
});

test('占位根之外/其他域的事件被忽略', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-cleanup-'));
  const removed = [];
  const ctx = makeCtx();
  const inst = installPlaceholderCleanup(ctx, { placeholderRoot: root, rm: async (p) => removed.push(p) });
  const handler = ctx.handlers[0][1];
  handler({ domain: 'session', table: 'sessions', operation: 'deleted', key: 'x' });
  handler({ domain: 'workspace', table: 'workspaces', operation: 'put', key: 'w', value: { path: '/elsewhere/x' } });
  handler({ domain: 'workspace', table: 'workspaces', operation: 'deleted', key: 'w' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(removed.length, 0);
  assert.equal(inst.byWorkspace.size, 0);
});

test('create/delete 词汇同样受支持', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-cleanup-'));
  const removed = [];
  const ctx = makeCtx();
  installPlaceholderCleanup(ctx, { placeholderRoot: root, rm: async (p) => removed.push(p) });
  const handler = ctx.handlers[0][1];
  const localPath = path.join(root, 'h1', 'eHl6');
  handler({ domain: 'workspace', table: 'workspaces', operation: 'create', key: 'w2', record: { path: localPath } });
  handler({ domain: 'workspace', table: 'workspaces', operation: 'delete', key: 'w2' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(removed.length, 1);
  assert.equal(removed[0], localPath);
});
