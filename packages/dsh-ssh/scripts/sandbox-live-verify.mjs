#!/usr/bin/env node
// @dsh-ssh/dsh-ssh P0 直连实测: 真实 SSH(ubuntu) + 不同 sandboxMode 的 fake exec/ctx,
// 验证远端 write 的 sandbox 语义。仅写 /tmp/dsh-ssh-verify-sandbox(工作区)与 /tmp/dsh-ssh-verify-outside.txt,
// 结束统一清理。内存 config(不落 ~/.dsh/settings.yaml, known_hosts 用独立校验文件)。
// PREREQ: reachable test remote (defaults + DSH_SSH_TEST_* overrides in test/live-config.mjs).
// Switch machines by exporting the DSH_SSH_TEST_* vars; touches only /tmp/dsh-ssh-* on the remote.
import os from 'node:os';
import path from 'node:path';
import { SshPool } from '../src/ssh-core.js';
import { apply } from '../tools.js';
import { mapRemoteToLocal } from '../src/router.js';
import { liveConfig, liveHostConfig, requireRealHost } from '../test/live-config.mjs';
requireRealHost('scripts/sandbox-live-verify');

process.env.DSH_SSH_REMOTE_ROOT = path.join(os.tmpdir(), 'dsh-ssh-live-verify-placeholder');

const HOST_ID = 'live';
const REMOTE_CWD = liveConfig.remoteRoot + '-sandbox';
const OUTSIDE = liveConfig.remoteRoot + '-outside.txt';

// 主机/私钥统一来自 live-config(A.38); 私钥默认 id_ed25519, DSH_SSH_TEST_KEY_PATH 可覆盖。
const cfg = {
  ...liveHostConfig({ id: HOST_ID }),
  name: 'sandbox live verify',
  knownHostsPath: '/tmp/dsh-ssh-verify-known_hosts',
  acceptNew: true,
  connectTimeoutMs: 10_000,
};

const pool = new SshPool({ maxConnections: 1 });

function makeApproval(outcome) {
  const calls = [];
  return { _calls: calls, request: async (req) => { calls.push(req); return outcome; } };
}

function makeCtx(mode, approval) {
  const registered = new Map();
  const fs = { sandboxMode: mode };
  const shell = { sandboxMode: mode };
  const sandboxPolicy = { resolve: ({ session } = {}) => ({ mode, workspaceRoot: REMOTE_CWD, ...(session ? { sessionId: session.id } : {}) }) };
  return {
    tools: { register(def) { registered.set(def.name, def); return () => registered.delete(def.name); }, get() { return undefined; } },
    shell, fs,
    get(key) {
      if (key === 'sshPool') return pool;
      if (key === 'settings') return { get: () => ({ hosts: { [HOST_ID]: cfg } }) };
      if (key === 'attachments') return undefined;
      if (key === 'sandboxPolicy') return sandboxPolicy;
      if (key === 'approval') return approval;
      if (key === 'fs') return fs;
      if (key === 'shell') return shell;
      return undefined;
    },
    logger: { info: () => {} },
    _registered: registered,
  };
}

function makeExec() {
  const cwd = mapRemoteToLocal(HOST_ID, REMOTE_CWD);
  return { agent: { session: { header: { cwd }, id: 'sess-live' } }, signal: undefined, callId: 'call-live' };
}

const failures = [];
function check(name, cond, detail) {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!cond) failures.push(name);
}

const conn = await pool.acquire(cfg);
try {
  // prep: 清理并重建工作区
  await conn.exec('rm -rf ' + REMOTE_CWD + ' ' + OUTSIDE);
  const mk = await conn.exec('mkdir -p ' + REMOTE_CWD);
  check('mkdir workspace', mk.code === 0, mk.stderr.trim());

  const exec = makeExec();

  // 1. workspace-write 区内写放行
  {
    const ctx = makeCtx('workspace-write');
    apply(ctx);
    const out = await getTool(ctx, 'write').execute({ file_path: 'inside.txt', content: 'hello-from-sandbox\n' }, exec);
    check('workspace-write 区内写放行', out.path === REMOTE_CWD + '/inside.txt', out.path);
  }

  // 2. workspace-write 区外写拒绝 + denial 形状
  {
    const ctx = makeCtx('workspace-write');
    apply(ctx);
    let err;
    try {
      await getTool(ctx, 'write').execute({ file_path: OUTSIDE, content: 'x' }, exec);
    } catch (e) { err = e; }
    check('workspace-write 区外写拒绝', err !== undefined && err.code === 'FS_SANDBOX_DENIED', err ? err.code + ' | ' + err.message.split('\n')[0] : 'NO ERROR (BUG)');
    check('denial 形状与官方一致', err !== undefined && err.message.startsWith('[sandbox: file access denied under workspace-write mode]'), err?.message.split('\n')[0]);
    check('denial 含升级 hint', err !== undefined && err.message.includes('[sandbox: escalation available — retry this exact operation once'), '');
  }

  // 3. read-only 区内写也拒绝
  {
    const ctx = makeCtx('read-only');
    apply(ctx);
    let err;
    try {
      await getTool(ctx, 'write').execute({ file_path: 'inside-ro.txt', content: 'x' }, exec);
    } catch (e) { err = e; }
    check('read-only 区内写拒绝', err !== undefined && err.code === 'FS_SANDBOX_DENIED' && err.message.startsWith('[sandbox: file access denied under read-only mode]'), err ? err.code : 'NO ERROR (BUG)');
  }

  // 4. 升级重试放行 (workspace-write + 区外 + sandbox_permissions=danger-full-access + 审批)
  {
    const approval = makeApproval('allowed-once');
    const ctx = makeCtx('workspace-write', approval);
    apply(ctx);
    const out = await getTool(ctx, 'write').execute(
      { file_path: OUTSIDE, content: 'escalated-write\n', sandbox_permissions: 'danger-full-access', justification: 'verify escalation retry writes outside workspace' },
      exec,
    );
    check('升级重试放行', out.path === OUTSIDE, out.path);
    check('审批通道被调用', approval._calls.length === 1 && approval._calls[0].toolName === 'write', JSON.stringify(approval._calls[0]));
    const ver = await conn.exec('test -f ' + OUTSIDE + ' && echo present');
    check('升级后区外文件真实落盘', ver.stdout.trim() === 'present', ver.stdout.trim());
  }

  // 5. danger-full-access 区外写全放
  {
    const ctx = makeCtx('danger-full-access');
    apply(ctx);
    const out = await getTool(ctx, 'write').execute({ file_path: OUTSIDE, content: 'full-access-write\n' }, exec);
    check('danger-full-access 区外写全放', out.path === OUTSIDE, out.path);
    const ver = await conn.exec('test -f ' + OUTSIDE + ' && echo present');
    check('danger-full-access 区外文件落盘', ver.stdout.trim() === 'present', ver.stdout.trim());
  }

  // 6. 逃逸路径 (绝对 ../) 在 workspace-write 被拒
  {
    const ctx = makeCtx('workspace-write');
    apply(ctx);
    let err;
    try {
      await getTool(ctx, 'write').execute({ file_path: REMOTE_CWD + '/../dsh-ssh-verify-escape.txt', content: 'x' }, exec);
    } catch (e) { err = e; }
    check('workspace-write 绝对 ../ 逃逸拒绝', err !== undefined && err.code === 'FS_SANDBOX_DENIED', err ? err.code : 'NO ERROR (BUG)');
  }

  // cleanup
  await conn.exec('rm -rf ' + REMOTE_CWD + ' ' + OUTSIDE + ' /tmp/dsh-ssh-verify-escape.txt');
  console.log('cleaned up /tmp/dsh-ssh-verify-*');

  if (failures.length > 0) { console.error('SANDBOX-LIVE-FAILED:', failures.join('; ')); process.exit(1); }
  console.log('SANDBOX-LIVE-OK');
  process.exit(0);
} catch (err) {
  console.error('SANDBOX-LIVE-FAILED:', err?.message ?? err);
  if (err?.stage) console.error('stage:', err.stage, 'hostId:', err.hostId);
  process.exit(1);
} finally {
  try { await conn.exec('rm -rf ' + REMOTE_CWD + ' ' + OUTSIDE + ' /tmp/dsh-ssh-verify-escape.txt'); } catch {}
  await pool.dispose();
}

function getTool(ctx, name) { return ctx._registered.get(name); }
