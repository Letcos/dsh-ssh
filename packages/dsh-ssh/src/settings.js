// @dsh-ssh/dsh-ssh — settings namespace for SSH hosts.
// Registers the dsh-ssh-hosts namespace (dict of HostConfig, keyed by host id)
// via the official dsh-settings API: settingsNamespace + ctx.settings.register(...).
// hosts is a DICT (not an array) so the official settings merge preserves stored
// secrets when a form leaves the write-only password blank — mergeLayers merges
// plain objects recursively but replaces arrays wholesale
// (dsh-settings/lib/index.js:235).
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';

// settingsNamespace enforces /^[a-z][a-z0-9-]*$/ (no dots) — hence kebab-case dsh-ssh-hosts
export const HOSTS_NAMESPACE = settingsNamespace('dsh-ssh-hosts');

// Legacy namespace (previously dssh-hosts): read-only fallback source. The read
// side falls back to it only when dsh-ssh-hosts is empty; the write side only
// writes dsh-ssh-hosts (see readHostsDoc and SshRemoteService saveHost/deleteHost).
export const LEGACY_HOSTS_NAMESPACE = settingsNamespace('dssh-hosts');

// HostConfig — one SSH target. Mirrors the ssh-core HostConfig shape.
export const HostConfigSchema = z.object({
  id: z.string().required().description('稳定 id(占位目录路径依赖, 如 uuid)'),
  name: z.string().description('显示名'),
  host: z.string().required().description('主机名或 IP'),
  port: z.number().min(1).max(65535).default(22).description('SSH 端口'),
  user: z.string().required().description('登录用户'),
  auth: z
    .union([
      z.object({ type: z.const('key'), privateKeyPath: z.string().description('私钥路径; 缺省走 ssh-agent') }),
      z.object({ type: z.const('password'), password: z.string().role('secret').description('口令; M2a 明文存 settings.yaml, 后续接 secret 存储(F3)') }),
    ])
    .default({ type: 'key' })
    .description('认证方式'),
  knownHostsPath: z.string().description('known_hosts 路径; 缺省 ~/.ssh/known_hosts'),
  connectTimeoutMs: z.number().min(500).default(10_000).description('连接超时(ms)'),
  keepaliveIntervalMs: z.number().min(1_000).default(15_000).description('keepalive 间隔(ms)'),
});

// dsh-ssh-hosts namespace: host dict (id → HostConfig). A dict makes settings'
// recursive merge preserve the stored password when auth.password is omitted (a
// write-only field left blank = keep as-is); deletion uses settings.mutate's
// unset ['hosts', <id>] (mutate paths must be string arrays; numeric indexes are rejected).
export const HostsSettingsSchema = z.object({
  hosts: z.dict(HostConfigSchema).default({}).description('SSH 主机配置(id → HostConfig, F1 CRUD 的持久化载体)'),
});

/** Extract the hosts dict from a settings document (tolerant of undefined). */
export function hostsOf(doc) {
  return doc && typeof doc === 'object' && doc.hosts && typeof doc.hosts === 'object' ? doc.hosts : {};
}

function safeGet(get, ns) {
  try { return get?.(ns); } catch { return undefined; }
}

/**
 * Read the host config document with dssh-hosts → dsh-ssh-hosts fallback. Reads
 * the new namespace first; only when it has no hosts and the legacy namespace
 * still has some do we fall back to the legacy doc, so already-configured hosts
 * are not lost. The write side only writes the new namespace (the full dict is
 * written there on first edit, see SshRemoteService).
 * @param get settings.get(ns) reader function.
 * @returns { doc, hosts, legacy } — legacy is true when the value came from the legacy namespace (migration not yet persisted).
 */
export function readHostsDoc(get) {
  const newDoc = safeGet(get, HOSTS_NAMESPACE);
  const newHosts = hostsOf(newDoc);
  if (Object.keys(newHosts).length > 0) return { doc: newDoc, hosts: newHosts, legacy: false };
  const legacyDoc = safeGet(get, LEGACY_HOSTS_NAMESPACE);
  const legacyHosts = hostsOf(legacyDoc);
  if (Object.keys(legacyHosts).length > 0) return { doc: legacyDoc, hosts: legacyHosts, legacy: true };
  return { doc: newDoc ?? { hosts: {} }, hosts: newHosts, legacy: false };
}

// Register the namespace on a settings-capable ctx (from ctx.inject(['settings'], ...)).
// base provides the default layer (effective until the user overrides); applies 'live' means changes take effect immediately.
export function registerSettings(ctx) {
  const scope = ctx.settings.register(HOSTS_NAMESPACE, HostsSettingsSchema, {
    applies: 'live',
    base: { hosts: {} },
  });
  // Register the legacy namespace read-only so pre-rename settings.yaml host data
  // stays readable during the migration window (see readHostsDoc). The write side
  // never writes it; data migrates wholesale into the new namespace on first edit.
  ctx.settings.register(LEGACY_HOSTS_NAMESPACE, HostsSettingsSchema, {
    applies: 'live',
    base: { hosts: {} },
  });
  ctx.logger?.info('[@dsh-ssh/dsh-ssh] settings namespace ' + HOSTS_NAMESPACE + ' registered');
  return scope;
}
