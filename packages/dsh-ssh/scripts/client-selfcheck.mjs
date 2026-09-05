
// PREREQ: run from the repo root (reads packages/dsh-ssh/client.js). No remote/network needed.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const code = readFileSync('packages/dsh-ssh/client.js', 'utf8');

// minimal react + primitives stubs so the factory body parses and runs
const element = (type, props, ...children) => ({ type, props, children });
const reactStub = {
  createElement: element,
  useState: () => [{}, () => {}],
  useEffect: () => {},
  useRef: () => ({}),
  Fragment: 'Fragment',
};
const required = new Set();
const primitivesStub = new Proxy({}, {
  get: (t, key) => {
    if (typeof key !== 'string') return undefined;
    return (props) => element(key, props);
  },
});
const requireStub = (id) => {
  required.add(id);
  if (id === 'react') return reactStub;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
  throw new Error('client.js required an unexpected module: ' + id);
};

globalThis.window = {};
let loaded = null;
window.__ModuleLoader__ = { load: (opts) => { loaded = opts; } };

// eval the file as a classic script (it only touches window.__ModuleLoader__)
(0, eval)(code);

assert.ok(loaded, 'window.__ModuleLoader__.load was not called');
assert.equal(loaded.id, '@dsh-ssh/dsh-ssh');
const mod = loaded.factory(requireStub);
assert.equal(typeof mod.apply, 'function', 'factory must export apply');
assert.deepEqual([...mod.inject], ['slots', 'locale', 'remote', 'remote.directoryPicker']);
assert.deepEqual([...required], ['react', '@deepseek-ai/dsh-client-ui-primitives']);

// The inline Typert client descriptors must mirror lib/typert-contribution.js
// (method + wire parameter list), or saveHost/deleteHost arg counts drift and
// the gateway rejects the call. Rebuild the expected lines from the lib copy
// and assert the client.js source contains them verbatim.
const lib = await import('../lib/typert-contribution.js');
const sq = (value) => "'" + String(value).replaceAll("'", "\\'") + "'";
for (const d of lib.CLIENT_TYPERT_REMOTE.descriptors) {
  const params = d.parameters.map((p) => p.name);
  const resultType = d.result.typeSymbol.split('#')[1];
  const line = 'remoteDescriptor(' + sq(d.method) + ', [' + params.map(sq).join(', ') + '], ' + sq(resultType) + ')';
  assert.ok(code.includes(line), 'client.js must inline descriptor line: ' + line);
}

// The combined picker must be registered into BOTH holes at
// priority -1 (single slots are unique per priority; lowest renders — the
// stock browse picker occupies default priority 0), using the nested
// slots.inject generator pattern (mirrors dsh-client-ui-directory-picker-browse).
for (const hole of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) {
  assert.ok(code.includes(hole), 'client.js must reference directoryFlow hole: ' + hole);
}
const priorityUses = code.match(/priority:\s*-1/g) ?? [];
assert.equal(priorityUses.length, 3, 'directoryFlow x2 + bash tool.call.toolview must carry priority: -1 (shadow the stock registrations)');
assert.ok(code.includes('function DirectoryFlowCombined'), 'client.js must define the DirectoryFlowCombined occupant');
assert.ok(code.includes('function LocalFlowBody'), 'client.js must define the local-tab browser body');
assert.ok(code.includes('function RemoteFlowBody'), 'client.js must define the remote-tab flow body');
assert.ok(code.includes("pickerCall('list')"), 'client.js must route listDirectory via ctx.remote.directoryPicker.list');
assert.ok(code.includes("pickerCall('createDirectory')"), 'client.js must route createDirectory via ctx.remote.directoryPicker.createDirectory');
assert.ok(code.includes('ctx.slots.inject("conversation.hero.workspace.directoryFlow"'), 'nested slots.inject pattern expected for hero hole');
assert.ok(code.includes('ctx.slots.inject("sidebar.workspaces.directoryFlow"'), 'nested slots.inject pattern expected for sidebar hole');
assert.ok(code.includes('ctx.locale.register("workspace.ssh"'), 'workspace.ssh locale must be registered');

console.log('client.js static self-check OK');
console.log('  id =', loaded.id);
console.log('  inject =', JSON.stringify(mod.inject));
console.log('  requires =', JSON.stringify([...required]));
