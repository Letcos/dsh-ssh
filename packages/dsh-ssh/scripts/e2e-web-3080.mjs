// @dsh-ssh/dsh-ssh — 3080 full-tool E2E (driven via HTTP API against a real web-app session)
// Purpose: without restarting or stopping 3080, drive a real session only via POST http://127.0.0.1:3080/api/<method> envelopes,
//       run 8 tool cases against the remote placeholder workspace (bash foreground / write / read / edit / glob / grep / bg chain / cleanup),
//       and finally clean up e2e artifacts with bash (keeping the directory).
// Envelope: {"type":"client-request","rpcId":"x","method":"<m>","params":{},"payload":{...}}
//   session.create {cwd,agentPreset:"standard"} -> result.value.sessionId
//   session.selectModel {sessionId,provider,model}
//   session.prompt {sessionId,mode:"queue",content:[{type:"text",text}]}
//   session.history {sessionId} -> result.value.events, each {event:{type,seq,data}}
// Single-turn decision: polling until "a newly added event contains turn/end" means one turn ends (interval 3s, cap 150s).
// Tool results: tool/call.data={callId,name,arguments};
//           tool/result.data.message.content[0]={type:"tool-result",toolCallId,isError,content:[{type:"text",text}]}
// Usage: node scripts/e2e-web-3080.mjs   (service address from live-config.mjs e2eBase, overridable via DSH_SSH_TEST_E2E_BASE / E2E_BASE)
// Exit code: all pass -> 0; any fail -> 1. Output is a PASS/FAIL summary table (<=60 lines).
// PREREQ: a running DSH web-app with this plugin, listening where live-config.mjs e2eBase
// points (default http://127.0.0.1:3080; override DSH_SSH_TEST_E2E_BASE / E2E_BASE).
// Switch machines via DSH_SSH_DSH_HOME + DSH_SSH_TEST_HOST_ID (placeholder root & hostId).
// PREREQ: <REMOTE>/note.txt must be pre-seeded on the remote with content "hello dsh-ssh e2e";
// this script drives a live session and does not create it. REMOTE comes from live-config.mjs
// remoteWorkspace (DSH_SSH_TEST_REMOTE_WORKSPACE override, default /tmp/dsh-ssh-remote-workspace).

import path from 'node:path';
import { liveConfig, requireRealHost } from '../test/live-config.mjs';
requireRealHost('scripts/e2e-web-3080');

const base = liveConfig.e2eBase;
const REMOTE = liveConfig.remoteWorkspace;
// Remote workspaces are local placeholders <dshHome>/remote/<hostId>/<base64url(remote path)>.
const PLACEHOLDER = path.join(liveConfig.dshHome, 'remote', liveConfig.hostId, Buffer.from(REMOTE, 'utf8').toString('base64url'));
const MODEL = 'deepseek-v4-flash';

async function rpc(method, payload = {}) {
  const res = await fetch(base + '/api/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r-' + Math.random().toString(36).slice(2), method, params: {}, payload }),
  });
  return await res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openSession() {
  const sc = await rpc('session.create', { cwd: PLACEHOLDER, agentPreset: 'standard' });
  const sid = sc?.result?.value?.sessionId;
  if (!sid) throw new Error('session.create failed: ' + JSON.stringify(sc).slice(0, 300));
  await rpc('session.selectModel', { sessionId: sid, provider: 'fusion-router', model: MODEL });
  return sid;
}

// Single-session poller: maintains an ingested cursor; after each prompt wait until "a newly added event contains turn/end"
function makePoller(sid) {
  let ingested = 0;
  return async function runTurn(text) {
    await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text }] });
    const t0 = Date.now();
    let ev = [];
    while (Date.now() - t0 < 150000) {
      await sleep(3000);
      const hist = await rpc('session.history', { sessionId: sid });
      const h = (hist.result && hist.result.value) ? hist.result.value.events : [];
      if (h.length > ingested && h.slice(ingested).some((e) => e.event.type === 'turn/end')) { ev = h; break; }
    }
    const newEv = ev.slice(ingested);
    ingested = Math.max(ingested, ev.length);
    // callId -> name pairing for tool/call and tool/result
    const nameById = new Map();
    const results = [];
    for (const it of newEv) {
      const e = it.event;
      if (e.type === 'tool/call') nameById.set(e.data.callId, e.data.name);
      else if (e.type === 'tool/result') {
        const c = e.data.message?.content?.[0];
        const callId = c?.toolCallId;
        const name = callId && nameById.get(callId);
        const text = (c?.type === 'tool-result' && c.content?.[0]?.type === 'text') ? c.content[0].text : JSON.stringify(c);
        results.push({ name, isError: c?.isError === true, text });
      }
    }
    return results;
  };
}

function findBy(results, name, pred) {
  return results.find((r) => r.name === name && (!pred || pred(r)));
}

// ---- Result ledger ----
const rows = [];
function record(no, desc, pass, detail) { rows.push({ no, desc, pass, detail }); }

async function caseBashFront() {
  const sid = await openSession();
  const poll = makePoller(sid);
  let results = await poll('只调用一次 bash 工具执行: hostname && cat ' + REMOTE + '/note.txt；不要文字回复, 不要调用其它工具。立刻调用 bash 工具。');
  let hit = findBy(results, 'bash', (r) => !r.isError && /hello dsh-ssh e2e/.test(r.text));
  if (!hit) {
    results = await poll('你刚才没有正确调用 bash。现在只调用一次 bash 工具执行: hostname && cat ' + REMOTE + '/note.txt；不要文字回复, 不要调用其它工具。');
    hit = findBy(results, 'bash', (r) => !r.isError && /hello dsh-ssh e2e/.test(r.text));
  }
  const any = results.some((r) => r.name === 'bash');
  const errTool = results.some((r) => r.name === 'bash' && r.isError);
  record(1, 'bash 前台(hostname && cat note.txt)', !!hit && any,
    hit ? '输出含 note.txt 内容' : (errTool ? 'bash 报错' : (any ? 'bash 输出缺期望内容' : '未调用 bash 工具')));
}

async function caseWrite() {
  const sid = await openSession();
  const poll = makePoller(sid);
  let results = await poll('只调用一次 write 工具, file_path=' + REMOTE + '/e2e-write.txt, content="dsh-ssh e2e write line one"。不要文字回复, 不要调用其它工具。立刻调用 write。');
  let r = findBy(results, 'write');
  if (!r || r.isError) {
    results = await poll('请只调用一次 write 工具, file_path=' + REMOTE + '/e2e-write.txt, content="dsh-ssh e2e write line one"。不要调用别的工具。');
    r = findBy(results, 'write');
  }
  record(2, 'write 远端写文件', !!r && !r.isError, r ? (r.isError ? 'write 报错' : '写入成功') : '未调用 write');
}

async function caseRead() {
  const sid = await openSession();
  const poll = makePoller(sid);
  let results = await poll('调用一次 read 工具读取 ' + REMOTE + '/e2e-write.txt, file_path=' + REMOTE + '/e2e-write.txt。不要文字回复, 不要调其它工具。');
  let r = findBy(results, 'read', (x) => !x.isError && /line one/.test(x.text));
  if (!r) {
    results = await poll('请只调用一次 read 工具, file_path=' + REMOTE + '/e2e-write.txt。不要调别的工具。');
    r = findBy(results, 'read', (x) => !x.isError && /line one/.test(x.text));
  }
  const any = results.some((x) => x.name === 'read');
  record(3, 'read 读回内容一致', !!r && any, !!r ? '读回含 line one' : (any ? 'read 输出不符' : '未调用 read'));
}

async function caseEdit() {
  const sid = await openSession();
  const poll = makePoller(sid);
  let results = await poll('调用一次 edit 工具, file_path=' + REMOTE + '/e2e-write.txt, old_string="line one", new_string="line one Updated"。不要文字回复, 不要调其它工具。');
  let r = findBy(results, 'edit', (x) => !x.isError && /updated/i.test(x.text));
  if (!r) {
    results = await poll('请只调用一次 edit 工具, 把 ' + REMOTE + '/e2e-write.txt 里的 line one 改成 line one Updated。');
    r = findBy(results, 'edit', (x) => !x.isError && /updated/i.test(x.text));
  }
  const any = results.some((x) => x.name === 'edit');
  record(4, 'edit 修改一行', !!r && any, !!r ? '结果含 updated' : (any ? 'edit 未生效' : '未调用 edit'));
}

async function caseGlob() {
  const sid = await openSession();
  const poll = makePoller(sid);
  let results = await poll('调用一次 glob 工具, pattern="*.txt", path=' + REMOTE + '。不要文字回复, 不要调其它工具。');
  let r = findBy(results, 'glob', (x) => !x.isError);
  if (!r) {
    results = await poll('请只调用一次 glob 工具, 参数 pattern=*.txt, path=' + REMOTE + '。');
    r = findBy(results, 'glob', (x) => !x.isError);
  }
  let n = 0;
  if (r) n = r.text.split(/\r?\n/).filter((l) => l.trim()).length;
  const any = results.some((x) => x.name === 'glob');
  record(5, 'glob pattern *.txt 命中>=2', !!r && n >= 2, !!r ? (n + ' 个命中') : (any ? 'glob 结果为空或异常' : '未调用 glob'));
}

async function caseGrep() {
  const sid = await openSession();
  const poll = makePoller(sid);
  let results = await poll('调用一次 grep 工具, pattern="dsh-ssh e2e", path=' + REMOTE + '。不要文字回复, 不要调其它工具。');
  let r = findBy(results, 'grep', (x) => !x.isError && /dsh-ssh e2e/.test(x.text));
  if (!r) {
    results = await poll('请只调用一次 grep 工具, 参数 pattern=dsh-ssh e2e, path=' + REMOTE + '。');
    r = findBy(results, 'grep', (x) => !x.isError && /dsh-ssh e2e/.test(x.text));
  }
  const any = results.some((x) => x.name === 'grep');
  record(6, 'grep 搜 dsh-ssh e2e 命中', !!r && any, !!r ? '命中' : (any ? 'grep 无命中' : '未调用 grep'));
}

async function caseBgChain() {
  const sid = await openSession();
  const poll = makePoller(sid);
  // 12 x 5s = 60s, ensures job_list still sees running (previously 5x5s=25s completed early due to polling + model generation time)
  const CMD = 'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo TICK-$i; sleep 5; done';
  let results = await poll('调用 bash 工具, run_in_background=true, command: ' + CMD + '。只调用这一次 bash, 不要调其它工具, 不要文字回复。');
  let r = findBy(results, 'bash', (x) => !x.isError && /started background job/.test(x.text));
  if (!r) {
    results = await poll('请只调用一次 bash 工具, run_in_background=true, command: ' + CMD + '。不要调别的工具。');
    r = findBy(results, 'bash', (x) => !x.isError && /started background job/.test(x.text));
  }
  if (!r) { record(7, '后台链(start→list→output→kill)', false, '不会 start 后台任务'); return; }
  const m = r.text.match(/started background job ([A-Za-z0-9-]+)/);
  const jobId = m ? m[1] : null;
  if (!jobId) { record(7, '后台链(start→list→output→kill)', false, '拿不到 jobId'); return; }

  let lres = await poll('调用一次 job_list 工具, 不要调用 bash, 不要再启动任何后台任务, 不要文字回复。');
  let lr = findBy(lres, 'job_list', (x) => !x.isError && new RegExp('^' + jobId + ' .*running').test(x.text));
  if (!lr) { lres = await poll('请只调用一次 job_list 工具, 不要启动任何任务。'); lr = findBy(lres, 'job_list', (x) => !x.isError && new RegExp('^' + jobId + ' .*running').test(x.text)); }
  const listRunning = !!lr;

  let ores = await poll('调用一次 job_output 工具, job_id=' + jobId + ', 不要调用 bash, 不要文字回复。');
  let or = findBy(ores, 'job_output', (x) => !x.isError && /TICK/.test(x.text));
  if (!or) { ores = await poll('请只调用一次 job_output 工具, job_id=' + jobId + '。'); or = findBy(ores, 'job_output', (x) => !x.isError && /TICK/.test(x.text)); }
  const outTick = !!or;

  let kres = await poll('调用一次 job_kill 工具, job_id=' + jobId + ', 不要调用 bash, 不要文字回复。');
  let kr = findBy(kres, 'job_kill', (x) => !x.isError && /(kill|success|cancel|finished)/i.test(x.text));
  if (!kr) { kres = await poll('请只调用一次 job_kill 工具, job_id=' + jobId + '。'); kr = findBy(kres, 'job_kill', (x) => !x.isError && /(kill|success|cancel|finished)/i.test(x.text)); }
  const killed = !!kr;

  const pass = listRunning && outTick && killed;
  let d = 'jobId=' + jobId;
  if (!listRunning) d += '; job_list 未显 running';
  if (!outTick) d += '; job_output 无 TICK';
  if (!killed) d += '; job_kill 未成功';
  record(7, '后台链(start→list→output→kill)', pass, pass ? ('jobId=' + jobId + ' 全链通过') : d.trim());
}

async function caseCleanup() {
  const sid = await openSession();
  const poll = makePoller(sid);
  const cmd = 'rm -f ' + REMOTE + '/e2e-write.txt ' + REMOTE + '/e2e-probe.txt; ls -1 ' + REMOTE;
  let results = await poll('调用一次 bash 工具执行: ' + cmd + '。不要文字回复, 不要调其它工具。');
  let r = findBy(results, 'bash', (x) => !x.isError);
  if (!r) { results = await poll('请只调用一次 bash 工具执行: ' + cmd + '。'); r = findBy(results, 'bash', (x) => !x.isError); }
  const dirKept = r && /note\.txt/.test(r.text);
  record(9, '清理 e2e 产物(保留目录)', !!r && dirKept, r ? (dirKept ? '目录保留, 产物已删' : '目录内容异常') : '清理 bash 未成功');
}

// ---- Main flow ----
const cases = [
  ['1', caseBashFront], ['2', caseWrite], ['3', caseRead], ['4', caseEdit],
  ['5', caseGlob], ['6', caseGrep], ['7', caseBgChain], ['9', caseCleanup],
];
for (const [no, fn] of cases) {
  try { await fn(); } catch (err) { record(Number(no), '用例' + no, false, '异常: ' + String((err && err.message) || err).slice(0, 120)); }
}

// ---- Summary ----
const maxLen = Math.max(...rows.map((r) => r.desc.length), 1);
console.log('\n===== 3080 全工具 E2E 汇总 =====');
for (const r of rows) {
  console.log((r.pass ? 'PASS' : 'FAIL') + '  [用例 ' + r.no + '] ' + r.desc.padEnd(maxLen) + ' → ' + r.detail);
}
const fails = rows.filter((r) => !r.pass).length;
console.log('----- ' + (rows.length - fails) + '/' + rows.length + ' 通过, ' + fails + ' 失败 -----');
process.exit(fails ? 1 : 0);
