// @dsh-ssh/dsh-ssh — functional unit test of the host Typert remote service.
// Requires the peer deps installed by pnpm install (cordis + typert-protocol
// live under packages/dsh-ssh/node_modules). Verifies the service registers a
// visible typertRemote binding and that testConnection merges stored secrets
// before delegating to the pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { bindTypertRemote, remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { SshRemoteService } from '../src/remote.js';
import { SshError, HOST_KEY_UNKNOWN_STAGE, sshKeyFingerprint, sshKeyTypeFromBlob, knownHostsLine } from '../src/ssh-core.js';
import { encodeRemotePath } from '../src/router.js';
import { HOST_TYPERT_CONTRIBUTION } from '../lib/typert-contribution.js';

test('SshRemoteService registers a typertRemote binding for namespace ssh', () => {
  const ctx = new Context();
  const calls = [];
  const pool = { testConnection: async (cfg) => { calls.push(cfg); return { ok: true, banner: 'echo ok' }; } };
  const svc = new SshRemoteService(ctx, pool);
  // ctx.get returns a traced proxy; the gateway unwraps via symbols.original
  // and then requires binding.service === original — check that relation here.
  const proxy = ctx.get('ssh');
  assert.equal(typeof proxy.testConnection, 'function');
  assert.equal(svc.typertRemote.service, svc);
  assert.equal(svc.typertRemote.serviceKey, 'ssh');
  assert.equal(svc.typertRemote.namespace, 'ssh');
  ctx.dispose?.();
});

test('remoteMethods on the plain-JS service is empty (no decorators) — strict contribution carries the endpoint', () => {
  // Uses the strict-registry route (ctx.typert.register) over SRC decorators,
  // so the endpoint identity comes from HOST_TYPERT_CONTRIBUTION, not decorator markers.
  const ctx = new Context();
  const pool = { testConnection: async () => ({ ok: false, error: 'x' }) };
  const svc = new SshRemoteService(ctx, pool);
  assert.equal(remoteMethods(svc).length, 0);
  assert.equal(HOST_TYPERT_CONTRIBUTION.invocations[0].namespace + '/' + HOST_TYPERT_CONTRIBUTION.invocations[0].method, 'ssh/testConnection');
  assert.equal(HOST_TYPERT_CONTRIBUTION.invocations[0].service, 'ssh');
  ctx.dispose?.();
});

test('testConnection merges stored password into the pool call when the form left it blank', async () => {
  const ctx = new Context();
  const calls = [];
  const pool = { testConnection: async (cfg) => { calls.push(cfg); return { ok: true, banner: 'ok' }; } };
  const svc = new SshRemoteService(ctx, pool);
  svc.setStoredResolver((id) => (id === 'h1' ? {
    id: 'h1', host: 'h', port: 22, user: 'u',
    auth: { type: 'password', password: 'stored-secret' },
    knownHostsPath: '/tmp/kh',
  } : undefined));
  const result = await svc.testConnection({ cfg: { id: 'h1', host: 'h', port: 22, user: 'u', auth: { type: 'password' } } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth.password, 'stored-secret');
  assert.equal(calls[0].knownHostsPath, '/tmp/kh');
  ctx.dispose?.();
});

test('testConnection passes a typed client password through (client wins)', async () => {
  const ctx = new Context();
  const calls = [];
  const pool = { testConnection: async (cfg) => { calls.push(cfg); return { ok: false, error: 'boom' }; } };
  const svc = new SshRemoteService(ctx, pool);
  const result = await svc.testConnection({ cfg: { id: 'h1', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'typed' } } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'boom');
  assert.equal(calls[0].auth.password, 'typed');
  ctx.dispose?.();
});

test('testConnection tolerates malformed requests (empty cfg -> key default, no throw)', async () => {
  const ctx = new Context();
  const calls = [];
  const pool = { testConnection: async (cfg) => { calls.push(cfg); return { ok: false, error: 'no host' }; } };
  const svc = new SshRemoteService(ctx, pool);
  const result = await svc.testConnection(null);
  assert.equal(result.ok, false);
  assert.equal(calls[0].auth.type, 'key');
  ctx.dispose?.();
});

test('bindTypertRemote is the exact binding shape the gateway validates', () => {
  // dsh-api-gateway readBinding requires service === original, serviceKey, namespace strings.
  const holder = { key: 'x' };
  const binding = bindTypertRemote(holder, 'ssh');
  assert.equal(binding.service, holder);
  assert.equal(binding.serviceKey, 'ssh');
  assert.equal(binding.namespace, 'ssh');
});

// ---------- CRUD over the Typert channel (settings wire not exposed) ----------

/** Minimal settings provider double: get/describe/writable/mutate with revision semantics. */
function makeSettings(initialHosts, legacyHosts) {
  let doc = { hosts: { ...(initialHosts ?? {}) } };
  const legacyDoc = { hosts: { ...(legacyHosts ?? {}) } };
  let revision = 0;
  return {
    get: (ns) => (ns === 'dsh-ssh-hosts' ? doc : ns === 'dssh-hosts' ? legacyDoc : undefined),
    describe: () => [{ ns: 'dsh-ssh-hosts', revision }],
    writable: true,
    lastWrite: null,
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'dsh-ssh-hosts');
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        const err = new Error(`settings namespace "dsh-ssh-hosts" changed since it was read (expected revision ${expectedRevision}, now ${revision})`);
        err.name = 'SettingsConflictError';
        err.code = 'SETTINGS_CONFLICT';
        throw err;
      }
      this.lastWrite = { ops, expectedRevision };
      for (const op of ops) {
        if (op.op === 'set') {
          if (op.path.length === 1 && op.path[0] === 'hosts') doc.hosts = { ...op.value };
          else doc.hosts[op.path[1]] = op.value;
        } else if (op.op === 'unset') {
          delete doc.hosts[op.path[1]];
        }
      }
      revision += 1;
    },
  };
}

function makeService(pool, settings) {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, pool ?? { testConnection: async () => ({ ok: false, error: 'x' }) });
  svc.setSettingsApi(settings);
  return { ctx, svc };
}

test('listHosts returns the REDACTED dict with revision + secrets + writable', () => {
  const settings = makeSettings({
    h1: { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 's3cret' }, knownHostsPath: '/tmp/kh' },
    h2: { id: 'h2', name: 'keybox', host: 'k', port: 22, user: 'u', auth: { type: 'key', privateKeyPath: '~/.ssh/id' } },
  });
  const { ctx, svc } = makeService({}, settings);
  const result = svc.listHosts();
  assert.deepEqual(result.hosts.h1.auth, { type: 'password' }); // password stripped
  assert.equal(result.hosts.h1.knownHostsPath, '/tmp/kh');       // non-secret fields survive
  assert.deepEqual(result.hosts.h2.auth, { type: 'key', privateKeyPath: '~/.ssh/id' });
  assert.equal(result.revision, 0);
  assert.deepEqual(result.secrets, [{ path: ['hosts', 'h1', 'auth', 'password'], set: true }]);
  assert.equal(result.writable, true);
  assert.equal(settings.get('dsh-ssh-hosts').hosts.h1.auth.password, 's3cret'); // store untouched
  ctx.dispose?.();
});

test('listHosts tolerates a missing settings service (empty state)', () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, { testConnection: async () => ({ ok: false, error: 'x' }) });
  const result = svc.listHosts();
  assert.deepEqual(result.hosts, {});
  assert.deepEqual(result.secrets, []);
  assert.equal(result.revision, 0);
  assert.equal(result.writable, true);
  ctx.dispose?.();
});

test('saveHost creates a new host (set op, id authoritative, no stored secret)', async () => {
  const settings = makeSettings({});
  const { ctx, svc } = makeService({}, settings);
  const result = await svc.saveHost('h-new', { id: 'spoofed', name: 'n', host: 'h', port: 22, user: 'u', auth: { type: 'key' } }, 0);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(settings.lastWrite.ops, [{ op: 'set', path: ['hosts'], value: { 'h-new': settings.get('dsh-ssh-hosts').hosts['h-new'] } }]);
  assert.equal(settings.lastWrite.expectedRevision, 0);
  assert.equal(settings.get('dsh-ssh-hosts').hosts['h-new'].id, 'h-new'); // id forced, patch.id ignored
  assert.equal(settings.get('dsh-ssh-hosts').hosts['h-new'].name, 'n');
  ctx.dispose?.();
});

test('saveHost edit keeps the stored password when the patch omits it', async () => {
  const settings = makeSettings({
    h1: { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'stored' } },
  });
  const { ctx, svc } = makeService({}, settings);
  await svc.saveHost('h1', { id: 'h1', name: 'box2', host: 'h', port: 22, user: 'u', auth: { type: 'password' } }, 0);
  const saved = settings.get('dsh-ssh-hosts').hosts.h1;
  assert.equal(saved.name, 'box2');
  assert.deepEqual(saved.auth, { type: 'password', password: 'stored' });
  ctx.dispose?.();
});

test('saveHost overwrites the password when the patch carries one', async () => {
  const settings = makeSettings({
    h1: { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'old' } },
  });
  const { ctx, svc } = makeService({}, settings);
  await svc.saveHost('h1', { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'new' } }, 0);
  assert.deepEqual(settings.get('dsh-ssh-hosts').hosts.h1.auth, { type: 'password', password: 'new' });
  ctx.dispose?.();
});

test('saveHost switching to key auth clears the stored password', async () => {
  const settings = makeSettings({
    h1: { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'stored' } },
  });
  const { ctx, svc } = makeService({}, settings);
  await svc.saveHost('h1', { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'key', privateKeyPath: '~/.ssh/id' } }, 0);
  assert.deepEqual(settings.get('dsh-ssh-hosts').hosts.h1.auth, { type: 'key', privateKeyPath: '~/.ssh/id' });
  assert.equal('password' in settings.get('dsh-ssh-hosts').hosts.h1.auth, false);
  ctx.dispose?.();
});

test('saveHost rejects an invalid host config host-side (remote values not trusted)', async () => {
  const settings = makeSettings({});
  const { ctx, svc } = makeService({}, settings);
  await assert.rejects(() => svc.saveHost('h1', { name: '', host: 'h', user: 'u', auth: { type: 'key' } }, 0), /主机配置无效/);
  assert.equal(settings.lastWrite, null); // nothing persisted
  ctx.dispose?.();
});

test('saveHost rejects a stale revision with a SETTINGS_CONFLICT retry hint', async () => {
  const settings = makeSettings({ h1: { id: 'h1', name: 'a', host: 'h', user: 'u', auth: { type: 'key' } } });
  const { ctx, svc } = makeService({}, settings);
  await svc.saveHost('h1', { id: 'h1', name: 'a', host: 'h', user: 'u', auth: { type: 'key' } }, 0); // bumps to rev 1
  await assert.rejects(
    () => svc.saveHost('h1', { id: 'h1', name: 'b', host: 'h', user: 'u', auth: { type: 'key' } }, 0),
    /SETTINGS_CONFLICT.*请刷新后重试/,
  );
  ctx.dispose?.();
});

test('deleteHost removes the entry via an unset op and is idempotent for missing ids', async () => {
  const settings = makeSettings({ h1: { id: 'h1', name: 'a', host: 'h', user: 'u', auth: { type: 'key' } } });
  const { ctx, svc } = makeService({}, settings);
  const missing = await svc.deleteHost('nope', 0);
  assert.deepEqual(missing, { ok: true });
  assert.equal(settings.lastWrite, null); // no write for a missing id

  await svc.deleteHost('h1', 0);
  assert.deepEqual(settings.lastWrite.ops, [{ op: 'set', path: ['hosts'], value: {} }]);
  assert.equal('h1' in settings.get('dsh-ssh-hosts').hosts, false);
  ctx.dispose?.();
});

test('deleteHost rejects a stale revision with a SETTINGS_CONFLICT retry hint', async () => {
  const settings = makeSettings({ h1: { id: 'h1', name: 'a', host: 'h', user: 'u', auth: { type: 'key' } } });
  const { ctx, svc } = makeService({}, settings);
  await svc.saveHost('h1', { id: 'h1', name: 'a', host: 'h', user: 'u', auth: { type: 'key' } }, 0); // rev 1
  await assert.rejects(() => svc.deleteHost('h1', 0), /SETTINGS_CONFLICT/);
  ctx.dispose?.();
});

test('saveHost throws a clear error when no settings service is wired', async () => {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, { testConnection: async () => ({ ok: false, error: 'x' }) });
  await assert.rejects(() => svc.saveHost('h1', { name: 'a', host: 'h', user: 'u', auth: { type: 'key' } }), /settings service unavailable/);
  ctx.dispose?.();
});

// ---------- Remote directory browse + placeholder creation ----------

const M4_HOST = { id: 'h1', host: 'h', port: 22, user: 'u', auth: { type: 'key' } };

/** Fake connection pool: acquire captures received (STORED) config, returns fixed conn. */
function makeBrowsePool(conn, onAcquire) {
  return {
    acquire: async (cfg) => { if (onAcquire) onAcquire(cfg); return conn; },
    testConnection: async () => ({ ok: false, error: 'x' }),
  };
}

/** Service with settings + stored resolver (connection endpoints use resolveStored, placeholder uses settingsApi). */
function makeBrowseService(pool, settings, stored) {
  const ctx = new Context();
  const svc = new SshRemoteService(ctx, pool ?? { testConnection: async () => ({ ok: false, error: 'x' }) });
  svc.setSettingsApi(settings);
  svc.setStoredResolver((id) => (stored && stored[id]) || undefined);
  return { ctx, svc };
}

test('listRemoteDir lists via SFTP and sorts directories first, then by name', async () => {
  const listDir = async () => [
    { name: 'zeta.txt', type: 'file', size: 3, mtime: 1 },
    { name: 'alpha', type: 'dir', size: 0, mtime: 1 },
    { name: 'beta.txt', type: 'file', size: 5, mtime: 2 },
    { name: 'Gamma', type: 'dir', size: 0, mtime: 3 },
  ];
  const conn = { sftp: async () => ({ listDir }), fs: async () => ({ listDir }), exec: async () => ({ code: 0, stdout: '', stderr: '' }) };
  let acquired = null;
  const { ctx, svc } = makeBrowseService(makeBrowsePool(conn, (cfg) => { acquired = cfg; }), makeSettings({ h1: M4_HOST }), { h1: M4_HOST });
  const result = await svc.listRemoteDir('h1', '/data');
  assert.deepEqual(result.map((e) => e.name), ['Gamma', 'alpha', 'beta.txt', 'zeta.txt']);
  assert.equal(result[0].type, 'dir');
  assert.deepEqual(acquired, { ...M4_HOST, id: 'h1' }); // acquire uses STORED config
  ctx.dispose?.();
});

test('listRemoteDir rejects a missing remote path and an unconfigured host (SshError)', async () => {
  const { ctx, svc } = makeBrowseService(makeBrowsePool(null), makeSettings({}), {});
  await assert.rejects(() => svc.listRemoteDir('h1', ''), (err) => err instanceof SshError && err.stage === 'sftp-readdir' && /path is required/.test(err.message));
  await assert.rejects(() => svc.listRemoteDir('nope', '/x'), (err) => err instanceof SshError && err.stage === 'resolve-host' && /not configured/.test(err.message));
  ctx.dispose?.();
});

test('statRemote reads raw SFTP stat with mtime; ENOENT maps to null', async () => {
  const statRaw = (p, cb) => cb(null, { size: 42, mtime: 1234, isDirectory: () => true, isFile: () => false });
  const conn = { sftp: async () => ({ listDir: async () => [] }), fs: async () => ({ stat: async () => ({ type: 'directory', size: 42, mtime: 1234 }) }), exec: async () => ({ code: 0, stdout: '', stderr: '' }) };
  const { ctx, svc } = makeBrowseService(makeBrowsePool(conn), makeSettings({ h1: M4_HOST }), { h1: M4_HOST });
  assert.deepEqual(await svc.statRemote('h1', '/data'), { type: 'directory', size: 42, mtime: 1234 });
  // ENOENT (ssh2 code 2) -> null
  const missingConn = { sftp: async () => ({ listDir: async () => [] }), fs: async () => ({ stat: async () => undefined }), exec: async () => ({ code: 0, stdout: '', stderr: '' }) };
  const svc2 = makeBrowseService(makeBrowsePool(missingConn), makeSettings({ h1: M4_HOST }), { h1: M4_HOST }).svc;
  assert.equal(await svc2.statRemote('h1', '/nope'), null);
  ctx.dispose?.();
});

test('resolveRemoteHome execs echo $HOME and returns the absolute home', async () => {
  const exec = async () => ({ code: 0, stdout: '/home/devuser\n', stderr: '' });
  const conn = { sftp: async () => ({ listDir: async () => [] }), exec };
  const { ctx, svc } = makeBrowseService(makeBrowsePool(conn), makeSettings({ h1: M4_HOST }), { h1: M4_HOST });
  assert.equal(await svc.resolveRemoteHome('h1'), '/home/devuser');
  // exec failure -> SshError(stage exec)
  const badExec = async () => ({ code: 127, stdout: '', stderr: 'command not found' });
  const svc2 = makeBrowseService(makeBrowsePool({ sftp: async () => ({ listDir: async () => [] }), exec: badExec }), makeSettings({ h1: M4_HOST }), { h1: M4_HOST }).svc;
  await assert.rejects(() => svc2.resolveRemoteHome('h1'), (err) => err instanceof SshError && err.stage === 'exec' && /exit 127/.test(err.message));
  ctx.dispose?.();
});

test('createPlaceholder validates the host in dsh-ssh-hosts and creates a real dir under env root', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeSettings({ h1: M4_HOST }), {});
    svc.env = { DSH_HOME: tmp };
    const result = await svc.createPlaceholder('h1', '/data/work');
    assert.equal(result.hostId, 'h1');
    assert.equal(result.remotePath, '/data/work');
    assert.ok(result.localPath.startsWith(tmp + pathMod.sep + 'remote' + pathMod.sep));
    assert.equal(result.localPath, pathMod.join(tmp, 'remote', 'h1', encodeRemotePath('/data/work')));
    assert.equal(fsMod.statSync(result.localPath).isDirectory(), true);
    // Real directory, not symlink (macOS /var -> /private canonical comparison)
    assert.equal(
      fsMod.realpathSync(result.localPath),
      pathMod.join(fsMod.realpathSync(tmp), 'remote', 'h1', encodeRemotePath('/data/work')),
    );
    // Idempotent
    assert.deepEqual(await svc.createPlaceholder('h1', '/data/work'), result);
    // Unconfigured host / relative path -> SshError
    await assert.rejects(() => svc.createPlaceholder('nope', '/x'), (err) => err instanceof SshError && err.stage === 'placeholder' && /not configured/.test(err.message));
    await assert.rejects(() => svc.createPlaceholder('h1', 'rel'), (err) => err instanceof SshError && err.stage === 'placeholder' && /must be absolute/.test(err.message));
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder explicit registry: workspace title = host display name / basename (fallback to hostId when name missing)', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const creates = [];
    const registry = {
      create: async (path, title) => {
        creates.push({ path, title });
        return { title, setTitle: async () => {} };
      },
    };
    const { ctx, svc } = makeBrowseService(null, makeSettings({ h1: M4_HOST }), {});
    svc.env = { DSH_HOME: tmp };
    svc.setWorkspaceRegistry(() => registry);
    const result = await svc.createPlaceholder('h1', '/home/devuser/workspace');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].path, result.localPath);
    // M4_HOST has no name -> display falls back to hostId 'h1': title = h1 / workspace
    assert.equal(creates[0].title, 'h1 / workspace');
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder auto-fixes legacy base64 title to host name / basename, preserves user-edited title', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeSettings({ h1: M4_HOST }), {});
    svc.env = { DSH_HOME: tmp };
    // Legacy bug: title equals encoded segment -> auto-rename to basename
    const renames = [];
    svc.setWorkspaceRegistry(() => ({
      create: async (path, title) => ({
        title: encodeRemotePath('/data/work'),
        setTitle: async (t) => { renames.push(t); },
      }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    // M4_HOST has no name -> display falls back to 'h1': encoded segment upgrades to h1 / work
    assert.deepEqual(renames, ['h1 / work']);
    // User-edited title (non-encoded) -> untouched
    const renames2 = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({
        title: 'my server',
        setTitle: async (t) => { renames2.push(t); },
      }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames2, []);
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder title uses host name when present, no fallback to hostId', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const creates = [];
    const registry = { create: async (path, title) => { creates.push({ path, title }); return { title, setTitle: async () => {} }; } };
    const { ctx, svc } = makeBrowseService(null, makeSettings({ h1: { ...M4_HOST, name: 'devuser' } }), {});
    svc.env = { DSH_HOME: tmp };
    svc.setWorkspaceRegistry(() => registry);
    await svc.createPlaceholder('h1', '/home/devuser/workspace');
    assert.equal(creates[0].title, 'devuser / workspace');
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder migrates legacy plain basename to host name / basename; idempotent', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeSettings({ h1: { ...M4_HOST, name: 'devuser' } }), {});
    svc.env = { DSH_HOME: tmp };
    // Legacy: title equals plain basename (no host identifier) -> upgrade to host format
    const renames = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({ title: 'work', setTitle: async (t) => { renames.push(t); } }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames, ['devuser / work']);
    // Idempotent: already new format -> no setTitle
    const renames2 = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({ title: 'devuser / work', setTitle: async (t) => { renames2.push(t); } }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames2, []);
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder preserves user custom title containing host identifier, does not overwrite', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeSettings({ h1: { ...M4_HOST, name: 'devuser' } }), {});
    svc.env = { DSH_HOME: tmp };
    // User manually named title with host identifier (different from current format) -> untouched
    const renames = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({ title: 'work · my-note', setTitle: async (t) => { renames.push(t); } }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames, []);
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder migrates legacy `basename · host` format to `host / basename`', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeSettings({ h1: { ...M4_HOST, name: 'devuser' } }), {});
    svc.env = { DSH_HOME: tmp };
    // Legacy auto title `work · devuser` (hostName=devuser) -> upgrade to new format
    const renames = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({ title: 'work · devuser', setTitle: async (t) => { renames.push(t); } }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames, ['devuser / work']);
    // Already new format -> idempotent no-op
    const renames2 = [];
    svc.setWorkspaceRegistry(() => ({
      create: async () => ({ title: 'devuser / work', setTitle: async (t) => { renames2.push(t); } }),
    }));
    await svc.createPlaceholder('h1', '/data/work');
    assert.deepEqual(renames2, []);
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createPlaceholder registry failure -> SshError(stage placeholder), no silent fallback', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'dsh-m4-svc-'));
  try {
    const { ctx, svc } = makeBrowseService(null, makeSettings({ h1: M4_HOST }), {});
    svc.env = { DSH_HOME: tmp };
    svc.setWorkspaceRegistry(() => ({
      create: async () => { throw new Error('registry boom'); },
    }));
    await assert.rejects(
      () => svc.createPlaceholder('h1', '/data'),
      (err) => err instanceof SshError && err.stage === 'placeholder' && /registry boom/.test(err.message),
    );
    ctx.dispose?.();
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

// TOFU: host-side trust persistence + structured host-key-unknown browse results
test('trustHostKey appends the confirmed key to a temp known_hosts, idempotently, fingerprint-validated', async () => {
  const ctx = new Context();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-trust-'));
  const kh = path.join(dir, 'known_hosts');
  try {
    const svc = new SshRemoteService(ctx, null);
    svc.setStoredResolver((id) => (id === 'h1' ? {
      id: 'h1', host: 'tofu.example', port: 2222, user: 'u', auth: { type: 'key' }, knownHostsPath: kh,
    } : undefined));
    // Build a raw host key blob with algorithm prefix (matches ssh2 hostVerifier shape)
    const algo = 'ssh-ed25519';
    const pre = Buffer.alloc(4); pre.writeUInt32BE(algo.length, 0);
    const blob = Buffer.concat([pre, Buffer.from(algo), Buffer.from('pubkey-bytes-here')]);
    const b64 = blob.toString('base64');
    const fp = sshKeyFingerprint(blob);
    const keyType = sshKeyTypeFromBlob(blob);
    const first = await svc.trustHostKey('h1', b64, fp);
    assert.equal(first.ok, true);
    assert.equal(first.appended, true);
    assert.equal(first.keyType, 'ssh-ed25519');
    assert.ok(readFileSync(kh, 'utf8').includes(knownHostsLine('tofu.example', 2222, keyType, b64)));
    // Idempotent
    const second = await svc.trustHostKey('h1', b64, fp);
    assert.equal(second.appended, false);
    // Fingerprint mismatch -> reject write
    await assert.rejects(() => svc.trustHostKey('h1', b64, 'SHA256:WRONG'), /does not match/);
    // Host not configured -> reject
    await assert.rejects(() => svc.trustHostKey('nope', b64, fp), /not configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    ctx.dispose?.();
  }
});

test('resolveRemoteHome surfaces a host-key-unknown as a structured VALUE (not a throw) for TOFU', async () => {
  const ctx = new Context();
  const unknownErr = new SshError({
    hostId: 'h1', stage: HOST_KEY_UNKNOWN_STAGE, message: 'unknown host key',
    host: 'tofu.example', port: 2222, fingerprint: 'SHA256:abc', rawKeyBase64: 'Zm9v', keyType: 'ssh-ed25519',
  });
  const pool = { acquire: async () => { throw unknownErr; } };
  const svc = new SshRemoteService(ctx, pool);
  svc.setStoredResolver((id) => (id === 'h1' ? { id: 'h1', host: 'tofu.example', port: 2222, user: 'u', auth: { type: 'key' } } : undefined));
  const res = await svc.resolveRemoteHome('h1');
  assert.equal(res.stage, HOST_KEY_UNKNOWN_STAGE);
  assert.equal(res.ok, false);
  assert.equal(res.host, 'tofu.example');
  assert.equal(res.port, 2222);
  assert.equal(res.fingerprint, 'SHA256:abc');
  assert.equal(res.rawKeyBase64, 'Zm9v');
  assert.equal(res.keyType, 'ssh-ed25519');
  ctx.dispose?.();
});
