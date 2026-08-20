// @dsh-ssh/dsh-ssh — settings 命名空间迁移单测(dssh-hosts → dsh-ssh-hosts)。
// 验证: 读侧回退(新空 + 旧有数据 → 读旧)、写侧全量写入新命名空间、已配主机不丢。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { HOSTS_NAMESPACE, LEGACY_HOSTS_NAMESPACE, readHostsDoc } from '../src/settings.js';
import { SshRemoteService } from '../src/remote.js';

test('改名后命名空间: 新 dsh-ssh-hosts / 旧 dssh-hosts(只读迁移源)', () => {
  assert.equal(String(HOSTS_NAMESPACE), 'dsh-ssh-hosts');
  assert.equal(String(LEGACY_HOSTS_NAMESPACE), 'dssh-hosts');
});

test('readHostsDoc: 新命名空间有主机 → 优先读新, legacy=false', () => {
  const get = (ns) => (ns === 'dsh-ssh-hosts' ? { hosts: { a: { id: 'a' } } } : { hosts: { b: { id: 'b' } } });
  const { hosts, legacy } = readHostsDoc(get);
  assert.equal(legacy, false);
  assert.deepEqual(Object.keys(hosts), ['a']);
});

test('readHostsDoc: 新空 + 旧有数据 → 回退读旧, legacy=true', () => {
  const get = (ns) => (ns === 'dssh-hosts' ? { hosts: { b: { id: 'b' } } } : undefined);
  const { hosts, legacy } = readHostsDoc(get);
  assert.equal(legacy, true);
  assert.deepEqual(Object.keys(hosts), ['b']);
});

test('readHostsDoc: 双空 → 空 dict, legacy=false', () => {
  const { hosts, legacy } = readHostsDoc(() => undefined);
  assert.equal(legacy, false);
  assert.deepEqual(hosts, {});
});

test('readHostsDoc: get 抛错 → 回退空 dict(不外抛)', () => {
  const { hosts, legacy } = readHostsDoc(() => { throw new Error('boom'); });
  assert.equal(legacy, false);
  assert.deepEqual(hosts, {});
});

test('saveHost 首次编辑: 旧命名空间主机整体迁入新命名空间, 已配主机不丢', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, { testConnection: async () => ({ ok: false, error: 'x' }) });
  // 新命名空间为空; 旧命名空间有 hA/hB 两台主机。
  let newDoc = { hosts: {} };
  const legacyDoc = {
    hosts: {
      hA: { id: 'hA', name: 'A', host: 'a', port: 22, user: 'u', auth: { type: 'key' } },
      hB: { id: 'hB', name: 'B', host: 'b', port: 22, user: 'u', auth: { type: 'key' } },
    },
  };
  let revision = 0;
  svc.setSettingsApi({
    get: (ns) => (ns === 'dsh-ssh-hosts' ? newDoc : ns === 'dssh-hosts' ? legacyDoc : undefined),
    describe: () => [{ ns: 'dsh-ssh-hosts', revision }],
    writable: true,
    async mutate(ns, ops) {
      assert.equal(ns, 'dsh-ssh-hosts');
      for (const op of ops) {
        if (op.op === 'set' && op.path.length === 1 && op.path[0] === 'hosts') newDoc.hosts = { ...op.value };
      }
      revision += 1;
    },
  });

  // 编辑 hA → 写侧全量写入新命名空间, hB 一并迁入。
  await svc.saveHost('hA', { id: 'hA', name: 'A2', host: 'a', port: 22, user: 'u', auth: { type: 'key' } }, 0);
  assert.deepEqual(Object.keys(newDoc.hosts).sort(), ['hA', 'hB']);
  assert.equal(newDoc.hosts.hA.name, 'A2');
  assert.equal(newDoc.hosts.hB.name, 'B'); // 旧主机不丢
  ctx.dispose?.();
});

test('deleteHost 首次删除(旧命名空间有数据): 其余旧主机一并迁入新命名空间', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, { testConnection: async () => ({ ok: false, error: 'x' }) });
  let newDoc = { hosts: {} };
  const legacyDoc = {
    hosts: {
      hA: { id: 'hA', name: 'A', host: 'a', port: 22, user: 'u', auth: { type: 'key' } },
      hB: { id: 'hB', name: 'B', host: 'b', port: 22, user: 'u', auth: { type: 'key' } },
    },
  };
  let revision = 0;
  svc.setSettingsApi({
    get: (ns) => (ns === 'dsh-ssh-hosts' ? newDoc : ns === 'dssh-hosts' ? legacyDoc : undefined),
    describe: () => [{ ns: 'dsh-ssh-hosts', revision }],
    writable: true,
    async mutate(ns, ops) {
      assert.equal(ns, 'dsh-ssh-hosts');
      for (const op of ops) {
        if (op.op === 'set' && op.path.length === 1 && op.path[0] === 'hosts') newDoc.hosts = { ...op.value };
      }
      revision += 1;
    },
  });

  await svc.deleteHost('hA', 0);
  assert.deepEqual(Object.keys(newDoc.hosts), ['hB']); // hA 删除, hB 迁入保留
  ctx.dispose?.();
});
