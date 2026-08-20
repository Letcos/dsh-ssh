// @dsh-ssh/dsh-ssh — 真机 live/verify 脚本统一配置 (A.38)。
// 主机 / 端口 / 用户 / hostId / 私钥路径 / 远端测试根目录 一处定义, 全部支持环境变量覆盖:
//   DSH_SSH_TEST_HOST / DSH_SSH_TEST_PORT / DSH_SSH_TEST_USER / DSH_SSH_TEST_HOST_ID
//   / DSH_SSH_TEST_KEY_PATH / DSH_SSH_TEST_REMOTE_ROOT
// 默认值 = RFC 5737 TEST-NET-3 保留示例地址 203.0.113.10(公网永不真实路由, 仅占位), 用户名示例 ubuntu,
// hostId = 占位 UUID 00000000-0000-4000-8000-000000000000, 私钥 <home>/.ssh/id_ed25519。
// 未显式配置真实主机时, 所有 live/verify/e2e 脚本会打印提示并跳过(见 requireRealHost), 绝不连网。
// 凡真机脚本(live-* / verify-* / bench / functional-live-test / sandbox-live-verify)一律从这里读,
// 不许再在各文件里写死主机 / 密钥 / hostId(否则环境变量覆盖与多机迁移都会漏改);
// 跑真机测试前必须显式设置 DSH_SSH_TEST_HOST(及可选的 PORT/USER/HOST_ID/KEY_PATH/REMOTE_ROOT)。
//
// Environment-sensitive local values (DSH core dir, DSH_HOME, profile name, E2E base URL,
// placeholder root) are centralized here too, so nothing in tests/scripts is bound to one
// machine. Every value below has an env override; the defaults keep the current dev machine
// usable. To run on another machine, export the relevant DSH_SSH_TEST_* / DSH_SSH_DSH_* /
// DSH_SSH_E2E_* variables — details are documented on each value below.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

function envStr(k, dflt) {
  const v = process.env[k];
  return v !== undefined && v !== '' ? v : dflt;
}
function envInt(k, dflt) {
  const v = process.env[k];
  return v !== undefined && v !== '' ? Number(v) : dflt;
}

// 默认私钥: <home>/.ssh/id_ed25519(由 os.homedir() 推导, 不写死用户名/绝对路径)。
// Windows 用 USERPROFILE, 其它平台用 HOME 构造绝对路径; 显式设置 DSH_SSH_TEST_KEY_PATH 一律优先。
const defaultKeyPath =
  process.env.USERPROFILE || process.env.HOME
    ? path.join(process.env.USERPROFILE ?? process.env.HOME, '.ssh', 'id_ed25519')
    : '~/.ssh/id_ed25519';

// ---- DSH core checkout directory (the @deepseek-ai/dsh package dir) ----
// Env: DSH_SSH_DSH_NODE_MODULES. Probe order: env → common install locations (macOS
// Homebrew, Linux /usr, Windows scoop/Program Files) → npm global prefix. The resolved dir
// is used as the install anchor for profile composition and for loading dsh-app-boot.
const CORE_CANDIDATES = [
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh',
  '/usr/lib/node_modules/@deepseek-ai/dsh',
  'C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh',
  'D:/Scoop/persist/nodejs/bin/node_modules/@deepseek-ai/dsh',
];
export function resolveDshNodeModules() {
  const fromEnv = envStr('DSH_SSH_DSH_NODE_MODULES', '');
  if (fromEnv) return fromEnv;
  const order = [];
  const prefix = process.env.npm_config_prefix;
  if (prefix) order.push(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh'));
  for (const c of CORE_CANDIDATES) {
    try { if (fs.existsSync(path.join(c, 'package.json'))) return c; } catch { /* keep probing */ }
  }
  for (const c of order) {
    try { if (fs.existsSync(path.join(c, 'package.json'))) return c; } catch { /* keep probing */ }
  }
  return order[0] || CORE_CANDIDATES[0];
}
export const dshNodeModules = resolveDshNodeModules();

// ---- DSH_HOME (settings / profiles root) ----
// Env: DSH_SSH_DSH_HOME. Default: ~/.dsh derived from os.homedir() — never hard-coded.
export function resolveDshHome() {
  const fromEnv = envStr('DSH_SSH_DSH_HOME', '');
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}
export const dshHome = resolveDshHome();

// ---- isolated profile name used by the verify* scripts ----
// Env: DSH_SSH_TEST_PROFILE. Default points at the repo's dedicated test profile.
export const profile = envStr('DSH_SSH_TEST_PROFILE', 'dsh-ssh-dev');

// ---- E2E base URL (scripts/e2e-web-3090.mjs) ----
// Env: DSH_SSH_TEST_E2E_BASE (or legacy E2E_BASE). Default: the local dev web-app on port 3090.
export const e2eBase = envStr('DSH_SSH_TEST_E2E_BASE', envStr('E2E_BASE', 'http://127.0.0.1:3090'));

// ---- placeholder root for remote workspaces (<dshHome>/remote) ----
// Remote cwds live under this root as <root>/<hostId>/<base64url(remote>path)>.
export const placeholderRoot = path.join(dshHome, 'remote');

/** 统一真机配置(全部可用环境变量覆盖)。远端测试根目录默认 /tmp/dsh-ssh-test-root。 */
export const liveConfig = {
  host: envStr('DSH_SSH_TEST_HOST', '203.0.113.10'),
  port: envInt('DSH_SSH_TEST_PORT', 22),
  user: envStr('DSH_SSH_TEST_USER', 'ubuntu'),
  hostId: envStr('DSH_SSH_TEST_HOST_ID', '00000000-0000-4000-8000-000000000000'),
  keyPath: envStr('DSH_SSH_TEST_KEY_PATH', defaultKeyPath),
  remoteRoot: envStr('DSH_SSH_TEST_REMOTE_ROOT', '/tmp/dsh-ssh-test-root'),
};

/** 生成一份可直接交给 SshPool.acquire 的主机配置(等价 live 主机)。 */
export function liveHostConfig({ id = liveConfig.hostId, host = liveConfig.host,
  port = liveConfig.port, user = liveConfig.user, keyPath = liveConfig.keyPath } = {}) {
  return {
    id, host, port, user,
    auth: { type: 'key', privateKeyPath: keyPath },
  };
}

/** 同主机不同端口/用户 的备用主机(兼容性矩阵 / E2E), 主机本体仍跟随 liveConfig.host。 */
export function secondaryHostConfig(id, port, user) {
  return {
    id, host: liveConfig.host, port, user,
    auth: { type: 'key', privateKeyPath: liveConfig.keyPath },
  };
}

// ---- 真实主机守卫(隐私红线) ----
// 默认 host 是 RFC 5737 TEST-NET-3 保留地址 203.0.113.10: 在公网永不路由, 仅作文档占位, 仓库内任何地方都不应
// 出现真实服务器地址。未显式配置真实主机时, 需要真机的 live/e2e 脚本应调用 requireRealHost() 打印提示并以
// 退出码 0 跳过(绝不尝试连接网络); 一旦 DSH_SSH_TEST_HOST 指向非示例地址则静默继续。
export const EXAMPLE_HOST = '203.0.113.10';
export const EXAMPLE_HOST_ID = '00000000-0000-4000-8000-000000000000';

/** 当前 host 是否仍为保留示例地址(即未配置真实主机)。 */
export function isExampleHost() {
  return liveConfig.host === EXAMPLE_HOST;
}

/** 未配置真实主机时打印提示并以退出码 0 跳过(不连网); 配置了真实主机则静默继续。 */
export function requireRealHost(label) {
  if (liveConfig.host === EXAMPLE_HOST) {
    console.log(
      '[skip] ' + label + ': 未配置真实测试主机 (DSH_SSH_TEST_HOST 仍为保留示例地址 ' +
        EXAMPLE_HOST + ', RFC 5737 TEST-NET-3, 永不真实路由)。' +
        '请设置 DSH_SSH_TEST_HOST 指向你的真机后重跑; 本次跳过(退出码 0)。'
    );
    process.exit(0);
  }
}
