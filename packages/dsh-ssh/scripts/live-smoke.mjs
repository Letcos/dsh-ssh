#!/usr/bin/env node
// @dsh-ssh/dsh-ssh live smoke: real SSH against the test remote (public-key/agent auth),
// one pooled connection doing exec + SFTP. Uses an in-memory config ONLY — never
// writes ~/.dsh/settings.yaml and never touches the user's ~/.ssh/known_hosts
// (verification file is /tmp/dsh-ssh-test-known_hosts; acceptNew is a script-only fallback).
import { SshPool } from '../src/ssh-core.js';
import { liveConfig, liveHostConfig, requireRealHost } from '../test/live-config.mjs';
requireRealHost('scripts/live-smoke');

// PREREQ: a reachable SSH test remote matching the defaults in test/live-config.mjs
// (ubuntu@203.0.113.10:22, key ~/.ssh/id_ed25519). To run on another machine, export the
// DSH_SSH_TEST_* vars (HOST/PORT/USER/HOST_ID/KEY_PATH/REMOTE_ROOT). Touches only /tmp/dsh-ssh-* on the remote.
// Host/private-key config comes from live-config; defaults to id_ed25519, overridable via DSH_SSH_TEST_KEY_PATH.
const cfg = {
  ...liveHostConfig({ id: 'live-smoke' }),
  name: 'live smoke',
  knownHostsPath: '/tmp/dsh-ssh-test-known_hosts',
  acceptNew: true, // fallback for this script only: file already contains host key, this switch only relaxes when file missing/new host
  connectTimeoutMs: 10_000,
};

const pool = new SshPool({ maxConnections: 1 });
try {
  const conn = await pool.acquire(cfg);

  const r = await conn.exec('echo hi; hostname; uname -m');
  console.log('exec exit code:', r.code);
  console.log('exec stdout:', r.stdout.trim());
  if (r.code !== 0) throw new Error('exec failed: ' + r.stderr.trim());
  // Report the remote architecture (uname -m) without assuming a specific arch; assert non-empty output only.
  const arch = r.stdout.trim().split('\n').pop();
  console.log('remote arch (uname -m):', arch);
  if (!/hi/.test(r.stdout) || !r.stdout.trim()) throw new Error('unexpected exec output: ' + JSON.stringify(r.stdout));

  const sftp = await conn.sftp();
  const hostname = (await sftp.readText('/etc/hostname')).trim();
  console.log('sftp readText /etc/hostname:', hostname);
  const tmp = await sftp.listDir('/tmp');
  console.log('sftp listDir /tmp first 3:', tmp.slice(0, 3).map((e) => e.type + ' ' + e.name).join(', '));

  console.log('LIVE-SMOKE-OK');
  process.exit(0);
} catch (err) {
  console.error('LIVE-SMOKE-FAILED:', err?.message ?? err);
  if (err?.stage) console.error('stage:', err.stage, 'hostId:', err.hostId);
  process.exit(1);
} finally {
  await pool.dispose();
}
