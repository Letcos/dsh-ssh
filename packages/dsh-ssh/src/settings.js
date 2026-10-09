// @dsh-ssh/dsh-ssh — settings surface for SSH hosts.
// Hosts live in this plugin's own Config schema: every user-editable leaf carries
// .volatile(), which is what makes it appear in the settings form and keeps the value
// live-committable into the running plugin without a remount (dsh-settings: a form is
// produced only when a volatile node exists). Values resolve through the constructor's
// config object; the profile patch row's config is the persisted layer.
// hosts is a DICT (not an array) so a patch that omits auth.password keeps the stored
// one: the resolver merges plain objects recursively but replaces arrays wholesale.
import z from '@deepseek-ai/schemastery';

// Profile patch row id, which is also the settings form's namespace. It is kept at the
// pre-rename name on purpose: dsh-settings migrates a legacy settings.yaml section into
// the profile entry whose id equals the section name, so this id is what carries
// existing user host configs across the 0.2 settings model change.
export const HOSTS_ENTRY_ID = 'dsh-ssh-hosts';

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
      z.object({ type: z.const('password'), password: z.string().role('secret').description('口令; write-only(保存后不回传, 留空沿用已保存值); 当前以明文落 profile patch, 属已知待改进项') }),
    ])
    .default({ type: 'key' })
    .description('认证方式'),
  knownHostsPath: z.string().description('known_hosts 路径; 缺省 ~/.ssh/known_hosts'),
  connectTimeoutMs: z.number().min(500).default(10_000).description('连接超时(ms)'),
  keepaliveIntervalMs: z.number().min(1_000).default(15_000).description('keepalive 间隔(ms)'),
});

// Connection-pool sizing stays non-volatile: it is composition config, not a user form
// field, so it must not appear in the settings page.
// The hosts dict is volatile as a WHOLE object rather than per host entry: a volatile
// field must sit at a fixed object path, and a dict's keys are not fixed paths.
export const SshConfigSchema = z.object({
  maxConnections: z.number().min(1).default(4),
  maxChannelsPerConnection: z.number().min(1).default(6),
  hosts: z.dict(HostConfigSchema).default({}).volatile().description('SSH 主机配置(id → HostConfig 的持久化载体)'),
});

/** Extract the hosts dict from a resolved config document (tolerant of undefined). */
/**
 * The id → HostConfig dict out of a config object, tolerant of undefined and of both
 * value shapes a resolved schema produces.
 */
export function hostsOf(doc) {
  const hosts = unwrap(doc?.hosts);
  return hosts && typeof hosts === 'object' ? hosts : {};
}

// A volatile field resolves to a stable ref ({ get() }) rather than a plain value, so a
// live config edit is visible through the same object without re-reading the plugin.
// Non-volatile fields resolve to plain values, so both shapes must be accepted.
function unwrap(value) {
  return value && typeof value.get === 'function' ? value.get() : value;
}

/**
 * Read the hosts dict out of a plugin config object (volatile refs unwrapped).
 * The exported config is authoritative — dsh-settings imports a legacy settings.yaml
 * section into this entry — so there is no second namespace to fall back to.
 * @param config the plugin's resolved config (may be undefined before activation).
 * @returns { hosts } — the resolved id → HostConfig dict.
 */
export function readHosts(config) {
  return { hosts: hostsOf(config) };
}

// Direct-connection config resolution (tools/test paths) also reads through the plugin
// config, so a host added in the settings page is visible to the very next tool call.
export function resolveHostFromConfig(config, hostId) {
  const id = hostId != null ? String(hostId) : '';
  if (!id) return undefined;
  return hostsOf(config)[id];
}

/** True when the plugin config declares a form the user can edit. */
export function hasVolatileHosts(config) {
  return config?.hosts !== undefined;
}
