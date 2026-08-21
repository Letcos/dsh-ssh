// @dsh-ssh/dsh-ssh — gateway {ok, value} response unwrapping tests.
// Gateway wraps host results as { ok: true, value } on success or { ok: false, error } on failure.
// Client must unwrap before checking the value. Covers unwrap helper semantics and gateway shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapRemoteResponse, remoteResponseError, isBrowseCapabilityError } from '../lib/typert-contribution.js';

test('unwrapRemoteResponse extracts the gateway-wrapped host value (ok:true)', () => {
  assert.equal(unwrapRemoteResponse({ ok: true, value: '/home/devuser' }), '/home/devuser');
  const list = unwrapRemoteResponse({ ok: true, value: [{ name: 'a', type: 'dir' }] });
  assert.equal(Array.isArray(list) && list[0].name, 'a');
});

test('unwrapRemoteResponse returns null for failures, non-shapes and bare values', () => {
  assert.equal(unwrapRemoteResponse({ ok: false, error: { message: 'boom' } }), null);
  assert.equal(unwrapRemoteResponse(null), null);
  assert.equal(unwrapRemoteResponse(undefined), null);
  // Bare strings must not be treated as success; must be null (unwrap required)
  assert.equal(unwrapRemoteResponse('/home/devuser'), null);
});

test('remoteResponseError prefers the wire error message, falls back otherwise', () => {
  assert.equal(remoteResponseError({ ok: false, error: { message: 'unknown host key' } }, 'fb'), 'unknown host key');
  assert.equal(remoteResponseError({ ok: true, value: '/home/devuser' }, 'fb'), 'fb');
  assert.equal(remoteResponseError(null, 'fb'), 'fb');
  assert.equal(remoteResponseError({ ok: false, error: 'plain-string-error' }, 'fb'), 'fb');
});

// Directory browse capability detection: when host picker only serves "native",
// ctx.workspaces.listDirectory/createDirectory throws DirectoryBrowseError (rpcError with
// directory-picker-unavailable containing "needs the browse capability");
// on match, fallback is ctx.workspaces.pickDirectory() system dialog instead of listDirectory.
test('isBrowseCapabilityError: DirectoryBrowseError shape (rpcError + message)', () => {
  const browseErr = {
    name: 'DirectoryBrowseError',
    message: 'directory browse failed: directory-picker-unavailable: host.listDirectory needs the browse capability; the composed picker serves "native"',
    rpcError: {
      code: 'directory-picker-unavailable',
      message: 'host.listDirectory needs the browse capability; the composed picker serves "native"',
      details: { capability: 'native' },
    },
  };
  assert.equal(isBrowseCapabilityError(browseErr), true);
});

test('isBrowseCapabilityError: mirrors createDirectory (native host) and plain Errors', () => {
  const createErr = {
    rpcError: {
      code: 'directory-picker-unavailable',
      message: 'host.createDirectory needs the browse capability; the composed picker serves "native"',
      details: { capability: 'native' },
    },
  };
  assert.equal(isBrowseCapabilityError(createErr), true);
  assert.equal(isBrowseCapabilityError(new Error('ENOENT: no such file')), false);
  assert.equal(isBrowseCapabilityError({ rpcError: { code: 'directory-exists', message: 'already there' } }), false);
  assert.equal(isBrowseCapabilityError('needs the browse capability (bare string)'), false);
  assert.equal(isBrowseCapabilityError(null), false);
  assert.equal(isBrowseCapabilityError(undefined), false);
});

test('isBrowseCapabilityError: message-only match without rpcError', () => {
  assert.equal(isBrowseCapabilityError({ message: 'host.listDirectory needs the browse capability; the composed picker serves "native"' }), true);
});

// Combined semantics: host returns bare value -> gateway wraps {ok, value} -> client unwraps,
// and startBrowse validation (string starting with '/') holds after unwrapping.
test('host bare value survives gateway wrap/unwrap round-trip (resolveRemoteHome flow)', () => {
  const hostResult = '/home/devuser'; // src/remote.js resolveRemoteHome return value
  const wire = { ok: true, value: hostResult };
  const resolved = unwrapRemoteResponse(wire);
  assert.equal(resolved, hostResult);
  assert.ok(typeof resolved === 'string' && resolved.startsWith('/'));
  // Gateway failure shape: host throws -> { ok:false, error:{message}} -> unwrap null
  const failWire = { ok: false, error: { message: 'resolveRemoteHome failed: exit 127: command not found' } };
  assert.equal(unwrapRemoteResponse(failWire), null);
  assert.match(remoteResponseError(failWire, 'fb'), /exit 127/);
});
