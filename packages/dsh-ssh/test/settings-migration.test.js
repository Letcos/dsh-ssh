// @dsh-ssh/dsh-ssh — settings namespace migration tests (dssh-hosts -> dsh-ssh-hosts).
// Verifies: read fallback (new empty + old data -> read old), write side fully writes to new namespace, existing hosts preserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { HOSTS_NAMESPACE, LEGACY_HOSTS_NAMESPACE, readHostsDoc } from '../src/settings.js';
import { SshRemoteService } from '../src/remote.js';

test('renamed namespaces: new dsh-ssh-hosts / old dssh-hosts (read-only migration source)', () => {
  assert.equal(String(HOSTS_NAMESPACE), 'dsh-ssh-hosts');
  assert.equal(String(LEGACY_HOSTS_NAMESPACE), 'dssh-hosts');
});

test('readHostsDoc: new namespace has hosts -> prefers new, legacy=false', () => {
  const get = (ns) => (ns === 'dsh-ssh-hosts' ? { hosts: { a: { id: 'a' } } } : { hosts: { b: { id: 'b' } } });
  const { hosts, legacy } = readHostsDoc(get);
  assert.equal(legacy, false);
  assert.deepEqual(Object.keys(hosts), ['a']);
});

test('readHostsDoc: new empty + old data -> fallback to old, legacy=true', () => {
  const get = (ns) => (ns === 'dssh-hosts' ? { hosts: { b: { id: 'b' } } } : undefined);
  const { hosts, legacy } = readHostsDoc(get);
  assert.equal(legacy, true);
  assert.deepEqual(Object.keys(hosts), ['b']);
});

test('readHostsDoc: both empty -> empty dict, legacy=false', () => {
  const { hosts, legacy } = readHostsDoc(() => undefined);
  assert.equal(legacy, false);
  assert.deepEqual(hosts, {});
});

test('readHostsDoc: get throws -> fallback to empty dict (no throw)', () => {
  const { hosts, legacy } = readHostsDoc(() => { throw new Error('boom'); });
  assert.equal(legacy, false);
  assert.deepEqual(hosts, {});
});

test('saveHost first edit: all old namespace hosts migrate to new namespace, existing hosts preserved', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, { testConnection: async () => ({ ok: false, error: 'x' }) });
  // New namespace empty; old namespace has two hosts hA/hB.
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

  // Edit hA -> write side fully writes to new namespace, hB migrates together.
  await svc.saveHost('hA', { id: 'hA', name: 'A2', host: 'a', port: 22, user: 'u', auth: { type: 'key' } }, 0);
  assert.deepEqual(Object.keys(newDoc.hosts).sort(), ['hA', 'hB']);
  assert.equal(newDoc.hosts.hA.name, 'A2');
  assert.equal(newDoc.hosts.hB.name, 'B'); // old host preserved
  ctx.dispose?.();
});

test('deleteHost first delete (old namespace has data): remaining old hosts migrate to new namespace', async () => {
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
  assert.deepEqual(Object.keys(newDoc.hosts), ['hB']); // hA deleted, hB migrated and retained
  ctx.dispose?.();
});
