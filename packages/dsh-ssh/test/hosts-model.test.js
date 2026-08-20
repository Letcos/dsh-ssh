// @dsh-ssh/dsh-ssh — pure-model unit tests (M2b). Run: node --test 'packages/@dsh-ssh/dsh-ssh/test/*.test.js'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePort, validateHostForm, displayHostTitle, displayAuthType,
  buildHostConfig, newHostId, secretPathFor, isHostSecretSet, sortedHosts,
  mergeHostPatch, validateHostConfig, formatHostErrors, redactHosts, hostsSecretsList,
  mergeTestConfig, messageOf,
} from '../lib/hosts-model.js';

test('normalizePort: valid, empty, and out-of-range', () => {
  assert.equal(normalizePort('22'), 22);
  assert.equal(normalizePort(2222), 2222);
  assert.equal(normalizePort(''), null);
  assert.equal(normalizePort(null), null);
  assert.equal(normalizePort(undefined), null);
  assert.equal(normalizePort('0'), null);
  assert.equal(normalizePort('65536'), null);
  assert.equal(normalizePort('22.5'), null);
  assert.equal(normalizePort('abc'), null);
});

test('validateHostForm: required fields and whitespace rule', () => {
  const empty = validateHostForm({});
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.name);
  assert.ok(empty.errors.host);
  assert.ok(empty.errors.user);

  const ok = validateHostForm({ name: ' box ', host: '192.168.1.1', port: '22', user: 'root' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, 'box');
  assert.equal(ok.value.port, 22);
  assert.equal(ok.value.authType, 'key');

  const spaced = validateHostForm({ name: 'x', host: 'a b', port: '', user: 'u' });
  assert.equal(spaced.ok, false);
  assert.equal(spaced.errors.host, 'noSpaces');

  const badPort = validateHostForm({ name: 'x', host: 'h', port: '70000', user: 'u' });
  assert.equal(badPort.ok, false);
  assert.equal(badPort.errors.port, 'range');
});

test('buildHostConfig: password only included when typed; key path optional', () => {
  const pw = buildHostConfig({ name: 'a', host: 'h', port: '22', user: 'u', authType: 'password', newPassword: 's3cret' }, null, 's3cret');
  assert.deepEqual(pw.auth, { type: 'password', password: 's3cret' });
  assert.equal(pw.port, 22);

  const pwBlank = buildHostConfig({ name: 'a', host: 'h', port: '', user: 'u', authType: 'password', newPassword: '  ' }, null, '  ');
  assert.deepEqual(pwBlank.auth, { type: 'password' });

  const key = buildHostConfig({ name: 'a', host: 'h', port: '2222', user: 'u', authType: 'key', privateKeyPath: ' ~/.ssh/id_ed25519 ' }, 'host-1', '');
  assert.equal(key.id, 'host-1');
  assert.equal(key.port, 2222);
  assert.deepEqual(key.auth, { type: 'key', privateKeyPath: '~/.ssh/id_ed25519' });

  const keyAgent = buildHostConfig({ name: 'a', host: 'h', port: '', user: 'u', authType: 'key', privateKeyPath: '' }, null, '');
  assert.deepEqual(keyAgent.auth, { type: 'key' });
});

test('newHostId: unique and string', () => {
  const a = newHostId();
  const b = newHostId();
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

test('secretPathFor / isHostSecretSet', () => {
  assert.deepEqual(secretPathFor('h1'), ['hosts', 'h1', 'auth', 'password']);
  const secrets = [
    { path: ['hosts', 'h1', 'auth', 'password'], set: true },
    { path: ['hosts', 'h2', 'auth', 'password'], set: false },
  ];
  assert.equal(isHostSecretSet(secrets, 'h1'), true);
  assert.equal(isHostSecretSet(secrets, 'h2'), false);
  assert.equal(isHostSecretSet(undefined, 'h1'), false);
  assert.equal(isHostSecretSet(secrets, 'h3'), false);
});

test('sortedHosts: sorts by title, preserves id', () => {
  const hosts = { b: { id: 'b', name: 'Beta', host: '1.1.1.1' }, a: { id: 'a', name: 'alpha', host: '2.2.2.2' } };
  const list = sortedHosts(hosts);
  assert.deepEqual(list.map((h) => h.id), ['a', 'b']);
  assert.equal(sortedHosts(null).length, 0);
});

test('mergeHostPatch: new host — patch applied, id forced, no stored secret', () => {
  const next = mergeHostPatch(undefined, { id: 'spoof', name: 'n', host: 'h', port: 22, user: 'u', auth: { type: 'key' } }, 'real-id');
  assert.equal(next.id, 'real-id');
  assert.equal(next.name, 'n');
  assert.deepEqual(next.auth, { type: 'key' });
});

test('mergeHostPatch: blank password keeps the stored one (write-only semantics)', () => {
  const stored = { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'stored' } };
  const next = mergeHostPatch(stored, { id: 'h1', name: 'box2', host: 'h', port: 22, user: 'u', auth: { type: 'password' } }, 'h1');
  assert.equal(next.name, 'box2');
  assert.deepEqual(next.auth, { type: 'password', password: 'stored' });
});

test('mergeHostPatch: typed password overwrites the stored one', () => {
  const stored = { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'old' } };
  const next = mergeHostPatch(stored, { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'new' } }, 'h1');
  assert.deepEqual(next.auth, { type: 'password', password: 'new' });
});

test('mergeHostPatch: switch to key clears the stored password', () => {
  const stored = { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'stored' } };
  const next = mergeHostPatch(stored, { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'key', privateKeyPath: '~/.ssh/id' } }, 'h1');
  assert.deepEqual(next.auth, { type: 'key', privateKeyPath: '~/.ssh/id' });
  assert.equal(Object.prototype.hasOwnProperty.call(next.auth, 'password'), false);
});

test('mergeHostPatch: partial patch keeps untouched fields from the stored entry', () => {
  const stored = {
    id: 'h1', name: 'box', host: 'h', port: 2222, user: 'u',
    auth: { type: 'key', privateKeyPath: '~/.ssh/id' }, knownHostsPath: '/tmp/kh', connectTimeoutMs: 5000,
  };
  const next = mergeHostPatch(stored, { name: 'renamed' }, 'h1');
  assert.equal(next.name, 'renamed');
  assert.equal(next.port, 2222);
  assert.equal(next.user, 'u');
  assert.deepEqual(next.auth, { type: 'key', privateKeyPath: '~/.ssh/id' });
  assert.equal(next.knownHostsPath, '/tmp/kh');
  assert.equal(next.connectTimeoutMs, 5000);
});

test('validateHostConfig: full valid host passes; missing/blank fields fail', () => {
  const ok = validateHostConfig({ id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'key' } });
  assert.equal(ok.ok, true);
  assert.equal(validateHostConfig({ name: '', host: 'h', port: 22, user: 'u', auth: { type: 'key' } }).ok, false);
  const spaced = validateHostConfig({ id: 'h1', name: 'box', host: 'a b', port: 22, user: 'u', auth: { type: 'key' } });
  assert.equal(spaced.ok, false);
  assert.equal(spaced.errors.host, 'noSpaces');
  const badAuth = validateHostConfig({ id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'token' } });
  assert.equal(badAuth.ok, false);
  assert.equal(badAuth.errors.auth, 'type');
  assert.equal(validateHostConfig({ id: 'h1', name: 'box', host: 'h', port: 'abc', user: 'u', auth: { type: 'key' } }).ok, false);
  assert.equal(validateHostConfig(null).ok, false);
});

test('formatHostErrors joins field=message pairs', () => {
  assert.equal(formatHostErrors({ name: 'required', host: 'noSpaces' }), 'name=required, host=noSpaces');
  assert.equal(formatHostErrors(undefined), 'invalid');
});

test('redactHosts strips every auth.password without touching the store', () => {
  const store = {
    h1: { id: 'h1', name: 'box', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 's3cret' } },
    h2: { id: 'h2', name: 'keybox', host: 'k', port: 22, user: 'u', auth: { type: 'key', privateKeyPath: '~/.ssh/id' } },
  };
  const redacted = redactHosts(store);
  assert.deepEqual(redacted.h1.auth, { type: 'password' });
  assert.deepEqual(redacted.h2.auth, { type: 'key', privateKeyPath: '~/.ssh/id' });
  assert.equal(store.h1.auth.password, 's3cret'); // store untouched
  assert.deepEqual(redactHosts(null), {});
});

test('hostsSecretsList reports only hosts that actually store a password', () => {
  const hosts = {
    h1: { id: 'h1', auth: { type: 'password', password: 'x' } },
    h2: { id: 'h2', auth: { type: 'password' } },      // no stored password
    h3: { id: 'h3', auth: { type: 'key' } },
  };
  assert.deepEqual(hostsSecretsList(hosts), [{ path: ['hosts', 'h1', 'auth', 'password'], set: true }]);
  assert.deepEqual(hostsSecretsList({}), []);
});

test('mergeTestConfig: fills password from stored when form left it blank', () => {
  const cfg = { id: 'h1', host: 'h', port: 22, user: 'u', auth: { type: 'password' } };
  const stored = { id: 'h1', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'secret' }, knownHostsPath: '/tmp/kh' };
  const merged = mergeTestConfig(cfg, stored);
  assert.equal(merged.auth.password, 'secret');
  assert.equal(merged.knownHostsPath, '/tmp/kh');
});

test('mergeTestConfig: client password wins; key path filled from stored', () => {
  const cfg = { id: 'h1', host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'typed' } };
  const stored = { id: 'h1', auth: { type: 'password', password: 'stored' } };
  assert.equal(mergeTestConfig(cfg, stored).auth.password, 'typed');

  const cfg2 = { id: 'h2', host: 'h', port: 22, user: 'u', auth: { type: 'key' } };
  const stored2 = { id: 'h2', auth: { type: 'key', privateKeyPath: '/k' } };
  assert.equal(mergeTestConfig(cfg2, stored2).auth.privateKeyPath, '/k');
});

test('mergeTestConfig: defaults when no stored host', () => {
  const merged = mergeTestConfig({ host: 'h', user: 'u' }, undefined);
  assert.equal(merged.port, 22);
  assert.deepEqual(merged.auth, { type: 'key' });
});

test('display helpers and messageOf', () => {
  assert.equal(displayHostTitle({ id: 'x', host: '1.2.3.4' }), '1.2.3.4 (x)');
  assert.equal(displayHostTitle({ id: 'x', name: 'Box' }), 'Box');
  assert.equal(displayAuthType({ auth: { type: 'password' } }), 'password');
  assert.equal(displayAuthType({ auth: { type: 'key' } }), 'key');
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf({ message: 'm' }), 'm');
  assert.equal(messageOf('raw'), 'raw');
});
