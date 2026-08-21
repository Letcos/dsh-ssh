// @dsh-ssh/dsh-ssh — Typert contribution shape tests.
// Verify the host contribution and client descriptors are structurally
// registrable: mirror the typert-registry validateInvocation rules and the
// client-side strict-codec requirement (dsh-api-gateway/lib/client.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_TYPERT_CONTRIBUTION, CLIENT_TYPERT_REMOTE,
  assertContributionShape, allClientCodecsStrict,
  TEST_CONNECTION_ENDPOINT, LIST_HOSTS_ENDPOINT, SAVE_HOST_ENDPOINT, DELETE_HOST_ENDPOINT,
  LIST_REMOTE_DIR_ENDPOINT, STAT_REMOTE_ENDPOINT, RESOLVE_REMOTE_HOME_ENDPOINT, CREATE_PLACEHOLDER_ENDPOINT,
  TRUST_HOST_KEY_ENDPOINT,
  REMOTE_PACKAGE, REMOTE_SERVICE, REMOTE_NAMESPACE,
} from '../lib/typert-contribution.js';

test('host contribution passes the shape checker', () => {
  assert.equal(assertContributionShape(HOST_TYPERT_CONTRIBUTION), true);
});

test('client remote passes the shape checker and is fully strict', () => {
  assert.equal(assertContributionShape(CLIENT_TYPERT_REMOTE), true);
  assert.equal(allClientCodecsStrict(CLIENT_TYPERT_REMOTE.descriptors), true);
});

test('endpoint identity is stable and shared', () => {
  assert.equal(TEST_CONNECTION_ENDPOINT, 'ssh/testConnection');
  assert.equal(LIST_HOSTS_ENDPOINT, 'ssh/listHosts');
  assert.equal(SAVE_HOST_ENDPOINT, 'ssh/saveHost');
  assert.equal(DELETE_HOST_ENDPOINT, 'ssh/deleteHost');
  assert.equal(LIST_REMOTE_DIR_ENDPOINT, 'ssh/listRemoteDir');
  assert.equal(STAT_REMOTE_ENDPOINT, 'ssh/statRemote');
  assert.equal(RESOLVE_REMOTE_HOME_ENDPOINT, 'ssh/resolveRemoteHome');
  assert.equal(CREATE_PLACEHOLDER_ENDPOINT, 'ssh/createPlaceholder');
  assert.equal(TRUST_HOST_KEY_ENDPOINT, 'ssh/trustHostKey');
  assert.equal(HOST_TYPERT_CONTRIBUTION.invocations.length, 9);
  assert.equal(CLIENT_TYPERT_REMOTE.descriptors.length, 9);
  for (let i = 0; i < 9; i++) {
    const host = HOST_TYPERT_CONTRIBUTION.invocations[i];
    const client = CLIENT_TYPERT_REMOTE.descriptors[i];
    assert.equal(host.namespace + '/' + host.method, client.namespace + '/' + client.method);
    assert.equal(host.service, REMOTE_SERVICE);
    assert.equal(client.service, REMOTE_SERVICE);
    assert.equal(host.namespace, REMOTE_NAMESPACE);
    assert.equal(host.id, REMOTE_PACKAGE + '#' + host.namespace + '/' + host.method);
    assert.equal(client.id, host.id);
  }
  assert.equal(REMOTE_PACKAGE, '@dsh-ssh/dsh-ssh');
});

test('CRUD wire args: listHosts has none; saveHost/deleteHost carry id (+patch) and revision', () => {
  const host = (endpoint) => HOST_TYPERT_CONTRIBUTION.invocations.find((d) => d.namespace + '/' + d.method === endpoint);
  const client = (endpoint) => CLIENT_TYPERT_REMOTE.descriptors.find((d) => d.namespace + '/' + d.method === endpoint);
  const assertWires = (endpoint, wires) => {
    for (const side of [host(endpoint), client(endpoint)]) {
      assert.deepEqual(side.parameters.map((p) => p.wire), wires);
      assert.ok(side.parameters.every((p) => p.source === 'json'));
    }
  };
  assertWires(TEST_CONNECTION_ENDPOINT, ['cfg']);
  assertWires(LIST_HOSTS_ENDPOINT, []);
  assertWires(SAVE_HOST_ENDPOINT, ['id', 'patch', 'revision']);
  assertWires(DELETE_HOST_ENDPOINT, ['id', 'revision']);
  // Browse endpoints are positional (hostId first, path/remotePath second)
  assertWires(LIST_REMOTE_DIR_ENDPOINT, ['hostId', 'path']);
  assertWires(STAT_REMOTE_ENDPOINT, ['hostId', 'path']);
  assertWires(RESOLVE_REMOTE_HOME_ENDPOINT, ['hostId']);
  assertWires(CREATE_PLACEHOLDER_ENDPOINT, ['hostId', 'remotePath']);
  // trustHostKey positions hostId, rawKeyBase64, fingerprint (raw key the user confirmed).
  assertWires(TRUST_HOST_KEY_ENDPOINT, ['hostId', 'rawKeyBase64', 'fingerprint']);
});

test('host descriptors use src-json codecs (no bundle validation)', () => {
  const d = HOST_TYPERT_CONTRIBUTION.invocations[0];
  assert.equal(d.parameters[0].codec.mode, 'src-json');
  assert.equal(d.result.mode, 'src-json');
});

test('wire args align: cfg with source json on both sides', () => {
  const host = HOST_TYPERT_CONTRIBUTION.invocations[0];
  const client = CLIENT_TYPERT_REMOTE.descriptors[0];
  assert.equal(host.parameters.length, 1);
  assert.equal(client.parameters.length, 1);
  assert.equal(host.parameters[0].wire, 'cfg');
  assert.equal(client.parameters[0].wire, 'cfg');
  assert.equal(host.parameters[0].source, 'json');
  assert.equal(client.parameters[0].source, 'json');
  assert.equal(host.invocation.kind, 'direct');
  assert.equal(client.invocation.kind, 'direct');
});

test('shape checker rejects bad contributions (guards regression)', () => {
  const dup = {
    package: 'x', face: 'host', schemas: [], model: undefined,
    invocations: [
      { id: 'x#n/m', service: 's', namespace: 'n', method: 'm', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' } },
      { id: 'x#n/m2', service: 's', namespace: 'n', method: 'm', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' } },
    ],
  };
  assert.throws(() => assertContributionShape(dup), /repeats/);

  const nonStrictClient = {
    package: 'x', descriptors: [
      { id: 'x#n/m', service: 's', namespace: 'n', method: 'm', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' } },
    ],
  };
  assert.throws(() => assertContributionShape(nonStrictClient), /must be strict/);

  const badWire = {
    package: 'x', face: 'host', schemas: [], model: undefined,
    invocations: [
      { id: 'x#n/m', service: 's', namespace: 'n', method: 'm', invocation: { kind: 'direct' }, parameters: [{ name: 'a', wire: '..', source: 'json', codec: { mode: 'src-json' } }], result: { mode: 'src-json' } },
    ],
  };
  assert.throws(() => assertContributionShape(badWire), /wire field/);
});
