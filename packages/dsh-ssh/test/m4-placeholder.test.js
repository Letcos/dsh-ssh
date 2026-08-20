// @dsh-ssh/dsh-ssh — M4 占位目录创建单测(纯函数, 无网络)。
// 覆盖: 编码复用(mapRemoteToLocal 可逆编码, 禁止路径穿越)、幂等、mock fs、
// DSH_HOME 尊重(DSH_SSH_REMOTE_ROOT > DSH_HOME > ~/.dsh)、真实目录落地(tmp 隔离, 不写 ~/.dsh/remote)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createPlaceholderDir, placeholderInvalidReason, placeholderDisplayName, hostDisplayName, placeholderWorkspaceTitle } from '../src/placeholder.js';
import { mapRemoteToLocal, mapLocalToRemote, encodeRemotePath } from '../src/router.js';

const ENV = { DSH_SSH_REMOTE_ROOT: '/tmp/dsh-ssh-m4-root' };

// Windows 下 mapRemoteToLocal 产出本地原生路径(带盘符/反斜杠); 此处只验证"根目录落在哪",
// 统一归一化到 POSIX 形态再 startsWith(盘符来自 cwd, 与语义无关)。
const toPosix = (p) => String(p).replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');

/** fs 双: promises.mkdir 只记录调用, 不做真实 IO。 */
function mockFs() {
  const mkdirs = [];
  return {
    promises: {
      mkdir: async (p, opts) => { mkdirs.push({ p, opts }); },
    },
    mkdirs,
  };
}

test('createPlaceholderDir: 用 mapRemoteToLocal 的可逆编码生成 localPath', async () => {
  const fsImpl = mockFs();
  const result = await createPlaceholderDir({ hostId: 'h1', remotePath: '/data/work', env: ENV, fsImpl });
  const expected = mapRemoteToLocal('h1', '/data/work', ENV);
  assert.equal(result.localPath, expected);
  assert.equal(result.hostId, 'h1');
  assert.equal(result.remotePath, '/data/work');
  // 编码复用: localPath 可被 mapLocalToRemote 逆回远端路径(宿主工具路由依赖此可逆性)
  assert.deepEqual(mapLocalToRemote(result.localPath, ENV), { hostId: 'h1', remotePath: '/data/work' });
  // mkdir recursive 且父目录缺失也可建
  assert.equal(fsImpl.mkdirs.length, 1);
  assert.equal(fsImpl.mkdirs[0].p, expected);
  assert.deepEqual(fsImpl.mkdirs[0].opts, { recursive: true });
});

test('createPlaceholderDir: DSH_HOME 尊重(根 = $DSH_HOME/remote), DSH_SSH_REMOTE_ROOT 优先', async () => {
  const fsImpl = mockFs();
  await createPlaceholderDir({ hostId: 'h1', remotePath: '/a/b', env: { DSH_HOME: '/tmp/custom-dsh' }, fsImpl });
  assert.ok(toPosix(fsImpl.mkdirs[0].p).startsWith('/tmp/custom-dsh/remote/'), 'must live under $DSH_HOME/remote, got ' + fsImpl.mkdirs[0].p);
  // DSH_SSH_REMOTE_ROOT 覆盖 DSH_HOME
  await createPlaceholderDir({ hostId: 'h1', remotePath: '/a/b', env: { DSH_HOME: '/tmp/ignored', DSH_SSH_REMOTE_ROOT: '/tmp/overridden' }, fsImpl });
  assert.ok(toPosix(fsImpl.mkdirs[1].p).startsWith('/tmp/overridden/'), 'DSH_SSH_REMOTE_ROOT must win, got ' + fsImpl.mkdirs[1].p);
});

test('createPlaceholderDir: 幂等(mkdir recursive 已存在目录成功, 两次调用结果一致)', async () => {
  const fsImpl = mockFs();
  const first = await createPlaceholderDir({ hostId: 'h1', remotePath: '/data', env: ENV, fsImpl });
  const second = await createPlaceholderDir({ hostId: 'h1', remotePath: '/data', env: ENV, fsImpl });
  assert.deepEqual(second, first);
  assert.equal(fsImpl.mkdirs.length, 2);
});

test('createPlaceholderDir: 拒绝非法 hostId 与相对远端路径(不落盘)', async () => {
  const fsImpl = mockFs();
  await assert.rejects(() => createPlaceholderDir({ hostId: '../evil', remotePath: '/x', env: ENV, fsImpl }), /unsafe segment|invalid host id/);
  await assert.rejects(() => createPlaceholderDir({ hostId: 'h1', remotePath: 'relative/path', env: ENV, fsImpl }), /must be absolute/);
  await assert.rejects(() => createPlaceholderDir({ hostId: '', remotePath: '/x', env: ENV, fsImpl }), /host id is required/);
  await assert.rejects(() => createPlaceholderDir({ hostId: 'h1', remotePath: '', env: ENV, fsImpl }), /remote path is required/);
  assert.equal(fsImpl.mkdirs.length, 0, 'no mkdir must happen on invalid input');
});

test('placeholderInvalidReason 覆盖空/相对/非字符串', () => {
  assert.equal(placeholderInvalidReason('', '/x'), 'host id is required');
  assert.equal(placeholderInvalidReason('h1', ''), 'remote path is required');
  assert.equal(placeholderInvalidReason('h1', 'rel'), 'remote path must be absolute');
  assert.equal(placeholderInvalidReason('h1', '/ok'), null);
});

test('createPlaceholderDir: 缺 fs.promises.mkdir 时报错(可注入性守卫)', async () => {
  await assert.rejects(() => createPlaceholderDir({ hostId: 'h1', remotePath: '/x', env: ENV, fsImpl: {} }), /no promises.mkdir/);
});

test('placeholderDisplayName: 占位工作区显示名 = 远端路径 basename (A.15)', () => {
  // 回归: 旧 bug 下 title 默认取占位目录 basename(= base64 编码段, 如 L2hvbWUv...),
  // 修复后按远端 POSIX 路径取人类可读 basename。
  assert.equal(placeholderDisplayName('/home/ubuntu/opencode-api'), 'opencode-api');
  assert.equal(placeholderDisplayName('/data/work'), 'work');
  assert.equal(placeholderDisplayName('/中文/目录 😀'), '目录 😀');
  assert.equal(placeholderDisplayName('/a/b/'), 'b');            // 尾斜杠
  assert.equal(placeholderDisplayName('/'), 'root');             // 根目录兜底
  assert.equal(placeholderDisplayName(''), 'root');              // 空输入兜底
  assert.equal(placeholderDisplayName(undefined), 'root');       // 非字符串兜底
  assert.equal(placeholderDisplayName('/.hidden'), '.hidden');   // 点文件保留原名
});

test('hostDisplayName: 优先取 name, 缺失回退 hostId (A.29)', () => {
  assert.equal(hostDisplayName({ h1: { name: 'ubuntu' } }, 'h1'), 'ubuntu');
  assert.equal(hostDisplayName({ h1: { name: '  ubuntu  ' } }, 'h1'), 'ubuntu'); // name 去空白
  assert.equal(hostDisplayName({ h1: { name: '' } }, 'h1'), 'h1');               // 空 name → 回退
  assert.equal(hostDisplayName({ h1: {} }, 'h1'), 'h1');                          // 无 name 字段 → 回退
  assert.equal(hostDisplayName({}, 'h1'), 'h1');                                  // 无该主机 → 回退
  assert.equal(hostDisplayName(undefined, 'h1'), 'h1');
  assert.equal(hostDisplayName({}, ''), '?');                                     // 空 hostId → '?'
});

test('placeholderWorkspaceTitle: 主机显示名 / basename', () => {
  assert.equal(placeholderWorkspaceTitle('/home/ubuntu/opencode-api', 'ubuntu'), 'ubuntu / opencode-api');
  assert.equal(placeholderWorkspaceTitle('/data/work', 'h1'), 'h1 / work');
  assert.equal(placeholderWorkspaceTitle('/a/b/', 'sv1'), 'sv1 / b');        // 尾斜杠
  assert.equal(placeholderWorkspaceTitle('/', 'sv1'), 'sv1 / root');         // 根兜底
});

test('createPlaceholderDir: 真实目录落地(tmp 隔离, DSH_HOME=/tmp/xxx; 不写 ~/.dsh/remote)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-m4-'));
  const env = { DSH_HOME: tmp };
  const result = await createPlaceholderDir({ hostId: 'h1', remotePath: '/中文/目录 😀', env });
  assert.ok(result.localPath.startsWith(tmp + path.sep + 'remote' + path.sep), 'placeholder under DSH_HOME/remote');
  // 契约: workspaceRegistry.create 先 fs.realpath 再判目录 —— 占位必须是真实存在的目录。
  // 注意 macOS 上 /var → /private 的符号链接: 与 canonical 逻辑路径比较即可判别"占位自身是符号链接"
  // (若 localPath 是链接, realpathSync 会解析到别处, 与 canonical 不等)。
  const canonical = path.join(fs.realpathSync(tmp), 'remote', 'h1', encodeRemotePath('/中文/目录 😀'));
  assert.equal(fs.realpathSync(result.localPath), canonical, 'placeholder must be a real (non-symlink) directory');
  const st = fs.statSync(result.localPath);
  assert.equal(st.isDirectory(), true);
  assert.deepEqual(mapLocalToRemote(result.localPath, env), { hostId: 'h1', remotePath: '/中文/目录 😀' });
  // 幂等(真实 fs 上再跑一次)
  const again = await createPlaceholderDir({ hostId: 'h1', remotePath: '/中文/目录 😀', env });
  assert.deepEqual(again, result);
  assert.equal(encodeRemotePath('/中文/目录 😀').includes('/'), false, 'encoded segment must stay single');
  fs.rmSync(tmp, { recursive: true, force: true });
});
