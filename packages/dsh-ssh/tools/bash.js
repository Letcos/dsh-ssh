// @dsh-ssh/dsh-ssh — bash tool extracted from tools.js via mechanical slice
// Provides REMOTE_EXEC_DEFAULT_TIMEOUT + createBashTool and bash-exclusive helpers
// (streamText/renderResult/bashDescription/validateBashArgs/presentBashCall/presentBashResult/canonicalBashResult/startRemoteBackground).
// Plain JS/ESM, no build step.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { parseExitStatus } from '@deepseek-ai/dsh-shell';
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox';
import { routeByCwd } from '../src/router.js';
import { SshError } from '../src/ssh-core.js';
import { createRemoteBashJobHooks, defaultRemoteJobDir, killForegroundTree } from '../src/remote-jobs.js';

export const REMOTE_EXEC_DEFAULT_TIMEOUT = 60_000;

// local error formatter (mirrors tools.js toolErrorText; duplicated to keep bash domain self-contained)
function toolErrorText(err, hostId, extra) {
  const stage = err && err.stage ? ' (' + err.stage + ')' : '';
  const msg = err && err.message ? err.message : String(err);
  return '[@dsh-ssh/dsh-ssh] host ' + hostId + stage + ': ' + msg + (extra ? ' [' + extra + ']' : '');
}

// ═══════════════════════════════════════════════════════════════════════════
// bash render / description (verbatim from dsh-tool-bash/lib/index.js)
// ═══════════════════════════════════════════════════════════════════════════
export function streamText(output) {
  if (!output.truncated) return output.text;
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? "(unavailable)"}]`;
}

export function renderResult(result, escalationModes = []) {
  const out = streamText(result.stdout);
  const err = streamText(result.stderr);
  let body = out;
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += `[stderr]\n${err}`;
  }
  if (body.length === 0) body = "(no output)";
  const markers = [];
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode));
    if (escalationModes.length > 0) markers.push(escalationHintMarker("command"));
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`);
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`);
  if (markers.length === 0) return body;
  if (!body.endsWith("\n")) body += "\n";
  return body + markers.join("\n");
}

export function bashDescription(backgroundEnabled, escalationModes) {
  const background = backgroundEnabled
    ? "Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`."
    : "Background execution is not available; long-running commands must finish within the timeout.";
  const base = `Execute a bash command (\`bash -c\`) and return its stdout/stderr. Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass \`workdir\` instead of using \`cd\`. Non-zero exits are reported as \`[exit code: N]\`. Current harness environment facts are exposed through managed \`$DSH_*\` variables; inspect them when needed. Commands may run under a file sandbox; a blocked file operation is reported as \`[sandbox: file access denied under <mode> mode]\` — a policy denial, not a bug in the command; do not retry another way. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. ` + background + ' In a remote (SSH) workspace there is no sandbox runner on the remote host, so the file-policy write boundary is not enforced per-file there: under read-only the remote command is refused outright, and under workspace-write it runs with the remote user\'s full privileges.';
  if (escalationModes.length === 0) return base;
  return base + " Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.";
}

export function validateBashArgs(args) {
  if (args.command.trim().length === 0) throw new Error("invalid command: expected a non-empty string");
  if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
  if (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
}

export function presentBashCall(args) {
  if (args.run_in_background === true) return {
    card: "generic", title: args.command, kind: "execute", rawInput: args.command,
    content: [{ type: "text", text: args.description }],
  };
  return {
    card: "terminal", title: args.command, description: args.description,
    ...args.workdir !== void 0 ? { cwd: args.workdir } : {},
  };
}

export function presentBashResult(args, result) {
  const block = result.content.length === 1 ? result.content[0] : void 0;
  if (block === void 0 || block.type !== "text") return void 0;
  const raw = block.text;
  if (typeof args === "object" && args !== null && args.run_in_background === true || result.isError) {
    return { card: "generic", content: [{ type: "text", text: `\`\`\`console\n${raw.replace(/\n+$/, "")}\n\`\`\`` }] };
  }
  const { body, ...exit } = parseExitStatus(raw);
  return { card: "terminal", output: body, ...exit };
}

export const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: "string", required: true, const: "background" },
  jobId: { type: "string", required: true },
};

export function canonicalBashResult(result) {
  const output = (stream) => ({
    text: stream.text, truncated: stream.truncated,
    ...stream.spillPath !== void 0 ? { spillPath: stream.spillPath } : {},
  });
  return {
    exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
    aborted: result.aborted, timeoutMs: result.timeoutMs,
    stdout: output(result.stdout), stderr: output(result.stderr),
    ...result.sandbox !== void 0 ? { sandbox: { mode: result.sandbox.mode, denied: result.sandbox.denied, ...result.sandbox.enforcement !== void 0 ? { enforcement: result.sandbox.enforcement } : {}, ...result.sandbox.runnerFailed !== void 0 ? { runnerFailed: result.sandbox.runnerFailed } : {} } } : {},
  };
}

// Remote bash background jobs: integrate with the official jobs contract (ctx.get('jobs').start) and
// return {kind:'background', jobId}. Duplicated pattern: acquires sshPool, validates signal.
export async function startRemoteBackground(ctx, exec, args, route, acquireRemote, abortIfSignalled) {
  const jobs = ctx.get('jobs');
  if (jobs === void 0 || typeof jobs.start !== 'function') {
    throw new Error('[@dsh-ssh/dsh-ssh] background jobs unavailable: the jobs service (dsh-jobs) is not mounted in this composition; load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs');
  }
  if (typeof abortIfSignalled === 'function') abortIfSignalled(exec);
  else if (exec && exec.signal && exec.signal.aborted) {
    const e = new Error('tool call aborted');
    e.name = 'AbortError';
    throw e;
  }
  const acquire = acquireRemote ?? (async (c, hostId) => {
    const pool = c.get('sshPool');
    if (!pool || typeof pool.acquire !== 'function') throw new Error('sshPool service unavailable');
    // fallback simple acquire without getHostConfig host resolution (for standalone calls)
    const conn = await pool.acquire({ id: hostId });
    return { pool, conn };
  });
  const { pool, conn } = await acquire(ctx, route.hostId);
  try {
    const jobId = jobs.start({
      kind: 'bash',
      label: args.command,
      ...exec.agent ? { owner: exec.agent } : {},
      run: () => createRemoteBashJobHooks({
        conn,
        cmd: args.command,
        cwd: route.remoteCwd,
        hostId: route.hostId,
        jobDir: defaultRemoteJobDir(route.hostId),
      }),
    });
    return { kind: 'background', jobId };
  } finally {
    pool.release();
  }
}

// ── bash tool factory ──────────────────────────────────────────────────
export function createBashTool({ ctx, backgroundEnabled, bashEscalationModes, delegateLocal, acquireRemote, abortIfSignalled, resolveRemoteEffectiveMode }) {
  return defineTool({
    name: 'bash',
    description: bashDescription(backgroundEnabled, bashEscalationModes),
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: { type: 'string', required: true, description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
      ...backgroundEnabled ? { run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' } } : {},
      ...bashEscalationModes.length > 0 ? {
        sandbox_permissions: { type: 'string', enum: [...bashEscalationModes], description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.' },
        justification: { type: 'string', description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.' },
      } : {},
    },
    output: {
      schema: { oneOf: [
        { type: 'object', additionalProperties: false, properties: BACKGROUND_OUTPUT_PROPERTIES },
        { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true },
          timeoutMs: { type: 'number', required: true },
          stdout: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' } } },
          stderr: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' } } },
          sandbox: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', required: true }, denied: { type: 'boolean', required: true }, enforcement: { type: 'string' }, runnerFailed: { type: 'boolean' } } },
        } },
      ] },
      render: (_args, value) => [{ type: 'text', text: value.kind === 'background' ? `started background job ${value.jobId}` : renderResult(value, bashEscalationModes) }],
    },
    async execute(args, exec) {
      validateBashArgs(args);
      const cwd = exec.agent?.session?.header?.cwd;
      const route = routeByCwd(cwd);
      if (route.kind === 'local') return delegateLocal('bash', args, exec);
      abortIfSignalled(exec);
      const mode = await resolveRemoteEffectiveMode(ctx, exec, args, 'bash', bashEscalationModes, 'command');
      const timeoutMs = args.timeoutMs ?? REMOTE_EXEC_DEFAULT_TIMEOUT;
      if (mode === 'read-only') {
        return { kind: 'foreground', exitCode: null, signal: null, timedOut: false, aborted: false, timeoutMs, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: 'read-only', denied: true } };
      }
      if (args.run_in_background === true) {
        if (!backgroundEnabled) throw new Error("run_in_background is disabled for this deployment (enableRunInBackground: false)");
        return startRemoteBackground(ctx, exec, args, route, acquireRemote, abortIfSignalled);
      }
      const { pool, conn } = await acquireRemote(ctx, route.hostId);
      try {
        const r = await conn.exec(args.command, { cwd: route.remoteCwd, timeoutMs });
        return {
          kind: 'foreground',
          exitCode: r.code === -1 ? null : r.code,
          signal: r.signal ?? null,
          timedOut: false, aborted: false, timeoutMs,
          stdout: { text: r.stdout, truncated: false },
          stderr: { text: r.stderr, truncated: false },
        };
      } catch (err) {
        if (err instanceof SshError && err.stage === 'exec-timeout') {
          await killForegroundTree(conn, args.command, route.remoteCwd);
          return { kind: 'foreground', exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } };
        }
        throw new Error(toolErrorText(err, route.hostId, 'command: ' + args.command));
      } finally {
        pool.release();
      }
    },
    presentCall: presentBashCall,
    presentResult: presentBashResult,
  });
}
