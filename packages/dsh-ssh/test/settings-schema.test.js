// @dsh-ssh/dsh-ssh — settings schema shape tests (M2b): hosts is a dict keyed by id,
// so secret-bearing hosts survive a redacted merge (see appendix A.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostsSettingsSchema, HostConfigSchema, HOSTS_NAMESPACE } from '../src/settings.js';

test('namespace is the kebab-case dsh-ssh-hosts', () => {
  assert.equal(String(HOSTS_NAMESPACE), 'dsh-ssh-hosts');
  assert.ok(!HOSTS_NAMESPACE.includes('.'));
});

test('HostsSettingsSchema resolves a dict of hosts and defaults to {}', () => {
  const resolved = HostsSettingsSchema({ hosts: {} });
  assert.deepEqual(resolved.hosts, {});
  const withHost = HostsSettingsSchema({
    hosts: {
      h1: { id: 'h1', name: 'box', host: '1.2.3.4', port: 22, user: 'u', auth: { type: 'key', privateKeyPath: '~/.ssh/id' } },
    },
  });
  assert.equal(withHost.hosts.h1.user, 'u');
  assert.equal(withHost.hosts.h1.auth.type, 'key');
});

test('password auth member accepts the write-only password field', () => {
  const resolved = HostsSettingsSchema({
    hosts: { h1: { id: 'h1', host: 'h', user: 'u', auth: { type: 'password', password: 's3cret' } } },
  });
  assert.equal(resolved.hosts.h1.auth.type, 'password');
  assert.equal(resolved.hosts.h1.auth.password, 's3cret');
});

test('HostConfigSchema is reusable standalone and defaults port/auth', () => {
  const cfg = HostConfigSchema({ id: 'x', host: 'h', user: 'u' });
  assert.equal(cfg.port, 22);
  assert.deepEqual(cfg.auth, { type: 'key' });
});
