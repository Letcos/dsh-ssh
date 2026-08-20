// @dsh-ssh/dsh-ssh — 真实组合端到端: 远端后台任务(秒完成)bug 复现+修复验证(A.35)。
// 同 verify-agent-created.mjs 装配(真实 cordis host + 真实插件 bundle + agent/created 钩子,
// 排除 web-app), 但走 tools registry 拿 scoped bash 工具, 以 run_in_background:true 调它,
// 再经真实 jobs registry(job_output/job_list/job_kill 同源)验证: sleep 30 @5s running + 增量输出 + kill 灭进程组。
// 用法: node scripts/verify-remote-bg-created.mjs
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
const REMOTE_PATH = '/home/ubuntu/trans-ai-web';
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

// 独立 SSH conn(复用宿主 sshPool 服务)用于远端证据 + 复现条件制造
const sshPool = ctx.get('sshPool');
const conn = await sshPool.acquire(HOST_CFG);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 复现条件: 确保 jobDir 不存在(startRemoteBackground 用 defaultRemoteJobDir 从不自查建目录)
await conn.exec('rm -rf ' + JOB_DIR, { timeoutMs: 10000 });
const pre = await conn.exec('ls -ld ' + JOB_DIR + ' 2>&1 || echo NOEXIST', { timeoutMs: 10000 });
log('pre-state jobDir: ' + JSON.stringify(pre.stdout.trim()));

// ── 通过 scoped bash 工具起后台任务 ────────────────────────────────────────
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

// @2s: 应仍 running, readOutput 增量含 TICK-1
await sleep(2000);
let rd = jobs.read(jobId, caller);
log('@2s status=' + rd.snapshot.status + ' detail=' + JSON.stringify(rd.snapshot.detail) + ' output=' + JSON.stringify(rd.text.slice(0, 80)));
if (rd.snapshot.status !== 'running') throw new Error('BUG: job not running at 2s -> status=' + rd.snapshot.status + ' (' + JSON.stringify(rd.snapshot.detail) + ') OUTPUT=' + JSON.stringify(rd.text));

// @5s: 必须仍 running(A.33/A.35 验收)
await sleep(3000);
rd = jobs.read(jobId, caller);
log('@5s status=' + rd.snapshot.status + ' detail=' + JSON.stringify(rd.snapshot.detail) + ' incremental=' + JSON.stringify(rd.text.slice(0, 80)));
if (rd.snapshot.status !== 'running') throw new Error('BUG: job completed prematurely at 5s: ' + rd.snapshot.status + ' ' + JSON.stringify(rd.snapshot.detail));
// readOutput 是游标增量: TICK-1 已在 @2s 被读过, 现在应无新增(sleep 30 未完成), 仍为 running

// 远端证据: 进程存活 + jobDir 有 log/status/side.txt
const ps = await conn.exec('ps -eo pid,pgid,args | grep -E "sleep 30" | grep -v grep || echo NONE', { timeoutMs: 10000 });
const ls = await conn.exec('ls -la ' + JOB_DIR + ' 2>&1 || echo NOEXIST', { timeoutMs: 10000 });
const side = await conn.exec('cat ' + JOB_DIR + '/side.txt 2>&1 || echo NOFILE', { timeoutMs: 10000 });
log('remote ps(sleep 30): ' + JSON.stringify(ps.stdout.trim()));
log('remote jobDir: ' + JSON.stringify(ls.stdout.trim()));
log('side.txt: ' + JSON.stringify(side.stdout.trim()));
if (!/sleep 30/.test(ps.stdout)) throw new Error('BUG: no sleep 30 process alive on remote');
if (!/side\.txt/.test(ls.stdout)) throw new Error('BUG: jobDir not created / side.txt missing');

// job_kill: 经 registry kill → cancel → 杀进程组 → killed
const killRes = jobs.kill(jobId, caller, 'verify');
log('jobs.kill result=' + JSON.stringify(killRes));
// 立即检查远端进程组是否被灭(独立探针)
const psK = await conn.exec('ps -eo pid,pgid,args | grep -E "sleep 30" | grep -v grep || echo NONE', { timeoutMs: 10000 });
log('immediate after kill , remote ps(sleep 30): ' + JSON.stringify(psK.stdout.trim()));
let ksnap = null;
for (let i = 0; i < 60; i++) {
  ksnap = jobs.get(jobId, caller);
  if (ksnap.status === 'killed' || ksnap.status === 'failed' || ksnap.status === 'completed') break;
  await sleep(400);
}
log('kill settled snapshot: ' + JSON.stringify(ksnap));
if (ksnap.status !== 'killed') throw new Error('BUG: expected killed after kill, got ' + ksnap.status);

const ps2 = await conn.exec('ps -eo pid,pgid,args | grep -E "sleep 30" | grep -v grep || echo NONE', { timeoutMs: 10000 });
log('after kill ps: ' + JSON.stringify(ps2.stdout.trim()));
if (/sleep 30/.test(ps2.stdout)) throw new Error('BUG: sleep 30 still alive after kill');

// 清理 jobDir(仅 /tmp/dsh-ssh-* 可写)
await conn.exec('rm -rf ' + JOB_DIR, { timeoutMs: 10000 }).catch(() => {});
log('RESULT: PASS');
ctx.get('sshPool').release(conn);
await ctx.fiber.dispose();
process.exit(0);
