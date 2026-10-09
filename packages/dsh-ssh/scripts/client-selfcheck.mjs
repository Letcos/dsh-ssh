
// PREREQ: run from the repo root (reads packages/dsh-ssh/client.js). No remote/network needed.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

const code = readFileSync('packages/dsh-ssh/client.js', 'utf8');

// Locate the @deepseek-ai/dsh-client-ui-primitives entry shipped with the DSH that runs
// this repo. An explicit override wins; otherwise probe the local resolution chain and
// the global npm root.
function resolvePrimitivesEntry() {
  const override = process.env.DSH_SSH_PRIMITIVES_ENTRY;
  if (override) return existsSync(override) ? override : null;
  const require_ = createRequire(import.meta.url);
  const probes = [];
  try {
    probes.push(require_.resolve('@deepseek-ai/dsh/package.json'));
  } catch { /* dsh not resolvable from here */ }
  try {
    // shell:true because npm is a .cmd shim on Windows.
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (globalRoot) probes.push(path.join(globalRoot, '@deepseek-ai', 'dsh', 'package.json'));
  } catch { /* npm unavailable */ }
  for (const pkgPath of probes) {
    const candidate = path.join(path.dirname(pkgPath), 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Names the primitives bundle exports, read from its final `export { ... }` statement.
// The bundle imports react, so it is parsed as text rather than imported.
function readPrimitivesExports() {
  const entry = resolvePrimitivesEntry();
  if (!entry) return null;
  let source;
  try { source = readFileSync(entry, 'utf8'); } catch { return null; }
  const names = new Set();
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names.size > 0 ? names : null;
}

// minimal react + primitives stubs so the factory body parses and runs.
// useState keeps a per-render slot list so a component that toggles disclosure can be
// re-rendered with a changed value (the bash row's expand behaviour is asserted below).
let stateSlots = [];
let stateCursor = 0;
const element = (type, props, ...children) => ({ type, props, children });
const reactStub = {
  createElement: element,
  useState: (initial) => {
    const index = stateCursor++;
    if (!(index in stateSlots)) stateSlots[index] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => { stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next; };
    return [stateSlots[index], set];
  },
  useEffect: () => {},
  useRef: () => ({}),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  memo: (component) => component,
  Fragment: 'Fragment',
};
const required = new Set();
const missing = [];
// The primitives namespace is resolved from the INSTALLED DSH when one is reachable,
// so a renamed or removed primitive (e.g. the size-suffixed icons dropped in
// 0.2.0-rc.2) fails this check instead of silently reaching the browser as undefined.
// With no installed DSH the stub stays permissive: catch drift where it is observable,
// not make the check unusable offline.
const primitivesExports = readPrimitivesExports();
const primitivesStub = new Proxy({}, {
  get: (t, key) => {
    if (typeof key !== 'string') return undefined;
    if (primitivesExports && !primitivesExports.has(key)) {
      missing.push(key);
      return undefined;
    }
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
// Names read off the primitives namespace must exist in the installed DSH: an undefined
// component reaches React.createElement and throws at render time in the browser.
assert.deepEqual(missing, [], 'client.js reads primitives the installed DSH does not export: ' + missing.join(', '));

// ── bash toolview: a completed bash call must be expandable ──────────────────────
// 0.2.0-rc.2 rebuilt the official terminal model: it no longer reads
// block.callView/resultView but parses the call arguments and the single result text.
// A model that still expects the removed projections yields expandable=false, so
// clicking a finished bash row does nothing. Render the registered occupant with a
// real 0.2.0-rc.2 result block and assert it is expandable and toggles open.
{
  const registered = [];
  const localeDicts = new Map();
  // The apply() body touches several services; only slots/locale matter for the row.
  const applyCtx = {
    slots: {
      register: (options, component) => { registered.push({ options, component }); return () => {}; },
      inject: (name, fn) => { try { return fn(); } catch { return undefined; } },
    },
    // $mount is awaited by apply(); a resolved stub keeps apply synchronous enough to
    // capture the slot registrations.
    remote: { $mount: () => Promise.resolve(() => {}), $on: () => () => {} },
    locale: {
      register: (ns, dicts) => { localeDicts.set(ns, dicts); return () => {}; },
      bind: (ns) => (key, vars) => {
        const dict = localeDicts.get(ns) ?? {};
        const table = dict.zh ?? dict.en ?? {};
        let text = table[key] ?? key;
        for (const [k, v] of Object.entries(vars ?? {})) text = text.replace('{' + k + '}', String(v));
        return text;
      },
    },
    effect: () => () => {},
    inject: () => () => {},
    get: () => undefined,
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  assert.doesNotThrow(() => mod.apply(applyCtx), 'apply() must run against a minimal client context');
  const bashEntry = registered.find((r) => r.options?.name === 'tool.call.toolview' && r.options?.key === 'bash');
  assert.ok(bashEntry, 'client.js must register the bash toolview occupant');
  assert.equal(bashEntry.options.priority, -1, 'bash toolview must shadow the stock row (priority -1)');

  // A settled bash call exactly as 0.2.0-rc.2 delivers it: argsRaw carries the command,
  // and content holds the single text block the host rendered (body + exit marker).
  const block = {
    kind: 'result',
    callId: 'call-1',
    call: { name: 'bash', argsRaw: JSON.stringify({ command: 'echo hi', description: 'say hi' }) },
    content: [{ type: 'text', text: 'hi\n\n[exit code: 0]' }],
    isError: false,
  };
  stateSlots = [];
  stateCursor = 0;
  const t = (key, vars) => (vars ? key + ':' + JSON.stringify(vars) : key);
  // A stand-in for the owner's disclosure hook: the expanded flag lives in the test.
  let expandedFlag = false;
  const props = {
    toolName: 'bash', block, sessionId: 's1', phase: 'result',
    useSessions: (selector) => selector({ byId: { s1: { cwd: '/data/work' } } }),
    useDisclosure: () => ({ expanded: expandedFlag, toggle: () => { expandedFlag = !expandedFlag; } }),
    inspect: () => {}, t,
  };
  const render = () => {
    stateCursor = 0;
    const el = bashEntry.component(props);
    // The row root is the first child carrying data-sample="bash".
    const find = (node) => {
      if (!node || typeof node !== 'object') return null;
      if (node.props && node.props['data-sample'] === 'bash') return node;
      for (const child of node.children ?? []) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    return { el, root: find(el) };
  };

  const collapsed = render();
  assert.ok(collapsed.root, 'the bash row must render a root node');
  assert.equal(collapsed.root.props['data-expandable'], true,
    'a settled bash call must be expandable (else clicking it does nothing)');
  assert.equal(collapsed.root.props['data-state'], 'ok', 'a clean exit must render state ok');

  // Toggling must open the terminal body: invoke the row's own click handler, then
  // re-render the way React would.
  assert.equal(typeof collapsed.root.props.onClick, 'function',
    'an expandable bash row must expose a click handler');
  collapsed.root.props.onClick();
  const opened = render();
  assert.equal(opened.root.props['aria-expanded'], true, 'after clicking, the row must report expanded');
  assert.ok(JSON.stringify(opened.el).includes('hi'), 'the expanded row must carry the command output');

  // A background call and an error call are NOT terminal cards (official behaviour).
  const bg = { ...block, call: { name: 'bash', argsRaw: JSON.stringify({ command: 'x', description: 'd', run_in_background: true }) } };
  stateSlots = []; stateCursor = 0;
  const bgRow = bashEntry.component({ ...props, block: bg, useDisclosure: () => ({ expanded: false, toggle: () => {} }) });
  const bgRoot = (function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.props && node.props['data-sample'] === 'bash') return node;
    for (const child of node.children ?? []) { const hit = find(child); if (hit) return hit; }
    return null;
  })(bgRow);
  assert.notEqual(bgRoot.props['data-expandable'], true, 'a background bash call is not an expandable terminal card');
}

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
// Without a resolvable DSH the primitives check above cannot run, so say so loudly
// rather than implying the exports were verified.
if (primitivesExports) {
  console.log('  primitives exports verified against the installed DSH (' + primitivesExports.size + ' exports)');
} else {
  console.log('  WARNING: no installed DSH found, primitives names were NOT verified (set DSH_SSH_PRIMITIVES_ENTRY to check)');
}
