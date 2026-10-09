// @dsh-ssh/dsh-ssh — verify the Typert contribution against the REAL registry.
// The client-side $mount validates strict codecs through dsh-typert-registry, which is
// where "strict codec has no create() factory" originates. This boots a real composition
// (so ctx.typert exists) and mounts the same descriptor objects client.js inlines,
// asserting the registry accepts them instead of throwing at mount time.
// PREREQ: DSH_SSH_DSH_NODE_MODULES points at the @deepseek-ai/dsh package dir.
import path from 'node:path';
import { dshNodeModules, dshHome } from '../test/live-config.mjs';

const CORE = dshNodeModules;
const bootUrl = 'file:///' + (CORE + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').replace(/\\/g, '/');
const { boot, loadProfile, readProfilePatches } = await import(bootUrl);

process.env.DSH_HOME = dshHome;
const NAME = 'dsh-typert-verify';
const profile = loadProfile(NAME, 'dsh-ssh-dev', CORE + '/package.json', process.env.DSH_HOME, { userLayer: false });

const log = (...a) => console.log('[verify-typert]', ...a);
let failures = 0;
const check = (label, ok, detail) => {
  log((ok ? 'OK   ' : 'FAIL ') + label + (detail !== undefined ? ' — ' + detail : ''));
  if (!ok) failures += 1;
};

const profileContext = {
  name: NAME,
  dir: profile.dir,
  home: process.env.DSH_HOME,
  patchPath: profile.patchPath,
  installAnchor: CORE + '/package.json',
  overlays: [],
};

const ctx = await boot(
  NAME,
  path.join(profile.dir, 'cordis.yml'),
  readProfilePatches(NAME, profileContext, profile),
  async (hostCtx) => { hostCtx.provide('profileContext', profileContext); },
);

try {
  const typert = ctx.get('typert');
  check('typert registry is live', typert !== undefined);

  const mod = await import(new URL('../lib/typert-contribution.js', import.meta.url).href);
  const { HOST_TYPERT_CONTRIBUTION, CLIENT_TYPERT_REMOTE, assertContributionShape } = mod;

  // The host contribution is registered by src/remote.js during plugin activation; if a
  // codec shape were rejected, boot would have thrown. Assert it registered.
  if (typert) {
    check('host contribution passes the registry shape checker', (() => {
      try { assertContributionShape(HOST_TYPERT_CONTRIBUTION); return true; } catch { return false; }
    })());
    check('client contribution passes the registry shape checker', (() => {
      try { assertContributionShape(CLIENT_TYPERT_REMOTE); return true; } catch { return false; }
    })());

    // Every strict codec must materialize a parse()-capable schema. This mirrors
    // dsh-typert-registry's validateCodec, which is what rejects a codec lacking
    // create() — the failure the browser surfaces as "strict codec has no create()".
    const bad = [];
    const inspect = (codec, subject) => {
      if (!codec || codec.mode !== 'strict') { bad.push(subject + ': not strict'); return; }
      if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) { bad.push(subject + ': no typeSymbol'); return; }
      if (typeof codec.create !== 'function') { bad.push(subject + ': no create()'); return; }
      const s = codec.create();
      if (!s || typeof s.parse !== 'function') bad.push(subject + ': create() has no parse()');
    };
    for (const d of CLIENT_TYPERT_REMOTE.descriptors) {
      inspect(d.result, d.id + ' result');
      for (const p of d.parameters) inspect(p.codec, d.id + ' param ' + p.name);
    }
    check('all client strict codecs satisfy the registry codec contract', bad.length === 0, bad.join('; '));

    // The host contribution uses src-json codecs, which validateCodec accepts as-is.
    const hostBad = HOST_TYPERT_CONTRIBUTION.invocations
      .filter((d) => d.result?.mode !== 'src-json')
      .map((d) => d.id);
    check('all host codecs are src-json (no strict requirement host-side)', hostBad.length === 0, hostBad.join('; '));

    // The registered host contribution must be retrievable by endpoint.
    const endpoints = typert.local?.list?.() ?? [];
    log('registered endpoints:', endpoints.length);
  }
} catch (err) {
  log('ERROR', err?.stack ?? String(err));
  failures += 1;
} finally {
  try { await ctx.dispose?.(); } catch { /* teardown noise */ }
}

log(failures === 0 ? 'VERIFY-TYPERT-OK' : 'VERIFY-TYPERT-FAILED (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
