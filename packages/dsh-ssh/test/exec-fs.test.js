// @dsh-ssh/dsh-ssh — SFTP-disabled fallback (exec-fs) unit tests (node --test, no network).
// ExecFs uses an in-memory fake connection (exec returns preset output, emulating remote shell FS ops for read/stat/find/mv/mkdir/rm)
// covering readBytes/writeBytes (base64 round-trip), stat, exists, readdir, unlink, mkdir, rename.
// Also covers SshConn.fs() capability probing: forceExecFs flag / sftp() throwing → fallback to ExecFs; sftp() success → SftpWrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecFs } from '../src/exec-fs.js';
import { SshError, SshConn, SftpWrapper } from '../src/ssh-core.js';

// Inverse of shellQuoteSingle output: strip outer single quotes, restore embedded '\'' to '.
function unquote(s) {
  if (!s) return s;
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/'\\''/g, "'");
  return s;
}

// In-memory "remote filesystem" fake connection: exec recognizes command shapes emitted by ExecFs and models files/dirs.
function makeFakeConn({ initial = {}, dirs = [] } = {}) {
  const files = new Map(); // path -> Buffer
  const dirSet = new Set(dirs); // explicit directories (including root)
  for (const [p, c] of Object.entries(initial)) files.set(p, Buffer.from(c, 'utf8'));
  const MT = 1700000000;
  const run = (code, stdout = '', stderr = '') => ({ code, signal: null, stdout, stderr });
  const exec = async (cmd) => {
    let m;
    // dd read: dd if='p' iflag=skip_bytes,count_bytes bs=131072 skip=N count=M 2>/dev/null | base64 -w0
    m = /^dd if=('[^']*') iflag=skip_bytes,count_bytes bs=131072 skip=(\d+) count=(\d+) 2>\/dev\/null \| base64 -w0$/.exec(cmd);
    if (m) {
      const p = unquote(m[1]); const skip = +m[2]; const count = +m[3];
      const b = files.get(p);
      if (!b) return run(1, '', 'no such file');
      return run(0, b.subarray(skip, skip + count).toString('base64'));
    }
    // base64 chunked write/append: printf '%s' '<b64>' | base64 -d >|>> 'tmp'
    m = /^printf '%s' ('[^']*') \| base64 -d (>>|>) ('[^']*')$/.exec(cmd);
    if (m) {
      const b64 = m[1].slice(1, -1); const redir = m[2]; const tmp = unquote(m[3]);
      const prev = redir === '>>' ? files.get(tmp) || Buffer.alloc(0) : Buffer.alloc(0);
      files.set(tmp, Buffer.concat([prev, Buffer.from(b64, 'base64')]));
      return run(0);
    }
    // mv -f from to
    m = /^mv -f ('[^']*') ('[^']*')$/.exec(cmd);
    if (m) {
      const f = unquote(m[1]); const t = unquote(m[2]);
      if (files.has(f)) { files.set(t, files.get(f)); files.delete(f); return run(0); }
      if (dirSet.has(f)) { dirSet.add(t); dirSet.delete(f); return run(0); }
      return run(1, '', 'mv: cannot stat');
    }
    // rm -f p
    m = /^rm -f ('[^']*')$/.exec(cmd);
    if (m) { const p = unquote(m[1]); files.delete(p); dirSet.delete(p); return run(0); }
    // mkdir -p p
    m = /^mkdir -p ('[^']*')$/.exec(cmd);
    if (m) { dirSet.add(unquote(m[1])); return run(0); }
    // stat composite: ( test -e 'p' || { printf "MISSING\n"; exit 0; }; ... )
    m = /^\( test -e ('[^']*') /.exec(cmd);
    if (m) {
      const p = unquote(m[1]);
      const isFile = files.has(p);
      if (!isFile && !dirSet.has(p)) return run(0, 'MISSING\n');
      const type = dirSet.has(p) ? 'DIR' : 'FILE';
      const size = isFile ? files.get(p).length : 0;
      return run(0, type + '\n' + size + '\n' + MT + '\n');
    }
    // find -printf readdir
    m = /^find ('[^']*') -mindepth 1 -maxdepth 1 -printf/.exec(cmd);
    if (m) {
      const dir = unquote(m[1]);
      const lines = [];
      for (const p of [...dirSet.keys(), ...files.keys()]) {
        const slash = p.lastIndexOf('/');
        if (p.slice(0, slash) !== dir) continue;
        const name = p.slice(slash + 1);
        const d = dirSet.has(p);
        lines.push((d ? 'd' : 'f') + '\t' + (d ? 0 : files.get(p).length) + '\t' + MT + '\t' + name);
      }
      return run(0, lines.join('\n') + (lines.length ? '\n' : ''));
    }
    return run(0, '', ''); // unrecognized command treated as successful no-op
  };
  return { hostId: 'h1', exec, _files: files, _dirs: dirSet };
}

function makeFs(conn, opts) { return new ExecFs(conn, opts); }

test('execfs.stat: file / directory / missing classification + size/mtime (locale-independent)', async () => {
  const conn = makeFakeConn({ initial: { '/t/a.txt': 'hello' }, dirs: ['/t', '/t/sub'] });
  const fs = makeFs(conn);
  const f = await fs.stat('/t/a.txt');
  assert.equal(f.type, 'file');
  assert.equal(f.size, 5);
  assert.ok(Number.isFinite(f.mtime));
  const d = await fs.stat('/t/sub');
  assert.equal(d.type, 'directory');
  const miss = await fs.stat('/t/nope');
  assert.equal(miss, undefined);
  assert.equal(await fs.exists('/t/a.txt'), true);
  assert.equal(await fs.exists('/t/nope'), false);
});

test('execfs.readBytes: text + binary (NUL) base64 round-trip', async () => {
  const bin = Buffer.from([0, 1, 2, 3, 255, 254, 65, 0, 66]);
  const conn = makeFakeConn({});
  conn._files.set('/t/bin.dat', bin);
  const fs = makeFs(conn);
  const got = await fs.readBytes('/t/bin.dat');
  assert.deepEqual(got, bin);
  conn._files.set('/t/a.txt', Buffer.from('hi\nworld\n'));
  assert.equal(await fs.readText('/t/a.txt'), 'hi\nworld\n');
});

test('execfs.readBytes: missing → throws SshError(stage execfs-read)', async () => {
  const fs = makeFs(makeFakeConn({}));
  await assert.rejects(() => fs.readBytes('/t/none'), (e) => e instanceof SshError && e.stage === 'execfs-read');
});

test('execfs.readBytes: large file reassembly across chunks (>chunkBytes)', async () => {
  const data = Buffer.alloc(600 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
  const conn = makeFakeConn({});
  conn._files.set('/t/big.bin', data);
  const fs = makeFs(conn, { chunkBytes: 256 * 1024 }); // 3 chunks
  const got = await fs.readBytes('/t/big.bin');
  assert.equal(got.length, data.length);
  assert.deepEqual(got, data);
});

test('execfs.writeFileAtomic: base64 write + mv publish, atomic replacement of existing file, no temp residue', async () => {
  const conn = makeFakeConn({ initial: { '/t/f.txt': 'old content' } });
  const fs = makeFs(conn);
  const payload = Buffer.from([0, 1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255, 10]);
  await fs.writeFileAtomic('/t/f.txt', payload);
  assert.deepEqual(conn._files.get('/t/f.txt'), payload);
  // No .dsh-tmp residue
  for (const p of conn._files.keys()) assert.ok(!p.includes('.dsh-tmp-'), 'tmp residue: ' + p);
});

test('execfs.writeFileAtomic: large binary spanning multiple chunks (base64 chunk multiple of 4) stays intact', async () => {
  const data = Buffer.alloc(300 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const conn = makeFakeConn({});
  const fs = makeFs(conn, { chunkBytes: 128 * 1024 });
  await fs.writeFileAtomic('/t/big.txt', data);
  assert.deepEqual(conn._files.get('/t/big.txt'), data);
});

test('execfs.unlink/mkdir/rename', async () => {
  const conn = makeFakeConn({ initial: { '/t/x.txt': 'a' }, dirs: ['/t'] });
  const fs = makeFs(conn);
  await fs.mkdir('/t/newdir');
  assert.ok(conn._dirs.has('/t/newdir'));
  await fs.rename('/t/x.txt', '/t/y.txt');
  assert.equal(conn._files.has('/t/x.txt'), false);
  assert.equal(conn._files.get('/t/y.txt').toString('utf8'), 'a');
  await fs.unlink('/t/y.txt');
  assert.equal(conn._files.has('/t/y.txt'), false);
});

test('execfs.listDir: type/size/mtime parsed via machine-readable output', async () => {
  const conn = makeFakeConn({ initial: { '/t/beta.txt': 'hello world' }, dirs: ['/t', '/t/alpha'] });
  const fs = makeFs(conn);
  const entries = await fs.listDir('/t');
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName['alpha'].type, 'dir');
  assert.equal(byName['beta.txt'].type, 'file');
  assert.equal(byName['beta.txt'].size, 11);
  assert.ok(Number.isFinite(byName['beta.txt'].mtime));
});

// ---- SshConn.fs() capability probing ----
test("fs(): cfg.forceExecFs=true returns ExecFs directly (does not touch sftp)", async () => {
  const conn = new SshConn({ hostId: 'h1', forceExecFs: true });
  conn.connect = async () => conn;
  conn._ensureOpen = () => {};
  let sftpCalled = false;
  conn.sftp = async () => { sftpCalled = true; throw new Error('should not'); };
  const f = await conn.fs();
  assert.equal(f.kind, 'exec');
  assert.equal(sftpCalled, false);
});

test('fs(): sftp() throwing (SFTP disabled) → fallback to ExecFs and set _sftpUnavailable', async () => {
  const conn = new SshConn({ hostId: 'h1' });
  conn.connect = async () => conn;
  conn._ensureOpen = () => {};
  conn.sftp = async () => { throw new SshError({ hostId: 'h1', stage: 'sftp-open', message: 'SFTP subsystem request failed' }); };
  const f = await conn.fs();
  assert.equal(f.kind, 'exec');
  assert.equal(conn._sftpUnavailable, true);
});

test('fs(): sftp() succeeds → returns SftpWrapper (SFTP path unchanged)', async () => {
  const conn = new SshConn({ hostId: 'h1' });
  conn.connect = async () => conn;
  conn._ensureOpen = () => {};
  const fakeSftp = { readBytes: async () => Buffer.alloc(0) };
  conn.sftp = async () => new SftpWrapper(conn, fakeSftp);
  const f = await conn.fs();
  assert.ok(f instanceof SftpWrapper);
});

test('fs(): first sftp() throws a different error → still falls back (promise not cached)', async () => {
  const conn = new SshConn({ hostId: 'h1' });
  conn.connect = async () => conn;
  conn._ensureOpen = () => {};
  conn.sftp = async () => { throw new Error('boom'); };
  const f = await conn.fs();
  assert.equal(f.kind, 'exec');
  assert.equal(conn._sftpPromise, null);
});
