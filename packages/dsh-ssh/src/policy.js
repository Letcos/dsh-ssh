// @dsh-ssh/dsh-ssh — remote sandbox permission semantics.
// The remote host has no sandbox runner, so mutation tools (write/edit/bash) are
// filtered at the tool layer with a coarse policy that mirrors the official
// dsh-fs-sandbox containment and dsh-tool-fs mapError semantics:
//   - danger-full-access: allow everything
//   - workspace-write: the resolved remote path must lie inside the workspace
//     (route.remoteCwd), otherwise reject
//   - read-only: reject all writes
// The denial shape matches the official FsError(code=FS_SANDBOX_DENIED,
// message=[sandbox: marker]\n[escalation hint]).
// Pure and side-effect free: the decision is based on lexically normalized paths
// (posix.normalize), consistent with the official "containment, not a security
// boundary" threat model (symlink/TOCTOU residuals accepted, see dsh-fs-sandbox
// lib/types/index.js header comment).
import { posix } from 'node:path';
import { FsError } from '@deepseek-ai/dsh-fs';
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox';

// Lexical containment test: target equals workspaceRoot or lies beneath it.
// Both sides are posix.normalized to drop ./.. and avoid prefix traps (with
// root=/tmp/foo, /tmp/foobar is not inside; compare against root + '/').
// workspaceRoot === '/' allows everything (whole filesystem is in-workspace).
export function isPathInsideWorkspace(targetPath, workspaceRoot) {
  if (typeof targetPath !== 'string' || typeof workspaceRoot !== 'string') return false;
  const target = posix.normalize(targetPath);
  let root = posix.normalize(workspaceRoot);
  if (root === '/') return true;
  if (root.endsWith('/')) root = root.slice(0, -1);
  if (root === '' || !posix.isAbsolute(root)) return false;
  if (target === root) return true;
  return target.startsWith(root + '/');
}

// Decide whether a mutation is denied under a mode: returns null (allowed) or
// the denying mode string. resolvedRemotePath must be the normalized absolute
// result of resolveRemotePath.
export function mutationDenialMode(mode, resolvedRemotePath, remoteCwd) {
  switch (mode) {
    case 'danger-full-access': return null;
    case 'read-only': return 'read-only';
    case 'workspace-write':
      return isPathInsideWorkspace(resolvedRemotePath, remoteCwd) ? null : 'workspace-write';
    default:
      // Unknown mode: fail closed to a denial (same direction as the official renderPolicyContext, which throws on unknown modes).
      return typeof mode === 'string' && mode.length > 0 ? mode : 'unknown';
  }
}

// Build an official-shaped denial error (thrown by write/edit; bash uses the sandbox.denied result shape).
export function sandboxDenialError(mode, subject = 'operation') {
  return new FsError(
    `${sandboxDenialMarker(mode)}\n${escalationHintMarker(subject)}`,
    'FS_SANDBOX_DENIED',
  );
}
