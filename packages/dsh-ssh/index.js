// @dsh-ssh/dsh-ssh — DeepSeek Harness SSH remote workspace plugin (host half).
// Provides the sshPool service (SshPool over ssh2), registers the dsh-ssh-hosts
// settings namespace for SSH host configuration, and exposes ssh/testConnection
// over the official Typert gateway for the settings-page "test connection" button
// (the UI lives client-side).
import { Service } from '@deepseek-ai/cordis';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { SshPool } from './src/ssh-core.js';
import { registerSettings, readHostsDoc } from './src/settings.js';
import { registerRemote } from './src/remote.js';
import { routeByCwd } from './src/router.js';
import { registerRoutedTools, ROUTED_TOOL_NAMES } from './tools.js';

export const name = '@dsh-ssh/dsh-ssh';

// Cordis Service: super(ctx, 'sshPool') registers ctx.sshPool on this fiber.
export class SshPoolService extends Service {
  constructor(ctx, config) {
    super(ctx, 'sshPool');
    this.pool = new SshPool(config);
  }

  acquire(cfg) { return this.pool.acquire(cfg); }
  release(conn) { return this.pool.release(conn); }
  invalidate(hostId) { return this.pool.invalidate(hostId); }
  testConnection(cfg) { return this.pool.testConnection(cfg); }
}

// Subscribe to workspace domain/changed so deleting a workspace record also cleans
// up its corresponding local placeholder directory.
// Event contract (same as the dsh-workspace invariant):
// { domain:'workspace', table:'workspaces', operation, key }.
// put/create carry the record (record.value.path or change.value.path); deleted/delete
// carry only the key (so an id→localPath map must be kept locally).
export function installPlaceholderCleanup(ctx, opts = {}) {
  const placeholderRoot = opts.placeholderRoot
    ?? (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'remote') : path.join(os.homedir(), '.dsh', 'remote'));
  const rmImpl = opts.rm ?? rm;
  const byWorkspace = new Map(); // workspaceId → localPath
  const handler = (change) => {
    if (!change || change.domain !== 'workspace' || change.table !== 'workspaces') return;
    const op = change.operation;
    const key = String(change.key ?? change.id ?? '');
    if (op === 'put' || op === 'create') {
      const record = change.value ?? change.record;
      const localPath = record?.value?.path ?? record?.path;
      if (typeof localPath === 'string' && localPath.startsWith(placeholderRoot + path.sep) && key) {
        byWorkspace.set(key, localPath);
      }
    } else if (op === 'deleted' || op === 'delete') {
      const localPath = byWorkspace.get(key);
      if (localPath) {
        byWorkspace.delete(key);
        // Best-effort async cleanup; failures silent (a leftover placeholder is harmless).
        Promise.resolve(rmImpl(localPath, { recursive: true, force: true })).catch(() => {});
      }
    }
  };
  const dispose = ctx.on('domain/changed', handler);
  ctx.effect(() => dispose, '@dsh-ssh/dsh-ssh: placeholder cleanup');
  return { placeholderRoot, byWorkspace };
}

// ── Preset-independent SSH tool routing (agent/created hook + scope shadowing) ──
// The host plugin listens to agent/created (dsh-agent/README.zh.md: emitted
// synchronously after setup, before the driver starts). Only when
// agent.session.header.cwd is a remote placeholder path does it register
// same-named routed tools on the agent's own scope (scoped shadows global,
// dsh-tools/lib/index.js L2550; agent.ctx.tools.register → the agent's own layer).
// Shadowing is conservative (strategy a): only tool names already present in the
// agent's view are shadowed; no new tools are added (so minimal/code presets are
// unaffected).
// Shell exception: in a session whose cwd is a remote placeholder, bash is always
// registered with the routed implementation (not filtered by "already present"; this
// also re-registers it on a Windows host where tool-bash is platform-disabled).
// pwsh is not routed.
// Local-cwd sessions return early (zero impact); local-path calls still delegate to
// the host-wide official implementation via the unscoped ctx.tools.get(name)
// (dsh-base cordis.patch.yml L210-230), byte-for-byte identical.

/**
 * Strategy (a): return the tool names already visible in the agent's view that need
 * shadowing. The scope key is the agent object itself (dsh-agent-loop:
 * createScope(loopCtx, this) → agent.ctx[kScope] = agent), so tools.get(name, agent) is
 * that agent's scoped view (global + preset standing + its own layer).
 */
export function selectShadowNames(agent, names = ROUTED_TOOL_NAMES) {
  const result = [];
  for (const name of names) {
    let visible = false;
    try {
      visible = agent?.ctx?.tools?.get(name, agent) !== undefined;
    } catch { visible = false; }
    if (visible) result.push(name);
  }
  return result;
}

// ── Remote background jobs: register a job controller on the agent scope ──────
// The web plane mounts presets per session, which disable the base tool-jobs line;
// the official dsh-tool-bash does not register a controller (it only calls
// ctx.jobs.start; dsh-tool-bash/lib/index.js L403-427) — the controller is registered
// only by dsh-tool-jobs (apply ctx.jobs.attachController('tool-jobs')). Cordis
// instantiates Services per scope and the services registry is per scope too (dsh-scope
// ScopedLayers). A shadowed bash's startRemoteBackground resolves agent.ctx.get('jobs')
// to the agent's own-scope jobs instance, but preset tool-jobs registers its controller
// only on its own scope layer — if the remote session's preset chain has no tool-jobs,
// that jobs instance has no controller on the global layer + its own scope chain, and
// start() throws "background jobs unavailable: no job controller serves this agent"
// (dsh-jobs-local/lib/index.js L132). So, while shadowing bash, we also attach a
// controller on the agent's own scope via the official attachController API. It is the
// same agent.ctx.get('jobs') instance, servesOwner(agent) matches along the agent scope
// chain, and background jobs become available. Purely additive: core untouched, local
// sessions unchanged, and when the preset already has tool-jobs this just adds an
// anonymous token with no side effects.
export function attachAgentJobsController(agent, name = '@dsh-ssh/dsh-ssh') {
  const jobs = agent && agent.ctx && typeof agent.ctx.get === 'function' ? agent.ctx.get('jobs') : null;
  if (!jobs || typeof jobs.attachController !== 'function') return null;
  try {
    const disposer = jobs.attachController(name);
    return { jobs, disposer };
  } catch {
    return null; // jobs missing / attachController unsupported → return null; caller stays silent
  }
}


// ── C: capability-surface declaration injection ─────────────────────────────
// Mechanism (official core channel): dsh-agent's assembleContextFor(agent, signal)
// returns { agent, scope: agent, ... } (dsh-agent/lib/types/dispatch.js L92-94) — each
// agent's system prompt is assembled with scope === agent, and dsh-system-prompt's
// SystemPrompt.section() registers via layers.effect(this.ctx, ...) on the calling
// context's scope (dsh-system-prompt/lib/index.js L186-188; PromptLayer error text at
// L142 states per-agent overrides go through agent.ctx). So calling
// agent.ctx.systemPrompt.section(...) in the agent/created hook registers the section in
// that agent's own scope — it participates only in that agent's assembly, i.e. it is
// remote-session-specific; local-cwd sessions return early in installToolRoutingHook and
// are unaffected.
// The instruction format follows Claude Code Agent Skills ("instruction injection with
// execution on the process's machine, not following the workspace").
export const CAPABILITY_SECTION_NAME = 'dsh-ssh:capability-surface';
export const CAPABILITY_SECTION_ORDER = 150; // tool-guidance band 100-199, clear of harness:identity(-100)/persona(0)

// Build the capability-surface declaration section for an agent. Pure, so unit-testable.
// route: { kind:'remote', hostId, remoteCwd }; opts.hostLabel: user-readable host name
// (defaults to hostId); opts.zh !== false → Chinese body (the session header has no
// locale field, so default to zh).
export function buildCapabilitySection(route, opts = {}) {
  const hostLabel = opts.hostLabel || (route && route.hostId) || 'remote';
  const zh = opts.zh !== false;
  const text = zh
    ? '当前工作区在远程主机「' + hostLabel + '」上执行。bash / read / write / edit / read_image / glob / grep 在远端机器(SSH)上运行, 相对路径基于远端工作目录。技能(skill)的脚本与资源、MCP 工具以及其它宿主工具在本机(运行 DSH 的机器)执行, 与远端工作区无关; 若需在远端使用本地技能脚本, 请用绝对路径上传(git/sftp)后执行。要访问本机文件, 请使用本机绝对路径。后台任务(bash run_in_background 产生的 bash-N)用 job_list / job_output / job_kill 查询与管理; 子代理(subagent)不是后台任务, 查询其进度或状态请用 list_agents, 不要把 subagent id 当作 job_id 传给 job_output / job_kill。'
    : 'This workspace executes on the remote host ' + hostLabel + '. bash / read / write / edit / read_image / glob / grep run on the remote machine (SSH); relative paths resolve against the remote working directory. Skill scripts and resources, MCP tools, and other host tools execute on this machine (where DSH runs), independent of the remote workspace. To use a local skill script on the remote, copy it with an absolute path (git/sftp) first. Use absolute paths to reach files on this machine. Background jobs (bash-N from bash run_in_background) are queried via job_list / job_output / job_kill; subagents are NOT jobs — check their progress with list_agents and never pass a subagent id as job_id to job_output / job_kill.';
  return { name: CAPABILITY_SECTION_NAME, order: CAPABILITY_SECTION_ORDER, text };
}

// Inject the capability surface into a remote agent. When agent.ctx.systemPrompt exists,
// register through the official per-agent section channel; the scope follows the agent
// lifetime (auto-cleaned). Returns null on absence/failure (zero impact, never throws —
// agent/created is an emit).
export function injectCapabilitySurface(agent, route, opts = {}) {
  const sp = agent && agent.ctx && agent.ctx.systemPrompt;
  if (!sp || typeof sp.section !== 'function') return null;
  const section = opts.section || buildCapabilitySection(route, opts);
  try {
    return sp.section(section);
  } catch (err) {
    return null;
  }
}

// Best-effort host display name (the settings read is only a hint; falls back to hostId
// on failure; the caller wraps this in try/catch).
export function resolveHostLabel(ctx, hostId) {
  if (!hostId || !ctx) return null;
  try {
    const get = ctx.settings && typeof ctx.settings.get === 'function' ? (ns) => ctx.settings.get(ns) : null;
    if (!get) return null;
    const { hosts } = readHostsDoc(get);
    const entry = hosts[hostId];
    return (entry && typeof entry.name === 'string' && entry.name) ? (entry.name + ' (' + hostId + ')') : null;
  } catch {
    return null;
  }
}

/**
 * Install the agent/created listener. Any exception is swallowed and warned — agent/created
 * is an emit event and a synchronous listener throw would veto the agent publish (dsh-agent
 * types: Synchronous listener failure vetoes publication), so it must never throw here.
 */
export function installToolRoutingHook(ctx, opts = {}) {
  const names = opts.names ?? ROUTED_TOOL_NAMES;
  const handler = ({ agent }) => {
    try {
      const cwd = agent?.session?.header?.cwd;
      if (!cwd) return; // no cwd (rare) → do not intervene
      const route = routeByCwd(cwd);
      if (route.kind !== 'remote') return; // local cwd → zero impact
      // Remote background jobs: register a job controller on the agent's own scope via the
      // official attachController API, so the shadowed bash's run_in_background jobs are
      // reachable on that agent (see attachAgentJobsController). The result is used only for
      // logging/assertion and never thrown (a synchronous throw in agent/created would veto
      // the agent publish).
      let controllerAttached = false;
      try {
        controllerAttached = attachAgentJobsController(agent) !== null;
      } catch { controllerAttached = false; }
      // C: inject the capability-surface declaration into remote sessions. Independent of tool
      // shadowing (injected even when a minimal preset has no tools to shadow); registered in
      // that agent's scope via the official agent.ctx.systemPrompt.section() per-agent channel.
      let capabilityInjected = false;
      if (opts.capability !== false) {
        const hostLabel = resolveHostLabel(ctx, route.hostId) || route.hostId;
        const injectOpts = { hostLabel: hostLabel, zh: opts.zh, section: opts.section };
        if (injectCapabilitySurface(agent, route, injectOpts)) capabilityInjected = true;
      }
      const selected = selectShadowNames(agent, names);
      // Shell exception: the shell semantics of a remote session are determined by the remote
      // platform (Linux, has bash), independent of the host platform. bash is always registered
      // with the routed implementation in a remote-placeholder-cwd session (re-registering it on
      // a Windows host where tool-bash is platform-disabled; on macOS/Linux hosts bash is already
      // in view and shadowing covers it). The six file/search tools keep strategy (a).
      if (!selected.includes('bash')) selected.push('bash');
      // remoteRouting=true: the hook only serves remote-cwd sessions/subagents, and the remote has
      // no local sandbox runner, so escalation (relaxing the local executor) is meaningless for
      // remote paths → do not advertise sandbox_permissions/justification (the tool schema omits
      // those fields), eliminating the "sandbox escalation to ... is not strictly wider" loop that
      // otherwise recurred under danger-full-access. The three-mode denial semantics in policy.js
      // are unaffected.
      registerRoutedTools(agent.ctx, selected, { ...opts.config, remoteRouting: true });
      ctx.logger?.info('[@dsh-ssh/dsh-ssh] agent/created: shadowed ' + selected.join(',')
        + ' for remote cwd (host ' + route.hostId + ')' + (capabilityInjected ? ' + capability surface' : '')
        + (controllerAttached ? ' + job controller' : ' (no job controller)'));

    } catch (err) {
      ctx.logger?.warn('[@dsh-ssh/dsh-ssh] agent/created tool routing failed: ' + (err?.message ?? String(err)));
    }
  };
  const dispose = ctx.on('agent/created', handler);
  ctx.effect(() => dispose, '@dsh-ssh/dsh-ssh: agent/created tool routing');
  return { dispose, handler };
}

export function apply(ctx, config = {}) {
  const svc = new SshPoolService(ctx, config);
  // Pool disposal follows the plugin fiber teardown (Service registration is removed with the fiber).
  ctx.effect(() => () => svc.pool.dispose());
  ctx.inject(['settings'], (settingsCtx) => {
    registerSettings(settingsCtx);
  });
  // Host-side Typert endpoint for the settings-page "test connection" (injects typert/settings itself).
  registerRemote(ctx, svc);
  installPlaceholderCleanup(ctx);
  installToolRoutingHook(ctx);
  ctx.logger.info('[@dsh-ssh/dsh-ssh] loaded: sshPool service (maxConnections=' + (config.maxConnections ?? 4) + ', maxChannelsPerConnection=' + (config.maxChannelsPerConnection ?? 6) + ') + settings dsh-ssh-hosts + remote ssh/* + placeholder cleanup + agent/created tool routing');
}