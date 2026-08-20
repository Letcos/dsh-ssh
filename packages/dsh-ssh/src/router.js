// @dsh-ssh/dsh-ssh — placeholder-directory ↔ remote-path routing.
// Plain ESM, zero dependencies (node:path/node:os only). Encodes the core
// assumption "a remote workspace is a local placeholder directory":
//   placeholder root remoteRoot() = <DSH_SSH_REMOTE_ROOT | $DSH_HOME || ~/.dsh>/remote
//   placeholder path = <root>/<hostId>/<base64url(absolute remote path)>
//     (exactly two segments: hostId + encoded segment)
// The encoding is reversible (base64url, single segment, no '/'); hostId is
// validated to reject path traversal; decoding must round-trip to an absolute
// path (starts with '/').
// Pure, no IO, no settings dependency: unknown hostIds are left to tools.js at
// call time (reported as "not configured" rather than silently treated as local).
import os from 'node:os';
import path from 'node:path';
import { posix } from 'node:path';

// Environment override precedence: DSH_SSH_REMOTE_ROOT > $DSH_HOME/remote > ~/.dsh/remote
export function remoteRoot(env = process.env) {
  if (env && env.DSH_SSH_REMOTE_ROOT) return path.resolve(String(env.DSH_SSH_REMOTE_ROOT));
  const dshHome = env && env.DSH_HOME ? String(env.DSH_HOME) : path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'remote');
}

// A hostId must be a safe single-segment directory name: alphanumeric start,
// optionally followed by . _ -, and must not be . or ...
export function isValidHostId(hostId) {
  if (typeof hostId !== 'string' || hostId.length === 0) return false;
  if (hostId === '.' || hostId === '..') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostId);
}

// Absolute remote path → base64url (no padding): single segment, no '/'.
export function encodeRemotePath(remotePath) {
  return Buffer.from(String(remotePath), 'utf8').toString('base64url');
}

// base64url → original string; null for invalid / non-canonical input (reversibility guard).
export function decodeRemotePath(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let text;
  try {
    text = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // Reject non-canonical encodings (padding/illegal chars were already blocked by
  // the regex; this guarantees decode→re-encode round-trips, ruling out ambiguous input)
  if (encodeRemotePath(text) !== encoded) return null;
  return text;
}

// Remote → local placeholder path. The caller must ensure hostId is valid (otherwise null).
export function mapRemoteToLocal(hostId, remotePath, env) {
  if (!isValidHostId(hostId)) return null;
  const root = remoteRoot(env);
  return path.join(root, hostId, encodeRemotePath(remotePath));
}

// Local path → { hostId, remotePath } | null. Requires exactly two segments
// <root>/<hostId>/<encoded>, and the encoded segment must decode to an absolute
// path starting with '/' (reversible, no traversal; a coincidentally matching
// real local directory is never misdetected).
export function mapLocalToRemote(localPath, env) {
  if (typeof localPath !== 'string' || localPath.length === 0) return null;
  const root = remoteRoot(env);
  const rel = path.relative(root, localPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segments = rel.split(path.sep);
  if (segments.length !== 2) return null;
  const hostId = segments[0];
  const encoded = segments[1];
  if (!isValidHostId(hostId)) return null;
  const remotePath = decodeRemotePath(encoded);
  if (remotePath === null) return null;
  if (!path.isAbsolute(remotePath) || !remotePath.startsWith('/')) return null;
  return { hostId, remotePath };
}

// Routing entry: a session cwd that is exactly a placeholder path → remote, otherwise local (never throws).
export function routeByCwd(cwd, env) {
  const mapped = mapLocalToRemote(cwd, env);
  if (mapped === null) return { kind: 'local' };
  return { kind: 'remote', hostId: mapped.hostId, remoteCwd: mapped.remotePath };
}

// Remote path resolution: relative paths are based on remoteCwd; absolute paths
// under the placeholder workspace (<placeholderCwd>/... shape) are re-anchored
// back to the remote; all other absolute paths pass through as remote absolute
// paths (everything inside a remote workspace is remote, matching the local
// "byte-for-byte identical" semantics).
export function resolveRemotePath(requestedPath, remoteCwd, placeholderCwd) {
  // On Windows the placeholder workspace cwd is a native local path
  // (C:\...\remote\<hostId>\<enc> or \...), for which posix.isAbsolute is false;
  // so the platform path.relative recognizes the "inside the placeholder root"
  // re-anchoring branch.
  if (!posix.isAbsolute(requestedPath)) {
    if (placeholderCwd) {
      const rel = path.relative(placeholderCwd, requestedPath);
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return posix.join(remoteCwd, rel.split(path.sep).join('/'));
      }
    }
    return posix.resolve(remoteCwd, requestedPath);
  }
  if (placeholderCwd) {
    const rel = posix.relative(placeholderCwd, requestedPath);
    if (rel !== '' && !rel.startsWith('..') && !posix.isAbsolute(rel)) {
      return posix.join(remoteCwd, rel);
    }
  }
  // Normalize absolute paths: fold ./../ and repeated slashes, closing lexical
  // escapes like /data/work/../etc (lexical normalization, no symlink resolution
  // — consistent with the official dsh-fs-sandbox containment threat model).
  return posix.normalize(requestedPath);
}
