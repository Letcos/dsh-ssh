// @dsh-ssh/dsh-ssh — config persistence and legacy-migration tests.
// Hosts persist as this plugin's own profile-patch config (entry id dsh-ssh-hosts), and
// dsh-settings migrates a legacy settings.yaml section into the entry with that id. These
// tests cover the entry id that makes that migration land, and the write path that
// persists a full host dict without dropping hosts another form section left untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { HOSTS_ENTRY_ID } from '../src/settings.js';
import { SshRemoteService } from '../src/remote.js';

/** Config + configEditor double mirroring the real ref-read / editor-write split. */
function makeConfigDouble(initialHosts) {
  const state = { config: { hosts: { ...(initialHosts ?? {}) } } };
  state.editor = {
    lastWrite: null,
    async edit(entry, change) {
      const next = change({ ...state.config, hosts: { ...state.config.hosts } }, {});
      this.lastWrite = next.hosts;
      state.config.hosts = { ...next.hosts };
    },
  };
  state.entry = { options: { id: HOSTS_ENTRY_ID } };
  return state;
}

function makeService(double) {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, { testConnection: async () => ({ ok: false, error: 'x' }) }, double.config);
  svc.setConfigWriter({ entry: double.entry, editor: double.editor });
  return { ctx, svc };
}

test('the migration entry id matches the legacy settings.yaml section name', () => {
  // dsh-settings resolves a legacy section through LEGACY_SECTION_ENTRIES[section] ?? section,
  // and only imports when a live entry with that id exists. Renaming it silently drops
  // every previously-configured host, so the id is a compatibility contract.
  assert.equal(String(HOSTS_ENTRY_ID), 'dsh-ssh-hosts');
});

test('saveHost writes the whole host dict so a peer host is never dropped', async () => {
  const double = makeConfigDouble({
    hA: { id: 'hA', name: 'A', host: 'a', port: 22, user: 'u', auth: { type: 'key' } },
    hB: { id: 'hB', name: 'B', host: 'b', port: 22, user: 'u', auth: { type: 'key' } },
  });
  const { ctx, svc } = makeService(double);
  await svc.saveHost('hA', { id: 'hA', name: 'A2', host: 'a', port: 22, user: 'u', auth: { type: 'key' } }, 0);
  assert.deepEqual(Object.keys(double.editor.lastWrite).sort(), ['hA', 'hB']);
  assert.equal(double.editor.lastWrite.hA.name, 'A2');
  assert.equal(double.editor.lastWrite.hB.name, 'B'); // untouched host preserved
  ctx.dispose?.();
});

test('saveHost edit preserves every other host in a multi-host config', async () => {
  const double = makeConfigDouble({ h1: { id: 'h1', name: 'one', host: 'a', user: 'u' } });
  const { ctx, svc } = makeService(double);
  await svc.saveHost('h2', { id: 'h2', name: 'two', host: 'b', user: 'u', auth: { type: 'key' } }, 0);
  assert.deepEqual(Object.keys(double.editor.lastWrite).sort(), ['h1', 'h2']);
  ctx.dispose?.();
});

test('deleteHost leaves the remaining hosts in place', async () => {
  const double = makeConfigDouble({
    hA: { id: 'hA', name: 'A', host: 'a', port: 22, user: 'u', auth: { type: 'key' } },
    hB: { id: 'hB', name: 'B', host: 'b', port: 22, user: 'u', auth: { type: 'key' } },
  });
  const { ctx, svc } = makeService(double);
  await svc.deleteHost('hA', 0);
  assert.deepEqual(Object.keys(double.editor.lastWrite), ['hB']);
  ctx.dispose?.();
});

test('a save with no configuration editor reports writable=false and refuses to persist', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, {}, { hosts: {} });
  assert.equal(svc.listHosts().writable, false);
  await assert.rejects(
    () => svc.saveHost('h1', { id: 'h1', name: 'a', host: 'h', user: 'u', auth: { type: 'key' } }, 0),
    /没有配置编辑器/,
  );
  ctx.dispose?.();
});

test('an unchanged save is a no-op rather than a redundant profile write', async () => {
  const existing = { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'key' } };
  const double = makeConfigDouble({ h1: { ...existing } });
  const { ctx, svc } = makeService(double);
  const result = await svc.saveHost('h1', { ...existing }, 0);
  assert.deepEqual(result, { ok: true, persisted: false }); // live value unchanged, no write
  assert.equal(double.editor.lastWrite, null);
  ctx.dispose?.();
});
