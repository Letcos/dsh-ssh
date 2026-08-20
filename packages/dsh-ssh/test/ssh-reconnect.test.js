// @dsh-ssh/dsh-ssh — auto-reconnect tests (node --test, no network).
// Covers: dead detection via close event, lazy reconnect, single retry on Not connected,
// reconnect failure surfaces SshError with hostId, dispose does not trigger reconnect.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SshError, SshConn, SshPool } from '../src/ssh-core.js';

// Helper: make a fake ssh2 client that is an EventEmitter-like object
function makeFakeClient() {
  const handlers = new Map();
  return {
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
      return this;
    },
    removeListener(ev, fn) {
      const arr = handlers.get(ev) || [];
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
      return this;
    },
    emit(ev, ...args) {
      for (const fn of [...(handlers.get(ev) || [])]) fn(...args);
    },
    end() {},
    exec(cmd, cb) { cb(null, fakeStream()); },
    sftp(cb) { cb(null, {}); },
    _handlers: handlers,
  };
}

function fakeStream() {
  return {
    on() { return this; },
    stderr: { on() { return this; } },
    close() {},
  };
}

// Stub connect to avoid real network: resolves immediately with current client
function stubConnectSuccess(conn, client) {
  conn._connectInner = async () => {
    conn.client = client;
    client.on('close', conn._onClose);
    client.on('end', conn._onClose);
    client.on('error', conn._onClose);
    return conn;
  };
}

function stubConnectFail(conn, err) {
  conn._connectInner = async () => { throw err; };
}

test('close event marks connection dead and clears cached state', async () => {
  const conn = new SshConn({ id: 'h-close', host: '203.0.113.10', port: 22, user: 'u', acceptNew: true });
  const client = makeFakeClient();
  stubConnectSuccess(conn, client);
  await conn.connect();
  assert.equal(conn._dead, false);
  assert.equal(conn.client, client);
  // Simulate remote close (keepalive failure / network drop)
  client.emit('close');
  assert.equal(conn._dead, true);
  assert.equal(conn.client, null);
  assert.equal(conn._ready, null);
  assert.equal(conn._sftpPromise, null);
});

test('next connect after close rebuilds connection', async () => {
  const conn = new SshConn({ id: 'h-rebuild', host: '203.0.113.10', port: 22, user: 'u', acceptNew: true });
  const client1 = makeFakeClient();
  stubConnectSuccess(conn, client1);
  await conn.connect();
  client1.emit('close');
  assert.equal(conn._dead, true);
  // Next connect should reset dead and rebuild
  const client2 = makeFakeClient();
  let rebuildCount = 0;
  conn._connectInner = async () => {
    rebuildCount++;
    conn.client = client2;
    client2.on('close', conn._onClose);
    return conn;
  };
  await conn.connect();
  assert.equal(rebuildCount, 1);
  assert.equal(conn._dead, false);
  assert.equal(conn.client, client2);
});

test('pool acquire after close invalidates and creates fresh SshConn', async () => {
  const pool = new SshPool({ maxConnections: 4 });
  const client1 = makeFakeClient();
  const cfg = { id: 'h-pool', host: '203.0.113.10', port: 22, user: 'u', acceptNew: true };
  // First acquire: inject fake conn directly
  const conn1 = new SshConn(cfg);
  stubConnectSuccess(conn1, client1);
  await conn1.connect();
  pool.conns.set(cfg.id, conn1);
  assert.equal(pool.conns.get(cfg.id), conn1);
  // Simulate close
  client1.emit('close');
  assert.equal(conn1._dead, true);
  // Next acquire should invalidate old and create new conn
  // Stub SshConn creation by mocking pool's internal new SshConn via overriding connect plumbing:
  // We let pool create a new SshConn; stub its _connectInner to succeed
  const originalSshConn = SshConn;
  // Instead, we test the pool logic: acquire should detect _dead and call invalidate
  // To avoid real network, we temporarily replace SshConn.prototype._connectInner for the new instance
  const newClient = makeFakeClient();
  let newConnectCalled = false;
  // Monkey patch SshConn _connectInner for any new instance created inside acquire
  const origConnectInner = SshConn.prototype._connectInner;
  SshConn.prototype._connectInner = async function () {
    newConnectCalled = true;
    this.client = newClient;
    newClient.on('close', this._onClose);
    return this;
  };
  try {
    const conn2 = await pool.acquire(cfg);
    assert.ok(newConnectCalled, 'new connection should be built');
    assert.notEqual(conn2, conn1, 'pool should return a fresh SshConn object');
    assert.equal(conn2._dead, false);
    assert.equal(pool.conns.get(cfg.id), conn2);
  } finally {
    SshConn.prototype._connectInner = origConnectInner;
  }
  await pool.dispose();
});

test('"Not connected" exec failure triggers single transparent retry and succeeds', async () => {
  const conn = new SshConn({ id: 'h-exec-retry', host: '203.0.113.10', port: 22, user: 'u', acceptNew: true });
  // Pretend connected
  conn.client = makeFakeClient();
  conn._ready = Promise.resolve(conn);
  let connectCalls = 0;
  conn._connectInner = async () => {
    connectCalls++;
    conn.client = makeFakeClient();
    conn.client.on('close', conn._onClose);
    return conn;
  };
  let doCalls = 0;
  conn._doExecChannel = async () => {
    doCalls++;
    if (doCalls === 1) throw new SshError({ hostId: 'h-exec-retry', stage: 'exec-open', message: 'Not connected' });
    return fakeStream();
  };
  const stream = await conn._execChannel('echo hi', {});
  assert.ok(stream, 'retry should return stream');
  assert.equal(doCalls, 2, 'should retry once');
  assert.equal(connectCalls, 1, 'should reconnect once');
});

test('"Not connected" sftp failure triggers single retry and succeeds', async () => {
  const conn = new SshConn({ id: 'h-sftp-retry', host: '203.0.113.10', port: 22, user: 'u', acceptNew: true });
  conn.client = makeFakeClient();
  conn._ready = Promise.resolve(conn);
  let connectCalls = 0;
  conn._connectInner = async () => {
    connectCalls++;
    conn.client = makeFakeClient();
    conn.client.on('close', conn._onClose);
    return conn;
  };
  let doCalls = 0;
  conn._doSftpOpen = async () => {
    doCalls++;
    if (doCalls === 1) throw new SshError({ hostId: 'h-sftp-retry', stage: 'sftp-open', message: 'Not connected' });
    return { dummy: true };
  };
  const sftp = await conn.sftp();
  assert.ok(sftp, 'retry should return wrapper');
  assert.equal(doCalls, 2);
  assert.equal(connectCalls, 1);
});

test('reconnect failure after Not connected throws SshError with hostId', async () => {
  const conn = new SshConn({ id: 'h-fail', host: '203.0.113.10', port: 22, user: 'u', acceptNew: true });
  conn.client = makeFakeClient();
  conn._ready = Promise.resolve(conn);
  conn._doExecChannel = async () => {
    throw new SshError({ hostId: 'h-fail', stage: 'exec-open', message: 'Not connected' });
  };
  stubConnectFail(conn, new SshError({ hostId: 'h-fail', stage: 'connect', message: 'ECONNREFUSED' }));
  await assert.rejects(() => conn._execChannel('echo hi', {}), (e) => {
    assert.ok(e instanceof SshError);
    assert.equal(e.hostId, 'h-fail');
    assert.equal(e.stage, 'exec-open');
    assert.match(e.message, /reconnect failed/i);
    return true;
  });
});

test('reconnect failure for sftp throws SshError with hostId', async () => {
  const conn = new SshConn({ id: 'h-sftp-fail', host: '203.0.113.10', port: 22, user: 'u', acceptNew: true });
  conn.client = makeFakeClient();
  conn._ready = Promise.resolve(conn);
  conn._doSftpOpen = async () => {
    throw new SshError({ hostId: 'h-sftp-fail', stage: 'sftp-open', message: 'Not connected' });
  };
  stubConnectFail(conn, new SshError({ hostId: 'h-sftp-fail', stage: 'connect', message: 'timeout' }));
  await assert.rejects(() => conn.sftp(), (e) => {
    assert.ok(e instanceof SshError);
    assert.equal(e.hostId, 'h-sftp-fail');
    assert.equal(e.stage, 'sftp-open');
    assert.match(e.message, /reconnect failed/i);
    return true;
  });
});

test('normal dispose does not mark dead and allows clean reconnect', async () => {
  const conn = new SshConn({ id: 'h-dispose', host: '203.0.113.10', port: 22, user: 'u', acceptNew: true });
  const client = makeFakeClient();
  stubConnectSuccess(conn, client);
  await conn.connect();
  await conn.dispose();
  // dispose is intentional: should not be considered dead
  assert.equal(conn._dead, false);
  assert.equal(conn.client, null);
  assert.equal(conn._ready, null);
  // Next connect should succeed without reconnect-failed wrapper
  const client2 = makeFakeClient();
  let called = false;
  conn._connectInner = async () => {
    called = true;
    conn.client = client2;
    client2.on('close', conn._onClose);
    return conn;
  };
  await conn.connect();
  assert.equal(called, true);
  assert.equal(conn._dead, false);
});

test('non-Not-connected exec error does not trigger retry', async () => {
  const conn = new SshConn({ id: 'h-no-retry', host: '203.0.113.10', port: 22, user: 'u', acceptNew: true });
  conn.client = makeFakeClient();
  conn._ready = Promise.resolve(conn);
  let doCalls = 0;
  conn._doExecChannel = async () => {
    doCalls++;
    throw new SshError({ hostId: 'h-no-retry', stage: 'exec-open', message: 'channel open failed' });
  };
  let connectCalled = false;
  conn._connectInner = async () => { connectCalled = true; return conn; };
  await assert.rejects(() => conn._execChannel('echo hi', {}), (e) => {
    assert.equal(e.message, 'channel open failed');
    return true;
  });
  assert.equal(doCalls, 1, 'should not retry');
  assert.equal(connectCalled, false, 'should not reconnect');
});
