// @dsh-ssh/dsh-ssh — SSH config schema tests.
// The hosts dict is a volatile field of this plugin's own Config: volatility is what
// makes the value appear in the settings form and stay live-editable, so it is part of
// the contract pinned down here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SshConfigSchema, HostConfigSchema, HOSTS_ENTRY_ID, readHosts, resolveHostFromConfig } from '../src/settings.js';

test('the settings entry id stays the kebab-case legacy-compatible dsh-ssh-hosts', () => {
  // dsh-settings migrates a legacy settings.yaml section into the profile entry whose
  // id equals the section name, so this must keep matching the old namespace name.
  assert.equal(String(HOSTS_ENTRY_ID), 'dsh-ssh-hosts');
  assert.ok(!HOSTS_ENTRY_ID.includes('.'));
});

test('Config resolves the hosts dict and defaults to {}', () => {
  const resolved = SshConfigSchema({ hosts: {} });
  assert.deepEqual(readHosts(resolved).hosts, {});
});

test('Config fills per-host defaults (port, timeouts) and keeps explicit values', () => {
  const resolved = SshConfigSchema({
    hosts: { h1: { id: 'h1', name: 'box', host: '203.0.113.10', port: 2222, user: 'u', auth: { type: 'key' } } },
  });
  const h1 = readHosts(resolved).hosts.h1;
  assert.equal(h1.port, 2222);
  assert.equal(h1.connectTimeoutMs, 10_000);
  assert.equal(h1.keepaliveIntervalMs, 15_000);
  assert.deepEqual(h1.auth, { type: 'key' });
  assert.equal(h1.user, 'u');
});

test('password auth member accepts the write-only password field', () => {
  const resolved = SshConfigSchema({
    hosts: { h1: { id: 'h1', host: 'h', user: 'u', auth: { type: 'password', password: 's3cret' } } },
  });
  assert.equal(readHosts(resolved).hosts.h1.auth.password, 's3cret');
});

test('hosts is volatile so a settings edit reaches a mounted plugin', () => {
  const resolved = SshConfigSchema({ hosts: { h1: { id: 'h1', host: 'h', user: 'u' } } });
  // A volatile field resolves to a stable ref; readHosts unwraps it.
  assert.equal(typeof resolved.hosts.get, 'function');
  assert.equal(readHosts(resolved).hosts.h1.host, 'h');
});

test('readHosts unwraps both ref-shaped (volatile) and plain values', () => {
  assert.deepEqual(readHosts({ hosts: { get: () => ({ a: { id: 'a' } }) } }).hosts, { a: { id: 'a' } });
  assert.deepEqual(readHosts({ hosts: { a: { id: 'a' } } }).hosts, { a: { id: 'a' } });
});

test('readHosts tolerates a missing config (no throw, empty dict)', () => {
  assert.deepEqual(readHosts(undefined).hosts, {});
  assert.deepEqual(readHosts({}).hosts, {});
  assert.deepEqual(readHosts({ hosts: null }).hosts, {});
});

test('resolveHostFromConfig returns a host by id, undefined otherwise', () => {
  const cfg = { hosts: { h1: { id: 'h1', host: 'h' } } };
  assert.equal(resolveHostFromConfig(cfg, 'h1').host, 'h');
  assert.equal(resolveHostFromConfig(cfg, 'nope'), undefined);
  assert.equal(resolveHostFromConfig(cfg, ''), undefined);
  assert.equal(resolveHostFromConfig(undefined, 'h1'), undefined);
});

test('HostConfigSchema keeps the password write-only secret role', () => {
  const json = JSON.stringify(HostConfigSchema.toJSON());
  assert.ok(json.includes('secret'), 'auth.password must stay role("secret") for redaction');
});

test('HostConfigSchema is reusable standalone and defaults port/auth', () => {
  const cfg = HostConfigSchema({ id: 'x', host: 'h', user: 'u' });
  assert.equal(cfg.port, 22);
  assert.deepEqual(cfg.auth, { type: 'key' });
});

test('pool sizing is NOT volatile (composition config, not a form field)', () => {
  const resolved = SshConfigSchema({});
  assert.equal(typeof resolved.maxConnections?.get, 'undefined');
  assert.equal(typeof resolved.maxChannelsPerConnection?.get, 'undefined');
});
