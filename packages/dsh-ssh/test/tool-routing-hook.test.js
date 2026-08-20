// @dsh-ssh/dsh-ssh — 方案⑤ agent/created 钩子 + scope 遮蔽 单元测试 (node --test, 无网络/IO)。
// 验证: (a) registerRoutedTools 只注册指定名字 + 未知名抛错;
//       (b) selectShadowNames 策略(a): 只返回 agent 视图里已可见的名字(纯策略, 不含 shell 例外);
//       (c) installToolRoutingHook: 本地 cwd 零注册 / 远端 cwd 遮蔽可见名且 bash 必注册
//           (决策 .agents/notes/decisions/2026-08-19-remote-shell-follows-remote-platform.md:
//            bash 在远端会话总是注册路由实现, 不经过"已存在"过滤) / 异常不抛(veto 保护)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { registerRoutedTools, ROUTED_TOOL_NAMES } from '../tools.js';
import { selectShadowNames, installToolRoutingHook } from '../index.js';
import { mapRemoteToLocal } from '../src/router.js';

const HOST_ID = '00000000-0000-4000-8000-000000000000';
const REMOTE_PATH = '/home/ubuntu/opencode-api';
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

// 带 sandbox 能力事实(shell/fs.sandboxMode 已挂)—— 真实远端部署下宿主 sandbox backend 总是挂着的,
// 若无 remoteRouting, 路由工具会因此广告 escalation 字段。用于证明钩子(强制 remoteRouting=true)
// 确实关闭广告(否则该断言会漏掉回归)。
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

// ── (a) registerRoutedTools ──────────────────────────────────────────────
test('registerRoutedTools registers exactly the named tools and returns names', () => {
  const { ctx, registered } = makeAgentCtx(new Set(ROUTED_TOOL_NAMES));
  const out = registerRoutedTools(ctx, ['bash', 'read']);
  assert.deepEqual(out.names, ['bash', 'read']);
  assert.deepEqual([...registered.keys()].sort(), ['bash', 'read']);
  // 每个定义都带官方同形的 execute / output.render / output.schema
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

// ── (b) selectShadowNames 策略(a) ────────────────────────────────────────
test('selectShadowNames returns only names already visible in the agent view (strategy a)', () => {
  const visible = new Set(['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep']);
  const { agent } = makeAgent('/tmp/local', visible);
  assert.deepEqual(selectShadowNames(agent), ROUTED_TOOL_NAMES);
});

test('selectShadowNames skips names absent from the agent view (minimal/code preset)', () => {
  const visible = new Set(['bash']); // 只暴露 bash(模拟 minimal preset)
  const { agent } = makeAgent('/tmp/local', visible);
  assert.deepEqual(selectShadowNames(agent), ['bash']);
});

test('selectShadowNames passes the agent object itself as the scope key', () => {
  const { agent, scopeArgs } = makeAgent('/tmp/local', new Set(['bash']));
  selectShadowNames(agent);
  // scope key === agent 对象本身(dsh-agent-loop createScope(loopCtx, this))
  assert.ok(scopeArgs.every((s) => s === agent));
});

test('selectShadowNames tolerates a get that throws (returns empty, never throws)', () => {
  const agent = {
    ctx: { tools: { get() { throw new Error('boom'); } } },
  };
  assert.deepEqual(selectShadowNames(agent, ['bash']), []);
});

test('selectShadowNames does not force bash (pure strategy a; shell forcing lives in the hook)', () => {
  // 视图无 bash(模拟 Windows 宿主 standard preset) → selectShadowNames 仍只返回可见名,
  // bash 的强制注册由 installToolRoutingHook 对远端会话负责, 不污染纯函数。
  const visible = new Set(['read', 'write', 'edit', 'read_image', 'glob', 'grep']);
  const { agent } = makeAgent('/tmp/local', visible);
  assert.deepEqual(selectShadowNames(agent), ['read', 'write', 'edit', 'read_image', 'glob', 'grep']);
});

// ── (c) installToolRoutingHook ───────────────────────────────────────────
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
  const { agent, registered } = makeAgent('/Users/haowu/project', new Set(ROUTED_TOOL_NAMES));
  host._handler()({ agent });
  assert.equal(registered.size, 0, 'local cwd must not shadow anything');
});

test('hook: local cwd + no bash in view → nothing registered (bash not forced locally)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const { agent, registered } = makeAgent('/Users/haowu/project', new Set(['read']));
  host._handler()({ agent });
  assert.equal(registered.size, 0, 'bash 例外只作用于远端会话, 本地 cwd 绝不注册任何路由工具');
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
  assert.deepEqual([...registered.keys()], ['bash'], 'bash 必注册, 不经过策略 (a) 的"已存在"过滤');
});

test('hook: remote cwd + Windows view without bash → bash registered alongside six fs/search tools', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);
  // Windows 宿主 standard preset: tool-bash 被 platform 禁用 → 视图无 bash, 只有六文件/搜索工具
  const visible = new Set(['read', 'write', 'edit', 'read_image', 'glob', 'grep']);
  const { agent, registered } = makeAgent(placeholderCwd, visible);
  host._handler()({ agent });
  assert.deepEqual([...registered.keys()].sort(), [...ROUTED_TOOL_NAMES].sort(),
    '六文件/搜索工具按策略 (a) 遮蔽, bash 补注册(决策 2026-08-19-remote-shell-follows-remote-platform)');
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

// ── (d) subagent 语境(A.40): agent/created 对 subagent 同效 + escalation 字段隐藏 ──────────────
test('subagent 继承会话远端 cwd → 钩子遮蔽; 且路由工具 escalation 字段隐藏(remoteRouting)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);
  // subagent 与主 agent 同构: 也是 agent/created 事件, session.header.cwd 继承会话的远端占位路径,
  // 故钩子对其同样生效(index.js installToolRoutingHook 只按 cwd 路由, 不区分主/子代理)。
  const { agent, registered } = makeSandboxAgent(placeholderCwd, new Set(ROUTED_TOOL_NAMES));
  host._handler()({ agent });
  assert.deepEqual([...registered.keys()].sort(), [...ROUTED_TOOL_NAMES].sort(), 'subagent 的远端 cwd 应触发全七工具遮蔽');
  // 宿主 sandbox backend 已挂(否则上面 helper 无法证明 remoteRouting 的作用)—— 若钩子忘了传
  // remoteRouting=true, 这里 bash/write/edit 就会暴露 sandbox_permissions/justification, 测试抓回归。
  for (const name of ['bash', 'write', 'edit']) {
    const def = registered.get(name);
    const props = (def.parameters ?? {}).properties ?? {};
    assert.ok(!('sandbox_permissions' in props), 'subagent 的路由 ' + name + ' 不得暴露 sandbox_permissions');
    assert.ok(!('justification' in props), 'subagent 的路由 ' + name + ' 不得暴露 justification');
  }
});

test('subagent 本地 cwd(非远端)→ 钩子零介入(本地 subagent 不被遮蔽, 无升级字段影响)', () => {
  const host = makeHostCtx();
  installToolRoutingHook(host);
  const { agent, registered } = makeSandboxAgent('/Users/haowu/local-project', new Set(ROUTED_TOOL_NAMES));
  host._handler()({ agent });
  assert.equal(registered.size, 0, 'subagent 本地 cwd 不得注册任何路由工具');
});
