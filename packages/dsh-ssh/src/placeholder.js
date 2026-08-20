// @dsh-ssh/dsh-ssh — placeholder directory creation.
// Pure with injectable fs/env, so unit tests never touch the real disk:
//   createPlaceholderDir({ hostId, remotePath, env, fsImpl })
//     → mapRemoteToLocal(router.js's reversible encoding, root =
//       <DSH_SSH_REMOTE_ROOT | $DSH_HOME || ~/.dsh>/remote)
//     → fs.mkdir({ recursive: true }) creates the real directory
//     → { localPath, hostId, remotePath }
// Idempotent: recursive mkdir succeeds when the directory already exists and
// creates missing parents.
// The placeholder directory must really exist and must not be a symlink:
// workspaceRegistry.create calls fs.realpath and rejects anything missing or
// non-directory.
import fs from 'node:fs';
import { mapRemoteToLocal } from './router.js';

/** Minimum constraint for a valid remote path: non-empty absolute (remote uses POSIX semantics). */
export function placeholderInvalidReason(hostId, remotePath) {
  if (typeof hostId !== 'string' || hostId.length === 0) return 'host id is required';
  if (typeof remotePath !== 'string' || remotePath.length === 0) return 'remote path is required';
  if (!remotePath.startsWith('/')) return 'remote path must be absolute';
  return null;
}

/**
 * Basename of the remote path (pure, testable); the basename half of the
 * placeholder workspace title. The placeholder directory name is a base64-encoded
 * segment (e.g. L2hvbWUv...), so we derive the title from the real remote path
 * instead.
 */
export function placeholderDisplayName(remotePath) {
  const text = typeof remotePath === 'string' ? remotePath : '';
  const parts = text.split('/');
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop(); // drop trailing slashes
  return parts.length > 1 ? parts[parts.length - 1] : 'root';
}

/**
 * Host display name: prefer the configured name from dsh-ssh-hosts (the user-set
 * display name), else fall back to hostId. The SSH banner is only available at
 * connect time and placeholder creation is purely local, so it is not used here.
 * Pure and testable.
 * @param hosts dsh-ssh-hosts dict (id → HostConfig); only the name field is read.
 * @param hostId host id (placeholder directory path segment); fallback when name is missing.
 */
export function hostDisplayName(hosts, hostId) {
  const id = typeof hostId === 'string' ? hostId : '';
  const entry = hosts && typeof hosts === 'object' ? hosts[id] : undefined;
  const name = entry && typeof entry === 'object' ? entry.name : undefined;
  if (typeof name === 'string' && name.trim().length > 0) return name.trim();
  return id || '?';
}

/**
 * Placeholder workspace title: host display name / basename (e.g. ubuntu /
 * opencode-api), so the sidebar can tell which host each workspace belongs to.
 * The host name is prefixed because a bare basename is ambiguous across hosts.
 * @param remotePath remote absolute path (its basename is used).
 * @param hostDisplayName host display name from {@link hostDisplayName}.
 */
export function placeholderWorkspaceTitle(remotePath, hostDisplayName) {
  return hostDisplayName + ' / ' + placeholderDisplayName(remotePath);
}

/**
 * Create the local placeholder directory and return the reversible mapping.
 * Throws when hostId is invalid or the path is not absolute; other (fs-layer)
 * failures propagate as-is and are wrapped as SshError by the caller
 * (SshRemoteService.createPlaceholder).
 */
export async function createPlaceholderDir({ hostId, remotePath, env, fsImpl = fs }) {
  const reason = placeholderInvalidReason(hostId, remotePath);
  if (reason) throw new Error('createPlaceholder: ' + reason);
  const localPath = mapRemoteToLocal(hostId, remotePath, env);
  if (!localPath) {
    throw new Error('createPlaceholder: invalid host id ' + JSON.stringify(hostId) + ' (unsafe segment)');
  }
  const promises = fsImpl && typeof fsImpl === 'object' ? fsImpl.promises : undefined;
  if (!promises || typeof promises.mkdir !== 'function') {
    throw new Error('createPlaceholder: fs implementation has no promises.mkdir');
  }
  await promises.mkdir.call(promises, localPath, { recursive: true });
  return { localPath, hostId, remotePath };
}
