// @dsh-ssh/dsh-ssh — remote bash background jobs: pure helpers + job hooks.
// Integrates with the official jobs contract:
//   execute(run_in_background) → ctx.get('jobs').start({ run, kind:'bash', label, owner })
//     → {kind:'background', jobId}
// The three controllers (job_output/job_list/job_kill) work unchanged because
// they only see the ctx.jobs registry.
//
// Two hard constraints that must hold:
//   ① A background command must be a single async command with cd embedded in
//      bash -c (a chained background command would hang):
//        setsid bash -c 'cd <cwd> && ( <cmd> ); ec=$?; printf "%s\n" "$ec" > <status>'
//          ><log> 2>&1 </dev/null & echo $!
//   ② Kill must cover the whole process tree (bash starts under setsid, so the
//      background bash is the leader of its own session/process group and its PID
//      equals its pgid):
//        kill -TERM -- -<pid> 2>/dev/null; pkill -TERM -P <pid> 2>/dev/null; true
//
// Each composed command is a single exec (sent over the ssh2 channel; no
// persistent channel needed). Redirecting the background process to a log file
// lets it outlive the channel. Output is collected by incrementally reading the
// log file with a cursor (equivalent to job_output); done polls the status file
// plus process-alive probes to derive the final state.
//
// Key contract: the official registry (dsh-jobs-local) calls job.readOutput()
// without awaiting it (dsh-jobs-local/lib/index.js L190) and returns its value
// directly as the job_output text field, which must be a string (lossless JSON).
// So readOutput must return a string synchronously (a Promise would make
// job_output report `value is not lossless JSON`). The official bash reads a
// process-local in-memory buffer synchronously (dsh-tool-bash/lib/index.js L423 /
// renderProcessRead); here the log lives in a remote file and can only be fetched
// over async SFTP, so the done loop asynchronously refreshes a local buffered copy
// and readOutput synchronously advances a cursor over it. job_output is poll-based:
// each call moves the cursor forward and the next call returns the delta.
//
// run() returns exactly {cancel, done, readOutput} per the official contract
// (dsh-tool-bash/lib/index.js L418-425). _meta/_state/_spawned/_refresh are only
// for tests/ops introspection and are mounted as non-enumerable properties, so
// they never enter registry records or serialization. The done resolution shape
// per-field matches the official ProcessOutcome (dsh-tool-bash/lib/index.js
// L21-30): completed → {status:'completed', detail:'exit code: N'}; killed →
// {status:'killed', detail:'signal: TERM'}.
import { SshError, shellQuoteSingle } from './ssh-core.js';

// Default poll interval (ms), overridable via config.remoteJobPollMs.
export const DEFAULT_POLL_MS = 400;

export function defaultRemoteJobDir(hostId) {
  return '/tmp/dsh-ssh-jobs-' + (hostId || 'host');
}

// Random token: makes log/status file names unique per host. It is independent of
// the registry-generated jobId (jobs.start only assigns an id after run(), so no id
// is available inside run(); our own token is used as the file suffix).
function token() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^$[\]{}()|/\\]/g, '\\$&');
}

// ── Pure command assembly (unit-testable) ─────────────────────────────────────
// Background start command: setsid starts the process in its own session/process
// group; the whole thing is a single command (no outer && chain) with cd embedded
// inside bash -c.
export function buildSpawnCommand({ cmd, cwd, logPath, statusPath }) {
  const inner = 'cd ' + shellQuoteSingle(cwd) + ' && ( ' + cmd + ' ); ec=$?; printf "%s\n" "$ec" > ' + shellQuoteSingle(statusPath);
  return 'setsid bash -c ' + shellQuoteSingle(inner) + ' >' + shellQuoteSingle(logPath) + ' 2>&1 </dev/null & echo $!';
}

// Process-tree kill command: the background bash is the setsid group leader, so
// PID==pgid — a negative PID kills the whole group; descendants are then killed recursively.
export function buildKillTreeCommand(pid) {
  return 'kill -TERM -- -' + pid + ' 2>/dev/null; pkill -TERM -P ' + pid + ' 2>/dev/null; true';
}

// Process-alive probe (used by the done loop to decide termination).
export function buildAliveProbeCommand(pid) {
  return 'kill -0 ' + pid + ' 2>/dev/null && echo ALIVE || echo DEAD';
}

// Foreground-timeout process-tree kill: match the remote cmdline exactly with the
// full "cd <cwd> && <cmd>" text (regex-escaped) so no other task is killed.
export function buildForegroundTreeKillCommand(cmd, cwd) {
  const pattern = escapeRegex('cd ' + (cwd ? cwd + ' && ' : '') + cmd);
  return 'pkill -TERM -f ' + shellQuoteSingle(pattern) + ' 2>/dev/null; true';
}

// Parse the "$!" PID from the spawn command's stdout (strips whitespace/trailing).
export function parseSpawnPid(text) {
  const m = /^\s*(\d+)\s*$/.exec(String(text || '').trim());
  return m ? Number(m[1]) : null;
}

// ── Runtime job hooks ────────────────────────────────────────────────────────
// Called inside jobs.start's run() (must return hooks synchronously; the actual
// spawn is async). conn: an acquired SshConn; kind: the kind used for registration
// (official bash uses 'bash').
// Returns { cancel, done, readOutput }; startup info (_meta/_state) is attached for tests.
export function createRemoteBashJobHooks({ conn, cmd, cwd, hostId, jobDir, pollMs }) {
  const t = token();
  const logPath = jobDir + '/' + t + '.log';
  const statusPath = jobDir + '/' + t + '.status';
  const interval = pollMs ?? DEFAULT_POLL_MS;
  const state = { cancelled: false, pid: null };

  const spawned = (async () => {
    // Ensure the remote jobDir exists first (mkdir -p, idempotent). Real service
    // startRemoteBackground uses defaultRemoteJobId(hostId) as jobDir but never mkdirs
    // it — if the directory is missing, the spawn's >log redirect fails to open, the
    // background process dies immediately, no log/status/side-effect files land on
    // disk, and the done poll sees !alive && ec===null, misreporting 'completed exit
    // code: 0' (an instant, side-effect-free success). Pre-creating the directory
    // with a single foreground exec avoids that; failure throws.
    await conn.exec('mkdir -p ' + shellQuoteSingle(jobDir), { timeoutMs: 15_000 });
    const spawnCmd = buildSpawnCommand({ cmd, cwd, logPath, statusPath });
    const r = await conn.exec(spawnCmd, { timeoutMs: 15_000 });
    if (r.code === -1) throw new SshError({ hostId, stage: 'spawn', message: 'background spawn channel closed unexpectedly' });
    const pid = parseSpawnPid(r.stdout);
    if (pid === null) {
      throw new SshError({ hostId, stage: 'spawn', message: 'could not parse background pid from output ' + JSON.stringify(r.stdout) });
    }
    state.pid = pid;
    return pid;
  })();
  // Startup failure is left to done (the registry force-fails the record on done
  // rejection); swallow it here to avoid an unhandled rejection.
  spawned.catch(() => {});

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function isAlive() {
    if (state.pid === null) {
      await spawned;
      if (state.pid === null) return true; // 启动失败由 done 兜底
    }
    const r = await conn.exec(buildAliveProbeCommand(state.pid), { timeoutMs: 10_000 });
    return /ALIVE/.test(r.stdout);
  }

  async function readStatusFile() {
    if (state.pid === null) await spawned;
    try {
      const fs = await conn.fs();
      const bytes = await fs.readBytes(statusPath);
      const n = parseInt(String(bytes).trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  async function readLogFile() {
    try {
      const fs = await conn.fs();
      const bytes = await fs.readBytes(logPath);
      return bytes.toString('utf8');
    } catch {
      return '';
    }
  }

  // ── Synchronous readOutput local buffer ─────────────────────────────────
  // The official registry.read() does not await readOutput(); job_output's text
  // must be a string. So readOutput synchronously slices the buffered cursor delta;
  // buffered is filled asynchronously by refreshLog() (from the done loop and test hooks).
  let buffered = '';
  let cursor = 0;
  async function refreshLog() {
    try {
      buffered = await readLogFile();
    } catch {
      /* pull failed (file not ready/deleted): keep the previous buffer */
    }
  }
  // readOutput synchronously returns the buffered text added since the last read (cursor advances by chars).
  const readOutput = () => {
    const delta = buffered.slice(cursor);
    cursor = buffered.length;
    return delta;
  };

  // done: poll until terminated. cancel sets state.cancelled and sends the kill-tree
  // command; cancelled → killed.
  const done = (async () => {
    await spawned; // startup failure throws here → the registry records the job as failed
    await refreshLog(); // first pull of the initial log
    for (;;) {
      await refreshLog(); // refresh the local log buffer on every status/alive probe round
      const alive = await isAlive();
      let status = null;
      if (state.cancelled) {
        if (!alive) status = { status: 'killed', detail: 'signal: TERM' };
      } else {
        const ec = await readStatusFile();
        if (!alive && ec === null) {
          // Process exited without ever writing the status file (ec=null) = it never ran
          // the trailing printf = spawn/startup failed. This must not be flattened to
          // 'completed exit code: 0', which would fake an instant side-effect-free success.
          status = { status: 'failed', detail: 'background process exited before reporting an exit status (' + statusPath + '); spawn/startup failed' };
        } else if (!alive || ec !== null) {
          status = { status: 'completed', detail: 'exit code: ' + (ec ?? 0) };
        }
      }
      if (status !== null) {
        await refreshLog(); // final sync before terminating (grab the full output)
        // Best-effort cleanup of log/status files (job is done); failures are silent.
        const fs = await conn.fs().catch(() => null);
        if (fs) {
          await fs.unlink(statusPath).catch(() => {});
          await fs.unlink(logPath).catch(() => {});
        }
        return status;
      }
      await sleep(interval);
    }
  })();
  done.catch(() => {});

  const hooks = {
    cancel() {
      state.cancelled = true;
      const fire = (pid) => conn.exec(buildKillTreeCommand(pid), { timeoutMs: 10_000 }).catch(() => {});
      if (state.pid !== null) fire(state.pid);
      else spawned.then(fire).catch(() => {});
    },
    done,
    readOutput,
  };
  // Introspection/test fields are non-enumerable so they never appear in registry
  // records, snapshots, or any serialization (invisible to Object.keys/JSON/spread).
  for (const [key, value] of [
    ['_meta', { jobDirText: jobDir, logPath, statusPath }],
    ['_state', state],
    ['_spawned', spawned],
    ['_refresh', refreshLog],
  ]) {
    Object.defineProperty(hooks, key, { value, enumerable: false, configurable: true });
  }
  return hooks;
}

// Foreground-timeout cleanup: assemble and send the kill-tree command (best-effort, silent on failure).
export async function killForegroundTree(conn, cmd, cwd) {
  await conn.exec(buildForegroundTreeKillCommand(cmd, cwd), { timeoutMs: 10_000 }).catch(() => {});
}
