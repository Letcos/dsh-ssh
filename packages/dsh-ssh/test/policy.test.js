// @dsh-ssh/dsh-ssh — P0 sandbox policy 纯函数单测 (node --test, 无 IO/网络)。
// 覆盖三种模式 × 区内/区外/逃逸路径的判定矩阵 + denial 错误形状 + resolveRemotePath 绝对路径规范化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPathInsideWorkspace, mutationDenialMode, sandboxDenialError } from '../src/policy.js';
import { resolveRemotePath } from '../src/router.js';
import { FsError } from '@deepseek-ai/dsh-fs';

// ── isPathInsideWorkspace ──
test('isPathInsideWorkspace: exact root / child / deep child → inside', () => {
  assert.equal(isPathInsideWorkspace('/data/work', '/data/work'), true);
  assert.equal(isPathInsideWorkspace('/data/work/a.txt', '/data/work'), true);
  assert.equal(isPathInsideWorkspace('/data/work/sub/deep/b.txt', '/data/work'), true);
});

test('isPathInsideWorkspace: parent / sibling prefix-trap / unrelated → outside', () => {
  assert.equal(isPathInsideWorkspace('/data', '/data/work'), false);
  assert.equal(isPathInsideWorkspace('/data/work2/a.txt', '/data/work'), false, 'prefix trap');
  assert.equal(isPathInsideWorkspace('/etc/passwd', '/data/work'), false);
});

test('isPathInsideWorkspace: trailing slash root + root "/"', () => {
  assert.equal(isPathInsideWorkspace('/data/work/a.txt', '/data/work/'), true);
  assert.equal(isPathInsideWorkspace('/data/work', '/data/work/'), true);
  assert.equal(isPathInsideWorkspace('/anything', '/'), true);
});

test('isPathInsideWorkspace: .. escape normalized away (lexical)', () => {
  assert.equal(isPathInsideWorkspace('/data/work/../../etc/passwd', '/data/work'), false);
  assert.equal(isPathInsideWorkspace('/data/work/sub/../inside.txt', '/data/work'), true, '.. that stays inside');
  assert.equal(isPathInsideWorkspace('/data/work/../work/inside.txt', '/data/work'), true);
});

test('isPathInsideWorkspace: non-string input → false (fail-closed)', () => {
  assert.equal(isPathInsideWorkspace(null, '/data/work'), false);
  assert.equal(isPathInsideWorkspace('/data/work/a', undefined), false);
});

// ── mutationDenialMode 矩阵 (三种模式 × 区内/区外/逃逸) ──
const INSIDE = '/data/work/new.txt';
const OUTSIDE = '/etc/passwd';
const ESCAPE = '/data/work/../../etc/passwd'; // 词法归一化后 = /etc/passwd (区外)

test('mutationDenialMode: danger-full-access → 全放行', () => {
  assert.equal(mutationDenialMode('danger-full-access', INSIDE, '/data/work'), null);
  assert.equal(mutationDenialMode('danger-full-access', OUTSIDE, '/data/work'), null);
  assert.equal(mutationDenialMode('danger-full-access', ESCAPE, '/data/work'), null);
});

test('mutationDenialMode: workspace-write → 区内放行 / 区外与逃逸拒绝', () => {
  assert.equal(mutationDenialMode('workspace-write', INSIDE, '/data/work'), null);
  assert.equal(mutationDenialMode('workspace-write', '/data/work', '/data/work'), null, 'exact root');
  assert.equal(mutationDenialMode('workspace-write', OUTSIDE, '/data/work'), 'workspace-write');
  assert.equal(mutationDenialMode('workspace-write', '/data/work2/x', '/data/work'), 'workspace-write', 'prefix trap');
  assert.equal(mutationDenialMode('workspace-write', ESCAPE, '/data/work'), 'workspace-write');
});

test('mutationDenialMode: read-only → 一律拒绝', () => {
  assert.equal(mutationDenialMode('read-only', INSIDE, '/data/work'), 'read-only');
  assert.equal(mutationDenialMode('read-only', OUTSIDE, '/data/work'), 'read-only');
  assert.equal(mutationDenialMode('read-only', ESCAPE, '/data/work'), 'read-only');
});

test('mutationDenialMode: 未知模式 fail-closed 拒绝', () => {
  assert.equal(mutationDenialMode('weird-mode', INSIDE, '/data/work'), 'weird-mode');
});

// ── sandboxDenialError: 与官方同形 ──
test('sandboxDenialError: FsError + FS_SANDBOX_DENIED + marker + escalation hint', () => {
  const err = sandboxDenialError('workspace-write', 'operation');
  assert.ok(err instanceof FsError);
  assert.equal(err.code, 'FS_SANDBOX_DENIED');
  assert.ok(err.message.startsWith('[sandbox: file access denied under workspace-write mode]'), err.message);
  assert.ok(err.message.includes('[sandbox: escalation available — retry this exact operation once with sandbox_permissions'), err.message);
});

test('sandboxDenialError: read-only mode marker', () => {
  const err = sandboxDenialError('read-only', 'operation');
  assert.equal(err.code, 'FS_SANDBOX_DENIED');
  assert.ok(err.message.startsWith('[sandbox: file access denied under read-only mode]'), err.message);
});

// ── resolveRemotePath: 绝对路径规范化关闭 ../ 词法逃逸 ──
test('resolveRemotePath normalizes absolute .. traversal (lexical)', () => {
  assert.equal(resolveRemotePath('/data/work/../../etc/passwd', '/data/work', undefined), '/etc/passwd');
  assert.equal(resolveRemotePath('/data/work/sub/../inside.txt', '/data/work', undefined), '/data/work/inside.txt');
  assert.equal(resolveRemotePath('/etc/hostname', '/data/work', undefined), '/etc/hostname', 'clean absolute passthrough');
  assert.equal(resolveRemotePath('src/foo.js', '/data/work', undefined), '/data/work/src/foo.js', 'relative unchanged');
});
