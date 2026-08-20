// @dsh-ssh/dsh-ssh — host-side Typert remote for the settings-page host editor.
// Settings are not exposed to configuration clients over the wire (the official
// gateway hard-whitelists namespaces — dsh-host-apiproxy/lib/index.js:888
// WEB_SETTINGS_NAMESPACES), so the whole host CRUD lives here:
//   - SshRemoteService: a Cordis Service under key 'ssh' carrying a visible
//     typertRemote binding (bindTypertRemote) — the gateway's validateBinding
//     requires exactly this shape (dsh-api-gateway/lib/index.js:282).
//   - ctx.typert.register(HOST_TYPERT_CONTRIBUTION): strict descriptors so the
//     gateway claims /api/ssh/{testConnection,listHosts,saveHost,deleteHost}
//     (claimsEndpoint) and dispatches to ctx.get('ssh').<method>(...).
// The unredacted stored hosts come from ctx.settings.get('dsh-ssh-hosts') so a
// password-auth host can be tested/saved even when the form left the password
// blank; listHosts redacts before the value leaves the process.
import { Service } from '@deepseek-ai/cordis';
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { SshError, HOST_KEY_UNKNOWN_STAGE, sshKeyFingerprint, sshKeyTypeFromBlob, appendKnownHost, defaultKnownHostsPath } from './ssh-core.js';
import { createPlaceholderDir, hostDisplayName, placeholderWorkspaceTitle } from './placeholder.js';
import { encodeRemotePath } from './router.js';
import { HOST_TYPERT_CONTRIBUTION, REMOTE_SERVICE, assertContributionShape } from '../lib/typert-contribution.js';
import { mergeTestConfig, mergeHostPatch, validateHostConfig, formatHostErrors, redactHosts, hostsSecretsList } from '../lib/hosts-model.js';
import { HOSTS_NAMESPACE, readHostsDoc } from './settings.js';

// ── TOFU host-side structured error surface ────────────────────────────────
// The gateway (dsh-api-gateway) serializes only the message of a thrown error
// (see rpcFailure: code/message/details), dropping structured fields
// (stage/fingerprint/rawKeyBase64 etc.). So host-key-unknown is always reported as
// a method return value, not thrown — testConnection already returns {ok:false,error};
// browsing methods (resolveRemoteHome/listRemoteDir) return the same shape on a
// connect-stage host-key-unknown, which the frontend uses to show the trust dialog.
function isHostKeyUnknown(err) {
  return err instanceof SshError && err.isHostKeyUnknown;
}
// Unified structured host-key-unknown return value (same fields as ssh-core's testConnection).
function hostKeyUnknownResult(err) {
  return {
    ok: false,
    stage: HOST_KEY_UNKNOWN_STAGE,
    hostId: err.hostId,
    host: err.host,
    port: err.port,
    fingerprint: err.fingerprint,
    rawKeyBase64: err.rawKeyBase64,
    keyType: err.keyType,
    message: err.message,
  };
}
// Try to connect with the stored cfg. Returns { result: 'host-key-unknown', ... } on
// a host-key-unknown, rethrows other errors, and { result: 'conn', conn } on success.
async function acquireStoredOrHostKeyUnknown(acquireFn, id) {
  try {
    const conn = await acquireFn(id);
    return { result: 'conn', conn };
  } catch (err) {
    if (isHostKeyUnknown(err)) return { result: 'host-key-unknown', err };
    throw err;
  }
}

export class SshRemoteService extends Service {
  constructor(ctx, sshPool) {
    super(ctx, REMOTE_SERVICE);
    this.typertRemote = bindTypertRemote(this, REMOTE_SERVICE);
    this.sshPool = sshPool;
    this.resolveStored = () => undefined;
    this.settingsApi = null; // { get, describe, mutate, writable } — set inside ctx.inject
    // workspaceRegistry resolved lazily (defaults to Cordis ctx.get; a test can inject a stub).
    // A placeholder workspace record's title must be written explicitly at creation
    // (the official workspace.create wire carries no title).
    this.resolveWorkspaceRegistry = () => this.ctx?.get?.('workspaceRegistry');
    this.env = process.env; // environment for placeholder-root resolution (DSH_SSH_REMOTE_ROOT > DSH_HOME > ~/.dsh); injectable in tests
  }

  /** Inject-time hook: supply the stored-host lookup (settings.get is only safe inside ctx.inject). */
  setStoredResolver(fn) {
    this.resolveStored = typeof fn === 'function' ? fn : () => undefined;
  }

  /** Inject-time hook: supply the live settings provider for CRUD reads/writes. */
  setSettingsApi(api) {
    this.settingsApi = api && typeof api === 'object' ? api : null;
  }

  /** Inject-time hook: supply the workspaceRegistry lookup (defaults to lazy ctx.get). */
  setWorkspaceRegistry(fn) {
    this.resolveWorkspaceRegistry = typeof fn === 'function' ? fn : () => undefined;
  }

  /** Current hosts state: resolved dict (UNREDACTED, dsh-ssh-hosts → dsh-ssh-hosts read fallback), scope revision, writability. */
  readState() {
    const api = this.settingsApi;
    const { hosts } = readHostsDoc(api && typeof api.get === 'function' ? (ns) => api.get(ns) : null);
    let revision = 0;
    try {
      const desc = api?.describe?.() ?? [];
      const found = Array.isArray(desc) ? desc.find((d) => d && d.ns === HOSTS_NAMESPACE) : undefined;
      if (found && typeof found.revision === 'number') revision = found.revision;
    } catch {
      revision = 0;
    }
    let writable = true;
    try { writable = api ? !!api.writable : true; } catch { writable = true; }
    return { hosts, revision, writable };
  }

  /** Map a settings write rejection to a clear, wire-safe error (conflict = retry hint). */
  wrapWriteError(error, verb) {
    const raw = error instanceof Error ? error : error && typeof error === 'object' ? error : { message: String(error) };
    const text = String(raw.message ?? '');
    const conflict = raw.code === 'SETTINGS_CONFLICT' || raw.name === 'SettingsConflictError' || text.includes('SETTINGS_CONFLICT');
    if (conflict) {
      return new Error(verb + '失败: 配置已被其他会话修改 (SETTINGS_CONFLICT), 请刷新后重试');
    }
    return new Error(verb + '失败: ' + text);
  }

  /**
   * Test a connection. request = { cfg: partial HostConfig }. Secret/auth
   * gaps are filled from the stored (unredacted) settings value when present.
   * @returns { ok: true, banner? } | { ok: false, error }  (SshPool.testConnection)
   */
  testConnection(request) {
    const req = request && typeof request === 'object' ? request : {};
    const cfg = req.cfg && typeof req.cfg === 'object' ? req.cfg : {};
    let stored;
    try {
      stored = this.resolveStored(cfg.id) ?? undefined;
    } catch {
      stored = undefined;
    }
    return this.sshPool.testConnection(mergeTestConfig(cfg, stored));
  }

  /**
   * List hosts for the editor: REDACTED dict + revision (optimistic
   * concurrency for saveHost/deleteHost) + secrets + writability.
   * @returns { hosts: {id: redacted HostConfig}, secrets: [{path, set}], revision, writable }
   */
  listHosts() {
    const { hosts, revision, writable } = this.readState();
    return { hosts: redactHosts(hosts), secrets: hostsSecretsList(hosts), revision, writable };
  }

  /**
   * Create or update one host. Positional wire args (Typert dispatch order):
   *   id     the host id the entry is written under (authoritative).
   *   patch  the form HostConfig (auth.password present ONLY when the user
   *          typed a new one; omitted/blank = keep the stored secret).
   *   revision  the settings revision listHosts returned — optimistic
   *          concurrency: a namespace that moved past it rejects the write
   *          with SETTINGS_CONFLICT so the client can prompt a refresh.
   * The patch is merged over the stored entry with the write-only-password
   * semantics (blank = keep stored; switch to key = clear), re-validated
   * host-side (remote values are not trusted), then written as one settings
   * mutate set-op. @returns { ok: true }
   */
  async saveHost(id, patch, revision) {
    const hostId = id != null ? String(id) : '';
    if (!hostId) throw new Error('saveHost: host id is required');
    const api = this.settingsApi;
    if (!api) throw new Error('saveHost: settings service unavailable');
    const { hosts } = this.readState();
    const next = mergeHostPatch(hosts[hostId], patch, hostId);
    const checked = validateHostConfig(next);
    if (!checked.ok) throw new Error('saveHost: 主机配置无效 (' + formatHostErrors(checked.errors) + ')');
    // Full write: commit the entire validated host dict (including hosts still only in
    // the legacy namespace) as one atomic set into the new namespace, so the first edit
    // loses no already-configured host during the dssh-hosts → dsh-ssh-hosts rename.
    const nextHosts = { ...hosts, [hostId]: next };
    try {
      await api.mutate(HOSTS_NAMESPACE, [{ op: 'set', path: ['hosts'], value: nextHosts }], revision);
    } catch (error) {
      throw this.wrapWriteError(error, '保存主机');
    }
    return { ok: true };
  }

  /**
   * Delete one host entry (settings mutate unset of ['hosts', id]). Missing
   * ids are idempotent. revision is the same optimistic-concurrency guard as
   * saveHost. @returns { ok: true }
   */
  async deleteHost(id, revision) {
    const hostId = id != null ? String(id) : '';
    if (!hostId) throw new Error('deleteHost: host id is required');
    const api = this.settingsApi;
    if (!api) throw new Error('deleteHost: settings service unavailable');
    const { hosts } = this.readState();
    if (!Object.prototype.hasOwnProperty.call(hosts, hostId)) return { ok: true };
    const nextHosts = { ...hosts };
    delete nextHosts[hostId];
    try {
      await api.mutate(HOSTS_NAMESPACE, [{ op: 'set', path: ['hosts'], value: nextHosts }], revision);
    } catch (error) {
      throw this.wrapWriteError(error, '删除主机');
    }
    return { ok: true };
  }

  // ---------- Remote directory browsing + placeholder creation ----------
  // Connection endpoints resolve the STORED (unredacted) HostConfig and reuse the
  // connection pool; failures become SshError.
  async _acquireStored(hostId) {
    const id = hostId != null ? String(hostId) : '';
    if (!id) throw new SshError({ hostId: id, stage: 'resolve-host', message: 'host id is required' });
    const cfg = this.resolveStored(id);
    if (!cfg || typeof cfg !== 'object') {
      throw new SshError({ hostId: id, stage: 'resolve-host', message: 'remote host "' + id + '" is not configured in dsh-ssh-hosts' });
    }
    return this.sshPool.acquire({ ...cfg, id });
  }

  /**
   * List a remote directory. request = { hostId, path } (wire positional args hostId, path).
   * @returns DirEntry[] = [{ name, type: 'dir'|'file'|'link'|'other', size?, mtime? }],
   *   sorted directories-first then by name.
   */
  async listRemoteDir(hostId, path) {
    const id = hostId != null ? String(hostId) : '';
    const target = typeof path === 'string' ? path : '';
    if (!target) throw new SshError({ hostId: id, stage: 'sftp-readdir', message: 'listRemoteDir: remote path is required' });
    const aq = await acquireStoredOrHostKeyUnknown((h) => this._acquireStored(h), id);
    if (aq.result === 'host-key-unknown') return hostKeyUnknownResult(aq.err); // TOFU: return a value, not throw (the gateway drops structured fields)
    const conn = aq.conn;
    const fs = await conn.fs();
    const entries = await fs.listDir(target);
    return entries
      .map((e) => ({ name: e.name, type: e.type, size: e.size, mtime: e.mtime }))
      .sort((a, b) => {
        const ad = a.type === 'dir' ? 0 : 1;
        const bd = b.type === 'dir' ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
  }

  /**
   * Metadata for a single remote path. request = { hostId, path }.
   * @returns { type: 'directory'|'file'|'other', size?, mtime? } | null (missing).
   * Does not use SftpWrapper.stat — it discards mtime; this reads the raw handle
   * (ssh-core's SftpWrapper exposes this.sftp, an existing API surface).
   */
  async statRemote(hostId, path) {
    const id = hostId != null ? String(hostId) : '';
    const target = typeof path === 'string' ? path : '';
    if (!target) throw new SshError({ hostId: id, stage: 'sftp-stat', message: 'statRemote: remote path is required' });
    const aq = await acquireStoredOrHostKeyUnknown((h) => this._acquireStored(h), id);
    if (aq.result === 'host-key-unknown') return hostKeyUnknownResult(aq.err); // TOFU: return a value, not throw
    const conn = aq.conn;
    // Use conn.fs() uniformly (SFTP or exec fallback) and fs.stat directly (carries mtime; missing → undefined).
    const fs = await conn.fs();
    const st = await fs.stat(target);
    return st === undefined ? null : st;
  }

  /**
   * The remote login user's $HOME (exec echo $HOME). request = { hostId }.
   * @returns home absolute path string.
   */
  async resolveRemoteHome(hostId) {
    const id = hostId != null ? String(hostId) : '';
    const aq = await acquireStoredOrHostKeyUnknown((h) => this._acquireStored(h), id);
    if (aq.result === 'host-key-unknown') return hostKeyUnknownResult(aq.err); // TOFU: return a value, not throw
    const conn = aq.conn;
    const r = await conn.exec('echo $HOME', { timeoutMs: 15_000 });
    if (r.code !== 0) {
      throw new SshError({ hostId: id, stage: 'exec', message: 'resolveRemoteHome failed: exit ' + r.code + ': ' + r.stderr.trim() });
    }
    const home = r.stdout.trim();
    if (!home || !home.startsWith('/')) {
      throw new SshError({ hostId: id, stage: 'exec', message: 'resolveRemoteHome: unexpected $HOME value ' + JSON.stringify(home) });
    }
    return home;
  }

  /**
   * Save trust for a host key the user confirmed (TOFU trust-save): append it to
   * known_hosts. Inputs (passed back verbatim from what the frontend captured on
   * failure) are hostId + rawKeyBase64 + fingerprint.
   * TOCTOU guard: the key appended must be the exact one the user saw in the dialog —
   * the host never re-handshakes to fetch the key; before writing, the raw key's
   * fingerprint is checked against the confirmed fingerprint, and a mismatch is rejected.
   * The path is host.knownHostsPath || defaultKnownHostsPath() (same as connect).
   * appendKnownHost makes it idempotent (no duplicate when host+keytype+key exists).
   * @returns { ok: true, path, appended, keyType }
   */
  async trustHostKey(hostId, rawKeyBase64, fingerprint) {
    const id = hostId != null ? String(hostId) : '';
    const cfg = this.resolveStored(id);
    if (!cfg || typeof cfg !== 'object') {
      throw new Error('trustHostKey: remote host "' + id + '" is not configured in dsh-ssh-hosts');
    }
    if (typeof rawKeyBase64 !== 'string' || rawKeyBase64 === '') {
      throw new Error('trustHostKey: raw host key is required');
    }
    let key;
    try { key = Buffer.from(rawKeyBase64, 'base64'); } catch { key = Buffer.alloc(0); }
    if (!key || key.length === 0) throw new Error('trustHostKey: invalid raw host key');
    // Fingerprint recheck: refuse a key whose fingerprint differs from the confirmed
    // one, preventing a tampered/miswritten key from landing on disk.
    const computed = sshKeyFingerprint(key);
    if (typeof fingerprint === 'string' && fingerprint !== '' && computed !== fingerprint) {
      throw new Error('trustHostKey: fingerprint does not match the confirmed key (refuse to write)');
    }
    const keyType = sshKeyTypeFromBlob(key) || 'ssh-unknown';
    const path = cfg.knownHostsPath || defaultKnownHostsPath();
    const res = await appendKnownHost(path, cfg.host, cfg.port ?? 22, keyType, rawKeyBase64, { hostId: id });
    return { ok: true, path, appended: res.appended, keyType };
  }

  /**
   * Create the local placeholder directory for a remote directory (purely local, no connect).
   * request = { hostId, remotePath }. Validates that hostId exists in dsh-ssh-hosts;
   * encodes with src/router.js mapRemoteToLocal (root =
   * <DSH_SSH_REMOTE_ROOT | $DSH_HOME || ~/.dsh>/remote), fs.mkdir recursive creates the
   * real directory; idempotent when it already exists. @returns { localPath, hostId, remotePath }.
   *
   * The placeholder workspace record's title is written as host display name / basename
   * (e.g. ubuntu / opencode-api) so the sidebar can distinguish hosts. The official
   * workspace.create wire only accepts { path } (dsh-host-apiproxy
   * workspaceCreateRequestSchema) and defaults the title to the directory basename, which
   * for a placeholder is the base64-encoded segment (unreadable, e.g. L2hvbWUv...; the actual
   * placeholder directory name stays encoded — only the display title is overridden).
   * We go through workspaceRegistry.create(path, title) directly (explicit titles are not
   * required to be unique, matching the local same-name convention). When the official flow
   * later adopts the same path, resolveByPath hits the existing record (created:false) and
   * the title is preserved. Old-signature titles are upgraded idempotently: ① base64-encoded
   * segment, ② bare basename (no host marker); anything else (user-edited or already the new
   * format) is left alone. Because localPath is built by this plugin's mapRemoteToLocal, the
   * upgrade only touches placeholder workspace records, never ordinary local workspaces. When
   * the registry is unavailable, fall back to the old behavior (no record write).
   */
  async createPlaceholder(hostId, remotePath) {
    const id = hostId != null ? String(hostId) : '';
    const target = typeof remotePath === 'string' ? remotePath : '';
    const { hosts } = this.readState();
    if (!Object.prototype.hasOwnProperty.call(hosts, id)) {
      throw new SshError({ hostId: id, stage: 'placeholder', message: 'createPlaceholder: remote host "' + id + '" is not configured in dsh-ssh-hosts' });
    }
    if (!target.startsWith('/')) {
      throw new SshError({ hostId: id, stage: 'placeholder', message: 'createPlaceholder: remote path must be absolute' });
    }
    try {
      const result = await createPlaceholderDir({ hostId: id, remotePath: target, env: this.env });
      const registry = this.resolveWorkspaceRegistry();
      if (registry && typeof registry.create === 'function') {
        // Title = host display name / basename (falling back to hostId), so the sidebar
        // can distinguish remote workspaces by host. This is the idempotent upgrade target
        // for legacy records (bare basename, base64-encoded segment, or legacy
        // "basename · host display name"); the placeholder folder's base64 name is not shown.
        // create() returns the existing entity when the path already has a record; because
        // localPath is built by this plugin's mapRemoteToLocal (placeholder-root/<hostId>/<base64>),
        // the upgrade only touches placeholder workspace records, never ordinary local workspaces.
        const hostName = hostDisplayName(hosts, id);
        const title = placeholderWorkspaceTitle(target, hostName);
        const entity = await registry.create(result.localPath, title);
        if (entity && typeof entity.setTitle === 'function') {
          const legacy = typeof entity.title === 'string' ? entity.title : '';
          const wantsBase = target.split('/').filter(Boolean).pop();
          const oldDotTitle = wantsBase + ' · ' + hostName; // legacy format: basename · host display name
          // Upgrade (idempotent, placeholder records only): rename only when the title matches
          // an old signature — ① base64-encoded segment, ② bare basename (no host marker),
          // ③ legacy "basename · host display name" auto-title. Anything else (user-edited, or
          // already the new hostname/basename format) is left alone so personal names are kept.
          const needsUpgrade = legacy === encodeRemotePath(target) || legacy === wantsBase || legacy === oldDotTitle;
          if (needsUpgrade && legacy !== title) await entity.setTitle(title);
        }
      }
      return result;
    } catch (err) {
      if (err instanceof SshError) throw err;
      throw new SshError({ hostId: id, stage: 'placeholder', message: 'createPlaceholder: ' + (err?.message ?? String(err)), cause: err });
    }
  }
}

/**
 * Register the remote service + typert contribution on a host ctx that already
 * owns the sshPool service. The typert registry and settings provider are
 * reached through ctx.inject so activation never blocks on them.
 */
export function registerRemote(ctx, sshPool) {
  const service = new SshRemoteService(ctx, sshPool);
  ctx.inject(['typert', 'settings'], (scope) => {
    service.setSettingsApi(scope.settings);
    service.setStoredResolver((id) => {
      if (!id) return undefined;
      try {
        const { hosts } = readHostsDoc((ns) => scope.settings.get(ns));
        return hosts[id] ?? undefined;
      } catch {
        return undefined;
      }
    });
    // Fail fast on a malformed contribution instead of a silent gateway miss.
    assertContributionShape(HOST_TYPERT_CONTRIBUTION);
    scope.typert.register(HOST_TYPERT_CONTRIBUTION);
    scope.logger?.info('[@dsh-ssh/dsh-ssh] typert remote ' + HOST_TYPERT_CONTRIBUTION.package
      + ' registered (ssh/testConnection, ssh/listHosts, ssh/saveHost, ssh/deleteHost,'
      + ' ssh/listRemoteDir, ssh/statRemote, ssh/resolveRemoteHome, ssh/createPlaceholder, ssh/trustHostKey)');
  });
  return service;
}
