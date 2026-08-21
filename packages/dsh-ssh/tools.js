// @dsh-ssh/dsh-ssh — remote same-named tools: bash / read / write / edit / read_image plus cwd routing;
// glob / grep are also defined here, so seven same-named tools in total.
// Exports registerRoutedTools (the registration entry reused by the agent/created hook) and apply(ctx)
// (the local-delegation registration helper, used only by tests and verify scripts).
//
// Routing: exec.agent.session.header.cwd being a placeholder path (~/.dsh/remote/<hostId>/<enc>) → remote
// (SSH); otherwise local → delegate to the host's globally registered same-named tool via
// ctx.tools.get(name).execute(args, exec) (byte-for-byte identical, hard constraint 4). The official tool
// packages (dsh-tool-bash/dsh-tool-fs) do not export a reusable execute function (only
// Config/apply/inject/name), but they are already globally registered in the host composition
// (@deepseek-ai/dsh-base/cordis.patch.yml) — we reuse their registered definitions.
//
// Remote branches:
//   bash       → ctx.sshPool.acquire(hostCfg) → conn.exec(cmd, {cwd, timeoutMs}) → official-shaped ShellRunResult
//   read       → sftp.stat + readText (size-capped) → local buildWindow → official-shaped {path,offset,lines,totalLines}
//   write      → sftp.writeFileAtomic (temp file + rename) → official-shaped {path,operation,before,after}
//   edit       → sftp readText → local applyLiteralEdit semantics → writeFileAtomic write-back (single round trip)
//   read_image → sftp.readBytes (capped) → ctx.attachments.saveImage → official-shaped {path,image}
//   glob       → remote find (conservative -name filter + mtime sort) → local rgGlobToRegExp exact filter → official-shaped {root,paths}
//   grep       → remote grep -rInHE (-I binary / hidden exclusion / include brace expansion / timeout) → official-shaped {matches:[{path,lineNumber,line}]}
// Errors are uniformly converted to a message carrying hostId/stage/remote command/exit code/output tail — never silent.
import { ESCALATION_TARGETS, approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox';
import { buildSearchCaps, createGlobTool, createGrepTool } from './tools/search.js';
import { buildFsCaps, createReadTool, createWriteTool, createEditTool, createReadImageTool } from './tools/fs.js';
import { createBashTool } from './tools/bash.js';
import { readHostsDoc } from './src/settings.js';

export const name = '@dsh-ssh/dsh-ssh-tools';
// shell/fs are injected to read sandboxMode, matching how the official tools advertise
// sandbox_permissions/justification (official tool-bash injects 'shell', tool-fs injects 'fs').
export const inject = ['tools', 'shell', 'fs'];
// ═══════════════════════════════════════════════════════════════════════════
// Routing / remote execution helpers
// ═══════════════════════════════════════════════════════════════════════════
function getHostConfig(ctx, hostId) {
  let hosts = {};
  try {
    const settings = ctx.get('settings');
    if (settings && typeof settings.get === 'function') {
      hosts = readHostsDoc((ns) => settings.get(ns)).hosts;
    }
  } catch { hosts = {}; }
  const host = hosts[hostId];
  if (!host || typeof host !== 'object') {
    throw new Error(`remote host "${hostId}" is not configured in dsh-ssh-hosts — add it in Settings → SSH hosts, or the workspace placeholder refers to a removed host`);
  }
  return { ...host, id: hostId };
}

async function acquireRemote(ctx, hostId) {
  const pool = ctx.get('sshPool');
  if (!pool || typeof pool.acquire !== 'function') {
    throw new Error('sshPool service unavailable — is the @dsh-ssh/dsh-ssh host plugin (bundle) loaded? (tools need the bundle patch row "@dsh-ssh/dsh-ssh")');
  }
  const cfg = getHostConfig(ctx, hostId);
  const conn = await pool.acquire(cfg);
  return { pool, conn, cfg };
}

function abortIfSignalled(exec) {
  if (exec && exec.signal && exec.signal.aborted) {
    const e = new Error('tool call aborted');
    e.name = 'AbortError';
    throw e;
  }
}

// ── Remote sandbox permissions (fence at the tool layer; mirrors official resolvePolicy/approveEscalation) ──
// Session effective mode = ctx.sandboxPolicy.resolve({session}).mode (session-level override beats the
// deployment default); falls back to the fs/shell sandboxMode capability facts; when none exist (no sandbox
// backend), treat as danger-full-access.
function resolveRemoteSandboxMode(ctx, exec) {
  const policy = ctx.get('sandboxPolicy');
  if (policy && typeof policy.resolve === 'function') {
    const resolved = policy.resolve(exec && exec.agent ? { session: exec.agent.session } : {});
    if (resolved && typeof resolved.mode === 'string') return resolved.mode;
  }
  const fsMode = ctx.get('fs')?.sandboxMode;
  if (fsMode !== undefined) return fsMode;
  const shellMode = ctx.get('shell')?.sandboxMode;
  if (shellMode !== undefined) return shellMode;
  return 'danger-full-access';
}

// Resolve the mutation "effective interception mode" (read-only | workspace-write | danger-full-access).
// The effective mode always comes from resolveRemoteSandboxMode and is independent of escalationModes —
// even when the remote-routing context (remoteRouting) disables escalation, the three-mode denial semantics
// in policy.js are preserved as-is.
// escalationModes only control the "escalation lever": approval (approveEscalation) runs only when >0 and
// the model explicitly passed sandbox_permissions; at 0, remote escalation is meaningless (approval can only
// relax the local executor, not the remote path) — bail with the official-shaped "unavailable" message
// (mirroring dsh-tool-fs resolvePolicy / dsh-tool-bash approveBashEscalation: "sandbox_permissions is not
// available in this composition"). The official path also errors under danger-full-access (approveEscalation's
// "not strictly wider"), so only the schema exposure is adjusted here, not the behavior.
async function resolveRemoteEffectiveMode(ctx, exec, args, toolName, escalationModes, subject) {
  validateEscalationArgs(args.sandbox_permissions, args.justification);
  const standingMode = resolveRemoteSandboxMode(ctx, exec);
  if (args.sandbox_permissions === void 0 || args.justification === void 0) return standingMode;
  if (escalationModes.length === 0) {
    const capability = subject === 'command' ? 'executor' : 'filesystem';
    throw new Error(`sandbox_permissions is not available in this composition (no sandboxing ${capability} to escalate)`);
  }
  return approveEscalation(
    {
      requestedMode: args.sandbox_permissions,
      effectiveMode: standingMode,
      justification: args.justification,
      subject,
    },
    {
      approver: ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName,
      signal: exec.signal,
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool definition construction + registration (the reusable form for preset-independent routing).
// buildRoutedToolDefinitions(ctx, config): pure construction of the seven tool defs (no registration).
// registerRoutedTools(agentCtx, names, config): registers each named def on agentCtx.tools.
//   - apply(ctx) (remoteRouting=false, local-delegation mode) registers all seven, for tests/verify scripts;
//   - the agent/created hook in index.js registers on the agent's own scope (shadowing preset official tools).
// ═══════════════════════════════════════════════════════════════════════════
export const ROUTED_TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep'];
// Marker for routed tools (a non-enumerable Symbol set on each def at registration; for debug/verify: a
// tool in the agent's view carrying this marker is a routed implementation).
export const ROUTED_TOOL_MARKER = Symbol('@dsh-ssh/dsh-ssh/routed-tool');

function buildRoutedToolDefinitions(ctx, config = {}) {
  const fsCaps = buildFsCaps(config);
  const backgroundEnabled = config.enableRunInBackground ?? true;
  // remoteRouting=true marks a "pure remote routing" registration (agent/created hook, only serves
  // remote-cwd sessions/subagents): the remote has no local sandbox runner, so escalation (approval only
  // relaxes the local executor) is meaningless for remote paths → escalationModes is always empty and
  // sandbox_permissions/justification never enter the schema — matching official behavior, which writes
  // those two fields only when escalationModes.length > 0 (dsh-tool-fs/lib/index.js L617/L771,
  // dsh-tool-bash/lib/index.js L285).
  // Default false: remoteRouting=false is the local-delegation mode (now used only by apply() for
  // tests/verify), keeping local escalation semantics identical to official.
  const remoteRouting = config.remoteRouting === true;
  const bashEscalationModes = remoteRouting ? [] : (ctx.get('shell')?.sandboxMode === undefined ? [] : ESCALATION_TARGETS);
  const fsEscalationModes = remoteRouting ? [] : (ctx.get('fs')?.sandboxMode === undefined ? [] : ESCALATION_TARGETS);
  const searchCaps = buildSearchCaps(config);

  // Local branch: delegate to the official same-named tool registered in the host composition
  // (byte-for-byte identical). If missing (e.g. tool-bash disabled on win32) → a clear error.
  function delegateLocal(toolName, args, exec) {
    const official = ctx.tools.get(toolName);
    if (official === undefined) {
      throw new Error(`tool "${toolName}" is unavailable locally: the official @deepseek-ai/dsh-tool-* implementation is not registered in this composition`);
    }
    return official.execute(args, exec);
  }

  return {
  bash: createBashTool({ ctx, backgroundEnabled, bashEscalationModes, delegateLocal, acquireRemote, abortIfSignalled, resolveRemoteEffectiveMode }),

  read: createReadTool({ ctx, fsCaps, delegateLocal, acquireRemote, abortIfSignalled }),

  write: createWriteTool({ ctx, fsCaps, fsEscalationModes, delegateLocal, acquireRemote, abortIfSignalled, resolveRemoteEffectiveMode }),

  edit: createEditTool({ ctx, fsCaps, fsEscalationModes, delegateLocal, acquireRemote, abortIfSignalled, resolveRemoteEffectiveMode }),

  read_image: createReadImageTool({ ctx, delegateLocal, acquireRemote, abortIfSignalled }),
  glob: createGlobTool({ ctx, searchCaps, delegateLocal, acquireRemote, abortIfSignalled }),

  grep: createGrepTool({ ctx, searchCaps, delegateLocal, acquireRemote, abortIfSignalled }),

  };
}

/**
 * Register the named routed tools on agentCtx.tools. names must be a subset of ROUTED_TOOL_NAMES; an unknown
 * name throws (the caller converges the list). Returns the registered names.
 */
export function registerRoutedTools(agentCtx, names, config = {}) {
  const defs = buildRoutedToolDefinitions(agentCtx, config);
  const registered = [];
  for (const name of names) {
    const def = defs[name];
    if (def === undefined) {
      throw new Error('[@dsh-ssh/dsh-ssh] unknown routed tool name "' + name + '" (expected one of: ' + ROUTED_TOOL_NAMES.join('/') + ')');
    }
    Object.defineProperty(def, ROUTED_TOOL_MARKER, { value: true }); // mark routed tool (non-enumerable)
    agentCtx.tools.register(def);
    registered.push(name);
  }
  return { names: registered };
}

// apply(ctx): registers all seven same-named routed tools on ctx (remoteRouting=false, local-delegation
// mode). Production routing goes through the agent/created hook in index.js via registerRoutedTools with
// remoteRouting=true; this apply() is only a registration helper for tests and verify scripts.
export function apply(ctx, config = {}) {
  registerRoutedTools(ctx, ROUTED_TOOL_NAMES, config);
  ctx.logger?.info('[@dsh-ssh/dsh-ssh] tools registered: bash/read/write/edit/read_image/glob/grep');
}
