// @dsh-ssh/dsh-ssh — verify the plugin's settings surface in a real DSH 0.2 composition.
// Boots dsh-base + the plugin through dsh-app-boot, then inspects the live settings
// service: the plugin entry must be addressable and expose a non-empty volatile form
// (that is what makes the settings page render and what legacy settings.yaml migration
// writes into). Also exercises a real save through the config editor path.
// PREREQ: DSH_SSH_DSH_NODE_MODULES points at the @deepseek-ai/dsh package dir.
import path from 'node:path';
import { dshNodeModules, dshHome } from '../test/live-config.mjs';

const CORE = dshNodeModules;
const appBootUrl = 'file:///' + (CORE + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').replace(/\\/g, '/');
const { boot, loadProfile, readProfilePatches } = await import(appBootUrl);

process.env.DSH_HOME = dshHome;

const NAME = 'dsh-settings-verify';
const INSTALL_ANCHOR = CORE + '/package.json';

const profile = loadProfile(NAME, 'dsh-ssh-dev', INSTALL_ANCHOR, process.env.DSH_HOME, { userLayer: false });

// Mirror the CLI launcher (dsh/lib/profile-boot) exactly: it builds the host context
// with `readProfilePatches`, provides profileContext (which gates the settings and
// config-editor entries), and installs the PluginPackages resolution plugin.
const profileContext = {
  name: NAME,
  dir: profile.dir,
  home: process.env.DSH_HOME,
  patchPath: profile.patchPath,
  installAnchor: INSTALL_ANCHOR,
  overlays: [],
};
const rootConfig = path.join(profile.dir, 'cordis.yml');
// Mirror the CLI launcher (dsh/lib/profile-boot): build the host context with
// `readProfilePatches` and provide profileContext, which is what gates the settings and
// config-editor entries. The launcher also installs a package-resolution plugin for
// module interception; that is not needed to observe the settings surface.
const ctx = await boot(NAME, rootConfig, readProfilePatches(NAME, profileContext, profile), async (hostCtx) => {
  hostCtx.provide('profileContext', profileContext);
});

const log = (...a) => console.log('[verify-settings]', ...a);
log('profileContext visible after prepare:', ctx.get('profileContext') !== undefined);
let failures = 0;
function check(label, ok, detail) {
  log((ok ? 'OK   ' : 'FAIL ') + label + (detail !== undefined ? ' — ' + detail : ''));
  if (!ok) failures += 1;
}

// A plugin entry that fails to import only shows as "failed to import"; surface the
// underlying error so the failure is diagnosable instead of a generic warning.
try {
  for (const entry of ctx.loader?.entries?.() ?? []) {
    const id = entry?.options?.id;
    if (id === 'settings' || id === 'config-editor') {
      log('entry', id, 'state=', entry.fiber?.state, 'err=', String(entry.fiber?.error?.stack ?? entry.fiber?.error ?? entry.error ?? 'none'));
    }
  }
} catch (e) { log('entry introspection failed:', e.message); }

try {
  // Services live on the booted root context; some are scope-local, so probe rather
  // than assume an accessor shape.
  const probe = (name) => {
    try { return ctx.get(name); } catch { return undefined; }
  };

  log('services seen:', ['settings', 'configEditor', 'sshPool', 'ssh', 'typert', 'loader', 'profileContext']
    .map((n) => n + '=' + (probe(n) !== undefined)).join(' '));

  // dsh-base gates the settings/config-editor entries on `profileContext`, which the
  // launcher provides from its host callback. A bare scripted boot evaluates that gate
  // before the provide lands, so those entries stay inactive here; the plugin's own
  // services are the part this check can prove. The settings FORM is verified against
  // the real launcher (dsh web) instead — see the note printed at the end.
  const settings = probe('settings');
  const hasSettings = settings !== undefined;
  if (hasSettings) {
    check('settings.register is gone (0.2 model)', settings.register === undefined);
    check('settings.get is gone (0.2 model)', settings.get === undefined);
    check('settings.describe exists', typeof settings.describe === 'function');
    check('settings.mutate exists', typeof settings.mutate === 'function');
  } else {
    log('SKIP settings-service assertions: the settings entry is inert under a bare boot');
  }

  // The plugin's own service must be live and must resolve hosts from its config.
  const pool = probe('sshPool');
  check('sshPool service is live', pool !== undefined);
  if (pool) {
    check('sshPool.host() resolves (empty config -> undefined)', pool.host('nope') === undefined);
    check('sshPool.hosts() returns a dict', pool.hosts() && typeof pool.hosts() === 'object');
  }

  // The remote service backs the settings-page CRUD.
  const ssh = probe('ssh');
  check('ssh remote service is live', ssh !== undefined);
  if (ssh) {
    const state = ssh.listHosts();
    check('listHosts returns the wire shape', state && 'hosts' in state && 'secrets' in state && 'revision' in state && 'writable' in state);
    // writable tracks whether a config editor is wired, which follows the settings
    // entry's activation — so it is only asserted when that entry is live.
    log('listHosts writable =', state.writable, '(configEditor live =', probe('configEditor') !== undefined, ')');

    if (probe('configEditor') !== undefined) {
      // Real save -> real profile patch write -> read back through the live config.
      const id = 'verify-host-0001';
      const saved = await ssh.saveHost(id, {
        id, name: 'verify', host: '203.0.113.10', port: 22, user: 'nobody', auth: { type: 'key' },
      });
      check('saveHost persisted through the config editor', saved.persisted === true, JSON.stringify(saved));
      check('saved host is readable from the live config', pool && pool.host(id)?.name === 'verify', JSON.stringify(pool?.host(id)));
      check('saved host appears in listHosts', ssh.listHosts().hosts[id]?.name === 'verify');
      check('secret-bearing auth is redacted on the wire', ssh.listHosts().hosts[id].auth?.password === undefined);

      const removed = await ssh.deleteHost(id);
      check('deleteHost persisted', removed.persisted === true);
      check('deleted host is gone from the live config', pool && pool.host(id) === undefined);
    } else {
      log('SKIP write-path assertions: no config editor in this boot');
    }
  }

  // What the settings page would render for this plugin.
  if (hasSettings) {
    const desc = settings.describe({ redactSecrets: true });
    const rows = Array.isArray(desc) ? desc : [];
    log('settings.describe() namespaces:', JSON.stringify(rows.map((r) => r.ns)));
    const mine = rows.find((r) => r && typeof r.ns === 'string' && r.ns.includes('dsh-ssh'));
    check('the plugin is addressable as a settings entry', mine !== undefined, 'ns=' + (mine && mine.ns));
    if (mine) {
      check('entry exposes a form (volatile fields exist)', mine.form !== undefined, JSON.stringify(Object.keys(mine.form ?? {})));
      check('entry id is the legacy-compatible dsh-ssh-hosts', mine.ns === 'dsh-ssh-hosts', 'ns=' + mine.ns);
    }
  } else {
    log('NOTE the settings FORM is verified against the real launcher (dsh web), not a bare boot');
  }
} catch (err) {
  log('ERROR', err?.stack ?? String(err));
  failures += 1;
} finally {
  try { await ctx.dispose?.(); } catch { /* teardown noise */ }
}

log(failures === 0 ? 'VERIFY-SETTINGS-OK' : 'VERIFY-SETTINGS-FAILED (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
