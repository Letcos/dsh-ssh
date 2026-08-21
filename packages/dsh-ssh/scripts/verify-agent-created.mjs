// @dsh-ssh/dsh-ssh — live/script-level verification: triggers the agent/created hook in a real cordis composition.
// Assembles dsh-base + dsh-ssh via dsh-app-boot's boot() (excluding web-app to avoid port conflicts),
// and creates standard preset sessions via ctx.agents.create (remote placeholder cwd vs local cwd).
// Note: on Windows, standard preset's tool-bash is disabled by platform (tool-pwsh replaces it),
//       so bash is not in the agent view — but per the decision that the remote shell follows the remote platform,
//       remote sessions always register the routed bash implementation (bypassing the "already present" filter; shell follows remote platform).
// Assertions: (1) remote cwd -> bash + read/glob/grep etc. all carry ROUTED_TOOL_MARKER (all seven tools shadowed),
//       and read goes via SSH to read back remote /etc/hostname;
//       (2) local cwd -> no marker (official tools, zero impact);
//       (3) remote session bash is always registered (even when Windows host view has no bash, the routed implementation is registered).
// Read-only remote + real SSH; does not write settings.yaml / known_hosts (reuses the preconfigured ubuntu host).
// When DSH_SSH_VERIFY_SKIP_SSH=1, skip SSH behavior verification for read (only assembly + shadowing assertions).
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
const REMOTE_PATH = liveConfig.remoteWorkspace;
const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);

const agents = ctx.get('agents');
if (!agents) throw new Error('agents service unavailable');

function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: undefined };
}

// ── 1. remote cwd session (standard preset) ─────────────────────────────────────
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

// Behavior verification: read /etc/hostname via SSH -> returns remote hostname (local Windows has no such file).
// Runs by default (connects to ubuntu@203.0.113.10, read-only); when DSH_SSH_VERIFY_SKIP_SSH=1 skip (assembly + shadowing assertions are enough).
let hostname = '(skipped)';
if (SKIP_SSH) {
  console.log('read /etc/hostname via remote-cwd agent → SKIPPED (DSH_SSH_VERIFY_SKIP_SSH=1)');
} else {
  const readTool = remoteAgent.ctx.tools.get('read', remoteAgent);
  const readResult = await readTool.execute({ file_path: '/etc/hostname', offset: 1, limit: 10 }, makeExec(placeholderCwd));
  hostname = (readResult.lines ?? []).map((l) => l.text).join(String.fromCharCode(10)).trim();
  console.log('read /etc/hostname via remote-cwd agent →', JSON.stringify(hostname));
  // Generic check: must read a non-empty remote hostname via SSH that differs from the local one (no hard-coded real hostname).
  if (!hostname || hostname === os.hostname()) {
    throw new Error('VERIFY-FAIL: read did not route to SSH; got: ' + JSON.stringify(hostname));
  }
}

// ── 2. local cwd session (standard preset, control) ───────────────────────────────
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

console.log('VERIFY-OK: agent/created 钩子在真实组合中触发; 远端 cwd 遮蔽七工具(远端 shell 跟随远端平台), '
  + (SKIP_SSH ? 'read 行为验证已跳过(DSH_SSH_VERIFY_SKIP_SSH=1)' : 'read /etc/hostname=' + hostname + ' 走 SSH')
  + '; 本地 cwd 零影响');
await ctx.fiber.dispose();
process.exit(0);
