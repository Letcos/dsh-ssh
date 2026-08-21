// @dsh-ssh/dsh-ssh — real composition end-to-end: remote background job verification.
// Assembles like verify-agent-created.mjs (real cordis host + real plugin bundle + agent/created hook,
// excluding web-app), but obtains the scoped bash tool via tools registry and invokes it with run_in_background:true,
// then verifies via the real jobs registry (job_output/job_list/job_kill same source): sleep 30 @5s running + incremental output + kill terminates process group.
// Usage: node scripts/verify-remote-bg-created.mjs
// PREREQ: a DSH core install (install anchor) — resolved via DSH_SSH_DSH_NODE_MODULES or the
// probed default in test/live-config.mjs; DSH_HOME via DSH_SSH_DSH_HOME (default ~/.dsh);
// profile via DSH_SSH_TEST_PROFILE. Switch machines by exporting those plus the DSH_SSH_TEST_*
// host vars (host/port/user/hostId/keyPath) from live-config.mjs. Uses only /tmp/dsh-ssh-* on the remote.
import path from 'node:path';
import { liveConfig, liveHostConfig, dshNodeModules, dshHome, profile as dshTestProfile, requireRealHost } from '../test/live-config.mjs';
requireRealHost('scripts/verify-remote-bg-created');

const CORE = dshNodeModules;
const appBootUrl = 'file:///' + (CORE + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').replace(/\\/g, '/');
const { boot, loadProfile, composeEntries } = await import(appBootUrl);

process.env.DSH_HOME = dshHome;

const NAME = 'dsh-verify-bg';
const INSTALL_ANCHOR = CORE + '/package.json';
const SHIPPED_PRESET_ROOT = CORE + '/config/agent-presets/';

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

const router = await import(new URL('../src/router.js', import.meta.url).href);
const { mapRemoteToLocal } = router;

const HOST_ID = liveConfig.hostId;
const REMOTE_PATH = liveConfig.remoteWorkspace;
const placeholderCwd = mapRemoteToLocal(HOST_ID, REMOTE_PATH);
const JOB_DIR = '/tmp/dsh-ssh-jobs-' + HOST_ID;
const HOST_CFG = { ...liveHostConfig({ id: HOST_ID }) };

const log = (m) => console.log('[bg-created]', m);

const agents = ctx.get('agents');
if (!agents) throw new Error('agents service unavailable');

const { agent: remoteAgent } = await agents.create({
  sessionId: 'session-bg-' + Date.now(),
  meta: { cwd: placeholderCwd, agentPreset: 'standard' },
  agentOptions: { provider: 'fusion-router', model: 'deepseek-v4-flash' },
});

const bashTool = remoteAgent.ctx.tools.get('bash', remoteAgent);
if (!bashTool) throw new Error('bash tool not visible on remote-cwd agent');
log('bash tool resolved');

const jobs = remoteAgent.ctx.get('jobs');
if (!jobs || typeof jobs.start !== 'function') throw new Error('jobs service missing in composition');
log('jobs service present (LocalJobRegistry)');

// Independent SSH conn (reusing host sshPool service) for remote evidence + reproduction setup
const sshPool = ctx.get('sshPool');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let conn = null;
let failed = false;
try {
  conn = await sshPool.acquire(HOST_CFG);

  // Reproduction setup: ensure jobDir does not exist (startRemoteBackground uses defaultRemoteJobDir and never checks/creates it)
  await conn.exec('rm -rf ' + JOB_DIR, { timeoutMs: 10000 });
  const pre = await conn.exec('ls -ld ' + JOB_DIR + ' 2>&1 || echo NOEXIST', { timeoutMs: 10000 });
  log('pre-state jobDir: ' + JSON.stringify(pre.stdout.trim()));

  // ── Start background job via scoped bash tool ────────────────────────────────────────
  const execCtx = { agent: remoteAgent, signal: undefined };
  const startRes = await bashTool.execute(
    { command: 'echo TICK-1; echo SIDE > ' + JOB_DIR + '/side.txt; sleep 30; echo DONE', description: 'verify remote bg job', run_in_background: true },
    execCtx,
  );
  log('bash run_in_background result: ' + JSON.stringify(startRes));
  if (startRes.kind !== 'background' || !startRes.jobId) throw new Error('expected background jobId, got ' + JSON.stringify(startRes));
  const jobId = startRes.jobId;
  log('jobId=' + jobId);

  const caller = remoteAgent;

  // @2s: should still be running, readOutput increment contains TICK-1 (sync contract: read is not awaited)
  await sleep(2000);
  let rd = jobs.read(jobId, caller);
  log('@2s status=' + rd.snapshot.status + ' detail=' + JSON.stringify(rd.snapshot.detail) + ' output=' + JSON.stringify(rd.text.slice(0, 80)));
  if (typeof rd.text !== 'string') throw new Error('readOutput not string (sync contract violated): ' + typeof rd.text);
  if (!/TICK-1/.test(rd.text)) throw new Error('job_output missing TICK-1 at 2s: ' + JSON.stringify(rd.text));
  if (rd.snapshot.status !== 'running') throw new Error('job not running at 2s -> status=' + rd.snapshot.status + ' (' + JSON.stringify(rd.snapshot.detail) + ') OUTPUT=' + JSON.stringify(rd.text));

  // @5s: must still be running
  await sleep(3000);
  rd = jobs.read(jobId, caller);
  log('@5s status=' + rd.snapshot.status + ' detail=' + JSON.stringify(rd.snapshot.detail) + ' incremental=' + JSON.stringify(rd.text.slice(0, 80)));
  if (rd.snapshot.status !== 'running') throw new Error('job completed prematurely at 5s: ' + rd.snapshot.status + ' ' + JSON.stringify(rd.snapshot.detail));
  // readOutput is cursor-incremental: TICK-1 was already read at @2s, now there should be no new output (sleep 30 not yet done), still running

  // Remote evidence: process alive + jobDir contains log/status/side.txt
  const ps = await conn.exec('ps -eo pid,pgid,args | grep -E "sleep 30" | grep -v grep || echo NONE', { timeoutMs: 10000 });
  const ls = await conn.exec('ls -la ' + JOB_DIR + ' 2>&1 || echo NOEXIST', { timeoutMs: 10000 });
  const side = await conn.exec('cat ' + JOB_DIR + '/side.txt 2>&1 || echo NOFILE', { timeoutMs: 10000 });
  log('remote ps(sleep 30): ' + JSON.stringify(ps.stdout.trim()));
  log('remote jobDir: ' + JSON.stringify(ls.stdout.trim()));
  log('side.txt: ' + JSON.stringify(side.stdout.trim()));
  if (!/sleep 30/.test(ps.stdout)) throw new Error('no sleep 30 process alive on remote');
  if (!/side\.txt/.test(ls.stdout)) throw new Error('jobDir not created / side.txt missing');

  // job_kill: via registry kill -> cancel -> kill process group -> killed
  const killRes = jobs.kill(jobId, caller, 'verify');
  log('jobs.kill result=' + JSON.stringify(killRes));
  // Immediately check whether the remote process group is terminated (independent probe)
  const psK = await conn.exec('ps -eo pid,pgid,args | grep -E "sleep 30" | grep -v grep || echo NONE', { timeoutMs: 10000 });
  log('immediate after kill , remote ps(sleep 30): ' + JSON.stringify(psK.stdout.trim()));
  let ksnap = null;
  for (let i = 0; i < 60; i++) {
    ksnap = jobs.get(jobId, caller);
    if (ksnap.status === 'killed' || ksnap.status === 'failed' || ksnap.status === 'completed') break;
    await sleep(400);
  }
  log('kill settled snapshot: ' + JSON.stringify(ksnap));
  if (ksnap.status !== 'killed') throw new Error('expected killed after kill, got ' + ksnap.status);

  const ps2 = await conn.exec('ps -eo pid,pgid,args | grep -E "sleep 30" | grep -v grep || echo NONE', { timeoutMs: 10000 });
  log('after kill ps: ' + JSON.stringify(ps2.stdout.trim()));
  if (/sleep 30/.test(ps2.stdout)) throw new Error('sleep 30 still alive after kill');

  // ── Verify completed exit-code branch + ProcessOutcome shape + output file landing ──
  // Covers three acceptance points: completed with exit 3,
  // ProcessOutcome {status, detail} shape, and tee'd file on disk.
  log('--- verifying completed branch (exit 3) ---');
  const startRes2 = await bashTool.execute(
    { command: 'echo START-A; sleep 2; echo DONE-A | tee ' + JOB_DIR + '/a.out; exit 3', description: 'verify completed exit 3', run_in_background: true },
    execCtx,
  );
  log('second job start result: ' + JSON.stringify(startRes2));
  if (startRes2.kind !== 'background' || !startRes2.jobId) throw new Error('expected background jobId for second job, got ' + JSON.stringify(startRes2));
  const jobId2 = startRes2.jobId;
  // Wait for completion (poll via jobs.get); timeout ~10s
  let snap2 = null;
  for (let i = 0; i < 30; i++) {
    snap2 = jobs.get(jobId2, caller);
    if (!snap2) throw new Error('jobs.get returned null for second job');
    if (snap2.status !== 'running') break;
    await sleep(400);
  }
  log('second job snapshot: ' + JSON.stringify(snap2));
  // Completed branch: must be completed with exit code 3 (not killed/failed)
  if (snap2.status !== 'completed') throw new Error('expected completed for exit-3 job, got ' + snap2.status + ' ' + JSON.stringify(snap2.detail));
  // ProcessOutcome shape: {status: string, detail: string} with detail exactly 'exit code: 3'
  if (typeof snap2.status !== 'string' || typeof snap2.detail !== 'string') throw new Error('ProcessOutcome shape invalid: ' + JSON.stringify(snap2));
  if (snap2.detail !== 'exit code: 3') throw new Error('expected detail "exit code: 3", got ' + JSON.stringify(snap2.detail));
  // Output file landing: DONE-A must be retrievable via incremental read and via remote file
  const rd2 = jobs.read(jobId2, caller);
  log('second job readOutput: ' + JSON.stringify(rd2.text.slice(0, 120)) + ' snapshot=' + JSON.stringify(rd2.snapshot));
  if (typeof rd2.text !== 'string') throw new Error('readOutput not string for completed job: ' + typeof rd2.text);
  // The incremental read after completion should contain DONE-A (or START-A if cursor already advanced)
  const combined2 = rd2.text;
  if (!/DONE-A/.test(combined2)) {
    // Try one more read in case cursor split across polls
    const rd2b = jobs.read(jobId2, caller);
    if (!/DONE-A/.test(rd2b.text) && !/DONE-A/.test(combined2 + rd2b.text)) {
      throw new Error('completed job output missing DONE-A: ' + JSON.stringify(combined2) + ' / ' + JSON.stringify(rd2b.text));
    }
  }
  const catA = await conn.exec('cat ' + JOB_DIR + '/a.out 2>&1 || echo NOFILE', { timeoutMs: 10000 });
  log('a.out content: ' + JSON.stringify(catA.stdout.trim()));
  if (!/DONE-A/.test(catA.stdout)) throw new Error('output file not landed on disk (a.out missing DONE-A): ' + JSON.stringify(catA.stdout));

  log('RESULT: PASS');
} catch (err) {
  failed = true;
  console.error('[bg-created] FAILED:', err?.message ?? err);
} finally {
  if (conn) {
    try { await conn.exec('rm -rf ' + JOB_DIR, { timeoutMs: 10000 }); } catch { /* best effort */ }
    try { ctx.get('sshPool').release(conn); } catch { /* best effort */ }
  }
  try { await ctx.fiber.dispose(); } catch { /* best effort */ }
}
if (failed) process.exit(1);
process.exit(0);
