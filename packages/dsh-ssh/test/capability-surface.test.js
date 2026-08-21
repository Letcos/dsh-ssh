// @dsh-ssh/dsh-ssh — unit tests for capability-surface declaration injection via agent/created (node --test, no network/IO).
// Verifies: buildCapabilitySection pure function / injectCapabilitySurface via agent.ctx.systemPrompt.section official channel /
//       installToolRoutingHook injects for remote cwd, zero injection for local cwd and capability:false / resolveHostLabel fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CAPABILITY_SECTION_NAME, CAPABILITY_SECTION_ORDER, buildCapabilitySection, injectCapabilitySurface, installToolRoutingHook, resolveHostLabel } from '../index.js';
import { mapRemoteToLocal } from '../src/router.js';

const HOST_ID = '00000000-0000-4000-8000-000000000000';
process.env.DSH_SSH_REMOTE_ROOT = path.join(os.homedir(), 'dsh-test-remote-root');
const REMOTE_PATH = '/home/devuser/workspace';
const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);

// ── buildCapabilitySection (pure function) ──────────────────────────────────────
test('buildCapabilitySection returns an official-shaped section (name/order/text)', () => {
  const sec = buildCapabilitySection({ kind: 'remote', hostId: HOST_ID, remoteCwd: REMOTE_PATH });
  assert.equal(sec.name, CAPABILITY_SECTION_NAME);
  assert.equal(sec.order, CAPABILITY_SECTION_ORDER);
  assert.ok(Number.isFinite(sec.order));
  assert.equal(typeof sec.text, 'string');
  // Chinese text covers: remote execution / skill scripts + MCP on local machine / absolute paths for local files
  assert.match(sec.text, new RegExp(HOST_ID));
  assert.match(sec.text, /远端机器/);
  assert.match(sec.text, /MCP/);
  assert.match(sec.text, /本机绝对路径/);
});

test('buildCapabilitySection: opts.zh=false → English text; hostLabel interpolated', () => {
  const sec = buildCapabilitySection({ kind: 'remote', hostId: HOST_ID }, { zh: false, hostLabel: 'workstation' });
  assert.match(sec.text, /workstation/);
  assert.match(sec.text, /remote machine/);
  assert.match(sec.text, /MCP/);
  // Default zh=true and hostLabel falls back to hostId when missing
  assert.match(buildCapabilitySection({ hostId: 'abc' }).text, /「abc」/);
});

// ── injectCapabilitySurface (official per-agent section channel) ────────────────
function makeSystemPromptAgent(cwd) {
  const registered = [];
  const sp = {
    section: function (s) { registered.push(s); return function () { const i = registered.indexOf(s); if (i >= 0) registered.splice(i, 1); }; }
  };
  // get: () => undefined — for remote cwd the hook always registers bash (remote shell follows remote platform);
  // buildRoutedToolDefinitions in registerRoutedTools reads ctx.get('shell')/ctx.get('fs') to determine sandbox mode.
  const ctx = { systemPrompt: sp, tools: { get: () => undefined, register: () => () => {} }, get: () => undefined };
  return { agent: { session: { header: { cwd } }, ctx }, registered };
}

test('injectCapabilitySurface registers a section via agent.ctx.systemPrompt.section', () => {
  const { agent, registered } = makeSystemPromptAgent(placeholderCwd);
  const disposer = injectCapabilitySurface(agent, { kind: 'remote', hostId: HOST_ID, remoteCwd: REMOTE_PATH });
  assert.equal(typeof disposer, 'function');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, CAPABILITY_SECTION_NAME);
  assert.equal(registered[0].order, CAPABILITY_SECTION_ORDER);
});

test('injectCapabilitySurface returns null when agent.ctx.systemPrompt is absent (zero impact)', () => {
  const { agent } = makeSystemPromptAgent(placeholderCwd);
  delete agent.ctx.systemPrompt;
  assert.equal(injectCapabilitySurface(agent, { kind: 'remote', hostId: HOST_ID }), null);
});

test('injectCapabilitySurface uses opts.section when provided and never throws on section() failure', () => {
  const custom = { name: 'x', order: 1, text: 'custom' };
  const { agent, registered } = makeSystemPromptAgent(placeholderCwd);
  injectCapabilitySurface(agent, { hostId: HOST_ID }, { section: custom });
  assert.deepEqual(registered, [custom]);
  // section() throwing → returns null, does not propagate (veto protection)
  agent.ctx.systemPrompt.section = () => { throw new Error('boom'); };
  assert.equal(injectCapabilitySurface(agent, { hostId: HOST_ID }), null);
});

// ── installToolRoutingHook integration: injection only for remote cwd ───────────────────
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

test('hook: remote placeholder cwd → capability section injected (even with no shadowed tools)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const { agent, registered } = makeSystemPromptAgent(placeholderCwd);
  host._handler()({ agent });
  assert.equal(registered.length, 1, 'capability section must be injected for remote cwd');
  assert.equal(registered[0].name, CAPABILITY_SECTION_NAME);
});

test('hook: local cwd → capability section NOT injected (zero impact)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const { agent, registered } = makeSystemPromptAgent('/home/devuser/project');
  host._handler()({ agent });
  assert.equal(registered.length, 0, 'local cwd must not inject capability surface');
});

test('hook: opts.capability === false → no injection', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host, { capability: false });
  const { agent, registered } = makeSystemPromptAgent(placeholderCwd);
  host._handler()({ agent });
  assert.equal(registered.length, 0);
});

test('hook: remote cwd with no systemPrompt service → no throw, no registration', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const { agent } = makeSystemPromptAgent(placeholderCwd);
  delete agent.ctx.systemPrompt;
  assert.doesNotThrow(() => host._handler()({ agent }));
});

// ── resolveHostLabel (fallback) ──────────────────────────────────────────────
test('resolveHostLabel returns null without settings or unknown host', () => {
  assert.equal(resolveHostLabel(null, HOST_ID), null);
  assert.equal(resolveHostLabel({}, HOST_ID), null);
  // settings.get throwing → fallback to null
  const bad = { settings: { get: () => { throw new Error('x'); } } };
  assert.equal(resolveHostLabel(bad, HOST_ID), null);
});

test('resolveHostLabel resolves display name from dsh-ssh-hosts when available', () => {
  const ctx = { settings: { get: (ns) => ns === 'dsh-ssh-hosts' ? { hosts: { [HOST_ID]: { name: '我的工作站' } } } : null } };
  assert.equal(resolveHostLabel(ctx, HOST_ID), '我的工作站 (' + HOST_ID + ')');
});
