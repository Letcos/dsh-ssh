// @dsh-ssh/dsh-ssh — glob/grep tests (node --test, no network).
// Covers: rg semantic translation pure functions (verified against official rg, 2025-08-16), remote command building, output parsing,
//       retained/render/present projections, mock pool remote branches (with error codes), and local delegation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../tools.js';
import { mapRemoteToLocal } from '../src/router.js';
import { SshError } from '../src/ssh-core.js';
import {
  SearchError, GLOB_VCS_EXCLUDES,
  buildRemoteGlobCommand, buildRemoteGrepCommand, translateIncludeForGrep, translateRustRegexToEre,
  globBasenameForFind, expandBraceGlobs, parseGlobOutput, parseGrepOutput,
  rgGlobToRegExp, rgGlobToRegExpSource, toWorkdirRelative,
  retainGrepMatches, previewLine, formatRetainedGrep, renderGlobPaths, globCardPage,
  grepSearchMeta, globSearchMeta, capMetaBytes, searchViewFromMeta,
  presentGlobCall, presentGlobResult, presentGrepCall, presentGrepResult, parseGlobArgs, parseGrepArgs,
} from '../src/search.js';

process.env.DSH_SSH_REMOTE_ROOT = '/tmp/dsh-ssh-test-remote-root';

// ═══════════════════════════════════════════════════════════════════════════
// rg glob -> RegExp semantics (verified against official rg --files, 2025-08-16)
// ═══════════════════════════════════════════════════════════════════════════
const re = (p) => rgGlobToRegExp(p);

test('glob: no-slash pattern matches basename at any depth', () => {
  assert.equal(re('*.ts').test('a.ts'), true);
  assert.equal(re('*.ts').test('src/deep/nested.test.ts'), true);
  assert.equal(re('*.ts').test('.hidden/h.ts'), true, 'hidden files included (rg --hidden)');
  assert.equal(re('*.ts').test('a.txt'), false);
  assert.equal(re('*.TS').test('a.ts'), false, 'globs are case-sensitive');
});

test('glob: **/*.ts matches root-level and deep files', () => {
  assert.equal(re('**/*.ts').test('b.ts'), true);
  assert.equal(re('**/*.ts').test('src/main.ts'), true);
});

test('glob: ** matches zero path segments', () => {
  assert.equal(re('src/**/*.test.ts').test('src/x.test.ts'), true, 'zero dirs');
  assert.equal(re('src/**/*.test.ts').test('src/deep/y.test.ts'), true);
  assert.equal(re('**/e.ts').test('e.ts'), true, 'zero leading dirs at root');
  assert.equal(re('**/e.ts').test('sub/e.ts'), true);
  assert.equal(re('src/**/main.ts').test('src/main.ts'), true, 'zero middle dirs');
});

test('glob: single-segment * does not cross slash', () => {
  assert.equal(re('src/*.ts').test('src/main.ts'), true);
  assert.equal(re('src/*.ts').test('src/deep/nested.ts'), false);
});

test('glob: braces alternation', () => {
  assert.equal(re('*.{ts,js}').test('a.ts'), true);
  assert.equal(re('*.{ts,js}').test('src/deep/x.js'), true);
  assert.equal(re('*.{ts,js}').test('a.md'), false);
  assert.equal(re('src/*.{ts,tsx}').test('src/main.tsx'), true);
});

test('glob: character classes', () => {
  assert.equal(re('*.t[cs]').test('x.ts'), true);
  assert.equal(re('*.t[cs]').test('x.td'), false);
});

test('glob: trailing /** matches contents, not the dir itself', () => {
  assert.equal(re('src/**').test('src/main.ts'), true);
  assert.equal(re('src/**').test('src'), false);
});

test('glob: trailing-slash dir glob matches no files', () => {
  assert.equal(re('sub/').test('sub/d.ts'), false);
  assert.equal(re('sub/').test('sub'), false);
});

test('glob: matches paths relative to session cwd (rg semantics)', () => {
  assert.equal(re('src/sub/*.ts').test('src/sub/leaf.ts'), true);
  assert.equal(re('sub/*.ts').test('src/sub/leaf.ts'), false, 'rg glob is workdir-relative, not root-relative');
});

test('glob: ** inside a segment behaves like *', () => {
  assert.equal(re('a**b.ts').test('aXb.ts'), re('a*b.ts').test('aXb.ts'));
});

test('glob: * and ** match every file', () => {
  assert.equal(re('*').test('x/y/z.ts'), true);
  assert.equal(re('**').test('anything/at/all.ts'), true);
});

test('glob: regex source is anchored', () => {
  const src = rgGlobToRegExpSource('*.ts');
  assert.ok(src.startsWith('^') && src.endsWith('$'));
});

// ═══════════════════════════════════════════════════════════════════════════
// Remote command construction
// ═══════════════════════════════════════════════════════════════════════════
test('globBasenameForFind: basename filter is a conservative superset', () => {
  assert.deepEqual(globBasenameForFind('*.ts'), ['*.ts']);
  assert.deepEqual(globBasenameForFind('src/**/*.test.js'), ['*.test.js']);
  assert.deepEqual(globBasenameForFind('*.{ts,tsx}'), ['*.ts', '*.tsx']);
  assert.deepEqual(globBasenameForFind('sub/'), ['*']);
  assert.deepEqual(globBasenameForFind('src/**'), ['*']);
  assert.equal(expandBraceGlobs('a{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20}b'), null, 'too many alternates → no remote filter (enumerate all)');
});

test('buildRemoteGlobCommand: prune VCS, files only, mtime sort, BSD fallback', () => {
  const cmd = buildRemoteGlobCommand('/data/w', '*.ts');
  for (const vcs of GLOB_VCS_EXCLUDES) assert.ok(cmd.includes('-name ' + vcs), 'prunes ' + vcs);
  assert.ok(cmd.includes("-type f -name '*.ts'"));
  assert.ok(cmd.includes('-printf '), 'GNU -printf branch present');
  assert.ok(cmd.includes('LC_ALL=C sort -n'));
  assert.ok(cmd.includes("find '/data/w' -prune -printf ''"), 'GNU probe');
  assert.ok(cmd.includes('else find '), 'BSD fallback branch');
  assert.ok(cmd.includes("cd ") === false, 'buildRemoteCommand adds the cd prefix later');
});

test('buildRemoteGlobCommand: brace filter becomes -o name expr; root quoted', () => {
  const cmd = buildRemoteGlobCommand('/data/my dir', '*.{ts,tsx}');
  assert.ok(cmd.includes("-name '*.ts' -o -name '*.tsx'"));
  assert.ok(cmd.includes("'/data/my dir'"));
});

test('buildRemoteGrepCommand: portable flags, hidden/binary excludes, quoting', () => {
  const cmd = buildRemoteGrepCommand('/data/w', 'foo', undefined);
  assert.ok(cmd.startsWith('grep -rInHE'));
  assert.ok(cmd.includes("--exclude-dir='.*'"), 'hidden dirs excluded');
  assert.ok(!cmd.includes("--exclude='.*'"), 'no file-level exclude (GNU/BSD quirk)');
  assert.ok(cmd.includes("--exclude-dir='.*'"));
  assert.ok(cmd.includes("-e 'foo'"));
  assert.ok(cmd.includes("'/data/w'"));
  assert.ok(!cmd.includes("'cd "), 'cd prefix comes from buildRemoteCommand');
});

test('buildRemoteGrepCommand: include braces expand to multiple --include; ** → *', () => {
  const cmd = buildRemoteGrepCommand('/data/w', 'x', '*.{ts,tsx}');
  assert.ok(cmd.includes("--include='*.ts'"));
  assert.ok(cmd.includes("--include='*.tsx'"));
  const cmd2 = buildRemoteGrepCommand('/data/w', 'x', '**.ts');
  assert.ok(cmd2.includes("--include='*.ts'"), '** collapses to * for basename --include');
});

test('translateIncludeForGrep: slash include rejected; validation preserved', () => {
  assert.throws(() => translateIncludeForGrep('src/*.ts'), (e) => e instanceof SearchError && e.code === 'SEARCH_FAILED' && /\//.test(e.message));
  assert.throws(() => parseGrepArgs({ pattern: 'x', include: 'a,b' }), /not a comma-separated list/);
  assert.throws(() => parseGrepArgs({ pattern: 'x', include: '!neg' }), /negated/);
  assert.throws(() => parseGrepArgs({ pattern: '', }), /non-empty/);
  assert.throws(() => parseGrepArgs({ pattern: 'x', path: '  ' }), /non-empty string when given/);
  assert.throws(() => parseGlobArgs({ pattern: '   ' }), /non-empty/);
});

test('translateRustRegexToEre bridges common shorthand classes', () => {
  assert.equal(translateRustRegexToEre('\\d+\\w*\\s'), '[0-9]+[A-Za-z0-9_]*[[:space:]]');
});

test('buildRemoteGrepCommand rejects newline/NUL patterns', () => {
  assert.throws(() => buildRemoteGrepCommand('/data/w', 'a\nb'), (e) => e instanceof SearchError && e.code === 'SEARCH_INVALID_PATTERN');
});

// ═══════════════════════════════════════════════════════════════════════════
// Output parsing
// ═══════════════════════════════════════════════════════════════════════════
test('parseGrepOutput: path:line:content with best-effort colon handling', () => {
  const out = parseGrepOutput('/data/w/a.ts:3:hello world\n/data/w/b:4:x:y\nnot-a-match\n');
  assert.deepEqual(out, [
    { path: '/data/w/a.ts', lineNumber: 3, line: 'hello world' },
    { path: '/data/w/b', lineNumber: 4, line: 'x:y' },
  ]);
  // Path containing ':' split at first ':<digits>:'
  const colonPath = parseGrepOutput('a:b.txt:3:hello');
  assert.deepEqual(colonPath, [{ path: 'a:b.txt', lineNumber: 3, line: 'hello' }]);
});

test('parseGlobOutput: mtime+path and plain fallback lines', () => {
  const out = parseGlobOutput('123.5\t/data/w/a.ts\nplain/path\n');
  assert.equal(out[0].mtime, 123.5);
  assert.equal(out[0].path, '/data/w/a.ts');
  assert.equal(out[1].mtime, null);
  assert.equal(out[1].path, 'plain/path');
});

// ═══════════════════════════════════════════════════════════════════════════
// Retention/render/present (official shape)
// ═══════════════════════════════════════════════════════════════════════════
test('retainGrepMatches caps head and previews long lines', () => {
  const matches = [1, 2, 3].map((n) => ({ path: 'a.ts', lineNumber: n, line: 'x'.repeat(100) }));
  const retained = retainGrepMatches(matches, 2, 10);
  assert.equal(retained.kept, 2);
  assert.equal(retained.seen, 3);
  assert.equal(retained.truncated, true);
  assert.ok(retained.items[0].line.endsWith(' (line truncated)'));
  assert.equal(retainGrepMatches(matches, 10, 2000).truncated, false);
});

test('previewLine keeps UTF-8 boundaries', () => {
  const line = '你'.repeat(10); // 3 bytes per char (kept as data to test UTF-8 boundaries)
  const out = previewLine(line, 9);
  assert.equal(Buffer.byteLength(out.split(' (line truncated)')[0], 'utf8'), 9);
});

test('formatRetainedGrep: no matches / count header / capped footer', () => {
  assert.equal(formatRetainedGrep({ items: [], kept: 0, seen: 0, truncated: false }), 'No matches found');
  const one = formatRetainedGrep({ items: [{ path: 'a.ts', lineNumber: 3, line: 'x' }], kept: 1, seen: 1, truncated: false });
  assert.ok(one.startsWith('Found 1 match'));
  assert.ok(one.includes('a.ts'));
  assert.ok(one.includes('Line 3: x'));
  const capped = formatRetainedGrep({ items: [{ path: 'a', lineNumber: 1, line: 'l' }], kept: 1, seen: 9, truncated: true });
  assert.ok(capped.startsWith('Found 1 of 9 matches'));
  assert.ok(capped.includes('could not be saved'));
});

test('renderGlobPaths: flat list, empty, and over-cap head page', () => {
  assert.equal(renderGlobPaths([], 100), 'No files found');
  assert.equal(renderGlobPaths(['a.ts', 'b.ts'], 100), 'a.ts\nb.ts');
  const capped = renderGlobPaths(['a.ts', 'b.ts', 'c.ts'], 2);
  assert.ok(capped.startsWith('a.ts\nb.ts'));
  assert.ok(capped.includes('Showing 2 of 3 paths'));
  assert.ok(capped.includes('could not be saved'));
});

test('globCardPage: head page with truncation signal', () => {
  assert.deepEqual(globCardPage(['a', 'b'], 100), { items: ['a', 'b'], truncated: false });
  assert.deepEqual(globCardPage(['a', 'b'], 1), { items: ['a'], truncated: true });
});

test('grepSearchMeta / globSearchMeta: official shapes + capMetaBytes trimming', () => {
  const retained = { items: [{ path: 'a.ts', lineNumber: 3, line: 'x' }], kept: 1, seen: 2, truncated: true };
  const grepMeta = grepSearchMeta(retained, 65536);
  assert.equal(grepMeta.shape, 'matches');
  assert.equal(grepMeta.total, 2);
  assert.equal(grepMeta.truncated, true);
  assert.deepEqual(grepMeta.files, [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'x' }] }]);

  const globMeta = globSearchMeta({ items: ['a.ts', 'b.ts'], truncated: false }, 2, 65536);
  assert.equal(globMeta.shape, 'paths');
  assert.deepEqual(globMeta.paths, ['a.ts', 'b.ts']);

  const tiny = globSearchMeta({ items: ['a'.repeat(100), 'b'.repeat(100)], truncated: false }, 2, 50);
  assert.equal(tiny.truncated, true, 'meta byte cap marks truncated and drops trailing paths');
});

test('searchViewFromMeta narrows to search card; presentResult falls back on garbage', () => {
  const view = searchViewFromMeta({ shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 });
  assert.deepEqual(view, { card: 'search', shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 });
  assert.equal(searchViewFromMeta({ shape: 'paths', paths: 'x', truncated: false, total: 1 }), undefined);
  assert.equal(searchViewFromMeta(null), undefined);
  assert.equal(presentGlobResult({}, { isError: true, meta: {} }), undefined);
  assert.equal(presentGrepResult({}, { isError: false, meta: { shape: 'paths', paths: [], truncated: false, total: 0 } }), undefined, 'grep rejects paths shape');
  assert.deepEqual(presentGlobCall({ pattern: '*.ts', path: 'src' }), { card: 'generic', title: 'Glob *.ts in src', kind: 'search', rawInput: '*.ts' });
  assert.deepEqual(presentGrepCall({ pattern: 'x', include: '*.ts' }), { card: 'generic', title: 'Grep x (*.ts)', kind: 'search', rawInput: 'x' });
});

test('toWorkdirRelative: workdir-relative display, outside paths pass through', () => {
  assert.equal(toWorkdirRelative('/data/w/sub/a.ts', '/data/w'), 'sub/a.ts');
  assert.equal(toWorkdirRelative('/data/w', '/data/w'), '.');
  assert.equal(toWorkdirRelative('/tmp/x', '/data/w'), '/tmp/x');
  assert.equal(toWorkdirRelative('rel.ts', '/data/w'), 'rel.ts');
});

// ═══════════════════════════════════════════════════════════════════════════
// Remote branches (mock pool; same in-memory pool as tools-remote.test.js)
// ═══════════════════════════════════════════════════════════════════════════
function makeCtx({ hosts = {}, sshPool, officialTools = {} } = {}) {
  const registered = new Map();
  const calls = [];
  return {
    tools: {
      register(def) { registered.set(def.name, def); return () => registered.delete(def.name); },
      get(name) {
        const official = officialTools[name];
        if (!official) return undefined;
        return { name, execute: async (args, exec) => { calls.push({ name, args, exec }); return official.result; } };
      },
    },
    shell: { sandboxMode: undefined },
    fs: { sandboxMode: undefined },
    get(key) {
      if (key === 'sshPool') return sshPool;
      if (key === 'settings') return { get: () => ({ hosts }) };
      return undefined;
    },
    logger: { info: () => {} },
    _registered: registered,
    _calls: calls,
  };
}

function makeExec(hostId, remotePath) {
  return { agent: { session: { header: { cwd: mapRemoteToLocal(hostId, remotePath) } } }, signal: undefined };
}

function makePool(execImpl) {
  const conn = { hostId: 'h1', exec: execImpl };
  return { pool: { acquire: async () => conn, release: () => {} }, conn };
}

const HOSTS = { h1: { id: 'h1', host: '203.0.113.10', port: 22, user: 'u', auth: { type: 'key' } } };

test('remote glob: find output → filtered workdir-relative paths + root', async () => {
  const { pool } = makePool(async () => ({ code: 0, signal: null, stdout: '1000.5\t/data/work/a.ts\n2000.5\t/data/work/sub/b.ts\n3000.5\t/data/work/c.txt\n', stderr: '' }));
  const ctx = makeCtx({ hosts: HOSTS, sshPool: pool });
  apply(ctx);
  const out = await ctx._registered.get('glob').execute({ pattern: '*.ts' }, makeExec('h1', '/data/work'));
  assert.deepEqual(out, { root: '.', paths: ['a.ts', 'sub/b.ts'] });
});

test('remote glob: local matcher drops find-superset extras (path scoping)', async () => {
  // find -name *.test.js is a superset; local must discard hits outside src
  const { pool } = makePool(async () => ({ code: 0, signal: null, stdout: '1000\t/data/work/src/x.test.ts\n2000\t/data/work/other/y.test.ts\n', stderr: '' }));
  const ctx = makeCtx({ hosts: HOSTS, sshPool: pool });
  apply(ctx);
  const out = await ctx._registered.get('glob').execute({ pattern: 'src/**/*.test.ts' }, makeExec('h1', '/data/work'));
  assert.deepEqual(out.paths, ['src/x.test.ts']);
});

test('remote glob: path arg → root display relative to workdir', async () => {
  const { pool } = makePool(async () => ({ code: 0, signal: null, stdout: '1000\t/data/work/sub/a.ts\n', stderr: '' }));
  const ctx = makeCtx({ hosts: HOSTS, sshPool: pool });
  apply(ctx);
  const out = await ctx._registered.get('glob').execute({ pattern: '*.ts', path: 'sub' }, makeExec('h1', '/data/work'));
  assert.equal(out.root, 'sub');
  assert.deepEqual(out.paths, ['sub/a.ts']);
});

test('remote glob: nonzero find exit → SEARCH_FAILED with host + stderr tail', async () => {
  const { pool } = makePool(async () => ({ code: 2, signal: null, stdout: '', stderr: 'find: bad option' }));
  const ctx = makeCtx({ hosts: HOSTS, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    ctx._registered.get('glob').execute({ pattern: '*.ts' }, makeExec('h1', '/data/work')),
    (e) => e instanceof SearchError && e.code === 'SEARCH_FAILED' && /host h1/.test(e.message) && /find: bad option/.test(e.message),
  );
});

test('remote glob: exec timeout → SEARCH_ABORTED; output overflow → SEARCH_RAW_OUTPUT_OVERFLOW', async () => {
  const { pool } = makePool(async () => { throw new SshError({ hostId: 'h1', stage: 'exec-timeout', message: 'exec timed out after 30000ms: find ...' }); });
  const ctx = makeCtx({ hosts: HOSTS, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    ctx._registered.get('glob').execute({ pattern: '*.ts' }, makeExec('h1', '/data/work')),
    (e) => e instanceof SearchError && e.code === 'SEARCH_ABORTED' && /timed out/.test(e.message),
  );

  const { pool: pool2 } = makePool(async () => { throw new SshError({ hostId: 'h1', stage: 'exec-output-overflow', message: 'exec output exceeded 20000000 bytes: find ...' }); });
  const ctx2 = makeCtx({ hosts: HOSTS, sshPool: pool2 });
  apply(ctx2);
  await assert.rejects(
    ctx2._registered.get('glob').execute({ pattern: '*' }, makeExec('h1', '/data/work')),
    (e) => e instanceof SearchError && e.code === 'SEARCH_RAW_OUTPUT_OVERFLOW',
  );
});

test('remote grep: output → matches with display-relative paths', async () => {
  const { pool } = makePool(async () => ({ code: 0, signal: null, stdout: '/data/work/a.ts:3:hello world\n/data/work/sub/b.ts:7:hello again\n', stderr: '' }));
  const ctx = makeCtx({ hosts: HOSTS, sshPool: pool });
  apply(ctx);
  const out = await ctx._registered.get('grep').execute({ pattern: 'hello' }, makeExec('h1', '/data/work'));
  assert.deepEqual(out.matches, [
    { path: 'a.ts', lineNumber: 3, line: 'hello world' },
    { path: 'sub/b.ts', lineNumber: 7, line: 'hello again' },
  ]);
});

test('remote grep: exit 1 → empty matches; exit 2 regex error → SEARCH_INVALID_PATTERN', async () => {
  const { pool } = makePool(async () => ({ code: 1, signal: null, stdout: '', stderr: '' }));
  const ctx = makeCtx({ hosts: HOSTS, sshPool: pool });
  apply(ctx);
  assert.deepEqual(await ctx._registered.get('grep').execute({ pattern: 'zzz' }, makeExec('h1', '/data/work')), { matches: [] });

  const { pool: pool2 } = makePool(async () => ({ code: 2, signal: null, stdout: '', stderr: 'grep: invalid regular expression' }));
  const ctx2 = makeCtx({ hosts: HOSTS, sshPool: pool2 });
  apply(ctx2);
  await assert.rejects(
    ctx2._registered.get('grep').execute({ pattern: '(' }, makeExec('h1', '/data/work')),
    (e) => e instanceof SearchError && e.code === 'SEARCH_INVALID_PATTERN' && /rejected by remote grep/.test(e.message),
  );
});

test('remote grep: exit 2 non-regex error → SEARCH_FAILED; timeout → SEARCH_ABORTED', async () => {
  const { pool } = makePool(async () => ({ code: 2, signal: null, stdout: '', stderr: 'grep: /nope: No such file or directory' }));
  const ctx = makeCtx({ hosts: HOSTS, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    ctx._registered.get('grep').execute({ pattern: 'x' }, makeExec('h1', '/data/work')),
    (e) => e instanceof SearchError && e.code === 'SEARCH_FAILED',
  );

  const { pool: pool2 } = makePool(async () => { throw new SshError({ hostId: 'h1', stage: 'exec-timeout', message: 'exec timed out after 30000ms: grep -rInHE' }); });
  const ctx2 = makeCtx({ hosts: HOSTS, sshPool: pool2 });
  apply(ctx2);
  await assert.rejects(
    ctx2._registered.get('grep').execute({ pattern: 'x' }, makeExec('h1', '/data/work')),
    (e) => e instanceof SearchError && e.code === 'SEARCH_ABORTED',
  );
});

test('remote grep: include with slash → clear SEARCH_FAILED (not silent)', async () => {
  const { pool } = makePool(async () => ({ code: 0, signal: null, stdout: '', stderr: '' }));
  const ctx = makeCtx({ hosts: HOSTS, sshPool: pool });
  apply(ctx);
  await assert.rejects(
    ctx._registered.get('grep').execute({ pattern: 'x', include: 'src/*.ts' }, makeExec('h1', '/data/work')),
    (e) => e instanceof SearchError && e.code === 'SEARCH_FAILED' && /basename/.test(e.message),
  );
});

test('remote glob/grep: unknown hostId → clear config error', async () => {
  const { pool } = makePool(async () => ({ code: 0, signal: null, stdout: '', stderr: '' }));
  const ctx = makeCtx({ hosts: {}, sshPool: pool });
  apply(ctx);
  await assert.rejects(ctx._registered.get('glob').execute({ pattern: '*' }, makeExec('ghost', '/data/work')), /not configured/);
  await assert.rejects(ctx._registered.get('grep').execute({ pattern: 'x' }, makeExec('ghost', '/data/work')), /not configured/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Local delegation (byte-identical)
// ═══════════════════════════════════════════════════════════════════════════
test('local glob/grep delegate to official implementations with same args+exec', async () => {
  const ctx = makeCtx({
    officialTools: {
      glob: { result: { root: '.', paths: ['a.ts'] } },
      grep: { result: { matches: [{ path: 'a.ts', lineNumber: 1, line: 'x' }] } },
    },
  });
  apply(ctx);
  const args = { pattern: '*.ts' };
  const exec = { agent: { session: { header: { cwd: '/home/devuser/project' } } }, signal: undefined };
  const out = await ctx._registered.get('glob').execute(args, exec);
  assert.deepEqual(out, { root: '.', paths: ['a.ts'] });
  assert.equal(ctx._calls[0].name, 'glob');
  assert.equal(ctx._calls[0].args, args);
  assert.equal(ctx._calls[0].exec, exec);
  const grepOut = await ctx._registered.get('grep').execute({ pattern: 'x', include: '*.ts' }, exec);
  assert.equal(grepOut.matches[0].path, 'a.ts');
  assert.equal(ctx._calls[1].name, 'grep');
});

test('local glob/grep missing official tool → clear error', async () => {
  const ctx = makeCtx({});
  apply(ctx);
  const exec = { agent: { session: { header: { cwd: '/home/devuser/project' } } }, signal: undefined };
  await assert.rejects(ctx._registered.get('glob').execute({ pattern: '*' }, exec), /unavailable locally/);
  await assert.rejects(ctx._registered.get('grep').execute({ pattern: 'x' }, exec), /unavailable locally/);
});
