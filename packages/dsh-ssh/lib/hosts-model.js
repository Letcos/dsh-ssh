// @dsh-ssh/dsh-ssh — pure host-model for the settings-page SSH host editor.
// Canonical copy of the form/serialization logic; unit-tested under node --test.
// The client bundle (client.js) carries an inlined, verbatim copy of the pure
// functions below (the web ModuleLoader cannot resolve relative imports), so any
// change here MUST be mirrored there. Everything here is plain ESM with zero
// imports — safe for node --test and for the browser.
//
// Settings shape: hosts is a DICT keyed by host id (string), not an array. The
// stored value must survive a merge where the wire never echoes the write-only
// password — with a dict, omitting auth.password preserves the stored value, and
// a set/unset path op ['hosts', <id>] replaces or removes exactly one entry. Since
// the settings wire is not exposed to configuration clients, all CRUD rides the
// Typert remote (SshRemoteService.listHosts/saveHost/deleteHost); the pure
// functions here implement the write-only secret semantics.

/** Port: number | null. '' / absent / invalid -> null (default 22 applied later). */
export function normalizePort(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

export const AUTH_TYPES = ['key', 'password'];

/**
 * Validate one host form (the browser form state, all strings).
 * Returns { ok:true, value } | { ok:false, errors:{ field: message } }.
 * value = { name, host, port(number|null), user, authType, privateKeyPath }.
 */
export function validateHostForm(form) {
  const errors = {};
  const name = String(form?.name ?? '').trim();
  const host = String(form?.host ?? '').trim();
  const user = String(form?.user ?? '').trim();
  const authType = form?.authType === 'password' ? 'password' : 'key';
  const privateKeyPath = String(form?.privateKeyPath ?? '').trim();
  const port = normalizePort(form?.port);
  if (!name) errors.name = 'required';
  if (!host) errors.host = 'required';
  else if (host.includes(' ')) errors.host = 'noSpaces';
  if (form?.port !== undefined && form?.port !== null && form?.port !== '' && port === null) errors.port = 'range';
  if (!user) errors.user = 'required';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, host, port, user, authType, privateKeyPath } };
}

/** Human display name of a stored (possibly redacted) HostConfig. */
export function displayHostTitle(host) {
  const name = host?.name && String(host.name).trim() ? String(host.name).trim() : '';
  const id = host?.id ? String(host.id) : '';
  const hostPart = host?.host ? String(host.host) : '';
  return name || (hostPart ? hostPart + (id ? ' (' + id + ')' : '') : id || '(unnamed)');
}

/** Redacted auth mode: 'password' when the union discriminator says so. */
export function displayAuthType(host) {
  return host?.auth && host.auth.type === 'password' ? 'password' : 'key';
}

/**
 * Build the persisted HostConfig for one form + optional new password.
 * auth.password is included ONLY when newPassword is non-empty (write-only
 * direction); a blank password means "keep the stored value" and the merge
 * layer preserves it (dict shape).
 */
export function buildHostConfig(form, existingId, newPassword) {
  const value = String(form?.newPassword ?? '');
  const password = value.trim();
  const auth = form?.authType === 'password'
    ? (password ? { type: 'password', password } : { type: 'password' })
    : { type: 'key', ...(String(form?.privateKeyPath ?? '').trim() ? { privateKeyPath: String(form.privateKeyPath).trim() } : {}) };
  const cfg = {
    id: existingId ?? newHostId(),
    name: String(form?.name ?? '').trim(),
    host: String(form?.host ?? '').trim(),
    port: normalizePort(form?.port) ?? 22,
    user: String(form?.user ?? '').trim(),
    auth,
  };
  const known = form?.knownHostsPath !== undefined && form.knownHostsPath !== null
    ? String(form.knownHostsPath).trim() : '';
  if (known) cfg.knownHostsPath = known;
  if (form?.connectTimeoutMs) cfg.connectTimeoutMs = Number(form.connectTimeoutMs);
  return cfg;
}

/** New stable host id (uuid v4; fallback for non-crypto environments). */
export function newHostId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'h-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Secret slot path for one host's password in the settings section. */
export function secretPathFor(hostId) {
  return ['hosts', String(hostId), 'auth', 'password'];
}

/** Whether the redacted describe() secrets list reports a set password for hostId. */
export function isHostSecretSet(secrets, hostId) {
  if (!Array.isArray(secrets)) return false;
  const target = ['hosts', String(hostId), 'auth', 'password'];
  return secrets.some((s) => s && s.set === true && Array.isArray(s.path)
    && s.path.length === target.length && s.path.every((p, i) => p === target[i]));
}

/** Sort hosts dict into a display list (by name, then id). */
export function sortedHosts(hosts) {
  if (!hosts || typeof hosts !== 'object') return [];
  return Object.entries(hosts)
    .map(([id, host]) => ({ ...host, id: String(host?.id ?? id) }))
    .sort((a, b) => {
      const an = displayHostTitle(a).toLowerCase();
      const bn = displayHostTitle(b).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
}

/**
 * Merge a partial save patch over the STORED (unredacted) host config —
 * the host-side secret semantics of the write-only password field.
 * @param current the stored HostConfig from the settings dict, or undefined
 *   for a brand-new host.
 * @param patch the client-sent patch (the form's HostConfig; auth.password
 *   present ONLY when the user typed a new password).
 * @param id the host id the entry is written under (always authoritative).
 * @returns the full next HostConfig for the settings mutate set-op.
 *
 * Semantics:
 *   - patch.auth.type === 'password' && no password  -> keep stored password
 *     (blank write-only field = unchanged).
 *   - patch.auth.type === 'password' && password     -> overwrite password.
 *   - patch.auth.type === 'key'                      -> password cleared
 *     (auth switch drops the stored secret).
 */
export function mergeHostPatch(current, patch, id) {
  const cur = current && typeof current === 'object' ? current : {};
  const p = patch && typeof patch === 'object' ? patch : {};
  const curAuth = cur.auth && typeof cur.auth === 'object' ? cur.auth : undefined;
  const auth = p.auth && typeof p.auth === 'object' ? p.auth : undefined;
  let nextAuth;
  if (auth?.type === 'password') {
    nextAuth = { type: 'password' };
    if (auth.password) nextAuth.password = String(auth.password);
    else if (curAuth?.type === 'password' && curAuth.password) nextAuth.password = curAuth.password;
  } else if (auth?.type === 'key') {
    nextAuth = { type: 'key' };
    const keyPath = auth.privateKeyPath !== undefined
      ? String(auth.privateKeyPath).trim()
      : (curAuth?.type === 'key' ? (curAuth.privateKeyPath ?? '') : '');
    if (keyPath) nextAuth.privateKeyPath = keyPath;
  } else {
    nextAuth = curAuth ? { ...curAuth } : { type: 'key' };
  }
  const next = {
    id: String(id),
    name: p.name !== undefined ? String(p.name).trim() : (cur.name ?? ''),
    host: p.host !== undefined ? String(p.host).trim() : (cur.host ?? ''),
    port: p.port !== undefined ? normalizePort(p.port) ?? 22 : (cur.port ?? 22),
    user: p.user !== undefined ? String(p.user).trim() : (cur.user ?? ''),
    auth: nextAuth,
  };
  if (p.knownHostsPath !== undefined) {
    const known = String(p.knownHostsPath).trim();
    if (known) next.knownHostsPath = known;
  } else if (cur.knownHostsPath) {
    next.knownHostsPath = cur.knownHostsPath;
  }
  if (p.connectTimeoutMs !== undefined) next.connectTimeoutMs = Number(p.connectTimeoutMs);
  else if (cur.connectTimeoutMs !== undefined) next.connectTimeoutMs = cur.connectTimeoutMs;
  if (p.keepaliveIntervalMs !== undefined) next.keepaliveIntervalMs = Number(p.keepaliveIntervalMs);
  else if (cur.keepaliveIntervalMs !== undefined) next.keepaliveIntervalMs = cur.keepaliveIntervalMs;
  return next;
}

/**
 * Structural HostConfig validation mirroring the HostConfigSchema rules in
 * src/settings.js — the HOST side re-validates everything the wire carries
 * (remote values are not trusted). Returns { ok:true, value } | { ok:false, errors }.
 */
export function validateHostConfig(host) {
  if (!host || typeof host !== 'object') return { ok: false, errors: { host: 'not-an-object' } };
  const errors = {};
  if (!String(host.id ?? '')) errors.id = 'required';
  const name = String(host.name ?? '').trim();
  if (!name) errors.name = 'required';
  const hostPart = String(host.host ?? '').trim();
  if (!hostPart) errors.host = 'required';
  else if (hostPart.includes(' ')) errors.host = 'noSpaces';
  if (normalizePort(host.port) === null) errors.port = 'range';
  const user = String(host.user ?? '').trim();
  if (!user) errors.user = 'required';
  const auth = host.auth && typeof host.auth === 'object' ? host.auth : {};
  if (auth.type !== 'key' && auth.type !== 'password') errors.auth = 'type';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: host };
}

/** Error text for { ok:false, errors } — host-side saveHost rejection message. */
export function formatHostErrors(errors) {
  const e = errors && typeof errors === 'object' ? errors : {};
  return Object.entries(e).map(([k, v]) => k + '=' + v).join(', ') || 'invalid';
}

/**
 * Deep-clone a hosts dict with every auth.password stripped — the redacted
 * view sent to the client (listHosts). The wire must never see the secret.
 */
export function redactHosts(hosts) {
  const out = {};
  for (const [id, host] of Object.entries(hosts ?? {})) {
    if (!host || typeof host !== 'object') { out[id] = host; continue; }
    const h = { ...host };
    if (h.auth && typeof h.auth === 'object' && h.auth.type === 'password') {
      h.auth = { ...h.auth };
      delete h.auth.password;
    }
    out[id] = h;
  }
  return out;
}

/**
 * The redacted secrets list for a hosts dict (listHosts): one entry per host
 * that actually stores a password, shaped like the settings describe()
 * secrets slots ([{path, set}]) so the client's isHostSecretSet keeps working.
 */
export function hostsSecretsList(hosts) {
  const secrets = [];
  for (const [id, host] of Object.entries(hosts ?? {})) {
    if (host && typeof host === 'object' && host.auth && typeof host.auth === 'object'
      && host.auth.type === 'password' && host.auth.password) {
      secrets.push({ path: secretPathFor(id), set: true });
    }
  }
  return secrets;
}

/**
 * Merge a client-supplied test-connection config with the stored host config
 * (host-side, where the unredacted value IS available). Fills auth material
 * and defaults that the redacted form could not carry.
 * @param cfg the client-sent partial config (may omit the secret).
 * @param stored the stored HostConfig from ctx.settings.get('dsh-ssh-hosts'), or undefined.
 * @returns the effective HostConfig for SshPool.testConnection.
 */
export function mergeTestConfig(cfg, stored) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const s = stored && typeof stored === 'object' ? stored : undefined;
  const id = c.id || (s ? s.id : undefined);
  const host = c.host || (s ? s.host : undefined) || '';
  const port = normalizePort(c.port) ?? (s && s.port) ?? 22;
  const user = c.user || (s ? s.user : undefined) || '';
  let auth = c.auth && typeof c.auth === 'object' ? c.auth : undefined;
  if (!auth && s && s.auth) auth = s.auth;
  if (auth && typeof auth === 'object') {
    if (auth.type === 'password' && !auth.password && s?.auth?.type === 'password' && s.auth.password) {
      auth = { type: 'password', password: s.auth.password };
    } else if (auth.type === 'key' && !auth.privateKeyPath && s?.auth?.type === 'key' && s.auth.privateKeyPath) {
      auth = { ...auth, privateKeyPath: s.auth.privateKeyPath };
    }
  }
  const merged = {
    id,
    host,
    port,
    user,
    auth: auth ?? { type: 'key' },
  };
  if (!c.knownHostsPath && s?.knownHostsPath) merged.knownHostsPath = s.knownHostsPath;
  if (c.connectTimeoutMs === undefined && s?.connectTimeoutMs !== undefined) merged.connectTimeoutMs = s.connectTimeoutMs;
  if (c.keepaliveIntervalMs === undefined && s?.keepaliveIntervalMs !== undefined) merged.keepaliveIntervalMs = s.keepaliveIntervalMs;
  return merged;
}

/** Fold a transport rejection or an {ok:false} envelope into a message. */
export function messageOf(error) {
  if (error && typeof error === 'object') {
    if (error.message) return String(error.message);
    if (error.code) return String(error.code);
  }
  return String(error);
}
