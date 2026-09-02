// @dsh-ssh/dsh-ssh — per-connection session-channel limit tests (node --test, no network).
// Covers: the FIFO channel semaphore (bound/hand-off/release), exec holding+releasing
// a slot for the whole command (success and error paths), and surfacing the ssh2
// channel-open reason code in the SshError message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SshError, SshConn } from '../src/ssh-core.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A stream whose close is controlled by the test (no automatic close), so the channel
// slot stays held until the test decides to release it.
function makeManualStream() {
  const handlers = {};
  return {
    stderr: { on: () => {} },
    on(ev, cb) { handlers[ev] = cb; return this; },
    close() { if (handlers.close) handlers.close(0, null); },
  };
}

test('_acquireChannel/_releaseChannel bound concurrent slots and hand off FIFO', async () => {
  const conn = new SshConn({ id: 'h', maxChannelsPerConnection: 2 });
  await conn._acquireChannel();
  await conn._acquireChannel();
  assert.equal(conn._channelActive, 2);

  let granted = false;
  const third = conn._acquireChannel().then(() => { granted = true; });
  await flush();
  assert.equal(granted, false, 'third acquire must queue while at the limit');
  assert.equal(conn._channelWaiters.length, 1);

  conn._releaseChannel(); // hands the freed slot to the queued waiter
  await third;
  assert.equal(granted, true);
  assert.equal(conn._channelActive, 2, 'hand-off keeps the active count unchanged');

  conn._releaseChannel();
  conn._releaseChannel();
  assert.equal(conn._channelActive, 0);
});

test('exec releases its channel slot after the command completes', async () => {
  const conn = new SshConn({ id: 'h', maxChannelsPerConnection: 1 });
  let opened = 0;
  conn._execChannel = async () => {
    opened++;
    const s = makeManualStream();
    setImmediate(() => s.close());
    return s;
  };
  const r = await conn.exec('echo ok');
  assert.equal(r.code, 0);
  assert.equal(opened, 1);
  assert.equal(conn._channelActive, 0, 'slot released after completion');
});

test('exec releases its channel slot when opening the channel fails', async () => {
  const conn = new SshConn({ id: 'h', maxChannelsPerConnection: 1 });
  conn._execChannel = async () => {
    throw new SshError({ hostId: 'h', stage: 'exec-open', message: 'boom' });
  };
  await assert.rejects(() => conn.exec('x'), (e) => e instanceof SshError && e.message === 'boom');
  assert.equal(conn._channelActive, 0, 'slot released on error');
});

test('concurrent execs queue beyond the per-connection channel limit', async () => {
  const conn = new SshConn({ id: 'h', maxChannelsPerConnection: 1 });
  const streams = [];
  conn._execChannel = async () => {
    const s = makeManualStream();
    streams.push(s);
    return s;
  };

  const first = conn.exec('a');
  await flush(); // let the first acquire a slot and open its channel
  assert.equal(conn._channelActive, 1);
  assert.equal(streams.length, 1);

  let secondDone = false;
  const second = conn.exec('b').then(() => { secondDone = true; });
  await flush();
  assert.equal(streams.length, 1, 'second exec must not open a channel until a slot frees');
  assert.equal(secondDone, false);

  streams[0].close(); // release the first slot
  await first;
  await flush();
  assert.equal(streams.length, 2, 'second channel opens after the first releases');
  streams[1].close();
  await second;
  assert.equal(secondDone, true);
  assert.equal(conn._channelActive, 0);
});

test('_doExecChannel surfaces the ssh2 channel-open reason code', async () => {
  const conn = new SshConn({ id: 'h', host: '203.0.113.10', port: 22, user: 'u' });
  conn.client = {
    exec(_cmd, cb) {
      const err = new Error('(SSH) Channel open failure: open failed');
      err.reason = 1;
      cb(err);
    },
  };
  await assert.rejects(() => conn._doExecChannel('echo hi', {}), (e) => {
    assert.ok(e instanceof SshError);
    assert.equal(e.stage, 'exec-open');
    assert.match(e.message, /administratively prohibited/);
    assert.match(e.message, /MaxSessions/);
    return true;
  });
});
