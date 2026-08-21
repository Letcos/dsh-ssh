// @dsh-ssh/dsh-ssh — unified configuration for live/verify scripts.
// Host / port / user / hostId / key path / remote root / remote workspace are defined here with env overrides:
//   DSH_SSH_TEST_HOST / DSH_SSH_TEST_PORT / DSH_SSH_TEST_USER / DSH_SSH_TEST_HOST_ID
//   / DSH_SSH_TEST_KEY_PATH / DSH_SSH_TEST_REMOTE_ROOT / DSH_SSH_TEST_REMOTE_WORKSPACE
// Defaults use RFC 5737 TEST-NET-3 reserved address 203.0.113.10 (never routed, placeholder),
// hostId placeholder UUID 00000000-0000-4000-8000-000000000000, key <home>/.ssh/id_ed25519.
// Without a real host configured, live/verify/e2e scripts print a hint and skip via requireRealHost.
// All live scripts read from here; do not hard-code host / key / hostId elsewhere.
// Set DSH_SSH_TEST_HOST (and optionally PORT/USER/HOST_ID/KEY_PATH/REMOTE_ROOT) before running live tests.
//
// Environment-sensitive local values (DSH_HOME, profile name, E2E base URL, placeholder root)
// are centralized here too, so nothing in tests/scripts is bound to one machine. The DSH core
// dir (dshNodeModules) has no hard-coded default and requires DSH_SSH_DSH_NODE_MODULES; every
// other value has an env override with defaults that keep the current dev machine usable. To
// run on another machine, export the relevant DSH_SSH_TEST_* / DSH_SSH_DSH_* / DSH_SSH_E2E_*
// variables — details are documented on each value below.
import path from 'node:path';
import os from 'node:os';

function envStr(k, dflt) {
  const v = process.env[k];
  return v !== undefined && v !== '' ? v : dflt;
}
function envInt(k, dflt) {
  const v = process.env[k];
  return v !== undefined && v !== '' ? Number(v) : dflt;
}

// Default key: <home>/.ssh/id_ed25519 derived via os.homedir(), no hard-coded username.
// On Windows uses USERPROFILE, otherwise HOME; DSH_SSH_TEST_KEY_PATH overrides when set.
const defaultKeyPath =
  process.env.USERPROFILE || process.env.HOME
    ? path.join(process.env.USERPROFILE ?? process.env.HOME, '.ssh', 'id_ed25519')
    : '~/.ssh/id_ed25519';

// ---- DSH core checkout directory (the @deepseek-ai/dsh package dir) ----
// Env: DSH_SSH_DSH_NODE_MODULES (required). No install path is hard-coded, so the
// live/verify scripts that resolve the install anchor (for profile composition and loading
// dsh-app-boot) must set this env; resolving without it fails with a clear error.
export function resolveDshNodeModules() {
  const fromEnv = envStr('DSH_SSH_DSH_NODE_MODULES', '');
  if (fromEnv) return fromEnv;
  throw new Error(
    'DSH_SSH_DSH_NODE_MODULES is not set: point it at the @deepseek-ai/dsh package dir ' +
    '(required by live/verify scripts to locate the DSH core install anchor).'
  );
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

// ---- E2E base URL (scripts/e2e-web-3080.mjs) ----
// Env: DSH_SSH_TEST_E2E_BASE (or legacy E2E_BASE). Default: the local dev web-app on port 3080.
export const e2eBase = envStr('DSH_SSH_TEST_E2E_BASE', envStr('E2E_BASE', 'http://127.0.0.1:3080'));

// ---- placeholder root for remote workspaces (<dshHome>/remote) ----
// Remote cwds live under this root as <root>/<hostId>/<base64url(remote>path)>.
export const placeholderRoot = path.join(dshHome, 'remote');

/** Unified live config (all env-overridable). Remote root defaults to /tmp/dsh-ssh-test-root. */
export const liveConfig = {
  host: envStr('DSH_SSH_TEST_HOST', '203.0.113.10'),
  port: envInt('DSH_SSH_TEST_PORT', 22),
  user: envStr('DSH_SSH_TEST_USER', 'ubuntu'),
  hostId: envStr('DSH_SSH_TEST_HOST_ID', '00000000-0000-4000-8000-000000000000'),
  keyPath: envStr('DSH_SSH_TEST_KEY_PATH', defaultKeyPath),
  remoteRoot: envStr('DSH_SSH_TEST_REMOTE_ROOT', '/tmp/dsh-ssh-test-root'),
  // Placeholder remote workspace used as the remote cwd by the verify*/e2e scripts (env-overridable).
  remoteWorkspace: envStr('DSH_SSH_TEST_REMOTE_WORKSPACE', '/tmp/dsh-ssh-remote-workspace'),
};

/** Build a host config for SshPool.acquire (equivalent to live host). */
export function liveHostConfig({ id = liveConfig.hostId, host = liveConfig.host,
  port = liveConfig.port, user = liveConfig.user, keyPath = liveConfig.keyPath } = {}) {
  return {
    id, host, port, user,
    auth: { type: 'key', privateKeyPath: keyPath },
  };
}

/** Secondary host on same address with different port/user; host follows liveConfig.host. */
export function secondaryHostConfig(id, port, user) {
  return {
    id, host: liveConfig.host, port, user,
    auth: { type: 'key', privateKeyPath: liveConfig.keyPath },
  };
}

// ---- Real-host guard ----
// Default host is RFC 5737 TEST-NET-3 reserved address 203.0.113.10 (never routed, placeholder).
// No real server address should appear in the repo. Live/e2e scripts call requireRealHost()
// to print a hint and exit 0 when no real host is configured; otherwise continue silently.
export const EXAMPLE_HOST = '203.0.113.10';
export const EXAMPLE_HOST_ID = '00000000-0000-4000-8000-000000000000';

/** Whether current host is still the placeholder example address (no real host configured). */
export function isExampleHost() {
  return liveConfig.host === EXAMPLE_HOST;
}

/** Print hint and exit 0 when no real host is configured; otherwise continue silently. */
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
