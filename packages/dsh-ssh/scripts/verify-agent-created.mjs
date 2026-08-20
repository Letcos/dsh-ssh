// @dsh-ssh/dsh-ssh — 方案⑤ 真机/脚本级验证: 在真实 cordis 组合里触发 agent/created 钩子。
// 用 dsh-app-boot 的 boot() 组装 dsh-base + dsh-ssh(不含 web-app, 避免端口冲突),
// 通过 ctx.agents.create 建 standard preset 会话(远端占位 cwd / 本地 cwd 对照)。
// 注意: 本机为 Windows, standard preset 的 tool-bash 被 platform 禁用(tool-pwsh 替代),
//       故 bash 不在 agent 视图里 —— 但按决策 .agents/notes/decisions/2026-08-19-remote-shell-follows-remote-platform.md,
//       远端会话 bash 总是补注册路由实现(不经过策略 a 的"已存在"过滤; shell 跟随远端平台)。
// 断言: (1) 远端 cwd → bash + read/glob/grep 等全部带 ROUTED_TOOL_MARKER(七工具全遮蔽),
//       且 read 走 SSH 读回远端 /etc/hostname;
//       (2) 本地 cwd → 无 marker(官方工具, 零影响);
//       (3) 远端会话 bash 必注册(Windows 宿主视图无 bash 也注册路由实现)。
// 只读远端 + 真实 SSH; 不写 settings.yaml / known_hosts(复用已配好的 ubuntu 主机)。
// DSH_SSH_VERIFY_SKIP_SSH=1 时跳过 read 的 SSH 行为验证(仅装配 + 遮蔽断言)。
// PREREQ: a DSH core install (install anchor) — resolved via DSH_SSH_DSH_NODE_MODULES or the
// probed default in test/live-config.mjs; DSH_HOME via DSH_SSH_DSH_HOME (default ~/.dsh);
// profile via DSH_SSH_TEST_PROFILE (default dsh-ssh-dev). Switch machines by exporting those
// plus the DSH_SSH_TEST_* host vars (host/port/user/hostId/keyPath) from live-config.mjs.
import path from 'node:path';
import os from 'node:os';
import { liveConfig, dshNodeModules, dshHome, profile as dshTestProfile, requireRealHost } from '../test/live-config.mjs';
requireRealHost('scripts/verify-agent-created');

const CORE = dshNodeModules;
const appBootUrl = 'file:///' + (CORE + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').replace(/\\/g, '/');
const { boot, loadProfile, composeEntries } = await import(appBootUrl);

process.env.DSH_HOME = dshHome;

const NAME = 'dsh-verify';
const INSTALL_ANCHOR = CORE + '/package.json';
const SHIPPED_PRESET_ROOT = CORE + '/config/agent-presets/';

const SKIP_SSH = process.env.DSH_SSH_VERIFY_SKIP_SSH === '1';

const profile = loadProfile(NAME, dshTestProfile, INSTALL_ANCHOR, process.env.DSH_HOME, { userLayer: false });
const bundlePatches = profile.layers
  .filter((l) => l.packageName !== '@deepseek-ai/dsh-web-app')
  .flatMap((l) => l.patches);
const rows = new Map();
for (const row of composeEntries([bundlePatches])) if (typeof row.id === 'string') rows.set(row.id, row);
const overlays = [];
if (rows.has('agent-presets')) {
  overlays.push({ id: 'agent-presets', config: { ...(rows.get('agent-presets')?.config ?? {}), roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }] } });
}

const rootConfig = path.join(profile.dir, 'cordis.yml');
const ctx = await boot(NAME, rootConfig, [...bundlePatches, ...overlays], (hostCtx) => {});

const ssh = await import(new URL('../tools.js', import.meta.url).href);
const router = await import(new URL('../src/router.js', import.meta.url).href);
const { ROUTED_TOOL_MARKER, ROUTED_TOOL_NAMES } = ssh;
const { mapRemoteToLocal } = router;

const HOST_ID = liveConfig.hostId;
const REMOTE_PATH = '/home/ubuntu/opencode-api';
const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);

const agents = ctx.get('agents');
if (!agents) throw new Error('agents service unavailable');

function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: undefined };
}

// ── 1. 远端 cwd 会话(standard preset) ─────────────────────────────────────
const { agent: remoteAgent } = await agents.create({
  sessionId: 'session-verify-remote-' + Date.now(),
  meta: { cwd: placeholderCwd, agentPreset: 'standard' },
  agentOptions: { provider: 'fusion-router', model: 'deepseek-v4-flash' },
});

const shadowed = ROUTED_TOOL_NAMES.filter((n) => remoteAgent.ctx.tools.get(n, remoteAgent)?.[ROUTED_TOOL_MARKER] === true);
console.log('remote agent: shadowed routed tools =', JSON.stringify(shadowed.sort()));
if (!ROUTED_TOOL_NAMES.every((n) => shadowed.includes(n))) {
  throw new Error('VERIFY-FAIL: expected all seven routed tools (incl. bash) shadowed, got ' + JSON.stringify(shadowed));
}

// 行为验证: read /etc/hostname 走 SSH → 返回远端 hostname(本地 Windows 无此文件)。
// 默认执行(连 ubuntu@203.0.113.10, 只读); DSH_SSH_VERIFY_SKIP_SSH=1 时跳过(装配+遮蔽断言已足够)。
let hostname = '(skipped)';
if (SKIP_SSH) {
  console.log('read /etc/hostname via remote-cwd agent → SKIPPED (DSH_SSH_VERIFY_SKIP_SSH=1)');
} else {
  const readTool = remoteAgent.ctx.tools.get('read', remoteAgent);
  const readResult = await readTool.execute({ file_path: '/etc/hostname', offset: 1, limit: 10 }, makeExec(placeholderCwd));
  hostname = (readResult.lines ?? []).map((l) => l.text).join(String.fromCharCode(10)).trim();
  console.log('read /etc/hostname via remote-cwd agent →', JSON.stringify(hostname));
  // 通用校验: 必须经 SSH 读到远端非空且与本机不同的 hostname(不硬编码任何真实主机名)。
  if (!hostname || hostname === os.hostname()) {
    throw new Error('VERIFY-FAIL: read did not route to SSH; got: ' + JSON.stringify(hostname));
  }
}

// ── 2. 本地 cwd 会话(standard preset, 对照) ───────────────────────────────
const { agent: localAgent } = await agents.create({
  sessionId: 'session-verify-local-' + Date.now(),
  meta: { cwd: process.cwd(), agentPreset: 'standard' },
  agentOptions: { provider: 'fusion-router', model: 'deepseek-v4-flash' },
});
const localShadowed = ROUTED_TOOL_NAMES.filter((n) => localAgent.ctx.tools.get(n, localAgent)?.[ROUTED_TOOL_MARKER] === true);
console.log('local agent: shadowed routed tools =', JSON.stringify(localShadowed));
if (localShadowed.length !== 0) {
  throw new Error('VERIFY-FAIL: local-cwd agent must not be shadowed (zero-impact violated): ' + JSON.stringify(localShadowed));
}

console.log('VERIFY-OK: agent/created 钩子在真实组合中触发; 远端 cwd 遮蔽 bash+六工具(决策 2026-08-19-remote-shell-follows-remote-platform), '
  + (SKIP_SSH ? 'read 行为验证已跳过(DSH_SSH_VERIFY_SKIP_SSH=1)' : 'read /etc/hostname=' + hostname + ' 走 SSH')
  + '; 本地 cwd 零影响');
await ctx.fiber.dispose();
process.exit(0);
