// @dsh-ssh/dsh-ssh — unit tests for agent/created hook and scope shadowing (node --test, no network/IO).
// Verifies: registerRoutedTools registers only requested names and rejects unknown names;
//       selectShadowNames returns only names already visible in the agent view (pure strategy, no shell exception);
//       installToolRoutingHook: local cwd registers nothing / remote cwd shadows visible names and bash is always registered
//           (remote shell follows remote platform: bash is always registered with the routed implementation for remote sessions, no existence filter) / errors are swallowed (veto protection).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { registerRoutedTools, ROUTED_TOOL_NAMES } from '../tools.js';
import { selectShadowNames, installToolRoutingHook } from '../index.js';
import { mapRemoteToLocal } from '../src/router.js';

const HOST_ID = '00000000-0000-4000-8000-000000000000';
const REMOTE_PATH = '/home/devuser/workspace';
process.env.DSH_SSH_REMOTE_ROOT = path.join(os.homedir(), 'dsh-test-remote-root');

function makeAgentCtx(visibleNames) {
  const registered = new Map();
  const scopeArgs = [];
  const ctx = {
    tools: {
      get(name, scope) {
        scopeArgs.push(scope);
        return visibleNames.has(name) ? { name, marker: 'official' } : undefined;
      },
      register(def) { registered.set(def.name, def); return () => registered.delete(def.name); },
    },
    get() { return undefined; },
  };
  return { ctx, registered, scopeArgs };
}

function makeAgent(cwd, visibleNames) {
  const { ctx, registered, scopeArgs } = makeAgentCtx(visibleNames);
  const agent = { session: { header: { cwd } }, ctx };
  return { agent, registered, scopeArgs };
}

// With sandbox capability facts (shell/fs.sandboxMode present) the host sandbox backend is mounted;
// without remoteRouting the routed tools would advertise escalation fields. This helper proves that the hook
// (forced remoteRouting=true) indeed hides them; otherwise the assertion would miss the regression.
function makeSandboxAgentCtx(visibleNames) {
  const registered = new Map();
  const scopeArgs = [];
  const fs = { sandboxMode: 'danger-full-access' };
  const shell = { sandboxMode: 'danger-full-access' };
  const ctx = {
    tools: {
      get(name, scope) {
        scopeArgs.push(scope);
        return visibleNames.has(name) ? { name, marker: 'official' } : undefined;
      },
      register(def) { registered.set(def.name, def); return () => registered.delete(def.name); },
    },
    fs, shell,
    get(key) {
      if (key === 'shell') return shell;
      if (key === 'fs') return fs;
      return undefined;
    },
  };
  return { ctx, registered, scopeArgs };
}
function makeSandboxAgent(cwd, visibleNames) {
  const { ctx, registered, scopeArgs } = makeSandboxAgentCtx(visibleNames);
  const agent = { session: { header: { cwd } }, ctx };
  return { agent, registered, scopeArgs };
}

// ── registerRoutedTools ──────────────────────────────────────────────────
test('registerRoutedTools registers exactly the named tools and returns names', () => {
  const { ctx, registered } = makeAgentCtx(new Set(ROUTED_TOOL_NAMES));
  const out = registerRoutedTools(ctx, ['bash', 'read']);
  assert.deepEqual(out.names, ['bash', 'read']);
  assert.deepEqual([...registered.keys()].sort(), ['bash', 'read']);
  // Each definition carries the official-shaped execute / output.render / output.schema
  const bash = registered.get('bash');
  assert.equal(bash.name, 'bash');
  assert.equal(typeof bash.execute, 'function');
  assert.equal(typeof bash.output.render, 'function');
  assert.ok(bash.output.schema);
});

test('registerRoutedTools rejects unknown tool names', () => {
  const { ctx } = makeAgentCtx(new Set(ROUTED_TOOL_NAMES));
  assert.throws(() => registerRoutedTools(ctx, ['bash', 'nope']), /unknown routed tool name "nope"/);
});

test('apply-registered set still covers all seven (via ROUTED_TOOL_NAMES)', () => {
  assert.deepEqual([...ROUTED_TOOL_NAMES].sort(), ['bash', 'edit', 'glob', 'grep', 'read', 'read_image', 'write']);
});

// ── selectShadowNames ───────────────────────────────────────────────────────
test('selectShadowNames returns only names already visible in the agent view', () => {
  const visible = new Set(['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep']);
  const { agent } = makeAgent('/tmp/local', visible);
  assert.deepEqual(selectShadowNames(agent), ROUTED_TOOL_NAMES);
});

test('selectShadowNames skips names absent from the agent view (minimal/code preset)', () => {
  const visible = new Set(['bash']); // only bash exposed (simulating minimal preset)
  const { agent } = makeAgent('/tmp/local', visible);
  assert.deepEqual(selectShadowNames(agent), ['bash']);
});

test('selectShadowNames passes the agent object itself as the scope key', () => {
  const { agent, scopeArgs } = makeAgent('/tmp/local', new Set(['bash']));
  selectShadowNames(agent);
  // scope key is the agent object itself (dsh-agent-loop createScope(loopCtx, this))
  assert.ok(scopeArgs.every((s) => s === agent));
});

test('selectShadowNames tolerates a get that throws (returns empty, never throws)', () => {
  const agent = {
    ctx: { tools: { get() { throw new Error('boom'); } } },
  };
  assert.deepEqual(selectShadowNames(agent, ['bash']), []);
});

test('selectShadowNames does not force bash (shell forcing lives in the hook)', () => {
  // View without bash (simulating Windows host standard preset) → still only returns visible names;
  // bash forcing is handled by installToolRoutingHook for remote sessions only and keeps this pure function clean.
  const visible = new Set(['read', 'write', 'edit', 'read_image', 'glob', 'grep']);
  const { agent } = makeAgent('/tmp/local', visible);
  assert.deepEqual(selectShadowNames(agent), ['read', 'write', 'edit', 'read_image', 'glob', 'grep']);
});

// ── installToolRoutingHook ───────────────────────────────────────────────
function makeHostCtx() {
  let handler = null;
  const warns = [];
  return {
    on(name, h) { handler = h; return () => { handler = null; }; },
    effect() { return () => {}; },
    logger: { info: () => {}, warn: (m) => warns.push(m) },
    _handler: () => handler,
    _warns: warns,
  };
}

test('hook: local cwd → no tool registered (zero impact)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const { agent, registered } = makeAgent('/home/devuser/project', new Set(ROUTED_TOOL_NAMES));
  host._handler()({ agent });
  assert.equal(registered.size, 0, 'local cwd must not shadow anything');
});

test('hook: local cwd + no bash in view → nothing registered (bash not forced locally)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const { agent, registered } = makeAgent('/home/devuser/project', new Set(['read']));
  host._handler()({ agent });
  assert.equal(registered.size, 0, 'bash exception applies to remote sessions only; local cwd registers no routed tools');
});

test('hook: remote placeholder cwd → shadows only visible names', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);
  const visible = new Set(['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep']);
  const { agent, registered } = makeAgent(placeholderCwd, visible);
  host._handler()({ agent });
  assert.deepEqual([...registered.keys()].sort(), [...ROUTED_TOOL_NAMES].sort());
});

test('hook: remote cwd + minimal preset (only bash visible) → only bash shadowed', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);
  const { agent, registered } = makeAgent(placeholderCwd, new Set(['bash']));
  host._handler()({ agent });
  assert.deepEqual([...registered.keys()], ['bash']);
});

test('hook: remote cwd with no visible tools → bash still registered (shell follows remote platform)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);
  const { agent, registered } = makeAgent(placeholderCwd, new Set());
  host._handler()({ agent });
  assert.deepEqual([...registered.keys()], ['bash'], 'bash must be registered without existence filtering');
});

test('hook: remote cwd + Windows view without bash → bash registered alongside six fs/search tools', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);
  // Windows host standard preset: tool-bash is platform-disabled → view has no bash, only six file/search tools
  const visible = new Set(['read', 'write', 'edit', 'read_image', 'glob', 'grep']);
  const { agent, registered } = makeAgent(placeholderCwd, visible);
  host._handler()({ agent });
  assert.deepEqual([...registered.keys()].sort(), [...ROUTED_TOOL_NAMES].sort(),
    'six file/search tools shadowed; bash is additionally registered (remote shell follows remote platform)');
});

test('hook: missing cwd → no throw, no registration', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const agent = { session: { header: {} }, ctx: { tools: { get: () => undefined, register: () => { throw new Error('must not call'); } } } };
  host._handler()({ agent });
});

test('hook: handler never throws even when registerRoutedTools fails (veto protection)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);
  const agent = {
    session: { header: { cwd: placeholderCwd } },
    ctx: { tools: { get: () => ({ name: 'bash' }), register: () => { throw new Error('register failed'); } } },
  };
  assert.doesNotThrow(() => host._handler()({ agent }));
  assert.ok(host._warns.some((w) => /tool routing failed/.test(w)), 'warning logged');
});

test('hook: dispose returned and handler captured', () => {
  const host = makeHostCtx();
  const { dispose, handler } = installToolRoutingHook(host);
  assert.equal(typeof dispose, 'function');
  assert.equal(typeof handler, 'function');
  assert.equal(host._handler(), handler);
});

// ── subagent context: agent/created applies to subagents as well and escalation fields stay hidden ──────────────────
test('subagent inherits remote cwd from session → hook shadows; routed tools hide escalation fields (remoteRouting)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);
  // Subagent is structurally identical to the main agent: same agent/created event, session.header.cwd inherits the remote placeholder path,
  // so the hook applies equally regardless of main/subagent distinction.
  const { agent, registered } = makeSandboxAgent(placeholderCwd, new Set(ROUTED_TOOL_NAMES));
  host._handler()({ agent });
  assert.deepEqual([...registered.keys()].sort(), [...ROUTED_TOOL_NAMES].sort(), 'subagent remote cwd must trigger shadowing of all seven tools');
  // Host sandbox backend is mounted (otherwise the helper could not prove remoteRouting effect) — if the hook forgot
  // remoteRouting=true, bash/write/edit would expose sandbox_permissions/justification; this catches the regression.
  for (const name of ['bash', 'write', 'edit']) {
    const def = registered.get(name);
    const props = (def.parameters ?? {}).properties ?? {};
    assert.ok(!('sandbox_permissions' in props), 'routed ' + name + ' for subagent must not expose sandbox_permissions');
    assert.ok(!('justification' in props), 'routed ' + name + ' for subagent must not expose justification');
  }
});

test('subagent with local cwd (non-remote) → hook does not intervene (local subagent stays unshadowed, no escalation impact)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const { agent, registered } = makeSandboxAgent('/home/devuser/local-project', new Set(ROUTED_TOOL_NAMES));
  host._handler()({ agent });
  assert.equal(registered.size, 0, 'subagent with local cwd must not register any routed tools');
});
