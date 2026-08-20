// @dsh-ssh/dsh-ssh — 远端后台任务控制器注册 单元测试 (node --test, 无网络/IO)。
// 验证 attachAgentJobsController + ⑤agent/created 钩子为远端 agent scope 补记 job controller:
//   Cordis Service 按 scope 分层实例化, 遮蔽 bash 的 startRemoteBackground 用 agent.ctx.get('jobs')
//   解析到 agent 自身 scope 的 jobs 实例; 若该实例全局层+自身 scope 链无 controller, start() 抛
//   "background jobs unavailable: no job controller serves this agent"
//   (dsh-jobs-local/lib/index.js servesOwner/L132)。本文件用最小忠实模型模拟官方
//   servesOwner(全局层优先, 其次沿 owner scope 链)+ attachController(注册进该 scope 层)语义,
//   验证修复前后 servesOwner / start-guard 行为翻转 —— 修复后远端 agent 一定被 serve。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { attachAgentJobsController, installToolRoutingHook } from '../index.js';
import { ROUTED_TOOL_NAMES } from '../tools.js';
import { mapRemoteToLocal } from '../src/router.js';

const HOST_ID = '00000000-0000-4000-8000-000000000000';
const REMOTE_PATH = '/home/ubuntu/opencode-api';
process.env.DSH_SSH_REMOTE_ROOT = path.join(os.homedir(), 'dsh-test-remote-root');

// 最小忠实模型, 镜像官方 dsh-jobs-local 的 scope 分层判定:
//   servesOwner: 全局层非空 → true; 否则沿 owner 的 scope 链找非空 controller 层。
//   attachController: 在"当前 agent scope 层"追加一个 controller(官方用它自己的 registry ctx 决定层,
//                     这里按 agent.ctx 解析到的该 jobs 实例的 scope 层 = 'agent')。
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
      return (byScope.get('agent') ?? 0) > 0; // agent scope 链命中
    },
    _global(a) { globalControllers = a ? 1 : 0; },
  };
}

// 模拟 startRemoteBackground 中 jobs.start 的 controller 存在性守卫(与官方一致)。
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

// ── attachAgentJobsController 注册逻辑 ─────────────────────────────────────
test('attachAgentJobsController registers a controller on the agent job instance', () => {
  const jobs = makeScopedJobs();
  const agent = makeRemoteAgent(jobs);
  // 基准: 全局层 + agent scope 层都无 controller → 不被 serve(修复前 start 会拒)
  assert.equal(jobs.servesOwner(agent), false);
  assert.throws(() => startWithGuard(jobs, agent), /no job controller serves this agent/);

  // 修复: 在 agent 自身 scope 注册 controller
  const res = attachAgentJobsController(agent);
  assert.ok(res && typeof res.disposer === 'function');
  assert.equal(res.jobs, jobs);

  // 修复后: 该 agent 被 serve, 后台任务 start 不再抛
  assert.equal(jobs.servesOwner(agent), true);
  assert.doesNotThrow(() => startWithGuard(jobs, agent));

  // 释放后恢复
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

// ── ⑤ agent/created 钩子: 远端会话顺带注册 controller ────────────────────
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
  assert.equal(jobs.servesOwner(agent), true); // 钩子已顺带为 agent scope 注册 controller
  assert.ok(registered.has('bash'));           // 远端 bash 路由实现照常注册
});
