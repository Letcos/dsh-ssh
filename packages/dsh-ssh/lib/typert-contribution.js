// @dsh-ssh/dsh-ssh — Typert remote contribution for the SSH host editor.
// The official settings wire (api.settings.*) is NOT exposed to configuration
// clients for plugin namespaces (hard whitelist in dsh-host-apiproxy/lib/
// index.js:888 WEB_SETTINGS_NAMESPACES), so ALL host-editor RPC —
// testConnection AND the CRUD listHosts/saveHost/deleteHost — rides this
// self-built Typert remote:
//   host:   SshRemoteService (ctx.ssh) + ctx.typert.register(HOST_TYPERT_CONTRIBUTION)
//   client: ctx.remote.$mount(CLIENT_TYPERT_REMOTE) then ctx.remote.ssh.*
// The host gateway (dsh-api-gateway/lib/index.js) resolves strict descriptors
// from ctx.typert.local, validates the receiver's typertRemote binding, and
// invokes ctx.get(service).<method>(...).
//
// Codec asymmetry is intentional and documented:
//   - Host side uses { mode: 'src-json' } codecs (no validation in the bundle;
//     ssh-core + hosts-model.validateHostConfig + the settings schema do the
//     real validation).
//   - Client side MUST use { mode: 'strict' } codecs (dsh-api-gateway client
//     rejects src-json at $mount). The strict schema is a JSON passthrough
//     (parse = identity): values are already validated host-side and the wire
//     gateway re-asserts JSON-safety. This keeps client.js free of a zod
//     dependency while satisfying the strict-codec contract.
// This module is pure data + a shape checker (no imports) so it is testable
// under node --test. client.js inlines the same descriptor objects.

export const REMOTE_PACKAGE = '@dsh-ssh/dsh-ssh';
export const REMOTE_SERVICE = 'ssh';
export const REMOTE_NAMESPACE = 'ssh';
export const TEST_CONNECTION_METHOD = 'testConnection';
export const TEST_CONNECTION_ENDPOINT = REMOTE_NAMESPACE + '/' + TEST_CONNECTION_METHOD;
export const LIST_HOSTS_METHOD = 'listHosts';
export const LIST_HOSTS_ENDPOINT = REMOTE_NAMESPACE + '/' + LIST_HOSTS_METHOD;
export const SAVE_HOST_METHOD = 'saveHost';
export const SAVE_HOST_ENDPOINT = REMOTE_NAMESPACE + '/' + SAVE_HOST_METHOD;
export const DELETE_HOST_METHOD = 'deleteHost';
export const DELETE_HOST_ENDPOINT = REMOTE_NAMESPACE + '/' + DELETE_HOST_METHOD;
// Remote directory browsing + placeholder creation (remote workspace flow).
export const LIST_REMOTE_DIR_METHOD = 'listRemoteDir';
export const LIST_REMOTE_DIR_ENDPOINT = REMOTE_NAMESPACE + '/' + LIST_REMOTE_DIR_METHOD;
export const STAT_REMOTE_METHOD = 'statRemote';
export const STAT_REMOTE_ENDPOINT = REMOTE_NAMESPACE + '/' + STAT_REMOTE_METHOD;
export const RESOLVE_REMOTE_HOME_METHOD = 'resolveRemoteHome';
export const RESOLVE_REMOTE_HOME_ENDPOINT = REMOTE_NAMESPACE + '/' + RESOLVE_REMOTE_HOME_METHOD;
export const CREATE_PLACEHOLDER_METHOD = 'createPlaceholder';
export const CREATE_PLACEHOLDER_ENDPOINT = REMOTE_NAMESPACE + '/' + CREATE_PLACEHOLDER_METHOD;
// TOFU trust-save: append the user-confirmed host public key to known_hosts.
export const TRUST_HOST_KEY_METHOD = 'trustHostKey';
export const TRUST_HOST_KEY_ENDPOINT = REMOTE_NAMESPACE + '/' + TRUST_HOST_KEY_METHOD;

const SRC_JSON = { mode: 'src-json' };

/** Identity JSON schema satisfying the strict-codec contract. */
function passthroughSchema(typeSymbol) {
  return {
    mode: 'strict',
    typeSymbol,
    schema: { parse: (value) => value },
  };
}

/** One remote method descriptor, parameterized by codec style. */
function descriptor(client, method, parameters, resultType) {
  return {
    id: REMOTE_PACKAGE + '#' + REMOTE_NAMESPACE + '/' + method,
    service: REMOTE_SERVICE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map((name) => ({
      name,
      wire: name,
      source: 'json',
      codec: client ? passthroughSchema('@dsh-ssh/dsh-ssh#' + name) : SRC_JSON,
    })),
    result: client ? passthroughSchema('@dsh-ssh/dsh-ssh#' + resultType) : SRC_JSON,
  };
}

function testConnectionDescriptor(client) {
  return descriptor(client, TEST_CONNECTION_METHOD, ['cfg'], 'TestConnectionResult');
}

function listHostsDescriptor(client) {
  return descriptor(client, LIST_HOSTS_METHOD, [], 'ListHostsResult');
}

// revision is an optional (src-json host side) optimistic-concurrency guard:
// the client echoes the listHosts revision and the host passes it to
// settings.mutate as expectedRevision; a stale one rejects with
// SETTINGS_CONFLICT and the client prompts a refresh.
function saveHostDescriptor(client) {
  return descriptor(client, SAVE_HOST_METHOD, ['id', 'patch', 'revision'], 'SaveHostResult');
}

function deleteHostDescriptor(client) {
  return descriptor(client, DELETE_HOST_METHOD, ['id', 'revision'], 'DeleteHostResult');
}

// Browse endpoints: positional wire args (Typert dispatch order); all returned
// values are JSON-safe (entries are {name,type,size?,mtime?}).
function listRemoteDirDescriptor(client) {
  return descriptor(client, LIST_REMOTE_DIR_METHOD, ['hostId', 'path'], 'ListRemoteDirResult');
}

function statRemoteDescriptor(client) {
  return descriptor(client, STAT_REMOTE_METHOD, ['hostId', 'path'], 'StatRemoteResult');
}

function resolveRemoteHomeDescriptor(client) {
  return descriptor(client, RESOLVE_REMOTE_HOME_METHOD, ['hostId'], 'ResolveRemoteHomeResult');
}

function createPlaceholderDescriptor(client) {
  return descriptor(client, CREATE_PLACEHOLDER_METHOD, ['hostId', 'remotePath'], 'CreatePlaceholderResult');
}

// trustHostKey(hostId, rawKeyBase64, fingerprint): rawKeyBase64 is the base64 of the
// key the user confirmed in the dialog; fingerprint is the SHA256 fingerprint shown
// there (validated by the host before writing).
function trustHostKeyDescriptor(client) {
  return descriptor(client, TRUST_HOST_KEY_METHOD, ['hostId', 'rawKeyBase64', 'fingerprint'], 'TrustHostKeyResult');
}

/** Host-side contribution: ctx.typert.register(this) makes the gateway claim the /api/ssh/* endpoints. */
export const HOST_TYPERT_CONTRIBUTION = Object.freeze({
  package: REMOTE_PACKAGE,
  face: 'host',
  schemas: [],
  invocations: Object.freeze([
    Object.freeze(testConnectionDescriptor(false)),
    Object.freeze(listHostsDescriptor(false)),
    Object.freeze(saveHostDescriptor(false)),
    Object.freeze(deleteHostDescriptor(false)),
    Object.freeze(listRemoteDirDescriptor(false)),
    Object.freeze(statRemoteDescriptor(false)),
    Object.freeze(resolveRemoteHomeDescriptor(false)),
    Object.freeze(createPlaceholderDescriptor(false)),
    Object.freeze(trustHostKeyDescriptor(false)),
  ]),
  model: undefined,
});

/** Client-side contribution: ctx.remote.$mount(this) installs ctx.remote.ssh.* methods. */
export const CLIENT_TYPERT_REMOTE = Object.freeze({
  package: REMOTE_PACKAGE,
  descriptors: Object.freeze([
    Object.freeze(testConnectionDescriptor(true)),
    Object.freeze(listHostsDescriptor(true)),
    Object.freeze(saveHostDescriptor(true)),
    Object.freeze(deleteHostDescriptor(true)),
    Object.freeze(listRemoteDirDescriptor(true)),
    Object.freeze(statRemoteDescriptor(true)),
    Object.freeze(resolveRemoteHomeDescriptor(true)),
    Object.freeze(createPlaceholderDescriptor(true)),
    Object.freeze(trustHostKeyDescriptor(true)),
  ]),
});

/**
 * Structural checker mirroring dsh-typert-registry/lib/index.js validateInvocation
 * + the client-side strict-codec rule (dsh-api-gateway/lib/client.js
 * requireStrictCodec). Throws on the first violation; used by unit tests and
 * by src/remote.js before registering.
 */
export function assertContributionShape(contribution) {
  if (!contribution || typeof contribution !== 'object') throw new Error('typert contribution must be an object');
  const isHost = contribution.face === 'host' || Array.isArray(contribution.invocations);
  const list = isHost ? contribution.invocations : contribution.descriptors;
  if (!Array.isArray(list) || list.length === 0) throw new Error('typert contribution needs invocations/descriptors');
  const segment = (subject, value) => {
    if (typeof value !== 'string' || value.length === 0 || value.includes('#')) {
      throw new Error('typert: invalid ' + subject + ' ' + JSON.stringify(value));
    }
  };
  // validateInvocation (dsh-typert-registry/lib/index.js:510) requires only a
  // NONEMPTY id — generated ids are '<package>#<ns>/<method>' and legally carry '#'.
  const nonempty = (subject, value) => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('typert: invalid ' + subject + ' ' + JSON.stringify(value));
    }
  };
  const wireName = (subject, value) => {
    if (typeof value !== 'string' || value === '.' || value === '..' || !/^[A-Za-z0-9_$.-]+$/.test(value)) {
      throw new Error('typert: invalid ' + subject + ' ' + JSON.stringify(value));
    }
  };
  const codec = (codec, subject, requireStrict) => {
    if (!codec || typeof codec !== 'object') throw new Error('typert: ' + subject + ' has no codec');
    if (codec.mode === 'src-json') {
      if (requireStrict) throw new Error('typert: ' + subject + ' client codec must be strict');
      return;
    }
    if (codec.mode !== 'strict') throw new Error('typert: ' + subject + ' has unknown codec mode');
    if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) throw new Error('typert: ' + subject + ' strict codec needs typeSymbol');
    if (!codec.schema || typeof codec.schema.parse !== 'function') throw new Error('typert: ' + subject + ' strict codec has no parse()');
  };
  const endpoints = new Set();
  const ids = new Set();
  for (const d of list) {
    nonempty('invocation id', d.id);
    segment('invocation service key', d.service);
    wireName('invocation namespace', d.namespace);
    wireName('invocation method', d.method);
    const endpoint = d.namespace + '/' + d.method;
    if (endpoints.has(endpoint)) throw new Error('typert: endpoint "' + endpoint + '" repeats');
    if (ids.has(d.id)) throw new Error('typert: invocation id "' + d.id + '" repeats');
    endpoints.add(endpoint);
    ids.add(d.id);
    if (d.invocation && d.invocation.kind !== 'direct' && d.invocation.kind !== 'context') {
      throw new Error('typert: invocation "' + d.id + '" has invalid invocation kind');
    }
    codec(d.result, d.id + ' result', isHost ? false : true);
    const wires = new Set();
    if (Array.isArray(d.parameters)) {
      for (const p of d.parameters) {
        wireName('parameter name', p.name);
        wireName('parameter wire field', p.wire);
        if (wires.has(p.wire)) throw new Error('typert: invocation "' + d.id + '" repeats wire field "' + p.wire + '"');
        wires.add(p.wire);
        if (p.source === 'lookup') {
          if (!p.lookup) throw new Error('typert: invocation "' + d.id + '" lookup parameter has no lookup key');
          segment('lookup key', p.lookup);
        } else if (p.lookup !== undefined) {
          throw new Error('typert: invocation "' + d.id + '" JSON parameter declares a lookup key');
        }
        codec(p.codec, d.id + ' parameter ' + p.name, isHost ? false : true);
      }
    }
    if (d.cancellation !== undefined && (!d.cancellation || d.cancellation.parameter !== 'signal')) {
      throw new Error('typert: invocation "' + d.id + '" cancellation must be "signal"');
    }
  }
  return true;
}

/** True when a client descriptor carries strict codecs everywhere (used by tests). */
export function allClientCodecsStrict(descriptors) {
  return descriptors.every((d) => {
    const ok = (c) => c && c.mode === 'strict' && typeof c.schema?.parse === 'function';
    return ok(d.result) && d.parameters.every((p) => ok(p.codec)) && (d.invocation.kind !== 'context' || ok(d.invocation.codec));
  });
}

/**
 * Unwrap a gateway response: dsh-api-gateway wraps every host method return value as
 *   { ok: true, value } (success) / { ok: false, error } (business failure)
 * (lib/index.js:123-131 invokeRpc; lib/client.js:258-265 client invoke). Every
 * ctx.remote.ssh.* promise on the client resolves to this shape — a bare value (e.g.
 * resolveRemoteHome's string) never reaches the UI directly and must go through this
 * helper. Returns value on ok; null on failure/non-shape (the error is not lost; it
 * flows through remoteResponseError). Kept in sync with the inline copy in client.js.
 */
export function unwrapRemoteResponse(response) {
  return response && typeof response === 'object' && response.ok === true ? response.value : null;
}

/** Extract a displayable error message from a gateway failure response; fallback when none exists. */
export function remoteResponseError(response, fallback) {
  const err = response && typeof response === 'object' ? response : null;
  const msg = err && err.error && typeof err.error === 'object' && typeof err.error.message === 'string'
    ? err.error.message
    : '';
  return msg || fallback;
}

/**
 * Detect a missing directory-browsing capability. When the host-side composed
 * directory picker serves only the "native" capability, host.listDirectory /
 * host.createDirectory return
 *   { code: "directory-picker-unavailable",
 *     message: 'host.listDirectory needs the browse capability; the composed picker serves "native"',
 *     details: { capability: "native" } }
 * (dsh-host-apiproxy/lib/index.js:3174-3204); the client-side
 * ctx.workspaces.listDirectory/createDirectory wrap them as DirectoryBrowseError
 * (err.rpcError carries that business code, err.message is prefixed
 * "directory browse failed:"). Matches the business code or the host message
 * "needs the browse capability" — the trigger for the native-dialog fallback.
 * Kept in sync with the inline copy in client.js.
 */
export function isBrowseCapabilityError(err) {
  if (!err || typeof err !== 'object') return false;
  const rpc = err.rpcError && typeof err.rpcError === 'object' ? err.rpcError : null;
  if (rpc && rpc.code === 'directory-picker-unavailable') return true;
  const rpcMsg = rpc && typeof rpc.message === 'string' ? rpc.message : '';
  const errMsg = typeof err.message === 'string' ? err.message : '';
  return rpcMsg.indexOf('needs the browse capability') !== -1
    || errMsg.indexOf('needs the browse capability') !== -1;
}

