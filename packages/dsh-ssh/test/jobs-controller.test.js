// @dsh-ssh/dsh-ssh — unit tests for remote background job controller registration (node --test, no network/IO).
// Verifies that attachAgentJobsController and the agent/created hook add a job controller to the remote agent scope:
//   Cordis instantiates services per scope; the routed bash's startRemoteBackground resolves agent.ctx.get('jobs')
//   to the jobs instance of the agent's own scope. If that instance has no controller on the global layer
//   or the agent's scope chain, start() throws
//   "background jobs unavailable: no job controller serves this agent"
//   (dsh-jobs-local/lib/index.js servesOwner). This file uses a minimal faithful model of the official
//   servesOwner (global layer first, then owner scope chain) + attachController (register on that scope layer)
//   to verify that the remote agent is served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { attachAgentJobsController, installToolRoutingHook } from '../index.js';
import { ROUTED_TOOL_NAMES } from '../tools.js';
import { mapRemoteToLocal } from '../src/router.js';

const HOST_ID = '00000000-0000-4000-8000-000000000000';
const REMOTE_PATH = '/home/devuser/workspace';
process.env.DSH_SSH_REMOTE_ROOT = path.join(os.homedir(), 'dsh-test-remote-root');

// Minimal faithful model mirroring the official dsh-jobs-local scope-layer decision:
//   servesOwner: non-empty global layer → true; otherwise walk the owner's scope chain for a non-empty controller layer.
//   attachController: append a controller on the current agent scope layer (official uses its own registry ctx
//                     to decide the layer; here the layer resolved via agent.ctx is 'agent').
function makeScopedJobs() {
  let globalControllers = 0;
  const byScope = new Map();
  return {
    attachController(name) {
      byScope.set('agent', (byScope.get('agent') ?? 0) + 1);
      return () => { const n = (byScope.get('agent') ?? 1) - 1; if (n > 0) byScope.set('agent', n); else byScope.delete('agent'); };
    },
    servesOwner(owner) {
      if (globalControllers > 0) return true;
      return (byScope.get('agent') ?? 0) > 0; // hit on agent scope chain
    },
    _global(a) { globalControllers = a ? 1 : 0; },
  };
}

// Simulate the controller existence guard for jobs.start inside startRemoteBackground (matches official behavior).
function startWithGuard(jobs, owner, guardName = '@dsh-ssh/dsh-ssh') {
  if (!jobs.servesOwner(owner)) {
    throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)');
  }
  const jobId = jobs.start ? jobs.start({ kind: 'bash', label: 'x', owner, run: () => ({ cancel(){}, done: Promise.resolve({status:'completed'}) }) }) : 'bash-1';
  return 'OK ' + jobId;
}

function remoteCwd() { return mapRemoteToLocal(HOST_ID, REMOTE_PATH); }

function makeRemoteAgent(jobs) {
  const agent = {
    session: { header: { cwd: remoteCwd() } },
    ctx: { get(key) { return key === 'jobs' ? jobs : undefined; } },
    id: 'agent-r1',
  };
  return agent;
}

// ── attachAgentJobsController registration ─────────────────────────────────────
test('attachAgentJobsController registers a controller on the agent job instance', () => {
  const jobs = makeScopedJobs();
  const agent = makeRemoteAgent(jobs);
  // Baseline: no controller on either global or agent scope → not served
  assert.equal(jobs.servesOwner(agent), false);
  assert.throws(() => startWithGuard(jobs, agent), /no job controller serves this agent/);

  // Register a controller on the agent's own scope
  const res = attachAgentJobsController(agent);
  assert.ok(res && typeof res.disposer === 'function');
  assert.equal(res.jobs, jobs);

  // After registration the agent is served and background start no longer throws
  assert.equal(jobs.servesOwner(agent), true);
  assert.doesNotThrow(() => startWithGuard(jobs, agent));

  // Disposer restores previous state
  res.disposer();
  assert.equal(jobs.servesOwner(agent), false);
});

test('attachAgentJobsController uses official attachController(name) with the default name', () => {
  let calledName = null;
  const jobs = { attachController(name) { calledName = name; return () => {}; } };
  const agent = makeRemoteAgent(jobs);
  const res = attachAgentJobsController(agent);
  assert.equal(calledName, '@dsh-ssh/dsh-ssh');
  assert.ok(res);
});

test('attachAgentJobsController honors a custom controller name', () => {
  let calledName = null;
  const jobs = { attachController(name) { calledName = name; return () => {}; } };
  const agent = makeRemoteAgent(jobs);
  attachAgentJobsController(agent, 'my-controller');
  assert.equal(calledName, 'my-controller');
});

test('attachAgentJobsController returns null (silent) when no jobs service is reachable', () => {
  const agent = { session: { header: { cwd: REMOTE_PATH } }, ctx: { get: () => undefined } };
  assert.equal(attachAgentJobsController(agent), null);
});

test('attachAgentJobsController returns null when jobs lacks attachController', () => {
  const jobs = { servesOwner() { return true; } };
  const agent = makeRemoteAgent(jobs);
  assert.equal(attachAgentJobsController(agent), null);
});

test('attachAgentJobsController tolerates an agent without ctx / get (never throws)', () => {
  assert.equal(attachAgentJobsController({}), null);
  assert.equal(attachAgentJobsController(null), null);
});

test('attachAgentJobsController swallows a throwing attachController (never throws)', () => {
  const jobs = { attachController() { throw new Error('boom'); } };
  const agent = makeRemoteAgent(jobs);
  assert.equal(attachAgentJobsController(agent), null);
});

// ── agent/created hook: remote session registers a controller ────────────────────
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

function makeAgentCtxWithJobs(visibleNames, jobs) {
  const registered = new Map();
  const ctx = {
    tools: {
      get(name) { return visibleNames.has(name) ? { name } : undefined; },
      register(def) { registered.set(def.name, def); return () => registered.delete(def.name); },
    },
    systemPrompt: { section: () => () => {} },
    get(key) { return key === 'jobs' ? jobs : undefined; },
  };
  return { ctx, registered };
}

test('hook: remote cwd → registers a job controller for the agent scope', () => {
  const jobs = makeScopedJobs();
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const handler = host._handler();
  assert.ok(handler);

  const { ctx, registered } = makeAgentCtxWithJobs(new Set(ROUTED_TOOL_NAMES), jobs);
  const agent = { session: { header: { cwd: remoteCwd() } }, ctx, id: 'agent-r1' };

  assert.equal(jobs.servesOwner(agent), false);
  handler({ agent });
  assert.equal(jobs.servesOwner(agent), true); // hook registered a controller on the agent scope
  assert.ok(registered.has('bash'));           // remote bash route is registered as expected
});
