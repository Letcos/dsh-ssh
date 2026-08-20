// @dsh-ssh/dsh-ssh — 网关 {ok,value} 响应解包回归测试 (A.13)。
// 根因(2026-08): dsh-api-gateway 把 host 方法返回值统一包成 { ok: true, value }(成功)
// 或 { ok: false, error }(业务失败)(lib/index.js:123-131 invokeRpc; lib/client.js:258-265 client
// invoke)。client.js 的 startBrowse 曾把 resolveRemoteHome 的响应当裸字符串判断, 未解包 →
// resolve 的值是对象而非 '/home/...' → UI 报"读取远端目录失败: resolveRemoteHome 返回异常"。
// 回归覆盖: 解包 helper 语义 + 与 host 裸返回值组合成的真实网关形状。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapRemoteResponse, remoteResponseError, isBrowseCapabilityError } from '../lib/typert-contribution.js';

test('unwrapRemoteResponse extracts the gateway-wrapped host value (ok:true)', () => {
  assert.equal(unwrapRemoteResponse({ ok: true, value: '/home/ubuntu' }), '/home/ubuntu');
  const list = unwrapRemoteResponse({ ok: true, value: [{ name: 'a', type: 'dir' }] });
  assert.equal(Array.isArray(list) && list[0].name, 'a');
});

test('unwrapRemoteResponse returns null for failures, non-shapes and bare values', () => {
  assert.equal(unwrapRemoteResponse({ ok: false, error: { message: 'boom' } }), null);
  assert.equal(unwrapRemoteResponse(null), null);
  assert.equal(unwrapRemoteResponse(undefined), null);
  // 旧错误假设: 把裸字符串当成功 —— 修复后必须判为 null(未解包即失败)
  assert.equal(unwrapRemoteResponse('/home/ubuntu'), null);
});

test('remoteResponseError prefers the wire error message, falls back otherwise', () => {
  assert.equal(remoteResponseError({ ok: false, error: { message: 'unknown host key' } }, 'fb'), 'unknown host key');
  assert.equal(remoteResponseError({ ok: true, value: '/home/ubuntu' }, 'fb'), 'fb');
  assert.equal(remoteResponseError(null, 'fb'), 'fb');
  assert.equal(remoteResponseError({ ok: false, error: 'plain-string-error' }, 'fb'), 'fb');
});

// A.14 回归: 目录浏览能力缺失检测 —— host composed picker 只 serve "native" 时,
// ctx.workspaces.listDirectory/createDirectory 抛 DirectoryBrowseError(rpcError 携带
// directory-picker-unavailable, 文案含 "needs the browse capability");
// 命中 → 本地页签回退 ctx.workspaces.pickDirectory() 系统对话框, 不再尝试 listDirectory。
test('isBrowseCapabilityError: DirectoryBrowseError shape (rpcError + message)', () => {
  const browseErr = {
    name: 'DirectoryBrowseError',
    message: 'directory browse failed: directory-picker-unavailable: host.listDirectory needs the browse capability; the composed picker serves "native"',
    rpcError: {
      code: 'directory-picker-unavailable',
      message: 'host.listDirectory needs the browse capability; the composed picker serves "native"',
      details: { capability: 'native' },
    },
  };
  assert.equal(isBrowseCapabilityError(browseErr), true);
});

test('isBrowseCapabilityError: mirrors createDirectory (native host) and plain Errors', () => {
  const createErr = {
    rpcError: {
      code: 'directory-picker-unavailable',
      message: 'host.createDirectory needs the browse capability; the composed picker serves "native"',
      details: { capability: 'native' },
    },
  };
  assert.equal(isBrowseCapabilityError(createErr), true);
  assert.equal(isBrowseCapabilityError(new Error('ENOENT: no such file')), false);
  assert.equal(isBrowseCapabilityError({ rpcError: { code: 'directory-exists', message: 'already there' } }), false);
  assert.equal(isBrowseCapabilityError('needs the browse capability (bare string)'), false);
  assert.equal(isBrowseCapabilityError(null), false);
  assert.equal(isBrowseCapabilityError(undefined), false);
});

test('isBrowseCapabilityError: message-only match without rpcError', () => {
  assert.equal(isBrowseCapabilityError({ message: 'host.listDirectory needs the browse capability; the composed picker serves "native"' }), true);
});

// 组合语义: host 服务返回裸值(remote.js 的真实返回) → 网关包 {ok,value} → client 解包回裸值,
// 且 startBrowse 的校验条件(字符串 + 以 '/' 开头)在解包后成立。
test('host bare value survives gateway wrap/unwrap round-trip (resolveRemoteHome flow)', () => {
  const hostResult = '/home/ubuntu'; // src/remote.js resolveRemoteHome 的真实返回
  const wire = { ok: true, value: hostResult };
  const resolved = unwrapRemoteResponse(wire);
  assert.equal(resolved, hostResult);
  assert.ok(typeof resolved === 'string' && resolved.startsWith('/'));
  // 网关业务失败形状: host 抛 SshError → { ok:false, error:{message}} → 解包 null + 文案透出
  const failWire = { ok: false, error: { message: 'resolveRemoteHome failed: exit 127: command not found' } };
  assert.equal(unwrapRemoteResponse(failWire), null);
  assert.match(remoteResponseError(failWire, 'fb'), /exit 127/);
});
